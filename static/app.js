const API_BASE = '';
let tagsData = {};
let ioData = [];
let updateInterval = null;
let selectedTag = null;
let expandedItems = new Set();
let currentTab = 'tags';
let isConnected = false;
let searchFilter = '';
let typeFilter = '';
const momentaryState = new Map();
let pendingWrites = new Set();
let needsFullRender = true;  // флаг что нужна полная перерисовка

const el = id => document.getElementById(id);

const ipInput = el('ipInput');
const slotInput = el('slotInput');
const connectBtn = el('connectBtn');
const emulatorBtn = el('emulatorBtn');
const tagTree = el('tagTree');
const ioContainer = el('ioContainer');
const statusBadge = el('statusBadge');
const lastUpdate = el('lastUpdate');
const alertContainer = el('alertContainer');
const detailPanel = el('detailPanel');
const tagCount = el('tagCount');
const ioCount = el('ioCount');
const historyList = el('historyList');
const searchInput = el('searchInput');
const typeSelect = el('typeFilter');
const expandAllBtn = el('expandAllBtn');
const collapseAllBtn = el('collapseAllBtn');
const placeholder = el('placeholder');

function $on(elem, ev, fn) { if (elem) elem.addEventListener(ev, fn); }

$on(connectBtn, 'click', toggleConnection);
$on(emulatorBtn, 'click', toggleEmulator);
$on(searchInput, 'input', e => { searchFilter = e.target.value.toLowerCase(); needsFullRender = true; render(); });
$on(typeSelect, 'change', e => { typeFilter = e.target.value; needsFullRender = true; render(); });
$on(expandAllBtn, 'click', () => expandAll(true));
$on(collapseAllBtn, 'click', () => expandAll(false));

document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

function switchTab(name) {
    currentTab = name;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    el('tagsView').style.display = name === 'tags' ? 'flex' : 'none';
    el('ioView').style.display = name === 'io' ? 'flex' : 'none';
    needsFullRender = true;
    if (name === 'io' && isConnected) loadIO();
    render();
}

// ========== BOOL КНОПКИ - МГНОВЕННЫЙ ОТКЛИК ==========
window.toggleBool = function(tagName, ev) {
    if (ev) { ev.stopPropagation(); ev.preventDefault(); }
    const tag = findTag(tagName);
    if (!tag) return;
    const newValue = tag.value === '1' ? '0' : '1';
    instantWrite(tagName, newValue);
};

window.momentaryDown = function(tagName, btn, ev) {
    if (ev) { ev.stopPropagation(); ev.preventDefault(); }
    if (btn) btn.classList.add('holding');
    momentaryState.set(tagName, true);
    instantWrite(tagName, '1');
};

window.momentaryUp = function(tagName, btn, ev) {
    if (ev) { ev.stopPropagation(); ev.preventDefault(); }
    if (btn) btn.classList.remove('holding');
    if (momentaryState.get(tagName)) {
        momentaryState.delete(tagName);
        instantWrite(tagName, '0');
    }
};

