import { App, Modal, Notice } from 'obsidian';
import { KurotsukiSettings } from '../types';

export class ShareModal extends Modal {
  private settings: KurotsukiSettings;
  private currentPath: string | null;

  constructor(app: App, settings: KurotsukiSettings, currentPath: string | null) {
    super(app);
    this.settings = settings;
    this.currentPath = currentPath;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('kurotsuki-modal');

    contentEl.createEl('h2', { text: '🔗 Share & Collaborate (Kurotsuki Sync)' });

    contentEl.createEl('p', {
      text: 'Share your vault or folders with your collaborators in real-time without third-party subscriptions.',
      attr: { style: 'color: var(--text-muted); margin-bottom: 16px;' },
    });

    // Invite Configuration Summary
    const box = contentEl.createDiv({ cls: 'kurotsuki-peer-item', attr: { style: 'flex-direction: column; align-items: flex-start; gap: 8px;' } });
    box.createDiv({ text: `Server URL: ${this.settings.serverUrl}` });
    box.createDiv({ text: `Vault / Room ID: ${this.settings.vaultId}` });
    if (this.currentPath) {
      box.createDiv({ text: `Current Resource: ${this.currentPath}` });
    }

    // Invite Payload
    const invitePayload = {
      serverUrl: this.settings.serverUrl,
      vaultId: this.settings.vaultId,
      token: this.settings.authToken || undefined,
    };
    const inviteCode = btoa(JSON.stringify(invitePayload));
    const inviteLink = `obsidian://kurotsuki-sync?invite=${encodeURIComponent(inviteCode)}`;

    const linkContainer = contentEl.createDiv({ attr: { style: 'margin-top: 14px;' } });
    linkContainer.createEl('label', { text: 'Quick Invite Code / Link:', attr: { style: 'font-weight: 600;' } });

    const input = linkContainer.createEl('input', {
      type: 'text',
      value: inviteLink,
      attr: { style: 'width: 100%; margin-top: 6px; padding: 6px;', readonly: 'true' },
    });

    const buttonRow = contentEl.createDiv({ attr: { style: 'margin-top: 12px; display: flex; gap: 8px;' } });

    const copyBtn = buttonRow.createEl('button', { text: '📋 Copy Invite Link', cls: 'mod-cta' });
    copyBtn.onclick = async () => {
      await navigator.clipboard.writeText(inviteLink);
      new Notice('Invite link copied to clipboard!');
    };

    const copyCodeBtn = buttonRow.createEl('button', { text: 'Copy Raw Code' });
    copyCodeBtn.onclick = async () => {
      await navigator.clipboard.writeText(inviteCode);
      new Notice('Raw invite code copied!');
    };
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
