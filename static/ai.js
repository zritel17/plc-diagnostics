window.AIAnalytics = (() => {
    const TITLES = {
        anomalies:   '⚡ Anomaly Analysis',
        diagnostics: 'Diagnostics',
        report:      'Report',
        custom:      'Custom Analysis',
    };

    let _currentSource = null;
    let _fullText = '';

    function init() {
        document.getElementById('aiAnomaliesBtn')?.addEventListener('click',   () => run('anomalies'));
        document.getElementById('aiDiagnosticsBtn')?.addEventListener('click', () => run('diagnostics'));
        document.getElementById('aiReportBtn')?.addEventListener('click',       () => run('report'));
        document.getElementById('aiStopBtn')?.addEventListener('click',         stop);
        document.getElementById('aiCopyBtn')?.addEventListener('click',         copy);
        document.getElementById('aiCustomRunBtn')?.addEventListener('click',    runCustom);
    }

    function onShow() {
        // nothing to refresh on show
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

        const token = localStorage.getItem('plc_token') || '';
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
        const timeRange     = document.getElementById('aiTimeRange')?.value || '-8h';
        const customTags    = (document.getElementById('aiCustomTags')?.value || '').trim();
        const customPrompt  = (document.getElementById('aiCustomPrompt')?.value || '').trim();
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
