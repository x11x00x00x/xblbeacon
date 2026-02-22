# XBL Beacon

A desktop app that updates your **Discord Rich Presence** when you're online on Insignia (xb.live). It shows what game you're playing and keeps the xb.live dashboard in sync with your status.

NOT OFFICIALLY SUPPORTED BY INSIGNIA.

**When logging into the App, Make sure Discord is open on your computer. Additionally, use your exsisting insignia login that you would use on the insignia.live website.**


**DOWNLOAD THE PRECOMPILED VERSION IN THE RELEASE PANEL ---->>>>**

## Features

- **Discord Rich Presence** – When you're online on Insignia, Discord shows your current game and "Online as [username]".
- **xb.live integration** – Log in with your xb.live (Insignia) account. The app registers with the site and sends a heartbeat so the dashboard and cron update your status every 1–2 minutes.
- **Any game** – Works with all Insignia games; presence uses the game name from your Insignia profile (e.g. "Xbox Live Dashboard", "Forza Motorsport").
- **Background running** – Runs in the system tray and checks status every 2 minutes.
- **Auto-start** – Option to start when your computer boots.
- **Cross-platform** – Windows and macOS.

## Prerequisites

- **Node.js** v16 or higher
- **Discord** desktop app (must be running for Rich Presence to work)
- **Insignia account** – Same email/password you use on the Insignia Stats / xb.live website

## Installation

1. **Install dependencies**
   ```bash
   cd XBLBeacon
   npm install
   ```

2. **Run the app**
   ```bash
   npm start
   ```

3. **Log in**
   - Click **Login to Discord** (Discord must be running).
   - Click **Login to xb.live** and enter your Insignia / xb.live email and password.
   - The app registers with xb.live and starts checking your status every 2 minutes.

## Building for distribution

Icons are generated from `icon.png` in the project root before each build.

- **macOS (current platform)**  
  `npm run build` or `npm run build:mac`  
  → `dist/XBL Beacon-1.0.0-arm64.dmg` (Apple Silicon)

- **Windows (from macOS)**  
  `npm run build:win`  
  → `dist/XBL Beacon-Setup-1.0.0.exe` (64-bit)

- **Regenerate icons only**  
  `npm run generate-icons`  
  → Updates `assets/icon.ico` and `assets/icon.icns` from `icon.png`.

## How it works

1. You log in to **Discord** and **xb.live** in the app.
2. The app **registers** your session with xb.live (`/api/me/play-time-register`) so the site can track you.
3. Every **2 minutes** the app:
   - Calls **xb.live** `POST /api/me/profile-live` with your session key. The server fetches your live status from the auth service (same as the dashboard/cron).
   - Sends a **beacon ping** to xb.live so the play-time cron re-checks you every run.
   - Updates **Discord** presence with your current game and "Online as [username]", or clears it if you're offline.

4. The **xb.live dashboard** shows your online status and play time; with the beacon running, it can update within about 1–2 minutes of you going online or offline.

It can take up to about **10 minutes** for status to appear the first time after signing in; after that, updates run every 2 minutes.

## System tray

- **Click** tray icon – Show or hide the main window.
- **Right-click** – Menu: Show XBL Beacon or Quit.

## Settings

- **Start automatically when computer starts** – Enable in the app to launch at login (runs in the background).

## Troubleshooting

| Issue | What to try |
|-------|---------------------|
| **Status stays "Not active"** | Make sure you're actually online in a game (or dashboard) on Insignia. The app gets status from xb.live; if the website shows you online, the beacon should too after the next 2‑minute check. |
| **"Insignia reports you're offline"** | You're logged in but Insignia says you're not in a game. Go online on the console and wait for the next check. |
| **Discord never updates** | Ensure Discord desktop is running and you're logged into both Discord and xb.live in the app. |
| **App won't start** | Run `npm install`, then `npm start`. Check the terminal for errors. |
| **Windows: "DiscardVirtualMemory could not be located"** | Use the built installer from this repo (Electron 22); it supports Windows 7/8. |

## Project structure

| Path | Purpose |
|------|--------|
| `main.js` | Main process: Discord RPC, profile via xb.live, beacon ping, tray, `nodeFetch` for HTTP |
| `preload.js` | Preload script for secure IPC |
| `renderer.js` | UI, login, presence status display |
| `index.html` | Main window |
| `scripts/generate-icons.js` | Build script: `icon.png` → `assets/icon.ico` and `assets/icon.icns` |
| `package.json` | Dependencies and electron-builder config |

## License

ISC.
