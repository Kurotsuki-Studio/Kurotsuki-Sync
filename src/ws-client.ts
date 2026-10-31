import { ConnectionStatus, KurotsukiSettings, UserProfile, UserRole, WSMessage } from './types';

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
      };

      this.ws.onmessage = (event) => {
        try {
          const raw = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
          const msg = JSON.parse(raw) as WSMessage;

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
        } catch (err) {
          console.error('[Kurotsuki] Error decoding WebSocket message:', err);
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
    } catch (err: any) {
      this.setStatus('error', err?.message || 'Failed to initialize WebSocket');
      this.scheduleReconnect();
    }
  }

  public disconnect(manual = true): void {
    this.manualDisconnect = manual;
    this.clearTimers();
    if (this.ws) {
      try {
        this.ws.close();
      } catch (e) {
        // Ignore close error
      }
      this.ws = null;
    }
    this.latency = null;
    this.setStatus('disconnected');
  }

  public send(msg: WSMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      console.error('[Kurotsuki] Failed to send WebSocket message:', err);
      return false;
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
