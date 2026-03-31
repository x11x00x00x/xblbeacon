// Renderer process script
// Note: discord-rpc needs to be used in main process, not renderer
// We'll handle RPC in main process and communicate via IPC

const INSIGNIA_AUTH_URL = 'https://auth.insigniastats.live/api';

let appLoadingDepth = 0;

function showLoadingOverlay(message) {
    const overlay = document.getElementById('appLoadingOverlay');
    if (!overlay) return;
    const label = overlay.querySelector('[data-loading-label]');
    if (label) label.textContent = message || 'Loading…';
    appLoadingDepth += 1;
    overlay.hidden = false;
    overlay.setAttribute('aria-busy', 'true');
}

function hideLoadingOverlay() {
    appLoadingDepth = Math.max(0, appLoadingDepth - 1);
    const overlay = document.getElementById('appLoadingOverlay');
    if (!overlay || appLoadingDepth > 0) return;
    overlay.hidden = true;
    overlay.setAttribute('aria-busy', 'false');
}

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
const xbAccountSelect = document.getElementById('xbAccountSelect');
const xbAccountSwitcherRow = document.getElementById('xbAccountSwitcherRow');
const addAnotherAccountBtn = document.getElementById('addAnotherAccountBtn');

/** When true, email/password are shown to add a second xb.live account */
let showInsigniaAddForm = false;
let lastXbAccountSelectValue = '';

const presenceStatus = document.getElementById('presenceStatus');
const presenceText = document.getElementById('presenceText');
const presenceDetails = document.getElementById('presenceDetails');
const totalTimePlayedEl = document.getElementById('totalTimePlayed');

const autoStartCheckbox = document.getElementById('autoStartCheckbox');

const notifyFriendsCheckbox = document.getElementById('notifyFriendsCheckbox');
const notifyAchievementsCheckbox = document.getElementById('notifyAchievementsCheckbox');
const notifyLobbyAlertsCheckbox = document.getElementById('notifyLobbyAlertsCheckbox');
const notifyEventsCheckbox = document.getElementById('notifyEventsCheckbox');
const notifyLobbyGamesList = document.getElementById('notifyLobbyGamesList');
const notifyEventGamesList = document.getElementById('notifyEventGamesList');
const notifyEventMinutesBeforeSelect = document.getElementById('notifyEventMinutesBefore');
const refreshNotifyGamesBtn = document.getElementById('refreshNotifyGamesBtn');
const notifyGamesFilterPlayedBtn = document.getElementById('notifyGamesFilterPlayedBtn');
const notifyTimeRangesList = document.getElementById('notifyTimeRangesList');
const notifyRangeStart = document.getElementById('notifyRangeStart');
const notifyRangeEnd = document.getElementById('notifyRangeEnd');
const addNotifyRangeBtn = document.getElementById('addNotifyRangeBtn');
const notifyPollInterval = document.getElementById('notifyPollInterval');

/** Local copy of time ranges for UI; persisted via setNotificationSettings */
let notifyTimeRangesDraft = [];

/** Full game list from xb.live online-users; used when toggling “only played” filter */
let cachedNotifyAllGames = [];
let notifyGamesPlayedFilterActive = false;
let cachedPlayedGameNames = [];

function filterGamesToPlayedIntersection(allGames, playedNames) {
    if (!Array.isArray(allGames) || !allGames.length) return [];
    if (!Array.isArray(playedNames) || !playedNames.length) return [];
    const playedLower = new Set(playedNames.map((p) => String(p).trim().toLowerCase()));
    return allGames.filter((g) => playedLower.has(String(g).trim().toLowerCase()));
}

function formatPlayTime(totalMinutes) {
    if (totalMinutes == null) return 'Total time played: —';
    const total = Number(totalMinutes);
    const h = Math.floor(total / 60);
    const m = Math.round(total % 60);
    if (h > 0 && m > 0) return `Total time played: ${h}h ${m}m`;
    if (h > 0) return `Total time played: ${h}h`;
    return `Total time played: ${m}m`;
}

function setTotalTimePlayed(totalMinutes) {
    if (!totalTimePlayedEl) return;
    totalTimePlayedEl.textContent = formatPlayTime(totalMinutes);
    // Show row whenever we have a value (including 0); hide only when explicitly cleared (not logged in)
    totalTimePlayedEl.style.display = totalMinutes != null ? '' : 'none';
}

