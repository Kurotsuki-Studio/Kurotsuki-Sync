import { App, Modal } from 'obsidian';
import type KurotsukiSyncPlugin from '../main';
import { HistoryInspectorModal } from './history-inspector-modal';
import { VaultSwitcherModal } from './vault-switcher-modal';

export class StatusModal extends Modal {
  private plugin: KurotsukiSyncPlugin;
  private unsubscribeStatus: (() => void) | null = null;
  private unsubscribeAwareness: (() => void) | null = null;
  private unsubscribeLatency: (() => void) | null = null;

  constructor(app: App, plugin: KurotsukiSyncPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('kurotsuki-modal');

    this.render();

    this.unsubscribeStatus = this.plugin.wsClient.onStatusChange(() => this.render());
    this.unsubscribeAwareness = this.plugin.awareness.subscribe(() => this.render());
    this.unsubscribeLatency = this.plugin.wsClient.onLatencyChange(() => this.render());
  }

  onClose() {
    if (this.unsubscribeStatus) this.unsubscribeStatus();
    if (this.unsubscribeAwareness) this.unsubscribeAwareness();
    if (this.unsubscribeLatency) this.unsubscribeLatency();
    const { contentEl } = this;
    contentEl.empty();
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: '🌙 Kurotsuki Sync Dashboard' });

    const status = this.plugin.wsClient.getStatus();
    const role = this.plugin.wsClient.getCurrentRole();
    const latency = this.plugin.wsClient.getLatency();

    const statusBox = contentEl.createDiv({ cls: 'kurotsuki-peer-item' });

    const statusLeft = statusBox.createDiv({ cls: 'kurotsuki-peer-info' });
    statusLeft.createSpan({ cls: `kurotsuki-status-dot kurotsuki-status-${status}` });
    statusLeft.createSpan({ text: `Status: ${status.toUpperCase()}`, attr: { style: 'font-weight: 600;' } });

    // Role badge
    statusLeft.createSpan({
      cls: `kurotsuki-role-badge kurotsuki-role-${role}`,
      text: role.toUpperCase(),
    });

    const actionBtn = statusBox.createEl('button', {
      text: status === 'connected' ? 'Disconnect' : 'Connect',
    });
    actionBtn.onclick = () => {
      if (status === 'connected') {
        this.plugin.wsClient.disconnect(true);
      } else {
        this.plugin.wsClient.connect();
      }
    };

    // Quick Action Bar
    const actionGrid = contentEl.createDiv({ cls: 'kurotsuki-modal-actions-grid' });

    const switchBtn = actionGrid.createEl('button', {
      text: '🔄 Switch Vault Profile',
      cls: 'kurotsuki-action-card',
    });
    switchBtn.onclick = () => {
      this.close();
      new VaultSwitcherModal(this.app, this.plugin).open();
    };

    const sidebarBtn = actionGrid.createEl('button', {
      text: '👥 Open Peer Sidebar',
      cls: 'kurotsuki-action-card',
    });
    sidebarBtn.onclick = async () => {
      this.close();
      await this.plugin.activatePeerSidebar();
    };

    const histBtn = actionGrid.createEl('button', {
      text: '📜 Sync & Conflict History',
      cls: 'kurotsuki-action-card',
    });
    histBtn.onclick = () => {
      this.close();
      new HistoryInspectorModal(this.app, this.plugin).open();
    };

    // Connection Details
    const details = contentEl.createDiv({ cls: 'kurotsuki-details-box' });
    details.createDiv({ text: `🌐 Server: ${this.plugin.settings.serverUrl}` });
    details.createDiv({ text: `📁 Active Vault / Room: ${this.plugin.settings.vaultId}` });
    details.createDiv({ text: `📶 Latency: ${latency !== null ? `${latency}ms` : 'Measuring...'}` });
    details.createDiv({ text: `🔄 Sync Mode: ${this.plugin.settings.syncMode === 'entire_vault' ? 'Entire Vault' : 'Selective Folders'}` });

    if (role === 'viewer') {
      const warningBanner = contentEl.createDiv({ cls: 'kurotsuki-warning-card' });
      warningBanner.createSpan({ text: '🔒 ' });
      warningBanner.createEl('strong', { text: 'Viewer Mode: ' });
      warningBanner.createSpan({ text: 'You have read-only access. Editor mutations and local saves are blocked.' });
    }

    // Active Collaborators Section
    contentEl.createEl('h3', { text: '👥 Online Collaborators', cls: 'kurotsuki-section-heading' });

    const local = this.plugin.awareness.getLocalState();
    const remotePeers = this.plugin.awareness.getAllRemotePeers();

    const peerList = contentEl.createDiv({ cls: 'kurotsuki-peer-list' });

    // Local user entry
    const localItem = peerList.createDiv({ cls: 'kurotsuki-peer-item' });
    const localInfo = localItem.createDiv({ cls: 'kurotsuki-peer-info' });
    const localAvatar = localInfo.createDiv({ cls: 'kurotsuki-peer-avatar' });
    localAvatar.setCssStyles({ backgroundColor: local.user.color });
    localAvatar.textContent = local.user.name.charAt(0).toUpperCase();
    localInfo.createSpan({ text: local.user.name, cls: 'kurotsuki-user-name' });
    localItem.createSpan({ text: 'You', cls: 'kurotsuki-badge-self' });

    // Remote users
    if (remotePeers.length === 0) {
      peerList.createEl('p', {
        text: 'No other collaborators currently connected.',
        cls: 'kurotsuki-muted-text',
      });
    } else {
      for (const peer of remotePeers) {
        const item = peerList.createDiv({ cls: 'kurotsuki-peer-item' });
        const info = item.createDiv({ cls: 'kurotsuki-peer-info' });
        const avatar = info.createDiv({ cls: 'kurotsuki-peer-avatar' });
        avatar.setCssStyles({ backgroundColor: peer.user.color });
        avatar.textContent = peer.user.name.charAt(0).toUpperCase();

        info.createSpan({ text: peer.user.name });
        if (peer.activeFile) {
          info.createSpan({
            text: ` • ${peer.activeFile}`,
            cls: 'kurotsuki-muted-file',
          });
        }
      }
    }
  }
}
