const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, Notification, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const Store = require('electron-store');
const { Client } = require('discord-rpc');
const { createNotificationPoller, httpsGetJson, httpsGetJsonWithHeaders } = require('./notifications');

// Human-readable name in OS UI (notification banner header, menu bar, etc.)
app.setName('XBL Beacon');
if (process.platform === 'win32') {
    // Avoid "electron.app.XBL.Beacon" on Windows toasts; match package.json build.appId
    app.setAppUserModelId('com.xbl.beacon');
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    app.quit();
    process.exit(0);
}

app.on('second-instance', () => {
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    }
});

const DEBUG = process.env.DEBUG === '1' || process.env.NODE_ENV === 'development';
function log(...args) { if (DEBUG) console.log(...args); }
function logWarn(...args) { if (DEBUG) console.warn(...args); }

// Keep-alive agents for connection reuse (fewer sockets, less CPU)
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 2 });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 2 });

// Node fetch (main process has no global fetch in Electron 22)
function nodeFetch(url, options = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const body = options.body ? Buffer.from(options.body, 'utf8') : null;
        const req = https.request({
            hostname: u.hostname,
            port: u.port || 443,
            path: u.pathname + u.search,
            method: options.method || 'GET',
            agent: httpsAgent,
            headers: {
                'Content-Type': 'application/json',
                ...(options.headers || {}),
                ...(body ? { 'Content-Length': body.length } : {})
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = data ? JSON.parse(data) : {};
                    resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json });
                } catch (e) {
                    resolve({ ok: false, status: res.statusCode, json: {} });
                }
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

// Fetch for update server (supports http or https, reuses connections)
function updateServerFetch(url, options = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const mod = u.protocol === 'https:' ? https : http;
        const agent = u.protocol === 'https:' ? httpsAgent : httpAgent;
        const body = options.body ? Buffer.from(options.body, 'utf8') : null;
        const req = mod.request({
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + u.search,
            method: options.method || 'GET',
            agent,
            headers: { 'Content-Type': 'application/json', ...(options.headers || {}), ...(body ? { 'Content-Length': body.length } : {}) }
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = data ? JSON.parse(data) : {};
                    resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json });
                } catch (e) {
                    resolve({ ok: false, status: res.statusCode, json: {} });
                }
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

const store = new Store();

/** Migrate legacy single-account keys into xbAccounts + activeXbAccountUsername */
function migrateXbAccountsLegacy() {
    if (store.get('xbAccounts') !== undefined) return;
    const session = store.get('insigniaSession');
    const user = store.get('insigniaUser');
    if (session && user && user.username) {
        store.set('xbAccounts', [{ username: user.username, email: user.email || '', sessionKey: session }]);
        store.set('activeXbAccountUsername', user.username);
    } else {
        store.set('xbAccounts', []);
    }
}

/** Active xb.live account (session + user) or null */
function getActiveXbAccount() {
    migrateXbAccountsLegacy();
    const accounts = store.get('xbAccounts', []);
    if (!accounts.length) return null;
    const activeUsername = store.get('activeXbAccountUsername');
    const acc = accounts.find((a) => a.username === activeUsername) || accounts[0];
    if (!acc || !acc.sessionKey) return null;
    return { username: acc.username, email: acc.email || '', sessionKey: acc.sessionKey };
}

function syncLegacyInsigniaKeysFromActive() {
    const acc = getActiveXbAccount();
    if (acc) {
        store.set('insigniaSession', acc.sessionKey);
        store.set('insigniaUser', { username: acc.username, email: acc.email });
    } else {
        store.delete('insigniaSession');
        store.delete('insigniaUser');
    }
}

/** Allowed values for “minutes before event” alert; keep in sync with notifications.js UI */
const NOTIFY_EVENT_LEAD_MINUTES = [3, 5, 10, 15, 30, 60, 90, 120];

function normalizeNotifyEventMinutesBefore(raw) {
    let n = parseInt(raw, 10);
    if (!Number.isFinite(n)) n = 5;
    if (NOTIFY_EVENT_LEAD_MINUTES.includes(n)) return n;
    return NOTIFY_EVENT_LEAD_MINUTES.reduce(
        (best, x) => (Math.abs(x - n) < Math.abs(best - n) ? x : best),
        5
    );
}

/** Split legacy notifyGameNames into lobby/event lists + explicit lobby toggle */
function migrateNotificationSettingsV2() {
    if (store.get('_notifySettingsV2')) return;
    const legacy = store.get('notifyGameNames', []) || [];
    if (store.get('notifyLobbyGameNames') == null) {
        store.set('notifyLobbyGameNames', [...legacy]);
    }
    if (store.get('notifyEventGameNames') == null) {
        store.set('notifyEventGameNames', [...legacy]);
    }
    if (store.get('notifyLobbyAlerts') == null) {
        store.set('notifyLobbyAlerts', legacy.length > 0);
    }
    if (store.get('notifyEventMinutesBefore') == null) {
        store.set('notifyEventMinutesBefore', 5);
    }
    store.set('_notifySettingsV2', true);
}

const DISCORD_CLIENT_ID = '1451762829303742555';
const AUTH_API_URL = process.env.AUTH_API_URL || 'https://auth.insigniastats.live/api';
const XBL_SITE_URL = process.env.XBL_SITE_URL || 'https://xb.live';
const CHECK_INTERVAL_ACTIVE = 120000;   // 2 min when user is online
const CHECK_INTERVAL_IDLE = 300000;     // 5 min when user is offline
const UPDATE_CHECK_INTERVAL = 86400000; // 24 h
// Update/status go to the same site backend as the rest of the app (e.g. xb.live/api/...)
const UPDATE_SERVER_URL = process.env.UPDATE_SERVER_URL || XBL_SITE_URL;

let notificationPoller = null;
function restartNotificationPoller() {
    migrateNotificationSettingsV2();
    if (!notificationPoller) {
        notificationPoller = createNotificationPoller({
            store,
            getSessionKey: () => getActiveXbAccount()?.sessionKey,
            getActiveUsername: () => getActiveXbAccount()?.username || '',
            Notification,
            log,
            XBL_SITE_URL,
            AUTH_API_URL
        });
    }
    notificationPoller.restart();
}

/** Windows tray: status lines mirroring Insignia Menubar popover (games + friends + Discord). */
function friendDisplayNameForTray(f) {
    return String(f.gamertag || f.username || f.name || '').trim() || '—';
}

function friendIsOnlineForTray(f) {
    return f.isOnline === true || f.online === true || f.isCurrentlyOnline === true;
}

function formatGameLineForTray(game) {
    const name = game.name || '';
    const online = game.online ?? 0;
    const lobbies = game.activeLobbies ?? 0;
    const sessions = game.sessionCount ?? 0;
    let title = `${name}: ${online} online`;
    if (lobbies > 0 || sessions > 0) {
        const lobbyStr = lobbies === 1 ? '1 lobby' : `${lobbies} lobbies`;
        const sessionStr = sessions === 1 ? '1 session' : `${sessions} sessions`;
        const parts = [];
        if (lobbies > 0) parts.push(lobbyStr);
        if (sessions > 0) parts.push(sessionStr);
        title += ` · ${parts.join(', ')}`;
    }
    return title;
}

function formatOnlineFriendLineForTray(f) {
    const g = f.game ? ` · ${f.game}` : '';
    const d = f.duration ? ` (${f.duration})` : '';
    return `${friendDisplayNameForTray(f)} – Online${g}${d}`;
}

function buildGameUrlForTray(game) {
    const tid = game.titleId && String(game.titleId).trim();
    if (tid) {
        return `${XBL_SITE_URL}/game?titleId=${encodeURIComponent(tid)}`;
    }
    const enc = encodeURIComponent(game.name || '');
    return `${XBL_SITE_URL}/game/${enc}`;
}

function buildDiscordTrayLineFromStore() {
    const discordUser = store.get('discordUser');
    const presenceActive = store.get('presenceActive');
    const lastGameName = store.get('lastGameName');
    if (discordUser) {
        const pres = presenceActive ? 'Online' : 'Offline';
        if (presenceActive && lastGameName) {
            return `Discord: Connected · ${pres} · Playing ${lastGameName}`;
        }
        if (presenceActive) return `Discord: Connected · ${pres} · OG Xbox`;
        return `Discord: Connected · ${pres}`;
    }
    return 'Discord: Not connected';
}

async function fetchWindowsTrayStatusData() {
    const users = await httpsGetJson(`${XBL_SITE_URL}/api/online-users`);
    const acc = getActiveXbAccount();
    const loggedIn = !!(acc && acc.sessionKey);
    let onlineFriends = [];
    if (loggedIn) {
        const fr = await httpsGetJsonWithHeaders(`${AUTH_API_URL}/auth/friends`, {
            'X-Session-Key': acc.sessionKey
        });
        const list = (fr && fr.friends) || [];
        onlineFriends = list.filter((f) => friendIsOnlineForTray(f));
    }
    let games = [];
    if (users && typeof users === 'object' && !Array.isArray(users)) {
        games = Object.values(users)
            .filter((g) => {
                const online = g.online || 0;
                const lobbies = g.activeLobbies ?? 0;
                const sess = g.hasActiveSession === true;
                return online > 0 || lobbies > 0 || sess;
            })
            .sort((a, b) =>
                String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' })
            );
    }
    return { games, onlineFriends, loggedIn };
}

async function showWindowsTrayStatusMenu() {
    if (!tray) return;
    let games = [];
    let onlineFriends = [];
    let loggedIn = false;
    let fetchError = null;
    try {
        const data = await fetchWindowsTrayStatusData();
        games = data.games;
        onlineFriends = data.onlineFriends;
        loggedIn = data.loggedIn;
    } catch (e) {
        fetchError = e.message || String(e);
    }
    const template = [];
    if (fetchError) {
        const msg = fetchError.length > 100 ? `${fetchError.slice(0, 97)}…` : fetchError;
        template.push({ label: `Could not load: ${msg}`, enabled: false });
        template.push({ type: 'separator' });
    }
    template.push({ label: 'Games online', enabled: false });
    if (games.length === 0) {
        template.push({ label: 'No games with active players', enabled: false });
    } else {
        games.forEach((g) => {
            const label = formatGameLineForTray(g).slice(0, 250);
            const url = buildGameUrlForTray(g);
            template.push({
                label,
                click: () => {
                    shell.openExternal(url);
                }
            });
        });
    }
    template.push({ type: 'separator' });
    template.push({ label: 'Friends online', enabled: false });
    if (!loggedIn) {
        template.push({ label: 'Log in in the app to see friends', enabled: false });
    } else if (onlineFriends.length === 0) {
        template.push({ label: 'No friends online', enabled: false });
    } else {
        onlineFriends.forEach((f) => {
            template.push({ label: formatOnlineFriendLineForTray(f).slice(0, 250), enabled: false });
        });
    }
    template.push({ type: 'separator' });
    template.push({ label: buildDiscordTrayLineFromStore().slice(0, 250), enabled: false });
    template.push({ type: 'separator' });
    template.push({
        label: 'Show XBL Beacon',
        click: () => {
            if (mainWindow) mainWindow.show();
        }
    });
    template.push({
        label: 'Quit',
        click: () => {
            isQuitting = true;
            app.quit();
        }
    });
    const menu = Menu.buildFromTemplate(template);
    tray.popUpContextMenu(menu);
}

let mainWindow = null;
let tray = null;
let isQuitting = false;
let discordRPC = null;
let checkTimeout = null;
let checkingActive = false;
let lastPlayTimeEnrollmentCheckAt = 0;
let lastPlayTimeEnrollmentDialogAt = 0;

// Only send to renderer when window is visible (saves CPU when minimized to tray)
function sendToRenderer(channel, ...args) {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
        mainWindow.webContents.send(channel, ...args);
    }
}

