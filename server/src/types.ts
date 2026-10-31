import { WebSocket } from 'ws';

export interface UserProfile {
  id: string;
  name: string;
  color: string;
}

export interface RemoteCursor {
  anchor: number;
  head: number;
}

export interface PeerAwarenessState {
  clientId: number;
  user: UserProfile;
  activeFile: string | null;
  cursor: RemoteCursor | null;
  lastActive: number;
}

export type WSMessage =
  | { type: 'auth'; token: string; vaultId: string; clientInfo: UserProfile }
  | { type: 'auth_ack'; success: boolean; message?: string; serverVersion: string }
  | { type: 'yjs_sync'; path: string; update: string }
  | { type: 'awareness_update'; states: PeerAwarenessState[] }
  | { type: 'file_event'; action: 'create' | 'modify' | 'delete' | 'rename'; path: string; oldPath?: string; hash?: string; mtime?: number }
  | { type: 'file_list_request' }
  | { type: 'file_list_response'; files: Array<{ path: string; hash?: string; mtime: number }> }
  | { type: 'ping' }
  | { type: 'pong' };

export interface ClientSession {
  id: string;
  ws: WebSocket;
  vaultId: string;
  user: UserProfile;
  clientId: number;
  ip: string;
  connectedAt: number;
  lastPing: number;
}

export interface ServerConfig {
  port: number;
  host: string;
  storageDir: string;
  authToken: string;
  maxPayloadMB: number;
  corsEnabled: boolean;
  version: string;
}
