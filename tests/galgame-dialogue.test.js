const assert = require('assert');
const dialogue = require('../js/galgame-dialogue.js');

const { normalizeSlices, createSnapshot, serializePreset, parsePreset, BUILTIN_PRESETS } = dialogue;
const IMAGE = 'data:image/svg+xml;base64,PHN2Zy8+';

function throws(fn, message) {
  assert.throws(fn, error => error instanceof Error && error.message.includes(message));
}

function test(name, fn) {
  fn();
  console.log(`✓ ${name}`);
}

test('normalizes valid and hostile slices with active-side preservation', () => {
  assert.deepStrictEqual(
    normalizeSlices({ left: 10.6, right: -3, top: 4.2, bottom: 5.7 }, 100, 50),
    { left: 11, right: 0, top: 4, bottom: 6 }
  );
  assert.deepStrictEqual(
    normalizeSlices({ left: 90, right: 80, top: 30, bottom: 30 }, 100, 50, 'left'),
    { left: 90, right: 9, top: 19, bottom: 30 }
  );
  assert.deepStrictEqual(
    normalizeSlices({ left: 90, right: 80, top: 30, bottom: 30 }, 100, 50, 'right'),
    { left: 19, right: 80, top: 19, bottom: 30 }
  );
  assert.deepStrictEqual(
    normalizeSlices({ left: 90, right: 80, top: 30, bottom: 30 }, 100, 50, 'top'),
    { left: 19, right: 80, top: 30, bottom: 19 }
  );
  assert.deepStrictEqual(
    normalizeSlices({ left: 90, right: 80, top: 30, bottom: 30 }, 100, 50, 'bottom'),
    { left: 19, right: 80, top: 19, bottom: 30 }
  );
});

test('rejects invalid image dimensions', () => {
  for (const value of [0, 0.4, -1, 'invalid', NaN, Infinity]) throws(() => normalizeSlices({}, value, 10), '图片尺寸无效');
  throws(() => normalizeSlices({}, 10, 0), '图片尺寸无效');
});

test('rounds numeric image dimensions before normalizing and snapshotting', () => {
  assert.deepStrictEqual(normalizeSlices({}, 120.4, '60.4'), { left: 0, right: 0, top: 0, bottom: 0 });
  assert.deepStrictEqual(createSnapshot({ imageSrc: IMAGE, imageWidth: 120.4, imageHeight: '60.4', slices: {} }), {
    name: '未命名预设', imageSrc: IMAGE, imageWidth: 120, imageHeight: 60,
    slices: { left: 0, right: 0, top: 0, bottom: 0 }, enabled: true
  });
});

test('creates a fresh no-id snapshot with defaults and normalized values', () => {
  const source = { id: 'temporary', builtIn: true, name: '', imageSrc: IMAGE, imageWidth: 100, imageHeight: 50, slices: { left: 200, right: 30, top: 0, bottom: 80 } };
  const snapshot = createSnapshot(source);
  assert.deepStrictEqual(snapshot, { name: '未命名预设', imageSrc: IMAGE, imageWidth: 100, imageHeight: 50, slices: { left: 69, right: 30, top: 0, bottom: 49 }, enabled: true });
  assert.strictEqual('id' in snapshot, false);
  assert.strictEqual('builtIn' in snapshot, false);
  snapshot.slices.left = 1;
  assert.strictEqual(source.slices.left, 200);
  throws(() => createSnapshot({ imageSrc: 'https://bad.example/a.png', imageWidth: 1, imageHeight: 1 }), '预设文件格式无效');
});

test('serializes and parses a portable preset round-trip', () => {
  const input = { name: '自定义', imageSrc: IMAGE, imageWidth: 256, imageHeight: 128, slices: { top: 28, bottom: 28, left: 40, right: 40 } };
  const encoded = serializePreset(input);
  assert.deepStrictEqual(JSON.parse(encoded), { format: 'story-editor-gal-preset', version: 1, preset: createSnapshot(input) });
  assert.deepStrictEqual(parsePreset(encoded), createSnapshot(input));
});

test('rejects malformed or incompatible preset files', () => {
  for (const text of ['', '{}', '{bad', JSON.stringify({ format: 'wrong', version: 1, preset: {} }), JSON.stringify({ format: 'story-editor-gal-preset', version: 2, preset: {} })]) {
    throws(() => parsePreset(text), '预设文件格式无效');
  }
});

test('exposes four immutable built-in presets that accept snapshots', () => {
  assert.ok(Object.isFrozen(BUILTIN_PRESETS));
  assert.strictEqual(BUILTIN_PRESETS.length, 4);
  assert.deepStrictEqual(BUILTIN_PRESETS.map(item => [item.id, item.name]), [
    ['builtin-black', '半透明黑'], ['builtin-moon-blue', '月蓝'], ['builtin-wine', '酒红'], ['builtin-antique-gold', '古典金棕']
  ]);
  for (const preset of BUILTIN_PRESETS) {
    assert.strictEqual(preset.builtIn, true);
    assert.ok(Object.isFrozen(preset.slices));
    preset.slices.left = 1;
    assert.strictEqual(preset.slices.left, 40);
    assert.ok(preset.imageSrc.startsWith('data:image/svg+xml'));
    assert.deepStrictEqual(createSnapshot(preset), { name: preset.name, imageSrc: preset.imageSrc, imageWidth: 256, imageHeight: 128, slices: { top: 28, bottom: 28, left: 40, right: 40 }, enabled: true });
  }
});
