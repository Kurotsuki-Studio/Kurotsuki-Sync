# 🌙 Kurotsuki Sync - Obsidian Plugin

Obsidian client plugin for **Kurotsuki Sync**: local-first real-time collaboration and vault synchronization powered by Yjs CRDTs.

---

## ⚡ Features

- **Live Collaborative Editing:** Multiple users editing the exact same note simultaneously with conflict-free merges.
- **Collaborator Presence & Cursors:** See remote user cursors, selection highlights, and active file indicators in real-time.
- **Local-First & Offline Resilient:** Edits are preserved locally when offline and synchronized automatically upon reconnection.
- **Selective Synchronization:** Choose whether to synchronize the entire vault or only specific shared directories.
- **Attachment & Asset Sync:** Automatically synchronizes embedded images and binary files.

---

## 📦 Manual Installation

1. Clone or download this repository.
2. Build the plugin bundle:
   ```bash
   cd plugin
   npm install
   npm run build
   ```
3. Copy `main.js`, `manifest.json`, and `styles.css` to:
   ```
   <Your-Vault>/.obsidian/plugins/obsidian-kurotsuki-sync/
   ```
4. Reload Obsidian, open **Settings → Community plugins**, and enable **Kurotsuki Sync**.

---

## ⚙️ Configuration

In Obsidian **Settings → Kurotsuki Sync**:
- **Server URL:** The WebSocket URL of your Kurotsuki Sync server (e.g., `ws://localhost:3000` or `wss://sync.yourdomain.com`).
- **Auth Token:** The secret authentication token matching `AUTH_TOKEN` in the server's `.env`.
- **Room / Vault ID:** Unique identifier for the shared collaboration room or vault.
- **Display Name & Color:** Customize your cursor name and color for collaborators.
- **Sync Mode:** Choose between `Entire Vault` or `Selective (Shared Folders)`.
- **Sync Attachments:** Toggle binary asset synchronization (images, audio, PDFs).

---

## 🧪 Testing

Run automated tests:
```bash
npm test
```
