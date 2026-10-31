import http from 'http';
import { config } from './config.js';
import { handleHttpRequest } from './http-api.js';
import { RoomManager } from './room-manager.js';
import { StorageEngine } from './storage.js';
import { setupWebSocketServer } from './ws-server.js';

export function createServer() {
  const storage = new StorageEngine(config.storageDir);
  const roomManager = new RoomManager(storage);

  const httpServer = http.createServer((req, res) => {
    handleHttpRequest(req, res, roomManager, storage);
  });

  const wss = setupWebSocketServer(httpServer, roomManager);

  return { httpServer, wss, roomManager, storage };
}

// Start standalone if invoked directly
if (process.env.NODE_ENV !== 'test') {
  const { httpServer } = createServer();

  httpServer.listen(config.port, config.host, () => {
    console.log(`🌙 Kurotsuki Sync Relay Server v${config.version}`);
    console.log(`📡 Listening on http://${config.host}:${config.port}`);
    console.log(`📂 Storage directory: ${config.storageDir}`);
    console.log(`🔒 Authentication: ${config.authToken ? 'Enabled (Bearer token required)' : 'Disabled (Open access)'}`);
  });

  const shutdown = () => {
    console.log('\nShutting down Kurotsuki Relay Server...');
    httpServer.close(() => {
      console.log('Server stopped gracefully.');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
