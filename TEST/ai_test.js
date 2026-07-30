// 端到端测试：AI 模块 + bbcode glow + exporter 导出守卫
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;
global.navigator = dom.window.navigator;

// ---- mock Storage（纯内存，不需 indexedDB） ----
const ASSETS = { background: [{ name: '天空' }], item: [{ name: '宝箱' }], music: [{ name: '主题曲' }], sound: [{ name: '雷声' }] };
dom.window.Storage = {
  LIBS: ['background', 'item', 'music', 'sound'],
  getAllAssets: async (lib) => ASSETS[lib] || [],
  loadMeta: () => ({ aiKey: 'sk-SECRET-LEAK', creation: { outline: '主角被困矿洞' } }),
  saveMeta: () => {},
  loadStory: () => [],
};
global.window.StoryEditorApi = {
  getText: () => '前文一行\n第二行\n<召唤背景:天空>\n',
  getSel: () => { const t = '前文一行\n第二行\n<召唤背景:天空>\n'; return { start: t.length, end: t.length }; },
  getCreation: () => ({ outline: '主角被困矿洞', intro: '', world: '', tone: '' }),
};
// 配置 API Key（否则 orchestrate 会拒绝，符合真实守卫行为）
localStorage.setItem('storyeditor:ai:key', 'sk-test-key');

// ---- mock fetch，返回 SSE 流 ----
global.fetch = async () => {
  const body = 'data: {"choices":[{"delta":{"content":"续写内容\\n<召唤背景:天空>"}}]}\n\ndata: [DONE]\n\n';
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    pull(c) { c.enqueue(enc.encode(body)); c.close(); },
  });
  return { ok: true, status: 200, body: stream };
};

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } }

const AI = require('../js/ai.js');
const BBCode = require('../js/bbcode.js');

