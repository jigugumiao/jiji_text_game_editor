const { chromium } = require('C:\\Users\\z1x2c\\.workbuddy\\binaries\\node\\workspace\\node_modules\\playwright-core');
const path = require('path');
const fs = require('fs');

const EXE = 'C:\\Users\\z1x2c\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';
const DIR = 'C:\\CH_ZAWU\\vibecoding工具\\剧情编辑器\\_dof_hdri_test';
const URL = 'file://' + path.join(DIR, 'test_render.html');

const combos = [
  { name: 'A_hdri_off_dof_off', hdri: false, dof: null },
  { name: 'B_hdri_on_dof_off',  hdri: true,  dof: null },
  { name: 'C_hdri_on_dof_on_center', hdri: true, dof: { enabled:true, focusObject:'', aperture:0.025, maxblur:0.01 } },
  { name: 'D_hdri_on_dof_on_strong', hdri: true, dof: { enabled:true, focusObject:'', aperture:0.05, maxblur:0.02 } },
];

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--use-gl=swiftshader','--enable-webgl','--ignore-gpu-blocklist','--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 600, height: 600 } });
  page.on('console', m => { console.log('PAGE['+m.type()+']:', m.text()); });
  page.on('pageerror', e => { console.log('PAGEERR:', e.message); });
  for (const c of combos) {
    await page.addInitScript((cfg) => {
      window.__HDRI__ = cfg.hdri;
      window.__DOF__ = cfg.dof;
    }, c);
    await page.goto(URL, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__ready === true || window.__err, { timeout: 15000 }).catch(()=>{});
    const err = await page.evaluate(() => window.__err || null);
    if (err) { console.log(c.name, 'MODULE ERROR:', err); continue; }
    await page.waitForTimeout(900);
    const out = path.join(DIR, c.name + '.png');
    await page.screenshot({ path: out });
    const stats = await page.evaluate(() => {
      const cv = document.querySelector('#viewer canvas');
      if(!cv) return null;
      const gl = cv.getContext('webgl2') || cv.getContext('webgl');
      const w = cv.width, h = cv.height;
      const px = new Uint8Array(4);
      function read(x,y){ gl.readPixels(x,y,1,1,gl.RGBA,gl.UNSIGNED_BYTE,px); return [px[0],px[1],px[2],px[3]]; }
      return { w, h, center: read(Math.floor(w/2), Math.floor(h/2)), bgUp: read(Math.floor(w/2), Math.floor(h*0.85)), bgMid: read(Math.floor(w/2), Math.floor(h*0.7)) };
    });
    console.log(c.name, JSON.stringify(stats));
  }
  await browser.close();
  console.log('DONE');
})().catch(e => { console.error('RUNNER FAIL', e); process.exit(1); });
