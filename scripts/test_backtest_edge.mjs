#!/usr/bin/env node
/**
 * 🔁 V77.3.5 每週自動回測守門(weekly_backtest.yml + build_backtest_edge.mjs + App「產物優先、常數備援」)
 *   ① build():產物訊號表的 value 要跟 `_SIGNAL_EDGE` 一樣是 8 欄;等級 A↔C 的變動要進 diff;⛔ 沒有任何「改預設」的欄位
 *   ② 空過守門:訊號總 n < 上一版 80% → throw(gate=true)、不寫檔
 *   ③ workflow:掛 daily_miner 的 workflow_run(名字逐字相同)、⛔ 無 cron、concurrency gh-pages-push、推兩個分支、週五守門、還原上一版產物
 *   ④ App:有產物 → `_sigEdge` 讀產物(決定性對照:把一個訊號改成 C 級要跟著變);沒有 → 讀嵌入版;讀不到檔不可 pageerror
 *   ⑤ App:`_btEdgeNote` 有產物印日期 + 差異數、沒有印「嵌入版」;⛔ 不改 `_DECK_TRACK49`
 * 注入:① build 的 diff 拿掉 grade 那條 → ①b 紅 ② 守門 0.8 改 0 → ② 紅 ③ `_sigEdge` 不讀產物 → ④ 紅 ④ workflow 加 schedule → ③ 紅
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { build, signalTable, readEmbedded } from './build_backtest_edge.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CODE = HTML.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
const WF = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'weekly_backtest.yml'), 'utf8');
const HOST = /^name:\s*(.+)$/m.exec(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'daily_miner.yml'), 'utf8'))[1].trim();
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 240)}`); if (!c) fails.push(n); };

// ① build()
const emb = readEmbedded(HTML);
ok('⓪ 讀得到嵌入版 _SIGNAL_EDGE / _DECK_TRACK49(空過守門)', emb.table && Object.keys(emb.table).length > 50 && emb.deck && emb.deck.gene > 0, JSON.stringify(emb.deck));
const keys = Object.keys(emb.table);
const mkSig = (mut = {}) => ({ syms: 2227, base: { win: { 10: 36.4 } }, signals: keys.map(k => { const v = emb.table[k]; const s = { key: k, grade: v[0], n: v[1], e10: v[2], w10: v[3], p: v[4], e20: v[5], payoff: v[6], exp: v[7] }; return Object.assign(s, mut[k] || {}); }) });
// V77.6.0:⛔ 不寫死(嵌入版重跑就會變)—— 從嵌入的 `_DECK_TRACK49` 推一組「差 12% / 回撤差 0.6」的產物
const gene = { n: 1117, win: 30.9, per: 3.09, cum: Math.round(emb.deck.gene * 1.12), dd: -(Math.abs(emb.deck.geneDD) + 0.6), from: '2022-09-12', to: '2026-09-16' };
const same = build({ sig: mkSig(), gene, embedded: emb, prev: null });
ok('①a 訊號表 value = 8 欄(跟 `_SIGNAL_EDGE` 一模一樣,App 才能直接換讀)', Object.values(same.signal.table).every(v => Array.isArray(v) && v.length === 8), '');
ok('①a2 產物跟嵌入版一致時 diff = 0(累積差 12% < 30%、回撤差 0.6 < 5)', same.diff.length === 0, JSON.stringify(same.diff.slice(0, 3)));
const aKey = keys.find(k => emb.table[k][0] === 'A');
const flipped = build({ sig: mkSig({ [aKey]: { grade: 'C' } }), gene, embedded: emb, prev: null });
ok('①b ⭐ 一個 A 級訊號變 C 級 → diff 裡有它(⛔ 只標示)', flipped.diff.some(d => d.k === aKey && d.what === 'grade' && d.old === 'A' && d.new === 'C'), JSON.stringify(flipped.diff.slice(0, 3)));
ok('①c 產物沒有任何「換預設」的欄位,note 寫明由人判', !JSON.stringify(same).includes('apply') && /不換預設/.test(same.note), '');
ok('①d 成績單累積差 >30% → diff 有 deck.gene', build({ sig: mkSig(), gene: { ...gene, cum: 2000000 }, embedded: emb, prev: null }).diff.some(d => d.k === 'deck.gene'), '');
// ② 守門
let gate = null;
try { build({ sig: mkSig(), gene, embedded: emb, prev: { run_at: '2026-09-13', signal: { n: same.signal.n * 2 }, deck: { gene: { n: 1117, win: 30.9 } } } }); } catch (e) { gate = e; }
ok('② 🚧 訊號總 n < 上一版 80% → throw(gate=true),不產出', gate && gate.gate === true && /80%/.test(gate.message), gate ? gate.message : '沒 throw');
let gate2 = null;
try { build({ sig: mkSig(), gene: { ...gene, n: 500 }, embedded: emb, prev: { run_at: '2026-09-13', signal: { n: same.signal.n }, deck: { gene: { n: 1117, win: 30.9 } } } }); } catch (e) { gate2 = e; }
ok('②b 成績單筆數 < 上一版 80% → 也 throw', gate2 && gate2.gate === true, gate2 ? gate2.message : '沒 throw');
// ③ workflow
ok('③a 掛 daily_miner 的 workflow_run,host 名字逐字相同(差一字永遠不觸發且零訊息)', WF.includes(`workflows: ["${HOST}"]`), HOST);
ok('③b ⛔ 無 cron(排程配額早就不夠)', !/^\s*schedule:/m.test(WF) && !/cron:/.test(WF), '');
ok('③c concurrency group gh-pages-push、cancel-in-progress false', /group:\s*gh-pages-push/.test(WF) && /cancel-in-progress:\s*false/.test(WF), '');
ok('③d 推兩個分支(gh-pages + data,陷阱 #41)', /deploy_branch gh-pages\s*\n\s*deploy_branch data/.test(WF), '');
ok('③e 週五守門 + force 跳過;只跟 host 的排程那一輪', /date -u \+%u/.test(WF) && /inputs\.force/.test(WF) && /workflow_run\.event == 'schedule'/.test(WF), '');
ok('③f 還原上一版產物當守門基準(PREV=data/backtest_edge.json)', /PREV=data\/backtest_edge\.json/.test(WF) && /git checkout origin\/data -- data\//.test(WF), '');
ok('③g 兩支回測都是「本機絕對路徑 / CI node_modules」雙來源載 playwright(⛔ 寫死沙箱路徑 = CI 一定炸)', ['scripts/portfolio_backtest.mjs', 'scripts/signal_backtest.mjs'].every(f => { const c = fs.readFileSync(path.join(ROOT, f), 'utf8'); return /catch \(_\) \{ \(\{ chromium \} = await import\('playwright'\)\); \}/.test(c) && /fs\.existsSync\(_exec\)/.test(c); }), '');
// ④⑤ App
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
const errs = []; page.on('pageerror', e => errs.push(String(e)));
await page.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._loadBacktestEdge, null, { timeout: 25000 });
await page.waitForTimeout(3000);
const R = await page.evaluate(async (aKey) => {
    const A = app;
    await A._loadBacktestEdge();
    const loaded = A._btEdge;                       // 沙箱抓不到檔 → 一定是 null
    const [det, title] = aKey.split('｜');
    const noteOff = A._btEdgeNote('html'), txtOff = A._btEdgeNote('text');
    const embG = A._sigEdge(det, title);
    // 決定性對照:塞一份產物,把那個 A 級改成 C
    const table = JSON.parse(JSON.stringify(A._SIGNAL_EDGE)); table[aKey][0] = 'C';
    A._btEdge = { run_at: '2026-09-19', signal: { table, grades: { A: 53, B: 11, C: 65 }, n: 1500000 }, deck: { gene: { n: 1100, win: 31, per: 3, cum: 5000000, dd: -24, from: '2022-09', to: '2026-09' } }, diff: [{ k: aKey, what: 'grade', old: 'A', new: 'C' }], note: 'x' };
    const liveG = A._sigEdge(det, title);
    const noteOn = A._btEdgeNote('html');
    const deckBefore = JSON.stringify(A._DECK_TRACK49);
    A._btEdge = null;
    const backG = A._sigEdge(det, title);
    return { loaded, embG: embG && embG.grade, liveG: liveG && liveG.grade, backG: backG && backG.grade, noteOff, txtOff, noteOn, deckSame: deckBefore === JSON.stringify(A._DECK_TRACK49) };
}, aKey);
await browser.close();
// ⚠️ 沙箱用 file:// 載入,Cache API 本來就會丟「Request scheme 'file' is unsupported」(App 的 SW 快取,跟這支無關)→ 只擋跟產物載入有關的錯
const myErrs = errs.filter(e => !/Request scheme 'file' is unsupported/.test(e));
ok('④a 讀不到產物 → `_btEdge` 是 null、沒有(跟它有關的)pageerror(常數備援)', R.loaded === null && myErrs.length === 0, JSON.stringify([R.loaded, myErrs.slice(0, 2)]));
ok('④b ⭐ 決定性對照:產物把那個訊號改成 C → `_sigEdge` 回 C;拿掉產物 → 回嵌入版的 A', R.embG === 'A' && R.liveG === 'C' && R.backG === 'A', JSON.stringify([R.embG, R.liveG, R.backG]));
ok('⑤a 沒產物:註記寫「嵌入版」(⛔ 不可假裝有日期)', /data-btedge="embedded"/.test(R.noteOff) && /嵌入版/.test(R.txtOff), R.noteOff.slice(0, 120));
ok('⑤b 有產物:註記印日期 + 差異數 + 「沒有自動換預設」', /data-btedge="live"/.test(R.noteOn) && /data-btdiff="1"/.test(R.noteOn) && /沒有自動換預設/.test(R.noteOn) && /2026/.test(R.noteOn), R.noteOn.slice(0, 200));
ok('⑤c ⛔ 產物載入後 `_DECK_TRACK49` 一個字都沒變', R.deckSame === true, '');
ok('⑤d 決策台成績單那張卡接上 `_btEdgeNote`、K 線教學也接上', /\$\{this\._btEdgeNote\('html'\)\}/.test(CODE) && /this\._btEdgeNote\('text'\)/.test(CODE.slice(CODE.indexOf('_showEdgeHelp() {'), CODE.indexOf('_showEdgeHelp() {') + 600)), '');

console.log(fails.length ? `\n❌ ${fails.length} 條失敗:${fails.join(' / ')}` : '\n✅ BACKTEST_EDGE_PASS');
process.exit(fails.length ? 1 : 0);
