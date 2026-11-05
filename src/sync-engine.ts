import { App, MarkdownView, Notice, TAbstractFile, TFile, requestUrl } from 'obsidian';
import * as Y from 'yjs';
import { KurotsukiSettings, SyncHistoryEntry, WSMessage } from './types';
import { base64ToUint8Array, normalizePath, uint8ArrayToBase64 } from './utils';
import { KurotsukiWSClient } from './ws-client';

export { base64ToUint8Array, normalizePath, uint8ArrayToBase64 } from './utils';

export class SyncEngine {
  private app: App;
  private settings: KurotsukiSettings;
  private wsClient: KurotsukiWSClient;
  private docs: Map<string, Y.Doc> = new Map();
  private remoteUpdateLocks: Map<string, number> = new Map();
  private pendingLocalDebounce: Map<string, number> = new Map();
  private pendingOutgoingUpdates: Map<string, Uint8Array[]> = new Map();
  private pendingOutgoingTimers: Map<string, number> = new Map();
  private historyLogs: SyncHistoryEntry[] = [];
  private lastUpdatePerFile: Map<string, { timestamp: number; author?: string }> = new Map();
  private serverKnownFiles: Set<string> = new Set();
  public onFileRenamed?: (newPath: string, oldPath: string) => void;

  public getFileByNormalizedPath(rawPath: string): TAbstractFile | null {
    if (!rawPath) return null;
    const clean = normalizePath(rawPath);
    const direct = this.app.vault.getAbstractFileByPath(clean);
    if (direct) return direct;

    const nfc = clean.normalize('NFC');
    const nfd = clean.normalize('NFD');
    const directNfc = this.app.vault.getAbstractFileByPath(nfc);
    if (directNfc) return directNfc;
    const directNfd = this.app.vault.getAbstractFileByPath(nfd);
    if (directNfd) return directNfd;

    const all = this.app.vault.getAllLoadedFiles();
    return all.find((f) => {
      const fnfc = normalizePath(f.path);
      return fnfc === nfc || fnfc === nfd;
    }) || null;
  }

  constructor(app: App, settings: KurotsukiSettings, wsClient: KurotsukiWSClient) {
    this.app = app;
    this.settings = settings;
    this.wsClient = wsClient;

    this.wsClient.onMessage((msg) => this.handleServerMessage(msg));
  }

  public updateSettings(settings: KurotsukiSettings): void {
    this.settings = settings;
  }

  public isReadOnly(): boolean {
    return this.settings.currentRole === 'viewer';
  }

  public shouldSync(path: string): boolean {
    if (!path) return false;
    const normalized = normalizePath(path);

    // Strict check: NEVER sync any hidden file or folder (e.g. .obsidian, .git, .trash, .smart-env)
    if (normalized.startsWith('.') || normalized.includes('/.') || normalized.includes('.obsidian')) {
      return false;
    }

    const configDir = this.app.vault.configDir;
    const cleanConfig = configDir ? normalizePath(configDir) : null;
    if (cleanConfig && (normalized === cleanConfig || normalized.startsWith(cleanConfig + '/'))) {
      return false;
    }

    if (this.settings.syncMode === 'entire_vault') {
      return true;
    }

    // Selective mode: check if path begins with any shared folder
    return this.settings.sharedFolders.some((folder) => {
      const cleanFolder = normalizePath(folder);
      if (!cleanFolder) return false;
      return normalized === cleanFolder || normalized.startsWith(cleanFolder + '/');
    });
  }

  public getDoc(rawPath: string): Y.Doc | undefined {
    return this.docs.get(normalizePath(rawPath));
  }

  private queueOutgoingYjsUpdate(path: string, update: Uint8Array): void {
    let list = this.pendingOutgoingUpdates.get(path);
    if (!list) {
      list = [];
      this.pendingOutgoingUpdates.set(path, list);
    }
    list.push(update);

    if (!this.pendingOutgoingTimers.has(path)) {
      const timer = window.setTimeout ? window.setTimeout(() => {
        this.flushOutgoingYjsUpdate(path);
      }, 30) : (setTimeout(() => {
        this.flushOutgoingYjsUpdate(path);
      }, 30) as unknown as number);
      this.pendingOutgoingTimers.set(path, timer);
    }
  }

