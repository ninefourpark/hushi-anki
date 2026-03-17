/**
 * 词汇蜘蛛纸牌 — 核心逻辑
 * 支持多词库 / 蜘蛛语法导入 / 哈希进度 / 词库管理
 */

// ============================================================
//  全局状态
// ============================================================

let activeGroups = [];
let currentDeckId = null;
let sortableInstances = [];
let waitingDeck = [];
let sessionCompletedHashes = [];

// ============================================================
//  1. 哈希工具
// ============================================================

function simpleHash(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function getCardHash(type, contentArray) {
    const combined = type + '|' + contentArray.join('').replace(/\s+/g, '').toLowerCase();
    return simpleHash(combined);
}

function enrichCardsWithHash(cards) {
    return cards.map(card => {
        if (!card.hash) card.hash = getCardHash(card.type, card.content);
        return card;
    });
}

// ============================================================
//  2. 词库注册表
// ============================================================

function getRegistry() {
    try { return JSON.parse(localStorage.getItem('deck_registry')) || []; }
    catch { return []; }
}

function saveRegistry(reg) {
    localStorage.setItem('deck_registry', JSON.stringify(reg));
}

function registerDeck(deck) {
    const reg = getRegistry();
    const idx = reg.findIndex(r => r.deck_id === deck.deck_metadata.deck_id);
    const entry = {
        deck_id: deck.deck_metadata.deck_id,
        title: deck.deck_metadata.title,
        language: deck.deck_metadata.language || ['en'],
        tags: deck.deck_metadata.tags || [],
        source: deck.deck_metadata.author === 'built-in' ? 'builtin' : 'user',
        description: deck.deck_metadata.description || '',
        card_count: deck.cards.length
    };
    if (idx >= 0) reg[idx] = entry;
    else reg.push(entry);
    saveRegistry(reg);
}

function storeDeck(deck) {
    const enriched = { ...deck, cards: enrichCardsWithHash(deck.cards) };
    localStorage.setItem('deck_' + deck.deck_metadata.deck_id, JSON.stringify(enriched));
    registerDeck(enriched);
    return enriched;
}

function loadDeckById(deck_id) {
    try { return JSON.parse(localStorage.getItem('deck_' + deck_id)); }
    catch { return null; }
}

function deleteDeck(deck_id) {
    localStorage.removeItem('deck_' + deck_id);
    saveRegistry(getRegistry().filter(r => r.deck_id !== deck_id));
}

// ============================================================
//  3. 进度存储 (key = deck_id|hash)
// ============================================================

function getStats() {
    try { return JSON.parse(localStorage.getItem('word_stats_v2')) || {}; }
    catch { return {}; }
}

function saveStats(stats) {
    localStorage.setItem('word_stats_v2', JSON.stringify(stats));
}

function getStatKey(deck_id, hash) { return deck_id + '|' + hash; }

function updateMemoryStage(deck_id, hash) {
    if (!deck_id || !hash) return;
    const stats = getStats();
    const key = getStatKey(deck_id, hash);
    let item = stats[key] || { stage: 0, nextReview: 0 };
    const intervals = [0, 1, 2, 4, 7, 15, 30, 180];
    item.stage = Math.min(item.stage + 1, intervals.length - 1);
    const now = new Date();
    const nextDate = new Date(now.setDate(now.getDate() + intervals[item.stage]));
    item.nextReview = nextDate.setHours(0, 0, 0, 0);
    item.lastInteracted = Date.now();
    stats[key] = item;
    saveStats(stats);
}

// ============================================================
//  4. 内置词库首次写入
// ============================================================

async function ensureBuiltinDecks() {
    const reg = getRegistry();
    if (reg.some(r => r.source === 'builtin')) return;

    try {
        const response = await fetch('wordbase.json');
        if (!response.ok) return;
        const raw = await response.json();

        if (raw.deck_metadata) {
            storeDeck(raw);
        } else if (raw.levels) {
            // 旧格式兼容：每个 level → 一个词库
            raw.levels.forEach(level => {
                const cards = [];
                for (const type in (level.categories || {})) {
                    level.categories[type].forEach(group => {
                        cards.push({ type, group_name: group.group_name, content: group.content });
                    });
                }
                const deck = {
                    deck_metadata: {
                        deck_id: 'builtin-level-' + level.level_id,
                        title: level.level_name,
                        language: ['en'],
                        tags: [],
                        author: 'built-in',
                        version: '1.0.0',
                        created_at: new Date().toISOString().split('T')[0],
                        description: ''
                    },
                    cards
                };
                storeDeck(deck);
            });
        }
    } catch (e) {
        console.warn('内置词库加载失败', e);
    }
}

// ============================================================
//  5. 初始化游戏
// ============================================================

async function initGame(deck_id) {
    sessionCompletedHashes = [];

    const reg = getRegistry();
    if (!deck_id && reg.length > 0) deck_id = reg[0].deck_id;
    if (!deck_id) { console.warn('没有可用词库'); return; }

    // 保存用户最后选中的词库
    localStorage.setItem('last_deck_id', deck_id);

    currentDeckId = deck_id;
    const deck = loadDeckById(deck_id);
    if (!deck) { console.warn('词库未找到:', deck_id); return; }

    document.getElementById('level-title').innerText = deck.deck_metadata.title;

    const lang = (deck.deck_metadata.language || ['en'])[0];
    document.querySelector('.board').dataset.deckLang = lang;

    const stats = getStats();
    const now = Date.now();
    const MAX_GROUPS = 5;

    let reviewPool = [], newWordsPool = [], learningPool = [];

    (deck.cards || []).forEach(card => {
        card._runtimeId = card.hash;
        const key = getStatKey(deck_id, card.hash);
        const stat = stats[key];
        if (!stat) newWordsPool.push(card);
        else if (stat.stage < 7) {
            if (now >= stat.nextReview) reviewPool.push(card);
            else learningPool.push(card);
        }
    });

    // 随机排序
    //[reviewPool, newWordsPool, learningPool].forEach(p => p.sort(() => Math.random() - 0.5));

    // 错过复习的牌不会有任何惩罚，只是安静地待在 reviewPool 里
    // 但假设用户消失了两周，回来时 reviewPool 里积了 20 张逾期的牌，但每局最多只抽 Math.floor(5 * 0.3) = 1 张复习牌，剩下 19 张只能慢慢排队。新词还在继续涌进来，复习债永远还不完。
    //const maxReview = Math.floor(MAX_GROUPS * 0.3);
    //const reviewSlice = reviewPool.slice(0, maxReview);
    //const newSlice = newWordsPool.slice(0, MAX_GROUPS - reviewSlice.length);

    // 改成：
    reviewPool.sort((a, b) => {
        const sa = stats[getStatKey(deck_id, a.hash)];
        const sb = stats[getStatKey(deck_id, b.hash)];
        return (sa?.nextReview || 0) - (sb?.nextReview || 0); // 最久逾期的排最前
    });
    newWordsPool.sort(() => Math.random() - 0.5);
    learningPool.sort(() => Math.random() - 0.5);

    const overdueCount = reviewPool.length;
    // totalCards 是在算 这个词库里还没毕业（达到 stage=7）的牌一共有多少张
    const totalCards = (deck.cards || []).filter(c => { 
        const s = stats[getStatKey(deck_id, c.hash)];
        return !s || s.stage < 7;
    }).length;

    // 逾期牌占待学总量的比例，决定本局复习配额
    // 比例 0% → 最多 1 组复习，比例 100% → 最多 5 组全是复习
    const overdueRatio = totalCards > 0 ? overdueCount / totalCards : 0;
    const maxReview = Math.max(1, Math.round(MAX_GROUPS * Math.min(overdueRatio * 1.5, 1))); // 乘以 1.5 是为了让比例稍高时能更快拉满配额; 超过 1 就截断到 1
    const reviewSlice = reviewPool.slice(0, maxReview);
    const newSlice = newWordsPool.slice(0, MAX_GROUPS - reviewSlice.length);

    const fillSlice = learningPool.slice(0, MAX_GROUPS - reviewSlice.length - newSlice.length);

    activeGroups = [...reviewSlice, ...newSlice, ...fillSlice];

    if (activeGroups.length === 0) {
        alert('恭喜你，通关了！本词库所有单词已达到最高记忆等级（Stage）。是时候看看其他词库了！');
        return;
    }

    ThinkTank.init(activeGroups);
    renderBoard();
    updateDeckSelectorUI();
}

// ============================================================
//  6. 词库选择器 UI
// ============================================================

const LANG_LABELS = { en: 'English', ja: '日本語', zh: '中文', ko: '한국어', fr: 'Français', de: 'Deutsch' };

function buildDeckSelector() {
    const container = document.getElementById('deck-selector-list');
    if (!container) return;
    container.innerHTML = '';
    const reg = getRegistry();

    if (reg.length === 0) {
        container.innerHTML = '<div class="deck-empty-hint">暂无词库，请先导入</div>';
        return;
    }

    // 按语言分组
    const grouped = {};
    reg.forEach(r => {
        const lang = (r.language || ['?'])[0];
        if (!grouped[lang]) grouped[lang] = [];
        grouped[lang].push(r);
    });

    Object.keys(grouped).forEach(lang => {
        const label = document.createElement('div');
        label.className = 'deck-lang-label';
        label.textContent = LANG_LABELS[lang] || lang.toUpperCase();
        container.appendChild(label);

        grouped[lang].forEach(entry => {
            const item = document.createElement('div');
            item.className = 'deck-selector-item' + (entry.deck_id === currentDeckId ? ' active' : '');

            const titleEl = document.createElement('span');
            titleEl.className = 'deck-item-title';
            titleEl.textContent = entry.title;

            //const metaEl = document.createElement('span');
            //metaEl.className = 'deck-item-meta';
            //const tagStr = (entry.tags || []).join(' · ');
            //const countStr = entry.card_count ? entry.card_count + '组' : '';
            //metaEl.textContent = [tagStr, countStr].filter(Boolean).join(' · ');

            item.appendChild(titleEl);
            //item.appendChild(metaEl);

            if (entry.source !== 'builtin') {

                const editBtn = document.createElement('button');
                editBtn.className = 'deck-edit-btn';
                editBtn.textContent = '编辑';
                editBtn.title = '编辑词库内容';
                editBtn.onclick = (e) => { e.stopPropagation(); openDeckEditor(entry.deck_id); };
                item.appendChild(editBtn);

                const delBtn = document.createElement('button');
                delBtn.className = 'deck-delete-btn';
                delBtn.textContent = '×';
                delBtn.title = '删除词库';
                delBtn.onclick = (e) => confirmDeleteDeck(entry.deck_id, e);
                item.appendChild(delBtn);
            }

            item.addEventListener('click', () => {
                closeAllMenus();
                initGame(entry.deck_id);
            });
            container.appendChild(item);
        });
    });
}

function updateDeckSelectorUI() {
    buildDeckSelector();

    // 同步手机端抽屉
    const drawerContainer = document.getElementById('drawer-deck-list');
    if (!drawerContainer) return;
    drawerContainer.innerHTML = '';
    getRegistry().forEach(entry => {
        const item = document.createElement('div');

        if (entry.source === 'builtin') {
            // 内置词库：点击直接切换，不显示二级面板
            item.className = 'drawer-item' + (entry.deck_id === currentDeckId ? ' drawer-item-active' : '');
            item.textContent = entry.title;
            item.addEventListener('click', () => { toggleMobileDrawer(); initGame(entry.deck_id); });
        } else {
            // 用户词库：点击展开二级面板
            item.innerHTML = `
                <details class="xp-collapse">
                    <summary class="drawer-item xp-collapse-title ${entry.deck_id === currentDeckId ? 'drawer-item-active' : ''}">
                        ${entry.title}
                        <span class="drawer-item-arrow">►</span>
                    </summary>
                    <div class="xp-collapse-body">
                        <div class="drawer-item drawer-deck-primary">▶️ 切换到此词库</div>
                        <div class="drawer-item drawer-deck-edit">✏️ 编辑内容</div>
                        <div class="drawer-item drawer-deck-danger">删除词库</div>
                    </div>
                </details>
            `;

            item.querySelector('.drawer-deck-primary').addEventListener('click', () => {
                toggleMobileDrawer();
                initGame(entry.deck_id);
            });
            item.querySelector('.drawer-deck-edit').addEventListener('click', () => {
                toggleMobileDrawer();
                setTimeout(() => openDeckEditor(entry.deck_id), 50);
            });
            item.querySelector('.drawer-deck-danger').addEventListener('click', () => {
                confirmDeleteDeck(entry.deck_id, { stopPropagation: () => {} });
            });
        }

        drawerContainer.appendChild(item);
    });
}

function openDeckEditor(deck_id) {
    const deck = loadDeckById(deck_id);
    if (!deck) return;

    // 把词库转回蜘蛛语法
    const m = deck.deck_metadata;
    const lines = [
        `@title: ${m.title}`,
        `@language: ${(m.language || ['en'])[0]}`,
        `@tags: ${(m.tags || []).join(', ')}`,
        ''
    ];
    (deck.cards || []).forEach(card => {
        switch (card.type) {
            case 'sentence_builder':  lines.push(card.content.join(' + ')); break;
            case 'intensity_ranking': lines.push(card.content.join(' > ')); break;
            case 'dialogue_chain':    lines.push(card.content.join(' // ')); break;
            case 'context_sorting':   lines.push(`#${card.group_name || 'Group'}: ${card.content.join(', ')}`); break;
        }
    });

    // 打开对话框，填入内容
    const textarea = document.getElementById('paste-textarea');
    textarea.value = lines.join('\n');
    document.getElementById('paste-dialog').classList.add('show');
    
    // 在对话框上记录正在编辑的 deck_id
    document.getElementById('paste-dialog').dataset.editingDeckId = deck_id;

    setTimeout(() => { textarea.focus(); }, 50);
}

function confirmDeleteDeck(deck_id, e) {
    e.stopPropagation();
    if (confirm('确定删除这个词库吗？该操作无法撤销！')) {
        deleteDeck(deck_id);
        if (currentDeckId === deck_id) {
            const reg = getRegistry();
            if (reg.length > 0) initGame(reg[0].deck_id);
            else updateDeckSelectorUI();
        } else {
            updateDeckSelectorUI();
        }
    }
}

// ============================================================
//  7. 蜘蛛语法解析
// ============================================================

function normalizeLanguageCode(input) {
    const map = {
        english: 'en', en: 'en', 'english': 'en', 'eng': 'en', '英语': 'en', 'en-us': 'en',
        japanese: 'ja', ja: 'ja', 'japanese': 'ja', 'jp': 'ja', 'jpn': 'ja', '日本語': 'ja', '日语': 'ja', '日文': 'ja',
        chinese: 'zh', zh: 'zh', 'chinese': 'zh', 'cn': 'zh', 'chi': 'zh', 'zh-cn': 'zh', 'zh-CN': 'zh', '中文': 'zh', '汉语': 'zh', '漢語': 'zh', '普通话': 'zh', '简体中文': 'zh', '繁体中文': 'zh', '简体': 'zh', '繁体': 'zh', '中国語': 'zh',
        korean: 'ko', ko: 'ko', 'kor': 'ko', 'korean': 'ko', '한국어': 'ko', '朝鲜语': 'ko', '韩语': 'ko', '韓語': 'ko', '韩文': 'ko',
        french: 'fr', fr: 'fr', 'fra': 'fr', 'fre': 'fr', 'français': 'fr', '法语': 'fr', '法語': 'fr', '法國語': 'fr', '法文': 'fr',
        german: 'de', de: 'de', 'ger': 'de',  'german': 'de', 'germany': 'de', 'deu': 'de', 'deutsch': 'de', '德语': 'de', '德文': 'de', 
        spanish: 'es', es: 'es', 'spa': 'es', 'spanish': 'es', 'español': 'es', '西班牙语': 'es', '西班牙語': 'es',
    };
    return map[input] || input;
}

function parseSpiderSyntax(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);
    const meta = { title: '我的词库', language: ['en'], tags: [] };
    const cards = [];

    lines.forEach(line => {
        if (line.startsWith('@title:')) { meta.title = line.slice(7).trim(); return; }
        if (line.startsWith('@language:')) {
            const langs = line.slice(10).split(',').map(s => normalizeLanguageCode(s.trim().toLowerCase())).filter(Boolean);
            meta.language = langs;
            return;
        }
        if (line.startsWith('@tags:')) {
            meta.tags = line.slice(6).split(',').map(t => t.trim()).filter(Boolean); return;
        }
        if (line.startsWith('@')) return;

        // 全角符号兼容
        const n = line.replace(/＋/g, '+').replace(/＞/g, '>').replace(/／／/g, '//').replace(/＃/g, '#').replace(/、、/g, ',').replace(/：：/g, ':');

        if (n.includes('+')) {
            const parts = n.split('+').map(p => p.trim()).filter(Boolean);
            if (parts.length >= 2) cards.push({ type: 'sentence_builder', content: parts });
            return;
        }
        if (n.includes('>')) {
            const parts = n.split('>').map(p => p.trim()).filter(Boolean);
            if (parts.length >= 2) cards.push({ type: 'intensity_ranking', content: parts });
            return;
        }
        if (n.includes('//')) {
            const parts = n.split('//').map(p => p.trim()).filter(Boolean);
            if (parts.length >= 2) cards.push({ type: 'dialogue_chain', content: parts });
            return;
        }
        if (n.startsWith('#')) {
            const colonIdx = n.indexOf(':');
            if (colonIdx > 0) {
                const group_name = n.slice(1, colonIdx).trim();
                const items = n.slice(colonIdx + 1).split(',').map(s => s.trim()).filter(Boolean);
                if (items.length >= 2) cards.push({ type: 'context_sorting', group_name, content: items });
            }
        }
    });

    return { meta, cards };
}

