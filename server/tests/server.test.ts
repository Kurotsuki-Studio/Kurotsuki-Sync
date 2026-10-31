import assert from 'node:assert';
import http from 'node:http';
import test, { after, before, describe } from 'node:test';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { verifyToken } from '../src/auth.js';
import { config } from '../src/config.js';
import { handleHttpRequest } from '../src/http-api.js';
import { RoomManager } from '../src/room-manager.js';
import { StorageEngine } from '../src/storage.js';
import { setupWebSocketServer } from '../src/ws-server.js';

describe('Kurotsuki Sync Relay Server', () => {
  let server: http.Server;
  let roomManager: RoomManager;
  let storage: StorageEngine;
  let testPort = 3199;
  let baseUrl: string;
  let wsUrl: string;

  before(async () => {
    config.authToken = 'test-secret-token';
    storage = new StorageEngine('./test-data');
    roomManager = new RoomManager(storage);

    server = http.createServer((req, res) => {
      handleHttpRequest(req, res, roomManager, storage);
    });
    setupWebSocketServer(server, roomManager);

    await new Promise<void>((resolve) => {
      server.listen(testPort, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${testPort}`;
        wsUrl = `ws://127.0.0.1:${testPort}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('Health check endpoint returns status ok and server info', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.status, 'ok');
    assert.strictEqual(body.name, 'Kurotsuki Sync Relay Server');
  });

  test('Authentication: verifyToken validates correct and incorrect tokens', () => {
    assert.strictEqual(verifyToken('test-secret-token'), true);
    assert.strictEqual(verifyToken('wrong-token'), false);
    assert.strictEqual(verifyToken(''), false);
    assert.strictEqual(verifyToken(null), false);
  });

  test('Protected endpoint /api/v1/stats requires authentication', async () => {
    const unauthRes = await fetch(`${baseUrl}/api/v1/stats`);
    assert.strictEqual(unauthRes.status, 401);

    const authRes = await fetch(`${baseUrl}/api/v1/stats`, {
      headers: { Authorization: 'Bearer test-secret-token' },
    });
    assert.strictEqual(authRes.status, 200);
    const stats = await authRes.json();
    assert.strictEqual(stats.status, 'ok');
    assert.ok(typeof stats.totalConnections === 'number');
  });

  test('Attachment upload and retrieval via HTTP API', async () => {
    const testContent = Buffer.from('Hello Kurotsuki attachment data');
    const uploadRes = await fetch(`${baseUrl}/api/v1/attachments/test-vault/images/sample.png`, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer test-secret-token',
        'Content-Type': 'application/octet-stream',
      },
      body: testContent,
    });
    assert.strictEqual(uploadRes.status, 200);

    const downloadRes = await fetch(`${baseUrl}/api/v1/attachments/test-vault/images/sample.png`, {
      headers: { Authorization: 'Bearer test-secret-token' },
    });
    assert.strictEqual(downloadRes.status, 200);
    const downloadedBuf = Buffer.from(await downloadRes.arrayBuffer());
    assert.deepStrictEqual(downloadedBuf, testContent);
  });

  test('WebSocket: rejects connection with invalid auth token', async () => {
    const ws = new WebSocket(`${wsUrl}?token=invalid-token`);
    const code = await new Promise<number>((resolve) => {
      ws.on('close', (closeCode) => resolve(closeCode));
    });
    assert.strictEqual(code, 4001);
  });

  test('WebSocket: connects and syncs Yjs updates between two clients', async () => {
    const wsA = new WebSocket(`${wsUrl}?token=test-secret-token&vaultId=test-room`);
    const wsB = new WebSocket(`${wsUrl}?token=test-secret-token&vaultId=test-room`);

    await Promise.all([
      new Promise((resolve) => wsA.on('open', resolve)),
      new Promise((resolve) => wsB.on('open', resolve)),
    ]);

    // Send auth messages
    wsA.send(JSON.stringify({
      type: 'auth',
      token: 'test-secret-token',
      vaultId: 'test-room',
      clientInfo: { id: 'userA', name: 'Alice', color: '#ff0000' },
    }));

    wsB.send(JSON.stringify({
      type: 'auth',
      token: 'test-secret-token',
      vaultId: 'test-room',
      clientInfo: { id: 'userB', name: 'Bob', color: '#00ff00' },
    }));

    // Setup local Ydocs
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const yTextA = docA.getText('content');

    // Wait for B to receive Yjs sync message from A
    const bReceivedPromise = new Promise<string>((resolve) => {
      wsB.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'yjs_sync' && msg.path === 'notes/collab.md') {
          const update = Buffer.from(msg.update, 'base64');
          Y.applyUpdate(docB, new Uint8Array(update));
          resolve(docB.getText('content').toString());
        }
      });
    });

    // Client A makes an edit
    docA.on('update', (update) => {
      wsA.send(JSON.stringify({
        type: 'yjs_sync',
        path: 'notes/collab.md',
        update: Buffer.from(update).toString('base64'),
      }));
    });

    yTextA.insert(0, 'Hello from Alice in Kurotsuki Sync!');

    const textInB = await bReceivedPromise;
    assert.strictEqual(textInB, 'Hello from Alice in Kurotsuki Sync!');

    wsA.close();
    wsB.close();
  });
});
