/**
 * ControlPanel — HMI-панель с виджетами.
 * Типы: momentary_button, maintained_button, indicator, numeric_display, numeric_input, section.
 * Конфигурация хранится в localStorage ('plc_ctrl_widgets').
 */
window.ControlPanel = (() => {
    const STORE_KEY = 'plc_ctrl_widgets';
    let editMode = false;
    let widgets = [];
    let refreshTimer = null;
    let dragSrc = null;
    // tag -> expiry ms: блокирует updateValues от перезаписи после нажатия
    const ctrlPending = new Map();
    // теги удерживаемых momentary кнопок
    const holdingTags = new Set();

    // ── persistence ──────────────────────────────────────────────────────────
    function load() {
        try { widgets = JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch { widgets = []; }
    }
    function save() {
        localStorage.setItem(STORE_KEY, JSON.stringify(widgets));
    }

    // ── helpers ───────────────────────────────────────────────────────────────
    function uid() { return Math.random().toString(36).slice(2, 9); }

    function getTagValue(tagName) {
        if (!window.tagsData) return null;
        for (const cat in window.tagsData) {
            for (const t of window.tagsData[cat]) {
                if (t.name === tagName) return t.value;
                if (t.fields) { const f = t.fields.find(x => x.name === tagName); if (f) return f.value; }
                if (t.elements) { const e = t.elements.find(x => x.name === tagName); if (e) return e.value; }
            }
        }
        return null;
    }

    function write(tagName, value) {
        if (window.instantWrite) { window.instantWrite(tagName, value); return; }
        fetch('/api/write', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tag: tagName, value }),
            keepalive: true
        }).catch(e => console.error('ctrl write:', e));
    }

    function availableTags() {
        const out = [];
        if (!window.tagsData) return out;
        for (const cat in window.tagsData) {
            for (const t of window.tagsData[cat]) {
                out.push({ name: t.name, type: t.type });
                if (t.fields) t.fields.forEach(f => out.push({ name: f.name, type: f.type }));
                if (t.elements) t.elements.forEach(e => out.push({ name: e.name, type: e.type }));
            }
        }
        return out;
    }

    const BUTTON_TYPES = new Set(['momentary_button', 'maintained_button']);

    // ── render ────────────────────────────────────────────────────────────────
    function render() {
        const grid = document.getElementById('ctrlGrid');
        if (!grid) return;
        grid.innerHTML = '';
        if (!widgets.length) {
            grid.innerHTML = '<div class="muted" style="padding:24px; text-align:center;">' +
                (editMode ? 'Добавьте виджеты через форму выше.' : 'Нет виджетов. Включите режим правки.') +
                '</div>';
            return;
        }
        for (const w of widgets) {
            const card = document.createElement('div');
            card.className = w.type === 'section' ? 'ctrl-section-card' : 'ctrl-widget';
            card.dataset.wid = w.id;
            card.innerHTML = renderWidget(w);
            bindWidgetEvents(card, w);

            if (editMode) {
                // delete button
                const del = document.createElement('button');
                del.className = 'ctrl-del-btn';
                del.title = 'Удалить';
                del.textContent = '×';
                del.addEventListener('click', () => { removeWidget(w.id); });
                card.appendChild(del);

                // drag-and-drop
                card.draggable = true;
                card.addEventListener('dragstart', e => {
                    dragSrc = w.id;
                    e.dataTransfer.effectAllowed = 'move';
                    card.classList.add('ctrl-dragging');
                });
                card.addEventListener('dragend', () => {
                    card.classList.remove('ctrl-dragging');
                    grid.querySelectorAll('.ctrl-drag-over').forEach(el => el.classList.remove('ctrl-drag-over'));
                });
                card.addEventListener('dragover', e => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    card.classList.add('ctrl-drag-over');
                });
                card.addEventListener('dragleave', () => card.classList.remove('ctrl-drag-over'));
                card.addEventListener('drop', e => {
                    e.preventDefault();
                    card.classList.remove('ctrl-drag-over');
                    if (dragSrc && dragSrc !== w.id) {
                        const fi = widgets.findIndex(x => x.id === dragSrc);
                        const ti = widgets.findIndex(x => x.id === w.id);
                        if (fi !== -1 && ti !== -1) {
                            const [moved] = widgets.splice(fi, 1);
                            widgets.splice(ti, 0, moved);
                            save();
                            render();
                        }
                    }
                });
            }

            grid.appendChild(card);
        }
    }

    function renderWidget(w) {
        const val = getTagValue(w.tag) ?? '—';
        const isOn = val === '1' || val === true;
        const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

        const header = `<div class="ctrl-w-label">${esc(w.label || w.tag)}</div>
                        <div class="ctrl-w-tag muted">${esc(w.tag)}</div>`;

        function indicatorHtml() {
            if (!w.indicatorTag) return '';
            const iv = getTagValue(w.indicatorTag) ?? '—';
            const iOn = iv === '1' || iv === true;
            return `<div class="ctrl-ind-secondary ${iOn ? 'on' : 'off'}" data-ind-tag="${esc(w.indicatorTag)}">
                <div class="ctrl-indicator-bulb"></div>
                <div class="ctrl-indicator-val">${iOn ? 'ВКЛ' : 'ВЫКЛ'}</div>
            </div>`;
        }

        switch (w.type) {
            case 'section':
                return `<div class="ctrl-section-header">${esc(w.label || 'Секция')}</div>`;

            case 'momentary_button':
                return `${header}<button class="ctrl-btn ctrl-momentary"
                    data-tag="${esc(w.tag)}"
                    onmousedown="ControlPanel._mdown('${esc(w.tag)}',this)"
                    onmouseup="ControlPanel._mup('${esc(w.tag)}',this)"
                    onmouseleave="ControlPanel._mup('${esc(w.tag)}',this)"
                    ontouchstart="ControlPanel._mdown('${esc(w.tag)}',this)"
                    ontouchend="ControlPanel._mup('${esc(w.tag)}',this)"
                    ontouchcancel="ControlPanel._mup('${esc(w.tag)}',this)">▶ ПУСК</button>${indicatorHtml()}`;

            case 'maintained_button':
                return `${header}<button class="ctrl-btn ctrl-maintained ${isOn ? 'active' : ''}"
                    data-tag="${esc(w.tag)}"
                    onclick="ControlPanel._toggle('${esc(w.tag)}',this)"
                    >${isOn ? '● ВКЛ' : '○ ВЫКЛ'}</button>${indicatorHtml()}`;

            case 'indicator':
                return `${header}<div class="ctrl-indicator ${isOn ? 'on' : 'off'}" data-tag="${esc(w.tag)}">
                    <div class="ctrl-indicator-bulb"></div>
                    <div class="ctrl-indicator-val">${isOn ? 'ВКЛ' : 'ВЫКЛ'}</div>
                </div>`;

            case 'numeric_display':
                return `${header}<div class="ctrl-num-display" data-tag="${esc(w.tag)}">${esc(val)}</div>`;

            case 'numeric_input': {
                return `${header}<div class="ctrl-num-input-wrap">
                    <div class="ctrl-num-display" data-tag="${esc(w.tag)}">${esc(val)}</div>
                    <form class="ctrl-write-form" onsubmit="return ControlPanel._write('${esc(w.tag)}',this)">
                        <input type="number" step="any" placeholder="Значение" />
                        <button type="submit" class="btn btn-small">▶</button>
                    </form>
                </div>`;
            }

            default:
                return `${header}<div class="muted">Unknown type: ${esc(w.type)}</div>`;
        }
    }

    function bindWidgetEvents() { /* events are inline — see renderWidget */ }

    // ── public handlers (called from inline HTML) ─────────────────────────────
    function _mdown(tag, btn) {
        btn && btn.classList.add('holding');
        holdingTags.add(tag);
        write(tag, '1');
    }
    function _mup(tag, btn) {
        if (!btn || !btn.classList.contains('holding')) return;
        btn.classList.remove('holding');
        holdingTags.delete(tag);
        write(tag, '0');
    }
    function _toggle(tag, btn) {
        // читаем из pending (быстрые клики) или из ПЛК
        const p = ctrlPending.get(tag);
        const cur = (p && Date.now() < p.expires) ? p.value : (getTagValue(tag) ?? '0');
        const next = (cur === '1' || cur === true) ? '0' : '1';
        write(tag, next);
        // pending только чтобы следующий быстрый клик читал правильное состояние
        ctrlPending.set(tag, { value: next, expires: Date.now() + 1500 });
        // мгновенно обновляем ТОЛЬКО эту кнопку — не ждём опроса ПЛК
        if (btn) {
            btn.classList.toggle('active', next === '1');
            btn.textContent = next === '1' ? '● ВКЛ' : '○ ВЫКЛ';
        }
    }
    function _writeForm(tag, form) {
        const inp = form.querySelector('input');
        if (!inp || inp.value === '') return false;
        write(tag, inp.value);
        inp.value = '';
        return false;
    }

    // ── live value update ─────────────────────────────────────────────────────
    function updateValues() {
        const grid = document.getElementById('ctrlGrid');
        if (!grid) return;
        for (const w of widgets) {
            if (w.type === 'section') continue;
            const card = grid.querySelector(`[data-wid="${w.id}"]`);
            if (!card) continue;
            const val = getTagValue(w.tag) ?? '—';
            const isOn = val === '1' || val === true;

            if (w.type === 'maintained_button') {
                const p = ctrlPending.get(w.tag);
                const blocked = p && Date.now() < p.expires;
                if (!blocked) {
                    if (p) ctrlPending.delete(w.tag);
                    const btn = card.querySelector('.ctrl-maintained');
                    if (btn) {
                        btn.classList.toggle('active', isOn);
                        btn.textContent = isOn ? '● ВКЛ' : '○ ВЫКЛ';
                    }
                }
            } else if (w.type === 'indicator') {
                const ind = card.querySelector('.ctrl-indicator');
                if (ind) {
                    ind.classList.toggle('on', isOn);
                    ind.classList.toggle('off', !isOn);
                    const v = ind.querySelector('.ctrl-indicator-val');
                    if (v) v.textContent = isOn ? 'ВКЛ' : 'ВЫКЛ';
                }
            } else if (w.type === 'numeric_display' || w.type === 'numeric_input') {
                const disp = card.querySelector('.ctrl-num-display');
                if (disp) disp.textContent = val;
            }

            // secondary indicator for button cards
            if (w.indicatorTag && BUTTON_TYPES.has(w.type)) {
                const iv = getTagValue(w.indicatorTag) ?? '—';
                const iOn = iv === '1' || iv === true;
                const ind = card.querySelector('.ctrl-ind-secondary');
                if (ind) {
                    ind.classList.toggle('on', iOn);
                    ind.classList.toggle('off', !iOn);
                    const v = ind.querySelector('.ctrl-indicator-val');
                    if (v) v.textContent = iOn ? 'ВКЛ' : 'ВЫКЛ';
                }
            }
        }
    }

    // ── widget CRUD ───────────────────────────────────────────────────────────
    function addWidget() {
        const type = document.getElementById('ctrlWType').value;
        const label = document.getElementById('ctrlWLabel').value.trim();
        const tag = document.getElementById('ctrlWTag').value;

        if (type !== 'section' && !tag) { alert('Выберите тег'); return; }

        const w = { id: uid(), type, label: label || (type === 'section' ? 'Секция' : tag), tag: tag || '' };

        if (BUTTON_TYPES.has(type)) {
            const indTag = document.getElementById('ctrlWIndicatorTag')?.value;
            if (indTag) w.indicatorTag = indTag;
        }

        widgets.push(w);
        save();
        render();
    }

    function removeWidget(id) {
        widgets = widgets.filter(w => w.id !== id);
        save();
        render();
    }

    // ── tag select populate ───────────────────────────────────────────────────
    function getFavs() {
        try { return new Set(JSON.parse(localStorage.getItem('plc_diag_favs') || '[]')); } catch { return new Set(); }
    }

    function populateTagSelect() {
        const sel = document.getElementById('ctrlWTag');
        const indSel = document.getElementById('ctrlWIndicatorTag');
        if (!sel) return;
        const favOnly = document.getElementById('ctrlFavOnly')?.checked;
        const favs = favOnly ? getFavs() : null;
        const tags = availableTags().filter(t => !favs || favs.has(t.name));
        if (!tags.length) {
            const msg = favOnly
                ? '<option value="">— нет избранных тегов —</option>'
                : '<option value="">— нет тегов (подключитесь к ПЛК) —</option>';
            sel.innerHTML = msg;
            if (indSel) indSel.innerHTML = '<option value="">— нет —</option>';
            return;
        }
        const opts = tags.map(t =>
            `<option value="${t.name.replace(/"/g,'&quot;')}">${t.name} (${t.type})</option>`
        ).join('');
        sel.innerHTML = opts;
        if (indSel) indSel.innerHTML = '<option value="">— нет —</option>' + opts;
    }

    // show/hide tag & indicator fields based on selected type
    function onTypeChange() {
        const type = document.getElementById('ctrlWType')?.value;
        const tagLabel = document.getElementById('ctrlTagLabel');
        const tagSel = document.getElementById('ctrlWTag');
        const indLabel = document.getElementById('ctrlIndTagLabel');
        const indSel = document.getElementById('ctrlWIndicatorTag');
        const isSection = type === 'section';
        const isButton = BUTTON_TYPES.has(type);

        if (tagLabel) tagLabel.style.display = isSection ? 'none' : '';
        if (tagSel)   tagSel.style.display   = isSection ? 'none' : '';
        if (indLabel) indLabel.style.display = isButton ? '' : 'none';
        if (indSel)   indSel.style.display   = isButton ? '' : 'none';
    }

    // ── edit mode toggle ──────────────────────────────────────────────────────
    function toggleEditMode() {
        editMode = !editMode;
        const btn = document.getElementById('ctrlModeBtn');
        const form = document.getElementById('ctrlEditForm');
        if (btn) btn.textContent = editMode ? '✔ Режим просмотра' : '✎ Режим правки';
        if (form) form.style.display = editMode ? 'block' : 'none';
        if (editMode) { populateTagSelect(); onTypeChange(); }
        render();
    }

    function onShow() {
        populateTagSelect();
        render();
        if (!refreshTimer) refreshTimer = setInterval(updateValues, 1000);
    }

    function init() {
        load();
        document.getElementById('ctrlModeBtn')?.addEventListener('click', toggleEditMode);
        document.getElementById('ctrlAddWidgetBtn')?.addEventListener('click', addWidget);
        document.getElementById('ctrlFavOnly')?.addEventListener('change', populateTagSelect);
        document.getElementById('ctrlWType')?.addEventListener('change', onTypeChange);
        // при уходе со страницы сбрасываем удерживаемые кнопки
        window.addEventListener('beforeunload', () => {
            holdingTags.forEach(tag => write(tag, '0'));
        });
    }

    return { init, onShow, updateValues, _mdown, _mup, _toggle, _write: _writeForm };
})();