// Discord RPC is handled in main process
async function initDiscordRPC() {
    // Request main process to initialize Discord RPC
    // This will be handled via IPC
    return true;
}

async function refreshXbAccountsUi() {
    if (!electronAPI.getXbAccountsState || !xbAccountSelect || !xbAccountSwitcherRow || !addAnotherAccountBtn) return;
    const { accounts, activeUsername } = await electronAPI.getXbAccountsState();
    xbAccountSelect.innerHTML = '';
    accounts.forEach((a) => {
        const opt = document.createElement('option');
        opt.value = a.username;
        opt.textContent = a.username;
        xbAccountSelect.appendChild(opt);
    });
    if (activeUsername) {
        xbAccountSelect.value = activeUsername;
        lastXbAccountSelectValue = activeUsername;
    }
    xbAccountSwitcherRow.style.display = accounts.length > 1 ? 'block' : 'none';
    addAnotherAccountBtn.style.display = accounts.length >= 1 ? 'block' : 'none';
}

// Load saved state
async function loadState(opts = {}) {
    const showOverlay = opts.showOverlay !== false;
    if (showOverlay) showLoadingOverlay('Loading…');
    try {
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

    // Update Insignia status (legacy keys stay in sync with active account from main)
    if (insigniaSession && insigniaUser) {
        updateInsigniaStatus(true, insigniaUser);
    } else {
        updateInsigniaStatus(false);
    }

    await refreshXbAccountsUi();

    // Update presence status (game name from store if set by main)
    const lastGameName = await electronAPI.getStoreValue('lastGameName');
    if (presenceActive) {
        updatePresenceStatus(true, lastCheck, lastGameName);
    } else {
        updatePresenceStatus(false, null, null);
    }

    // Update auto-start checkbox
    autoStartCheckbox.checked = autoStart;

    // Total time played (fetch when logged in to xb.live)
    if (insigniaSession && insigniaUser) {
        if (electronAPI.getPlayTime) {
            electronAPI.getPlayTime().then(({ totalMinutes }) => setTotalTimePlayed(totalMinutes)).catch(() => setTotalTimePlayed(null));
        } else {
            const cached = await electronAPI.getStoreValue('totalPlayTimeMinutes');
            setTotalTimePlayed(cached);
        }
    } else {
        setTotalTimePlayed(null);
    }

    await loadNotificationSettings();
    } finally {
        if (showOverlay) hideLoadingOverlay();
    }
}

function timeStrToMinutes(str) {
    if (!str || typeof str !== 'string') return null;
    const m = /^(\d{1,2}):(\d{2})$/.exec(str.trim());
    if (!m) return null;
    const h = parseInt(m[1], 10);
    const mi = parseInt(m[2], 10);
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
}

