# 🌙 Kurotsuki Sync

<p align="center">
  <b>Synchronisation et collaboration temps réel auto-hébergeables pour Obsidian</b><br>
  <i>L'alternative libre, décentralisée et respectueuse de votre vie privée à Obsidian Sync & Relay.</i>
</p>

<p align="center">
  <a href="https://github.com/Kurotsuki-Studio/Kurotsuki-Sync/releases"><img src="https://img.shields.io/github/v/release/Kurotsuki-Studio/Kurotsuki-Sync?color=7c3aed&style=flat-square" alt="GitHub release" /></a>
  <a href="https://github.com/Kurotsuki-Studio/Kurotsuki-Sync-Server"><img src="https://img.shields.io/badge/Server-Kurotsuki--Sync--Server-blue?style=flat-square" alt="Server Repo" /></a>
  <a href="https://github.com/Kurotsuki-Studio/Kurotsuki-Sync/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License" /></a>
</p>

---

## ✨ Fonctionnalités Clés

- ⚡ **Édition collaborative en direct (CRDTs)** : Modifiez la même note à plusieurs simultanément sans aucun conflit de fusion grâce à la technologie [Yjs](https://yjs.dev/).
- 👥 **Curseurs et présences en direct** : Visualisez les curseurs colorés de vos collaborateurs, leurs sélections de texte et la note qu'ils consultent en temps réel.
- 🔒 **100% Souverain & Privé** : Vos notes ne transitent par aucun serveur tiers. Vous vous connectez directement à votre propre serveur relais : [**Kurotsuki-Sync-Server**](https://github.com/Kurotsuki-Studio/Kurotsuki-Sync-Server).
- 💾 **Local-First & Résilience Hors-Ligne** : Continuez à écrire sans connexion Internet. Vos modifications sont sauvegardées localement et synchronisées automatiquement dès que le réseau revient.
- 📎 **Synchronisation des Pièces Jointes** : Prise en charge automatique des images (PNG, JPG, WebP), PDFs, audios et médias.
- 🎯 **Synchronisation Sélective** : Choisissez de synchroniser l'intégralité de votre coffre (*Entire Vault*) ou uniquement des dossiers partagés spécifiques.

---

## 🚀 Installation

### Option 1 : Via les Releases GitHub (Recommandé)
1. Rendez-vous sur la page des [**Releases**](https://github.com/Kurotsuki-Studio/Kurotsuki-Sync/releases/latest).
2. Téléchargez les trois fichiers :
   - `main.js`
   - `manifest.json`
   - `styles.css`
3. Dans votre coffre Obsidian, créez le dossier :
   ```
   <Votre-Coffre>/.obsidian/plugins/obsidian-kurotsuki-sync/
   ```
4. Déposez-y les 3 fichiers téléchargés.
5. Rechargez Obsidian, ouvrez **Paramètres → Plugins de la communauté**, puis activez **Kurotsuki Sync**.

### Option 2 : Via le plugin BRAT
1. Installez le plugin communautaire **Obsidian42 - BRAT**.
2. Dans les paramètres de BRAT, cliquez sur **Add Beta plugin**.
3. Entrez l'URL : `https://github.com/Kurotsuki-Studio/Kurotsuki-Sync`.
4. BRAT téléchargera et mettra à jour le plugin automatiquement à chaque nouvelle release.

---

## ⚙️ Configuration du Plugin

Une fois le plugin activé, accédez à **Paramètres → Kurotsuki Sync** :

| Paramètre | Description | Exemple |
| :--- | :--- | :--- |
| **Server URL** | Adresse WebSocket de votre serveur relais | `ws://192.168.1.50:3000` ou `wss://sync.mon-domaine.fr` |
| **Auth Token** | Clé secrète configurée sur votre serveur relais (`AUTH_TOKEN`) | `mon_super_token_secret_123` |
| **Vault / Room ID** | Identifiant unique du salon de synchronisation partagé | `equipe-projet` ou `mon-coffre-perso` |
| **User Name** | Votre nom affiché sur votre curseur pour les autres | `Alice` |
| **Cursor Color** | Couleur de votre curseur et de votre sélection | `#7c3aed` |
| **Sync Mode** | Mode de synchronisation (Coffre complet ou Dossiers sélectionnés) | `Entire Vault` |
| **Sync Attachments** | Activer ou non la synchronisation des images et pièces jointes | `Activé` |

---

## 🖥️ Héberger le Serveur Relais

Le plugin nécessite une instance du serveur relais **Kurotsuki Sync Server**. 

Le déploiement se fait en 1 minute via Docker :

```bash
git clone https://github.com/Kurotsuki-Studio/Kurotsuki-Sync-Server.git
cd Kurotsuki-Sync-Server
docker compose up -d
```

Pour la documentation complète du serveur, le proxy inverse HTTPS/WSS (Caddy, Nginx) et les options avancées, consultez le dépôt :
👉 [**https://github.com/Kurotsuki-Studio/Kurotsuki-Sync-Server**](https://github.com/Kurotsuki-Studio/Kurotsuki-Sync-Server)

---

## 🛠️ Développement Local

```bash
# Cloner le dépôt
git clone https://github.com/Kurotsuki-Studio/Kurotsuki-Sync.git
cd Kurotsuki-Sync

# Installer les dépendances
npm install

# Compiler en mode production
npm run build

# Mode développement avec auto-rechargement
npm run dev
```

---

## 📄 Licence

Ce projet est sous licence libre [MIT](LICENSE). Développé avec passion par [Kurotsuki Studio](https://github.com/Kurotsuki-Studio).
