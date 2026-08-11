const { chromium } = require('C:\\Users\\z1x2c\\.workbuddy\\binaries\\node\\workspace\\node_modules\\playwright-core');
const path = require('path');

const DIR = 'C:\\CH_ZAWU\\vibecoding工具\\剧情编辑器\\_dof_hdri_test';
const URL = 'file://' + path.join(DIR, 'test_hdri.html');
const CHROME = 'C:\\Users\\z1x2c\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--disable-gpu-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 400, height: 400 } });
  page.on('console', m => { if (m.type() === 'error') console.log('PAGE ERR:', m.text()); });
  page.on('pageerror', e => console.log('PAGE ERROR:', e.message));
  const results = {};
  for (const key of ['urban', 'blue']) {
    await page.goto(URL + '?hdri=' + key, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__ready === true, { timeout: 20000 }).catch(() => {});
    const stats = await page.evaluate(() => window.__stats || null);
    results[key] = stats;
    const out = path.join(DIR, 'HDRI_' + key + '.png');
    await page.screenshot({ path: out });
    console.log(key, JSON.stringify(stats));
  }
  await browser.close();
  // 差异判定
  const a = results.urban && results.urban.mean;
  const b = results.blue && results.blue.mean;
  if (a && b) {
    const diff = Math.abs(a[0]-b[0]) + Math.abs(a[1]-b[1]) + Math.abs(a[2]-b[2]);
    console.log('=== mean-RGB diff (urban vs blue):', diff, diff > 25 ? 'DIFFERENT (PASS)' : 'TOO SIMILAR (FAIL) ===');
  }
})();
