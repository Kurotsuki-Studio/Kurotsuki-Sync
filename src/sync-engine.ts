import { App, Notice, TAbstractFile, TFile, TFolder } from 'obsidian';
import * as Y from 'yjs';
import { KurotsukiSettings, SyncHistoryEntry, WSMessage } from './types';
import { base64ToUint8Array, uint8ArrayToBase64 } from './utils';
import { KurotsukiWSClient } from './ws-client';

export { base64ToUint8Array, uint8ArrayToBase64 } from './utils';

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
    // Exclude hidden files / system folders
    if (path.startsWith('.obsidian/') || path.startsWith('.git/') || path.startsWith('.trash/')) {
      return false;
    }

    if (this.settings.syncMode === 'entire_vault') {
      return true;
    }

    // Selective mode: check if path begins with any shared folder
    const normalized = path.replace(/\\/g, '/');
    return this.settings.sharedFolders.some((folder) => {
      const cleanFolder = folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (!cleanFolder) return false;
      return normalized === cleanFolder || normalized.startsWith(cleanFolder + '/');
    });
  }

  public getDoc(path: string): Y.Doc | undefined {
    return this.docs.get(path);
  }

  private queueOutgoingYjsUpdate(path: string, update: Uint8Array): void {
    let list = this.pendingOutgoingUpdates.get(path);
    if (!list) {
      list = [];
      this.pendingOutgoingUpdates.set(path, list);
    }
    list.push(update);

    if (!this.pendingOutgoingTimers.has(path)) {
      const timer = window.setTimeout(() => {
        this.flushOutgoingYjsUpdate(path);
      }, 25);
      this.pendingOutgoingTimers.set(path, timer);
    }
  }

  private flushOutgoingYjsUpdate(path: string): void {
    const timer = this.pendingOutgoingTimers.get(path);
    if (timer) {
      window.clearTimeout(timer);
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
      summary: `Sent local CRDT update (${merged.length} bytes)`,
    });

    this.wsClient.send({
      type: 'yjs_sync',
      path,
      update: b64,
    });
  }

  public getOrCreateDoc(path: string, initialContent?: string): Y.Doc {
    let doc = this.docs.get(path);
    if (!doc) {
      doc = new Y.Doc();
      const yText = doc.getText('content');
      if (initialContent !== undefined && yText.length === 0) {
        yText.insert(0, initialContent);
      }

      // Listen for local changes to this doc to transmit to server
      doc.on('update', (update: Uint8Array, origin: any) => {
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

  public removeDoc(path: string): void {
    const doc = this.docs.get(path);
    if (doc) {
      doc.destroy();
      this.docs.delete(path);
    }
  }

  public async onLocalFileModified(file: TFile): Promise<void> {
    if (!this.shouldSync(file.path)) return;
    if (this.isLocked(file.path)) return;

    // Block local modifications from affecting CRDT or syncing if user is viewer
    if (this.isReadOnly()) {
      return;
    }

    // IMPORTANT: If this file is currently open in the active editor,
    // the CM6 extension is ALREADY tracking every keystroke directly into Yjs!
    // Do NOT read stale disk cache and do NOT overwrite Yjs while user is typing!
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile && activeFile.path === file.path) {
      return;
    }

    // For markdown files: sync text via Yjs with surgical diff
    if (file.extension === 'md' || file.extension === 'txt' || file.extension === 'canvas') {
      const content = await this.app.vault.read(file);
      const doc = this.getOrCreateDoc(file.path);
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
    if (!this.shouldSync(file.path)) return;
    if (this.isLocked(file.path)) return;
    if (this.isReadOnly()) return;

    this.removeDoc(file.path);
    this.untrackSyncedFile(file.path);
    this.recordHistory({
      type: 'file_event',
      path: file.path,
      summary: `Deleted file ${file.name}`,
    });
    this.wsClient.send({
      type: 'file_event',
      action: 'delete',
      path: file.path,
      mtime: Date.now(),
    });
  }

  public onLocalFileRenamed(file: TAbstractFile, oldPath: string): void {
    if (!this.shouldSync(file.path) && !this.shouldSync(oldPath)) return;
    if (this.isLocked(file.path) || this.isLocked(oldPath)) return;
    if (this.isReadOnly()) return;

    // Migrate doc if exists
    const doc = this.docs.get(oldPath);
    if (doc) {
      this.docs.delete(oldPath);
      this.docs.set(file.path, doc);
    }
    this.untrackSyncedFile(oldPath);
    this.trackSyncedFile(file.path);

    this.recordHistory({
      type: 'file_event',
      path: file.path,
      summary: `Renamed file from ${oldPath} to ${file.path}`,
    });

    this.wsClient.send({
      type: 'file_event',
      action: 'rename',
      path: file.path,
      oldPath,
      mtime: Date.now(),
    });
  }

  private handleServerMessage(msg: WSMessage): void {
    switch (msg.type) {
      case 'yjs_sync':
        this.handleRemoteYjsSync(msg.path, msg.update);
        break;
      case 'file_event':
        this.handleRemoteFileEvent(msg);
        break;
      case 'file_list_response':
        this.handleFileListResponse(msg.files);
        break;
      case 'doc_response':
        this.handleDocResponse(msg.path, msg.update);
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
    const remotePaths = new Set(remoteFiles.map((f) => f.path));

    // 1. Process all remote files from server: download anything we don't have
    for (const rf of remoteFiles) {
      if (!this.shouldSync(rf.path)) continue;
      const localFile = this.app.vault.getAbstractFileByPath(rf.path);

      if (!localFile) {
        // Missing on local disk -> fetch and create locally
        this.trackSyncedFile(rf.path);
        if (rf.isAttachment || this.isAttachmentPath(rf.path)) {
          await this.downloadAttachment(rf.path);
        } else {
          this.wsClient.send({
            type: 'doc_request',
            path: rf.path,
          });
        }
      } else {
        // Exists locally -> ensure tracked and request CRDT state
        this.trackSyncedFile(rf.path);
        if (!rf.isAttachment && !this.isAttachmentPath(rf.path)) {
          this.wsClient.send({
            type: 'doc_request',
            path: rf.path,
          });
        }
      }
    }

    // 2. Check local files: if server doesn't have it, upload/push it to server! (NEVER delete local files)
    const localFiles = this.app.vault.getFiles();
    for (const file of localFiles) {
      if (!this.shouldSync(file.path)) continue;
      if (!remotePaths.has(file.path)) {
        if (!this.isReadOnly()) {
          this.trackSyncedFile(file.path);
          if (this.isAttachmentPath(file.path)) {
            if (this.settings.syncAttachments) {
              await this.syncAttachment(file);
            }
          } else {
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
          }
        }
      }
    }
  }

  private async handleDocResponse(path: string, updateB64: string): Promise<void> {
    if (!this.shouldSync(path)) return;
    const update = base64ToUint8Array(updateB64);
    const doc = this.getOrCreateDoc(path);
    Y.applyUpdate(doc, update, 'remote');
    this.trackSyncedFile(path);
    const content = doc.getText('content').toString();
    await this.writeToVaultSafely(path, content);
  }

  private async downloadAttachment(relativePath: string): Promise<void> {
    try {
      let httpBase = this.settings.serverUrl.replace(/^ws:\/\//, 'http://').replace(/^wss:\/\//, 'https://');
      const url = `${httpBase}/api/v1/attachments/${encodeURIComponent(this.settings.vaultId)}/${encodeURIComponent(relativePath)}`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.settings.authToken}`,
        },
      });
      if (res.ok) {
        const arrayBuffer = await res.arrayBuffer();
        this.lockPath(relativePath, 2000);
        await this.ensureFolderExists(relativePath);
        const existing = this.app.vault.getAbstractFileByPath(relativePath);
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

  private async handleRemoteYjsSync(path: string, updateB64: string): Promise<void> {
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
      window.clearTimeout(existing);
    }

    const timer = window.setTimeout(async () => {
      this.pendingLocalDebounce.delete(path);

      // Protect active editor: do NOT overwrite the file on disk while actively open in editor
      // Writing to an active file causes Obsidian to reload the buffer and resets the cursor to 0
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile && activeFile.path === path) {
        return;
      }

      const text = doc.getText('content').toString();
      await this.writeToVaultSafely(path, text);
    }, 1500);

    this.pendingLocalDebounce.set(path, timer);
  }

  public async flushDocToDisk(path: string): Promise<void> {
    const timer = this.pendingLocalDebounce.get(path);
    if (timer) {
      window.clearTimeout(timer);
      this.pendingLocalDebounce.delete(path);
    }
    const doc = this.docs.get(path);
    if (doc) {
      const text = doc.getText('content').toString();
      await this.writeToVaultSafely(path, text);
    }
  }

  private async writeToVaultSafely(path: string, content: string): Promise<void> {
    const abstractFile = this.app.vault.getAbstractFileByPath(path);
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
    const { action, path, oldPath } = msg;
    if (!this.shouldSync(path)) return;

    this.lockPath(path, 2000);
    if (oldPath) this.lockPath(oldPath, 2000);

    this.recordHistory({
      type: 'file_event',
      path,
      summary: `Remote file event: ${action} on ${path}`,
    });

    try {
      const file = this.app.vault.getAbstractFileByPath(path);

      if (action === 'delete') {
        if (file) {
          this.removeDoc(path);
          this.untrackSyncedFile(path);
          await this.app.vault.delete(file);
        }
      } else if (action === 'rename' && oldPath) {
        const oldFile = this.app.vault.getAbstractFileByPath(oldPath);
        if (oldFile) {
          const doc = this.docs.get(oldPath);
          if (doc) {
            this.docs.delete(oldPath);
            this.docs.set(path, doc);
          }
          this.untrackSyncedFile(oldPath);
          this.trackSyncedFile(path);
          await this.app.fileManager.renameFile(oldFile, path);
        }
      } else if (action === 'create' || action === 'modify') {
        this.trackSyncedFile(path);
        if (this.isAttachmentPath(path)) {
          await this.downloadAttachment(path);
        } else {
          this.wsClient.send({
            type: 'doc_request',
            path,
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

      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${this.settings.authToken}`,
          'Content-Type': 'application/octet-stream',
        },
        body: buffer,
      });

      if (!res.ok) {
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
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (!existing) {
        try {
          await this.app.vault.createFolder(current);
        } catch (e) {
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
      this.historyLogs = this.historyLogs.slice(0, 200);
    }
  }

  public getHistoryLogs(): SyncHistoryEntry[] {
    return this.historyLogs;
  }

  public clearHistory(): void {
    this.historyLogs = [];
  }

  public resetDocs(): void {
    for (const timer of this.pendingLocalDebounce.values()) {
      window.clearTimeout(timer);
    }
    this.pendingLocalDebounce.clear();
    for (const timer of this.pendingOutgoingTimers.values()) {
      window.clearTimeout(timer);
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
