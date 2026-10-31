import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type KurotsukiSyncPlugin from './main';
import { COLOR_PALETTE, SyncMode } from './types';

export class KurotsukiSettingTab extends PluginSettingTab {
  plugin: KurotsukiSyncPlugin;

  constructor(app: App, plugin: KurotsukiSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: '🌙 Kurotsuki Sync Settings' });
    containerEl.createEl('p', {
      text: 'Configure your self-hosted relay server, collaboration profile, and synchronization scope.',
      attr: { style: 'color: var(--text-muted);' },
    });

    // Server Configuration Header
    containerEl.createEl('h3', { text: '🌐 Server Connection' });

    new Setting(containerEl)
      .setName('Relay Server URL')
      .setDesc('WebSocket or HTTP URL of your self-hosted Kurotsuki Relay server (e.g. ws://localhost:3000 or wss://relay.yourdomain.com)')
      .addText((text) =>
        text
          .setPlaceholder('ws://localhost:3000')
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (val) => {
            this.plugin.settings.serverUrl = val.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Authentication Secret / Token')
      .setDesc('Secret token required by your relay server (leave empty if your server does not require authentication)')
      .addText((text) =>
        text
          .setPlaceholder('my-secret-token')
          .setValue(this.plugin.settings.authToken)
          .onChange(async (val) => {
            this.plugin.settings.authToken = val.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Vault / Room ID')
      .setDesc('Unique identifier for this shared workspace / vault room')
      .addText((text) =>
        text
          .setPlaceholder('default-vault')
          .setValue(this.plugin.settings.vaultId)
          .onChange(async (val) => {
            this.plugin.settings.vaultId = val.trim() || 'default-vault';
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Test Connection')
      .setDesc('Verify communication with the configured Kurotsuki server')
      .addButton((btn) =>
        btn
          .setButtonText('Test Now')
          .setCta()
          .onClick(async () => {
            btn.setDisabled(true);
            btn.setButtonText('Testing...');
            try {
              let httpBase = this.plugin.settings.serverUrl.replace(/^ws:\/\//, 'http://').replace(/^wss:\/\//, 'https://');
              if (!httpBase.startsWith('http://') && !httpBase.startsWith('https://')) {
                httpBase = 'http://' + httpBase;
              }
              const res = await fetch(`${httpBase}/api/v1/health`);
              if (res.ok) {
                const data = await res.json();
                new Notice(`✅ Connected! Server: ${data.name || 'Kurotsuki Relay'} (v${data.version || '1.0.0'})`);
              } else {
                new Notice(`⚠️ Server returned HTTP ${res.status}`);
              }
            } catch (err: any) {
              new Notice(`❌ Connection failed: ${err.message || 'Cannot reach server'}`);
            } finally {
              btn.setDisabled(false);
              btn.setButtonText('Test Now');
            }
          })
      );

    // Profile Settings Header
    containerEl.createEl('h3', { text: '👤 Collaborator Profile' });

    new Setting(containerEl)
      .setName('Display Name')
      .setDesc('Your nickname visible to other collaborators on active notes')
      .addText((text) =>
        text
          .setPlaceholder('Your Name')
          .setValue(this.plugin.settings.userName)
          .onChange(async (val) => {
            this.plugin.settings.userName = val.trim() || 'Obsidian User';
            this.plugin.awareness.updateUserProfile({ name: this.plugin.settings.userName });
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('User Color')
      .setDesc('Color of your live cursor and avatar badge')
      .addColorPicker((color) =>
        color
          .setValue(this.plugin.settings.userColor)
          .onChange(async (val) => {
            this.plugin.settings.userColor = val;
            this.plugin.awareness.updateUserProfile({ color: val });
            await this.plugin.saveSettings();
          })
      );

    // Sync Scope Header
    containerEl.createEl('h3', { text: '📂 Synchronization Scope' });

    new Setting(containerEl)
      .setName('Sync Mode')
      .setDesc('Choose whether to sync your whole vault or only designated folders (like Relay Selective Sync)')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('entire_vault', 'Entire Vault')
          .addOption('selective', 'Selective Shared Folders')
          .setValue(this.plugin.settings.syncMode)
          .onChange(async (val) => {
            this.plugin.settings.syncMode = val as SyncMode;
            await this.plugin.saveSettings();
            this.display(); // re-render to show/hide folder list
          })
      );

    if (this.plugin.settings.syncMode === 'selective') {
      new Setting(containerEl)
        .setName('Shared Folders')
        .setDesc('Comma-separated list of folder paths to synchronize (e.g. Shared, Team/Notes, Work)')
        .addTextArea((text) =>
          text
            .setPlaceholder('Shared, Projects/Collab')
            .setValue(this.plugin.settings.sharedFolders.join(', '))
            .onChange(async (val) => {
              this.plugin.settings.sharedFolders = val
                .split(',')
                .map((f) => f.trim())
                .filter((f) => f.length > 0);
              await this.plugin.saveSettings();
            })
        );
    }

    new Setting(containerEl)
      .setName('Sync Attachments')
      .setDesc('Automatically synchronize images and media assets')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncAttachments)
          .onChange(async (val) => {
            this.plugin.settings.syncAttachments = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Show Live Remote Cursors')
      .setDesc('Display real-time cursor positions and collaborator tags in CodeMirror 6')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableLiveCursors)
          .onChange(async (val) => {
            this.plugin.settings.enableLiveCursors = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Auto-connect on Startup')
      .setDesc('Automatically connect to the relay server when Obsidian launches')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoConnect)
          .onChange(async (val) => {
            this.plugin.settings.autoConnect = val;
            await this.plugin.saveSettings();
          })
      );
  }
}
