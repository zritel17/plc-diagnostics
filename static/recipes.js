/**
 * recipes.js — Recipe monitor (UDT tags).
 * Studio 5000-style flat member table, snapshot save/load, change tracking.
 */
window.Recipes = (() => {
    'use strict';

    let currentRecipe = null;
    let liveMembers   = [];          // [{name, display_name, type, value}]
    let baseline      = null;        // {id, label, values: {name: val}} | null
    let snapshots     = [];
    let tracking      = false;
    let pollTimer     = null;
    let recipesList   = [];          // full list from /api/recipes
    const POLL_MS     = 2000;

    function esc(s) {
        return String(s ?? '').replace(/[&<>"']/g,
            c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }
    function ea(s) {
        return String(s ?? '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function valsEqual(a, b) {
        if (a === b) return true;
        const fa = parseFloat(a), fb = parseFloat(b);
        if (!isNaN(fa) && !isNaN(fb)) return Math.abs(fa - fb) < 1e-6;
        return String(a).trim() === String(b).trim();
    }

    // ── Layout ────────────────────────────────────────────────────────────────
    function init() {
        const view = document.getElementById('recipesView');
        if (!view) return;
        view.innerHTML = `
<div class="recipe-layout">
  <aside class="recipe-sb">
    <div class="recipe-sb-head">Рецепты (UDT)</div>
    <div id="recipeList" class="recipe-list">
      <div class="recipe-empty">Подключитесь к ПЛК</div>
    </div>
    <div class="recipe-sb-head" style="border-top:1px solid var(--border);">Снимки</div>
    <div id="snapshotList" class="snapshot-list">
      <div class="recipe-empty">—</div>
    </div>
  </aside>
  <main class="recipe-main" id="recipeMain">
    <div class="recipe-empty-state">
      <div style="font-size:40px;opacity:0.25;">📋</div>
      <div>Выберите рецепт из списка слева</div>
      <div style="font-size:11px;margin-top:4px;color:var(--fg-muted);">UDT теги появятся после подключения к ПЛК</div>
    </div>
  </main>
</div>`;
    }

    // ── Data loading ──────────────────────────────────────────────────────────
    async function loadRecipes() {
        try {
            const r = await fetch('/api/recipes');
            if (!r.ok) return;
            const data = await r.json();
            recipesList = data.recipes || [];
            renderRecipeList();
        } catch (e) { console.error('loadRecipes:', e); }
    }

    async function loadLive() {
        if (!currentRecipe) return;
        try {
            const r = await fetch(`/api/recipes/${encodeURIComponent(currentRecipe)}/read`);
            if (!r.ok) return;
            const data = await r.json();

            const prev = Object.fromEntries(liveMembers.map(m => [m.name, m.value]));
            liveMembers = data.members || [];

            if (tracking && Object.keys(prev).length) {
                const changed = liveMembers.filter(m =>
                    m.name in prev && !valsEqual(prev[m.name], m.value));
                if (changed.length) {
                    logChanges(changed.map(m => ({
                        member: m.name,
                        old_value: prev[m.name],
                        new_value: m.value,
                    })));
                }
            }
            renderMonitorTable();
        } catch (e) { console.error('loadLive:', e); }
    }

    async function loadSnapshots() {
        if (!currentRecipe) return;
        try {
            const r = await fetch(`/api/recipes/${encodeURIComponent(currentRecipe)}/snapshots`);
            if (!r.ok) return;
            snapshots = await r.json();
            renderSnapshotList();
        } catch (e) {}
    }

    async function loadChangeLog() {
        if (!currentRecipe) return;
        const wrap = document.getElementById('changeLogTable');
        if (!wrap) return;
        try {
            const r = await fetch(`/api/recipes/${encodeURIComponent(currentRecipe)}/changes?limit=60`);
            if (!r.ok) return;
            const changes = await r.json();
            if (!changes.length) {
                wrap.innerHTML = '<div class="recipe-empty">Нет записей</div>';
                return;
            }
            wrap.innerHTML = `<table class="data-table" style="font-size:11px;">
  <thead><tr>
    <th style="width:90px;">Время</th>
    <th>Поле</th>
    <th style="width:100px;">Было</th>
    <th style="width:100px;">Стало</th>
  </tr></thead>
  <tbody>${changes.map(c => {
    const dt = new Date(c.changed_at).toLocaleTimeString('ru-RU');
    const short = c.member.includes('.') ? c.member.split('.').slice(1).join('.') : c.member;
    return `<tr>
      <td style="font-family:var(--font-mono);">${esc(dt)}</td>
      <td class="tag-name-cell">${esc(short)}</td>
      <td><span class="diag-val val-num">${esc(c.old_value ?? '—')}</span></td>
      <td><span class="diag-val val-num" style="color:var(--dot-error);">${esc(c.new_value)}</span></td>
    </tr>`;
  }).join('')}</tbody>
</table>`;
        } catch (e) {}
    }

    async function logChanges(changes) {
        try {
            await fetch(`/api/recipes/${encodeURIComponent(currentRecipe)}/changes`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ changes }),
            });
            await loadChangeLog();
        } catch (e) {}
    }

    // ── Render helpers ────────────────────────────────────────────────────────
    function renderRecipeList() {
        const el = document.getElementById('recipeList');
        if (!el) return;
        if (!recipesList.length) {
            el.innerHTML = '<div class="recipe-empty">UDT теги не найдены</div>';
            return;
        }
        el.innerHTML = recipesList.map(r => `
<div class="recipe-list-item${currentRecipe === r.name ? ' active' : ''}"
     data-name="${ea(r.name)}" onclick="Recipes._select('${ea(r.name)}')">
  <div class="recipe-item-name">${esc(r.name)}</div>
  <div class="recipe-item-meta">${esc(r.udt_type)} · ${r.member_count} полей</div>
</div>`).join('');
    }

    function renderSnapshotList() {
        const el = document.getElementById('snapshotList');
        if (!el) return;
        if (!snapshots.length) {
            el.innerHTML = '<div class="recipe-empty">Нет снимков</div>';
            return;
        }
        el.innerHTML = snapshots.map(s => {
            const dt = new Date(s.created_at).toLocaleString('ru-RU',
                { dateStyle: 'short', timeStyle: 'short' });
            const loaded = baseline && baseline.id === s.id;
            return `<div class="snapshot-item${loaded ? ' loaded' : ''}">
  <div class="snapshot-item-info" onclick="Recipes._loadSnap(${s.id})" title="Загрузить как базовую линию">
    <div class="snapshot-label">${esc(s.label)}</div>
    <div class="snapshot-dt">${dt}</div>
  </div>
  <button class="snapshot-del-btn" onclick="Recipes._delSnap(${s.id})" title="Удалить">×</button>
</div>`;
        }).join('');
    }

    function renderMonitorShell() {
        const main = document.getElementById('recipeMain');
        if (!main) return;
        main.innerHTML = `
<div class="recipe-toolbar">
  <span class="recipe-toolbar-name">${esc(currentRecipe)}</span>
  <div class="recipe-toolbar-right">
    <button class="btn btn-secondary btn-small" onclick="Recipes._saveSnap()">Сохранить снимок</button>
    <button class="btn btn-secondary btn-small${baseline ? ' rcp-baseline-active' : ''}"
            id="rcpClearBtn"
            onclick="Recipes._clearBaseline()"
            ${baseline ? '' : 'disabled'}>
      ${baseline ? `Базовая: ${esc(baseline.label)} &nbsp;×` : 'Нет базовой линии'}
    </button>
    <label class="recipe-track-toggle">
      <input type="checkbox" id="trackToggle" ${tracking ? 'checked' : ''}
             onchange="Recipes._setTrack(this.checked)">
      Отслеживать изменения
    </label>
  </div>
</div>
<div id="monitorTableWrap" class="monitor-table-wrap"></div>
<div id="changeLogWrap" class="recipe-changes-section" style="${tracking ? '' : 'display:none;'}">
  <div class="recipe-changes-title">Журнал изменений</div>
  <div id="changeLogTable"><div class="recipe-empty">—</div></div>
</div>`;
    }

    function renderMonitorTable() {
        const wrap = document.getElementById('monitorTableWrap');
        if (!wrap) return;

        if (!liveMembers.length) {
            wrap.innerHTML = '<div class="recipe-empty" style="padding:30px;">Нет членов UDT. Возможно, pylogix не может прочитать структуру этого типа.</div>';
            return;
        }

        const hasBase = !!baseline;
        let changedCount = 0;

        let html = '';

        if (hasBase) {
            const total = liveMembers.filter(m => m.name in baseline.values).length;
            const changed = liveMembers.filter(m =>
                m.name in baseline.values && !valsEqual(m.value, baseline.values[m.name])).length;
            changedCount = changed;
            html += `<div class="mon-summary">
  Базовая линия: <strong>${esc(baseline.label)}</strong>
  <span id="monChangedSummary" style="margin-left:12px;color:${changed > 0 ? 'var(--dot-error)' : 'var(--dot-success)'};">
    ${changed > 0 ? `${changed} изменений из ${total}` : 'Без изменений'}
  </span>
</div>`;
        }

        html += `<table class="recipe-monitor-table data-table">
<thead><tr>
  <th>Поле</th>
  <th style="width:70px;">Тип</th>
  <th style="width:130px;">Значение</th>
  ${hasBase ? '<th style="width:130px;">Базовая</th><th style="width:32px;text-align:center;"></th>' : ''}
</tr></thead>
<tbody>`;

        for (const m of liveMembers) {
            const baseVal = hasBase ? (baseline.values[m.name] ?? '—') : null;
            const isChanged = hasBase && baseVal !== '—' && !valsEqual(m.value, baseVal);

            const vClass = m.type === 'BOOL'
                ? (m.value === '1' ? 'val-bool-on' : 'val-bool-off')
                : m.type === 'REAL' ? 'val-real'
                : m.type === 'STRING' ? 'val-str'
                : 'val-num';

            const bClass = hasBase && baseVal !== '—'
                ? (m.type === 'REAL' ? 'val-real' : m.type === 'STRING' ? 'val-str' : 'val-num')
                : '';

            html += `<tr class="diag-row${isChanged ? ' mon-row-changed' : ''}" data-member="${ea(m.name)}">
  <td class="tag-name-cell" style="font-size:11px;" title="${ea(m.name)}">${esc(m.display_name)}</td>
  <td><span class="type-badge">${esc(m.type)}</span></td>
  <td><span class="diag-val ${vClass} mon-live" data-mon="${ea(m.name)}">${esc(m.value)}</span></td>
  ${hasBase ? `<td><span class="diag-val ${bClass}">${esc(String(baseVal))}</span></td>
  <td style="text-align:center;font-size:14px;color:var(--dot-warning);">${isChanged ? '⚠' : ''}</td>` : ''}
</tr>`;
        }

        html += '</tbody></table>';
        wrap.innerHTML = html;
    }

    // ── User actions ──────────────────────────────────────────────────────────
    async function _select(name) {
        if (currentRecipe === name) return;
        stopPoll();
        currentRecipe = name;
        baseline = null;
        liveMembers = [];
        snapshots = [];

        document.querySelectorAll('.recipe-list-item').forEach(el => {
            el.classList.toggle('active', el.dataset.name === name);
        });

        renderMonitorShell();
        renderMonitorTable();
        await loadLive();
        await loadSnapshots();
        if (tracking) await loadChangeLog();
        startPoll();
    }

    async function _saveSnap() {
        const defaultLabel = `Снимок ${new Date().toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}`;
        const label = prompt('Название снимка:', defaultLabel);
        if (label === null) return;
        const values = {};
        for (const m of liveMembers) values[m.name] = m.value;
        try {
            const r = await fetch(`/api/recipes/${encodeURIComponent(currentRecipe)}/snapshots`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ label: label || defaultLabel, values }),
            });
            if (r.ok) await loadSnapshots();
        } catch (e) {}
    }

    async function _loadSnap(id) {
        const snap = snapshots.find(s => s.id === id);
        if (!snap) return;
        baseline = { id: snap.id, label: snap.label, values: snap.values };
        renderSnapshotList();
        renderMonitorShell();
        renderMonitorTable();
    }

    async function _delSnap(id) {
        if (!confirm('Удалить снимок?')) return;
        try {
            await fetch(`/api/recipes/snapshots/${id}`, { method: 'DELETE' });
            if (baseline && baseline.id === id) baseline = null;
            await loadSnapshots();
            if (baseline === null) {
                renderMonitorShell();
                renderMonitorTable();
            }
        } catch (e) {}
    }

    function _clearBaseline() {
        baseline = null;
        renderSnapshotList();
        renderMonitorShell();
        renderMonitorTable();
    }

    function _setTrack(enabled) {
        tracking = enabled;
        const wrap = document.getElementById('changeLogWrap');
        if (wrap) wrap.style.display = enabled ? '' : 'none';
        if (enabled && currentRecipe) loadChangeLog();
    }

    // ── Poll ──────────────────────────────────────────────────────────────────
    function startPoll() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(loadLive, POLL_MS);
    }

    function stopPoll() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    // ── Public ────────────────────────────────────────────────────────────────
    function onShow() {
        loadRecipes();
        if (currentRecipe) {
            loadLive();
            startPoll();
        }
    }

    function onHide() {
        stopPoll();
    }

    return {
        init, onShow, onHide,
        _select, _saveSnap, _loadSnap, _delSnap,
        _clearBaseline, _setTrack,
    };
})();
