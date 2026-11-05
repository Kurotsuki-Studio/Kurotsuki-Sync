import * as Y from 'yjs';
import { ConnectionStatus, KurotsukiSettings, UserProfile, UserRole, WSMessage } from './types';
import { base64ToUint8Array, uint8ArrayToBase64 } from './utils';

export type WSMessageHandler = (message: WSMessage) => void;
export type StatusChangeHandler = (status: ConnectionStatus, message?: string) => void;
export type LatencyHandler = (latencyMs: number) => void;
export type RoleChangeHandler = (role: UserRole) => void;

export class KurotsukiWSClient {
  private ws: WebSocket | null = null;
  private settings: KurotsukiSettings;
  private getUserProfile: () => UserProfile;
  private messageHandlers: Set<WSMessageHandler> = new Set();
  private statusHandlers: Set<StatusChangeHandler> = new Set();
  private latencyHandlers: Set<LatencyHandler> = new Set();
  private roleHandlers: Set<RoleChangeHandler> = new Set();

  private status: ConnectionStatus = 'disconnected';
  private currentRole: UserRole = 'unknown';
  private latency: number | null = null;
  private reconnectTimeout: number | null = null;
  private pingInterval: number | null = null;
  private reconnectAttempts = 0;
  private manualDisconnect = false;
  private lastPingSentAt: number | null = null;
  private outgoingQueue: WSMessage[] = [];

  constructor(settings: KurotsukiSettings, getUserProfile: () => UserProfile) {
    this.settings = settings;
    this.getUserProfile = getUserProfile;
    this.currentRole = settings.currentRole || 'unknown';
  }

  public updateSettings(settings: KurotsukiSettings): void {
    this.settings = settings;
  }

  public getStatus(): ConnectionStatus {
    return this.status;
  }

  public getLatency(): number | null {
    return this.latency;
  }

  public getCurrentRole(): UserRole {
    return this.currentRole;
  }

  public getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  public connect(): void {
    this.manualDisconnect = false;
    this.clearTimers();

    if (!this.settings.serverUrl) {
      this.setStatus('error', 'Server URL is not configured');
      return;
    }

    try {
      this.setStatus('connecting');
      let url = this.settings.serverUrl.trim();
      if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
        url = url.replace(/^http:\/\//, 'ws://').replace(/^https:\/\//, 'wss://');
        if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
          url = 'ws://' + url;
        }
      }

      const wsUrl = new URL(url);
      if (this.settings.authToken) {
        wsUrl.searchParams.set('token', this.settings.authToken);
      }
      if (this.settings.vaultId) {
        wsUrl.searchParams.set('vaultId', this.settings.vaultId);
      }

      this.ws = new WebSocket(wsUrl.toString());

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.startHeartbeat();
        // Send initial auth message with clientInfo
        const profile = this.getUserProfile();
        this.send({
          type: 'auth',
          token: this.settings.authToken,
          vaultId: this.settings.vaultId,
          clientInfo: {
            ...profile,
            role: this.currentRole !== 'unknown' ? this.currentRole : undefined,
          },
        });
        // Flush any buffered messages from disconnect/reconnect
        this.flushOutgoingQueue();
      };

