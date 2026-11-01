import { App, Modal, Notice, Setting } from 'obsidian';
import type KurotsukiSyncPlugin from '../main';
import { VaultProfile } from '../types';

export class VaultSwitcherModal extends Modal {
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

    contentEl.createEl('h2', { text: '🔄 Switch Vault / Room Profile' });
    contentEl.createEl('p', {
      text: 'Seamlessly switch synchronization to another shared Kurotsuki workspace or relay room.',
      cls: 'kurotsuki-modal-desc',
    });

    const profiles = this.plugin.settings.vaultProfiles || [];
    const activeId = this.plugin.settings.activeProfileId || (profiles[0] ? profiles[0].id : '');

    const listEl = contentEl.createDiv({ cls: 'kurotsuki-vault-profile-list' });

    if (profiles.length === 0) {
      listEl.createDiv({
        cls: 'kurotsuki-empty-state',
        text: 'No saved vault profiles yet. Add one below!',
      });
    }

    profiles.forEach((profile) => {
      const isActive = profile.id === activeId;
      const card = listEl.createDiv({
        cls: `kurotsuki-profile-card ${isActive ? 'kurotsuki-profile-active' : ''}`,
      });

      const header = card.createDiv({ cls: 'kurotsuki-profile-header' });
      const titleWrapper = header.createDiv({ cls: 'kurotsuki-profile-title' });

      titleWrapper.createSpan({
        cls: `kurotsuki-status-dot ${isActive ? 'kurotsuki-status-connected' : 'kurotsuki-status-offline'}`,
      });

      titleWrapper.createEl('strong', { text: profile.name || profile.vaultId });

      if (isActive) {
        header.createSpan({ cls: 'kurotsuki-badge-active', text: 'CURRENT' });
      }

      const meta = card.createDiv({ cls: 'kurotsuki-profile-meta' });
      meta.createDiv({ text: `Room: ${profile.vaultId}` });
      meta.createDiv({ text: `Server: ${profile.serverUrl}` });

      const actions = card.createDiv({ cls: 'kurotsuki-profile-actions' });

      if (!isActive) {
        const switchBtn = actions.createEl('button', {
          text: 'Switch To This Vault',
          cls: 'mod-cta',
        });
        switchBtn.onclick = async () => {
          await this.switchToProfile(profile);
        };
      }

      if (profiles.length > 1) {
        const deleteBtn = actions.createEl('button', {
          text: 'Remove',
          cls: 'mod-warning',
        });
        deleteBtn.onclick = async () => {
          this.plugin.settings.vaultProfiles = this.plugin.settings.vaultProfiles.filter(
            (p) => p.id !== profile.id
          );
          await this.plugin.saveSettings();
          this.render();
        };
      }
    });

    // Add New Profile Section
    new Setting(contentEl).setName('➕ Add Vault Profile').setHeading();

    let newName = '';
    let newVaultId = '';
    let newServerUrl = this.plugin.settings.serverUrl || 'ws://localhost:3000';
    let newAuthToken = '';

    new Setting(contentEl)
      .setName('Profile Name')
      .setDesc('Friendly label for this workspace profile')
      .addText((text) =>
        text.setPlaceholder('e.g. Engineering Collab').onChange((val) => {
          newName = val.trim();
        })
      );

    new Setting(contentEl)
      .setName('Vault / Room ID')
      .setDesc('Relay room identifier on the server')
      .addText((text) =>
        text.setPlaceholder('e.g. team-engineering').onChange((val) => {
          newVaultId = val.trim();
        })
      );

    new Setting(contentEl)
      .setName('Relay Server URL')
      .setDesc('WebSocket server address')
      .addText((text) =>
        text.setValue(newServerUrl).onChange((val) => {
          newServerUrl = val.trim();
        })
      );

    new Setting(contentEl)
      .setName('Authentication Secret / Token')
      .setDesc('Token assigned for this vault (or viewer token)')
      .addText((text) =>
        text.setPlaceholder('kuro_...').onChange((val) => {
          newAuthToken = val.trim();
        })
      );

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText('Save Profile')
        .setCta()
        .onClick(async () => {
          if (!newVaultId) {
            new Notice('Please specify a Vault / Room ID');
            return;
          }

          const newProfile: VaultProfile = {
            id: 'prof_' + Math.random().toString(36).substring(2, 9),
            name: newName || newVaultId,
            vaultId: newVaultId,
            serverUrl: newServerUrl,
            authToken: newAuthToken,
          };

          this.plugin.settings.vaultProfiles.push(newProfile);
          await this.plugin.saveSettings();
          new Notice(`Added profile "${newProfile.name}"`);
          this.render();
        })
    );
  }

  private async switchToProfile(profile: VaultProfile): Promise<void> {
    this.plugin.settings.activeProfileId = profile.id;
    this.plugin.settings.vaultId = profile.vaultId;
    this.plugin.settings.serverUrl = profile.serverUrl;
    this.plugin.settings.authToken = profile.authToken;

    await this.plugin.saveSettings();

    // Cleanly flush and reset previous in-memory docs for the new vault
    this.plugin.syncEngine.resetDocs();
    this.plugin.syncEngine.updateSettings(this.plugin.settings);
    this.plugin.wsClient.updateSettings(this.plugin.settings);

    // Reconnect websocket
    this.plugin.wsClient.disconnect(false);
    this.plugin.wsClient.connect();

    new Notice(`🌙 Switched to Vault: ${profile.name || profile.vaultId}`);
    this.close();
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
