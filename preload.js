const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
    // Store operations
    getStoreValue: (key) => ipcRenderer.invoke('get-store-value', key),
    setStoreValue: (key, value) => ipcRenderer.invoke('set-store-value', key, value),
    deleteStoreValue: (key) => ipcRenderer.invoke('delete-store-value', key),
    
    // Auto-start
    setAutoStart: (enabled) => ipcRenderer.invoke('set-auto-start', enabled),
    getAutoStart: () => ipcRenderer.invoke('get-auto-start'),
    
    // Discord RPC
    initDiscordRPC: () => ipcRenderer.invoke('init-discord-rpc'),
    disconnectDiscordRPC: () => ipcRenderer.invoke('disconnect-discord-rpc'),
    updateDiscordPresence: (presence) => ipcRenderer.invoke('update-discord-presence', presence),
    clearDiscordPresence: () => ipcRenderer.invoke('clear-discord-presence'),
    
    // Status checking
    startChecking: () => ipcRenderer.invoke('start-checking'),
    stopChecking: () => ipcRenderer.invoke('stop-checking'),
    
    // Register with xbl.live for play-time tracking
    registerWithXbl: (sessionKey) => ipcRenderer.invoke('register-with-xbl', sessionKey),
    getPlayTime: () => ipcRenderer.invoke('get-play-time'),
    getPlayedGameNames: () => ipcRenderer.invoke('get-played-game-names'),
    upsertXbAccount: (payload) => ipcRenderer.invoke('upsert-xb-account', payload),
    getXbAccountsState: () => ipcRenderer.invoke('get-xb-accounts-state'),
    switchXbAccount: (username) => ipcRenderer.invoke('switch-xb-account', username),
    logoutActiveXbAccount: () => ipcRenderer.invoke('logout-active-xb-account'),
    
    getNotificationSettings: () => ipcRenderer.invoke('get-notification-settings'),
    setNotificationSettings: (patch) => ipcRenderer.invoke('set-notification-settings', patch),
    fetchOnlineUsersGameList: () => ipcRenderer.invoke('fetch-online-users-game-list'),
    requestNotificationPermission: () => ipcRenderer.invoke('request-notification-permission'),
    
    // Updates
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
    downloadAndInstallUpdate: (opts) => ipcRenderer.invoke('download-and-install-update', opts),
    
    // Listen for messages from main process
    onMessage: (channel, callback) => {
        ipcRenderer.on(channel, (event, ...args) => callback(...args));
    }
});

