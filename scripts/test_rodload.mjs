// 🎣 V77.9.4 釣魚頁「點進來是空的」+ 👑 領頭羊魚 守門
//   使用者:「釣魚策略目前點進來都是空的,都要點了某個東西她才全部會出現」
//          「把領頭羊的魚加進去,還有底層、中層的魚;拋竿要釣到最強的魚」
//   真因:renderRod 在畫任何東西之前依序等 index.html(4.9 MB)→ screener → 約 190 個財報小檔。
//   ⛔ 這支釘的用意:
//     ① 財報小檔再慢(這裡故意延遲 8 秒)魚缸也要先出來:3 秒內有魚、池子鈕有字
//     ② 💎 那一池還沒讀完要說「讀取財報中 x/y」,讀完才有魚(⛔ 不可空白)
//     ③ 預設池 = 👑 領頭羊池;魚缸裡戴 👑 的剛好是 `_leaderCalc` 前 N 名
//     ④ 🎣 拋竿 = `_leaderCalc` 前 N 名(= 決策台的預設)
//     ⑤ 靜態:renderRod ⛔ 不可 await 財報 / index.html;starFetch / _twiiLoad 共用 promise
//     ⑥ 同時呼叫 starFetch 兩次都拿得到資料(舊版第二個拿到 null)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_MODULE || '/opt/node22/lib/node_modules/playwright');
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

