const assert = require('node:assert/strict');
const VisualDoc = require('../js/story-visual-doc.js');

// The state reference index is deliberately independent of the editor DOM so
// validation can preview a whole-project change before any storage is written.
{
  const index = VisualDoc.buildStateReferenceIndex({
    __MAIN__: [
      '欢迎，{姓名}',
      '<变量:金币+3>',
      '<玩家输入变量:姓名,"你的名字">',
      '<选项:"购买",商店,条件:金币>=10,变化:金币-10>',
    ].join('\n'),
    支线: '<选项:"有钥匙",门,条件:钥匙,变化:钥匙=false>',
  }, [
    { name: '金币', type: 'number', value: 0 },
    { name: '姓名', type: 'text', value: '' },
    { name: '钥匙', type: 'boolean', value: false },
    { name: '金币', type: 'number', value: 1 },
  ]);

  assert.deepEqual(index.duplicates, ['金币']);
  assert.deepEqual(index.byName.金币.map(ref => [ref.kind, ref.block, ref.line]), [
    ['change', '__MAIN__', 2],
    ['condition', '__MAIN__', 4],
    ['effect', '__MAIN__', 4],
  ]);
  assert.deepEqual(index.byName.姓名.map(ref => [ref.kind, ref.block, ref.line]), [
    ['read', '__MAIN__', 1],
    ['player_input', '__MAIN__', 3],
  ]);
  assert.deepEqual(index.byName.钥匙.map(ref => [ref.kind, ref.block, ref.line]), [
    ['condition', '支线', 1],
    ['effect', '支线', 1],
  ]);
}

// Rename preview and delete protection both use the same project-wide index.
{
  const index = VisualDoc.buildStateReferenceIndex({
    __MAIN__: '{金币}\n<变量:金币+1>',
    商店: '<选项:"买",商店,条件:金币>=2,变化:金币-2>',
  }, [{ name: '金币', type: 'number', value: 0 }]);
  assert.equal(index.byName.金币.length, 4);
  assert.equal(index.byName.不存在, undefined);
}

// A type change must be rejected before saving when existing uses need the
// former type. The report retains locations for an actionable inline message.
{
  const index = VisualDoc.buildStateReferenceIndex({
    __MAIN__: '<变量:金币+1>\n{钥匙:开|关}\n<选项:"门",门,条件:钥匙>',
    另一块: '<选项:"搜",搜,条件:名称 contains "剑">',
  }, [
    { name: '金币', type: 'number', value: 0 },
    { name: '钥匙', type: 'boolean', value: false },
    { name: '名称', type: 'text', value: '' },
  ]);
  assert.deepEqual(VisualDoc.findIncompatibleStateReferences(index, '金币', 'text')
    .map(ref => [ref.kind, ref.block, ref.line, ref.requiredType]), [
      ['change', '__MAIN__', 1, 'number'],
    ]);
  assert.equal(VisualDoc.findIncompatibleStateReferences(index, '钥匙', 'number').length, 2);
  assert.deepEqual(VisualDoc.findIncompatibleStateReferences(index, '名称', 'number')
    .map(ref => ref.requiredType), ['text']);
}

console.log('story-state-management.test.js passed');