async function importFromClipboard() {
    try {
        const text = await navigator.clipboard.readText();
        if (!text.trim()) { alert('剪贴板是空的。'); return; }
        importSpiderText(text);
    } catch {
        showPasteDialog();
    }
}


function showPasteDialog() {
    const template = `@title: 我的词库
@language: en
@tags: 日常生活, 基础词汇

I'd like + a hot + latte.
Good > Great > Amazing
#Fruit: apple,banana,orange
Can I help you? // Yes, I'm looking for a shirt. // What size do you wear?

`;

    const textarea = document.getElementById('paste-textarea');
    document.getElementById('paste-dialog').classList.add('show');
    
    // 1. 设置内容
    textarea.value = template;

    setTimeout(() => {
        textarea.focus();
        textarea.select();
    }, 50);
}

function closePasteDialog() {
    document.getElementById('paste-dialog').classList.remove('show');
}

function confirmPasteImport() {
    const text = document.getElementById('paste-textarea').value;
    if (!text.trim()) { alert('请填写文本。'); return; }

    const { meta, cards } = parseSpiderSyntax(text);

    if (meta.language.length > 1) {
        alert('@language 只能填写一种语言。\n\n例如：\n  @language: en\n  @language: ja\n  @language: zh');
        return;
    }
    if (cards.length === 0) {
        alert('没有识别到有效的卡片。');
        return;
    }

    // 判断是编辑模式还是新建模式
    const editingId = document.getElementById('paste-dialog').dataset.editingDeckId;

    closePasteDialog();

    if (editingId) {
        // 覆盖原词库，保留 deck_id（进度不丢失）
        const existing = loadDeckById(editingId);
        const deck = {
            deck_metadata: {
                ...existing.deck_metadata,   // 保留 deck_id、created_at 等
                title: meta.title,
                language: meta.language,
                secondary_language: meta.secondary_language || [],
                tags: meta.tags,
                version: bumpVersion(existing.deck_metadata.version)
            },
            cards
        };
        storeDeck(deck);
        alert(`「${meta.title}」已更新，共 ${cards.length} 组卡片。`);
        updateDeckSelectorUI();
        initGame(editingId);
    } else {
        importSpiderText(text);
    }

}

