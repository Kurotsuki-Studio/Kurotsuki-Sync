# 🌙 Kurotsuki Sync

<p align="center">
  <b>Self-hostable, local-first real-time collaboration and vault synchronization for Obsidian</b><br>
  <b>Synchronisation et collaboration temps réel auto-hébergeables pour Obsidian</b>
</p>

<p align="center">
  <a href="https://github.com/Kurotsuki-Studio/Kurotsuki-Sync/releases"><img src="https://img.shields.io/github/v/release/Kurotsuki-Studio/Kurotsuki-Sync?color=7c3aed&style=flat-square" alt="GitHub release" /></a>
  <a href="https://github.com/Kurotsuki-Studio/Kurotsuki-Sync-Server"><img src="https://img.shields.io/badge/Server-Kurotsuki--Sync--Server-blue?style=flat-square" alt="Server Repo" /></a>
  <a href="https://github.com/Kurotsuki-Studio/Kurotsuki-Sync/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License" /></a>
</p>

<p align="center">
  <a href="#english">English</a> • <a href="#français">Français</a>
</p>

---

<a name="english"></a>
## 🇬🇧 English

**Kurotsuki Sync** is an open-source, self-hosted, local-first alternative to proprietary Obsidian relay and synchronization services. Powered by **Yjs CRDTs**, it enables real-time peer-to-peer style collaboration with zero merge conflicts.

### ✨ Key Features

