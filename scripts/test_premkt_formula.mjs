#!/usr/bin/env node
/**
 * 🌅 V79.5.4 盤前體檢「開盤分數」只有一份算法:`app._preOpenScore(x)`
 *
 * 為什麼抽出來:10/22 使用者問「預判準確度跑掉了,要不要調權重」—— App 那條公式以前長在 renderMarketBriefing 裡面,
 *   回測探針只能另外抄一份(premkt_probe.py 的 STRICT 8 項跟 App 不一樣)→ 從來沒有人回測過「App 真的在用的那條」。
 *   現在 scripts/premkt_app_probe.mjs 直接呼叫這一支重算 2010 起每一天(⛔ 不複製判定邏輯)。
 *
 * ⛔ 釘住:
 *   ⓪ 全 App 只有一份定義、renderMarketBriefing 只呼叫一次、裡面 ⛔ 不再自己算分;每一筆加減都走 _add(只有一處 `s +=`)
 *   ① 全部沒有資料 → 0 分(50 / 100),美股 5 項 + 亞股 3 項照樣列出「沒有資料」
 *   ② 每一項的權重 / 門檻逐項釘死(改任何一個都要先跑 premkt_app_probe,再回來改這裡)
 *   ③ 一組完整的例子(手算 8 分)
 *   ⑦ V79.5.4 亞股三項只列出來、0 分(不管漲跌多少、資料新舊)—— premkt_app_probe 2010~2026 實測拿掉比較準
 *   ⑧ 產業作戰室 `PRO._premktScore` 是這支的抄本(兩個檔案沒辦法互相 import)→ 同一份 macro_risk 300 組,兩邊分數逐一相同
 *   ④ 資料舊了(stale)→ 那一項 0 分、寫「資料舊了・不計分」
 *   ⑤ ⭐ 決定性對照:抓不到(null)⛔ 不可當成 0 —— 恐懼貪婪 null 以前會變「極度恐慌 +0.5 分」;同一組換成 10 → 才 +0.5
 *   ⑥ 接線:renderMarketBriefing 實跑的 `_preOpenCalc` == 直接呼叫 `_preOpenScore`(同一份輸入);每一項的說明 = 餵進去的那個值
 *   ⑥d ⑥e V79.9.8 台指期只有真的夜盤(sess 'night')才算分:前一天日盤 / 不知道哪一盤 → 0 分,那一格寫日期 +「日盤」+「只列出來」(決定性對照:同一個 +2.47% 換成夜盤 → +1.5)
 *   ⑩ V79.9.9 美股四項 + 台積電 ADR 漲跌太小(|%| < 0.4)算 0 分:門檻 App == pro、邊界 0.39 → 0 / 0.4 → 照算;注入「拿掉門檻」必紅
 *   ⑨ V79.9.8 開盤發生率(`_PREMKT_OCC`)== 產業作戰室 `_PREMKT`;高分 / 低分那一行三個比例跟著換、⛔ 研究字樣
 *   INJECT=1:漲跌太小也算分 / 台積電權重 ×2→×1 / 恐懼貪婪 null 退回 `+x.fg` / 呼叫端把那斯達克跟 S&P 接反 / 亞股又算分 / 日盤又算分(App 或只改產業作戰室那份)/ 只改產業作戰室台積電權重 → 每一種都要紅
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const INJ = {
  tsmw: ["else _add('🏭 台積電 ADR', _sd(tsmChg, x.tsm) * 2, _dn(tsmChg, x.tsm));", "else _add('🏭 台積電 ADR', _sd(tsmChg, x.tsm) * 1, _dn(tsmChg, x.tsm));"],
  fgnull: ['const _fgN = _num(x.fg);', 'const _fgN = +x.fg;'],
  wiring: ["dji: usPct('dji'), ndx: usPct('nasdaq'), spx: usPct('sp500'),", "dji: usPct('dji'), ndx: usPct('sp500'), spx: usPct('nasdaq'),"],
  asia: ["const _asia = (nm, k, c) => _info(nm,", "const _asia = (nm, k, c) => _add(nm, Number.isFinite(c) ? Math.sign(c) : 0,"],
  txday: ["if (txNight && txNight.sess === 'night' && txNight.est !== true", "if (txNight && txNight.est !== true"],
  occ: ['hi: { n: 1738, up: 50.7,', 'hi: { n: 1738, up: 99.9,'],
  dead: ["const _dz = v => { const n = N(v); return n != null && Math.abs(Math.round(n * 100) / 100) < this._PREMKT_DEAD; };", "const _dz = v => false;"],
};
const PRO_SRC = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');
// ⑧ 注入在 pro 那一份(只改一邊 → 兩邊對不上要紅)
const INJ_PRO = { proTsm: ["if (tsm != null && !stale('tsm')) add('台積電 ADR', tsm, dz(tsm) ? 0 : sg(tsm) * 2);", "if (tsm != null && !stale('tsm')) add('台積電 ADR', tsm, dz(tsm) ? 0 : sg(tsm) * 1.5);"],
                  proDead: ["const DEAD = 0.4, dz = v => Math.abs(Math.round(v * 100) / 100) < DEAD;", "const DEAD = 0.4, dz = v => false;"],
                  proTxDay: ["if (tx && tx.sess === 'night' && tx.est !== true", "if (tx && tx.est !== true"] };

const fnBody = html => {
  const i = html.indexOf('    _preOpenScore(x) {');
  const j = html.indexOf('\n    },\n', i);
  return i < 0 || j < 0 ? '' : html.slice(i, j);
};
const rmbBody = html => (html.match(/async renderMarketBriefing\(\)\s*\{[\s\S]*?\n    \},\n/) || [''])[0];
const stripC = t => t.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n').replace(/\/\/[^\n'`]*$/gm, '');

async function run(html, proHtml = PRO_SRC) {
  const fails = [];
  const ok = (n, c, e = '') => { if (!process.env.QUIET) console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };

  // ⓪ 靜態
  ok('⓪ `_preOpenScore` 全 App 只有一份定義', (html.match(/\n    _preOpenScore\(x\) \{/g) || []).length === 1);
  const rmb = stripC(rmbBody(html)), fb = stripC(fnBody(html));
  ok('⓪b renderMarketBriefing 只呼叫一次、⛔ 不再自己算分(沒有 _asiaScore / s += / _pp)',
     rmb.length > 15000 && (rmb.match(/this\._preOpenScore\(/g) || []).length === 1 && !/_asiaScore|_pp\b|(^|\n)\s*s \+=/.test(rmb),
     `len ${rmb.length}`);
  const nAdd = (fb.match(/(^|\n)\s*s \+=/g) || []).length, nSub = (fb.match(/(^|\n)\s*s -=/g) || []).length;
  ok('⓪c 每一筆加減都走 _add(函式裡只有一處 `s +=`、沒有 `s -=`)', fb.length > 2000 && /parts\.push/.test(fb) && nAdd === 1 && nSub === 0, `s+= ${nAdd} ・s-= ${nSub}`);

  let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
  const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const browser = await chromium.launch({ ...(fs.existsSync(exe) ? { executablePath: exe } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'premktf-')), 'index.html');
  fs.writeFileSync(tmp, html);
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  const errs = []; page.on('pageerror', e => { const m = String(e); if (!/Cache|file' is unsupported|Failed to fetch/.test(m)) errs.push(m.slice(0, 200)); });
  await page.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
  await page.goto(pathToFileURL(tmp).href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof app !== 'undefined' && !!app._preOpenScore, null, { timeout: 30000 });
  await page.waitForTimeout(1500);

  const R = await page.evaluate(async () => {
    const A = app, o = {};
    const F = x => A._preOpenScore(x);
    const d = (r, nm) => { const p = r.parts.find(q => q.nm === nm); return p ? p.d : undefined; };
    const note = (r, nm) => { const p = r.parts.find(q => q.nm === nm); return p ? p.note : undefined; };
    // ① 全部沒有
    const e = F({});
    o.empty = { s: e.s, sPct: e.sPct, n: e.parts.length, names: e.parts.map(p => p.nm), notes: e.parts.map(p => p.note) };
    // ② 單項權重 / 門檻
    const one = (k, v, nm, extra) => d(F(Object.assign({ [k]: v }, extra || {})), nm);
    o.w = {
      dji_up: one('dji', 0.4, '🇺🇸 道瓊'), dji_dn: one('dji', -0.4, '🇺🇸 道瓊'), dji_0: one('dji', 0, '🇺🇸 道瓊'),
      // 🧪 V79.9.9 漲跌太小(|%| < 0.4)算 0 分:0.39 / −0.39 / 0.1 都是 0;0.4 起照算(邊界)
      dji_039: one('dji', 0.39, '🇺🇸 道瓊'), dji_m039: one('dji', -0.39, '🇺🇸 道瓊'), sox_03: one('sox', 0.3, '💾 費半'), tsm_02: one('tsm', 0.2, '🏭 台積電 ADR'), spx_m01: one('spx', -0.1, '🇺🇸 S&P500'),
      ndx: one('ndx', -1, '🇺🇸 那斯達克'), spx: one('spx', 2, '🇺🇸 S&P500'), sox: one('sox', 1, '💾 費半'), sox_dn: one('sox', -1, '💾 費半'),
      tsm: one('tsm', 0.5, '🏭 台積電 ADR'), tsm_dn: one('tsm', -0.5, '🏭 台積電 ADR'),
      asx: one('asx', 0.3, '🔌 日月光 ADR'), umc: one('umc', -0.2, '🔌 聯電 ADR'), umc0: one('umc', 0, '🔌 聯電 ADR'),
      vix31: one('vix', 31, '😱 VIX'), vix26: one('vix', '26.00', '😱 VIX'), vix22: one('vix', 22, '😱 VIX'), vix19: one('vix', '19.99', '😱 VIX'),
      nq_up: one('nq', 0.31, '🔮 那指期夜盤'), nq_dn: one('nq', -0.31, '🔮 那指期夜盤'), nq_flat: one('nq', 0.3, '🔮 那指期夜盤'),
      ust_up: one('ust', 2, '📜 美債 10 年期'), ust_dn: one('ust', -2, '📜 美債 10 年期'), ust_mid: one('ust', 1.9, '📜 美債 10 年期'),
      n1: one('night', 1, '🌙 台指期夜盤'), n02: one('night', 0.2, '🌙 台指期夜盤'), nm02: one('night', -0.2, '🌙 台指期夜盤'), nm1: one('night', -1, '🌙 台指期夜盤'), n01: one('night', 0.1, '🌙 台指期夜盤'),
      nk03: one('nk', 0.3, '🇯🇵 日經'), nk1: one('nk', 1, '🇯🇵 日經'), nk5: one('nk', 5, '🇯🇵 日經'), ksm1: one('ks', -1, '🇰🇷 韓股'), ksm03: one('ks', -0.3, '🇰🇷 韓股'), hs1: one('hs', 1, '🇭🇰 恆指'),
      fg80: one('fg', 80, '🧭 恐懼貪婪'), fg20: one('fg', 20, '🧭 恐懼貪婪'), fg50: one('fg', 50, '🧭 恐懼貪婪'),
      twd04: one('twd', 0.4, '💱 台幣(當日)'), twd015: one('twd', 0.15, '💱 台幣(當日)'), twdm04: one('twd', -0.4, '💱 台幣(當日)'), twdm015: one('twd', -0.15, '💱 台幣(當日)'), twd01: one('twd', 0.1, '💱 台幣(當日)'),
      twd5: one('twd5', 1, '💱 台幣(5 日連貶)'),
      fx: one('twd5', 0.8, '💱 亞幣競貶', { krw5: 0.8 }), fx_no: one('twd5', 0.8, '💱 亞幣競貶', { krw5: 0.79 }),
      cny: one('cny5', 1.2, '💱 人民幣急貶'), cny_no: one('cny5', 1.19, '💱 人民幣急貶'),
      // 只列出來、⛔ 不計分
      fut: one('fut', { chg5: -9000 }, '🏦 外資台指期(5日增減)'), spot: one('fiSpot', -300, '🏦 外資現貨買賣超'),
      tot: one('fiTotal', 500, '🏛️ 三大法人合計'), tech: one('tech', '偏多', '📈 加權自己的技術面'),
    };
    // ③ 完整例子
    const full = F({ dji: 0.5, ndx: 1.2, spx: 0.8, sox: 2.1, tsm: 3.0, vix: '15.20', nk: 1.2, ks: 0.4, hs: -0.5, fg: 50, twd: -0.2 });
    o.full = { s: full.s, sPct: full.sPct, raw: full.raw, clamped: full.clamped, sum: Math.round(full.parts.reduce((a, p) => a + p.d, 0) * 10) / 10 };
    const big = F({ dji: 1, ndx: 1, spx: 1, sox: 1, tsm: 1, vix: 15, asx: 1, umc: 1, night: 2, nk: 2, ks: 2, hs: 2, twd: -1, nq: 1 });
    o.big = { s: big.s, sPct: big.sPct, raw: big.raw, clamped: big.clamped };
    // ④ 資料舊了
    const st = F({ tsm: 3, nk: 2, stale: { tsm: '2026-10-19', nikkei: '2026-10-19' } });
    o.stale = { tsm: d(st, '🏭 台積電 ADR'), tsmN: note(st, '🏭 台積電 ADR'), nk: d(st, '🇯🇵 日經'), nkN: note(st, '🇯🇵 日經'), s: st.s };
    // ⑤ null ⛔ 不可當 0
    const z = F({ fg: null, nk: null, fiSpot: null, fiTotal: null, twd: null, twd5: null, krw5: null, cny5: null });
    o.nul = { s: z.s, fg: d(z, '🧭 恐懼貪婪'), nkN: note(z, '🇯🇵 日經'), spot: d(z, '🏦 外資現貨買賣超'), tot: d(z, '🏛️ 三大法人合計'), twd: d(z, '💱 台幣(當日)'), vfg: z.v.fg };
    o.nul2 = { s: F({ fg: '' }).s, s10: F({ fg: 10 }).s, d10: d(F({ fg: 10 }), '🧭 恐懼貪婪') };

    // ⑥ 接線:實跑 renderMarketBriefing(每一欄一個好認的值)→ `_preOpenCalc` 要等於直接呼叫
    A._getTwiiRows = async () => null; A.fetchFugleData = async () => null; A._bubbleCache = {}; A._riskHistCache = [];
    const mr = {
      updated: '2026-10-22 08:12 +0800', taiex_date: '2026-10-21', fi_three_date: '2026-10-21', sp500_date: '2026-10-21',
      dji_chg_pct: 0.11, nasdaq_chg_pct: -0.22, sp500_chg_pct: 0.33, sox_chg_pct: -0.44, tsm_chg_pct: 0.55,
      asx_chg_pct: 0.66, umc_chg_pct: -0.77, tsm_date: '2026-10-21', asx_date: '2026-10-21', umc_date: '2026-10-21',
      vix: 26.5, vix_date: '2026-10-22', nq_fut_chg_pct: 0.88, ust10y_chg_pct: -2.5,
      fi_spot_net: -123, fi_total_net: 456, taifex_tx_now: { chg: -0.35, est: false, sess: 'night' },
      nikkei_chg_pct: 1.11, kospi_chg_pct: -0.45, hsi_chg_pct: 0.6, nikkei_date: '2026-10-21', kospi_date: '2026-10-21', hsi_date: '2026-10-21',
      fear_greed: null, usdtwd_chg_pct: 0.2, usdtwd_chg_5d: 0.9, krw_chg_5d: 0.85, cny_chg_5d: 1.3,
    };
    A._macroRiskCache = mr; A.usMacroCache = { dji: { close: 1 } }; A._marketSnapshot = A.usMacroCache; A.fiShortQty = null;
    await A.renderMarketBriefing();
    const C = A._preOpenCalc || {};
    const _f5 = A._fiFutState();
    const D = F({ dji: 0.11, ndx: -0.22, spx: 0.33, sox: -0.44, tsm: 0.55, asx: 0.66, umc: -0.77, vix: '26.50', nq: 0.88, ust: -2.5,
                  night: -0.35, nk: 1.11, ks: -0.45, hs: 0.6, fg: null, twd: 0.2, twd5: 0.9, krw5: 0.85, cny5: 1.3,
                  stale: A._premktFieldAge(mr).stale, fut: { chg5: _f5.chg5, pct: _f5.pct }, fiSpot: -123, fiTotal: 456, tech: null });
    o.wire = {
      same: JSON.stringify(C.parts) === JSON.stringify(D.parts) && C.s === D.s && C.sPct === D.sPct,
      C: C.parts && C.parts.map(p => `${p.nm}:${p.d}:${p.note}`).join(' | '), D: D.parts.map(p => `${p.nm}:${p.d}:${p.note}`).join(' | '),
      notes: Object.fromEntries((C.parts || []).map(p => [p.nm, p.note])),
      txt: (document.getElementById('marketBriefing') || {}).innerText || '',
    };
    // ⑥d V79.9.8 台指期:前一天日盤(sess 'day')/ 不知道哪一盤 ⛔ 算分;同一個 +2.47% 換成真的夜盤才算(決定性對照)
    const runTx = async tx => { A._macroRiskCache = { ...mr, taifex_tx_now: tx }; await A.renderMarketBriefing(); const c = A._preOpenCalc || {};
      return { d: ((c.parts || []).find(p => p.nm === '🌙 台指期夜盤') || {}).d, s: c.s, txt: (document.getElementById('marketBriefing') || {}).textContent || '' }; };
    o.txDay = await runTx({ price: 23456, chg: 2.47, est: false, sess: 'day', date: '2026-10-28' });
    o.txNa = await runTx({ price: 23456, chg: 2.47, est: false });
    o.txNight = await runTx({ price: 23456, chg: 2.47, est: false, sess: 'night' });
    // ⑨ V79.9.8 開盤發生率那一行:高分 / 低分各跑一次,三個比例跟著換
    const occOf = async extra => { A._macroRiskCache = { ...mr, ...extra }; await A.renderMarketBriefing();
      const el = document.querySelector('#marketBriefing [data-occ="premkt"]'); return { p: (A._preOpenCalc || {}).sPct, t: el ? el.textContent : '' }; };
    o.occHi = await occOf({ dji_chg_pct: 1, nasdaq_chg_pct: 1, sp500_chg_pct: 1, sox_chg_pct: 1, tsm_chg_pct: 1, vix: 15, nq_fut_chg_pct: 1 });
    o.occLo = await occOf({ dji_chg_pct: -1, nasdaq_chg_pct: -1, sp500_chg_pct: -1, sox_chg_pct: -1, tsm_chg_pct: -1, vix: 35, nq_fut_chg_pct: -1, asx_chg_pct: -1 });
    o.occK = JSON.parse(JSON.stringify(A._PREMKT_OCC || null));
    A._macroRiskCache = mr;
    return o;
  });

  const W = R.w;
  ok('① 全部沒有資料 → 0 分 / 50 分;美股 5 項 + 亞股 3 項照樣列出', R.empty.s === 0 && R.empty.sPct === 50 && R.empty.n === 8
     && R.empty.notes.every(n => /^沒有資料/.test(n)), JSON.stringify(R.empty));
  const exp = {
    dji_up: 1, dji_dn: -1, dji_0: 0, dji_039: 0, dji_m039: 0, sox_03: 0, tsm_02: 0, spx_m01: 0, ndx: -1, spx: 1, sox: 1.5, sox_dn: -1.5, tsm: 2, tsm_dn: -2, asx: 0.5, umc: -0.5, umc0: 0,
    vix31: -2, vix26: -1, vix22: 0, vix19: 1, nq_up: 1, nq_dn: -1, nq_flat: 0, ust_up: -0.5, ust_dn: 0.5, ust_mid: 0,
    n1: 1.5, n02: 1, nm02: -1, nm1: -2, n01: 0, nk03: 0, nk1: 0, nk5: 0, ksm1: 0, ksm03: 0, hs1: 0,
    fg80: -0.5, fg20: 0.5, fg50: 0, twd04: -1, twd015: -0.5, twdm04: 1, twdm015: 0.5, twd01: 0, twd5: -0.5,
    fx: -1, fx_no: undefined, cny: -0.5, cny_no: undefined, fut: 0, spot: 0, tot: 0, tech: 0,
  };
  const badW = Object.keys(exp).filter(k => W[k] !== exp[k]);
  ok('② 每一項的權重 / 門檻(55 條;改任何一個都要先跑 premkt_app_probe)', badW.length === 0,
     badW.map(k => `${k}: ${W[k]} ≠ ${exp[k]}`).join(' ・'));
  ok('③ 完整例子:3 + 費半 1.5 + 台積電 2 + VIX 1 + 台幣升 0.5 = 8 分 ・90 / 100(日經 1.2 / 韓股 0.4 / 恆指 −0.5 只列出來)',
     R.full.s === 8 && R.full.sPct === 90 && R.full.raw === 90 && !R.full.clamped, JSON.stringify(R.full));
  ok('③b 逐項加總 == 分數(⛔ 明細漏記就會對不上)', Math.abs(R.full.sum - R.full.s) < 0.051, JSON.stringify(R.full));
  ok('③c 超出量表要標 clamped,而且留原始分', R.big.sPct === 100 && R.big.clamped && R.big.raw > 100, JSON.stringify(R.big));
  ok('④ 資料舊了 → 0 分、寫「資料舊了」「不計分」(台積電 / 日經)', R.stale.tsm === 0 && R.stale.nk === 0 && R.stale.s === 0
     && /資料舊了/.test(R.stale.tsmN) && /不計分/.test(R.stale.tsmN) && /資料舊了/.test(R.stale.nkN), JSON.stringify(R.stale));
  ok('⑤ ⭐ 抓不到(null)⛔ 當成 0:恐懼貪婪不列、不加 0.5;亞股寫「沒有資料」;外資現貨 / 三大法人 / 台幣不列',
     R.nul.s === 0 && R.nul.fg === undefined && /^沒有資料/.test(R.nul.nkN || '') && R.nul.spot === undefined && R.nul.tot === undefined
     && R.nul.twd === undefined && Number.isNaN(R.nul.vfg), JSON.stringify(R.nul));
  ok('⑤b 決定性對照:空字串也不算;同一組換成 10 → 才 +0.5', R.nul2.s === 0 && R.nul2.s10 === 0.5 && R.nul2.d10 === 0.5, JSON.stringify(R.nul2));
  ok('⑥ 接線:實跑的 `_preOpenCalc` == 直接呼叫(同一份輸入)', R.wire.same, `\n  實跑 ${R.wire.C}\n  直接 ${R.wire.D}`);
  const N = R.wire.notes;
  ok('⑥b 每一項的說明 = 餵進去的那個值(⛔ 接反了會對不上)',
     N['🇺🇸 道瓊'] === '+0.11%・太小不計分' && N['🇺🇸 那斯達克'] === '-0.22%・太小不計分' && N['🇺🇸 S&P500'] === '+0.33%・太小不計分' && N['💾 費半'] === '-0.44%'
     && N['🏭 台積電 ADR'] === '+0.55%' && N['🔌 日月光 ADR'] === '0.66%' && N['🔌 聯電 ADR'] === '-0.77%' && N['😱 VIX'] === '26.5'
     && N['🔮 那指期夜盤'] === '0.88%' && N['📜 美債 10 年期'] === '-2.5%' && N['🌙 台指期夜盤'] === '-0.35%'
     && N['🇯🇵 日經'] === '1.11% ・不計分' && N['🇰🇷 韓股'] === '-0.45% ・不計分' && N['🇭🇰 恆指'] === '0.6% ・不計分' && !('🧭 恐懼貪婪' in N)
     && N['💱 台幣(當日)'] === '0.2%' && /台幣 0\.9% ・韓元 0\.8%/.test(N['💱 亞幣競貶'] || '') && N['💱 人民幣急貶'] === '1.30%',
     JSON.stringify(N));
  const TX = { day: R.txDay && R.txDay.d, na: R.txNa && R.txNa.d, night: R.txNight && R.txNight.d, ds: R.txNight && R.txDay && R.txNight.s - R.txDay.s };
  ok('⑥d V79.9.8 台指期前一天日盤 / 不知道哪一盤 ⛔ 算分;同一個 +2.47% 換成真的夜盤才 +1.5(決定性對照)',
     TX.day === undefined && TX.na === undefined && TX.night === 1.5 && Math.abs(TX.ds - 1.5) < 1e-9, JSON.stringify(TX));
  ok('⑥e 日盤那一格寫出哪一天、「日盤」、「只列出來」;⛔ 寫「夜盤走強」',
     /10\/28/.test(R.txDay.txt) && /日盤/.test(R.txDay.txt) && /只列出來/.test(R.txDay.txt) && !/夜盤走強/.test(R.txDay.txt) && !/夜盤走強/.test(R.txNa.txt),
     R.txDay.txt.slice(0, 160));
  ok('⑥c 恐懼貪婪抓不到 → 分析師那段 ⛔ 不可寫「極度恐慌」', !/極度恐慌|恐懼貪婪 0\)/.test(R.wire.txt), R.wire.txt.slice(0, 200));
  ok('⑦ V79.5.4 亞股三項照樣列出來(看得到漲跌)但 0 分:日經 +5% / 韓股 −1% / 恆指 +1% 都是 0,說明寫「不計分」',
     W.nk5 === 0 && W.ksm1 === 0 && W.hs1 === 0 && R.empty.names.includes('🇯🇵 日經') && R.empty.names.includes('🇭🇰 恆指')
     && /不計分/.test(R.empty.notes[R.empty.names.indexOf('🇯🇵 日經')] || ''), JSON.stringify({ nk5: W.nk5, ksm1: W.ksm1, hs1: W.hs1 }));
  ok('⓪d 無 pageerror', errs.length === 0, errs.join(' | '));

  // ⑧ 跨檔:產業作戰室的抄本 == App(同一份 macro_risk,300 組隨機)
  const tmpP = path.join(path.dirname(tmp), 'pro.html');
  fs.writeFileSync(tmpP, proHtml);
  const pp = await browser.newPage();
  await pp.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
  await pp.goto(pathToFileURL(tmpP).href, { waitUntil: 'domcontentloaded' });
  await pp.waitForFunction(() => typeof PRO !== 'undefined' && !!PRO._premktScore, null, { timeout: 30000 });
  let seed = 20261022;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const num = (lo, hi, nullP = 0.12) => rnd() < nullP ? null : Math.round((lo + (hi - lo) * rnd()) * 100) / 100;
  const pick = a => a[Math.floor(rnd() * a.length)];
  const fx = [];
  for (let i = 0; i < 300; i++) fx.push({
    updated: '2026-10-22 08:12 +0800', taiex_date: '2026-10-21', fi_three_date: '2026-10-21', sp500_date: '2026-10-21',
    dji_chg_pct: num(-3, 3), nasdaq_chg_pct: num(-4, 4), sp500_chg_pct: num(-3, 3), sox_chg_pct: num(-6, 6), tsm_chg_pct: num(-6, 6),
    asx_chg_pct: num(-5, 5), umc_chg_pct: num(-5, 5), tsm_date: pick(['2026-10-21', '2026-10-21', '2026-10-20']), asx_date: pick(['2026-10-21', '2026-10-20']), umc_date: pick(['2026-10-21', '']),
    vix: num(11, 40, 0.05), nq_fut_chg_pct: num(-1.5, 1.5, 0.5), ust10y_chg_pct: num(-4, 4, 0.2),
    taifex_tx_now: rnd() < 0.4 ? null : { chg: num(-2.5, 2.5, 0), est: rnd() < 0.2, sess: pick(['night', 'night', 'day', undefined]) },
    nikkei_chg_pct: num(-4, 4), kospi_chg_pct: num(-5, 5), hsi_chg_pct: num(-4, 4), nikkei_date: '2026-10-21', kospi_date: '2026-10-21', hsi_date: '2026-10-20',
    fear_greed: num(5, 95, 0.15), usdtwd_chg_pct: num(-0.8, 0.8, 0.1), usdtwd_chg_5d: num(-2, 2, 0.1), krw_chg_5d: num(-2, 2, 0.2), cny_chg_5d: num(-1.5, 1.8, 0.2),
    fi_total_net: 100, fi_spot_net: -50,
  });
  const appS = await page.evaluate(async F => {
    const A = app, out = [];
    A._getTwiiRows = async () => null; A.fetchFugleData = async () => null; A._bubbleCache = {}; A._riskHistCache = [];
    for (const mr of F) { A._macroRiskCache = { ...mr }; A.usMacroCache = { dji: { close: 1 } }; A._marketSnapshot = A.usMacroCache; A.fiShortQty = null;
      await A.renderMarketBriefing(); out.push(A._preOpenCalc ? A._preOpenCalc.s : null); }
    return out;
  }, fx);
  const proS = await pp.evaluate(F => F.map(mr => { const r = PRO._premktScore(mr); return r && !r.na ? r.s : null; }), fx);
  // ⑩ V79.9.9 漲跌太小的門檻兩邊一樣(App `_PREMKT_DEAD` == pro `_premktScore` 裡的 DEAD),而且 300 組裡真的有落在 ±0.4 內的(⛔ 沒有就測不到)
  const deadIdx = await page.evaluate(() => app._PREMKT_DEAD);
  const deadPro = +((proHtml.match(/const DEAD = ([0-9.]+), dz = /) || [])[1]);
  const deadNote = await pp.evaluate(() => PRO._PREMKT && PRO._PREMKT.dead ? PRO._PREMKT.dead.th : null);   // 作戰室說明文字用的那個數字也要一樣
  const nSmall = fx.filter(m => ['dji_chg_pct', 'nasdaq_chg_pct', 'sp500_chg_pct', 'sox_chg_pct', 'tsm_chg_pct'].some(k => m[k] != null && Math.abs(m[k]) < 0.4)).length;
  ok('⑩ 漲跌太小算 0 分的門檻:App `_PREMKT_DEAD` == 產業作戰室那份 == 0.4,而且 ⑧ 的 300 組裡有 ≥30 組會碰到', deadIdx === 0.4 && deadPro === deadIdx && deadNote === deadIdx && nSmall >= 30, `App ${deadIdx} / pro ${deadPro} / pro 說明 ${deadNote} / 碰到 ${nSmall} 組`);
  // ⑨ 跨檔:散戶 App 的開盤發生率 == 產業作戰室 `_PREMKT`(同一支探針的數字,⛔ 只改一邊)
  const proP = await pp.evaluate(() => JSON.parse(JSON.stringify(PRO._PREMKT)));
  const K = R.occK || {}, pick3 = b => b && [b.up, b.flat, b.dn, b.n == null ? null : b.n].join('/');
  const occSame = ['hi', 'mid', 'lo', 'all'].every(k => pick3(K[k]) === pick3(proP[k])) && K.from === proP.from && K.days === proP.days;
  ok('⑨ 開盤發生率 `_PREMKT_OCC` == 產業作戰室 `_PREMKT`(高 / 中 / 低 / 隨便一天、起始年、天數)', occSame,
     JSON.stringify({ idx: K, pro: { hi: proP.hi, mid: proP.mid, lo: proP.lo, all: proP.all, from: proP.from, days: proP.days } }));
  const { badOf } = await import(pathToFileURL(path.join(ROOT, 'scripts/lib_retailbad.mjs')).href);
  const hiT = R.occHi.t, loT = R.occLo.t;
  const r0 = v => Math.round(v), tri = b => `開高 ${r0(b.up)}% ・開平 ${r0(b.flat)}% ・開低 ${r0(b.dn)}%`;
  ok('⑨b 高分 / 低分那天那一行的三個比例 = `_PREMKT_OCC` 那一格(隨便一天那組也是)+「不是今天會漲或會跌」;⛔ 研究字樣',
     R.occHi.p >= 65 && R.occLo.p <= 35 && K.hi && hiT.includes(tri(K.hi)) && hiT.includes(`隨便一天 ${r0(K.all.up)}% / ${r0(K.all.flat)}% / ${r0(K.all.dn)}%`) && /不是今天會漲或會跌/.test(hiT)
     && loT.includes(tri(K.lo)) && badOf(hiT + loT).length === 0, JSON.stringify({ hi: [R.occHi.p, hiT], lo: [R.occLo.p, loT], bad: badOf(hiT + loT) }));
  const both = appS.map((a, i) => [a, proS[i]]).filter(([a, b]) => b != null);
  const diff = both.filter(([a, b]) => a !== b);
  ok('⑧ 產業作戰室 `PRO._premktScore` == App(300 組隨機 macro_risk,兩邊都有分數的那幾組逐一相同)',
     both.length >= 250 && diff.length === 0, `比到 ${both.length} 組、不同 ${diff.length} 組:${JSON.stringify(diff.slice(0, 5))}`);
  await browser.close();
  return fails;
}

if (process.env.INJECT) {
  let bad = 0;
  for (const [k, [a, b]] of Object.entries(INJ)) {
    if (!SRC.includes(a)) { console.log(`❌ 注入 ${k}:找不到要改的那一行(測試過期了)`); bad++; continue; }
    process.env.QUIET = '1';
    const f = await run(SRC.replace(a, b));
    console.log(`${f.length ? '✅' : '❌'} 注入 ${k} → ${f.length ? '紅:' + f.join(' / ').slice(0, 160) : '⛔ 全綠(這個注入沒被抓到)'}`);
    if (!f.length) bad++;
  }
  for (const [k, [a, b]] of Object.entries(INJ_PRO)) {
    if (!PRO_SRC.includes(a)) { console.log(`❌ 注入 ${k}:找不到要改的那一行(測試過期了)`); bad++; continue; }
    const f = await run(SRC, PRO_SRC.replace(a, b));
    console.log(`${f.length ? '✅' : '❌'} 注入 ${k} → ${f.length ? '紅:' + f.join(' / ').slice(0, 160) : '⛔ 全綠(這個注入沒被抓到)'}`);
    if (!f.length) bad++;
  }
  console.log(bad ? `\n❌ ${bad} 種注入沒被抓到` : `\n✅ ${Object.keys(INJ).length + Object.keys(INJ_PRO).length} 種注入全部叫得出來`);
  process.exit(bad ? 1 : 0);
}
const f = await run(SRC);
console.log(f.length ? `\n❌ ${f.length} 條失敗:${f.join(' / ')}` : '\n✅ PREMKT_FORMULA_PASS(全部通過)');
process.exit(f.length ? 1 : 0);
