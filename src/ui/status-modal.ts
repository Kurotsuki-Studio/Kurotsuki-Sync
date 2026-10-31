import { App, Modal } from 'obsidian';
import { AwarenessManager } from '../awareness';
import { ConnectionStatus, KurotsukiSettings } from '../types';
import { KurotsukiWSClient } from '../ws-client';

export class StatusModal extends Modal {
  private settings: KurotsukiSettings;
  private wsClient: KurotsukiWSClient;
  private awareness: AwarenessManager;
  private unsubscribeStatus: (() => void) | null = null;
  private unsubscribeAwareness: (() => void) | null = null;

  constructor(app: App, settings: KurotsukiSettings, wsClient: KurotsukiWSClient, awareness: AwarenessManager) {
    super(app);
    this.settings = settings;
    this.wsClient = wsClient;
    this.awareness = awareness;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('kurotsuki-modal');

    this.render();

    this.unsubscribeStatus = this.wsClient.onStatusChange(() => this.render());
    this.unsubscribeAwareness = this.awareness.subscribe(() => this.render());
  }

  onClose() {
    if (this.unsubscribeStatus) this.unsubscribeStatus();
    if (this.unsubscribeAwareness) this.unsubscribeAwareness();
    const { contentEl } = this;
    contentEl.empty();
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: '🌙 Kurotsuki Sync Status' });

    const status = this.wsClient.getStatus();
    const statusBox = contentEl.createDiv({ cls: 'kurotsuki-peer-item' });

    const statusLeft = statusBox.createDiv({ cls: 'kurotsuki-peer-info' });
    const dot = statusLeft.createSpan({ cls: `kurotsuki-status-dot kurotsuki-status-${status}` });
    statusLeft.createSpan({ text: `Status: ${status.toUpperCase()}`, attr: { style: 'font-weight: 600;' } });

    const actionBtn = statusBox.createEl('button', {
      text: status === 'connected' ? 'Disconnect' : 'Connect',
    });
    actionBtn.onclick = () => {
      if (status === 'connected') {
        this.wsClient.disconnect(true);
      } else {
        this.wsClient.connect();
      }
    };

    // Details Grid
    const details = contentEl.createDiv({ attr: { style: 'margin-top: 14px; font-size: 0.9em; display: flex; flex-direction: column; gap: 6px;' } });
    details.createDiv({ text: `🌐 Server: ${this.settings.serverUrl}` });
    details.createDiv({ text: `📁 Vault / Room ID: ${this.settings.vaultId}` });
    details.createDiv({ text: `🔄 Sync Mode: ${this.settings.syncMode === 'entire_vault' ? 'Entire Vault' : 'Selective Folders'}` });

    // Active Collaborators Section
    contentEl.createEl('h3', { text: '👥 Active Collaborators', attr: { style: 'margin-top: 18px;' } });

    const local = this.awareness.getLocalState();
    const remotePeers = this.awareness.getAllRemotePeers();

    const peerList = contentEl.createDiv({ cls: 'kurotsuki-peer-list' });

    // Local user entry
    const localItem = peerList.createDiv({ cls: 'kurotsuki-peer-item' });
    const localInfo = localItem.createDiv({ cls: 'kurotsuki-peer-info' });
    const localAvatar = localInfo.createDiv({ cls: 'kurotsuki-peer-avatar' });
    localAvatar.style.backgroundColor = local.user.color;
    localAvatar.textContent = local.user.name.charAt(0).toUpperCase();
    localInfo.createSpan({ text: local.user.name, attr: { style: 'font-weight: 600;' } });
    localItem.createSpan({ text: 'You (Host)', cls: 'kurotsuki-badge-self' });

    // Remote users
    if (remotePeers.length === 0) {
      peerList.createEl('p', { text: 'No other collaborators currently connected.', attr: { style: 'color: var(--text-muted); font-size: 0.9em;' } });
    } else {
      for (const peer of remotePeers) {
        const item = peerList.createDiv({ cls: 'kurotsuki-peer-item' });
        const info = item.createDiv({ cls: 'kurotsuki-peer-info' });
        const avatar = info.createDiv({ cls: 'kurotsuki-peer-avatar' });
        avatar.style.backgroundColor = peer.user.color;
        avatar.textContent = peer.user.name.charAt(0).toUpperCase();

        const nameSpan = info.createSpan({ text: peer.user.name });
        if (peer.activeFile) {
          info.createSpan({ text: ` • ${peer.activeFile}`, attr: { style: 'font-size: 0.8em; color: var(--text-muted);' } });
        }
      }
    }
  }
}
