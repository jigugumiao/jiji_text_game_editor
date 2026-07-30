// js/bbcode.js — BBCode 解析与图形化编辑辅助

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 把 BBCode 文本转为 HTML（用于运行时渲染）
// 支持：[b][i][u][s][color=hex][size=n][center][br] 以及换行
function bbcodeToHtml(s) {
  if (s == null) return '';
  let t = escapeHtml(s);
  t = t.replace(/\n/g, '[br]');
  // 顺序很重要：先处理带属性的，再处理简单的
  t = t.replace(/\[color=([^\]]+)\]((?:[^[]|\[(?!color=))*)\[\/color\]/g,
    (m, c, inner) => `<span style="color:${c}">${inner}</span>`);
  t = t.replace(/\[size=(\d+)\]((?:[^[]|\[(?!size=))*)\[\/size\]/g,
    (m, n, inner) => `<span style="font-size:${n}px">${inner}</span>`);
  t = t.replace(/\[center\]((?:[^[]|\[(?!center))*)\[\/center\]/g,
    (m, inner) => `<div style="text-align:center">${inner}</div>`);
  t = t.replace(/\[left\]((?:[^[]|\[(?!left))*)\[\/left\]/g,
    (m, inner) => `<div style="text-align:left">${inner}</div>`);
  t = t.replace(/\[right\]((?:[^[]|\[(?!right))*)\[\/right\]/g,
    (m, inner) => `<div style="text-align:right">${inner}</div>`);
  t = t.replace(/\[b\]((?:[^[]|\[(?!b]))*)\[\/b\]/g, '<b>$1</b>');
  t = t.replace(/\[i\]((?:[^[]|\[(?!i]))*)\[\/i\]/g, '<i>$1</i>');
  t = t.replace(/\[u\]((?:[^[]|\[(?!u]))*)\[\/u\]/g, '<u>$1</u>');
  t = t.replace(/\[s\]((?:[^[]|\[(?!s]))*)\[\/s\]/g, '<s>$1</s>');
  t = t.replace(/\[br\]/g, '<br>');
  // 特效（与编辑器预览 renderBBCode、运行时 exporter.js 保持一致，做到所见即所得）
  t = t.replace(/\[shadow=([^\]]+)\]/g, '<span style="text-shadow:2px 2px 4px $1">');
  t = t.replace(/\[\/shadow\]/g, '</span>');
  t = t.replace(/\[glow=([^\]]+)\]/g, '<span style="text-shadow:0 0 8px $1,0 0 16px $1,0 0 24px $1">');
  t = t.replace(/\[\/glow\]/g, '</span>');
  t = t.replace(/\[highlight=([^\]]+)\]/g, '<mark style="background:$1;color:#000;padding:0 4px;border-radius:3px">');
  t = t.replace(/\[\/highlight\]/g, '</mark>');
  // 瞬显：编辑器/运行时内整段直接出现（不逐字）
  t = t.replace(/\[瞬显\]/g, '<span class="instant">');
  t = t.replace(/\[\/瞬显\]/g, '</span>');
  return t;
}

// 统计渲染后纯文本字符数（用于打字机进度）
function bbcodeTextLength(s) {
  const d = document.createElement('div');
  d.innerHTML = bbcodeToHtml(s || '');
  return (d.textContent || '').length;
}

// 基于显式字符偏移包裹（不依赖焦点/选区 API，移动端只读态也能用）
function wrapAtRange(ta, start, end, before, after, placeholder) {
  if (!ta) return false;
  let s = start, e = end;
  if (!(e > s)) { // 无有效选区：取偏移所在整行
    const val = ta.value, cur = start;
    s = val.lastIndexOf('\n', cur - 1) + 1;
    const le = val.indexOf('\n', cur);
    e = le === -1 ? val.length : le;
  }
  const sel = ta.value.slice(s, e) || (placeholder || '');
  const newVal = ta.value.slice(0, s) + before + sel + after + ta.value.slice(e);
  ta.value = newVal;
  // 若文本框当前有焦点，恢复光标到包裹后选区；否则不抢焦点（避免弹输入法）
  if (document.activeElement === ta) {
    try { ta.setSelectionRange(s + before.length, s + before.length + sel.length); } catch (_) {}
  }
  return true;
}
// 在指定偏移插入（不依赖焦点）
function insertAtRange(ta, pos, text) {
  if (!ta) return false;
  const p = pos == null ? ta.selectionStart : pos;
  const val = ta.value;
  ta.value = val.slice(0, p) + text + val.slice(ta.selectionEnd);
  if (document.activeElement === ta) {
    try { ta.setSelectionRange(p + text.length, p + text.length); } catch (_) {}
  }
  return true;
}

// 给文本块中「选中文本」包裹 BBCode 标签（兼容旧接口；range 优先用显式偏移）
function wrapSelection(ta, before, after, placeholder, range) {
  let s, e;
  if (range && range.end > range.start) { s = range.start; e = range.end; }
  else { s = ta.selectionStart; e = ta.selectionEnd; }
  return wrapAtRange(ta, s, e, before, after, placeholder);
}
// 插入不包裹的标签（如 [br]）
function insertAtCursor(ta, text, range) {
  const pos = (range && range.end > range.start) ? range.start : (ta ? ta.selectionStart : 0);
  return insertAtRange(ta, pos, text);
}

const BBCode = { escapeHtml, bbcodeToHtml, bbcodeTextLength, wrapSelection, insertAtCursor, wrapAtRange, insertAtRange };
if (typeof window !== 'undefined') window.BBCode = BBCode;
if (typeof module !== 'undefined' && module.exports) module.exports = BBCode;
