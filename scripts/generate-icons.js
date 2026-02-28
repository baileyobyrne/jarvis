'use strict';
/**
 * generate-icons.js
 * Generates PWA app icons using Playwright (no extra dependencies).
 * Outputs: icon-192.png, icon-512.png, apple-touch-icon.png (180x180)
 *
 * Usage: node /root/.openclaw/scripts/generate-icons.js
 */
const { chromium } = require('/root/.openclaw/skills/agentbox-willoughby/node_modules/playwright');
const fs   = require('fs');
const path = require('path');

const ICONS_DIR = '/root/.openclaw/workspace/dashboard/icons';
if (!fs.existsSync(ICONS_DIR)) fs.mkdirSync(ICONS_DIR, { recursive: true });

function iconHtml(size) {
  const letterSize = Math.round(size * 0.48);
  const subSize    = Math.round(size * 0.09);
  const subMargin  = Math.round(size * 0.015);
  const radius     = Math.round(size * 0.18);
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${size}px;height:${size}px;overflow:hidden}
body{
  background:#080C0F;
  display:flex;align-items:center;justify-content:center;flex-direction:column;
  font-family:-apple-system,'SF Pro Display','Helvetica Neue',Helvetica,sans-serif;
  border-radius:${radius}px;
}
.j{font-size:${letterSize}px;font-weight:800;color:#C8A96E;line-height:1;letter-spacing:-1px}
.sub{font-size:${subSize}px;font-weight:500;color:rgba(200,169,110,0.45);letter-spacing:${Math.round(size*0.02)}px;text-transform:uppercase;margin-top:${subMargin}px}
</style></head><body>
<div class="j">J</div>
<div class="sub">JARVIS</div>
</body></html>`;
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const targets = [
    { file: 'icon-192.png',         size: 192 },
    { file: 'icon-512.png',         size: 512 },
    { file: 'apple-touch-icon.png', size: 180 },
  ];

  for (const { file, size } of targets) {
    const page = await browser.newPage();
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(iconHtml(size), { waitUntil: 'domcontentloaded' });
    const outPath = path.join(ICONS_DIR, file);
    await page.screenshot({ path: outPath, type: 'png' });
    await page.close();
    console.log(`  ${file} (${size}x${size}) -> ${outPath}`);
  }

  await browser.close();
  console.log('Done.');
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
