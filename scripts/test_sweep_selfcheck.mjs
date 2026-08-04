#!/usr/bin/env node
/**
 * 🔬 `page_sweep.mjs` ⑤ 偵測器的**自我驗證**(V72.2.7)
 *
 * ⚠️ 為什麼需要這支:V72.2.4 加了「⑤ 跨卡指令打架」偵測,但因為當時整頁被當成
 *    **一張卡**(`#appMainArea` 吃掉所有子層),它**從上線到 V72.2.7 一次都不可能觸發** ——
 *    而輸出上「0 筆打架」跟「偵測器根本沒機會跑」長得一模一樣。
 *    我當時甚至寫下「偵測器收到 1 多 / 2 空、正確判定無衝突」這種**錯的推論**。
 *
 * ⭐ 通用鐵則:**「沒有報錯」不能當成「檢查過了」** ——
 *    任何偵測器都要有一條「注入已知缺陷,確認它真的叫得出來」的自我驗證。
 *
 * 這支注入兩張明確矛盾的假卡(一張叫你進場、一張叫你空手觀望),
 * 斷言 `page_sweep` 用的那組樣式與配對邏輯真的報得出來。
 * ⚠️ 樣式必須跟 `page_sweep.mjs` **完全一致** —— 改那邊記得同步改這邊(下面有斷言擋)。
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { pathToFileURL } from 'url';
const RE_ACT_BULL = /(可以進場|可依紀律進場|可放心做多|可順勢操作|順勢做多|可加碼|分批試單|可以追)/g;
const RE_ACT_BEAR = /(空手觀望|反彈減碼|分批停利|先別加碼|別做,?等|不接刀|先出場|全數出場)/g;
const nono = t => String(t).replace(/(?:不是|並非|沒有|不可|不准|別|禁|⛔)[^。;,\n]{0,26}(進場|加碼|抱好|順勢|追|試單|做多)/g,'').replace(/(?:不建議|不宜|暫不)[^。;,\n]{0,20}(進場|加碼|做多|追)/g,'');
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--no-sandbox','--allow-file-access-from-files'] });
const p = await b.newPage();
await p.goto(pathToFileURL('/home/user/StockAI-DB/index.html').href,{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>typeof app!=='undefined',null,{timeout:25000});
const cards = await p.evaluate(()=>{
  const host=document.body;
  const a=document.createElement('div'); a.id='__fakeBull'; a.textContent='技術面轉強,現在可以進場,守住月線就抱著。'; host.appendChild(a);
  const c=document.createElement('div'); c.id='__fakeBear'; c.textContent='籌碼轉弱,建議空手觀望,等站穩再說。'; host.appendChild(c);
  return [{id:'__fakeBull',t:a.textContent},{id:'__fakeBear',t:c.textContent}];
});
const acts={bull:[],bear:[]};
for (const c of cards){ const clean=nono(c.t);
  for(const m of clean.matchAll(RE_ACT_BULL)) acts.bull.push({id:c.id,w:m[1]});
  for(const m of clean.matchAll(RE_ACT_BEAR)) acts.bear.push({id:c.id,w:m[1]}); }
let fired=null;
if(acts.bull.length&&acts.bear.length){ for(const x of acts.bull){ const o=acts.bear.find(y=>y.id!==x.id); if(o){fired=`${x.w} ⇄ ${o.w} (${x.id} vs ${o.id})`; break;} } }
console.log(fired ? `✅ ⑤ 偵測器真的報得出來:${fired}` : `❌ ⑤ 注入了明確矛盾卻沒報 —— 偵測器壞了 (bull=${acts.bull.length} bear=${acts.bear.length})`);

// ⭐ 樣式必須跟 page_sweep.mjs 同步(⛔ 兩份分歧的話,這支就變成在驗一個不存在的偵測器)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const SWEEP = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'page_sweep.mjs'), 'utf8');
const sameBull = SWEEP.includes(String(RE_ACT_BULL));
const sameBear = SWEEP.includes(String(RE_ACT_BEAR));
console.log(sameBull && sameBear
    ? '✅ 樣式與 page_sweep.mjs 一致'
    : `❌ 樣式跟 page_sweep.mjs 不一致(bull=${sameBull} bear=${sameBear})—— 這支會驗到一個不存在的偵測器`);
// ⛔ 外殼排除清單也要在(那正是讓 ⑤ 永遠無法觸發的元凶)
const hasShellSkip = /el\.id === 'appMainArea'/.test(SWEEP) && /\^\(tabContent\|subContent\)/.test(SWEEP);
console.log(hasShellSkip
    ? '✅ page_sweep 有排除 appMainArea / tabContent* 外殼'
    : '❌ page_sweep 沒有排除外殼 → 整頁又會變成一張卡,⑤ 永遠不可能觸發');

await b.close();
const okAll = !!fired && sameBull && sameBear && hasShellSkip;
console.log('');
console.log(okAll ? '✅ SWEEP_SELFCHECK_PASS' : '❌ SWEEP_SELFCHECK_FAIL');
process.exit(okAll ? 0 : 1);
