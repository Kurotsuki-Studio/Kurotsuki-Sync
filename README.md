# 🌙 Kurotsuki Sync

**Kurotsuki Sync** is a self-hostable, local-first real-time collaboration and vault synchronization plugin for [Obsidian](https://obsidian.md).

It provides an open-source alternative to proprietary relay sync solutions, powered by **Yjs CRDTs** for seamless, conflict-free collaboration.

---

## ✨ Features

- ⚡ **Live Collaborative Editing:** Multiple users editing the exact same note simultaneously with zero merge conflicts.
- 👥 **Real-Time Cursor Presence:** See collaborators' live cursors, text selections, and active file indicators in real time.
- 🔒 **Self-Hosted & Private:** Complete ownership of your data. Connects to your own [Kurotsuki Sync Relay Server](https://github.com/Kurotsuki-Studio/Kurotsuki-Sync-Server).
- 💾 **Local-First & Offline Resilient:** Keep writing without an internet connection. Changes sync automatically when reconnected.
- 📎 **Attachment & Media Sync:** Automatic synchronization of images, audio, PDFs, and binary attachments.
- 🎯 **Selective Synchronization:** Choose between synchronizing your entire vault or specific shared directories.

---

## 🚀 Quick Start

### 1. Host the Relay Server
Deploy the lightweight relay server using Docker on your VPS or local network:
\\\ash
# See the server repository for full instructions:
# https://github.com/Kurotsuki-Studio/Kurotsuki-Sync-Server
git clone https://github.com/Kurotsuki-Studio/Kurotsuki-Sync-Server.git
cd Kurotsuki-Sync-Server
docker compose up -d
\\\

### 2. Install the Plugin in Obsidian
- **From Community Plugins:** Search for **Kurotsuki Sync** and click Install (once listed).
- **Manual Installation:**
  1. Download \main.js\, \manifest.json\, and \styles.css\ from the [Latest Release](https://github.com/Kurotsuki-Studio/Kurotsuki-Sync/releases).
  2. Place them into: \<Your-Vault>/.obsidian/plugins/obsidian-kurotsuki-sync/\.
  3. Reload Obsidian and enable the plugin in **Settings → Community plugins**.

### 3. Configure the Connection
In Obsidian **Settings → Kurotsuki Sync**:
1. **Server URL:** \ws://your-server-ip:3000\ (or \wss://sync.yourdomain.com\).
2. **Auth Token:** The secret authentication token set on your server.
3. **Room / Vault ID:** The shared identifier for your workspace.
4. **Display Name & Color:** Customize your presence cursor for other collaborators.

---

## 🛠️ Development & Building

\\\ash
git clone https://github.com/Kurotsuki-Studio/Kurotsuki-Sync.git
cd Kurotsuki-Sync
npm install
npm run build
\\\

---

## 📄 License

MIT License - Copyright (c) 2026 Kurotsuki Studio
