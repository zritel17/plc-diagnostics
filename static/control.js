/**
 * ControlPanel — HMI-панель с виджетами.
 * Типы: momentary_button, maintained_button, indicator, numeric_display, numeric_input.
 * Конфигурация хранится в localStorage ('plc_ctrl_widgets').
 */
window.ControlPanel = (() => {
    const STORE_KEY = 'plc_ctrl_widgets';
    let editMode = false;
    let widgets = [];
    let refreshTimer = null;

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
            card.className = 'ctrl-widget';
            card.dataset.wid = w.id;
            card.innerHTML = renderWidget(w);
            bindWidgetEvents(card, w);
            if (editMode) {
                const del = document.createElement('button');
                del.className = 'ctrl-del-btn';
                del.title = 'Удалить';
                del.textContent = '×';
                del.addEventListener('click', () => { removeWidget(w.id); });
                card.appendChild(del);
            }
            grid.appendChild(card);
        }
    }

    function renderWidget(w) {
        const val = getTagValue(w.tag) ?? '—';
        const isBool = val === '1' || val === '0' || val === true || val === false;
        const isOn = val === '1' || val === true;
        const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

        const header = `<div class="ctrl-w-label">${esc(w.label || w.tag)}</div>
                        <div class="ctrl-w-tag muted">${esc(w.tag)}</div>`;

        switch (w.type) {
            case 'momentary_button':
                return `${header}<button class="ctrl-btn ctrl-momentary"
                    data-tag="${esc(w.tag)}"
                    onmousedown="ControlPanel._mdown('${esc(w.tag)}',this)"
                    onmouseup="ControlPanel._mup('${esc(w.tag)}',this)"
                    onmouseleave="ControlPanel._mup('${esc(w.tag)}',this)"
                    ontouchstart="ControlPanel._mdown('${esc(w.tag)}',this)"
                    ontouchend="ControlPanel._mup('${esc(w.tag)}',this)"
                    ontouchcancel="ControlPanel._mup('${esc(w.tag)}',this)">▶ ПУСК</button>`;

            case 'maintained_button':
                return `${header}<button class="ctrl-btn ctrl-maintained ${isOn ? 'active' : ''}"
                    data-tag="${esc(w.tag)}"
                    onclick="ControlPanel._toggle('${esc(w.tag)}',this)"
                    >${isOn ? '● ВКЛ' : '○ ВЫКЛ'}</button>`;

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
        write(tag, '1');
    }
    function _mup(tag, btn) {
        if (!btn || !btn.classList.contains('holding')) return;
        btn.classList.remove('holding');
        write(tag, '0');
    }
    function _toggle(tag, btn) {
        const cur = getTagValue(tag);
        const next = (cur === '1' || cur === true) ? '0' : '1';
        write(tag, next);
        // optimistic UI
        setTimeout(updateValues, 50);
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
            const card = grid.querySelector(`[data-wid="${w.id}"]`);
            if (!card) continue;
            const val = getTagValue(w.tag) ?? '—';
            const isOn = val === '1' || val === true;

            if (w.type === 'maintained_button') {
                const btn = card.querySelector('.ctrl-maintained');
                if (btn) {
                    btn.classList.toggle('active', isOn);
                    btn.textContent = isOn ? '● ВКЛ' : '○ ВЫКЛ';
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
        }
    }

    // ── widget CRUD ───────────────────────────────────────────────────────────
    function addWidget() {
        const type = document.getElementById('ctrlWType').value;
        const label = document.getElementById('ctrlWLabel').value.trim();
        const tag = document.getElementById('ctrlWTag').value;
        if (!tag) { alert('Выберите тег'); return; }
        widgets.push({ id: uid(), type, label: label || tag, tag });
        save();
        render();
    }

    function removeWidget(id) {
        widgets = widgets.filter(w => w.id !== id);
        save();
        render();
    }

    // ── tag select populate ───────────────────────────────────────────────────
    function populateTagSelect() {
        const sel = document.getElementById('ctrlWTag');
        if (!sel) return;
        const tags = availableTags();
        if (!tags.length) {
            sel.innerHTML = '<option value="">— нет тегов (подключитесь к ПЛК) —</option>';
            return;
        }
        sel.innerHTML = tags.map(t =>
            `<option value="${t.name.replace(/"/g,'&quot;')}">${t.name} (${t.type})</option>`
        ).join('');
    }

    // ── edit mode toggle ──────────────────────────────────────────────────────
    function toggleEditMode() {
        editMode = !editMode;
        const btn = document.getElementById('ctrlModeBtn');
        const form = document.getElementById('ctrlEditForm');
        if (btn) btn.textContent = editMode ? '✔ Режим просмотра' : '✎ Режим правки';
        if (form) form.style.display = editMode ? 'block' : 'none';
        if (editMode) populateTagSelect();
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
    }

    return { init, onShow, updateValues, _mdown, _mup, _toggle, _write: _writeForm };
})();
