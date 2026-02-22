const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require('electron');
const path = require('path');
const https = require('https');
const Store = require('electron-store');
const { Client } = require('discord-rpc');

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

const store = new Store();

const DISCORD_CLIENT_ID = '1451762829303742555';
const AUTH_API_URL = process.env.AUTH_API_URL || 'https://auth.insigniastats.live/api';
const XBL_SITE_URL = process.env.XBL_SITE_URL || 'https://xb.live';
const CHECK_INTERVAL = 120000; // 2 minutes

let mainWindow = null;
let tray = null;
let isQuitting = false;
let discordRPC = null;
let checkInterval = null;

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
            // Try loading as buffer first (more reliable)
            try {
                const iconBuffer = fs.readFileSync(iconPath);
                windowIcon = nativeImage.createFromBuffer(iconBuffer);
            } catch (e) {
                // Fallback to path method
                windowIcon = nativeImage.createFromPath(iconPath);
            }
            
            // If still empty, try root icon.png as fallback
            if (windowIcon.isEmpty() && iconPath !== path.join(__dirname, 'icon.png')) {
                const rootIcon = path.join(__dirname, 'icon.png');
                if (fs.existsSync(rootIcon)) {
                    try {
                        const rootBuffer = fs.readFileSync(rootIcon);
                        windowIcon = nativeImage.createFromBuffer(rootBuffer);
                    } catch (e) {
                        windowIcon = nativeImage.createFromPath(rootIcon);
                    }
                }
            }
            
            if (!windowIcon.isEmpty()) {
                const size = windowIcon.getSize();
                console.log(`✓ Loaded window icon from: ${iconPath}`);
                console.log(`  Window icon size: ${size.width}x${size.height}`);
            } else {
                console.warn('Window icon is empty after loading');
            }
        } else {
            console.warn(`Window icon not found at: ${iconPath}`);
        }
    } catch (error) {
        console.warn('Error loading window icon:', error.message);
    }
    
    mainWindow = new BrowserWindow({
        width: 500,
        height: 600,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        icon: windowIcon && !windowIcon.isEmpty() ? windowIcon : undefined,
        title: 'XBL Beacon',
        autoHideMenuBar: true
    });

    mainWindow.loadFile('index.html');

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
        
        console.log(`Attempting to load tray icon from: ${iconPath}`);
        console.log(`  Full path: ${path.resolve(iconPath)}`);
        console.log(`  File exists: ${fs.existsSync(iconPath)}`);
        
        if (fs.existsSync(iconPath)) {
            // Load icon using createFromPath (most reliable method)
            icon = nativeImage.createFromPath(iconPath);
            
            // If path method fails, try buffer method as fallback
            if (icon.isEmpty()) {
                console.log('Path method failed, trying buffer method...');
                const iconBuffer = fs.readFileSync(iconPath);
                icon = nativeImage.createFromBuffer(iconBuffer);
            }
            
            if (icon.isEmpty()) {
                console.warn(`Icon at ${iconPath} is empty after loading`);
                throw new Error('Icon is empty');
            }
            
            const iconSize = icon.getSize();
            console.log(`✓ Successfully loaded tray icon from: ${iconPath}`);
            console.log(`  Icon size: ${iconSize.width}x${iconSize.height}`);
            
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
        // Resize only if larger than 64x64
        if (iconSize.width > 64 || iconSize.height > 64) {
            const size = process.platform === 'darwin' ? 22 : 16;
            trayIcon = icon.resize({ width: size, height: size });
            
            if (trayIcon.isEmpty()) {
                console.warn('Resized icon is empty, using original size');
                trayIcon = icon;
            }
            console.log(`Resized icon from ${iconSize.width}x${iconSize.height} to ${size}x${size}`);
        } else {
            console.log(`Using icon at native size: ${iconSize.width}x${iconSize.height}`);
        }
        
        tray = new Tray(trayIcon);
        console.log(`✓ Created tray with icon`);
    } else {
        console.warn('Tray icon is empty, tray may show default system icon');
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
                if (!dockIcon.isEmpty()) {
                    // Don't set as template - use the icon as-is
                    app.dock.setIcon(dockIcon);
                    const size = dockIcon.getSize();
                    console.log(`✓ Set macOS dock icon from ${iconPath} (${size.width}x${size.height})`);
                } else {
                    console.warn('Dock icon is empty after loading');
                }
            } catch (error) {
                console.warn('Could not set dock icon:', error.message);
            }
        } else {
            console.warn(`Dock icon not found at: ${iconPath}`);
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

// Get presence from xb.live server (server calls auth refresh - same path as cron, so we get same result)
async function getPresenceFromAuth(sessionKey) {
    try {
        const res = await nodeFetch(`${XBL_SITE_URL}/api/me/profile-live`, {
            method: 'POST',
            body: JSON.stringify({ sessionKey })
        });
        if (!res.ok) {
            console.warn(`profile-live returned ${res.status}`, (res.json && res.json.error) || '');
            return { isOnline: false, gameName: null };
        }
        const profile = res.json || {};
        const isOnline = !!profile.isOnline;
        const gameName = (profile.game && String(profile.game).trim()) ? String(profile.game).trim() : null;
        console.log(`profile-live OK -> online=${isOnline}, game=${gameName || 'none'}`);
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
            console.log('No username found in insigniaUser:', insigniaUser);
            await clearPresence();
            return;
        }

        console.log(`Checking presence for user: ${username}`);
        const { isOnline, gameName } = await getPresenceFromAuth(insigniaSession);
        console.log(`User online: ${isOnline}, game: ${gameName || 'none'}`);

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
        } else {
            if (mainWindow) {
                mainWindow.webContents.send('presence-updated', {
                    active: false,
                    lastCheckResult: 'offline',
                    gameName: null
                });
            }
            await clearPresence(true);
        }
    } catch (error) {
        console.error('Error checking presence:', error);
        if (mainWindow) {
            mainWindow.webContents.send('presence-updated', {
                active: false,
                lastCheckResult: 'error',
                error: error.message
            });
        }
        await clearPresence(true);
    }
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
            console.log('Setting new presence timestamp:', new Date(startTimestamp).toISOString());
        } else {
            console.log('Keeping existing presence timestamp:', new Date(startTimestamp).toISOString());
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
            mainWindow.webContents.send('presence-updated', {
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
        mainWindow.webContents.send('presence-updated', { active: false });
    }
}

function startChecking() {
    if (checkInterval) {
        clearInterval(checkInterval);
    }

    checkInterval = setInterval(checkAndUpdatePresence, CHECK_INTERVAL);
    checkAndUpdatePresence(); // Check immediately
}

function stopChecking() {
    if (checkInterval) {
        clearInterval(checkInterval);
        checkInterval = null;
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
            console.warn('xbl.live play-time-register failed:', res.status, (res.json && res.json.error) || '');
            return { ok: false, status: res.status };
        }
        return { ok: true };
    } catch (e) {
        console.warn('xbl.live play-time-register error:', e.message);
        return { ok: false };
    }
});

