import { IncomingMessage, ServerResponse } from 'http';
import { extractTokenFromRequest, verifyToken } from './auth.js';
import { config } from './config.js';
import { RoomManager } from './room-manager.js';
import { StorageEngine } from './storage.js';

export function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  roomManager: RoomManager,
  storage: StorageEngine
): void {
  // CORS Headers
  if (config.corsEnabled) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // 1. Health check
  if (pathname === '/health' || pathname === '/api/v1/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        name: 'Kurotsuki Sync Relay Server',
        version: config.version,
        uptime: Math.floor(process.uptime()),
        timestamp: Date.now(),
      })
    );
    return;
  }

  // 2. Server stats
  if (pathname === '/api/v1/stats') {
    const token = extractTokenFromRequest(req);
    if (!verifyToken(token)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const stats = roomManager.getStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        version: config.version,
        uptime: Math.floor(process.uptime()),
        memory: process.memoryUsage(),
        ...stats,
      })
    );
    return;
  }

  // 3. Attachments API: /api/v1/attachments/:vaultId/<path...>
  const attachmentMatch = pathname.match(/^\/api\/v1\/attachments\/([^\/]+)\/(.+)$/);
  if (attachmentMatch) {
    const token = extractTokenFromRequest(req);
    if (!verifyToken(token)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const vaultId = decodeURIComponent(attachmentMatch[1]);
    const filePath = decodeURIComponent(attachmentMatch[2]);

    if (req.method === 'PUT') {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      const maxBytes = config.maxPayloadMB * 1024 * 1024;

      req.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Payload too large' }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        const buffer = Buffer.concat(chunks);
        storage.saveAttachment(vaultId, filePath, buffer);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, path: filePath, bytes: buffer.length }));
      });
      return;
    }

    if (req.method === 'GET') {
      const data = storage.getAttachment(vaultId, filePath);
      if (!data) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Attachment not found' }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': data.length,
      });
      res.end(data);
      return;
    }
  }

  // 4. Default 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}
