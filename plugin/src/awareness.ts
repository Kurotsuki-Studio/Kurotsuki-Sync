import { PeerAwarenessState, RemoteCursor, UserProfile } from './types';

export type AwarenessListener = (peers: PeerAwarenessState[]) => void;

export class AwarenessManager {
  private localState: PeerAwarenessState;
  private remotePeers: Map<number, PeerAwarenessState> = new Map();
  private listeners: Set<AwarenessListener> = new Set();
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
  }

  public updateActiveFile(path: string | null): void {
    if (this.localState.activeFile !== path) {
      this.localState.activeFile = path;
      this.localState.cursor = null;
      this.localState.lastActive = Date.now();
      this.notify();
    }
  }

  public updateCursor(cursor: RemoteCursor | null): void {
    this.localState.cursor = cursor;
    this.localState.lastActive = Date.now();
    this.notify();
  }

  public handleRemoteAwareness(states: PeerAwarenessState[]): void {
    const now = Date.now();
    for (const state of states) {
      if (state.clientId === this.localState.clientId) continue;
      this.remotePeers.set(state.clientId, {
        ...state,
        lastActive: now,
      });
    }
    this.notify();
  }

  public removePeer(clientId: number): void {
    if (this.remotePeers.delete(clientId)) {
      this.notify();
    }
  }

  public getActivePeersForFile(path: string): PeerAwarenessState[] {
    const peers: PeerAwarenessState[] = [];
    for (const peer of this.remotePeers.values()) {
      if (peer.activeFile === path) {
        peers.push(peer);
      }
    }
    return peers;
  }

  public getAllRemotePeers(): PeerAwarenessState[] {
    return Array.from(this.remotePeers.values());
  }

  public subscribe(listener: AwarenessListener): () => void {
    this.listeners.add(listener);
    listener(this.getAllRemotePeers());
    return () => this.listeners.delete(listener);
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
    this.remotePeers.clear();
  }
}
