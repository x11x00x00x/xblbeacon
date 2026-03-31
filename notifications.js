/**
 * Insignia Menubar–style notifications: friends online, lobby/session alerts, event reminders.
 * Lobby vs events are independent; each has its own game list. Event lead time is configurable.
 */
const https = require('https');

function httpsGetJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data || '{}'));
                } catch (e) {
                    resolve(null);
                }
            });
        }).on('error', reject);
    });
}

function httpsGetJsonWithHeaders(url, headers) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = https.request(
            {
                hostname: u.hostname,
                path: u.pathname + u.search,
                method: 'GET',
                headers: { ...headers }
            },
            (res) => {
                let data = '';
                res.on('data', (c) => { data += c; });
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data || '{}'));
                    } catch (e) {
                        resolve(null);
                    }
                });
            }
        );
        req.on('error', reject);
        req.end();
    });
}

/** Event wall time in America/New_York → UTC Date (minute scan; matches Insignia Menubar). */
function eventStartUtcFromNyWall(event_date, start_time) {
    if (!event_date || event_date.length < 10) return null;
    const [y, mo, d] = event_date.split('-').map(Number);
    let hour = 0;
    let minute = 0;
    if (start_time && String(start_time).trim()) {
        const t = String(start_time).trim().split(':');
        hour = parseInt(t[0], 10) || 0;
        minute = parseInt(t[1], 10) || 0;
    }
    const base = Date.UTC(y, mo - 1, d, 12, 0, 0);
    for (let delta = -40 * 3600000; delta <= 40 * 3600000; delta += 60000) {
        const dt = new Date(base + delta);
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York',
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            hour12: false
        }).formatToParts(dt);
        const get = (type) => parseInt(parts.find((p) => p.type === type)?.value || '0', 10);
        if (
            get('year') === y &&
            get('month') === mo &&
            get('day') === d &&
            get('hour') === hour &&
            get('minute') === minute
        ) {
            return dt;
        }
    }
    return null;
}

function isWithinNotificationHours(ranges, date = new Date()) {
    if (!ranges || !ranges.length) return true;
    const hour = date.getHours();
    const minute = date.getMinutes();
    const nowMinutes = hour * 60 + minute;
    for (const range of ranges) {
        const start = range.startMinutes;
        const end = range.endMinutes;
        if (nowMinutes >= start && nowMinutes <= end) return true;
        if (start > end && (nowMinutes >= start || nowMinutes <= end)) return true;
    }
    return false;
}

function resolveGameKey(name, users) {
    const trimmed = name.trim();
    if (users[trimmed] != null) return trimmed;
    const lower = trimmed.toLowerCase();
    return Object.keys(users).find((k) => k.trim().toLowerCase() === lower) || null;
}

function friendDisplayName(f) {
    const raw = (f.gamertag || f.username || f.name || '').trim();
    return raw || '—';
}

function friendIsOnline(f) {
    return f.isOnline === true || f.online === true;
}

/** xb.live must expose one of these (GET, header X-Session-Key). See module comments on response shape. */
const ACHIEVEMENT_FEED_PATHS = ['/api/me/achievement-feed', '/api/me/achievements/recent'];

/**
 * Expected JSON examples (any one):
 * { "items": [ { "id", "gameName"|"game", "name"|"title"|"achievementName", "unlockedAt"? } ] }
 * { "recent": [ ... ] } | { "achievements": [ ... ] }
 * A bare JSON array also works.
 */
function normalizeAchievementList(payload) {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload;
    if (typeof payload !== 'object') return [];
    for (const k of ['items', 'recent', 'unlocks', 'achievements', 'notifications', 'feed', 'data']) {
        const v = payload[k];
        if (Array.isArray(v)) return v;
    }
    return [];
}

function achievementGameLabel(item) {
    if (!item || typeof item !== 'object') return '';
    return String(item.gameName ?? item.game ?? item.titleName ?? item.title_name ?? '').trim();
}

function achievementTitleLabel(item) {
    if (!item || typeof item !== 'object') return '';
    return String(
        item.achievementName ?? item.name ?? item.title ?? item.achievement ?? item.label ?? ''
    ).trim();
}

function achievementStableKey(item) {
    if (!item || typeof item !== 'object') return '';
    const id = item.id ?? item.achievementId ?? item.unlockId;
    if (id != null && String(id).length) return `id:${String(id)}`;
    const game = achievementGameLabel(item);
    const title = achievementTitleLabel(item);
    const t =
        item.unlockedAt ??
        item.earnedAt ??
        item.createdAt ??
        item.unlocked_at ??
        item.date ??
        '';
    return `sig:${game}|${title}|${t}`;
}

