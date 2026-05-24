window.Database = (() => {
    'use strict';

    let _autoTimer = null;
    let _loading = false;

    function init() {
        document.getElementById('dbRefreshBtn')?.addEventListener('click', () => fetchData());
        document.getElementById('dbTagSelect')?.addEventListener('change', () => fetchData());
        document.getElementById('dbRangeSelect')?.addEventListener('change', () => fetchData());
        document.getElementById('dbRowsSelect')?.addEventListener('change', () => fetchData());
        document.getElementById('dbAutoRefresh')?.addEventListener('change', (e) => {
            if (e.target.checked) startAutoRefresh();
            else stopAutoRefresh();
        });
    }

    function onShow() {
        loadTagList();
        startAutoRefresh();
    }

    function startAutoRefresh() {
        stopAutoRefresh();
        const cb = document.getElementById('dbAutoRefresh');
        if (!cb || !cb.checked) return;
        _autoTimer = setInterval(fetchData, 2000);
        fetchData();
    }

    function stopAutoRefresh() {
        if (_autoTimer) { clearInterval(_autoTimer); _autoTimer = null; }
    }

    async function loadTagList() {
        try {
            const r = await fetch('/api/data/tags');
            if (!r.ok) return;
            const d = await r.json();
            const tags = (d.tags || []).filter(Boolean).sort();
            const sel = document.getElementById('dbTagSelect');
            if (!sel) return;
            const prev = sel.value;
            sel.innerHTML = tags.length
                ? tags.map(n => `<option value="${n}"${n === prev ? ' selected' : ''}>${n}</option>`).join('')
                : '<option value="">— no data in InfluxDB —</option>';
            if (!prev && tags.length) fetchData();
        } catch (_) {}
    }

    async function fetchData() {
        if (_loading) return;
        const sel   = document.getElementById('dbTagSelect');
        const range = document.getElementById('dbRangeSelect')?.value || '-15m';
        const rows  = document.getElementById('dbRowsSelect')?.value  || '50';
        const tag   = sel?.value;
        if (!tag) return;

        _loading = true;
        setStatus('Loading…');
        try {
            const r = await fetch(`/api/data/${encodeURIComponent(tag)}/history?from=${encodeURIComponent(range)}&max_points=${rows}`);
            if (!r.ok) { setStatus('Error ' + r.status); return; }
            const d = await r.json();
            const points = (d.points || []).slice().reverse(); // newest first
            renderTable(tag, points);
            setStatus(points.length ? `${points.length} rows` : 'No data');
        } catch (e) {
            setStatus('Network error');
        } finally {
            _loading = false;
        }
    }

    function renderTable(tag, points) {
        const tbody = document.getElementById('dbTableBody');
        if (!tbody) return;
        if (!points.length) {
            tbody.innerHTML = '<tr><td colspan="2" class="empty-row">No data for selected range</td></tr>';
            return;
        }
        tbody.innerHTML = points.map(p => {
            const ts = new Date(p.time).toLocaleString(undefined, {
                year: '2-digit', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit'
            });
            const val = p.value != null ? p.value : '—';
            return `<tr><td style="font-family:monospace; font-size:12px; white-space:nowrap;">${ts}</td><td>${val}</td></tr>`;
        }).join('');
    }

    function setStatus(msg) {
        const el = document.getElementById('dbStatus');
        if (el) el.textContent = msg;
    }

    return { init, onShow };
})();
