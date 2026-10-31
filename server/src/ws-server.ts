import { IncomingMessage, Server } from 'http';
import { RawData, WebSocket, WebSocketServer } from 'ws';
import * as Y from 'yjs';
import { extractTokenFromRequest, verifyToken } from './auth.js';
import { config } from './config.js';
import { RoomManager } from './room-manager.js';
import { ClientSession, WSMessage } from './types.js';

export function setupWebSocketServer(httpServer: Server, roomManager: RoomManager): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const ip = req.socket.remoteAddress || 'unknown';
    const initialToken = extractTokenFromRequest(req);

    // Initial session placeholder
    const session: ClientSession = {
      id: 'sess_' + Math.random().toString(36).substring(2, 10),
      ws,
      vaultId: 'default-vault',
      user: {
        id: 'usr_' + Math.random().toString(36).substring(2, 8),
        name: 'Anonymous',
        color: '#3b82f6',
      },
      clientId: 0,
      ip,
      connectedAt: Date.now(),
      lastPing: Date.now(),
    };

    // If token in URL query is invalid, reject early
    if (initialToken && !verifyToken(initialToken)) {
      ws.send(JSON.stringify({
        type: 'auth_ack',
        success: false,
        message: 'Invalid authentication token',
        serverVersion: config.version,
      }));
      ws.close(4001, 'Unauthorized');
      return;
    }

    // Ping interval to verify socket liveness
    const pingInterval = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        ws.ping();
      }
    }, 30000);

    ws.on('message', (raw: RawData) => {
      try {
        const text = raw.toString();
        const msg = JSON.parse(text) as WSMessage;

        switch (msg.type) {
          case 'auth': {
            if (!verifyToken(msg.token)) {
              ws.send(JSON.stringify({
                type: 'auth_ack',
                success: false,
                message: 'Invalid authentication token',
                serverVersion: config.version,
              }));
              ws.close(4001, 'Unauthorized');
              return;
            }

            session.vaultId = msg.vaultId || 'default-vault';
            if (msg.clientInfo) {
              session.user = msg.clientInfo;
            }

            roomManager.joinRoom(session.vaultId, session);

            ws.send(JSON.stringify({
              type: 'auth_ack',
              success: true,
              serverVersion: config.version,
            }));
            break;
          }

          case 'yjs_sync': {
            if (!msg.path || !msg.update) return;
            const updateBuf = Buffer.from(msg.update, 'base64');
            roomManager.applyUpdate(session.vaultId, msg.path, new Uint8Array(updateBuf), session);
            break;
          }

          case 'awareness_update': {
            if (Array.isArray(msg.states)) {
              for (const state of msg.states) {
                session.clientId = state.clientId;
              }
              roomManager.updateAwareness(session.vaultId, msg.states, session);
            }
            break;
          }

          case 'file_event': {
            roomManager.broadcastFileEvent(session.vaultId, msg, session);
            break;
          }

          case 'file_list_request': {
            const files = roomManager.getOrCreateRoom(session.vaultId);
            // Storage file listing can be queried if needed
            ws.send(JSON.stringify({
              type: 'file_list_response',
              files: [],
            }));
            break;
          }

          case 'ping': {
            session.lastPing = Date.now();
            ws.send(JSON.stringify({ type: 'pong' }));
            break;
          }

          case 'pong': {
            session.lastPing = Date.now();
            break;
          }

          default:
            break;
        }
      } catch (err) {
        console.error('[WebSocket] Error processing message:', err);
      }
    });

    ws.on('close', () => {
      clearInterval(pingInterval);
      roomManager.leaveRoom(session);
    });

    ws.on('error', (err) => {
      console.warn(`[WebSocket] Client error (${session.id}):`, err);
    });
  });

  return wss;
}
