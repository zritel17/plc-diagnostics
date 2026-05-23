/**
 * Collector — статус и управление коллектором.
 * Зависит от элементов с id: collState, collPlcIp, collPolls, collWrites,
 * collErrors, collInflux, collLastError, collStartBtn, collStopBtn,
 * collIpInput, collSlotInput, collPollInput, collAutostart, collSaveSettingsBtn,
 * collectorBadge.
 */
window.Collector = (() => {
    let statusTimer = null;
    let lastStats = null;

    async function fetchStatus() {
        try {
            const r = await fetch('/api/collector/status');
            if (!r.ok) return;
            const s = await r.json();
            lastStats = s;
            renderStatus(s);
            updateHeaderBadge(s);
        } catch (e) {
            console.error('collector status:', e);
        }
    }

    function renderStatus(s) {
        const stateEl = document.getElementById('collState');
        if (!stateEl) return;
        stateEl.textContent = s.running ? '● Running' : '■ Stopped';
        stateEl.className = 'status-value ' + (s.running ? 'running' : 'stopped');
        document.getElementById('collPlcIp').textContent = s.plc_ip || '—';
        document.getElementById('collPolls').textContent = s.polls;
        document.getElementById('collWrites').textContent = s.writes;
        document.getElementById('collErrors').textContent = s.errors;
        const inflEl = document.getElementById('collInflux');
        inflEl.textContent = s.influx_available ? 'OK' : 'unavailable';
        inflEl.className = 'status-value ' + (s.influx_available ? 'running' : 'warn');
        const errEl = document.getElementById('collLastError');
        errEl.textContent = s.last_error ? `⚠ ${s.last_error}` : '';
        errEl.style.color = s.last_error ? '#f87171' : '';
    }

    function updateHeaderBadge(s) {
        const b = document.getElementById('collectorBadge');
        if (!b) return;
        if (s.running) {
            b.textContent = `▶ ${s.writes}`;
            b.className = 'running';
        } else {
            b.textContent = '■';
            b.className = 'stopped';
        }
    }

    async function loadSettings() {
        try {
            const r = await fetch('/api/collector/settings');
            const s = await r.json();
            document.getElementById('collIpInput').value = s.plc_ip || '';
            document.getElementById('collSlotInput').value = s.plc_slot ?? 0;
            document.getElementById('collPollInput').value = s.poll_interval_ms ?? 100;
            document.getElementById('collAutostart').checked = !!s.autostart;
        } catch (e) {
            console.error('collector settings load:', e);
        }
    }

    async function saveSettings() {
        const payload = {
            autostart: document.getElementById('collAutostart').checked ? 1 : 0,
            poll_interval_ms: parseInt(document.getElementById('collPollInput').value, 10) || 100,
            plc_ip: document.getElementById('collIpInput').value.trim() || null,
            plc_slot: parseInt(document.getElementById('collSlotInput').value, 10) || 0,
        };
        try {
            const r = await fetch('/api/collector/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (r.ok) toast('Settings saved', 'success');
            else toast('Save error', 'error');
        } catch (e) {
            toast(`Error: ${e.message}`, 'error');
        }
    }

    async function start() {
        try {
            const r = await fetch('/api/collector/start', { method: 'POST' });
            const j = await r.json();
            toast(`Collector: ${j.status || 'ok'}`, 'success');
            setTimeout(fetchStatus, 500);
        } catch (e) {
            toast(`Error: ${e.message}`, 'error');
        }
    }

    async function stop() {
        try {
            const r = await fetch('/api/collector/stop', { method: 'POST' });
            const j = await r.json();
            toast(`Collector: ${j.status || 'ok'}`, 'success');
            setTimeout(fetchStatus, 500);
        } catch (e) {
            toast(`Error: ${e.message}`, 'error');
        }
    }

    function toast(msg, type) {
        const c = document.getElementById('alertContainer');
        if (!c) { console.log(msg); return; }
        const div = document.createElement('div');
        div.className = `alert alert-${type || 'info'}`;
        div.textContent = msg;
        c.appendChild(div);
        setTimeout(() => div.remove(), 3500);
    }

    function init() {
        const startBtn = document.getElementById('collStartBtn');
        const stopBtn = document.getElementById('collStopBtn');
        const saveBtn = document.getElementById('collSaveSettingsBtn');
        if (!startBtn) return;
        startBtn.addEventListener('click', start);
        stopBtn.addEventListener('click', stop);
        saveBtn.addEventListener('click', saveSettings);
        loadSettings();
        fetchStatus();
        if (statusTimer) clearInterval(statusTimer);
        statusTimer = setInterval(fetchStatus, 2000);
    }

    return { init, fetchStatus, loadSettings, getStats: () => lastStats };
})();
