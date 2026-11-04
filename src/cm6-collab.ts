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
import { normalizePath } from './utils';

export const remoteSyncAnnotation = Annotation.define<boolean>();
export const setReadOnlyEffect = StateEffect.define<boolean>();
export const awarenessEffect = StateEffect.define<void>();
export const rebindEffect = StateEffect.define<void>();

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
  private isRecent: boolean;

  constructor(user: PeerAwarenessState['user'], isRecent = true) {
    super();
    this.user = user;
    this.isRecent = isRecent;
  }

  toDOM(): HTMLElement {
    const cursor = createSpan({ cls: 'cm-kurotsuki-cursor' });
    const color = this.user.color || '#3b82f6';
    cursor.setCssProps({ '--kurotsuki-user-color': color });

    const label = cursor.createSpan({
      cls: `cm-kurotsuki-cursor-label ${this.isRecent ? 'kurotsuki-cursor-recent' : 'kurotsuki-cursor-idle'}`,
      text: this.user.name || 'Collaborator',
    });
    label.setCssProps({ '--kurotsuki-user-color': color });

    return cursor;
  }

  updateDOM(dom: HTMLElement): boolean {
    const color = this.user.color || '#3b82f6';
    dom.setCssProps({ '--kurotsuki-user-color': color });
    const label = dom.querySelector('.cm-kurotsuki-cursor-label') as HTMLElement | null;
    if (label) {
      label.textContent = this.user.name || 'Collaborator';
      label.setCssProps({ '--kurotsuki-user-color': color });
      label.className = `cm-kurotsuki-cursor-label ${this.isRecent ? 'kurotsuki-cursor-recent' : 'kurotsuki-cursor-idle'}`;
    }
    return true;
  }

  eq(other: RemoteCursorWidget): boolean {
    return (
      this.user.id === other.user.id &&
      this.user.color === other.user.color &&
      this.user.name === other.user.name &&
      this.isRecent === other.isRecent
    );
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export function createCollabExtension(
  awareness: AwarenessManager,
  getActiveFilePath: (view?: EditorView) => string | null,
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
      private lastPeerFingerprint = '';

      constructor(private view: EditorView) {
        this.bindActiveYDoc();
        this.decorations = this.buildDecorations(view);

        this.unsubscribeAwareness = awareness.subscribe(() => {
          if (this.view.dom && this.view.dom.isConnected) {
            this.scheduleAwarenessUpdate();
          }
        });

        this.updateBanner(view);
        this.syncReadOnlyState(view);
      }

      private getPeersFingerprint(currentPath: string): string {
        const peers = awareness.getActivePeersForFile(currentPath);
        if (peers.length === 0) return '';
        let fp = '';
        for (const p of peers) {
          fp += `${p.clientId}:${p.cursor?.anchor},${p.cursor?.head}:${p.user.color}:${p.user.name};`;
        }
        return fp;
      }

      private scheduleAwarenessUpdate(): void {
        if (!this.view.dom || !this.view.dom.isConnected) return;
        const currentPath = this.boundPath || getActiveFilePath(this.view);
        if (!currentPath) return;

        const newFp = this.getPeersFingerprint(currentPath);
        if (newFp === this.lastPeerFingerprint) {
          // No peers in this file, or identical cursor/user positions
          return;
        }

        if (this.awarenessScheduled) return;
        this.awarenessScheduled = true;
        window.requestAnimationFrame(() => {
          this.awarenessScheduled = false;
          if (this.view.dom && this.view.dom.isConnected) {
            const path = this.boundPath || getActiveFilePath(this.view);
            if (!path) return;
            const currentFp = this.getPeersFingerprint(path);
            if (currentFp === this.lastPeerFingerprint) return;
            this.lastPeerFingerprint = currentFp;
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
        const rawPath = getActiveFilePath(this.view);
        if (!rawPath) {
          return;
        }
        const path = normalizePath(rawPath);

        // If active file is detected, update awareness if this leaf is focused or if awareness is empty
        if (this.view.hasFocus || !awareness.getLocalState().activeFile) {
          if (awareness.getLocalState().activeFile !== path) {
            awareness.updateActiveFile(path);
          }
        }

        if (path === this.boundPath && this.currentYText) return;

        // Unbind previous
        if (this.currentYText && this.yTextObserver) {
          this.currentYText.unobserve(this.yTextObserver);
        }

        this.boundPath = path;

        const doc = getYDocForPath(path);
        if (!doc) return;

        const yText = doc.getText('content');
        this.currentYText = yText;

        const syncEditorToYText = () => {
          if (this.isDispatchingRemote) return;
          const currentCmText = this.view.state.doc.toString();
          const targetYText = yText.toString();

          if (currentCmText === targetYText) {
            return; // In exact sync, do not dispatch or duplicate
          }

          const changes = computeTextChanges(currentCmText, targetYText);
          if (changes.length > 0) {
            this.isDispatchingRemote = true;
            try {
              const curSel = this.view.state.selection;
              const changeDesc = this.view.state.changes(changes);
              const mappedSel = curSel.map(changeDesc);
              this.view.dispatch({
                changes,
                selection: mappedSel,
                annotations: [remoteSyncAnnotation.of(true)],
              });
            } finally {
              this.isDispatchingRemote = false;
            }
          }
        };

        // If Yjs already has text from server, sync CodeMirror to match
        if (yText.length > 0) {
          syncEditorToYText();
        }

        // Listen for inbound Yjs changes (from remote peers via WebSocket)
        this.yTextObserver = (event: Y.YTextEvent) => {
          if (event.transaction.origin === 'cm6') return;
          syncEditorToYText();
        };

        yText.observe(this.yTextObserver);
      }

      update(update: ViewUpdate) {
        const hasRebindEffect = update.transactions.some((tr) =>
          tr.effects.some((e) => e.is(rebindEffect))
        );

        // Re-bind only if not yet bound, explicitly notified of file switch, or focus changed into this view
        if (!this.boundPath || hasRebindEffect || (update.focusChanged && update.view.hasFocus)) {
          this.bindActiveYDoc();
        }

        // Update read-only banner only on role/read-only effect or focus change
        const hasReadOnlyEffect = update.transactions.some((tr) =>
          tr.effects.some((e) => e.is(setReadOnlyEffect))
        );
        if (hasReadOnlyEffect || update.focusChanged) {
          this.syncReadOnlyState(update.view);
          this.updateBanner(update.view);
        }

        const hasAwarenessEffect = update.transactions.some((tr) =>
          tr.effects.some((e) => e.is(awarenessEffect))
        );

        if (hasAwarenessEffect) {
          this.decorations = this.buildDecorations(update.view);
        } else if (update.docChanged && this.decorations !== Decoration.none) {
          // Efficient O(log N) decoration mapping on typing, preserving remote widgets
          this.decorations = this.decorations.map(update.changes);
        }

        // Propagate local keystrokes / edits into Yjs text immediately
        if (update.docChanged && !this.isDispatchingRemote) {
          const isRemote = update.transactions.some((tr) => tr.annotation(remoteSyncAnnotation));
          if (!isRemote && this.currentYText && !isReadOnly()) {
            const yText = this.currentYText;
            const doc = yText.doc;
            if (doc) {
              const currentCmText = update.state.doc.toString();
              const oldYText = yText.toString();
              if (oldYText.length === 0 && currentCmText.length > 0) {
                // Initial seed from first typing client
                doc.transact(() => {
                  yText.insert(0, currentCmText);
                }, 'cm6');
              } else if (oldYText !== currentCmText) {
                const changes = computeTextChanges(oldYText, currentCmText);
                doc.transact(() => {
                  for (const c of changes) {
                    const delLen = c.to - c.from;
                    if (delLen > 0) {
                      yText.delete(c.from, delLen);
                    }
                    if (c.insert.length > 0) {
                      yText.insert(c.from, c.insert);
                    }
                  }
                }, 'cm6');
              }
            }
          }
        }

        // Send local cursor to awareness when focused or editing (handles mobile virtual keyboard)
        if (update.selectionSet && (update.view.hasFocus || update.docChanged)) {
          const main = update.state.selection.main;
          if (
            typeof main.anchor === 'number' &&
            typeof main.head === 'number' &&
            !isNaN(main.anchor) &&
            !isNaN(main.head)
          ) {
            if (this.boundPath && awareness.getLocalState().activeFile !== this.boundPath) {
              awareness.updateActiveFile(this.boundPath);
            }
            awareness.updateCursor({
              anchor: main.anchor,
              head: main.head,
            });
          }
        }
      }

      private updateBanner(view: EditorView): void {
        const readOnly = isReadOnly();
        const parent = view.dom;

        if (readOnly) {
          if (!this.bannerEl) {
            this.bannerEl = createDiv({ cls: 'kurotsuki-editor-readonly-banner' });
            this.bannerEl.createSpan({ cls: 'kurotsuki-banner-icon', text: '🔒' });
            this.bannerEl.createSpan({ cls: 'kurotsuki-banner-title', text: 'READ-ONLY VAULT:' });
            this.bannerEl.createSpan({
              cls: 'kurotsuki-banner-desc',
              text: 'You are connected as Viewer. All document edits and local saves are blocked.',
            });
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
        const currentPath = this.boundPath || getActiveFilePath(view);
        if (!currentPath) return Decoration.none;

        const peers = awareness.getActivePeersForFile(currentPath);
        if (peers.length === 0) return Decoration.none;

        const docLength = view.state.doc.length;
        const ranges: Array<Range<Decoration>> = [];

        for (const peer of peers) {
          if (!peer.cursor) continue;
          if (
            typeof peer.cursor.anchor !== 'number' ||
            typeof peer.cursor.head !== 'number' ||
            isNaN(peer.cursor.anchor) ||
            isNaN(peer.cursor.head)
          ) {
            continue;
          }
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
                style: `--kurotsuki-sel-bg: ${hexToRgba(peer.user.color || '#3b82f6', 0.28)};`,
              },
            });
            ranges.push(markDeco.range(safeFrom, safeTo));
          }

          // 2. Remote Cursor Caret & Name Tag
          const isRecent = Date.now() - peer.lastActive < 4000;
          const widgetDeco = Decoration.widget({
            widget: new RemoteCursorWidget(peer.user, isRecent),
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