// Create main window
function createWindow() {
    // Load icon using nativeImage for better compatibility
    const fs = require('fs');
    let windowIcon;
    
    try {
        // Always try root icon.png first (the actual PGR logo)
        let iconPath = path.join(__dirname, 'icon.png');
        
        // Platform-specific fallbacks
        if (!fs.existsSync(iconPath)) {
            if (process.platform === 'win32') {
                iconPath = path.join(__dirname, 'assets', 'icon.ico');
            } else if (process.platform === 'darwin') {
                iconPath = path.join(__dirname, 'assets', 'icon.icns');
                if (!fs.existsSync(iconPath)) {
                    iconPath = path.join(__dirname, 'assets', 'icon.png');
                }
            } else {
                iconPath = path.join(__dirname, 'assets', 'icon.png');
            }
        }
        
        if (fs.existsSync(iconPath)) {
            // Prefer path (no buffer copy in memory); fall back to buffer if empty
            windowIcon = nativeImage.createFromPath(iconPath);
            if (windowIcon.isEmpty()) {
                try {
                    const iconBuffer = fs.readFileSync(iconPath);
                    windowIcon = nativeImage.createFromBuffer(iconBuffer);
                } catch (e) {
                    windowIcon = nativeImage.createFromPath(iconPath);
                }
            }
            if (windowIcon.isEmpty() && iconPath !== path.join(__dirname, 'icon.png')) {
                const rootIcon = path.join(__dirname, 'icon.png');
                if (fs.existsSync(rootIcon)) windowIcon = nativeImage.createFromPath(rootIcon);
            }
            
            if (!windowIcon.isEmpty()) {
                log('Loaded window icon from:', iconPath);
            } else {
                logWarn('Window icon is empty after loading');
            }
        } else {
            logWarn('Window icon not found at:', iconPath);
        }
    } catch (error) {
        logWarn('Error loading window icon:', error.message);
    }
    
    mainWindow = new BrowserWindow({
        width: 500,
        height: 600,
        show: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
            backgroundThrottling: true
        },
        icon: windowIcon && !windowIcon.isEmpty() ? windowIcon : undefined,
        title: 'XBL Beacon',
        autoHideMenuBar: true
    });

    mainWindow.once('ready-to-show', () => { mainWindow.show(); });
    mainWindow.loadFile('index.html');

    // When user reopens window, push current state so UI is up to date (no extra polling)
    mainWindow.on('show', () => {
        const active = store.get('presenceActive', false);
        if (active) {
            sendToRenderer('presence-updated', {
                active: true,
                lastCheck: store.get('lastCheck'),
                gameName: store.get('lastGameName')
            });
        } else {
            sendToRenderer('presence-updated', { active: false });
        }
        if (getActiveXbAccount()) {
            const totalMinutes = store.get('totalPlayTimeMinutes', 0);
            sendToRenderer('play-time-updated', { totalMinutes });
        }
    });

    // Handle window close
    mainWindow.on('close', (event) => {
        if (!isQuitting) {
            event.preventDefault();
            mainWindow.hide();
            
            // Show notification on first minimize (only on macOS)
            if (process.platform === 'darwin' && !store.get('hasMinimizedBefore')) {
                mainWindow.show();
                store.set('hasMinimizedBefore', true);
            }
        }
    });

    // Create system tray
    createTray();
}

