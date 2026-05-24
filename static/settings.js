window.Settings = (() => {
    let _loaded = false;

    function init() {
        document.getElementById('settingsSaveBtn')?.addEventListener('click', save);
        document.getElementById('settingsDbRefreshBtn')?.addEventListener('click', loadDbStats);
    }

    function onShow() {
        if (!_loaded) {
            _loaded = true;
            load();
            loadDbStats();
        }
    }

    async function load() {
        try {
            const r = await fetch('/api/settings', { headers: _authHeader() });
            if (!r.ok) return;
            const d = await r.json();
            _set('settingsPlcIp',        d.plc_ip || '');
            _set('settingsPlcSlot',      d.plc_slot ?? 0);
            _set('settingsPollInterval', d.poll_interval_ms ?? 100);
            _setCheck('settingsAutostart', d.autostart);
            _set('settingsOllamaUrl',    d.ollama_url || '');
            _set('settingsAiModel',      d.ai_model || '');
        } catch (e) {
            console.error('Settings load error', e);
        }
    }

    async function save() {
        const btn = document.getElementById('settingsSaveBtn');
        if (btn) btn.disabled = true;
        try {
            const payload = {
                plc_ip:          document.getElementById('settingsPlcIp')?.value.trim() || null,
                plc_slot:        parseInt(document.getElementById('settingsPlcSlot')?.value || '0', 10),
                poll_interval_ms: parseInt(document.getElementById('settingsPollInterval')?.value || '100', 10),
                autostart:       document.getElementById('settingsAutostart')?.checked || false,
                ollama_url:      document.getElementById('settingsOllamaUrl')?.value.trim() || null,
                ai_model:        document.getElementById('settingsAiModel')?.value.trim() || null,
            };
            const r = await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ..._authHeader() },
                body: JSON.stringify(payload),
            });
            if (r.ok) {
                _flash('settingsSaveStatus', 'Saved', 'var(--success)');
            } else {
                _flash('settingsSaveStatus', 'Error saving', 'var(--danger)');
            }
        } catch (e) {
            _flash('settingsSaveStatus', 'Network error', 'var(--danger)');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    async function loadDbStats() {
        const el = document.getElementById('settingsDbStats');
        if (!el) return;
        el.textContent = 'Loading…';
        try {
            const r = await fetch('/api/db/stats', { headers: _authHeader() });
            if (!r.ok) { el.textContent = 'Error fetching stats'; return; }
            const d = await r.json();
            const lines = [];
            lines.push(`InfluxDB: ${d.available ? '✓ Connected' : '✗ Unavailable'}`);
            if (d.error && !d.available) lines.push(`  Error: ${d.error}`);
            lines.push(`Tags configured (SQLite): ${d.tags_configured}`);
            lines.push(`Tags with data (InfluxDB): ${d.tags_with_data}`);
            if (d.oldest) lines.push(`Data from: ${_fmtTime(d.oldest)}`);
            if (d.newest) lines.push(`Data to:   ${_fmtTime(d.newest)}`);
            if (!d.oldest && d.available) lines.push('No data collected yet');
            el.textContent = lines.join('\n');
        } catch (e) {
            el.textContent = 'Network error';
        }
    }

    function _set(id, val) {
        const el = document.getElementById(id);
        if (el) el.value = val;
    }

    function _setCheck(id, val) {
        const el = document.getElementById(id);
        if (el) el.checked = !!val;
    }

    function _flash(id, msg, color) {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = msg;
        el.style.color = color;
        setTimeout(() => { el.textContent = ''; }, 3000);
    }

    function _fmtTime(iso) {
        try {
            return new Date(iso).toLocaleString();
        } catch { return iso; }
    }

    function _authHeader() {
        const token = localStorage.getItem('plc_token') || '';
        return token ? { 'Authorization': `Bearer ${token}` } : {};
    }

    return { init, onShow };
})();
