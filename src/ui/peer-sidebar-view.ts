import { ItemView, WorkspaceLeaf } from 'obsidian';
import type KurotsukiSyncPlugin from '../main';
import { PeerAwarenessState } from '../types';

export const VIEW_TYPE_KUROTSUKI_PEERS = 'kurotsuki-peer-view';

export class KurotsukiPeerSidebarView extends ItemView {
  private plugin: KurotsukiSyncPlugin;
  private unsubscribeAwareness: (() => void) | null = null;
  private unsubscribeLatency: (() => void) | null = null;
  private unsubscribeRole: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: KurotsukiSyncPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_KUROTSUKI_PEERS;
  }

  getDisplayText(): string {
    return 'Kurotsuki Collaborators';
  }

  getIcon(): string {
    return 'users';
  }

  async onOpen(): Promise<void> {
    this.unsubscribeAwareness = this.plugin.awareness.subscribe(() => {
      this.render();
    });

    this.unsubscribeLatency = this.plugin.wsClient.onLatencyChange(() => {
      this.renderHeaderStats();
    });

    this.unsubscribeRole = this.plugin.wsClient.onRoleChange(() => {
      this.render();
    });

    this.render();
  }

  async onClose(): Promise<void> {
    if (this.unsubscribeAwareness) {
      this.unsubscribeAwareness();
      this.unsubscribeAwareness = null;
    }
    if (this.unsubscribeLatency) {
      this.unsubscribeLatency();
      this.unsubscribeLatency = null;
    }
    if (this.unsubscribeRole) {
      this.unsubscribeRole();
      this.unsubscribeRole = null;
    }
  }

  private render(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    if (!container) return;
    container.empty();
    container.addClass('kurotsuki-sidebar-view');

    // 1. Header card
    const headerEl = container.createDiv({ cls: 'kurotsuki-sidebar-header' });
    this.renderHeaderContent(headerEl);

    // 2. Peer count title
    const allPeers = this.plugin.awareness.getAllPeers();
    const countEl = container.createDiv({ cls: 'kurotsuki-sidebar-section-title' });
    countEl.createSpan({ text: `Online Collaborators (${allPeers.length + 1})` });

    // 3. Peer list
    const listEl = container.createDiv({ cls: 'kurotsuki-sidebar-peer-list' });

    // Local user first
    const localUser = this.plugin.awareness.getLocalState();
    this.renderPeerItem(listEl, localUser, true);

    // Remote peers
    for (const peer of allPeers) {
      this.renderPeerItem(listEl, peer, false);
    }
  }

  private renderHeaderStats(): void {
    const statPill = this.containerEl.querySelector('.kurotsuki-header-latency');
    if (statPill) {
      const latency = this.plugin.wsClient.getLatency();
      statPill.textContent = latency !== null ? `${latency}ms` : '--';
    }
  }

  private renderHeaderContent(headerEl: HTMLElement): void {
    headerEl.empty();

    const titleRow = headerEl.createDiv({ cls: 'kurotsuki-sidebar-room-row' });
    const roomSpan = titleRow.createDiv({ cls: 'kurotsuki-room-info' });
    roomSpan.createSpan({ text: '🌙 ' });
    roomSpan.createEl('strong', { text: this.plugin.settings.vaultId });

    // Role badge
    const role = this.plugin.wsClient.getCurrentRole();
    const roleBadge = titleRow.createSpan({
      cls: `kurotsuki-role-badge kurotsuki-role-${role}`,
      text: role.toUpperCase(),
    });

    // Subtext: Status & Latency
    const metaRow = headerEl.createDiv({ cls: 'kurotsuki-sidebar-meta-row' });
    const status = this.plugin.wsClient.getStatus();
    const latency = this.plugin.wsClient.getLatency();

    const statusPill = metaRow.createSpan({ cls: 'kurotsuki-meta-pill' });
    statusPill.createSpan({ cls: `kurotsuki-status-dot kurotsuki-status-${status}` });
    statusPill.createSpan({ text: status === 'connected' ? 'Connected' : status });

    const latencyPill = metaRow.createSpan({ cls: 'kurotsuki-meta-pill' });
    latencyPill.createSpan({ text: '📶 ' });
    latencyPill.createSpan({
      cls: 'kurotsuki-header-latency',
      text: latency !== null ? `${latency}ms` : '--',
    });
  }

  private renderPeerItem(container: HTMLElement, state: PeerAwarenessState, isSelf: boolean): void {
    const card = container.createDiv({
      cls: `kurotsuki-peer-sidebar-card ${isSelf ? 'kurotsuki-peer-self' : ''}`,
    });

    // Avatar
    const avatar = card.createDiv({ cls: 'kurotsuki-peer-sidebar-avatar' });
    avatar.style.backgroundColor = state.user.color || '#3b82f6';
    avatar.textContent = (state.user.name || '?').charAt(0).toUpperCase();

    // Info body
    const body = card.createDiv({ cls: 'kurotsuki-peer-sidebar-body' });
    const nameRow = body.createDiv({ cls: 'kurotsuki-peer-name-row' });
    nameRow.createEl('span', { cls: 'kurotsuki-peer-name', text: state.user.name });

    if (isSelf) {
      nameRow.createSpan({ cls: 'kurotsuki-badge-self', text: 'You' });
    }

    // Active Note Link
    const noteRow = body.createDiv({ cls: 'kurotsuki-peer-note-row' });
    if (state.activeFile) {
      const fileLink = noteRow.createEl('a', {
        cls: 'kurotsuki-note-link',
        text: `📄 ${state.activeFile}`,
      });
      fileLink.onclick = async (e) => {
        e.preventDefault();
        if (state.activeFile) {
          await this.app.workspace.openLinkText(state.activeFile, '', false);
        }
      };
    } else {
      noteRow.createSpan({ cls: 'kurotsuki-peer-idle', text: 'Idle (no note opened)' });
    }

    // Cursor position if active
    if (state.cursor) {
      body.createDiv({
        cls: 'kurotsuki-peer-cursor-info',
        text: `pos: ${state.cursor.head}`,
      });
    }
  }
}
