import * as Y from 'yjs';
import { StorageEngine } from './storage.js';
import { ClientSession, PeerAwarenessState, WSMessage } from './types.js';

interface Room {
  vaultId: string;
  sessions: Set<ClientSession>;
  docs: Map<string, Y.Doc>;
  awareness: Map<number, PeerAwarenessState>;
  saveDebounceTimers: Map<string, NodeJS.Timeout>;
}

export class RoomManager {
  private rooms: Map<string, Room> = new Map();
  private storage: StorageEngine;

  constructor(storage: StorageEngine) {
    this.storage = storage;
  }

  public getOrCreateRoom(vaultId: string): Room {
    let room = this.rooms.get(vaultId);
    if (!room) {
      room = {
        vaultId,
        sessions: new Set(),
        docs: new Map(),
        awareness: new Map(),
        saveDebounceTimers: new Map(),
      };
      this.rooms.set(vaultId, room);
    }
    return room;
  }

  public joinRoom(vaultId: string, session: ClientSession): void {
    const room = this.getOrCreateRoom(vaultId);
    room.sessions.add(session);

    // Send current awareness states to new client
    const allAwareness = Array.from(room.awareness.values());
    if (allAwareness.length > 0) {
      this.sendToSession(session, {
        type: 'awareness_update',
        states: allAwareness,
      });
    }
  }

  public leaveRoom(session: ClientSession): void {
    const room = this.rooms.get(session.vaultId);
    if (!room) return;

    room.sessions.delete(session);
    room.awareness.delete(session.clientId);

    // Broadcast updated awareness to remaining clients
    this.broadcastToRoom(session.vaultId, {
      type: 'awareness_update',
      states: Array.from(room.awareness.values()),
    });

    // Cleanup empty room docs from memory after inactivity if no sessions
    if (room.sessions.size === 0) {
      // Flush any pending saves
      for (const [docPath, timer] of room.saveDebounceTimers.entries()) {
        clearTimeout(timer);
        const doc = room.docs.get(docPath);
        if (doc) {
          this.storage.saveDoc(room.vaultId, docPath, doc);
        }
      }
      room.saveDebounceTimers.clear();
      room.docs.clear();
      this.rooms.delete(session.vaultId);
    }
  }

  public getOrCreateDoc(vaultId: string, docPath: string): Y.Doc {
    const room = this.getOrCreateRoom(vaultId);
    let doc = room.docs.get(docPath);
    if (!doc) {
      doc = new Y.Doc();
      this.storage.loadDoc(vaultId, docPath, doc);
      room.docs.set(docPath, doc);
    }
    return doc;
  }

  public applyUpdate(
    vaultId: string,
    docPath: string,
    update: Uint8Array,
    senderSession?: ClientSession
  ): void {
    const doc = this.getOrCreateDoc(vaultId, docPath);
    Y.applyUpdate(doc, update);

    // Schedule debounced save to storage
    this.scheduleDocSave(vaultId, docPath, doc);

    // Broadcast to other peers in room
    const b64 = Buffer.from(update).toString('base64');
    this.broadcastToRoom(
      vaultId,
      {
        type: 'yjs_sync',
        path: docPath,
        update: b64,
      },
      senderSession
    );
  }

  public updateAwareness(
    vaultId: string,
    states: PeerAwarenessState[],
    senderSession?: ClientSession
  ): void {
    const room = this.getOrCreateRoom(vaultId);
    for (const state of states) {
      room.awareness.set(state.clientId, state);
    }

    this.broadcastToRoom(
      vaultId,
      {
        type: 'awareness_update',
        states: Array.from(room.awareness.values()),
      },
      senderSession
    );
  }

  public broadcastFileEvent(vaultId: string, msg: WSMessage, senderSession?: ClientSession): void {
    if (msg.type === 'file_event' && msg.action === 'delete') {
      // Remove doc from memory and storage if deleted
      const room = this.rooms.get(vaultId);
      if (room) {
        room.docs.delete(msg.path);
      }
      this.storage.deleteDoc(vaultId, msg.path);
    }
    this.broadcastToRoom(vaultId, msg, senderSession);
  }

  public broadcastToRoom(
    vaultId: string,
    msg: WSMessage,
    excludeSession?: ClientSession
  ): void {
    const room = this.rooms.get(vaultId);
    if (!room) return;

    const payload = JSON.stringify(msg);
    for (const session of room.sessions) {
      if (excludeSession && session === excludeSession) continue;
      if (session.ws.readyState === session.ws.OPEN) {
        try {
          session.ws.send(payload);
        } catch (err) {
          console.error(`[RoomManager] Failed to send message to session ${session.id}:`, err);
        }
      }
    }
  }

  public sendToSession(session: ClientSession, msg: WSMessage): void {
    if (session.ws.readyState === session.ws.OPEN) {
      try {
        session.ws.send(JSON.stringify(msg));
      } catch (err) {
        console.error(`[RoomManager] Failed to send message to session ${session.id}:`, err);
      }
    }
  }

  private scheduleDocSave(vaultId: string, docPath: string, doc: Y.Doc): void {
    const room = this.getOrCreateRoom(vaultId);
    const existing = room.saveDebounceTimers.get(docPath);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      room.saveDebounceTimers.delete(docPath);
      this.storage.saveDoc(vaultId, docPath, doc);
    }, 1000);

    room.saveDebounceTimers.set(docPath, timer);
  }

  public getStats() {
    let totalConnections = 0;
    const roomStats: Array<{ vaultId: string; peers: number; activeDocs: number }> = [];

    for (const [vaultId, room] of this.rooms.entries()) {
      totalConnections += room.sessions.size;
      roomStats.push({
        vaultId,
        peers: room.sessions.size,
        activeDocs: room.docs.size,
      });
    }

    return {
      activeRooms: this.rooms.size,
      totalConnections,
      rooms: roomStats,
    };
  }
}
