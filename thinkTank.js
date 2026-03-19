// thinkTank.js (改造成 Clippy 风格)
// 翻译优先级：wordbase.json 本地 → localStorage 缓存 → MyMemory API

const ThinkTank = (() => {
  const AGENT_ID      = 'think-tank'; // 外部容器
  const TANK_ID       = 'tt-body';      // 核心交互气泡 
  const TEXT_ID       = 'translation-text';
  const CLOSE_BTN_ID  = 'clippy-close-btn'; //  关闭按钮
  
  const CACHE_PREFIX  = 'tt_trans_';   // localStorage key 前缀

  const BUBBLE_HIDE_CLASS = 'bubble-hidden';

  let agentEl  = null;
  let tankEl   = null;
  let textEl   = null;
  let wordMap  = {};   // groupId → { word, translation? }


  // ── 1. 初始化，传入 activeGroups ────────────────────────────
  function init(activeGroups) {
    agentEl  = document.getElementById(AGENT_ID);
    tankEl   = document.getElementById(TANK_ID);
    textEl   = document.getElementById(TEXT_ID);



    wordMap = {};
    activeGroups.forEach(group => {
      wordMap[group.id] = {
        word:        group.content[0] ?? '',
        // 兼容多种字段名
        translation: group.translation ?? group.zh ?? group.meaning ?? null
      };
    });

    _bindDropZone();
    _bindCloseBtn(); // 绑定新的关闭按钮
    _bindAvatarClick(); // 注册精灵点击事件
    
  }


  // ── 2. 核心：接收卡片，查翻译，显示 ────────────────────────
  async function receive(cardEl) {
    if (!textEl) return;

    const bubbleEl = document.getElementById(TANK_ID);
  // 拖入卡片时，强制显示气泡
  bubbleEl.classList.remove('bubble-hidden');

    // 接收卡片时，确保精灵是可见的
    agentEl.classList.remove('hidden');

    // --- 进入检索状态 ---
    agentEl.classList.add('is-searching');

    const groupId = cardEl?.dataset?.groupId;
    const entry   = wordMap[groupId];

    // 直接读这张卡片上显示的文本
    const word = cardEl.querySelector('.card-text')?.innerText?.trim()
              ?? entry?.word
              ?? '';
    if (!word) return;

    // 本地翻译只对根卡牌（order===0）有效，其余词走缓存/API
    const isRootCard     = parseInt(cardEl.dataset.order) === 0;
    const localTranslation = (isRootCard && entry?.translation) ? entry.translation : null;

    // 显示加载中
    // _setStatus('查询中...'); 
    textEl.innerHTML =
      `<span class="tt-word">${word}</span>` +
      `<span class="tt-arrow"> ▶ </span>` +
      `<span class="xp-display-hint" style="font-style:italic">翻译中...</span>`;

    _pop();

    try {
      const deckLang = document.querySelector('.board')?.dataset?.deckLang || 'en';
      const zh = await _resolveTranslation(word, localTranslation, deckLang);

      textEl.innerHTML =
        `<span class="tt-word">${word}</span>` +
        `<span class="tt-arrow"> ▶ </span>` +
        `<span class="tt-translation">${zh}</span>`;

      // 移除状态栏更新
      // _setStatus(`已翻译 · ${word}`);
    } catch (err) {
      textEl.innerHTML =
        `<span class="tt-word">${word}</span>` +
        `<span class="tt-arrow"> ▶ </span>` +
        `<span class="xp-display-hint">翻译失败，请检查网络</span>`;
      // _setStatus('翻译失败');
      console.warn('[ThinkTank] 翻译失败:', err);
    } finally {
        // --- 关键修改：无论成功失败，恢复空闲状态 ---
        // 为了让用户看清“检索中”的样子，加个微小的延迟
        setTimeout(() => {
        agentEl.classList.remove('is-searching');
        }, 300); 
    }
  }


  // ── 3. 翻译解析：本地 → 缓存 → API ─────────────────────────
  async function _resolveTranslation(word, localTranslation, sourceLang = 'en') {
    
    // 第一层：wordbase.json 本地翻译
    if (localTranslation) {
      return localTranslation;
    }

    // 第二层：localStorage 缓存
    const cacheKey = CACHE_PREFIX + sourceLang + '_' + word.toLowerCase().trim();
    const cached   = localStorage.getItem(cacheKey);
    if (cached) {
      return cached;
    }

    // 第三层：MyMemory API
    const result = await _fetchMyMemory(word, sourceLang);

    // 写入缓存
    try {
      localStorage.setItem(cacheKey, result);
    } catch (e) {
      // localStorage 满了也不影响使用
      console.warn('[ThinkTank] 缓存写入失败:', e);
    }

    return result;
  }


  // ── 4. MyMemory 请求 ─────────────────────────────────────────
  async function _fetchMyMemory(word, sourceLang = 'en', targetLang = 'zh') {
    const langPair = `${sourceLang}|${targetLang}`;
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(word)}&langpair=${langPair}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`MyMemory HTTP ${res.status}`);

    const data = await res.json();

    // responseStatus 200 = 正常；429 = 超配额
    if (data.responseStatus !== 200) {
      throw new Error(`MyMemory 返回错误: ${data.responseStatus} ${data.responseDetails}`);
    }

    const zh = data.responseData?.translatedText;
    if (!zh) throw new Error('MyMemory 返回空翻译');

    return zh;
  }


  // ── 5. 判断拖拽落点是否在俺寻思区域 ─────────────────────────
  function isOverTank(pointerX, pointerY) {
    
    if (!tankEl) return false;
    
    // 气泡关了，往精灵身上扔就不能触发
  // 即，如果气泡被隐藏了，则不接收任何卡片
    if (tankEl.classList.contains(BUBBLE_HIDE_CLASS)) {
      return false;
    }

  const rect = tankEl.getBoundingClientRect();
  
  // 增加了一点“磁吸”边缘 ，让拖拽更容易触发
  const buffer = 10; 
  return (
    pointerX >= rect.left - buffer &&
    pointerX <= rect.right + buffer &&
    pointerY >= rect.top - buffer &&
    pointerY <= rect.bottom + buffer
  );
}

  // ── 6. 拖拽高亮 ──────────────────────────────────────────────
  function _bindDropZone() {
    if (!agentEl || !tankEl) return;

    agentEl.addEventListener('dragover', (e) => {
      // 只有气泡显示时，才阻止默认行为并显示高亮
      if (!tankEl.classList.contains(BUBBLE_HIDE_CLASS)) {
        e.preventDefault();
        agentEl.classList.add('drag-over');
      }
    });

    agentEl.addEventListener('dragleave', () => {
      agentEl.classList.remove('drag-over');
    });

    agentEl.addEventListener('drop', (e) => {
      e.preventDefault();
      agentEl.classList.remove('drag-over');
    });
  }

  // ── 7. 关闭/隐藏按钮 (新的) ────────────────────────────────────
function _bindCloseBtn() {
    const closeBtn = document.getElementById(CLOSE_BTN_ID);
    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // 阻止冒泡，防止触发精灵的点击事件
        tankEl.classList.add(BUBBLE_HIDE_CLASS);
      });
    }
  }
// ── 新增：点击精灵显示气泡 ────────────────────────────────
function _bindAvatarClick() {
    const avatarEl = agentEl.querySelector('.clippy-avatar');
    if (avatarEl) {
      avatarEl.addEventListener('click', () => {
        tankEl.classList.toggle(BUBBLE_HIDE_CLASS);
      });
    }
  }

  // ── 8. 内部工具 ─────────────────────────────────────────────────
  function _pop() {
    if (!agentEl) return;
    // popping 动画现在用在整个 agent 上
    agentEl.classList.remove('popping');
    void agentEl.offsetWidth; // reflow 重置动画
    agentEl.classList.add('popping');
    agentEl.addEventListener('animationend', () => agentEl.classList.remove('popping'), { once: true });
  }


  // ── 公开接口 ─────────────────────────────────────────────────
  return { init, receive, isOverTank, getAgentElement: () => agentEl };
})();


