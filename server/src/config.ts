import path from 'path';
import { ServerConfig } from './types.js';

export const config: ServerConfig = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  storageDir: process.env.STORAGE_DIR ? path.resolve(process.env.STORAGE_DIR) : path.resolve(process.cwd(), 'data'),
  authToken: process.env.AUTH_TOKEN || '',
  maxPayloadMB: parseInt(process.env.MAX_PAYLOAD_MB || '50', 10),
  corsEnabled: process.env.CORS_ENABLED !== 'false',
  version: '1.0.0',
};
