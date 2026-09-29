#!/usr/bin/env node
// 🎣 V77.9.7 金鱗釣場主畫面圖示:用 pro.html 自己的魚(`PRO._fpvIcon`)畫 → fish-192.png / fish-512.png
//   ⭐ 圖示跟 App 裡的魚是同一支函式畫的(⛔ 不另外手繪一份)。改了魚的外觀想換圖示就重跑這支。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_MODULE || '/opt/node22/lib/node_modules/playwright');
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const pg = await b.newPage();
await pg.goto(pathToFileURL(resolve('pro.html')).href);
await pg.waitForFunction(() => typeof PRO !== 'undefined' && !!PRO._fpvIcon, null, { timeout: 30000 });
for (const n of [192, 512]) {
  const url = await pg.evaluate(n => PRO._fpvIcon(n), n);
  const buf = Buffer.from(url.split(',')[1], 'base64');
  if (buf.length < 2000) { console.error(`❌ fish-${n}.png 只有 ${buf.length} bytes —— 沒畫出東西`); process.exit(1); }
  writeFileSync(`fish-${n}.png`, buf); console.log(`✅ fish-${n}.png ${buf.length} bytes`);
}
await b.close();
