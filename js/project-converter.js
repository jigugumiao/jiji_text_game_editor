// js/project-converter.js — old game projects are copied, never upgraded in place.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ProjectConverter = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function nextConvertedName(sourceName, projects) {
    const base = String(sourceName || '未命名项目').trim() || '未命名项目';
    const names = new Set((projects || []).map(p => p && p.name));
    const first = base + '（可视化版）';
    if (!names.has(first)) return first;
    let n = 2;
    while (names.has(base + '（可视化版 ' + n + '）')) n++;
    return base + '（可视化版 ' + n + '）';
  }

  function blockEntries(snapshot) {
    const blocks = snapshot && snapshot.blocks || {};
    const out = [['__MAIN__', blocks.main || '']];
    Object.keys(blocks.blocks || {}).forEach(name => out.push([name, blocks.blocks[name] || '']));
    return out;
  }

  function optionTokens(line) {
    const tokens = [];
    let start = line.indexOf('<选项:');
    while (start !== -1) {
      let end = start + 4;
      while ((end = line.indexOf('>', end)) !== -1 && line[end - 1] === '=') end++;
      if (end === -1) break;
      tokens.push(line.slice(start, end + 1));
      start = line.indexOf('<选项:', end + 1);
    }
    return tokens;
  }

  function analyzeProjectSnapshot(snapshot) {
    const stateNames = new Set(((snapshot && snapshot.vars) || []).map(v => v && v.name).filter(Boolean));
    const counts = { options: 0, stateChanges: 0, effects: 0 };
    const issues = [];
    blockEntries(snapshot).forEach(([block, text]) => String(text).split('\n').forEach((line, index) => {
      const lineNo = index + 1;
      const options = optionTokens(line);
      counts.options += options.length;
      counts.stateChanges += (line.match(/<变量:[^>]*>/g) || []).length;
      counts.effects += (line.match(/(?:^|,)变化:([^,>]+)/g) || []).length;
      options.forEach(option => {
        const condition = /(?:^|,)条件:([^,>]+)/.exec(option);
        if (condition) {
          const refs = condition[1].match(/[\u4e00-\u9fa5A-Za-z_][\u4e00-\u9fa5A-Za-z0-9_]*/g) || [];
          refs.filter(name => !['true', 'false', 'contains'].includes(name) && !stateNames.has(name)).forEach(name => {
            issues.push({ block, line: lineNo, message: '条件引用了未定义的剧情状态：' + name });
          });
        }
      });
    }));
    return { counts, issues };
  }

  function buildConversionReport(snapshot, analysis) {
    const result = analysis || analyzeProjectSnapshot(snapshot);
    return { counts: result.counts, issues: result.issues, lostContentCount: 0 };
  }

  async function copyProjectForVisual(sourceId, requestedName, adapter) {
    if (!adapter) throw new Error('缺少项目存储适配器');
    const snapshot = await adapter.readProjectSnapshot(sourceId);
    if (!snapshot) throw new Error('找不到原项目');
    const targetId = adapter.createId ? adapter.createId() : ('proj_visual_' + Date.now().toString(36));
    try {
      await adapter.writeTemporaryProject(snapshot, targetId);
      await adapter.validateTemporaryProject(targetId);
      await adapter.registerTemporaryProject(targetId, requestedName, {
        visualEditorVersion: 1,
        convertedFrom: sourceId
      });
      return { projectId: targetId, report: buildConversionReport(snapshot) };
    } catch (error) {
      try { await adapter.cleanupTemporaryProject(targetId); } catch (cleanupError) { console.error('清理转换临时数据失败', cleanupError); }
      throw error;
    }
  }

  return { nextConvertedName, analyzeProjectSnapshot, buildConversionReport, copyProjectForVisual };
});
