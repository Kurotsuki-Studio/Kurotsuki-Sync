import { App, Notice, PluginSettingTab, Setting, requestUrl } from 'obsidian';
import type KurotsukiSyncPlugin from './main';
import { SyncMode } from './types';
import { VaultSwitcherModal } from './ui/vault-switcher-modal';

export class KurotsukiSettingTab extends PluginSettingTab {
  plugin: KurotsukiSyncPlugin;

  constructor(app: App, plugin: KurotsukiSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName('General').setHeading();
    new Setting(containerEl).setDesc(
      'Configure your self-hosted relay server, collaboration profile, and synchronization scope.'
    );

    // Role & Connection State Banner
    const role = this.plugin.wsClient.getCurrentRole();
    const status = this.plugin.wsClient.getStatus();
    const latency = this.plugin.wsClient.getLatency();

    const banner = containerEl.createDiv({ cls: 'kurotsuki-settings-banner' });
    const bannerRow = banner.createDiv({ cls: 'kurotsuki-banner-row' });
    bannerRow.createSpan({ cls: `kurotsuki-status-dot kurotsuki-status-${status}` });
    bannerRow.createEl('strong', { text: `Relay Status: ${status.toUpperCase()}` });
    bannerRow.createSpan({
      cls: `kurotsuki-role-badge kurotsuki-role-${role}`,
      text: `ROLE: ${role.toUpperCase()}`,
    });

    if (latency !== null) {
      bannerRow.createSpan({ text: ` • Ping: ${latency}ms` });
    }

    if (role === 'viewer') {
      const viewerNotice = banner.createDiv({ cls: 'kurotsuki-banner-subnotice' });
      viewerNotice.textContent = '🔒 Read-Only Active: Editor changes in Obsidian are locked and local saves will not overwrite the relay.';
    }

    // Multi-Vault Profiles Header
    new Setting(containerEl).setName('🗂️ Multi-Vault & Room Profiles').setHeading();

    new Setting(containerEl)
      .setName('Manage Vault Profiles')
      .setDesc('Configure and switch between multiple remote rooms and vaults')
      .addButton((btn) =>
        btn
          .setButtonText('Switch / Edit Profiles')
          .setCta()
          .onClick(() => {
            new VaultSwitcherModal(this.app, this.plugin).open();
          })
      );

    // Server Configuration Header
    new Setting(containerEl).setName('🌐 Server Connection').setHeading();

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
      .setName('Room / Vault ID')
      .setDesc('Unique identifier for this vault room on the relay server')
      .addText((text) =>
        text
          .setPlaceholder('my-obsidian-vault')
          .setValue(this.plugin.settings.vaultId)
          .onChange(async (val) => {
            this.plugin.settings.vaultId = val.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Auth Token / Secret')
      .setDesc('Optional shared password/token for private relay rooms')
      .addText((text) =>
        text
          .setPlaceholder('Secret token')
          .setValue(this.plugin.settings.authToken)
          .onChange(async (val) => {
            this.plugin.settings.authToken = val.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Test Server Connection')
      .setDesc('Verify HTTP API reachability, token authentication, and WebSocket connectivity')
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
              const res = await requestUrl({
                url: `${httpBase}/api/v1/health`,
                throw: false,
              });
              if (res.status !== 200) {
                new Notice(`⚠️ Le serveur ne répond pas (HTTP ${res.status})`);
                return;
              }
              const statsRes = await requestUrl({
                url: `${httpBase}/api/v1/stats`,
                headers: { Authorization: `Bearer ${this.plugin.settings.authToken}` },
                throw: false,
              });
              if (statsRes.status === 401) {
                new Notice('❌ Token / Mot de passe incorrect ! Le serveur refuse la connexion.');
                return;
              }
              new Notice('✅ Connexion et mot de passe validés !');
              this.plugin.wsClient.disconnect(false);
              this.plugin.wsClient.connect();
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : 'Cannot reach server';
              new Notice(`❌ Connection failed: ${msg}`);
            } finally {
              btn.setDisabled(false);
              btn.setButtonText('Test Now');
            }
          })
      );

    // Profile Settings Header
    new Setting(containerEl).setName('👤 Collaborator Profile').setHeading();

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
    new Setting(containerEl).setName('📂 Synchronization Scope').setHeading();

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

    // Vault Push & Synchronization
    new Setting(containerEl).setName('⚡ Vault Push & Cloud Sync').setHeading();

    new Setting(containerEl)
      .setName('Push Entire Vault to Server')
      .setDesc('Upload and synchronize all local notes, folders, and media assets to your Kurotsuki Relay server right now.')
      .addButton((btn) =>
        btn
          .setButtonText('📤 Push Entire Vault Now')
          .setCta()
          .onClick(async () => {
            if (this.plugin.wsClient.getStatus() !== 'connected') {
              new Notice("⚠️ Le serveur relais n'est pas connecté. Veuillez vous connecter d'abord.");
              return;
            }
            btn.setDisabled(true);
            btn.setButtonText('Pushing...');
            const notice = new Notice('⏳ Poussement du coffre vers le serveur relais...', 0);
            try {
              const res = await this.plugin.syncEngine.pushEntireVault((cur, tot, p) => {
                notice.setMessage(`⏳ Synchronisation (${cur}/${tot}) :\n${p.split('/').pop()}`);
              });
              notice.hide();
              new Notice(`✅ Coffre envoyé avec succès ! (${res.success} fichiers synchronisés, ${res.failed} erreurs)`, 6000);
            } catch (err: unknown) {
              notice.hide();
              const msg = err instanceof Error ? err.message : String(err);
              new Notice(`❌ Erreur : ${msg}`);
            } finally {
              btn.setDisabled(false);
              btn.setButtonText('📤 Push Entire Vault Now');
            }
          })
      );
  }
}
