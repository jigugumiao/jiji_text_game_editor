// js/generators.js — 背景图片生成器（渐变 / 噪波），输出 PNG dataURL

// 渐变：direction ∈ vertical|horizontal|diagonal|radial
function generateGradient(opt) {
  const w = 1280, h = 720;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  let g;
  const dir = opt.direction || 'vertical';
  if (dir === 'horizontal') g = ctx.createLinearGradient(0, 0, w, 0);
  else if (dir === 'diagonal') g = ctx.createLinearGradient(0, 0, w, h);
  else if (dir === 'radial') g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.6);
  else g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, opt.color1 || '#1a2a6c');
  g.addColorStop(1, opt.color2 || '#b21f1f');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  return c.toDataURL('image/png');
}

// 值噪波（平滑随机），可着色为双色渐变噪点
function generateNoise(opt) {
  const w = opt.w || 1280, h = opt.h || 720;
  const grid = opt.grid || 3;           // 横向随机控制点分辨率（决定底色云雾疏密）
  const grain = (typeof opt.grain === 'number') ? opt.grain : 0.4; // 0..1，叠加的逐像素细颗粒强度
  const cellsX = Math.max(2, grid);
  const cellsY = Math.max(2, Math.round(grid * h / w)); // 纵向按宽高比换算，保持颗粒接近正方
  // 生成随机值网格 + 双线性插值平滑
  const rnd = [];
  for (let y = 0; y <= cellsY; y++) {
    rnd[y] = [];
    for (let x = 0; x <= cellsX; x++) rnd[y][x] = Math.random();
  }
  function smooth(t) { return t * t * (3 - 2 * t); }
  function sample(x, y) {
    const gx = x * cellsX / w, gy = y * cellsY / h;
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const x1 = Math.min(cellsX, x0 + 1), y1 = Math.min(cellsY, y0 + 1);
    const tx = smooth(gx - x0), ty = smooth(gy - y0);
    const a = rnd[y0][x0] * (1 - tx) + rnd[y0][x1] * tx;
    const b = rnd[y1][x0] * (1 - tx) + rnd[y1][x1] * tx;
    return a * (1 - ty) + b * ty;
  }
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  const col1 = hexToRgb(opt.color1 || '#0b1020');
  const col2 = hexToRgb(opt.color2 || '#5b6ee1');
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const base = sample(x, y);               // 0..1 平滑底色（云雾）
      const white = Math.random();             // 0..1 逐像素高频白噪
      const v = base * (1 - grain) + white * grain; // 叠加细颗粒，grain 越大越清晰
      const i = (y * w + x) * 4;
      img.data[i] = col1.r + (col2.r - col1.r) * v;
      img.data[i + 1] = col1.g + (col2.g - col1.g) * v;
      img.data[i + 2] = col1.b + (col2.b - col1.b) * v;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

function hexToRgb(hex) {
  hex = (hex || '#000000').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  const n = parseInt(hex, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// 文件大小（估算，用于提示）
function dataUrlSize(dataUrl) {
  const b64 = dataUrl.split(',')[1] || '';
  return Math.round(b64.length * 0.75);
}

const Generators = { generateGradient, generateNoise, hexToRgb, dataUrlSize };
if (typeof window !== 'undefined') window.Generators = Generators;
if (typeof module !== 'undefined' && module.exports) module.exports = Generators;
