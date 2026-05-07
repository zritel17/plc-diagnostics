/**
 * TagCfg — управление списком тегов для сбора (SQLite через REST).
 * Использует window.tagsData (заполняется существующим app.js при коннекте к ПЛК).
 */
window.TagCfg = (() => {
    let configs = [];

    async function loadConfigs() {
        try {
            const r = await fetch('/api/config/tags');
            configs = await r.json();
            renderTable();
        } catch (e) {
            console.error('load configs:', e);
        }
    }

    function renderTable() {
        const tbody = document.getElementById('cfgTableBody');
        const counter = document.getElementById('cfgCounter');
        if (!tbody) return;
        counter.textContent = `(${configs.length})`;
        if (!configs.length) {
            tbody.innerHTML = '<tr><td colspan="6" class="empty-row">Список пуст. Подключитесь к ПЛК на вкладке «Теги» и нажмите «+ Добавить из ПЛК».</td></tr>';
            return;
        }
        tbody.innerHTML = configs.map(c => {
            const isChange = c.update_mode === 'on_change';
            const param = isChange
                ? `<input type="number" step="0.1" min="0" value="${c.deadband ?? 0}" data-id="${c.id}" data-field="deadband" /> <span class="muted">deadband</span>`
                : `<input type="number" min="1" value="${c.interval_sec ?? 1}" data-id="${c.id}" data-field="interval_sec" /> <span class="muted">сек</span>`;
            return `<tr data-id="${c.id}">
                <td class="tag-name-cell" title="${esc(c.tag_name)}">${esc(c.tag_name)}</td>
                <td><span class="muted">${esc(c.tag_type || '—')}</span></td>
                <td>
                    <select data-id="${c.id}" data-field="update_mode">
                        <option value="on_change" ${isChange?'selected':''}>on_change</option>
                        <option value="on_interval" ${!isChange?'selected':''}>on_interval</option>
                    </select>
                </td>
                <td>${param}</td>
                <td><input type="checkbox" data-id="${c.id}" data-field="enabled" ${c.enabled?'checked':''} /></td>
                <td><button class="btn btn-danger btn-small del-btn" data-tag="${esc(c.tag_name)}">🗑</button></td>
            </tr>`;
        }).join('');

        tbody.querySelectorAll('input,select').forEach(el => {
            el.addEventListener('change', onCellChange);
        });
        tbody.querySelectorAll('.del-btn').forEach(b => {
            b.addEventListener('click', () => deleteTag(b.dataset.tag));
        });
    }

    async function onCellChange(e) {
        const id = parseInt(e.target.dataset.id, 10);
        const field = e.target.dataset.field;
        const cfg = configs.find(c => c.id === id);
        if (!cfg) return;
        if (field === 'enabled') cfg.enabled = e.target.checked ? 1 : 0;
        else if (field === 'update_mode') {
            cfg.update_mode = e.target.value;
            if (cfg.update_mode === 'on_interval' && !cfg.interval_sec) cfg.interval_sec = 5;
        }
        else if (field === 'deadband') cfg.deadband = parseFloat(e.target.value) || 0;
        else if (field === 'interval_sec') cfg.interval_sec = parseInt(e.target.value, 10) || 1;
        await saveOne(cfg);
        renderTable();
    }

    async function saveOne(cfg) {
        const payload = {
            tags: [{
                tag_name: cfg.tag_name,
                tag_type: cfg.tag_type,
                update_mode: cfg.update_mode,
                interval_sec: cfg.interval_sec,
                deadband: cfg.deadband || 0,
                enabled: cfg.enabled ? 1 : 0,
            }],
            replace_all: false,
        };
        try {
            await fetch('/api/config/tags/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
        } catch (e) {
            console.error('saveOne:', e);
        }
    }

    async function deleteTag(name) {
        if (!confirm(`Удалить «${name}» из сбора?`)) return;
        try {
            await fetch(`/api/config/tags/${encodeURIComponent(name)}`, { method: 'DELETE' });
            await loadConfigs();
        } catch (e) {
            alert(`Ошибка: ${e.message}`);
        }
    }

    function flattenTagTree(tree) {
        const result = [];
        for (const cat of Object.keys(tree || {})) {
            for (const tag of tree[cat] || []) {
                if (tag.is_array && Array.isArray(tag.elements)) {
                    for (const el of tag.elements) {
                        result.push({ name: el.name, type: el.type });
                    }
                } else {
                    result.push({ name: tag.name, type: tag.type });
                    if (Array.isArray(tag.fields)) {
                        for (const f of tag.fields) {
                            result.push({ name: f.name, type: f.type });
                        }
                    }
                }
            }
        }
        return result;
    }

    async function fetchPlcTagsViaApi() {
        // Быстрый путь: /api/tags/list — только имена/типы из кэша (без чтения с ПЛК)
        try {
            const r = await fetch('/api/tags/list');
            if (r.status === 400) {
                const err = await r.json().catch(() => ({}));
                throw new Error(err.detail || 'Нет подключения к ПЛК. Откройте вкладку «Теги» и подключитесь.');
            }
            if (r.ok) {
                const data = await r.json();
                return data.tags || [];
            }
        } catch (e) {
            // если эндпоинт недоступен (старая версия) — попробуем full tree
        }
        // Fallback: window.tagsData (если app.js его выставил) или /api/tags
        if (window.tagsData && Object.keys(window.tagsData).length) {
            return flattenTagTree(window.tagsData);
        }
        const r = await fetch('/api/tags');
        if (r.status === 400) {
            const err = await r.json().catch(() => ({}));
            throw new Error(err.detail || 'Нет подключения к ПЛК. Откройте вкладку «Теги» и подключитесь.');
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        return flattenTagTree(data.tags || {});
    }

    async function openAddModal() {
        const btn = document.getElementById('cfgAddFromPlcBtn');
        const oldText = btn ? btn.textContent : null;
        if (btn) { btn.disabled = true; btn.textContent = '⏳ Загружаю теги…'; }
        try {
            const flatTags = await fetchPlcTagsViaApi();
            if (!flatTags.length) {
                alert('Нет тегов в ПЛК.');
                return;
            }
            const existing = new Set(configs.map(c => c.tag_name));
            const available = flatTags.filter(t => !existing.has(t.name));
            if (!available.length) {
                alert('Все теги ПЛК уже добавлены в сбор.');
                return;
            }
            renderModal(available);
        } catch (e) {
            alert(`Не удалось получить теги: ${e.message}`);
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = oldText; }
        }
    }

    function renderModal(tags) {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal">
                <div class="modal-header">
                    <span>Добавить теги в сбор · доступно ${tags.length}</span>
                    <button class="modal-close">×</button>
                </div>
                <div class="modal-body">
                    <input type="text" id="modalSearch" placeholder="🔍 Фильтр по имени или типу" style="width:100%; margin-bottom:10px;" />
                    <div style="display:flex; gap: 12px; align-items:center; flex-wrap:wrap; margin-bottom:10px;">
                        <span class="muted">Режим по умолчанию:</span>
                        <select id="modalMode">
                            <option value="on_change">on_change</option>
                            <option value="on_interval">on_interval</option>
                        </select>
                        <span class="muted">Параметр (deadband для float / интервал в сек):</span>
                        <input type="number" id="modalParam" value="0" step="0.1" min="0" style="width:80px;" />
                        <button class="btn btn-secondary btn-small" id="modalSelectAll">Выбрать все видимые</button>
                        <button class="btn btn-secondary btn-small" id="modalClear">Очистить</button>
                    </div>
                    <div class="modal-list" id="modalList">
                        ${tags.map(t => `
                            <label class="modal-item">
                                <input type="checkbox" value="${esc(t.name)}" data-type="${esc(t.type)}" />
                                <span class="tag-name-cell">${esc(t.name)}</span>
                                <span class="muted" style="margin-left:auto;">${esc(t.type)}</span>
                            </label>
                        `).join('')}
                    </div>
                </div>
                <div class="modal-footer">
                    <span class="muted" id="modalCount">0 выбрано</span>
                    <button class="btn btn-secondary" id="modalCancelBtn">Отмена</button>
                    <button class="btn" id="modalSaveBtn">Добавить выбранные</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const list = overlay.querySelector('#modalList');
        const countEl = overlay.querySelector('#modalCount');
        const searchEl = overlay.querySelector('#modalSearch');

        const updateCount = () => {
            countEl.textContent = `${list.querySelectorAll('input:checked').length} выбрано`;
        };
        list.addEventListener('change', updateCount);

        searchEl.addEventListener('input', () => {
            const q = searchEl.value.toLowerCase();
            list.querySelectorAll('.modal-item').forEach(it => {
                it.style.display = it.textContent.toLowerCase().includes(q) ? 'flex' : 'none';
            });
        });

        overlay.querySelector('#modalSelectAll').addEventListener('click', () => {
            list.querySelectorAll('.modal-item').forEach(it => {
                if (it.style.display !== 'none') it.querySelector('input').checked = true;
            });
            updateCount();
        });
        overlay.querySelector('#modalClear').addEventListener('click', () => {
            list.querySelectorAll('input:checked').forEach(c => c.checked = false);
            updateCount();
        });

        const close = () => overlay.remove();
        overlay.querySelector('.modal-close').addEventListener('click', close);
        overlay.querySelector('#modalCancelBtn').addEventListener('click', close);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

        overlay.querySelector('#modalSaveBtn').addEventListener('click', async () => {
            const checks = Array.from(list.querySelectorAll('input:checked'));
            if (!checks.length) { close(); return; }
            const mode = overlay.querySelector('#modalMode').value;
            const param = parseFloat(overlay.querySelector('#modalParam').value) || 0;
            const payload = {
                tags: checks.map(c => ({
                    tag_name: c.value,
                    tag_type: c.dataset.type,
                    update_mode: mode,
                    interval_sec: mode === 'on_interval' ? Math.max(1, Math.floor(param || 1)) : null,
                    deadband: mode === 'on_change' ? param : 0,
                    enabled: 1,
                })),
                replace_all: false,
            };
            try {
                const r = await fetch('/api/config/tags/save', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                if (r.ok) {
                    close();
                    await loadConfigs();
                } else {
                    alert('Ошибка сохранения');
                }
            } catch (e) {
                alert(`Ошибка: ${e.message}`);
            }
        });
    }

    function esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    function init() {
        const refreshBtn = document.getElementById('cfgRefreshBtn');
        const addBtn = document.getElementById('cfgAddFromPlcBtn');
        if (!refreshBtn) return;
        refreshBtn.addEventListener('click', loadConfigs);
        addBtn.addEventListener('click', openAddModal);
        loadConfigs();
    }

    return { init, loadConfigs };
})();