function formatMinutesAsTime(minutes) {
    const h = Math.floor(minutes / 60) % 24;
    const mi = minutes % 60;
    return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

function renderNotifyTimeRanges() {
    if (!notifyTimeRangesList) return;
    notifyTimeRangesList.innerHTML = '';
    if (!notifyTimeRangesDraft.length) {
        const p = document.createElement('div');
        p.className = 'info';
        p.textContent = 'No restrictions (all day).';
        notifyTimeRangesList.appendChild(p);
        return;
    }
    notifyTimeRangesDraft.forEach((range, index) => {
        const row = document.createElement('div');
        row.className = 'notify-range-row';
        const start = typeof range.startMinutes === 'number' ? range.startMinutes : 0;
        const end = typeof range.endMinutes === 'number' ? range.endMinutes : 0;
        row.innerHTML = `<span>${formatMinutesAsTime(start)} – ${formatMinutesAsTime(end)}</span>`;
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'secondary';
        removeBtn.style.cssText = 'width: auto; padding: 4px 10px; margin-left: auto;';
        removeBtn.textContent = 'Remove';
        removeBtn.addEventListener('click', async () => {
            notifyTimeRangesDraft.splice(index, 1);
            if (electronAPI.setNotificationSettings) {
                await electronAPI.setNotificationSettings({ notifyTimeRanges: [...notifyTimeRangesDraft] });
            }
            renderNotifyTimeRanges();
        });
        row.appendChild(removeBtn);
        notifyTimeRangesList.appendChild(row);
    });
}

function renderNotifyGameCheckboxList(container, gameNames, selectedNames, listKind) {
    if (!container) return;
    container.innerHTML = '';
    const selected = new Set(Array.isArray(selectedNames) ? selectedNames : []);
    if (!gameNames.length) {
        const p = document.createElement('div');
        p.className = 'info';
        p.style.fontSize = '12px';
        if (notifyGamesPlayedFilterActive && cachedNotifyAllGames.length && !cachedPlayedGameNames.length) {
            p.textContent =
                'No play-time games returned. Log in to xb.live and ensure play time is tracked, or turn off “only played”.';
        } else if (notifyGamesPlayedFilterActive && cachedNotifyAllGames.length) {
            p.textContent =
                'None of your played games appear in the live list right now. Try Refresh or turn off the filter.';
        } else {
            p.textContent = 'No games yet (or refresh failed). Try Refresh when xb.live is reachable.';
        }
        container.appendChild(p);
        return;
    }
    gameNames.forEach((name, i) => {
        const id = `notify-${listKind}-game-${i}`;
        const label = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.id = id;
        cb.checked = selected.has(name);
        cb.addEventListener('change', async () => {
            const visibleChecked = gameNames.filter((g, j) => {
                const el = document.getElementById(`notify-${listKind}-game-${j}`);
                return el && el.checked;
            });
            if (!electronAPI.getNotificationSettings || !electronAPI.setNotificationSettings) return;
            const s = await electronAPI.getNotificationSettings();
            const stored =
                listKind === 'lobby' ? s.notifyLobbyGameNames || [] : s.notifyEventGameNames || [];
            const displaySet = new Set(gameNames);
            const hiddenKept = stored.filter((x) => !displaySet.has(x));
            const merged = [...new Set([...hiddenKept, ...visibleChecked])];
            const patch =
                listKind === 'lobby'
                    ? { notifyLobbyGameNames: merged }
                    : { notifyEventGameNames: merged };
            await electronAPI.setNotificationSettings(patch);
        });
        label.appendChild(cb);
        const span = document.createElement('span');
        span.textContent = name;
        label.appendChild(span);
        container.appendChild(label);
    });
}

async function refreshBothNotifyGameLists(lobbySelected, eventSelected) {
    if (!electronAPI.fetchOnlineUsersGameList) return;
    let gameNames = [];
    try {
        const res = await electronAPI.fetchOnlineUsersGameList();
        gameNames = res && Array.isArray(res.gameNames) ? res.gameNames : [];
    } catch (e) {
        gameNames = [];
    }
    cachedNotifyAllGames = gameNames;
    let display = gameNames;
    if (notifyGamesPlayedFilterActive) {
        display = cachedPlayedGameNames.length
            ? filterGamesToPlayedIntersection(gameNames, cachedPlayedGameNames)
            : [];
    }
    renderNotifyGameCheckboxList(notifyLobbyGamesList, display, lobbySelected, 'lobby');
    renderNotifyGameCheckboxList(notifyEventGamesList, display, eventSelected, 'event');
}

async function loadNotificationSettings() {
    if (!electronAPI.getNotificationSettings) return;
    try {
        const s = await electronAPI.getNotificationSettings();
        if (notifyFriendsCheckbox) notifyFriendsCheckbox.checked = s.notifyFriendsOnline !== false;
        if (notifyAchievementsCheckbox) notifyAchievementsCheckbox.checked = s.notifyAchievements === true;
        if (notifyLobbyAlertsCheckbox) notifyLobbyAlertsCheckbox.checked = s.notifyLobbyAlerts === true;
        if (notifyEventsCheckbox) notifyEventsCheckbox.checked = s.notifyEvents === true;
        if (notifyEventMinutesBeforeSelect) {
            const allowed = Array.isArray(s.notifyEventLeadOptions)
                ? s.notifyEventLeadOptions
                : [3, 5, 10, 15, 30, 60, 90, 120];
            let m = Number(s.notifyEventMinutesBefore) || 5;
            if (!allowed.includes(m)) m = 5;
            notifyEventMinutesBeforeSelect.value = String(m);
        }
        if (notifyPollInterval) {
            const allowed = [1, 3, 5, 10, 15];
            let p = Number(s.notifyPollIntervalMinutes) || 5;
            if (!allowed.includes(p)) p = 5;
            notifyPollInterval.value = String(p);
        }
        notifyTimeRangesDraft = Array.isArray(s.notifyTimeRanges) ? s.notifyTimeRanges.map((r) => ({
            startMinutes: r.startMinutes,
            endMinutes: r.endMinutes
        })) : [];
        renderNotifyTimeRanges();
        await refreshBothNotifyGameLists(s.notifyLobbyGameNames, s.notifyEventGameNames);
    } catch (e) {
        console.error('loadNotificationSettings', e);
    }
}

if (notifyFriendsCheckbox && electronAPI.setNotificationSettings) {
    notifyFriendsCheckbox.addEventListener('change', async (e) => {
        const on = e.target.checked;
        if (on && electronAPI.requestNotificationPermission) {
            await electronAPI.requestNotificationPermission();
        }
        await electronAPI.setNotificationSettings({ notifyFriendsOnline: on });
    });
}
if (notifyAchievementsCheckbox && electronAPI.setNotificationSettings) {
    notifyAchievementsCheckbox.addEventListener('change', async (e) => {
        const on = e.target.checked;
        if (on && electronAPI.requestNotificationPermission) {
            await electronAPI.requestNotificationPermission();
        }
        await electronAPI.setNotificationSettings({ notifyAchievements: on });
    });
}
if (notifyLobbyAlertsCheckbox && electronAPI.setNotificationSettings) {
    notifyLobbyAlertsCheckbox.addEventListener('change', async (e) => {
        const on = e.target.checked;
        if (on && electronAPI.requestNotificationPermission) {
            await electronAPI.requestNotificationPermission();
        }
        await electronAPI.setNotificationSettings({ notifyLobbyAlerts: on });
    });
}
if (notifyEventsCheckbox && electronAPI.setNotificationSettings) {
    notifyEventsCheckbox.addEventListener('change', async (e) => {
        const on = e.target.checked;
        if (on && electronAPI.requestNotificationPermission) {
            await electronAPI.requestNotificationPermission();
        }
        await electronAPI.setNotificationSettings({ notifyEvents: on });
    });
}
if (notifyEventMinutesBeforeSelect && electronAPI.setNotificationSettings) {
    notifyEventMinutesBeforeSelect.addEventListener('change', async (e) => {
        const n = parseInt(e.target.value, 10);
        if (!Number.isFinite(n)) return;
        await electronAPI.setNotificationSettings({ notifyEventMinutesBefore: n });
    });
}
if (refreshNotifyGamesBtn && electronAPI.getNotificationSettings) {
    refreshNotifyGamesBtn.addEventListener('click', async () => {
        refreshNotifyGamesBtn.disabled = true;
        showLoadingOverlay('Loading game lists…');
        try {
            if (notifyGamesPlayedFilterActive && electronAPI.getPlayedGameNames) {
                const r = await electronAPI.getPlayedGameNames();
                cachedPlayedGameNames = r && Array.isArray(r.gameNames) ? r.gameNames : [];
            }
            const s = await electronAPI.getNotificationSettings();
            await refreshBothNotifyGameLists(s.notifyLobbyGameNames, s.notifyEventGameNames);
        } finally {
            hideLoadingOverlay();
            refreshNotifyGamesBtn.disabled = false;
        }
    });
}
if (notifyGamesFilterPlayedBtn && electronAPI.getNotificationSettings) {
    const labelPlayed = "Only games I've played";
    const labelAll = 'Show all games';
    notifyGamesFilterPlayedBtn.addEventListener('click', async () => {
        notifyGamesPlayedFilterActive = !notifyGamesPlayedFilterActive;
        notifyGamesFilterPlayedBtn.disabled = true;
        showLoadingOverlay('Loading game lists…');
        try {
            if (notifyGamesPlayedFilterActive) {
                notifyGamesFilterPlayedBtn.textContent = labelAll;
                if (electronAPI.getPlayedGameNames) {
                    const r = await electronAPI.getPlayedGameNames();
                    cachedPlayedGameNames = r && Array.isArray(r.gameNames) ? r.gameNames : [];
                } else {
                    cachedPlayedGameNames = [];
                }
            } else {
                notifyGamesFilterPlayedBtn.textContent = labelPlayed;
                cachedPlayedGameNames = [];
            }
            const s = await electronAPI.getNotificationSettings();
            await refreshBothNotifyGameLists(s.notifyLobbyGameNames, s.notifyEventGameNames);
        } finally {
            hideLoadingOverlay();
            notifyGamesFilterPlayedBtn.disabled = false;
        }
    });
}
if (addNotifyRangeBtn && electronAPI.setNotificationSettings) {
    addNotifyRangeBtn.addEventListener('click', async () => {
        const startM = timeStrToMinutes(notifyRangeStart ? notifyRangeStart.value : '');
        const endM = timeStrToMinutes(notifyRangeEnd ? notifyRangeEnd.value : '');
        if (startM == null || endM == null) return;
        notifyTimeRangesDraft.push({ startMinutes: startM, endMinutes: endM });
        await electronAPI.setNotificationSettings({ notifyTimeRanges: [...notifyTimeRangesDraft] });
        renderNotifyTimeRanges();
    });
}
if (notifyPollInterval && electronAPI.setNotificationSettings) {
    notifyPollInterval.addEventListener('change', async (e) => {
        const n = parseInt(e.target.value, 10);
        if (!Number.isFinite(n)) return;
        await electronAPI.setNotificationSettings({ notifyPollIntervalMinutes: n });
    });
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
        insigniaUsername.textContent = user ? `Active: ${user.username || 'Unknown'}` : '';
        if (showInsigniaAddForm) {
            insigniaEmailGroup.style.display = 'block';
            insigniaPasswordGroup.style.display = 'block';
            insigniaLoginBtn.style.display = 'block';
            insigniaLoginBtn.textContent = 'Add account';
        } else {
            insigniaEmailGroup.style.display = 'none';
            insigniaPasswordGroup.style.display = 'none';
            insigniaLoginBtn.style.display = 'none';
            insigniaLoginBtn.textContent = 'Login to xb.live';
        }
        insigniaLogoutBtn.style.display = 'block';
        insigniaError.textContent = '';
    } else {
        showInsigniaAddForm = false;
        insigniaStatus.className = 'status-indicator disconnected';
        insigniaStatusText.textContent = 'Not connected';
        insigniaUsername.textContent = '';
        insigniaEmailGroup.style.display = 'block';
        insigniaPasswordGroup.style.display = 'block';
        insigniaLoginBtn.style.display = 'block';
        insigniaLoginBtn.textContent = 'Login to xb.live';
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
        electronAPI.getStoreValue('insigniaUser').then(user => {
            if (user && user.username) debugInfo.textContent = `Logged in as: ${user.username}`;
        });
    }
}

