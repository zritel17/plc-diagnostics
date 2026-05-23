/**
 * init_extras.js — авторизация, управление вкладками, WebSocket.
 */
(function() {
    'use strict';

    // ── AUTH ──────────────────────────────────────────────────────────────────
    const token = localStorage.getItem('plc_token') || '';
    if (!token) { window.location.href = '/login'; return; }

    // Оборачиваем fetch: добавляем Authorization, перехватываем 401
    const _origFetch = window.fetch.bind(window);
    window.fetch = function(url, opts) {
        opts = opts || {};
        const headers = new Headers(opts.headers || {});
        headers.set('Authorization', 'Bearer ' + token);
        opts.headers = headers;
        return _origFetch(url, opts).then(r => {
            if (r.status === 401) {
                localStorage.removeItem('plc_token');
                window.location.href = '/login';
            }
            return r;
        });
    };

    // Проверяем токен на сервере сразу при загрузке.
    fetch('/api/auth/check').catch(() => {
        localStorage.removeItem('plc_token');
        window.location.href = '/login';
    });

    // Logout
    document.getElementById('logoutBtn')?.addEventListener('click', () => {
        localStorage.removeItem('plc_token');
        window.location.href = '/login';
    });

    // ── TAB MANAGEMENT ────────────────────────────────────────────────────────
    function showOnly(viewId) {
        ['plcView', 'collectorView', 'dashboardsView', 'controlView', 'recipesView', 'aiView'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = (id === viewId) ? 'flex' : 'none';
        });
        const tv = document.getElementById('tagsView');
        if (tv) tv.style.display = 'none';
    }

    // Restore tags from localStorage cache when offline
    function restoreTagsFromCache() {
        if (window.isConnected) return;
        try {
            const cache = localStorage.getItem('plc_tags_cache');
            if (cache) {
                const data = JSON.parse(cache);
                if (data && Object.keys(data).length > 0) {
                    window.tagsData = data;
                }
            }
        } catch {}
    }

    function bindTabs() {
        const plcTab = document.querySelector('.tab[data-tab="plc"]');
        if (plcTab) {
            plcTab.addEventListener('click', () => {
                document.body.classList.add('no-left');
                showOnly('plcView');
                restoreTagsFromCache();
                if (window.Diagnostics) Diagnostics.render();
            });
        }

        const dashTab = document.querySelector('.tab[data-tab="dashboards"]');
        if (dashTab) {
            dashTab.addEventListener('click', () => {
                document.body.classList.add('no-left');
                showOnly('dashboardsView');
                if (window.Dashboards) { Dashboards.loadAvailableTags(); Dashboards.loadList(); }
            });
        }

        const ctrlTab = document.querySelector('.tab[data-tab="control"]');
        if (ctrlTab) {
            ctrlTab.addEventListener('click', () => {
                document.body.classList.add('no-left');
                showOnly('controlView');
                if (window.ControlPanel) ControlPanel.onShow();
            });
        }

        const collTab = document.querySelector('.tab[data-tab="collector"]');
        if (collTab) {
            collTab.addEventListener('click', () => {
                document.body.classList.add('no-left');
                showOnly('collectorView');
                if (window.Collector) { Collector.fetchStatus(); Collector.loadSettings(); }
                if (window.TagCfg) TagCfg.loadConfigs();
            });
        }

        const recipesTab = document.querySelector('.tab[data-tab="recipes"]');
        if (recipesTab) {
            recipesTab.addEventListener('click', () => {
                document.body.classList.add('no-left');
                showOnly('recipesView');
                if (window.Recipes) Recipes.onShow();
            });
        }

        const aiTab = document.querySelector('.tab[data-tab="ai"]');
        if (aiTab) {
            aiTab.addEventListener('click', () => {
                document.body.classList.add('no-left');
                showOnly('aiView');
                if (window.AIAnalytics) AIAnalytics.onShow();
            });
        }
    }

    function initModules() {
        try { if (window.Collector)    Collector.init();    } catch (e) { console.error('Collector.init', e); }
        try { if (window.TagCfg)       TagCfg.init();       } catch (e) { console.error('TagCfg.init', e); }
        try { if (window.Dashboards)   Dashboards.init();   } catch (e) { console.error('Dashboards.init', e); }
        try { if (window.ControlPanel) ControlPanel.init(); } catch (e) { console.error('ControlPanel.init', e); }
        try { if (window.Diagnostics)  Diagnostics.init();  } catch (e) { console.error('Diagnostics.init', e); }
        try { if (window.Recipes)      Recipes.init();      } catch (e) { console.error('Recipes.init', e); }
        try { if (window.AIAnalytics)  AIAnalytics.init();  } catch (e) { console.error('AIAnalytics.init', e); }
    }

    // ── WEBSOCKET ─────────────────────────────────────────────────────────────
    let ws = null;
    let wsBackoff = 1000;

    function connectWs() {
        try {
            const proto = location.protocol === 'https:' ? 'wss' : 'ws';
            const t = encodeURIComponent(localStorage.getItem('plc_token') || '');
            ws = new WebSocket(`${proto}://${location.host}/ws/live?token=${t}`);
            ws.onopen = () => { wsBackoff = 1000; };
            ws.onmessage = ev => {
                try {
                    const msg = JSON.parse(ev.data);
                    if (msg.type === 'tag_update') {
                        flashBadge();
                        const now = Date.now();
                        if (!connectWs._lastBump || now - connectWs._lastBump > 1000) {
                            connectWs._lastBump = now;
                            const collectorVisible =
                                document.body.classList.contains('no-left') &&
                                document.getElementById('collectorView')?.style.display === 'flex';
                            if (collectorVisible && window.Collector) Collector.fetchStatus();
                        }
                    }
                } catch (e) { /* ignore */ }
            };
            ws.onclose = ev => {
                ws = null;
                if (ev.code === 4001) {
                    localStorage.removeItem('plc_token');
                    window.location.href = '/login';
                    return;
                }
                setTimeout(connectWs, Math.min(wsBackoff, 30000));
                wsBackoff = Math.min(wsBackoff * 2, 30000);
            };
            ws.onerror = () => { try { ws && ws.close(); } catch (e) {} };
        } catch (e) {
            setTimeout(connectWs, 5000);
        }
    }

    function flashBadge() {
        const b = document.getElementById('collectorBadge');
        if (!b) return;
        b.style.color = 'var(--dot-success)';
        clearTimeout(flashBadge._t);
        flashBadge._t = setTimeout(() => { b.style.color = ''; }, 300);
    }

    // ── BOOT ──────────────────────────────────────────────────────────────────
    function activateDefaultTab() {
        document.body.classList.add('no-left');
        showOnly('plcView');
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        const dt = document.querySelector('.tab[data-tab="plc"]');
        if (dt) dt.classList.add('active');
        restoreTagsFromCache();
    }

    const _origSwitchTab = window.switchTab;
    window.switchTab = function(name) {
        document.querySelectorAll('.tab').forEach(t =>
            t.classList.toggle('active', t.dataset.tab === name));
        if (name === 'plc' || name === 'tags') {
            document.body.classList.add('no-left');
            showOnly('plcView');
            if (_origSwitchTab) _origSwitchTab(name);
            const tv = document.getElementById('tagsView');
            if (tv) tv.style.display = 'none';
            restoreTagsFromCache();
            if (window.Diagnostics) Diagnostics.render();
        } else if (name === 'recipes') {
            document.body.classList.add('no-left');
            showOnly('recipesView');
            if (window.Recipes) Recipes.onShow();
        } else {
            if (_origSwitchTab) _origSwitchTab(name);
        }
    };

    function restoreLastIpSlot() {
        const lastIp = localStorage.getItem('plc_last_ip');
        const lastSlot = localStorage.getItem('plc_last_slot');
        if (lastIp) {
            const el = document.getElementById('ipInput');
            if (el && !el.value) el.value = lastIp;
        }
        if (lastSlot !== null) {
            const el = document.getElementById('slotInput');
            if (el && el.value === '0') el.value = lastSlot;
        }
    }

    function restoreAutoConnect() {
        const cb = document.getElementById('autoConnectCheck');
        if (!cb) return;
        cb.checked = localStorage.getItem('plc_autoconnect') === '1';
        cb.addEventListener('change', () => {
            localStorage.setItem('plc_autoconnect', cb.checked ? '1' : '0');
        });
    }

    function tryAutoConnect() {
        if (localStorage.getItem('plc_autoconnect') !== '1') return;
        const ip = localStorage.getItem('plc_last_ip');
        if (!ip) return;
        setTimeout(() => {
            if (!window.isConnected && typeof connect === 'function') connect();
        }, 400);
    }

    function bindConnectSave() {
        document.getElementById('connectBtn')?.addEventListener('click', () => {
            const ip = document.getElementById('ipInput')?.value.trim();
            const slot = document.getElementById('slotInput')?.value || '0';
            if (ip) {
                localStorage.setItem('plc_last_ip', ip);
                localStorage.setItem('plc_last_slot', slot);
            }
        });
    }

    // ── UPDATE ────────────────────────────────────────────────────────────────
    let _updateInfo = null;

    function updateModalSetStatus(msg) {
        const el = document.getElementById('updateStatusMsg');
        if (el) el.textContent = msg;
    }

    function renderUpdateInfo(info) {
        _updateInfo = info;
        const hashEl   = document.getElementById('updateCurrentHash');
        const msgEl    = document.getElementById('updateCurrentMsg');
        const newRow   = document.getElementById('updateNewRow');
        const newHash  = document.getElementById('updateNewHash');
        const newMsg   = document.getElementById('updateNewMsg');
        const applyBtn = document.getElementById('updateApplyBtn');
        if (hashEl) hashEl.textContent = info.current_hash;
        if (msgEl)  msgEl.textContent  = info.current_msg;
        if (info.update_available) {
            if (newRow)  newRow.style.display  = '';
            if (newHash) newHash.textContent = info.new_hash || '';
            if (newMsg)  newMsg.textContent  = info.new_msg  || '';
            if (applyBtn) applyBtn.style.display = '';
            updateModalSetStatus(`${info.commits_behind} new commit(s) available.`);
        } else {
            if (newRow)  newRow.style.display  = 'none';
            if (applyBtn) applyBtn.style.display = 'none';
            updateModalSetStatus('You are up to date.');
        }
    }

    async function checkForUpdate(silent) {
        try {
            updateModalSetStatus('Checking…');
            const r = await fetch('/api/update/check');
            if (!r.ok) { updateModalSetStatus('Check failed.'); return; }
            const info = await r.json();
            renderUpdateInfo(info);
            const btn = document.getElementById('updateBtn');
            if (btn) btn.style.display = info.update_available ? '' : 'none';
        } catch (e) {
            if (!silent) updateModalSetStatus('Network error.');
        }
    }

    function openUpdateModal() {
        const modal = document.getElementById('updateModal');
        if (modal) modal.style.display = 'flex';
        if (_updateInfo) renderUpdateInfo(_updateInfo);
        else checkForUpdate(false);
    }

    function closeUpdateModal() {
        const modal = document.getElementById('updateModal');
        if (modal) modal.style.display = 'none';
    }

    async function applyUpdate() {
        const applyBtn = document.getElementById('updateApplyBtn');
        const checkBtn = document.getElementById('updateCheckBtn');
        if (applyBtn) applyBtn.disabled = true;
        if (checkBtn) checkBtn.disabled = true;
        updateModalSetStatus('Pulling updates…');
        try {
            await fetch('/api/update/apply', { method: 'POST' });
        } catch (_) {}
        updateModalSetStatus('Restarting server, please wait…');
        // Poll until server comes back, then reload
        const poll = setInterval(async () => {
            try {
                const r = await _origFetch('/api/auth/check', {
                    headers: { Authorization: 'Bearer ' + token }
                });
                if (r.ok) { clearInterval(poll); window.location.reload(); }
            } catch (_) {}
        }, 2000);
    }

    function bindUpdateUI() {
        document.getElementById('updateBtn')?.addEventListener('click', openUpdateModal);
        document.getElementById('updateModalClose')?.addEventListener('click', closeUpdateModal);
        document.getElementById('updateCheckBtn')?.addEventListener('click', () => checkForUpdate(false));
        document.getElementById('updateApplyBtn')?.addEventListener('click', applyUpdate);
        document.getElementById('updateModal')?.addEventListener('click', e => {
            if (e.target === document.getElementById('updateModal')) closeUpdateModal();
        });
        // Silent background check 5 s after load
        setTimeout(() => checkForUpdate(true), 5000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            bindTabs();
            initModules();
            activateDefaultTab();
            restoreLastIpSlot();
            restoreAutoConnect();
            bindConnectSave();
            tryAutoConnect();
            connectWs();
            bindUpdateUI();
        });
    } else {
        bindTabs();
        initModules();
        activateDefaultTab();
        restoreLastIpSlot();
        restoreAutoConnect();
        bindConnectSave();
        tryAutoConnect();
        connectWs();
        bindUpdateUI();
    }
})();