  public flushOutgoingYjsUpdate(path: string): void {
    const timer = this.pendingOutgoingTimers.get(path);
    if (timer !== undefined) {
      if (typeof window !== 'undefined' && window.clearTimeout) {
        window.clearTimeout(timer);
      } else {
        clearTimeout(timer);
      }
      this.pendingOutgoingTimers.delete(path);
    }

    const updates = this.pendingOutgoingUpdates.get(path);
    this.pendingOutgoingUpdates.delete(path);
    if (!updates || updates.length === 0) return;

    const merged = updates.length === 1 ? updates[0] : Y.mergeUpdates(updates);
    const b64 = uint8ArrayToBase64(merged);

    this.recordHistory({
      type: 'local_update',
      path,
      sizeBytes: merged.length,
      summary: `Sent local CRDT update (${merged.length} bytes${updates.length > 1 ? `, ${updates.length} batched` : ''})`,
    });

    this.wsClient.send({
      type: 'yjs_sync',
      path,
      update: b64,
    });
  }

  public flushAllOutgoingUpdates(): void {
    const paths = Array.from(this.pendingOutgoingUpdates.keys());
    for (const p of paths) {
      this.flushOutgoingYjsUpdate(p);
    }
  }

  public getOrCreateDoc(rawPath: string, initialContent?: string): Y.Doc {
    const path = normalizePath(rawPath);
    let doc = this.docs.get(path);
    if (!doc) {
      doc = new Y.Doc();
      const yText = doc.getText('content');

      // CRITICAL: Only seed initialContent if this file is genuinely NOT on the server yet!
      // If the file is known to the server, NEVER insert initialContent locally at position 0!
      // Doing so creates a concurrent root insert in Yjs that duplicates the entire document!
      const isKnownOnServer = this.serverKnownFiles.has(path);
      if (!isKnownOnServer && initialContent !== undefined && yText.length === 0) {
        yText.insert(0, initialContent);
      } else if (isKnownOnServer) {
        // Request the authoritative CRDT document from the server
        this.requestDocFromServer(path);
      }

      // Listen for local changes to this doc to transmit to server
      doc.on('update', (update: Uint8Array, origin: unknown) => {
        // If origin is remote or internal load, don't broadcast back
        if (origin === 'remote' || origin === 'internal') return;

        // If client is in read-only mode, block sending Yjs updates
        if (this.isReadOnly()) {
          console.warn(`[Kurotsuki] Sync blocked: Vault is in read-only mode for ${path}`);
          return;
        }

        this.queueOutgoingYjsUpdate(path, update);
      });

      this.docs.set(path, doc);
    }
    return doc;
  }

  public requestDocFromServer(rawPath: string): void {
    const path = normalizePath(rawPath);
    if (!this.shouldSync(path)) return;
    if (this.wsClient.getStatus() === 'connected') {
      this.wsClient.send({
        type: 'doc_request',
        path,
      });
    }
  }

  public removeDoc(rawPath: string): void {
    const path = normalizePath(rawPath);
    const doc = this.docs.get(path);
    if (doc) {
      doc.destroy();
      this.docs.delete(path);
    }
  }

  public isOpenInEditor(rawPath: string): boolean {
    const path = normalizePath(rawPath);
    if (!path) return false;

    // Fast check: active file in workspace
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile && normalizePath(activeFile.path) === path) {
      return true;
    }

