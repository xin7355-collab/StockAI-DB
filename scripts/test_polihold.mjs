// 🏛️ V79.2.0 產業作戰室「政治人物持股」—— 照申報的持股抱著的含息報酬 vs 0050
//   ⛔ 守住:① 頁內 _poliTr / _poliScale == lib_totalreturn(⛔ 第二份實作不可分叉,陷阱 #37)
//          ② A(每次申報抱到今天)/ B(每次申報換一次持股串起來)手算對得上
//          ③ 決定性對照:改一檔股數,報酬要跟著變
//          ④ 算不出的那幾檔要寫出來 + 佔多少(⛔ 不靜默丟)
//          ⑤ 表頭排序同欄反向 ⑥ 讀不到檔要講原因 ⑦ ⛔ 不給買進指令
//          ⑨ 🏆 排行:poli_rank.mjs(抽 pro.html 函式)算的 == 頁面算的;表照「贏/輸 0050」排、算不出的排最後、可反向、點列換人、meta 跟著資料
//          ⑧ 配股要加股數(本站 K 線沒還原配股);⛔ 前一天收盤對不上「前價」不加(免得重複)
//   真資料:REAL=1 讀 origin/data 的 legislator_holdings + K 線 + 股利,印出顏寬恒兩種報酬(不設門檻)
//   注入:PRO_FILE=<改過的 pro.html> 跑同一套,應該要紅
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_MODULE || '/opt/node22/lib/node_modules/playwright');
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { trSeries, scaleFor } from './lib_totalreturn.mjs';
import { extractPoli, rankAll } from './poli_rank.mjs';