// Create system tray icon
function createTray() {
    const fs = require('fs');
    let icon;
    
    try {
        // Try root icon.png first (the actual PGR logo), then fallback to assets/icon.png
        let iconPath = path.join(__dirname, 'icon.png');
        if (!fs.existsSync(iconPath)) {
            iconPath = path.join(__dirname, 'assets', 'icon.png');
        }
        
        if (fs.existsSync(iconPath)) {
            icon = nativeImage.createFromPath(iconPath);
            if (icon.isEmpty()) {
                const iconBuffer = fs.readFileSync(iconPath);
                icon = nativeImage.createFromBuffer(iconBuffer);
            }
            if (icon.isEmpty()) {
                logWarn('Icon at', iconPath, 'is empty');
                throw new Error('Icon is empty');
            }
            log('Loaded tray icon from:', iconPath);
            
            // Don't use template mode - it causes black icons
            // Template mode is only for monochrome icons with alpha channel
        } else {
            throw new Error(`Icon file not found at ${iconPath}`);
        }
    } catch (error) {
        console.error('Could not load tray icon:', error.message);
        console.error('Stack:', error.stack);
        icon = nativeImage.createEmpty();
    }
    
    // Create tray with icon
    if (icon && !icon.isEmpty()) {
        // For macOS, try using the icon at native size first (macOS handles scaling well)
        // Only resize if absolutely necessary
        const iconSize = icon.getSize();
        let trayIcon = icon;
        
        // macOS can handle larger icons, but very large ones might cause issues
        if (iconSize.width > 64 || iconSize.height > 64) {
            const size = process.platform === 'darwin' ? 22 : 16;
            trayIcon = icon.resize({ width: size, height: size });
            if (trayIcon.isEmpty()) trayIcon = icon;
        }
        tray = new Tray(trayIcon);
    } else {
        logWarn('Tray icon empty, using default');
        const emptyIcon = nativeImage.createEmpty();
        tray = new Tray(emptyIcon);
    }
    
    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Show XBL Beacon',
            click: () => {
                if (mainWindow) {
                    mainWindow.show();
                }
            }
        },
        {
            label: 'Quit',
            click: () => {
                isQuitting = true;
                app.quit();
            }
        }
    ]);
    
    tray.setToolTip('XBL Beacon - Discord presence for xb.live');

    if (process.platform === 'win32') {
        // Like Insignia Menubar’s status popover: left-click shows games + friends + Discord; game rows open xb.live.
        tray.setContextMenu(null);
        tray.on('click', () => {
            showWindowsTrayStatusMenu().catch((e) => logWarn('Windows tray menu:', e.message));
        });
        tray.on('right-click', () => {
            tray.popUpContextMenu(contextMenu);
        });
    } else {
        tray.setContextMenu(contextMenu);
        tray.on('click', () => {
            if (mainWindow) {
                if (mainWindow.isVisible()) {
                    mainWindow.hide();
                } else {
                    mainWindow.show();
                }
            }
        });
    }
}