function bumpVersion(version = '1.0.0') {
    const parts = version.split('.').map(Number);
    parts[2] = (parts[2] || 0) + 1;
    return parts.join('.');
}

function closePasteDialog() {
    const dialog = document.getElementById('paste-dialog');
    dialog.classList.remove('show');
    delete dialog.dataset.editingDeckId;  // 清除编辑状态
}


function importSpiderText(text) {
    const { meta, cards } = parseSpiderSyntax(text);
    if (cards.length === 0) {
        alert('没有识别到有效的卡片。\n请检查格式：\n  连词成句：词1 + 词2 + 词3\n  程度排序：低 > 中 > 高\n  对话链：A // B // C\n  同类词：#组名: 词1, 词2');
        return;
    }
    const deck_id = 'user-' + Date.now();
    const deck = {
        deck_metadata: {
            deck_id,
            title: meta.title,
            language: meta.language,
            tags: meta.tags,
            author: 'user',
            version: '1.0.0',
            created_at: new Date().toISOString().split('T')[0],
            description: ''
        },
        cards
    };
    storeDeck(deck);
    alert(`「${meta.title}」导入成功！共 ${cards.length} 组卡片。`);
    updateDeckSelectorUI();
    initGame(deck_id);
}

// ============================================================
//  8. 导入 / 导出词库
// ============================================================

