import { Annotation, Extension, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { EditorState } from '@codemirror/state';
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import * as Y from 'yjs';
import { AwarenessManager } from './awareness';
import { PeerAwarenessState } from './types';

export const remoteSyncAnnotation = Annotation.define<boolean>();

export const setReadOnlyEffect = StateEffect.define<boolean>();

export const readOnlyField = StateField.define<boolean>({
  create: () => false,
  update: (val, tr) => {
    for (const effect of tr.effects) {
      if (effect.is(setReadOnlyEffect)) return effect.value;
    }
    return val;
  },
});

class RemoteCursorWidget extends WidgetType {
  private user: PeerAwarenessState['user'];

  constructor(user: PeerAwarenessState['user']) {
    super();
    this.user = user;
  }

  toDOM(): HTMLElement {
    const cursor = document.createElement('span');
    cursor.className = 'cm-kurotsuki-cursor';
    cursor.style.borderLeft = `2px solid ${this.user.color}`;
    cursor.style.height = '1.2em';

    const label = document.createElement('span');
    label.className = 'cm-kurotsuki-cursor-label';
    label.style.backgroundColor = this.user.color;
    label.textContent = this.user.name;

    cursor.appendChild(label);
    return cursor;
  }

  eq(other: RemoteCursorWidget): boolean {
    return this.user.id === other.user.id && this.user.color === other.user.color && this.user.name === other.user.name;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export function createCollabExtension(
  awareness: AwarenessManager,
  getActiveFilePath: () => string | null,
  getYDocForPath: (path: string) => Y.Doc | null,
  isReadOnly: () => boolean = () => false,
  onReadOnlyAttempt?: () => void
): Extension {
  // 1. Live Yjs text synchronization & Remote cursor decorations
  const collabPlugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private unsubscribeAwareness: (() => void) | null = null;
      private bannerEl: HTMLElement | null = null;
      private boundPath: string | null = null;
      private currentYText: Y.Text | null = null;
      private yTextObserver: ((event: Y.YTextEvent) => void) | null = null;
      private isDispatchingRemote = false;

      constructor(private view: EditorView) {
        this.decorations = this.buildDecorations(view);

        this.unsubscribeAwareness = awareness.subscribe(() => {
          view.requestMeasure();
        });

        this.updateBanner(view);
        this.syncReadOnlyState(view);
        this.bindActiveYDoc();
      }

      private syncReadOnlyState(view: EditorView): void {
        const readOnly = isReadOnly();
        if (view.state.field(readOnlyField) !== readOnly) {
          queueMicrotask(() => {
            if (view.state.field(readOnlyField) !== isReadOnly()) {
              view.dispatch({
                effects: [setReadOnlyEffect.of(isReadOnly())],
              });
            }
          });
        }
      }

      private bindActiveYDoc(): void {
        const path = getActiveFilePath();
        if (path === this.boundPath && this.currentYText) return;

        // Unbind previous
        if (this.currentYText && this.yTextObserver) {
          this.currentYText.unobserve(this.yTextObserver);
        }

        this.boundPath = path;
        if (!path) {
          this.currentYText = null;
          this.yTextObserver = null;
          return;
        }

        const doc = getYDocForPath(path);
        if (!doc) return;

        const yText = doc.getText('content');
        this.currentYText = yText;

        // If local editor has text and Yjs is empty, seed Yjs text
        const localText = this.view.state.doc.toString();
        if (yText.length === 0 && localText.length > 0) {
          doc.transact(() => {
            yText.insert(0, localText);
          }, 'cm6-init');
        } else if (yText.length > 0 && yText.toString() !== localText) {
          // If Yjs already has text from server/peers, sync editor to Yjs content
          const yString = yText.toString();
          this.isDispatchingRemote = true;
          this.view.dispatch({
            changes: { from: 0, to: localText.length, insert: yString },
            annotations: [remoteSyncAnnotation.of(true)],
          });
          this.isDispatchingRemote = false;
        }

        // Listen for inbound Yjs changes (from remote peers via WebSocket)
        this.yTextObserver = (event: Y.YTextEvent) => {
          if (event.transaction.origin === 'cm6') return;

          // Convert Yjs deltas into CodeMirror transaction
          let index = 0;
          const changes: Array<{ from: number; to: number; insert?: string }> = [];

          for (const d of event.delta) {
            if (d.retain) {
              index += d.retain;
            }
            if (d.delete) {
              changes.push({ from: index, to: index + d.delete });
            }
            if (d.insert) {
              const str = typeof d.insert === 'string' ? d.insert : '';
              changes.push({ from: index, to: index, insert: str });
              index += str.length;
            }
          }

          if (changes.length > 0) {
            this.isDispatchingRemote = true;
            this.view.dispatch({
              changes,
              annotations: [remoteSyncAnnotation.of(true)],
            });
            this.isDispatchingRemote = false;
          }
        };

        yText.observe(this.yTextObserver);
      }

      update(update: ViewUpdate) {
        // Check if active note changed
        this.bindActiveYDoc();
        this.syncReadOnlyState(update.view);

        if (update.docChanged || update.viewportChanged || update.selectionSet) {
          this.decorations = this.buildDecorations(update.view);
        }

        // Propagate local keystrokes / edits into Yjs text immediately
        if (update.docChanged && !this.isDispatchingRemote) {
          const isRemote = update.transactions.some((tr) => tr.annotation(remoteSyncAnnotation));
          if (!isRemote && this.currentYText && !isReadOnly()) {
            const yText = this.currentYText;
            const doc = yText.doc;
            if (doc) {
              update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
                const insertStr = inserted.toString();
                const deleteLen = toA - fromA;
                doc.transact(() => {
                  if (deleteLen > 0) {
                    yText.delete(fromA, deleteLen);
                  }
                  if (insertStr.length > 0) {
                    yText.insert(fromA, insertStr);
                  }
                }, 'cm6');
              });
            }
          }
        }

        // Send local cursor to awareness
        if (update.selectionSet) {
          const main = update.state.selection.main;
          awareness.updateCursor({
            anchor: main.anchor,
            head: main.head,
          });
        }

        this.updateBanner(update.view);
      }

      private updateBanner(view: EditorView): void {
        const readOnly = isReadOnly();
        const parent = view.dom;

        if (readOnly) {
          if (!this.bannerEl) {
            this.bannerEl = document.createElement('div');
            this.bannerEl.className = 'kurotsuki-editor-readonly-banner';
            this.bannerEl.innerHTML = `
              <span class="kurotsuki-banner-icon">🔒</span>
              <span class="kurotsuki-banner-title">READ-ONLY VAULT:</span>
              <span class="kurotsuki-banner-desc">You are connected as Viewer. All document edits and local saves are blocked.</span>
            `;
            parent.insertBefore(this.bannerEl, parent.firstChild);
          }
        } else if (this.bannerEl) {
          this.bannerEl.remove();
          this.bannerEl = null;
        }
      }

      destroy() {
        if (this.currentYText && this.yTextObserver) {
          this.currentYText.unobserve(this.yTextObserver);
        }
        if (this.unsubscribeAwareness) {
          this.unsubscribeAwareness();
          this.unsubscribeAwareness = null;
        }
        if (this.bannerEl) {
          this.bannerEl.remove();
          this.bannerEl = null;
        }
      }

      private buildDecorations(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        const currentPath = getActiveFilePath();
        if (!currentPath) return builder.finish();

        const peers = awareness.getActivePeersForFile(currentPath);
        const docLength = view.state.doc.length;

        const cursorEntries: Array<{ pos: number; peer: PeerAwarenessState; isHead: boolean; range?: { from: number; to: number } }> = [];

        for (const peer of peers) {
          if (!peer.cursor) continue;
          const from = Math.min(peer.cursor.anchor, peer.cursor.head);
          const to = Math.max(peer.cursor.anchor, peer.cursor.head);

          const safeFrom = Math.max(0, Math.min(from, docLength));
          const safeTo = Math.max(0, Math.min(to, docLength));
          const safeHead = Math.max(0, Math.min(peer.cursor.head, docLength));

          if (safeFrom !== safeTo) {
            cursorEntries.push({
              pos: safeFrom,
              peer,
              isHead: false,
              range: { from: safeFrom, to: safeTo },
            });
          }

          cursorEntries.push({
            pos: safeHead,
            peer,
            isHead: true,
          });
        }

        cursorEntries.sort((a, b) => a.pos - b.pos);

        for (const entry of cursorEntries) {
          if (entry.isHead) {
            const widget = Decoration.widget({
              widget: new RemoteCursorWidget(entry.peer.user),
              side: 1,
            });
            builder.add(entry.pos, entry.pos, widget);
          } else if (entry.range) {
            const mark = Decoration.mark({
              class: 'cm-kurotsuki-selection',
              attributes: {
                style: `background-color: ${entry.peer.user.color};`,
              },
            });
            builder.add(entry.range.from, entry.range.to, mark);
          }
        }

        return builder.finish();
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );

  // 2. Read-only dynamic facet: instructs CodeMirror commands to refuse edits
  const readOnlyFacet = EditorState.readOnly.compute([readOnlyField], (state) => {
    return state.field(readOnlyField);
  });

  // 3. Dynamic editable facet: disables DOM contenteditable when in read-only mode
  const editableFacet = EditorView.editable.compute([readOnlyField], (state) => {
    return !state.field(readOnlyField);
  });

  // 4. Change filter: cancels any edit if user is in read-only mode, but allows remote sync
  const changeFilter = EditorState.changeFilter.of((tr) => {
    if (tr.annotation(remoteSyncAnnotation)) {
      return true;
    }
    if (isReadOnly() && tr.docChanged) {
      if (onReadOnlyAttempt) onReadOnlyAttempt();
      return false; // Rejects all local doc changes
    }
    return true;
  });

  // 5. Transaction filter: double safety filter
  const transactionFilter = EditorState.transactionFilter.of((tr) => {
    if (tr.annotation(remoteSyncAnnotation)) {
      return tr;
    }
    if (isReadOnly() && tr.docChanged) {
      if (onReadOnlyAttempt) onReadOnlyAttempt();
      return []; // Drops the transaction
    }
    return tr;
  });

  return [readOnlyField, collabPlugin, readOnlyFacet, editableFacet, changeFilter, transactionFilter];
}