    // Check active view of type MarkdownView
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView?.file && normalizePath(activeView.file.path) === path) {
      return true;
    }

    // Check all open leaves across mobile and desktop without fragile instanceof
    let open = false;
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (view) {
        const viewFile = (view as any).file;
        if (viewFile && normalizePath(viewFile.path) === path) {
          open = true;
        }
      }
    });
    return open;
  }

  public async onLocalFileModified(file: TFile): Promise<void> {
    const cleanPath = normalizePath(file.path);
    if (!this.shouldSync(cleanPath)) return;
    if (this.isLocked(cleanPath)) return;

    // Block local modifications from affecting CRDT or syncing if user is viewer
    if (this.isReadOnly()) {
      return;
    }

    // IMPORTANT: If this file is currently open in ANY editor in Obsidian,
    // the CM6 extension is ALREADY tracking every keystroke directly into Yjs!
    // Do NOT read stale disk cache and do NOT overwrite Yjs while user is typing!
    if (this.isOpenInEditor(cleanPath)) {
      return;
    }

    // For markdown files: sync text via Yjs with surgical diff
    if (file.extension === 'md' || file.extension === 'txt' || file.extension === 'canvas') {
      const content = await this.app.vault.read(file);
      const doc = this.getOrCreateDoc(cleanPath);
      const yText = doc.getText('content');
      this.applyTextDiff(yText, content);
    } else if (this.settings.syncAttachments) {
      // Binary attachment sync
      await this.syncAttachment(file);
    }
  }

  private applyTextDiff(yText: Y.Text, newText: string): void {
    const oldText = yText.toString();
    if (oldText === newText) return;

    let start = 0;
    while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) {
      start++;
    }

    let oldEnd = oldText.length;
    let newEnd = newText.length;
    while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }

    const deleteCount = oldEnd - start;
    const insertStr = newText.substring(start, newEnd);

    const doc = yText.doc;
    if (doc) {
      doc.transact(() => {
        if (deleteCount > 0) {
          yText.delete(start, deleteCount);
        }
        if (insertStr.length > 0) {
          yText.insert(start, insertStr);
        }
      }, 'local-file-diff');
    }
  }

  public async pushEntireVault(
    onProgress?: (current: number, total: number, path: string) => void
  ): Promise<{ success: number; failed: number }> {
    if (this.isReadOnly()) {
      new Notice('🔒 Cannot push: Vault is in Read-Only (Viewer) mode');
      return { success: 0, failed: 0 };
    }

    const allFiles = this.app.vault.getFiles().filter((f) => this.shouldSync(f.path));
    let success = 0;
    let failed = 0;

    for (let i = 0; i < allFiles.length; i++) {
      const file = allFiles[i];
      if (onProgress) {
        onProgress(i + 1, allFiles.length, file.path);
      }

      try {
        if (file.extension === 'md' || file.extension === 'txt' || file.extension === 'canvas') {
          const content = await this.app.vault.read(file);
          const doc = this.getOrCreateDoc(file.path, content);
          const state = Y.encodeStateAsUpdate(doc);

          this.wsClient.send({
            type: 'file_event',
            action: 'create',
            path: file.path,
            mtime: file.stat.mtime,
          });

          this.wsClient.send({
            type: 'yjs_sync',
            path: file.path,
            update: uint8ArrayToBase64(state),
          });
        } else if (this.settings.syncAttachments) {
          await this.syncAttachment(file);
        }

        this.trackSyncedFile(file.path);
        success++;
      } catch (err) {
        console.error(`[Kurotsuki] Failed to push file ${file.path}:`, err);
        failed++;
      }
    }

    this.recordHistory({
      type: 'local_update',
      path: '*',
      summary: `Pushed entire vault to relay (${success} files, ${failed} failed)`,
    });

    return { success, failed };
  }

  private getSyncedFilesMap(): Record<string, number> {
    if (!this.settings.syncedFiles) {
      this.settings.syncedFiles = {};
    }
    return this.settings.syncedFiles;
  }

  private trackSyncedFile(path: string): void {
    const map = this.getSyncedFilesMap();
    map[path] = Date.now();
  }

  private untrackSyncedFile(path: string): void {
    const map = this.getSyncedFilesMap();
    delete map[path];
  }

  private isAttachmentPath(path: string): boolean {
    const ext = path.split('.').pop()?.toLowerCase();
    return ext !== 'md' && ext !== 'txt' && ext !== 'canvas';
  }

  public async onLocalFileCreated(file: TAbstractFile): Promise<void> {
    if (!this.shouldSync(file.path)) return;
    if (this.isLocked(file.path)) return;
    if (this.isReadOnly()) return;

    if (file instanceof TFile) {
      if (file.extension === 'md' || file.extension === 'txt' || file.extension === 'canvas') {
        const content = await this.app.vault.read(file);
        const doc = this.getOrCreateDoc(file.path, content);
        const state = Y.encodeStateAsUpdate(doc);
        this.wsClient.send({
          type: 'yjs_sync',
          path: file.path,
          update: uint8ArrayToBase64(state),
        });
      } else if (this.settings.syncAttachments) {
        await this.syncAttachment(file);
      }
      this.trackSyncedFile(file.path);
      this.recordHistory({
        type: 'file_event',
        path: file.path,
        summary: `Created file ${file.name}`,
      });
      this.wsClient.send({
        type: 'file_event',
        action: 'create',
        path: file.path,
        mtime: file.stat.mtime,
      });
    }
  }

  public onLocalFileDeleted(file: TAbstractFile): void {
    const cleanPath = normalizePath(file.path);
    if (!this.shouldSync(cleanPath)) return;
    if (this.isLocked(cleanPath)) return;
    if (this.isReadOnly()) return;

    this.removeDoc(cleanPath);
    this.serverKnownFiles.delete(cleanPath);
    this.untrackSyncedFile(cleanPath);
    this.recordHistory({
      type: 'file_event',
      path: cleanPath,
      summary: `Deleted file ${file.name}`,
    });
    this.wsClient.send({
      type: 'file_event',
      action: 'delete',
      path: cleanPath,
      mtime: Date.now(),
    });
  }

  public onLocalFileRenamed(file: TAbstractFile, rawOldPath: string): void {
    const cleanPath = normalizePath(file.path);
    const cleanOldPath = normalizePath(rawOldPath);
    if (!this.shouldSync(cleanPath) && !this.shouldSync(cleanOldPath)) return;
    if (this.isLocked(cleanPath) || this.isLocked(cleanOldPath)) return;
    if (this.isReadOnly()) return;

    this.lockPath(cleanPath, 3000);
    this.lockPath(cleanOldPath, 3000);

    // Migrate doc if exists
    const doc = this.docs.get(cleanOldPath);
    if (doc) {
      this.docs.delete(cleanOldPath);
      this.docs.set(cleanPath, doc);
    }
    this.serverKnownFiles.delete(cleanOldPath);
    this.serverKnownFiles.add(cleanPath);
    this.untrackSyncedFile(cleanOldPath);
    this.trackSyncedFile(cleanPath);

    this.recordHistory({
      type: 'file_event',
      path: cleanPath,
      summary: `Renamed file from ${cleanOldPath} to ${cleanPath}`,
    });

    this.wsClient.send({
      type: 'file_event',
      action: 'rename',
      path: cleanPath,
      oldPath: cleanOldPath,
      mtime: Date.now(),
    });
  }

  private handleServerMessage(msg: WSMessage): void {
    switch (msg.type) {
      case 'yjs_sync':
        void this.handleRemoteYjsSync(msg.path, msg.update);
        break;
      case 'file_event':
        void this.handleRemoteFileEvent(msg);
        break;
      case 'file_list_response':
        void this.handleFileListResponse(msg.files);
        break;
      case 'doc_response':
        void this.handleDocResponse(msg.path, msg.update);
        break;
      case 'error':
        this.recordHistory({
          type: 'error',
          path: '',
          summary: `Server Error: ${msg.message}`,
        });
        if (msg.code === 'ERR_READONLY') {
          new Notice('🔒 Read-Only: Edit rejected by server.', 4000);
        }
        break;
      default:
        break;
    }
  }

  public reconcileVault(): void {
    if (this.wsClient.getStatus() === 'connected') {
      this.wsClient.send({
        type: 'file_list_request',
      });
    }
  }

  public async handleFileListResponse(remoteFiles: Array<{ path: string; mtime: number; isAttachment?: boolean }>): Promise<void> {
    const remotePaths = new Set(remoteFiles.map((f) => normalizePath(f.path)));
    this.serverKnownFiles = remotePaths;

    // 1. Process all remote files from server: only download files missing on local disk
    for (const rf of remoteFiles) {
      const cleanRemotePath = normalizePath(rf.path);
      if (!this.shouldSync(cleanRemotePath)) continue;
      const localFile = this.getFileByNormalizedPath(cleanRemotePath);

      if (!localFile) {
        // Missing on local disk -> fetch and create locally
        this.trackSyncedFile(cleanRemotePath);
        if (rf.isAttachment || this.isAttachmentPath(cleanRemotePath)) {
          await this.downloadAttachment(cleanRemotePath);
        } else {
          this.wsClient.send({
            type: 'doc_request',
            path: cleanRemotePath,
          });
        }
      } else {
        // Already exists on local disk -> keep tracked without flooding disk writes
        this.trackSyncedFile(cleanRemotePath);
      }
    }

    // 2. Check local files: if server doesn't have it, upload/push it to server! (NEVER delete local files)
    const localFiles = this.app.vault.getFiles();
    for (const file of localFiles) {
      const cleanLocalPath = normalizePath(file.path);
      if (!this.shouldSync(cleanLocalPath)) continue;
      if (!remotePaths.has(cleanLocalPath)) {
        if (!this.isReadOnly()) {
          this.trackSyncedFile(cleanLocalPath);
          this.serverKnownFiles.add(cleanLocalPath);
          if (this.isAttachmentPath(cleanLocalPath)) {
            if (this.settings.syncAttachments) {
              await this.syncAttachment(file);
            }
          } else {
            const content = await this.app.vault.read(file);
            const doc = this.getOrCreateDoc(cleanLocalPath, content);
            const state = Y.encodeStateAsUpdate(doc);
            this.wsClient.send({
              type: 'file_event',
              action: 'create',
              path: cleanLocalPath,
              mtime: file.stat.mtime,
            });
            this.wsClient.send({
              type: 'yjs_sync',
              path: cleanLocalPath,
              update: uint8ArrayToBase64(state),
            });
            // Small pause between file seeding to prevent starving the event loop
            await new Promise((resolve) => setTimeout(resolve, 15));
          }
        }
      }
    }
  }

  private async handleDocResponse(rawPath: string, updateB64: string): Promise<void> {
    const path = normalizePath(rawPath);
    if (!this.shouldSync(path)) return;
    const update = base64ToUint8Array(updateB64);
    const doc = this.getOrCreateDoc(path);
    Y.applyUpdate(doc, update, 'remote');
    this.trackSyncedFile(path);
    this.serverKnownFiles.add(path);

    const yText = doc.getText('content');

    // If doc from server was completely empty, seed it from local file
    if (yText.length === 0) {
      const file = this.getFileByNormalizedPath(path);
      if (file instanceof TFile) {
        try {
          const content = await this.app.vault.read(file);
          if (content.length > 0 && yText.length === 0) {
            doc.transact(() => {
              yText.insert(0, content);
            }, 'seed');
            const seedUpdate = Y.encodeStateAsUpdate(doc);
            this.wsClient.send({
              type: 'yjs_sync',
              path,
              update: uint8ArrayToBase64(seedUpdate),
            });
          }
        } catch (e) {
          console.error(`[Kurotsuki] Error seeding doc from local file ${path}:`, e);
        }
      }
    }

    if (!this.isOpenInEditor(path)) {
      const content = yText.toString();
      // Only write to vault if content on disk is actually different
      const abstractFile = this.getFileByNormalizedPath(path);
      if (abstractFile instanceof TFile) {
        const diskContent = await this.app.vault.read(abstractFile);
        if (diskContent === content) {
          return; // Skip identical write, prevent triggering Obsidian re-indexing
        }
      }
      await this.writeToVaultSafely(path, content);
    }
  }

  private async downloadAttachment(relativePath: string): Promise<void> {
    try {
      let httpBase = this.settings.serverUrl.replace(/^ws:\/\//, 'http://').replace(/^wss:\/\//, 'https://');
      const url = `${httpBase}/api/v1/attachments/${encodeURIComponent(this.settings.vaultId)}/${encodeURIComponent(relativePath)}`;
      const res = await requestUrl({
        url,
        headers: {
          Authorization: `Bearer ${this.settings.authToken}`,
        },
        throw: false,
      });
      if (res.status === 200) {
        const arrayBuffer = res.arrayBuffer;
        this.lockPath(relativePath, 2000);
        await this.ensureFolderExists(relativePath);
        const existing = this.getFileByNormalizedPath(relativePath);
        if (existing instanceof TFile) {
          await this.app.vault.modifyBinary(existing, arrayBuffer);
        } else if (!existing) {
          await this.app.vault.createBinary(relativePath, arrayBuffer);
        }
      }
    } catch (e) {
      console.error(`[Kurotsuki] Error downloading attachment ${relativePath}:`, e);
    }
  }

  private async handleRemoteYjsSync(rawPath: string, updateB64: string): Promise<void> {
    const path = normalizePath(rawPath);
    if (!this.shouldSync(path)) return;

    const update = base64ToUint8Array(updateB64);
    const doc = this.getOrCreateDoc(path);

    const now = Date.now();
    const last = this.lastUpdatePerFile.get(path);
    if (last && now - last.timestamp < 2000) {
      this.recordHistory({
        type: 'conflict_detected',
        path,
        sizeBytes: update.length,
        summary: `Concurrent CRDT edits resolved seamlessly for ${path}`,
      });
    } else {
      this.recordHistory({
        type: 'remote_update',
        path,
        sizeBytes: update.length,
        summary: `Received remote CRDT sync (${update.length} bytes)`,
      });
    }
    this.lastUpdatePerFile.set(path, { timestamp: now });

    // Apply update with origin 'remote'
    Y.applyUpdate(doc, update, 'remote');

    // Debounce writing updated content to disk if not actively open
    this.debounceDiskWrite(path, doc);
  }

  private debounceDiskWrite(path: string, doc: Y.Doc): void {
    const existing = this.pendingLocalDebounce.get(path);
    if (existing) {
      if (typeof window !== 'undefined' && window.clearTimeout) {
        window.clearTimeout(existing);
      } else {
        clearTimeout(existing);
      }
    }

    const timer = window.setTimeout ? window.setTimeout(async () => {
      this.pendingLocalDebounce.delete(path);

      // Protect active editor: do NOT overwrite the file on disk while open in editor
      if (this.isOpenInEditor(path)) {
        return;
      }

      const text = doc.getText('content').toString();
      await this.writeToVaultSafely(path, text);
    }, 1500) : (setTimeout(async () => {
      this.pendingLocalDebounce.delete(path);

      if (this.isOpenInEditor(path)) {
        return;
      }

      const text = doc.getText('content').toString();
      await this.writeToVaultSafely(path, text);
    }, 1500) as unknown as number);

    this.pendingLocalDebounce.set(path, timer);
  }

  public async flushDocToDisk(path: string): Promise<void> {
    this.flushOutgoingYjsUpdate(path);
    const timer = this.pendingLocalDebounce.get(path);
    if (timer) {
      if (typeof window !== 'undefined' && window.clearTimeout) {
        window.clearTimeout(timer);
      } else {
        clearTimeout(timer);
      }
      this.pendingLocalDebounce.delete(path);
    }
    const doc = this.docs.get(path);
    if (doc) {
      const text = doc.getText('content').toString();
      await this.writeToVaultSafely(path, text);
    }
  }

  private async writeToVaultSafely(path: string, content: string): Promise<void> {
    const abstractFile = this.getFileByNormalizedPath(path);
    this.lockPath(path, 1500);

    try {
      if (abstractFile instanceof TFile) {
        const currentContent = await this.app.vault.read(abstractFile);
        if (currentContent !== content) {
          await this.app.vault.modify(abstractFile, content);
        }
      } else if (!abstractFile) {
        // Ensure folder path exists
        const lastSlash = path.lastIndexOf('/');
        if (lastSlash > 0) {
          const folderPath = path.substring(0, lastSlash);
          await this.ensureFolderExists(folderPath);
        }
        await this.app.vault.create(path, content);
      }
    } catch (err) {
      console.error(`[Kurotsuki] Error writing remote change to ${path}:`, err);
    }
  }

  private async handleRemoteFileEvent(msg: Extract<WSMessage, { type: 'file_event' }>): Promise<void> {
    const cleanPath = normalizePath(msg.path);
    const cleanOldPath = msg.oldPath ? normalizePath(msg.oldPath) : undefined;
    const { action } = msg;
    if (!this.shouldSync(cleanPath)) return;

    this.lockPath(cleanPath, 2000);
    if (cleanOldPath) this.lockPath(cleanOldPath, 2000);

    this.recordHistory({
      type: 'file_event',
      path: cleanPath,
      summary: `Remote file event: ${action} on ${cleanPath}`,
    });

    try {
      const file = this.getFileByNormalizedPath(cleanPath);

      if (action === 'delete') {
        if (file) {
          this.removeDoc(cleanPath);
          this.serverKnownFiles.delete(cleanPath);
          this.untrackSyncedFile(cleanPath);
          await this.app.fileManager.trashFile(file);
        }
      } else if (action === 'rename' && cleanOldPath) {
        if (!this.shouldSync(cleanPath) && !this.shouldSync(cleanOldPath)) return;

        this.lockPath(cleanPath, 3000);
        this.lockPath(cleanOldPath, 3000);

        const oldFile = this.getFileByNormalizedPath(cleanOldPath);
        if (oldFile) {
          const doc = this.docs.get(cleanOldPath);
          if (doc) {
            this.docs.delete(cleanOldPath);
            this.docs.set(cleanPath, doc);
          }
          this.serverKnownFiles.delete(cleanOldPath);
          this.serverKnownFiles.add(cleanPath);
          this.untrackSyncedFile(cleanOldPath);
          this.trackSyncedFile(cleanPath);
          await this.ensureFolderExists(cleanPath);
          await this.app.fileManager.renameFile(oldFile, cleanPath);
          this.onFileRenamed?.(cleanPath, cleanOldPath);
        }
      } else if (action === 'create' || action === 'modify') {
        this.trackSyncedFile(cleanPath);
        this.serverKnownFiles.add(cleanPath);
        if (this.isAttachmentPath(cleanPath)) {
          await this.downloadAttachment(cleanPath);
        } else {
          this.wsClient.send({
            type: 'doc_request',
            path: cleanPath,
          });
        }
      }
    } catch (err) {
      console.error(`[Kurotsuki] Error executing remote file event ${action}:`, err);
    }
  }

  private async syncAttachment(file: TFile): Promise<void> {
    if (this.isReadOnly()) return;

    const maxBytes = (this.settings.maxAttachmentSizeMB || 20) * 1024 * 1024;
    if (file.stat.size > maxBytes) {
      console.warn(`[Kurotsuki] Skipping attachment ${file.path}: size exceeds limit (${file.stat.size} bytes)`);
      return;
    }

    try {
      const buffer = await this.app.vault.readBinary(file);
      // Derive HTTP endpoint from serverUrl
      let httpBase = this.settings.serverUrl.replace(/^ws:\/\//, 'http://').replace(/^wss:\/\//, 'https://');
      const url = `${httpBase}/api/v1/attachments/${encodeURIComponent(this.settings.vaultId)}/${encodeURIComponent(file.path)}`;

      const res = await requestUrl({
        url,
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${this.settings.authToken}`,
          'Content-Type': 'application/octet-stream',
        },
        body: buffer,
        throw: false,
      });

      if (res.status !== 200 && res.status !== 201) {
        if (res.status === 403) {
          new Notice('🔒 Read-Only: Attachment upload blocked by server.');
        }
      }
    } catch (err) {
      console.error(`[Kurotsuki] Failed to sync attachment ${file.path}:`, err);
    }
  }

  private async ensureFolderExists(folderPath: string): Promise<void> {
    const parts = folderPath.split('/');
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.getFileByNormalizedPath(current);
      if (!existing) {
        try {
          await this.app.vault.createFolder(current);
        } catch {
          // Folder may have been created concurrently
        }
      }
    }
  }

  private lockPath(path: string, durationMs: number): void {
    this.remoteUpdateLocks.set(path, Date.now() + durationMs);
  }

  public isLocked(path: string): boolean {
    const expiry = this.remoteUpdateLocks.get(path);
    if (!expiry) return false;
    if (Date.now() > expiry) {
      this.remoteUpdateLocks.delete(path);
      return false;
    }
    return true;
  }

  private recordHistory(entry: Omit<SyncHistoryEntry, 'id' | 'timestamp'>): void {
    const item: SyncHistoryEntry = {
      id: 'hist_' + Math.random().toString(36).substring(2, 9),
      timestamp: Date.now(),
      ...entry,
    };
    this.historyLogs.unshift(item);
    if (this.historyLogs.length > 200) {
      this.historyLogs.pop();
    }
  }

  public getHistoryLogs(): SyncHistoryEntry[] {
    return this.historyLogs;
  }

  public clearHistory(): void {
    this.historyLogs = [];
  }

  public resetDocs(): void {
    this.flushAllOutgoingUpdates();
    for (const timer of this.pendingLocalDebounce.values()) {
      if (typeof window !== 'undefined' && window.clearTimeout) {
        window.clearTimeout(timer);
      } else {
        clearTimeout(timer);
      }
    }
    this.pendingLocalDebounce.clear();
    for (const timer of this.pendingOutgoingTimers.values()) {
      if (typeof window !== 'undefined' && window.clearTimeout) {
        window.clearTimeout(timer);
      } else {
        clearTimeout(timer);
      }
    }
    this.pendingOutgoingTimers.clear();
    this.pendingOutgoingUpdates.clear();
    for (const doc of this.docs.values()) {
      doc.destroy();
    }
    this.docs.clear();
    this.remoteUpdateLocks.clear();
  }

  public destroy(): void {
    this.resetDocs();
  }
}
