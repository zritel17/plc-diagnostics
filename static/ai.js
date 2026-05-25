window.AIAnalytics = (() => {
    const TITLES = {
        anomalies:      '⚡ Anomaly Analysis',
        diagnostics:    'Diagnostics',
        report:         'Report',
        breakdown_risk: '⚠ Breakdown Risk Assessment',
        shift_compare:  '⇆ Shift Comparison',
        custom:         'Custom Analysis',
    };

    let _currentSource = null;
    let _fullText = '';
    let _bgPollInterval = null;

    function init() {
        document.getElementById('aiAnomaliesBtn')?.addEventListener('click',      () => run('anomalies'));
        document.getElementById('aiDiagnosticsBtn')?.addEventListener('click',    () => run('diagnostics'));
        document.getElementById('aiReportBtn')?.addEventListener('click',         () => run('report'));
        document.getElementById('aiBreakdownBtn')?.addEventListener('click',      () => run('breakdown_risk'));
        document.getElementById('aiShiftCompareBtn')?.addEventListener('click',   () => run('shift_compare'));
        document.getElementById('aiStopBtn')?.addEventListener('click',           stop);
        document.getElementById('aiCopyBtn')?.addEventListener('click',           copy);
        document.getElementById('aiCustomRunBtn')?.addEventListener('click',      runCustom);
        document.getElementById('aiHistoryRefreshBtn')?.addEventListener('click', _loadHistory);

        // Poll bg-status every 5 minutes
        _bgPollInterval = setInterval(_checkBgStatus, 5 * 60 * 1000);
    }

    function onShow() {
        _loadHistory();
        _checkBgStatus();
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    function _getToken() {
        return localStorage.getItem('plc_token') || '';
    }

    function _getTagsFromFavs() {
        const favOnly = document.getElementById('aiFavOnly')?.checked || false;
        if (!favOnly || !window.tagsData) return [];
        try {
            const favs = JSON.parse(localStorage.getItem('plc_diag_favs') || '[]');
            const favSet = new Set(favs);
            return Object.keys(window.tagsData).filter(t => favSet.has(t));
        } catch { return []; }
    }

    // ── Quick stats table ─────────────────────────────────────────────────────

    async function _loadAndRenderStats(timeRange, tagsStr) {
        const statsCard = document.getElementById('aiStatsCard');
        if (!statsCard) return;
        statsCard.style.display = 'none';

        const params = new URLSearchParams({ time_range: timeRange, token: _getToken() });
        if (tagsStr) params.set('tags', tagsStr);

        try {
            const res = await fetch('/api/ai/context-stats?' + params);
            if (!res.ok) return;
            const data = await res.json();
            const tagData = data.tags || {};
            const names = Object.keys(tagData);
            if (!names.length) return;

            // Get current PLC values from global cache
            const currentMap = {};
            if (window.tagsData) {
                Object.values(window.tagsData).forEach(arr => {
                    if (Array.isArray(arr)) arr.forEach(t => { if (t.name) currentMap[t.name] = t.value; });
                });
            }

            const tbody = document.getElementById('aiStatsBody');
            if (!tbody) return;
            tbody.innerHTML = '';

            names.forEach(name => {
                const s = tagData[name];
                const cur = currentMap[name];

                // Trend
                let trendHtml = '<span class="trend-flat">→</span>';
                if (s.first != null && s.last != null && Math.abs(s.first) > 1e-9) {
                    const pct = (s.last - s.first) / Math.abs(s.first) * 100;
                    if (pct > 2)  trendHtml = `<span class="trend-up">↑ ${pct.toFixed(1)}%</span>`;
                    if (pct < -2) trendHtml = `<span class="trend-down">↓ ${Math.abs(pct).toFixed(1)}%</span>`;
                }

                // Status
                let statusHtml = '<span class="tag-status-normal">normal</span>';
                if (s.mean != null && cur != null) {
                    const spread = (s.max ?? 0) - (s.min ?? 0);
                    try {
                        const curF = parseFloat(cur);
                        if (spread > 0 && !isNaN(curF)) {
                            const dev = Math.abs(curF - s.mean) / (spread / 2) * 100;
                            if (dev > 50) statusHtml = '<span class="tag-status-alert">alert</span>';
                            else if (dev > 20) statusHtml = '<span class="tag-status-watch">watch</span>';
                        }
                    } catch (_) {}
                }

                const fmt = v => (v == null ? '—' : Number(v).toPrecision(4));
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td style="font-size:11px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${name}">${name}</td>
                    <td>${trendHtml}</td>
                    <td>${fmt(s.min)}</td>
                    <td>${fmt(s.mean)}</td>
                    <td>${fmt(s.max)}</td>
                    <td>${cur != null ? cur : '—'}</td>
                    <td>${statusHtml}</td>
                `;
                tbody.appendChild(tr);
            });

            statsCard.style.display = '';
        } catch (_) {}
    }

    // ── Analysis history ──────────────────────────────────────────────────────

    async function _loadHistory() {
        const histCard = document.getElementById('aiHistoryCard');
        const histList = document.getElementById('aiHistoryList');
        if (!histCard || !histList) return;

        try {
            const res = await fetch('/api/ai/history?token=' + _getToken());
            if (!res.ok) return;
            const data = await res.json();
            const items = (data.history || []).slice(0, 5);
            if (!items.length) {
                histCard.style.display = 'none';
                return;
            }
            histList.innerHTML = '';
            items.forEach(item => {
                const d = document.createElement('details');
                d.style.cssText = 'border-bottom:1px solid var(--border);padding:8px 14px;';
                const typeLabel = item.type || 'analysis';
                const tagCount  = (item.tags || []).length;
                d.innerHTML = `
                    <summary style="cursor:pointer;font-size:12px;list-style:none;display:flex;gap:8px;align-items:center;">
                        <span class="type-badge" style="font-size:10px;">${typeLabel}</span>
                        <span style="color:var(--fg-muted);">${item.time_range || ''}</span>
                        <span>${tagCount} tag${tagCount !== 1 ? 's' : ''}</span>
                        <span style="margin-left:auto;color:var(--fg-muted);font-size:11px;">${item.ts || ''}</span>
                    </summary>
                    <pre style="font-size:11px;white-space:pre-wrap;margin:6px 0 2px;color:var(--fg-secondary);max-height:120px;overflow:auto;">${_esc(item.preview || '')}…</pre>
                `;
                histList.appendChild(d);
            });
            histCard.style.display = '';
        } catch (_) {}
    }

    function _esc(s) {
        return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    // ── Background status badge ───────────────────────────────────────────────

    async function _checkBgStatus() {
        try {
            const res = await fetch('/api/ai/bg-status?token=' + _getToken());
            if (!res.ok) return;
            const data = await res.json();
            const badge   = document.getElementById('aiRiskBadge');
            const notice  = document.getElementById('aiRiskNotice');
            const noticeTs = document.getElementById('aiRiskNoticeTs');

            if (data.has_risk) {
                if (badge)    { badge.style.display = ''; }
                if (notice)   { notice.style.display = ''; }
                if (noticeTs) { noticeTs.textContent = data.last_ts || ''; }
            } else {
                if (badge)  badge.style.display = 'none';
                if (notice) notice.style.display = 'none';
            }
        } catch (_) {}
    }

    // ── Stream ────────────────────────────────────────────────────────────────

    function _startStream(params, title) {
        stop();
        _fullText = '';

        const output     = document.getElementById('aiOutput');
        const card       = document.getElementById('aiResultCard');
        const titleEl    = document.getElementById('aiResultTitle');
        const statusCard = document.getElementById('aiStatusCard');
        const statusMsg  = document.getElementById('aiStatusMsg');
        const stopBtn    = document.getElementById('aiStopBtn');

        if (!output || !card) return;

        card.style.display = 'none';
        if (statusCard) {
            statusCard.style.display = 'block';
            statusMsg.textContent = 'Fetching data and analyzing…';
        }
        if (stopBtn) stopBtn.style.display = '';

        // Kick off the quick stats table in parallel (no await — let it render independently)
        const timeRange = params.time_range || '-8h';
        const tagsStr   = params.tags || '';
        _loadAndRenderStats(timeRange, tagsStr);

        const token = _getToken();
        const url = '/api/ai/analyze/stream?' + new URLSearchParams({ ...params, token });

        const es = new EventSource(url);
        _currentSource = es;

        es.onmessage = ev => {
            const data = ev.data;
            if (data === '[DONE]') {
                es.close();
                _currentSource = null;
                if (stopBtn) stopBtn.style.display = 'none';
                if (statusCard) statusCard.style.display = 'none';
                _loadHistory();
                return;
            }
            if (data.startsWith('[ERROR]')) {
                es.close();
                _currentSource = null;
                if (stopBtn) stopBtn.style.display = 'none';
                if (statusCard) statusMsg.textContent = data.replace('[ERROR]', '').trim();
                return;
            }

            if (!card.style.display || card.style.display === 'none') {
                card.style.display = '';
                if (statusCard) statusCard.style.display = 'none';
                titleEl.textContent = title;
                output.textContent = '';
            }

            _fullText += data;
            output.textContent = _fullText;
            output.scrollTop = output.scrollHeight;
        };

        es.onerror = () => {
            es.close();
            _currentSource = null;
            if (stopBtn) stopBtn.style.display = 'none';
            if (!_fullText && statusCard) {
                statusMsg.textContent = 'Connection error. Check that Ollama is running.';
            }
        };
    }

    function run(analysisType) {
        const timeRange = document.getElementById('aiTimeRange')?.value || '-8h';
        const tags = _getTagsFromFavs();
        _startStream(
            { analysis_type: analysisType, time_range: timeRange, tags: tags.join(',') },
            TITLES[analysisType] || 'Result'
        );
    }

    function runCustom() {
        const timeRange    = document.getElementById('aiTimeRange')?.value || '-8h';
        const customTags   = (document.getElementById('aiCustomTags')?.value || '').trim();
        const customPrompt = (document.getElementById('aiCustomPrompt')?.value || '').trim();
        if (!customPrompt) {
            alert('Enter a question or instruction for the AI.');
            return;
        }
        const tags = customTags || _getTagsFromFavs().join(',');
        _startStream(
            { analysis_type: 'custom', time_range: timeRange, tags, custom_prompt: customPrompt },
            TITLES.custom
        );
    }

    function stop() {
        if (_currentSource) {
            _currentSource.close();
            _currentSource = null;
        }
        const stopBtn = document.getElementById('aiStopBtn');
        if (stopBtn) stopBtn.style.display = 'none';
    }

    function copy() {
        if (!_fullText) return;
        navigator.clipboard.writeText(_fullText).catch(() => {
            const ta = document.createElement('textarea');
            ta.value = _fullText;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
        });
    }

    return { init, onShow };
})();
