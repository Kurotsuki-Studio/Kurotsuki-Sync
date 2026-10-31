import { App, TAbstractFile, TFile, TFolder } from 'obsidian';
import * as Y from 'yjs';
import { KurotsukiSettings, WSMessage } from './types';
import { KurotsukiWSClient } from './ws-client';

export { base64ToUint8Array, uint8ArrayToBase64 } from './utils';

export class SyncEngine {
  private app: App;
  private settings: KurotsukiSettings;
  private wsClient: KurotsukiWSClient;
  private docs: Map<string, Y.Doc> = new Map();
  private remoteUpdateLocks: Map<string, number> = new Map();
  private pendingLocalDebounce: Map<string, number> = new Map();

  constructor(app: App, settings: KurotsukiSettings, wsClient: KurotsukiWSClient) {
    this.app = app;
    this.settings = settings;
    this.wsClient = wsClient;

    this.wsClient.onMessage((msg) => this.handleServerMessage(msg));
  }

  public updateSettings(settings: KurotsukiSettings): void {
    this.settings = settings;
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
        const b64 = uint8ArrayToBase64(update);
        this.wsClient.send({
          type: 'yjs_sync',
          path,
          update: b64,
        });
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

    // For markdown files: sync text via Yjs
    if (file.extension === 'md' || file.extension === 'txt' || file.extension === 'canvas') {
      const content = await this.app.vault.read(file);
      const doc = this.getOrCreateDoc(file.path);
      const yText = doc.getText('content');
      const currentDocText = yText.toString();

      if (currentDocText !== content) {
        // Update Yjs text to match file content
        doc.transact(() => {
          yText.delete(0, yText.length);
          yText.insert(0, content);
        }, 'local-file-change');
      }
    } else if (this.settings.syncAttachments) {
      // Binary attachment sync
      await this.syncAttachment(file);
    }
  }

  public async onLocalFileCreated(file: TAbstractFile): Promise<void> {
    if (!this.shouldSync(file.path)) return;
    if (this.isLocked(file.path)) return;

    if (file instanceof TFile) {
      if (file.extension === 'md' || file.extension === 'txt' || file.extension === 'canvas') {
        const content = await this.app.vault.read(file);
        this.getOrCreateDoc(file.path, content);
      }
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

    this.removeDoc(file.path);
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

    // Migrate doc if exists
    const doc = this.docs.get(oldPath);
    if (doc) {
      this.docs.delete(oldPath);
      this.docs.set(file.path, doc);
    }

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
      default:
        break;
    }
  }

  private async handleRemoteYjsSync(path: string, updateB64: string): Promise<void> {
    if (!this.shouldSync(path)) return;

    const update = base64ToUint8Array(updateB64);
    const doc = this.getOrCreateDoc(path);

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
      const text = doc.getText('content').toString();
      await this.writeToVaultSafely(path, text);
    }, 400);

    this.pendingLocalDebounce.set(path, timer);
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

    try {
      const file = this.app.vault.getAbstractFileByPath(path);

      if (action === 'delete') {
        if (file) {
          this.removeDoc(path);
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
          await this.app.fileManager.renameFile(oldFile, path);
        }
      }
    } catch (err) {
      console.error(`[Kurotsuki] Error executing remote file event ${action}:`, err);
    }
  }

  private async syncAttachment(file: TFile): Promise<void> {
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

      await fetch(url, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${this.settings.authToken}`,
          'Content-Type': 'application/octet-stream',
        },
        body: buffer,
      });
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

  public destroy(): void {
    for (const timer of this.pendingLocalDebounce.values()) {
      window.clearTimeout(timer);
    }
    this.pendingLocalDebounce.clear();
    for (const doc of this.docs.values()) {
      doc.destroy();
    }
    this.docs.clear();
    this.remoteUpdateLocks.clear();
  }
}