let bad = 0;
const ok = (c, n, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${e ? ' — ' + e : ''}`); if (!c) bad++; };
if (!existsSync('data/screener.json')) { console.log('❌ 沒有 data/screener.json(跑 bash scripts/fetch_testdata.sh)—— ⛔ 不跑假測試'); process.exit(1); }
const SCR = JSON.parse(readFileSync('data/screener.json', 'utf8'));
if (!SCR.cols || !SCR.cols.includes('chg10') || !SCR.cols.includes('amt20')) { console.log('❌ 測資 screener 沒有 chg10 / amt20(舊檔)—— 跑 bash scripts/fetch_testdata.sh'); process.exit(1); }

const SRC = readFileSync('pro.html', 'utf8');
const body = (head) => { const i = SRC.indexOf(head); return i < 0 ? '' : SRC.slice(i, SRC.indexOf('\n  },', i)); };
const noComment = t => t.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');

// ⑤ 靜態
const rr = noComment(body('  async renderRod() {')), rb = noComment(body('  async _renderRodBody() {'));
ok(rr.length > 200 && !/await this\._fillRoe/.test(rr + rb) && !/await this\.loadIdx/.test(rr + rb) && /data-rodloading/.test(rr),
  '⑤ renderRod ⛔ 不可 await 財報 / index.html,而且先寫「載入中」');
ok(/if \(this\._starP\) return this\._starP;/.test(SRC) && /if \(this\._twiiP\) return this\._twiiP;/.test(SRC),
  '⑤b starFetch / _twiiLoad 同時呼叫共用同一個 promise');

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const pg = await b.newPage({ viewport: { width: 390, height: 900 } });
await pg.addInitScript(() => { try { const s = JSON.parse(localStorage.getItem('proTerminalSettings') || '{}'); s.strategy = 'lead'; s.stratUnlock = true; localStorage.setItem('proTerminalSettings', JSON.stringify(s)); } catch (_) {} });   // 🎯 V77.9.6 這支測的是 👑 那一套 → 先切成 👑(🧬 預設另由 test_stratswitch 測)
await pg.emulateMedia({ reducedMotion: 'no-preference' });
const errs = []; pg.on('pageerror', e => errs.push(String(e).slice(0, 200)));
await pg.goto(pathToFileURL(resolve('pro.html')).href);
await pg.waitForFunction(() => typeof PRO !== 'undefined' && !!PRO.renderRod, null, { timeout: 30000 });

// ①② 財報小檔故意慢 8 秒
const A = await pg.evaluate(async () => {
  const orig = PRO.fetchJson.bind(PRO);
  window.__slow = true;
  PRO.fetchJson = async (u, ...a) => { if (window.__slow && /data\/fin\//.test(u)) await new Promise(r => setTimeout(r, 8000)); return orig(u, ...a); };
  const t0 = Date.now();
  PRO.switchTab('rod');
  let t = 0; while (Date.now() - t0 < 3000) { if ((PRO._fish || []).length) { t = Date.now() - t0; break; } await new Promise(r => setTimeout(r, 100)); }
  const chips = [...document.querySelectorAll('#fishPool .fishpool')].map(e => e.textContent.trim());
  const out = { t, fish: (PRO._fish || []).length, chips, poolK: PRO._fishPoolK, roeDone: PRO._fishD && PRO._fishD.roeDone };
  // 💎 那一池:還沒讀完
  PRO._fishPoolK = 'val'; PRO._fishRebuild();
  out.valMsg = document.getElementById('fishMsg').innerText;
  PRO._fishPoolK = 'lead'; PRO._fishRebuild();
  // 👑 戴冠的 = _leaderCalc 前 N 名
  const D = PRO._fishD, N = PRO._LEAD.N;
  out.buy = (D.LD.buy || []).map(r => r.sym).sort();
  out.crown = (PRO._fish || []).filter(f => f.lrank > 0 && f.lrank <= N).map(f => f.sym).sort();
  out.poolN = PRO._fishPoolRows(D).length; out.U = PRO._LEAD.U;
  out.below = PRO._fishPoolRows(D).filter(r => r.pos252 < 75).length;
  window.__slow = false;             // 量完就恢復正常速度(不然 31 批 × 8 秒)
  return out;
});
ok(A.fish > 0 && A.t > 0 && A.t < 3000 && A.chips.length >= 3 && !A.roeDone,
  '① 財報慢 8 秒也不擋:3 秒內魚缸有魚、池子鈕有字(財報那時候還沒讀完)', `${A.t}ms ・${A.fish} 條 ・${A.chips.length} 顆鈕 ・roeDone=${A.roeDone}`);
ok(/讀取財報中 \d+ \/ \d+/.test(A.valMsg), '② 💎 那一池財報還沒讀完 → 寫「讀取財報中 x/y」(⛔ 不可空白)', A.valMsg.slice(0, 80));
ok(A.poolK === 'lead' && /👑 領頭羊池/.test(A.chips[0] || ''), '③ 預設池 = 👑 領頭羊池(排第一顆)', `${A.poolK} / ${A.chips[0]}`);
ok(A.buy.length === 5 && JSON.stringify(A.crown) === JSON.stringify(A.buy), '③b 魚缸戴 👑 的剛好是 `_leaderCalc` 前 N 名', `${A.crown.join(',')} vs ${A.buy.join(',')}`);
ok(A.poolN > 50 && A.poolN <= A.U && A.below > 0, '③c 👑 池子 = 成交額前 U 大,⛔ 不先用位階篩(上層以外的魚也在)', `${A.poolN} 條 ・位階 <75 的 ${A.below} 條`);

// ② 讀完之後 💎 才有魚
const V = await pg.evaluate(async () => {
  const t0 = Date.now(); while (!PRO._fishD.roeDone && Date.now() - t0 < 40000) await new Promise(r => setTimeout(r, 300));
  PRO._fishPoolK = 'val'; PRO._fishRebuild();
  const n = PRO._fishPoolRows(PRO._fishD).length, msg = document.getElementById('fishMsg').innerText;
  PRO._fishPoolK = 'lead'; PRO._fishRebuild();
  return { done: PRO._fishD.roeDone, n, msg };
});
ok(V.done && !/讀取財報中/.test(V.msg), '②b 財報讀完 → 💎 不再顯示「讀取中」', `done=${V.done} n=${V.n}`);

// ④ 拋竿 = 領頭羊前 N 名
const C = await pg.evaluate(async () => {
  PRO._castAnimRun = async () => {};          // 動畫跟結果無關
  await PRO.castRod();
  const R = PRO._cast || {};
  return { picked: (R.picked || []).map(x => x.sym).sort(), buy: PRO._fishD.LD.buy.map(r => r.sym).sort(), lead: R.lead, strip: (document.getElementById('rodCastPicks') || {}).innerText || '' };
});
ok(C.lead && C.picked.length === 5 && JSON.stringify(C.picked) === JSON.stringify(C.buy), '④ 🎣 拋竿 = 👑 領頭羊前 N 名(= 決策台預設)', C.picked.join(','));
ok(/👑1/.test(C.strip) && /(換倉日|還要 \d+ 個交易日|空頭)/.test(C.strip), '④b 上鉤條寫出名次 + 換倉節拍 / 空頭', C.strip.slice(0, 100));

// ⑥ 同時呼叫 starFetch 兩次
const S = await pg.evaluate(async () => { PRO._starData = undefined; const [a, c] = await Promise.all([PRO.starFetch(), PRO.starFetch()]); return { a: !!a, c: !!c }; });
ok(S.a && S.c, '⑥ 同時呼叫 starFetch 兩次都拿得到資料(舊版第二個拿到 null)', JSON.stringify(S));
ok(errs.length === 0, '⑦ ⛔ 無 pageerror', errs.slice(0, 2).join(' | '));
await b.close();
console.log(bad ? `\n❌ ${bad} 條沒過` : '\n✅ RODLOAD_PASS');
process.exit(bad ? 1 : 0);
