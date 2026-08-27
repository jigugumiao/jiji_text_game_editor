const assert = require('node:assert/strict');
const vm = require('node:vm');
const StoryOptions = require('../js/story-options.js');

// ---------- fields ----------
assert.deepEqual(
  StoryOptions.splitTopLevelFields('"买,钥匙",商店,条件:(金币>=10, 声望>2),提示:"需要\\"十\\"金币"'),
  ['"买,钥匙"', '商店', '条件:(金币>=10, 声望>2)', '提示:"需要\\"十\\"金币"']
);
assert.deepEqual(StoryOptions.splitTopLevelFields('“买,钥匙”,商店'), ['“买,钥匙”', '商店']);

// ---------- canonical parse / serialize ----------
{
  const raw = '<选项:"购买钥匙",商店,条件:(金币>=10),不满足:禁用,提示:"需要 10 金币",变化:金币-10,变化:拿到钥匙=true>';
  const parsed = StoryOptions.parseOptionTag(raw);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.option, {
    text: '购买钥匙', block: '商店', condition: '(金币>=10)', unmetBehavior: 'disable',
    unmetMessage: '需要 10 金币', effects: [{ name: '金币', op: '-', val: '10' }, { name: '拿到钥匙', op: '=', val: 'true' }], unknownFields: []
  });
  assert.deepEqual(StoryOptions.serializeOption(parsed.option), { ok: true, value: raw, error: null });
}

// ---------- backwards compatibility and escaping ----------
{
  const old = StoryOptions.parseOptionTag('<选项:"A",块A,条件:金币>=2>');
  assert.equal(old.ok, true);
  assert.deepEqual(old.option, { text: 'A', block: '块A', condition: '金币>=2', unmetBehavior: 'hide', unmetMessage: null, effects: [], unknownFields: [] });

  const quoted = StoryOptions.parseOptionTag('<选项:"她说\\"好,走吧\\"",块A>');
  assert.equal(quoted.option.text, '她说"好,走吧"');
  assert.equal(StoryOptions.serializeOption(quoted.option).value, '<选项:"她说\\"好,走吧\\"",块A>');
}

// ---------- option without a jump ----------
{
  const noJump = StoryOptions.parseOptionTag('<选项:"拿走钥匙",变化:拿到钥匙=true>');
  assert.equal(noJump.ok, true);
  assert.equal(noJump.option.block, null);
  assert.equal(StoryOptions.serializeOption(noJump.option).value, '<选项:"拿走钥匙",变化:拿到钥匙=true>');
}

// ---------- preservation and errors ----------
{
  const unknown = StoryOptions.parseOptionTag('<选项:"A",块A,样式:红色>');
  assert.equal(unknown.ok, true);
  assert.deepEqual(unknown.option.unknownFields, ['样式:红色']);
  assert.deepEqual(StoryOptions.serializeOption(unknown.option), { ok: true, value: '<选项:"A",块A,样式:红色>', error: null });
  assert.equal(StoryOptions.parseOptionTag('<选项:abc>').ok, false);
}

// ---------- exact extraction spans ----------
{
  const line = '前<选项:"A",块A,条件:金币>=2> 后<选项:"B",块B>'; 
  const matches = StoryOptions.extractOptionLine(line);
  assert.deepEqual(matches.map(function (m) { return { start: m.start, end: m.end, raw: m.raw, ok: m.ok }; }), [
    { start: 1, end: 21, raw: '<选项:"A",块A,条件:金币>=2>', ok: true },
    { start: 23, end: 34, raw: '<选项:"B",块B>', ok: true }
  ]);
  assert.equal(matches[0].option.text, 'A');
  const chineseQuote = StoryOptions.extractOptionLine('<选项:“含 > 的文字”,块A>')[0];
  assert.equal(chineseQuote.raw, '<选项:“含 > 的文字”,块A>');
  assert.equal(chineseQuote.option.text, '含 > 的文字');
}

// ---------- summaries and normalizing ----------
{
  const option = StoryOptions.parseOptionTag('<选项:"A",块A,不满足:禁用,提示:"不能,去">').option;
  assert.deepEqual(StoryOptions.normalizeOption({ text: ' A ', block: ' 块A ', condition: ' ', unmetBehavior: 'other', unmetMessage: ' ', effects: [], unknownFields: [] }), {
    text: 'A', block: '块A', condition: null, unmetBehavior: 'hide', unmetMessage: null, effects: [], unknownFields: []
  });
  assert.match(StoryOptions.summarizeOption(option), /A/);
}

// ---------- exported runtime receives the same grammar ----------
{
  const context = { window: { StoryVars: require('../js/story-vars.js') } };
  vm.createContext(context);
  vm.runInContext(StoryOptions.buildRuntimeSource(), context);
  const option = context.window.StoryOptions.parseOptionTag('<选项:"A, B",块,条件:(金币>=2),样式:红>').option;
  assert.equal(option.text, 'A, B');
  assert.equal(option.condition, '(金币>=2)');
  assert.deepEqual(Array.from(option.unknownFields), ['样式:红']);
}

console.log('story-options.test.js passed');