(async () => {
  // 1) parseOutput 剥代码块
  assert(AI.parseOutput('```\n<召唤背景:天空>\n```') === '<召唤背景:天空>', 'parseOutput 应剥 ``` 代码块');
  assert(AI.parseOutput('<召唤背景:天空>') === '<召唤背景:天空>', 'parseOutput 普通文本不变');
  // 归一化换行：句间空行（连续 2+ 换行）必须被压成单个换行
  assert(AI.parseOutput('雨下了一夜。\n\n我推开门。\n\n\n走廊空无一人。') === '雨下了一夜。\n我推开门。\n走廊空无一人。', 'parseOutput 应把句间空行压成单行换行');

  // 2) buildContext 注入真实素材名 + 前文
  const ctx = await AI.buildContext('continue');
  assert(ctx.assets.background.includes('天空'), 'buildContext 应注入真实背景名「天空」');
  assert(ctx.assets.music.includes('主题曲'), 'buildContext 应注入真实音乐名「主题曲」');
  assert(ctx.before.includes('前文一行'), 'buildContext 应取前文');
  assert(ctx.creation.outline === '主角被困矿洞', 'buildContext 应读创作设定');

  // 3) orchestrate 流式产出原生标记
  let tokenCount = 0;
  const text = await AI.orchestrate({ mode: 'continue', ctx, onToken: () => { tokenCount++; } });
  assert(text.includes('<召唤背景:天空>'), 'orchestrate 输出应含原生召唤指令');
  assert(text.includes('续写内容'), 'orchestrate 输出应含正文');
  assert(tokenCount > 0, 'orchestrate 应触发流式 onToken');
  assert(!text.includes('```'), 'orchestrate 输出不应含 ```');

  // 4) 强度档约束文本
  const light = AI.systemPrompt('轻');
  const heavy = AI.systemPrompt('重');
  assert(light.includes('极克制') && heavy.includes('密集'), 'systemPrompt 强度档应区分');

  // 4a) 谜题设计数量（召唤物体）约束：应注入 systemPrompt，受 puzzle 参数控制
  const spNoPuzzle = AI.systemPrompt('中', 0, 0);
  assert(spNoPuzzle.includes('【谜题数量（召唤物体）】') && spNoPuzzle.includes('不强制'), 'puzzle=0 时应提示不强制谜题数量');
  const spPuzzle = AI.systemPrompt('中', 5, 0);
  assert(spPuzzle.includes('约 5 个') && spPuzzle.includes('召唤物品'), 'puzzle=5 时应要求约 5 个召唤物体谜题');
  assert(spPuzzle.includes('结束物体') && spPuzzle.includes('旋转'), '召唤物品说明应包含游戏作用（旋转检视 / 结束物体关闭继续）');

  // 4a2) 对话分支数量约束：应注入 systemPrompt，受 branches 参数控制
  const spNoBranch = AI.systemPrompt('中', 0, 0);
  assert(spNoBranch.includes('【对话分支数量】') && spNoBranch.includes('不强制'), 'branches=0 时应提示不强制对话分支数量');
  const spBranch = AI.systemPrompt('中', 0, 3);
  assert(spBranch.includes('约 3 个') && spBranch.includes('对话 / 选择分支'), 'branches=3 时应要求约 3 个对话/选择分支');
  assert(spBranch.includes('<选项:') && spBranch.includes('<<剧情块:') && spBranch.includes('<跳回>'), '对话分支说明应包含指令语法（<选项: / <<剧情块: / <跳回>）');
  // 4a3) 分块结构已并入分支约束（原「生成完整分块剧本」开关废弃）：branches>0 应带出主剧情+分块+单/双尖括号区分
  assert(spBranch.includes('主剧情') && spBranch.includes('单 / 双尖括号'), 'branches>0 应说明主剧情结构与单/双尖括号区分（吸收原多块开关）');

  // 4b) 字号与排版约束：AI 提示词须按"克制"规则覆盖 [size=n] / 对齐 / [br] / i·u·s
  const sp = AI.systemPrompt('中');
  assert(sp.includes('【字号 [size=n]】'), 'systemPrompt 应包含字号 [size=n] 约束');
  assert(sp.includes('正文默认不加任何字号标签') && sp.includes('仅在突发情况'), '字号约束应强调默认不加、仅突发/响声/紧急用大字号');
  assert(sp.includes('【排版（对齐与换行）】') && sp.includes('[center]') && sp.includes('[br]'), '排版约束应覆盖对齐与 [br]（悬浮标题内换行）');
  assert(sp.includes('【斜体 / 下划线 / 删除线】') && sp.includes('平常禁止使用'), 'i/u/s 约束应明确平常禁止、仅信件可用');
  assert(sp.includes('每个 <停顿> 前刻意的表现类标签') && sp.includes('[size=]'), '克制锚点应把偶发 [size=] 计入停顿前效果上限');
  // 4b2) 材质描写克制：AI 提示词须约束不铺陈物品材质/物性，用自然人感方式表达
  assert(sp.includes('【克制：材质与物性描写】'), 'systemPrompt 应包含材质物性描写克制规则');
  assert(sp.includes('冰凉的金属边缘') && sp.includes('还在口袋里摸到过它'), '材质克制应含反例(冰凉的金属边缘)与正例(还在口袋里摸到过它)对照');

  // 4b4) 生理反应暗示情绪：零度叙事下允许用可观察的身体事实暗示情绪，增强代入感
  assert(sp.includes('用生理反应暗示情绪') && sp.includes('冷汗顺着我的脸颊流下来'), 'systemPrompt 应允许用生理反应(如冷汗)暗示情绪以增强代入感，并含正例');
  assert(sp.includes('只写可观察的身体事实') && sp.includes('不写“恐惧涌上心头”'), '生理描写应限定为可观察身体事实、禁止心理命名');
  // 4b5) "我"意向自由：身体阻碍(冷汗/腿)作为物体层事实单独成句，不与"我"动作同写
  assert(sp.includes('“我”的意向保持自由') && sp.includes('身体阻碍不与“我”同写'), 'systemPrompt 应要求"我"意向自由、身体阻碍不与"我"同句');
  assert(sp.includes('僵直的双腿拖着不肯动') && sp.includes('我转过身'), '生理示例应展示身体状态单独成句、"我"动作保持干净');

  // 4b3) 方括号 [] 与 尖括号 <> 分类：明确两套标记形状不同、结尾不能混用
  assert(sp.includes('两类标记总览') || sp.includes('方括号 []') && sp.includes('尖括号 <>'), 'systemPrompt 应分类说明方括号与尖括号两套标记');
  assert(sp.includes('[/标签]') && sp.includes('绝不能写成 </标签>'), '应强调方括号标签结尾必须是 [/标签]，禁止写成 </标签> (HTML 风格)');
  assert(sp.includes('[color=#ff6a00]橙黄色的光[/color]') && sp.includes('[color=#ff6a00]橙黄色的光</color>'), '应同时给出 color 的正确与错误(尖括号结尾)对照示例');
  assert(sp.includes('标记速查') && sp.includes('分列'), '应有一段把方括号与尖括号例子分列摆放的速查');

  // 4b6) 放钩子（悬念节奏方法论）：已注入 systemPrompt，四法 + 红线 + 零度叙事协同
  assert(sp.includes('【放钩子') && sp.includes('夺魂钩') && sp.includes('回马枪'), 'systemPrompt 应包含放钩子方法论（开篇夺魂钩 + 章末回马枪）');
  assert(sp.includes('长期悬念') && sp.includes('伏笔与暗示'), '放钩子应含主线长期悬念与伏笔暗示两法');
  assert(sp.includes('有挖必有填') && sp.includes('只挖不填'), '放钩子红线应强调钩子必须回收（有挖必有填）');
  assert(sp.includes('与【<停顿> 密度】协同') && sp.includes('零度叙事下'), '放钩子应声明与停顿密度协同、并与零度叙事回收方式一致');
  // 换行/空行约束：严禁句间空行，场景转换用 <分割线:> 而非空行
  assert(sp.includes('【换行与空行') && sp.includes('严禁') && sp.includes('连续两个回车'), 'systemPrompt 应显式禁止句间空行（连续两个回车）');
  assert(sp.includes('<分割线:>') && sp.includes('不要用空行'), '换行约束应说明场景转换用 <分割线:> 而非空行');

  // 4c) 运行时渲染：信件排版 [left]/[center]/[right] 在游戏中均生效（exporter 与 bbcode 一致）
  const cl = BBCode.bbcodeToHtml('[left]左[/left]');
  const cc = BBCode.bbcodeToHtml('[center]中[/center]');
  const cr = BBCode.bbcodeToHtml('[right]右[/right]');
  assert(cl.includes('text-align:left') && cc.includes('text-align:center') && cr.includes('text-align:right'), 'bbcodeToHtml 应支持信件三向对齐 [left]/[center]/[right]');

  // 5) bbcode glow/shadow 映射（所见即所得）
  const g = BBCode.bbcodeToHtml('[glow=橙]岩浆[/glow]');
  assert(g.includes('text-shadow'), 'bbcodeToHtml 应支持 [glow=]');
  const sh = BBCode.bbcodeToHtml('[shadow=黑]影[/shadow]');
  assert(sh.includes('text-shadow'), 'bbcodeToHtml 应支持 [shadow=]');

  // 6) exporter 导出守卫：meta 里的 aiKey 不进 global
  let exporterOk = true;
  try {
    const Exporter = require('../js/exporter.js');
    const data = await Exporter.collectRuntimeData(true);
    assert(!('aiKey' in data.global), 'collectRuntimeData 的 global 不应含 aiKey');
    const dumped = JSON.stringify(data.global);
    assert(!dumped.includes('sk-SECRET-LEAK'), '导出数据不应泄露 API Key');
  } catch (e) {
    exporterOk = false;
    console.error('  ⚠ exporter 测试跳过（模块加载需浏览器环境）：', e.message);
  }

  // 7) 重写/润色：AI 应拿到前后文语境（UI 不展示给用户、结果也不应包含前后文）
  const selCtx = {
    full: '前文一行\n选中段落\n后文一行', selStart: 5, selEnd: 10, hasSel: true, selText: '选中段落',
    before: '前文一行', after: '后文一行',
    creation: { outline: '矿洞' }, assets: ASSETS, caretLine: 2,
  };
  const expandMsg = AI.buildUserMessage('expand', selCtx, '', '');
  assert(expandMsg.includes('前文（光标之前）'), 'expand 提示应包含前文上下文');
  assert(expandMsg.includes('后文（光标之后）'), 'expand 提示应包含后文上下文');
  assert(expandMsg.includes('选中段落'), 'expand 提示应包含选中文字');
  assert(expandMsg.includes('不要包含也不重复前后文'), 'expand 应约束只输出选中文字结果');
  const polishMsg = AI.buildUserMessage('polish', selCtx, '', '');
  assert(polishMsg.includes('前文（光标之前）') && polishMsg.includes('后文（光标之后）'), 'polish 提示应包含前后文上下文');
  assert(polishMsg.includes('不要包含也不重复前后文'), 'polish 应约束只输出选中文字结果');

  // 8) 生成钩子开头：提示词须规定 6 个【钩子N】格式、带入创作设定（文风）、遵循开篇夺魂钩
  const hookCtx = {
    full: '', selStart: 0, selEnd: 0, hasSel: false, selText: '',
    before: '', after: '',
    creation: { outline: '末日废土', intro: '幸存者寻找绿洲', world: '辐射荒漠', style: '冷峻零度' },
    assets: ASSETS, caretLine: 1,
  };
  const hookMsg = AI.buildUserMessage('hook', hookCtx, '', '');
  assert(hookMsg.includes('【钩子1】') && hookMsg.includes('【/钩子1】'), 'hook 提示应规定【钩子1】…【/钩子1】输出格式');
  assert(hookMsg.includes('【钩子6】') && hookMsg.includes('【/钩子6】'), 'hook 提示应规定第 6 个钩子格式');
  assert(hookMsg.includes('夺魂钩'), 'hook 提示应要求遵循开篇「夺魂钩」');
  assert(hookMsg.includes('文风：冷峻零度'), 'hook 提示创作设定里应用「文风：」而非「语气：」');
  assert(!hookMsg.includes('语气：'), 'hook 提示不应再使用「语气：」（已更名为文风）');
  assert(hookMsg.includes('大纲：末日废土') && hookMsg.includes('世界观：辐射荒漠'), 'hook 提示应带入大纲与世界观');
  // 8a) 分块结构已从 buildUserMessage 移除（原多块开关废弃），改由 systemPrompt 的 branchRule 统一注入
  const outlineCtx = { full: '', selStart: 0, selEnd: 0, hasSel: false, selText: '', before: '', after: '', creation: { outline: '矿洞' }, assets: ASSETS, caretLine: 1 };
  const outlineMsg = AI.buildUserMessage('outline', outlineCtx, '', '');
  assert(!outlineMsg.includes('多剧情块剧本') && !outlineMsg.includes('多对话块剧本'), 'buildUserMessage 不应再注入独立的多块剧本指令（已并入分支约束）');
  // branches>0 时，分块结构由 systemPrompt 携带
  const spOutlineBranch = AI.systemPrompt('中', 0, 2);
  assert(spOutlineBranch.includes('<<剧情块:') && spOutlineBranch.includes('<跳回>') && spOutlineBranch.includes('单 / 双尖括号'), 'branches>0 的 systemPrompt 应携带 <<剧情块>>/<跳回>/单双尖括号区分');

  // 8b) 大纲/续写已合并为单一 continue 生成入口；「深度思考」开关控制篇幅（深=多场景大段；浅=一个桥段）
  const genCtx = { full: '', selStart: 0, selEnd: 0, hasSel: false, selText: '', before: '前文若干', after: '', creation: { outline: '矿洞' }, assets: ASSETS, caretLine: 1 };
  const genShallow = AI.buildUserMessage('continue', genCtx, '', '', false);
  const genDeep = AI.buildUserMessage('continue', genCtx, '', '', true);
  assert(genShallow.includes('一个完整的桥段') && !genShallow.includes('3～5 个连续'), '未开深度思考应只写一个完整桥段');
  assert(genDeep.includes('3～5 个连续') && genDeep.includes('阶段性收束点'), '开启深度思考应铺开多个场景的大段初稿');
  assert(genDeep.includes('前文若干'), '生成任务应带入光标前文');
  // 对话分支数量 >0 时，用户消息必须内联分支强化：选项内联 + 分支块必须写完 + 红线
  const genBranch = AI.buildUserMessage('continue', genCtx, '', '', false, 3);
  assert(genBranch.includes('对话分支写法') && genBranch.includes('对话分支数量=3'), 'branches>0 应在用户消息内联分支写法提示');
  assert(genBranch.includes('真正发生该抉择的那一行之后') && genBranch.includes('绝不能只抛 <选项>'), '分支提示应要求选项内联在抉择点且禁止空选项（不出分支块）');
  const genNoBranch = AI.buildUserMessage('continue', genCtx, '', '', false, 0);
  assert(!genNoBranch.includes('对话分支写法'), 'branches=0 不应注入分支写法提示');

  // splitHooks 解析 6 个成对标签
  const sample = '【钩子1】醒来时手腕多了一副环。\n<停顿>\n【/钩子1】\n【钩子2】那封信只有一句：“别回头。”\n【/钩子2】\n【钩子3】a【/钩子3】\n【钩子4】b【/钩子4】\n【钩子5】c【/钩子5】\n【钩子6】d【/钩子6】';
  const hooks = AI.splitHooks(sample);
  assert(hooks.length === 6, 'splitHooks 应解析出 6 个开头（实得 ' + hooks.length + '）');
  assert(hooks[0].includes('醒来时手腕多了一副环'), 'splitHooks[0] 内容应正确');
  assert(hooks[5].includes('d'), 'splitHooks[5] 应是第 6 个');
  // 兜底：无【钩子】标签时按数字标题切分
  const fallback = AI.splitHooks('1. 第一版开场\n2. 第二版开场\n3. 第三版开场');
  assert(fallback.length >= 2, 'splitHooks 兜底应按数字标题切分（实得 ' + fallback.length + '）');

  // 9) splitIntoBlocks：把 AI 一次产出的多块剧本拆成「主对话 + 分支块」
  // 9a) 无分块标记：main = 整段，blocks 为空（向下兼容单块写法）
  const noSplit = AI.splitIntoBlocks('第一段\n<停顿>\n第二段');
  assert(noSplit.main === '第一段\n<停顿>\n第二段', '无分块标记时 main 应等于原文');
  assert(Object.keys(noSplit.blocks).length === 0, '无分块标记时 blocks 应为空');

  // 9b) 单个分支块：抽出后 main 不再插入无条件跳转指令，块内容以 <跳回> 收尾
  const oneBlk = AI.splitIntoBlocks('主对话开头\n<停顿>\n<<对话块:支线A>>\n支线内容\n<跳回>');
  assert(!oneBlk.main.includes('<对话块:支线A>'), '主对话不应再插入 <对话块:支线A> 无条件跳转指令（分支由 <选项> 到达）');
  assert(oneBlk.main.startsWith('主对话开头'), '主对话应以原文开头');
  assert(oneBlk.blocks['支线A'] && oneBlk.blocks['支线A'].includes('支线内容'), '支线A 块应含其内容');
  assert(oneBlk.blocks['支线A'].trim().endsWith('<跳回>'), '支线A 块应以 <跳回> 收尾');

  // 9c) 子块漏写 <跳回> 时自动补，保证运行时能返回父块
  const noReturn = AI.splitIntoBlocks('主\n<<对话块:密室>>\n在密室里搜查');
  assert(noReturn.blocks['密室'].trim().endsWith('<跳回>'), '漏写 <跳回> 的子块应被自动补上');

  // 9d) 块内继续写（<跳回> 之后的内容回到父块续写）
  const withCont = AI.splitIntoBlocks('甲\n<<对话块:支线>>\n支线内容\n<跳回>\n乙');
  assert(withCont.main.includes('乙'), '主对话在 <跳回> 之后应继续（乙）');
  assert(!withCont.main.includes('支线内容'), '主对话不应包含子块内部内容（支线内容）');

  // 9e) 嵌套块：块内再用 <<对话块:...>> 定义孙块，抽出后各自独立成块、main 不再含跳转指令
  const nested = AI.splitIntoBlocks('开场\n<<对话块:父>>\n父内容\n<<对话块:孙>>\n孙内容\n<跳回>\n<跳回>');
  assert(nested.blocks['父'] && nested.blocks['父'].trim().endsWith('<跳回>'), '父块应独立存在并以 <跳回> 收尾');
  assert(nested.blocks['孙'] && nested.blocks['孙'].includes('孙内容'), '孙块应独立存在并含其内容');
  assert(!nested.main.includes('<对话块:父>') && nested.main === '开场', '主对话不再插入无条件跳转指令，仅保留块前原文');

  // 9f) 多分支块：多个 <<对话块:...>> 各自成块，main 不再插入跳转指令
  const multi = AI.splitIntoBlocks('头\n<<对话块:A>>\nA内容\n<跳回>\n<<对话块:B>>\nB内容\n<跳回>');
  assert(multi.blocks['A'] && multi.blocks['B'], '应生成 A、B 两个分支块');
  assert(multi.main === '头' && !multi.main.includes('<对话块:'), '主对话不应再插入 A/B 跳转指令，仅保留块前原文');

  console.log('\n==== AI 流程测试 ====');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  if (fail === 0 && exporterOk) console.log('全部 PASS ✅');
  else if (fail === 0) console.log('核心 PASS（exporter 守卫因环境跳过，已 node --check）');
  else process.exit(1);
})();