// Мгновенная запись + локальное обновление DOM
function instantWrite(tagName, value) {
    pendingWrites.add(tagName);
    setTimeout(() => pendingWrites.delete(tagName), 1500);
    
    // Обновляем локально в данных
    updateLocalValue(tagName, value);
    
    // Обновляем точечно в DOM (без перерисовки!)
    patchDomValue(tagName, value);
    
    // Отправляем запрос (не ждём)
    fetch(`${API_BASE}/api/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: tagName, value }),
        keepalive: true
    }).catch(e => console.error('write error:', e));
}

// Обновить значение в данных (для logical state)
function updateLocalValue(tagName, value) {
    for (const cat in tagsData) {
        for (const tag of tagsData[cat]) {
            if (tag.name === tagName) { tag.value = value; return; }
            if (tag.fields) {
                for (const f of tag.fields) {
                    if (f.name === tagName) { f.value = value; return; }
                }
            }
            if (tag.elements) {
                for (const e of tag.elements) {
                    if (e.name === tagName) { e.value = value; return; }
                }
            }
        }
    }
    for (const mod of ioData) {
        for (const out of (mod.outputs || [])) {
            if (out.tag === tagName) { out.value = parseInt(value); return; }
        }
        for (const inp of (mod.inputs || [])) {
            if (inp.tag === tagName) { inp.value = parseInt(value); return; }
        }
    }
}

// Точечное обновление DOM по data-атрибуту
function patchDomValue(tagName, value) {
    // Все элементы с этим тегом
    const elements = document.querySelectorAll(`[data-value-of="${cssEscape(tagName)}"]`);
    elements.forEach(el => {
        el.textContent = value;
        // Обновляем класс для BOOL
        el.classList.remove('bool-true', 'bool-false');
        if (value === '1') el.classList.add('bool-true');
        else if (value === '0') el.classList.add('bool-false');
    });
    
    // Также обновим bool кнопки чтобы они знали актуальное значение
    const boolBtns = document.querySelectorAll(`[data-bool-tag="${cssEscape(tagName)}"]`);
    boolBtns.forEach(btn => {
        btn.dataset.currentValue = value;
    });
    
    // I/O channels
    const ioChannels = document.querySelectorAll(`[data-io-tag="${cssEscape(tagName)}"]`);
    ioChannels.forEach(ch => {
        const valEl = ch.querySelector('.io-channel-val');
        if (valEl) valEl.textContent = value;
        const isOutput = ch.classList.contains('output-on') || ch.classList.contains('output-off');
        const isInput = ch.classList.contains('input-on') || ch.classList.contains('input-off');
        ch.classList.remove('input-on', 'input-off', 'output-on', 'output-off');
        if (isOutput) ch.classList.add(value === '1' ? 'output-on' : 'output-off');
        else if (isInput) ch.classList.add(value === '1' ? 'input-on' : 'input-off');
    });
}

function cssEscape(s) {
    return String(s).replace(/[\\"]/g, '\\$&');
}

// ========== ПОДКЛЮЧЕНИЕ ==========
async function toggleConnection() {
    if (isConnected) await disconnect();
    else await connect();
}

async function connect() {
    const ip = ipInput.value.trim();
    const slot = parseInt(slotInput.value) || 0;
    if (!ip) { showAlert('Enter IP address', 'error'); return; }
    
    connectBtn.disabled = true;
    connectBtn.textContent = '⏳';
    
    try {
        const r = await fetch(`${API_BASE}/api/connect`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ip, slot })
        });
        if (r.ok) {
            const data = await r.json();
            showAlert(`✅ ${data.tag_count} tags, ${data.io_count} I/O`, 'success');
            updateStatus('online', ip, slot);
            isConnected = true;
            connectBtn.textContent = 'Disconnect';
            connectBtn.classList.add('btn-danger');
            needsFullRender = true;
            await loadTags();
            await loadIO();
            startAutoRefresh();
            loadHistory();
        } else {
            const err = await r.json();
            showAlert(`Error: ${err.detail}`, 'error');
            updateStatus('offline');
        }
    } catch (e) {
        showAlert(`Network error: ${e.message}`, 'error');
    } finally {
        connectBtn.disabled = false;
        if (!isConnected) connectBtn.textContent = 'Connect';
    }
}

async function disconnect() {
    try { await fetch(`${API_BASE}/api/disconnect`, { method: 'POST' }); } catch (e) {}
    isConnected = false;
    stopAutoRefresh();
    updateStatus('offline');
    connectBtn.textContent = 'Connect';
    connectBtn.classList.remove('btn-danger');
    if (emulatorBtn) {
        emulatorBtn.textContent = 'Emulator';
        emulatorBtn.classList.remove('active', 'btn-danger');
    }
    tagsData = {};
    ioData = [];
    selectedTag = null;
    detailPanel.classList.remove('active');
    if (placeholder) placeholder.style.display = 'block';
    needsFullRender = true;
    render();
    showAlert('Disconnected', 'success');
}

async function toggleEmulator() {
    if (isConnected) { await disconnect(); return; }
    await connectEmulator();
}

async function connectEmulator() {
    if (emulatorBtn) { emulatorBtn.disabled = true; emulatorBtn.textContent = '⏳'; }
    if (connectBtn) connectBtn.disabled = true;

    try {
        const r = await fetch(`${API_BASE}/api/emulator/connect`, { method: 'POST' });
        if (r.ok) {
            const data = await r.json();
            showAlert(`✅ Emulator: ${data.tag_count} tags`, 'success');
            updateStatus('online', 'EMULATOR', 0);
            isConnected = true;
            connectBtn.textContent = 'Disconnect';
            connectBtn.classList.add('btn-danger');
            if (emulatorBtn) {
                emulatorBtn.textContent = 'Disconnect';
                emulatorBtn.classList.add('active', 'btn-danger');
            }
            needsFullRender = true;
            await loadTags();
            await loadIO();
            startAutoRefresh();
        } else {
            const err = await r.json();
            showAlert(`Emulator error: ${err.detail}`, 'error');
        }
    } catch (e) {
        showAlert(`Error: ${e.message}`, 'error');
    } finally {
        if (emulatorBtn) emulatorBtn.disabled = false;
        if (connectBtn) connectBtn.disabled = false;
        if (!isConnected && emulatorBtn) emulatorBtn.textContent = 'Emulator';
    }
}

// ========== ЗАГРУЗКА ==========
async function loadTags() {
    try {
        const r = await fetch(`${API_BASE}/api/tags`);
        if (r.ok) {
            const data = await r.json();
            const newTagsData = data.tags;
            
            // Сохраним pending значения от перезаписи
            preservePendingValues(newTagsData);
            
            tagsData = newTagsData;
            updateLastUpdate(data.last_update);
            updateStats();
            
            if (currentTab === 'tags') {
                if (needsFullRender) {
                    renderTags();
                    needsFullRender = false;
                } else {
                    // Только обновим значения (DOM стабилен)
                    updateTreeValues();
                    if (selectedTag) updateDetailValues();
                }
            }
        } else updateStatus('error');
    } catch (e) { console.error('loadTags:', e); }
}

async function loadIO() {
    try {
        const r = await fetch(`${API_BASE}/api/io`);
        if (r.ok) {
            const newIoData = await r.json();
            preservePendingIO(newIoData);
            ioData = newIoData;
            window.ioData = ioData;
            updateStats();
            if (window.Diagnostics) Diagnostics.onIoUpdated();
            if (currentTab === 'io') {
                if (needsFullRender) {
                    renderIO();
                    needsFullRender = false;
                } else {
                    updateIOValues();
                }
            }
        }
    } catch (e) { console.error('loadIO:', e); }
}

function preservePendingValues(newData) {
    if (pendingWrites.size === 0) return;
    for (const cat in newData) {
        for (const tag of newData[cat]) {
            if (pendingWrites.has(tag.name)) {
                const old = findTag(tag.name);
                if (old) tag.value = old.value;
            }
            if (tag.fields) {
                for (const f of tag.fields) {
                    if (pendingWrites.has(f.name)) {
                        const old = findTag(f.name);
                        if (old) f.value = old.value;
                    }
                }
            }
            if (tag.elements) {
                for (const e of tag.elements) {
                    if (pendingWrites.has(e.name)) {
                        const old = findTag(e.name);
                        if (old) e.value = old.value;
                    }
                }
            }
        }
    }
}

function preservePendingIO(newData) {
    if (pendingWrites.size === 0) return;
    for (const mod of newData) {
        for (const out of (mod.outputs || [])) {
            if (pendingWrites.has(out.tag)) {
                // Сохраним старое значение
                const oldMod = ioData.find(m => m.slot === mod.slot);
                if (oldMod) {
                    const oldOut = oldMod.outputs.find(o => o.tag === out.tag);
                    if (oldOut) out.value = oldOut.value;
                }
            }
        }
    }
}

async function loadHistory() {
    try {
        const r = await fetch(`${API_BASE}/api/history`);
        if (r.ok) renderHistory(await r.json());
    } catch (e) {}
}

function renderHistory(items) {
    if (!items || items.length === 0) {
        historyList.innerHTML = '<div style="color:#64748b; font-size:11px; text-align:center; padding:8px;">Empty</div>';
        return;
    }
    historyList.innerHTML = items.map(h => {
        const isSuccess = h.status === 'success';
        return `<div class="history-item" onclick="quickConnect('${escAttr(h.ip)}', ${h.slot})">
            <span>${escHtml(h.ip)}:${h.slot}</span>
            <span class="history-item-status ${isSuccess ? 'success' : 'failed'}">${isSuccess ? '✓' : '✗'}</span>
        </div>`;
    }).join('');
}

window.quickConnect = (ip, slot) => {
    ipInput.value = ip;
    slotInput.value = slot;
    if (!isConnected) connect();
};

function render() {
    if (currentTab === 'tags') renderTags();
    else renderIO();
}

function updateStats() {
    const total = Object.values(tagsData).reduce((s, arr) => s + arr.length, 0);
    if (tagCount) tagCount.textContent = total;
    if (ioCount) ioCount.textContent = ioData.length;
}

function getCategoryInfo(cat) {
    return {
        'BOOL': { label: 'BOOL', icon: '◆', order: 1 },
        'SINT': { label: 'SINT', icon: '8', order: 2 },
        'INT': { label: 'INT', icon: '#', order: 3 },
        'DINT': { label: 'DINT', icon: '#', order: 4 },
        'LINT': { label: 'LINT', icon: '#', order: 5 },
        'REAL': { label: 'REAL', icon: '.', order: 6 },
        'STRING': { label: 'STRING', icon: 'A', order: 7 },
        'TIMER': { label: 'TIMER', icon: '⏱', order: 8 },
        'COUNTER': { label: 'COUNTER', icon: '🔢', order: 9 },
        'BOOL_ARRAY': { label: 'BOOL[]', icon: '◊', order: 11 },
        'DINT_ARRAY': { label: 'DINT[]', icon: '◊', order: 14 },
        'INT_ARRAY': { label: 'INT[]', icon: '◊', order: 13 },
        'SINT_ARRAY': { label: 'SINT[]', icon: '◊', order: 12 },
        'LINT_ARRAY': { label: 'LINT[]', icon: '◊', order: 15 },
        'REAL_ARRAY': { label: 'REAL[]', icon: '◊', order: 16 },
        'STRING_ARRAY': { label: 'STRING[]', icon: '◊', order: 17 },
        'TIMER_ARRAY': { label: 'TIMER[]', icon: '◊', order: 18 },
        'COUNTER_ARRAY': { label: 'COUNTER[]', icon: '◊', order: 19 },
        'UDT_ARRAY': { label: 'UDT[]', icon: '◊', order: 20 },
        'UDT': { label: 'UDT', icon: '◊', order: 21 },
        'IO': { label: 'I/O Tags', icon: '⚙', order: 22 },
        'MODULE': { label: 'Modules', icon: '📦', order: 23 }
    }[cat] || { label: cat, icon: '•', order: 99 };
}

function shortName(name) { return name.replace(/^Program:[^.]+\./, ''); }
function isBool(t) { return (t || '').toUpperCase() === 'BOOL'; }
function getValueClass(type, value) {
    const t = (type || '').toUpperCase();
    if (t === 'BOOL') return value === '1' ? 'bool-true' : 'bool-false';
    if (t === 'REAL') return 'real';
    if (t === 'STRING') return 'string';
    return 'numeric';
}

function matchesFilter(tag) {
    if (typeFilter && getTagFilterType(tag) !== typeFilter) return false;
    if (searchFilter && !tag.name.toLowerCase().includes(searchFilter)) return false;
    return true;
}

function getTagFilterType(tag) {
    const t = (tag.type || '').toUpperCase();
    if (tag.is_array) return 'ARRAY';
    if (t === 'BOOL') return 'BOOL';
    if (['SINT','INT','DINT','LINT'].includes(t)) return 'INT';
    if (t === 'REAL') return 'REAL';
    if (t === 'STRING') return 'STRING';
    if (t === 'TIMER') return 'TIMER';
    if (t === 'COUNTER') return 'COUNTER';
    return 'OTHER';
}

// ========== ПОЛНЫЙ РЕНДЕР (только при изменении структуры) ==========
function renderTags() {
    if (!tagsData || Object.keys(tagsData).length === 0) {
        tagTree.innerHTML = '<div class="empty-state"><div class="empty-state-icon">⚠️</div><div>No data</div></div>';
        return;
    }
    
    const categories = Object.keys(tagsData).sort((a, b) => 
        getCategoryInfo(a).order - getCategoryInfo(b).order);
    
    let html = '';
    for (const cat of categories) {
        const tags = (tagsData[cat] || []).filter(matchesFilter);
        if (tags.length === 0) continue;
        const info = getCategoryInfo(cat);
        html += `<div class="tree-section">
            <div class="tree-section-title">
                <span>${info.icon} ${info.label}</span>
                <span class="tree-section-count">${tags.length}</span>
            </div>`;
        for (const tag of tags) {
            html += renderTagItem(tag, cat);
        }
        html += `</div>`;
    }
    
    tagTree.innerHTML = html || '<div class="empty-state"><div class="empty-state-icon">🔍</div><div>Nothing found</div></div>';
    bindTreeEvents();
}

function renderTagItem(tag, category, indent = 0) {
    const isInt = ['SINT','INT','DINT','LINT'].includes((tag.type || '').toUpperCase());
    const isArray = tag.is_array === true;
    const hasFields = (tag.fields && tag.fields.length > 0);
    const canExpand = hasFields || isInt || isArray;
    const isExpanded = expandedItems.has(tag.name);
    const valClass = getValueClass(tag.type, tag.value);
    const padding = indent * 16;
    const isBoolTag = isBool(tag.type);
    const escName = escAttr(tag.name);
    
    let html = `<div class="tree-item">
        <div class="tree-row" data-tag="${escName}" style="padding-left: ${10 + padding}px;">
            <span class="tree-toggle ${canExpand ? '' : 'empty'} ${isExpanded ? 'expanded' : ''}" data-toggle="${escName}">▶</span>
            <span class="tree-icon">${getCategoryInfo(category).icon}</span>
            <span class="tree-name" title="${escName}">${escHtml(shortName(tag.name))}</span>
            <span class="tree-value ${valClass}" data-value-of="${escName}">${escHtml(tag.value)}</span>
            ${isBoolTag ? boolControlsHtml(tag.name) : ''}
        </div>`;
    
    if (canExpand && isExpanded) {
        html += `<div class="tree-children expanded">`;
        if (isArray && tag.elements) {
            for (const elem of tag.elements) html += renderArrayElement(elem, indent + 1);
        } else if (hasFields) {
            for (const f of tag.fields) {
                const fClass = getValueClass(f.type, f.value);
                const isBoolField = isBool(f.type);
                const escFName = escAttr(f.name);
                html += `<div class="tree-row" data-tag="${escFName}" style="padding-left: ${10 + (indent + 1) * 16}px;">
                    <span class="tree-toggle empty"></span>
                    <span class="tree-icon">·</span>
                    <span class="tree-name">${escHtml(f.display_name)}<span style="color:#64748b; font-size:10px;"> (${escHtml(f.type)})</span></span>
                    <span class="tree-value ${fClass}" data-value-of="${escFName}">${escHtml(f.value)}</span>
                    ${isBoolField ? boolControlsHtml(f.name) : ''}
                </div>`;
            }
        } else if (isInt && tag.bits) {
            html += renderBitsGrid(tag, indent + 1);
        }
        html += `</div>`;
    }
    html += `</div>`;
    return html;
}

function renderArrayElement(elem, indent) {
    const isInt = ['SINT','INT','DINT','LINT'].includes((elem.type || '').toUpperCase());
    const isExpanded = expandedItems.has(elem.name);
    const valClass = getValueClass(elem.type, elem.value);
    const padding = indent * 16;
    const isBoolElem = isBool(elem.type);
    const escName = escAttr(elem.name);
    
    let html = `<div class="tree-item">
        <div class="tree-row" data-tag="${escName}" style="padding-left: ${10 + padding}px;">
            <span class="tree-toggle ${isInt ? '' : 'empty'} ${isExpanded ? 'expanded' : ''}" data-toggle="${escName}">▶</span>
            <span class="tree-icon">[]</span>
            <span class="tree-name">${escHtml(elem.display_name)}<span style="color:#64748b; font-size:10px;"> (${escHtml(elem.type)})</span></span>
            <span class="tree-value ${valClass}" data-value-of="${escName}">${escHtml(elem.value)}</span>
            ${isBoolElem ? boolControlsHtml(elem.name) : ''}
        </div>`;
    if (isInt && isExpanded && elem.bits) {
        html += `<div class="tree-children expanded">`;
        html += renderBitsGrid(elem, indent + 1);
        html += `</div>`;
    }
    html += `</div>`;
    return html;
}

function renderBitsGrid(tag, indent) {
    const numBits = tag.num_bits || 32;
    const padding = indent * 16;
    let html = `<div class="bits-wrapper" data-bits-of="${escAttr(tag.name)}" style="padding: 6px 8px 6px ${10 + padding}px;">
        <div style="font-size:10px; color:#94a3b8; margin-bottom:4px;">HEX: <span class="hex-value" data-hex-of="${escAttr(tag.name)}" style="color:#fbbf24;">${escHtml(tag.hex)}</span></div>
        <div class="bits-grid bits-${numBits}">`;
    for (let i = numBits - 1; i >= 0; i--) {
        const v = tag.bits[i];
        html += `<div class="bit-cell ${v ? 'bit-on' : 'bit-off'}" data-bit="${i}" data-bit-parent="${escAttr(tag.name)}" title="bit ${i}">
            <div class="bit-num">${i}</div>
            <div class="bit-val">${v}</div>
        </div>`;
    }
    html += `</div></div>`;
    return html;
}

function boolControlsHtml(tagName) {
    const t = escAttr(tagName);
    return `<div class="bool-controls" onclick="event.stopPropagation()">
        <span class="bool-btn bool-btn-toggle" data-bool-tag="${t}"
              onclick="toggleBool('${t}', event)"
              title="Toggle">⇄</span>
        <span class="bool-btn bool-btn-momentary" data-bool-tag="${t}"
              onmousedown="momentaryDown('${t}', this, event)"
              onmouseup="momentaryUp('${t}', this, event)"
              onmouseleave="momentaryUp('${t}', this, event)"
              ontouchstart="momentaryDown('${t}', this, event)"
              ontouchend="momentaryUp('${t}', this, event)"
              ontouchcancel="momentaryUp('${t}', this, event)"
              title="Hold">⏺</span>
    </div>`;
}

// ========== ТОЧЕЧНОЕ ОБНОВЛЕНИЕ ЗНАЧЕНИЙ (без перерисовки) ==========
function updateTreeValues() {
    // Обновляем только текст и классы у существующих элементов
    for (const cat in tagsData) {
        for (const tag of tagsData[cat]) {
            updateValueInDom(tag.name, tag.value, tag.type);
            // Обновим биты если есть
            if (tag.bits) updateBitsInDom(tag);
            // Поля
            if (tag.fields) {
                for (const f of tag.fields) {
                    updateValueInDom(f.name, f.value, f.type);
                }
            }
            // Элементы массива
            if (tag.elements) {
                for (const e of tag.elements) {
                    updateValueInDom(e.name, e.value, e.type);
                    if (e.bits) updateBitsInDom(e);
                }
            }
        }
    }
}

function updateValueInDom(tagName, value, type) {
    if (pendingWrites.has(tagName)) return; // не трогаем pending
    
    const elements = document.querySelectorAll(`[data-value-of="${cssEscape(tagName)}"]`);
    elements.forEach(el => {
        if (el.textContent !== String(value)) {
            el.textContent = value;
        }
        if (isBool(type)) {
            const newCls = value === '1' ? 'bool-true' : 'bool-false';
            const oldCls = value === '1' ? 'bool-false' : 'bool-true';
            if (!el.classList.contains(newCls)) {
                el.classList.remove(oldCls);
                el.classList.add(newCls);
            }
        }
    });
}

function updateBitsInDom(tag) {
    if (pendingWrites.has(tag.name)) return;
    
    // Обновим hex
    const hexEl = document.querySelector(`[data-hex-of="${cssEscape(tag.name)}"]`);
    if (hexEl && hexEl.textContent !== tag.hex) {
        hexEl.textContent = tag.hex;
    }
    
    // Обновим биты
    const wrapper = document.querySelector(`[data-bits-of="${cssEscape(tag.name)}"]`);
    if (!wrapper || !tag.bits) return;
    
    const cells = wrapper.querySelectorAll('.bit-cell');
    cells.forEach(cell => {
        const idx = parseInt(cell.dataset.bit);
        if (isNaN(idx)) return;
        const v = tag.bits[idx];
        const valEl = cell.querySelector('.bit-val');
        if (valEl && valEl.textContent !== String(v)) {
            valEl.textContent = v;
        }
        const newCls = v ? 'bit-on' : 'bit-off';
        const oldCls = v ? 'bit-off' : 'bit-on';
        if (!cell.classList.contains(newCls)) {
            cell.classList.remove(oldCls);
            cell.classList.add(newCls);
        }
    });
}

function bindTreeEvents() {
    tagTree.querySelectorAll('[data-toggle]').forEach(e => {
        e.onclick = (ev) => {
            ev.stopPropagation();
            const id = e.dataset.toggle;
            if (expandedItems.has(id)) expandedItems.delete(id);
            else expandedItems.add(id);
            needsFullRender = true;
            renderTags();
        };
    });
    
    tagTree.querySelectorAll('[data-tag]').forEach(e => {
        e.onclick = (ev) => {
            if (ev.target.dataset.toggle) return;
            if (ev.target.closest('.bool-controls')) return;
            if (ev.target.classList.contains('bool-btn')) return;
            const name = e.dataset.tag;
            const tag = findTag(name);
            if (tag) {
                selectedTag = tag;
                if (placeholder) placeholder.style.display = 'none';
                renderDetail();
            }
        };
    });
}

function findTag(name) {
    for (const cat in tagsData) {
        for (const tag of tagsData[cat]) {
            if (tag.name === name) return tag;
            if (tag.fields) {
                const f = tag.fields.find(x => x.name === name);
                if (f) return f;
            }
            if (tag.elements) {
                const e = tag.elements.find(x => x.name === name);
                if (e) return e;
            }
        }
    }
    return null;
}

// ========== ДЕТАЛЬНАЯ ПАНЕЛЬ ==========
function renderDetail() {
    if (!selectedTag) {
        detailPanel.classList.remove('active');
        return;
    }
    detailPanel.classList.add('active');
    
    const t = selectedTag;
    const isInt = ['SINT','INT','DINT','LINT'].includes((t.type || '').toUpperCase());
    const isArray = t.is_array === true;
    const isBoolTag = isBool(t.type);
    const valClass = getValueClass(t.type, t.value);
    const escName = escAttr(t.name);
    
    let html = `<div class="detail-header">
        <div class="detail-name">${escHtml(t.name)}</div>
        <div class="detail-meta">
            <span class="detail-meta-tag">Type: ${escHtml(t.type)}${isArray ? `[${t.array_size}]` : ''}</span>
        </div>
    </div>
    <div class="value-display">
        <div class="value-label">Value:</div>
        <div class="value-data ${valClass}" data-value-of="${escName}" ${!isArray && !isBoolTag ? `data-edit="${escName}"` : ''}>${escHtml(t.value)}</div>
    </div>`;
    
    if (isBoolTag) {
        const tEsc = escName;
        html += `<div class="bool-action-row">
            <div class="value-label">Actions:</div>
            <div class="bool-action-buttons">
                <div class="bool-action-btn toggle"
                     onclick="toggleBool('${tEsc}', event)">⇄ Toggle</div>
                <div class="bool-action-btn momentary"
                     onmousedown="momentaryDown('${tEsc}', this, event)"
                     onmouseup="momentaryUp('${tEsc}', this, event)"
                     onmouseleave="momentaryUp('${tEsc}', this, event)"
                     ontouchstart="momentaryDown('${tEsc}', this, event)"
                     ontouchend="momentaryUp('${tEsc}', this, event)"
                     ontouchcancel="momentaryUp('${tEsc}', this, event)">⏺ Momentary (Hold)</div>
            </div>
        </div>`;
    }
    
    if (isInt && t.hex) {
        html += `<div class="value-display">
            <div class="value-label">Hex:</div>
            <div class="value-data" data-hex-of="${escName}" style="color:#fbbf24;">${escHtml(t.hex)}</div>
        </div>`;
        if (t.bits) {
            const numBits = t.num_bits;
            html += `<div class="bits-section" data-bits-of="${escName}">
                <div class="bits-title">Bits (${numBits})</div>
                <div class="bits-grid bits-${numBits}">`;
            for (let i = numBits - 1; i >= 0; i--) {
                const v = t.bits[i];
                html += `<div class="bit-cell ${v ? 'bit-on' : 'bit-off'}" data-bit="${i}" data-bit-parent="${escName}" title="${escName}.${i}">
                    <div class="bit-num">${i}</div>
                    <div class="bit-val">${v}</div>
                </div>`;
            }
            html += `</div></div>`;
        }
    }
    
    if (isArray && t.elements) {
        html += `<div class="fields-section">
            <div class="bits-title">Array elements (${t.array_size})</div>
            <div class="fields-grid" style="grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));">`;
        for (const elem of t.elements) {
            const ec = getValueClass(elem.type, elem.value);
            const isBE = isBool(elem.type);
            const eName = escAttr(elem.name);
            html += `<div class="field-card" style="grid-template-columns: 1fr ${isBE ? '120px' : '100px'};">
                <div class="field-info">
                    <div class="field-name-row">
                        <span class="field-name">${escHtml(elem.display_name)}</span>
                        ${elem.hex ? `<span class="field-type" style="background:rgba(245,158,11,0.2); color:#fbbf24;">${escHtml(elem.hex)}</span>` : ''}
                    </div>
                </div>
                <div style="display:flex; gap:4px; align-items:center;">
                    <div class="field-value ${ec}" data-value-of="${eName}" ${!isBE ? `data-edit="${eName}"` : ''} style="flex:1;">${escHtml(elem.value)}</div>
                    ${isBE ? boolControlsHtml(elem.name) : ''}
                </div>
            </div>`;
        }
        html += `</div></div>`;
    }
    
    if (t.fields && t.fields.length > 0) {
        html += `<div class="fields-section">
            <div class="bits-title">Structure fields</div>
            <div class="fields-grid">`;
        for (const f of t.fields) {
            const fc = getValueClass(f.type, f.value);
            const isBF = isBool(f.type);
            const fName = escAttr(f.name);
            html += `<div class="field-card">
                <div class="field-info">
                    <div class="field-name-row">
                        <span class="field-name">${escHtml(f.display_name)}</span>
                        <span class="field-type">${escHtml(f.type)}</span>
                    </div>
                    ${f.desc ? `<div class="field-desc">${escHtml(f.desc)}</div>` : ''}
                </div>
                <div style="display:flex; gap:4px; align-items:center;">
                    <div class="field-value ${fc}" data-value-of="${fName}" ${!isBF ? `data-edit="${fName}"` : ''} style="flex:1;">${escHtml(f.value)}</div>
                    ${isBF ? boolControlsHtml(f.name) : ''}
                </div>
            </div>`;
        }
        html += `</div></div>`;
    }
    
    detailPanel.innerHTML = html;
    detailPanel.querySelectorAll('[data-edit]').forEach(e => {
        e.onclick = () => editValue(e.dataset.edit);
    });
}

function updateDetailValues() {
    if (!selectedTag) return;
    const fresh = findTag(selectedTag.name);
    if (!fresh) return;
    selectedTag = fresh;
    
    // Обновим только значения в детальной панели
    updateValueInDom(fresh.name, fresh.value, fresh.type);
    if (fresh.bits) updateBitsInDom(fresh);
    if (fresh.fields) {
        for (const f of fresh.fields) {
            updateValueInDom(f.name, f.value, f.type);
        }
    }
    if (fresh.elements) {
        for (const e of fresh.elements) {
            updateValueInDom(e.name, e.value, e.type);
        }
    }
}

// ========== I/O ==========
function renderIO() {
    if (!ioContainer) return;
    if (!ioData || ioData.length === 0) {
        ioContainer.innerHTML = isConnected
            ? '<div class="empty-state"><div class="empty-state-icon">⚙️</div><div>No I/O modules found</div></div>'
            : '<div class="empty-state"><div class="empty-state-icon">⚙️</div><div>Connect to PLC</div></div>';
        return;
    }
    
    let html = '';
    for (const mod of ioData) {
        html += `<div class="io-module">
            <div class="io-module-header">
                <div class="io-module-title">📦 Slot ${mod.slot}</div>
                <div class="io-module-info">
                    ${mod.has_input ? `<span class="io-tag">Local:${mod.slot}:I</span>` : ''}
                    ${mod.has_output ? `<span class="io-tag">Local:${mod.slot}:O</span>` : ''}
                </div>
            </div>`;
        
        if (mod.inputs && mod.inputs.length > 0) {
            const activeCount = mod.inputs.filter(x => x.value).length;
            html += `<div class="io-section">
                <div class="io-section-title">🟢 Inputs — ${mod.inputs.length} <span class="io-active-count" data-count-input="${mod.slot}" style="color:#4ade80;">(${activeCount} active)</span></div>
                <div class="io-channels">`;
            for (const inp of mod.inputs) {
                const cls = inp.value ? 'input-on' : 'input-off';
                html += `<div class="io-channel ${cls}" data-io-tag="${escAttr(inp.tag)}" title="${escAttr(inp.tag)}">
                    <div class="io-channel-num">CH${inp.channel}</div>
                    <div class="io-channel-val">${inp.value}</div>
                </div>`;
            }
            html += `</div></div>`;
        }
        
        if (mod.outputs && mod.outputs.length > 0) {
            const activeCount = mod.outputs.filter(x => x.value).length;
            html += `<div class="io-section">
                <div class="io-section-title">🟠 Outputs — ${mod.outputs.length} <span class="io-active-count" data-count-output="${mod.slot}" style="color:#fb923c;">(${activeCount} active)</span></div>
                <div class="io-channels">`;
            for (const out of mod.outputs) {
                const cls = out.value ? 'output-on' : 'output-off';
                const t = escAttr(out.tag);
                html += `<div class="io-channel ${cls}" data-io-tag="${t}" title="${t}"
                    onclick="toggleBool('${t}', event)">
                    <div class="io-channel-num">CH${out.channel}</div>
                    <div class="io-channel-val">${out.value}</div>
                </div>`;
            }
            html += `</div></div>`;
        }
        
        if (mod.analog_inputs && mod.analog_inputs.length > 0) {
            html += `<div class="io-section">
                <div class="io-section-title">📊 Analog inputs</div>
                <div class="io-analog">`;
            for (const ch of mod.analog_inputs) {
                html += `<div class="analog-card" data-analog-tag="${escAttr(ch.tag)}">
                    <span class="analog-name">Ch${ch.channel}</span>
                    <span class="analog-value">${Number(ch.value).toFixed(2)}</span>
                </div>`;
            }
            html += `</div></div>`;
        }
        
        if (mod.analog_outputs && mod.analog_outputs.length > 0) {
            html += `<div class="io-section">
                <div class="io-section-title">📊 Analog outputs</div>
                <div class="io-analog">`;
            for (const ch of mod.analog_outputs) {
                html += `<div class="analog-card" data-analog-tag="${escAttr(ch.tag)}" onclick="editValue('${escAttr(ch.tag)}')" style="cursor:pointer;">
                    <span class="analog-name">Ch${ch.channel}</span>
                    <span class="analog-value">${Number(ch.value).toFixed(2)}</span>
                </div>`;
            }
            html += `</div></div>`;
        }
        
        html += `</div>`;
    }
    ioContainer.innerHTML = html;
}

function updateIOValues() {
    for (const mod of ioData) {
        // Дискретные входы
        for (const inp of (mod.inputs || [])) {
            if (pendingWrites.has(inp.tag)) continue;
            const cell = document.querySelector(`[data-io-tag="${cssEscape(inp.tag)}"]`);
            if (!cell) continue;
            const valEl = cell.querySelector('.io-channel-val');
            if (valEl && valEl.textContent !== String(inp.value)) {
                valEl.textContent = inp.value;
            }
            const newCls = inp.value ? 'input-on' : 'input-off';
            const oldCls = inp.value ? 'input-off' : 'input-on';
            if (!cell.classList.contains(newCls)) {
                cell.classList.remove(oldCls);
                cell.classList.add(newCls);
            }
        }
        // Дискретные выходы
        for (const out of (mod.outputs || [])) {
            if (pendingWrites.has(out.tag)) continue;
            const cell = document.querySelector(`[data-io-tag="${cssEscape(out.tag)}"]`);
            if (!cell) continue;
            const valEl = cell.querySelector('.io-channel-val');
            if (valEl && valEl.textContent !== String(out.value)) {
                valEl.textContent = out.value;
            }
            const newCls = out.value ? 'output-on' : 'output-off';
            const oldCls = out.value ? 'output-off' : 'output-on';
            if (!cell.classList.contains(newCls)) {
                cell.classList.remove(oldCls);
                cell.classList.add(newCls);
            }
        }
        // Аналоговые
        for (const ch of (mod.analog_inputs || [])) {
            const cell = document.querySelector(`[data-analog-tag="${cssEscape(ch.tag)}"]`);
            if (!cell) continue;
            const valEl = cell.querySelector('.analog-value');
            const newVal = Number(ch.value).toFixed(2);
            if (valEl && valEl.textContent !== newVal) {
                valEl.textContent = newVal;
            }
        }
        for (const ch of (mod.analog_outputs || [])) {
            const cell = document.querySelector(`[data-analog-tag="${cssEscape(ch.tag)}"]`);
            if (!cell) continue;
            const valEl = cell.querySelector('.analog-value');
            const newVal = Number(ch.value).toFixed(2);
            if (valEl && valEl.textContent !== newVal) {
                valEl.textContent = newVal;
            }
        }
    }
}

function expandAll(expand) {
    if (expand) {
        for (const cat in tagsData) {
            for (const tag of tagsData[cat]) {
                expandedItems.add(tag.name);
                if (tag.elements) for (const e of tag.elements) expandedItems.add(e.name);
            }
        }
    } else {
        expandedItems.clear();
    }
    needsFullRender = true;
    renderTags();
}

window.editValue = function(tagName) {
    const v = prompt(`New value for:\n${tagName}`, '');
    if (v !== null && v !== '') instantWrite(tagName, v);
};

function updateStatus(status, ip, slot) {
    if (status === 'online') {
        statusBadge.textContent = `🟢 ${ip}:${slot}`;
        statusBadge.className = 'status-badge online';
    } else if (status === 'error') {
        statusBadge.textContent = '⚠️ Error';
        statusBadge.className = 'status-badge error';
    } else {
        statusBadge.textContent = '🔴 Offline';
        statusBadge.className = 'status-badge';
    }
}

function updateLastUpdate(ts) {
    if (!ts) return;
    const d = new Date(ts);
    lastUpdate.textContent = `🕒 ${d.toLocaleTimeString()}`;
}

function startAutoRefresh() {
    if (updateInterval) clearInterval(updateInterval);
    updateInterval = setInterval(() => {
        loadTags();
        loadIO();
    }, 300);
}

function stopAutoRefresh() {
    if (updateInterval) clearInterval(updateInterval);
    updateInterval = null;
}

async function syncServerState() {
    try {
        const r = await fetch(`${API_BASE}/api/status`);
        if (!r.ok) return;
        const s = await r.json();
        if (s.status !== 'online') return;
        // Сервер уже подключён — синхронизируем UI без повторного connect()
        isConnected = true;
        if (s.ip && s.ip !== 'EMULATOR' && ipInput) ipInput.value = s.ip;
        if (s.slot != null && slotInput) slotInput.value = s.slot;
        updateStatus('online', s.ip, s.slot);
        connectBtn.textContent = 'Disconnect';
        connectBtn.classList.add('btn-danger');
        if (s.ip === 'EMULATOR' && emulatorBtn) {
            emulatorBtn.textContent = 'Disconnect';
            emulatorBtn.classList.add('active', 'btn-danger');
        }
        needsFullRender = true;
        await loadTags();
        await loadIO();
        startAutoRefresh();
    } catch (_) {}
}

function showAlert(msg, type) {
    const a = document.createElement('div');
    a.className = `alert alert-${type}`;
    a.textContent = msg;
    alertContainer.appendChild(a);
    setTimeout(() => a.remove(), 3500);
}

function escHtml(t) {
    if (t == null) return '';
    const d = document.createElement('div');
    d.textContent = String(t);
    return d.innerHTML;
}

function escAttr(t) {
    if (t == null) return '';
    return String(t).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

loadHistory();
syncServerState();
