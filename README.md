# XBL Beacon

A desktop app that updates your **Discord Rich Presence** when you're online on Insignia (xb.live). It shows what game you're playing and keeps the xb.live dashboard in sync with your status.

## TO DOWNLOAD XBL BEACON CLICK RELEASES TO THE RIGHT ---->

<img width="621" height="809" alt="Screenshot 2026-02-22 at 5 13 19 PM" src="https://github.com/user-attachments/assets/4ddf0ade-b448-4fe4-b597-fe91a894bba9" />

<img width="277" height="204" alt="Screenshot 2026-02-22 at 5 13 37 PM" src="https://github.com/user-attachments/assets/60895380-6ebf-42c4-b71c-f7710f50e8e2" />

## Features

- **Discord Rich Presence** – When you're online on Insignia, Discord shows your current game and "Online as [username]".
- **xb.live integration** – Log in with your xb.live (Insignia) account. The app registers with the site and sends a heartbeat so the dashboard and cron update your status every 1–2 minutes.
- **Multiple xb.live accounts** – Add more than one account and switch the **active** account from a dropdown; presence and notifications follow the active login.
- **Any game** – Works with all Insignia games; presence uses the game name from your Insignia profile (e.g. "Xbox Live Dashboard", "Forza Motorsport").
- **Total play time** – When logged in, the app can show your total time played (from xb.live) in the Presence section.
- **Desktop notifications** (optional, system tray) – Uses your OS notification settings:
  - **Friends** – Alert when a friend comes online.
  - **Achievements** – Alert when you unlock a new achievement (requires the xb.live API to expose recent achievements for your session).
  - **Lobby / session** – Alert when a lobby or session goes up for games you pick (separate list from events).
  - **Scheduled events** – Remind you before site events for selected games; lead time is configurable (e.g. 5 or 30 minutes before).
  - **Quiet hours** – Only notify during time ranges you add (local time), or leave empty for all day.
  - **Poll interval** – How often the app refreshes notification-related data (1–15 minutes).
  - **Game lists** – Refresh the pick lists from the server; optional **“Only games I’ve played”** filter to narrow choices.
- **Updates** – **Check for updates** and **Download update** in Settings when your distribution provides an update server; the app may also notify you when a new version is available.
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
  → `dist/XBL Beacon-<version>-arm64.dmg` (Apple Silicon; version comes from `package.json`)

- **Windows (from macOS)**  
  `npm run build:win`  
  → `dist/XBL Beacon-Setup-<version>.exe` (64-bit NSIS installer)

- **Regenerate icons only**  
  `npm run generate-icons`  
  → Updates `assets/icon.ico` and `assets/icon.icns` from `icon.png`.

### macOS: “App is corrupted” or “damaged” when copying from the DMG

The built Mac app is **unsigned** (no Developer ID cert), so Gatekeeper may show “damaged” or “corrupted” when you copy it to Applications and try to open it. The app itself is fine.

- **Workaround:** After copying to Applications, **right‑click the app → Open** (first launch only), or in Terminal run:  
  `xattr -cr "/Applications/XBL Beacon.app"`

The build is configured to **sign** the app when a **Developer ID Application** certificate is in your keychain—run `npm run build:mac` to get a signed DMG. For notarization, set `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` before building. Without a certificate the build still succeeds but the app is unsigned (use the workaround above if Gatekeeper blocks it).

## How it works

1. You log in to **Discord** and **xb.live** in the app.
2. The app **registers** your session with xb.live (`/api/me/play-time-register`) so the site can track you.
3. Every **2 minutes** the app:
   - Calls **xb.live** `POST /api/me/profile-live` with your session key. The server fetches your live status from the auth service (same as the dashboard/cron).
   - Sends a **beacon ping** to xb.live so the play-time cron re-checks you every run.
   - Updates **Discord** presence with your current game and "Online as [username]", or clears it if you're offline.

4. The **xb.live dashboard** shows your online status and play time; with the beacon running, it can update within about 1–2 minutes of you going online or offline.

5. If you enable **notifications**, the app polls xb.live on the interval you set (friends list, lobby/session state, scheduled events, and—when the API supports it—recent achievements) and shows **system notifications** when something matches your toggles and game picks.

It can take up to about **10 minutes** for status to appear the first time after signing in; after that, updates run every 2 minutes.

## System tray

- **Click** tray icon – Show or hide the main window.
- **Right-click** – Menu: Show XBL Beacon or Quit.

## Settings

- **Start automatically when computer starts** – Enable in the app to launch at login (runs in the background).
- **Notifications** – Toggle friend, achievement, lobby/session, and event alerts; pick games separately for lobby alerts vs. event reminders; set quiet hours and how often data is refreshed. Allow notifications for XBL Beacon in macOS / Windows if prompts appear.
- **Updates** – See current **Version**, use **Check for updates**, and **Download update** when your release pipeline serves update metadata (otherwise checks may report no update).

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
| `main.js` | Main process: Discord RPC, profile via xb.live, beacon ping, tray, notifications poller IPC, optional update checks |
| `notifications.js` | Friend / lobby / event / achievement notification logic (loaded by main) |
| `preload.js` | Preload script for secure IPC |
| `renderer.js` | UI, login, multi-account switcher, presence, notifications settings, loading overlay |
| `index.html` | Main window |
| `scripts/generate-icons.js` | Build script: `icon.png` → `assets/icon.ico` and `assets/icon.icns` |
| `package.json` | Dependencies and electron-builder config |

## License

ISC.
