import { PeerAwarenessState, RemoteCursor, UserProfile } from './types';
import { normalizePath } from './utils';

export type AwarenessListener = (peers: PeerAwarenessState[]) => void;
export type LocalChangeListener = (state: PeerAwarenessState) => void;

export class AwarenessManager {
  private localState: PeerAwarenessState;
  private remotePeers: Map<number, PeerAwarenessState> = new Map();
  private listeners: Set<AwarenessListener> = new Set();
  private localListeners: Set<LocalChangeListener> = new Set();
  private cleanupInterval: number | null = null;

  constructor(user: UserProfile) {
    const randomClientId = Math.floor(Math.random() * 1000000) + 1;
    this.localState = {
      clientId: randomClientId,
      user,
      activeFile: null,
      cursor: null,
      lastActive: Date.now(),
    };

    // Periodically clean up stale peers (> 30s)
    if (typeof window !== 'undefined') {
      this.cleanupInterval = window.setInterval(() => this.pruneStalePeers(), 10000);
    }
  }

  public getClientId(): number {
    return this.localState.clientId;
  }

  public getLocalState(): PeerAwarenessState {
    return { ...this.localState };
  }

  public updateUserProfile(user: Partial<UserProfile>): void {
    this.localState.user = { ...this.localState.user, ...user };
    this.localState.lastActive = Date.now();
    this.notify();
    this.notifyLocal();
  }

  public updateActiveFile(path: string | null): void {
    const cleanPath = path ? normalizePath(path) : null;
    if (this.localState.activeFile !== cleanPath) {
      this.localState.activeFile = cleanPath;
      this.localState.cursor = null;
      this.localState.lastActive = Date.now();
      this.notify();
      this.notifyLocal();
    }
  }

  public updateCursor(cursor: RemoteCursor | null): void {
    const prev = this.localState.cursor;
    if (
      (prev === null && cursor === null) ||
      (prev !== null && cursor !== null && prev.anchor === cursor.anchor && prev.head === cursor.head)
    ) {
      return;
    }
    this.localState.cursor = cursor;
    this.localState.lastActive = Date.now();
    // Only notify local WebSocket broadcast (debounced/throttled)
    // Avoid triggering full remote re-renders on local typing
    this.notifyLocal();
  }

  public handleRemoteAwareness(states: PeerAwarenessState[]): void {
    const now = Date.now();
    let hasChanged = false;

    for (const state of states) {
      if (state.clientId === this.localState.clientId) continue;

      const existing = this.remotePeers.get(state.clientId);
      const normalizedStateFile = state.activeFile ? normalizePath(state.activeFile) : null;
      if (!existing) {
        this.remotePeers.set(state.clientId, {
          ...state,
          activeFile: normalizedStateFile,
          lastActive: now,
        });
        hasChanged = true;
      } else {
        const cursorChanged =
          (!existing.cursor && !!state.cursor) ||
          (!!existing.cursor && !state.cursor) ||
          (!!existing.cursor &&
            !!state.cursor &&
            (existing.cursor.anchor !== state.cursor.anchor || existing.cursor.head !== state.cursor.head));
        const fileChanged = existing.activeFile !== normalizedStateFile;
        const userChanged =
          existing.user.name !== state.user?.name ||
          existing.user.color !== state.user?.color ||
          existing.user.role !== state.user?.role;

        existing.lastActive = now;
        if (cursorChanged || fileChanged || userChanged) {
          existing.activeFile = normalizedStateFile;
          existing.cursor = state.cursor;
          if (state.user) {
            existing.user = { ...existing.user, ...state.user };
          }
          hasChanged = true;
        }
      }
    }

    if (hasChanged) {
      this.notify();
    }
  }

  public removePeer(clientId: number): void {
    if (this.remotePeers.delete(clientId)) {
      this.notify();
    }
  }

  public getActivePeersForFile(path: string): PeerAwarenessState[] {
    const cleanPath = normalizePath(path);
    const peers: PeerAwarenessState[] = [];
    for (const peer of this.remotePeers.values()) {
      if (peer.activeFile && normalizePath(peer.activeFile) === cleanPath) {
        peers.push(peer);
      }
    }
    return peers;
  }

  public getAllRemotePeers(): PeerAwarenessState[] {
    return Array.from(this.remotePeers.values());
  }

  public getAllPeers(): PeerAwarenessState[] {
    return this.getAllRemotePeers();
  }

  public subscribe(listener: AwarenessListener): () => void {
    this.listeners.add(listener);
    listener(this.getAllRemotePeers());
    return () => this.listeners.delete(listener);
  }

  public onLocalChange(listener: LocalChangeListener): () => void {
    this.localListeners.add(listener);
    return () => this.localListeners.delete(listener);
  }

  private notifyLocal(): void {
    const local = this.getLocalState();
    for (const listener of this.localListeners) {
      listener(local);
    }
  }

  private pruneStalePeers(): void {
    const now = Date.now();
    let changed = false;
    for (const [clientId, peer] of this.remotePeers.entries()) {
      if (now - peer.lastActive > 35000) {
        this.remotePeers.delete(clientId);
        changed = true;
      }
    }
    if (changed) {
      this.notify();
    }
  }

  private notify(): void {
    const peers = this.getAllRemotePeers();
    for (const listener of this.listeners) {
      listener(peers);
    }
  }

  public destroy(): void {
    if (this.cleanupInterval !== null && typeof window !== 'undefined') {
      window.clearInterval(this.cleanupInterval);
    }
    this.listeners.clear();
    this.localListeners.clear();
    this.remotePeers.clear();
  }
}
