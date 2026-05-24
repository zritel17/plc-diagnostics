/**
 * Dashboards — конструктор дашбордов поверх данных InfluxDB.
 * Виджеты: line_chart (Chart.js), gauge, stat, table.
 */
window.Dashboards = (() => {
    let dashboards = [];
    let current = null;
    let widgetCharts = new Map();
    let realtimeIntervals = new Map();
    let availableTags = [];

    const REALTIME_RANGE = '-30s';
    const REALTIME_INTERVAL_MS = 500;
    const DEFAULT_REFRESH_MS = 5000;

    function rangeLabel(r) {
        return r === 'realtime' ? '⚡ Real time' : r;
    }

    async function loadList() {
        try {
            const r = await fetch('/api/dashboard');
            dashboards = await r.json();
        } catch (e) {
            dashboards = [];
        }
        const sel = document.getElementById('dashSelect');
        if (!sel) return;
        if (dashboards.length) {
            sel.innerHTML = dashboards
                .map(d => `<option value="${d.id}">${esc(d.name)}</option>`)
                .join('');
            const id = current && dashboards.find(d => d.id === current.id)
                ? current.id
                : dashboards[0].id;
            sel.value = id;
            await loadDashboard(id);
        } else {
            sel.innerHTML = '<option value="">— no dashboards —</option>';
            current = null;
            renderGrid();
        }
    }

    async function loadDashboard(id) {
        try {
            const r = await fetch(`/api/dashboard/${id}`);
            if (!r.ok) return;
            current = await r.json();
            renderGrid();
            for (const w of current.widgets) refreshWidget(w);
        } catch (e) {
            console.error('loadDashboard:', e);
        }
    }

    async function loadAvailableTags() {
        const sel = document.getElementById('widTag');
        if (!sel) return;
        try {
            const r = await fetch('/api/data/tags');
            const data = await r.json();
            availableTags = data.tags || [];
            if (availableTags.length) {
                sel.innerHTML = availableTags
                    .map(t => `<option value="${esc(t)}">${esc(t)}</option>`)
                    .join('');
            } else {
                sel.innerHTML = `<option value="">— no data in InfluxDB${data.error ? ' (' + esc(data.error) + ')' : ''}—</option>`;
            }
        } catch (e) {
            sel.innerHTML = '<option value="">— load error —</option>';
        }
    }

    function widgetsToPayload(widgets) {
        return widgets.map(w => ({
            tag_name: w.tag_name,
            widget_type: w.widget_type,
            time_range: w.time_range,
            aggregation: w.aggregation || null,
            position_x: w.position_x ?? 0,
            position_y: w.position_y ?? 0,
            width: w.width ?? 6,
            height: w.height ?? 4,
            title: w.title || w.tag_name,
        }));
    }

    async function newDashboard() {
        const name = prompt('Dashboard name:', 'New dashboard');
        if (!name) return;
        const r = await fetch('/api/dashboard', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        });
        if (r.ok) {
            current = await r.json();
            await loadList();
        }
    }

    async function renameDashboard() {
        if (!current) return;
        const name = prompt('New name:', current.name);
        if (!name) return;
        const r = await fetch(`/api/dashboard/${current.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        });
        if (r.ok) {
            current = await r.json();
            await loadList();
        }
    }

    async function deleteDashboard() {
        if (!current) return;
        if (!confirm(`Delete dashboard "${current.name}"?`)) return;
        await fetch(`/api/dashboard/${current.id}`, { method: 'DELETE' });
        current = null;
        await loadList();
    }

    async function addWidget() {
        if (!current) {
            alert('Please create or select a dashboard first.');
            return;
        }
        const tag = document.getElementById('widTag').value;
        if (!tag) { alert('No tags in InfluxDB. Start the collector.'); return; }
        const newW = {
            tag_name: tag,
            widget_type: document.getElementById('widType').value,
            time_range: document.getElementById('widRange').value,
            aggregation: document.getElementById('widAgg').value || null,
            position_x: 0, position_y: 0,
            width: document.getElementById('widType').value === 'stat' ? 3 : 6,
            height: 4,
            title: tag,
        };
        const widgets = widgetsToPayload(current.widgets).concat([newW]);
        const r = await fetch(`/api/dashboard/${current.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ widgets }),
        });
        if (r.ok) await loadDashboard(current.id);
    }

    async function removeWidget(widgetId) {
        if (!current) return;
        const widgets = widgetsToPayload(current.widgets.filter(w => w.id !== widgetId));
        const r = await fetch(`/api/dashboard/${current.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ widgets }),
        });
        if (r.ok) await loadDashboard(current.id);
    }

    function renderGrid() {
        const grid = document.getElementById('dashGrid');
        if (!grid) return;
        widgetCharts.forEach(c => c.destroy());
        widgetCharts.clear();
        realtimeIntervals.forEach(id => clearInterval(id));
        realtimeIntervals.clear();
        if (!current) {
            grid.innerHTML = '<div class="muted" style="padding: 24px; text-align:center;">No dashboards. Create a new one.</div>';
            return;
        }
        if (!current.widgets.length) {
            grid.innerHTML = '<div class="muted" style="padding: 24px; text-align:center;">No widgets. Add one using the form above.</div>';
            return;
        }
        grid.innerHTML = current.widgets.map(w => {
            const colSpan = `grid-column: span ${Math.min(12, Math.max(2, w.width || 6))};`;
            const minH = `min-height: ${(w.height || 4) * 60}px;`;
            return `<div class="widget" style="${colSpan}${minH}" data-wid="${w.id}">
                <div class="widget-header">
                    <span class="widget-title" title="${esc(w.title || w.tag_name)}">
                        ${esc(w.title || w.tag_name)} <span class="muted">${esc(rangeLabel(w.time_range))}${w.aggregation ? ' · ' + esc(w.aggregation) : ''}</span>
                    </span>
                    <div class="widget-actions">
                        <button data-action="refresh" title="Refresh">🔄</button>
                        <button data-action="remove" title="Delete">×</button>
                    </div>
                </div>
                <div class="widget-body" id="wbody-${w.id}">
                    <div class="widget-empty">Loading…</div>
                </div>
            </div>`;
        }).join('');

        grid.querySelectorAll('.widget').forEach(elt => {
            const wid = parseInt(elt.dataset.wid, 10);
            const w = current.widgets.find(ww => ww.id === wid);
            elt.querySelector('[data-action="refresh"]').addEventListener('click', () => refreshWidget(w));
            elt.querySelector('[data-action="remove"]').addEventListener('click', () => removeWidget(wid));
        });
    }

    async function refreshWidget(w) {
        const body = document.getElementById(`wbody-${w.id}`);
        if (!body) return;

        const isRealtime = w.time_range === 'realtime';
        const effectiveRange = isRealtime ? REALTIME_RANGE : w.time_range;

        // Schedule auto-refresh
        if (!realtimeIntervals.has(w.id)) {
            const ms = isRealtime ? REALTIME_INTERVAL_MS : DEFAULT_REFRESH_MS;
            realtimeIntervals.set(w.id, setInterval(() => {
                if (document.getElementById(`wbody-${w.id}`)) refreshWidget(w);
                else {
                    clearInterval(realtimeIntervals.get(w.id));
                    realtimeIntervals.delete(w.id);
                }
            }, ms));
        }

        try {
            if (w.widget_type === 'stat') {
                const r = await fetch(`/api/data/${encodeURIComponent(w.tag_name)}/stats?from=${encodeURIComponent(effectiveRange)}`);
                const d = await r.json();
                const last = d.stats?.last;
                const mean = d.stats?.mean;
                body.innerHTML = `
                    <div style="text-align:center;">
                        <div class="stat-value">${last != null ? formatVal(last) : '—'}</div>
                        <div class="stat-meta">last · mean: ${mean != null ? formatVal(mean) : '—'}</div>
                    </div>`;
                return;
            }

            const url = `/api/data/${encodeURIComponent(w.tag_name)}/history?from=${encodeURIComponent(effectiveRange)}&max_points=20` +
                        (w.aggregation ? `&agg=${encodeURIComponent(w.aggregation)}` : '');
            const r = await fetch(url);
            const d = await r.json();
            const points = d.points || [];

            if (w.widget_type === 'table') {
                const rows = points.slice(-100).reverse().map(p => `
                    <tr><td>${new Date(p.time).toLocaleString()}</td><td>${formatVal(p.value)}</td></tr>`).join('');
                body.innerHTML = `<div style="width:100%; max-height:100%; overflow:auto;"><table class="data-table" style="width:100%">
                    <thead><tr><th>Time</th><th>Value</th></tr></thead>
                    <tbody>${rows || '<tr><td colspan="2" class="empty-row">no data</td></tr>'}</tbody>
                </table></div>`;
                return;
            }

            if (!points.length) {
                body.innerHTML = '<div class="widget-empty">No data for period</div>';
                return;
            }

            if (w.widget_type === 'gauge') {
                const last = +points[points.length - 1].value;
                const allVals = points.map(p => +p.value).filter(v => !isNaN(v));
                const min = Math.min(...allVals);
                const max = Math.max(...allVals);
                const pct = (max === min) ? 50 : Math.max(0, Math.min(100, ((last - min) / (max - min)) * 100));
                body.innerHTML = `
                    <div style="text-align:center; width:100%;">
                        <div class="stat-value">${formatVal(last)}</div>
                        <div style="background:#0f172a;height:14px;border-radius:7px;overflow:hidden;margin:10px 0;border:1px solid #334155;">
                            <div style="background:linear-gradient(90deg,#22c55e,#f59e0b,#ef4444);height:100%;width:${pct.toFixed(1)}%;"></div>
                        </div>
                        <div class="stat-meta">${formatVal(min)} … ${formatVal(max)}</div>
                    </div>`;
                return;
            }

            // line_chart
            body.innerHTML = `<canvas id="chart-${w.id}" style="width:100%; height:100%;"></canvas>`;
            const ctx = document.getElementById(`chart-${w.id}`);
            const labels = points.map(p => new Date(p.time).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }));
            const chart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels,
                    datasets: [{
                        label: w.tag_name,
                        data: points.map(p => +p.value),
                        borderColor: '#667eea',
                        backgroundColor: 'rgba(102, 126, 234, 0.15)',
                        borderWidth: 1.5,
                        pointRadius: 0,
                        tension: 0.1,
                        fill: true,
                    }],
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false,
                    interaction: { intersect: false, mode: 'index' },
                    scales: {
                        x: {
                            ticks: { color: '#94a3b8', font: { size: 10 }, maxTicksLimit: 8, autoSkip: true },
                            grid: { color: 'rgba(148, 163, 184, 0.1)' },
                        },
                        y: {
                            ticks: { color: '#94a3b8', font: { size: 10 } },
                            grid: { color: 'rgba(148, 163, 184, 0.1)' },
                        },
                    },
                    plugins: {
                        legend: { display: false },
                        tooltip: { backgroundColor: '#1e293b', borderColor: '#334155', borderWidth: 1 },
                    },
                },
            });
            widgetCharts.set(w.id, chart);
        } catch (e) {
            body.innerHTML = `<div class="widget-empty">Error: ${esc(e.message || e)}</div>`;
        }
    }

    function formatVal(v) {
        if (v == null) return '—';
        const n = Number(v);
        if (isNaN(n)) return String(v);
        if (Number.isInteger(n)) return String(n);
        return n.toFixed(2);
    }
    function esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    function init() {
        const sel = document.getElementById('dashSelect');
        if (!sel) return;
        document.getElementById('dashNewBtn').addEventListener('click', newDashboard);
        document.getElementById('dashRenameBtn').addEventListener('click', renameDashboard);
        document.getElementById('dashDeleteBtn').addEventListener('click', deleteDashboard);
        document.getElementById('dashRefreshBtn').addEventListener('click', () => current && loadDashboard(current.id));
        sel.addEventListener('change', e => {
            const id = parseInt(e.target.value, 10);
            if (id) loadDashboard(id);
        });
        document.getElementById('widAddBtn').addEventListener('click', addWidget);
    }

    return { init, loadList, loadAvailableTags };
})();
