#!/usr/bin/env node
/**
 * 🖱️ 大盤三格指數:點下去不可以噴 JS 錯誤(V73.3.1,使用者截圖抓到)
 *
 * 使用者:「櫃買指數、台指電子盤點選時會出現錯誤訊息」
 *   → `SyntaxError: Unexpected EOF` ・位置 `?source=pwa:1` ・**文件完整(3390KB)**
 *
 * ⚠️ 這個 bug 的可怕之處:**載入時完全正常**,只有「點下去那一刻」才炸
 *    → smoke_test / page_sweep 都抓不到(它們不會去點)。
 *    所以這支就是專門去**真的點一下**。
 *
 * ⛔ 空過守門:三格沒渲染出來就 exit 1 —— 沒點到等於什麼都沒驗。
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--no-sandbox','--allow-file-access-from-files']});
const p=await b.newPage();
const errs=[]; p.on('pageerror',e=>errs.push(String(e&&e.message||e)));
p.on('dialog', d=>{ console.log('   💬 跳出說明:', d.message().replace(/\n/g,' ⏎ ').slice(0,70)+'…'); d.dismiss(); });
await p.goto('file://'+ROOT+'/index.html',{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>typeof app!=='undefined'&&!!app._renderIndexRow,null,{timeout:20000});
await p.evaluate(()=>new Promise(r=>setTimeout(r,3000)));
const html = await p.evaluate(()=>{ app.switchAppTab('market'); try{app.switchMarketSubTab('idx');}catch(_){}
  const row=document.getElementById('mktIndexRow'); app._renderIndexRow(); return row? row.innerHTML : ''; });
// 🚧 空過守門:沒渲染出三格 = 什麼都沒驗到
const cells = (html.match(/<div onclick=/g)||[]).length;
console.log(`   三格指數渲染出 ${cells} 格`);
if (cells < 3) { console.log('❌ 沒渲染出來,這次驗證無效'); process.exit(1); }
let fails = 0;
console.log('   onclick 屬性內有真換行嗎?', /onclick="[^"]*\n[^"]*"/.test(html) ? '❌ 有(會爆)' : '✅ 沒有');
for (const [i,name] of [[1,'櫃買指數'],[2,'台指電子盤']]) {
  errs.length = 0;
  await p.evaluate(n=>{ document.querySelectorAll('#mktIndexRow > div')[n].click(); }, i);
  await p.evaluate(()=>new Promise(r=>setTimeout(r,300)));
  if (errs.length) fails++;
  console.log(`   點「${name}」→ ${errs.length? '❌ '+errs[0].slice(0,80) : '✅ 沒有 JS 錯誤'}`);
}
await b.close();
console.log(fails ? '\n❌ IDXCELL_CLICK_FAIL' : '\n✅ IDXCELL_CLICK_PASS');
process.exit(fails ? 1 : 0);