// Discord login - Discord RPC doesn't require OAuth, just needs Discord to be running
discordLoginBtn.addEventListener('click', async () => {
    try {
        discordLoginBtn.disabled = true;
        discordLoginBtn.textContent = 'Connecting...';
        showLoadingOverlay('Connecting to Discord…');

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
        hideLoadingOverlay();
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
    showLoadingOverlay('Signing in to xb.live…');

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

        if (electronAPI.upsertXbAccount) {
            await electronAPI.upsertXbAccount({
                username: user.username,
                email: user.email,
                sessionKey: data.sessionKey
            });
        } else {
            await electronAPI.setStoreValue('insigniaSession', data.sessionKey);
            await electronAPI.setStoreValue('insigniaUser', user);
        }

        clearTimeout(waitingTimeout);
        insigniaError.textContent = '';
        showInsigniaAddForm = false;
        updateInsigniaStatus(true, user);
        insigniaPassword.value = '';
        await refreshXbAccountsUi();

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
        hideLoadingOverlay();
        insigniaLoginBtn.disabled = false;
        insigniaLoginBtn.textContent = 'Login to xb.live';
    }
});

// Insignia logout (active account only; other saved accounts remain)
insigniaLogoutBtn.addEventListener('click', async () => {
    if (electronAPI.logoutActiveXbAccount) {
        const result = await electronAPI.logoutActiveXbAccount();
        if (result && result.ok) {
            showInsigniaAddForm = false;
            await loadState();
        }
        return;
    }
    const sessionKey = await electronAPI.getStoreValue('insigniaSession');
    if (sessionKey) {
        try {
            await fetch(`${INSIGNIA_AUTH_URL}/auth/logout`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionKey })
            });
        } catch (e) {}
    }
    await electronAPI.deleteStoreValue('insigniaSession');
    await electronAPI.deleteStoreValue('insigniaUser');
    showInsigniaAddForm = false;
    updateInsigniaStatus(false);
    stopChecking();
});