// Handle app ready
app.whenReady().then(() => {
    // Set app icon on macOS (dock icon) before creating window
    if (process.platform === 'darwin') {
        const fs = require('fs');
        // Try root icon.png first (the actual PGR logo), then assets/icon.png
        let iconPath = path.join(__dirname, 'icon.png');
        if (!fs.existsSync(iconPath)) {
            iconPath = path.join(__dirname, 'assets', 'icon.png');
        }
        
        if (fs.existsSync(iconPath)) {
            try {
                const dockIcon = nativeImage.createFromPath(iconPath);
                if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon);
                else logWarn('Dock icon empty');
            } catch (error) {
                logWarn('Could not set dock icon:', error.message);
            }
        } else {
            logWarn('Dock icon not found:', iconPath);
        }
    }
    
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        } else if (mainWindow) {
            mainWindow.show();
        }
    });
});

// Handle all windows closed
app.on('window-all-closed', () => {
    // Don't quit on macOS - keep running in background
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// Handle before quit
app.on('before-quit', () => {
    isQuitting = true;
});

// IPC handlers
ipcMain.handle('get-store-value', (event, key) => {
    return store.get(key);
});

ipcMain.handle('set-store-value', (event, key, value) => {
    store.set(key, value);
});

ipcMain.handle('delete-store-value', (event, key) => {
    store.delete(key);
});

// Auto-start functionality
app.setLoginItemSettings({
    openAtLogin: store.get('autoStart', false),
    openAsHidden: true
});

ipcMain.handle('set-auto-start', (event, enabled) => {
    app.setLoginItemSettings({
        openAtLogin: enabled,
        openAsHidden: true
    });
    store.set('autoStart', enabled);
    return enabled;
});

ipcMain.handle('get-auto-start', () => {
    return store.get('autoStart', false);
});

// Discord RPC handlers
ipcMain.handle('init-discord-rpc', async () => {
    try {
        if (discordRPC && discordRPC.user) {
            return { 
                success: true, 
                user: {
                    username: discordRPC.user.username || 'Unknown',
                    id: discordRPC.user.id || 'Unknown'
                }
            };
        }

        // Destroy existing connection if any
        if (discordRPC) {
            try {
                await discordRPC.destroy();
            } catch (e) {
                // Ignore errors when destroying
            }
            discordRPC = null;
        }

        discordRPC = new Client({ transport: 'ipc' });

        // Set up event handlers (shared function)
        setupDiscordRPCEventHandlers();

        await discordRPC.login({ clientId: DISCORD_CLIENT_ID });
        
        // Wait a bit for user info to be available
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        if (discordRPC.user) {
            return { 
                success: true, 
                user: {
                    username: discordRPC.user.username || 'Unknown',
                    id: discordRPC.user.id || 'Unknown'
                }
            };
        } else {
            // If user info not available yet, return success but with placeholder
            return { 
                success: true, 
                user: {
                    username: 'Connected',
                    id: 'Unknown'
                }
            };
        }
    } catch (error) {
        console.error('Failed to initialize Discord RPC:', error);
        // Check if it's because Discord isn't running
        if (error.message && error.message.includes('ENOENT')) {
            return { 
                success: false, 
                error: 'Discord is not running. Please start Discord and try again.' 
            };
        }
        return { success: false, error: error.message || 'Failed to connect to Discord' };
    }
});

ipcMain.handle('disconnect-discord-rpc', async () => {
    if (discordRPC) {
        try {
            await discordRPC.clearActivity();
            await discordRPC.destroy();
        } catch (error) {
            console.error('Error destroying Discord RPC:', error);
        }
        discordRPC = null;
    }
    stopChecking();
});

ipcMain.handle('update-discord-presence', async (event, presence) => {
    if (!discordRPC || !discordRPC.user) {
        return { success: false, error: 'Discord RPC not connected' };
    }

    try {
        await discordRPC.setActivity(presence);
        return { success: true };
    } catch (error) {
        console.error('Error updating Discord presence:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('clear-discord-presence', async () => {
    if (discordRPC && discordRPC.user) {
        try {
            await discordRPC.clearActivity();
        } catch (error) {
            console.error('Error clearing Discord presence:', error);
        }
    }
});

// Get total play time from xb.live (same API as Insignia stats server: GET /api/me/play-time)
async function getPlayTime(username, sessionKey) {
    if (!username) return { totalMinutes: 0, byGame: {}, lastState: 'offline', currentGame: null };
    try {
        const url = `${XBL_SITE_URL}/api/me/play-time?username=${encodeURIComponent(username)}`;
        const opts = { method: 'GET' };
        if (sessionKey) opts.headers = { 'X-Session-Key': sessionKey };
        const res = await nodeFetch(url, opts);
        if (!res.ok) return { totalMinutes: 0, byGame: {}, lastState: 'offline', currentGame: null };
        const data = res.json || {};
        return {
            totalMinutes: data.totalMinutes || 0,
            byGame: data.byGame || {},
            lastState: data.lastState || 'offline',
            currentGame: data.currentGame || null
        };
    } catch (e) {
        logWarn('play-time fetch failed:', e.message);
        return { totalMinutes: 0, byGame: {}, lastState: 'offline', currentGame: null };
    }
}

const PLAY_TIME_ENROLLMENT_CHECK_INTERVAL_MS = 15 * 60 * 1000;
const PLAY_TIME_ENROLLMENT_DIALOG_COOLDOWN_MS = 45 * 60 * 1000;

/** Called while Discord + xb.live checking runs: ensures play-time row exists on xb.live; nudges user if reauth needed. */
async function verifyPlayTimeEnrollmentIfDue() {
    const acc = getActiveXbAccount();
    if (!acc || !acc.username || !acc.sessionKey) return;
    if (!store.get('discordUser')) return;

    const now = Date.now();
    if (now - lastPlayTimeEnrollmentCheckAt < PLAY_TIME_ENROLLMENT_CHECK_INTERVAL_MS) return;
    lastPlayTimeEnrollmentCheckAt = now;

    const url = `${XBL_SITE_URL}/api/me/play-time?username=${encodeURIComponent(acc.username)}`;
    let res;
    try {
        res = await nodeFetch(url, {
            method: 'GET',
            headers: { 'X-Session-Key': acc.sessionKey }
        });
    } catch (e) {
        return;
    }
    if (!res.ok) return;

    const j = res.json || {};
    const explicitlyNotRegistered = j.playTimeRegistered === false;
    const reauth = !!j.reauthRequired;

    if (explicitlyNotRegistered) {
        try {
            const reg = await nodeFetch(`${XBL_SITE_URL}/api/me/play-time-register`, {
                method: 'POST',
                body: JSON.stringify({ sessionKey: acc.sessionKey })
            });
            if (reg.ok) {
                log('play-time enrollment restored via play-time-register');
                return;
            }
        } catch (e) {
            logWarn('play-time-register retry failed:', e.message);
        }
    }

    if (!reauth && !explicitlyNotRegistered) return;

    if (now - lastPlayTimeEnrollmentDialogAt < PLAY_TIME_ENROLLMENT_DIALOG_COOLDOWN_MS) return;
    lastPlayTimeEnrollmentDialogAt = now;

    const detail = reauth
        ? 'xb.live needs a fresh sign-in for play time sync. In XBL Beacon, log out of xb.live, then log in again so tracking stays enabled.'
        : 'Play time is not registered for your account on xb.live. Log out and sign in again in this app (or use the site dashboard).';

    try {
        await dialog.showMessageBox(
            mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
            {
                type: 'warning',
                title: 'Play time tracking',
                message: 'Play time tracking needs to be re-enabled',
                detail,
                buttons: ['OK']
            }
        );
    } catch (e) {}
}

// Get presence from xb.live server (server calls auth refresh - same path as cron, so we get same result)
async function getPresenceFromAuth(sessionKey) {
    try {
        const res = await nodeFetch(`${XBL_SITE_URL}/api/me/profile-live`, {
            method: 'POST',
            body: JSON.stringify({ sessionKey })
        });
        if (!res.ok) {
            logWarn('profile-live returned', res.status, (res.json && res.json.error) || '');
            return { isOnline: false, gameName: null };
        }
        const profile = res.json || {};
        const isOnline = !!profile.isOnline;
        const gameName = (profile.game && String(profile.game).trim()) ? String(profile.game).trim() : null;
        log('profile-live OK -> online=', isOnline, 'game=', gameName || 'none');
        return { isOnline, gameName };
    } catch (e) {
        console.error('profile-live failed:', e.message);
        return { isOnline: false, gameName: null };
    }
}

async function checkAndUpdatePresence() {
    try {
        const discordUser = store.get('discordUser');
        const insigniaUser = getActiveXbAccount();
        const insigniaSession = insigniaUser && insigniaUser.sessionKey;

        if (!discordUser || !insigniaSession || !insigniaUser) {
            await clearPresence();
            return;
        }

        const username = insigniaUser.username;
        if (!username) {
            log('No username in active xb account:', insigniaUser);
            await clearPresence();
            return;
        }

        log('Checking presence for', username);
        const { isOnline, gameName } = await getPresenceFromAuth(insigniaSession);
        log('User online:', isOnline, 'game:', gameName || 'none');

        // Ping server so cron re-checks this user every run (dashboard updates within ~1–2 min)
        try {
            nodeFetch(`${XBL_SITE_URL}/api/me/play-time-beacon-ping`, {
                method: 'POST',
                body: JSON.stringify({ sessionKey: insigniaSession })
            }).catch(() => {});
        } catch (e) {}

        verifyPlayTimeEnrollmentIfDue().catch(() => {});

        const wasOnline = store.get('presenceActive', false);
        
        if (isOnline) {
            const shouldSetNewTimestamp = !wasOnline;
            await updatePresence(username, gameName, shouldSetNewTimestamp);
            // Fetch play time in background so we don't delay scheduling the next check
            getPlayTime(username, insigniaSession).then((playTime) => {
                store.set('totalPlayTimeMinutes', playTime.totalMinutes);
                sendToRenderer('play-time-updated', { totalMinutes: playTime.totalMinutes });
            }).catch(() => {});
        } else {
            if (mainWindow) {
                sendToRenderer('presence-updated', {
                    active: false,
                    lastCheckResult: 'offline',
                    gameName: null
                });
            }
            await clearPresence(true);
        }

        scheduleNextCheck();
    } catch (error) {
        console.error('Error checking presence:', error);
        if (mainWindow) {
            sendToRenderer('presence-updated', {
                active: false,
                lastCheckResult: 'error',
                error: error.message
            });
        }
        await clearPresence(true);
        scheduleNextCheck();
    }
}

function scheduleNextCheck() {
    if (!checkingActive || checkTimeout) return;
    const interval = store.get('presenceActive', false) ? CHECK_INTERVAL_ACTIVE : CHECK_INTERVAL_IDLE;
    checkTimeout = setTimeout(() => {
        checkTimeout = null;
        if (checkingActive) checkAndUpdatePresence();
    }, interval);
}

async function updatePresence(username, gameName, setNewTimestamp = false) {
    if (!discordRPC || !discordRPC.user) {
        return;
    }

    try {
        let startTimestamp = store.get('presenceStartTimestamp');
        
        if (setNewTimestamp || !startTimestamp) {
            startTimestamp = Date.now();
            store.set('presenceStartTimestamp', startTimestamp);
            log('Setting new presence timestamp:', new Date(startTimestamp).toISOString());
        } else {
            log('Keeping existing presence timestamp:', new Date(startTimestamp).toISOString());
        }

        const gameDisplay = gameName && gameName.trim() ? gameName.trim() : 'OG Xbox';
        const presence = {
            details: gameName ? `Playing ${gameName}` : 'Online on xb.live',
            state: `Online as ${username}`,
            startTimestamp: startTimestamp,
            largeImageKey: 'logo',
            largeImageText: gameDisplay,
            smallImageKey: 'online',
            smallImageText: 'xb.live'
        };

        await discordRPC.setActivity(presence);
        store.set('presenceActive', true);
        store.set('lastCheck', new Date().toISOString());
        store.set('lastGameName', gameName);
        
        if (mainWindow) {
            sendToRenderer('presence-updated', {
                active: true,
                lastCheck: new Date().toISOString(),
                gameName: gameName || null
            });
        }
    } catch (error) {
        console.error('Error updating Discord presence:', error);
    }
}

async function clearPresence(skipNotify = false) {
    if (discordRPC && discordRPC.user) {
        try {
            await discordRPC.clearActivity();
        } catch (error) {
            console.error('Error clearing Discord presence:', error);
        }
    }
    
    store.set('presenceActive', false);
    store.delete('presenceStartTimestamp');
    
    if (!skipNotify && mainWindow) {
        sendToRenderer('presence-updated', { active: false });
    }
}

function startChecking() {
    if (checkTimeout) clearTimeout(checkTimeout);
    checkTimeout = null;
    checkingActive = true;
    checkAndUpdatePresence();
}

function stopChecking() {
    checkingActive = false;
    if (checkTimeout) {
        clearTimeout(checkTimeout);
        checkTimeout = null;
    }
    clearPresence();
}

ipcMain.handle('start-checking', () => {
    startChecking();
});

// Register session with xbl.live for play-time tracking (so site + cron show user online/game)
ipcMain.handle('register-with-xbl', async (event, sessionKey) => {
    if (!sessionKey) return { ok: false };
    try {
        const res = await nodeFetch(`${XBL_SITE_URL}/api/me/play-time-register`, {
            method: 'POST',
            body: JSON.stringify({ sessionKey })
        });
        if (!res.ok) {
            logWarn('xbl.live play-time-register failed:', res.status, (res.json && res.json.error) || '');
            return { ok: false, status: res.status };
        }
        return { ok: true };
    } catch (e) {
        logWarn('xbl.live play-time-register error:', e.message);
        return { ok: false };
    }
});

ipcMain.handle('stop-checking', () => {
    stopChecking();
});

// --- Update & status (transparent: version check, download, optional status report) ---
const currentVersion = app.getVersion();
let updateCheckTimeout = null;

async function checkForUpdates() {
    try {
        const base = UPDATE_SERVER_URL.replace(/\/$/, '');
        const res = await updateServerFetch(`${base}/api/update/check?version=${encodeURIComponent(currentVersion)}&platform=${process.platform}`);
        if (!res.ok) return { updateAvailable: false };
        const { updateAvailable, version, url, sha256, notes } = res.json || {};
        if (!updateAvailable || !url) return { updateAvailable: false };
        return { updateAvailable: true, version, url, sha256: sha256 || null, notes: notes || null };
    } catch (e) {
        logWarn('Update check failed:', e.message);
        return { updateAvailable: false, error: e.message };
    }
}

function reportStatus() {
    const base = UPDATE_SERVER_URL.replace(/\/$/, '');
    const payload = {
        version: currentVersion,
        platform: process.platform,
        arch: process.arch,
        lastCheck: store.get('lastCheck') || null
    };
    updateServerFetch(`${base}/api/status`, { method: 'POST', body: JSON.stringify(payload) }).catch(() => {});
}

async function downloadAndInstallUpdate(url, expectedSha256) {
    const tmpDir = app.getPath('temp');
    const filename = path.basename(new URL(url).pathname) || `XBL-Beacon-${currentVersion}.dmg`;
    const destPath = path.join(tmpDir, filename);
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const file = fs.createWriteStream(destPath);
        const hash = expectedSha256 ? crypto.createHash('sha256') : null;
        mod.get(url, (res) => {
            if (res.statusCode !== 200) {
                fs.unlink(destPath, () => {});
                return reject(new Error(`Download failed: ${res.statusCode}`));
            }
            res.pipe(file);
            if (hash) res.on('data', chunk => hash.update(chunk));
            file.on('finish', () => {
                file.close(() => {
                    if (hash && expectedSha256) {
                        const actual = hash.digest('hex');
                        if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
                            fs.unlink(destPath, () => {});
                            return reject(new Error('Hash mismatch'));
                        }
                    }
                    shell.openPath(destPath).then(() => {
                        isQuitting = true;
                        app.quit();
                    });
                    resolve({ path: destPath });
                });
            });
        }).on('error', (e) => {
            fs.unlink(destPath, () => {});
            reject(e);
        });
    });
}

function notifyUserUpdateAvailable(result) {
    if (!result || !result.updateAvailable || !result.version) return;
    if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
        sendToRenderer('update-available', result);
    }
    if (Notification.isSupported()) {
        const n = new Notification({
            title: 'XBL Beacon — Update available',
            body: `Version ${result.version} is available. Open the app to download and install.`
        });
        n.on('click', () => {
            if (mainWindow) {
                mainWindow.show();
                mainWindow.focus();
            }
        });
        n.show();
    }
}

