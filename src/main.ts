import { Editor, MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { AwarenessManager } from './awareness';
import { createCollabExtension, setReadOnlyEffect } from './cm6-collab';
import { KurotsukiSettingTab } from './settings';
import { SyncEngine } from './sync-engine';
import { DEFAULT_SETTINGS, KurotsukiSettings, UserProfile, UserRole, WSMessage } from './types';
import { HistoryInspectorModal } from './ui/history-inspector-modal';
import { KurotsukiPeerSidebarView, VIEW_TYPE_KUROTSUKI_PEERS } from './ui/peer-sidebar-view';
import { ShareModal } from './ui/share-modal';
import { StatusModal } from './ui/status-modal';
import { VaultSwitcherModal } from './ui/vault-switcher-modal';
import { KurotsukiWSClient } from './ws-client';

interface CMEditorHost {
  cm?: EditorView;
}

export default class KurotsukiSyncPlugin extends Plugin {
  settings: KurotsukiSettings = DEFAULT_SETTINGS;
  wsClient!: KurotsukiWSClient;
  syncEngine!: SyncEngine;
  awareness!: AwarenessManager;
  private statusBarEl!: HTMLElement;
  private awarenessBroadcastInterval: number | null = null;
  private awarenessDebounceTimer: number | null = null;
  private lastReadOnlyNoticeTime = 0;

  async onload() {
    await this.loadSettings();

    // 1. Initialize Awareness
    const initialUser: UserProfile = {
      id: 'usr_' + Math.random().toString(36).substring(2, 9),
      name: this.settings.userName,
      color: this.settings.userColor,
    };
    this.awareness = new AwarenessManager(initialUser);
    this.awareness.onLocalChange(() => {
      this.debouncedBroadcastAwareness();
    });

    // 2. Initialize WebSocket Client
    this.wsClient = new KurotsukiWSClient(this.settings, () => ({
      id: initialUser.id,
      name: this.settings.userName,
      color: this.settings.userColor,
      role: this.settings.currentRole,
    }));

    // 3. Initialize Sync Engine
    this.syncEngine = new SyncEngine(this.app, this.settings, this.wsClient);

    // 4. Register CM6 Editor Extension with Active Read-Only Guard
    this.registerEditorExtension(
      createCollabExtension(
        this.awareness,
        (view?: EditorView) => this.getPathForView(view),
        (path: string) => this.syncEngine.getOrCreateDoc(path),
        () => this.syncEngine.isReadOnly(),
        () => this.notifyReadOnlyAttempt()
      )
    );

    // 5. Register Peer Sidebar View
    this.registerView(
      VIEW_TYPE_KUROTSUKI_PEERS,
      (leaf) => new KurotsukiPeerSidebarView(leaf, this)
    );

    // 6. Register Status Bar
    this.setupStatusBar();

    // 7. Register Ribbon Icons
    this.addRibbonIcon('refresh-cw', 'Kurotsuki Sync Dashboard', () => {
      new StatusModal(this.app, this).open();
    });

    this.addRibbonIcon('users', 'Kurotsuki Collaborators', () => {
      void this.activatePeerSidebar();
    });

    // 8. Register Vault Events for Local Synchronization
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile) {
          void this.syncEngine.onLocalFileModified(file);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('create', (file) => {
        void this.syncEngine.onLocalFileCreated(file);
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

    // 9. Track Active Workspace Leaf for Awareness & Safe Disk Flush
    let previousActivePath: string | null = null;

    const handleActiveFileChange = async (fileOrLeafPath: string | null) => {
      if (previousActivePath && previousActivePath !== fileOrLeafPath) {
        await this.syncEngine.flushDocToDisk(previousActivePath);
      }
      previousActivePath = fileOrLeafPath;
      if (this.awareness.getLocalState().activeFile !== fileOrLeafPath) {
        this.awareness.updateActiveFile(fileOrLeafPath);
        this.broadcastLocalAwareness();
      }
    };

    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        void handleActiveFileChange(file ? file.path : null);
      })
    );

    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        if (leaf && leaf.view instanceof MarkdownView && leaf.view.file) {
          void handleActiveFileChange(leaf.view.file.path);
        }
      })
    );

    this.app.workspace.onLayoutReady(() => {
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile) {
        void handleActiveFileChange(activeFile.path);
      }
    });

    // 10. Handle Inbound Awareness Updates & Server Events
    this.wsClient.onMessage((msg: WSMessage) => {
      if (msg.type === 'awareness_update') {
        this.awareness.handleRemoteAwareness(msg.states);
      }
    });

    this.wsClient.onRoleChange((role: UserRole) => {
      this.settings.currentRole = role;
      this.syncEngine.updateSettings(this.settings);
      this.updateEditorReadOnlyState(role === 'viewer');
      if (role === 'viewer') {
        new Notice('🔒 Connected as Viewer: Vault is read-only. Editing is disabled.', 5000);
      }
    });

    // Periodic Awareness broadcast (every 3 seconds)
    this.awarenessBroadcastInterval = window.setInterval(() => {
      if (this.wsClient.getStatus() === 'connected') {
        const active = this.getRobustActiveFilePath();
        if (active && this.awareness.getLocalState().activeFile !== active) {
          this.awareness.updateActiveFile(active);
        }
        this.broadcastLocalAwareness();
      }
    }, 3000);

    // 11. Register Commands
    this.addCommand({
      id: 'kurotsuki-status',
      name: 'Open Sync Dashboard & Collaborators',
      callback: () => {
        new StatusModal(this.app, this).open();
      },
    });

    this.addCommand({
      id: 'kurotsuki-switch-vault',
      name: 'Switch Vault / Room Profile',
      callback: () => {
        new VaultSwitcherModal(this.app, this).open();
      },
    });

    this.addCommand({
      id: 'kurotsuki-open-peer-sidebar',
      name: 'Open Collaborators Sidebar Leaf',
      callback: async () => {
        await this.activatePeerSidebar();
      },
    });

    this.addCommand({
      id: 'kurotsuki-history',
      name: 'Open Sync & Conflict History Inspector',
      callback: () => {
        new HistoryInspectorModal(this.app, this).open();
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
          if (this.syncEngine.isReadOnly()) {
            new Notice('🔒 Cannot sync: Vault is in Read-Only (Viewer) mode');
            return;
          }
          await this.syncEngine.onLocalFileModified(file);
          new Notice(`Kurotsuki Sync: Synced ${file.name}`);
        }
      },
    });

    this.addCommand({
      id: 'kurotsuki-push-vault',
      name: 'Push Entire Vault to Relay Server',
      callback: async () => {
        if (this.wsClient.getStatus() !== 'connected') {
          new Notice('⚠️ Kurotsuki Relay is not connected. Connect first.');
          return;
        }
        const notice = new Notice('⏳ Pushing entire vault to Kurotsuki Relay...', 0);
        const res = await this.syncEngine.pushEntireVault((cur, tot, p) => {
          notice.setMessage(`⏳ Pushing vault: ${cur}/${tot}\n${p.split('/').pop()}`);
        });
        notice.hide();
        new Notice(`✅ Vault pushed to relay! (${res.success} files synchronized, ${res.failed} errors)`, 5000);
      },
    });

    // 12. Add Settings Tab
    this.addSettingTab(new KurotsukiSettingTab(this.app, this));

    // 13. Connect if auto-connect enabled
    if (this.settings.autoConnect && this.settings.serverUrl) {
      this.wsClient.connect();
    }
  }

  onunload() {
    if (this.awarenessBroadcastInterval !== null) {
      window.clearInterval(this.awarenessBroadcastInterval);
    }
    if (this.awarenessDebounceTimer !== null) {
      window.clearTimeout(this.awarenessDebounceTimer);
    }
    this.wsClient.disconnect(true);
    this.syncEngine.destroy();
    this.awareness.destroy();
  }

  public async activatePeerSidebar(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_KUROTSUKI_PEERS);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({
          type: VIEW_TYPE_KUROTSUKI_PEERS,
          active: true,
        });
      }
    }

    if (leaf) {
      await workspace.revealLeaf(leaf);
    }
  }

  private notifyReadOnlyAttempt(): void {
    const now = Date.now();
    // Debounce notice so it doesn't spam on repeated key presses
    if (now - this.lastReadOnlyNoticeTime > 3000) {
      this.lastReadOnlyNoticeTime = now;
      new Notice('🔒 Read-Only Note: You are connected as Viewer. Modifications cannot be saved.', 3500);
    }
  }

  private broadcastLocalAwareness(): void {
    const local = this.awareness.getLocalState();
    this.wsClient.send({
      type: 'awareness_update',
      states: [local],
    });
  }

  private debouncedBroadcastAwareness(): void {
    if (this.awarenessDebounceTimer !== null) {
      window.clearTimeout(this.awarenessDebounceTimer);
    }
    this.awarenessDebounceTimer = window.setTimeout(() => {
      this.awarenessDebounceTimer = null;
      if (this.wsClient.getStatus() === 'connected') {
        this.broadcastLocalAwareness();
      }
    }, 40);
  }

  private setupStatusBar(): void {
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass('kurotsuki-status-bar');

    const updateBar = () => {
      this.statusBarEl.empty();
      const status = this.wsClient.getStatus();
      const role = this.wsClient.getCurrentRole();
      const latency = this.wsClient.getLatency();

      this.statusBarEl.createSpan({ cls: `kurotsuki-status-dot kurotsuki-status-${status}` });
      const currentFile = this.app.workspace.getActiveFile();
      const peersInFile = currentFile ? this.awareness.getActivePeersForFile(currentFile.path).length : 0;

      let label = 'Kurotsuki';
      if (status === 'connected') {
        const peerCount = peersInFile > 0 ? ` (${peersInFile + 1} 👤)` : '';
        const roleTag = role === 'viewer' ? ' [🔒 Viewer]' : '';
        const pingTag = latency !== null ? ` • ${latency}ms` : '';
        label = `Kurotsuki${roleTag}${peerCount}${pingTag}`;
      } else if (status === 'connecting') {
        label = 'Kurotsuki (Connecting...)';
      } else if (status === 'error') {
        label = 'Kurotsuki (Error)';
      } else {
        label = 'Kurotsuki (Offline)';
      }

      this.statusBarEl.createSpan({ text: label });
    };

    this.wsClient.onStatusChange((status) => {
      updateBar();
      if (status === 'connected') {
        const active = this.getRobustActiveFilePath();
        if (active) {
          this.awareness.updateActiveFile(active);
        }
        this.broadcastLocalAwareness();
        void this.syncEngine.reconcileVault();
      }
    });
    this.wsClient.onLatencyChange(updateBar);
    this.wsClient.onRoleChange(updateBar);
    this.awareness.subscribe(updateBar);

    this.statusBarEl.onclick = () => {
      new StatusModal(this.app, this).open();
    };
  }

  public updateEditorReadOnlyState(readOnly: boolean): void {
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView && leaf.view.editor) {
        const host = leaf.view.editor as unknown as CMEditorHost;
        if (host.cm && typeof host.cm.dispatch === 'function') {
          host.cm.dispatch({
            effects: [setReadOnlyEffect.of(readOnly)],
          });
        }
      }
    });
  }

  public getPathForView(view?: EditorView): string | null {
    if (view && view.dom) {
      let foundPath: string | null = null;
      this.app.workspace.iterateAllLeaves((leaf) => {
        if (!foundPath && leaf.view instanceof MarkdownView && leaf.view.file) {
          if (
            (leaf.view.contentEl && leaf.view.contentEl.contains(view.dom)) ||
            (leaf.view.containerEl && leaf.view.containerEl.contains(view.dom))
          ) {
            foundPath = leaf.view.file.path;
          }
        }
      });
      if (foundPath) return foundPath;
      // If a specific view was given but doesn't belong to any open markdown leaf, do not bind to active file
      return null;
    }
    return this.getRobustActiveFilePath();
  }

  public getRobustActiveFilePath(): string | null {
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile) return activeFile.path;

    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView && activeView.file) return activeView.file.path;

    let path: string | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!path && leaf.view instanceof MarkdownView && leaf.view.file) {
        path = leaf.view.file.path;
      }
    });
    return path;
  }

  async loadSettings() {
    const data = (await this.loadData()) as Partial<KurotsukiSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data || {});
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.wsClient.updateSettings(this.settings);
    this.syncEngine.updateSettings(this.settings);
  }
}