ipcMain.handle('stop-checking', () => {
    stopChecking();
});

// Start checking if both logins exist
app.whenReady().then(() => {
    const discordUser = store.get('discordUser');
    const insigniaSession = store.get('insigniaSession');
    
    if (discordUser && insigniaSession) {
        // Initialize Discord RPC if user was logged in
        setTimeout(async () => {
            await initDiscordRPC();
            startChecking();
        }, 2000);
    }
});

// Set up Discord RPC event handlers (shared between init methods)
function setupDiscordRPCEventHandlers() {
    if (!discordRPC) return;
    
    // Remove any existing listeners to avoid duplicates
    discordRPC.removeAllListeners('ready');
    discordRPC.removeAllListeners('error');
    discordRPC.removeAllListeners('disconnected');
    
    discordRPC.on('ready', async () => {
        console.log('Discord RPC ready');
        if (mainWindow) {
            mainWindow.webContents.send('discord-rpc-ready', discordRPC.user);
        }
        
        // If user was online before Discord restarted, restore presence
        const wasActive = store.get('presenceActive', false);
        if (wasActive) {
            console.log('Discord reconnected - checking if user is still online to restore presence...');
            setTimeout(async () => {
                const insigniaSession = store.get('insigniaSession');
                const insigniaUser = store.get('insigniaUser');
                
                if (insigniaSession && insigniaUser && insigniaUser.username) {
                    const { isOnline, gameName } = await getPresenceFromAuth(insigniaSession);
                    if (isOnline) {
                        console.log('User is still online - restoring Discord presence');
                        await updatePresence(insigniaUser.username, gameName, false);
                    } else {
                        console.log('User is no longer online - clearing presence');
                        await clearPresence();
                    }
                }
            }, 1000);
        }
    });

    discordRPC.on('error', (error) => {
        console.error('Discord RPC error:', error);
        if (mainWindow) {
            mainWindow.webContents.send('discord-rpc-error', error.message);
        }
    });
    
    // Handle disconnection - attempt to reconnect with retries
    discordRPC.on('disconnected', () => {
        console.log('Discord RPC disconnected');
        // Reset discordRPC so it can reconnect
        discordRPC = null;
        
        // Try to reconnect if user was logged in
        const discordUser = store.get('discordUser');
        const insigniaSession = store.get('insigniaSession');
        if (discordUser && insigniaSession) {
            console.log('Attempting to reconnect Discord RPC...');
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
    
    console.log(`Reconnecting Discord RPC (attempt ${attempt + 1}/${MAX_ATTEMPTS}) in ${delay}ms...`);
    
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
        console.log('Discord RPC login successful');
    } catch (error) {
        console.error('Failed to initialize Discord RPC:', error);
        discordRPC = null;
        // Re-throw error so reconnection logic can catch it
        throw error;
    }
}

