/**
 * Связывает новые модули с существующим app.js, не модифицируя его.
 * - дополняет переключение вкладок (collector/dashboards) — мои обработчики
 *   запускаются после оригинальных, поэтому состояние tagsView/ioView
 *   корректно скрывается оригинальным switchTab, а я только показываю свои.
 * - инициализирует модули после DOMContentLoaded.
 * - подключает WebSocket /ws/live для индикатора в шапке.
 */
(function() {
    'use strict';

    function showOnly(viewId) {
        ['collectorView', 'dashboardsView'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = (id === viewId) ? 'flex' : 'none';
        });
    }

    function bindTabs() {
        // collector
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
        // dashboards
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
        // tags / io — снимаем no-left и прячем наши вью
        ['tags', 'io'].forEach(name => {
            const t = document.querySelector(`.tab[data-tab="${name}"]`);
            if (t) {
                t.addEventListener('click', () => {
                    document.body.classList.remove('no-left');
                    showOnly(null);
                });
            }
        });
    }

    function initModules() {
        try { if (window.Collector) Collector.init(); } catch (e) { console.error('Collector.init', e); }
        try { if (window.TagCfg) TagCfg.init(); } catch (e) { console.error('TagCfg.init', e); }
        try { if (window.Dashboards) Dashboards.init(); } catch (e) { console.error('Dashboards.init', e); }
    }

    let ws = null;
    let wsBackoff = 1000;
    function connectWs() {
        try {
            const proto = location.protocol === 'https:' ? 'wss' : 'ws';
            ws = new WebSocket(`${proto}://${location.host}/ws/live`);
            ws.onopen = () => { wsBackoff = 1000; };
            ws.onmessage = ev => {
                try {
                    const msg = JSON.parse(ev.data);
                    if (msg.type === 'tag_update') {
                        flashBadge();
                        // если открыта вкладка коллектора, дёргаем статус (writes++)
                        if (document.body.classList.contains('no-left') &&
                            document.getElementById('collectorView')?.style.display === 'flex' &&
                            window.Collector) {
                            // не зовём чаще раза в секунду
                            const now = Date.now();
                            if (!connectWs._lastBump || now - connectWs._lastBump > 1000) {
                                connectWs._lastBump = now;
                                Collector.fetchStatus();
                            }
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

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            bindTabs();
            initModules();
            connectWs();
        });
    } else {
        bindTabs();
        initModules();
        connectWs();
    }
})();
