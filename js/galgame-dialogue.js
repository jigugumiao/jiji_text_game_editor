(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GalgameDialogue = api;
}(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var FORMAT = 'story-editor-gal-preset';
  var VALID_IMAGE = /^data:image\/(?:png|jpeg|webp|svg\+xml)(?:;[^,]*)?,/i;

  function normalizedSize(value) {
    value = Math.round(Number(value));
    return Number.isFinite(value) && value >= 1 ? value : null;
  }

  function invalidPreset() {
    throw new Error('预设文件格式无效');
  }

  function number(value) {
    value = Math.round(Number(value));
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  }

  function pair(first, second, limit, active, defaultActive) {
    var a = number(first), b = number(second), firstIsActive = active === 'first' || (active !== 'second' && defaultActive === 'first');
    if (firstIsActive) {
      a = Math.min(a, limit - 1);
      b = Math.min(b, limit - 1 - a);
    } else {
      b = Math.min(b, limit - 1);
      a = Math.min(a, limit - 1 - b);
    }
    return [a, b];
  }

  function normalizeSlices(input, imageWidth, imageHeight, activeSide) {
    imageWidth = normalizedSize(imageWidth);
    imageHeight = normalizedSize(imageHeight);
    if (!imageWidth || !imageHeight) throw new Error('图片尺寸无效');
    input = input || {};
    var horizontal = pair(input.left, input.right, imageWidth, activeSide === 'left' ? 'first' : activeSide === 'right' ? 'second' : null, 'second');
    var vertical = pair(input.top, input.bottom, imageHeight, activeSide === 'top' ? 'first' : activeSide === 'bottom' ? 'second' : null, 'second');
    return { left: horizontal[0], right: horizontal[1], top: vertical[0], bottom: vertical[1] };
  }

  function createSnapshot(preset) {
    preset = preset || {};
    if (typeof preset.imageSrc !== 'string' || !VALID_IMAGE.test(preset.imageSrc)) invalidPreset();
    var imageWidth = normalizedSize(preset.imageWidth);
    var imageHeight = normalizedSize(preset.imageHeight);
    if (!imageWidth || !imageHeight) throw new Error('图片尺寸无效');
    return {
      name: typeof preset.name === 'string' && preset.name ? preset.name : '未命名预设',
      imageSrc: preset.imageSrc,
      imageWidth: imageWidth,
      imageHeight: imageHeight,
      slices: normalizeSlices(preset.slices, imageWidth, imageHeight, preset.activeSide),
      enabled: true
    };
  }

  function serializePreset(preset) {
    return JSON.stringify({ format: FORMAT, version: 1, preset: createSnapshot(preset) });
  }

  function parsePreset(text) {
    var parsed;
    try { parsed = JSON.parse(text); } catch (error) { invalidPreset(); }
    if (!parsed || parsed.format !== FORMAT || parsed.version !== 1 || !parsed.preset || typeof parsed.preset !== 'object') invalidPreset();
    try { return createSnapshot(parsed.preset); } catch (error) { invalidPreset(); }
  }

  function svg(fill, stroke) {
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="128" viewBox="0 0 256 128"><rect width="256" height="128" rx="12" fill="' + fill + '" stroke="' + stroke + '" stroke-width="4"/><path d="M16 32H240M16 96H240" stroke="' + stroke + '" opacity=".5"/></svg>');
  }

  function builtin(id, name, fill, stroke) {
    return Object.freeze({ id: id, name: name, imageSrc: svg(fill, stroke), imageWidth: 256, imageHeight: 128,
      slices: Object.freeze({ top: 28, bottom: 28, left: 40, right: 40 }), builtIn: true });
  }

  var BUILTIN_PRESETS = Object.freeze([
    builtin('builtin-black', '半透明黑', 'rgba(0,0,0,.78)', '#777'),
    builtin('builtin-moon-blue', '月蓝', '#18243d', '#7296c9'),
    builtin('builtin-wine', '酒红', '#4a1622', '#bf6b7f'),
    builtin('builtin-antique-gold', '古典金棕', '#4b3420', '#d6aa57')
  ]);

  return { normalizeSlices: normalizeSlices, createSnapshot: createSnapshot, serializePreset: serializePreset, parsePreset: parsePreset, BUILTIN_PRESETS: BUILTIN_PRESETS };
}));
