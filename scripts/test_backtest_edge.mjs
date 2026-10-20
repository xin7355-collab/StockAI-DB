#!/usr/bin/env node
/**
 * 🔁 V77.3.5 每週自動回測守門(weekly_backtest.yml + build_backtest_edge.mjs + App「產物優先、常數備援」)
 *   ① build():產物訊號表的 value 要跟 `_SIGNAL_EDGE` 一樣是 10 欄(V79.4.5);等級 A↔C 的變動要進 diff;⛔ 沒有任何「改預設」的欄位
 *   ② 空過守門:訊號總 n < 上一版 80% → throw(gate=true)、不寫檔
 *      🔁 V79.4.5 換設定(cfg)/ 換訊號方法(match)那一次 → 重新起算(放行 + rebase 註記);絕對下限 FLOOR 照樣要過;
 *         沒有上一版 → ⛔ 不拿內嵌的 16 年表當基準
 *   ③h workflow 的成績單設定 == App 現行預設(`_GENE_RULE` / `_DECK_TRACK49`)—— 改 App 預設忘了改這裡就紅
 *   ③ workflow:掛 daily_miner 的 workflow_run(名字逐字相同)、⛔ 無 cron、concurrency gh-pages-push、推兩個分支、週五守門、還原上一版產物
 *   ④ App:有產物 → `_sigEdge` 讀產物(決定性對照:把一個訊號改成 C 級要跟著變);沒有 → 讀嵌入版;讀不到檔不可 pageerror
 *   ⑤ App:`_btEdgeNote` 有產物印日期 + 差異數、沒有印「嵌入版」;⛔ 不改 `_DECK_TRACK49`
 * 注入:① build 的 diff 拿掉 grade 那條 → ①b 紅 ② 守門 0.8 改 0 → ② 紅 ③ `_sigEdge` 不讀產物 → ④ 紅 ④ workflow 加 schedule → ③ 紅
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { build, signalTable, readEmbedded, FLOOR, deckSig, DECK_SIG } from './build_backtest_edge.mjs';

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
const mkSig = (mut = {}, extra = {}) => ({ syms: 2227, base: { win: { 10: 36.4 } }, ...extra, signals: keys.map(k => { const v = emb.table[k]; const s = { key: k, grade: v[0], n: v[1], e10: v[2], w10: v[3], p: v[4], e20: v[5], payoff: v[6], exp: v[7], xr: v[8], tone: v[9] }; return Object.assign(s, mut[k] || {}); }) });
// 🔁 V79.4.5 成績單 cfg:現行設定 vs 舊設定(9/21 那份:唐奇安 / 位階 75 / 沒有那幾欄)
const CFG_NEW = { syms: 600, picks: 2, lot: 150000, capital: 1000000, exit: 'chand2', stop: 'lo5', entry: 'close', self: 'high+hivolat', filter: 'bear60', rankMin: 85, volatMin: 60, stopFill: 'close', maxd: 20, warmup: 240, div: 'nhi' };
const CFG_OLD = { syms: 600, picks: 2, lot: 150000, capital: 1000000, exit: 'don', stop: 'lo5', entry: 'close', self: 'high+hivolat', filter: '' };
// V77.6.0:⛔ 不寫死(嵌入版重跑就會變)—— 從嵌入的 `_DECK_TRACK49` 推一組「差 12% / 回撤差 0.6」的產物
const gene = { n: 1117, win: 30.9, per: 3.09, cum: Math.round(emb.deck.gene * 1.12), dd: -(Math.abs(emb.deck.geneDD) + 0.6), from: '2022-09-12', to: '2026-09-16', months: 49, cfg: CFG_NEW };
const same = build({ sig: mkSig(), gene, embedded: emb, prev: null });
ok('①a 訊號表 value = 10 欄(跟 `_SIGNAL_EDGE` 一模一樣:第 9 欄 xr、第 10 欄 tone)', Object.values(same.signal.table).every(v => Array.isArray(v) && v.length === 10) && Object.keys(same.signal.table).every(k => same.signal.table[k][8] === emb.table[k][8] && same.signal.table[k][9] === emb.table[k][9]), '');
ok('①a2 產物跟嵌入版一致時 diff = 0(累積差 12% < 30%、回撤差 0.6 < 5)', same.diff.length === 0, JSON.stringify(same.diff.slice(0, 3)));
const aKey = keys.find(k => emb.table[k][0] === 'A');
const flipped = build({ sig: mkSig({ [aKey]: { grade: 'C' } }), gene, embedded: emb, prev: null });
ok('①b ⭐ 一個 A 級訊號變 C 級 → diff 裡有它(⛔ 只標示)', flipped.diff.some(d => d.k === aKey && d.what === 'grade' && d.old === 'A' && d.new === 'C'), JSON.stringify(flipped.diff.slice(0, 3)));
ok('①c 產物沒有任何「換預設」的欄位,note 寫明由人判', !JSON.stringify(same).includes('apply') && /不換預設/.test(same.note), '');
ok('①d 成績單累積差 >30% → diff 有 deck.gene', build({ sig: mkSig(), gene: { ...gene, cum: 2000000 }, embedded: emb, prev: null }).diff.some(d => d.k === 'deck.gene'), '');
// ② 守門
let gate = null;
try { build({ sig: mkSig(), gene, embedded: emb, prev: { run_at: '2026-09-13', signal: { n: same.signal.n * 2 }, deck: { gene: { n: 1117, win: 30.9, cfg: CFG_NEW } } } }); } catch (e) { gate = e; }
ok('② 🚧 訊號總 n < 上一版 80% → throw(gate=true),不產出', gate && gate.gate === true && /80%/.test(gate.message), gate ? gate.message : '沒 throw');
let gate2 = null;
const nOk = Math.max(FLOOR.deckN, Math.round(1117 * 0.7));   // 同設定:掉到上一版的 70%(< 80%)但仍過絕對下限 → 只會被「80%」那條擋
try { build({ sig: mkSig(), gene: { ...gene, n: nOk }, embedded: emb, prev: { run_at: '2026-09-13', signal: { n: same.signal.n }, deck: { gene: { n: 1117, win: 30.9, cfg: CFG_NEW } } } }); } catch (e) { gate2 = e; }
ok('②b 同設定:成績單筆數 < 上一版 80% → 也 throw', nOk < 1117 * 0.8 && gate2 && gate2.gate === true && /上一版 1117 的 80%/.test(gate2.message), gate2 ? gate2.message : '沒 throw');
// 🔁 V79.4.5 ②c~②h:換設定那一次重新起算 + 絕對下限(⭐ 決定性對照:同一個筆數,cfg 一樣 → 擋、cfg 換了 → 放行)
const PREV_OLD = { run_at: '2026-09-21', signal: { n: same.signal.n }, deck: { gene: { n: 1233, win: 30.9, cfg: CFG_OLD } } };
const geneNew = { ...gene, n: Math.max(FLOOR.deckN, Math.round(1233 * 0.6)) };   // 舊設定 1,233 的 60%:同設定會被擋,換了設定要放行
let rb = null, rbErr = null;
try { rb = build({ sig: mkSig(), gene: geneNew, embedded: emb, prev: PREV_OLD }); } catch (e) { rbErr = e; }
ok('②c ⭐ 換設定(9/21 舊引擎唐奇安 → 現行吊燈 ATR):這一次放行 + rebase 註記「舊 → 新」(⛔ 不跟舊設定比 80%)',
   !rbErr && rb && rb.rebase && rb.rebase.deck && rb.rebase.deck.oldN === 1233 && rb.rebase.deck.newN === geneNew.n && /exit=don/.test(rb.rebase.deck.from) && /exit=chand2/.test(rb.rebase.deck.to) && !rb.diff.some(d => d.what === 'win_vs_prev'),
   rbErr ? rbErr.message : JSON.stringify(rb && rb.rebase));
let rbSame = null;
try { build({ sig: mkSig(), gene: geneNew, embedded: emb, prev: { ...PREV_OLD, deck: { gene: { n: 1233, win: 30.9, cfg: CFG_NEW } } } }); } catch (e) { rbSame = e; }
ok('②d ⭐ 決定性對照:同一個筆數,cfg 沒換 → 照擋(80%)', rbSame && rbSame.gate === true && /80%/.test(rbSame.message), rbSame ? rbSame.message : '沒 throw');
let fl = null;
try { build({ sig: mkSig(), gene: { ...geneNew, n: FLOOR.deckN - 1 }, embedded: emb, prev: PREV_OLD }); } catch (e) { fl = e; }
ok('②e 換設定但成績單筆數 < 絕對下限 → 照擋(⛔「換設定」不可掩護一份真的壞掉的產物)', fl && fl.gate === true && /絕對下限/.test(fl.message), fl ? fl.message : '沒 throw');
let fm = null;
try { build({ sig: mkSig(), gene: { ...geneNew, months: 30 }, embedded: emb, prev: null }); } catch (e) { fm = e; }
ok('②f 窗口 < 36 個月 → 擋(沒有上一版也一樣)', fm && fm.gate === true && /個月/.test(fm.message), fm ? fm.message : '沒 throw');
const sigSmall = mkSig(Object.fromEntries(keys.map(k => [k, { n: Math.max(1, Math.round(emb.table[k][1] * 0.2)) }])));
const totSmall = sigSmall.signals.reduce((a, x) => a + x.n, 0), totEmb = keys.reduce((a, k) => a + (+emb.table[k][1] || 0), 0);
let ns = null, nsErr = null;
try { ns = build({ sig: sigSmall, gene, embedded: emb, prev: null, floor: { ...FLOOR, sigN: Math.min(FLOOR.sigN, totSmall) } }); } catch (e) { nsErr = e; }
ok('②g 沒有上一版 → ⛔ 不拿內嵌的 16 年表當基準(樣本只有它的兩成也放行;只看絕對下限)', totSmall < totEmb * 0.8 && !nsErr && ns && ns.rebase === null, nsErr ? nsErr.message : `${totSmall} vs ${totEmb}`);
let fs2 = null;
try { build({ sig: mkSig(), gene, embedded: emb, prev: null, floor: { ...FLOOR, sigN: same.signal.n + 1 } }); } catch (e) { fs2 = e; }
ok('②g2 訊號總樣本 < 絕對下限 → 擋', fs2 && fs2.gate === true && /絕對下限/.test(fs2.message), fs2 ? fs2.message : '沒 throw');
let ms = null, msErr = null;
try { ms = build({ sig: mkSig({}, { match: 'same-day' }), gene, embedded: emb, prev: { run_at: '2026-09-21', signal: { n: same.signal.n * 3 }, deck: { gene: { n: 1117, win: 30.9, cfg: CFG_NEW } } } }); } catch (e) { msErr = e; }
let msSame = null;
try { build({ sig: mkSig({}, { match: 'same-day' }), gene, embedded: emb, prev: { run_at: '2026-09-21', signal: { n: same.signal.n * 3, match: 'same-day' }, deck: { gene: { n: 1117, win: 30.9, cfg: CFG_NEW } } } }); } catch (e) { msSame = e; }
ok('②h 訊號方法換了(舊:整段平均 → same-day)→ 重新起算放行;方法一樣 → 照擋(決定性對照)',
   !msErr && ms && ms.rebase && ms.rebase.signal && ms.rebase.signal.to === 'same-day' && ms.signal.match === 'same-day' && msSame && msSame.gate === true,
   msErr ? msErr.message : JSON.stringify(ms && ms.rebase));
ok('②i 絕對下限有合理數值(成績單 ≥200 筆、窗口 36 個月、訊號樣本 ≥10 萬)+ 簽章含 App 預設那幾欄', FLOOR.deckN >= 200 && FLOOR.months === 36 && FLOOR.sigN >= 100000 && ['exit', 'rankMin', 'maxd', 'filter', 'stopFill', 'div'].every(k => DECK_SIG.includes(k)) && deckSig(CFG_NEW) !== deckSig(CFG_OLD), JSON.stringify(FLOOR));
// ③ workflow
ok('③a 掛 daily_miner 的 workflow_run,host 名字逐字相同(差一字永遠不觸發且零訊息)', WF.includes(`workflows: ["${HOST}"]`), HOST);
ok('③b ⛔ 無 cron(排程配額早就不夠)', !/^\s*schedule:/m.test(WF) && !/cron:/.test(WF), '');
ok('③c concurrency group gh-pages-push、cancel-in-progress false', /group:\s*gh-pages-push/.test(WF) && /cancel-in-progress:\s*false/.test(WF), '');
ok('③d 推兩個分支(gh-pages + data,陷阱 #41)', /deploy_branch gh-pages\s*\n\s*deploy_branch data/.test(WF), '');
ok('③e 週五守門 + force 跳過;只跟 host 的排程那一輪', /date -u \+%u/.test(WF) && /inputs\.force/.test(WF) && /workflow_run\.event == 'schedule'/.test(WF), '');
ok('③f 還原上一版產物當守門基準(PREV=data/backtest_edge.json)', /PREV=data\/backtest_edge\.json/.test(WF) && /git checkout origin\/data -- data\//.test(WF), '');
// 🔁 V79.4.5 ③h workflow 的成績單設定 == App 現行預設(⭐ 跨檔比對:改 App 預設忘了改 workflow → 紅)
{
    const envOf = k => { const m = new RegExp(`^\\s+${k}:\\s*'?([^'\\n]+?)'?\\s*$`, 'm').exec(WF); return m ? m[1].trim() : null; };
    const rank = +(/_GENE_RULE:\s*\{\s*rank:\s*(\d+),\s*vol:\s*(\d+)/.exec(HTML) || [])[1], vol = +(/_GENE_RULE:\s*\{\s*rank:\s*(\d+),\s*vol:\s*(\d+)/.exec(HTML) || [])[2];
    const T = /_DECK_TRACK49:[\s\S]{0,600}?exit:\s*'(\w+)'[\s\S]{0,80}?maxd:\s*(\d+),\s*bearGate:\s*(true|false)/.exec(HTML);
    const fill = (/_DECK_TRACK49:[\s\S]{0,4000}?fill:\s*'(\w+)'/.exec(HTML) || [])[1];
    const ALIAS = { atr2: 'chand2', atr: 'chand2', don: 'don20', don40: 'don40' };
    const want = T ? { RANK_MIN: String(rank), VOLAT_MIN: String(vol), EXIT: ALIAS[T[1]] || T[1], MAXD: T[2], FILTER: T[3] === 'true' ? 'bear60' : null, STOPFILL: fill } : null;
    const got = { RANK_MIN: envOf('RANK_MIN'), VOLAT_MIN: envOf('VOLAT_MIN'), EXIT: envOf('EXIT'), MAXD: envOf('MAXD'), FILTER: envOf('FILTER'), STOPFILL: envOf('STOPFILL') };
    ok('③h ⭐ workflow 的成績單設定 == App 現行預設(`_GENE_RULE` 位階 / 振幅、`_DECK_TRACK49` 出場 / 天數 / 空頭守門 / 成交價)+ 股利入帳',
       !!want && rank > 0 && Object.keys(want).every(k => want[k] === got[k]) && /DIV_TRADES:\s*data\/dividends_hist\.json/.test(WF) && /\bDIV:\s*data\/dividends_hist\.json/.test(WF),
       JSON.stringify({ want, got }));
}
ok('③g 兩支回測都是「本機絕對路徑 / CI node_modules」雙來源載 playwright(⛔ 寫死沙箱路徑 = CI 一定炸)', ['scripts/portfolio_backtest.mjs', 'scripts/signal_backtest.mjs'].every(f => { const c = fs.readFileSync(path.join(ROOT, f), 'utf8'); return /catch \(_\) \{ \(\{ chromium \} = await import\('playwright'\)\); \}/.test(c) && /fs\.existsSync\(_exec\)/.test(c); }), '');
// ④⑤ App
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
const errs = []; page.on('pageerror', e => errs.push(String(e)));
await page.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
// ⚠️ V78.1.2 舊版靠「沙箱抓不到檔」來造「沒有產物」的情境 —— 本機一旦有 data/backtest_edge.json(每週回測產物)就整段紅了。
//   → 「沒產物」改成**這支測試自己擋掉**那個檔(決定性),有產物的情境下面另外 stub。
await page.route('**/backtest_edge.json*', r => r.abort());
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._loadBacktestEdge, null, { timeout: 25000 });
await page.waitForTimeout(3000);
const R = await page.evaluate(async (aKey) => {
    const A = app;
    await A._loadBacktestEdge();
    const loaded = A._btEdge;                       // 這支測試擋掉了那個檔 → 一定是 null
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
// 🔁 V79.4.5 使用者決定:App 一律用內嵌的 16 年表,每週產物⛔ 不再蓋掉它(只當實驗室參考)→ 決定性對照反過來
ok('④b ⭐ 決定性對照:產物把那個訊號改成 C → `_sigEdge` 仍回內嵌的 A(⛔ 產物不可蓋掉 16 年表)', R.embG === 'A' && R.liveG === 'A' && R.backG === 'A', JSON.stringify([R.embG, R.liveG, R.backG]));
ok('⑤a 沒產物:註記寫「嵌入版 / 還沒載到」(⛔ 不可假裝有日期)', /data-btedge="embedded"/.test(R.noteOff) && /還沒載到/.test(R.txtOff), R.noteOff.slice(0, 120) + ' | ' + R.txtOff);
ok('⑤b 有產物:註記印日期 + 差異數 + 「沒有自動換預設」', /data-btedge="live"/.test(R.noteOn) && /data-btdiff="1"/.test(R.noteOn) && /沒有自動換預設/.test(R.noteOn) && /2026/.test(R.noteOn), R.noteOn.slice(0, 200));
ok('⑤c ⛔ 產物載入後 `_DECK_TRACK49` 一個字都沒變', R.deckSame === true, '');
// 🧹 V78.3.4 決策台「這套做法實測賺多少」整塊搬到產業作戰室 → 決策台⛔ 不再掛 `_btEdgeNote`
// 🧹 V78.3.6 K 線教學(`_showEdgeHelp`)也改成只講「怎麼看、怎麼做」→ 散戶 App 畫面⛔ 任何地方都不再呼叫 `_btEdgeNote`
//   (函式本身留著,⑤a/⑤b 仍直接驗它的內容;成績與差異改在產業作戰室看)。現在釘:① 沒有呼叫端 ② 教學彈窗沒有研究字樣 ③ 「怎麼看」的關鍵句還在
const _EH = CODE.slice(CODE.indexOf('_showEdgeHelp() {'), CODE.indexOf('_showEdgeHelp() {') + 1200);
// 🔬 V79.4.5 唯一的呼叫點是 K 線教學裡的**實驗室模式**那一段(每週產物 = 最近幾年的參考)→ 每個呼叫點都要在 `this._labMode() ?` 後面
const _btCalls = [...CODE.matchAll(/this\._btEdgeNote\(/g)].map(m => CODE.slice(Math.max(0, m.index - 600), m.index));
ok('⑤d 🧹 散戶 App 一般模式⛔ 不呼叫 `_btEdgeNote`;只有 K 線教學的實驗室段落可以(V79.4.5)',
   CODE.indexOf('_showEdgeHelp() {') > 0 && _btCalls.length >= 1 && _btCalls.every(pre => /this\._labMode\(\) \?/.test(pre)), String(_btCalls.length));
const _ehRetail = _EH.slice(0, _EH.indexOf('(this._labMode() ?') > 0 ? _EH.indexOf('(this._labMode() ?') : _EH.indexOf('this.vibrate'));
ok('⑤d2 🧹 K 線教學(一般模式那段)只講怎麼看:⛔ 沒有 成績來源 / 自動回測 / 實測 / 勝率 / 期望值 / A 級,且「起漲點怎麼看」還在',
   /起漲點怎麼看/.test(_ehRetail) && /風險提醒/.test(_ehRetail) && !/成績來源|自動回測|實測|回測|勝率|期望值|A 級/.test(_ehRetail), _ehRetail.slice(0, 200));

console.log(fails.length ? `\n❌ ${fails.length} 條失敗:${fails.join(' / ')}` : '\n✅ BACKTEST_EDGE_PASS');
process.exit(fails.length ? 1 : 0);
