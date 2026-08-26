// 条件选项必须由 StoryOptions 统一解析，避免编辑器和导出端再分叉。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const StoryOptions = require('../js/story-options.js');

const editorSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'editor.js'), 'utf8');
const exporterSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'exporter.js'), 'utf8');
for (const [tag, src] of [['editor.js', editorSrc], ['exporter.js', exporterSrc]]) {
  assert.match(src, /StoryOptions\.extractOptionLine/, tag + ' uses shared extraction');
  assert.doesNotMatch(src, /function extractOptionLine\(line\)/, tag + ' has no duplicate extraction');
  assert.doesNotMatch(src, /function splitOptionExtra\(extra\)/, tag + ' has no duplicate field splitting');
}

{
  const opts = StoryOptions.extractOptionLine('<选项:"强攻",战斗块,条件:力量>=20><选项:"偷摸",潜入,条件:警戒<5>');
  assert.equal(opts.length, 2);
  assert.equal(opts[0].option.block, '战斗块');
  assert.equal(opts[0].option.condition, '力量>=20');
  assert.equal(opts[1].option.condition, '警戒<5');
}
{
  const option = StoryOptions.parseOptionTag('<选项:"买,钥匙","商店,内",条件:(金币>=10 && 勇气>0),提示:"还差,一点",样式:红>').option;
  assert.equal(option.text, '买,钥匙');
  assert.equal(option.block, '商店,内');
  assert.equal(option.condition, '(金币>=10 && 勇气>0)');
  assert.equal(option.unmetMessage, '还差,一点');
  assert.deepEqual(option.unknownFields, ['样式:红']);
  assert.equal(StoryOptions.serializeOption(option).value, '<选项:"买,钥匙","商店,内",条件:(金币>=10 && 勇气>0),提示:"还差,一点",样式:红>');
}

console.log('option-condition.test.js passed');