function scheduleUpdateCheck() {
    if (updateCheckTimeout) clearTimeout(updateCheckTimeout);
    updateCheckTimeout = setTimeout(() => {
        updateCheckTimeout = null;
        checkForUpdates().then(result => {
            if (result.updateAvailable) notifyUserUpdateAvailable(result);
        });
        scheduleUpdateCheck();
    }, UPDATE_CHECK_INTERVAL);
}

ipcMain.handle('get-app-version', () => currentVersion);
ipcMain.handle('check-for-updates', () => checkForUpdates());
ipcMain.handle('download-and-install-update', (event, { url, sha256 }) => downloadAndInstallUpdate(url, sha256));

ipcMain.handle('get-play-time', async () => {
    const acc = getActiveXbAccount();
    if (!acc || !acc.username) return { totalMinutes: 0, byGame: {} };
    // Only call the API when user is online; otherwise return cached value
    if (!store.get('presenceActive', false)) {
        return { totalMinutes: store.get('totalPlayTimeMinutes', 0), byGame: {} };
    }
    const data = await getPlayTime(acc.username, acc.sessionKey);
    store.set('totalPlayTimeMinutes', data.totalMinutes);
    return { totalMinutes: data.totalMinutes, byGame: {} };
});

ipcMain.handle('upsert-xb-account', (event, payload) => {
    const { username, email, sessionKey } = payload || {};
    if (!username || !sessionKey) return { ok: false };
    migrateXbAccountsLegacy();
    const accounts = [...store.get('xbAccounts', [])];
    const i = accounts.findIndex((a) => a.username === username);
    const entry = { username, email: email || '', sessionKey };
    if (i >= 0) accounts[i] = entry;
    else accounts.push(entry);
    store.set('xbAccounts', accounts);
    store.set('activeXbAccountUsername', username);
    syncLegacyInsigniaKeysFromActive();
    restartNotificationPoller();
    return { ok: true };
});

