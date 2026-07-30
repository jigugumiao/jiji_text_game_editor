// 测试 computeStartNode：把光标字符偏移映射到「第几个节点」
// 验证「从光标开始」试玩时，起点节点计算正确。
const assert = require('assert');
const { computeStartNode } = require('../js/exporter.js');

let pass = 0, fail = 0;
function check(name, got, want) {
  try { assert.strictEqual(got, want); pass++; }
  catch (e) { fail++; console.log('✗ ' + name + ' —— 期望 ' + want + '，实际 ' + got); }
}

// 计算某行行首的字符偏移
function offsetAtLine(src, lineNo) {
  const lines = src.split(/\r?\n/);
  let off = 0;
  for (let i = 0; i < lineNo && i < lines.length; i++) off += lines[i].length + 1; // +1 换行符
  return off;
}

// 1) 纯文本：两行文本合并为 1 个 text 节点
let s1 = '第一行剧情\n第二行剧情';
check('纯文本·第0行→节点0', computeStartNode(s1, 0), 0);
check('纯文本·第1行中间→节点0', computeStartNode(s1, offsetAtLine(s1, 1) + 2), 0);

// 2) 指令行分割节点
let s2 = '开场白\n<召唤背景:森林>\n<停顿>\n继续说些什么';
// 节点：0 文本(开场白) 1 summon 2 pause 3 文本(继续说些什么)
check('指令·第0行→0', computeStartNode(s2, 0), 0);
check('指令·<召唤背景>行→1', computeStartNode(s2, offsetAtLine(s2, 1)), 1);
check('指令·<停顿>行→2', computeStartNode(s2, offsetAtLine(s2, 2)), 2);
check('指令·最后文本行→3', computeStartNode(s2, offsetAtLine(s2, 3) + 1), 3);

// 3) 空行分隔文本缓冲
let s3 = '甲\n\n乙\n丙';
// 节点：0 文本(甲) 1 文本(乙,丙) —— 中间空行结束第一个缓冲
check('空行·甲行→0', computeStartNode(s3, 0), 0);
check('空行·乙行→1', computeStartNode(s3, offsetAtLine(s3, 2)), 1);
check('空行·丙行→1', computeStartNode(s3, offsetAtLine(s3, 3)), 1);

// 4) 注释行被忽略
let s4 = '正文\n// 这是注释\n<召唤音乐:主题>';
// 节点：0 文本(正文) 1 summon(music)
check('注释·正文行→0', computeStartNode(s4, 0), 0);
check('注释·召唤行→1', computeStartNode(s4, offsetAtLine(s4, 2)), 1);

// 5) 选项行定位（每个 <选项:> 行各自是 1 个 options 节点）
let s5 = '抉择前\n<选项:"左走",左路>\n<选项:"右走",右路>\n之后';
// 节点：0 文本(抉择前) 1 options(左走) 2 options(右走) 3 文本(之后)
check('选项·前→0', computeStartNode(s5, 0), 0);
check('选项·选项行→1', computeStartNode(s5, offsetAtLine(s5, 1)), 1);
check('选项·之后行→3', computeStartNode(s5, offsetAtLine(s5, 3)), 3);

// 6) 越界/空文档安全
check('空串→0', computeStartNode('', 0), 0);
check('超长偏移→末节点', computeStartNode(s5, 99999), 3);

console.log('\n光标起点映射测试：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
