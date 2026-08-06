// js/editor.js — 剧情编辑器主逻辑（极简纯文本编辑器）
// 整个剧情就是一段纯文本。一行普通文字 = 一句剧情；
// 以 <召唤背景:名称> / <召唤物品:名称> / <召唤音乐:名称> / <召唤音效:名称> / <停顿> 开头的整行 = 指令（召唤类用尖括号且必须带"召唤"二字）。
// 编辑器负责把这段文本解析成运行时消费的剧情数组，并反向把旧数组还原成文本。
(function () {
  const $ = (s) => document.querySelector(s);
  const storyText = $('#story-text');
  // 最近一次文本框选区快照（手机点按钮失焦后选区会丢，点工具栏/素材时用它恢复）；
  // 定义在模块顶层，使 getRange / insertAtCursor（模块顶层）与 init 内部都能访问（原先定义在 init 内部，
  // 导致模块顶层的 insertAtCursor 调 getRange 时抛 ReferenceError: getRange is not defined，所有「插入到光标」类功能失效）。
  let lastTextSel = { start: 0, end: 0 };
  const storyPreview = $('#story-preview');
  const editorBody = $('#editor-body') || storyText.parentElement;
  const lnGutter = $('#ln-gutter');
  const editorTextWrap = $('#editor-text-wrap');
  let lnTimer = null, lastLnCount = -1;
  const libPanel = $('#lib-panel');
  // 横竖屏判定（与 CSS body.portrait / @media 对齐）：竖屏=点按添加，横屏=拖动添加。
  // 定义在模块顶层，bindGlobal 与 makeCard 等都可访问（原先定义在 bindGlobal 内部，
  // 导致模块顶层的 makeCard 调用时抛 ReferenceError: isLandscapeNow is not defined）。
  function isPortraitNow() { return window.innerHeight > window.innerWidth; }
  function isLandscapeNow() { return !isPortraitNow(); }
  let previewMode = false;
  let splitMode = false;
  let pendingEffectTag = null; // 特效按钮用的临时标签名

  // 全局属性
  // playMode: 'longform' 长文模式（默认，文字累积成长卷）| 'galgame' galgame模式（底部黑色文本框，逐段显示）
  let globalSettings = { gameName: '', subtitle: '', authorId: '', icon: '', font: null, openingBg: '', openingMusic: '', textContrast: 'auto', playMode: 'longform', watermark: { text: '', pos: '右下', url: '', opacity: 40 } };
  // 把 meta 里的创作设定统一同步进 globalSettings（开场背景/音乐/图标等所有字段，避免 openProject 漏字段导致刷新后丢失）
  function syncGlobalFromMeta(meta) {
    meta = meta || {};
    if (meta.gameName) globalSettings.gameName = meta.gameName;
    if (meta.subtitle) globalSettings.subtitle = meta.subtitle;
    if (meta.authorId) globalSettings.authorId = meta.authorId;
    if (meta.icon) globalSettings.icon = meta.icon;
    if (meta.font) globalSettings.font = meta.font;
    if (meta.watermark) globalSettings.watermark = meta.watermark;
    if (meta.openingBg) globalSettings.openingBg = meta.openingBg;
    if (meta.openingMusic) globalSettings.openingMusic = meta.openingMusic;
    if (meta.textContrast) globalSettings.textContrast = (meta.textContrast === 'scrim') ? 'auto' : meta.textContrast;
    if (meta.playMode) globalSettings.playMode = (meta.playMode === 'galgame') ? 'galgame' : 'longform';
  }
  (async function loadGlobal() {
    const meta = (window.Storage.loadMeta && window.Storage.loadMeta()) || {};
    syncGlobalFromMeta(meta);
  })();
  async function saveGlobal() {
    const meta = (window.Storage.loadMeta && window.Storage.loadMeta()) || {};
    meta.gameName = globalSettings.gameName;
    meta.subtitle = globalSettings.subtitle;
    meta.authorId = globalSettings.authorId;
    meta.icon = globalSettings.icon;
    meta.font = globalSettings.font;
    meta.openingBg = globalSettings.openingBg;
    meta.openingMusic = globalSettings.openingMusic;
    meta.textContrast = globalSettings.textContrast;
    meta.playMode = globalSettings.playMode;
    meta.watermark = globalSettings.watermark;
    if (window.Storage.saveMeta) await window.Storage.saveMeta(meta);
    saveNow();
  }

  let text = '';
  let activeLib = 'background';
  const MAIN_BLOCK = (window.Storage && window.Storage.MAIN_BLOCK) ? window.Storage.MAIN_BLOCK : '__MAIN__';
  let activeBlock = MAIN_BLOCK;   // 当前正在编辑的剧情块（主剧情默认，置顶不可删）
  let currentProjectMode = 'game'; // 'game' 剧情游戏 | 'article' 通用文章
  let pendingAudioLib = null;
  let saveTimer = null;
  let history = [];      // 撤销栈：{ text, selStart, selEnd }
  let histIndex = -1;    // 当前位置
  let histTimer = null;  // 打字合并计时器
  let pvTimer = null;
  let outlineTimer = null;   // 导航栏刷新计时器    // 分屏/预览实时刷新计时器

  const KIND_TO_CN = { background: '背景', item: '物品', overlay: '叠层', music: '音乐', sound: '音效' };
  const CN_TO_KIND = { '背景': 'background', '物品': 'item', '叠层': 'overlay', '音乐': 'music', '音效': 'sound' };

  const RE_PAUSE = /^<停顿(?::\s*(\d+))?>$/;
  const RE_SUMMON = /^<召唤(背景|物品|音乐|音效|叠层):\s*(.*?)\s*>$/;
  const RE_TITLE = /^<标题:\s*(.*?)\s*>$/;
  const RE_DIVIDER = /^<分割线(?::\s*(.*?)\s*)?>$/;
  // 分支剧情：<剧情块:名>（兼容旧 <对话块:名>）跳转、<选项:"文字",块名> 选项、<跳回> 返回、<跳回重选> 回到上一步重选
  const RE_BLOCK = /^<(?:对话块|剧情块):\s*(.*?)\s*>$/;
  const RE_RETURN = /^<跳回>$/;
  const RE_RETURN_RECHOOSE = /^<跳回重选>$/;
  const RE_OPTION = /<选项:\s*"([^"]*)"\s*(?:,\s*([^>]*?))?\s*>/g;
  // 变量操作：<变量:名=值> / <变量:名+数> / <变量:名-数>（独占一行；一行可含多个，按 <变量:...> 逐个提取）
  const RE_VAR_OP = /<变量:\s*([A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*)\s*([=+\-])\s*([^<>]*?)\s*>/g;

  const DEFAULT_TEXT =
    '// 欢迎来到剧情编辑器！这段示例文字会带你快速了解核心功能。\n' +
    '// 以 // 开头的是注释，游玩时不显示；/// 会出现在左侧大纲作为大章节导航。\n' +
    '\n' +
    '/// 第一章：冒险开始\n' +
    '\n' +
    '<召唤音乐:主题曲>\n' +
    '<召唤背景:冒险开始>\n\n' +
    '<标题:异世界之门>\n\n' +
    '你站在一座古老的石拱门前。\n' +
    '阳光穿透云层，远处浮空岛缓缓旋转。\n' +
    '<停顿>\n\n' +
    '这就是你踏上旅程的地方。\n' +
    '深吸一口气，迈出了第一步。\n' +
    '\n' +
    '/// 第二章：第一场战斗\n' +
    '\n' +
    '<召唤背景:史莱姆平原>\n\n' +
    '<标题:史莱姆来袭>\n\n' +
    '一只圆滚滚的史莱姆挡住了去路。\n' +
    '它半透明的身体在阳光下闪着诡异的光。\n' +
    '<停顿>\n\n' +
    '你握紧手中的剑，准备迎战。\n\n' +
    '<变量:勇气=1>\n\n' +
    '你的勇气值现在是 {勇气}。\n' +
    '\n' +
    '// 小提示：点右上角「试玩」即可预览效果；右侧素材库可上传你自己的图片 / 音乐 / 3D 模型。';

  // ============ 文本 ↔ 剧情数组 ============
  function parseStory(src) {
    const lines = (src || '').split(/\r?\n/);
    const story = [];
    let buf = [];
    const flush = () => {
      if (!buf.length) return;
      const merged = buf.join('\n').replace(/^\s+|\s+$/g, '');
      if (merged) story.push({ type: 'text', content: merged });
      buf = [];
    };
    for (const line of lines) {
      // // 开头的行是注释，不出现在实际游玩中
      if (/^\s*\/\//.test(line)) continue;
      const t = line.trim();
      let m;
      if ((m = t.match(RE_PAUSE))) {
        flush();
        story.push({ type: 'pause', ms: m[1] != null ? parseInt(m[1], 10) : 0 });
      } else if ((m = t.match(RE_SUMMON))) {
        flush();
        let sname = m[2];
        let shint = '';
        // 召唤物品支持 name,"提示文字" 格式（物品出现时在画面中下方显示）
        if (CN_TO_KIND[m[1]] === 'item') {
          const hm = sname.match(/^(.*?),\s*"(.*)"\s*$/);
          if (hm) { sname = hm[1].trim(); shint = hm[2]; }
        }
        const snode = { type: 'summon', kind: CN_TO_KIND[m[1]], name: sname };
        if (shint) snode.hint = shint;
        story.push(snode);
      } else if ((m = t.match(RE_TITLE))) {
        flush();
        story.push({ type: 'title', text: m[1] || '标题' });
      } else if ((m = t.match(RE_DIVIDER))) {
        flush();
        story.push({ type: 'divider', text: (m[1] || '').trim() });
      } else if (t === '<停止音乐>') {
        flush();
        story.push({ type: 'stopmusic' });
      } else if ((m = t.match(RE_BLOCK))) {
        flush();
        story.push({ type: 'block', name: m[1].trim() });
      } else if (RE_RETURN.test(t)) {
        flush();
        story.push({ type: 'return' });
      } else if (RE_RETURN_RECHOOSE.test(t)) {
        flush();
        story.push({ type: 'returnrechoose' });
      } else if (t.indexOf('<变量:') === 0) {
        // 提取整行内所有 <变量:...> 操作，合并为一个 varop 节点（与导出端 parseStoryForExport 一致）
        const ops = [];
        let vm; RE_VAR_OP.lastIndex = 0;
        while ((vm = RE_VAR_OP.exec(t)) !== null) {
          ops.push({ name: vm[1], op: vm[2], val: vm[3].trim() });
        }
        if (ops.length) { flush(); story.push({ type: 'varop', ops: ops }); }
        else buf.push(line); // 形如 <变量:...> 但格式无法识别 → 当普通文本
      } else if (t.indexOf('<选项:') >= 0) {
        flush();
        const options = [];
        let om; RE_OPTION.lastIndex = 0;
        while ((om = RE_OPTION.exec(t)) !== null) {
          const txt = om[1];
          const blk = (om[2] && om[2].trim()) || null;
          options.push({ text: txt, block: blk });
        }
        if (options.length) story.push({ type: 'options', options });
      } else {
        buf.push(line);
      }
    }
    flush();
    return story;
  }

  function storyToText(story) {
    if (!Array.isArray(story) || !story.length) return '';
    const out = [];
    for (const n of story) {
      if (n.type === 'text') out.push(n.content || '');
      else if (n.type === 'pause') out.push(n.ms ? ('<停顿:' + n.ms + '>') : '<停顿>');
      else if (n.type === 'summon' && KIND_TO_CN[n.kind]) {
        let s = '<召唤' + KIND_TO_CN[n.kind] + ':' + (n.name || '');
        if (n.hint) s += ',"' + n.hint + '"';
        s += '>';
        out.push(s);
      }
      else if (n.type === 'title') out.push('<标题:' + (n.text || '') + '>');
      else if (n.type === 'divider') out.push('<分割线:' + (n.text || '') + '>');
      else if (n.type === 'stopmusic') out.push('<停止音乐>');
      else if (n.type === 'block') out.push('<剧情块:' + (n.name || '') + '>');
      else if (n.type === 'return') out.push('<跳回>');
      else if (n.type === 'returnrechoose') out.push('<跳回重选>');
      else if (n.type === 'varop') out.push(n.ops.map(o => '<变量:' + o.name + (o.op === '=' ? '=' : o.op) + o.val + '>').join(''));
      else if (n.type === 'options') out.push(n.options.map(o => '<选项:"' + (o.text || '') + '"' + (o.block ? ',' + o.block : '') + '>').join(' '));
    }
    return out.join('\n');
  }

  // ============ BBCode 预览 ============
  // 布局：编辑态 / 全屏预览态 / 分屏态（左写右渲）
  // previewMode 由「预览」按钮或按住右 Ctrl 控制；splitMode 由「分屏」按钮控制
  function applyLayout() {
    const showText = !previewMode || splitMode;
    const showPreview = previewMode || splitMode;
    storyText.classList.toggle('hidden', !showText);
    storyPreview.classList.toggle('hidden', !showPreview);
    editorBody.classList.toggle('split', splitMode);
    editorTextWrap.classList.toggle('hidden', !showText);
    if (showText) buildLineNumbers();
    if (showPreview) renderPreview();
    // 仅「全屏预览且无分屏」时锁定编辑按钮
    const lockEdit = previewMode && !splitMode;
    $('#btn-undo').disabled = lockEdit;
    $('#btn-redo').disabled = lockEdit;
    const pvBtn = $('#btn-bbcode-preview');
    if (previewMode && !splitMode) { pvBtn.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#ic-pencil"/></svg> 编辑'; pvBtn.title = '切换回纯文本编辑模式'; }
    else { pvBtn.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#ic-eye"/></svg> 预览'; pvBtn.title = '切换 BBCode 预览模式'; }
    if (showText && !splitMode) storyText.focus();
  }
  function setPreviewMode(on) {
    on = !!on;
    if (on === previewMode) { if (on || splitMode) renderPreview(); return; }
    previewMode = on;
    applyLayout();
  }
  function togglePreview() { setPreviewMode(!previewMode); }
  function renderPreview() {
    if (!previewMode && !splitMode) return;
    // 每次都从 textarea 读取最新内容
    const currentText = storyText.value;
    const lines = currentText.split(/\r?\n/);
    let html = '';
    for (const raw of lines) {
      const t = raw.trim();
      // 注释行
      if (/^\s*\/\//.test(raw)) {
        html += '<div class="pv-line pv-comment">' + escapeHtml(raw) + '</div>';
        continue;
      }
      // 空行
      if (!t) { html += '<div class="pv-line">&nbsp;</div>'; continue; }
      // 指令行（<> 是命令，[] 是 BBCode）
      if (t.startsWith('<') && t.endsWith('>')) {
        let m;
        if (t.startsWith('<停顿')) {
          const ms = (t.match(RE_PAUSE) || [])[1];
          html += '<div class="pv-line pv-pause"><div class="pv-pause-line"></div><span class="pv-pause-label"><svg class="ico" aria-hidden="true"><use href="#ic-pause"/></svg> 停顿' + (ms ? ' ' + ms + 'ms' : '') + '</span></div>';
        } else if ((m = t.match(RE_SUMMON))) {
          const cn = m[1], name = m[2];
          const clsMap = { '背景': 'bg', '物品': 'item', '叠层': 'overlay', '音乐': 'music', '音效': 'sound' };
          html += '<div class="pv-line"><span class="pv-cmd ' + (clsMap[cn] || '') + '"><svg class="ico" aria-hidden="true"><use href="#ic-bookmark"/></svg> ' + cn + '：' + escapeHtml(name) + '</span></div>';
        } else if ((m = t.match(RE_TITLE))) {
          html += '<div class="pv-line" style="text-align:center;font-size:28px;font-weight:700;margin:10px 0;color:#ffd700">' + renderBBCode(m[1]) + '</div>';
        } else if ((m = t.match(RE_DIVIDER))) {
          const dtxt = (m[1] || '').trim();
          html += '<div class="pv-line pv-divider">' + (dtxt
            ? '<span class="pv-divider-text">' + renderBBCode(dtxt) + '</span>'
            : '<span class="pv-divider-line"></span>') + '</div>';
        } else if (t === '<停止音乐>') {
          html += '<div class="pv-line"><span class="pv-cmd music"><svg class="ico" aria-hidden="true"><use href="#ic-stop"/></svg> 停止音乐</span></div>';
        } else if (RE_RETURN.test(t)) {
          html += '<div class="pv-line"><span class="pv-cmd return"><svg class="ico" aria-hidden="true"><use href="#ic-corner-up-left"/></svg> 跳回（返回上一层对话）</span></div>';
        } else if (RE_RETURN_RECHOOSE.test(t)) {
          html += '<div class="pv-line"><span class="pv-cmd return"><svg class="ico" aria-hidden="true"><use href="#ic-corner-up-left"/></svg> 跳回重选（返回上一步，重新做出选择）</span></div>';
        }         else if ((m = t.match(RE_BLOCK))) {
          html += '<div class="pv-line"><span class="pv-cmd block"><svg class="ico" aria-hidden="true"><use href="#ic-box"/></svg> 进入剧情块：' + escapeHtml(m[1]) + '</span></div>';
        } else if (t.indexOf('<变量:') === 0) {
          const ops = [];
          let vm; RE_VAR_OP.lastIndex = 0;
          while ((vm = RE_VAR_OP.exec(t)) !== null) {
            const sym = vm[2] === '=' ? '=' : vm[2];
            ops.push(escapeHtml(vm[1] + ' ' + sym + ' ' + vm[3].trim()));
          }
          html += '<div class="pv-line"><span class="pv-cmd var"><svg class="ico" aria-hidden="true"><use href="#ic-key"/></svg> 变量：' + (ops.join('，') || '（格式有误）') + '</span></div>';
        } else if (t.indexOf('<选项:') >= 0) {
          const opts = [];
          let om; RE_OPTION.lastIndex = 0;
          while ((om = RE_OPTION.exec(t)) !== null) opts.push(om[1] + (om[2] && om[2].trim() ? ' → ' + om[2].trim() : ''));
          html += '<div class="pv-line"><span class="pv-cmd option"><svg class="ico" aria-hidden="true"><use href="#ic-circle-dot"/></svg> 选项：' + opts.map(o => escapeHtml(o)).join(' ｜ ') + '</span></div>';
        } else {
          // 其它方括号内容（BBCode 或未知指令）
          html += '<div class="pv-line">' + renderBBCode(raw) + '</div>';
        }
        continue;
      }
      // 普通文本：渲染 BBCode
      if (t) {
        html += '<div class="pv-line">' + renderBBCode(raw) + '</div>';
      }
    }
    if (!html) html = '<div class="empty-tip">（空白剧情）</div>';
    storyPreview.innerHTML = html;
    // 顺序标注行号（与 textarea 行号 1:1 对应），供「光标行对齐」使用
    const pvLines = storyPreview.querySelectorAll('.pv-line');
    pvLines.forEach((el, i) => el.setAttribute('data-ln', String(i + 1)));
    // 分屏态 / 全屏预览态（含按住右 Ctrl 预览）：渲染后把预览滚动定位到当前编辑光标所在行
    if (splitMode || previewMode) withScrollLock(revealPreviewCursorLine);
    // 点击预览区：仅「全屏预览（非分屏）」时用——跳回编辑并定位到点击的脚本行；
    // 分屏模式不移动左侧编辑器（右预览左编辑同屏，点击预览不应让左侧跳到不可预料位置）
    storyPreview.onclick = function(e) {
      // 取点击的预览行号；pv-line 的 data-ln 已 1:1 对应编辑器行号
      const pvLineEl = e.target.closest ? e.target.closest('.pv-line') : null;
      let lineNo = null;
      if (pvLineEl && pvLineEl.dataset && pvLineEl.dataset.ln) lineNo = parseInt(pvLineEl.dataset.ln, 10);
      if (!lineNo) {
        // 退化：点到了非 pv-line 的留白处，用行高估算一个行号
        const rect = storyPreview.getBoundingClientRect();
        const y = e.clientY - rect.top + storyPreview.scrollTop;
        const lineH = parseFloat(getComputedStyle(storyPreview).lineHeight) || 30;
        lineNo = Math.floor(y / lineH) + 1;
      }
      if (!lineNo) return;
      if (splitMode) {
        // 分屏态：把左侧编辑器光标同步到该行并滚动可见（不切换预览/编辑模式）
        withScrollLock(() => { gotoLine(lineNo); revealPreviewCursorLine(); });
      } else {
        togglePreview();
        gotoLine(lineNo);
      }
    };
    // 预览模式下按任意键（非修饰键）回到编辑模式；分屏模式不做（右预览左编辑同屏）
    storyPreview.onkeydown = function(e) {
      if (splitMode) return;
      if (e.key === 'Escape' || (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1)) {
        e.preventDefault();
        togglePreview();
        setTimeout(() => { storyText.focus(); storyText.selectionStart = storyText.selectionEnd = storyText.value.length; }, 50);
      }
    };
    storyPreview.setAttribute('tabindex', '0');
  }
  // ---- 分屏滚动同步：让预览位置跟随编辑器 ----
  // 三种同步：编辑器拖滚动条→预览按比例跟随；预览拖滚动条→编辑器按比例跟随；
  //           编辑时光标所在行→预览自动滚动到可见。用锁防止双向触发死循环。
  let _scrollLock = false;
  function withScrollLock(fn) {
    _scrollLock = true;
    try { fn(); } finally { requestAnimationFrame(() => { _scrollLock = false; }); }
  }
  function caretLine() {
    const v = storyText.value;
    const pos = storyText.selectionStart;
    return v.slice(0, pos).split('\n').length; // 1-based 行号
  }
  // 编辑光标所在行 → 在预览区滚动到居中可见，并打上浅浅的行标记（分屏态与全屏预览态都生效）
  function revealPreviewCursorLine() {
    if (!splitMode && !previewMode) return;
    const ln = caretLine();
    // 先清除所有行标记，再给当前行加（pv-line 在重渲染后会被重建，因此每次重设即可）
    const all = storyPreview.querySelectorAll('.pv-line');
    for (let i = 0; i < all.length; i++) all[i].classList.remove('pv-cursor-line');
    const el = storyPreview.querySelector('[data-ln="' + ln + '"]');
    if (el) el.classList.add('pv-cursor-line');
    if (!el) return;
    const cont = storyPreview;
    const cr = cont.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const desired = cont.scrollTop + (er.top - cr.top) - (cr.height - er.height) / 2;
    cont.scrollTop = Math.max(0, Math.min(desired, cont.scrollHeight - cont.clientHeight));
  }
  // 编辑器滚动 → 预览按比例跟随
  function syncScrollToPreview() {
    if (_scrollLock || !splitMode) return;
    const st = storyText, pv = storyPreview;
    const stMax = st.scrollHeight - st.clientHeight;
    const pvMax = pv.scrollHeight - pv.clientHeight;
    if (stMax <= 0 || pvMax <= 0) { withScrollLock(() => { pv.scrollTop = 0; }); return; }
    withScrollLock(() => { pv.scrollTop = (st.scrollTop / stMax) * pvMax; });
  }
  // 预览滚动 → 编辑器按比例跟随
  function syncScrollToEditor() {
    if (_scrollLock || !splitMode) return;
    const st = storyText, pv = storyPreview;
    const stMax = st.scrollHeight - st.clientHeight;
    const pvMax = pv.scrollHeight - pv.clientHeight;
    if (stMax <= 0 || pvMax <= 0) { withScrollLock(() => { st.scrollTop = 0; }); return; }
    withScrollLock(() => { st.scrollTop = (pv.scrollTop / pvMax) * stMax; });
  }
  // 在 HTML 中渲染 BBCode（b/i/u/s/color/size/center/br）
  function renderBBCode(s) {
    let t = escapeHtml(s);
    t = t.replace(/\[color=([^\]]+)\]/g, '<span style="color:$1">');
    t = t.replace(/\[\/color\]/g, '</span>');
    t = t.replace(/\[size=(\d+)\]/g, '<span style="font-size:$1px">');
    t = t.replace(/\[\/size\]/g, '</span>');
    t = t.replace(/\[b\]/g, '<b>'); t = t.replace(/\[\/b\]/g, '</b>');
    t = t.replace(/\[i\]/g, '<i>'); t = t.replace(/\[\/i\]/g, '</i>');
    t = t.replace(/\[u\]/g, '<u>'); t = t.replace(/\[\/u\]/g, '</u>');
    t = t.replace(/\[s\]/g, '<s>'); t = t.replace(/\[\/s\]/g, '</s>');
    t = t.replace(/\[left\]/g, '<div style="text-align:left">'); t = t.replace(/\[\/left\]/g, '</div>');
    t = t.replace(/\[center\]/g, '<div style="text-align:center">'); t = t.replace(/\[\/center\]/g, '</div>');
    t = t.replace(/\[right\]/g, '<div style="text-align:right">'); t = t.replace(/\[\/right\]/g, '</div>');
    t = t.replace(/\[br\]/g, '<br>');
    // 特效
    t = t.replace(/\[shadow=([^\]]+)\]/g, '<span style="text-shadow:2px 2px 4px $1">');
    t = t.replace(/\[\/shadow\]/g, '</span>');
    t = t.replace(/\[glow=([^\]]+)\]/g, '<span style="text-shadow:0 0 8px $1,0 0 16px $1,0 0 24px $1">');
    t = t.replace(/\[\/glow\]/g, '</span>');
    t = t.replace(/\[highlight=([^\]]+)\]/g, '<mark style="background:$1;color:#000;padding:0 4px;border-radius:3px">');
    t = t.replace(/\[\/highlight\]/g, '</mark>');
    // 瞬显（编辑器预览：直接整段显示，不打字）
    t = t.replace(/\[瞬显\]/g, '<span class="instant">');
    t = t.replace(/\[\/瞬显\]/g, '</span>');
    return t;
  }

  // ============ 初始化 ============
  function init() {
    bindGlobal();
    bindTodoEvents(); // 素材待办浮动按钮事件
    bindImageProcessor(); // 背景图处理面板（滑块/下拉/按钮事件，只绑一次）
    bindAudioProcessor(); // 音频处理面板（裁切/压缩，只绑一次）
    bindBgLightbox();     // 背景大图预览关闭事件（遮罩/叉叉/Esc）
    applyTheme();         // 启动时恢复暗色模式
    bindThemeToggle();    // 暗色模式切换按钮（#btn-theme）
    bindContextMenu();    // 自定义右键菜单（接管原生右键，编辑器工作区）
    applyHideAllAI(); // 启动时应用「隐藏所有 AI 功能」开关
    // 先迁移旧数据并展示项目页，进入某项目后才加载其剧情
    window.Storage.migrateLegacyIfNeeded().then(() => {
      renderProjectsScreen();
      showProjectsScreen(true);
    });
  }

  // ============ 暗色模式（#btn-theme） ============
  const THEME_KEY = 'storyeditor:theme';
  function applyTheme() {
    let t = null;
    try { t = localStorage.getItem(THEME_KEY); } catch (e) {}
    const dark = t === 'dark';
    document.body.classList.toggle('dark', dark);
    const btn = document.getElementById('btn-theme');
    if (btn) {
      const use = btn.querySelector('use');
      if (use) use.setAttribute('href', dark ? '#ic-sun' : '#ic-moon');
      btn.title = dark ? '亮色模式' : '暗色模式';
    }
  }
  function toggleTheme() {
    const dark = !document.body.classList.contains('dark');
    document.body.classList.toggle('dark', dark);
    try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch (e) {}
    const btn = document.getElementById('btn-theme');
    if (btn) {
      const use = btn.querySelector('use');
      if (use) use.setAttribute('href', dark ? '#ic-sun' : '#ic-moon');
      btn.title = dark ? '亮色模式' : '暗色模式';
    }
  }
  function bindThemeToggle() {
    const btn = document.getElementById('btn-theme');
    if (btn) btn.addEventListener('click', toggleTheme);
  }

  // ============ 自定义右键菜单（接管原生右键） ============
  const CTX_EXCLUDE = 'input, [contenteditable="true"], .modal, .tb-menu, .bg-lightbox';
  // 子菜单（插入素材的多级展开）状态
  let ctxSubPanels = [];
  let ctxSubToken = 0;
  function ctxCloseSubs() { ctxSubPanels.forEach(function (p) { p.remove(); }); ctxSubPanels = []; }
  // 根据素材卡片 dataset 生成召唤指令文本
  function summonTextForCard(ds) {
    if (ds.kind === 'item') return '<召唤物品:' + ds.name + ',"">';
    const cn = (typeof KIND_TO_CN !== 'undefined' && KIND_TO_CN[ds.kind]) || ds.kind;
    return '<召唤' + cn + ':' + ds.name + '>';
  }
  // ============ 右键菜单：剪贴板 & 选区辅助 ============
  function ctxCopyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).catch(function () {}); return true; }
    } catch (e) {}
    try {
      const t = document.createElement('textarea');
      t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove();
      return true;
    } catch (e2) { return false; }
  }
  function ctxSelectAll() {
    storyText.focus();
    storyText.setSelectionRange(0, storyText.value.length);
  }
  function ctxDeleteSelection() {
    const ta = storyText, s = ta.selectionStart, e = ta.selectionEnd;
    if (s === e) { toast('未选中文字'); return; }
    ta.value = ta.value.slice(0, s) + ta.value.slice(e);
    ta.setSelectionRange(s, s); ta.focus(); commitEdit();
    toast('已删除选中文字');
  }
  function insertPauseAfterSelection() {
    const ta = storyText, st = ta.scrollTop, e = ta.selectionEnd, v = ta.value;
    let lineEnd = v.indexOf('\n', e);
    if (lineEnd === -1) lineEnd = v.length;
    const insert = '\n<停顿>\n';
    ta.value = v.slice(0, lineEnd) + insert + v.slice(lineEnd);
    const pos = lineEnd + insert.length;
    ta.setSelectionRange(pos, pos); ta.focus(); ta.scrollTop = st; commitEdit();
  }
  function switchLib(lib) {
    activeLib = lib;
    const tabs = document.querySelectorAll('#lib-tabs [data-lib]');
    tabs.forEach(function (x) { x.classList.toggle('active', x.dataset.lib === lib); });
    renderLibrary();
  }
  function ctxPaste() {
    const ta = storyText;
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(function (text) {
        if (text) { insertAtCursor(text); toast('已粘贴'); }
        else toast('剪贴板为空');
      }).catch(function (err) { toast('粘贴失败（浏览器限制了剪贴板读取）：' + (err && err.message ? err.message : err)); });
    } else {
      ta.focus();
      try { document.execCommand('paste'); toast('已粘贴'); }
      catch (e) { toast('当前浏览器不支持右键粘贴，请用 Ctrl/⌘+V'); }
    }
  }

  // 按右键目标构造菜单项；每个项 {label,icon,danger?,action?}，分隔线 {separator:true}
  function buildContextItems(target) {
    const card = target.closest ? target.closest('.asset-card') : null;
    if (card) return cardItems(card);
    const inText = (target === storyText) || (target.closest && target.closest('#story-text'));
    if (inText) {
      const hasSel = storyText.selectionStart !== storyText.selectionEnd;
      return hasSel ? textSelectedItems() : textEmptyItems();
    }
    if (target.closest && target.closest('#lib-panel')) return libraryItems();
    return generalItems();
  }
  function cardItems(card) {
    const ds = card.dataset;
    // 剧情块卡片：data-kind='block'，块名在 data-block-name；走专属菜单（不再套用素材卡的 undefined 分支）
    if (ds.kind === 'block') {
      const bname = ds.blockName;
      const isMain = bname === MAIN_BLOCK;
      const jumpCmd = '<剧情块:' + bname + '>';
      const items = [
        { label: '插入「跳转 ' + (isMain ? '主剧情' : bname) + '」到光标', icon: 'ic-corner-up-left', action: function () { insertBlockJump(bname); } },
        { label: '复制跳转指令', icon: 'ic-copy', action: function () { ctxCopyText(jumpCmd); toast('已复制：' + jumpCmd); } },
      ];
      if (!isMain) {
        items.push({ separator: true });
        items.push({ label: '重命名剧情块', icon: 'ic-pencil', action: function () { handleRenameBlock(bname); } });
        items.push({ label: '删除剧情块', icon: 'ic-trash', danger: true, action: function () { handleDeleteBlock(bname); } });
      }
      return items;
    }
    const summonText = function () {
      const wasRO = storyText.readOnly; storyText.readOnly = false;
      try { const s = summonTextForCard(ds); insertAtCursor(s); toast('已插入：' + s); }
      finally { storyText.readOnly = wasRO; }
    };
    if (card.classList.contains('stop-music-card')) {
      return [
        { label: '插入「停止音乐」到光标', icon: 'ic-stop', action: summonText },
        { label: '复制指令', icon: 'ic-copy', action: function () { ctxCopyText('<停止音乐>'); toast('已复制：<停止音乐>'); } },
      ];
    }
    const cn = (typeof KIND_TO_CN !== 'undefined' && KIND_TO_CN[ds.kind]) || ds.kind;
    const items = [
      { label: '插入「' + cn + '：' + ds.name + '」到光标', icon: 'ic-plus', action: summonText },
      { label: '复制召唤指令', icon: 'ic-copy', action: function () { const s = summonTextForCard(ds); ctxCopyText(s); toast('已复制指令：' + s); } },
      { separator: true },
    ];
    if (ds.kind && ds.id != null) {
      items.push({ label: '重命名素材', icon: 'ic-pencil', action: function () { handleRenameAsset(ds.kind, ds.id, ds.name); } });
      // 物品库：设置结束物体 → 剧情块的绑定（右键进入设置面板）
      if (ds.kind === 'item') {
        items.push({ label: '设置结束物体绑定', icon: 'ic-link', action: function () { openItemExitSettings(ds.kind, ds.id); } });
      }
      // 纯色背景：再编辑改为「重选颜色」（纯色无图可压缩，复用纯色生成器并预填当前色）
      if (ds.kind === 'background' && ds.solid === '1') {
        items.push({ label: '重选颜色', icon: 'ic-color', action: function () { openSolidRePick(ds.kind, ds.id); } });
      }
      // 图片（背景）/ 音频（音乐/音效）支持再编辑：调参 + 重新压缩，原图/原音频归档保留
      else if (ds.kind === 'background' || ds.kind === 'music' || ds.kind === 'sound') {
        items.push({ label: '再编辑（调参 / 压缩）', icon: 'ic-pencil', action: function () { openReEditModal(ds.kind, ds.id); } });
      }
      // 音乐库 ⇄ 音效库 互移（两者 asset 结构相同，仅 lib 不同）
      if (ds.kind === 'music' || ds.kind === 'sound') {
        const targetLib = (ds.kind === 'music') ? 'sound' : 'music';
        const targetCN = (targetLib === 'music') ? '音乐库' : '音效库';
        const moveIcon = (targetLib === 'music') ? 'ic-music' : 'ic-volume';
        items.push({ label: '移动到' + targetCN, icon: moveIcon, action: async function () {
          try {
            const asset = await window.Storage.getAsset(ds.kind, ds.id);
            if (!asset) { toast('素材不存在，无法移动'); return; }
            const fromCN = (ds.kind === 'music') ? '音乐' : '音效';
            const toCN = (targetLib === 'music') ? '音乐' : '音效';
            const aname = asset.name || ds.name;
            await window.Storage.saveAsset(targetLib, asset);
            await window.Storage.deleteAsset(ds.kind, ds.id);
            const n = swapSummonKindEverywhere(fromCN, toCN, aname);
            renderLibrary();
            toast('已移动到' + targetCN + '：' + aname + (n ? '（同步改写 ' + n + ' 处召唤指令）' : ''));
          } catch (err) { toast('移动失败：' + (err && err.message ? err.message : err)); }
        } });
        // 复制到另一库（保留原素材与原有召唤指令，仅新增一份到目标库）
        items.push({ label: '复制到' + targetCN, icon: 'ic-copy', action: async function () {
          try {
            const asset = await window.Storage.getAsset(ds.kind, ds.id);
            if (!asset) { toast('素材不存在，无法复制'); return; }
            const aname = asset.name || ds.name;
            const copyAsset = JSON.parse(JSON.stringify(asset));
            delete copyAsset.id; // 去掉 id，让 saveAsset 自动分配新 id，避免跨库 id 冲突
            delete copyAsset.key;
            await window.Storage.saveAsset(targetLib, copyAsset);
            renderLibrary();
            toast('已复制到' + targetCN + '：' + aname);
          } catch (err) { toast('复制失败：' + (err && err.message ? err.message : err)); }
        } });
      }
      // 已派生素材：可一键恢复原始（原图/原音频）
      if (ds.derived === '1') {
        items.push({ label: '恢复原始素材', icon: 'ic-undo', action: function () { restoreOriginalAsset(ds.kind, ds.id); } });
      }
      items.push({ label: '删除素材', icon: 'ic-trash', danger: true, action: async function () {
        try { await window.Storage.deleteAsset(ds.kind, ds.id); renderLibrary(); toast('已删除：' + ds.name); }
        catch (err) { toast('删除失败：' + (err && err.message ? err.message : err)); }
      } });
    }
    return items;
  }
  function textSelectedItems() {
    return [
      { label: '复制', icon: 'ic-copy', action: function () { const t = storyText.value.slice(storyText.selectionStart, storyText.selectionEnd); ctxCopyText(t); toast('已复制'); } },
      { label: '剪切', icon: 'ic-scissors', action: function () {
        const s = storyText.selectionStart, e = storyText.selectionEnd;
        if (s === e) { toast('未选中文字'); return; }
        const t = storyText.value.slice(s, e); ctxCopyText(t);
        storyText.value = storyText.value.slice(0, s) + storyText.value.slice(e);
        storyText.setSelectionRange(s, s); storyText.focus(); commitEdit(); toast('已剪切');
      } },
      { label: '粘贴', icon: 'ic-clipboard', action: function () { ctxPaste(); } },
      { label: '全选', icon: 'ic-select-all', action: function () { ctxSelectAll(); } },
      { separator: true },
      { label: '插入素材', icon: 'ic-plus', submenu: buildInsertAssetMenu() },
      { separator: true },
      { label: '插入「停顿」到选中后', icon: 'ic-pause', action: function () { insertPauseAfterSelection(); } },
      { label: 'AI 重写选中文字', icon: 'ic-redo', action: function () { if (typeof prepareMode === 'function') prepareMode('expand'); } },
      { label: 'AI 润色选中文字', icon: 'ic-sparkles', action: function () { if (typeof prepareMode === 'function') prepareMode('polish'); } },
      { separator: true },
      { label: '删除选中文字', icon: 'ic-trash', danger: true, action: function () { ctxDeleteSelection(); } },
    ];
  }
  function textEmptyItems() {
    return [
      { label: '粘贴', icon: 'ic-clipboard', action: function () { ctxPaste(); } },
      { label: '全选', icon: 'ic-select-all', action: function () { ctxSelectAll(); } },
      { separator: true },
      { label: '插入素材', icon: 'ic-plus', submenu: buildInsertAssetMenu() },
      { separator: true },
      { label: '插入「停顿」到当前行末', icon: 'ic-pause', action: function () { insertPauseBelow(); } },
      { label: 'AI 续写', icon: 'ic-sparkles', action: function () { if (typeof openAIQuickMenu === 'function') openAIQuickMenu(); else toast('未找到 AI 菜单'); } },
    ];
  }
  function libraryItems() {
    return [
      { label: '刷新素材库', icon: 'ic-refresh', action: function () { renderLibrary(); toast('已刷新素材库'); } },
      { separator: true },
      { label: '切到背景库', icon: 'ic-image', action: function () { switchLib('background'); } },
      { label: '切到3D库', icon: 'ic-box', action: function () { switchLib('item'); } },
      { label: '切到音乐库', icon: 'ic-music', action: function () { switchLib('music'); } },
      { label: '切到音效库', icon: 'ic-volume', action: function () { switchLib('sound'); } },
      { label: '切到剧情块库', icon: 'ic-comment', action: function () { switchLib('dialogueblock'); } },
      { label: '切到变量库', icon: 'ic-key', action: function () { switchLib('variable'); } },
      { separator: true },
      { label: '导入素材到当前库', icon: 'ic-plus', action: function () {
        if (activeLib === 'background') $('#file-bg').click();
        else if (activeLib === 'item') $('#file-item').click();
        else if (activeLib === 'overlay') $('#file-overlay').click();
        else if (activeLib === 'music') { pendingAudioLib = 'music'; $('#file-audio').click(); }
        else if (activeLib === 'sound') { pendingAudioLib = 'sound'; $('#file-audio').click(); }
        else if (activeLib === 'dialogueblock') { const n = window.Storage.addBlock('新对话'); switchBlock(n); }
        else if (activeLib === 'variable') { const vars = window.Storage.getVars(); vars.push({ name: '', type: 'number', value: 0 }); window.Storage.saveVars(vars); renderLibrary(); }
      } },
    ];
  }
  function generalItems() {
    return [
      { label: '粘贴', icon: 'ic-clipboard', action: function () { ctxPaste(); } },
      { label: '保存', icon: 'ic-download', action: function () { saveNow(); toast('已保存'); } },
      { label: '预览 / 导出', icon: 'ic-play', action: function () { openPreview(); } },
      { separator: true },
      { label: '插入「停顿」到当前行末', icon: 'ic-pause', action: function () { insertPauseBelow(); } },
      { label: 'AI 续写', icon: 'ic-sparkles', action: function () { if (typeof openAIQuickMenu === 'function') openAIQuickMenu(); else toast('未找到 AI 菜单'); } },
      { separator: true },
      { label: document.body.classList.contains('dark') ? '切换到亮色模式' : '切换到暗色模式', icon: 'ic-moon', action: function () { toggleTheme(); } },
    ];
  }
  function showContextMenu(x, y, items) {
    const menu = document.getElementById('ctx-menu'); if (!menu) return;
    ctxCloseSubs(); ctxSubToken++;
    menu.innerHTML = '';
    if (!items || !items.length) {
      const e = document.createElement('div'); e.className = 'ctx-empty'; e.textContent = '（无可用操作）'; menu.appendChild(e);
    } else {
      items.forEach(function (it) {
        if (it.separator) { const s = document.createElement('div'); s.className = 'ctx-sep'; menu.appendChild(s); return; }
        const row = document.createElement('div'); row.className = 'ctx-item' + (it.danger ? ' danger' : '') + (it.submenu ? ' has-sub' : '');
        const ico = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        ico.setAttribute('class', 'ctx-ico'); ico.setAttribute('aria-hidden', 'true');
        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttribute('href', '#' + (it.icon || 'ic-circle-dot')); ico.appendChild(use);
        const lbl = document.createElement('span'); lbl.textContent = it.label;
        row.appendChild(ico); row.appendChild(lbl);
        if (it.submenu) { row.addEventListener('mouseenter', function () { openCtxSub(row, it.submenu); }); }
        row.addEventListener('click', function (ev) { ev.stopPropagation(); if (it.submenu) return; hideContextMenu(); try { if (it.action) it.action(); } catch (e) { console.error(e); } });
        menu.appendChild(row);
      });
    }
    menu.classList.remove('hidden');
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let px = x, py = y;
    if (px + mw > window.innerWidth - 8) px = Math.max(8, window.innerWidth - mw - 8);
    if (py + mh > window.innerHeight - 8) py = Math.max(8, window.innerHeight - mh - 8);
    menu.style.left = px + 'px'; menu.style.top = py + 'px';
  }
  function hideContextMenu() { ctxSubToken++; const menu = document.getElementById('ctx-menu'); if (menu) menu.classList.add('hidden'); ctxCloseSubs(); }
  let lastCtxCaret = null; // 右键落点对应的字符偏移，作为「插入素材」等插入位置（绕开浏览器右键不移动光标的差异）
  function bindContextMenu() {
    document.addEventListener('contextmenu', function (e) {
      if (e.target.closest && e.target.closest(CTX_EXCLUDE)) return; // 保留原生菜单（输入框/弹窗/设置抽屉等）
      // 记录右键落点对应的字符偏移，避免「右键不移动光标」的浏览器把插入落到文末。
      // 优先用 getCaretOffsetFromPoint（拖拽插入已验证可靠），textarea 不被 caretRangeFromPoint 支持时退回镜像 div 反查。
      lastCtxCaret = null;
      if (e.target === storyText || (e.target.closest && e.target.closest('#story-text'))) {
        let off = getCaretOffsetFromPoint(storyText, e.clientX, e.clientY);
        if (typeof off !== 'number') off = offsetFromPoint(storyText, e.clientX, e.clientY);
        if (typeof off === 'number') lastCtxCaret = Math.max(0, Math.min(off, storyText.value.length));
      }
      e.preventDefault(); e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, buildContextItems(e.target));
    });
    document.addEventListener('click', hideContextMenu);
    document.addEventListener('scroll', hideContextMenu, true);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hideContextMenu(); });
    window.addEventListener('blur', hideContextMenu);
  }


  // ============ 右键：插入素材子菜单 ============
  function kindIcon(kind) {
    return ({ background: 'ic-image', item: 'ic-box', music: 'ic-music', sound: 'ic-volume' })[kind] || 'ic-circle-dot';
  }
  // 由鼠标视口坐标反推 textarea 内字符偏移（镜像 div 反查；textarea 内容非实时 DOM，caretRangeFromPoint 不可靠，故自实现）
  function offsetFromPoint(ta, clientX, clientY) {
    const len = ta.value.length;
    if (len === 0) return 0;
    let best = 0, bestDy = Infinity;
    const steps = Math.min(400, len);
    const step = Math.max(1, Math.floor(len / steps));
    for (let off = 0; off <= len; off += step) {
      const d = Math.abs(getCaretPixelPos(ta, off).y - clientY);
      if (d < bestDy) { bestDy = d; best = off; }
    }
    const fl = Math.max(0, best - step), fh = Math.min(len, best + step);
    for (let off = fl; off <= fh; off++) {
      const d = Math.abs(getCaretPixelPos(ta, off).y - clientY);
      if (d < bestDy) { bestDy = d; best = off; }
    }
    const h0 = getCaretPixelPos(ta, best).height || 20;
    let b2 = best, bestDx = Math.abs(getCaretPixelPos(ta, best).x - clientX);
    for (let off = Math.max(0, best - 80); off <= Math.min(len, best + 80); off++) {
      if (Math.abs(getCaretPixelPos(ta, off).y - getCaretPixelPos(ta, best).y) > h0 * 0.5) continue;
      const d = Math.abs(getCaretPixelPos(ta, off).x - clientX);
      if (d < bestDx) { bestDx = d; b2 = off; }
    }
    return b2;
  }
  // 右键「插入素材」的插入范围：优先用右键落点；有选中时替换选中（落点在选中外则落到落点）
  function ctxInsertRange() {
    const ta = storyText;
    const s = ta.selectionStart, e = ta.selectionEnd;
    if (e > s) {
      if (typeof lastCtxCaret === 'number' && (lastCtxCaret < s || lastCtxCaret > e)) return { s: lastCtxCaret, e: lastCtxCaret };
      return { s: s, e: e };
    }
    if (typeof lastCtxCaret === 'number') return { s: lastCtxCaret, e: lastCtxCaret };
    return { s: s, e: s };
  }
  function insertSummonTemplate(kind) {
    const cn = KIND_TO_CN[kind] || kind;
    const open = '<召唤' + cn + ':';
    const close = '>';
    const ta = storyText;
    const wasRO = ta.readOnly; ta.readOnly = false;
    try {
      const r = ctxInsertRange();
      const s = r.s, e = r.e;
      const before = ta.value.slice(0, s), after = ta.value.slice(e);
      const padBefore = (before && !before.endsWith('\n')) ? '\n' : '';
      const padAfter = (after && !after.startsWith('\n')) ? '\n' : '';
      const insert = padBefore + open + close + padAfter;
      ta.value = before + insert + after;
      const pos = (before + padBefore + open).length; // 光标落在「:」与「>」之间，直接输入素材名称
      ta.focus();
      try { ta.setSelectionRange(pos, pos); } catch (_) {}
      commitEdit();
      toast('已插入召唤指令，请填写素材名称');
    } finally { ta.readOnly = wasRO; }
  }
  function insertSummonFilled(kind, name) {
    const cn = KIND_TO_CN[kind] || kind;
    const txt = '<召唤' + cn + ':' + name + '>';
    const ta = storyText;
    const wasRO = ta.readOnly; ta.readOnly = false;
    try {
      const r = ctxInsertRange();
      const s = r.s, e = r.e;
      const before = ta.value.slice(0, s), after = ta.value.slice(e);
      const padBefore = (before && !before.endsWith('\n')) ? '\n' : '';
      const padAfter = (after && !after.startsWith('\n')) ? '\n' : '';
      const insert = padBefore + txt + padAfter;
      ta.value = before + insert + after;
      const pos = (before + insert).length;
      ta.focus();
      try { ta.setSelectionRange(pos, pos); } catch (_) {}
      commitEdit();
      toast('已插入：' + txt);
    } finally { ta.readOnly = wasRO; }
  }
  function buildInsertAssetMenu() {
    const cats = [
      { kind: 'background', label: '图片', icon: 'ic-image' },
      { kind: 'item', label: '物品', icon: 'ic-box' },
      { kind: 'music', label: '音乐', icon: 'ic-music' },
      { kind: 'sound', label: '音效', icon: 'ic-volume' },
    ];
    return cats.map(function (c) {
      return { label: c.label, icon: c.icon, submenu: function () { return buildAssetSubmenu(c.kind); }, action: function () { insertSummonTemplate(c.kind); } };
    });
  }
  async function buildAssetSubmenu(kind) {
    const items = [];
    items.push({ label: '✎ 输入名称…', icon: 'ic-pencil', action: function () { insertSummonTemplate(kind); } });
    const assets = await window.Storage.getAllAssets(kind);
    if (assets && assets.length) {
      items.push({ separator: true });
      assets.forEach(function (a) {
        const nm = a.name || ('未命名' + (a.id != null ? a.id : ''));
        items.push({ label: nm, icon: kindIcon(kind), action: function () { insertSummonFilled(kind, nm); } });
      });
    }
    return items;
  }
  function ctxMakePanel(items) {
    const panel = document.createElement('div');
    panel.className = 'ctx-sub';
    if (!items || !items.length) {
      const e = document.createElement('div'); e.className = 'ctx-empty'; e.textContent = '（无素材）'; panel.appendChild(e);
      return panel;
    }
    items.forEach(function (it) {
      if (it.separator) { const s = document.createElement('div'); s.className = 'ctx-sep'; panel.appendChild(s); return; }
      const row = document.createElement('div');
      row.className = 'ctx-item' + (it.danger ? ' danger' : '') + (it.submenu ? ' has-sub' : '');
      const ico = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      ico.setAttribute('class', 'ctx-ico'); ico.setAttribute('aria-hidden', 'true');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '#' + (it.icon || 'ic-circle-dot')); ico.appendChild(use);
      const lbl = document.createElement('span'); lbl.textContent = it.label;
      row.appendChild(ico); row.appendChild(lbl);
      if (it.submenu) {
        row.addEventListener('mouseenter', function () {
          const myToken = ++ctxSubToken;
          const sub = it.submenu;
          function open(real) { if (myToken !== ctxSubToken) return; openCtxSub(row, real); }
          if (typeof sub === 'function') {
            const res = sub();
            if (res && typeof res.then === 'function') res.then(open); else open(res);
          } else open(sub);
        });
        row.addEventListener('click', function (ev) {
          ev.stopPropagation();
          hideContextMenu();
          try { if (it.action) it.action(); } catch (e) { console.error(e); }
        });
      } else {
        row.addEventListener('click', function (ev) { ev.stopPropagation(); hideContextMenu(); try { if (it.action) it.action(); } catch (e) { console.error(e); } });
      }
      panel.appendChild(row);
    });
    return panel;
  }
  function ctxOwnerDepth(anchorRow) {
    const sub = anchorRow.closest ? anchorRow.closest('.ctx-sub') : null;
    if (!sub) return 0;
    return (sub.__depth || 1);
  }
  function openCtxSub(anchorRow, items) {
    const ownerDepth = ctxOwnerDepth(anchorRow);
    ctxSubPanels = ctxSubPanels.filter(function (p) {
      if ((p.__depth || 1) > ownerDepth) { p.remove(); return false; }
      return true;
    });
    const panel = ctxMakePanel(items);
    panel.__depth = ownerDepth + 1;
    document.body.appendChild(panel);
    ctxSubPanels.push(panel);
    const r = anchorRow.getBoundingClientRect();
    const pw = panel.offsetWidth, ph = panel.offsetHeight;
    let px = r.right + 4, py = r.top;
    if (px + pw > window.innerWidth - 8) px = Math.max(8, r.left - pw - 4);
    if (py + ph > window.innerHeight - 8) py = Math.max(8, window.innerHeight - ph - 8);
    panel.style.left = px + 'px'; panel.style.top = py + 'px';
  }

  // ============ 项目页 ============
  function showProjectsScreen(show) {
    $('#projects-screen').classList.toggle('hidden', !show);
  }
  // 新建项目时，把内置「示例冒险」工程一次性灌入该项目。
  // 仅在「新建项目」流程中调用（见新建按钮 handler），打开已有项目时绝不执行，
  // 因此不会再出现「所有项目打开时都被塞入默认素材」的情况。
  // sample-project.js 内含内联示例素材 data URL（约 9MB），改为按需懒加载：
  // 平时打开编辑器不加载它；仅当用户点「新建项目」或打开的项目需要修复示例素材时才动态 import。
  let _sampleProjectPromise = null;
  function ensureSampleProject() {
    if (_sampleProjectPromise) return _sampleProjectPromise;
    _sampleProjectPromise = import(new URL('./js/sample-project.js?v=20260731-21', location.href).href)
      .then(() => { return window.SAMPLE_PROJECT_JSON || null; })
      .catch((e) => { console.error('示例工程脚本加载失败', e); return null; });
    return _sampleProjectPromise;
  }
  // 修复旧版示例素材：v25.2.99 曾把图片/音乐以「相对路径 + 无 size」直接入库，
  // 导致编辑器显示 <0.01MB、再编辑解码失败、运行时（尤其离线/本地）加载不到图而采不到色值。
  // 打开项目时若发现示例资产仍是相对路径，则就地替换为内联 data URL + 正确 size（按 id 匹配 SAMPLE）。
  async function repairExampleAssetsIfNeeded() {
    let broken = [];
    for (const lib of ['background', 'music']) {
      let assets;
      try { assets = await window.Storage.getAllAssets(lib); } catch (e) { continue; }
      for (const a of (assets || [])) {
        if (a && typeof a.src === 'string' && a.src.indexOf('examples/') === 0) {
          broken.push({ lib: lib, rec: a });
        }
      }
    }
    if (!broken.length) return; // 无需修复：不触发 9MB 下载
    const json = await ensureSampleProject();
    if (!json || !json.data || !Array.isArray(json.data.assets)) return;
    const byId = {};
    for (const s of json.data.assets) { if (s && s.id) byId[s.id] = s; }
    let fixed = 0;
    for (const b of broken) {
      const s = byId[b.rec.id];
      if (!s || !s.src || s.src.indexOf('data:') !== 0) continue;
      const rec = Object.assign({}, b.rec);
      rec.src = s.src;
      rec.size = s.size || b.rec.size || 0;
      try { await window.Storage.saveAsset(b.lib, rec); fixed++; }
      catch (e) { console.warn('修复示例素材失败', b.rec.name, e); }
    }
    if (fixed) { console.log('已修复示例素材', fixed, '个'); renderLibrary(); }
  }
  async function fetchAsDataUrlAndSize(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const blob = await res.blob();
      const dataUrl = await new Promise((resolve) => {
        const r = new FileReader();
        r.onload = function () { resolve(r.result); };
        r.onerror = function () { resolve(null); };
        r.readAsDataURL(blob);
      });
      if (!dataUrl) return null;
      return { dataUrl: dataUrl, size: blob.size };
    } catch (e) { return null; }
  }
  async function importExampleAsset(lib, a) {
    const rec = { name: a.name };
    if (a.id) rec.id = a.id;
    if (lib === 'background') rec.kind = a.kind || 'image';
    const canInline = (lib === 'background' || lib === 'music') && a.src && a.src.indexOf('data:') !== 0;
    if (canInline) {
      const fetched = await fetchAsDataUrlAndSize(a.src);
      if (fetched && fetched.dataUrl) {
        rec.src = fetched.dataUrl;
        rec.size = fetched.size || a.size || 0;
      } else {
        rec.src = a.src;
        rec.size = a.size || 0;
      }
    } else {
      rec.src = a.src;
      rec.size = a.size || 0;
    }
    return rec;
  }
  async function seedExampleProjectInto(pid) {
    const json = window.SAMPLE_PROJECT_JSON;
    if (!json || json.format !== 'story-editor-project') return;
    const prev = window.Storage.getCurrentProjectId();
    window.Storage.setCurrentProject(pid); // 切到目标项目命名空间，确保写入落在正确项目
    try {
      const d = json.data || {};
      if (d.blocks) {
        try { window.Storage.saveBlocks(JSON.parse(d.blocks)); } catch (e) { console.warn('示例 blocks 解析失败', e); }
      }
      if (d.vars) {
        try { window.Storage.saveVars(JSON.parse(d.vars || '[]')); } catch (e) { console.warn('示例 vars 解析失败', e); }
      }
      if (d.meta) {
        try { window.Storage.saveMeta(JSON.parse(d.meta || '{}')); } catch (e) { console.warn('示例 meta 解析失败', e); }
      }
      const assets = Array.isArray(d.assets) ? d.assets : [];
      for (const a of assets) {
        if (!a || !a.lib || !a.id) continue;
        try {
          let rec;
          if (a.lib === 'item') {
            // 物品字段较多且 GLB 已是 dataURL，直接整份迁移并补全缺省字段
            rec = {
              id: a.id, name: a.name, glb: a.glb || '',
              exitMesh: a.exitMesh || (a.exitMeshes && a.exitMeshes[0]) || null,
              exitMeshes: a.exitMeshes || (a.exitMesh ? [a.exitMesh] : []),
              interactions: a.interactions || {}, sounds: a.sounds || {},
              defaultView: a.defaultView || null, bg: a.bg || null,
              lockRotation: !!a.lockRotation, chains: a.chains || [],
              exitBindings: a.exitBindings || {}
            };
          } else {
            rec = await importExampleAsset(a.lib, a);
          }
          await window.Storage.saveAsset(a.lib, rec);
        } catch (e) { console.warn('示例素材写入失败', (a.name || a.id), e); }
      }
    } finally {
      if (prev) window.Storage.setCurrentProject(prev); // 还原此前命名空间，避免错乱
    }
  }

  async function openProject(id) {
    window.Storage.setCurrentProject(id);
    await repairExampleAssetsIfNeeded(); // 就地修复旧版相对路径示例素材（按需触发 9MB 懒加载）
    currentProjectMode = window.Storage.getProjectMode(id); // 'article' | 'game'
    applyProjectMode();
    const meta = window.Storage.loadMeta() || {};
    syncGlobalFromMeta(meta); // 统一回读：开场背景/开场音乐/图标等全部字段，刷新重开项目后不再丢失
    // 剧情块系统：主剧情默认存在，游戏从主剧情开始
    const blk0 = window.Storage.loadBlocks();
    activeBlock = MAIN_BLOCK;
    let initial = blk0.main || '';
    // 首次启动（无任何剧情块存储）→ 用默认文本填充主剧情
    if (!window.Storage.hasBlocksData()) {
      if (initial === '') initial = DEFAULT_TEXT;
      window.Storage.setBlockText(activeBlock, initial);
    }
    text = window.Storage.getBlockText(activeBlock) || initial || DEFAULT_TEXT;
    storyText.value = text;
    updateWordCount();
    history = []; histIndex = -1;
    showProjectsScreen(false);
    // 注意：示例工程只在「新建项目」时灌入，此处不再自动播种，避免改动已有项目
    renderLibrary();
    updateBlockChip();
    renderOutline();
    applyEditorFont();
    saveNow();
    pushHistory(); // 初始快照，作为撤销起点
    updateUndoButtons();
    refreshTodo(); // 进入项目时扫描一次待办（非实时，仅此一次 + 打开/刷新时）
    renderReviewPanel();
    refreshReviewToggleBadge();
    refreshBlockReviewLine();
    ftResetSession(); // 全文助理对话按工程隔离：切工程时重置内存态，下次开面板从本工程 key 重新加载
  }
  function returnToProjects() {
    saveNow();
    renderProjectsScreen();
    showProjectsScreen(true);
  }
  async function renderProjectsScreen() {
    const list = $('#projects-list');
    list.innerHTML = '';
    const projects = window.Storage.listProjects();
    // 并行读取全部项目统计，避免卡片逐张 await 串行弹出
    const statsList = await Promise.all(projects.map(p => window.Storage.getProjectStats(p.id)));
    for (let i = 0; i < projects.length; i++) {
      const p = projects[i];
      const stats = statsList[i];
      const isArticle = p.mode === 'article';
      const modeLabel = isArticle ? '通用文章' : '剧情游戏';
      const card = document.createElement('div');
      card.className = 'project-card' + (isArticle ? ' is-article' : '');
      card.innerHTML =
        '<div class="project-card-main">' +
          '<div class="project-card-name">' + escapeHtml(p.name) + '</div>' +
          '<div class="project-card-meta">' +
            '<span class="mode-badge ' + (isArticle ? 'mode-article' : 'mode-game') + '">' + modeLabel + '</span>' +
            '素材 ' + stats.assetCount + ' 个 · 剧情 ' + stats.lineCount + ' 行' +
          '</div>' +
        '</div>' +
        '<div class="project-card-actions">' +
          '<button class="btn btn-ghost btn-p-open">打开</button>' +
          '<button class="btn btn-ghost btn-p-backup">备份</button>' +
          '<button class="btn btn-ghost btn-p-rename">重命名</button>' +
          '<button class="btn btn-ghost btn-p-del">删除</button>' +
        '</div>';
      card.querySelector('.btn-p-open').onclick = () => openProject(p.id);
      card.querySelector('.btn-p-backup').onclick = () => exportProjectBackup(p.id);
      card.querySelector('.btn-p-rename').onclick = () => {
        const name = prompt('项目新名称', p.name);
        if (name != null && name.trim()) { window.Storage.renameProject(p.id, name.trim()); renderProjectsScreen(); }
      };
      card.querySelector('.btn-p-del').onclick = () => {
        if (!confirm('确定删除项目「' + p.name + '」？其剧情与素材将一并清空，且不可恢复。')) return;
        window.Storage.deleteProject(p.id).then(() => renderProjectsScreen());
      };
      list.appendChild(card);
    }
    if (!projects.length) {
      list.innerHTML = '<div class="empty-tip">还没有项目，点右上角「＋ 新建项目」开始。</div>';
    }
  }

  // ============ 项目类型（通用文章 / 剧情游戏） ============
  function applyProjectMode() {
    document.body.classList.toggle('article-mode', currentProjectMode === 'article');
  }

  let _npSelectedMode = 'game';
  function openNewProjectModal() {
    _npSelectedMode = 'game';
    const nameInput = $('#new-project-name');
    if (nameInput) nameInput.value = '';
    const modal = $('#new-project-modal');
    modal.classList.remove('hidden');
    // 重置模式卡片选中态
    modal.querySelectorAll('.mode-card').forEach(c => {
      c.classList.toggle('selected', c.getAttribute('data-mode') === _npSelectedMode);
    });
    if (nameInput) setTimeout(() => nameInput.focus(), 30);
  }
  function closeNewProjectModal() {
    $('#new-project-modal').classList.add('hidden');
  }
  function bindNewProjectModal() {
    const modal = $('#new-project-modal');
    modal.querySelectorAll('.mode-card').forEach(card => {
      card.addEventListener('click', () => {
        _npSelectedMode = card.getAttribute('data-mode');
        modal.querySelectorAll('.mode-card').forEach(c => c.classList.toggle('selected', c === card));
      });
    });
    $('#new-project-x').addEventListener('click', closeNewProjectModal);
    $('#new-project-cancel').addEventListener('click', closeNewProjectModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeNewProjectModal(); });
    $('#new-project-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('#new-project-create').click();
    });
    $('#new-project-create').addEventListener('click', async () => {
      const name = ($('#new-project-name').value || '').trim();
      const id = window.Storage.createProject(name, _npSelectedMode);
      closeNewProjectModal();
      // 新建项目：灌入内置「示例冒险」工程（含剧情 / 变量 / 素材），仅此一次，之后不再改动该项目
      try { await ensureSampleProject(); await seedExampleProjectInto(id); }
      catch (e) { console.error('示例工程播种失败', e); }
      openProject(id);
    });
  }

  function bindGlobal() {
    // 项目页
    $('#btn-projects').addEventListener('click', returnToProjects);
    $('#btn-new-project').addEventListener('click', openNewProjectModal);
    bindNewProjectModal();
    // 工程备份导入：点按钮选文件 → 解析 → 新建独立项目
    const importInput = $('#file-import-project');
    $('#btn-import-project').addEventListener('click', () => { if (importInput) importInput.click(); });
    if (importInput) importInput.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) importProjectBackup(f);
    });

    storyText.addEventListener('input', () => {
      text = storyText.value;
      scheduleSave();
      hideCompileBar(); // 用户已动手修改，旧红字条失效
      updateErrorHighlights([]); // 清除错误高亮
      // 分屏/预览态下实时刷新右栏
      if (splitMode || previewMode) { clearTimeout(pvTimer); pvTimer = setTimeout(renderPreview, 200); }
      scheduleOutline(); // 导航栏随注释变化实时刷新
      updateWordCount(); // 右下角字数统计实时刷新
      refreshClueHint(); // 正文变化后检查是否需提示更新线索
      // 连续打字合并为一步，避免每键一栈
      clearTimeout(histTimer);
      histTimer = setTimeout(pushHistory, 500);
    });
    // 分屏滚动同步：编辑器滚动/光标移动 → 预览跟随
    storyText.addEventListener('scroll', syncScrollToPreview);
    // 行号槽：输入（防抖重建行数）+ 滚动同步 + 网页字体加载/窗口尺寸变化后重算行高
    storyText.addEventListener('input', scheduleLineNumbers);
    storyText.addEventListener('scroll', syncGutterScroll);
    window.addEventListener('resize', () => { lastLnCount = -1; buildLineNumbers(); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { lastLnCount = -1; buildLineNumbers(); });
    // 程序化改写 storyText.value（AI 生成 / 载入 / BBCode 包裹等）也刷新行号：
    // 在实例上重定义 value setter，拦截所有 .value = 赋值（含局部变量 ta === storyText）。
    (function installValueHook() {
      const proto = Object.getPrototypeOf(storyText);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (!desc) return;
      Object.defineProperty(storyText, 'value', {
        configurable: true,
        get() { return desc.get.call(this); },
        set(v) { desc.set.call(this, v); scheduleLineNumbers(); }
      });
    })();
    buildLineNumbers();
    storyText.addEventListener('click', () => { if (splitMode) withScrollLock(revealPreviewCursorLine); });
    storyText.addEventListener('keyup', () => { if (splitMode) withScrollLock(revealPreviewCursorLine); });
    storyPreview.addEventListener('scroll', syncScrollToEditor);
    storyText.addEventListener('keydown', (e) => {
      // 仅「文本框聚焦时」拦截 Tab：在下方插入一行 <停顿>
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        insertPauseBelow();
      }
      // 撤销/重做/保存的快捷键已移至全局 document 监听，使文本框未聚焦（光标不显示）时也能生效
    });
    // 全局快捷键：Ctrl/⌘+Z 撤销、Ctrl/⌘+Y 或 Ctrl/⌘+Shift+Z 重做、Ctrl/⌘+S 保存、F12 预览
    // 绑定在 document（而非 storyText）上，使文本框未聚焦（光标不显示）时撤销/重做也生效
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();
        const t = e.target;
        // 焦点在其它可编辑元素（非剧情文本）时，Ctrl+Z 交给原生撤销，不打断其编辑
        const otherEditable = t && t !== storyText && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
        if (!otherEditable) {
          if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
          else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); return; }
        }
        if (k === 's') { e.preventDefault(); saveNow(); toast('已保存'); return; }
      }
      if (e.key === 'F12') { e.preventDefault(); openPreview(); }
      // 右侧 Ctrl：按住=预览，松开=编辑
      if (e.code === 'ControlRight' && !e.repeat) { setPreviewMode(true); }
    });
    document.addEventListener('keyup', (e) => {
      if (e.code === 'ControlRight') { setPreviewMode(false); }
    });
    // 窗口失焦时强制松开，避免卡在预览态
    window.addEventListener('blur', () => { setPreviewMode(false); });
    $('#btn-undo').addEventListener('click', undo);
    $('#btn-redo').addEventListener('click', redo);
        $('#btn-bbcode-preview').addEventListener('click', togglePreview);
        $('#btn-split').addEventListener('click', () => {
          splitMode = !splitMode;
          const btn = $('#btn-split');
          btn.classList.toggle('active', splitMode);
          btn.textContent = splitMode ? '▣ 退出分屏' : '▥ 分屏';
          btn.title = splitMode ? '退出分屏预览' : '左写右渲分屏预览';
          // 与「审阅」面板互斥：进入分屏时关闭审阅列，避免三重栏挤压正文显示区
          if (splitMode) {
            const rc = $('#review-col');
            if (rc && !rc.classList.contains('hidden')) rc.classList.add('hidden');
          }
          applyLayout();
        });

        // 左侧导航：折叠 / 展开（折叠后不占正文编辑器空间）
        const outlineCol = $('#outline-col');
        const outlineToggle = $('#outline-toggle');
        const outlineReopen = $('#outline-reopen');
        const isPortrait = () => document.body.classList.contains('portrait');
        // 竖屏下始终显示编辑器左上角「🧭 导航」按钮来唤出浮动大纲；
        // 横屏下仅在折叠时显示该按钮。
        const updateOutlineReopenVisibility = () => {
          if (isPortrait()) outlineReopen.classList.remove('hidden');
          else outlineReopen.classList.toggle('hidden', !outlineCol.classList.contains('collapsed'));
        };
        const setOutlineCollapsed = (c) => {
          outlineCol.classList.toggle('collapsed', c);
          outlineReopen.classList.toggle('hidden', !c);
          try { localStorage.setItem('storyeditor:outline-collapsed', c ? '1' : '0'); } catch (e) {}
          updateOutlineReopenVisibility();
        };
        outlineToggle.addEventListener('click', () => {
          // 竖屏下大纲是浮动面板：« 按钮直接收起浮动面板
          if (isPortrait()) outlineCol.classList.remove('portrait-open');
          else setOutlineCollapsed(true);
        });
        // 编辑器左上角「🧭 导航」按钮：竖屏切换浮动面板，横屏展开折叠列
        outlineReopen.addEventListener('click', () => {
          if (isPortrait()) outlineCol.classList.toggle('portrait-open');
          else setOutlineCollapsed(false);
        });
        try { if (localStorage.getItem('storyeditor:outline-collapsed') === '1') setOutlineCollapsed(true); } catch (e) {}

        // ===== 比例适配：竖屏（高>宽）改为上下结构 =====
        function applyOrientation() {
          const portrait = window.innerHeight > window.innerWidth;
          document.body.classList.toggle('portrait', portrait);
          // 进出竖屏都清掉浮动面板状态，避免跨屏残留
          outlineCol.classList.remove('portrait-open');
          updateOutlineReopenVisibility();
        }
        window.addEventListener('resize', applyOrientation);
        window.addEventListener('orientationchange', applyOrientation);
        applyOrientation();

        // 禁用页面缩放：所有元素由网页自身比例适配，不允许双指 / 双击 / Ctrl+滚轮缩放
        (function disablePageZoom() {
          const block = (e) => e.preventDefault();
          // iOS Safari 双指捏合缩放手势（该浏览器不尊重 viewport 的 user-scalable=no）
          ['gesturestart', 'gesturechange', 'gestureend'].forEach(ev => document.addEventListener(ev, block, { passive: false }));
          // Android / WebView 双指捏合：多触点 touchmove 时阻止默认缩放手势
          document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
          // 双击缩放兜底
          let lastTouchEnd = 0;
          document.addEventListener('touchend', (e) => {
            const now = Date.now();
            if (now - lastTouchEnd <= 300) e.preventDefault();
            lastTouchEnd = now;
          }, { passive: false });
          // 桌面 Ctrl+滚轮 / 触控板捏合缩放（macOS 部分触控板也带 ctrlKey）
          document.addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) e.preventDefault(); }, { passive: false });
          // 双击事件兜底（PC 触摸板 / 部分 Android 浏览器）
          document.addEventListener('dblclick', block, { passive: false });
        })();

        // 文字工具栏：显示 / 隐藏 开关（位于列头、AI 按钮左侧）
        const bbToggle = $('#btn-bbcode-toggle');
        const bbFloat = $('#bbcode-float');
        // 只读状态由两路合并：手动「禁用输入法」(imeLock) + 文字工具栏出现自动锁 (bbcodeImeLock)
        let imeLock = false;
        let bbcodeImeLock = false;
        function applyReadOnly() { storyText.readOnly = imeLock || bbcodeImeLock; }
        const setToolbarVisible = (v) => {
          bbFloat.classList.toggle('hidden', !v);
          bbToggle.classList.toggle('active', v);
          try { localStorage.setItem('storyeditor:bbcode-visible', v ? '1' : '0'); } catch (e) {}
          // 竖屏下文字工具栏出现 → 自动禁用输入法（仍可点选文字）；横屏不锁，正常打字
          bbcodeImeLock = v && isPortraitNow();
          applyReadOnly();
        };
        bbToggle.addEventListener('click', () => setToolbarVisible(bbFloat.classList.contains('hidden')));
        // 默认关闭文字工具栏；若用户此前手动改过，则按 localStorage 偏好恢复（'0'=关, '1'=开）
        try {
          const bbPref = localStorage.getItem('storyeditor:bbcode-visible');
          if (bbPref === '0') setToolbarVisible(false);
          else if (bbPref === '1') setToolbarVisible(true);
        } catch (e) {}

    // 导出下拉
    $('#btn-export').addEventListener('click', (e) => {
      e.stopPropagation();
      $('#export-menu').classList.toggle('open');
    });
    document.addEventListener('click', () => $('#export-menu').classList.remove('open'));
    $('#export-menu').addEventListener('click', async (e) => {
      const t = e.target.closest('button[data-export]');
      if (!t) return;
      $('#export-menu').classList.remove('open');
      const mode = t.dataset.export;
      saveNow();
      if (mode === 'backup') { doExport('backup'); return; }
      const issues = await validateStory();
      if (issues.length) { showCompileBar(issues, () => doExport(mode)); return; }
      doExport(mode);
    });

    // 文档查看：新窗口打开使用文档（弹窗被拦截时改用新标签页，避免"打不开"假死）
    $('#btn-docs').addEventListener('click', (e) => {
      e.stopPropagation();
      const url = new URL('docs.html', location.href).href;
      let w = null;
      try { w = window.open(url, 'story_docs', 'width=980,height=820,resizable=yes,scrollbars=yes'); } catch (e2) {}
      if (w) { try { w.focus(); } catch (e2) {} }
      else {
        const a = document.createElement('a');
        a.href = url; a.target = '_blank'; a.rel = 'noopener';
        document.body.appendChild(a); a.click(); a.remove();
        toast('已在新标签页打开文档（弹窗被拦截）');
      }
    });

    // 预览
    $('#btn-preview').addEventListener('click', openPreview);
    $('#btn-close-preview').addEventListener('click', () => {
      const f = document.getElementById('preview-frame');
      // 关键：卸载 iframe 文档，强制停止运行时里仍在播放的背景音乐/音效/3D 循环
      if (f) { try { f.srcdoc = '<!doctype html><html><head></head><body></body></html>'; } catch (e) {} }
      $('#preview-modal').classList.add('hidden');
    });
    // 试玩顶栏「审阅」：取当前剧情上下文 → 弹输入框写修改意见
    $('#btn-review-play').addEventListener('click', requestReviewContext);
    // 审阅输入弹窗
    $('#review-input-save').addEventListener('click', saveReviewInput);
    $('#review-input-cancel').addEventListener('click', closeReviewInput);
    $('#review-input-modal').addEventListener('click', (e) => { if (e.target.id === 'review-input-modal') closeReviewInput(); });
    const rvInput = $('#review-input-text');
    if (rvInput) rvInput.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); closeReviewInput(); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveReviewInput(); }
    });
    // 编辑器右栏「审阅」开关
    $('#btn-review-panel').addEventListener('click', () => {
      const col = $('#review-col');
      if (col) col.classList.toggle('hidden');
      renderReviewPanel();
      // 与「分屏」互斥：打开审阅列时强制退出分屏，避免三重栏挤压正文显示区
      if (col && !col.classList.contains('hidden') && splitMode) {
        splitMode = false;
        const sb = $('#btn-split');
        if (sb) {
          sb.classList.remove('active');
          sb.textContent = '▥ 分屏';
          sb.title = '左写右渲分屏预览';
        }
        applyLayout();
      }
    });

    // 编译检查红字条按钮
    $('#compile-continue').addEventListener('click', () => { hideCompileBar(); const a = pendingAction; pendingAction = null; if (a) a(); });
    $('#compile-cancel').addEventListener('click', () => { hideCompileBar(); pendingAction = null; });

    // 素材库 tab
    $('#lib-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-lib]');
      if (!b) return;
      activeLib = b.dataset.lib;
      [...$('#lib-tabs').children].forEach(x => x.classList.toggle('active', x === b));
      renderLibrary();
    });
    // 当前剧情块指示器：点击切到剧情块库（方便切换/新建）
    const chip = $('#current-block-chip');
    if (chip) chip.addEventListener('click', () => {
      activeLib = 'dialogueblock';
      [...$('#lib-tabs').children].forEach(x => x.classList.toggle('active', x.dataset.lib === 'dialogueblock'));
      renderLibrary();
    });
    // 素材库右下角：清理未使用素材（两次确认）
    const btnClean = $('#btn-clean-unused');
    if (btnClean) btnClean.addEventListener('click', cleanUnusedAssets);

    // ============ 设置抽屉（含 AI 编剧） ============
    $('#btn-settings').addEventListener('click', (e) => { e.stopPropagation(); openSettings('ai'); });
    $('#settings-close').addEventListener('click', closeSettings);
    document.addEventListener('click', (e) => {
      const d = $('#settings-drawer');
      if (!d.classList.contains('hidden') && e.target === d) closeSettings();
    });
    document.querySelectorAll('.settings-subnav').forEach(b => b.addEventListener('click', () => switchSettingsSub(b.dataset.sub)));
    // 创作设定输入
    ['outline', 'intro', 'world', 'style'].forEach(k => {
      const el = $('#c-' + k);
      if (el) el.addEventListener('input', function () { const c2 = loadCreation(); c2[k] = this.value; saveCreation(c2); });
    });
    // 关键线索：输入即存本机（仅创作设定层，不进导出）
    const cluesEl = $('#ai-clues');
    if (cluesEl) cluesEl.addEventListener('input', function () { const c2 = loadCreation(); c2.clues = this.value; saveCreation(c2); });
    // AI 模型与密钥
    $('#ai-key').addEventListener('input', () => { const s = window.AI.loadSettings(); s.key = $('#ai-key').value; window.AI.saveSettings(s); loadAISettings(); });
    $('#ai-base').addEventListener('input', () => { const s = window.AI.loadSettings(); s.base = $('#ai-base').value; window.AI.saveSettings(s); });
    $('#ai-model').addEventListener('input', () => { const s = window.AI.loadSettings(); s.model = $('#ai-model').value; window.AI.saveSettings(s); });
    $('#ai-intensity').addEventListener('change', () => { const s = window.AI.loadSettings(); s.intensity = $('#ai-intensity').value; window.AI.saveSettings(s); });
    $('#ai-temp').addEventListener('input', () => { const v = parseFloat($('#ai-temp').value); $('#ai-temp-val').textContent = v; const s = window.AI.loadSettings(); s.temp = v; window.AI.saveSettings(s); });
    $('#ai-selfcheck').addEventListener('change', () => { const s = window.AI.loadSettings(); s.selfCheck = $('#ai-selfcheck').checked; window.AI.saveSettings(s); });
    // 隐藏所有 AI 功能（设置内开关）
    $('#ai-hide-all').addEventListener('change', () => { const s = window.AI.loadSettings(); s.hideAllAI = $('#ai-hide-all').checked; window.AI.saveSettings(s); applyHideAllAI(); });
    // 提取关键线索
    $('#btn-extract-clues').addEventListener('click', extractCluesHandler);
    $('#btn-extract-clues-quick').addEventListener('click', extractCluesQuick);
    refreshClueHint(); // 打开编辑器时若正文已相对上次提取变化较多，提示更新
    $('#btn-ai-quick').addEventListener('click', (e) => { e.stopPropagation(); const m = $('#ai-quick-menu'); if (m.classList.contains('hidden')) openAIQuickMenu(); else closeAIQuickMenu(); });
    document.addEventListener('click', (e) => {
      const m = $('#ai-quick-menu');
      if (!m.classList.contains('hidden') && !m.contains(e.target) && e.target.id !== 'btn-ai-quick') m.classList.add('hidden');
    });
    // 全文助理
    const ftBtn = $('#btn-ft-assistant'); if (ftBtn) ftBtn.addEventListener('click', openFulltextAssistant);
    $('#fta-close').addEventListener('click', () => $('#fulltext-assistant').classList.add('hidden'));
    $('#fta-start').addEventListener('click', ftStart);
    $('#fta-send').addEventListener('click', function () { if (ftBusy) ftStop(); else ftSend(); });
    $('#fta-refeed').addEventListener('click', ftRefeed);
    $('#fta-clear').addEventListener('click', ftClear);
    $('#fta-thinking').checked = ftThinking;
    $('#fta-thinking').addEventListener('change', function (e) {
      ftThinking = !!e.target.checked;
      try { localStorage.setItem('fta-thinking', ftThinking ? '1' : '0'); } catch (err) {}
    });
    $('#fta-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ftSend(); }
    });
    $('#ai-review-close').addEventListener('click', requestCloseReview);
    $('#ai-start-gen').addEventListener('click', startGeneration);
    // 生成中控制条：停止并采纳已有 / 插话改方向
    $('#ai-stop-keep').addEventListener('click', function () {
      if (aiReviewPhase !== 'generating') return;
      aiAbortReason = 'stop';
      if (aiAbort) aiAbort.abort();
    });
    $('#ai-redirect-toggle').addEventListener('click', function () {
      const box = $('#ai-redirect-box'); if (!box) return;
      box.classList.toggle('hidden');
      if (!box.classList.contains('hidden')) { const i = $('#ai-redirect-input'); if (i) i.focus(); }
    });
    $('#ai-redirect-send').addEventListener('click', doRedirect);
    const _ri = $('#ai-redirect-input');
    if (_ri) _ri.addEventListener('keydown', function (e) { if (e.key === 'Enter') doRedirect(); });
    // 备注 chips 点击：把情绪/历史备注追加到备注框
    const _nc = $('#ai-note-chips');
    if (_nc) _nc.addEventListener('click', function (e) {
      const chip = e.target.closest && e.target.closest('.ai-chip'); if (!chip) return;
      appendNote(chip.dataset.note || '');
    });
    // 生成参数滑块（谜题/分支数量）实时更新数值显示
    $('#ai-puzzle').addEventListener('input', () => { const v = parseInt($('#ai-puzzle').value, 10) || 0; const el = $('#ai-puzzle-val'); if (el) el.textContent = v; });
    $('#ai-branches').addEventListener('input', () => { const v = parseInt($('#ai-branches').value, 10) || 0; const el = $('#ai-branches-val'); if (el) el.textContent = v; });
    $('#ai-accept').addEventListener('click', acceptReview);
    $('#ai-revise').addEventListener('click', reviseReview);
    $('#ai-discard').addEventListener('click', () => { closeReviewModal(); aiReviewCtx = null; aiReviewMode = null; });
    $('#ai-req-copy').addEventListener('click', () => {
      const pre = $('#ai-review-req-text');
      if (pre && pre.textContent) {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(pre.textContent).catch(() => {});
        toast('已复制需求素材清单');
      }
    });
    $('#ai-hook-regen').addEventListener('click', () => {
      const note = prompt('要换一个方向吗？（下方已保留上次的备注，可直接修改或清空；留空则沿用原方向）', aiLastNote || '');
      if (note == null) return;
      aiReviseNote = note.trim();
      setReviewPhase('generating');
      startGeneration();
    });

    // 背景提示词生成窗
    $('#bgp-close').addEventListener('click', closeBgPromptModal);
    $('#bgp-done').addEventListener('click', closeBgPromptModal);
    $('#bgp-gen').addEventListener('click', runBgPromptGen);
    // 重新生成：不直接执行，先返回到用户补充输入界面，允许修改/补充参数后再确认生成
    $('#bgp-regen').addEventListener('click', () => {
      if (bgpName) {
        const setSel = (id, val) => { const el = document.getElementById(id); if (el && el.querySelector('option[value="' + val + '"]')) el.value = val; };
        setSel('bgp-ratio', bgpParams.ratio || 'landscape');
        setSel('bgp-style', bgpParams.style || '3d');
        setSel('bgp-lighting', bgpParams.lighting || 'dim-indoor');
        setSel('bgp-composition', bgpParams.composition || 'long');
        setSel('bgp-lens', (bgpParams.lens != null ? bgpParams.lens : 'none'));
        $('#bgp-special').value = bgpParams.special || '';
      }
      setBgpPhase('preview');
      setBgpStatus('已回到补充参数界面，可修改或补充后再次点击「生成提示词」重新生成。', '');
    });
    $('#bgp-copy').addEventListener('click', () => {
      const v = ($('#bgp-text').value || '').trim();
      if (!v) { toast('还没有提示词可复制'); return; }
      if (bgpName) saveAssetPrompt(bgpName, v); // 复制时一并保存手动编辑
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(v).then(() => toast('已复制提示词')).catch(() => toast('复制失败，请手动选择复制'));
      } else {
        const ta = $('#bgp-text'); ta.select(); try { document.execCommand('copy'); toast('已复制提示词'); } catch (e) { toast('复制失败，请手动选择复制'); }
      }
    });

    // BBCode 工具栏（直接作用于文本区选区）
    bindBBCode();
    bindColorPop();
    renderCommonColors();
    bindBBCodeDrag();
    // 字号快捷按钮
    document.querySelectorAll('.bb-size-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        const sz = btn.dataset.size;
        $('#bb-size').value = sz;
        $('#bb-size-val').textContent = sz;
        const ta = storyText;
        if (!ta) return;
        const st = ta.scrollTop;
        if (!smartWrap(ta, '[size=' + sz + ']', '[/size]', '文字')) { ta.scrollTop = st; return; }
        ta.scrollTop = st;
        commitEdit();
      });
    });
    // 滑块联动数值显示
    $('#bb-size').addEventListener('input', () => {
      $('#bb-size-val').textContent = $('#bb-size').value;
    });

    // 清除 BBCode
    $('#bb-clear').addEventListener('click', () => {
      const ta = storyText;
      if (!ta) return;
      const r = getRange(ta);
      const st = ta.scrollTop;
      const start = r.start;
      const lines = ta.value.split('\n');
      let pos = 0, lineNo = 0;
      for (let i = 0; i < lines.length; i++) {
        if (start >= pos && start <= pos + lines[i].length) { lineNo = i; break; }
        pos += lines[i].length + 1;
      }
      lines[lineNo] = lines[lineNo].replace(/\[\/?(?:b|i|u|s|left|right|center|瞬显|color=[^\]]*|size=\d+)\]/g, '');
      ta.value = lines.join('\n');
      ta.scrollTop = st;
      commitEdit();
    });

    // 标题按钮
    $('#bb-title-btn').addEventListener('click', () => {
      const ta = storyText;
      if (!ta) return;
      const st = ta.scrollTop;
      applyTitle(ta);
      ta.scrollTop = st;
      commitEdit();
    });

    // 分割线按钮：插入 <分割线:备注>（备注可空），游戏中显示并停顿
    $('#bb-divider-btn').addEventListener('click', () => {
      const ta = storyText;
      if (!ta) return;
      const st = ta.scrollTop;
      applyDivider(ta);
      ta.scrollTop = st;
      commitEdit();
    });

    // 停顿按钮（文字工具栏）：在选中行/光标处插入整行 <停顿>，不依赖焦点
    $('#bb-pause-btn').addEventListener('click', () => {
      const ta = storyText;
      if (!ta) return;
      const r = getRange(ta);
      const s = r.start, e = r.end;
      const before = ta.value.slice(0, s), after = ta.value.slice(ta.selectionEnd);
      const padBefore = (before && !before.endsWith('\n')) ? '\n' : '';
      const padAfter = (after && !after.startsWith('\n')) ? '\n' : '';
      const token = '<停顿>';
      const pre = before + padBefore + token;
      const pos = pre.length - 1;
      ta.value = pre + padAfter + after;
      if (document.activeElement === ta) try { ta.setSelectionRange(pos, pos); } catch (_) {}
      commitEdit();
    });
    // 添加选项按钮（文字工具栏）：在当前行行尾插入 <选项:""> 并将光标落在引号内
    $('#bb-option-btn').addEventListener('click', () => {
      const ta = storyText;
      if (!ta) return;
      const r = getRange(ta);
      const s = r.start;
      const val = ta.value;
      let lineEnd = val.indexOf('\n', s);
      if (lineEnd === -1) lineEnd = val.length;
      const before = val.slice(0, lineEnd);
      const after = val.slice(lineEnd);
      const insertStr = '<选项:"">';
      ta.value = before + insertStr + after;
      const caret = before.length + '<选项:"'.length;
      if (document.activeElement === ta) try { ta.setSelectionRange(caret, caret); } catch (_) {}
      commitEdit();
    });

    // 拖放：素材 / 剧情块 → 文本区（吸附到行首/行尾，并实时显示插入位置提示线）
    storyText.addEventListener('dragover', (e) => {
      const isVar = e.dataTransfer.types.includes('application/x-variable');
      if (e.dataTransfer.types.includes('application/x-asset') || e.dataTransfer.types.includes('application/x-block') || isVar) {
        e.preventDefault();
        storyText.classList.add('drag-over');
        // 变量：行内精确插入，不显示「吸附行尾」提示线（避免误导）
        if (isVar) { hideCaretHint(); return; }
        // 实时计算吸附点并显示小光标提示
        const off = getCaretOffsetFromPoint(storyText, e.clientX, e.clientY);
        if (off != null) {
          const snap = snapToLineEdge(storyText, off);
          const pos = getCaretPixelPos(storyText, snap);
          showCaretHint(pos.x, pos.y, pos.height);
        }
      }
    });
    storyText.addEventListener('dragleave', () => { storyText.classList.remove('drag-over'); hideCaretHint(); });
    storyText.addEventListener('drop', (e) => {
      const vData = e.dataTransfer.getData('application/x-variable');
      if (vData) {
        e.preventDefault();
        storyText.classList.remove('drag-over'); hideCaretHint();
        let info; try { info = JSON.parse(vData); } catch { return; }
        if (!info || !info.name) return;
        const ph = (info.type === 'boolean') ? '{' + info.name + ':是|否}' : '{' + info.name + '}';
        const off = getCaretOffsetFromPoint(storyText, e.clientX, e.clientY);
        const offset = off == null ? storyText.selectionStart : off;
        const range = insertInlineAtOffset(ph, offset);
        const optCtx = isOptionLineAt(range.start) ? lineCtxAt(range.start) : null;
        openVarPopover(info.name, info.type, range, optCtx);
        return;
      }
      const blockData = e.dataTransfer.getData('application/x-block');
      if (blockData) {
        e.preventDefault();
        storyText.classList.remove('drag-over'); hideCaretHint();
        let info;
        try { info = JSON.parse(blockData); } catch { return; }
        if (info && info.name) {
          // 拖剧情块 = 吸附到行首/行尾生成可编辑文字的选项
          const off = getCaretOffsetFromPoint(storyText, e.clientX, e.clientY);
          const offset = off == null ? storyText.selectionStart : snapToLineEdge(storyText, off);
          insertBlockOption(info.name, offset);
        }
        return;
      }
      const data = e.dataTransfer.getData('application/x-asset');
      if (!data) return;
      e.preventDefault();
      storyText.classList.remove('drag-over'); hideCaretHint();
      let info;
      try { info = JSON.parse(data); } catch { return; }
      // 按鼠标落点算插入位置并吸附到行首/行尾（拖拽时文本框未聚焦，必须用坐标算）
      const off = getCaretOffsetFromPoint(storyText, e.clientX, e.clientY);
      const offset = off == null ? storyText.selectionStart : snapToLineEdge(storyText, off);
      if (info.kind === 'stopmusic') {
        insertAtOffset('<停止音乐>', offset, 0);
      } else if (info.kind === 'clearoverlay') {
        insertAtOffset('<清除叠层>', offset, 0);
      } else if (info.kind === 'item') {
        // 物品：自动补全文字提示占位符，并把光标停在双引号之间
        insertAtOffset('<召唤物品:' + info.name + ',"">', offset, 2);
      } else {
        const cn = KIND_TO_CN[info.kind] || info.kind;
        insertAtOffset('<召唤' + cn + ':' + info.name + '>', offset, 0);
      }
    });

    // ============ 「禁用输入法」开关（竖屏插入素材用）============
    // 打开：点文字只移动插入光标（显示小光标提示线），不弹软键盘；点素材插到选中行。
    // 关闭：恢复正常输入（点文字弹键盘打字）。横屏下开关自动隐藏（见 css）。
    let pendingInsertOffset = null;
    const imeLockBtn = $('#ime-lock-btn');
    if (imeLockBtn) {
      imeLockBtn.addEventListener('click', () => {
        imeLock = !imeLock;
        applyReadOnly();
        imeLockBtn.classList.toggle('active', imeLock);
        if (!imeLock) { hideCaretHint(); pendingInsertOffset = null; }
        toast(imeLock ? '已禁用输入法：点文字选行，点素材插入' : '已恢复输入法');
      });
    }
    // 只读态下（文字工具栏出现 / 手动禁输入法）仍能「选择文字」：记录最近一次选区，
    // 点工具栏按钮时若选区被折叠（手机点按钮会丢选区），用记录恢复，保证格式套用到选中文字。
    function captureSel() { lastTextSel.start = storyText.selectionStart; lastTextSel.end = storyText.selectionEnd; }
    storyText.addEventListener('mouseup', captureSel);
    storyText.addEventListener('touchend', captureSel);
    storyText.addEventListener('keyup', captureSel);
    storyText.addEventListener('select', captureSel);
    // 统一获取「有效选区」逻辑见模块顶层的 getRange（与 insertAtCursor 同层，供 init 内外调用）。
    // 锁定模式：点文字 = 标记插入行（不聚焦、不弹键盘），显示小光标提示线
    storyText.addEventListener('click', (e) => {
      if (!imeLock) return;
      const off = getCaretOffsetFromPoint(storyText, e.clientX, e.clientY);
      if (off == null) return;
      const snap = snapToLineEdge(storyText, off);
      pendingInsertOffset = snap;
      try { storyText.setSelectionRange(snap, snap); } catch (_) {}
      refreshInsertHint();
    });
    // 滚动后提示线错位，隐藏等重新点选
    storyText.addEventListener('scroll', () => { if (imeLock) hideCaretHint(); });
    // 在已标记的插入行处刷新小光标提示线
    function refreshInsertHint() {
      if (imeLock && pendingInsertOffset != null) {
        const p = getCaretPixelPos(storyText, pendingInsertOffset);
        showCaretHint(p.x, p.y, p.height);
      }
    }
    // 横竖屏判定见模块顶层 isPortraitNow / isLandscapeNow（已提升到 IIFE 顶层，供 makeCard 等共用）
    // 横竖屏切换：同步已渲染素材卡的 draggable（横屏可拖、竖屏禁拖避免吞点击），
    // 并强制退出「禁用输入法」锁定（该开关仅竖屏有意义），恢复可编辑。
    function syncCardDraggable() {
      const land = isLandscapeNow();
      document.querySelectorAll('.asset-card').forEach((c) => { c.draggable = land; });
      if (land && (imeLock || bbcodeImeLock)) {
        imeLock = false;
        bbcodeImeLock = false;
        applyReadOnly();
        const btn = document.getElementById('ime-lock-btn');
        if (btn) btn.classList.remove('active');
        hideCaretHint(); pendingInsertOffset = null;
      }
    }
    window.addEventListener('orientationchange', syncCardDraggable);
    window.addEventListener('resize', syncCardDraggable);

    // 文件导入
    $('#file-bg').addEventListener('change', (e) => { const f = e.target.files; e.target.value = ''; importFiles(f, 'background', 'image'); });
    $('#file-overlay').addEventListener('change', (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      if (!files.length) return;
      (async () => {
        let ok = 0, fail = 0;
        for (const f of files) {
          const err = validatePastedImage(f);
          if (err) { toast(err); fail++; continue; }
          try { const src = await readFileAsDataUrl(f); await window.Storage.saveAsset('overlay', { name: f.name, src }); ok++; }
          catch (err2) { fail++; console.error('叠层保存失败', err2); }
        }
        if (fail) toast('有 ' + fail + ' 个叠层保存失败');
        else if (ok) toast('已导入 ' + ok + ' 张叠层图');
        focusLibrary('overlay');
      })();
    });
    $('#file-item').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; importBundle(f); });
    $('#file-audio').addEventListener('change', (e) => {
      const f = e.target.files; const lib = pendingAudioLib; e.target.value = '';
      pendingAudioLib = null;
      if (lib) importFiles(f, lib, 'audio');
    });

    // 右侧库拖拽文件导入
    let dragDepth = 0;
    libPanel.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
      e.preventDefault(); dragDepth++; libPanel.classList.add('drag-over');
    });
    libPanel.addEventListener('dragover', (e) => {
      if (e.dataTransfer && e.dataTransfer.types.includes('Files')) e.preventDefault();
    });
    libPanel.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) libPanel.classList.remove('drag-over');
    });
    libPanel.addEventListener('drop', (e) => {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      e.preventDefault(); dragDepth = 0; libPanel.classList.remove('drag-over');
      handleDroppedFiles(files);
    });
  }

  // 取音频文件时长（秒）；取不到返回 NaN
  function getAudioDuration(file) {
    return new Promise((resolve) => {
      let url = '';
      try { url = URL.createObjectURL(file); } catch (e) { url = ''; }
      const au = new Audio();
      const cleanup = () => { try { if (url) URL.revokeObjectURL(url); } catch (e) {} };
      au.onloadedmetadata = () => { const d = au.duration; cleanup(); resolve(isFinite(d) ? d : NaN); };
      au.onerror = () => { cleanup(); resolve(NaN); };
      au.src = url;
    });
  }

  // 10~30 秒音频：弹窗让用户选择归入音乐库还是音效库，返回 'music' | 'sound' | null
  function askAudioLib(file) {
    return new Promise((resolve) => {
      const overlay = $('#audio-ask');
      if (!overlay) { resolve('music'); return; }
      $('#audio-ask-file').textContent = file.name;
      overlay.classList.remove('hidden');
      function finish(v) {
        overlay.classList.add('hidden');
        $('#audio-ask-music').removeEventListener('click', onMusic);
        $('#audio-ask-sound').removeEventListener('click', onSound);
        $('#audio-ask-cancel').removeEventListener('click', onCancel);
        overlay.removeEventListener('click', onMask);
        resolve(v);
      }
      const onMusic = () => finish('music');
      const onSound = () => finish('sound');
      const onCancel = () => finish(null);
      function onMask(e) { if (e.target === overlay) finish(null); }
      $('#audio-ask-music').addEventListener('click', onMusic);
      $('#audio-ask-sound').addEventListener('click', onSound);
      $('#audio-ask-cancel').addEventListener('click', onCancel);
      overlay.addEventListener('click', onMask);
    });
  }

  // 把拖入右侧库的文件按内容智能归类（不依赖当前激活库）：
  //  - 场景包（GLB/.json/.gltf/.jgl/.zip）→ 物品库（.jgl 为 3D交互制作器新导出格式）
  //  - 图片 → 背景库
  //  - 音频按时长：<10s 音效库、>30s 音乐库、10~30s 询问
  async function handleDroppedFiles(files) {
    const arr = Array.from(files);
    if (!arr.length) return;
    const bundles = [], images = [], audios = [];
    const isBundle = (f) => /\.(json|glb|gltf|jgl|zip)$/i.test(f.name) || /json|gltf|zip/.test(f.type || '');
    const isImage = (f) => (f.type || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.name);
    const isAudio = (f) => (f.type || '').startsWith('audio/') || /\.(mp3|wav|ogg|m4a|flac|aac|wma)$/i.test(f.name);
    for (const f of arr) {
      if (isBundle(f)) bundles.push(f);
      else if (isImage(f)) images.push(f);
      else if (isAudio(f)) audios.push(f);
      else toast('无法识别文件类型，已跳过：' + f.name);
    }
    // 场景包（GLB 等）→ 物品库（即便当前在背景库，也自动归物品）
    for (const f of bundles) {
      const wasActive = activeLib;
      importBundle(f);
      if (wasActive !== 'item') toast('「' + f.name + '」已自动归入物品库');
    }
    // 图片 → 背景库
    if (images.length) importFiles(images, 'background', 'image');
    // 音频 → 按时长归类
    for (const f of audios) {
      let dur = NaN;
      try { dur = await getAudioDuration(f); } catch (e) { dur = NaN; }
      if (!isFinite(dur)) {
        // 取不到时长：退化为按当前库（音乐/音效），都不符则归音乐
        const lib = (activeLib === 'sound') ? 'sound' : 'music';
        await importFiles([f], lib, 'audio');
        continue;
      }
      if (dur < 10) {
        await importFiles([f], 'sound', 'audio');
        toast('「' + f.name + '」时长 ' + dur.toFixed(1) + 's，已自动归入音效库');
      } else if (dur > 30) {
        await importFiles([f], 'music', 'audio');
        toast('「' + f.name + '」时长 ' + dur.toFixed(1) + 's，已自动归入音乐库');
      } else {
        const choice = await askAudioLib(f);
        if (!choice) { toast('已跳过「' + f.name + '」'); continue; }
        await importFiles([f], choice, 'audio');
      }
    }
  }

  // 统一获取「有效选区」：优先实时光标选区，其次最近一次选区快照（lastTextSel，
  // 解决手机点按钮失焦后选区丢失），再无则交调用方取整行。不依赖焦点，移动端只读态可用。
  // 定义在模块顶层，使 init 内部与外部（insertAtCursor 等）都能调用（原先定义在 init 内部导致 ReferenceError）。
  function getRange(ta) {
    const a = ta.selectionStart, b = ta.selectionEnd;
    if (b > a) return { start: a, end: b };
    if (lastTextSel.end > lastTextSel.start) return { start: lastTextSel.start, end: lastTextSel.end };
    return { start: a, end: a };
  }

  // 在光标处插入文本（自动补换行，保持每行为一个单元）
  // caretFromEnd：插入后光标从末尾往前回退的字符数（用于把光标停在某个占位符中间）
  function insertAtCursor(str, caretFromEnd) {
    const ta = storyText;
    const st = ta.scrollTop;
    const r = getRange(ta);
    const s = r.start, e = r.end;
    const before = ta.value.slice(0, s);
    const after = ta.value.slice(e);
    const padBefore = (before && !before.endsWith('\n')) ? '\n' : '';
    const padAfter = (after && !after.startsWith('\n')) ? '\n' : '';
    const insert = padBefore + str + padAfter;
    ta.value = before + insert + after;
    let pos = (before + insert).length;
    if (caretFromEnd) pos = Math.max(before.length + padBefore.length, pos - caretFromEnd);
    if (document.activeElement === ta) try { ta.setSelectionRange(pos, pos); } catch (e2) {}
    ta.scrollTop = st;
    commitEdit();
  }

  // 根据鼠标坐标算文本框内的字符偏移（拖拽落点插入用）；不支持/取不到时返回 null
  function getCaretOffsetFromPoint(ta, clientX, clientY) {
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(clientX, clientY);
      if (r) {
        if (r.startContainer === ta && typeof r.startOffset === 'number') return r.startOffset;
        // 部分浏览器把光标落在 textarea 内部编辑器的文本节点上
        if (r.startContainer && r.startContainer.nodeType === 3 && ta.contains(r.startContainer) && typeof r.startOffset === 'number') return r.startOffset;
      }
    }
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(clientX, clientY);
      if (p) {
        if (p.offsetNode === ta && typeof p.offset === 'number') return p.offset;
        if (p.offsetNode && p.offsetNode.nodeType === 3 && ta.contains(p.offsetNode) && typeof p.offset === 'number') return p.offset;
      }
    }
    return null;
  }

  // 把精确落点吸附到所在行的「行首」或「行尾」（取离落点更近的一端）。
  // 原因：<召唤X:...> / <选项:...> 这类指令应单独成行，插在行中间会破坏该行其它文本。
  function snapToLineEdge(ta, off) {
    const v = ta.value;
    off = Math.max(0, Math.min(off, v.length));
    const lineStart = v.lastIndexOf('\n', off - 1) + 1; // 该行第一个字符的偏移
    let lineEnd = v.indexOf('\n', off);                 // 该行末尾换行符位置（行尾即此偏移）
    if (lineEnd === -1) lineEnd = v.length;            // 落在最后一行：行尾 = 文末
    // 离行首更近吸行首，否则吸行尾（平局取行尾，更贴近「追加到行末」直觉）
    return (off - lineStart) <= (lineEnd - off) ? lineStart : lineEnd;
  }

  // 用镜像 div 估算 textarea 中某字符偏移处的像素坐标（视口坐标），供拖拽插入位置提示线使用
  let _caretMirror = null;
  function getCaretPixelPos(ta, offset) {
    const cs = getComputedStyle(ta);
    if (!_caretMirror) {
      _caretMirror = document.createElement('div');
      _caretMirror.id = '__caret_mirror';
      _caretMirror.setAttribute('aria-hidden', 'true');
      document.body.appendChild(_caretMirror);
    }
    const m = _caretMirror;
    const pl = parseFloat(cs.paddingLeft) || 0;
    const pr = parseFloat(cs.paddingRight) || 0;
    const pt = parseFloat(cs.paddingTop) || 0;
    const contentW = ta.clientWidth - pl - pr;
    Object.assign(m.style, {
      position: 'absolute', visibility: 'hidden',
      whiteSpace: 'pre-wrap', wordWrap: 'break-word', overflowWrap: 'break-word',
      boxSizing: 'content-box',
      width: Math.max(0, contentW) + 'px',
      fontFamily: cs.fontFamily, fontSize: cs.fontSize,
      fontWeight: cs.fontWeight, fontStyle: cs.fontStyle,
      lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing,
      textTransform: cs.textTransform,
      padding: '0', border: '0', margin: '0',
      top: ta.getBoundingClientRect().top + 'px',
      left: ta.getBoundingClientRect().left + 'px',
    });
    m.textContent = ta.value.slice(0, offset);
    const marker = document.createElement('span');
    marker.textContent = String.fromCharCode(8203); // 零宽空格，仅用于取其后位置
    m.appendChild(marker);
    const mRect = m.getBoundingClientRect();
    const x = mRect.left + marker.offsetLeft - ta.scrollLeft + pl;
    const y = mRect.top + marker.offsetTop - ta.scrollTop + pt;
    const height = marker.offsetHeight || parseFloat(cs.lineHeight) || 20;
    return { x, y, height };
  }

  // 拖拽时的「插入位置提示线」（小光标），fixed 定位、不拦截事件
  let _caretHint = null;
  function showCaretHint(x, y, h) {
    if (!_caretHint) {
      _caretHint = document.createElement('div');
      _caretHint.id = 'drag-caret-hint';
      document.body.appendChild(_caretHint);
    }
    _caretHint.style.display = 'block';
    _caretHint.style.left = x + 'px';
    _caretHint.style.top = y + 'px';
    _caretHint.style.height = h + 'px';
  }
  function hideCaretHint() { if (_caretHint) _caretHint.style.display = 'none'; }

  // 在指定字符偏移处插入文本（拖拽落点）；caretFromEnd 同 insertAtCursor
  function insertAtOffset(str, offset, caretFromEnd) {
    const ta = storyText;
    const st = ta.scrollTop;
    offset = Math.max(0, Math.min(offset, ta.value.length));
    const before = ta.value.slice(0, offset);
    const after = ta.value.slice(offset);
    const padBefore = (before && !before.endsWith('\n')) ? '\n' : '';
    const padAfter = (after && !after.startsWith('\n')) ? '\n' : '';
    const insert = padBefore + str + padAfter;
    ta.value = before + insert + after;
    let pos = (before + insert).length;
    if (caretFromEnd) pos = Math.max(before.length + padBefore.length, pos - caretFromEnd);
    try { ta.setSelectionRange(pos, pos); } catch (e) {}
    // 拖拽插入不抢占焦点：避免手机软键盘 / 桌面中文输入法候选条被唤起
    if (document.activeElement === ta) ta.blur();
    ta.scrollTop = st;
    commitEdit();
  }

  // 行内精确插入（变量读取占位用：不吸附行首/尾、不加换行 padding），返回插入范围 {start,end}
  function insertInlineAtOffset(str, offset) {
    const ta = storyText; const st = ta.scrollTop;
    offset = Math.max(0, Math.min(offset, ta.value.length));
    const before = ta.value.slice(0, offset);
    const after = ta.value.slice(offset);
    ta.value = before + str + after;
    const start = before.length; const end = before.length + str.length;
    try { ta.setSelectionRange(end, end); } catch (e) {}
    if (document.activeElement === ta) ta.blur();
    ta.scrollTop = st;
    commitEdit();
    return { start, end };
  }
  // 判断偏移所在行是否含 <选项:（变量浮窗据此显示「作为条件」）
  function isOptionLineAt(off) {
    const v = storyText.value;
    const ls = v.lastIndexOf('\n', off - 1) + 1;
    let le = v.indexOf('\n', off); if (le === -1) le = v.length;
    return v.slice(ls, le).indexOf('<选项:') >= 0;
  }
  function lineCtxAt(off) {
    const v = storyText.value;
    const ls = v.lastIndexOf('\n', off - 1) + 1;
    let le = v.indexOf('\n', off); if (le === -1) le = v.length;
    return { lineStart: ls, lineEnd: le };
  }
  let _varPop = null, _varPopRange = null, _varPopOutside = null, _varPopEsc = null;
  function openVarPopover(name, type, range, optCtx) {
    _varPopRange = range;
    if (!_varPop) { _varPop = document.createElement('div'); _varPop.id = 'var-popover'; document.body.appendChild(_varPop); }
    const isBool = (type === 'boolean');
    const items = [{ label: '读取', sub: isBool ? '{' + name + ':是|否}' : '{' + name + '}', act: 'read' }];
    items.push({ label: '赋值', sub: '<变量:' + name + '=>', act: 'assign' });
    if (!isBool) { items.push({ label: '+1', sub: '<变量:' + name + '+1>', act: 'inc' }); items.push({ label: '-1', sub: '<变量:' + name + '-1>', act: 'dec' }); }
    if (optCtx) items.push({ label: '作为条件', sub: ',条件:' + name, act: 'cond' });
    _varPop.innerHTML = '';
    const title = document.createElement('div'); title.className = 'vp-title'; title.textContent = '插入「' + name + '」语句';
    _varPop.appendChild(title);
    items.forEach(function (it) {
      const b = document.createElement('button'); b.className = 'vp-item'; b.type = 'button';
      b.innerHTML = '<span>' + it.label + '</span><span class="vp-sub">' + escapeHtml(it.sub) + '</span>';
      b.addEventListener('click', function (e) { e.stopPropagation(); applyVarChoice(it.act, name, type, range, optCtx); closeVarPopover(); });
      _varPop.appendChild(b);
    });
    const pos = getCaretPixelPos(storyText, range.start);
    _varPop.style.left = Math.min(pos.x, window.innerWidth - 170) + 'px';
    _varPop.style.top = (pos.y + pos.height + 6) + 'px';
    _varPop.classList.add('show');
    if (_varPopOutside) document.removeEventListener('mousedown', _varPopOutside);
    _varPopOutside = function (e) { if (_varPop && !_varPop.contains(e.target)) closeVarPopover(); };
    setTimeout(function () { document.addEventListener('mousedown', _varPopOutside); }, 0);
    if (_varPopEsc) document.removeEventListener('keydown', _varPopEsc);
    _varPopEsc = function (e) { if (e.key === 'Escape') closeVarPopover(); };
    document.addEventListener('keydown', _varPopEsc);
  }
  function closeVarPopover() {
    if (_varPop) _varPop.classList.remove('show');
    _varPopRange = null;
    if (_varPopOutside) { document.removeEventListener('mousedown', _varPopOutside); _varPopOutside = null; }
    if (_varPopEsc) { document.removeEventListener('keydown', _varPopEsc); _varPopEsc = null; }
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function applyVarChoice(act, name, type, range, optCtx) {
    const ta = storyText, v = ta.value;
    const setVal = function (s, caretFromStart) {
      ta.value = v.slice(0, range.start) + s + v.slice(range.end);
      const pos = (caretFromStart != null) ? range.start + caretFromStart : (range.start + s.length);
      try { ta.setSelectionRange(pos, pos); } catch (e) {}
      if (document.activeElement === ta) ta.blur();
      commitEdit();
    };
    if (act === 'read') { setVal((type === 'boolean') ? '{' + name + ':是|否}' : '{' + name + '}'); }
    else if (act === 'assign') { setVal('<变量:' + name + '=>', ('<变量:' + name + '=').length); }
    else if (act === 'inc') { setVal('<变量:' + name + '+1>'); }
    else if (act === 'dec') { setVal('<变量:' + name + '-1>'); }
    else if (act === 'cond') {
      let nv = v.slice(0, range.start) + v.slice(range.end);
      const ls = optCtx.lineStart;
      const le = optCtx.lineEnd - (range.end - range.start);
      const line = nv.slice(ls, le);
      // 本行可能含多个 <选项:...>（同一行多个选项），需定位 drop 点所在 / 最近的那个
      const re = /<选项:[^>]*>/g; let m, segs = [];
      while ((m = re.exec(line)) !== null) segs.push({ s: m.index, e: m.index + m[0].length, seg: m[0] });
      let target = null;
      for (const sg of segs) { if (range.start >= ls + sg.s && range.start <= ls + sg.e) { target = sg; break; } }
      if (!target) {
        // 落在选项间空隙或行尾：取 drop 点之前最近的选项；若落在首个之前则取首个
        let best = null;
        for (const sg of segs) { if (ls + sg.e <= range.start) best = sg; }
        target = best || (segs.length ? segs[segs.length - 1] : null);
      }
      if (target) {
        let seg = target.seg;
        if (/条件:/.test(seg)) seg = seg.replace(/(条件:[^>]*?)>/, function (mm, c) { return c + ' && ' + name + '>'; });
        else seg = seg.slice(0, -1) + ',条件:' + name + '>';
        nv = nv.slice(0, ls + target.s) + seg + nv.slice(ls + target.e);
        ta.value = nv;
        const pos = ls + target.s + seg.lastIndexOf(name) + name.length;
        try { ta.setSelectionRange(pos, pos); } catch (e) {}
        if (document.activeElement === ta) ta.blur();
        commitEdit();
      }
    }
  }

  // TAB 快捷键：在当前行下方插入一行 <停顿>，光标落到停顿的下一行
  function insertPauseBelow() {
    const ta = storyText;
    const st = ta.scrollTop;
    const s = ta.selectionStart;
    const v = ta.value;
    let lineEnd = v.indexOf('\n', s);
    if (lineEnd === -1) lineEnd = v.length; // 当前行是最后一行
    const insert = '\n<停顿>\n';
    ta.value = v.slice(0, lineEnd) + insert + v.slice(lineEnd);
    const pos = lineEnd + insert.length; // 停在「<停顿>」下一行的行首
    ta.setSelectionRange(pos, pos);
    ta.focus();
    ta.scrollTop = st;
    commitEdit();
  }

  // ============ 素材库渲染 ============
  // 计数条：每个库顶部显示「共 N 项」，加载中为「加载中…」、出错为「读取失败」
  function setLibCount(el, n, label) {
    el.textContent = label + ' · 共 ' + n + ' 项';
  }
  function renderLibrary() {
    libPanel.innerHTML = '';
    const tools = document.createElement('div');
    tools.className = 'lib-tools';
    const countEl = document.createElement('div');
    countEl.className = 'lib-count';
    countEl.textContent = '加载中…';
    const list = document.createElement('div');
    list.className = 'asset-list';

    // 读取失败：明确报错 + 重试按钮（不再静默留空，避免「素材不显示=坏了」的误解）
    const showError = (msg) => {
      list.innerHTML = '<div class="lib-error"><svg class="ico" aria-hidden="true"><use href="#ic-alert"/></svg> 素材读取失败'
        + '<div class="lib-error-detail">' + escapeHtml(msg || '未知错误') + '</div>'
        + '<button class="btn btn-sm" id="lib-retry" type="button">重试</button></div>';
      const rb = list.querySelector('#lib-retry');
      if (rb) rb.onclick = renderLibrary;
      countEl.textContent = '读取失败';
    };

    if (activeLib === 'background') {
      tools.innerHTML = '<button class="btn" id="t-bg-img"><svg class="ico" aria-hidden="true"><use href="#ic-image"/></svg> 导入图片</button>'
        + '<div class="lib-tools-row">'
        + '<button class="btn" id="t-bg-grad"><svg class="ico" aria-hidden="true"><use href="#ic-gradient"/></svg> 渐变生成器</button>'
        + '<button class="btn" id="t-bg-noise"><svg class="ico" aria-hidden="true"><use href="#ic-noise"/></svg> 噪波生成器</button>'
        + '<button class="btn" id="t-bg-solid"><svg class="ico" aria-hidden="true"><use href="#ic-color"/></svg> 纯色生成器</button>'
        + '</div>';
      tools.querySelector('#t-bg-img').onclick = () => $('#file-bg').click();
      tools.querySelector('#t-bg-grad').onclick = () => openGradientGen();
      tools.querySelector('#t-bg-noise').onclick = () => openNoiseGen();
      tools.querySelector('#t-bg-solid').onclick = () => openSolidGen();
      window.Storage.getAllAssets('background')
        .then((assets) => { setLibCount(countEl, assets.length, '图片库'); renderBgCards(list, assets); })
        .catch(showError);
    } else if (activeLib === 'item') {
      tools.innerHTML = '<button class="btn" id="t-item"><svg class="ico" aria-hidden="true"><use href="#ic-box"/></svg> 导入3D物品包</button>';
      tools.querySelector('#t-item').onclick = () => $('#file-item').click();
      window.Storage.getAllAssets('item')
        .then((assets) => { setLibCount(countEl, assets.length, '物品库'); renderItemCards(list, assets); })
        .catch(showError);
    } else if (activeLib === 'overlay') {
      tools.innerHTML = '<button class="btn" id="t-overlay-img"><svg class="ico" aria-hidden="true"><use href="#ic-image"/></svg> 导入图片（推荐 PNG）</button>'
        + '<div class="lib-tools-row lib-hint">叠层会显示在背景之上、文字之下，适合放透明背景的角色 / 物件</div>';
      tools.querySelector('#t-overlay-img').onclick = () => $('#file-overlay').click();
      window.Storage.getAllAssets('overlay')
        .then((assets) => { setLibCount(countEl, assets.length, '叠层库'); renderOverlayCards(list, assets); })
        .catch(showError);
    } else if (activeLib === 'music') {
      tools.innerHTML = '<button class="btn" id="t-music"><svg class="ico" aria-hidden="true"><use href="#ic-music"/></svg> 导入音乐文件</button>';
      tools.querySelector('#t-music').onclick = () => { pendingAudioLib = 'music'; $('#file-audio').click(); };
      window.Storage.getAllAssets('music')
        .then((assets) => { setLibCount(countEl, assets.length, '音乐库'); renderAudioCards(list, 'music', assets, true); })
        .catch(showError);
    } else if (activeLib === 'sound') {
      tools.innerHTML = '<button class="btn" id="t-sound"><svg class="ico" aria-hidden="true"><use href="#ic-volume"/></svg> 导入音效文件</button>';
      tools.querySelector('#t-sound').onclick = () => { pendingAudioLib = 'sound'; $('#file-audio').click(); };
      window.Storage.getAllAssets('sound')
        .then((assets) => { setLibCount(countEl, assets.length, '音效库'); renderAudioCards(list, 'sound', assets); })
        .catch(showError);
    } else if (activeLib === 'dialogueblock') {
      tools.innerHTML = '<button class="btn" id="t-block-add">＋ 新建剧情块</button>'
        + '<button class="btn" id="t-block-graph" title="打开剧情分支节点图（自动编译当前剧情块的分支顺序）"><svg class="ico" aria-hidden="true"><use href="#ic-box"/></svg> 分支图</button>';
      tools.querySelector('#t-block-add').onclick = () => {
        const name = window.Storage.addBlock('新对话');
        switchBlock(name);
      };
      tools.querySelector('#t-block-graph').onclick = () => openBlockGraph();
      const names = window.Storage.listBlockNames();
      setLibCount(countEl, names.length, '剧情块库');
      renderDialogueBlocks(list);
    } else if (activeLib === 'variable') {
      tools.innerHTML = '<button class="btn" id="t-var-add"><svg class="ico" aria-hidden="true"><use href="#ic-plus"/></svg> 新建变量</button>'
        + '<div class="lib-tools-row lib-hint">正文用 {变量名} 读取、&lt;变量:名=值&gt; 赋值、&lt;当:条件&gt; 做条件分支</div>';
      tools.querySelector('#t-var-add').onclick = () => {
        const vars = window.Storage.getVars();
        vars.push({ name: '', type: 'number', value: 0 });
        window.Storage.saveVars(vars);
        renderVariableList(list);
        const first = list.querySelector('.var-name');
        if (first) first.focus();
      };
      const vars = window.Storage.getVars();
      setLibCount(countEl, vars.length, '变量库');
      renderVariableList(list);
    }

    libPanel.appendChild(tools);
    libPanel.appendChild(countEl);
    libPanel.appendChild(list);
  }

  // 变量库：集中定义变量（名字/类型/初值）。正文用 {名} 读取、<变量:名=值> 赋值。
  function renderVariableList(list) {
    const vars = window.Storage.getVars();
    if (!vars.length) {
      list.innerHTML = '<div class="empty-tip">还没有变量。<br>点上方「＋ 新建变量」，在变量库集中定义后，正文用 {变量名} 读取、&lt;变量:名=值&gt; 赋值。</div>';
      return;
    }
    list.innerHTML = '';
    // 表头：标识 名称 / 类型 / 值 三列（与 .var-row 列对齐）
    const header = document.createElement('div');
    header.className = 'var-row var-header';
    header.innerHTML =
      '<div class="var-th-handle"></div>' +
      '<div class="var-th var-th-name">名称</div>' +
      '<div class="var-th var-th-type">类型</div>' +
      '<div class="var-th var-th-val">值</div>' +
      '<div class="var-th-del"></div>';
    list.appendChild(header);
    vars.forEach((v, idx) => {
      const row = document.createElement('div'); row.className = 'var-row';
      const handle = document.createElement('div'); handle.className = 'var-handle'; handle.title = '拖到正文插入，或点击弹出语句菜单'; handle.textContent = '⠿'; handle.draggable = true;
      handle.addEventListener('dragstart', (e) => {
        if (!v.name) { e.preventDefault(); return; }
        e.dataTransfer.setData('application/x-variable', JSON.stringify({ name: v.name, type: v.type }));
        e.dataTransfer.effectAllowed = 'copy';
        handle.classList.add('dragging');
      });
      handle.addEventListener('dragend', () => handle.classList.remove('dragging'));
      handle.addEventListener('click', () => {
        if (!v.name) return;
        const wasRO = storyText.readOnly; storyText.readOnly = false;
        const ph = (v.type === 'boolean') ? '{' + v.name + ':是|否}' : '{' + v.name + '}';
        insertAtCursor(ph);
        const pos = storyText.selectionStart;
        const at = pos - ph.length;
        openVarPopover(v.name, v.type, { start: at, end: pos }, isOptionLineAt(at) ? lineCtxAt(at) : null);
        storyText.readOnly = wasRO;
      });
      const name = document.createElement('input'); name.className = 'var-name'; name.value = v.name; name.placeholder = '变量名';
      name.onchange = () => { vars[idx].name = name.value.trim(); window.Storage.saveVars(vars); refreshTodo(); };
      const type = document.createElement('select'); type.className = 'var-type';
      [['number', '数字'], ['text', '文本'], ['boolean', '布尔']].forEach(([val, lab]) => {
        const o = document.createElement('option'); o.value = val; o.textContent = lab; if (v.type === val) o.selected = true; type.appendChild(o);
      });
      type.onchange = () => {
        v.type = type.value;
        if (v.type === 'boolean') v.value = (v.value === true || v.value === 'true');
        else if (v.type === 'number') v.value = Number(v.value) || 0;
        window.Storage.saveVars(vars); renderVariableList(list);
      };
      const valWrap = document.createElement('div'); valWrap.className = 'var-val';
      function renderVal() {
        valWrap.innerHTML = '';
        if (v.type === 'boolean') {
          const s = document.createElement('select'); s.className = 'var-value';
          [['true', '真'], ['false', '假']].forEach(([val, lab]) => {
            const o = document.createElement('option'); o.value = val; o.textContent = lab; if (String(v.value) === val) o.selected = true; s.appendChild(o);
          });
          s.onchange = () => { v.value = (s.value === 'true'); window.Storage.saveVars(vars); refreshTodo(); };
          valWrap.appendChild(s);
        } else {
          const inp = document.createElement('input'); inp.className = 'var-value';
          inp.type = (v.type === 'number') ? 'number' : 'text';
          inp.value = (v.value == null ? '' : v.value);
          inp.onchange = () => { v.value = (v.type === 'number') ? Number(inp.value) : inp.value; window.Storage.saveVars(vars); refreshTodo(); };
          valWrap.appendChild(inp);
        }
      }
      renderVal();
      const del = document.createElement('button'); del.className = 'var-del'; del.title = '删除变量'; del.type = 'button';
      del.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#ic-trash"/></svg>';
      del.onclick = () => { vars.splice(idx, 1); window.Storage.saveVars(vars); renderVariableList(list); refreshTodo(); };
      row.appendChild(handle); row.appendChild(name); row.appendChild(type); row.appendChild(valWrap); row.appendChild(del);
      list.appendChild(row);
    });
  }

  // ============ 清理未使用素材 ============
  // 把所有剧情块（含主剧情与所有子剧情块）文本收齐，便于统一扫描被召唤的素材名。
  function collectAllStoryText() {
    const out = [];
    const names = window.Storage.listBlockNames(); // 含 MAIN_BLOCK
    for (const nm of names) {
      // 当前正在编辑的块以 textarea 实时内容为准（可能尚未提交到存储）
      out.push(nm === activeBlock ? (storyText.value || '') : (window.Storage.getBlockText(nm) || ''));
    }
    return out.join('\n');
  }
  // 扫描「剧情 + 所有子剧情块」以及开场设置，删除未被召唤的素材（背景/物品/音乐/音效）。
  function cleanUnusedAssets() {
    // 第一次警告：说明范围与不可逆
    const ok1 = window.confirm(
      '清理未使用素材\n\n'
      + '将扫描全部剧情（含所有子剧情块）以及开场背景/音乐设置，\n'
      + '删除其中「完全没有用到的素材」（背景 / 物品 / 音乐 / 音效）。\n\n'
      + '此操作不可撤销，确定继续吗？'
    );
    if (!ok1) return;

    // 统计被使用的素材名称（按库）
    const used = { background: new Set(), item: new Set(), overlay: new Set(), music: new Set(), sound: new Set() };
    const allText = collectAllStoryText();
    const libMap = { '背景': 'background', '物品': 'item', '叠层': 'overlay', '音乐': 'music', '音效': 'sound' };
    allText.split('\n').forEach((line) => {
      const m = line.match(RE_SUMMON);
      if (!m) return;
      const lib = libMap[m[1]];
      if (!lib) return;
      let name = m[2];
      if (lib === 'item') name = name.split(',')[0]; // 物品支持 name,"提示文字" 格式
      name = (name || '').trim();
      if (name) used[lib].add(name);
    });
    // 开场设置也按名称引用素材
    if (globalSettings.openingBg) used.background.add(globalSettings.openingBg.trim());
    if (globalSettings.openingMusic) used.music.add(globalSettings.openingMusic.trim());

    // 找出每个库里未使用的素材
    const libs = ['background', 'item', 'overlay', 'music', 'sound'];
    const libLabel = { background: '背景库', item: '3D库', overlay: '叠层库', music: '音乐库', sound: '音效库' };
    const toDelete = []; // { lib, id, name }
    (async () => {
      for (const lib of libs) {
        const assets = await window.Storage.getAllAssets(lib);
        for (const a of assets) {
          if (!used[lib].has(a.name)) toDelete.push({ lib, id: a.id, name: a.name });
        }
      }
      if (!toDelete.length) {
        window.confirm('没有发现未使用的素材，素材库很干净。\n\n（若刚删除了正文里的召唤指令，请先保存或切换一下剧情块，再点清理。）');
        return;
      }
      // 第二次警告：列出数量与清单，再次确认
      const byLib = {};
      toDelete.forEach(d => { (byLib[d.lib] = byLib[d.lib] || []).push(d.name); });
      let summary = '';
      for (const lib of libs) {
        if (byLib[lib] && byLib[lib].length) {
          summary += '\n· ' + libLabel[lib] + '（' + byLib[lib].length + '）：' + byLib[lib].join('、');
        }
      }
      const ok2 = window.confirm(
        '即将清理 ' + toDelete.length + ' 个未使用素材：' + summary + '\n\n'
        + '再次确认？删除后将无法恢复。'
      );
      if (!ok2) return;

      let done = 0;
      for (const d of toDelete) {
        try { await window.Storage.deleteAsset(d.lib, d.id); done++; } catch (e) { console.error('删除素材失败', d, e); }
      }
      renderLibrary();
      if (typeof refreshTodo === 'function') refreshTodo();
      toast('已清理 ' + done + ' 个未使用素材');
    })();
  }

  // ============ 剧情块库（仓库）============
  function displayBlockName(name) { return name === MAIN_BLOCK ? '主剧情' : name; }
  function updateBlockChip() {
    const chip = document.getElementById('current-block-chip');
    if (chip) chip.innerHTML = (activeBlock === MAIN_BLOCK ? '<svg class="ico" aria-hidden="true"><use href="#ic-lock"/></svg> 主剧情' : '<svg class="ico" aria-hidden="true"><use href="#ic-box"/></svg> ' + escapeHtml(activeBlock));
  }
  function renderDialogueBlocks(list) {
    list.innerHTML = '';
    const names = window.Storage.listBlockNames();
    if (!names.length) { list.innerHTML = '<div class="empty-tip">还没有剧情块<br>点上方「＋ 新建剧情块」</div>'; return; }
    names.forEach((name) => {
      const isMain = name === MAIN_BLOCK;
      const card = document.createElement('div');
      card.className = 'asset-card block-card' + (isMain ? ' block-main' : '') + (name === activeBlock ? ' block-active' : '');
      card.dataset.kind = 'block';
      card.dataset.blockName = name;
      card.draggable = true;
      const meta = document.createElement('div'); meta.className = 'asset-meta';
      const nm = document.createElement('div'); nm.className = 'asset-name';
      nm.innerHTML = (isMain ? '<svg class="ico" aria-hidden="true"><use href="#ic-lock"/></svg> 主剧情' : '<svg class="ico" aria-hidden="true"><use href="#ic-box"/></svg> ' + escapeHtml(name));
      meta.appendChild(nm);
      const sub = document.createElement('div'); sub.className = 'asset-sub';
      const txt = window.Storage.getBlockText(name) || '';
      const lines = txt.split('\n').filter(l => l.trim() && !l.trim().startsWith('//')).length;
      sub.textContent = (isMain ? '游戏默认从这里开始 · ' : '') + lines + ' 行';
      meta.appendChild(sub);
      card.appendChild(meta);
      // 操作：插入「跳转」指令（光标处）
      const jump = document.createElement('button'); jump.className = 'asset-jump'; jump.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#ic-corner-up-left"/></svg> 跳转'; jump.title = '在光标处插入 <剧情块:名称>';
      jump.addEventListener('click', (e) => { e.stopPropagation(); insertBlockJump(name); });
      card.appendChild(jump);
      if (!isMain) {
        const ren = document.createElement('button'); ren.className = 'asset-ren'; ren.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#ic-pencil"/></svg>'; ren.title = '重命名（自动更新所有引用）';
        ren.addEventListener('click', (e) => { e.stopPropagation(); handleRenameBlock(name); });
        card.appendChild(ren);
        const del = document.createElement('button'); del.className = 'asset-del'; del.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#ic-trash"/></svg>'; del.title = '删除';
        del.addEventListener('click', (e) => { e.stopPropagation(); handleDeleteBlock(name); });
        card.appendChild(del);
      }
      // 点击卡片 = 切换到该块编辑
      card.addEventListener('click', () => switchBlock(name));
      // 拖拽 = 在光标处插入「选项」指令（文字可被直接编辑）
      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('application/x-block', JSON.stringify({ name: name }));
        e.dataTransfer.effectAllowed = 'copy';
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));
      list.appendChild(card);
    });
    refreshTodo();   // 素材库每次渲染（即素材发生变动）后，自动刷新右上角待办
  }
  // ============ 剧情分支节点图（浮动窗口）============
  let _graphPanel = null;
  function ensureGraphPanel() {
    if (_graphPanel) return _graphPanel;
    const panel = document.createElement('div');
    panel.id = 'block-graph-panel';
    panel.className = 'hidden';
    panel.innerHTML =
      '<div class="bgp-head">' +
        '<div class="bgp-title"><svg class="ico" aria-hidden="true"><use href="#ic-box"/></svg> 剧情分支图</div>' +
        '<div class="bgp-actions">' +
          '<button id="bgp-refresh" class="bgp-refresh" title="重新编译剧情块、刷新节点"><svg class="ico" aria-hidden="true"><use href="#ic-refresh"/></svg> 刷新</button>' +
          '<button id="bgp-close" class="bgp-close" title="关闭">✕</button>' +
        '</div>' +
      '</div>' +
      '<div class="bgp-body"><div class="bgp-canvas" id="bgp-canvas">' +
        '<svg id="bgp-edges" class="bgp-edges" xmlns="http://www.w3.org/2000/svg"></svg>' +
        '<div id="bgp-nodes" class="bgp-nodes"></div>' +
      '</div></div>' +
      '<div class="bgp-foot"><span class="bgp-hint">点击节点跳转到该剧情块 · 点击连线上的选项标签定位到对应选项行 · ESC 关闭</span></div>';
    document.body.appendChild(panel);
    panel.querySelector('#bgp-close').addEventListener('click', closeGraph);
    panel.querySelector('#bgp-refresh').addEventListener('click', renderBlockGraph);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && _graphPanel && !_graphPanel.classList.contains('hidden')) closeGraph();
    });
    _graphPanel = panel;
    return panel;
  }
  function closeGraph() { if (_graphPanel) _graphPanel.classList.add('hidden'); }
  function openBlockGraph() { ensureGraphPanel(); _graphPanel.classList.remove('hidden'); renderBlockGraph(); }

  // 估算标签像素宽度（CJK ≈13px，ASCII ≈7px）
  function _labelWidth(s) {
    let w = 0;
    for (const ch of (s || '')) w += (ch.charCodeAt(0) > 255 ? 13 : 7);
    return Math.ceil(w) + 18;
  }

  function renderBlockGraph() {
    const panel = ensureGraphPanel();
    const canvas = panel.querySelector('#bgp-canvas');
    const nodesEl = panel.querySelector('#bgp-nodes');
    const edgesSvg = panel.querySelector('#bgp-edges');
    const names = window.Storage.listBlockNames();
    if (!names.length) {
      canvas.style.width = canvas.style.height = '100%';
      nodesEl.innerHTML = '<div style="padding:40px;color:var(--text-3)">还没有剧情块。</div>';
      edgesSvg.innerHTML = '';
      return;
    }
    const NODE_W = 172, NODE_H = 58, GAP_X = 92, GAP_Y = 26;
    // 1) 编译所有边（选项 + 剧情块跳转），记录选项在原文的绝对字符偏移
    const edges = [];
    names.forEach((name) => {
      const raw = window.Storage.getBlockText(name) || '';
      RE_OPTION.lastIndex = 0;
      let om;
      while ((om = RE_OPTION.exec(raw)) !== null) {
        const target = (om[2] && om[2].trim()) || null;
        edges.push({ from: name, to: target, label: om[1] || '选项', charIndex: om.index, kind: 'option' });
      }
      const lines = raw.split(/\r?\n/);
      lines.forEach((line) => {
        const bm = line.trim().match(RE_BLOCK);
        if (bm) {
          const target = bm[1].trim();
          edges.push({ from: name, to: target, label: '进入剧情块', charIndex: raw.indexOf(line), kind: 'block' });
        }
      });
    });
    // 2) 自「主剧情」做 BFS 分层；不可达块放到最右侧
    const adj = {};
    names.forEach((n) => { adj[n] = []; });
    edges.forEach((e) => { if (e.to && names.includes(e.to)) adj[e.from].push(e.to); });
    const layer = {};
    if (names.includes(MAIN_BLOCK)) {
      layer[MAIN_BLOCK] = 0;
      const q = [MAIN_BLOCK];
      while (q.length) {
        const c = q.shift();
        (adj[c] || []).forEach((t) => { if (layer[t] === undefined) { layer[t] = layer[c] + 1; q.push(t); } });
      }
    }
    let maxL = 0;
    Object.values(layer).forEach((v) => { if (v > maxL) maxL = v; });
    names.forEach((n) => { if (layer[n] === undefined) layer[n] = maxL + 1; });
    // 3) 按层分配坐标
    const byLayer = {};
    names.forEach((n) => { (byLayer[layer[n]] = byLayer[layer[n]] || []).push(n); });
    const pos = {};
    Object.keys(byLayer).map(Number).sort((a, b) => a - b).forEach((L) => {
      byLayer[L].forEach((n, i) => { pos[n] = { x: L * (NODE_W + GAP_X) + 24, y: i * (NODE_H + GAP_Y) + 24 }; });
    });
    let maxX = 0, maxY = 0;
    names.forEach((n) => { if (pos[n].x > maxX) maxX = pos[n].x; if (pos[n].y > maxY) maxY = pos[n].y; });
    const W = maxX + NODE_W + 40, H = maxY + NODE_H + 40;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    edgesSvg.setAttribute('width', W); edgesSvg.setAttribute('height', H);
    edgesSvg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    // 4) 渲染节点
    nodesEl.innerHTML = '';
    names.forEach((name) => {
      const p = pos[name];
      const isMain = name === MAIN_BLOCK;
      const node = document.createElement('div');
      node.className = 'bgp-node' + (isMain ? ' bgp-node-main' : '');
      node.style.left = p.x + 'px'; node.style.top = p.y + 'px';
      node.style.width = NODE_W + 'px'; node.style.height = NODE_H + 'px';
      node.innerHTML = '<div class="bgp-node-name">' + (isMain ? '主剧情' : escapeHtml(name)) + '</div>';
      node.title = isMain ? '主剧情（默认起点）' : name;
      node.addEventListener('click', () => { window.StoryEditorApi.setActiveBlock(name); closeGraph(); });
      nodesEl.appendChild(node);
    });
    // 5) 渲染连线（带箭头 marker）；平行边错开避免重叠
    const pairCount = {};
    edges.forEach((e) => { if (e.to && names.includes(e.to)) { const k = e.from + '\u0001' + e.to; pairCount[k] = (pairCount[k] || 0) + 1; } });
    const pairIdx = {};
    let svg = '<defs>' +
      '<marker id="bgp-arrow-opt" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L7,3 L0,6 Z" fill="var(--violet)"/></marker>' +
      '<marker id="bgp-arrow-block" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L7,3 L0,6 Z" fill="var(--amber)"/></marker>' +
      '</defs>';
    edges.forEach((e) => {
      if (!e.to || !names.includes(e.to)) return; // 无目标的选项仅推进，不画连线
      const a = pos[e.from], b = pos[e.to];
      const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2;
      const x2 = b.x, y2 = b.y + NODE_H / 2;
      const k = e.from + '\u0001' + e.to;
      const idx = (pairIdx[k] = (pairIdx[k] || 0));
      pairIdx[k]++;
      const total = pairCount[k];
      const off = (idx - (total - 1) / 2) * 40;
      const mx = (x1 + x2) / 2;
      const c1x = mx, c1y = y1 + off, c2x = mx, c2y = y2 + off;
      const isOpt = e.kind === 'option';
      const stroke = isOpt ? 'var(--violet)' : 'var(--amber)';
      const marker = isOpt ? 'url(#bgp-arrow-opt)' : 'url(#bgp-arrow-block)';
      svg += '<path d="M' + x1 + ',' + y1 + ' C' + c1x + ',' + c1y + ' ' + c2x + ',' + c2y + ' ' + x2 + ',' + y2 +
        '" fill="none" stroke="' + stroke + '" stroke-width="2" marker-end="' + marker + '" opacity="0.9"/>';
      const lw = _labelWidth(e.label);
      const lx = mx, ly = (y1 + y2) / 2 + off;
      const fromAttr = encodeURIComponent(e.from);
      svg += '<g class="bgp-edge-label" data-from="' + fromAttr + '" data-char="' + e.charIndex + '" data-kind="' + e.kind + '">' +
        '<rect x="' + (lx - lw / 2) + '" y="' + (ly - 11) + '" width="' + lw + '" height="20" rx="9" class="bgp-edge-rect ' + e.kind + '"/>' +
        '<text x="' + lx + '" y="' + (ly + 4) + '" text-anchor="middle" class="bgp-edge-text">' + escapeHtml(e.label) + '</text></g>';
    });
    edgesSvg.innerHTML = svg;
    edgesSvg.querySelectorAll('.bgp-edge-label').forEach((g) => {
      g.addEventListener('click', () => {
        const from = decodeURIComponent(g.getAttribute('data-from'));
        const charIndex = parseInt(g.getAttribute('data-char'), 10);
        window.StoryEditorApi.setActiveBlock(from);
        const ta = document.getElementById('story-text');
        if (ta) {
          const p = Math.max(0, Math.min(charIndex, ta.value.length));
          ta.focus();
          ta.setSelectionRange(p, p + 1);
        }
        closeGraph();
      });
    });
  }

  // 切换到某个剧情块编辑（先提交当前块文本）
  function switchBlock(name) {
    if (name === activeBlock) { renderLibrary(); updateBlockChip(); return; }
    window.Storage.setBlockText(activeBlock, storyText.value);
    activeBlock = name;
    text = window.Storage.getBlockText(name) || '';
    storyText.value = text;
    updateWordCount();
    refreshClueHint();
    history = []; histIndex = -1;
    pushHistory();
    updateBlockChip();
    updateUndoButtons();
    renderLibrary();
    refreshTodo();
    refreshBlockReviewLine();
    renderReviewPanel();
    refreshReviewToggleBadge();
  }
  // 在光标处插入「进入剧情块」指令
  function insertBlockJump(name) { insertAtCursor('<剧情块:' + name + '>'); }
  // 在光标处（或指定字符偏移）插入「选项」指令，并把光标选中占位文字「文字」，方便直接覆盖
  function insertBlockOption(name, offset) {
    const ta = storyText; const st = ta.scrollTop;
    if (offset == null) offset = ta.selectionStart;
    offset = Math.max(0, Math.min(offset, ta.value.length));
    const before = ta.value.slice(0, offset);
    const after = ta.value.slice(offset);
    // 拖剧情块 = 在当前光标处插入选项指令，不自动换行（选项支持单行多指令，如 <选项:"A",块A><选项:"B",块B>）
    const padBefore = '';
    const placeholder = '文字';
    const insertStr = '<选项:"' + placeholder + '",' + name + '>';
    const fullInsert = padBefore + insertStr;
    ta.value = before + fullInsert + after;
    const selStart = (before + fullInsert).length - insertStr.length + '<选项:"'.length;
    const selEnd = selStart + placeholder.length;
    ta.setSelectionRange(selStart, selEnd);
    // 拖拽插入时文本框未聚焦，不主动抢焦点，避免唤起软键盘 / 中文输入法候选条
    if (document.activeElement === ta) ta.focus();
    ta.scrollTop = st;
    commitEdit();
  }
  // 添加选项按钮：把光标移到本行末尾，再在行尾追加 <选项:"">（不换行）
  // 光标落在两个引号之间等待输入文字（仅写文字 = 仅推进；后接 ,块名 = 分支跳转）
  function insertOptionEmpty() {
    const ta = storyText; const st = ta.scrollTop;
    const s = ta.selectionStart;
    const val = ta.value;
    // 找到光标所在行的行尾（下一个 \n 之前；若其后无换行则到文本末尾）
    let lineEnd = val.indexOf('\n', s);
    if (lineEnd === -1) lineEnd = val.length;
    const before = val.slice(0, lineEnd);
    const after = val.slice(lineEnd);
    const insertStr = '<选项:"">';
    ta.value = before + insertStr + after;
    // 光标落在引号内：<选项:" 共 5 个字符，插在 before 之后
    const caret = before.length + '<选项:"'.length;
    ta.setSelectionRange(caret, caret);
    ta.focus(); ta.scrollTop = st;
    commitEdit();
  }
  async function handleRenameBlock(name) {
    const disp = name === MAIN_BLOCK ? '主剧情' : name;
    const input = prompt('重命名剧情块「' + disp + '」', name === MAIN_BLOCK ? '主剧情' : name);
    if (input == null) return;
    const newName = input.trim();
    if (!newName || newName === name) return;
    const finalName = window.Storage.renameBlock(name, newName);
    if (activeBlock === name) activeBlock = finalName;
    text = window.Storage.getBlockText(activeBlock) || '';
    storyText.value = text;
    updateWordCount();
    updateBlockChip();
    renderLibrary();
    refreshTodo();
    toast('已重命名剧情块');
  }
  async function handleDeleteBlock(name) {
    if (!confirm('确定删除剧情块「' + name + '」？\n注意：其它块里指向它的 <剧情块:名称> / <选项:...,名称> 会变成无效引用。')) return;
    window.Storage.deleteBlock(name);
    if (activeBlock === name) {
      activeBlock = MAIN_BLOCK;
      text = window.Storage.getBlockText(MAIN_BLOCK) || '';
      storyText.value = text;
      updateWordCount();
    }
    updateBlockChip();
    renderLibrary();
    refreshTodo();
    toast('已删除剧情块「' + name + '」');
  }

  function renderBgCards(list, assets) {
    if (!assets.length) { list.innerHTML = '<div class="empty-tip">还没有背景<br>导入图片，或用渐变/噪波/纯色生成器</div>'; return; }
    assets.forEach(a => {
      const card = makeCard({ kind: 'background', id: a.id, name: a.name, derived: a.derived, src: a.src, original: a.original });
      if (a.kind === 'solid') {
        card.dataset.solid = '1';
        if (a.color) card.dataset.color = a.color;
        const sw = document.createElement('div');
        sw.className = 'asset-thumb solid-swatch';
        sw.style.background = a.color || '#000000';
        sw.title = '纯色背景：' + (a.color || '#000000');
        sw.addEventListener('click', function(e){ e.stopPropagation(); openBgPreview(a.color || '#000000', a.name, true); });
        card.insertBefore(sw, card.querySelector('.asset-meta'));
      } else {
        const thumb = document.createElement('img');
        thumb.className = 'asset-thumb'; thumb.src = a.src; thumb.draggable = false;
        thumb.addEventListener('click', function(e){ e.stopPropagation(); openBgPreview(a.src, a.name, false); });
        card.insertBefore(thumb, card.querySelector('.asset-meta'));
      }
      list.appendChild(card);
    });
  }
  // 叠层库：图片形式，召唤后显示在背景之上、文字之下（适合透明 PNG 角色 / 物件）。
  // 复用图片卡片渲染；kind='overlay' 使拖拽 / 点按自动生成 <召唤叠层:名称>。
  function renderOverlayCards(list, assets) {
    // 顶部固定「清除叠层」功能块（非真实素材，点击 / 拖入即产生 <清除叠层> 指令）
    const stop = document.createElement('div');
    stop.className = 'asset-card stop-music-card';
    stop.draggable = true;
    stop.innerHTML = '<div class="asset-meta"><div class="asset-name"><svg class="ico" aria-hidden="true"><use href="#ic-stop"/></svg> 清除叠层</div>'
      + '<div class="asset-sub">插入 &lt;清除叠层&gt; 指令（移除当前叠层角色，回到纯背景）</div></div>';
    stop.addEventListener('click', () => insertAtCursor('<清除叠层>'));
    stop.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-asset', JSON.stringify({ kind: 'clearoverlay', name: '__CLEAR__' }));
      e.dataTransfer.effectAllowed = 'copy';
      stop.classList.add('dragging');
    });
    stop.addEventListener('dragend', () => stop.classList.remove('dragging'));
    list.appendChild(stop);

    if (!assets.length) {
      const tip = document.createElement('div');
      tip.className = 'empty-tip';
      tip.innerHTML = '还没有叠层<br>导入 PNG（推荐透明背景的角色 / 物件），召唤后显示在背景之上、文字之下';
      list.appendChild(tip);
      return;
    }
    assets.forEach(a => {
      const card = makeCard({ kind: 'overlay', id: a.id, name: a.name, derived: a.derived, src: a.src, original: a.original });
      const thumb = document.createElement('img');
      thumb.className = 'asset-thumb'; thumb.src = a.src; thumb.draggable = false;
      thumb.addEventListener('click', function(e){ e.stopPropagation(); openBgPreview(a.src, a.name, false); });
      card.insertBefore(thumb, card.querySelector('.asset-meta'));
      list.appendChild(card);
    });
  }
  // —— 背景大图预览（点缩略图打开，点遮罩/叉叉/Esc 关闭）——
  function openBgPreview(src, name, isSolid) {
    const lb = $('#bg-lightbox'); if (!lb) return;
    const img = $('#bg-lightbox-img'), sw = $('#bg-lightbox-swatch'), nm = $('#bg-lightbox-name');
    if (isSolid) {
      img.style.display = 'none';
      sw.style.display = 'block';
      sw.style.background = src || '#000000';
      nm.textContent = (name || '纯色背景') + '  ·  ' + (src || '');
    } else {
      sw.style.display = 'none';
      img.style.display = 'block';
      img.src = src || '';
      nm.textContent = name || '';
    }
    lb.classList.remove('hidden');
  }
  function closeBgPreview() {
    const lb = $('#bg-lightbox'); if (lb) lb.classList.add('hidden');
  }
  function bindBgLightbox() {
    const lb = $('#bg-lightbox'); if (!lb) return;
    // 点遮罩（图片外区域）→ 关闭
    lb.addEventListener('click', function(e){ if (e.target === lb) closeBgPreview(); });
    // 叉叉 → 关闭（阻止冒泡，避免与遮罩关闭逻辑重复）
    $('#bg-lightbox-close').addEventListener('click', function(e){ e.stopPropagation(); closeBgPreview(); });
    // 点图片/色块本身 → 不关闭
    $('#bg-lightbox-img').addEventListener('click', function(e){ e.stopPropagation(); });
    $('#bg-lightbox-swatch').addEventListener('click', function(e){ e.stopPropagation(); });
    // Esc 关闭
    document.addEventListener('keydown', function(e){
      if (e.key === 'Escape' && !lb.classList.contains('hidden')) closeBgPreview();
    });
  }

  function applyEditorFont() {
    let style = document.getElementById('custom-font-style');
    const fallback = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif";
    if (globalSettings.font && globalSettings.font.src) {
      if (!style) { style = document.createElement('style'); style.id = 'custom-font-style'; document.head.appendChild(style); }
      style.textContent = "@font-face{font-family:'StoryCustomFont';src:url('" + globalSettings.font.src + "');font-display:swap;}";
      storyText.style.fontFamily = "'StoryCustomFont', " + fallback;
    } else {
      if (style) style.remove();
      storyText.style.fontFamily = fallback;
    }
  }
  // 通用设置：渲染进设置抽屉的「通用」子项（#settings-general）
  function renderSettingsGeneral() {
    const box = $('#settings-general');
    if (!box) return;
    const wm = globalSettings.watermark;
    box.innerHTML =
      '<div class="global-section">' +
        '<h4><svg class="ico" aria-hidden="true"><use href="#ic-play-circle"/></svg> 游戏信息</h4>' +
        '<div class="field"><label>游戏名</label><input type="text" id="gs-name" value="' + escapeHtml(globalSettings.gameName) + '" placeholder="留空则不显示标题"></div>' +
        '<div class="field"><label>副标题</label><input type="text" id="gs-subtitle" value="' + escapeHtml(globalSettings.subtitle) + '" placeholder="显示在游戏名下方（灰色小字，可选）"></div>' +
        '<div class="field"><label>作者ID</label><input type="text" id="gs-author-id" value="' + escapeHtml(globalSettings.authorId) + '" placeholder="完结界面展示的作者标识"></div>' +
        '<div class="field"><label>图标</label>' +
          '<select id="gs-icon"><option value="">（使用默认图标）</option></select>' +
          (globalSettings.icon ? (String(globalSettings.icon).indexOf('data:') === 0 ? ' <span style="font-size:12px;color:#8b96a8">（旧版上传图，仍生效）</span>' : ' <span style="font-size:12px;color:#88c0ff">已选择：' + escapeHtml(globalSettings.icon) + '</span>') : ' <span style="font-size:12px;color:#8b96a8">（从图片库中选取；留空=默认图标）</span>') + '</div>' +
          (globalSettings.icon && String(globalSettings.icon).indexOf('data:') === 0 ? '<div class="field"><img id="gs-icon-preview" src="' + globalSettings.icon + '" style="max-width:64px;max-height:64px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);object-fit:cover"></div>' : '') +
        '<h4 style="margin-top:14px"><svg class="ico" aria-hidden="true"><use href="#ic-play-circle"/></svg> 游玩模式</h4>' +
        '<div class="ai-hint">长文模式：文字像长卷一样不断累积、整屏滚动阅读（当前默认）。galgame模式：文字每次只显示一段（到下一个「停顿」为止），固定在画面底部对齐的黑色文本框内，背景不加明暗蒙版、完整呈现原图——适合配合背景图与叠层角色。两种模式都可在游戏顶部菜单点「历史」回看已读文本。</div>' +
        '<div class="field"><label>游玩模式</label><select id="gs-playmode">' +
          [['longform','长文模式（文字累积滚动，默认）'],['galgame','galgame模式（底部文本框，逐段显示）']].map(function(o){ return '<option value="' + o[0] + '"' + (globalSettings.playMode === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
        '</select></div>' +
        '<h4 style="margin-top:14px"><svg class="ico" aria-hidden="true"><use href="#ic-image"/></svg> 开场背景</h4>' +
        '<div class="field"><label>开场背景图案</label>' +
          '<select id="gs-opening"><option value="">（使用默认深色开场）</option></select>' +
          (globalSettings.openingBg ? (String(globalSettings.openingBg).indexOf('data:') === 0 ? ' <span style="font-size:12px;color:#8b96a8">（旧版上传图，仍生效）</span>' : ' <span style="font-size:12px;color:#88c0ff">已选择：' + escapeHtml(globalSettings.openingBg) + '</span>') : ' <span style="font-size:12px;color:#8b96a8">（从素材库的背景中选取；留空=默认深色开场）</span>') + '</div>' +
        (globalSettings.openingBg && String(globalSettings.openingBg).indexOf('data:') === 0 ? '<div class="field"><img id="gs-opening-preview" src="' + globalSettings.openingBg + '" style="max-width:140px;max-height:80px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);object-fit:cover"></div>' : '') +
        '<h4 style="margin-top:14px"><svg class="ico" aria-hidden="true"><use href="#ic-music"/></svg> 开场音乐</h4>' +
        '<div class="field"><label>开场标题界面音乐</label>' +
          '<select id="gs-opening-music"><option value="">（不使用开场音乐）</option></select>' +
          (globalSettings.openingMusic ? ' <span style="font-size:12px;color:#88c0ff">已选择：' + escapeHtml(globalSettings.openingMusic) + '</span>' : ' <span style="font-size:12px;color:#8b96a8">（从素材库的音乐中选取；留空=无开场音乐）</span>') +
        '</div>' +
        '<h4 style="margin-top:14px"><svg class="ico" aria-hidden="true"><use href="#ic-type"/></svg> 字体设置</h4>' +
        '<div class="field"><label>自定义字体</label><input type="file" id="gs-font" accept=".ttf,.otf,.woff,.woff2">' +
          (globalSettings.font ? ' <span style="font-size:12px;color:#88c0ff">已设置：' + escapeHtml(globalSettings.font.name) + '</span>' : ' <span style="font-size:12px;color:#8b96a8">（留空=系统默认字体）</span>') + '</div>' +
        (globalSettings.font ? '<div class="field"><button type="button" id="gs-font-remove" style="padding:5px 14px;border-radius:8px;border:1px solid rgba(255,255,255,0.18);background:rgba(255,255,255,0.08);color:#fff;cursor:pointer">移除字体</button></div>' : '') +
        '<h4 style="margin-top:14px"><svg class="ico" aria-hidden="true"><use href="#ic-lock"/></svg> 水印设置</h4>' +
        '<div class="field"><label>文字</label><input type="text" id="wm-text" value="' + escapeHtml(wm.text) + '" placeholder="水印文字（留空=不显示）"></div>' +
        '<div class="field"><label>位置</label><select id="wm-pos">' +
          ['左上','右上','左下','右下'].map(p => '<option value="' + p + '"' + (wm.pos===p?' selected':'') + '>' + p + '</option>').join('') +
        '</select></div>' +
        '<div class="field"><label>不透明度</label><input type="range" id="wm-opacity" min="10" max="100" value="' + (wm.opacity || 40) + '"><span id="wm-op-val" style="font-size:12px;color:#9aa3b2;min-width:30px">' + (wm.opacity || 40) + '%</span></div>' +
        '<h4 style="margin-top:14px"><svg class="ico" aria-hidden="true"><use href="#ic-type"/></svg> 文字对比度保护</h4>' +
        '<div class="ai-hint">背景图偏亮/偏暗或与文字色接近时，自动按背景平均亮度选黑字/白字，并对整张背景做亮度调整（亮背景更亮、暗背景更暗）把对比度拉到清晰可读——不再给文字加底板（避免跳闪）。游戏中长按画面 1 秒可隐藏文字、欣赏背景原图。<b>仅在长文模式下生效</b>：galgame模式自带黑色文本框，不会给背景加蒙版。</div>' +
        '<div class="field"><label>保护强度</label><select id="gs-textcontrast">' +
          [['off','关（保持原样）'],['auto','自动（选字色 + 调亮暗背景，默认）']].map(function(o){ return '<option value="' + o[0] + '"' + (globalSettings.textContrast === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
        '</select></div>' +
      '</div>';
    box.querySelector('#gs-name').addEventListener('input', function() { globalSettings.gameName = this.value; saveGlobal(); });
    box.querySelector('#gs-subtitle').addEventListener('input', function() { globalSettings.subtitle = this.value; saveGlobal(); });
    box.querySelector('#gs-author-id').addEventListener('input', function() { globalSettings.authorId = this.value; saveGlobal(); });
    // 图标：从图片库(background)中选取（存名称，导出时按名称解析 src）
    const icSel = box.querySelector('#gs-icon');
    if (icSel) {
      window.Storage.getAllAssets('background').then(function(list) {
        const opts = ['<option value="">（使用默认图标）</option>'];
        (list || []).forEach(function(a) {
          if (a && a.name) opts.push('<option value="' + escapeHtml(a.name) + '"' + (globalSettings.icon === a.name ? ' selected' : '') + '>' + escapeHtml(a.name) + '</option>');
        });
        icSel.innerHTML = opts.join('');
      }).catch(function() {});
      icSel.addEventListener('change', function() {
        globalSettings.icon = this.value;
        saveGlobal();
        if (this.value) { toast('图标已设为：' + this.value); renderSettingsGeneral(); }
        else { toast('已使用默认图标'); renderSettingsGeneral(); }
      });
    }
    box.querySelector('#gs-font').addEventListener('change', function(e) {
      const f = e.target.files[0];
      if (!f) return;
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      if (!['ttf','otf','woff','woff2'].includes(ext)) { toast('请选择 TTF/OTF/WOFF/WOFF2 字体文件'); e.target.value = ''; return; }
      const reader = new FileReader();
      reader.onload = function() {
        globalSettings.font = { name: f.name, src: reader.result, ext: ext };
        saveGlobal(); applyEditorFont(); toast('字体已上传'); renderSettingsGeneral();
      };
      reader.readAsDataURL(f);
    });
    if (globalSettings.font) {
      box.querySelector('#gs-font-remove').addEventListener('click', function() {
        globalSettings.font = null; saveGlobal(); applyEditorFont(); toast('已移除字体'); renderSettingsGeneral();
      });
    }
    box.querySelector('#wm-text').addEventListener('input', function() { globalSettings.watermark.text = this.value; saveGlobal(); });
    box.querySelector('#wm-pos').addEventListener('change', function() { globalSettings.watermark.pos = this.value; saveGlobal(); });
    box.querySelector('#wm-opacity').addEventListener('input', function() { globalSettings.watermark.opacity = parseInt(this.value); box.querySelector('#wm-op-val').textContent = this.value + '%'; saveGlobal(); });
    const tcSel = box.querySelector('#gs-textcontrast');
    if (tcSel) tcSel.addEventListener('change', function() { globalSettings.textContrast = this.value; saveGlobal(); toast('文字对比度保护：' + this.options[this.selectedIndex].text); });
    // 游玩模式：长文模式 / galgame模式（影响运行时文字排版与背景蒙版，不改动剧情文本）
    const pmSel = box.querySelector('#gs-playmode');
    if (pmSel) pmSel.addEventListener('change', function() {
      globalSettings.playMode = (this.value === 'galgame') ? 'galgame' : 'longform';
      saveGlobal();
      toast('游玩模式：' + (globalSettings.playMode === 'galgame' ? 'galgame模式' : '长文模式'));
    });
    const obSel = box.querySelector('#gs-opening');
    if (obSel) {
      window.Storage.getAllAssets('background').then(function(list) {
        const opts = ['<option value="">（使用默认深色开场）</option>'];
        (list || []).forEach(function(a) {
          if (a && a.name) opts.push('<option value="' + escapeHtml(a.name) + '"' + (globalSettings.openingBg === a.name ? ' selected' : '') + '>' + escapeHtml(a.name) + '</option>');
        });
        obSel.innerHTML = opts.join('');
      }).catch(function() {});
      obSel.addEventListener('change', function() {
        globalSettings.openingBg = this.value;
        saveGlobal();
        if (this.value) { toast('开场背景已设为：' + this.value); renderSettingsGeneral(); }
        else { toast('已使用默认深色开场'); renderSettingsGeneral(); }
      });
    }
    // 开场音乐：从素材库的音乐中选取（存名称，导出时按名称解析 src）
    const omSel = box.querySelector('#gs-opening-music');
    if (omSel) {
      window.Storage.getAllAssets('music').then(function(list) {
        const opts = ['<option value="">（不使用开场音乐）</option>'];
        (list || []).forEach(function(a) {
          if (a && a.name) opts.push('<option value="' + escapeHtml(a.name) + '"' + (globalSettings.openingMusic === a.name ? ' selected' : '') + '>' + escapeHtml(a.name) + '</option>');
        });
        omSel.innerHTML = opts.join('');
      }).catch(function() {});
      omSel.addEventListener('change', function() {
        globalSettings.openingMusic = this.value;
        saveGlobal();
        if (this.value) { toast('开场音乐已设为：' + this.value); renderSettingsGeneral(); }
        else { toast('已关闭开场音乐'); renderSettingsGeneral(); }
      });
    }
  }
  // 创作设定：把已存的创作信息填回设置抽屉里的输入框
  function loadCreationIntoForm() {
    const c = loadCreation();
    ['outline', 'intro', 'world', 'style'].forEach(k => { const el = $('#c-' + k); if (el) el.value = c[k] || ''; });
    const ce = $('#ai-clues'); if (ce) ce.value = c.clues || '';
  }
  function renderItemCards(list, assets) {
    if (!assets.length) { list.innerHTML = '<div class="empty-tip">还没有物品<br>导入「3D交互制作器」导出的场景包 JSON</div>'; return; }
    assets.forEach(a => {
      const card = makeCard({ kind: 'item', id: a.id, name: a.name, src: a.src, original: a.original });
      const ico = document.createElement('div'); ico.className = 'asset-ico'; ico.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#ic-box"/></svg>';
      const sub = document.createElement('div'); sub.className = 'asset-sub';
      const exitList = (a.exitMeshes && a.exitMeshes.length) ? a.exitMeshes : (a.exitMesh ? [a.exitMesh] : []);
      const boundCount = (a.exitBindings && typeof a.exitBindings === 'object') ? Object.keys(a.exitBindings).filter(function(k){ return a.exitBindings[k]; }).length : 0;
      sub.textContent = exitList.length ? ('结束物体: ' + exitList.join('、') + (boundCount ? (' · 已绑' + boundCount) : '')) : '无结束物体';
      card.querySelector('.asset-meta').appendChild(sub);
      card.insertBefore(ico, card.querySelector('.asset-meta'));
      list.appendChild(card);
    });
  }
  function renderAudioCards(list, icoChar, assets, withStop) {
    list.innerHTML = '';
    // 音乐库：顶部固定一个「停止音乐」功能块（非真实素材，拖入即产生 <停止音乐> 指令）
    if (withStop) {
      const card = document.createElement('div');
      card.className = 'asset-card stop-music-card';
      card.draggable = true;
      card.innerHTML = '<div class="asset-meta"><div class="asset-name"><svg class="ico" aria-hidden="true"><use href="#ic-stop"/></svg> 停止音乐</div>'
        + '<div class="asset-sub">插入 &lt;停止音乐&gt; 指令（3 秒内渐出当前音乐）</div></div>';
      card.addEventListener('click', () => insertAtCursor('<停止音乐>'));
      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('application/x-asset', JSON.stringify({ kind: 'stopmusic', name: '__STOP__' }));
        e.dataTransfer.effectAllowed = 'copy';
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));
      list.appendChild(card);
    }
    if (!assets.length) {
      if (withStop) return; // 已有「停止音乐」卡，不再显示空库提示
      list.innerHTML = '<div class="empty-tip">还没有' + (icoChar === 'music' ? '音乐' : '音效') + '<br>导入音频文件</div>';
      return;
    }
    assets.forEach(a => {
      const card = makeCard({ kind: a.lib || icoChar, id: a.id, name: a.name, src: a.src, original: a.original, derived: a.derived });
      const ico = document.createElement('div'); ico.className = 'asset-ico'; ico.innerHTML = (icoChar === 'music' ? '<svg class="ico" aria-hidden="true"><use href="#ic-music"/></svg>' : '<svg class="ico" aria-hidden="true"><use href="#ic-volume"/></svg>');
      card.insertBefore(ico, card.querySelector('.asset-meta'));
      list.appendChild(card);
    });
  }

  // 音效/音乐试听：全局同一时刻只放一个预览音，点击可切换播放/停止
  let _previewAudio = null, _previewBtn = null;
  function stopPreview() {
    if (_previewAudio) { _previewAudio.pause(); _previewAudio = null; }
    if (_previewBtn) { _previewBtn.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#ic-play"/></svg>'; _previewBtn = null; }
  }
  function toggleAudioPreview(src, btn) {
    if (_previewAudio && _previewBtn === btn) { stopPreview(); return; }
    stopPreview();
    const a = new Audio(src);
    a.onended = () => { _previewAudio = null; _previewBtn = null; if (btn) btn.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#ic-play"/></svg>'; };
    a.play().catch(function(){});
    _previewAudio = a; _previewBtn = btn; btn.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#ic-pause"/></svg>';
  }
  // 计算素材在存储中的占用字节：src（当前素材）+ original（再编辑归档的原始源，若有）均为 dataUrl/base64
  function dataUrlBytes(s) {
    if (!s || typeof s !== 'string') return 0;
    const i = s.indexOf(',');
    const b64 = i >= 0 ? s.slice(i + 1) : s;
    if (!b64) return 0;
    const pad = b64.endsWith('==') ? 2 : (b64.endsWith('=') ? 1 : 0);
    return Math.max(0, Math.floor(b64.length * 3 / 4) - pad);
  }
  function assetByteSize(info) {
    if (!info) return 0;
    return dataUrlBytes(info.src) + dataUrlBytes(info.original);
  }
  function formatAssetSize(bytes) {
    if (!bytes) return '—';
    const mb = bytes / 1048576;
    if (mb < 0.01) return '<0.01 MB';
    return mb.toFixed(2) + ' MB';
  }
  function makeCard(info) {
    const card = document.createElement('div');
    card.className = 'asset-card';
    // 把素材元信息写到 DOM，供右键菜单读取（kind/name/id）
    if (info.kind) card.dataset.kind = info.kind;
    if (info.id != null) card.dataset.id = info.id;
    if (info.name != null) card.dataset.name = info.name;
    if (info.derived) card.dataset.derived = '1';
    // 横屏=拖动添加；竖屏=点按添加（竖屏若可拖拽，点击会被拖动吞掉导致不插入）
    card.draggable = isLandscapeNow();
    const meta = document.createElement('div'); meta.className = 'asset-meta';
    const nm = document.createElement('div'); nm.className = 'asset-name';
    const anText = document.createElement('span'); anText.className = 'an-text'; anText.textContent = info.name || '';
    nm.appendChild(anText);
    const sz = document.createElement('span'); sz.className = 'asset-size';
    const curBytes = dataUrlBytes(info.src);
    sz.textContent = formatAssetSize(curBytes);
    if (info.derived && info.original) {
      const origBytes = dataUrlBytes(info.original);
      sz.title = '当前 ' + formatAssetSize(curBytes) + ' · 原版备份 ' + formatAssetSize(origBytes);
      sz.classList.add('has-orig');
    }
    nm.appendChild(sz);
    if (info.derived) {
      const tag = document.createElement('span'); tag.className = 'tag tag-derived'; tag.textContent = '已再编辑';
      meta.appendChild(tag);
    }
    meta.appendChild(nm);
    const del = document.createElement('button'); del.className = 'asset-del'; del.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#ic-trash"/></svg>'; del.title = '删除';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (_previewBtn && del.closest('.asset-card') === _previewBtn.closest('.asset-card')) stopPreview();
      try { await window.Storage.deleteAsset(info.kind, info.id); renderLibrary(); }
      catch (err) { toast('删除失败：' + (err && err.message ? err.message : err)); }
    });
    const ren = document.createElement('button'); ren.className = 'asset-ren'; ren.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#ic-pencil"/></svg>'; ren.title = '重命名';
    ren.addEventListener('click', (e) => {
      e.stopPropagation();
      handleRenameAsset(info.kind, info.id, info.name);
    });
    card.appendChild(meta);
    // 音效库 / 音乐库：加「试听 / 预览」按钮，全局同一时刻只放一个，点同按钮可停止
    if (info.src && (info.kind === 'sound' || info.kind === 'music')) {
      const play = document.createElement('button');
      play.className = 'asset-play';
      play.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#ic-play"/></svg>';
      play.title = info.kind === 'music' ? '预览音乐' : '试听音效';
      play.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleAudioPreview(info.src, play);
      });
      card.appendChild(play);
    }
    card.appendChild(ren);
    card.appendChild(del);
    // 点按卡片 = 在竖屏把对应召唤指令插入文字编辑器（横屏用拖动，点按不插入）。
    // 锁定模式且已选行时插到选中行，否则插到光标处。临时解除只读确保禁用输入法时也能写入。
    card.addEventListener('click', () => {
      if (!isPortraitNow()) return; // 横屏：用拖动添加，点按不触发插入
      const wasRO = storyText.readOnly;
      storyText.readOnly = false; // 临时解除只读，确保程序化插入一定能写入
      try {
        if (info.kind === 'item') {
          const str = '<召唤物品:' + info.name + ',"">';
          if (imeLock && pendingInsertOffset != null) insertAtOffset(str, pendingInsertOffset, 2);
          else insertAtCursor(str, 2);
          toast('已插入：<召唤物品:' + info.name + '>');
        } else {
          const cn = KIND_TO_CN[info.kind] || info.kind;
          const str = '<召唤' + cn + ':' + info.name + '>';
          if (imeLock && pendingInsertOffset != null) insertAtOffset(str, pendingInsertOffset, 0);
          else insertAtCursor(str);
          toast('已插入：<召唤' + cn + ':' + info.name + '>');
        }
      } finally {
        storyText.readOnly = wasRO;
      }
      refreshInsertHint();
    });
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-asset', JSON.stringify(info));
      e.dataTransfer.effectAllowed = 'copy';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    return card;
  }

  // ============ 导入 ============
  function readFileAsDataUrl(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
  }
  // 把 imageData 量化到 n 色（median-cut 改良版，n 可任意 2..256），模拟像素游戏感、减小体积
  function quantizeToNColor(imageData, n) {
    n = Math.max(2, Math.min(256, n | 0));
    const data = imageData.data;
    const pxCount = (data.length / 4) | 0;
    const STEP = Math.max(1, Math.floor(pxCount / 20000)); // 采样构建调色板，控制内存与耗时
    const samples = [];
    for (let i = 0; i < pxCount; i += STEP) {
      const o = i * 4;
      samples.push([data[o], data[o + 1], data[o + 2]]);
    }
    const makeBox = (list) => {
      let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0;
      for (const p of list) {
        if (p[0] < rmin) rmin = p[0]; if (p[0] > rmax) rmax = p[0];
        if (p[1] < gmin) gmin = p[1]; if (p[1] > gmax) gmax = p[1];
        if (p[2] < bmin) bmin = p[2]; if (p[2] > bmax) bmax = p[2];
      }
      return { list, rmin, rmax, gmin, gmax, bmin, bmax };
    };
    let boxes = [makeBox(samples)];
    while (boxes.length < n) {
      let ti = -1, tr = -1, tchan = 'r';
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (b.list.length < 2) continue;
        const rr = b.rmax - b.rmin, gr = b.gmax - b.gmin, br = b.bmax - b.bmin;
        const m = Math.max(rr, gr, br);
        if (m > tr) { tr = m; ti = i; tchan = m === rr ? 'r' : (m === gr ? 'g' : 'b'); }
      }
      if (ti < 0) break;
      const b = boxes[ti];
      const ci = tchan === 'r' ? 0 : tchan === 'g' ? 1 : 2; // 按数组下标排序（a[tchan] 取的是 undefined，会导致排序失效、调色板塌成近单色）
      b.list.sort((a, c) => a[ci] - c[ci]);
      const mid = b.list.length >> 1;
      boxes.splice(ti, 1, makeBox(b.list.slice(0, mid)), makeBox(b.list.slice(mid)));
    }
    const palette = boxes.map(b => {
      let r = 0, g = 0, bl = 0;
      for (const p of b.list) { r += p[0]; g += p[1]; bl += p[2]; }
      const c = b.list.length || 1;
      return [Math.round(r / c), Math.round(g / c), Math.round(bl / c)];
    });
    const out = new Uint8ClampedArray(data.length);
    for (let i = 0; i < pxCount; i++) {
      const o = i * 4;
      const pr = data[o], pg = data[o + 1], pb = data[o + 2];
      let best = 0, bd = Infinity;
      for (let k = 0; k < palette.length; k++) {
        const dr = pr - palette[k][0], dg = pg - palette[k][1], db = pb - palette[k][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; best = k; }
      }
      out[o] = palette[best][0]; out[o + 1] = palette[best][1]; out[o + 2] = palette[best][2]; out[o + 3] = 255;
    }
    return out;
  }

  // 亮度 / 对比度 / 饱和度调整（参数均为 -100..100；0 表示不变）
  function adjustImageData(imageData, opt) {
    const data = imageData.data;
    const br = (opt.brightness || 0) / 100 * 255;
    const cf = (opt.contrast + 100) / 100;   // 对比度因子（围绕 128）
    const sf = (opt.saturation + 100) / 100; // 饱和度因子（围绕灰度）
    for (let i = 0; i < data.length; i += 4) {
      let r = data[i], g = data[i + 1], b = data[i + 2];
      r = (r - 128) * cf + 128 + br;
      g = (g - 128) * cf + 128 + br;
      b = (b - 128) * cf + 128 + br;
      const gray = 0.299 * r + 0.587 * g + 0.114 * b;
      r = gray + (r - gray) * sf;
      g = gray + (g - gray) * sf;
      b = gray + (b - gray) * sf;
      data[i] = r < 0 ? 0 : r > 255 ? 255 : r;
      data[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      data[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
    }
  }

  // 背景图处理默认参数（与旧版写死的效果一致：720 高、量化 8 色、JPEG 0.85、平滑缩放）
  function IMGPROC_DEFAULTS() {
    return { height: 720, smooth: true, quantize: true, colors: 8, brightness: 0, contrast: 0, saturation: 0, format: 'image/jpeg', quality: 0.85 };
  }

  // 对一张已加载的 Image 按参数处理，返回 canvas（供预览与导出复用）
  function processImageToCanvas(img, p) {
    const H = (p.height && p.height > 0) ? p.height : img.height;
    const W = Math.max(1, Math.round(H * img.width / img.height));
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = !!p.smooth;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, W, H);                 // 缩放（先干净缩，再量化/调色）
    if (p.brightness || p.contrast || p.saturation) {
      const id = ctx.getImageData(0, 0, W, H);
      adjustImageData(id, p);
      ctx.putImageData(id, 0, 0);
    }
    if (p.quantize) {
      const id = ctx.getImageData(0, 0, W, H);
      const out = quantizeToNColor(id, p.colors || 8);
      const od = ctx.createImageData(W, H);
      od.data.set(out);
      ctx.putImageData(od, 0, 0);
    }
    return canvas;
  }
  function processImageToSrc(img, p) {
    const c = processImageToCanvas(img, p);
    return c.toDataURL(p.format || 'image/jpeg', p.quality == null ? 0.85 : p.quality);
  }

  // 背景图导入自动处理（兼容旧调用：默认参数）
  function processBackgroundImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try { URL.revokeObjectURL(url); resolve(processImageToSrc(img, IMGPROC_DEFAULTS())); }
        catch (e) { reject(e); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片解码失败')); };
      img.src = url;
    });
  }

  // ============ 背景图处理面板（上传后弹出，可调参数） ============
  let imgProc = null;     // 当前打开的处理任务：{ img, file, url, originalSrc, name, onApply, onSkip, timer }
  let imgProcBound = false;
  // 打开处理面板。opts: { name, onApply(src), onSkip() }
  function openImageProcessor(file, opts) {
    opts = opts || {};
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const job = {
        img, file, url, name: opts.name || file.name,
        originalSrc: null,
        onApply: opts.onApply || function () {},
        onSkip: opts.onSkip || function () {},
        timer: null
      };
      imgProc = job;
      // 并行读原图 dataURL（「用原图」按钮用）
      readFileAsDataUrl(file).then((s) => { if (imgProc === job) job.originalSrc = s; }).catch(() => {});
      $('#imgproc-fname').textContent = (file.name || '').slice(0, 30);
      $('#imgproc-orig').src = url;
      // 控件复位到默认（与旧版自动处理效果一致）
      $('#ip-height').value = '720';
      $('#ip-smooth').checked = true;
      $('#ip-quant').checked = true;
      $('#ip-colors').value = 8; $('#ip-colors-val').textContent = '8';
      $('#ip-colors').disabled = false;
      $('#ip-bright').value = 0; $('#ip-bright-val').textContent = '0';
      $('#ip-contrast').value = 0; $('#ip-contrast-val').textContent = '0';
      $('#ip-sat').value = 0; $('#ip-sat-val').textContent = '0';
      $('#ip-format').value = 'image/jpeg';
      $('#ip-quality').value = 0.85; $('#ip-quality-val').textContent = '0.85';
      $('#ip-quality-field').style.display = '';
      $('#imgproc-modal').classList.remove('hidden');
      renderImgProcPreview();
    };
    img.onerror = () => { URL.revokeObjectURL(url); toast('图片解码失败'); };
    img.src = url;
  }
  function imgProcReadParams() {
    return {
      height: parseInt($('#ip-height').value, 10) || 0,
      smooth: $('#ip-smooth').checked,
      quantize: $('#ip-quant').checked,
      colors: parseInt($('#ip-colors').value, 10) || 8,
      brightness: parseInt($('#ip-bright').value, 10) || 0,
      contrast: parseInt($('#ip-contrast').value, 10) || 0,
      saturation: parseInt($('#ip-sat').value, 10) || 0,
      format: $('#ip-format').value,
      quality: parseFloat($('#ip-quality').value) || 0.85
    };
  }
  function renderImgProcPreview() {
    if (!imgProc) return;
    const params = imgProcReadParams();
    const canvas = processImageToCanvas(imgProc.img, params);
    const cv = $('#imgproc-res');
    cv.width = canvas.width; cv.height = canvas.height;
    cv.getContext('2d').drawImage(canvas, 0, 0);
    const src = canvas.toDataURL(params.format || 'image/jpeg', params.quality == null ? 0.85 : params.quality);
    const kb = src.length * 0.75 / 1024;
    $('#imgproc-size').textContent = '输出 ' + (kb >= 1024 ? (kb / 1024).toFixed(2) + ' MB' : kb.toFixed(1) + ' KB')
      + ' · ' + (params.format === 'image/png' ? 'PNG' : 'JPEG ' + params.quality.toFixed(2))
      + ' · ' + (params.height ? params.height + 'px 高' : '原尺寸')
      + ' · ' + canvas.width + '×' + canvas.height;
  }
  function scheduleImgProcPreview() {
    if (!imgProc) return;
    if (imgProc.timer) clearTimeout(imgProc.timer);
    imgProc.timer = setTimeout(renderImgProcPreview, 60);
  }
  function closeImageProcessor() {
    if (imgProc && imgProc.url) URL.revokeObjectURL(imgProc.url);
    if (imgProc && imgProc.timer) clearTimeout(imgProc.timer);
    imgProc = null;
    $('#imgproc-modal').classList.add('hidden');
  }
  function finishImageProcessor(src) {
    if (!imgProc) return;
    const cb = imgProc.onApply;
    closeImageProcessor();
    if (cb) cb(src);
  }
  function bindImageProcessor() {
    if (imgProcBound) return; imgProcBound = true;
    const rePrev = () => scheduleImgProcPreview();
    ['ip-height', 'ip-smooth', 'ip-quant', 'ip-colors', 'ip-bright', 'ip-contrast', 'ip-sat', 'ip-format', 'ip-quality'].forEach((id) => {
      const el = $('#' + id);
      el.addEventListener('input', rePrev);
      el.addEventListener('change', rePrev);
    });
    $('#ip-colors').addEventListener('input', () => { $('#ip-colors-val').textContent = $('#ip-colors').value; });
    $('#ip-bright').addEventListener('input', () => { $('#ip-bright-val').textContent = $('#ip-bright').value; });
    $('#ip-contrast').addEventListener('input', () => { $('#ip-contrast-val').textContent = $('#ip-contrast').value; });
    $('#ip-sat').addEventListener('input', () => { $('#ip-sat-val').textContent = $('#ip-sat').value; });
    $('#ip-quality').addEventListener('input', () => { $('#ip-quality-val').textContent = parseFloat($('#ip-quality').value).toFixed(2); });
    // 量化关 → 禁用颜色级数
    $('#ip-quant').addEventListener('change', () => { $('#ip-colors').disabled = !$('#ip-quant').checked; });
    // 格式切 PNG → 隐藏质量
    $('#ip-format').addEventListener('change', () => { $('#ip-quality-field').style.display = $('#ip-format').value === 'image/png' ? 'none' : ''; });
    // 点遮罩空白处 / ✕ / 取消 → 取消（onSkip）
    const cancel = () => { if (imgProc) imgProc.onSkip(); closeImageProcessor(); };
    $('#imgproc-x').addEventListener('click', cancel);
    $('#ip-cancel').addEventListener('click', cancel);
    $('#imgproc-modal').addEventListener('click', (e) => { if (e.target === $('#imgproc-modal')) cancel(); });
    // 用原图
    $('#ip-orig').addEventListener('click', () => {
      if (!imgProc) return;
      finishImageProcessor(imgProc.originalSrc || imgProc.url);
    });
    // 重置
    $('#ip-reset').addEventListener('click', () => {
      $('#ip-height').value = '720';
      $('#ip-smooth').checked = true;
      $('#ip-quant').checked = true;
      $('#ip-colors').value = 8; $('#ip-colors-val').textContent = '8'; $('#ip-colors').disabled = false;
      $('#ip-bright').value = 0; $('#ip-bright-val').textContent = '0';
      $('#ip-contrast').value = 0; $('#ip-contrast-val').textContent = '0';
      $('#ip-sat').value = 0; $('#ip-sat-val').textContent = '0';
      $('#ip-format').value = 'image/jpeg';
      $('#ip-quality').value = 0.85; $('#ip-quality-val').textContent = '0.85';
      $('#ip-quality-field').style.display = '';
      renderImgProcPreview();
    });
    // 应用并保存
    $('#ip-apply').addEventListener('click', () => {
      if (!imgProc) return;
      const params = imgProcReadParams();
      const src = processImageToSrc(imgProc.img, params);
      finishImageProcessor(src);
    });
  }

  // ============ 音频处理核心（裁切 / 压缩，纯浏览器，不外传任何服务器） ============
  let _audioCtx = null;
  function getAudioCtx() {
    if (!_audioCtx) { const AC = window.AudioContext || window.webkitAudioContext; _audioCtx = new AC(); }
    return _audioCtx;
  }
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error || new Error('读取失败'));
      r.readAsDataURL(blob);
    });
  }
  function decodeAudioFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url);
      xhr.responseType = 'arraybuffer';
      xhr.onload = () => {
        URL.revokeObjectURL(url);
        const ctx = getAudioCtx();
        ctx.decodeAudioData(xhr.response.slice(0), (b) => resolve(b), (e) => reject(e || new Error('音频解码失败')));
      };
      xhr.onerror = () => { URL.revokeObjectURL(url); reject(new Error('音频读取失败')); };
      xhr.send();
    });
  }
  // 裁切：取出 [startSec, endSec] 区间，返回新 AudioBuffer（保持原采样率/声道）
  function sliceBuffer(buf, startSec, endSec) {
    const sr = buf.sampleRate;
    let s = Math.max(0, Math.floor(startSec * sr));
    let e = Math.min(buf.length, Math.ceil(endSec * sr));
    if (e <= s) e = buf.length;
    const len = e - s;
    const out = getAudioCtx().createBuffer(buf.numberOfChannels, len, sr);
    for (let c = 0; c < buf.numberOfChannels; c++) out.getChannelData(c).set(buf.getChannelData(c).subarray(s, e));
    return out;
  }
  // 重采样 + 单声道（用 OfflineAudioContext 渲染）
  function resampleBuffer(buf, targetSR, mono) {
    return new Promise((resolve, reject) => {
      const sr = (targetSR && targetSR > 0) ? targetSR : buf.sampleRate;
      const ch = mono ? 1 : buf.numberOfChannels;
      const len = Math.max(1, Math.ceil(buf.length * sr / buf.sampleRate));
      const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      let off;
      try { off = new OAC(ch, len, sr); }
      catch (e) { resolve(buf); return; } // 采样率越界：放弃重采样
      const src = off.createBufferSource();
      src.buffer = buf; src.connect(off.destination); src.start(0);
      off.oncomplete = (ev) => resolve(ev.renderedBuffer);
      off.onerror = (e) => reject(e);
      off.startRendering();
    });
  }
  async function buildProcessedBuffer(buf, p) {
    const sliced = sliceBuffer(buf, p.startSec, p.endSec);
    if ((p.sampleRate && p.sampleRate > 0) || p.mono) {
      try { return await resampleBuffer(sliced, p.sampleRate, p.mono); }
      catch (e) { console.warn('重采样失败，使用裁切结果', e); return sliced; }
    }
    return sliced;
  }
  // WAV 编码（16bit PCM）
  function audioBufferToWav(buf) {
    const numCh = buf.numberOfChannels, sr = buf.sampleRate, len = buf.length;
    const blockAlign = numCh * 2, dataSize = len * blockAlign;
    const ab = new ArrayBuffer(44 + dataSize), view = new DataView(ab);
    const ws = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); ws(8, 'WAVE');
    ws(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, numCh, true);
    view.setUint32(24, sr, true); view.setUint32(28, sr * blockAlign, true); view.setUint16(32, blockAlign, true); view.setUint16(34, 16, true);
    ws(36, 'data'); view.setUint32(40, dataSize, true);
    const chans = []; for (let c = 0; c < numCh; c++) chans.push(buf.getChannelData(c));
    let off = 44;
    for (let i = 0; i < len; i++) for (let c = 0; c < numCh; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]));
      view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7FFF, true); off += 2;
    }
    return new Blob([view], { type: 'audio/wav' });
  }
  // MP3 编码（本地 lamejs，真正压缩）
  async function encodeMp3(buf, kbps) {
    const L = window.lamejs;
    if (!L || !L.Mp3Encoder) throw new Error('MP3 编码库未就绪');
    const numCh = buf.numberOfChannels, sr = buf.sampleRate;
    const enc = new L.Mp3Encoder(numCh, sr, kbps);
    const chans = [];
    for (let c = 0; c < numCh; c++) {
      const d = buf.getChannelData(c), i16 = new Int16Array(d.length);
      for (let i = 0; i < d.length; i++) { const v = Math.max(-1, Math.min(1, d[i])); i16[i] = v < 0 ? v * 0x8000 : v * 0x7FFF; }
      chans.push(i16);
    }
    const block = 1152, out = [];
    if (numCh === 1) {
      for (let i = 0; i < chans[0].length; i += block) { const o = enc.encodeBuffer(chans[0].subarray(i, i + block)); if (o.length) out.push(new Uint8Array(o)); }
    } else {
      for (let i = 0; i < chans[0].length; i += block) { const o = enc.encodeBuffer(chans[0].subarray(i, i + block), chans[1].subarray(i, i + block)); if (o.length) out.push(new Uint8Array(o)); }
    }
    const end = enc.flush(); if (end.length) out.push(new Uint8Array(end));
    return new Blob(out, { type: 'audio/mpeg' });
  }
  // 主线程 MP3 编码（Worker 不可用时的兜底）：分块并在每块间让出事件循环，
  // 使「处理中」弹窗能持续刷新、界面不彻底卡死（能走 Worker 时不会到这）。
  async function encodeMp3Chunked(buf, kbps, onProgress) {
    const L = window.lamejs;
    if (!L || !L.Mp3Encoder) throw new Error('MP3 编码库未就绪');
    const numCh = buf.numberOfChannels, sr = buf.sampleRate;
    const enc = new L.Mp3Encoder(numCh, sr, kbps);
    const chans = [];
    for (let c = 0; c < numCh; c++) {
      const d = buf.getChannelData(c), i16 = new Int16Array(d.length);
      for (let i = 0; i < d.length; i++) { const v = Math.max(-1, Math.min(1, d[i])); i16[i] = v < 0 ? v * 0x8000 : v * 0x7FFF; }
      chans.push(i16);
    }
    const block = 1152, out = [];
    const total = chans[0].length;
    const yieldEvery = Math.max(block, Math.floor(total / 60)); // 约 60 次让出
    let lastPct = -1;
    const yield_ = () => new Promise((r) => setTimeout(r, 0));
    let i;
    if (numCh === 1) {
      for (i = 0; i < total; i += block) {
        const o = enc.encodeBuffer(chans[0].subarray(i, i + block));
        if (o.length) out.push(new Uint8Array(o));
        if (i % yieldEvery < block) { await yield_(); if (onProgress) { const p = Math.floor((i / total) * 100); if (p !== lastPct) { lastPct = p; onProgress(p); } } }
      }
    } else {
      for (i = 0; i < total; i += block) {
        const o = enc.encodeBuffer(chans[0].subarray(i, i + block), chans[1].subarray(i, i + block));
        if (o.length) out.push(new Uint8Array(o));
        if (i % yieldEvery < block) { await yield_(); if (onProgress) { const p = Math.floor((i / total) * 100); if (p !== lastPct) { lastPct = p; onProgress(p); } } }
      }
    }
    const end = enc.flush(); if (end.length) out.push(new Uint8Array(end));
    return new Blob(out, { type: 'audio/mpeg' });
  }
  async function encodeAudioBuffer(buf, format, kbps) {
    if (format === 'mp3') { try { return { blob: await encodeMp3(buf, kbps) }; } catch (e) { console.warn('MP3 编码失败，回退 WAV', e); return { blob: audioBufferToWav(buf) }; } }
    return { blob: audioBufferToWav(buf) };
  }

  // ============ 后台音频编码（Worker，避免主线程卡死） ============
  // 关键点：部署到 htmlto.link 的是「内联单文件」dist/index.html，里面没有独立的
  // js/audio-worker.js（实测 404），所以原来 new Worker('js/audio-worker.js…') 永远
  // 加载失败 → 静默回退主线程编码 → 界面卡死、右下角「处理中」弹窗滞后才出。
  // 现改为：用页面已加载的 lamejs（window.lamejs，build_inline 也会内联进来）源码 +
  // 下面的 Worker 逻辑拼成 Blob Worker，任何环境（本地 / 内联部署）都能用上后台编码。
  let _audioWorker = null;
  let _audioWorkerFailed = false;
  let _audioWorkerReject = null;
  let _audioWorkerPromise = null;
  const AUDIO_WORKER_BODY = `
self.onmessage = function (e) {
  var msg = e.data;
  if (!msg || msg.type !== 'encode') return;
  try {
    var L = self.lamejs;
    if (!L || !L.Mp3Encoder) { self.postMessage({ type: 'error', message: 'MP3 编码库未就绪' }); return; }
    var numCh = msg.numCh, sr = msg.sr, kbps = msg.kbps;
    var chans = msg.chans;
    var enc = new L.Mp3Encoder(numCh, sr, kbps);
    var block = 1152, out = [];
    var total = chans[0].length;
    var lastPct = -1;
    var i, o;
    if (numCh === 1) {
      for (i = 0; i < total; i += block) {
        o = enc.encodeBuffer(chans[0].subarray(i, i + block));
        if (o.length) out.push(new Uint8Array(o));
        var p1 = Math.floor((i / total) * 100);
        if (p1 !== lastPct) { lastPct = p1; self.postMessage({ type: 'progress', pct: p1 }); }
      }
    } else {
      for (i = 0; i < total; i += block) {
        o = enc.encodeBuffer(chans[0].subarray(i, i + block), chans[1].subarray(i, i + block));
        if (o.length) out.push(new Uint8Array(o));
        var p2 = Math.floor((i / total) * 100);
        if (p2 !== lastPct) { lastPct = p2; self.postMessage({ type: 'progress', pct: p2 }); }
      }
    }
    var end = enc.flush(); if (end.length) out.push(new Uint8Array(end));
    var len = 0; out.forEach(function (u) { len += u.length; });
    var all = new Uint8Array(len); var off = 0;
    out.forEach(function (u) { all.set(u, off); off += u.length; });
    var bin = ''; var chunk = 0x8000;
    for (var j = 0; j < all.length; j += chunk) bin += String.fromCharCode.apply(null, all.subarray(j, j + chunk));
    var dataUrl = 'data:audio/mpeg;base64,' + btoa(bin);
    self.postMessage({ type: 'done', dataUrl: dataUrl });
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
`;
  async function ensureAudioWorker() {
    if (_audioWorkerFailed) return null;
    if (_audioWorker) return _audioWorker;
    if (_audioWorkerPromise) return _audioWorkerPromise;
    _audioWorkerPromise = (async () => {
      try {
        const L = window.lamejs;
        if (typeof L !== 'function') throw new Error('lamejs 未加载');
        const src = L.toString() + '\n;\n' + AUDIO_WORKER_BODY;
        const blob = new Blob([src], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        const w = new Worker(url);
        w.addEventListener('error', () => {
          _audioWorkerFailed = true;
          if (_audioWorkerReject) { const r = _audioWorkerReject; _audioWorkerReject = null; r(new Error('音频 Worker 加载失败')); }
        });
        _audioWorker = w;
        return w;
      } catch (e) {
        _audioWorkerFailed = true;
        throw e;
      } finally {
        _audioWorkerPromise = null;
      }
    })();
    return _audioWorkerPromise;
  }
  // 后台编码：MP3 优先走 Blob Worker（含进度），失败回退「分块主线程」（让出事件循环，不卡死）
  async function encodeAudioBufferAsync(buf, format, kbps, onProgress) {
    if (format === 'mp3') {
      try {
        const w = await ensureAudioWorker();
        if (w) {
          try {
            const numCh = buf.numberOfChannels, sr = buf.sampleRate;
            const chans = [];
            for (let c = 0; c < numCh; c++) {
              const d = buf.getChannelData(c), i16 = new Int16Array(d.length);
              for (let i = 0; i < d.length; i++) { const v = Math.max(-1, Math.min(1, d[i])); i16[i] = v < 0 ? v * 0x8000 : v * 0x7FFF; }
              chans.push(i16);
            }
            const dataUrl = await new Promise((resolve, reject) => {
              const onMsg = (ev) => {
                const m = ev.data;
                if (m.type === 'progress') { if (onProgress) onProgress(m.pct); }
                else if (m.type === 'done') { w.removeEventListener('message', onMsg); _audioWorkerReject = null; resolve(m.dataUrl); }
                else if (m.type === 'error') { w.removeEventListener('message', onMsg); _audioWorkerReject = null; reject(new Error(m.message || '编码失败')); }
              };
              _audioWorkerReject = reject;
              w.addEventListener('message', onMsg);
              w.postMessage({ type: 'encode', numCh, sr, kbps, chans }, chans.map((c) => c.buffer));
            });
            return { blob: null, dataUrl };
          } catch (e) {
            console.warn('Worker MP3 编码失败，回退主线程分块编码', e);
            _audioWorkerFailed = true;
          }
        }
      } catch (e) {
        console.warn('音频 Worker 初始化失败，回退主线程分块编码', e);
        _audioWorkerFailed = true;
      }
      // 主线程回退：分块编码并周期性让出，避免界面完全卡死
      try { if (onProgress) onProgress(15); } catch (e) {}
      const blob = await encodeMp3Chunked(buf, kbps, onProgress);
      try { if (onProgress) onProgress(100); } catch (e) {}
      return { blob };
    }
    // WAV
    try { if (onProgress) onProgress(50); } catch (e) {}
    const blob = audioBufferToWav(buf);
    try { if (onProgress) onProgress(100); } catch (e) {}
    return { blob };
  }
  let _apPreviewSrc = null;
  function playTrimPreview(buf) {
    try { if (_apPreviewSrc) _apPreviewSrc.stop(); } catch (e) {}
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    const s = ctx.createBufferSource(); s.buffer = buf; s.connect(ctx.destination); s.start(0); _apPreviewSrc = s;
  }

  // ============ 音频处理面板（导入音乐/音效后弹出） ============
  let audioProc = null;
  let audioProcBound = false;
  function openAudioProcessor(file, opts) {
    opts = opts || {};
    decodeAudioFile(file).then((buf) => {
      audioProc = {
        file, buf, name: opts.name || file.name,
        onApply: opts.onApply || function () {}, onSkip: opts.onSkip || function () {},
        timer: null
      };
      $('#audioproc-fname').textContent = (file.name || '').slice(0, 36);
      resetAudioProcControls();
      $('#audioproc-modal').classList.remove('hidden');
      drawAudioWave(); renderAudioProcInfo();
    }).catch((e) => {
      console.warn('音频解码失败，直接按原文件入库', e);
      toast('该音频无法解析，已按原文件导入');
      if (opts.onApply) opts.onApply(null); // 调用方收到 null → 用原 dataURL
    });
  }
  function audioProcReadParams() {
    const sr = parseInt($('#ap-sr').value, 10);
    return {
      startSec: parseFloat($('#ap-start').value) || 0,
      endSec: parseFloat($('#ap-end').value) || 0,
      sampleRate: (isNaN(sr) ? 0 : sr),
      mono: $('#ap-channels').value === '1',
      format: $('#ap-format').value,
      kbps: parseInt($('#ap-kbps').value, 10) || 128
    };
  }
  function resetAudioProcControls() {
    const buf = audioProc && audioProc.buf;
    const dur = buf ? buf.duration : 0;
    $('#ap-start').max = dur; $('#ap-end').max = dur;
    $('#ap-start').value = 0; $('#ap-start-val').textContent = '0.0s';
    $('#ap-end').value = dur; $('#ap-end-val').textContent = dur.toFixed(1) + 's';
    $('#ap-sr').value = '0';
    $('#ap-channels').value = String(buf ? buf.numberOfChannels : 2);
    $('#ap-format').value = 'mp3';
    $('#ap-kbps').value = '128';
    $('#ap-kbps-field').style.display = '';
  }
  function drawAudioWave() {
    if (!audioProc) return;
    const cv = $('#audioproc-wave');
    const W = cv.clientWidth || 700, H = 140;
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    const buf = audioProc.buf, data = buf.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / W));
    ctx.fillStyle = '#f1f3f7'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#9aa3b2';
    for (let x = 0; x < W; x++) {
      const s = x * step, e = Math.min(data.length, s + step);
      let min = 1, max = -1;
      for (let i = s; i < e; i++) { const v = data[i]; if (v < min) min = v; if (v > max) max = v; }
      const y1 = (1 - (max * 0.5 + 0.5)) * H, y2 = (1 - (min * 0.5 + 0.5)) * H;
      ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
    const p = audioProcReadParams();
    const x1 = (p.startSec / buf.duration) * W, x2 = (p.endSec / buf.duration) * W;
    ctx.fillStyle = 'rgba(99,102,241,0.18)'; ctx.fillRect(x1, 0, Math.max(0, x2 - x1), H);
    ctx.strokeStyle = 'rgba(99,102,241,0.9)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x1, 0); ctx.lineTo(x1, H); ctx.moveTo(x2, 0); ctx.lineTo(x2, H); ctx.stroke();
  }
  function renderAudioProcInfo() {
    if (!audioProc) return;
    const p = audioProcReadParams(), buf = audioProc.buf;
    const dur = Math.max(0, p.endSec - p.startSec);
    const sr = (p.sampleRate && p.sampleRate > 0) ? p.sampleRate : buf.sampleRate;
    const ch = p.mono ? 1 : buf.numberOfChannels;
    let sizeText;
    if (p.format === 'mp3') {
      const kb = dur * p.kbps * 125 / 1024;
      sizeText = '约 ' + (kb >= 1024 ? (kb / 1024).toFixed(2) + ' MB' : kb.toFixed(0) + ' KB') + '（MP3 ' + p.kbps + 'kbps）';
    } else {
      const kb = (44 + dur * sr * ch * 2) / 1024;
      sizeText = '约 ' + (kb >= 1024 ? (kb / 1024).toFixed(2) + ' MB' : kb.toFixed(0) + ' KB') + '（WAV）';
    }
    $('#audioproc-info').textContent = '时长 ' + dur.toFixed(1) + 's · ' + sr + 'Hz · ' + ch + '声道 · ' + sizeText;
  }
  function scheduleAudioProcRender() {
    if (!audioProc) return;
    if (audioProc.timer) clearTimeout(audioProc.timer);
    audioProc.timer = setTimeout(() => { drawAudioWave(); renderAudioProcInfo(); }, 40);
  }
  function closeAudioProcessor() {
    if (audioProc && audioProc.timer) clearTimeout(audioProc.timer);
    try { if (_apPreviewSrc) _apPreviewSrc.stop(); } catch (e) {}
    audioProc = null;
    $('#audioproc-modal').classList.add('hidden');
  }
  function finishAudioProcessor(src) {
    if (!audioProc) return;
    const cb = audioProc.onApply;
    closeAudioProcessor();
    if (cb) cb(src); // src 为 null 表示「用原文件」
  }

  // ============ 音频保存浮动窗（后台编码进度提示） ============
  function showAudioSaveFloat(name, pct) {
    const f = $('#save-float'); if (!f) return;
    f.classList.remove('hidden', 'done');
    const title = f.querySelector('.sf-title'); if (title) title.textContent = '正在处理音频…';
    const nm = $('#save-float-name'); if (nm) nm.textContent = name || '';
    updateAudioSaveFloat(pct || 0);
  }
  function updateAudioSaveFloat(pct) {
    const fill = $('#save-float-fill'); if (!fill) return;
    fill.style.width = Math.max(0, Math.min(100, Math.round(pct))) + '%';
  }
  function updateAudioSaveFloatDone() {
    const f = $('#save-float'); if (!f) return;
    f.classList.add('done');
    const title = f.querySelector('.sf-title'); if (title) title.textContent = '✓ 已完成，已加入音频库';
    updateAudioSaveFloat(100);
    setTimeout(() => { f.classList.add('hidden'); f.classList.remove('done'); }, 1400);
  }
  function hideAudioSaveFloat() {
    const f = $('#save-float'); if (!f) return;
    f.classList.add('hidden'); f.classList.remove('done');
  }
  function bindAudioProcessor() {
    if (audioProcBound) return; audioProcBound = true;
    const re = () => scheduleAudioProcRender();
    ['ap-start', 'ap-end', 'ap-sr', 'ap-channels', 'ap-format', 'ap-kbps'].forEach((id) => {
      const el = $('#' + id); el.addEventListener('input', re); el.addEventListener('change', re);
    });
    $('#ap-start').addEventListener('input', () => { $('#ap-start-val').textContent = parseFloat($('#ap-start').value).toFixed(1) + 's'; });
    $('#ap-end').addEventListener('input', () => { $('#ap-end-val').textContent = parseFloat($('#ap-end').value).toFixed(1) + 's'; });
    $('#ap-format').addEventListener('change', () => { $('#ap-kbps-field').style.display = $('#ap-format').value === 'mp3' ? '' : 'none'; });
    $('#ap-preview').addEventListener('click', async () => {
      if (!audioProc) return;
      const p = audioProcReadParams();
      playTrimPreview(await buildProcessedBuffer(audioProc.buf, p));
    });
    const cancel = () => { if (audioProc) audioProc.onSkip(); closeAudioProcessor(); };
    $('#audioproc-x').addEventListener('click', cancel);
    $('#ap-cancel').addEventListener('click', cancel);
    $('#audioproc-modal').addEventListener('click', (e) => { if (e.target === $('#audioproc-modal')) cancel(); });
    $('#ap-orig').addEventListener('click', () => { finishAudioProcessor(null); });
    $('#ap-reset').addEventListener('click', () => { resetAudioProcControls(); drawAudioWave(); renderAudioProcInfo(); });
    $('#ap-apply').addEventListener('click', () => {
      if (!audioProc) return;
      const p = audioProcReadParams();
      const cb = audioProc.onApply, theBuf = audioProc.buf, nm = audioProc.name;
      closeAudioProcessor(); // 立即关闭弹窗，避免界面卡死
      showAudioSaveFloat(nm, 0);
      (async () => {
        try {
          const buf = await buildProcessedBuffer(theBuf, p);
          const res = await encodeAudioBufferAsync(buf, p.format, p.kbps, updateAudioSaveFloat);
          const src = res.dataUrl || (res.blob ? await blobToDataUrl(res.blob) : null);
          if (cb) await cb(src);
          updateAudioSaveFloatDone();
        } catch (e) {
          console.error('音频处理失败', e);
          hideAudioSaveFloat();
          toast('处理失败，已按原文件导入');
          if (cb) { try { await cb(null); } catch (_) {} }
        }
      })();
    });
  }

  // 把 dataURL 转成 File（再编辑时把已存素材喂回图片/音频处理面板）
  function dataUrlToFile(dataUrl, fallbackName) {
    const m = /^data:(.*?);base64,(.*)$/.exec(dataUrl || '');
    const mime = m ? m[1] : 'application/octet-stream';
    const b64 = m ? m[2] : '';
    let bin = '';
    try { bin = atob(b64); } catch (e) { bin = ''; }
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const extMap = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/wave': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a' };
    const ext = extMap[mime] || 'bin';
    const base = (fallbackName || 'asset').replace(/\.[^.]+$/, '');
    return new File([bytes], base + '.' + ext, { type: mime });
  }

  // 再编辑：保留原图/原音频，调参后重新生成压缩版（src 更新，original 归档不动）
  // 永远从「原始源」(original || src) 派生，避免有损压缩反复叠加导致画质/音质崩坏；
  // 用户点「用原图/用原文件」则恢复成原始源并清掉派生标记。
  async function openReEditModal(lib, id) {
    const asset = await window.Storage.getAsset(lib, id);
    if (!asset) { toast('素材不存在'); return; }
    const baseSrc = asset.original || asset.src;   // 原始源
    if (!baseSrc) { toast('没有可再编辑的源数据'); return; }
    const file = dataUrlToFile(baseSrc, asset.name || 'asset');
    const applyUpdate = async (newSrc) => {
      if (!asset.original) asset.original = asset.src;   // 首次再编辑才归档原始源
      if (newSrc && newSrc === baseSrc) {                // 用户点「用原图/原文件」= 恢复原始
        asset.src = baseSrc; asset.original = null; asset.derived = false; asset.edit = null;
      } else if (newSrc) {                               // 应用新参数后的派生版本
        asset.src = newSrc; asset.derived = true;
        asset.edit = { tool: (lib === 'background' ? 'image' : 'audio'), editedAt: Date.now() };
      } else {                                           // 音频「用原文件」返回 null = 恢复
        asset.src = baseSrc; asset.original = null; asset.derived = false; asset.edit = null;
      }
      // 音频派生版由浮动窗提示完成；图片 / 恢复原始仍走 toast
      const silent = (lib === 'music' || lib === 'sound') && newSrc && newSrc !== baseSrc;
      try { await window.Storage.saveAsset(lib, asset); renderLibrary(); focusLibrary(lib); if (!silent) toast('已保存再编辑结果'); }
      catch (e) { toast('保存失败：' + (e && e.message ? e.message : e)); }
    };
    if (lib === 'background') {
      openImageProcessor(file, { name: asset.name, onApply: applyUpdate, onSkip: function () {} });
    } else if (lib === 'music' || lib === 'sound') {
      openAudioProcessor(file, { name: asset.name, onApply: applyUpdate, onSkip: function () {} });
    }
  }

  async function restoreOriginalAsset(lib, id) {
    try {
      const asset = await window.Storage.getAsset(lib, id);
      if (!asset || !asset.original) { toast('没有可恢复的原始素材'); return; }
      asset.src = asset.original; asset.original = null; asset.derived = false; asset.edit = null;
      await window.Storage.saveAsset(lib, asset); renderLibrary(); toast('已恢复原始素材');
    } catch (e) { toast('恢复失败：' + (e && e.message ? e.message : e)); }
  }

  async function importFiles(files, lib, kind) {
    const arr = Array.from(files || []);
    if (kind === 'image') {
      // 背景图：逐张打开处理面板，用户调参后保存（多张则串行队列）
      let done = 0;
      for (const f of arr) {
        await new Promise((resolve) => {
          openImageProcessor(f, {
            name: f.name,
            onApply: async (src) => {
              try { await window.Storage.saveAsset(lib, { name: f.name, src }); done++; }
              catch (e) { console.error('素材保存失败：', f && f.name, e); }
              resolve();
            },
            onSkip: () => resolve()
          });
        });
      }
      if (lib === 'background') focusLibrary('background');
      else { renderLibrary(); saveNow(); }
      toast('已导入 ' + done + ' 张背景图');
      return;
    }
    if (kind === 'audio') {
      // 音乐/音效：逐张打开处理面板，用户裁切+压缩后保存（多张串行队列）
      let done = 0;
      for (const f of arr) {
        await new Promise((resolve) => {
          openAudioProcessor(f, {
            name: f.name,
            onApply: async (src) => {
              try {
                let dataUrl = src;
                if (!dataUrl) { try { dataUrl = await readFileAsDataUrl(f); } catch (e) {} }
                if (dataUrl) { await window.Storage.saveAsset(lib, { name: f.name, src: dataUrl }); done++; focusLibrary(lib); }
              } catch (e) { console.error('音频保存失败：', f && f.name, e); }
              resolve();
            },
            onSkip: () => resolve()
          });
        });
      }
      toast('已导入 ' + done + ' 个音频');
      renderLibrary(); saveNow();
      return;
    }
    let ok = 0, fail = 0;
    for (const f of arr) {
      try {
        const src = await readFileAsDataUrl(f);
        await window.Storage.saveAsset(lib, { name: f.name, src });
        ok++;
      } catch (e) {
        fail++;
        console.error('素材保存失败：', f && f.name, e);
      }
    }
    if (fail) toast('有 ' + fail + ' 个素材保存失败（可能超出浏览器存储上限）');
    else if (ok) toast('已导入 ' + ok + ' 个素材');
    renderLibrary(); saveNow();
  }
  async function importBundle(file) {
    if (!file) return;
    try {
      const imported = await window.Storage.importSceneBundleFile(file);
      toast('已导入 ' + imported.length + ' 个物品');
      renderLibrary();
    } catch (err) {
      alert('导入失败：' + (err.message || err));
    }
  }

  // ============ 重命名素材（自动更新文字编辑器中的引用） ============
  async function handleRenameAsset(lib, id, oldName) {
    const input = prompt('重命名素材「' + oldName + '」', oldName);
    if (input == null || !input.trim() || input.trim() === oldName) return;
    let safe = input.trim();
    // 检测同名：如果同一个库里已有其他素材叫这个名字，自动在后面加序号
    const all = await window.Storage.getAllAssets(lib);
    const others = all.filter(a => a.id !== id).map(a => a.name);
    if (others.includes(safe)) {
      let n = 2;
      while (others.includes(safe + ' (' + n + ')')) n++;
      safe = safe + ' (' + n + ')';
      toast('名称重复，已自动改为「' + safe + '」');
    }
    try { await window.Storage.renameAsset(lib, id, safe); }
    catch (e) { toast('重命名失败：' + (e && e.message ? e.message : e)); return; }
    // 替换文字编辑器中所有 [召唤X:旧名] → [召唤X:新名]
    const cn = KIND_TO_CN[lib];
    if (cn) {
      // 转义旧名中可能含有的正则特殊字符
      const escOld = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('(\\<召唤' + cn + ':)(' + escOld + ')(\\>)', 'g');
      const ta = storyText;
      const newVal = ta.value.replace(re, '$1' + safe + '$3');
      if (newVal !== ta.value) {
        ta.value = newVal;
        commitEdit();
        toast('已更新文本中相关召唤引用');
      }
    }
    renderLibrary();
  }

  // 音乐库 ⇄ 音效库 互移时，同步改写剧本里对应的召唤指令
  // （<召唤音乐:名称> ⇄ <召唤音效:名称>），遍历所有剧情块（含主剧情与子块）
  function swapSummonKindEverywhere(fromCN, toCN, assetName) {
    const names = window.Storage.listBlockNames();
    const esc = (assetName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!esc) return 0;
    const re = new RegExp('(<召唤)' + fromCN + '(:\\s*' + esc + '\\s*>)', 'g');
    let changed = 0;
    for (const nm of names) {
      let text, save;
      if (nm === activeBlock) {
        text = storyText.value;
        save = function (v) { storyText.value = v; commitEdit(); };
      } else {
        text = window.Storage.getBlockText(nm) || '';
        save = function (v) { window.Storage.setBlockText(nm, v); };
      }
      const newText = text.replace(re, '$1' + toCN + '$2');
      if (newText !== text) { save(newText); changed++; }
    }
    return changed;
  }

  // ============ 生成器 ============
  function openGradientGen(presetName) {
    const box = $('#gen-box');
    box.innerHTML = '<h3><svg class="ico" aria-hidden="true"><use href="#ic-gradient"/></svg> 渐变背景生成器</h3>'
      + '<div class="gen-preview"><img id="g-prev" alt="预览"></div>'
      + '<div class="gen-colors-row">'
      + '<div class="gen-color-item"><label>颜色1</label><input type="color" class="gen-color-big" id="g-c1" value="#1a2a6c"></div>'
      + '<div class="gen-color-item"><label>颜色2</label><input type="color" class="gen-color-big" id="g-c2" value="#b21f1f"></div>'
      + '</div>'
      + field('方向', '<select id="g-dir"><option value="vertical">竖直</option><option value="horizontal">水平</option><option value="diagonal">对角</option><option value="radial">径向</option></select>')
      + '<button class="btn btn-primary" id="g-go">生成并加入图片库</button>';
    $('#gen-modal').classList.remove('hidden');
    const opts = () => ({ color1: $('#g-c1').value, color2: $('#g-c2').value, direction: $('#g-dir').value });
    const upd = () => { $('#g-prev').src = window.Generators.generateGradient(opts()); };
    $('#g-c1').addEventListener('input', upd);
    $('#g-c2').addEventListener('input', upd);
    $('#g-dir').addEventListener('change', upd);
    upd();
    $('#g-go').onclick = () => {
      const assetName = (typeof presetName === 'string' && presetName) ? presetName : ('渐变-' + Date.now().toString(36));
      window.Storage.saveAsset('background', { name: assetName, kind: 'gradient', src: window.Generators.generateGradient(opts()) }).then(() => {
        closeGen(); renderLibrary(); saveNow();
        if (presetName) refreshTodo();
      }).catch((err) => {
        closeGen(); alert('生成失败：' + (err && err.message ? err.message : err));
      });
    };
  }
  function openNoiseGen(presetName) {
    const box = $('#gen-box');
    box.innerHTML = '<h3><svg class="ico" aria-hidden="true"><use href="#ic-noise"/></svg> 噪波背景生成器</h3>'
      + '<div class="gen-preview"><img id="n-prev" alt="预览"></div>'
      + '<div class="gen-colors-row">'
      + '<div class="gen-color-item"><label>颜色1</label><input type="color" class="gen-color-big" id="n-c1" value="#0b1020"></div>'
      + '<div class="gen-color-item"><label>颜色2</label><input type="color" class="gen-color-big" id="n-c2" value="#5b6ee1"></div>'
      + '</div>'
      + field('宽度', '<input type="number" id="n-w" value="1280" min="128" max="1920" step="2">')
      + field('高度', '<input type="number" id="n-h" value="720" min="128" max="1080" step="2">')
      + field('云雾', '<input type="number" id="n-grid" value="3" min="2" max="128" step="1">')
      + field('颗粒强度', '<input type="range" id="n-grain" min="0" max="100" value="40"><span id="n-grain-val" style="font-size:12px;color:#9aa3b2;min-width:34px;margin-left:6px">40%</span>')
      + '<button class="btn btn-primary" id="n-go">生成并加入图片库</button>';
    $('#gen-modal').classList.remove('hidden');
    const opts = () => ({ color1: $('#n-c1').value, color2: $('#n-c2').value, w: parseInt($('#n-w').value, 10) || 1280, h: parseInt($('#n-h').value, 10) || 720, grid: parseInt($('#n-grid').value, 10) || 3, grain: parseInt($('#n-grain').value, 10) / 100 });
    const upd = () => { $('#n-prev').src = window.Generators.generateNoise(opts()); };
    $('#n-c1').addEventListener('input', upd);
    $('#n-c2').addEventListener('input', upd);
    $('#n-w').addEventListener('input', upd);
    $('#n-h').addEventListener('input', upd);
    $('#n-grid').addEventListener('input', upd);
    $('#n-grain').addEventListener('input', () => { $('#n-grain-val').textContent = $('#n-grain').value + '%'; upd(); });
    upd();
    $('#n-go').onclick = () => {
      const assetName = (typeof presetName === 'string' && presetName) ? presetName : ('噪波-' + Date.now().toString(36));
      window.Storage.saveAsset('background', { name: assetName, kind: 'noise', src: window.Generators.generateNoise(opts()) }).then(() => {
        closeGen(); renderLibrary(); saveNow();
        if (presetName) refreshTodo();
      }).catch((err) => {
        closeGen(); alert('生成失败：' + (err && err.message ? err.message : err));
      });
    };
  }
  // 纯色背景「重选颜色」：复用纯色生成器，进入编辑模式（预填当前色、改按钮为保存修改）
  async function openSolidRePick(lib, id) {
    const asset = await window.Storage.getAsset(lib, id);
    if (!asset) { toast('素材不存在'); return; }
    if (asset.kind !== 'solid') { openReEditModal(lib, id); return; } // 非纯色走原再编辑
    openSolidGen(null, asset);
  }
  // ============ 物品：设置结束物体 → 剧情块绑定 ============
  // 右键物品卡 → 设置结束物体绑定：为每个结束物体选择要跳转的剧情块（或不绑定）。
  async function openItemExitSettings(lib, id) {
    const asset = await window.Storage.getAsset(lib, id);
    if (!asset) { toast('素材不存在'); return; }
    const exitMeshes = (asset.exitMeshes && asset.exitMeshes.length) ? asset.exitMeshes
                     : (asset.exitMesh ? [asset.exitMesh] : []);
    const bindings = (asset.exitBindings && typeof asset.exitBindings === 'object') ? asset.exitBindings : {};
    const blockNames = (window.Storage.listBlockNames && window.Storage.listBlockNames()) || [];
    const box = $('#gen-box');
    let html = '<h3><svg class="ico" aria-hidden="true"><use href="#ic-link"/></svg> 设置结束物体绑定</h3>';
    html += '<div class="gen-note">为物品 <b>' + escapeHtml(asset.name || '') + '</b> 的每个「结束物体」选择要跳转的剧情块。'
          + '未绑定的结束物体点击后仍按原逻辑关闭查看器并继续剧情。</div>';
    if (!exitMeshes.length) {
      html += '<div class="gen-note" style="color:#ffb4b4">该物品没有「结束物体」（导出场景包时未设置），无法绑定。'
            + '请在 3D交互制作器里设置结束物体后重新导入。</div>';
    } else {
      html += '<div id="exit-binding-rows">';
      exitMeshes.forEach(function(mesh){
        const cur = bindings[mesh] || '';
        const opts = ['<option value="">（不绑定，原逻辑）</option>'].concat(
          blockNames.map(function(b){
            return '<option value="' + escapeHtml(b) + '"' + (b === cur ? ' selected' : '') + '>' + escapeHtml(b) + '</option>';
          })
        ).join('');
        html += '<div class="field"><label>' + escapeHtml(mesh) + '</label>'
              + '<select class="exit-bind-select" data-mesh="' + escapeHtml(mesh) + '">' + opts + '</select></div>';
      });
      html += '</div>';
    }
    html += '<div style="display:flex;gap:8px;margin-top:12px">'
          + '<button class="btn btn-primary" id="exit-bind-save">保存绑定</button>'
          + '<button class="btn" id="exit-bind-cancel">取消</button></div>';
    box.innerHTML = html;
    $('#gen-modal').classList.remove('hidden');
    $('#exit-bind-cancel').onclick = function () { closeGen(); };
    $('#exit-bind-save').onclick = function () {
      const newBindings = {};
      Array.prototype.forEach.call(document.querySelectorAll('.exit-bind-select'), function (sel) {
        const mesh = sel.getAttribute('data-mesh');
        const val = sel.value;
        if (val) newBindings[mesh] = val;
      });
      asset.exitBindings = newBindings;
      window.Storage.saveAsset('item', asset).then(function () {
        closeGen(); renderLibrary(); saveNow();
        const n = Object.keys(newBindings).length;
        toast(n ? ('已保存 ' + n + ' 个结束物体绑定') : '已清除所有绑定');
      }).catch(function (err) {
        closeGen(); alert('保存失败：' + (err && err.message ? err.message : err));
      });
    };
  }
  function openSolidGen(presetName, editAsset) {
    const box = $('#gen-box');
    const presets = ['#000000|纯黑', '#ffffff|纯白', '#3a6ea5|天蓝', '#c0392b|朱红', '#27ae60|草绿', '#f1c40f|明黄', '#8e44ad|紫罗兰', '#ecf0f1|浅灰', '#2c3e50|深蓝灰', '#e67e22|橙'];
    const editing = !!(editAsset && editAsset.id != null);
    const initColor = (editing && editAsset.color) ? editAsset.color : '#3a6ea5';
    box.innerHTML = '<h3><svg class="ico" aria-hidden="true"><use href="#ic-color"/></svg> ' + (editing ? '重选纯色背景' : '纯色背景生成器') + '</h3>'
      + '<div class="gen-solid-preview" id="s-prev"></div>'
      + '<div class="gen-colors-row">'
      + '<div class="gen-color-item"><label>纯色</label><input type="color" class="gen-color-big" id="s-c" value="' + initColor + '"></div>'
      + '<div class="gen-color-item"><label>常用色</label><select id="s-preset">' + presets.map(function(p){ const kv = p.split('|'); return '<option value="' + kv[0] + '">' + kv[1] + '</option>'; }).join('') + '</select></div>'
      + '</div>'
      + '<div class="gen-note">纯色背景不会生成图片，导出时直接以该颜色铺满背景层，更小巧、对比清晰。</div>'
      + '<button class="btn btn-primary" id="s-go">' + (editing ? '保存修改' : '加入图片库（召唤即纯色背景）') + '</button>';
    $('#gen-modal').classList.remove('hidden');
    const upd = () => { $('#s-prev').style.background = $('#s-c').value; };
    $('#s-c').addEventListener('input', upd);
    $('#s-preset').addEventListener('change', () => { $('#s-c').value = $('#s-preset').value; upd(); });
    // 若当前颜色命中某个预设，预选它
    const sel = $('#s-preset');
    Array.prototype.forEach.call(sel.options, function (o) { o.selected = (o.value.toLowerCase() === initColor.toLowerCase()); });
    upd();
    $('#s-go').onclick = () => {
      const color = $('#s-c').value;
      if (editing) {
        window.Storage.getAsset('background', editAsset.id).then(function (asset) {
          asset = asset || {};
          asset.color = color;
          asset.kind = 'solid';
          if (!asset.name) asset.name = editAsset.name || ('纯色-' + color.replace('#', '').toUpperCase());
          return window.Storage.saveAsset('background', asset);
        }).then(function () {
          closeGen(); renderLibrary(); saveNow();
          toast('已更新纯色背景：' + color);
        }).catch(function (err) {
          closeGen(); alert('保存失败：' + (err && err.message ? err.message : err));
        });
      } else {
        const assetName = (typeof presetName === 'string' && presetName) ? presetName : ('纯色-' + color.replace('#', '').toUpperCase() + '-' + Date.now().toString(36));
        window.Storage.saveAsset('background', { name: assetName, kind: 'solid', color: color }).then(() => {
          closeGen(); renderLibrary(); saveNow();
          if (presetName) refreshTodo();
          toast('已加入纯色背景：' + color);
        }).catch((err) => {
          closeGen(); alert('生成失败：' + (err && err.message ? err.message : err));
        });
      }
    };
  }
  function closeGen() { $('#gen-modal').classList.add('hidden'); }
  $('#gen-modal').addEventListener('click', (e) => { if (e.target.id === 'gen-modal') closeGen(); });
  function field(label, control) {
    return '<div class="field"><label>' + label + '</label>' + control + '</div>';
  }

  // ============ 素材待办 ============
  // 扫描当前文字里「被召唤、但素材库里还没有」的素材。
  // 非实时监测：仅在「打开待办面板」或「点击刷新」时扫描（见 bindTodoEvents）。
  let todoAutoRefreshStarted = false;
  let todoPasteBound = false;
  let todoHoverBound = false;
  let todoHoveredRow = null; // 当前鼠标悬停的待办行（用 mouseover/mouseleave 精确追踪）
  let todoHoveredName = null; // 对应待办项名字（待办刷新后旧节点失效时，按名字找回行）
  function bindTodoEvents() {
    const fab = $('#todo-fab');
    if (fab) fab.addEventListener('click', () => {
      const panel = $('#todo-panel');
      const willOpen = panel.classList.contains('hidden');
      panel.classList.toggle('hidden');
      if (willOpen) refreshTodo(); // 打开即刷新一次
    });
    const closeBtn = $('#todo-close');
    if (closeBtn) closeBtn.addEventListener('click', () => $('#todo-panel').classList.add('hidden'));
    const refreshBtn = $('#todo-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', () => refreshTodo());
    // 防止把文件拖到待办区域以外时浏览器直接打开文件（拖到待办条目上由条目自身处理）
    const blockFileNav = (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') >= 0) e.preventDefault();
    };
    window.addEventListener('dragover', blockFileNav);
    window.addEventListener('drop', blockFileNav);
    // 每 40 秒自动刷新一次待办（素材库变动时会即时刷新，见 renderLibrary）；只启动一次
    if (!todoAutoRefreshStarted) { todoAutoRefreshStarted = true; setInterval(refreshTodo, 40000); }
    // 背景待办：悬停 + Ctrl+V 粘贴图片上传（全局监听一次）
    if (!todoPasteBound) { todoPasteBound = true; document.addEventListener('paste', onTodoPaste); }
    // 悬停追踪：用 mouseover/mouseleave 精确记录当前悬停的待办行。
    // 比 querySelector(':hover') 更稳——部分浏览器在 paste 事件触发时 :hover 命中不可靠，导致取不到悬停行。
    if (!todoHoverBound) {
      todoHoverBound = true;
      const tl = document.getElementById('todo-list');
      if (tl) {
        tl.addEventListener('mouseover', (e) => {
          const r = e.target && e.target.closest ? e.target.closest('.todo-item') : null;
          if (r) { todoHoveredRow = r; todoHoveredName = r.dataset ? r.dataset.todoName : null; }
        });
        tl.addEventListener('mouseleave', () => { todoHoveredRow = null; todoHoveredName = null; });
      }
    }
  }

  // 返回「已召唤但库中缺失」的素材列表：[{ kind, name }]
  async function computeTodo() {
    // 扫描全部剧情块（含主剧情）里的召唤指令
    const names = window.Storage.listBlockNames();
    const summoned = {}; // kind -> Set(name)
    for (const nm of names) {
      const story = parseStory(window.Storage.getBlockText(nm) || '');
      for (const n of story) {
        if (n.type === 'summon' && n.name && n.name.trim()) {
          (summoned[n.kind] = summoned[n.kind] || new Set()).add(n.name.trim());
        }
      }
    }
    const todo = [];
    for (const kind of window.Storage.LIBS) {
      const names = summoned[kind];
      if (!names || !names.size) continue;
      let have;
      try { have = new Set((await window.Storage.getAllAssets(kind)).map(a => a.name)); }
      catch (e) { have = new Set(); }
      for (const name of names) {
        if (!have.has(name)) todo.push({ kind, name });
      }
    }
    return todo;
  }

  async function refreshTodo() {
    const todo = await computeTodo();
    const badge = $('#todo-badge');
    if (badge) {
      if (todo.length) { badge.textContent = String(todo.length); badge.hidden = false; }
      else badge.hidden = true;
    }
    const list = $('#todo-list');
    if (!list) return;
    list.innerHTML = '';
    if (!todo.length) {
      list.innerHTML = '<div class="todo-empty"><svg class="ico" aria-hidden="true"><use href="#ic-check"/></svg> 当前文字里召唤的素材都已就绪</div>';
      return;
    }
    for (const item of todo) list.appendChild(makeTodoItem(item));
  }

  function makeTodoItem(item) {
    const cn = KIND_TO_CN[item.kind] || item.kind;
    const row = document.createElement('div');
    row.className = 'todo-item todo-' + item.kind;
    row.dataset.todoName = item.name; // 供悬停 paste 时按名字找回行（待办刷新后旧节点失效）
    row.innerHTML =
      '<div class="todo-info"><span class="todo-kind">' + cn + '</span>'
      + '<span class="todo-name" title="' + escapeHtml(item.name) + '">' + escapeHtml(item.name) + '</span></div>'
      + '<div class="todo-actions">'
      + '<button type="button" class="btn todo-upload" title="上传素材并命名为「' + escapeHtml(item.name) + '」"><svg class="ico" aria-hidden="true"><use href="#ic-upload"/></svg> 上传</button>'
      + (item.kind === 'background'
          ? '<button type="button" class="btn todo-bgprompt' + (getCachedPrompt(item.name) ? ' has-prompt' : '') + '" title="用 AI 揣摩该场景，生成图片提示词"><svg class="ico" aria-hidden="true"><use href="#ic-bulb"/></svg> 提示词' + (getCachedPrompt(item.name) ? '<svg class="ico" aria-hidden="true"><use href="#ic-check"/></svg>' : '') + '</button>'
            + '<button type="button" class="btn todo-gengrad" title="打开渐变生成器，调好颜色后以「' + escapeHtml(item.name) + '」入库"><svg class="ico" aria-hidden="true"><use href="#ic-gradient"/></svg> 渐变</button>'
            + '<button type="button" class="btn todo-gennoise" title="打开噪波生成器，调好参数后以「' + escapeHtml(item.name) + '」入库"><svg class="ico" aria-hidden="true"><use href="#ic-noise"/></svg> 噪波</button>'
          : (item.kind === 'sound' || item.kind === 'music'
              ? '<button type="button" class="btn todo-search" title="在 tosound.com 搜索' + (item.kind === 'music' ? '音乐' : '音效') + '「' + escapeHtml(item.name) + '」"><svg class="ico" aria-hidden="true"><use href="#ic-search"/></svg> 搜</button>'
              : ''))
      + '</div>'
      + (item.kind === 'background'
          ? '<div class="todo-paste-hint">悬停此行，按 Ctrl+V 可粘贴图片快速上传</div>'
          : '');

    // 隐藏文件选择框：选中后以待办名直接入库
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.style.display = 'none';
    if (item.kind === 'background' || item.kind === 'overlay') fileInput.accept = 'image/*';
    else if (item.kind === 'item') fileInput.accept = '.json,application/json';
    else fileInput.accept = 'audio/*';
    row.appendChild(fileInput);

    // 校验待办条目允许的文件格式；格式不对直接拒绝，不入库
    function todoFileOk(f) {
      const name = (f.name || '').toLowerCase();
      if (item.kind === 'background' || item.kind === 'overlay') return f.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|bmp)$/.test(name);
      if (item.kind === 'item') return f.type === 'application/json' || name.endsWith('.json');
      return f.type.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|flac|aac|opus|weba)$/.test(name); // sound / music
    }
    const KIND_NEED = { background: '图片文件', item: 'JSON 场景包', overlay: '图片文件', sound: '音频文件', music: '音频文件' };

    // 统一入库入口：拖拽 / 选择 都走这里（先校验格式）
    async function handleTodoFile(f) {
      if (!f) return;
      if (!todoFileOk(f)) {
        toast('格式不对：待办「' + item.name + '」需要' + (KIND_NEED[item.kind] || '对应素材'));
        return;
      }
      try {
        if (item.kind === 'item') {
          await importBundleAsTodo(f, item.name); // GLB 场景包，整体以待办名入库
          focusLibrary('item'); // 上传后切到物品库并刷新，立即显示新模型
        } else if (item.kind === 'background') {
          // 打开处理面板：上传后弹出，可调分辨率/颜色级数/亮度等，确认后保存
          openImageProcessor(f, {
            name: item.name,
            onApply: async (src) => {
              await window.Storage.saveAsset('background', { name: item.name, src });
              focusLibrary('background'); // 上传后切到背景库并刷新，立即显示新图
              showTodoPreview(row, src);  // 行内实时预览
              setTimeout(() => refreshTodo(), 1600); // 延迟刷新：先让用户看到预览，刷新后该项因已补齐而从待办消失
            },
            onSkip: () => {}
          });
        } else {
          const dataUrl = await readFileAsDataUrl(f);
          await window.Storage.saveAsset(item.kind, { name: item.name, src: dataUrl });
          focusLibrary(item.kind); // 上传后切到对应素材库并刷新，立即显示新条目
        }
        toast('已添加「' + item.name + '」（' + cn + '）');
        refreshTodo(); // 重新扫描，已补齐的项自动消失
      } catch (err) {
        alert('添加失败：' + (err && err.message ? err.message : err));
      }
    }

    row.querySelector('.todo-upload').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => handleTodoFile(fileInput.files && fileInput.files[0]));

    // 拖拽上传：把文件拖到该待办条目上即入库；格式不符则拒绝（不接收）
    row.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); row.classList.add('drag-over'); });
    row.addEventListener('dragenter', (e) => { e.preventDefault(); e.stopPropagation(); row.classList.add('drag-over'); });
    row.addEventListener('dragleave', (e) => { e.preventDefault(); e.stopPropagation(); row.classList.remove('drag-over'); });
    row.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation();
      row.classList.remove('drag-over');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleTodoFile(f);
    });

    // 背景额外两个生成器按钮：点开与背景库一致的「调色生成器」弹层，让用户调好后再以待办名入库
    if (item.kind === 'background') {
      row.querySelector('.todo-bgprompt').addEventListener('click', () => openBgPromptModal(item.name));
      row.querySelector('.todo-gengrad').addEventListener('click', () => openGradientGen(item.name));
      row.querySelector('.todo-gennoise').addEventListener('click', () => openNoiseGen(item.name));
    }
    // 音效 / 音乐额外「一键搜索」按钮：新窗口跳转到 tosound 搜索；音乐带 /music-1 后缀
    if (item.kind === 'sound' || item.kind === 'music') {
      row.querySelector('.todo-search').addEventListener('click', () => {
        let url = 'https://www.tosound.com/search/word-' + encodeURIComponent(item.name);
        if (item.kind === 'music') url += '/music-1';
        if (window.open) window.open(url, '_blank', 'noopener');
      });
    }
    return row;
  }

  // 切到指定素材库 tab 并刷新（上传素材后让新条目立即显示出来）
  function focusLibrary(kind) {
    if (!kind) return;
    activeLib = kind;
    const tabs = document.querySelectorAll('#lib-tabs [data-lib]');
    tabs.forEach((x) => x.classList.toggle('active', x.dataset.lib === kind));
    renderLibrary();
  }

  // ---- 背景待办：悬停 + Ctrl+V 粘贴上传 ----
  // 从剪贴板 DataTransfer 取出图片文件（无则返回 null）
  // 同时检查 cd.files（FileList）和 cd.items（DataTransferItemList），覆盖不同浏览器习惯
  function getImageFileFromClipboard(cd) {
    if (!cd) return null;
    // 1) 优先从 files 取（兼容性最好，IE/旧 Edge/部分右键复制图片场景直接放在这里）
    const files = cd.files || [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (f && f.type && f.type.indexOf('image/') === 0) return f;
    }
    // 2) 再从 items 取（Chrome/Firefox 等现代浏览器）
    const items = cd.items || [];
    for (const it of items) {
      if (it.kind === 'file' && it.type && it.type.indexOf('image/') === 0) {
        const f = it.getAsFile && it.getAsFile();
        if (f) return f;
      }
    }
    return null;
  }
  // 校验粘贴图片的格式与大小；返回错误提示字符串（null 表示通过）
  function validatePastedImage(f) {
    const MAX = 10 * 1024 * 1024; // 10MB
    const name = (f.name || '').toLowerCase();
    const okType = (f.type && f.type.indexOf('image/') === 0 && /(png|jpe?g|gif|webp|avif|bmp)/.test(f.type))
      || /\.(png|jpe?g|gif|webp|avif|bmp)$/.test(name);
    if (!okType) return '图片格式不支持，请粘贴 PNG / JPG / GIF / WEBP / AVIF / BMP 图片';
    if (f.size > MAX) return '图片过大（' + (f.size / 1048576).toFixed(1) + ' MB），请小于 10 MB';
    return null;
  }
  // 全局粘贴监听：仅「悬停在背景待办上 + Ctrl/Cmd+V + 剪贴板含图片」时处理；其余场景放行（如正常文字粘贴）
  // 待办刷新后旧行节点已失效时，按名字找回当前悬停的背景待办行
  function findTodoRowByName(name) {
    if (!name) return null;
    const rows = document.querySelectorAll('.todo-item.todo-background');
    for (const r of rows) { if (r.dataset && r.dataset.todoName === name) return r; }
    return null;
  }
  function onTodoPaste(e) {
    // 不再强制要求 Ctrl/Cmd：只要鼠标悬停在背景待办行上，并且剪贴板里是图片，就上传到该待办。
    // 纯文字粘贴（无图片）直接 return，不影响正文 textarea 正常粘贴。
    // 1) 确定悬停的背景待办行（多方式兜底：追踪引用 → :hover → 按名字找回）
    let hovered = todoHoveredRow;
    if (!hovered || !document.body.contains(hovered) || !hovered.classList.contains('todo-background')) {
      hovered = document.querySelector('.todo-background:hover');
    }
    if ((!hovered || !hovered.classList.contains('todo-background')) && todoHoveredName) {
      hovered = findTodoRowByName(todoHoveredName);
    }
    if (!hovered || !hovered.classList.contains('todo-background')) return; // 没悬停背景待办：完全不响应，放行默认

    // 2) 剪贴板是否含图片
    const cd = e.clipboardData || window.clipboardData;
    const file = cd ? getImageFileFromClipboard(cd) : null;
    if (!file) return;                                 // 剪贴板不是图片：放行（例如把文字粘贴进正文 textarea）

    // 3) 悬停背景待办 + 剪贴板是图片：无论焦点在 textarea 还是别处，都拦截并上传到该待办
    e.preventDefault();
    const name = (hovered.querySelector('.todo-name') || {}).textContent || '';
    if (!name) return;
    pasteImageToTodo(name, file, hovered);
  }
  async function pasteImageToTodo(name, file, rowEl) {
    const err = validatePastedImage(file);
    if (err) { toast(err); return; }                   // 格式/大小不符：校验并提示
    // 打开处理面板：悬停待办 + 粘贴图片后弹出，可调参数后保存
    openImageProcessor(file, {
      name,
      onApply: async (src) => {
        await window.Storage.saveAsset('background', { name, src });
        focusLibrary('background');                   // 上传后切到背景库并刷新，立即显示新图
        showTodoPreview(rowEl, src);                   // 实时预览背景图效果
        toast('已粘贴上传「' + name + '」背景图');
        // 延迟刷新：先让用户看到预览，刷新后该项因已补齐而从待办消失
        setTimeout(() => refreshTodo(), 1600);
      },
      onSkip: () => {}
    });
  }
  function showTodoPreview(rowEl, src) {
    if (!rowEl) return;
    let pv = rowEl.querySelector('.todo-preview');
    if (!pv) {
      pv = document.createElement('div');
      pv.className = 'todo-preview';
      const actions = rowEl.querySelector('.todo-actions');
      if (actions) rowEl.insertBefore(pv, actions);
      else rowEl.appendChild(pv);
    }
    pv.innerHTML = '<img src="' + src + '" alt="背景预览"><span class="todo-preview-tag">已上传 <svg class="ico" aria-hidden="true"><use href="#ic-check"/></svg> 实时预览</span>';
    rowEl.classList.add('todo-done');
  }

  // 物品库待办：上传 GLB 场景包 JSON，模型以待办名入库（覆盖包内原名）
  async function importBundleAsTodo(file, todoName) {
    const text = await file.text();
    const json = JSON.parse(text);
    if (!json || json.schema !== 'glb-scene-bundle') throw new Error('不是 glb-scene-bundle 场景包');
    const models = json.models || [];
    if (!models.length) throw new Error('场景包里没有模型');
    let i = 0;
    for (const m of models) {
      const id = m.id || window.Storage.uid('itm');
      const name = models.length > 1 ? (todoName + (i ? ' (' + (i + 1) + ')' : '')) : todoName;
      const item = {
        id, name,
        glb: m.glb || '',
        exitMesh: m.exitMesh || (m.exitMeshes && m.exitMeshes[0]) || null,
        exitMeshes: m.exitMeshes || (m.exitMesh ? [m.exitMesh] : []),
        interactions: m.interactions || {},
        chains: m.chains || [],
        sounds: m.sounds || {},
        defaultView: m.defaultView || null,
        lockRotation: !!m.lockRotation,
        bg: m.bg || null,
      };
      await window.Storage.saveAsset('item', item);
      i++;
    }
    return models.length;
  }

  // ============ BBCode 工具栏 ============
  // 智能包裹：没选中→选中整行；已包裹→清除；相邻有标签→也清除
  // 对指令行（<>）会拦截一次防误操作
  let _warnTag = null, _warnTime = 0;
  function smartWrap(ta, open, close, placeholder) {
    const r = getRange(ta);
    let s = r.start, e = r.end;
    if (!(e > s)) {
      const val = ta.value, cur = s;
      s = val.lastIndexOf('\n', cur - 1) + 1;
      const le = val.indexOf('\n', cur);
      e = le === -1 ? val.length : le;
    }
    const sel = ta.value.slice(s, e);
    const before = ta.value.slice(0, s);
    const after = ta.value.slice(e);

    // 提取 tag 名（如 [color=#fff] → color, [b] → b）
    const tagName = open.match(/^\[([A-Za-z0-9_一-龥]+)/)[1];
    const openRe = new RegExp('\\[' + tagName + '(?:=[^\\]]*)?\\]$');
    const closeStr = '[/' + tagName + ']';

    // 情况1：选中文字本身已包裹 → 清除
    if (sel.startsWith(open) && sel.endsWith(close)) {
      const inner = sel.slice(open.length, sel.length - close.length);
      ta.value = before + inner + after;
      if (document.activeElement === ta) try { ta.setSelectionRange(s, s + inner.length); } catch (_) {}
      return true;
    }
    // 情况2：选中文字前后紧邻着标签 → 清除前后标签
    const beforeMatch = before.match(openRe);
    if (beforeMatch && after.trimLeft().startsWith(closeStr)) {
      const openLen = beforeMatch[0].length;
      const closeIdx = after.indexOf(closeStr);
      ta.value = before.slice(0, before.length - openLen) + sel + after.slice(closeIdx + closeStr.length);
      if (document.activeElement === ta) try { ta.setSelectionRange(s - openLen, s - openLen + sel.length); } catch (_) {}
      return true;
    }
    // 检测是否对指令行操作（标题除外）
    const trimmed = sel.trim();
    if (trimmed.startsWith('<') && trimmed.endsWith('>') && !trimmed.startsWith('<标题')) {
      const now = Date.now();
      if (_warnTag !== open || now - _warnTime > 3000) {
        _warnTag = open; _warnTime = now;
        toast('<svg class="ico" aria-hidden="true"><use href="#ic-alert"/></svg> 这是指令行，BBCode 不会生效。再点一次强制套用');
        return false;
      }
    }
    window.BBCode.wrapAtRange(ta, s, e, open, close, placeholder);
    return true;
  }
  // 浮动标题：<标题:文字> 是整行指令，不兼容 BBCode 的 smartWrap（后者假设标签以 [ 开头），单独处理
  function applyTitle(ta) {
    const r = getRange(ta);
    let s = r.start, e = r.end;
    if (!(e > s)) {
      const val = ta.value, cur = s;
      s = val.lastIndexOf('\n', cur - 1) + 1;
      const le = val.indexOf('\n', cur);
      e = le === -1 ? val.length : le;
    }
    const sel = ta.value.slice(s, e);
    const before = ta.value.slice(0, s);
    const after = ta.value.slice(e);
    const OPEN = '<标题:', CLOSE = '>';
    // 情况1：选中本身已是 <标题:X> → 去掉标题
    if (sel.startsWith(OPEN) && sel.endsWith(CLOSE)) {
      const inner = sel.slice(OPEN.length, sel.length - CLOSE.length);
      ta.value = before + inner + after;
      if (document.activeElement === ta) try { ta.setSelectionRange(s, s + inner.length); } catch (_) {}
      return;
    }
    // 情况2：前后紧邻着 <标题: 和 > → 去掉
    const bMatch = before.match(/<标题:[^>]*$/);
    if (bMatch && after.trimLeft().startsWith(CLOSE)) {
      const openLen = bMatch[0].length;
      const closeIdx = after.indexOf(CLOSE);
      ta.value = before.slice(0, before.length - openLen) + sel + after.slice(closeIdx + CLOSE.length);
      if (document.activeElement === ta) try { ta.setSelectionRange(s - openLen, s - openLen + sel.length); } catch (_) {}
      return;
    }
    // 套用：<标题:选中文字>
    ta.value = before + OPEN + sel + CLOSE + after;
    if (document.activeElement === ta) try { ta.setSelectionRange(s + OPEN.length, s + OPEN.length + sel.length); } catch (_) {}
  }
  // 分割线：<分割线:备注> 是整行结构指令，同时具备停顿功能（游戏中显示后等点击继续）
  function applyDivider(ta) {
    const r = getRange(ta);
    let s = r.start, e = r.end;
    if (!(e > s)) {
      const val = ta.value, cur = s;
      s = val.lastIndexOf('\n', cur - 1) + 1;
      const le = val.indexOf('\n', cur);
      e = le === -1 ? val.length : le;
    }
    const sel = ta.value.slice(s, e).trim();
    const before = ta.value.slice(0, s);
    const after = ta.value.slice(e);
    if (sel) {
      // 有选区：把选区文字当作备注
      const token = '<分割线:' + sel + '>';
      ta.value = before + token + after;
      if (document.activeElement === ta) try { ta.setSelectionRange(s, s + token.length); } catch (_) {}
      return;
    }
    // 无选区：插入独立一行，光标停在冒号后、> 之前，可直接写备注；留空即为普通横线
    const padBefore = (before && !before.endsWith('\n')) ? '\n' : '';
    const padAfter = (after && !after.startsWith('\n')) ? '\n' : '';
    const token = '<分割线:>';
    const pre = before + padBefore + token;
    const pos = pre.length - 1; // 停在 ':' 之后、'>' 之前
    ta.value = pre + padAfter + after;
    if (document.activeElement === ta) try { ta.setSelectionRange(pos, pos); } catch (_) {}
  }
  function bindBBCode() {
    document.querySelectorAll('.bbcode-btns .bb').forEach(btn => {
      btn.addEventListener('click', () => {
        const tag = btn.dataset.tag;
        if (!tag) return;
        const ta = storyText;
        if (!ta) return;
        const r = getRange(ta); // 基于实时选区或最近快照，不依赖焦点，移动端只读态可用
        const st = ta.scrollTop;
        if (tag === 'size') {
          const n = $('#bb-size').value || '24';
          $('#bb-size-val').textContent = n;
          if (!smartWrap(ta, '[size=' + n + ']', '[/size]', '文字')) { ta.scrollTop = st; return; }
        } else if (tag === 'left' || tag === 'center' || tag === 'right') {
          let s = r.start, e = r.end;
          if (!(e > s)) {
            const val = ta.value, cur = s;
            s = val.lastIndexOf('\n', cur - 1) + 1;
            const le = val.indexOf('\n', cur);
            e = le === -1 ? val.length : le;
          }
          let lineText = ta.value.slice(s, e);
          lineText = lineText.replace(/\[(left|center|right)\]|\[\/(left|center|right)\]/g, '');
          lineText = '[' + tag + ']' + lineText + '[/' + tag + ']';
          ta.value = ta.value.slice(0, s) + lineText + ta.value.slice(e);
          if (document.activeElement === ta) try { ta.setSelectionRange(s, s + lineText.length); } catch (_) {}
        } else if (tag === 'shadow' || tag === 'glow' || tag === 'highlight') {
          pendingEffectTag = tag;
          let s = r.start, e = r.end;
          if (!(e > s)) {
            const val = ta.value, cur = s;
            s = val.lastIndexOf('\n', cur - 1) + 1;
            const le = val.indexOf('\n', cur);
            e = le === -1 ? val.length : le;
            try { ta.setSelectionRange(s, e); } catch (_) {}
          }
          const pop = $('#color-pop');
          pop.classList.remove('hidden');
          $('#color-pop-input').focus();
          ta.scrollTop = st;
          return;
        } else if (tag === 'br') {
          window.BBCode.insertAtRange(ta, r.start, '[br]');
        } else {
          const m = { b: ['[b]', '[/b]'], i: ['[i]', '[/i]'], u: ['[u]', '[/u]'], s: ['[s]', '[/s]'], instant: ['[瞬显]', '[/瞬显]'] }[tag];
          if (m && !smartWrap(ta, m[0], m[1], '文字')) { ta.scrollTop = st; return; }
        }
        ta.scrollTop = st;
        commitEdit();
      });
    });
  }

  // ===== 常用色色板（6 格，可自定义；覆盖 色/阴影/发光/记号笔 四个工具）=====
  const CC_KEY = 'storyeditor:commonColors';
  const CC_DEFAULT = ['#ffffff', '#ff4d4f', '#ff7a45', '#ffb300', '#faad14', '#52c41a', '#13c2c2', '#1890ff', '#722ed1', '#b37feb', '#eb2f96', '#8c8c8c'];
  let commonColors = loadCommonColors();
  let ccEditIdx = -1;
  function loadCommonColors() {
    try {
      const raw = localStorage.getItem(CC_KEY);
      if (raw) {
        const a = JSON.parse(raw);
        if (Array.isArray(a)) {
          const clean = a.filter(c => /^#[0-9a-fA-F]{6}$/.test(c));
          if (clean.length === 12) return clean;            // 已是新格式
          if (clean.length === 6) return clean.concat(CC_DEFAULT.slice(6)); // 旧 6 色升级：保留自定义，补齐后 6 格默认
        }
      }
    } catch (e) {}
    return CC_DEFAULT.slice();
  }
  function saveCommonColors() { try { localStorage.setItem(CC_KEY, JSON.stringify(commonColors)); } catch (e) {} }
  function renderCommonColors() {
    const wrap = $('#common-colors');
    if (!wrap) return;
    wrap.innerHTML = '';
    commonColors.forEach((c, i) => {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'cc-swatch';
      sw.style.background = c;
      sw.title = '左键套用 ' + c + ' · 右键自定义';
      sw.addEventListener('click', (e) => { e.stopPropagation(); applyChosenColor(c); closeColorPop(); });
      sw.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        ccEditIdx = i;
        const ccEdit = $('#cc-edit-input');
        ccEdit.value = c;
        ccEdit.click();
      });
      wrap.appendChild(sw);
    });
  }
  function closeColorPop() { const p = $('#color-pop'); if (p) p.classList.add('hidden'); }
  // 套用某个颜色：特效标签走 [tag=color]，否则走 [color=color]
  function applyChosenColor(v) {
    const ta = storyText;
    const r = getRange(ta);
    const st = ta.scrollTop;
    if (pendingEffectTag) {
      let s = r.start, e = r.end;
      if (!(e > s)) {
        const val = ta.value, cur = s;
        s = val.lastIndexOf('\n', cur - 1) + 1;
        const le = val.indexOf('\n', cur);
        e = le === -1 ? val.length : le;
      }
      const labels = { shadow: '阴影文字', glow: '发光文字', highlight: '记号笔文字' };
      window.BBCode.wrapAtRange(ta, s, e, '[' + pendingEffectTag + '=' + v + ']', '[/' + pendingEffectTag + ']', labels[pendingEffectTag] || '文字');
      pendingEffectTag = null;
    } else {
      if (!smartWrap(ta, '[color=' + v + ']', '[/color]', '文字')) return;
    }
    ta.scrollTop = st;
    commitEdit();
  }

  // 选色弹层：点「色」弹出，确认（套用）在弹层内完成
  function bindColorPop() {
    const pop = $('#color-pop');
    const ci = $('#color-pop-input');
    const hex = $('#color-pop-hex');
    const open = () => { pop.classList.remove('hidden'); ci.focus(); };
    $('#bb-color-btn').addEventListener('click', (e) => { e.stopPropagation(); open(); });
    ci.addEventListener('input', () => { hex.value = ci.value; });
    hex.addEventListener('input', () => {
      let v = hex.value.trim();
      if (!v.startsWith('#')) v = '#' + v;
      if (/^#[0-9a-fA-F]{6}$/.test(v)) ci.value = v;
    });
    $('#color-pop-ok').addEventListener('click', (e) => {
      e.stopPropagation();
      let v = hex.value.trim();
      if (!/^#[0-9a-fA-F]{6}$/.test(v)) v = ci.value;
      applyChosenColor(v);
      closeColorPop();
    });
    $('#color-pop-cancel').addEventListener('click', (e) => { e.stopPropagation(); pendingEffectTag = null; closeColorPop(); });
    document.addEventListener('click', (e) => {
      if (!pop.classList.contains('hidden') && !pop.contains(e.target) && e.target !== $('#bb-color-btn') && !e.target.closest('#bbcode-float')) closeColorPop();
    });
    // 右键色板 → 自定义该格常用色（原生取色器 input 实时更新、change 关闭时收尾）
    const ccEdit = $('#cc-edit-input');
    const onCcEdit = () => {
      if (ccEditIdx < 0) return;
      commonColors[ccEditIdx] = ccEdit.value;
      saveCommonColors();
      renderCommonColors();
    };
    ccEdit.addEventListener('input', onCcEdit);
    ccEdit.addEventListener('change', () => { onCcEdit(); ccEditIdx = -1; });
  }

  // 浮动工具栏拖拽
  function bindBBCodeDrag() {
    const panel = $('#bbcode-float');
    const head = $('#bbcode-drag');
    if (!panel || !head) return;
    let dragging = false, startX, startY, initX, initY;
    head.addEventListener('pointerdown', (e) => {
      if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
      dragging = true; startX = e.clientX; startY = e.clientY;
      const r = panel.getBoundingClientRect();
      initX = r.left; initY = r.top;
      panel.style.width = r.width + 'px';   // 锁定宽度，避免拖动后收缩
      if (head.setPointerCapture) { try { head.setPointerCapture(e.pointerId); } catch (_) {} }
      e.preventDefault();
    });
    document.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const rect = panel.getBoundingClientRect();
      let nl = initX + e.clientX - startX;
      let nt = initY + e.clientY - startY;
      // 限制在视口内，避免拖出屏幕后丢失
      nl = Math.max(0, Math.min(nl, window.innerWidth - rect.width));
      nt = Math.max(0, Math.min(nt, window.innerHeight - rect.height));
      panel.style.left = nl + 'px';
      panel.style.top = nt + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    });
    document.addEventListener('pointerup', () => { dragging = false; });
    document.addEventListener('pointercancel', () => { dragging = false; });
  }

  // ============ 编译检查 ============
  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  // 预览 / 导出前的「编译」：返回问题列表 [{line,type:'error'|'warning',msg}]
  async function validateStory() {
    const issues = [];
    const assetNames = { background: new Set(), item: new Set(), overlay: new Set(), music: new Set(), sound: new Set() };
    for (const lib of ['background', 'item', 'overlay', 'music', 'sound']) {
      const arr = await window.Storage.getAllAssets(lib);
      arr.forEach(a => assetNames[lib].add((a.name || '').trim()));
    }
    const blockNames = new Set(window.Storage.listBlockNames());
    // 变量：变量库定义 + 正文 <变量:名=...> 赋值，二者并集为“已知变量”
    const definedVarNames = window.Storage.getVarNames();
    const varTypeMap = {};
    window.Storage.getVars().forEach(v => { const nm = (v.name || '').trim(); if (nm) varTypeMap[nm] = v.type; });
    const assignedVarNames = new Set();
    window.Storage.listBlockNames().forEach(nm => {
      const txt = window.Storage.getBlockText(nm) || '';
      (txt.match(/<变量:([\s\S]*?)>/g) || []).forEach(m => {
        const body = m.replace(/^<变量:/, '').replace(/>$/, '');
        body.split(';').forEach(seg => {
          const nm2 = seg.trim().match(/^[A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*/);
          if (nm2) assignedVarNames.add(nm2[0]);
        });
      });
    });
    const knownVars = new Set([...definedVarNames, ...assignedVarNames]);
    // 逐块校验（主剧情 + 其它剧情块）；块名作为前缀标注，便于定位
    const blocksToCheck = window.Storage.listBlockNames().map(nm => ({ name: nm, text: window.Storage.getBlockText(nm) || '' }));
    function pushIssue(prefix, n, type, msg) {
      issues.push({ line: n, type: type, msg: (prefix ? prefix + ' ' : '') + msg });
    }
    // 校验条件表达式：非空，且至少引用一个已定义变量
    function checkCond(prefix, n, condStr) {
      const c = (condStr || '').trim();
      if (!c) { pushIssue(prefix, n, 'error', '条件块/条件选项缺少条件表达式（如 <当:金币>=10>）'); return; }
      const toks = c.match(/[A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*/g) || [];
      const known = toks.filter(tk => knownVars.has(tk));
      if (!known.length) pushIssue(prefix, n, 'warning', '条件「' + c + '」似乎没有引用任何已定义的变量');
    }
    const reOpt = /<选项:\s*"([^"]*)"\s*(?:,\s*([^>]*?))?\s*>/g;
    for (const blk of blocksToCheck) {
      const prefix = blk.name === MAIN_BLOCK ? '' : ('【' + blk.name + '】');
      let whenDepth = 0;
      const lines = blk.text.split(/\r?\n/);
      lines.forEach((raw, i) => {
        const n = i + 1;
        if (/^\s*\/\//.test(raw)) return;
        const t = raw.trim();
        if (!t) return;
        // 变量引用 {名} / {名:真|假}
        const refMatches = raw.match(/\{[^{}]+\}/g);
        if (refMatches) {
          refMatches.forEach(r => {
            let inner = r.slice(1, -1).trim();
            let vname = inner, disp = false;
            const ci = inner.indexOf(':');
            if (ci >= 0) { vname = inner.slice(0, ci).trim(); disp = true; }
            if (!vname) return;
            if (!knownVars.has(vname)) pushIssue(prefix, n, 'warning', '未定义的变量「' + vname + '」（请在素材库·变量库定义，或用 <变量:' + vname + '=值> 赋值）');
            else if (disp && varTypeMap[vname] && varTypeMap[vname] !== 'boolean') pushIssue(prefix, n, 'warning', '显示映射 {' + vname + ':真|假} 仅用于布尔变量');
          });
        }
        // 条件块 <当:>/</当>/<否则> 嵌套计数
        if (/^<当:[\s\S]*>$/.test(t)) {
          whenDepth++;
        } else if (t === '</当>') {
          if (whenDepth <= 0) pushIssue(prefix, n, 'error', '</当> 没有对应的 <当:> 条件块');
          else whenDepth--;
        } else if (t === '<否则>') {
          if (whenDepth <= 0) pushIssue(prefix, n, 'error', '<否则> 必须写在 <当:> 条件块内部');
        }
        if (t.includes('<') && !t.includes('>')) {
          pushIssue(prefix, n, 'error', '「<」没有对应的「>」（指令未闭合，指令用尖括号）');
          return;
        }
        // 指令标签内嵌套标签检测：如 <当:<选项:...>>、<召唤背景:<变量:金币>> 等（两个「<」之间不含「>」即视为嵌套）
        if (/<[^>]*<[^>]*>/.test(t) && /<(召唤|选项|当|否则|变量|停顿|标题|分割线|剧情块|对话块|跳回|跳回重选|停止音乐)/.test(t)) {
          pushIssue(prefix, n, 'error', '指令标签内部不应再嵌套另一个尖括号标签（发现「<> 内嵌套 <>」，请把内层指令拆到独立一行）');
          return;
        }
        if (raw.includes('[') && !raw.includes(']')) {
          pushIssue(prefix, n, 'error', '「[」没有对应的「]」（BBCode 未闭合）');
          return;
        }
        // 主剧情块不允许使用 <跳回> / <跳回重选>（它们用于从分支剧情块返回/重选）
        if (blk.name === MAIN_BLOCK && (t === '<跳回>' || t === '<跳回重选>')) {
          pushIssue(prefix, n, 'error', '不应在主剧情块使用<跳回>或者<跳回重选>');
          return;
        }
        const afterCmd = t.match(/^(<(?:召唤(?:背景|物品|音乐|音效|叠层):[^>]*>|<分割线(?::[^>]*)?>|停顿(?::\s*\d+)?>|<(?:对话块|剧情块):[^>]*>|<跳回>|<跳回重选>))\s*(\S[\s\S]*)$/);
        if (afterCmd) {
          pushIssue(prefix, n, 'error', '指令「' + afterCmd[1] + '」后方不应跟文字（如需文字请另起一行）');
          return;
        }
        if (t.startsWith('<') && t.endsWith('>')) {
          if ((raw.includes('[') || raw.includes(']')) && !t.match(RE_TITLE)) {
            pushIssue(prefix, n, 'error', '指令段（<>）内不可嵌套 BBCode（[]），请将 BBCode 放在指令行外');
            return;
          }
          let m;
          if (t.startsWith('<停顿')) {
            if ((m = t.match(RE_PAUSE))) {
              if (m[1] != null && !/^\d+$/.test(m[1])) pushIssue(prefix, n, 'error', '停顿时间必须是数字（毫秒），例如 <停顿:2000>');
            } else pushIssue(prefix, n, 'error', '停顿指令格式不正确（如 <停顿> 或 <停顿:2000>）');
          } else if ((m = t.match(/^<召唤([^:<>]+):(.*)>$/))) {
            const cn = m[1];
            const kind = CN_TO_KIND[cn];
            let name = m[2].trim();
            if (kind === 'item') { const hm = name.match(/^(.*?),\s*"(.*)"\s*$/); if (hm) name = hm[1].trim(); }
            if (!kind) pushIssue(prefix, n, 'error', '未知召唤类型：' + cn + '（应为 背景/物品/叠层/音乐/音效）');
            else if (!name) pushIssue(prefix, n, 'error', '召唤名称不能为空，例如 <召唤' + cn + ':名称>');
            else if (!assetNames[kind].has(name)) pushIssue(prefix, n, 'warning', '未找到名为「' + name + '」的' + cn + '，召唤可能无效');
          } else if (t.match(RE_DIVIDER)) {
            // 分割线：合法
          } else if (t.startsWith('<对话块') || t.startsWith('<剧情块')) {
            const bm = t.match(RE_BLOCK);
            if (!bm) pushIssue(prefix, n, 'error', '剧情块指令格式不正确（如 <剧情块:名称>）');
            else if (!bm[1].trim()) pushIssue(prefix, n, 'error', '剧情块名称不能为空（如 <剧情块:名称>）');
            else if (!blockNames.has(bm[1].trim())) pushIssue(prefix, n, 'warning', '未找到名为「' + bm[1].trim() + '」的剧情块，跳转可能无效');
          } else if (t.indexOf('<选项:') >= 0) {
            const opts = []; let om;
            reOpt.lastIndex = 0;
            while ((om = reOpt.exec(t)) !== null) opts.push(om);
            if (!opts.length) pushIssue(prefix, n, 'error', '选项指令格式不正确（如 <选项:"文字"> 或 <选项:"文字",块名>）');
            else {
              if (opts.length > 6) pushIssue(prefix, n, 'error', '一行最多放置 6 个选项，当前 ' + opts.length + ' 个');
              for (const o of opts) {
                const bn = (o[2] && o[2].trim()) || '';
                if (bn === MAIN_BLOCK) pushIssue(prefix, n, 'warning', '不建议选项跳到主剧情块');
                else if (bn && !blockNames.has(bn)) pushIssue(prefix, n, 'warning', '选项指向的剧情块「' + bn + '」未找到，点击可能无效');
                // 条件选项：<选项:"文字",块名,条件:金币>=20>
                const extra = (o[2] || '').trim();
                if (extra) {
                  const ci = extra.indexOf('条件:');
                  if (ci >= 0) {
                    const cond = extra.slice(ci + 3).trim().replace(/,$/, '');
                    checkCond(prefix, n, cond);
                  }
                }
              }
            }
          } else if (t === '<跳回>') {
            // 跳回：合法（主剧情块已在前面报错）
          } else if (t === '<跳回重选>') {
            // 跳回重选：合法（主剧情块已在前面报错）
          } else if (t.startsWith('<召唤')) {
            pushIssue(prefix, n, 'warning', '召唤指令格式可能不正确（检查冒号与名称，如 <召唤背景:天空>）');
          } else if (t.match(RE_TITLE)) {
            // 标题指令：合法
          } else if (t === '<停止音乐>') {
            // 停止音乐：合法
          } else if ((m = t.match(/^<当:([\s\S]*)>$/))) {
            checkCond(prefix, n, m[1]);
          } else if (t === '</当>') {
            // 嵌套计数已在前面处理
          } else if (t === '<否则>') {
            // 嵌套计数已在前面处理
          } else if (t.startsWith('<变量')) {
            const vm = t.match(/^<变量:([\s\S]*)>$/);
            if (!vm) pushIssue(prefix, n, 'error', '变量指令格式不正确（如 <变量:金币=10> 或 <变量:金币-3>）');
            else {
              vm[1].split(';').forEach(seg => {
                const s = seg.trim();
                if (!s) return;
                if (!/^[A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*\s*([=+\-]\s*[^\s]+)?$/.test(s)) {
                  pushIssue(prefix, n, 'error', '变量指令片段「' + s + '」格式不正确（应为 名=值 / 名+n / 名-n）');
                }
              });
            }
          } else {
            pushIssue(prefix, n, 'error', '无法识别的指令「' + t + '」（识别的指令：停顿/召唤/剧情块/选项/跳回/跳回重选）');
          }
        }
        if (t.startsWith('[') && t.endsWith(']') && !/^\[(?:b|i|u|s|color=|size=|center|left|right|br|shadow=|glow=|highlight=)[\]\=]/.test(t) && !/\[\/(?:b|i|u|s|color|size|center|left|right|shadow|glow|highlight)\]/.test(t)) {
          pushIssue(prefix, n, 'error', '无法识别的方括号指令「' + t + '」（BBCode 请用 []，指令请用 <>）');
        }
      });
      // BBCode 配对（逐块）
      const checkText = blk.text;
      const single = ['b', 'i', 'u', 's', 'center', 'left', 'right'];
      for (const tag of single) {
        const open = (checkText.match(new RegExp('\\[' + tag + '\\]', 'g')) || []).length;
        const close = (checkText.match(new RegExp('\\[/' + tag + '\\]', 'g')) || []).length;
        if (open !== close) pushIssue(prefix, 0, 'warning', 'BBCode [' + tag + '] 与 [/]' + tag + ' 数量不一致（' + open + ' 开 / ' + close + ' 闭）');
      }
      for (const tag of ['color', 'size', 'shadow', 'glow', 'highlight']) {
        const open = (checkText.match(new RegExp('\\[' + tag + '=', 'g')) || []).length;
        const close = (checkText.match(new RegExp('\\[/' + tag + '\\]', 'g')) || []).length;
        if (open !== close) pushIssue(prefix, 0, 'warning', 'BBCode [' + tag + '=…] 与 [/]' + tag + ' 数量不一致（' + open + ' 开 / ' + close + ' 闭）');
      }
      if (whenDepth > 0) pushIssue(prefix, 0, 'error', '有 <当:> 条件块未闭合（缺少 </当>）');
    }
    return issues;
  }
  // 把光标定位到指定行行首，并尽量滚入视野
  function gotoLine(lineNo) {
    if (!lineNo || lineNo < 1) return;
    const lines = storyText.value.split('\n');
    if (lineNo > lines.length) return;
    let pos = 0;
    for (let i = 0; i < lineNo - 1 && i < lines.length; i++) pos += lines[i].length + 1;
    const end = pos + (lines[lineNo - 1] ? lines[lineNo - 1].length : 0);
    storyText.focus();
    storyText.setSelectionRange(pos, end);
    const lh = parseFloat(getComputedStyle(storyText).lineHeight) || 22;
    const target = (lineNo - 1) * lh;
    storyText.scrollTop = Math.max(0, target - storyText.clientHeight / 2 + lh);
  }
  // 仅把指定行滚入视野（不移动光标、不抢焦点），用于编译检查提示：
  // 保留「定位到问题」的可读性，但不像 gotoLine 那样把用户光标拽走。
  function scrollToLine(lineNo) {
    if (!lineNo || lineNo < 1) return;
    const lines = storyText.value.split(/\r?\n/);
    if (lineNo > lines.length) return;
    const lh = parseFloat(getComputedStyle(storyText).lineHeight) || 22;
    const pt = parseFloat(getComputedStyle(storyText).paddingTop) || 0;
    const target = (lineNo - 1) * lh + pt;
    storyText.scrollTop = Math.max(0, target - storyText.clientHeight / 2 + lh);
  }
  // ============ 行号槽（极淡灰，编译报错时帮助定位行） ============
  // 行号与 textarea 的逻辑行 1:1 对应；每行高度/顶部内边距取自 textarea 计算样式，保证数字正对每行。
  // 仅当行数变化时重建 DOM（打字过程中不重建），并与 textarea 纵向滚动同步。
  function syncGutterScroll() {
    if (lnGutter && storyText) lnGutter.scrollTop = storyText.scrollTop;
  }
  function buildLineNumbers() {
    if (!lnGutter || !storyText || editorTextWrap.classList.contains('hidden')) return;
    const lines = storyText.value.split('\n').length;
    if (lines === lastLnCount && lnGutter.dataset.built === '1') { syncGutterScroll(); return; }
    lastLnCount = lines;
    let html = '';
    for (let i = 1; i <= lines; i++) html += '<div class="ln-line">' + i + '</div>';
    lnGutter.innerHTML = html;
    lnGutter.dataset.built = '1';
    const cs = getComputedStyle(storyText);
    const lh = parseFloat(cs.lineHeight) || 22;
    lnGutter.style.paddingTop = (parseFloat(cs.paddingTop) || 0) + 'px';
    lnGutter.style.paddingBottom = (parseFloat(cs.paddingBottom) || 0) + 'px';
    const lineEls = lnGutter.children;
    for (let i = 0; i < lineEls.length; i++) { lineEls[i].style.height = lh + 'px'; lineEls[i].style.lineHeight = lh + 'px'; }
    syncGutterScroll();
  }
  function scheduleLineNumbers() {
    clearTimeout(lnTimer);
    lnTimer = setTimeout(buildLineNumbers, 120);
  }
  // 导航（大纲）：读取 // 与 /// 注释；/// 作为更大层级（大标题）展示
  function scheduleOutline() {
    clearTimeout(outlineTimer);
    outlineTimer = setTimeout(renderOutline, 150);
  }
  function renderOutline() {
    const box = $('#outline-list');
    if (!box) return;
    const lines = storyText.value.split(/\r?\n/);
    const items = [];
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      let level = -1, label = '';
      const m3 = raw.match(/^\s*\/\/\/(.*)$/);          // /// 大层级
      if (m3) { level = 1; label = m3[1].trim(); }
      else if (/^\s*\/\//.test(raw)) { level = 0; label = raw.replace(/^\s*\/\//, '').trim(); }
      else continue;
      if (!label) label = '(空注释)';
      items.push({ line: i + 1, level: level, label: label });
    }
    if (!items.length) {
      box.innerHTML = '<div class="outline-empty">用 // 写注释可在此导航<br>/// 为大标题（更大层级）</div>';
      return;
    }
    box.innerHTML = '';
    items.forEach(it => {
      const el = document.createElement('div');
      el.className = 'outline-item' + (it.level === 1 ? ' section' : '');
      el.textContent = (it.level === 1 ? '▪ ' : '· ') + it.label;
      el.title = '跳到第 ' + it.line + ' 行';
      el.addEventListener('click', () => {
        // 纯预览态下先切回编辑态，再定位
        if (previewMode && !splitMode) setPreviewMode(false);
        gotoLine(it.line);
        // 竖屏浮动面板：点选某块后自动缩回
        if (document.body.classList.contains('portrait')) outlineCol.classList.remove('portrait-open');
      });
      box.appendChild(el);
    });
  }
  let pendingAction = null; // 校验不通过时，用户点「仍要执行」要跑的动作
  // 在编辑器底部红字条列出问题，并把光标跳到第一个出错行
  function showCompileBar(issues, action) {
    pendingAction = action;
    const bar = $('#compile-bar');
    const list = $('#compile-list');
    const title = $('#compile-title');
    const errCount = issues.filter(i => i.type === 'error').length;
    const warnCount = issues.length - errCount;
    title.innerHTML = (errCount ? '<b style="color:#ff6677"><svg class="ico" aria-hidden="true"><use href="#ic-alert"/></svg> ' + errCount + ' 个错误</b>' : '')
      + (errCount && warnCount ? ' &nbsp;' : '')
      + (warnCount ? '<b style="color:#f0b429"><svg class="ico" aria-hidden="true"><use href="#ic-alert"/></svg> ' + warnCount + ' 个提醒</b>' : '');
    list.innerHTML = '';
    issues.forEach(it => {
      const div = document.createElement('div');
      div.className = 'cissue ' + it.type;
      const hasLine = !!it.line;
      div.title = hasLine ? ('点击跳到第 ' + it.line + ' 行') : '该问题未绑定到具体行';
      const loc = hasLine ? ('第 ' + it.line + ' 行：') : '';
      div.innerHTML = '<span class="cissue-msg">' + escapeHtml(loc + it.msg) + '</span>'
        + (hasLine ? '<span class="cissue-jump" aria-hidden="true"><svg class="ico"><use href="#ic-corner-up-left"/></svg></span>' : '');
      if (hasLine) {
        div.addEventListener('click', () => {
          if (previewMode && !splitMode) setPreviewMode(false); // 确保在纯文本编辑视图里能看到这行
          gotoLine(it.line);
        });
      }
      list.appendChild(div);
    });
    bar.classList.remove('hidden');
    const target = issues.find(i => i.line > 0);
    // 仅滚动到第一个问题行（不抢焦点、不移动用户光标），避免编辑时光标被重置到开头
    if (target) scrollToLine(target.line);
    updateErrorHighlights(issues);
  }
  function hideCompileBar() {
    $('#compile-bar').classList.add('hidden');
    updateErrorHighlights([]);
  }
  function updateErrorHighlights(issues) {
    const ta = storyText;
    const errorLines = issues.filter(i => i.type === 'error' && i.line > 0).map(i => i.line);
    if (!errorLines.length) {
      ta.style.backgroundImage = '';
      ta.style.backgroundAttachment = '';
      return;
    }
    const style = getComputedStyle(ta);
    const lh = parseFloat(style.lineHeight) || 30;
    const pt = parseFloat(style.paddingTop) || 20;
    const stops = [];
    errorLines.forEach(line => {
      const yTop = pt + (line - 1) * lh;
      const yBot = yTop + lh - 1;
      stops.push('transparent ' + yTop + 'px');
      stops.push('rgba(255,80,90,0.10) ' + yTop + 'px');
      stops.push('rgba(255,80,90,0.10) ' + yBot + 'px');
      stops.push('transparent ' + yBot + 'px');
    });
    ta.style.backgroundAttachment = 'local';
    ta.style.backgroundImage = 'linear-gradient(to bottom, ' + stops.join(',') + ')';
  }
  function doExport(mode) {
    if (mode === 'backup') { exportProjectBackup(window.Storage.getCurrentProjectId()); return; }
    if (mode === 'single') window.Exporter.exportSingleHTML().then(() => toast('已导出单 HTML'));
    else window.Exporter.exportZip().then(() => toast('已导出标准结构 zip'));
  }

  // ============ 工程备份 / 恢复（跨设备搬运整个剧本） ============
  // 触发浏览器下载一段文本/JSON
  function downloadBlob(filename, content, mime) {
    const blob = new Blob([content], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // 导出某个项目的完整备份（含素材/变量/线索/设定），不含 AI Key
  async function exportProjectBackup(pid) {
    pid = pid || window.Storage.getCurrentProjectId();
    if (!pid) { toast('没有可备份的项目'); return; }
    try {
      const data = await window.Storage.exportProject(pid);
      const safe = (data.projectName || 'project').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
      const ts = new Date().toISOString().slice(0, 10);
      downloadBlob('剧情工程_' + safe + '_' + ts + '.json', JSON.stringify(data, null, 2), 'application/json');
      toast('工程备份已导出（含素材/变量/线索）');
    } catch (e) {
      toast('导出失败：' + ((e && e.message) || e));
    }
  }

  // 从文件导入工程备份：新建独立项目，不与本机现有项目冲突
  async function importProjectBackup(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const newId = await window.Storage.importProject(json, { name: ((json.projectName || '导入项目') + '（备份）') });
      toast('工程已导入：' + (json.projectName || '未命名'));
      renderProjectsScreen();
    } catch (e) {
      toast('导入失败：' + ((e && e.message) || e));
    }
  }

  // ============ 预览 ============
  async function openPreview() {
    saveNow();
    const issues = await validateStory();
    if (issues.length) { showCompileBar(issues, reallyOpenPreview); return; }
    reallyOpenPreview();
  }
  async function reallyOpenPreview() {
    const modal = $('#preview-modal');
    modal.classList.remove('hidden');
    const frame = $('#preview-frame');
    frame.srcdoc = '<div style="color:#9aa3b2;padding:40px;font-family:sans-serif">生成预览中…</div>';
    try {
      const html = await window.Exporter.buildPreviewHTML(null);
      frame.srcdoc = html;
    } catch (e) {
      frame.srcdoc = '<div style="color:#ff6677;padding:40px">预览生成失败：' + (e.message || e) + '</div>';
    }
  }

  // ============ 保存 ============
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 400);
  }
  function saveNow() {
    window.Storage.setBlockText(activeBlock, text);
    const existing = window.Storage.loadMeta() || {};
    window.Storage.saveMeta(existing);
  }

  // ============ 撤销 / 重做 ============
  // textarea 被 JS 改写（BBCode 包裹、拖拽插入）会清空浏览器原生撤销栈，
  // 这里自管一个栈，让所有修改都可撤销 / 重做。
  function pushHistory() {
    const snap = { text: storyText.value, selStart: storyText.selectionStart, selEnd: storyText.selectionEnd };
    const top = history[histIndex];
    if (top && top.text === snap.text) { top.selStart = snap.selStart; top.selEnd = snap.selEnd; return; }
    history = history.slice(0, histIndex + 1);
    history.push(snap);
    if (history.length > 300) history.shift();
    histIndex = history.length - 1;
    updateUndoButtons();
  }
  // 程序化修改统一走这里：写值 + 入栈 + 保存
  // 字数统计：统计「叙事正文」字符数，排除 [] <> {} 及其内部内容（含嵌套，如 <<剧情块>>）
  // 注意：条件表达式里的 >= / <= 运算符含 > <，会被当成括号闭合而多计其后少数字符，属可接受的近似误差。
  function countNarrativeChars(text) {
    const opens = { '[': ']', '<': '>', '{': '}' };
    const closes = { ']': '[', '>': '<', '}': '{' };
    const stack = [];
    let count = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (opens[ch]) stack.push(ch);
      else if (closes[ch]) {
        if (stack.length && stack[stack.length - 1] === closes[ch]) stack.pop();
      } else if (stack.length === 0 && !/\s/.test(ch)) {
        count++;
      }
    }
    return count;
  }
  function updateWordCount() {
    const el = document.getElementById('word-count');
    if (!el) return;
    el.textContent = '总字数：' + countNarrativeChars(storyText.value);
  }
  function commitEdit() {
    clearTimeout(histTimer);
    text = storyText.value;
    pushHistory();
    scheduleSave();
    scheduleOutline();
    updateWordCount();
  }
  function restoreSnap(snap) {
    storyText.value = snap.text;
    text = snap.text;
    updateWordCount();
    // 仅当文本框本来就是焦点时恢复焦点；从页面其它位置撤销时不抢焦点，避免唤起输入法/软键盘
    if (document.activeElement === storyText) storyText.focus();
    try { storyText.setSelectionRange(snap.selStart, snap.selEnd); } catch (e) {}
    scheduleSave();
    scheduleOutline();
  }
  function undo() {
    clearTimeout(histTimer);
    // 若当前有尚未入栈的修改（打字 debounce 未触发），先把它提交为栈顶，再退一步
    if (storyText.value !== (history[histIndex] && history[histIndex].text)) pushHistory();
    if (histIndex <= 0) return;
    histIndex--;
    restoreSnap(history[histIndex]);
    updateUndoButtons();
  }
  function redo() {
    clearTimeout(histTimer);
    if (histIndex >= history.length - 1) return;
    histIndex++;
    restoreSnap(history[histIndex]);
    updateUndoButtons();
  }
  function updateUndoButtons() {
    const u = $('#btn-undo'); const r = $('#btn-redo');
    if (u) u.disabled = !(histIndex > 0);
    if (r) r.disabled = !(histIndex < history.length - 1);
  }

  // ============ 工具 ============
  let toastTimer = null;
  function toast(msg) {
    let t = $('#toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#fff;color:#171717;padding:10px 18px;border-radius:10px;border:1px solid #ebebeb;box-shadow:0 8px 30px rgba(0,0,0,.14);z-index:200;font-size:13px;'; document.body.appendChild(t); }
    t.textContent = msg; t.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.style.display = 'none'; }, 1800);
  }

  // ============ AI 编剧 ============
  let aiReviewCtx = null;   // 当前审阅上下文（接受/再改改复用）
  let aiReviewMode = null;

  // 创作设定存于 meta.creation（独立字段，不进运行时 DATA，故不泄露到导出成品）
  function loadCreation() {
    const meta = window.Storage.loadMeta() || {};
    const raw = meta.creation || { outline: '', intro: '', world: '', tone: '' };
    // 兼容旧字段名 tone（已更名为 style）
    return {
      outline: raw.outline || '',
      intro: raw.intro || '',
      world: raw.world || '',
      style: raw.style || raw.tone || '',
      clues: raw.clues || '',
      clueExtractChars: (typeof raw.clueExtractChars === 'number') ? raw.clueExtractChars : null,
      clueCorpus: raw.clueCorpus || {},
      reviews: Array.isArray(raw.reviews) ? raw.reviews : [],
    };
  }
  function saveCreation(c) {
    const meta = window.Storage.loadMeta() || {};
    meta.creation = c;
    window.Storage.saveMeta(meta);
  }

  // ============ 试玩审阅（review） ============
  // 审阅记录：{ id, block(块名), snippet(被审阅的原文片段), opinion(修改意见), createdAt }
  // 存于 meta.creation.reviews（不进运行时 DATA，不泄露到导出成品）。
  function loadReviews() { return loadCreation().reviews || []; }
  function saveReviews(arr) { const c = loadCreation(); c.reviews = arr; saveCreation(c); }
  function blockHasReview(block) { return loadReviews().some(r => r.block === block); }
  function addReview(block, snippet, opinion) {
    const arr = loadReviews();
    const r = { id: 'rv_' + Date.now() + '_' + Math.floor(Math.random() * 1e4), block: block, snippet: (snippet || '').slice(0, 200), opinion: opinion || '', createdAt: Date.now() };
    arr.push(r);
    saveReviews(arr);
    renderReviewPanel();
    refreshBlockReviewLine();
    refreshReviewToggleBadge();
    return r;
  }
  function deleteReview(id) {
    saveReviews(loadReviews().filter(r => r.id !== id));
    renderReviewPanel();
    refreshBlockReviewLine();
    refreshReviewToggleBadge();
  }
  function refreshReviewToggleBadge() {
    // AI 审阅建议以 <审阅:N> 标记形式存于正文，其对应记录（kind:'ai'）不再重复计入，避免「记录数 + 标记数」翻倍。
    // 角标 = 人工审阅记录（非 'ai'，即试玩里记的意见）+ 各块正文里的 <审阅:N> 标记数，与右侧面板实际卡片数一致。
    let n = loadReviews().filter(function (r) { return r.kind !== 'ai'; }).length;
    try {
      window.Storage.listBlockNames().forEach(function (nm) {
        const t = (nm === activeBlock) ? storyText.value : (window.Storage.getBlockText(nm) || '');
        n += getReviewMarkers(t).length;
      });
    } catch (e) {}
    const badge = $('#review-toggle-badge');
    if (badge) { badge.textContent = n; badge.hidden = n === 0; }
  }
  // 主编辑器：当前块有审阅时，文本框下方显示一条红色波浪线
  function refreshBlockReviewLine() {
    const el = $('#block-review-line');
    if (!el) return;
    const on = blockHasReview(activeBlock) || getReviewMarkers(storyText.value).length > 0;
    el.classList.toggle('on', on);
  }
  // 渲染右侧审阅面板
  function renderReviewPanel() {
    const wrap = $('#review-list');
    if (!wrap) return;
    const arr = loadReviews();
    // 清理当前块里已无标记的 AI 建议（避免孤儿条目）
    const liveN = new Set(getReviewMarkers(storyText.value).map(function (m) { return m.n; }));
    const stale = arr.filter(function (r) { return r.kind === 'ai' && r.block === activeBlock && !liveN.has(r.n); });
    if (stale.length) {
      const kill = new Set(stale.map(function (r) { return r.id; }));
      saveReviews(arr.filter(function (r) { return !kill.has(r.id); }));
    }
    const fresh = loadReviews();
    const playtest = fresh.filter(function (r) { return r.kind !== 'ai'; });
    const markers = getReviewMarkers(storyText.value);
    const unanchored = fresh.filter(function (r) { return r.kind === 'ai_unanchored' && r.block === activeBlock; });
    if (!playtest.length && !markers.length && !unanchored.length) {
      wrap.innerHTML = '<div class="review-empty">还没有审阅记录。<br>点试玩顶栏的「审阅」，边玩边记修改意见；或在全文助理里让 AI 出修改意见，确认「加入审阅」后自动生成 <审阅:N> 标记与替换建议。</div>';
      return;
    }
    let html = '';
    // ---- 试玩审阅（人工意见）----
    if (playtest.length) {
      const blocks = {};
      playtest.forEach(function (r) { (blocks[r.block] = blocks[r.block] || []).push(r); });
      Object.keys(blocks).forEach(function (bk) {
        html += '<div class="review-block-group"><div class="review-block-name">' + escapeHtml(bk) + '</div>';
        blocks[bk].forEach(function (r) {
          const time = new Date(r.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
          const snip = r.snippet ? escapeHtml(r.snippet) : '<span class="review-no-snip">（当前显示内容为空）</span>';
          html += '<div class="review-card" data-id="' + r.id + '">'
            + '<div class="review-snippet jump-target" data-jump="playtest" data-id="' + r.id + '" data-block="' + escapeHtml(r.block) + '" title="点击定位到该段剧情">' + snip + '</div>'
            + '<div class="review-opinion">' + escapeHtml(r.opinion || '') + '</div>'
            + '<div class="review-meta"><span>' + time + '</span>'
            + '<span class="review-actions">'
            + '<button class="review-del" data-id="' + r.id + '" title="删除">删除</button>'
            + '</span></div></div>';
        });
        html += '</div>';
      });
    }
    // ---- AI 审视（<审阅:N> 标记，按标记锚定，手动改文不漂移）----
    if (markers.length) {
      html += '<div class="review-ai-head">AI 审视 · 当前块《' + escapeHtml(activeBlock) + '》'
        + '<button id="review-clear-markers" class="btn btn-ghost btn-sm" type="button" title="移除本块所有 <审阅:N> 标记（保留内部文字）">清除标记</button></div>';
      const aiMap = {};
      fresh.filter(function (r) { return r.kind === 'ai' && r.block === activeBlock; }).forEach(function (r) { aiMap[r.n] = r; });
      markers.forEach(function (m) {
        const r = aiMap[m.n];
        const suggestion = r ? (r.text || '') : '';
        const applied = r ? !!r.applied : false;
        html += '<div class="review-card review-ai-card' + (applied ? ' applied' : '') + '" data-n="' + m.n + '">'
          + '<div class="review-line-badge">审阅 ' + m.n + (applied ? '<span class="review-applied-tag">已应用</span>' : '') + '</div>'
          + '<div class="review-edit-text">' + escapeHtml(m.inner) + '</div>'
          + (suggestion
              ? ('<div class="review-suggestion"><div class="review-suggestion-label">建议替换为：</div>' + escapeHtml(suggestion) + '</div>')
              : '<div class="review-suggestion review-suggestion-empty">（AI 暂未给出替换建议；在全文助理里描述如何修改此段即可生成）</div>')
          + '<div class="review-meta"><span>标记 ' + m.n + '</span>'
          + '<span class="review-actions">'
          + (suggestion && !applied ? '<button class="review-apply" data-n="' + m.n + '" title="用建议替换标记内部文字">应用</button>' : '')
          + '<button class="review-del" data-n="' + m.n + '" title="移除该标记（保留内部文字）">删除</button>'
          + '</span></div></div>';
      });
    }
    if (unanchored.length) {
      html += '<div class="review-ai-head">AI 建议 · 未锚定（未能自动定位，请手动修改）</div>';
      unanchored.forEach(function (u) {
        html += '<div class="review-card review-unanchored-card" data-id="' + u.id + '">'
          + '<div class="review-line-badge">未锚定建议</div>'
          + '<div class="review-edit-text jump-target" data-jump="unanchored" data-id="' + u.id + '" title="点击在正文搜索该片段">' + escapeHtml(u.current || '(空)') + '</div>'
          + (u.suggestion ? '<div class="review-suggestion"><div class="review-suggestion-label">建议：</div>' + escapeHtml(u.suggestion) + '</div>' : '')
          + '<div class="review-meta"><span>需手动定位</span><span class="review-actions">'
          + '<button class="review-un-del" data-id="' + u.id + '" title="删除该建议">删除</button>'
          + '</span></div></div>';
      });
    }
    wrap.innerHTML = html;
    wrap.querySelectorAll('.review-del').forEach(function (b) { b.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (b.dataset.n != null && b.dataset.n !== '') deleteAiReview(parseInt(b.dataset.n, 10));
      else deleteReview(b.dataset.id);
    }); });
    // 点审阅段落文字 → 跳转/定位（不再有独立「跳转/定位」按钮）
    wrap.querySelectorAll('.jump-target').forEach(function (el) {
      el.addEventListener('click', function (ev) {
        ev.stopPropagation();
        const mode = el.dataset.jump;
        if (mode === 'playtest') {
          const id = el.dataset.id;
          const block = el.dataset.block;
          const r = loadReviews().find(function (x) { return x.id === id; });
          const snippet = r ? (r.snippet || '') : '';
          if (block && block !== activeBlock) switchBlock(block);
          if (snippet) locateSnippetText(snippet);
          else if (!block || block === activeBlock) updateBlockChip();
        } else if (mode === 'unanchored') {
          locateUnanchored(el.dataset.id);
        }
      });
    });
    wrap.querySelectorAll('.review-apply').forEach(function (b) { b.addEventListener('click', function (ev) { ev.stopPropagation(); applyAiReview(parseInt(b.dataset.n, 10)); }); });
    wrap.querySelectorAll('.review-ai-card').forEach(function (card) {
      card.addEventListener('click', function (ev) {
        if (ev.target.closest('button')) return;
        const n = parseInt(card.dataset.n, 10);
        if (!isNaN(n)) locateReviewMarker(n);
      });
    });
    wrap.querySelectorAll('.review-un-del').forEach(function (b) { b.addEventListener('click', function (ev) { ev.stopPropagation(); deleteUnanchoredReview(b.dataset.id); }); });
    const clearBtn = wrap.querySelector('#review-clear-markers');
    if (clearBtn) clearBtn.addEventListener('click', function (ev) { ev.stopPropagation(); clearBlockMarkers(); });
  }
  // 试玩中点击「审阅」：向 iframe 取当前块名+文字，再弹输入框
  let _pendingReview = null;
  // 试玩手动审阅：抓取原文只取「首行」作为锚点。整段文字（两个暂停之间的一整段）无换行时
  // 当成一个超长串去定位容易与正文对不上（变量插值/标点/内部换行差异都会让长串整体失配），
  // 取首行短锚点能稳定命中正文对应那一行。
  function firstLineAnchor(text) {
    if (!text) return '';
    const raw = (text + '').replace(/^\s+|\s+$/g, '');
    if (!raw) return '';
    const firstLine = raw.split(/\r?\n/)[0];
    // 首行若仍过长（整段无换行时首行即整段），截断到适合单行的长度
    return firstLine.length > 80 ? firstLine.slice(0, 80) : firstLine;
  }
  function requestReviewContext() {
    const frame = document.getElementById('preview-frame');
    if (!frame || !frame.contentWindow) { toast('请先开始试玩'); return; }
    let got = false;
    const onCtx = function (ev) {
      if (ev.data && ev.data.type === 'review-context') {
        got = true; window.removeEventListener('message', onCtx);
        openReviewInput(ev.data.block, firstLineAnchor(ev.data.text || ''));
      }
    };
    window.addEventListener('message', onCtx);
    try { frame.contentWindow.postMessage({ type: 'get-review-context' }, '*'); } catch (e) {}
    // 兜底：同源 srcdoc 直接调用
    setTimeout(function () {
      if (got) return;
      try {
        const ctx = frame.contentWindow && frame.contentWindow.__storyReviewContext && frame.contentWindow.__storyReviewContext();
        if (ctx) { got = true; window.removeEventListener('message', onCtx); openReviewInput(ctx.block, firstLineAnchor(ctx.text || '')); }
      } catch (e) {}
    }, 250);
    setTimeout(function () { if (!got) { window.removeEventListener('message', onCtx); toast('未能获取试玩中的剧情，请稍后再试'); } }, 1500);
  }
  function openReviewInput(block, snippet) {
    _pendingReview = { block: block || activeBlock, snippet: snippet || '' };
    const bEl = $('#review-input-block'); if (bEl) bEl.textContent = _pendingReview.block;
    const cEl = $('#review-input-context'); if (cEl) cEl.innerHTML = _pendingReview.snippet ? escapeHtml(_pendingReview.snippet) : '<span class="review-no-snip">（当前显示内容为空）</span>';
    const tEl = $('#review-input-text'); if (tEl) { tEl.value = ''; tEl.focus(); }
    const m = $('#review-input-modal'); if (m) m.classList.remove('hidden');
  }
  function closeReviewInput() { _pendingReview = null; const m = $('#review-input-modal'); if (m) m.classList.add('hidden'); }
  function saveReviewInput() {
    if (!_pendingReview) return;
    const tEl = $('#review-input-text');
    const opinion = tEl ? tEl.value.trim() : '';
    if (!opinion) { toast('请先输入修改意见'); if (tEl) tEl.focus(); return; }
    addReview(_pendingReview.block, _pendingReview.snippet, opinion);
    closeReviewInput();
    // 自动展开审阅右栏并高亮新卡片
    const col = $('#review-col'); if (col && col.classList.contains('hidden')) col.classList.remove('hidden');
    const list = $('#review-list');
    if (list) { const cards = list.querySelectorAll('.review-card'); if (cards.length) { cards[cards.length - 1].classList.add('flash'); setTimeout(function(){ if (cards[cards.length-1]) cards[cards.length-1].classList.remove('flash'); }, 1200); } }
    toast('已记录审阅');
  }

  // ============ 背景提示词生成（素材待办「💡 提示词」按钮） ============
  // 每个背景素材生成一次即缓存到 meta.assetPrompts[name]，再点不重复生成（除非「重新生成」）
  let bgpName = null;      // 当前处理的背景素材名
  let bgpCtxText = '';     // 当前召唤处上下文缓存
  let bgpParams = { ratio: 'landscape', style: '3d', lighting: 'dim-indoor', composition: 'long', lens: 'none', special: '' }; // 用户选择的画面预设参数
  function loadAssetPrompts() {
    const meta = window.Storage.loadMeta() || {};
    return meta.assetPrompts || {};
  }
  function saveAssetPrompt(name, text) {
    const meta = window.Storage.loadMeta() || {};
    meta.assetPrompts = meta.assetPrompts || {};
    if (text == null || text === '') delete meta.assetPrompts[name];
    else meta.assetPrompts[name] = text;
    window.Storage.saveMeta(meta);
  }
  function getCachedPrompt(name) {
    const p = loadAssetPrompts();
    return (p && p[name]) || '';
  }
  // 记忆「补充画面参数」上一次填的内容（跨素材、跨开关持久化，避免每次重开都要重填）
  const BGP_LAST_KEY = 'story-editor:bgprompt:lastParams';
  function loadLastBgParams() {
    try {
      const raw = localStorage.getItem(BGP_LAST_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw) || {};
      return {
        ratio: o.ratio || 'landscape',
        style: o.style || '3d',
        lighting: o.lighting || 'dim-indoor',
        composition: o.composition || 'long',
        lens: (o.lens != null ? o.lens : 'none'),
        special: o.special || '',
      };
    } catch (e) { return null; }
  }
  function saveLastBgParams(p) {
    try {
      localStorage.setItem(BGP_LAST_KEY, JSON.stringify({
        ratio: (p && p.ratio) || 'landscape',
        style: (p && p.style) || '3d',
        lighting: (p && p.lighting) || 'dim-indoor',
        composition: (p && p.composition) || 'long',
        lens: (p && p.lens != null ? p.lens : 'none'),
        special: (p && p.special) || '',
      }));
    } catch (e) { /* 隐私模式等忽略 */ }
  }
  // 收集某背景素材在剧情中「召唤处」上下各 15 行内容（跨所有剧情块，取首次出现，去注释与空行）
  function collectBgContext(name) {
    const names = window.Storage.listBlockNames();
    for (const bn of names) {
      const raw = (window.Storage.getBlockText(bn) || '').split(/\r?\n/);
      const lines = raw.filter(l => !/^\s*\/\//.test(l)); // 去注释行
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].trim().match(RE_SUMMON);
        if (m && CN_TO_KIND[m[1]] === 'background' && (m[2] || '').trim() === name) {
          const from = Math.max(0, i - 15);
          const to = Math.min(lines.length, i + 16); // 含召唤行本身 + 后 15 行
          return lines.slice(from, to).map(l => l.replace(/\s+$/, '')).filter(l => l.trim() !== '').join('\n');
        }
      }
    }
    return '';
  }
  function setBgpStatus(msg, cls) {
    const el = $('#bgp-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'ai-status' + (cls ? ' ' + cls : '');
  }
  // 三态：preview（生成按钮）/ generating（旋转）/ result（结果文本框 + 操作按钮）
  function setBgpPhase(phase) {
    $('#bgp-start').classList.toggle('hidden', phase !== 'preview');
    $('#bgp-spinner').classList.toggle('hidden', phase !== 'generating');
    $('#bgp-text').classList.toggle('hidden', phase === 'preview' || phase === 'generating');
    document.querySelectorAll('#bgp-actions .btn').forEach(b => b.classList.toggle('hidden', phase !== 'result'));
  }
  function openBgPromptModal(name) {
    if (!window.AI) return;
    const settings = window.AI.loadSettings();
    if (!settings.key) { toast('请先在「设置 → AI 编剧 → 模型与密钥」填写 Deepseek API Key'); openSettings('ai'); return; }
    bgpName = name;
    bgpCtxText = collectBgContext(name);
    // 记忆上一次选的画面预设（跨素材持久化），重开窗口自动回填
    const lastP = loadLastBgParams() || {};
    const ratio = lastP.ratio || 'landscape';
    const style = lastP.style || '3d';
    const lighting = lastP.lighting || 'dim-indoor';
    const composition = lastP.composition || 'long';
    const lens = (lastP.lens != null ? lastP.lens : 'none');
    const special = lastP.special || '';
    bgpParams = { ratio, style, lighting, composition, lens, special };
    // 下拉框若存的是旧版自由文本（不匹配选项），保持默认首项
    const setSel = (id, val) => { const el = document.getElementById(id); if (el && el.querySelector('option[value="' + val + '"]')) el.value = val; };
    setSel('bgp-ratio', ratio);
    setSel('bgp-style', style);
    setSel('bgp-lighting', lighting);
    setSel('bgp-composition', composition);
    setSel('bgp-lens', lens);
    $('#bgp-special').value = special;
    const c = loadCreation();
    const cLines = [
      c.intro ? ('简介：' + c.intro) : '',
      c.outline ? ('大纲：' + c.outline) : '',
      c.world ? ('世界观：' + c.world) : '',
      c.style ? ('文风：' + c.style) : '',
    ].filter(Boolean);
    $('#bgp-creation').textContent = cLines.length ? cLines.join('\n') : '（未填写创作设定，AI 将主要依据上下文揣摩）';
    $('#bgp-context').textContent = bgpCtxText || '（未在剧情中找到该背景的召唤处，AI 将仅依据素材名与设定揣摩）';
    $('#bgp-title').textContent = '背景提示词 · ' + name;
    setBgpStatus('');
    $('#bg-prompt-modal').classList.remove('hidden');
    const cached = getCachedPrompt(name);
    if (cached) {
      $('#bgp-text').value = cached;
      setBgpStatus('已有缓存提示词（可编辑；点「重新生成」重新揣摩）', '');
      setBgpPhase('result');
    } else {
      $('#bgp-text').value = '';
      setBgpPhase('preview');
    }
  }
  function closeBgPromptModal() {
    // 关闭前把当前文本框内容存回缓存（保留用户手动编辑）
    if (bgpName) {
      const v = ($('#bgp-text').value || '').trim();
      if (v) saveAssetPrompt(bgpName, v);
      // 记忆本次画面预设（上一次选的内容），供下次重开窗口自动回填
      saveLastBgParams({
        ratio: $('#bgp-ratio').value,
        style: $('#bgp-style').value,
        lighting: $('#bgp-lighting').value,
        composition: $('#bgp-composition').value,
        lens: $('#bgp-lens').value,
        special: ($('#bgp-special').value || '').trim(),
      });
    }
    $('#bg-prompt-modal').classList.add('hidden');
    bgpName = null;
    refreshTodo(); // 刷新待办按钮的 <svg class="ico" aria-hidden="true"><use href="#ic-check"/></svg> 标记
  }

  // ============ 全文助理（对话式 AI，一次喂全文、持续对话、可全文改写） ============
  let ftStarted = false;
  let ftBusy = false;
  let ftThinking = false; // 思考模式：开则 AI 先推理再答（更准、更慢、更费 token），关闭则轻量直答
  try { ftThinking = localStorage.getItem('fta-thinking') === '1'; } catch (e) {}
  let ftEditMode = false;  // 是否处于「局部修改当前块」模式
  let ftPendingOps = null; // AI 最近一次给出的待确认审阅提案 {map,wraps}，用户发「确认」时直接应用，避免再次调 AI 生成全文
  let ftMessages = [];   // [{role:'system'|'user'|'assistant', content}]
  const FT_SYSTEM = [
    '你是一个贴身「全文助理」，服务于一位正在写作的创作者。',
    '创作者已经把作品的【全文、大纲、简介、世界观、文风、关键线索】一次性提供给你（作为隐藏上下文），你随时可以引用，不必用户重复粘贴。',
    '你的职责：',
    '1. 就这部作品与创作者自然对话——回答关于情节、人物、设定、伏笔、节奏的问题；给修改建议；讨论写法。',
    '2. 【唯一】允许输出【完整全文】的情形：用户明确说出「全文改写 / 改写全文」之类的整篇改写指令（即要把整部作品重写一遍、交付一份完整的新版正文）。此时只输出改写后正文，不要解释、不要包裹、不要 markdown 代码块；若作品是互动剧情，保留原有的 <<剧情块:名称>> 分块标记与 <跳回>/<跳回重选> 跳转标记，只改写其中的文字。注意：「润色全文」≠「改写全文」——它指读取已有全文后，只润色其中需要改进的地方，仍走规则 6 的审阅标记工具（逐处提案），【禁止】为「润色全文」输出完整全文。除此之外，任何情况下都【禁止】输出作品的完整全文或大幅重写（会让界面卡顿、毫无意义，且破坏审阅流程）。',
    '3. 默认用中文回答，语气自然、像编辑搭档；回答要具体、贴着作品内容，不要编造作品里没有的情节或人物。',
    '4. 只有在规则 2 的整篇改写指令下才输出完整全文；其它任何请求（局部修改、单段润色、按用户意见调整、用户说「可以/好的/应用」确认改动等）都【不得】输出全文或改写后的整段文稿。',
    '5. 简短交流即可，除非用户要求详细；不要主动复述全文，更不要输出任何被改写后的整篇/整段文稿。',
    '6. 【协作修改的唯一途径：审阅标记工具】当用户提出任何局部修改/改进/审视/找问题/润色片段（包括「改一下」「写得更紧张」「润色这段」「出修改意见」，或你主动发现可改进处），你必须按如下「标记锚定」方式工作（行号会因手动改文漂移，标记随文本走不会漂移）：',
    '   a. 用一两句自然语言说明修改思路（简明即可）；',
    '   b. 紧接着【只输出】审阅提案 JSON（放 ```json 代码块或裸 JSON），二选一：',
    '      - 替换已有标记：{"N":"新内容", ...}（N 为已有 <审阅:N> 的序号，只替换该标记内部文字，务必保留 <审阅:N> 标签本身不动）；',
    '      - 新增标记：[{"current":"需要改进的原文（逐字照搬，可含换行）","suggestion":"改进后的文字"}, ...]（系统把 current 用 <审阅:M>…</审阅> 包裹并放入右侧审阅面板，M 自动编号）。',
    '   c. current 必须逐字照搬原文（含标点、换行），不得改动 <召唤…>/<<剧情块>>/<跳回>/<停顿>/<选项> 等结构标签；用户没指定位置时，主动发现当前块 2-4 处可改点（节奏、冗余、平直、缺感官等）并提案。为提高多段修改的定位准确率：current 应连带其前后各一句相邻的唯一文字（避免与别处重复文字混淆导致系统定位错乱）；多段修改时每条 current 必须各自唯一可定位；若你对措辞做了改写，原文务必进 current、改写进 suggestion，二者不可混。',
    '   d. 【绝对禁止】在这一步输出被改写的整段或整篇全文——只给 JSON 提案即可；你输出的审阅提案会被系统自动加入右侧审阅面板，无需用户手动复制。',
    '7. 当用户回复「确认 / 可以 / 好的 / 行 / 采纳 / 应用建议 / apply / ok」等确认语，且你上一轮已给出待确认提案时：你【什么都不用做】——系统会自动把提案用 <审阅:N> 标记写入正文、进审阅面板。若你仍收到此类消息，只回一句极短的话（如「已加入审阅面板」），绝不输出任何全文或改写稿。每次给出提案后，也用一句话提示用户「回复『确认』即可插入审阅面板（也提供了『加入审阅』按钮）」。',
  ].join('\n');
  function ftaCollectFullText() {
    if (window.StoryEditorApi && window.StoryEditorApi.listBlockNames) {
      const names = window.StoryEditorApi.listBlockNames();
      const blocks = names.map(n => (window.StoryEditorApi.getBlockText(n) || ''));
      return blocks.join('\n\n');
    }
    return (window.StoryEditorApi && window.StoryEditorApi.getText) ? window.StoryEditorApi.getText() : '';
  }
  function ftaBuildContext() {
    const c = loadCreation();
    const parts = [];
    const full = ftaCollectFullText();
    parts.push('【作品全文】\n' + (full && full.trim() ? full : '（为空）'));
    if (c.outline) parts.push('【大纲】\n' + c.outline);
    if (c.intro) parts.push('【简介】\n' + c.intro);
    if (c.world) parts.push('【世界观】\n' + c.world);
    if (c.style) parts.push('【文风】\n' + c.style);
    if (c.clues) parts.push('【关键线索】\n' + c.clues);
    // 当前正在编辑的剧情块（纯文本，含可能已有的 <审阅:N> 标记），供「审视/修改当前块」按标记序号引用
    try {
      const blkName = (typeof activeBlock !== 'undefined' && activeBlock) ? activeBlock : '主剧情';
      const blkText = (typeof storyText !== 'undefined' && storyText) ? storyText.value : '';
      if (blkText && blkText.trim()) {
        parts.push('【当前编辑块《' + blkName + '》全文（文本中可能已含 <审阅:N>…</审阅> 标记，N 为序号、可跨多行；你可按序号引用，或新增标记。已用标记锚定，不要使用行号）】\n' + blkText);
      }
    } catch (e) {}
    return parts.join('\n\n');
  }
  let ftBubbleSeq = 1;
  function ftNewId() { return 'm' + (Date.now().toString(36)) + '_' + (ftBubbleSeq++); }
  // 聊天记录持久化（像工程一样保存，刷新不丢，避免重复喂全文/复述浪费 token）
  function ftHistoryKey() {
    // 用真实工程 id 作 key：每个工程独立存历史（之前误用 loadMeta().id，而 meta 从不存 id，
    // 导致所有工程共用 fta-history:default，既不独立、又会在切工程时被互相覆盖）。
    let pid = 'default';
    try { const id = window.Storage && window.Storage.getCurrentProjectId && window.Storage.getCurrentProjectId(); if (id) pid = id; } catch (e) {}
    return 'fta-history:' + pid;
  }
  function ftSaveHistory() {
    try {
      const turns = ftMessages.filter(m => m && m._id).map(m => ({ role: m.role, content: m.content, _id: m._id }));
      localStorage.setItem(ftHistoryKey(), JSON.stringify(turns));
    } catch (e) {}
  }
  function ftLoadHistory() {
    try {
      const key = ftHistoryKey();
      let raw = localStorage.getItem(key);
      if (!raw) {
        // 兼容升级：旧版本所有工程共用 fta-history:default，迁移到当前工程的独立 key（一次性），旧数据不丢
        const legacy = localStorage.getItem('fta-history:default');
        if (legacy) { localStorage.setItem(key, legacy); localStorage.removeItem('fta-history:default'); raw = legacy; }
      }
      if (!raw) return [];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string');
    } catch (e) { return []; }
  }
  // 切换工程时调用：重置全文助理会话态，使其按工程独立。
  // 旧工程的对话此前已逐条 ftSaveHistory 落盘到 fta-history:<旧id>，不会丢失；
  // 重置后下次打开面板会 ftStart 从「本工程 key」重新加载，避免上一工程的内存残留串进新工程。
  function ftResetSession() {
    ftSessionGen++;   // 使正在进行的 AI 请求遗留回调失效，避免切工程时的中止残留在 catch 里覆盖已落盘历史
    // 若有进行中的 AI 请求，先中止，避免旧工程的回复写回新工程
    if (ftAbortCtrl) { try { ftAbortCtrl.abort(); } catch (e) {} ftAbortCtrl = null; }
    ftStopping = false;
    ftStarted = false;
    ftMessages = [];
    const box = $('#fta-messages');
    if (box) box.innerHTML = '';
    const startWrap = $('#fta-start-wrap');
    if (startWrap) startWrap.classList.remove('hidden');
    const inputRow = $('#fta-input-row');
    if (inputRow) inputRow.classList.add('hidden');
    const actions = $('#fta-actions');
    if (actions) actions.classList.add('hidden');
  }
  function ftaAppendBubble(role, text, mid) {
    const box = $('#fta-messages');
    const el = document.createElement('div');
    el.className = 'fta-msg ' + (role === 'user' ? 'user' : 'assistant');
    el.textContent = text || '';
    box.appendChild(el);
    if (mid) attachBubbleMid(el, mid);
    box.scrollTop = box.scrollHeight;
    return el;
  }
  function attachBubbleMid(el, mid) {
    if (!el || el.dataset.mid) return;
    el.dataset.mid = mid;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fta-del';
    btn.title = '删除这条（从对话与上下文中移除）';
    btn.setAttribute('aria-label', '删除这条消息');
    btn.textContent = '×';
    btn.addEventListener('click', function (e) { e.stopPropagation(); ftDeleteBubble(mid); });
    el.appendChild(btn);
  }
  function ftDeleteBubble(mid) {
    const idx = ftMessages.findIndex(m => m && m._id === mid);
    if (idx >= 2) ftMessages.splice(idx, 1);   // 系统两条(persona + 隐藏上下文)永不被删
    const el = document.querySelector('[data-mid="' + (mid || '').replace(/"/g, '\\"') + '"]');
    if (el) el.remove();
    ftSaveHistory();
  }
  function openFulltextAssistant() {
    if (!window.AI) return;
    const settings = window.AI.loadSettings();
    if (!settings.key) { toast('请先在「设置 → AI 编剧 → 模型与密钥」填写 Deepseek API Key'); openSettings('ai'); return; }
    $('#fulltext-assistant').classList.remove('hidden');
    $('#fta-start-wrap').classList.toggle('hidden', ftStarted);
    $('#fta-input-row').classList.toggle('hidden', !ftStarted);
    $('#fta-actions').classList.toggle('hidden', !ftStarted);
    if (ftStarted) $('#fta-messages').scrollTop = $('#fta-messages').scrollHeight;
    else if (ftLoadHistory().length) {
      // 有历史聊天记录：自动恢复（像工程一样保留，刷新不丢），无需再点「启动」
      ftStart();
    }
  }
  function ftStart() {
    ftSessionGen++;   // 新会话：使上一会话遗留的异步回调失效，避免写回旧历史
    if (ftStarted) return;
    ftStarted = true;
    const seed = $('#fta-messages');
    seed.innerHTML = '';
    const turns = ftLoadHistory();
    ftMessages = [
      { role: 'system', content: FT_SYSTEM },
      { role: 'system', content: '【以下为隐藏上下文，仅供你参考，不要原样复述给用户】\n' + ftaBuildContext() },
    ];
    if (turns.length) {
      // 还原历史对话气泡（含每条的删除键）
      turns.forEach(function (t) {
        const mid = t._id || ftNewId();
        ftMessages.push({ role: t.role, content: t.content, _id: mid });
        ftaAppendBubble(t.role, t.content, mid);
      });
    } else {
      ftaAppendBubble('assistant', '已加载你的全文与创作设定，随时和我聊剧情、人物、写法。');
    }
    $('#fta-start-wrap').classList.add('hidden');
    $('#fta-input-row').classList.remove('hidden');
    $('#fta-actions').classList.remove('hidden');
    $('#fta-input').focus();
  }
  let ftAbortCtrl = null;   // 当前 AI 调用的 AbortController（用于「停止」）
  let ftStopping = false;   // 标记本次结束是用户手动停止（catch 里据此区分 AbortError 与真实错误）
  let ftSessionGen = 0;     // 会话代次：切工程/重开会话时自增，使遗留的异步回调失效、不写回旧历史（防 re-entry 丢上下文）
  function ftStop() {
    if (!ftBusy || !ftAbortCtrl) return;
    ftStopping = true;
    try { ftAbortCtrl.abort(); } catch (e) {}
  }
  function ftSetBusy(on) {
    ftBusy = on;
    const send = $('#fta-send');
    $('#fta-refeed').disabled = on;
    $('#fta-input').disabled = on;
    if ($('#fta-thinking')) $('#fta-thinking').disabled = on;
    if (send) {
      if (on) { // 进入生成：发送按钮变成「停止」，可点击中止
        send.textContent = '停止';
        send.classList.add('fta-stop');
        send.disabled = false;
        send.title = '停止 AI 输出';
      } else {  // 恢复「发送」
        send.textContent = '发送';
        send.classList.remove('fta-stop');
        send.disabled = false;
        send.title = '';
      }
    }
    $('#fta-refeed').disabled = on;
    $('#fta-input').disabled = on;
    if ($('#fta-thinking')) $('#fta-thinking').disabled = on;
  }
  function ftSend() {
    if (ftBusy || !ftStarted) return;
    const myGen = ftSessionGen;   // 本次请求所属会话代次，回调里比对失效则放弃写回，避免覆盖历史
    const ta = $('#fta-input');
    const text = (ta.value || '').trim();
    if (!text) return;
    ta.value = '';
    // 确认意图拦截：用户发「确认/采纳/应用建议」等，直接把 AI 刚才的待确认提案插入审阅面板，
    // 不再调用 AI（避免 AI 把整篇改好的全文吐回对话框造成卡顿），也不会重新生成全文。
    if (ftIsConfirmIntent(text)) {
      const uMid = ftNewId();
      ftaAppendBubble('user', text, uMid);
      ftMessages.push({ role: 'user', content: text, _id: uMid });
      const b = ftaAppendBubble('assistant', '');
      const aMid = ftNewId();
      if (ftPendingOps) {
        const r = ftApplyReviewOps(ftPendingOps);
        if (r.ok) {
          b.textContent = '✓ 已确认并加入审阅面板（' + r.upd + ' 处替换、' + r.added + ' 处新增标记' + (r.unanchored ? ('、' + r.unanchored + ' 处未能自动定位，见右侧面板「未锚定建议」人工处理') : '') + '），到右侧审阅面板逐条「应用」。已进入审阅模式。';
          ftMessages.push({ role: 'assistant', content: '（已确认 AI 审阅建议并加入审阅面板）', _id: aMid });
        } else {
          b.textContent = 'AI 的建议没匹配上现有标记或原文片段，未做改动。可先点「重采上下文」让 AI 重新出建议。';
          ftMessages.push({ role: 'assistant', content: '（确认失败：建议未匹配）', _id: aMid });
        }
        ftPendingOps = null;
      } else {
        b.textContent = '当前没有待确认的 AI 审阅建议（可能已应用或已过期）。可让 AI「出几处修改意见」，它会列出建议并提示你发「确认」来插入审阅。';
        ftMessages.push({ role: 'assistant', content: '（无待确认建议）', _id: aMid });
      }
      attachBubbleMid(b, aMid); ftSaveHistory();
      $('#fta-messages').scrollTop = $('#fta-messages').scrollHeight;
      ftSetBusy(false); $('#fta-input').focus();
      return;
    }
    let userContent = text;
    if (ftEditMode) {
      const blkName = (typeof activeBlock !== 'undefined' && activeBlock) ? activeBlock : '主剧情';
      userContent = '【修改《' + blkName + '》中的 <审阅:N> 标记】' + text + '\n若需替换某个已有 <审阅:N> 标记内部内容，输出 JSON 对象 {"N":"新内容",...}（N 为已有标记序号，保留标签）；若要新增需审视的片段，输出 JSON 数组 [{"current":"原句","suggestion":"新句"}]。只输出 JSON（可放 ```json 代码块），不要其它解释。';
    }
    const uMid = ftNewId();
    ftaAppendBubble('user', text, uMid);
    ftMessages.push({ role: 'user', content: userContent, _id: uMid });
    const aMid = ftNewId();
    const bubble = ftaAppendBubble('assistant', '');
    ftSetBusy(true);
    // 普通对话发起前用最新全文刷新隐藏上下文，确保 AI 拿到的「当前编辑块」是最新的，提升审阅提案匹配率
    if (ftMessages.length >= 2 && ftMessages[1] && ftMessages[1].role === 'system') {
      ftMessages[1].content = '【以下为隐藏上下文，仅供你参考，不要原样复述给用户】\n' + ftaBuildContext();
    }
    const messages = ftMessages.slice();
    ftAbortCtrl = new AbortController();
    if (ftThinking) { bubble.textContent = '（思考中…）'; bubble._thinking = true; }
    window.AI.callDeepseek(messages, {
      stream: true, thinking: ftThinking, signal: ftAbortCtrl.signal,
      onToken: (d) => ftStreamAppend(bubble, d),
      onStatus: () => {},
    }).then(full => {
      if (myGen !== ftSessionGen) return;   // 会话已切走（切工程/重开），丢弃这次迟到的回复，不写回旧历史
      full = full || '';
      // 审视/修改模式：解析 {N:"新内容"} 或 [{current,suggestion}]，按标记锚定写入审阅面板
      const ops = ftExtractReviewOps(full);
      const hasOps = Object.keys(ops.map).length > 0 || ops.wraps.length > 0;
      if (hasOps) {
        // 不直接改文：先展示建议 + 确认按钮，用户点「加入审阅」后才写标记并进审阅模式
        const prose = ftStripEditsFromText(full);
        const total = Object.keys(ops.map).length + ops.wraps.length;
        bubble.textContent = (prose ? prose + '\n\n' : '');
        const note = document.createElement('div');
        note.className = 'fta-confirm';
        const tip = document.createElement('div');
        tip.className = 'fta-confirm-tip';
        ftPendingOps = { map: Object.assign({}, ops.map), wraps: ops.wraps.slice() };
        tip.textContent = 'AI 给出 ' + total + ' 处审阅建议。点「加入审阅」或在对话框发送「确认」即可把它们插入审阅面板（用 <审阅:N> 标记写入正文，不会重新生成全文）：';
        const bar = document.createElement('div');
        bar.className = 'fta-confirm-bar';
        const okBtn = document.createElement('button');
        okBtn.type = 'button'; okBtn.className = 'btn btn-primary'; okBtn.textContent = '加入审阅';
        const noBtn = document.createElement('button');
        noBtn.type = 'button'; noBtn.className = 'btn'; noBtn.textContent = '仅看建议';
        okBtn.addEventListener('click', function () {
          const r = ftApplyReviewOps(ftPendingOps);
          if (r.ok) {
            note.outerHTML = '✓ 已加入审阅面板（' + r.upd + ' 处替换、' + r.added + ' 处新增标记' + (r.unanchored ? ('、' + r.unanchored + ' 处未能自动定位，见右侧面板「未锚定建议」人工处理') : '') + '），到右侧审阅面板逐条「应用」（标记随文本走，手动改文也不会错位）。';
            toast('已进入审阅模式');
          } else {
            note.outerHTML = 'AI 给出了建议，但没匹配上现有标记或原文片段；请确认序号或原文是否已被改动（可点「重采上下文」刷新）。';
          }
          ftPendingOps = null;
        });
        noBtn.addEventListener('click', function () { note.outerHTML = '（已保留原文，仅展示建议）'; ftPendingOps = null; });
        bar.appendChild(okBtn); bar.appendChild(noBtn);
        note.appendChild(tip); note.appendChild(bar);
        bubble.appendChild(note);
        ftMessages.push({ role: 'assistant', content: prose || '（给出审阅建议，待确认。回复「确认」即可插入审阅）', _id: aMid });
        attachBubbleMid(bubble, aMid); ftSaveHistory();
      } else {
        // 兜底：AI 没按约定给审阅提案、却输出了整篇/大幅文稿——直接拦截（卡顿且无意义），提示改走审阅标记
        if (ftIsFullTextDump(full)) {
          bubble.textContent = '⚠️ 已自动阻止 AI 输出整篇文稿（会造成卡顿且无意义）。请让它用「审阅标记」方式给修改：例如说「出几处修改意见」，它会列出建议并提示你发「确认」插入右侧审阅面板。';
          ftMessages.push({ role: 'assistant', content: '（系统已阻止 AI 输出全文，提示用户改用审阅标记方式）', _id: aMid });
          attachBubbleMid(bubble, aMid); ftSaveHistory();
        } else {
          bubble.textContent = full;
          ftMessages.push({ role: 'assistant', content: full, _id: aMid });
          attachBubbleMid(bubble, aMid); ftSaveHistory();
        }
        ftPendingOps = null;
      }
      $('#fta-messages').scrollTop = $('#fta-messages').scrollHeight;
    }).catch(err => {
      if (myGen !== ftSessionGen) return;   // 会话已切走，连「手动停止/出错」的兜底保存也跳过，绝不覆盖已落盘历史
      if (err && (err.name === 'AbortError' || ftStopping)) {
        if (bubble._thinking) { bubble.textContent = '（已手动停止）'; bubble._thinking = false; }
        else {
          const partial = (bubble.textContent || '').trim();
          bubble.textContent = (partial ? partial + '\n\n' : '') + '（已手动停止）';
        }
        bubble.classList.remove('fta-typing');
        ftMessages.push({ role: 'assistant', content: bubble.textContent, _id: aMid });
        attachBubbleMid(bubble, aMid); ftSaveHistory();
        ftStopping = false; ftAbortCtrl = null;
        return;
      }
      bubble.textContent = '出错：' + (err && err.message ? err.message : err);
      bubble.classList.add('fta-typing');
      if (ftEditMode) { ftEditMode = false; const ta2 = $('#fta-input'); if (ta2) ta2.placeholder = '和助理聊一句…（Enter 发送，Shift+Enter 换行）'; }
    }).then(() => { ftSetBusy(false); $('#fta-input').focus(); });
  }
  function ftRefeed() {
    if (!ftStarted) { toast('请先启动全文助理'); return; }
    if (ftMessages.length >= 2 && ftMessages[1].role === 'system') {
      ftMessages[1].content = '【以下为隐藏上下文，仅供你参考，不要原样复述给用户】\n' + ftaBuildContext();
    } else {
      ftMessages.splice(1, 0, { role: 'system', content: '【以下为隐藏上下文，仅供你参考，不要原样复述给用户】\n' + ftaBuildContext() });
    }
    toast('已用最新全文更新上下文');
  }
  function ftClear() {
    ftMessages = ftMessages.slice(0, 2); // 仅保留 system 两条（persona + 隐藏上下文）
    $('#fta-messages').innerHTML = '';
    ftaAppendBubble('assistant', '对话已清空，上下文仍在。继续聊吧。');
    ftSaveHistory(); // 同步清空持久化记录
  }
  // ---- 全文助理「审视/修改当前块」：用 <审阅:N> 标记锚定，AI 改动直接替换标记内部 ----
  function ftaEnterReview() {
    if (!ftStarted) { toast('请先启动全文助理'); return; }
    const myGen = ftSessionGen;   // 本次请求所属会话代次，回调里比对失效则放弃写回，避免覆盖历史
    const blkName = (typeof activeBlock !== 'undefined' && activeBlock) ? activeBlock : '主剧情';
    // 刷新隐藏上下文，确保含最新「当前块全文（含已有标记）」
    if (ftMessages.length >= 2 && ftMessages[1] && ftMessages[1].role === 'system') {
      ftMessages[1].content = '【以下为隐藏上下文，仅供你参考，不要原样复述给用户】\n' + ftaBuildContext();
    } else {
      ftMessages.splice(1, 0, { role: 'system', content: '【以下为隐藏上下文，仅供你参考，不要原样复述给用户】\n' + ftaBuildContext() });
    }
    // 若当前块已存在 <审阅:N> 标记，则直接进入「修改模式」，不再重新包裹（避免破坏已有标记）
    if (getReviewMarkers(storyText.value).length > 0) {
      ftEditMode = true;
      ftaAppendBubble('assistant', '当前块已存在审阅标记（审阅 1…' + maxReviewN(storyText.value) + '）。直接描述你想怎么改，例如：\n· 把审阅 2 写得更紧张\n· 删掉审阅 3 的标记\n· 再找几处问题（我会新增标记）\n我会按 <审阅:N> 序号给出替换建议，放进右侧审阅面板，你逐条「应用」即可。');
      const ta = $('#fta-input');
      if (ta) { ta.placeholder = '描述对《' + blkName + '》审阅标记的修改（如：把审阅 2 写得更紧张）…'; ta.focus(); }
      return;
    }
    // 否则执行「审视并标记」：让 AI 找出可改进片段，用 <审阅:N> 包裹并给出替换建议
    ftSetBusy(true);
    ftaAppendBubble('assistant', '正在审视《' + blkName + '》…');
    const aMid = ftNewId();
    const bubble = ftaAppendBubble('assistant', '');
    const messages = [
      { role: 'system', content: FT_SYSTEM },
      { role: 'system', content: '【以下为隐藏上下文，仅供你参考，不要原样复述给用户】\n' + ftaBuildContext() },
      { role: 'user', content: '请审视《' + blkName + '》块，找出 3-6 处可改进的文字片段（节奏、冗余、平直、缺感官细节、情绪不到位等），按约定只输出一个 JSON 数组：[{"current":"需要改进的原文（逐字照搬，可含换行）","suggestion":"改进后的文字"}]。不要包裹 markdown，直接输出 JSON。不要改动原文里 <召唤…>/<<剧情块>>/<跳回>/<停顿>/<选项> 等结构标签。' },
    ];
    window.AI.callDeepseek(messages, {
      stream: true, thinking: ftThinking,
      onToken: (d) => ftStreamAppend(bubble, d),
      onStatus: () => {},
    }).then(full => {
      if (myGen !== ftSessionGen) return;   // 会话已切走（切工程/重开），丢弃这次迟到的回复，不写回旧历史
      full = full || '';
      const ops = ftExtractReviewOps(full);
      if (!ops.wraps.length) {
        bubble.textContent = '未能解析出可标记片段，已原样显示：\n' + full;
        ftMessages.push({ role: 'assistant', content: full, _id: aMid });
        attachBubbleMid(bubble, aMid); ftSaveHistory();
        ftSetBusy(false);
        return;
      }
      const res = ftDoWraps(ops.wraps);
      if (res.wrapped > 0) {
        ftEditMode = true;
        renderReviewPanel(); refreshReviewToggleBadge(); refreshBlockReviewLine();
        const ta = $('#fta-input');
        if (ta) { ta.placeholder = '描述对《' + blkName + '》审阅标记的修改（如：把审阅 2 写得更紧张）…'; ta.focus(); }
        bubble.textContent = '已在《' + blkName + '》中标记 ' + res.wrapped + ' 处需要审视的片段（用 <审阅:N> 包裹），右侧审阅面板可逐条「应用」我的替换建议。\n你现在可以直接描述想怎么改，例如「把审阅 2 写得更紧张」，我会更新对应建议。';
        ftMessages.push({ role: 'assistant', content: '（已在当前块标记 ' + res.wrapped + ' 处审阅片段并放入审阅面板）', _id: aMid });
        attachBubbleMid(bubble, aMid); ftSaveHistory();
      } else {
        bubble.textContent = '我在原文里没匹配到你提供的片段（可能已被修改），未做标记。原回复：\n' + full;
        ftMessages.push({ role: 'assistant', content: full, _id: aMid });
        attachBubbleMid(bubble, aMid); ftSaveHistory();
      }
      ftSetBusy(false);
    }).catch(err => {
      bubble.textContent = '出错：' + (err && err.message ? err.message : err);
      bubble.classList.add('fta-typing');
      ftSetBusy(false);
    });
  }
  // 从模型回复里抽取审阅操作 → { map:{N:"新内容"}, wraps:[{current,suggestion}] }
  // 支持：```json 代码块、纯 ``` 代码块、以及无围栏的裸 JSON（自动括号匹配，忽略字符串内括号）
  // 预修复：模型常在长字符串值里直接写「真实换行」，导致 JSON.parse 抛错、审阅提案整体丢失。
  // 这里只把【字符串字面量内部】的裸换行/回车转义掉（\n→\\n、\r 丢弃），字符串外与已转义的 \n 不受影响。
  function ftRepairJson(raw) {
    if (!raw) return raw;
    let out = '', inStr = false, esc = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (inStr) {
        if (esc) { out += ch; esc = false; }
        else if (ch === '\\') { out += ch; esc = true; }
        else if (ch === '"') { out += ch; inStr = false; }
        else if (ch === '\n') { out += '\\n'; }   // 字符串内的真实换行 → 转义
        else if (ch === '\r') { /* 丢弃，避免 CRLF 双转义 */ }
        else { out += ch; }
      } else {
        if (ch === '"') { out += ch; inStr = true; }
        else out += ch;
      }
    }
    return out;
  }
  function ftExtractReviewOps(text) {
    if (!text) return { map: {}, wraps: [] };
    let raw = null;
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) raw = fence[1];
    else raw = ftFindJson(text);   // 退而求其次：在文本中找最外层 JSON
    if (!raw) return { map: {}, wraps: [] };
    const clean = ftRepairJson(raw).replace(/,(\s*[}\]])/g, '$1');
    let parsed;
    try { parsed = JSON.parse(clean); } catch (e) { return { map: {}, wraps: [] }; }
    const map = {}, wraps = [];
    if (Array.isArray(parsed)) {
      for (const it of parsed) {
        if (!it || typeof it !== 'object') continue;
        if (typeof it.current === 'string' && it.current.trim()) wraps.push({ current: it.current, suggestion: typeof it.suggestion === 'string' ? it.suggestion : '' });
      }
    } else if (parsed && typeof parsed === 'object') {
      for (const k of Object.keys(parsed)) {
        const num = parseInt(k, 10);
        if (!isNaN(num) && typeof parsed[k] === 'string') map[num] = parsed[k];
      }
    }
    return { map: map, wraps: wraps };
  }
  // 流式增量渲染：只追加新 token 的文本节点，避免每个 token 都 textContent=full 重解析整段已累积文本（大段文字 O(n^2) 卡顿根因）
  function ftStreamAppend(bubble, d) {
    if (d == null || d === '') return;
    if (bubble._thinking) { bubble.textContent = ''; bubble._thinking = false; } // 首个 token 到达即清掉「思考中…」占位
    let tn = bubble._streamNode;
    if (!tn) {
      tn = document.createTextNode('');
      bubble.insertBefore(tn, bubble.firstChild); // 气泡初始为空，流式文字落在最前；收尾 .then 会用 textContent 重置，不会重复
      bubble._streamNode = tn;
    }
    tn.textContent += d;
    $('#fta-messages').scrollTop = $('#fta-messages').scrollHeight;
  }
  // 判断 AI 回复是否为「整篇/大幅文稿重写」——这类输出无意义且卡顿，应拦截、改走审阅标记
  // 纯字数判定：输出 ≥ 3000 字即视为整篇/大幅重写并拦截；低于此一律正常显示（不再误拦局部改写）
  function ftIsFullTextDump(text) {
    return !!(text && text.length >= 3000);
  }
  // 判断用户消息是否为「确认/采纳建议」意图（命中则直接应用待确认审阅提案，不再调 AI）
  function ftIsConfirmIntent(t) {
    const s = (t || '').trim().toLowerCase();
    if (!s) return false;
    const strong = ['确认', '采纳', '接受', '加入审阅', '确认建议', '采纳建议', '应用建议', 'apply', 'confirm', 'accept'];
    const weak = ['应用', '照此', '照做', '就按', '好的', '行', '可以', 'ok', 'yes'];
    if (s.length <= 14) return strong.some(function (k) { return s.indexOf(k) >= 0; }) || weak.some(function (k) { return s.indexOf(k) >= 0; });
    if (s.length <= 40) return strong.some(function (k) { return s.indexOf(k) >= 0; });
    return false;
  }
  // 把一份审阅提案（{map,wraps}）真正写入正文标记并进审阅模式；返回 {ok,upd,added,notFound}
  function ftApplyReviewOps(ops) {
    if (!ops) return { ok: false, upd: 0, added: 0, notFound: 0 };
    let upd = 0, added = 0, notFound = 0;
    for (const k of Object.keys(ops.map)) {
      const n = parseInt(k, 10);
      if (getReviewMarkers(storyText.value).some(function (m) { return m.n === n; })) { storeAiSuggestion(activeBlock, n, ops.map[k]); upd++; }
      else notFound++;
    }
    if (ops.wraps.length) { const res = ftDoWraps(ops.wraps); added = res.wrapped; notFound += res.skipped; }
    if (upd || added) {
      ftEditMode = true;
      renderReviewPanel(); refreshReviewToggleBadge(); refreshBlockReviewLine();
      const ta = $('#fta-input');
      const blk = (typeof activeBlock !== 'undefined' && activeBlock) ? activeBlock : '主剧情';
      if (ta) ta.placeholder = '描述对《' + blk + '》审阅标记的修改（如：把审阅 2 写得更紧张）…';
      return { ok: true, upd: upd, added: added, notFound: notFound };
    }
    return { ok: false, upd: upd, added: added, notFound: notFound };
  }
  // 扫描文本里的 <审阅:N>…</审阅> 标记，返回 {n,start,end,inner}
  function getReviewMarkers(text) {
    const out = []; const re = /<审阅:(\d+)>([\s\S]*?)<\/审阅>/g; let m;
    while ((m = re.exec(text)) !== null) out.push({ n: parseInt(m[1], 10), start: m.index, end: m.index + m[0].length, inner: m[2] });
    return out;
  }
  function maxReviewN(text) { return getReviewMarkers(text).reduce(function (a, x) { return Math.max(a, x.n); }, 0); }
  // ---- 审阅标记定位辅助：精确优先，失败再模糊回退 ----
  function normText(s) {
    if (!s) return '';
    return (s + '')
      .replace(/[　\s]+/g, '')                                                            // 去所有空白（含全角空格）
      .replace(/[！-～]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); }); // 全角标点→半角
  }
  // 在 txt 中定位 target：先精确，失败再归一化模糊匹配并映射回原索引。返回原字符索引或 -1
  function findAnchored(txt, target) {
    if (!target) return -1;
    const exact = txt.indexOf(target);
    if (exact >= 0) return exact;
    const ng = normText(target);
    if (!ng) return -1;
    const nt = normText(txt);
    const p = nt.indexOf(ng);
    if (p < 0) return -1;
    let count = 0, orig = 0;
    for (let i = 0; i < txt.length && count < p; i++) {
      if (!/\s/.test(txt[i])) count++;
      orig = i + 1;
    }
    return orig;
  }
  // 把 AI 给出的片段用 <审阅:N> 包裹进当前块文本，并存储替换建议
  function ftDoWraps(items) {
    let txt = storyText.value; let wrapped = 0, skipped = 0, unanchored = 0;
    const placed = [];   // 已插入标记的 [start,end)，防重叠嵌套
    for (const it of items) {
      if (!it || typeof it.current !== 'string' || !it.current.trim()) { skipped++; continue; }
      const markers = getReviewMarkers(txt);
      let idx = findAnchored(txt, it.current);
      let done = false;
      while (idx >= 0) {
        const inside = markers.some(function (mk) { return idx >= mk.start && idx < mk.end; });
        const overlap = placed.some(function (rg) { return idx < rg.end && idx + it.current.length > rg.start; });
        if (!inside && !overlap) {
          const n = maxReviewN(txt) + 1;
          const tag = '<审阅:' + n + '>';
          const len = it.current.length;
          txt = txt.slice(0, idx) + tag + it.current + '</审阅>' + txt.slice(idx + len);
          storeAiSuggestion(activeBlock, n, it.suggestion || '');
          wrapped++; done = true;
          placed.push({ start: idx, end: idx + len + tag.length + '</审阅>'.length });
          break;
        }
        const next = txt.indexOf(it.current, idx + it.current.length);
        idx = next >= 0 ? next : -1;
      }
      if (!done) {
        storeUnanchoredSuggestion(activeBlock, it.current, it.suggestion || ''); // 锚定不上也不丢弃，存为未锚定建议由人工定位
        unanchored++; skipped++;
      }
    }
    if (wrapped) { storyText.value = txt; commitEdit(); }
    return { wrapped: wrapped, skipped: skipped, unanchored: unanchored };
  }
  // 把 AI 对某 <审阅:N> 的替换建议存进 reviews（按 block+n 稳定锚定，不随行号漂移）
  function storeAiSuggestion(block, n, suggestion) {
    const arr = loadReviews();
    let r = arr.find(function (x) { return x.kind === 'ai' && x.block === block && x.n === n; });
    if (r) { r.text = suggestion || ''; r.applied = false; }
    else arr.push({ id: 'ai_' + Date.now() + '_' + n + '_' + Math.floor(Math.random() * 1e4), kind: 'ai', block: block, n: n, text: suggestion || '', applied: false, createdAt: Date.now() });
    saveReviews(arr);
  }
  // 锚定不上的 AI 审阅提案：存为未锚定记录，由用户手动定位后修改（不再静默丢弃）
  function storeUnanchoredSuggestion(block, current, suggestion) {
    const arr = loadReviews();
    arr.push({ id: 'ai_un_' + Date.now() + '_' + Math.floor(Math.random() * 1e4), kind: 'ai_unanchored', block: block, current: current || '', suggestion: suggestion || '', createdAt: Date.now() });
    saveReviews(arr);
  }
  // 应用某 <审阅:N> 的替换建议（用建议替换标记内部文字，保留标记）
  function applyAiReview(n) {
    const arr = loadReviews();
    const r = arr.find(function (x) { return x.kind === 'ai' && x.block === activeBlock && x.n === n; });
    if (!r || !r.text) { toast('审阅 ' + n + ' 没有可应用的替换建议'); return; }
    const re = new RegExp('<审阅:' + n + '>([\\s\\S]*?)<\\/审阅>', '');
    const m = re.exec(storyText.value);
    if (!m) { toast('未找到 审阅 ' + n + ' 标记，可能已被手动删除'); return; }
    storyText.value = storyText.value.slice(0, m.index) + '<审阅:' + n + '>' + r.text + '</审阅>' + storyText.value.slice(m.index + m[0].length);
    commitEdit();
    r.applied = true;
    saveReviews(arr);
    renderReviewPanel();
    refreshReviewToggleBadge();
    refreshBlockReviewLine();
    toast('已应用 审阅 ' + n + ' 的替换建议');
  }
  // 删除某 <审阅:N> 标记（保留内部文字）
  function deleteAiReview(n) {
    storyText.value = storyText.value.replace(new RegExp('<审阅:' + n + '>([\\s\\S]*?)<\\/审阅>', ''), '$1');
    commitEdit();
    saveReviews(loadReviews().filter(function (r) { return !(r.kind === 'ai' && r.block === activeBlock && r.n === n); }));
    renderReviewPanel();
    refreshReviewToggleBadge();
    refreshBlockReviewLine();
  }
  // 在编辑器里定位某 <审阅:N> 标记（选中整段）
  function locateReviewMarker(n) {
    const re = new RegExp('<审阅:' + n + '>([\\s\\S]*?)<\\/审阅>', '');
    const m = re.exec(storyText.value);
    if (!m) { toast('未找到 审阅 ' + n + ' 标记'); return; }
    storyText.focus();
    try { storyText.setSelectionRange(m.index, m.index + m[0].length); } catch (e) {}
    const before = storyText.value.slice(0, m.index);
    const lineNo = before.split('\n').length;
    const lh = parseFloat(getComputedStyle(storyText).lineHeight) || 22;
    const pt = parseFloat(getComputedStyle(storyText).paddingTop) || 0;
    storyText.scrollTop = Math.max(0, (lineNo - 1) * lh + pt - storyText.clientHeight / 2 + lh);
  }
  // 清除当前块所有 <审阅:N> 标记（保留内部文字）与对应 AI 建议
  function clearBlockMarkers() {
    const before = storyText.value;
    storyText.value = before.replace(/<审阅:\d+>([\s\S]*?)<\/审阅>/g, '$1');
    if (storyText.value === before) { toast('本块没有审阅标记'); return; }
    commitEdit();
    saveReviews(loadReviews().filter(function (r) { return !(r.kind === 'ai' && r.block === activeBlock); }));
    renderReviewPanel();
    refreshReviewToggleBadge();
    refreshBlockReviewLine();
    toast('已清除本块所有审阅标记');
  }
  // 删除一条未锚定 AI 建议
  function deleteUnanchoredReview(id) {
    saveReviews(loadReviews().filter(function (r) { return r.id !== id; }));
    renderReviewPanel(); refreshReviewToggleBadge();
  }
  // 在正文里定位一条未锚定建议的原文片段（选中高亮）
  function locateUnanchored(id) {
    const r = loadReviews().find(function (x) { return x.id === id; });
    if (!r || !r.current) { toast('无片段可定位'); return; }
    locateSnippetText(r.current);
  }
  // 在正文里定位一段文字（选中高亮并滚动入视野）。找不到给明确提示而非静默失败
  function locateSnippetText(txt) {
    if (!txt) { toast('该审阅没有可定位的剧情片段'); return; }
    const idx = findAnchored(storyText.value, txt);
    if (idx < 0) { toast('找不到匹配文本，可能已经修改。'); return; }
    storyText.focus();
    try { storyText.setSelectionRange(idx, idx + txt.length); } catch (e) {}
    const before = storyText.value.slice(0, idx);
    const lineNo = before.split('\n').length;
    const lh = parseFloat(getComputedStyle(storyText).lineHeight) || 22;
    const pt = parseFloat(getComputedStyle(storyText).paddingTop) || 0;
    storyText.scrollTop = Math.max(0, (lineNo - 1) * lh + pt - storyText.clientHeight / 2 + lh);
  }
  // 在文本中定位最外层 JSON（数组或对象），做括号匹配（字符串内的括号忽略）
  function ftFindJson(text) {
    const start = text.search(/[[{]/);
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '[' || ch === '{') depth++;
      else if (ch === ']' || ch === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    return end < 0 ? null : text.slice(start, end + 1);
  }
  // 把模型回复里的 JSON（代码块或裸 JSON）从展示文本里剥离，只留自然语言说明
  function ftStripEditsFromText(text) {
    if (!text) return '';
    let t = text.replace(/```(?:json)?[\s\S]*?```/gi, '');   // 去掉代码块
    // 若去掉后所剩基本就是裸 JSON（整段以 [ 或 { 开头且可被解析），也清空
    const rest = t.trim();
    if (rest && (rest[0] === '[' || rest[0] === '{')) {
      const bare = ftFindJson(rest);
      if (bare && bare.length > rest.length * 0.6) t = t.replace(bare, '');
    }
    return t.replace(/\n{3,}/g, '\n\n').trim();
  }
  function runBgPromptGen() {
    if (!bgpName || !window.AI) return;
    const name = bgpName;
    // 读取并暂存用户选的画面预设，供「重新生成」返回时回填；同时记忆为「上一次选的内容」
    bgpParams = {
      ratio: $('#bgp-ratio').value,
      style: $('#bgp-style').value,
      lighting: $('#bgp-lighting').value,
      composition: $('#bgp-composition').value,
      lens: $('#bgp-lens').value,
      special: ($('#bgp-special').value || '').trim(),
    };
    saveLastBgParams(bgpParams);
    setBgpPhase('generating');
    setBgpStatus('AI 揣摩场景中…', 'busy');
    window.AI.generateBackgroundPrompt({
      name,
      contextText: bgpCtxText,
      creation: loadCreation(),
      params: bgpParams,
      onStatus: (st) => setBgpStatus(st, 'busy'),
    }).then(promptText => {
      if (bgpName !== name) return; // 期间已关闭/切换
      $('#bgp-text').value = promptText;
      saveAssetPrompt(name, promptText);
      setBgpStatus('完成 · 已缓存，可编辑后复制', '');
      setBgpPhase('result');
    }).catch(err => {
      setBgpStatus('出错：' + (err && err.message ? err.message : err), 'err');
      toast('生成失败：' + (err && err.message ? err.message : err));
      setBgpPhase(getCachedPrompt(name) ? 'result' : 'preview');
    });
  }

  // ============ 关键线索提取 ============
  // 隐藏所有 AI 功能开关：在 body 上挂 class，CSS 据此隐藏编辑器/素材待办里的 AI 按钮（设置内不受影响）
  function applyHideAllAI() {
    if (!window.AI) return;
    const on = !!window.AI.loadSettings().hideAllAI;
    document.body.classList.toggle('ai-hidden', on);
  }
  function setCluesStatus(msg, cls) {
    const el = $('#clues-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'ai-status' + (cls ? ' ' + cls : '');
  }
  // ---------- 语料快照（用于增量提取关键线索，避免每次重发全文） ----------
  // 简单字符串哈希（djb2），仅用于比对内容是否变化，不要求加密强度
  function hashStr(s) {
    s = String(s || '');
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }
  // 收集当前全部「语料单元」：创作设定 4 项 + 每个剧情块当前文本
  function collectCorpusUnits() {
    const c = loadCreation();
    const units = { __outline: c.outline || '', __intro: c.intro || '', __world: c.world || '', __style: c.style || '' };
    const names = window.Storage.listBlockNames();
    for (const nm of names) {
      const txt = (nm === activeBlock) ? (storyText.value || '') : (window.Storage.getBlockText(nm) || '');
      units['blk:' + nm] = txt;
    }
    return units;
  }
  function computeCorpusHashes() {
    const units = collectCorpusUnits();
    const snap = {};
    for (const k in units) snap[k] = hashStr(units[k]);
    return snap;
  }
  function unitLabel(k) {
    if (k === '__outline') return '大纲';
    if (k === '__intro') return '简介';
    if (k === '__world') return '世界观';
    if (k === '__style') return '文风';
    if (k.indexOf('blk:') === 0) return '剧情块·' + k.slice(4);
    return k;
  }
  // 返回自上次提取以来「变化的语料单元」文本（新增/修改的块内容；已删除的块给出复核提示）
  function getChangedCorpusText(prevSnap) {
    const units = collectCorpusUnits();
    const cur = computeCorpusHashes();
    const parts = [];
    for (const k in units) {
      if (prevSnap[k] !== cur[k]) parts.push('【' + unitLabel(k) + '】\n' + (units[k] || '（空）'));
    }
    for (const k in prevSnap) {
      if (k.indexOf('blk:') === 0 && !(k in cur)) {
        parts.push('【已删除的剧情块：' + unitLabel(k) + '】\n（该段已被移除，其相关线索可能需复核）');
      }
    }
    return parts.join('\n\n');
  }
  // 核心：执行一次关键线索提取（设置内按钮与编辑区上方按钮共用）
  // onStatus(msg, cls) 由调用方提供（设置内更新 #clues-status，编辑区仅 toast）
  // 核心：执行一次关键线索提取（设置内按钮与编辑区上方按钮共用）
  // opts.forceFull=true 时无视快照、全量重扫（设置内按钮用）；否则走增量（仅发变化段落）
  function runClueExtraction(onStatus, opts) {
    opts = opts || {};
    return new Promise((resolve, reject) => {
      if (!window.AI) { reject(new Error('AI 模块未加载')); return; }
      const c = loadCreation();
      const prevSnap = c.clueCorpus || {};
      const hasSnap = Object.keys(prevSnap).length > 0;
      const forceFull = !!opts.forceFull;
      let body, incremental = false, changedText = '';
      if (!forceFull && hasSnap) {
        changedText = getChangedCorpusText(prevSnap);
        if (!changedText.trim()) {
          toast('内容较上次提取无变化，无需重新提取');
          if (onStatus) onStatus('内容无变化，已跳过', '');
          resolve({ clues: c.clues || '', summary: '（内容无变化，已跳过）' });
          return;
        }
        incremental = true;
        body = changedText; // 仅发变化段落，大幅省 token
      } else {
        body = collectAllStoryText(); // 全部正文（首次或强制全量）
      }
      const existing = ($('#ai-clues').value || '').trim();
      if (onStatus) onStatus('AI 分析中（可能需数十秒）…', 'busy');
      window.AI.extractClues({
        outline: c.outline, intro: c.intro, world: c.world, style: c.style,
        body: body, existing: existing, incremental: incremental,
        onStatus: (st) => { if (onStatus) onStatus(st, 'busy'); },
      }).then(res => {
        const clues = (res.clues || '').trim();
        const ta = $('#ai-clues');
        if (ta) ta.value = clues;
        const c2 = loadCreation();
        c2.clues = clues;
        c2.clueExtractChars = collectAllStoryText().length; // 记录本次提取时正文总字数
        c2.clueCorpus = computeCorpusHashes(); // 更新语料快照（供下次增量）
        saveCreation(c2); // 持久化
        const n = clues ? clues.split('\n').filter(l => l.trim()).length : 0;
        if (onStatus) onStatus('完成 · 已更新线索', '');
        toast('关键线索已更新（共 ' + n + ' 条）');
        refreshClueHint(); // 重置上方提示（字数已对齐）
        resolve(res);
      }).catch(err => {
        if (onStatus) onStatus('出错：' + ((err && err.message) ? err.message : String(err)), 'err');
        reject(err);
      });
    });
  }
  // 编辑区上方「提取关键线索」：增量优先（仅发变化段落），先确认消耗 AI 额度
  function extractCluesQuick() {
    if (!window.AI) return;
    const settings = window.AI.loadSettings();
    if (!settings.key) { toast('请先在「设置 → AI 编剧 → 模型与密钥」填写 Deepseek API Key'); openSettings('ai'); return; }
    const c = loadCreation();
    const prevSnap = c.clueCorpus || {};
    const hasSnap = Object.keys(prevSnap).length > 0;
    const incremental = hasSnap;
    const changedText = hasSnap ? getChangedCorpusText(prevSnap) : '';
    if (incremental && !changedText.trim()) { toast('内容较上次提取无变化，无需重新提取'); return; }
    const ok = window.confirm(
      '提取关键线索\n\n'
      + (incremental
        ? '将把大纲、简介与【自上次提取以来变化的剧情段落】发送给 AI 增量更新关键线索，会消耗一些 Deepseek API 额度。\n'
        : '将把大纲、简介与全部正文发送给 AI 重新梳理关键线索，会消耗一些 Deepseek API 额度。\n')
      + '确认后执行一次（与设置里的功能一致）。'
    );
    if (!ok) return;
    const btn = $('#btn-extract-clues-quick');
    if (btn) { btn.disabled = true; btn.classList.add('busy'); }
    runClueExtraction(() => { /* 状态以 toast 形式提示，不阻塞编辑区 */ }, { forceFull: false })
      .then(() => { toast('已提取关键线索'); })
      .catch(err => { toast('提取失败：' + ((err && err.message) ? err.message : String(err))); })
      .finally(() => { if (btn) { btn.disabled = false; btn.classList.remove('busy'); } });
  }
  // 设置抽屉内「提取关键线索」：带变更说明
  function extractCluesHandler() {
    if (!window.AI) return;
    const settings = window.AI.loadSettings();
    if (!settings.key) { toast('请先在「设置 → AI 编剧 → 模型与密钥」填写 Deepseek API Key'); openSettings('ai'); return; }
    const btn = $('#btn-extract-clues');
    if (btn) btn.disabled = true;
    const note = $('#clues-change-note');
    if (note) note.classList.add('hidden');
    runClueExtraction(setCluesStatus, { forceFull: true })
      .then(res => {
        const note = $('#clues-change-note');
        if (note) {
          if (res.summary) { note.textContent = '变更：' + res.summary; note.classList.remove('hidden'); }
          else note.classList.add('hidden');
        }
      })
      .catch(() => {})
      .finally(() => { if (btn) btn.disabled = false; });
  }
  // 编辑区上方「提取关键线索」按钮 + 提示的显隐规则：
  // 仅当正文相对「上次提取时」的字数变化（首次与 0 比较）绝对值超过 1000 字时才显示，否则隐藏
  function refreshClueHint() {
    const hintEl = $('#clue-update-hint');
    const btn = $('#btn-extract-clues-quick');
    const c = loadCreation();
    const last = (typeof c.clueExtractChars === 'number') ? c.clueExtractChars : 0; // 首次未提取：与 0 比较
    const cur = collectAllStoryText().length;
    const delta = cur - last;
    const show = Math.abs(delta) > 1000;          // 阈值 1000 字
    if (btn) btn.classList.toggle('hidden', !show);
    if (!hintEl) return;
    if (show) {
      const sign = delta > 0 ? '+' : '';
      hintEl.textContent = '正文已变化 ' + sign + delta + ' 字（与上次提取相比），建议更新一次关键线索';
      hintEl.classList.remove('hidden');
    } else {
      hintEl.classList.add('hidden');
    }
  }

  // 暴露给 AI 模块读取，保持编辑器与 AI 解耦
  window.StoryEditorApi = {
    getText: () => storyText.value,
    setText: (t) => { storyText.value = t; updateWordCount(); },
    getSel: () => ({ start: storyText.selectionStart, end: storyText.selectionEnd }),
    getCreation: () => loadCreation(),
    parseStory,
    storyToText,
    computeTodo,
    refreshTodo,
    handleDroppedFiles,
    // 剧情块 API
    getActiveBlock: () => activeBlock,
    getMode: () => currentProjectMode, // 'article' | 'game'
    getPlayMode: () => (globalSettings.playMode === 'galgame' ? 'galgame' : 'longform'), // 'longform' | 'galgame'
    setActiveBlock: (n) => switchBlock(n),
    listBlockNames: () => window.Storage.listBlockNames(),
    getBlockText: (n) => window.Storage.getBlockText(n),
    insertBlockOption,
    insertBlockJump,
    insertOptionEmpty,
    applyGeneratedBlocks,
    splitIntoBlocks: (t) => window.AI.splitIntoBlocks(t),
  };

  function openSettings(sub) {
    $('#settings-drawer').classList.remove('hidden');
    switchSettingsSub(sub || 'ai');
    refreshSettingsForms();
  }
  function closeSettings() { $('#settings-drawer').classList.add('hidden'); }
  function switchSettingsSub(sub) {
    document.querySelectorAll('.settings-subnav').forEach(b => b.classList.toggle('active', b.dataset.sub === sub));
    document.querySelectorAll('.settings-sub').forEach(p => p.classList.toggle('hidden', p.dataset.sub !== sub));
    if (sub === 'general') renderSettingsGeneral();
  }
  function refreshSettingsForms() {
    loadAISettings();
    loadCreationIntoForm();
    renderSettingsGeneral();
  }
  function loadAISettings() {
    if (!window.AI) return;
    const s = window.AI.loadSettings();
    $('#ai-key').value = s.key || '';
    $('#ai-base').value = s.base || '';
    $('#ai-model').value = s.model || '';
    $('#ai-intensity').value = s.intensity || '中';
    $('#ai-temp').value = (typeof s.temp === 'number') ? s.temp : 0.8;
    $('#ai-temp-val').textContent = (typeof s.temp === 'number') ? s.temp : 0.8;
    $('#ai-selfcheck').checked = !!s.selfCheck;
    const hideEl = $('#ai-hide-all'); if (hideEl) hideEl.checked = !!s.hideAllAI;
    applyHideAllAI(); // 设置内改了开关要立即生效
    const hint = $('#ai-key-hint');
    hint.textContent = s.key ? '已配置 Key（仅存本机，不进导出成品）。' : '提示：Key 仅存本机，不会进入导出的游戏成品。';
  }
  function setAIStatus(msg, cls) {
    const el = $('#ai-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'ai-status' + (cls ? ' ' + cls : '');
  }

  // 点 🤖 AI 菜单项 → 先列上下文、不直接生成；生成由「开始」按钮触发
  function prepareMode(mode) {
    if (!window.AI) return;
    const settings = window.AI.loadSettings();
    if (!settings.key) { toast('请先在「设置 → AI 编剧 → 模型与密钥」填写 Deepseek API Key'); openSettings('ai'); return; }
    const sel = (typeof window.StoryEditorApi !== 'undefined' && window.StoryEditorApi.getSel) ? window.StoryEditorApi.getSel() : { start: 0, end: 0 };
    const hasSel = sel.end > sel.start;
    if ((mode === 'expand' || mode === 'polish') && !hasSel) {
      toast(mode === 'polish' ? '请先选中要润色的文字' : '请先选中要重写的文字');
      return;
    }
    if (mode === 'continue') {
      const c = loadCreation();
      const isBlank = !(typeof window.StoryEditorApi !== 'undefined' && window.StoryEditorApi.getText && window.StoryEditorApi.getText().trim());
      if (isBlank && !c.outline && !c.intro && !c.world && !c.style) {
        toast('建议先去「设置 → AI 编剧 → 创作设定」补全大纲/简介，AI 才有据可依');
      }
    }
    window.AI.buildContext(mode).then(ctx => {
      openReviewModal(mode, ctx);
    });
  }

  // 真正调 AI 生成（由「开始」按钮或「再改改」触发）
  let aiReviseNote = null;
  let aiReviewPhase = 'preview';
  let aiLastNote = '';       // 上一次实际用过的备注（首次生成=方向备注，重提后=新备注），供「重提要求」预填
  let aiAbort = null;        // 当前生成请求的 AbortController（用于「停止并采纳 / 插话改方向」）
  let aiAbortReason = null;  // 'stop' | 'redirect' | null
  let aiStreamedFull = '';   // 生成中实时累积的全文（用于停止并采纳 / 插话续写基底）
  let aiBaseText = '';       // 插话改方向前的已有部分
  let aiRedirected = false;  // 本次生成是否经历过插话续写

  // 备注历史（最近 3 条用过的方向备注），渲染为可点击 chip
  const NOTE_HISTORY_KEY = 'story-editor:note-history';
  function loadNoteHistory() {
    try { const a = JSON.parse(localStorage.getItem(NOTE_HISTORY_KEY) || '[]'); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function saveNoteHistory(note) {
    let a = loadNoteHistory().filter(n => n !== note);
    a.unshift(note);
    a = a.slice(0, 3);
    try { localStorage.setItem(NOTE_HISTORY_KEY, JSON.stringify(a)); } catch (e) {}
  }
  const MOOD_CHIPS = ['更悬疑', '更荒诞', '更克制', '加快节奏', '放缓', '更口语'];
  function renderNoteChips() {
    const box = $('#ai-note-chips'); if (!box) return;
    box.innerHTML = '';
    const chips = (currentProjectMode === 'article')
      ? MOOD_CHIPS.filter(m => m !== '更荒诞')   // 文章=小说模式：荒诞与叙事调性冲突，隐藏
      : MOOD_CHIPS;
    chips.forEach(m => {
      const c = document.createElement('span');
      c.className = 'ai-chip ai-chip-mood'; c.textContent = m; c.dataset.note = m;
      box.appendChild(c);
    });
    loadNoteHistory().forEach(h => {
      const c = document.createElement('span');
      c.className = 'ai-chip ai-chip-hist';
      c.textContent = h.length > 12 ? h.slice(0, 12) + '…' : h;
      c.title = h; c.dataset.note = h;
      box.appendChild(c);
    });
  }
  function appendNote(frag) {
    const el = $('#ai-note'); if (!el) return;
    const cur = el.value.trim();
    el.value = cur ? (cur + '，' + frag) : frag;
  }
  function getGenParams() {
    const hasGenParams = (aiReviewMode === 'outline' || aiReviewMode === 'continue' || aiReviewMode === 'expand' || aiReviewMode === 'polish');
    // 通用文章模式：不写分支 / 谜题
    if (currentProjectMode === 'article') return { puzzle: 0, branches: 0, deepThink: !!(aiReviewMode === 'outline' || aiReviewMode === 'continue' || aiReviewMode === 'expand' || aiReviewMode === 'polish') && $('#ai-deepthink') && $('#ai-deepthink').checked };
    const gp = hasGenParams ? (parseInt($('#ai-puzzle').value, 10) || 0) : 0;
    const gb = hasGenParams ? (parseInt($('#ai-branches').value, 10) || 0) : 0;
    const dt = $('#ai-deepthink');
    const dd = hasGenParams ? !!(dt && dt.checked) : false;
    return { puzzle: gp, branches: gb, deepThink: dd };
  }
  // ---- 流式渲染性能优化：token 先入缓冲区，最多每帧(≈60fps)写一次 DOM ----
  // 用 setRangeText 仅追加增量、避免整段重拷；大段文字不再 O(n²) 卡顿。
  let _streamPending = '';
  let _streamRAF = 0;
  let _streamForceFull = false;
  function _streamReset() {
    _streamPending = ''; _streamForceFull = true;
    if (_streamRAF) { cancelAnimationFrame(_streamRAF); _streamRAF = 0; }
  }
  function _streamCancel() {
    if (_streamRAF) { cancelAnimationFrame(_streamRAF); _streamRAF = 0; }
    _streamPending = '';
  }
  function _streamFlush() {
    _streamRAF = 0;
    const ta = $('#ai-review-text');
    if (!ta) { _streamPending = ''; return; }
    if (_streamForceFull || ta.value.length !== (aiStreamedFull.length - _streamPending.length)) {
      ta.value = aiStreamedFull;            // 不连续（首帧 / 插话重置）→ 整段重赋一次
      _streamForceFull = false;
    } else if (_streamPending) {
      const at = ta.value.length;
      ta.setRangeText(_streamPending, at, at, 'end');  // 连续 → 仅追加增量（O(delta)）
    }
    _streamPending = '';
    // 仅当用户停在底部附近时才自动跟随（差值 < 80px），不打断手动上翻阅读
    if (ta.scrollHeight - ta.scrollTop - ta.clientHeight < 80) ta.scrollTop = ta.scrollHeight;
  }
  // 统一生成入口（首生成与插话续写共用）
  function runGeneration(extra) {
    extra = extra || {};
    aiAbort = new AbortController();
    aiAbortReason = null;
    aiRedirected = !!extra.resumeFrom;
    if (aiRedirected) aiBaseText = extra.resumeFrom;
    _streamReset();
    const gp = getGenParams();
    setReviewPhase('generating');
    window.AI.orchestrate({
      mode: aiReviewMode, ctx: aiReviewCtx,
      reviseNote: aiReviseNote, directionNote: aiLastNote,
      puzzle: gp.puzzle, branches: gp.branches, deepThink: gp.deepThink,
      signal: aiAbort.signal,
      onStatus: (st) => setAIStatus(st, 'busy'),
      onToken: (delta, full) => {
        aiStreamedFull = (aiRedirected ? (aiBaseText + '\n') : '') + full;
        _streamPending += delta;
        if (!_streamRAF) _streamRAF = requestAnimationFrame(_streamFlush);
      },
      resumeFrom: extra.resumeFrom, redirectNote: extra.redirectNote,
    }).then(text => {
      const finalText = aiRedirected ? (aiBaseText + '\n' + text) : text;
      finalizeGeneration(finalText);
    }).catch(err => {
      if (err && err.name === 'AbortError') {
        if (aiAbortReason === 'stop') finalizeStop();
        // redirect：忽略，新的 runGeneration 会接管
        return;
      }
      setAIStatus('出错：' + (err && err.message ? err.message : err), 'err');
      toast('AI 调用失败：' + (err && err.message ? err.message : err));
      setReviewPhase('preview');
    });
  }
  // 停止并采纳：把已流式生成的部分作为结果落盘
  function finalizeStop() {
    _streamCancel();  // 防止残留的流式 rAF 把已解析结果覆盖回原始累计文本
    const t = aiStreamedFull || '';
    if (!t.trim()) { setAIStatus('还没有生成任何内容，无法采纳', 'err'); setReviewPhase('preview'); return; }
    const parts = window.AI.splitRequirements(t);
    const ta = $('#ai-review-text');
    if (ta) ta.value = parts.story;
    showReviewContext(aiReviewCtx);
    showRequirements(parts.requirements);
    setAIStatus('已停止 · 已采纳已生成部分（可继续编辑后接受）', '');
    setReviewPhase('result');
  }
  // 插话改方向：中断当前流，以已生成部分作为基底、把新指令作为 follow-up 续写
  function doRedirect() {
    const inp = $('#ai-redirect-input');
    const note = inp ? inp.value.trim() : '';
    if (!note) return;
    if (!aiStreamedFull.trim()) { toast('还没有生成内容，无法插话'); return; }
    aiBaseText = aiStreamedFull;
    const box = $('#ai-redirect-box'); if (box) box.classList.add('hidden');
    if (inp) inp.value = '';
    aiAbortReason = 'redirect';
    if (aiAbort) aiAbort.abort();   // 中断当前流（其 catch 会忽略 redirect）
    aiStreamedFull = aiBaseText;      // 保留已生成部分显示，等新 token 接上
    runGeneration({ resumeFrom: aiBaseText, redirectNote: note });
  }
  // 生成完成后的统一落盘（首生成 / 插话续写共用）
  function finalizeGeneration(text) {
    _streamCancel();  // 防止残留流式 rAF 覆盖已解析的最终文本
    const parts = window.AI.splitRequirements(text);
    if (!parts.story.trim()) {
      const msg = parts.requirements
        ? 'AI 只列出了「需求素材」但未生成正文，请重试（可缩短创作设定或已写前文）'
        : 'AI 返回内容为空，请重试（可能是模型限流或内容被过滤）';
      setAIStatus('出错：' + msg, 'err');
      toast(msg);
      setReviewPhase('preview');
      return;
    }
    const ta = $('#ai-review-text');
    if (ta) ta.value = parts.story;
    showReviewContext(aiReviewCtx);
    showRequirements(parts.requirements);
    if (aiReviewMode === 'outline' || aiReviewMode === 'continue' || aiReviewMode === 'expand' || aiReviewMode === 'polish') {
      const sp = window.AI.splitIntoBlocks(parts.story);
      if (Object.keys(sp.blocks).length) showBlockSummary(sp);
      else hideBlockSummary();
    } else { hideBlockSummary(); }
    if (aiReviewMode === 'hook') {
      const hooks = window.AI.splitHooks(parts.story);
      if (!hooks.length) {
        const msg = 'AI 返回的开头无法解析为 6 个方案，请点击「重新生成 6 个」重试；或检查创作设定是否过短。';
        setAIStatus('出错：' + msg, 'err'); toast(msg); setReviewPhase('preview'); return;
      }
      showHookChooser(hooks);
      return;
    }
    setAIStatus('完成 · 可直接编辑后接受', '');
    setReviewPhase('result');
  }

  function startGeneration() {
    if (!aiReviewCtx) return;
    const mode = aiReviewMode, ctx = aiReviewCtx, reviseNote = aiReviseNote;
    aiReviseNote = null;
    const noteEl = $('#ai-note');
    const directionNote = noteEl ? noteEl.value.trim() : '';
    aiLastNote = (reviseNote && reviseNote.trim()) ? reviseNote.trim() : directionNote;
    if (aiLastNote) { saveNoteHistory(aiLastNote); renderNoteChips(); }
    aiStreamedFull = ''; aiBaseText = ''; aiRedirected = false;
    runGeneration({});
  }

  // 审阅窗三阶段：preview（列上下文+开始按钮）/ generating（旋转等待）/ result（显示文字+操作）
  // 各模式预览内容不同：outline=大纲+已写前文并排；expand/polish=仅选中文字；continue=光标前后文
  function setReviewPhase(phase) {
    aiReviewPhase = phase;
    const isOutline = aiReviewMode === 'outline';
    const isSelection = aiReviewMode === 'expand' || aiReviewMode === 'polish';
    const hookMode = aiReviewMode === 'hook';
    const isContinue = aiReviewMode === 'continue';
    const preview = phase === 'preview';
    // 前文/后文上下文：仅「根据光标上下文续写」模式、预览态显示
    const showCtx = aiReviewMode === 'continue' && preview;
    const before = $('#ai-review-before'), after = $('#ai-review-after');
    if (showCtx) { before.classList.remove('hidden'); after.classList.remove('hidden'); }
    else { before.classList.add('hidden'); after.classList.add('hidden'); }
    // 大纲/创作设定预览块：大纲、钩子模式、预览态显示
    $('#ai-review-outline').classList.toggle('hidden', !((isOutline || hookMode) && preview));
    // 选中文字预览块：仅重写/润色模式、预览态显示
    $('#ai-review-selection').classList.toggle('hidden', !(isSelection && preview));
    // 输出区（mid / 输出栏）：所有模式的预览态都在这里浮「开始」层（含大纲模式，统一骨架）；
    // 钩子模式改用「6 选 1」选择区，mid 内部三态皆隐藏，故整体隐藏，避免上方留大片空白
    $('#ai-review-mid').classList.toggle('hidden', hookMode);
    // mid 内部三态：所有模式的预览态都显示「开始」层（含大纲模式，开始按钮统一在输出栏浮层）
    $('#ai-review-start').classList.toggle('hidden', phase !== 'preview');
    $('#ai-review-spinner').classList.add('hidden');
    // 普通结果文本框：钩子模式改用「6 选 1」选择区，不显示该文本框；生成阶段改为实时显示（接管原来的旋转等待）
    $('#ai-review-text').classList.toggle('hidden', phase === 'preview' || hookMode);
    // 生成中浮出「停止并采纳 / 插话改方向」控制条；文本框在生成阶段只读（避免误改正在流式写入的内容）
    $('#ai-gen-live').classList.toggle('hidden', phase !== 'generating');
    const _ta = $('#ai-review-text'); if (_ta) _ta.readOnly = (phase === 'generating');
    // 钩子选择区：仅钩子模式、结果态显示
    $('#ai-hook-chooser').classList.toggle('hidden', !(hookMode && phase === 'result'));
    if (phase !== 'result') $('#ai-review-req').classList.add('hidden');
    // 生成参数（谜题/分支数量）：大纲、续写、重写、润色模式、预览态显示
    const gpWrap = $('#ai-genparams-wrap');
    if (gpWrap) gpWrap.classList.toggle('hidden', !((isOutline || isContinue || isSelection) && preview));
    // 块清单：大纲 / 续写 / 重写 / 润色模式、结果态显示（内容由 startGeneration 填充）
    $('#ai-blocksum').classList.toggle('hidden', !((isOutline || isContinue || isSelection) && phase === 'result'));
    // 底部操作按钮：钩子模式不使用（选择区自带「选用 / 重新生成」），其余模式仅结果态显示
    document.querySelectorAll('#ai-review-actions .btn').forEach(b => b.classList.toggle('hidden', phase !== 'result' || hookMode));
    // 「接受」按钮文案
    const acceptBtn = $('#ai-accept');
    if (acceptBtn) acceptBtn.textContent = '接受并插入';
  }

  function openReviewModal(mode, ctx) {
    $('#ai-review-modal').classList.remove('hidden');
    const titleMap = { outline: 'AI 生成剧情', continue: 'AI 生成剧情', expand: 'AI 重写选中文字', polish: '润色加文字效果', hook: '生成钩子开头' };
    $('#ai-review-title').textContent = '审阅 · ' + (titleMap[mode] || 'AI 生成');
    const startLabel = { outline: '开始生成', continue: '开始生成', expand: '开始重写', polish: '开始润色', hook: '开始生成 6 个开头' };
    const sb = $('#ai-start-gen'); if (sb) sb.textContent = startLabel[mode] || '开始生成';
    const ta = $('#ai-review-text');
    ta.value = '';
    const noteEl = $('#ai-note'); if (noteEl) noteEl.value = '';
    const before = $('#ai-review-before'), after = $('#ai-review-after');
    before.className = 'ai-review-ctx ai-review-before empty hidden'; before.textContent = '';
    after.className = 'ai-review-ctx ai-review-after empty hidden'; after.textContent = '';
    // 大纲/钩子模式：填充「创作设定」预览（钩子不展示已写前文，避免与"替换式开头"混淆）
    if ((mode === 'outline' || mode === 'hook') && ctx) {
      const c = ctx.creation || {};
      const cLines = [
        c.outline ? ('大纲：' + c.outline) : '',
        c.intro ? ('简介：' + c.intro) : '',
        c.world ? ('世界观：' + c.world) : '',
        c.style ? ('文风：' + c.style) : '',
      ].filter(Boolean);
      const cEl = $('#ai-outline-creation'); if (cEl) cEl.textContent = cLines.length ? cLines.join('\n') : '（未填写，AI 将自由发挥）';
      if (mode === 'outline') {
        const eEl = $('#ai-outline-existing'); if (eEl) eEl.textContent = (ctx.full && ctx.full.trim()) ? ctx.full.trim() : '（尚无已写内容，将从头生成）';
      }
    }
    // 重写/润色模式：填充「选中文字」预览（不显示前后文上下文）
    if ((mode === 'expand' || mode === 'polish') && ctx) {
      const selEl = $('#ai-review-selection-text');
      if (selEl) selEl.textContent = (ctx.selText && ctx.selText.trim()) ? ctx.selText.trim() : '（未选中文字）';
    }
    // 备注占位统一为「生成方向备注（内容方向，大概行数等）」，四个模式共用同一提示文案
    const noteCfg = {
      outline: { ph: '生成方向备注（内容方向，大概行数等）', note: '请确认上下文后点击开始生成。' },
      continue: { ph: '生成方向备注（内容方向，大概行数等）', note: '请确认上下文后点击开始生成。可勾选「深度思考」让 AI 先规划再铺开大段初稿。' },
      expand: { ph: '生成方向备注（内容方向，大概行数等）', note: '请确认选中文字后点击开始重写。可开启「对话分支 / 谜题」让 AI 在重写中自动插入选项与谜题，并写出对应剧情块。' },
      polish: { ph: '生成方向备注（内容方向，大概行数等）', note: '请确认选中文字后点击开始润色。可开启「对话分支 / 谜题」让 AI 在润色中自动插入选项与谜题，并写出对应剧情块。' },
      hook: { ph: '方向备注（可选，如：想要更惊悚 / 更轻松的开场）', note: '将依据「创作设定」生成 6 个开头钩子，生成后由你挑选一个使用。' },
    };
    if (noteCfg[mode]) {
      const ni = $('#ai-note'); if (ni) ni.placeholder = noteCfg[mode].ph;
      const nn = $('#ai-start-note-text'); if (nn) nn.textContent = noteCfg[mode].note;
    }
    showRequirements('');
    setAIStatus('');
    // 生成参数滑块每次开窗口归零（仅 outline/continue 显示，但值统一重置避免残留）
    const gp = $('#ai-puzzle'); if (gp) { gp.value = 0; const gv = $('#ai-puzzle-val'); if (gv) gv.textContent = '0'; }
    const gb = $('#ai-branches'); if (gb) { gb.value = 0; const gv = $('#ai-branches-val'); if (gv) gv.textContent = '0'; }
    const dt = $('#ai-deepthink'); if (dt) dt.checked = false;   // 深度思考默认不勾选，每次开窗归零
    hideBlockSummary();
    aiReviewCtx = ctx; aiReviewMode = mode; aiLastNote = '';
    showReviewContext(ctx);
    renderNoteChips();
    setReviewPhase('preview');
  }
  function closeReviewModal() { $('#ai-review-modal').classList.add('hidden'); }
  // 关闭前判断：生成中或已有结果时，提示会丢失且 token 不返还，需二次确认
  function requestCloseReview() {
    if (aiReviewPhase === 'generating' || aiReviewPhase === 'result') {
      if (!window.confirm('AI 生成结果会消失，token 不会返还。确定要关闭吗？')) return;
    }
    closeReviewModal();
    aiReviewCtx = null; aiReviewMode = null; aiReviseNote = null;
  }
  function showReviewContext(ctx) {
    const before = $('#ai-review-before'), after = $('#ai-review-after');
    if (ctx && ctx.before && ctx.before.trim()) {
      before.textContent = '— 前文上下文 —\n' + ctx.before;
      before.className = 'ai-review-ctx ai-review-before';
      before.scrollTop = before.scrollHeight; // 滚到最下方（贴近光标处）
    } else { before.className = 'ai-review-ctx ai-review-before empty'; before.textContent = ''; }
    if (ctx && ctx.after && ctx.after.trim()) {
      after.textContent = '— 后文上下文 —\n' + ctx.after;
      after.className = 'ai-review-ctx ai-review-after';
    } else { after.className = 'ai-review-ctx ai-review-after empty'; after.textContent = ''; }
  }
  function showRequirements(req) {
    const box = $('#ai-review-req'), pre = $('#ai-review-req-text');
    if (!box || !pre) return;
    if (req && req.trim()) { pre.textContent = req; box.classList.remove('hidden'); }
    else { pre.textContent = ''; box.classList.add('hidden'); }
  }
  // 剔除 AI 自言自语的「括号备注」（如 (主剧情继续)、(分支开始)、(待续)、(回到主线)），避免混进正文
  // 仅删除"中英文圆括号片段、且内部含结构/流程关键词"的部分，保护正常对白括号（如（他压低声音））
  function cleanAIMetaNotes(t) {
    if (!t) return t;
    const KW = /主剧情|分支|主线|待续|上接|下接|过渡|转场|剧情继续|此处接|另起|衔接|接上|回到主线|下接上文/;
    const lines = t.split(/\r?\n/);
    const out = [];
    for (let line of lines) {
      const cleaned = line.replace(/[（(][^（）()\n]{1,40}[）)]\s*/g, (m) => {
        const inner = m.replace(/^[（(]/, '').replace(/[）)]\s*$/, '');
        return KW.test(inner) ? '' : m;
      });
      out.push(cleaned);
    }
    return out.join('\n');
  }
  function acceptReview() {
    if (!aiReviewCtx) { closeReviewModal(); return; }
    let text = $('#ai-review-text').value;
    text = cleanAIMetaNotes(text); // 兜底剔除 AI 残留的括号备注
    // 含分块标记（对话分支数量>0 时 AI 产出 <<剧情块>>）→ 拆成「主剧情/主线 + 分支块」本地应用
    if (aiReviewMode === 'outline') {
      const sp = window.AI.splitIntoBlocks(text);
      if (Object.keys(sp.blocks).length) {
        applyGeneratedBlocks(text);
        closeReviewModal();
        aiReviewCtx = null; aiReviewMode = null;
        return;
      }
    } else if (aiReviewMode === 'continue') {
      const sp = window.AI.splitIntoBlocks(text);
      if (Object.keys(sp.blocks).length) {
        applyContinueBlocks(text, aiReviewCtx);
        closeReviewModal();
        aiReviewCtx = null; aiReviewMode = null;
        return;
      }
    } else if (aiReviewMode === 'expand' || aiReviewMode === 'polish') {
      const sp = window.AI.splitIntoBlocks(text);
      if (Object.keys(sp.blocks).length) {
        applySelectionBlocks(text, aiReviewCtx);
        closeReviewModal();
        aiReviewCtx = null; aiReviewMode = null;
        return;
      }
    }
    insertAIResult(text, aiReviewMode, aiReviewCtx);
    closeReviewModal();
    aiReviewCtx = null; aiReviewMode = null;
    toast('已插入 AI 生成内容');
  }
  // 把 AI 一次产出的多块剧本拆成「主剧情 + 分支剧情块」并写入存储
  function applyGeneratedBlocks(text) {
    const sp = window.AI.splitIntoBlocks(text);
    // 主剧情
    window.Storage.setBlockText(MAIN_BLOCK, sp.main);
    // 分支块：存在则覆盖、不存在则用同名新建（直接写入键名，避免 addBlock 改名破坏跳转引用）
    for (const name in sp.blocks) window.Storage.setBlockText(name, sp.blocks[name]);
    // 跳到「剧情块」库并载入主剧情展示（直接设，绕过 switchBlock 在主剧情时的早退）
    activeLib = 'dialogueblock';
    [].forEach.call(document.querySelectorAll('#lib-tabs .lib-tab'), x => x.classList.toggle('active', x.dataset.lib === 'dialogueblock'));
    activeBlock = MAIN_BLOCK;
    storyText.value = sp.main;
    updateWordCount();
    history = []; histIndex = -1; pushHistory();
    updateBlockChip();
    renderLibrary();
    refreshTodo();
    commitEdit();
    const n = Object.keys(sp.blocks).length;
    toast('已生成：主剧情 + ' + n + ' 个剧情块');
  }
  // 续写模式：主线插入到光标处（不覆盖当前块），分支块建入「剧情块」库
  function applyContinueBlocks(text, ctx) {
    const sp = window.AI.splitIntoBlocks(text);
    // 分支块：存在则覆盖、不存在则用同名新建（直接写键名，避免改名破坏跳转引用）
    for (const name in sp.blocks) window.Storage.setBlockText(name, sp.blocks[name]);
    // 主线（含 <剧情块:...> 跳转指令）插入到当前光标处
    insertAIResult(sp.main, 'continue', ctx);
    renderLibrary();
    refreshTodo();
    const n = Object.keys(sp.blocks).length;
    toast('已续写主线 + 新建 ' + n + ' 个剧情块');
  }
  // 重写 / 润色模式：把「主剧情（含内联 <选项> 指令）」替换原选中文字，分支块建入「剧情块」库
  function applySelectionBlocks(text, ctx) {
    const sp = window.AI.splitIntoBlocks(text);
    for (const name in sp.blocks) window.Storage.setBlockText(name, sp.blocks[name]);
    const ta = storyText;
    const st = ta.scrollTop;
    const s = ctx.selStart, e = ctx.selEnd;
    const before = ta.value.slice(0, s);
    const after = ta.value.slice(e);
    const padBefore = (before && !before.endsWith('\n')) ? '\n' : '';
    const padAfter = (after && !after.startsWith('\n')) ? '\n' : '';
    ta.value = before + padBefore + sp.main + padAfter + after;
    const pos = (before + padBefore).length + sp.main.length;
    ta.setSelectionRange(pos, pos);
    ta.focus(); ta.scrollTop = st; commitEdit();
    renderLibrary();
    refreshTodo();
    const n = Object.keys(sp.blocks).length;
    toast('已重写选中文字，并新建 ' + n + ' 个剧情块');
  }
  function showBlockSummary(sp) {
    const box = $('#ai-blocksum');
    if (!box) return;
    box.innerHTML = '';
    const isContinueMode = aiReviewMode === 'continue';
    const isSelectionMode = aiReviewMode === 'expand' || aiReviewMode === 'polish';
    const head = document.createElement('div');
    head.className = 'ai-blocksum-head';
    let headText;
    if (isContinueMode) headText = '<svg class="ico" aria-hidden="true"><use href="#ic-doc"/></svg> 将把 <b>续写主线</b> 插入光标处，并新建 <b>' + Object.keys(sp.blocks).length + '</b> 个剧情块（点「接受」即应用）：';
    else if (isSelectionMode) headText = '<svg class="ico" aria-hidden="true"><use href="#ic-doc"/></svg> 将用重写结果 <b>替换选中文字</b>，并新建 <b>' + Object.keys(sp.blocks).length + '</b> 个剧情块（点「接受」即应用）：';
    else headText = '<svg class="ico" aria-hidden="true"><use href="#ic-doc"/></svg> 将生成 <b>主剧情</b> + <b>' + Object.keys(sp.blocks).length + '</b> 个剧情块（点「接受」即拆好）：';
    head.innerHTML = headText;
    box.appendChild(head);
    const row = document.createElement('div');
    row.className = 'ai-blocksum-row';
    const addChip = (nm, isMain) => {
      const c = document.createElement('span');
      c.className = 'blk-chip' + (isMain ? ' blk-main' : '');
      c.innerHTML = isMain ? (isContinueMode ? '<svg class="ico" aria-hidden="true"><use href="#ic-pencil"/></svg> 续写主线（插入光标）' : (isSelectionMode ? '<svg class="ico" aria-hidden="true"><use href="#ic-pencil"/></svg> 重写结果（替换选中）' : '<svg class="ico" aria-hidden="true"><use href="#ic-lock"/></svg> 主剧情')) : ('<svg class="ico" aria-hidden="true"><use href="#ic-box"/></svg> ' + escapeHtml(nm));
      if (!isMain) {
        c.title = '点击切到该剧情块编辑';
        c.addEventListener('click', () => { switchBlock(nm); renderLibrary(); toast('已切换到「' + nm + '」'); });
      }
      row.appendChild(c);
    };
    addChip(MAIN_BLOCK, true);
    Object.keys(sp.blocks).forEach(nm => addChip(nm, false));
    box.appendChild(row);
    box.classList.remove('hidden');
  }
  function hideBlockSummary() {
    const box = $('#ai-blocksum');
    if (box) { box.innerHTML = ''; box.classList.add('hidden'); }
  }
  function reviseReview() {
    // 默认预填上一次用过的备注（首次=方向备注，重提后=上次重提内容），用户可直接修改或清空
    const note = prompt('告诉 AI 哪里要改（下方已保留上次的备注，可直接修改或清空）：', aiLastNote || '');
    if (note == null) return;
    aiReviseNote = note.trim();
    startGeneration();
  }
  function insertAIResult(text, mode, ctx) {
    const ta = storyText;
    const st = ta.scrollTop;
    if ((mode === 'expand' || mode === 'polish') && ctx && ctx.hasSel) {
      const s = ctx.selStart, e = ctx.selEnd;
      const before = ta.value.slice(0, s);
      const after = ta.value.slice(e);
      const padBefore = (before && !before.endsWith('\n')) ? '\n' : '';
      const padAfter = (after && !after.startsWith('\n')) ? '\n' : '';
      ta.value = before + padBefore + text + padAfter + after;
      const pos = (before + padBefore).length + text.length;
      ta.setSelectionRange(pos, pos);
    } else {
      insertAtCursor(text);
      return;
    }
    ta.focus(); ta.scrollTop = st; commitEdit();
  }
  // 钩子模式结果：渲染 6 个开头卡片，用户点「选用」插入其中一个
  function showHookChooser(hooks) {
    const chooser = $('#ai-hook-chooser');
    const list = $('#ai-hook-list');
    if (!chooser || !list) return;
    list.innerHTML = '';
    hooks.forEach((h, i) => {
      const card = document.createElement('div');
      card.className = 'ai-hook-card';
      const idx = document.createElement('div');
      idx.className = 'ai-hook-idx';
      idx.textContent = '方案 ' + (i + 1);
      const body = document.createElement('pre');
      body.className = 'ai-hook-body';
      body.textContent = h;
      const foot = document.createElement('div');
      foot.className = 'ai-hook-card-foot';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-primary btn-sm';
      btn.textContent = '选用';
      btn.addEventListener('click', () => {
        insertAIResult(h, 'hook', aiReviewCtx);
        closeReviewModal();
        aiReviewCtx = null; aiReviewMode = null; aiReviseNote = null;
        toast('已插入所选开头');
      });
      foot.appendChild(btn);
      card.appendChild(idx);
      card.appendChild(body);
      card.appendChild(foot);
      list.appendChild(card);
    });
    const head = chooser.querySelector('.ai-hook-head');
    if (head) head.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#ic-fish"/></svg> 挑选一个开头（共 ' + hooks.length + ' 个，点击「选用」即插入）';
    setAIStatus('完成 · 点击「选用」插入一个开头', '');
    setReviewPhase('result');
  }

  // 列头 🤖 快捷菜单：先列「全文助理」（对话式），再列 4 种写作方式（按用户指定顺序），按上下文给「推荐」标记
  function openAIQuickMenu() {
    const menu = $('#ai-quick-menu');
    const hasSel = storyText.selectionStart !== storyText.selectionEnd;
    const isBlank = !storyText.value.trim();
    const article = currentProjectMode === 'article';
    const items = [
      { mode: 'ft', special: 'openFulltext', label: '<svg class="ico" aria-hidden="true"><use href="#ic-brain"/></svg> 全文助理（对话式 AI，可全文改写）' },
      { mode: 'hook', label: '<svg class="ico" aria-hidden="true"><use href="#ic-fish"/></svg> 生成文章开头（6 选 1）', rec: isBlank },
      { mode: 'continue', label: article ? '<svg class="ico" aria-hidden="true"><use href="#ic-pencil"/></svg> AI 续写文章（按设定 / 上下文）' : '<svg class="ico" aria-hidden="true"><use href="#ic-pencil"/></svg> AI 生成剧情（按设定 / 上下文）', rec: !hasSel },
      { mode: 'expand', label: '<svg class="ico" aria-hidden="true"><use href="#ic-redo"/></svg> AI 重写选中文字', rec: hasSel },
      { mode: 'polish', label: '<svg class="ico" aria-hidden="true"><use href="#ic-sparkles"/></svg>' + (article ? ' 润色选中文字' : ' 润色加文字效果'), rec: hasSel },
    ];
    menu.innerHTML = items.map(it =>
      '<button data-mode="' + it.mode + '"' + (it.special ? ' data-special="' + it.special + '"' : '') + (it.rec ? ' class="ai-q-recommend"' : '') + '>' +
      it.label + (it.rec ? ' <span class="ai-q-tag">推荐</span>' : '') + '</button>'
    ).join('');
    const btn = $('#btn-ai-quick');
    const r = btn.getBoundingClientRect();
    menu.style.top = (r.bottom + 6) + 'px';
    menu.style.left = Math.max(8, r.left - 120) + 'px';
    menu.classList.remove('hidden');
    menu.querySelectorAll('button').forEach(b => {
      b.addEventListener('click', () => {
        menu.classList.add('hidden');
        if (b.dataset.special === 'openFulltext') openFulltextAssistant();
        else prepareMode(b.dataset.mode);
      });
    });
  }
  function closeAIQuickMenu() { $('#ai-quick-menu').classList.add('hidden'); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