ipcMain.handle('get-xb-accounts-state', () => {
    migrateXbAccountsLegacy();
    const accounts = store.get('xbAccounts', []);
    return {
        accounts: accounts.map((a) => ({ username: a.username, email: a.email || '' })),
        activeUsername: store.get('activeXbAccountUsername') || (accounts[0] && accounts[0].username) || null
    };
});

ipcMain.handle('switch-xb-account', async (event, username) => {
    migrateXbAccountsLegacy();
    const accounts = store.get('xbAccounts', []);
    if (!accounts.find((a) => a.username === username)) return { ok: false };
    store.set('activeXbAccountUsername', username);
    syncLegacyInsigniaKeysFromActive();
    const acc = getActiveXbAccount();
    if (acc && acc.sessionKey) {
        try {
            await nodeFetch(`${XBL_SITE_URL}/api/me/play-time-register`, {
                method: 'POST',
                body: JSON.stringify({ sessionKey: acc.sessionKey })
            });
        } catch (e) {}
    }
    stopChecking();
    if (store.get('discordUser')) startChecking();
    restartNotificationPoller();
    return { ok: true };
});

ipcMain.handle('logout-active-xb-account', async () => {
    const acc = getActiveXbAccount();
    if (!acc) return { ok: false, remaining: 0 };
    try {
        await nodeFetch(`${AUTH_API_URL}/auth/logout`, {
            method: 'POST',
            body: JSON.stringify({ sessionKey: acc.sessionKey })
        });
    } catch (e) {}
    const accounts = store.get('xbAccounts', []).filter((a) => a.username !== acc.username);
    store.set('xbAccounts', accounts);
    if (accounts.length === 0) {
        store.delete('activeXbAccountUsername');
        store.delete('insigniaSession');
        store.delete('insigniaUser');
        stopChecking();
        restartNotificationPoller();
        return { ok: true, remaining: 0 };
    }
    store.set('activeXbAccountUsername', accounts[0].username);
    syncLegacyInsigniaKeysFromActive();
    stopChecking();
    if (store.get('discordUser')) startChecking();
    restartNotificationPoller();
    return { ok: true, remaining: accounts.length };
});

