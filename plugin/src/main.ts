import { Editor, MarkdownView, Notice, Plugin, TFile } from 'obsidian';
import { AwarenessManager } from './awareness';
import { createCollabExtension } from './cm6-collab';
import { KurotsukiSettingTab } from './settings';
import { SyncEngine } from './sync-engine';
import { ConnectionStatus, DEFAULT_SETTINGS, KurotsukiSettings, UserProfile, WSMessage } from './types';
import { ShareModal } from './ui/share-modal';
import { StatusModal } from './ui/status-modal';
import { KurotsukiWSClient } from './ws-client';

export default class KurotsukiSyncPlugin extends Plugin {
  settings: KurotsukiSettings = DEFAULT_SETTINGS;
  wsClient!: KurotsukiWSClient;
  syncEngine!: SyncEngine;
  awareness!: AwarenessManager;
  private statusBarEl!: HTMLElement;
  private awarenessBroadcastInterval: number | null = null;

  async onload() {
    await this.loadSettings();

    // 1. Initialize Awareness
    const initialUser: UserProfile = {
      id: 'usr_' + Math.random().toString(36).substring(2, 9),
      name: this.settings.userName,
      color: this.settings.userColor,
    };
    this.awareness = new AwarenessManager(initialUser);

    // 2. Initialize WebSocket Client
    this.wsClient = new KurotsukiWSClient(this.settings, () => ({
      id: initialUser.id,
      name: this.settings.userName,
      color: this.settings.userColor,
    }));

    // 3. Initialize Sync Engine
    this.syncEngine = new SyncEngine(this.app, this.settings, this.wsClient);

    // 4. Register CM6 Editor Extension
    this.registerEditorExtension(
      createCollabExtension(
        this.awareness,
        () => this.app.workspace.getActiveFile()?.path || null,
        (path: string) => this.syncEngine.getOrCreateDoc(path)
      )
    );

    // 5. Register Status Bar
    this.setupStatusBar();

    // 6. Register Ribbon Icon
    this.addRibbonIcon('refresh-cw', 'Kurotsuki Sync', () => {
      new StatusModal(this.app, this.settings, this.wsClient, this.awareness).open();
    });

    // 7. Register Vault Events for Local Synchronization
    this.registerEvent(
      this.app.vault.on('modify', async (file) => {
        if (file instanceof TFile) {
          await this.syncEngine.onLocalFileModified(file);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('create', async (file) => {
        await this.syncEngine.onLocalFileCreated(file);
      })
    );

    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        this.syncEngine.onLocalFileDeleted(file);
      })
    );

    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        this.syncEngine.onLocalFileRenamed(file, oldPath);
      })
    );

    // 8. Track Active Workspace Leaf for Awareness
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        this.awareness.updateActiveFile(file ? file.path : null);
        this.broadcastLocalAwareness();
      })
    );

    // 9. Handle Inbound Awareness Updates
    this.wsClient.onMessage((msg: WSMessage) => {
      if (msg.type === 'awareness_update') {
        this.awareness.handleRemoteAwareness(msg.states);
      }
    });

    // Periodic Awareness broadcast (every 3 seconds)
    this.awarenessBroadcastInterval = window.setInterval(() => {
      if (this.wsClient.getStatus() === 'connected') {
        this.broadcastLocalAwareness();
      }
    }, 3000);

    // 10. Register Commands
    this.addCommand({
      id: 'kurotsuki-status',
      name: 'View Connection Status & Collaborators',
      callback: () => {
        new StatusModal(this.app, this.settings, this.wsClient, this.awareness).open();
      },
    });

    this.addCommand({
      id: 'kurotsuki-share-current',
      name: 'Share Current Note / Workspace Link',
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        new ShareModal(this.app, this.settings, file ? file.path : null).open();
      },
    });

    this.addCommand({
      id: 'kurotsuki-reconnect',
      name: 'Reconnect to Relay Server',
      callback: () => {
        this.wsClient.disconnect(false);
        this.wsClient.connect();
        new Notice('Kurotsuki Sync: Reconnecting...');
      },
    });

    this.addCommand({
      id: 'kurotsuki-force-sync-file',
      name: 'Force Sync Active Note',
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        const file = view.file;
        if (file) {
          await this.syncEngine.onLocalFileModified(file);
          new Notice(`Kurotsuki Sync: Synced ${file.name}`);
        }
      },
    });

    // 11. Add Settings Tab
    this.addSettingTab(new KurotsukiSettingTab(this.app, this));

    // 12. Connect if auto-connect enabled
    if (this.settings.autoConnect && this.settings.serverUrl) {
      this.wsClient.connect();
    }
  }

  onunload() {
    if (this.awarenessBroadcastInterval !== null) {
      window.clearInterval(this.awarenessBroadcastInterval);
    }
    this.wsClient.disconnect(true);
    this.syncEngine.destroy();
    this.awareness.destroy();
  }

  private broadcastLocalAwareness(): void {
    const local = this.awareness.getLocalState();
    this.wsClient.send({
      type: 'awareness_update',
      states: [local],
    });
  }

  private setupStatusBar(): void {
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass('kurotsuki-status-bar');

    const updateBar = (status: ConnectionStatus) => {
      this.statusBarEl.empty();
      const dot = this.statusBarEl.createSpan({ cls: `kurotsuki-status-dot kurotsuki-status-${status}` });
      const currentFile = this.app.workspace.getActiveFile();
      const peersInFile = currentFile ? this.awareness.getActivePeersForFile(currentFile.path).length : 0;

      let label = 'Kurotsuki';
      if (status === 'connected') {
        label = peersInFile > 0 ? `Kurotsuki (${peersInFile + 1} 👤)` : 'Kurotsuki (Connected)';
      } else if (status === 'connecting') {
        label = 'Kurotsuki (Connecting...)';
      } else if (status === 'error') {
        label = 'Kurotsuki (Error)';
      } else {
        label = 'Kurotsuki (Offline)';
      }

      this.statusBarEl.createSpan({ text: label });
    };

    this.wsClient.onStatusChange(updateBar);
    this.awareness.subscribe(() => updateBar(this.wsClient.getStatus()));

    this.statusBarEl.onclick = () => {
      new StatusModal(this.app, this.settings, this.wsClient, this.awareness).open();
    };
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.wsClient.updateSettings(this.settings);
    this.syncEngine.updateSettings(this.settings);
  }
}
