/**
 * Diagnostics — живая таблица тегов для вкладки «Диагностика».
 * Читает window.tagsData (заполняет app.js), рендерит таблицу
 * с фильтром, избранным (localStorage), раскрытием битов DINT/DINT[].
 */
window.Diagnostics = (() => {
    const FAV_KEY = 'plc_diag_favs';
    let favs = new Set();
    let expanded = new Set();    // tagName → раскрыт
    let searchQ = '';
    let typeF = '';
    let favOnly = false;

    function loadFavs() {
        try { favs = new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]')); } catch { favs = new Set(); }
    }
    function saveFavs() {
        localStorage.setItem(FAV_KEY, JSON.stringify([...favs]));
    }
    function toggleFav(name) {
        if (favs.has(name)) favs.delete(name); else favs.add(name);
        saveFavs();
        render();
    }

    // ── helpers ───────────────────────────────────────────────────────────────
    function esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }
    function ea(s) { return String(s ?? '').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

    function flatRows() {
        const rows = [];
        const td = window.tagsData || {};
        for (const cat in td) {
            for (const tag of td[cat]) {
                if (tag.is_array) {
                    rows.push({ ...tag, _cat: cat, _isRoot: true });
                } else {
                    rows.push({ ...tag, _cat: cat, _isRoot: true });
                }
            }
        }
        return rows;
    }

    function matchRow(r) {
        const name = (r.name || '').toLowerCase();
        const type = (r.type || '').toUpperCase();
        if (favOnly && !favs.has(r.name)) return false;
        if (searchQ && !name.includes(searchQ)) return false;
        if (typeF && type !== typeF) return false;
        return true;
    }

    // ── render ────────────────────────────────────────────────────────────────
    function render() {
        const wrap = document.getElementById('diagTableWrap');
        if (!wrap) return;
        const rows = flatRows().filter(matchRow);
        if (!rows.length) {
            const connected = window.isConnected;
            wrap.innerHTML = `<div class="empty-state">
                <div class="empty-state-icon">${connected ? '🔍' : '🔬'}</div>
                <div>${connected ? 'Ничего не найдено' : 'Подключитесь к ПЛК на вкладке «Диагностика»'}</div>
            </div>`;
            return;
        }

        let html = `<table class="data-table diag-table">
            <thead><tr>
                <th style="width:28px;">★</th>
                <th>Адрес</th>
                <th style="width:80px;">Тип</th>
                <th style="width:120px;">Значение</th>
                <th>Действия</th>
            </tr></thead><tbody>`;

        for (const r of rows) {
            html += renderRow(r);
            if (expanded.has(r.name)) {
                html += renderExpanded(r);
            }
        }
        html += '</tbody></table>';
        wrap.innerHTML = html;
        bindEvents(wrap);
    }

    function renderRow(r) {
        const isFav = favs.has(r.name);
        const type = (r.type || '').toUpperCase();
        const isDint = ['SINT','INT','DINT','LINT'].includes(type);
        const isDintArr = r.is_array && isDint;
        const isBool = type === 'BOOL';
        const isReal = type === 'REAL';
        const isStr  = type === 'STRING';
        const canExpand = isDint || isDintArr;
        const isExp = expanded.has(r.name);

        const valClass = isBool ? (r.value === '1' ? 'val-bool-on' : 'val-bool-off')
                       : isReal ? 'val-real'
                       : isStr  ? 'val-str'
                       : 'val-num';

        const displayVal = r.is_array ? `[${r.array_size}]` : esc(r.value);

        let actions = '';
        if (isBool) {
            actions = `<span class="bool-btn bool-btn-toggle" onclick="(function(e){e.stopPropagation();window.toggleBool&&window.toggleBool('${ea(r.name)}',e)})(event)">⇄ Toggle</span>
                       <span class="bool-btn bool-btn-momentary"
                         onmousedown="window.momentaryDown&&window.momentaryDown('${ea(r.name)}',this,event)"
                         onmouseup="window.momentaryUp&&window.momentaryUp('${ea(r.name)}',this,event)"
                         onmouseleave="window.momentaryUp&&window.momentaryUp('${ea(r.name)}',this,event)"
                         ontouchstart="window.momentaryDown&&window.momentaryDown('${ea(r.name)}',this,event)"
                         ontouchend="window.momentaryUp&&window.momentaryUp('${ea(r.name)}',this,event)"
                         ontouchcancel="window.momentaryUp&&window.momentaryUp('${ea(r.name)}',this,event)">⏺ Момент.</span>`;
        } else if (!r.is_array && !isBool) {
            actions = `<span class="diag-edit-btn" onclick="window.editValue&&window.editValue('${ea(r.name)}')">✎ Запись</span>`;
        }

        return `<tr class="diag-row${canExpand ? ' expandable' : ''}" data-name="${ea(r.name)}">
            <td class="diag-fav" onclick="Diagnostics._fav('${ea(r.name)}')">${isFav ? '★' : '☆'}</td>
            <td class="tag-name-cell" style="font-size:11px;">${esc(r.name)}</td>
            <td><span class="type-badge">${esc(r.type)}${r.is_array ? '[]' : ''}</span></td>
            <td><span class="diag-val ${valClass}" data-value-of="${ea(r.name)}">${displayVal}</span></td>
            <td class="diag-actions">
                ${canExpand ? `<span class="diag-expand-btn" data-expand="${ea(r.name)}">${isExp ? '▲ Скрыть' : '▼ Биты'}</span>` : ''}
                ${actions}
            </td>
        </tr>`;
    }

    function renderExpanded(r) {
        const type = (r.type || '').toUpperCase();
        const isDintArr = r.is_array && ['SINT','INT','DINT','LINT'].includes(type);

        if (isDintArr) {
            let html = `<tr class="diag-expanded-row"><td colspan="5"><div class="diag-expand-body">`;
            for (const elem of (r.elements || [])) {
                const isExpElem = expanded.has(elem.name);
                html += `<div class="diag-elem-row">
                    <span class="muted" style="min-width:60px;">[${elem.index}]</span>
                    <span class="diag-val val-num" data-value-of="${ea(elem.name)}">${esc(elem.value)}</span>
                    <span class="diag-expand-btn" data-expand="${ea(elem.name)}" style="margin-left:6px;">${isExpElem ? '▲' : '▼ биты'}</span>
                </div>`;
                if (isExpElem && elem.bits) {
                    html += renderBitsInline(elem);
                }
            }
            html += `</div></td></tr>`;
            return html;
        }

        // Scalar DINT — bits grid
        if (r.bits) {
            return `<tr class="diag-expanded-row"><td colspan="5">${renderBitsInline(r)}</td></tr>`;
        }
        return '';
    }

    function renderBitsInline(tag) {
        const numBits = tag.num_bits || 32;
        let html = `<div class="diag-bits-wrap">
            <div class="bits-grid bits-${numBits}">`;
        for (let i = numBits - 1; i >= 0; i--) {
            const v = tag.bits ? tag.bits[i] : 0;
            html += `<div class="bit-cell ${v ? 'bit-on' : 'bit-off'}" data-bit="${i}" data-bit-parent="${ea(tag.name)}" title="bit ${i}">
                <div class="bit-num">${i}</div><div class="bit-val">${v}</div>
            </div>`;
        }
        html += `</div></div>`;
        return html;
    }

    // ── events ────────────────────────────────────────────────────────────────
    function bindEvents(wrap) {
        wrap.querySelectorAll('[data-expand]').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                const name = btn.dataset.expand;
                if (expanded.has(name)) expanded.delete(name); else expanded.add(name);
                render();
            });
        });
        wrap.querySelectorAll('.diag-fav').forEach(cell => {
            // already bound via onclick inline
        });
    }

    // ── external call from app.js after data refresh ──────────────────────────
    function onTagsUpdated() {
        const diagVisible = document.getElementById('diagnosticsView')?.style.display === 'flex';
        if (diagVisible) renderUpdateOnly();
    }

    function renderUpdateOnly() {
        // Patch values in DOM without full re-render
        const td = window.tagsData || {};
        for (const cat in td) {
            for (const t of td[cat]) {
                updateVal(t.name, t.value, t.type);
                if (t.elements) t.elements.forEach(e => { updateVal(e.name, e.value, e.type); updateBits(e); });
                updateBits(t);
            }
        }
    }

    function cssEsc(s) { return String(s).replace(/[\\"]/g, '\\$&'); }

    function updateVal(name, value, type) {
        document.querySelectorAll(`[data-value-of="${cssEsc(name)}"]`).forEach(el => {
            if (el.textContent !== String(value)) el.textContent = value;
            const isBool = (type || '').toUpperCase() === 'BOOL';
            if (isBool) {
                el.classList.toggle('val-bool-on', value === '1');
                el.classList.toggle('val-bool-off', value === '0');
            }
        });
    }

    function updateBits(tag) {
        if (!tag.bits) return;
        const wrap = document.querySelector(`.diag-bits-wrap [data-bit-parent="${cssEsc(tag.name)}"]`);
        // just re-render expanded if it's open
        if (expanded.has(tag.name)) {
            const el = document.querySelector(`.diag-expanded-row`);
            if (el) { /* full render is fine for expanded */ }
        }
    }

    function init() {
        loadFavs();

        document.getElementById('diagSearch')?.addEventListener('input', e => {
            searchQ = e.target.value.toLowerCase();
            render();
        });
        document.getElementById('diagTypeFilter')?.addEventListener('change', e => {
            typeF = e.target.value;
            render();
        });
        document.getElementById('diagFavOnly')?.addEventListener('change', e => {
            favOnly = e.target.checked;
            render();
        });

        // Hook into app.js data refresh
        const _origLoad = window.loadTags;
        if (_origLoad) {
            window.loadTags = async function() {
                await _origLoad();
                onTagsUpdated();
            };
        }
    }

    return { init, render, onTagsUpdated, _fav: toggleFav };
})();
