window.AIAnalytics = (() => {
    const TITLES = {
        anomalies:   '⚡ Анализ аномалий',
        diagnostics: 'Диагностика',
        report:      'Отчёт',
    };

    let _currentSource = null;
    let _fullText = '';

    function init() {
        document.getElementById('aiAnomaliesBtn')?.addEventListener('click',   () => run('anomalies'));
        document.getElementById('aiDiagnosticsBtn')?.addEventListener('click', () => run('diagnostics'));
        document.getElementById('aiReportBtn')?.addEventListener('click',       () => run('report'));
        document.getElementById('aiStopBtn')?.addEventListener('click',         stop);
        document.getElementById('aiCopyBtn')?.addEventListener('click',         copy);
    }

    function onShow() {
        // nothing to refresh on show
    }

    function run(analysisType) {
        stop();

        const timeRange = document.getElementById('aiTimeRange')?.value || '-8h';
        const favOnly   = document.getElementById('aiFavOnly')?.checked || false;

        let tags = [];
        if (favOnly && window.tagsData) {
            try {
                const favs = JSON.parse(localStorage.getItem('plc_diag_favs') || '[]');
                const favSet = new Set(favs);
                tags = Object.keys(window.tagsData).filter(t => favSet.has(t));
            } catch {}
        }

        _fullText = '';
        const output    = document.getElementById('aiOutput');
        const card      = document.getElementById('aiResultCard');
        const titleEl   = document.getElementById('aiResultTitle');
        const statusCard = document.getElementById('aiStatusCard');
        const statusMsg  = document.getElementById('aiStatusMsg');
        const stopBtn    = document.getElementById('aiStopBtn');

        if (!output || !card) return;

        card.style.display = 'none';
        if (statusCard) {
            statusCard.style.display = 'block';
            statusMsg.textContent = 'Запрашиваю данные и анализирую…';
        }
        if (stopBtn) stopBtn.style.display = '';

        const token = localStorage.getItem('plc_token') || '';
        const url = '/api/ai/analyze/stream?' + new URLSearchParams({
            analysis_type: analysisType,
            time_range:    timeRange,
            tags:          tags.join(','),
            token:         token,
        });

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
                if (statusCard) {
                    statusMsg.textContent = data.replace('[ERROR]', '').trim();
                }
                return;
            }

            if (!card.style.display || card.style.display === 'none') {
                card.style.display = '';
                if (statusCard) statusCard.style.display = 'none';
                titleEl.textContent = TITLES[analysisType] || 'Результат';
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
                statusMsg.textContent = 'Ошибка подключения к серверу. Проверьте, запущен ли Ollama.';
            }
        };
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
