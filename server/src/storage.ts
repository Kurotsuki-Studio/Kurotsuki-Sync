import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import * as Y from 'yjs';
import { config } from './config.js';

export class StorageEngine {
  private baseDir: string;

  constructor(baseDir: string = config.storageDir) {
    this.baseDir = baseDir;
    this.ensureDir(this.baseDir);
  }

  private ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  private getVaultDir(vaultId: string): string {
    const safeVaultId = vaultId.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    const vaultDir = path.join(this.baseDir, 'vaults', safeVaultId);
    this.ensureDir(vaultDir);
    return vaultDir;
  }

  private getDocFilePath(vaultId: string, docPath: string): string {
    const vaultDir = this.getVaultDir(vaultId);
    const docsDir = path.join(vaultDir, 'docs');
    this.ensureDir(docsDir);

    // Hash or sanitize docPath to prevent filesystem traversal while keeping human readable prefix
    const hash = crypto.createHash('sha256').update(docPath).digest('hex').substring(0, 16);
    const safeName = docPath.replace(/[^a-zA-Z0-9_\-\.]/g, '_').substring(0, 40);
    return path.join(docsDir, `${safeName}_${hash}.ydoc`);
  }

  public loadDoc(vaultId: string, docPath: string, doc: Y.Doc): boolean {
    const filePath = this.getDocFilePath(vaultId, docPath);
    if (fs.existsSync(filePath)) {
      try {
        const data = fs.readFileSync(filePath);
        Y.applyUpdate(doc, new Uint8Array(data));
        return true;
      } catch (err) {
        console.error(`[Storage] Failed to read YDoc from ${filePath}:`, err);
      }
    }
    return false;
  }

  public saveDoc(vaultId: string, docPath: string, doc: Y.Doc): void {
    const filePath = this.getDocFilePath(vaultId, docPath);
    try {
      const state = Y.encodeStateAsUpdate(doc);
      fs.writeFileSync(filePath, Buffer.from(state));
    } catch (err) {
      console.error(`[Storage] Failed to write YDoc to ${filePath}:`, err);
    }
  }

  public deleteDoc(vaultId: string, docPath: string): void {
    const filePath = this.getDocFilePath(vaultId, docPath);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        console.error(`[Storage] Failed to delete YDoc ${filePath}:`, err);
      }
    }
  }

  public getAttachmentPath(vaultId: string, relativePath: string): string {
    const vaultDir = this.getVaultDir(vaultId);
    const attachmentsDir = path.join(vaultDir, 'attachments');
    this.ensureDir(attachmentsDir);

    // Prevent directory traversal
    const safePath = path.normalize(relativePath).replace(/^(\.\.[\/\\])+/, '');
    const fullPath = path.join(attachmentsDir, safePath);
    this.ensureDir(path.dirname(fullPath));
    return fullPath;
  }

  public saveAttachment(vaultId: string, relativePath: string, data: Buffer): void {
    const targetPath = this.getAttachmentPath(vaultId, relativePath);
    fs.writeFileSync(targetPath, data);
  }

  public getAttachment(vaultId: string, relativePath: string): Buffer | null {
    const targetPath = this.getAttachmentPath(vaultId, relativePath);
    if (fs.existsSync(targetPath)) {
      return fs.readFileSync(targetPath);
    }
    return null;
  }

  public listFiles(vaultId: string): Array<{ path: string; mtime: number }> {
    const vaultDir = this.getVaultDir(vaultId);
    const docsDir = path.join(vaultDir, 'docs');
    const results: Array<{ path: string; mtime: number }> = [];

    if (fs.existsSync(docsDir)) {
      const entries = fs.readdirSync(docsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.ydoc')) {
          const stat = fs.statSync(path.join(docsDir, entry.name));
          results.push({
            path: entry.name,
            mtime: stat.mtimeMs,
          });
        }
      }
    }
    return results;
  }
}
