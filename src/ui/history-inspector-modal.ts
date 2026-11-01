import { App, Modal, Notice } from 'obsidian';
import type KurotsukiSyncPlugin from '../main';

export class HistoryInspectorModal extends Modal {
  private plugin: KurotsukiSyncPlugin;

  constructor(app: App, plugin: KurotsukiSyncPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    this.render();
  }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('kurotsuki-modal');

    contentEl.createEl('h2', { text: '📜 Sync & Conflict History Inspector' });
    contentEl.createEl('p', {
      text: 'Audit trail of recent CRDT document syncs, detected concurrent updates, and file events.',
      cls: 'kurotsuki-modal-desc',
    });

    const logs = this.plugin.syncEngine.getHistoryLogs();

    // Top action bar
    const bar = contentEl.createDiv({ cls: 'kurotsuki-history-bar' });
    bar.createSpan({ text: `Total Recorded Events: ${logs.length}` });

    const clearBtn = bar.createEl('button', { text: 'Clear Log', cls: 'mod-warning' });
    clearBtn.onclick = () => {
      this.plugin.syncEngine.clearHistory();
      new Notice('History log cleared');
      this.render();
    };

    const container = contentEl.createDiv({ cls: 'kurotsuki-history-list' });

    if (logs.length === 0) {
      container.createDiv({
        cls: 'kurotsuki-empty-state',
        text: 'No synchronization events recorded in this session yet.',
      });
      return;
    }

    for (const log of logs) {
      const item = container.createDiv({
        cls: `kurotsuki-history-item kurotsuki-hist-${log.type}`,
      });

      const topRow = item.createDiv({ cls: 'kurotsuki-history-top' });

      // Badge
      const typeBadge = topRow.createSpan({
        cls: `kurotsuki-badge-type kurotsuki-type-${log.type}`,
      });

      if (log.type === 'conflict_detected') {
        typeBadge.textContent = '⚡ CONCURRENT RESOLVED';
      } else if (log.type === 'remote_update') {
        typeBadge.textContent = '📥 REMOTE SYNC';
      } else if (log.type === 'local_update') {
        typeBadge.textContent = '📤 LOCAL EDIT';
      } else if (log.type === 'file_event') {
        typeBadge.textContent = '📁 FILE EVENT';
      } else {
        typeBadge.textContent = '⚠️ ERROR';
      }

      // Time
      const timeStr = new Date(log.timestamp).toLocaleTimeString();
      topRow.createSpan({ cls: 'kurotsuki-history-time', text: timeStr });

      // Summary
      item.createDiv({ cls: 'kurotsuki-history-summary', text: log.summary });

      // Path
      if (log.path) {
        item.createDiv({ cls: 'kurotsuki-history-path', text: `Path: ${log.path}` });
      }
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
