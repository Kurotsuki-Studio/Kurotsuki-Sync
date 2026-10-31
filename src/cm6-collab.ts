import { Annotation, Extension, Range, StateEffect, StateField } from '@codemirror/state';
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
export const awarenessEffect = StateEffect.define<void>();

export const readOnlyField = StateField.define<boolean>({
  create: () => false,
  update: (val, tr) => {
    for (const effect of tr.effects) {
      if (effect.is(setReadOnlyEffect)) return effect.value;
    }
    return val;
  },
});

function hexToRgba(hex: string, alpha = 0.25): string {
  if (!hex || !hex.startsWith('#')) return `rgba(59, 130, 246, ${alpha})`;
  let c = hex.substring(1);
  if (c.length === 3) c = c.split('').map((x) => x + x).join('');
  const num = parseInt(c, 16);
  if (isNaN(num)) return `rgba(59, 130, 246, ${alpha})`;
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function computeTextChanges(oldText: string, newText: string): Array<{ from: number; to: number; insert: string }> {
  if (oldText === newText) return [];

  let start = 0;
  while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) {
    start++;
  }

  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  return [{
    from: start,
    to: oldEnd,
    insert: newText.substring(start, newEnd),
  }];
}

class RemoteCursorWidget extends WidgetType {
  private user: PeerAwarenessState['user'];

  constructor(user: PeerAwarenessState['user']) {
    super();
    this.user = user;
  }

  toDOM(): HTMLElement {
    const cursor = document.createElement('span');
    cursor.className = 'cm-kurotsuki-cursor';
    cursor.style.borderLeftColor = this.user.color || '#3b82f6';

    const label = document.createElement('span');
    label.className = 'cm-kurotsuki-cursor-label';
    label.style.backgroundColor = this.user.color || '#3b82f6';
    label.textContent = this.user.name || 'Collaborator';

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
      private awarenessScheduled = false;

      constructor(private view: EditorView) {
        this.decorations = this.buildDecorations(view);

        this.unsubscribeAwareness = awareness.subscribe(() => {
          if (this.view.dom && this.view.dom.isConnected) {
            this.scheduleAwarenessUpdate();
          }
        });

        this.updateBanner(view);
        this.syncReadOnlyState(view);
        this.bindActiveYDoc();
      }

      private scheduleAwarenessUpdate(): void {
        if (this.awarenessScheduled) return;
        this.awarenessScheduled = true;
        requestAnimationFrame(() => {
          this.awarenessScheduled = false;
          if (this.view.dom && this.view.dom.isConnected) {
            this.view.dispatch({
              effects: [awarenessEffect.of()],
            });
          }
        });
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
          // If Yjs already has text from server/peers, sync editor to Yjs content with surgical diff & preserved cursor
          const yString = yText.toString();
          const changes = computeTextChanges(localText, yString);
          if (changes.length > 0) {
            this.isDispatchingRemote = true;
            const curSel = this.view.state.selection;
            const changeDesc = this.view.state.changes(changes);
            const mappedSel = curSel.map(changeDesc);
            this.view.dispatch({
              changes,
              selection: mappedSel,
              annotations: [remoteSyncAnnotation.of(true)],
            });
            this.isDispatchingRemote = false;
          }
        }

        // Listen for inbound Yjs changes (from remote peers via WebSocket)
        this.yTextObserver = (event: Y.YTextEvent) => {
          if (event.transaction.origin === 'cm6') return;

          // Convert Yjs deltas into CodeMirror transaction accurately
          let index = 0;
          const changes: Array<{ from: number; to: number; insert?: string }> = [];

          for (const d of event.delta) {
            if (d.retain) {
              index += d.retain;
            }
            if (d.delete) {
              changes.push({ from: index, to: index + d.delete });
              index += d.delete;
            }
            if (d.insert) {
              const str = typeof d.insert === 'string' ? d.insert : '';
              changes.push({ from: index, to: index, insert: str });
            }
          }

          if (changes.length > 0) {
            this.isDispatchingRemote = true;
            const curSel = this.view.state.selection;
            const changeDesc = this.view.state.changes(changes);
            const mappedSel = curSel.map(changeDesc);
            this.view.dispatch({
              changes,
              selection: mappedSel,
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

        const hasAwarenessEffect = update.transactions.some((tr) =>
          tr.effects.some((e) => e.is(awarenessEffect))
        );

        if (update.docChanged || update.viewportChanged || update.selectionSet || hasAwarenessEffect) {
          this.decorations = this.buildDecorations(update.view);
        }

        // Propagate local keystrokes / edits into Yjs text immediately
        if (update.docChanged && !this.isDispatchingRemote) {
          const isRemote = update.transactions.some((tr) => tr.annotation(remoteSyncAnnotation));
          if (!isRemote && this.currentYText && !isReadOnly()) {
            const yText = this.currentYText;
            const doc = yText.doc;
            if (doc) {
              let adj = 0;
              update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
                const insertStr = inserted.toString();
                const deleteLen = toA - fromA;
                const pos = fromA + adj;
                doc.transact(() => {
                  if (deleteLen > 0) {
                    yText.delete(pos, deleteLen);
                  }
                  if (insertStr.length > 0) {
                    yText.insert(pos, insertStr);
                  }
                }, 'cm6');
                adj += insertStr.length - deleteLen;
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
        const currentPath = getActiveFilePath();
        if (!currentPath) return Decoration.none;

        const peers = awareness.getActivePeersForFile(currentPath);
        if (peers.length === 0) return Decoration.none;

        const docLength = view.state.doc.length;
        const ranges: Array<Range<Decoration>> = [];

        for (const peer of peers) {
          if (!peer.cursor) continue;
          const from = Math.min(peer.cursor.anchor, peer.cursor.head);
          const to = Math.max(peer.cursor.anchor, peer.cursor.head);

          const safeFrom = Math.max(0, Math.min(from, docLength));
          const safeTo = Math.max(0, Math.min(to, docLength));
          const safeHead = Math.max(0, Math.min(peer.cursor.head, docLength));

          // 1. Text Selection Highlight (if range > 0)
          if (safeFrom < safeTo) {
            const markDeco = Decoration.mark({
              class: 'cm-kurotsuki-selection',
              attributes: {
                style: `background-color: ${hexToRgba(peer.user.color || '#3b82f6', 0.28)} !important;`,
              },
            });
            ranges.push(markDeco.range(safeFrom, safeTo));
          }

          // 2. Remote Cursor Caret & Name Tag
          const widgetDeco = Decoration.widget({
            widget: new RemoteCursorWidget(peer.user),
            side: 1,
          });
          ranges.push(widgetDeco.range(safeHead));
        }

        if (ranges.length === 0) return Decoration.none;
        return Decoration.set(ranges, true);
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