// Start checking if both logins exist; schedule update check and report status
app.whenReady().then(() => {
    migrateXbAccountsLegacy();
    const discordUser = store.get('discordUser');
    const acc = getActiveXbAccount();
    
    if (discordUser && acc && acc.sessionKey) {
        setTimeout(async () => {
            await initDiscordRPC();
            startChecking();
        }, 2000);
    }
    // Single deferred run: update check + status + one-time play time on start (if logged in)
    setTimeout(() => {
        checkForUpdates().then(result => {
            if (result.updateAvailable) notifyUserUpdateAvailable(result);
        });
        reportStatus();
        const accStart = getActiveXbAccount();
        if (accStart && accStart.username && accStart.sessionKey) {
            getPlayTime(accStart.username, accStart.sessionKey).then((playTime) => {
                store.set('totalPlayTimeMinutes', playTime.totalMinutes);
                sendToRenderer('play-time-updated', { totalMinutes: playTime.totalMinutes });
            }).catch(() => {});
        }
    }, 8000);
    scheduleUpdateCheck();
    restartNotificationPoller();
});

ipcMain.handle('get-notification-settings', () => {
    migrateNotificationSettingsV2();
    return {
        notifyFriendsOnline: store.get('notifyFriendsOnline') !== false,
        notifyLobbyAlerts: store.get('notifyLobbyAlerts') === true,
        notifyEvents: store.get('notifyEvents') === true,
        notifyLobbyGameNames: store.get('notifyLobbyGameNames', []) || [],
        notifyEventGameNames: store.get('notifyEventGameNames', []) || [],
        notifyEventMinutesBefore: normalizeNotifyEventMinutesBefore(store.get('notifyEventMinutesBefore', 5)),
        notifyTimeRanges: store.get('notifyTimeRanges', []) || [],
        notifyPollIntervalMinutes: Math.max(1, store.get('notifyPollIntervalMinutes', 5) || 5),
        notifyEventLeadOptions: NOTIFY_EVENT_LEAD_MINUTES,
        notifyAchievements: store.get('notifyAchievements') === true
    };
});

ipcMain.handle('set-notification-settings', (event, patch) => {
    migrateNotificationSettingsV2();
    if (patch.notifyFriendsOnline !== undefined) store.set('notifyFriendsOnline', !!patch.notifyFriendsOnline);
    if (patch.notifyLobbyAlerts !== undefined) store.set('notifyLobbyAlerts', !!patch.notifyLobbyAlerts);
    if (patch.notifyEvents !== undefined) store.set('notifyEvents', !!patch.notifyEvents);
    if (patch.notifyLobbyGameNames !== undefined) store.set('notifyLobbyGameNames', patch.notifyLobbyGameNames);
    if (patch.notifyEventGameNames !== undefined) store.set('notifyEventGameNames', patch.notifyEventGameNames);
    if (patch.notifyGameNames !== undefined) {
        store.set('notifyLobbyGameNames', patch.notifyGameNames);
        store.set('notifyEventGameNames', patch.notifyGameNames);
    }
    if (patch.notifyEventMinutesBefore !== undefined) {
        store.set('notifyEventMinutesBefore', normalizeNotifyEventMinutesBefore(patch.notifyEventMinutesBefore));
    }
    if (patch.notifyTimeRanges !== undefined) store.set('notifyTimeRanges', patch.notifyTimeRanges);
    if (patch.notifyPollIntervalMinutes !== undefined) store.set('notifyPollIntervalMinutes', patch.notifyPollIntervalMinutes);
    if (patch.notifyAchievements !== undefined) {
        store.set('notifyAchievements', !!patch.notifyAchievements);
        if (patch.notifyAchievements) {
            store.set('notifyAchievementsSeeded', false);
        }
    }
    restartNotificationPoller();
    return { ok: true };
});