let bad = 0;
const ok = (c, n, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${e ? ' — ' + e : ''}`); if (!c) bad++; };
const FILE = process.env.PRO_FILE || 'pro.html';
const SRC = readFileSync(FILE, 'utf8');
const NC = SRC.replace(/<!--[\s\S]*?-->/g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

ok(/\['poli', 'Poli'\]/.test(NC), '⓪a PRO.TABS 有 [poli, Poli]');
ok(/if \(t === 'poli'\) this\.renderPoli\(\);/.test(NC), '⓪b switchTab 有 lazy render');
ok(/id="tabBtnPoli"/.test(NC) && /id="tabPoli"/.test(NC), '⓪c 分頁鈕與容器都在');
ok(/this\._tab === 'poli'\) \{ this\._poliD = undefined/.test(NC), '⓪d 🔄 重新整理會清掉重抓');

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const pg = await b.newPage();
const errs = []; pg.on('pageerror', e => errs.push(String(e).slice(0, 160)));
await pg.goto(pathToFileURL(resolve(FILE)).href);
await pg.waitForFunction(() => typeof PRO !== 'undefined' && !!PRO.renderPoli, null, { timeout: 30000 });

// ① 跨檔:頁內 vs lib(opt 不給 → 逐點相同)
const D10 = s => s.replace(/\//g, '-');
const bars0050 = (() => { try { return JSON.parse(execSync('git show origin/data:data/0050.json', { maxBuffer: 1 << 26 }).toString()); } catch (_) { return null; } })();
const div = (() => { try { return JSON.parse(execSync('git show origin/data:data/dividends_hist.json', { maxBuffer: 1 << 28 }).toString()); } catch (_) { return null; } })();
const cases = [];
cases.push({ n: '合成:現金股利 + 分割尺標', bars: [10, 10, 10.2, 5.1, 5.2, 5.3].map((c, i) => ({ d: `2024-01-0${i + 1}`, c })),
  divs: [['2024-01-03', 0.5, '息', 10.4, 9.9], ['2024-01-05', 0.2, '息', 10.6, 10.4], ['2024-01-06', 1, '權', 6, 5]] });
if (bars0050 && div) cases.push({ n: '真資料:0050 全段', bars: bars0050.map(r => ({ d: D10(r.date).slice(0, 10), c: +r.close })).filter(r => r.c > 0), divs: div.d['0050'].h });
if (div) { try { const r = JSON.parse(execSync('git show origin/data:data/3374.json', { maxBuffer: 1 << 26 }).toString()); cases.push({ n: '真資料:3374 精材', bars: r.map(x => ({ d: D10(x.date).slice(0, 10), c: +x.close })).filter(x => x.c > 0), divs: div.d['3374'].h }); } catch (_) {} }
for (const C of cases) {
  const lib = trSeries(C.bars, C.divs);
  const pageV = await pg.evaluate(([bs, ds]) => PRO._poliTr(bs, ds).v, [C.bars, C.divs]);
  const maxd = Math.max(...lib.v.map((v, i) => Math.abs(v - pageV[i])));
  ok(pageV.length === lib.v.length && maxd < 1e-12, `①a 頁內 _poliTr == lib trSeries(${C.n})`, `n=${lib.v.length} 最大差 ${maxd}`);
}
ok(cases.length >= 2, '①a2 跨檔比對至少有一組真資料(讀不到 origin/data 時要說)', `組數 ${cases.length}`);
const sc = [[100, 100], [100, 50], [100, 25.2], [50, 101], [100, 70], [0, 10], [100, 0]];
const scOk = await pg.evaluate(S => S.map(([a, b]) => PRO._poliScale(a, b)), sc);
ok(sc.every(([a, bb], i) => JSON.stringify(scaleFor(a, bb)) === JSON.stringify(scOk[i])), '①b 頁內 _poliScale == lib scaleFor(七種比值)');

// ⑧ 配股:opt.stock 才加;前一天收盤對不上前價 → 不加
const stk = await pg.evaluate(() => {
  const bars = [{ d: '2026-08-18', c: 117 }, { d: '2026-08-19', c: 117.5 }, { d: '2026-08-20', c: 105.5 }, { d: '2026-08-21', c: 107 }];
  const ev = [['2026-08-20', 10.68, '權', 117.5, 106.82]];
  const ev2 = [['2026-08-20', 10.68, '權', 130, 118]];      // 前價對不上 K 線 → 當成 K 線已還原,⛔ 不加
  return { off: PRO._poliTr(bars, ev).v.at(-1), on: PRO._poliTr(bars, ev, { stock: true }).v.at(-1), mis: PRO._poliTr(bars, ev2, { stock: true }).v.at(-1) };
});
ok(Math.abs(stk.off - 107 / 117) < 1e-12, '⑧a 不開 stock → 跟 lib 一樣不計配股');
ok(Math.abs(stk.on - (107 / 117) * (117.5 / 106.82)) < 1e-9, '⑧b 開 stock → 股數 × 前價÷後價', stk.on.toFixed(6));
ok(Math.abs(stk.mis - 107 / 117) < 1e-12, '⑧c 前一天收盤對不上前價 → ⛔ 不加(免得重複)');

// ② ~ ⑦ 合成資料走真的渲染
const K = { '1111': [10, 10, 11, 11, 12], '2222': [20, 20, 20, 20, 18], '0050': [100, 100, 104, 105, 110] };
const DT = ['2024/01/02', '2024/01/03', '2024/01/04', '2024/01/05', '2024/01/08'];
const FIX = (sh2 = 1000) => ({ updated: '2026-10-13T21:58:03Z', src: 'https://legislator-wealth.tw', people: { 'x-y': { name: '測試人', party: '某黨',
  decls: [{ date: '2024-01-03', rows: [{ sym: '1111', name: '甲', shares: 1000, owner: '本人', val: 10000 }] },
          { date: '2024-01-05', rows: [{ sym: '1111', name: '甲', shares: 500, owner: '本人', val: 5000 }, { sym: '2222', name: '乙', shares: sh2, owner: '配偶', val: 10000 }, { sym: '9999', name: '丙', shares: 500, owner: '本人', val: 5000 }] }],
  trades: [{ d: '2024-01-04', sym: '2222', name: '乙', shares: 1000, px: 20, side: 'sell', why: '賣' }] } },
  skipped: { 'x-y': [] } });
const load = async (fix) => pg.evaluate(([F, K, DT]) => {
  PRO._cache = {};
  PRO._cache['data/legislator_holdings.json'] = F;
  PRO._cache['data/dividends_hist.json'] = { d: {} };
  for (const [s, cs] of Object.entries(K)) PRO._cache[`data/${s}.json`] = cs.map((c, i) => ({ date: DT[i], close: c }));
  PRO._names = Object.assign(PRO._names || {}, { '1111': '甲', '2222': '乙', '0050': '元大台灣50' });
  PRO.loadNames = async () => PRO._names;
  PRO._poliD = undefined; PRO._poliK = {}; PRO._poliSortK = null;
}, [fix, K, DT]);
await load(FIX());
await pg.evaluate(() => PRO.switchTab('poli'));
await pg.waitForFunction(() => !!document.querySelector('#poliTbl'), null, { timeout: 10000 }).catch(() => {});
const R = await pg.evaluate(() => {
  const t = document.getElementById('tabPoli');
  const h = t.querySelector('[data-poli-a]'), c = t.querySelector('[data-poli-b]');
  return { a: h ? +h.dataset.poliA : null, b: c ? +c.dataset.poliB : null, txt: (t.innerText || '').replace(/\s+/g, ' '),
    miss: (t.querySelector('[data-poli-miss]') || {}).innerText || '', rows: [...t.querySelectorAll('[data-poli-row]')].map(e => e.dataset.poliRow),
    vis: getComputedStyle(t).display !== 'none', inWrap: !!document.querySelector('.wrap #tabPoli') };
});
ok(R.vis && R.inWrap && !errs.length, '② 分頁切得過去、在 .wrap 裡、無 pageerror', errs.join(' | '));
ok(Math.abs(R.a - (24000 / 25500 - 1)) < 1e-9, '②a A:最新申報抱到今天 = 手算 (6000+18000)/(5500+20000)−1 = −5.88%', String(R.a));
ok(Math.abs(R.b - (1.1 * (24000 / 25500) - 1)) < 1e-9, '②b B:兩次申報串起來 = 手算 +3.53%', String(R.b));
ok(/0050/.test(R.txt) && /\+4\.8%/.test(R.txt) && /\+10\.0%/.test(R.txt), '②c 0050 同期(+4.8% / +10.0%)都有印');
ok(/丙|9999/.test(R.miss) && /25\.0%/.test(R.miss), '④ 算不出的那檔要寫出來 + 佔 25.0%(⛔ 不靜默丟)', R.miss.slice(0, 120));
ok(R.rows.join(',') === '2222,1111' && /起點佔比 ▼/.test(R.txt), '⑤a 預設照「起點佔比」由大到小,而且表頭看得出來(▼)', R.rows.join(','));
const s1 = await pg.evaluate(() => { PRO.poliSort('ret'); return [...document.querySelectorAll('[data-poli-row]')].map(e => e.dataset.poliRow).join(','); });
const s2 = await pg.evaluate(() => { PRO.poliSort('ret'); return [...document.querySelectorAll('[data-poli-row]')].map(e => e.dataset.poliRow).join(','); });
ok(s1 === '1111,2222' && s2 === '2222,1111', '⑤b 同一個表頭再點一次要反向', `${s1} → ${s2}`);
const BUY = /建議買|可以買|進場|加碼|買進訊號|跟著買進/;
ok(!BUY.test(R.txt), '⑦ ⛔ 不給買進指令', (R.txt.match(BUY) || [])[0]);
ok(/不是他真實的報酬/.test(R.txt), '⑦b 畫面要寫明「不是他真實的報酬」');
// ③ 決定性對照
await load(FIX(3000)); await pg.evaluate(() => PRO.renderPoli()); await pg.waitForTimeout(300);
const a3 = await pg.evaluate(() => +(document.querySelector('[data-poli-a]') || {}).dataset?.poliA);
ok(Number.isFinite(a3) && Math.abs(a3 - R.a) > 1e-6 && Math.abs(a3 - ((6000 + 18000 * 3) / (5500 + 20000 * 3) - 1)) < 1e-9, '③ 決定性對照:乙的股數 1000 → 3000,報酬跟著變', `${R.a} → ${a3}`);
// ⑨ 🏆 排行
const RK = rankAll(FIX(), extractPoli(SRC), s => (K[s] ? K[s].map((c, i) => ({ date: DT[i], close: c })) : null), {});
ok(RK.rows.length === 1 && Math.abs(RK.rows[0].ret - R.a) < 1e-12 && Math.abs(RK.rows[0].chain - R.b) < 1e-12,
  '⑨a poli_rank(抽 pro.html 的函式)算的 == 頁面畫出來的(A、B 逐位)', `${RK.rows[0] && RK.rows[0].ret} vs ${R.a}`);
ok(Math.abs(RK.rows[0].cov - 0.75) < 1e-12, '⑨a2 算得出比例 = 1 − 丙的面額 5000 / 20000 = 75%(跟單人頁的「佔 25.0%」同一份)', String(RK.rows[0].cov));
const FIXR = (beat = 1) => { const F = FIX(); F.people['z-w'] = JSON.parse(JSON.stringify(F.people['x-y'])); F.people['z-w'].name = '另一人';
  F.rank = [{ slug: 'x-y', name: '測試人', party: '某黨', date: '2024-01-05', v0: 25500, ret: -0.06, bench: 0.05, ex: -0.11, chain: 0.03, cov: 0.8 },
            { slug: 'z-w', name: '另一人', party: '某黨', date: '2024-01-05', v0: 5e6, ret: 0.4, bench: 0.05, ex: 0.35, chain: null, cov: 0.5 },
            { slug: 'q-q', name: '算不出', party: '', date: '2024-01-05', v0: 0, ret: 0.1, bench: null, ex: null, chain: null, cov: null }];
  F.rank_meta = { asof: '2024-01-08', n_people: 3, beat0050: beat, median_ex: 0.12 }; F.nostock = [{ slug: 'n', name: '沒股票', why: '申報裡沒有股票' }]; return F; };
await load(FIXR()); await pg.evaluate(() => PRO.renderPoli());
await pg.waitForFunction(() => !!document.querySelector('#poliRankTbl'), null, { timeout: 8000 }).catch(() => {});
const rk = await pg.evaluate(() => ({ rows: [...document.querySelectorAll('[data-poli-rrow]')].map(e => e.dataset.poliRrow),
  txt: (document.getElementById('poliRank') || {}).innerText || '', raw: (document.getElementById('poliRank') || {}).textContent || '', meta: (document.querySelector('[data-poli-meta]') || {}).dataset?.poliMeta,
  bar: document.getElementById('poliBar').innerText }));
ok(rk.rows.join(',') === 'z-w,x-y,q-q' && /贏\/輸 0050\(百分點\) ▼/.test(rk.txt), '⑨b 預設照「贏/輸 0050」由高到低、算不出的排最後、表頭看得出來', rk.rows.join(','));
ok(/⚠️ 多數持股算不出/.test(rk.txt) && /金額小/.test(rk.txt) && /排第一 ≠ 會選股/.test(rk.txt) && /沒股票/.test(rk.raw) && !rk.bar,
  '⑨c 算得出 <60% / 金額小 標出來、運氣提醒、沒持股的那幾位列出來、按鈕列不重複出現');
const r1 = await pg.evaluate(() => { PRO.poliRankSort('ex'); return [...document.querySelectorAll('[data-poli-rrow]')].map(e => e.dataset.poliRrow).join(','); });
ok(r1 === 'x-y,z-w,q-q', '⑨d 同一個表頭再點一次要反向(算不出的仍在最後)', r1);
await pg.evaluate(() => document.querySelector('[data-poli-rrow="z-w"]').click()); await pg.waitForTimeout(400);
const who = await pg.evaluate(() => PRO._poliSlug + '|' + ((document.getElementById('poliBody').innerText.match(/另一人|測試人/) || [])[0] || ''));
ok(who === 'z-w|另一人', '⑨e 點一列 → 底下換成那一位的明細', who);
ok(!BUY.test(rk.txt), '⑨f 排行表 ⛔ 不給買進指令', (rk.txt.match(BUY) || [])[0]);
await load(FIXR(2)); await pg.evaluate(() => PRO.renderPoli()); await pg.waitForTimeout(300);
const meta2 = await pg.evaluate(() => (document.querySelector('[data-poli-meta]') || {}).dataset?.poliMeta);
ok(rk.meta === '1/3' && meta2 === '2/3', '⑨g 決定性對照:「幾位贏 0050」讀 rank_meta,改了畫面跟著變', `${rk.meta} → ${meta2}`);
await load(FIX()); await pg.evaluate(() => PRO.renderPoli()); await pg.waitForTimeout(300);
const noRk = await pg.evaluate(() => !document.querySelector('#poliRankTbl') && !!document.querySelector('[data-poli-a]'));
ok(noRk, '⑨h 舊檔(沒有 rank)→ 不畫排行、單人明細照常');
// ⑥ 讀不到檔
await pg.evaluate(() => { PRO._cache = {}; PRO.fetchJson = async () => null; PRO._poliD = undefined; return PRO.renderPoli(); });
const nf = await pg.evaluate(() => !!document.querySelector('[data-poli-nofile]') && /讀不到/.test(document.getElementById('poliBody').innerText));
ok(nf, '⑥ 讀不到 legislator_holdings.json 要講原因(⛔ 不空白)');

// 真資料(REAL=1)
if (process.env.REAL) {
  const g = p => JSON.parse(execSync(`git show origin/data:${p}`, { maxBuffer: 1 << 28 }).toString());
  const J = g('data/legislator_holdings.json'), Dv = g('data/dividends_hist.json');
  const need = new Set(['0050']); for (const P of Object.values(J.people)) { for (const d of P.decls) for (const r of d.rows) need.add(r.sym); for (const t of P.trades) if (t.sym) need.add(t.sym); }
  const KK = {}; for (const s of need) { try { KK[`data/${s}.json`] = g(`data/${s}.json`); } catch (_) {} }
  const pg2 = await b.newPage(); await pg2.goto(pathToFileURL(resolve(FILE)).href);
  await pg2.waitForFunction(() => typeof PRO !== 'undefined' && !!PRO.renderPoli, null, { timeout: 30000 });
  const names = JSON.parse(execSync('git show origin/data:data/stock_names.json', { maxBuffer: 1 << 26 }).toString());
  const out = await pg2.evaluate(async ([J, Dv, KK, NM]) => {
    PRO._cache['data/legislator_holdings.json'] = J; PRO._cache['data/dividends_hist.json'] = Dv; Object.assign(PRO._cache, KK);
    PRO._cache['data/stock_names.json'] = NM;
    await PRO.switchTab('poli'); await new Promise(r => setTimeout(r, 1500));
    const P = J.people['yan-kuan-heng'], K = PRO._poliK, C = PRO._poliCalc(P, K, Dv.d, K['0050']);
    return { A: C.A.map(a => ({ date: a.date, ret: a.ret, bench: a.bench, v0: a.v0, v1: a.v1, n: a.items.length, miss: a.miss.map(m => m.name),
      top: a.items.slice().sort((x, y) => y.v0 - x.v0).slice(0, 6).map(i => `${i.sym}:${(i.ret * 100).toFixed(1)}%`) })),
      chain: C.chain && { ret: C.chain.ret, bench: C.chain.bench, segs: C.chain.segs }, txt: document.getElementById('poliBody').innerText.slice(0, 900) };
  }, [J, Dv, KK, names]);
  console.log(JSON.stringify(out, null, 1));
}
await b.close();
console.log(bad ? `\n❌ ${bad} 條沒過` : '\n✅ POLIHOLD_PASS');
process.exit(bad ? 1 : 0);
