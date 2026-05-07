/**
 * init_extras.js — связывает все модули, управляет авторизацией и вкладками.
 */
(function() {
    'use strict';

    // ── AUTH ──────────────────────────────────────────────────────────────────
    const token = localStorage.getItem('plc_token') || '';
    if (!token) { window.location.href = '/login'; return; }

    // Оборачиваем глобальный fetch: добавляем Authorization, перехватываем 401
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

    // Logout
    document.getElementById('logoutBtn')?.addEventListener('click', () => {
        localStorage.removeItem('plc_token');
        window.location.href = '/login';
    });

    // ── TAB MANAGEMENT ────────────────────────────────────────────────────────
    function showOnly(viewId) {
        ['collectorView', 'dashboardsView', 'controlView', 'diagnosticsView'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = (id === viewId) ? 'flex' : 'none';
        });
        // tagsView управляется app.js через switchTab — здесь только скрываем
        const tv = document.getElementById('tagsView');
        if (tv) tv.style.display = 'none';
    }

    function bindTabs() {
        // Дашборды
        const dashTab = document.querySelector('.tab[data-tab="dashboards"]');
        if (dashTab) {
            dashTab.addEventListener('click', () => {
                document.body.classList.add('no-left');
                showOnly('dashboardsView');
                if (window.Dashboards) {
                    Dashboards.loadAvailableTags();
                    Dashboards.loadList();
                }
            });
        }

        // Контрольная панель
        const ctrlTab = document.querySelector('.tab[data-tab="control"]');
        if (ctrlTab) {
            ctrlTab.addEventListener('click', () => {
                document.body.classList.add('no-left');
                showOnly('controlView');
                if (window.ControlPanel) ControlPanel.onShow();
            });
        }

        // Выбор тегов (collector)
        const collTab = document.querySelector('.tab[data-tab="collector"]');
        if (collTab) {
            collTab.addEventListener('click', () => {
                document.body.classList.add('no-left');
                showOnly('collectorView');
                if (window.Collector) {
                    Collector.fetchStatus();
                    Collector.loadSettings();
                }
                if (window.TagCfg) TagCfg.loadConfigs();
            });
        }

        // Диагностика (tags)
        const tagsTab = document.querySelector('.tab[data-tab="tags"]');
        if (tagsTab) {
            tagsTab.addEventListener('click', () => {
                document.body.classList.remove('no-left');
                showOnly('diagnosticsView');
                if (window.Diagnostics) Diagnostics.render();
            });
        }
    }

    function initModules() {
        try { if (window.Collector) Collector.init(); } catch (e) { console.error('Collector.init', e); }
        try { if (window.TagCfg) TagCfg.init(); } catch (e) { console.error('TagCfg.init', e); }
        try { if (window.Dashboards) Dashboards.init(); } catch (e) { console.error('Dashboards.init', e); }
        try { if (window.ControlPanel) ControlPanel.init(); } catch (e) { console.error('ControlPanel.init', e); }
        try { if (window.Diagnostics) Diagnostics.init(); } catch (e) { console.error('Diagnostics.init', e); }
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
            ws.onclose = () => {
                ws = null;
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
        b.style.boxShadow = '0 0 12px rgba(74,222,128,0.6)';
        clearTimeout(flashBadge._t);
        flashBadge._t = setTimeout(() => { b.style.boxShadow = ''; }, 200);
    }

    // ── BOOT ──────────────────────────────────────────────────────────────────
    // Первая вкладка при загрузке — Дашборды (скрываем left-panel, показываем dashboardsView)
    function activateDefaultTab() {
        document.body.classList.add('no-left');
        showOnly('dashboardsView');
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        const dt = document.querySelector('.tab[data-tab="dashboards"]');
        if (dt) dt.classList.add('active');
    }

    // Перехватываем app.js switchTab чтобы корректно синхронизировать наши вью
    const _origSwitchTab = window.switchTab;
    window.switchTab = function(name) {
        document.querySelectorAll('.tab').forEach(t =>
            t.classList.toggle('active', t.dataset.tab === name));
        if (name === 'tags') {
            document.body.classList.remove('no-left');
            showOnly('diagnosticsView');
            if (_origSwitchTab) _origSwitchTab(name);
            // origSwitchTab sets tagsView to flex — hide it, we use diagnosticsView
            const tv = document.getElementById('tagsView');
            if (tv) tv.style.display = 'none';
            if (window.Diagnostics) Diagnostics.render();
        } else {
            if (_origSwitchTab) _origSwitchTab(name);
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            bindTabs();
            initModules();
            activateDefaultTab();
            connectWs();
        });
    } else {
        bindTabs();
        initModules();
        activateDefaultTab();
        connectWs();
    }
})();