function exportCurrentDeckJSON() {
    const deck = loadDeckById(currentDeckId);
    if (!deck) return alert('未找到词库数据。');
    const blob = new Blob([JSON.stringify(deck, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (deck.deck_metadata.title || 'deck') + '.json';
    a.click();
    URL.revokeObjectURL(url);
}

function exportCurrentDeckAsSpider() {
    const deck = loadDeckById(currentDeckId);
    if (!deck) return alert('未找到词库数据。');
    const m = deck.deck_metadata;
    const lines = [
        `@title:${m.title}`,
        `@language:${(m.language || ['en'])[0]}`,
        `@tags:${(m.tags || []).join(',')}`,
        ''
    ];
    (deck.cards || []).forEach(card => {
        switch (card.type) {
            case 'sentence_builder':  lines.push(card.content.join(' + ')); break;
            case 'intensity_ranking': lines.push(card.content.join(' > ')); break;
            case 'dialogue_chain':    lines.push(card.content.join(' // ')); break;
            case 'context_sorting':   lines.push(`#${card.group_name || 'Group'}: ${card.content.join(', ')}`); break;
        }
    });
    const text = lines.join('\n');
    navigator.clipboard.writeText(text).then(() => {
        alert('词库已复制到剪贴板！');
    }).catch(() => {
        document.getElementById('export-textarea').value = text;
        document.getElementById('export-text-dialog').classList.add('show');
    });
}

function closeExportTextDialog() {
    document.getElementById('export-text-dialog').classList.remove('show');
}

function importDeckJSONFile(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const deck = JSON.parse(e.target.result);
            if (!deck.deck_metadata || !deck.cards) {
                alert('格式不正确：文件需包含 deck_metadata 和 cards 字段。');
                return;
            }
            storeDeck(deck);
            alert(`「${deck.deck_metadata.title}」导入成功！`);
            updateDeckSelectorUI();
            initGame(deck.deck_metadata.deck_id);
        } catch {
            alert('文件损坏或格式不正确。');
        }
    };
    reader.readAsText(file);
    event.target.value = '';
}

// ============================================================
//  9. 进度备份 / 恢复
// ============================================================

function exportProgress() {
    const stats = getStats();
    if (Object.keys(stats).length === 0) return alert('没有可以备份的进度数据。');
    const blob = new Blob([JSON.stringify(stats, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `progress_backup_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

function importProgress(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const json = JSON.parse(e.target.result);
            if (typeof json !== 'object') throw new Error();
            saveStats({ ...getStats(), ...json }); // 合并，不覆盖
            alert('进度恢复成功！');
            initGame(currentDeckId);
        } catch { alert('文件损坏或格式不正确。'); }
    };
    reader.readAsText(file);
    event.target.value = '';
}

// 兼容旧菜单调用
function exportUserData() { exportProgress(); }
function importUserData(event) { importProgress(event); }

function resetProgress() {
    if (confirm('确定要清除当前词库的所有学习进度吗？')) {
        const stats = getStats();
        Object.keys(stats).forEach(key => { if (key.startsWith(currentDeckId + '|')) delete stats[key]; });
        saveStats(stats);
        initGame(currentDeckId);
    }
}

// ============================================================
//  10. 渲染棋盘
// ============================================================

function renderBoard() {
    document.querySelectorAll('.sortable-list').forEach(el => el.innerHTML = '');

    let allCards = [];
    activeGroups.forEach(group => {
        group.content.forEach((text, index) => {
            allCards.push({
                text,
                groupId: group._runtimeId || group.hash,
                order: index,
                total: group.content.length,
                category: group.type,
                lang: currentDeckLang()
            });
        });
    });

    allCards.sort(() => Math.random() - 0.5);

    const initialCount = Math.min(allCards.length, 12);
    waitingDeck = allCards.slice(initialCount);

    allCards.slice(0, initialCount).forEach((card, i) => {
        const colIndex = i % 4;
        const cardHtml = createCardElement(card);
        if (i < 8) cardHtml.classList.add('is-flipped');
        document.getElementById(`col-${colIndex + 1}`).appendChild(cardHtml);
    });

    updateDeckUI();
    setupSortable();
    refreshFlippedState();
}

function currentDeckLang() {
    const deck = loadDeckById(currentDeckId);
    return deck ? (deck.deck_metadata.language || ['en'])[0] : 'en';
}

// ============================================================
//  11. 卡片 DOM
// ============================================================

function createCardElement(cardData) {
    const div = document.createElement('div');
    div.className = 'card';
    div.dataset.category = cardData.category || 'default';
    div.dataset.groupId = cardData.groupId;
    div.dataset.order = cardData.order;

    const text = document.createElement('div');
    text.className = 'card-text';
    text.innerText = cardData.text;
    text.lang = cardData.lang || 'en';
    div.appendChild(text);

    if (parseInt(cardData.order) === 0) {
        div.classList.add('root-card');
        const badge = document.createElement('div');
        badge.className = 'card-badge';
        badge.innerText = `1/${cardData.total || '?'}`;
        div.appendChild(badge);
    }
    return div;
}

// ============================================================
//  12. 菜单
// ============================================================

let openMenu = null;
let menuActive = false;
let menuIndex = 0;
const menuItems = document.querySelectorAll('.xp-menubar > li');

function toggleMenu(menuId, el) {
    const menu = document.getElementById(menuId);
    if (openMenu === menu) { menu.classList.add('hidden'); openMenu = null; return; }
    document.querySelectorAll('.dropdown').forEach(m => m.classList.add('hidden'));
    menu.classList.remove('hidden');
    openMenu = menu;
    const rect = el.getBoundingClientRect();
    menu.style.left = rect.left + 'px';
    menu.style.top = rect.bottom + 'px';
}

function closeAllMenus() {
    document.querySelectorAll('.dropdown').forEach(m => m.classList.add('hidden'));
    openMenu = null;
}

document.addEventListener('click', e => {
    if (!e.target.closest('.menu-item') && !e.target.closest('.dropdown')) closeAllMenus();
});

document.addEventListener('keydown', e => {

    // 如果焦点在输入框或文本域内，不拦截任何键盘事件
    const tag = document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if (e.key === 'Alt') {
        e.preventDefault();
        menuActive = !menuActive;
        if (menuActive) { menuIndex = 0; menuItems[0].focus(); menuItems[0].classList.add('menu-open'); }
        else closeMenus();
    }
    if (!menuActive) return;
    if (e.key === 'ArrowRight') { menuIndex = (menuIndex + 1) % menuItems.length; focusMenu(); }
    if (e.key === 'ArrowLeft')  { menuIndex = (menuIndex - 1 + menuItems.length) % menuItems.length; focusMenu(); }
    if (e.key === 'ArrowDown')  { const sub = menuItems[menuIndex].querySelector('ul'); if (sub) { sub.style.display = 'block'; const fi = sub.querySelector('li'); if (fi) fi.focus(); } }
    if (e.key === 'Escape') closeMenus();
});

function focusMenu() {
    menuItems.forEach(m => m.classList.remove('menu-open'));
    menuItems[menuIndex].focus();
    menuItems[menuIndex].classList.add('menu-open');
}
function closeMenus() {
    menuActive = false;
    document.querySelectorAll('.xp-menubar ul').forEach(m => m.style.display = '');
    menuItems.forEach(m => m.classList.remove('menu-open'));
}

// ============================================================
//  13. 字体 / 卡背 / 花色
// ============================================================

function setCardFont(lang, fontKey) {
    document.body.dataset['font' + lang.charAt(0).toUpperCase() + lang.slice(1)] = fontKey;
    localStorage.setItem('card_font_' + lang, fontKey);
}

function restoreFontSettings() {
    ['en', 'ja', 'zh'].forEach(lang => {
        const saved = localStorage.getItem('card_font_' + lang);
        if (saved) setCardFont(lang, saved);
    });
}

function setCardBack(theme) {
    document.body.dataset.cardBack = theme;
    localStorage.setItem('card_back_theme', theme);
}

function setSuitTheme(theme) {
    document.body.dataset.suitTheme = theme;
    localStorage.setItem('suit_theme', theme);
}


// ============================================================
//  14. 拖拽
// ============================================================

const eliminatingGroups = new Set();

function setupSortable() {
    sortableInstances.forEach(i => i.destroy());
    sortableInstances = [];

    document.querySelectorAll('.sortable-list').forEach(col => {
        const s = new Sortable(col, {
            group: 'shared', animation: 150, filter: '.is-flipped', preventOnFilter: true,
            delay: 50, delayOnTouchOnly: true,
            ghostClass: 'sortable-ghost', chosenClass: 'sortable-chosen', dragClass: 'sortable-drag',

            onStart(evt) {
                const itemEl = evt.item;
                const cards = Array.from(itemEl.parentNode.querySelectorAll('.card'));
                const index = cards.indexOf(itemEl);
                const groupId = itemEl.dataset.groupId;
                const category = itemEl.dataset.category;
                let currentOrder = parseInt(itemEl.dataset.order);
                itemEl._bundledCards = [];
                itemEl.style.zIndex = '9999';
                itemEl.style.position = 'relative';

                for (let i = index + 1; i < cards.length; i++) {
                    const next = cards[i];
                    if (next.dataset.groupId !== groupId || next.classList.contains('is-flipped')) break;
                    let bundle = false;
                    if (category === 'context_sorting') {
                        bundle = true;
                    } else {
                        const nextOrder = parseInt(next.dataset.order);
                        if (nextOrder === currentOrder + 1) { bundle = true; currentOrder = nextOrder; }
                    }
                    if (bundle) { next.classList.add('is-bundled'); itemEl._bundledCards.push(next); }
                    else break;
                }

                if (itemEl._bundledCards.length > 0) {
                    const stack = document.createElement('div');
                    stack.className = 'drag-stack';
                    itemEl._bundledCards.forEach((card, i) => {
                        const clone = card.cloneNode(true);
                        clone.classList.remove('is-bundled');
                        clone.classList.add('drag-clone');
                        clone.style.marginTop = '0';
                        clone.style.transform = `translateY(${(i + 1) * 60}px)`;
                        stack.appendChild(clone);
                    });
                    itemEl.appendChild(stack);
                }
            },

            onMove: evt => evt.related ? (evt.related.nextElementSibling === null && evt.willInsertAfter) : true,

            onEnd(evt) {
                const itemEl = evt.item;
                if (ThinkTank.isOverTank(evt.originalEvent.clientX, evt.originalEvent.clientY)) {
                    ThinkTank.receive(itemEl);
                    evt.from.appendChild(itemEl);
                    itemEl._bundledCards = [];
                    return;
                }
                const bundled = itemEl._bundledCards || [];
                const targetCol = evt.to;
                itemEl.style.zIndex = '';
                itemEl.style.position = '';

                if (bundled.length > 0 && targetCol) {
                    bundled.forEach((card, i) => {
                        card.style.transition = 'none';
                        card.style.transform = `translateY(${(i + 1) * 60}px)`;
                        card.classList.remove('is-bundled');
                        card.style.visibility = 'visible';
                        card.style.opacity = '1';
                        targetCol.appendChild(card);
                    });
                    itemEl.offsetHeight;
                    bundled.forEach(card => { card.style.transform = 'translateY(0)'; });
                }

                const stack = itemEl.querySelector('.drag-stack');
                if (stack) stack.remove();

                setTimeout(() => {
                    bundled.forEach(card => card.style.transition = '');
                    itemEl._bundledCards = [];
                    refreshFlippedState();
                    checkAllColumns();
                }, 160);
            }
        });
        sortableInstances.push(s);
    });
}

// ============================================================
//  15. 翻牌 / 发牌
// ============================================================

function refreshFlippedState() {
    document.querySelectorAll('.sortable-list').forEach(col => {
        const cards = col.querySelectorAll('.card');
        if (cards.length > 0) cards[cards.length - 1].classList.remove('is-flipped');
    });
}

function dealCards() {
    if (waitingDeck.length === 0) return;
    const deckRect = document.getElementById('deck-pile').getBoundingClientRect();
    for (let i = 1; i <= 4; i++) {
        if (waitingDeck.length > 0) {
            const cardData = waitingDeck.shift();
            setTimeout(() => animateCardFlight(deckRect, document.getElementById(`col-${i}`), cardData), i * 150);
        }
    }
}

function animateCardFlight(startRect, targetCol, cardData) {
    const isMobile = window.innerWidth <= 600;
    const cardHeight = isMobile ? 130 : 160;
    const stackStep = isMobile ? 50 : 60;
    const flyer = document.createElement('div');
    flyer.className = 'flying-card';
    flyer.style.cssText = `left:${startRect.left}px;top:${startRect.top}px;width:${targetCol.clientWidth}px;height:${cardHeight}px`;
    document.body.appendChild(flyer);
    flyer.getBoundingClientRect();
    const colRect = targetCol.getBoundingClientRect();
    let targetTop = colRect.top + targetCol.querySelectorAll('.card').length * stackStep;
    if (targetTop > window.innerHeight - cardHeight - 10) targetTop = window.innerHeight - cardHeight - 10;
    requestAnimationFrame(() => { flyer.style.left = colRect.left + 'px'; flyer.style.top = targetTop + 'px'; });
    flyer.addEventListener('transitionend', () => {
        flyer.remove();
        const cardHtml = createCardElement(cardData);
        cardHtml.classList.remove('is-flipped');
        targetCol.appendChild(cardHtml);
        updateDeckUI(); refreshFlippedState(); checkAllColumns();
    }, { once: true });
}

function updateDeckUI() {
    const deckPile = document.getElementById('deck-pile');
    if (!deckPile) return;
    let countEl = deckPile.querySelector('.deck-count');
    if (!countEl) { countEl = document.createElement('span'); countEl.className = 'deck-count'; deckPile.appendChild(countEl); }
    countEl.textContent = waitingDeck.length;
    deckPile.style.opacity = waitingDeck.length === 0 ? '0.3' : '1';
}

// ============================================================
//  16. 判定 / 消除
// ============================================================

function checkAllColumns() {
    document.querySelectorAll('.sortable-list').forEach(col => {
        const cards = Array.from(col.querySelectorAll('.card:not([data-eliminating]):not(.sortable-drag):not(.is-bundled)'));

        let i = 0;
        while (i < cards.length) {
            const card = cards[i];
            if (card.classList.contains('is-flipped')) { i++; continue; }
            const groupId = card.dataset.groupId;
            const groupInfo = activeGroups.find(g => (g._runtimeId || g.hash) === groupId);
            if (!groupInfo || groupInfo.type !== 'context_sorting') { i++; continue; }
            if (eliminatingGroups.has(groupId)) { i++; continue; }

            const expectedTotal = groupInfo.content.length;
            let segment = [card], j = i + 1;
            while (j < cards.length) {
                const next = cards[j];
                if (next.classList.contains('is-flipped')) break;
                if (next.dataset.groupId === groupId) { segment.push(next); j++; } else break;
            }
            const badgeTarget = segment.find(c => c.dataset.order === '0') || segment[0];
            const badge = badgeTarget.querySelector('.card-badge');
            if (badge) badge.innerText = `${segment.length}/${expectedTotal}`;
            if (segment.length === expectedTotal) { eliminatingGroups.add(groupId); eliminateGroup(segment, groupId); }
            i = j;
        }

        cards.forEach((card, index) => {
            if (card.classList.contains('is-flipped')) return;
            const groupId = card.dataset.groupId;
            const groupInfo = activeGroups.find(g => (g._runtimeId || g.hash) === groupId);
            if (!groupInfo || groupInfo.type === 'context_sorting') return;
            if (eliminatingGroups.has(groupId) || card.dataset.order !== '0') return;

            const expectedTotal = groupInfo.content.length;
            let matchCount = 1, cardsToEliminate = [card];
            for (let j = 1; j < expectedTotal; j++) {
                const next = cards[index + j];
                if (next && !next.classList.contains('is-flipped') &&
                    next.dataset.groupId === groupId && parseInt(next.dataset.order) === j) {
                    matchCount++; cardsToEliminate.push(next);
                } else break;
            }
            const badge = card.querySelector('.card-badge');
            if (badge) badge.innerText = `${matchCount}/${expectedTotal}`;
            if (matchCount === expectedTotal) { eliminatingGroups.add(groupId); eliminateGroup(cardsToEliminate, groupId); }
        });
    });
}

function eliminateGroup(cardElements, groupId) {
    cardElements.forEach(el => {
        el.dataset.eliminating = 'true';
        el.style.pointerEvents = 'none';
        el.style.transform = 'scale(0)';
        el.style.opacity = '0';
    });

    playEliminateSound();

    updateMemoryStage(currentDeckId, groupId);
    if (!sessionCompletedHashes.includes(groupId)) sessionCompletedHashes.push(groupId);
    setTimeout(() => {
        cardElements.forEach(el => el.remove());
        eliminatingGroups.delete(groupId);
        refreshFlippedState();
        if (document.querySelectorAll('.card').length === 0) handleVictory();
    }, 500);
}

// 卡牌消除音效。用 Web Audio API 合成
function playEliminateSound() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();

        // 白噪音模拟纸张摩擦
        const bufferSize = ctx.sampleRate * 0.08; // 80ms
        const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = (Math.random() * 2 - 1);
        }

        const noise = ctx.createBufferSource();
        noise.buffer = buffer;

        // 带通滤波器，保留纸张频率范围，滤掉低频和高频
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 2200;
        filter.Q.value = 0.8;

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.6, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.04);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(ctx.destination);

        noise.start(ctx.currentTime);
        noise.stop(ctx.currentTime + 0.08);

    } catch (e) {}
}

// ============================================================
//  17. 胜利
// ============================================================

function handleVictory() { showWinMessage(); playWinAnimation(); }

function playWinAnimation() {
    for (let i = 0; i < 40; i++) {
        const card = document.createElement('div');
        card.className = 'win-card';
        card.style.left = Math.random() * 100 + 'vw';
        card.style.top = '-150px';
        card.style.setProperty('--drift', `${(Math.random() - 0.5) * 300}px`);
        card.style.setProperty('--rotate', `${(Math.random() - 0.5) * 1000}deg`);
        const delay = Math.random() * 2, duration = 2 + Math.random() * 2;
        card.style.animation = `winCardFall ${duration}s ease-in ${delay}s forwards`;
        document.body.appendChild(card);
        setTimeout(() => card.remove(), (delay + duration) * 1000);
    }
}

function  playWinSound() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();

        // 两个音符叠加，产生"叮"的感觉
        const notes = [523.25, 783.99]; // C5 + G5

        notes.forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();

            osc.connect(gain);
            gain.connect(ctx.destination);

            osc.type = 'square';
            osc.frequency.value = freq;

            const startTime = ctx.currentTime + i * 0.06; // 两个音符略微错开
            gain.gain.setValueAtTime(0.18, startTime);
            gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.4);

            osc.start(startTime);
            osc.stop(startTime + 0.4);
        });

    } catch (e) {
        // 浏览器不支持或用户未交互，静默失败
    }
}

function showWinMessage() {
    playWinAnimation(); 
    setTimeout(() => {
        document.getElementById('win-overlay').classList.add('show');
        playWinSound();
        renderProgressBar();
    }, 900);
}

function renderProgressBar() {
    const deck = loadDeckById(currentDeckId);
    if (!deck) return;

    const stats = getStats();
    const onedayms = 86400000;
    const cards = deck.cards || [];
    const total = cards.length;
    if (total === 0) return;

    let counts = { grad: 0, learning: 0, upcoming: 0, tomorrow: 0, due: 0, unseen: 0 };

    cards.forEach(card => {
        const s = stats[getStatKey(currentDeckId, card.hash)];
        if (!s) {
            counts.unseen++;
        } else if (s.stage >= 7) {
            counts.grad++;
        } else if (Date.now() >= s.nextReview) {
            counts.due++;
        } else {
            // 计算距离下次复习还有几天
            const diffDays = Math.ceil((s.nextReview - Date.now()) / onedayms);
            
            if (diffDays <= 1) {
                counts.tomorrow++;
            } else if (diffDays <= 3) {
                counts.upcoming++;
            } else {
                counts.learning++;
            }
        }
    });



    const colors = {
        grad: '#4372ff',      //  (完成)
        due: '#4db5ff',       //  (现在就该学)
        tomorrow: '#c2d52f',  // (明天)
        upcoming: '#FFD54F',  //  (后天)
        learning: '#fff282',  //  (稳固中,超过三天)
        unseen: '#9E9E9E'     // 灰色 (未开始)
    };

    const labels = {
        grad: '掌握', 
        due: '即将重逢', 
        tomorrow: '明天再见',
        upcoming: '3天内再见',
        learning: '3天后再见',
        unseen: '没见过'
    };

    const bar = document.getElementById('win-progress-bar');
    if (bar) {
        const order = ['grad', 'due','tomorrow',  'upcoming', 'learning', 'unseen'];
        bar.innerHTML = order.map(key => {
            const pct = (counts[key] / total * 100).toFixed(1);
            if (counts[key] === 0) return '';
            return `<div style="width:${pct}%;background:${colors[key]};height:100%;transition: width 0.3s;"></div>`;
        }).join('');
    }

    // 图例
    const legend = document.getElementById('win-progress-legend');
    if (legend) {
        legend.innerHTML = Object.entries(counts)
            .filter(([, v]) => v > 0)
            .sort((a, b) => {
                const order = ['due', 'tomorrow', 'upcoming', 'learning', 'grad', 'unseen'];
                return order.indexOf(a[0]) - order.indexOf(b[0]);
            })
            .map(([k, v]) =>
                `<span class="win-legend-item">
                    <span class="win-legend-dot" style="background:${colors[k]}"></span>
                    ${labels[k]} ${v}
                </span>`
            ).join('');
    }

    // 词库名
    const deckLabel = document.getElementById('win-deck-label');
    if (deckLabel) {
        deckLabel.textContent = `${deck.deck_metadata.title} · 共 ${total} 组`;
    }
}

document.getElementById('play-again').onclick = () => {
    document.getElementById('win-overlay').classList.remove('show');
    sessionCompletedHashes = [];
    initGame(currentDeckId);
};

// ============================================================
//  18. 帮助弹窗
// ============================================================

function openAbout() {
    document.getElementById('about-overlay').classList.add('show');
}

function closeAbout() {
    document.getElementById('about-overlay').classList.remove('show');
}

function switchTab(tabId, btn) {
    document.querySelectorAll('.about-tab-content').forEach(el => el.style.display = 'none');
    document.querySelectorAll('.about-tab').forEach(el => el.classList.remove('active'));
    document.getElementById('tab-' + tabId).style.display = '';
    btn.classList.add('active');
}

function openLightbox(imgEl) {
    document.getElementById('lightbox-img').src = imgEl.src;
    document.getElementById('lightbox').classList.add('show');
}

function closeLightbox() {
    document.getElementById('lightbox').classList.remove('show');
}

// Esc 关闭灯箱和关于弹窗
document.addEventListener('keydown', e => {
    const tag = document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'Escape') {
        closeLightbox();
        closeAbout();
    }
});


// ============================================================
//  19. title-bar 文案点击变化
// ============================================================

// 根据今天日期生成胡适之文案
function getHushiLine() {
    const today = new Date();
    const m = today.getMonth() + 1;
    const d = today.getDate();
    const d1 = d + 1, d2 = d + 2, d3 = d + 3;
    return `${m}月${d}日，打牌。${m}月${d1}日，打牌。${m}月${d2}日，胡适之啊胡适之！${m}月${d3}日，打牌。`;
}

const TITLE_LINES = [
    { title: '胡适开心词场', sub: () => getHushiLine() },
    { title: 'Hushi Anki',     sub: () => 'Solitaire? No, Study!' },
    { title: '胡适开心词场', sub: () => '打牌……读书人的事，能叫打牌么?' },
    { title: '胡适开心词场', sub: () => '书中自有棋牌室' },
    { title: 'Hushi Anki',     sub: () => 'My Anki is Spider Solitaire' },
    { title: '胡适开心词场', sub: () => '我不是Anki 我是空档接龙！' },
    { title: 'Hushi Anki',     sub: () => 'Solitaire for Anki brains' },
    { title: '胡适开心词场', sub: () => '万物皆可 空档接龙！' },
];

let titleIndex = 0;

function cycleTitle() {
    titleIndex = (titleIndex + 1) % TITLE_LINES.length;
    const line = TITLE_LINES[titleIndex];
    document.getElementById('game-title').textContent = line.title;
    document.getElementById('game-subtitle').textContent = line.sub();
}

// 启动时初始化第一条
function initTitle() {
    const line = TITLE_LINES[0];
    document.getElementById('game-title').textContent = line.title;
    document.getElementById('game-subtitle').textContent = line.sub();
}


// ============================================================
//  20. 启动
// ============================================================

window.onload = async () => {
    setCardBack(localStorage.getItem('card_back_theme') || 'classic');
    restoreFontSettings();
    // 启动时恢复
    const savedSuit = localStorage.getItem('suit_theme') || 'shapes';
    setSuitTheme(savedSuit);

    initTitle();  // 胡适之 title-bar

    await ensureBuiltinDecks();
    updateDeckSelectorUI();
    const reg = getRegistry();

    const lastId = localStorage.getItem('last_deck_id');
    // 优先使用用户最后选中的词库，但要确认它还在注册表里（防止词库被删后找不到）
    const startId = reg.find(r => r.deck_id === lastId)
        ? lastId
        : reg[0]?.deck_id;

    await initGame(startId);

    //await initGame(reg.length > 0 ? reg[0].deck_id : null);
};