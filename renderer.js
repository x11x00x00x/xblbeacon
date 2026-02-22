// Renderer process script
// Note: discord-rpc needs to be used in main process, not renderer
// We'll handle RPC in main process and communicate via IPC

const INSIGNIA_AUTH_URL = 'https://auth.insigniastats.live/api';

// DOM elements
const discordStatus = document.getElementById('discordStatus');
const discordStatusText = document.getElementById('discordStatusText');
const discordUsername = document.getElementById('discordUsername');
const discordLoginBtn = document.getElementById('discordLoginBtn');
const discordLogoutBtn = document.getElementById('discordLogoutBtn');

const insigniaStatus = document.getElementById('insigniaStatus');
const insigniaStatusText = document.getElementById('insigniaStatusText');
const insigniaUsername = document.getElementById('insigniaUsername');
const insigniaEmail = document.getElementById('insigniaEmail');
const insigniaPassword = document.getElementById('insigniaPassword');
const insigniaEmailGroup = document.getElementById('insigniaEmailGroup');
const insigniaPasswordGroup = document.getElementById('insigniaPasswordGroup');
const insigniaLoginBtn = document.getElementById('insigniaLoginBtn');
const insigniaLogoutBtn = document.getElementById('insigniaLogoutBtn');
const insigniaError = document.getElementById('insigniaError');

const presenceStatus = document.getElementById('presenceStatus');
const presenceText = document.getElementById('presenceText');
const presenceDetails = document.getElementById('presenceDetails');

const autoStartCheckbox = document.getElementById('autoStartCheckbox');

// Discord RPC is handled in main process
async function initDiscordRPC() {
    // Request main process to initialize Discord RPC
    // This will be handled via IPC
    return true;
}

// Load saved state
async function loadState() {
    const discordUser = await electronAPI.getStoreValue('discordUser');
    const insigniaSession = await electronAPI.getStoreValue('insigniaSession');
    const insigniaUser = await electronAPI.getStoreValue('insigniaUser');
    const presenceActive = await electronAPI.getStoreValue('presenceActive');
    const lastCheck = await electronAPI.getStoreValue('lastCheck');
    const autoStart = await electronAPI.getAutoStart();

    // Update Discord status
    if (discordUser) {
        updateDiscordStatus(true, discordUser);
    } else {
        updateDiscordStatus(false);
    }

    // Update Insignia status
    if (insigniaSession && insigniaUser) {
        updateInsigniaStatus(true, insigniaUser);
    } else {
        updateInsigniaStatus(false);
    }

    // Update presence status (game name from store if set by main)
    const lastGameName = await electronAPI.getStoreValue('lastGameName');
    if (presenceActive) {
        updatePresenceStatus(true, lastCheck, lastGameName);
    } else {
        updatePresenceStatus(false, null, null);
    }

    // Update auto-start checkbox
    autoStartCheckbox.checked = autoStart;
}

function updateDiscordStatus(connected, user = null) {
    if (connected) {
        discordStatus.className = 'status-indicator connected';
        discordStatusText.textContent = 'Connected';
        discordUsername.textContent = user ? `Logged in as: ${user.username || 'Unknown'}` : '';
        discordLoginBtn.style.display = 'none';
        discordLogoutBtn.style.display = 'block';
    } else {
        discordStatus.className = 'status-indicator disconnected';
        discordStatusText.textContent = 'Not connected';
        discordUsername.textContent = '';
        discordLoginBtn.style.display = 'block';
        discordLogoutBtn.style.display = 'none';
    }
}

function updateInsigniaStatus(connected, user = null) {
    if (connected) {
        insigniaStatus.className = 'status-indicator connected';
        insigniaStatusText.textContent = 'Connected';
        insigniaUsername.textContent = user ? `Logged in as: ${user.username || 'Unknown'}` : '';
        insigniaEmailGroup.style.display = 'none';
        insigniaPasswordGroup.style.display = 'none';
        insigniaLoginBtn.style.display = 'none';
        insigniaLogoutBtn.style.display = 'block';
        insigniaError.textContent = '';
    } else {
        insigniaStatus.className = 'status-indicator disconnected';
        insigniaStatusText.textContent = 'Not connected';
        insigniaUsername.textContent = '';
        insigniaEmailGroup.style.display = 'block';
        insigniaPasswordGroup.style.display = 'block';
        insigniaLoginBtn.style.display = 'block';
        insigniaLogoutBtn.style.display = 'none';
    }
}

const debugInfo = document.getElementById('debugInfo');

function updatePresenceStatus(active, lastCheck = null, gameName = null, lastCheckResult = null, errorMsg = null) {
    if (active) {
        presenceStatus.className = 'presence-status active';
        presenceText.textContent = gameName ? `Playing ${gameName}` : 'Online on xb.live';
        const time = lastCheck ? new Date(lastCheck).toLocaleTimeString() : 'Just now';
        presenceDetails.textContent = `Last checked: ${time}`;
        debugInfo.textContent = '';
    } else {
        presenceStatus.className = 'presence-status inactive';
        presenceText.textContent = 'Not active';
        if (lastCheckResult === 'offline') {
            presenceDetails.textContent = 'Insignia reports you\'re offline. Go online in a game to see status here and on Discord.';
        } else if (lastCheckResult === 'error' && errorMsg) {
            presenceDetails.textContent = 'Could not reach auth service: ' + errorMsg;
        } else {
            presenceDetails.textContent = 'When you\'re online on Insignia, Discord will show what you\'re playing. Checking every 2 minutes.';
        }
        loadState().then(() => {
            electronAPI.getStoreValue('insigniaUser').then(user => {
                if (user && user.username) {
                    debugInfo.textContent = `Logged in as: ${user.username}`;
                }
            });
        });
    }
}

