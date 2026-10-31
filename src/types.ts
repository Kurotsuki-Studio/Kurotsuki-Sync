export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'syncing' | 'error';

export type UserRole = 'admin' | 'editor' | 'viewer' | 'unknown';

export interface UserProfile {
  id: string;
  name: string;
  color: string;
  role?: UserRole;
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

export interface VaultProfile {
  id: string;
  name: string;
  serverUrl: string;
  vaultId: string;
  authToken: string;
  role?: UserRole;
  syncMode?: SyncMode;
  sharedFolders?: string[];
}

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
  currentRole: UserRole;
  vaultProfiles: VaultProfile[];
  activeProfileId: string;
  syncedFiles?: Record<string, number>;
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
  currentRole: 'unknown',
  syncedFiles: {},
  vaultProfiles: [
    {
      id: 'default-profile',
      name: 'Default Workspace',
      serverUrl: 'ws://localhost:3000',
      vaultId: 'default-vault',
      authToken: '',
      role: 'editor',
    },
  ],
  activeProfileId: 'default-profile',
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
  | { type: 'auth_ack'; success: boolean; message?: string; serverVersion: string; role?: UserRole; vaultId?: string }
  | { type: 'yjs_sync'; path: string; update: string }
  | { type: 'awareness_update'; states: PeerAwarenessState[] }
  | { type: 'file_event'; action: 'create' | 'modify' | 'delete' | 'rename'; path: string; oldPath?: string; hash?: string; mtime?: number }
  | { type: 'file_list_request' }
  | { type: 'file_list_response'; files: Array<{ path: string; hash?: string; mtime: number; isAttachment?: boolean }> }
  | { type: 'doc_request'; path: string }
  | { type: 'doc_response'; path: string; update: string }
  | { type: 'ping'; timestamp?: number }
  | { type: 'pong'; timestamp?: number }
  | { type: 'error'; message: string; code?: string };

export interface SyncHistoryEntry {
  id: string;
  timestamp: number;
  path: string;
  author?: string;
  type: 'remote_update' | 'local_update' | 'file_event' | 'conflict_detected' | 'error';
  sizeBytes?: number;
  summary: string;
}