ipcMain.handle('fetch-online-users-game-list', async () => {
    try {
        const j = await httpsGetJson(`${XBL_SITE_URL}/api/online-users`);
        if (!j || typeof j !== 'object') return { gameNames: [] };
        return { gameNames: Object.keys(j).sort((a, b) => a.localeCompare(b)) };
    } catch (e) {
        return { gameNames: [] };
    }
});

/** Game titles the active account has play time in (from GET /api/me/play-time byGame). */
ipcMain.handle('get-played-game-names', async () => {
    const acc = getActiveXbAccount();
    if (!acc || !acc.username || !acc.sessionKey) return { gameNames: [] };
    try {
        const data = await getPlayTime(acc.username, acc.sessionKey);
        const byGame = data.byGame || {};
        const names = Object.keys(byGame).filter((k) => {
            const raw = byGame[k];
            const n = typeof raw === 'number' ? raw : parseFloat(raw);
            return Number.isFinite(n) && n > 0;
        });
        names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        return { gameNames: names };
    } catch (e) {
        return { gameNames: [] };
    }
});

ipcMain.handle('request-notification-permission', () => {
    if (Notification.isSupported()) {
        new Notification({ title: 'XBL Beacon', body: 'Notifications are enabled for this app.' }).show();
    }
    return { ok: true };
});

// Set up Discord RPC event handlers (shared between init methods)
function setupDiscordRPCEventHandlers() {
    if (!discordRPC) return;
    
    // Remove any existing listeners to avoid duplicates
    discordRPC.removeAllListeners('ready');
    discordRPC.removeAllListeners('error');
    discordRPC.removeAllListeners('disconnected');
    
    discordRPC.on('ready', async () => {
        log('Discord RPC ready');
        if (mainWindow) {
            sendToRenderer('discord-rpc-ready', discordRPC.user);
        }
        
        // If user was online before Discord restarted, restore presence
        const wasActive = store.get('presenceActive', false);
        if (wasActive) {
            log('Discord reconnected - checking if user still online...');
            setTimeout(async () => {
                const acc = getActiveXbAccount();
                if (acc && acc.sessionKey && acc.username) {
                    const { isOnline, gameName } = await getPresenceFromAuth(acc.sessionKey);
                    if (isOnline) {
                        log('User still online - restoring presence');
                        await updatePresence(acc.username, gameName, false);
                    } else {
                        log('User no longer online - clearing presence');
                        await clearPresence();
                    }
                }
            }, 1000);
        }
    });

    discordRPC.on('error', (error) => {
        console.error('Discord RPC error:', error);
        if (mainWindow) {
            sendToRenderer('discord-rpc-error', error.message);
        }
    });
    
    // Handle disconnection - attempt to reconnect with retries
    discordRPC.on('disconnected', () => {
        log('Discord RPC disconnected');
        // Reset discordRPC so it can reconnect
        discordRPC = null;
        
        // Try to reconnect if user was logged in
        const discordUser = store.get('discordUser');
        const acc = getActiveXbAccount();
        if (discordUser && acc && acc.sessionKey) {
            log('Attempting to reconnect Discord RPC...');
            reconnectDiscordRPC(0); // Start with attempt 0
        }
    });
}

// Reconnect Discord RPC with exponential backoff retry logic
async function reconnectDiscordRPC(attempt = 0) {
    const MAX_ATTEMPTS = 10;
    const INITIAL_DELAY = 2000; // Start with 2 seconds
    const MAX_DELAY = 30000; // Max 30 seconds between attempts
    
    if (attempt >= MAX_ATTEMPTS) {
        console.error('Failed to reconnect Discord RPC after', MAX_ATTEMPTS, 'attempts');
        return;
    }
    
    // Calculate delay with exponential backoff (capped at MAX_DELAY)
    const delay = Math.min(INITIAL_DELAY * Math.pow(2, attempt), MAX_DELAY);
    
    log('Reconnecting Discord RPC attempt', attempt + 1, '/', MAX_ATTEMPTS, 'in', delay, 'ms');
    
    setTimeout(async () => {
        try {
            await initDiscordRPC();
            // If successful, initDiscordRPC will set up the connection
            // The 'ready' event handler will restore presence
        } catch (error) {
            console.error(`Failed to reconnect Discord RPC (attempt ${attempt + 1}):`, error.message);
            // Retry with next attempt
            reconnectDiscordRPC(attempt + 1);
        }
    }, delay);
}

async function initDiscordRPC() {
    if (discordRPC && discordRPC.user) {
        // Already connected and ready
        return;
    }

    try {
        // Destroy existing connection if any (but not ready)
        if (discordRPC) {
            try {
                await discordRPC.destroy();
            } catch (e) {
                // Ignore errors when destroying
            }
            discordRPC = null;
        }

        discordRPC = new Client({ transport: 'ipc' });
        
        // Set up event handlers
        setupDiscordRPCEventHandlers();
        
        await discordRPC.login({ clientId: DISCORD_CLIENT_ID });
        log('Discord RPC login successful');
    } catch (error) {
        console.error('Failed to initialize Discord RPC:', error);
        discordRPC = null;
        // Re-throw error so reconnection logic can catch it
        throw error;
    }
}

