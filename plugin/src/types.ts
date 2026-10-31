export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'syncing' | 'error';

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

export type SyncMode = 'entire_vault' | 'selective';

export interface KurotsukiSettings {
  serverUrl: string;
  authToken: string;
  vaultId: string;
  userName: string;
  userColor: string;
  syncMode: SyncMode;
  sharedFolders: string[];
  syncAttachments: boolean;
  maxAttachmentSizeMB: number;
  autoConnect: boolean;
  enableLiveCursors: boolean;
}

export const DEFAULT_SETTINGS: KurotsukiSettings = {
  serverUrl: 'ws://localhost:3000',
  authToken: '',
  vaultId: 'default-vault',
  userName: 'Obsidian User',
  userColor: '#3b82f6',
  syncMode: 'entire_vault',
  sharedFolders: ['Shared'],
  syncAttachments: true,
  maxAttachmentSizeMB: 20,
  autoConnect: true,
  enableLiveCursors: true,
};

export const COLOR_PALETTE = [
  '#ef4444', // Red
  '#f97316', // Orange
  '#f59e0b', // Amber
  '#10b981', // Emerald
  '#06b6d4', // Cyan
  '#3b82f6', // Blue
  '#6366f1', // Indigo
  '#8b5cf6', // Violet
  '#ec4899', // Pink
  '#14b8a6', // Teal
];

// Protocol Messages
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