function createNotificationPoller({
    store,
    getSessionKey,
    getActiveUsername,
    Notification,
    log,
    XBL_SITE_URL,
    AUTH_API_URL
}) {
    let pollTimer = null;
    let lastOnlineFriendGamertags = null;
    let lastGameHadLobby = {};
    const notifiedEventKeys = new Set();

    const EVENT_LEAD_OPTIONS = [3, 5, 10, 15, 30, 60, 90, 120];

    function getSettings() {
        let minutesBefore = Number(store.get('notifyEventMinutesBefore', 5));
        if (!Number.isFinite(minutesBefore)) minutesBefore = 5;
        if (!EVENT_LEAD_OPTIONS.includes(minutesBefore)) {
            minutesBefore = EVENT_LEAD_OPTIONS.reduce((best, n) =>
                Math.abs(n - minutesBefore) < Math.abs(best - minutesBefore) ? n : best
            , 5);
        }
        return {
            notifyFriendsOnline: store.get('notifyFriendsOnline') !== false,
            notifyLobbyAlerts: store.get('notifyLobbyAlerts') === true,
            notifyEvents: store.get('notifyEvents') === true,
            notifyLobbyGameNames: store.get('notifyLobbyGameNames', []) || [],
            notifyEventGameNames: store.get('notifyEventGameNames', []) || [],
            notifyEventMinutesBefore: minutesBefore,
            notifyTimeRanges: store.get('notifyTimeRanges', []) || [],
            notifyPollIntervalMinutes: Math.max(1, store.get('notifyPollIntervalMinutes', 5) || 5),
            notifyAchievements: store.get('notifyAchievements') === true
        };
    }

    function showNotif(title, body) {
        try {
            if (!Notification.isSupported()) return;
            const n = new Notification({ title, body: body || '' });
            n.show();
        } catch (e) {
            if (log) log('Notification failed:', e.message);
        }
    }

    function checkFriends(response) {
        const friends = response.friends || [];
        const nowOnline = new Set(
            friends.filter(friendIsOnline).map(friendDisplayName).filter((n) => n && n !== '—')
        );
        if (lastOnlineFriendGamertags === null) {
            lastOnlineFriendGamertags = nowOnline;
            return;
        }
        const newlyOnline = [...nowOnline].filter((g) => !lastOnlineFriendGamertags.has(g));
        lastOnlineFriendGamertags = nowOnline;
        if (!getSettings().notifyFriendsOnline) return;
        for (const gamertag of newlyOnline) {
            const friend = friends.find((f) => friendDisplayName(f) === gamertag);
            const gamePart = friend && friend.game ? ` – ${friend.game}` : '';
            const body = gamePart ? `Playing${gamePart}` : '';
            showNotif(`${gamertag} is now online`, body);
        }
    }

    function checkLobby(users, selectedNames) {
        if (!isWithinNotificationHours(getSettings().notifyTimeRanges)) return;
        if (!selectedNames.length) return;
        const keys = new Set(Object.keys(users));
        for (const name of selectedNames) {
            const key = resolveGameKey(name, users);
            if (!key) continue;
            const info = users[key];
            const lobbies = info && info.activeLobbies != null ? info.activeLobbies : 0;
            const hasSession = info && info.hasActiveSession === true;
            const nowHasLobby = lobbies > 0 || hasSession;
            const hadBefore = lastGameHadLobby[key] === true;
            if (!hadBefore && nowHasLobby) {
                const hostNames = (info && info.lobbyHostNames) || [];
                let body;
                if (lobbies > 0) {
                    if (hostNames.length && hostNames[0]) {
                        body =
                            hostNames.length === 1
                                ? `Hosted by ${hostNames[0]}.`
                                : `Hosted by ${hostNames[0]} (+${hostNames.length - 1} more).`;
                    } else {
                        body = `${lobbies} ${lobbies === 1 ? 'lobby' : 'lobbies'} active.`;
                    }
                } else {
                    body = 'Session active.';
                }
                showNotif(`Lobby is up in ${key}`, body);
            }
            lastGameHadLobby[key] = nowHasLobby;
        }
        lastGameHadLobby = Object.fromEntries(
            Object.entries(lastGameHadLobby).filter(([k]) => keys.has(k))
        );
    }

    function checkEvents(events, selectedGames, minutesBefore, pollIntervalMinutes) {
        if (!isWithinNotificationHours(getSettings().notifyTimeRanges)) return;
        const now = Date.now();
        const M = Math.max(1, Math.min(180, minutesBefore || 5));
        const pollMs = Math.max(60_000, pollIntervalMinutes * 60 * 1000);
        // ~M minutes before start; widen by half a poll so coarse intervals still catch it
        const halfPoll = pollMs / 2;
        const minMs = Math.max(30_000, (M - 1) * 60 * 1000 - halfPoll);
        const maxMs = (M + 2) * 60 * 1000 + halfPoll;
        const lower = (s) => String(s || '').trim().toLowerCase();
        const selected = new Set(selectedGames.map(lower));
        for (const event of events) {
            const gameName = (event.game_name && String(event.game_name).trim()) || '';
            if (!gameName || !selected.has(lower(gameName))) continue;
            const start = eventStartUtcFromNyWall(event.event_date, event.start_time);
            if (!start || Number.isNaN(start.getTime())) continue;
            const msUntil = start.getTime() - now;
            if (msUntil < minMs || msUntil > maxMs) continue;
            const id = event.id != null ? String(event.id) : `${event.event_date}-${event.start_time}`;
            const key = `event-${id}-${event.event_date}-lead${M}`;
            if (notifiedEventKeys.has(key)) continue;
            notifiedEventKeys.add(key);
            const title = event.title || 'Event';
            const leadLabel = M === 1 ? 'about 1 minute' : `about ${M} minutes`;
            showNotif(`Event starting soon: ${title}`, `${gameName} — in ${leadLabel}`);
        }
    }

    const MAX_ACHIEVEMENT_KEYS = 500;

    function trimAchievementSeen(seen) {
        if (seen.size <= MAX_ACHIEVEMENT_KEYS) return;
        const tail = [...seen].slice(-MAX_ACHIEVEMENT_KEYS);
        seen.clear();
        tail.forEach((k) => seen.add(k));
    }

    async function fetchAchievementFeed(sessionKey) {
        for (const p of ACHIEVEMENT_FEED_PATHS) {
            try {
                const data = await httpsGetJsonWithHeaders(`${XBL_SITE_URL}${p}`, {
                    'X-Session-Key': sessionKey
                });
                if (data != null && typeof data === 'object') {
                    return { list: normalizeAchievementList(data), ok: true };
                }
            } catch (e) {
                if (log) log('notify: achievement path', p, e.message);
            }
        }
        return { list: [], ok: false };
    }

    async function checkAchievements(sessionKey) {
        if (!getSettings().notifyAchievements) return;
        if (!isWithinNotificationHours(getSettings().notifyTimeRanges)) return;

        const username = typeof getActiveUsername === 'function' ? getActiveUsername() : '';
        const tracked = store.get('notifyAchievementTrackedUsername') || '';
        if (username && username !== tracked) {
            store.set('notifySeenAchievementKeys', []);
            store.set('notifyAchievementsSeeded', false);
            store.set('notifyAchievementTrackedUsername', username);
        }

        let list;
        let ok;
        try {
            const r = await fetchAchievementFeed(sessionKey);
            list = r.list;
            ok = r.ok;
        } catch (e) {
            if (log) log('notify: achievements failed', e.message);
            return;
        }

        const seeded = store.get('notifyAchievementsSeeded') === true;
        if (!seeded && !ok) {
            return;
        }

        const seen = new Set(store.get('notifySeenAchievementKeys', []) || []);
        const keyed = [];
        for (const item of list) {
            const k = achievementStableKey(item);
            if (k) keyed.push({ k, item });
        }

        if (!seeded) {
            for (const { k } of keyed) seen.add(k);
            trimAchievementSeen(seen);
            store.set('notifySeenAchievementKeys', [...seen]);
            store.set('notifyAchievementsSeeded', true);
            return;
        }

        for (const { k, item } of keyed) {
            if (seen.has(k)) continue;
            seen.add(k);
            const game = achievementGameLabel(item);
            const ach = achievementTitleLabel(item);
            const title = 'Achievement unlocked';
            let body;
            if (game && ach) body = `${game}: ${ach}`;
            else body = ach || game || 'New achievement';
            showNotif(title, body);
        }
        trimAchievementSeen(seen);
        store.set('notifySeenAchievementKeys', [...seen]);
    }

    async function pollOnce() {
        const s = getSettings();
        try {
            const users = await httpsGetJson(`${XBL_SITE_URL}/api/online-users`);
            if (users && typeof users === 'object' && !Array.isArray(users)) {
                if (s.notifyLobbyAlerts && s.notifyLobbyGameNames.length) {
                    checkLobby(users, s.notifyLobbyGameNames);
                }
            }
        } catch (e) {
            if (log) log('notify: online-users failed', e.message);
        }

        const sessionKey = getSessionKey();
        if (sessionKey && s.notifyFriendsOnline) {
            try {
                const friends = await httpsGetJsonWithHeaders(`${AUTH_API_URL}/auth/friends`, {
                    'X-Session-Key': sessionKey
                });
                if (friends && friends.friends) checkFriends(friends);
            } catch (e) {
                if (log) log('notify: friends failed', e.message);
            }
        }

        if (s.notifyEvents && s.notifyEventGameNames.length) {
            try {
                const events = await httpsGetJson(`${XBL_SITE_URL}/api/events`);
                if (Array.isArray(events)) {
                    checkEvents(
                        events,
                        s.notifyEventGameNames,
                        s.notifyEventMinutesBefore,
                        s.notifyPollIntervalMinutes
                    );
                }
            } catch (e) {
                if (log) log('notify: events failed', e.message);
            }
        }

        if (sessionKey && s.notifyAchievements) {
            try {
                await checkAchievements(sessionKey);
            } catch (e) {
                if (log) log('notify: achievements', e.message);
            }
        }
    }

    function restart() {
        stop();
        const mins = getSettings().notifyPollIntervalMinutes;
        const ms = mins * 60 * 1000;
        pollTimer = setInterval(() => {
            pollOnce().catch(() => {});
        }, ms);
        pollOnce().catch(() => {});
    }

    function stop() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    return { restart, stop, pollOnce, getSettings };
}

module.exports = {
    createNotificationPoller,
    httpsGetJson,
    httpsGetJsonWithHeaders,
    isWithinNotificationHours
};