      this.ws.onmessage = (event) => {
        try {
          let raw: string;
          if (typeof event.data === 'string') {
            raw = event.data;
          } else if (event.data instanceof ArrayBuffer) {
            raw = new TextDecoder().decode(event.data);
          } else {
            return;
          }
          const parsed: unknown = JSON.parse(raw);
          if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) {
            return;
          }
          const msg = parsed as WSMessage;

          if (msg.type === 'auth_ack') {
            if (msg.success) {
              this.currentRole = msg.role || 'editor';
              this.settings.currentRole = this.currentRole;
              this.emitRole(this.currentRole);
              this.setStatus('connected');
              // Measure initial ping
              this.sendPing();
            } else {
              this.setStatus('error', msg.message || 'Authentication failed');
              this.disconnect(true);
            }
          } else if (msg.type === 'pong') {
            const now = Date.now();
            const sentAt = msg.timestamp || this.lastPingSentAt || now;
            this.latency = Math.max(1, now - sentAt);
            this.emitLatency(this.latency);
          } else {
            for (const handler of this.messageHandlers) {
              handler(msg);
            }
          }
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error('[Kurotsuki] Error decoding WebSocket message:', errMsg);
        }
      };

      this.ws.onerror = (err) => {
        console.warn('[Kurotsuki] WebSocket connection error:', err);
      };

      this.ws.onclose = (event) => {
        this.clearTimers();
        this.ws = null;
        this.latency = null;
        if (!this.manualDisconnect) {
          const reason = event.reason ? `: ${event.reason}` : '';
          this.setStatus('disconnected', `Disconnected${reason}`);
          this.scheduleReconnect();
        } else {
          this.setStatus('disconnected');
        }
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to initialize WebSocket';
      this.setStatus('error', msg);
      this.scheduleReconnect();
    }
  }

  public disconnect(manual = true): void {
    this.manualDisconnect = manual;
    this.clearTimers();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore close error
      }
      this.ws = null;
    }
    this.latency = null;
    this.setStatus('disconnected');
  }

  public send(msg: WSMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Buffer critical sync/file messages if socket is temporarily connecting or reconnecting
      if (msg.type === 'yjs_sync' || msg.type === 'file_event' || msg.type === 'doc_request') {
        this.outgoingQueue.push(msg);
        if (this.outgoingQueue.length > 500) {
          this.outgoingQueue.shift();
        }
      }
      return false;
    }
    return this.sendDirect(msg);
  }

  private sendDirect(msg: WSMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error('[Kurotsuki] Failed to send WebSocket message:', errMsg);
      return false;
    }
  }

  private flushOutgoingQueue(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // Coalesce buffered yjs_sync updates for the same document path
    const coalesced: WSMessage[] = [];
    const syncUpdatesByPath: Map<string, string[]> = new Map();

    while (this.outgoingQueue.length > 0) {
      const msg = this.outgoingQueue.shift();
      if (!msg) continue;

      if (msg.type === 'yjs_sync') {
        let list = syncUpdatesByPath.get(msg.path);
        if (!list) {
          list = [];
          syncUpdatesByPath.set(msg.path, list);
          coalesced.push(msg); // First placeholder preserves relative order
        }
        list.push(msg.update);
      } else {
        coalesced.push(msg);
      }
    }

    for (const msg of coalesced) {
      if (msg.type === 'yjs_sync') {
        const updatesB64 = syncUpdatesByPath.get(msg.path);
        if (updatesB64 && updatesB64.length > 0) {
          syncUpdatesByPath.delete(msg.path);
          if (updatesB64.length === 1) {
            this.sendDirect(msg);
          } else {
            try {
              const u8List = updatesB64.map((b64) => base64ToUint8Array(b64));
              const merged = Y.mergeUpdates(u8List);
              this.sendDirect({
                type: 'yjs_sync',
                path: msg.path,
                update: uint8ArrayToBase64(merged),
              });
            } catch {
              for (const b64 of updatesB64) {
                this.sendDirect({ type: 'yjs_sync', path: msg.path, update: b64 });
              }
            }
          }
        }
      } else {
        this.sendDirect(msg);
      }
    }
  }

  public sendPing(): void {
    this.lastPingSentAt = Date.now();
    this.send({
      type: 'ping',
      timestamp: this.lastPingSentAt,
    });
  }

  public onMessage(handler: WSMessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  public onStatusChange(handler: StatusChangeHandler): () => void {
    this.statusHandlers.add(handler);
    handler(this.status);
    return () => this.statusHandlers.delete(handler);
  }

  public onLatencyChange(handler: LatencyHandler): () => void {
    this.latencyHandlers.add(handler);
    if (this.latency !== null) {
      handler(this.latency);
    }
    return () => this.latencyHandlers.delete(handler);
  }

  public onRoleChange(handler: RoleChangeHandler): () => void {
    this.roleHandlers.add(handler);
    handler(this.currentRole);
    return () => this.roleHandlers.delete(handler);
  }

  private setStatus(status: ConnectionStatus, message?: string): void {
    this.status = status;
    for (const handler of this.statusHandlers) {
      handler(status, message);
    }
  }

  private emitLatency(latencyMs: number): void {
    for (const handler of this.latencyHandlers) {
      handler(latencyMs);
    }
  }

  private emitRole(role: UserRole): void {
    for (const handler of this.roleHandlers) {
      handler(role);
    }
  }

  private scheduleReconnect(): void {
    if (this.manualDisconnect) return;
    this.reconnectAttempts++;
    // Exponential backoff with jitter: min(1000 * 1.6^attempt + jitter, 30000)
    const base = 1000 * Math.pow(1.6, Math.min(this.reconnectAttempts, 8));
    const jitter = Math.random() * 800;
    const delay = Math.min(base + jitter, 30000);

    const seconds = Math.ceil(delay / 1000);
    this.setStatus('disconnected', `Reconnecting in ${seconds}s (attempt ${this.reconnectAttempts})...`);

    this.reconnectTimeout = window.setTimeout(() => {
      this.connect();
    }, delay);
  }

  private startHeartbeat(): void {
    // Send ping every 10 seconds for active RTT & latency measurement
    this.pingInterval = window.setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.sendPing();
      }
    }, 10000);
  }

  private clearTimers(): void {
    if (this.reconnectTimeout !== null) {
      window.clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.pingInterval !== null) {
      window.clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}
