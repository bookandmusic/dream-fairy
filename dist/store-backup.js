(function() {
    'use strict';
    
    const STORE_NAME = 'game-backup.json';
    const BACKUP_KEY_PREFIX = 'backup_';
    const DEBUG = false;
    
    function log(...args) {
        if (DEBUG) console.log('[StoreBackup]', ...args);
    }
    
    let storeInstance = null;
    let storeReady = false;
    let storeInitPromise = null;
    
    async function initStore() {
        if (storeInitPromise) return storeInitPromise;
        
        storeInitPromise = (async () => {
            if (!window.__TAURI__ || !window.__TAURI__.store) {
                return null;
            }
            try {
                storeInstance = new window.__TAURI__.store.Store(STORE_NAME);
                storeReady = true;
                return storeInstance;
            } catch (e) {
                console.error('[StoreBackup] Store init failed:', e);
                return null;
            }
        })();
        
        return storeInitPromise;
    }
    
    function getStore() {
        return storeReady ? storeInstance : null;
    }
    
    function isTauriEnv() {
        return !!(window.__TAURI__ && window.__TAURI__.store);
    }
    
    const originalSetItem = localStorage.setItem.bind(localStorage);
    const originalRemoveItem = localStorage.removeItem.bind(localStorage);
    const originalClear = localStorage.clear.bind(localStorage);
    const originalGetItem = localStorage.getItem.bind(localStorage);
    const originalKey = localStorage.key.bind(localStorage);
    
    let backupQueue = [];
    let isProcessing = false;
    
    async function processBackupQueue() {
        if (isProcessing || backupQueue.length === 0) return;
        if (!storeReady) {
            await initStore();
            if (!storeReady) return;
        }
        
        isProcessing = true;
        const store = getStore();
        
        try {
            const batch = backupQueue.slice();
            backupQueue = [];
            
            for (const task of batch) {
                if (task.type === 'set') {
                    await store.set(BACKUP_KEY_PREFIX + task.key, task.value);
                } else if (task.type === 'remove') {
                    await store.delete(BACKUP_KEY_PREFIX + task.key);
                } else if (task.type === 'clear') {
                    const keys = await store.keys();
                    for (const key of keys) {
                        if (key.startsWith(BACKUP_KEY_PREFIX)) {
                            await store.delete(key);
                        }
                    }
                }
            }
            
            await store.save();
            log('Backup saved, operations:', batch.length);
        } catch (e) {
            console.error('[StoreBackup] Backup failed:', e);
        } finally {
            isProcessing = false;
            if (backupQueue.length > 0) {
                processBackupQueue();
            }
        }
    }
    
    function scheduleBackup(task) {
        backupQueue.push(task);
        if (storeReady) {
            setTimeout(processBackupQueue, 0);
        } else {
            initStore().then(() => {
                if (storeReady) processBackupQueue();
            });
        }
    }
    
    localStorage.setItem = function(key, value) {
        originalSetItem(key, value);
        
        if (key.startsWith('farm_operation_')) {
            scheduleBackup({ type: 'set', key, value });
        }
    };
    
    localStorage.removeItem = function(key) {
        originalRemoveItem(key);
        
        if (key.startsWith('farm_operation_')) {
            scheduleBackup({ type: 'remove', key });
        }
    };
    
    localStorage.clear = function() {
        originalClear();
        scheduleBackup({ type: 'clear' });
    };
    
    async function restoreFromBackup() {
        if (!isTauriEnv()) {
            log('Not in Tauri environment, skip restore');
            return 0;
        }
        
        await initStore();
        const store = getStore();
        if (!store) {
            log('Store not available');
            return 0;
        }
        
        try {
            const keys = await store.keys();
            const backupKeys = keys.filter(k => k.startsWith(BACKUP_KEY_PREFIX));
            
            if (backupKeys.length === 0) {
                log('No backup found');
                return 0;
            }
            
            let restored = 0;
            for (const backupKey of backupKeys) {
                const originalKey = backupKey.replace(BACKUP_KEY_PREFIX, '');
                const existingValue = originalGetItem(originalKey);
                
                if (!existingValue) {
                    const value = await store.get(backupKey);
                    if (value !== null && value !== undefined) {
                        originalSetItem(originalKey, value);
                        restored++;
                        log('Restored:', originalKey);
                    }
                }
            }
            
            if (restored > 0) {
                console.log('[StoreBackup] Restored', restored, 'items from backup');
            }
            return restored;
        } catch (e) {
            console.error('[StoreBackup] Restore failed:', e);
            return 0;
        }
    }
    
    async function fullBackupToStore() {
        if (!isTauriEnv()) return 0;
        
        await initStore();
        const store = getStore();
        if (!store) return 0;
        
        try {
            let backedUp = 0;
            const len = localStorage.length;
            for (let i = 0; i < len; i++) {
                const key = originalKey(i);
                if (key && key.startsWith('farm_operation_')) {
                    const value = originalGetItem(key);
                    if (value) {
                        await store.set(BACKUP_KEY_PREFIX + key, value);
                        backedUp++;
                    }
                }
            }
            
            if (backedUp > 0) {
                await store.save();
                console.log('[StoreBackup] Full backup completed:', backedUp, 'items');
            }
            return backedUp;
        } catch (e) {
            console.error('[StoreBackup] Full backup failed:', e);
            return 0;
        }
    }
    
    let restoreResolve = null;
    let restoreCompletePromise = new Promise((resolve) => {
        restoreResolve = resolve;
    });
    
    let restoreStarted = false;
    
    async function waitForTauriAndRestore() {
        if (restoreStarted) return restoreCompletePromise;
        restoreStarted = true;
        
        let attempts = 0;
        const maxAttempts = 50;
        
        while (!isTauriEnv() && attempts < maxAttempts) {
            await new Promise(r => setTimeout(r, 100));
            attempts++;
        }
        
        if (isTauriEnv()) {
            log('Tauri environment ready, starting restore...');
            await restoreFromBackup();
            await fullBackupToStore();
        } else {
            log('Tauri environment not detected, running in browser mode');
        }
        
        if (restoreResolve) restoreResolve();
        return restoreCompletePromise;
    }
    
    window.__STORE_BACKUP__ = {
        restore: restoreFromBackup,
        fullBackup: fullBackupToStore,
        isReady: isTauriEnv,
        waitForRestore: () => restoreCompletePromise
    };
    
    let originalBoot = null;
    
    Object.defineProperty(window, 'boot', {
        configurable: true,
        enumerable: true,
        get: function() {
            return originalBoot;
        },
        set: function(fn) {
            if (typeof fn === 'function') {
                originalBoot = function() {
                    waitForTauriAndRestore().finally(() => {
                        fn.apply(this, arguments);
                    });
                };
                log('window.boot intercepted and wrapped');
            } else {
                originalBoot = fn;
            }
        }
    });
    
    log('Store backup initialized');
})();