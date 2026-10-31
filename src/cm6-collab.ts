import { Extension, RangeSetBuilder, StateField } from '@codemirror/state';
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
  getYDocForPath: (path: string) => Y.Doc | null
): Extension {
  // Plugin to render remote cursors and selections
  const cursorPlugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private unsubscribeAwareness: (() => void) | null = null;

      constructor(view: EditorView) {
        this.decorations = this.buildDecorations(view);

        this.unsubscribeAwareness = awareness.subscribe(() => {
          // Force view to update decorations when awareness updates
          view.requestMeasure();
        });
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged || update.selectionSet) {
          this.decorations = this.buildDecorations(update.view);
        }

        // Send local cursor to awareness
        if (update.selectionSet) {
          const main = update.state.selection.main;
          awareness.updateCursor({
            anchor: main.anchor,
            head: main.head,
          });
        }
      }

      destroy() {
        if (this.unsubscribeAwareness) {
          this.unsubscribeAwareness();
          this.unsubscribeAwareness = null;
        }
      }

      private buildDecorations(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        const currentPath = getActiveFilePath();
        if (!currentPath) return builder.finish();

        const peers = awareness.getActivePeersForFile(currentPath);
        const docLength = view.state.doc.length;

        // Sort peers by cursor position for RangeSetBuilder requirement
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

  return [cursorPlugin];
}