- ⚡ **Live Collaborative Editing:** Multiple users editing the exact same note simultaneously with conflict-free merges (CRDT).
- 👥 **Real-Time Cursor Presence:** Live collaborator cursors, text selection highlights, and note location indicators.
- 🔒 **100% Sovereign & Private:** Connects directly to your own self-hosted [**Kurotsuki-Sync-Server**](https://github.com/Kurotsuki-Studio/Kurotsuki-Sync-Server). No third-party data tracking.
- 💾 **Local-First & Offline Resilient:** Write freely while offline; changes sync and merge cleanly upon reconnection.
- 📎 **Attachment & Media Sync:** Automatic synchronization of binary files (images, audio, PDFs, canvases).
- 🎯 **Selective Sync Scope:** Choose between synchronizing your entire vault or designated shared folders.

### 📦 Installation

#### Option 1: Manual Installation (GitHub Release)
1. Download `main.js`, `manifest.json`, and `styles.css` from the [**Latest Release**](https://github.com/Kurotsuki-Studio/Kurotsuki-Sync/releases/latest).
2. Inside your Obsidian vault, create the folder:
   ```
   <Your-Vault>/.obsidian/plugins/obsidian-kurotsuki-sync/
   ```
3. Place `main.js`, `manifest.json`, and `styles.css` into that folder.
4. Reload Obsidian, navigate to **Settings → Community plugins**, and enable **Kurotsuki Sync**.

#### Option 2: Obsidian42 - BRAT (Beta Reviewer Auto-update Tester)
1. Install **Obsidian42 - BRAT** from Community Plugins.
2. In BRAT settings, click **Add Beta plugin**.
3. Enter repository URL: `https://github.com/Kurotsuki-Studio/Kurotsuki-Sync`.
4. BRAT installs and automatically updates the plugin on each new release.

### ⚙️ Plugin Configuration

In Obsidian **Settings → Kurotsuki Sync**:

| Option | Description | Example |
| :--- | :--- | :--- |
| **Relay Server URL** | WebSocket URL of your self-hosted relay | `ws://192.168.1.50:3000` or `wss://sync.yourdomain.com` |
| **Authentication Secret / Token** | Secret token configured on your relay server (`AUTH_TOKEN`) | `your-secret-token` |
| **Vault / Room ID** | Shared workspace identifier | `team-notes` or `main-vault` |
| **Display Name** | Your visible nickname for collaborator cursor badges | `Alice` |
| **User Color** | Cursor & text selection highlight color | `#7c3aed` |
| **Sync Mode** | `Entire Vault` or `Selective Shared Folders` | `Entire Vault` |
| **Sync Attachments** | Toggle automatic synchronization of binary attachments | `Enabled` |
| **Show Live Remote Cursors** | Display remote user cursor positions in the editor | `Enabled` |
| **Auto-connect on Startup** | Automatically connect when Obsidian opens | `Enabled` |

---

<a name="français"></a>
## 🇫🇷 Français

**Kurotsuki Sync** est une alternative libre, auto-hébergeable et locale (*local-first*) aux services de synchronisation et de collaboration propriétaires pour Obsidian. Grâce aux **CRDTs Yjs**, il permet une édition collaborative en direct sans jamais perdre de données ni rencontrer de conflits de fusion.

### ✨ Fonctionnalités Clés

- ⚡ **Édition collaborative en direct (CRDTs)** : Modifiez la même note à plusieurs en simultané sans aucun conflit de fusion grâce à la technologie [Yjs](https://yjs.dev/).
- 👥 **Curseurs et présences en temps réel** : Visualisez en direct les curseurs colorés, les sélections de texte et les fichiers actifs de vos collaborateurs.
- 🔒 **100% Souverain & Privé** : Vos notes restent sur votre propre serveur relais auto-hébergé [**Kurotsuki-Sync-Server**](https://github.com/Kurotsuki-Studio/Kurotsuki-Sync-Server).
- 💾 **Local-First & Résilience Hors-Ligne** : Continuez d'écrire sans connexion Internet. Vos modifications sont sauvegardées localement et synchronisées automatiquement dès que le réseau revient.
- 📎 **Synchronisation des Pièces Jointes** : Prise en charge automatique des images (PNG, JPG, WebP), PDFs, fichiers audios et canevas.
- 🎯 **Synchronisation Sélective** : Choisissez entre la synchronisation du coffre entier (*Entire Vault*) ou uniquement de dossiers partagés spécifiques.

### 📦 Installation

#### Option 1 : Installation Manuelle (Release GitHub)
1. Téléchargez `main.js`, `manifest.json` et `styles.css` depuis la [**Dernière Release**](https://github.com/Kurotsuki-Studio/Kurotsuki-Sync/releases/latest).
2. Dans votre coffre Obsidian, créez le dossier :
   ```
   <Votre-Coffre>/.obsidian/plugins/obsidian-kurotsuki-sync/
   ```
3. Déposez-y les 3 fichiers téléchargés.
4. Rechargez Obsidian, ouvrez **Paramètres → Plugins de la communauté**, puis activez **Kurotsuki Sync**.

#### Option 2 : Via le plugin Obsidian42 - BRAT
1. Installez le plugin **Obsidian42 - BRAT** depuis les plugins communautaires.
2. Dans les réglages de BRAT, cliquez sur **Add Beta plugin**.
3. Saisissez l'URL : `https://github.com/Kurotsuki-Studio/Kurotsuki-Sync`.
4. BRAT se charge de l'installation et des mises à jour automatiques.

### ⚙️ Configuration du Plugin

Dans Obsidian **Paramètres → Kurotsuki Sync** :

| Option | Description | Exemple |
| :--- | :--- | :--- |
| **Relay Server URL** | Adresse WebSocket de votre serveur relais | `ws://192.168.1.50:3000` ou `wss://sync.mon-domaine.fr` |
| **Authentication Secret / Token** | Clé secrète configurée sur votre serveur (`AUTH_TOKEN`) | `mon-token-secret` |
| **Vault / Room ID** | Identifiant du salon de synchronisation partagé | `notes-equipe` ou `mon-coffre` |
| **Display Name** | Votre pseudo affiché sur votre curseur pour les autres | `Alice` |
| **User Color** | Couleur de votre curseur et de vos sélections | `#7c3aed` |
| **Sync Mode** | Mode : Coffre complet (`Entire Vault`) ou Dossiers partagés (`Selective`) | `Entire Vault` |
| **Sync Attachments** | Activer ou non la synchronisation des médias et images | `Activé` |
| **Show Live Remote Cursors** | Afficher les curseurs des collaborateurs en direct | `Activé` |
| **Auto-connect on Startup** | Connexion automatique au lancement d'Obsidian | `Activé` |

---

## 🖥️ Serveur Relais / Relay Server

Le serveur relais s'installe en quelques secondes avec Docker ou Node.js :
👉 [**https://github.com/Kurotsuki-Studio/Kurotsuki-Sync-Server**](https://github.com/Kurotsuki-Studio/Kurotsuki-Sync-Server)

---

## 🛠️ Développement / Development

```bash
git clone https://github.com/Kurotsuki-Studio/Kurotsuki-Sync.git
cd Kurotsuki-Sync
npm install
npm run build
```

---

## 📄 Licence

MIT License - Copyright (c) 2026 [Kurotsuki Studio](https://github.com/Kurotsuki-Studio).
