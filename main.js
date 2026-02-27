const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const Store = require('electron-store');
const { Client } = require('discord-rpc');

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

const DISCORD_CLIENT_ID = '1451762829303742555';
const AUTH_API_URL = process.env.AUTH_API_URL || 'https://auth.insigniastats.live/api';
const XBL_SITE_URL = process.env.XBL_SITE_URL || 'https://xb.live';
const CHECK_INTERVAL_ACTIVE = 120000;   // 2 min when user is online
const CHECK_INTERVAL_IDLE = 300000;     // 5 min when user is offline
const UPDATE_CHECK_INTERVAL = 86400000; // 24 h
// Update/status go to the same site backend as the rest of the app (e.g. xb.live/api/...)
const UPDATE_SERVER_URL = process.env.UPDATE_SERVER_URL || XBL_SITE_URL;

let mainWindow = null;
let tray = null;
let isQuitting = false;
let discordRPC = null;
let checkTimeout = null;
let checkingActive = false;

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
        if (store.get('insigniaUser')) {
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
        const insigniaSession = store.get('insigniaSession');
        const insigniaUser = store.get('insigniaUser');

        if (!discordUser || !insigniaSession || !insigniaUser) {
            await clearPresence();
            return;
        }

        const username = insigniaUser.username;
        if (!username) {
            log('No username in insigniaUser:', insigniaUser);
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
    const insigniaUser = store.get('insigniaUser');
    const insigniaSession = store.get('insigniaSession');
    if (!insigniaUser || !insigniaUser.username) return { totalMinutes: 0, byGame: {} };
    // Only call the API when user is online; otherwise return cached value
    if (!store.get('presenceActive', false)) {
        return { totalMinutes: store.get('totalPlayTimeMinutes', 0), byGame: {} };
    }
    const data = await getPlayTime(insigniaUser.username, insigniaSession);
    store.set('totalPlayTimeMinutes', data.totalMinutes);
    return { totalMinutes: data.totalMinutes, byGame: {} };
});

// Start checking if both logins exist; schedule update check and report status
app.whenReady().then(() => {
    const discordUser = store.get('discordUser');
    const insigniaSession = store.get('insigniaSession');
    
    if (discordUser && insigniaSession) {
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
        const insigniaUser = store.get('insigniaUser');
        const insigniaSession = store.get('insigniaSession');
        if (insigniaUser && insigniaUser.username && insigniaSession) {
            getPlayTime(insigniaUser.username, insigniaSession).then((playTime) => {
                store.set('totalPlayTimeMinutes', playTime.totalMinutes);
                sendToRenderer('play-time-updated', { totalMinutes: playTime.totalMinutes });
            }).catch(() => {});
        }
    }, 8000);
    scheduleUpdateCheck();
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
                const insigniaSession = store.get('insigniaSession');
                const insigniaUser = store.get('insigniaUser');
                
                if (insigniaSession && insigniaUser && insigniaUser.username) {
                    const { isOnline, gameName } = await getPresenceFromAuth(insigniaSession);
                    if (isOnline) {
                        log('User still online - restoring presence');
                        await updatePresence(insigniaUser.username, gameName, false);
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
        const insigniaSession = store.get('insigniaSession');
        if (discordUser && insigniaSession) {
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