if (addAnotherAccountBtn) {
    addAnotherAccountBtn.addEventListener('click', () => {
        showInsigniaAddForm = true;
        insigniaEmail.value = '';
        insigniaPassword.value = '';
        electronAPI.getStoreValue('insigniaUser').then((u) => {
            updateInsigniaStatus(true, u);
        });
    });
}

if (xbAccountSelect) {
    xbAccountSelect.addEventListener('change', async () => {
        const username = xbAccountSelect.value;
        if (!username || username === lastXbAccountSelectValue) return;
        showLoadingOverlay('Switching account…');
        try {
            const r = await electronAPI.switchXbAccount(username);
            if (r && r.ok) {
                lastXbAccountSelectValue = username;
                const u = await electronAPI.getStoreValue('insigniaUser');
                updateInsigniaStatus(true, u);
                await refreshXbAccountsUi();
                await loadState({ showOverlay: false });
            } else {
                xbAccountSelect.value = lastXbAccountSelectValue;
            }
        } finally {
            hideLoadingOverlay();
        }
    });
}

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

// --- Updates ---
const appVersionEl = document.getElementById('appVersion');
const checkUpdateBtn = document.getElementById('checkUpdateBtn');
const updateStatusEl = document.getElementById('updateStatus');
const updateAvailableEl = document.getElementById('updateAvailable');
const downloadUpdateBtn = document.getElementById('downloadUpdateBtn');
let pendingUpdate = null;

