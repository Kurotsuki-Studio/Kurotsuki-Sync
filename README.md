# 🌙 Kurotsuki Sync

> **Local-first, real-time collaborative editing & vault synchronization for Obsidian.**  
> A 100% open-source and self-hostable alternative to Obsidian Relay and Obsidian Sync.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node: 20+](https://img.shields.io/badge/node-20%2B-green.svg)](https://nodejs.org/)
[![Obsidian: v1.5+](https://img.shields.io/badge/Obsidian-v1.5%2B-purple.svg)](https://obsidian.md)

---

## 🌟 Overview

**Kurotsuki Sync** brings real-time multiplayer collaboration, cursor presence, and resilient synchronization to your Obsidian vaults using your own self-hosted infrastructure. 

- **No monthly subscriptions:** Full self-hosted control over your documents and data.
- **Conflict-free resolution:** Powered by [Yjs](https://yjs.dev/) Conflict-Free Replicated Data Types (CRDTs).
- **Multiplayer awareness:** Live cursor positions and active collaborator indicators directly in Obsidian editor.
- **Flexible sync modes:** Synchronize either your entire vault or selectively choose specific folders.
- **Binary asset synchronization:** Sync images, PDFs, audio, and attachments via built-in HTTP chunked endpoints.
- **Secure by design:** Token authentication, path sanitization, traversal protection, and end-to-end transport encryption with TLS/WSS.

---

## 📂 Repository Structure

```
Kurotsuki-Sync/
├── plugin/               # Obsidian desktop/mobile plugin (TypeScript, CodeMirror 6, Yjs)
│   ├── src/              # Plugin source code
│   ├── tests/            # Test suite for sync logic & awareness
│   ├── manifest.json     # Obsidian plugin manifest
│   └── esbuild.config.mjs# Production bundler
├── server/               # Self-hosted relay & storage server (Node.js, WebSockets, Yjs)
│   ├── src/              # Server source code (auth, rooms, CRDT storage, HTTP API)
│   ├── tests/            # Integration & unit test suite
│   ├── Dockerfile        # Container image
│   ├── docker-compose.yml# Single-command deployment with Caddy reverse proxy
│   └── Caddyfile         # Automatic Let's Encrypt SSL/TLS reverse proxy
└── README.md
```

---

## 🚀 Quick Start

### 1. Deploy the Relay Server

The relay server can be deployed on any VPS, home server, Raspberry Pi, or local network.

#### Using Docker Compose (Recommended)

```bash
cd server
cp .env.example .env
# Edit .env and choose your AUTH_TOKEN and PORT
docker compose up -d
```

Your relay server is now active at `http://your-server-ip:3000` (and `ws://your-server-ip:3000`).

For automatic HTTPS with Let's Encrypt, configure your domain in `server/Caddyfile` and deploy the Caddy profile:
```bash
docker compose --profile proxy up -d
```

#### Running directly with Node.js

```bash
cd server
npm install
npm run build
npm start
```

---

### 2. Install & Configure the Obsidian Plugin

#### Installation

1. Build the plugin:
   ```bash
   cd plugin
   npm install
   npm run build
   ```
2. Copy the plugin files (`main.js`, `manifest.json`, `styles.css`) into your Obsidian vault:
   ```
   <Your-Vault>/.obsidian/plugins/obsidian-kurotsuki-sync/
   ```
3. In Obsidian, go to **Settings → Community plugins**, reload, and enable **Kurotsuki Sync**.

#### Configuration

In Obsidian **Settings → Kurotsuki Sync**:

| Setting | Description | Example |
| :--- | :--- | :--- |
| **Server URL** | WebSocket URL of your relay server | `ws://127.0.0.1:3000` or `wss://sync.example.com` |
| **Auth Token** | Secret authentication token configured on server | `your-secret-token` |
| **Room / Vault ID** | Unique room or vault identifier to synchronize | `team-vault-01` |
| **User Name** | Your display name for collaboration cursors | `Alice` |
| **User Color** | Cursor color for collaborative editing | `#8b5cf6` |
| **Sync Mode** | `Entire Vault` or `Selective (Shared Folders)` | Selective |
| **Shared Folders** | Folders to sync when in selective mode | `Projects`, `Work/Shared` |
| **Sync Attachments**| Enable image and binary file synchronization | `true` |

---

## 🧪 Testing & Verification

Both the server and plugin contain automated test suites:

### Server Tests
```bash
cd server
npm test
```
Tests health check endpoints, token authentication, protected routes, binary attachment upload/download, WebSocket lifecycle, and multi-client Yjs synchronization.

### Plugin Tests
```bash
cd plugin
npm test
```
Tests Base64/Uint8Array roundtrip encoders, selective folder filtering logic, and Awareness cursor state tracking.

---

## 🛡️ Security & Privacy

- **Self-Hosted:** Your notes and edits never touch third-party cloud services.
- **Transport Encryption:** Use HTTPS and WSS via reverse proxy (Caddy, Nginx, or Cloudflare Tunnel).
- **Access Control:** All WebSocket connections and attachment requests are validated against `AUTH_TOKEN`.
- **Path Sanitization:** Prevent directory traversal attacks on vault assets.

---

## 📄 License

This project is open-source and released under the [MIT License](LICENSE).
