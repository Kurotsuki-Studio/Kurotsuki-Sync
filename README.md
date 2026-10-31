# 🌙 Kurotsuki Sync

<p align="center">
  <b>Self-hostable, local-first real-time collaboration and vault synchronization for Obsidian</b><br>
  <b>Synchronisation et collaboration temps réel multi-utilisateurs auto-hébergeables pour Obsidian</b>
</p>

<p align="center">
  <a href="https://github.com/Kurotsuki-Studio/Kurotsuki-Sync/releases"><img src="https://img.shields.io/github/v/release/Kurotsuki-Studio/Kurotsuki-Sync?color=7c3aed&style=flat-square" alt="GitHub release" /></a>
  <a href="https://github.com/Kurotsuki-Studio/Kurotsuki-Sync-Server"><img src="https://img.shields.io/badge/Server-Kurotsuki--Sync--Server-blue?style=flat-square" alt="Server Repo" /></a>
  <a href="https://github.com/Kurotsuki-Studio/Kurotsuki-Sync/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License" /></a>
</p>

<p align="center">
  <a href="#english">English</a> • <a href="#français">Français</a> • <a href="#server-guide">Guide Serveur & VPS</a>
</p>

---

<a name="english"></a>
## 🇬🇧 English

**Kurotsuki Sync** is an open-source, self-hosted, local-first alternative to proprietary Obsidian relay and synchronization services. Powered by **Yjs CRDTs** and WebSockets, it enables real-time collaborative editing, instant cursor presence, multi-vault profile switching, and strict Role-Based Access Control (RBAC).

### ✨ Key Features

- ⚡ **Live Collaborative Editing:** Multiple users editing the exact same note simultaneously with conflict-free merges (CRDT).
- 👥 **Real-Time Cursor Presence & Avatars:** See collaborator cursor positions, active text selections, and note locations in real time.
- 🗂️ **Multi-Vault Profile Switcher:** Switch between multiple remote vaults and relay rooms with 1 click without leaving Obsidian.
- 🔒 **Client-Side Read-Only Enforcement:** Users with the `viewer` role are locked in read-only mode in CodeMirror 6 with clear visual badges.
- 📁 **File Explorer Reconciliation:** Add or delete files from Windows Explorer, Finder, or terminal: changes sync automatically while Obsidian runs or when launched.
- 👥 **Peer List Sidebar View:** Dockable sidebar leaf showing online collaborators, their custom avatars, and clickable active note links.
- 📜 **Conflict History & Audit Inspector:** Built-in modal to view CRDT merge events, file synchronization status, and server communication logs.
- 📶 **Real-Time Ping Indicator:** Live connection latency display in the Obsidian status bar.
- 🔒 **100% Sovereign & Private:** Connects directly to your own self-hosted [**Kurotsuki-Sync-Server**](https://github.com/Kurotsuki-Studio/Kurotsuki-Sync-Server).

---

### 📦 Installation

#### Option 1: Obsidian42 - BRAT (Recommended for Auto-Updates)
1. Install **Obsidian42 - BRAT** from Community Plugins in Obsidian.
2. In BRAT settings, click **Add Beta plugin**.
3. Enter repository URL: `https://github.com/Kurotsuki-Studio/Kurotsuki-Sync`.
4. BRAT installs and automatically keeps the plugin up to date.

#### Option 2: Manual Installation (GitHub Release)
1. Download `main.js`, `manifest.json`, and `styles.css` from the [**Latest Release**](https://github.com/Kurotsuki-Studio/Kurotsuki-Sync/releases/latest).
2. Inside your Obsidian vault, create the folder:
   ```
   <Your-Vault>/.obsidian/plugins/obsidian-kurotsuki-sync/
   ```
3. Copy `main.js`, `manifest.json`, and `styles.css` into that directory.
4. Reload Obsidian, open **Settings → Community plugins**, and toggle **Kurotsuki Sync** ON.

---

### ⚙️ Plugin Configuration

In Obsidian **Settings → Kurotsuki Sync**:

| Option | Description | Example |
| :--- | :--- | :--- |
| **Relay Server URL** | WebSocket URL of your self-hosted relay | `ws://192.168.1.50:3050` or `wss://relay.yourdomain.com` |
| **Authentication Secret / Token** | Token configured on your relay (`AUTH_TOKEN` or generated user token) | `kurotsuki_vault` |
| **Vault / Room ID** | Shared workspace or room name | `Kurotsuki Vault` |
| **Display Name** | Your visible nickname for collaborator cursor badges | `AngmarRoiSorcier` |
| **User Color** | Color of your avatar and live cursor highlight | `#ff0000` |
| **Sync Mode** | Choose between `Entire Vault` or `Selective Shared Folders` | `Entire Vault` |

---

<a name="server-guide"></a>
### 🔄 Server Setup & VPS Update Tutorial

To run or update your self-hosted server on a VPS, refer to the [**Kurotsuki Sync Server Guide**](https://github.com/Kurotsuki-Studio/Kurotsuki-Sync-Server#vps-update).

Quick commands to update the server on your VPS:
```bash
cd /root/Kurotsuki-Sync-Server
git pull origin main
docker compose down
docker compose up -d --build
docker compose logs -f
```

---

<a name="français"></a>
## 🇫🇷 Français

**Kurotsuki Sync** est une alternative open-source, auto-hébergeable et "local-first" aux services propriétaires Obsidian Sync et Relay. Basé sur **Yjs** et WebSockets, il offre la collaboration en temps réel, la présence des curseurs, la gestion multi-coffres et le contrôle des permissions par rôle (RBAC).

### ✨ Fonctionnalités Principales

- ⚡ **Édition Collaborative Temps Réel :** Éditez la même note à plusieurs sans aucun conflit de fusion grâce aux CRDTs Yjs.
- 👥 **Curseurs & Avatars en Direct :** Visualisez les curseurs de vos collaborateurs, leurs sélections de texte et la note sur laquelle ils travaillent.
- 🗂️ **Sélecteur Multi-Coffres :** Passez d'un coffre ou salon distant à un autre en 1 clic directement dans Obsidian.
- 🔒 **Protection Lecture Seule (Viewer) :** Si votre rôle est `viewer`, l'éditeur CodeMirror 6 est verrouillé et les modifications locales sont bloquées.
- 📁 **Prise en charge de l'Explorateur Windows / Linux :** Vos ajouts et suppressions de fichiers effectués hors d'Obsidian sont synchronisés en direct et au démarrage.
- 👥 **Panneau Latéral des Collaborateurs :** Onglet latéral affichant les membres connectés et liens directs vers leurs notes actives.
- 📶 **Indicateur de Latence :** Affichage du ping en direct dans la barre d'état Obsidian.
