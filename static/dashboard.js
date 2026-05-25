/**
 * Dashboards — конструктор дашбордов поверх данных InfluxDB.
 * Виджеты: line_chart, gauge, stat, table, boolean.
 */
window.Dashboards = (() => {
    let dashboards = [];
    let current = null;
    let widgetCharts = new Map();
    let realtimeIntervals = new Map();
    let availableTags = [];
    let _editingWidgetId = null;
    let _refreshTimer = null;

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

    // Map a widget to the batch data type it consumes.
    function widgetDataType(w) {
        if (w.widget_type === 'stat' && w.aggregation === 'delta') return 'delta';
        const map = {
            line_chart: 'history', table: 'history', gauge: 'history', boolean: 'history',
            stat: 'stats', bar_chart: 'bars', state_timeline: 'timeline', donut: 'uptime',
        };
        return map[w.widget_type] || 'history';
    }

    // One POST /api/data/batch for all widgets; returns Map<widgetId, prefetched>
    // where each prefetched object matches the shape the widget branch expects.
    async function loadAllWidgetData(widgets) {
        const items = widgets.map(w => {
            const eff  = w.time_range === 'realtime' ? REALTIME_RANGE : w.time_range;
            const type = widgetDataType(w);
            return {
                tag:        w.tag_name,
                type,
                range:      String(eff).replace(/^-/, ''),
                agg:        type === 'history' ? (w.aggregation || '') : (w.aggregation || 'mean'),
                window:     w.bar_window || '8h',
                count:      w.bar_count || 7,
                max_points: type === 'history' ? Math.max(10, Math.min(2000, w.max_points ?? 100)) : 200,
            };
        });
        const byId = new Map();
        let results;
        try {
            const r = await fetch('/api/data/batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ items }),
            });
            results = (await r.json()).results || {};
        } catch (e) {
            return byId;  // fall back to per-widget fetches
        }
        for (const w of widgets) {
            const type = widgetDataType(w);
            const raw  = results[`${w.tag_name}::${type}`];
            if (raw === undefined || (raw && raw.error)) continue;
            if (type === 'history')       byId.set(w.id, { points: raw || [] });
            else if (type === 'stats')    byId.set(w.id, { stats: raw || {} });
            else if (type === 'timeline') byId.set(w.id, { events: raw || [] });
            else                          byId.set(w.id, raw || {});
        }
        return byId;
    }

    async function loadDashboard(id) {
        try {
            const r = await fetch(`/api/dashboard/${id}`);
            if (!r.ok) return;
            current = await r.json();
            renderGrid();
            const prefetch = await loadAllWidgetData(current.widgets);
            for (const w of current.widgets) refreshWidget(w, prefetch.get(w.id));
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
                sel.innerHTML = `<option value="">— no data in InfluxDB${data.error ? ' (' + esc(data.error) + ')' : ''} —</option>`;
            }
        } catch (e) {
            sel.innerHTML = '<option value="">— load error —</option>';
        }
    }

    function widgetsToPayload(widgets) {
        return widgets.map(w => ({
            tag_name:     w.tag_name,
            widget_type:  w.widget_type,
            time_range:   w.time_range,
            aggregation:  w.aggregation || null,
            position_x:   w.position_x ?? 0,
            position_y:   w.position_y ?? 0,
            width:         w.width ?? 6,
            height:        w.height ?? 4,
            title:         w.title || w.tag_name,
            gauge_min:     w.gauge_min ?? null,
            gauge_max:     w.gauge_max ?? null,
            threshold_hh:  w.threshold_hh ?? null,
            threshold_h:   w.threshold_h  ?? null,
            threshold_l:   w.threshold_l  ?? null,
            threshold_ll:  w.threshold_ll ?? null,
            max_points:    w.max_points ?? 100,
            color:         w.color || null,
            bar_window:    w.bar_window || null,
            bar_count:     w.bar_count ?? 7,
        }));
    }

    function parseOptionalFloat(id) {
        const v = document.getElementById(id)?.value?.trim();
        if (!v) return null;
        const f = parseFloat(v);
        return isNaN(f) ? null : f;
    }

    function readFormWidget() {
        const type = document.getElementById('widType').value;
        return {
            tag_name:     document.getElementById('widTag').value,
            widget_type:  type,
            time_range:   document.getElementById('widRange').value,
            aggregation:  document.getElementById('widAgg').value || null,
            position_x:   0,
            position_y:   0,
            width:         type === 'stat' || type === 'boolean' ? 3 : 6,
            height:        4,
            title:         document.getElementById('widTag').value,
            gauge_min:     parseOptionalFloat('wGaugeMin'),
            gauge_max:     parseOptionalFloat('wGaugeMax'),
            threshold_hh:  parseOptionalFloat('wThresholdHH'),
            threshold_h:   parseOptionalFloat('wThresholdH'),
            threshold_l:   parseOptionalFloat('wThresholdL'),
            threshold_ll:  parseOptionalFloat('wThresholdLL'),
            max_points:    Math.max(10, Math.min(2000, parseInt(document.getElementById('wMaxPoints')?.value || '100', 10))),
            color:         document.getElementById('wColor')?.value || null,
            bar_window:    document.getElementById('wBarWindow')?.value || null,
            bar_count:     Math.max(2, Math.min(60, parseInt(document.getElementById('wBarCount')?.value || '7', 10))),
        };
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
        if (r.ok) { current = await r.json(); await loadList(); }
    }

    async function deleteDashboard() {
        if (!current) return;
        if (!confirm(`Delete dashboard "${current.name}"?`)) return;
        await fetch(`/api/dashboard/${current.id}`, { method: 'DELETE' });
        current = null;
        await loadList();
    }

    async function addWidget() {
        if (!current) { alert('Please create or select a dashboard first.'); return; }
        const tag = document.getElementById('widTag').value;
        if (!tag) { alert('No tags in InfluxDB. Start the collector.'); return; }

        const formW = readFormWidget();
        let widgets;

        if (_editingWidgetId !== null) {
            // Edit mode: replace widget in-place, keep its id/position
            widgets = widgetsToPayload(current.widgets.map(w => {
                if (w.id !== _editingWidgetId) return w;
                return { ...w, ...formW, position_x: w.position_x, position_y: w.position_y };
            }));
            cancelEdit();
        } else {
            widgets = widgetsToPayload(current.widgets).concat([formW]);
        }

        const r = await fetch(`/api/dashboard/${current.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ widgets }),
        });
        if (r.ok) await loadDashboard(current.id);
    }

    function editWidget(id) {
        const w = current?.widgets.find(x => x.id === id);
        if (!w) return;
        _editingWidgetId = id;
        // Populate form
        const setVal = (elId, val) => { const el = document.getElementById(elId); if (el) el.value = val ?? ''; };
        setVal('widTag',        w.tag_name);
        setVal('widType',       w.widget_type);
        setVal('widRange',      w.time_range);
        setVal('widAgg',        w.aggregation || '');
        setVal('wMaxPoints',    w.max_points ?? 100);
        setVal('wColor',        w.color || '#667eea');
        setVal('wGaugeMin',     w.gauge_min  ?? '');
        setVal('wGaugeMax',     w.gauge_max  ?? '');
        setVal('wThresholdHH',  w.threshold_hh ?? '');
        setVal('wThresholdH',   w.threshold_h  ?? '');
        setVal('wThresholdL',   w.threshold_l  ?? '');
        setVal('wThresholdLL',  w.threshold_ll ?? '');
        setVal('wBarWindow',    w.bar_window || '8h');
        setVal('wBarCount',     w.bar_count ?? 7);
        const addBtn = document.getElementById('widAddBtn');
        if (addBtn) addBtn.textContent = 'Save changes';
        const cancelBtn = document.getElementById('widCancelEditBtn');
        if (cancelBtn) cancelBtn.style.display = '';
        updateTypeOptions();
        document.getElementById('widTag')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function cancelEdit() {
        _editingWidgetId = null;
        const addBtn = document.getElementById('widAddBtn');
        if (addBtn) addBtn.textContent = '+ Add';
        const cancelBtn = document.getElementById('widCancelEditBtn');
        if (cancelBtn) cancelBtn.style.display = 'none';
    }

    function updateTypeOptions() {
        const type = document.getElementById('widType')?.value;
        const gaugeRow = document.getElementById('wGaugeRow');
        const threshRow = document.getElementById('wThresholdRow');
        const barRow = document.getElementById('wBarRow');
        if (gaugeRow)  gaugeRow.style.display  = type === 'gauge' ? '' : 'none';
        if (threshRow) threshRow.style.display = (type === 'line_chart' || type === 'gauge') ? '' : 'none';
        if (barRow)    barRow.style.display    = type === 'bar_chart' ? '' : 'none';
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
            grid.innerHTML = '<div class="muted" style="padding:24px;text-align:center;">No dashboards. Create a new one.</div>';
            return;
        }
        if (!current.widgets.length) {
            grid.innerHTML = '<div class="muted" style="padding:24px;text-align:center;">No widgets. Add one using the form above.</div>';
            return;
        }
        grid.innerHTML = current.widgets.map(w => {
            const colSpan = `grid-column: span ${Math.min(12, Math.max(2, w.width || 6))};`;
            const minH    = `min-height: ${(w.height || 4) * 60}px;`;
            const agg     = w.aggregation ? ` · ${esc(w.aggregation)}` : '';
            const thStr   = [
                w.threshold_hh != null ? `HH:${w.threshold_hh}` : '',
                w.threshold_h  != null ? `H:${w.threshold_h}`   : '',
                w.threshold_l  != null ? `L:${w.threshold_l}`   : '',
                w.threshold_ll != null ? `LL:${w.threshold_ll}` : '',
            ].filter(Boolean).join(' ');
            return `<div class="widget" style="${colSpan}${minH}" data-wid="${w.id}">
                <div class="widget-header">
                    <span class="widget-title" title="${esc(w.title || w.tag_name)}">
                        ${esc(w.title || w.tag_name)}
                        <span class="muted">${esc(rangeLabel(w.time_range))}${agg}${thStr ? ' · ' + esc(thStr) : ''}</span>
                    </span>
                    <div class="widget-actions">
                        <button data-action="refresh" title="Refresh">🔄</button>
                        <button data-action="edit" title="Edit">✏</button>
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
            const w   = current.widgets.find(ww => ww.id === wid);
            elt.querySelector('[data-action="refresh"]').addEventListener('click', () => refreshWidget(w));
            elt.querySelector('[data-action="edit"]').addEventListener('click',    () => editWidget(wid));
            elt.querySelector('[data-action="remove"]').addEventListener('click',  () => removeWidget(wid));
        });
    }

    async function refreshWidget(w, prefetched) {
        const body = document.getElementById(`wbody-${w.id}`);
        if (!body) return;

        const isRealtime    = w.time_range === 'realtime';
        const effectiveRange = isRealtime ? REALTIME_RANGE : w.time_range;

        if (!realtimeIntervals.has(w.id)) {
            const ms = isRealtime ? REALTIME_INTERVAL_MS : DEFAULT_REFRESH_MS;
            realtimeIntervals.set(w.id, setInterval(() => {
                if (document.getElementById(`wbody-${w.id}`)) refreshWidget(w);
                else { clearInterval(realtimeIntervals.get(w.id)); realtimeIntervals.delete(w.id); }
            }, ms));
        }

        const mp = Math.max(10, Math.min(2000, w.max_points ?? 100));

        try {
            // ── boolean ──────────────────────────────────────────────────────
            if (w.widget_type === 'boolean') {
                const d = prefetched || await (await fetch(`/api/data/${encodeURIComponent(w.tag_name)}/history?from=${encodeURIComponent(effectiveRange)}&max_points=1`)).json();
                const last  = d.points?.[d.points.length - 1]?.value;
                const isOn  = last !== null && last !== undefined && +last !== 0;
                const clr   = isOn ? '#22c55e' : '#ef4444';
                body.innerHTML = `
                    <div style="display:flex;align-items:center;justify-content:center;height:100%;
                                background:${clr}22;border-radius:8px;border:2px solid ${clr};">
                        <div style="text-align:center;">
                            <div style="font-size:36px;color:${clr};font-weight:700;letter-spacing:3px;">${isOn ? 'ON' : 'OFF'}</div>
                            <div style="font-size:12px;color:var(--fg-muted);margin-top:6px;">${formatVal(last)}</div>
                        </div>
                    </div>`;
                return;
            }

            // ── stat ─────────────────────────────────────────────────────────
            if (w.widget_type === 'stat') {
                if (w.aggregation === 'delta') {
                    const rng = effectiveRange.replace(/^-/, '');
                    const d = prefetched || await (await fetch(`/api/data/${encodeURIComponent(w.tag_name)}/delta?range=${encodeURIComponent(rng)}`)).json();
                    const has = d.delta != null;
                    body.innerHTML = `
                        <div style="text-align:center;">
                            <div class="stat-value">${has ? formatVal(d.delta) : '—'}</div>
                            <div class="stat-meta">Δ ${rangeLabel(w.time_range)}${has ? ` · ${formatVal(d.first)} → ${formatVal(d.last)}` : ''}</div>
                        </div>`;
                    return;
                }
                const d = prefetched || await (await fetch(`/api/data/${encodeURIComponent(w.tag_name)}/stats?from=${encodeURIComponent(effectiveRange)}`)).json();
                const last = d.stats?.last;
                const mean = d.stats?.mean;
                body.innerHTML = `
                    <div style="text-align:center;">
                        <div class="stat-value">${last != null ? formatVal(last) : '—'}</div>
                        <div class="stat-meta">last · mean: ${mean != null ? formatVal(mean) : '—'}</div>
                    </div>`;
                return;
            }

            // ── bar_chart ─────────────────────────────────────────────────────
            if (w.widget_type === 'bar_chart') {
                const win   = w.bar_window || '8h';
                const cnt   = w.bar_count ?? 7;
                const bAgg  = w.aggregation === 'delta' ? 'delta' : (w.aggregation || 'mean');
                const d = prefetched || await (await fetch(`/api/data/${encodeURIComponent(w.tag_name)}/bars?window=${encodeURIComponent(win)}&count=${cnt}&agg=${encodeURIComponent(bAgg)}`)).json();
                const labels = d.labels || [];
                const values = d.values || [];
                if (!labels.length) {
                    body.innerHTML = '<div class="widget-empty">No data for period</div>';
                    return;
                }
                const fill = bAgg === 'delta' ? 'rgba(34, 197, 94, 0.7)' : (w.color || 'rgba(59, 130, 246, 0.7)');
                const existing = widgetCharts.get(w.id);
                if (existing && existing._tagName === w.tag_name && existing.config.type === 'bar') {
                    existing.data.labels = labels;
                    existing.data.datasets[0].data = values;
                    existing.update('none');
                    return;
                }
                if (existing) existing.destroy();
                body.innerHTML = `<canvas id="chart-${w.id}" style="width:100%;height:100%;"></canvas>`;
                const chart = new Chart(document.getElementById(`chart-${w.id}`), {
                    type: 'bar',
                    data: { labels, datasets: [{ label: w.title || w.tag_name, data: values, backgroundColor: fill, borderRadius: 4 }] },
                    options: {
                        responsive: true, maintainAspectRatio: false, animation: false,
                        scales: {
                            x: { ticks: { color: '#94a3b8', font: { size: 10 }, maxTicksLimit: 12 }, grid: { display: false } },
                            y: { beginAtZero: true, ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { color: 'rgba(148,163,184,0.1)' } },
                        },
                        plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1e293b', borderColor: '#334155', borderWidth: 1 } },
                    },
                });
                chart._tagName = w.tag_name;
                widgetCharts.set(w.id, chart);
                return;
            }

            // ── donut (uptime %) ──────────────────────────────────────────────
            if (w.widget_type === 'donut') {
                const rng = effectiveRange.replace(/^-/, '');
                const d = prefetched || await (await fetch(`/api/data/${encodeURIComponent(w.tag_name)}/uptime?range=${encodeURIComponent(rng)}`)).json();
                if (d.uptime_pct == null) {
                    body.innerHTML = '<div class="widget-empty">No data for period</div>';
                    return;
                }
                const up = d.uptime_pct, down = d.downtime_pct;
                const existing = widgetCharts.get(w.id);
                if (existing && existing.config.type === 'doughnut') {
                    existing.data.datasets[0].data = [up, down];
                    existing.$uptimePct = up;
                    existing.update('none');
                    return;
                }
                if (existing) existing.destroy();
                body.innerHTML = `<canvas id="chart-${w.id}" style="width:100%;height:100%;"></canvas>`;
                const centerText = {
                    id: 'centerText',
                    afterDraw(chart) {
                        const { ctx, chartArea: { left, right, top, bottom } } = chart;
                        ctx.save();
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        ctx.fillStyle = '#22c55e';
                        ctx.font = '700 22px Inter, sans-serif';
                        ctx.fillText((chart.$uptimePct ?? 0) + '%', (left + right) / 2, (top + bottom) / 2);
                        ctx.restore();
                    },
                };
                const chart = new Chart(document.getElementById(`chart-${w.id}`), {
                    type: 'doughnut',
                    data: {
                        labels: ['Uptime', 'Downtime'],
                        datasets: [{ data: [up, down], backgroundColor: ['#22c55e', '#e5e7eb'], borderWidth: 0 }],
                    },
                    options: {
                        responsive: true, maintainAspectRatio: false, animation: false, cutout: '70%',
                        plugins: {
                            legend: { position: 'bottom', labels: { color: '#94a3b8', boxWidth: 12, font: { size: 10 } } },
                            tooltip: { backgroundColor: '#1e293b', borderColor: '#334155', borderWidth: 1 },
                        },
                    },
                    plugins: [centerText],
                });
                chart.$uptimePct = up;
                widgetCharts.set(w.id, chart);
                return;
            }

            // ── state_timeline ────────────────────────────────────────────────
            if (w.widget_type === 'state_timeline') {
                const rng = effectiveRange.replace(/^-/, '');
                const d = prefetched || await (await fetch(`/api/data/${encodeURIComponent(w.tag_name)}/timeline?range=${encodeURIComponent(rng)}`)).json();
                body.innerHTML = `<div style="width:100%;height:100%;"><canvas id="tl-${w.id}" style="width:100%;height:100%;display:block;"></canvas></div>`;
                renderTimeline(document.getElementById(`tl-${w.id}`), d.events || [], rangeToMs(effectiveRange));
                return;
            }

            // ── fetch history (table / gauge / line_chart) ────────────────────
            let d;
            if (prefetched) {
                d = prefetched;
            } else {
                const url = `/api/data/${encodeURIComponent(w.tag_name)}/history?from=${encodeURIComponent(effectiveRange)}&max_points=${mp}` +
                            (w.aggregation ? `&agg=${encodeURIComponent(w.aggregation)}` : '');
                d = await (await fetch(url)).json();
            }
            const points = d.points || [];

            // ── table ─────────────────────────────────────────────────────────
            if (w.widget_type === 'table') {
                const TABLE_MAX_ROWS = 50;
                const recent = points.slice(-TABLE_MAX_ROWS).reverse();  // newest first, capped
                const rows = recent.map(p => `
                    <tr><td>${new Date(p.time).toLocaleString()}</td><td>${formatVal(p.value)}</td></tr>`).join('');
                const note = points.length > TABLE_MAX_ROWS
                    ? `<div class="stat-meta" style="padding:4px 8px;">showing last ${TABLE_MAX_ROWS} of ${points.length}</div>`
                    : '';
                body.innerHTML = `<div style="width:100%;max-height:100%;overflow:auto;">
                    <table class="data-table" style="width:100%">
                        <thead><tr><th>Time</th><th>Value</th></tr></thead>
                        <tbody>${rows || '<tr><td colspan="2" class="empty-row">no data</td></tr>'}</tbody>
                    </table>${note}</div>`;
                return;
            }

            if (!points.length) {
                body.innerHTML = '<div class="widget-empty">No data for period</div>';
                return;
            }

            // ── gauge ─────────────────────────────────────────────────────────
            if (w.widget_type === 'gauge') {
                const last    = +points[points.length - 1].value;
                const allVals = points.map(p => +p.value).filter(v => !isNaN(v));
                const min     = w.gauge_min != null ? +w.gauge_min : Math.min(...allVals);
                const max     = w.gauge_max != null ? +w.gauge_max : Math.max(...allVals);
                const span    = max - min;
                const pct     = (span === 0) ? 50 : Math.max(0, Math.min(100, ((last - min) / span) * 100));
                const clr     = w.color || null;

                // Threshold zones (only thresholds that fall inside min..max are drawn)
                const th = {
                    hh: w.threshold_hh != null ? +w.threshold_hh : null,
                    h:  w.threshold_h  != null ? +w.threshold_h  : null,
                    l:  w.threshold_l  != null ? +w.threshold_l  : null,
                    ll: w.threshold_ll != null ? +w.threshold_ll : null,
                };
                const hasZones = th.hh != null || th.h != null || th.l != null || th.ll != null;

                const zoneColor = (v) => {
                    if (th.hh != null && v >= th.hh) return '#ef4444';
                    if (th.h  != null && v >= th.h)  return '#f59e0b';
                    if (th.ll != null && v <= th.ll) return '#ef4444';
                    if (th.l  != null && v <= th.l)  return '#f59e0b';
                    return '#22c55e';
                };
                const toPct = (v) => (span === 0 ? 0 : Math.max(0, Math.min(100, ((v - min) / span) * 100)));

                let trackInner;
                if (hasZones) {
                    const bounds = [min, max];
                    [th.ll, th.l, th.h, th.hh].forEach(v => {
                        if (v != null && v > min && v < max) bounds.push(v);
                    });
                    bounds.sort((a, b) => a - b);
                    let segs = '';
                    for (let i = 0; i < bounds.length - 1; i++) {
                        const a = bounds[i], b = bounds[i + 1];
                        if (b <= a) continue;
                        const col = zoneColor((a + b) / 2);
                        segs += `<div style="position:absolute;top:0;bottom:0;left:${toPct(a).toFixed(1)}%;width:${(toPct(b) - toPct(a)).toFixed(1)}%;background:${col};opacity:0.45;"></div>`;
                    }
                    trackInner = segs +
                        `<div style="position:absolute;top:-3px;bottom:-3px;left:${pct.toFixed(1)}%;width:3px;background:var(--fg,#e2e8f0);border-radius:2px;transform:translateX(-50%);"></div>`;
                } else {
                    const barStyle = clr
                        ? `background:${clr};`
                        : 'background:linear-gradient(90deg,#22c55e,#f59e0b,#ef4444);';
                    trackInner = `<div style="${barStyle}height:100%;width:${pct.toFixed(1)}%;transition:width 0.3s;"></div>`;
                }
                const valColor = hasZones ? zoneColor(last) : 'var(--fg)';
                body.innerHTML = `
                    <div style="text-align:center;width:100%;">
                        <div class="stat-value" style="color:${valColor};">${formatVal(last)}</div>
                        <div style="position:relative;background:#0f172a;height:14px;border-radius:7px;overflow:hidden;margin:10px 0;border:1px solid #334155;">
                            ${trackInner}
                        </div>
                        <div class="stat-meta">${formatVal(min)} … ${formatVal(max)}</div>
                    </div>`;
                return;
            }

            // ── line_chart ────────────────────────────────────────────────────
            const color   = w.color || '#667eea';
            const bgColor = color + '26';
            const labels  = points.map(p => new Date(p.time).toLocaleString(undefined, {
                hour: '2-digit', minute: '2-digit', second: '2-digit'
            }));

            const threshDefs = [
                { key: 'threshold_hh', label: 'HH', color: '#ef4444' },
                { key: 'threshold_h',  label: 'H',  color: '#f59e0b' },
                { key: 'threshold_l',  label: 'L',  color: '#3b82f6' },
                { key: 'threshold_ll', label: 'LL', color: '#8b5cf6' },
            ];
            const thresholdDatasets = threshDefs
                .filter(t => w[t.key] != null)
                .map(t => ({
                    label:       t.label,
                    data:        Array(points.length).fill(+w[t.key]),
                    borderColor: t.color,
                    borderWidth: 1.5,
                    borderDash:  [6, 3],
                    pointRadius: 0,
                    fill:        false,
                    tension:     0,
                }));

            const hasThresholds = thresholdDatasets.length > 0;
            const existing = widgetCharts.get(w.id);
            if (existing && existing._tagName === w.tag_name) {
                existing.data.labels = labels;
                existing.data.datasets[0].data = points.map(p => +p.value);
                thresholdDatasets.forEach((td, i) => {
                    if (existing.data.datasets[i + 1]) existing.data.datasets[i + 1].data = td.data;
                });
                existing.update('none');
                return;
            }
            if (existing) existing.destroy();
            body.innerHTML = `<canvas id="chart-${w.id}" style="width:100%;height:100%;"></canvas>`;
            const ctx   = document.getElementById(`chart-${w.id}`);
            const chart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels,
                    datasets: [
                        {
                            label:           w.title || w.tag_name,
                            data:            points.map(p => +p.value),
                            borderColor:     color,
                            backgroundColor: bgColor,
                            borderWidth:     1.5,
                            pointRadius:     0,
                            tension:         0.1,
                            fill:            true,
                        },
                        ...thresholdDatasets,
                    ],
                },
                options: {
                    responsive:          true,
                    maintainAspectRatio: false,
                    animation:           false,
                    interaction:         { intersect: false, mode: 'index' },
                    scales: {
                        x: {
                            ticks: { color: '#94a3b8', font: { size: 10 }, maxTicksLimit: 8, autoSkip: true },
                            grid:  { color: 'rgba(148,163,184,0.1)' },
                        },
                        y: {
                            ticks: { color: '#94a3b8', font: { size: 10 } },
                            grid:  { color: 'rgba(148,163,184,0.1)' },
                        },
                    },
                    plugins: {
                        legend:  { display: hasThresholds, labels: { color: '#94a3b8', boxWidth: 20, font: { size: 11 } } },
                        tooltip: { backgroundColor: '#1e293b', borderColor: '#334155', borderWidth: 1 },
                    },
                },
            });
            chart._tagName = w.tag_name;
            widgetCharts.set(w.id, chart);
        } catch (e) {
            body.innerHTML = `<div class="widget-empty">Error: ${esc(e.message || e)}</div>`;
        }
    }

    function rangeToMs(r) {
        const m = String(r).match(/-?(\d+)([smhd])/);
        if (!m) return 3600000;
        return (+m[1]) * ({ s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]]);
    }

    function renderTimeline(canvas, events, rangeMs) {
        const ctx = canvas.getContext('2d');
        const W = canvas.offsetWidth || canvas.width;
        const H = canvas.offsetHeight || canvas.height;
        canvas.width = W; canvas.height = H;
        ctx.clearRect(0, 0, W, H);

        if (!events || events.length < 2) {
            ctx.fillStyle = '#9ca3af';
            ctx.font = '12px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('No data', W / 2, H / 2);
            return;
        }

        const now = Date.now();
        const start = now - rangeMs;

        for (let i = 0; i < events.length - 1; i++) {
            const ev = events[i], next = events[i + 1];
            const x1 = Math.max(0, ((ev.ts - start) / rangeMs) * W);
            const x2 = Math.min(W, ((next.ts - start) / rangeMs) * W);
            if (x2 <= x1) continue;
            ctx.fillStyle = ev.value ? '#22c55e' : '#e5e7eb';
            ctx.fillRect(x1, 4, x2 - x1 - 1, H - 22);
        }
        // Последний сегмент до now
        const last = events[events.length - 1];
        const xLast = Math.max(0, ((last.ts - start) / rangeMs) * W);
        ctx.fillStyle = last.value ? '#22c55e' : '#e5e7eb';
        ctx.fillRect(xLast, 4, W - xLast, H - 22);

        // Подписи времени по краям
        ctx.fillStyle = '#6b7280';
        ctx.font = '10px Inter, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(new Date(start).toLocaleTimeString(), 2, H - 4);
        ctx.textAlign = 'right';
        ctx.fillText(new Date(now).toLocaleTimeString(), W - 2, H - 4);
    }

    function formatVal(v) {
        if (v == null) return '—';
        const n = Number(v);
        if (isNaN(n)) return String(v);
        if (Number.isInteger(n)) return String(n);
        return n.toFixed(2);
    }
    function esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function setAutoRefresh(seconds) {
        if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
        if (seconds > 0) {
            _refreshTimer = setInterval(() => { if (current) loadDashboard(current.id); }, seconds * 1000);
        }
        localStorage.setItem('plc_dash_autorefresh', String(seconds));
    }

    function init() {
        const sel = document.getElementById('dashSelect');
        if (!sel) return;
        document.getElementById('dashNewBtn').addEventListener('click', newDashboard);
        document.getElementById('dashRenameBtn').addEventListener('click', renameDashboard);
        document.getElementById('dashDeleteBtn').addEventListener('click', deleteDashboard);
        document.getElementById('dashRefreshBtn').addEventListener('click', () => current && loadDashboard(current.id));
        sel.addEventListener('change', e => { const id = parseInt(e.target.value, 10); if (id) loadDashboard(id); });
        document.getElementById('widAddBtn').addEventListener('click', addWidget);
        document.getElementById('widCancelEditBtn')?.addEventListener('click', cancelEdit);
        document.getElementById('widType')?.addEventListener('change', updateTypeOptions);
        const arSel = document.getElementById('dashAutoRefresh');
        if (arSel) {
            const saved = parseInt(localStorage.getItem('plc_dash_autorefresh') || '0', 10);
            arSel.value = String(saved);
            arSel.addEventListener('change', e => setAutoRefresh(parseInt(e.target.value, 10) || 0));
            setAutoRefresh(saved);
        }
        updateTypeOptions();
    }

    return { init, loadList, loadAvailableTags };
})();
