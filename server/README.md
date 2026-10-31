# 🌙 Kurotsuki Sync - Cloud Relay Server

The self-hostable synchronization and collaboration server for Obsidian (Relay alternative). Built with high-performance WebSockets, Yjs CRDT document engine, and zero heavy dependencies.

---

## 🚀 Features

- **Real-Time Multiplayer Collaboration:** Full Yjs CRDT synchronization with live cursor tracking.
- **Selective & Vault-Wide Sync:** Room and vault isolation.
- **Binary Attachments:** Synchronizes images, audio, and attachments.
- **Persistent Storage:** Local file & binary snapshot storage with automated deduplication.
- **Zero-Dependency Core:** Runs natively anywhere Node.js or Docker runs.
- **Security:** Token-based authentication, path sanitization, and traversal protection.

---

## 🛠️ Quick Start with Docker Compose (Recommended)

1. **Clone or copy the server folder:**
   ```bash
   git clone https://github.com/Kurotsuki-Sync/kurotsuki-sync.git
   cd "Kurotsuki Sync/server"
   ```

2. **Configure your environment:**
   ```bash
   cp .env.example .env
   # Edit .env and set your AUTH_TOKEN
   ```

3. **Start the server:**
   ```bash
   docker compose up -d
   ```

The server is now live at `http://localhost:3000` (and WebSocket at `ws://localhost:3000`).

---

## 💻 Manual Setup (Node.js)

### Prerequisites
- Node.js 20+ installed.

### Steps
```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Start the server
npm start
```

For development with hot-reload:
```bash
npm run dev
```

---

## 🌐 Production Deployment Options

### Option A: Reverse Proxy with Nginx
```nginx
server {
    server_name sync.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Option B: Cloudflare Tunnel (Zero Port Forwarding)
```bash
cloudflared tunnel run --url http://localhost:3000 my-kurotsuki-relay
```

### Option C: Tailscale (Private Mesh VPN)
Simply run on any device on your Tailscale network and point Obsidian to `ws://tailscale-machine-ip:3000`.

---

## 🔍 API & Health Endpoints

- `GET /health` or `GET /api/v1/health`
  Returns server uptime and operational status.
- `GET /api/v1/stats` (Requires Bearer token if `AUTH_TOKEN` is set)
  Returns active rooms, peer count, memory usage.
- `GET /api/v1/attachments/:vaultId/:path`
  Downloads synced binary asset.
- `PUT /api/v1/attachments/:vaultId/:path`
  Uploads binary asset.