// Discord login - Discord RPC doesn't require OAuth, just needs Discord to be running
discordLoginBtn.addEventListener('click', async () => {
    try {
        discordLoginBtn.disabled = true;
        discordLoginBtn.textContent = 'Connecting...';

        // Request main process to initialize Discord RPC
        // The main process will handle the RPC connection
        const result = await electronAPI.initDiscordRPC();
        
        if (result && result.success) {
            const user = result.user;
            await electronAPI.setStoreValue('discordUser', user);
            updateDiscordStatus(true, user);
        } else {
            const errorMsg = result?.error || 'Failed to connect to Discord';
            console.error('Discord connection error:', errorMsg);
            alert(errorMsg);
        }
    } catch (error) {
        console.error('Discord connection error:', error);
        alert('Failed to connect to Discord. Make sure Discord is running and try again.');
    } finally {
        discordLoginBtn.disabled = false;
        discordLoginBtn.textContent = 'Login to Discord';
    }
});

// Discord logout
discordLogoutBtn.addEventListener('click', async () => {
    // Request main process to disconnect Discord RPC
    await electronAPI.disconnectDiscordRPC();
    
    await electronAPI.deleteStoreValue('discordToken');
    await electronAPI.deleteStoreValue('discordUser');
    updateDiscordStatus(false);
    stopChecking();
});

// Insignia login
insigniaLoginBtn.addEventListener('click', async () => {
    const email = insigniaEmail.value.trim();
    const password = insigniaPassword.value.trim();

    if (!email || !password) {
        insigniaError.textContent = 'Please enter both email and password';
        return;
    }

    insigniaError.textContent = '';
    insigniaError.className = 'error';
    insigniaLoginBtn.disabled = true;
    insigniaLoginBtn.textContent = 'Logging in...';

    const waitingMessage = 'Waiting for a response from Insignia this may take up to a minute.';
    const waitingTimeout = setTimeout(() => {
        insigniaError.textContent = waitingMessage;
        insigniaError.className = 'info';
    }, 5000);

    try {
        const response = await fetch(`${INSIGNIA_AUTH_URL}/auth/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ email, password })
        });

        const data = await response.json();

        if (!response.ok || !data.success) {
            throw new Error(data.error || 'Login failed');
        }

        const user = {
            username: data.username,
            email: data.email || email
        };

        await electronAPI.setStoreValue('insigniaSession', data.sessionKey);
        await electronAPI.setStoreValue('insigniaUser', user);

        clearTimeout(waitingTimeout);
        insigniaError.textContent = '';
        updateInsigniaStatus(true, user);
        insigniaPassword.value = '';

        // Register with xbl.live so the site tracks play time and current game
        const reg = await electronAPI.registerWithXbl(data.sessionKey);
        if (!reg || !reg.ok) {
            console.warn('Could not register with xb.live (play-time may not show on site)');
        }

        startChecking();
    } catch (error) {
        clearTimeout(waitingTimeout);
        console.error('Insignia login error:', error);
        insigniaError.className = 'error';
        insigniaError.textContent = error.message || 'Failed to login';
    } finally {
        clearTimeout(waitingTimeout);
        insigniaLoginBtn.disabled = false;
        insigniaLoginBtn.textContent = 'Login to xb.live';
    }
});

// Insignia logout
insigniaLogoutBtn.addEventListener('click', async () => {
    const sessionKey = await electronAPI.getStoreValue('insigniaSession');
    
    if (sessionKey) {
        try {
            await fetch(`${INSIGNIA_AUTH_URL}/auth/logout`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ sessionKey })
            });
        } catch (error) {
            console.error('Logout error:', error);
        }
    }
    
    await electronAPI.deleteStoreValue('insigniaSession');
    await electronAPI.deleteStoreValue('insigniaUser');
    updateInsigniaStatus(false);
    stopChecking();
});

// Clear Discord presence
async function clearDiscordPresence() {
    try {
        // Request main process to clear presence
        await electronAPI.clearDiscordPresence();
    } catch (error) {
        console.error('Error clearing Discord presence:', error);
    }
    
    await electronAPI.setStoreValue('presenceActive', false);
    updatePresenceStatus(false);
}

// Start checking (main process does auth profile check and Discord updates)
function startChecking() {
    electronAPI.startChecking();
}

// Stop checking
function stopChecking() {
    // Request main process to stop checking
    electronAPI.stopChecking();
    clearDiscordPresence();
}

// Auto-start checkbox
autoStartCheckbox.addEventListener('change', async (e) => {
    await electronAPI.setAutoStart(e.target.checked);
});

// Listen for presence updates from main to refresh UI (once)
if (typeof electronAPI !== 'undefined' && electronAPI.onMessage) {
    electronAPI.onMessage('presence-updated', (payload) => {
        if (payload && payload.active) {
            updatePresenceStatus(true, payload.lastCheck || null, payload.gameName || null);
        } else {
            updatePresenceStatus(false, null, null, payload?.lastCheckResult || null, payload?.error || null);
        }
    });
}

// Initialize
loadState();