async function refreshVersion() {
    if (typeof electronAPI !== 'undefined' && electronAPI.getAppVersion) {
        const v = await electronAPI.getAppVersion();
        if (appVersionEl) appVersionEl.textContent = v || '—';
    }
}

function showUpdateStatus(text, isError) {
    if (!updateStatusEl) return;
    updateStatusEl.style.display = 'block';
    updateStatusEl.textContent = text;
    updateStatusEl.className = isError ? 'error' : 'info';
}

function showPendingUpdate(info) {
    pendingUpdate = info;
    if (updateAvailableEl) updateAvailableEl.style.display = 'block';
    if (updateStatusEl) {
        updateStatusEl.style.display = 'block';
        updateStatusEl.textContent = `Update ${info.version} available. ${info.notes || ''}`;
        updateStatusEl.className = 'success';
    }
}

checkUpdateBtn.addEventListener('click', async () => {
    if (!electronAPI.checkForUpdates) return;
    checkUpdateBtn.disabled = true;
    updateAvailableEl.style.display = 'none';
    showUpdateStatus('Checking for updates…', false);
    showLoadingOverlay('Checking for updates…');
    try {
        const result = await electronAPI.checkForUpdates();
        if (result.updateAvailable && result.url) {
            showPendingUpdate(result);
        } else if (result.error) {
            showUpdateStatus('Update check failed: ' + result.error, true);
        } else {
            showUpdateStatus('You’re on the latest version.', false);
        }
    } catch (e) {
        showUpdateStatus('Update check failed.', true);
    } finally {
        hideLoadingOverlay();
        checkUpdateBtn.disabled = false;
    }
});

downloadUpdateBtn.addEventListener('click', async () => {
    if (!pendingUpdate || !electronAPI.downloadAndInstallUpdate) return;
    downloadUpdateBtn.disabled = true;
    showLoadingOverlay('Preparing download…');
    try {
        await electronAPI.downloadAndInstallUpdate({ url: pendingUpdate.url, sha256: pendingUpdate.sha256 });
        showUpdateStatus('Download started. Install the update and restart the app.', false);
    } catch (e) {
        showUpdateStatus('Download failed: ' + (e.message || 'Unknown error'), true);
    } finally {
        hideLoadingOverlay();
        downloadUpdateBtn.disabled = false;
    }
});

if (typeof electronAPI !== 'undefined' && electronAPI.onMessage) {
    electronAPI.onMessage('update-available', (info) => {
        if (info && info.updateAvailable && info.url) showPendingUpdate(info);
    });
    electronAPI.onMessage('play-time-updated', (data) => {
        if (data && typeof data.totalMinutes === 'number') setTotalTimePlayed(data.totalMinutes);
    });
}

// Initialize
refreshVersion();
loadState();

