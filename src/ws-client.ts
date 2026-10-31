import { ConnectionStatus, KurotsukiSettings, UserProfile, WSMessage } from './types';

export type WSMessageHandler = (message: WSMessage) => void;
export type StatusChangeHandler = (status: ConnectionStatus, message?: string) => void;

export class KurotsukiWSClient {
  private ws: WebSocket | null = null;
  private settings: KurotsukiSettings;
  private getUserProfile: () => UserProfile;
  private messageHandlers: Set<WSMessageHandler> = new Set();
  private statusHandlers: Set<StatusChangeHandler> = new Set();
  private status: ConnectionStatus = 'disconnected';
  private reconnectTimeout: number | null = null;
  private pingInterval: number | null = null;
  private reconnectAttempts = 0;
  private manualDisconnect = false;

  constructor(settings: KurotsukiSettings, getUserProfile: () => UserProfile) {
    this.settings = settings;
    this.getUserProfile = getUserProfile;
  }

  public updateSettings(settings: KurotsukiSettings): void {
    this.settings = settings;
  }

  public getStatus(): ConnectionStatus {
    return this.status;
  }

  public connect(): void {
    this.manualDisconnect = false;
    this.clearTimers();

    if (!this.settings.serverUrl) {
      this.setStatus('error', 'Server URL is not set');
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
        // Send initial auth message
        this.send({
          type: 'auth',
          token: this.settings.authToken,
          vaultId: this.settings.vaultId,
          clientInfo: this.getUserProfile(),
        });
      };

      this.ws.onmessage = (event) => {
        try {
          const raw = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
          const msg = JSON.parse(raw) as WSMessage;

          if (msg.type === 'auth_ack') {
            if (msg.success) {
              this.setStatus('connected');
            } else {
              this.setStatus('error', msg.message || 'Authentication failed');
              this.disconnect(true);
            }
          } else if (msg.type === 'pong') {
            // Heartbeat response
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
        console.warn('[Kurotsuki] WebSocket error:', err);
      };

      this.ws.onclose = () => {
        this.clearTimers();
        this.ws = null;
        if (!this.manualDisconnect) {
          this.setStatus('disconnected', 'Disconnected from server');
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
      console.error('[Kurotsuki] Failed to send message:', err);
      return false;
    }
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

  private setStatus(status: ConnectionStatus, message?: string): void {
    this.status = status;
    for (const handler of this.statusHandlers) {
      handler(status, message);
    }
  }

  private scheduleReconnect(): void {
    if (this.manualDisconnect) return;
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 15000);
    this.reconnectTimeout = window.setTimeout(() => {
      this.connect();
    }, delay);
  }

  private startHeartbeat(): void {
    this.pingInterval = window.setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.send({ type: 'ping' });
      }
    }, 25000);
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
