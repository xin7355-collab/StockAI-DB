#!/usr/bin/env node
/**
 * 🧊 V82.7.0 每天早上凍結「App 盤前頁當下說了什麼」(scripts/forecast_freeze.mjs)
 *   ① ⭐ 伺服器(Node)算的 == 瀏覽器真的跑 App(renderMarketBriefing + _renderReboundRadar)的結果,36 種情境
 *      (美股盤中、ADR 太舊、夜盤有 / 沒有、黑天鵝、成交值退全市場、檔案缺 …):分數 / sPct / 開盤那一句 / 雷達過幾條 / 門檻 / 哪一級 / 每一條
 *   ② 派發日:背景那支還沒跑完(_distDayCount 空)但加權日 K 已載好 → 當場算(⛔ 掛 ⏳)
 *   ③ 只認「這一輪真的寫了今天早上那一筆」的標記(premkt_w + premkt_recent 同一個 d / at);沒有 → 不寫檔、exit 0
 *   ④ 抓不到檔:那一段照 App 的處置(雷達那條 x)、⛔ 丟例外;抓檔失敗回原因、⛔ 丟例外
 *   ⑤ 公式指紋:改到算分的程式就變、只改畫面文字(發生率那段 html)⛔ 變
 *   ⑥ 讀到沒抽出來的 this.xxx → 直接丟錯(⛔ 靜默變 undefined 算出另一個數字)
 *   INJECT=1:只改 Node 那邊的門檻 / 拿掉同步派發日 / 不看標記 / 抓檔失敗就丟例外 —— 四種都要紅
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INJ = process.env._FF_INJ || '';
const SRC0 = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const FF0 = fs.readFileSync(path.join(ROOT, 'scripts/forecast_freeze.mjs'), 'utf8');
const INJECTS = {
    nodeVix: ['vix != null && vix < 25 && (sp == null || sp > -0.5)', 'vix != null && vix < 20 && (sp == null || sp > -0.5)'],   // 只改 Node 那份
    noSyncDist: ["if (dist == null) { try { dist = N(this._calcDistributionDays(", "if (false) { try { dist = N(this._calcDistributionDays("],
    ignoreMark: ['    if (!mk) { console.log(', '    if (false) { console.log('],
    fetchThrow: ["        } catch (e) { why.push(e && e.name === 'TimeoutError'", "        } catch (e) { throw e; why.push(e && e.name === 'TimeoutError'"],
};
const inj = (s, k) => { const [a, b] = INJECTS[k]; if (!s.includes(a)) { console.log(`❌ 注入點找不到:${k}`); process.exit(1); } return s.replace(a, b); };
const SRC_BROWSER = INJ === 'noSyncDist' ? inj(SRC0, 'noSyncDist') : SRC0;
const SRC_NODE = INJ === 'nodeVix' ? inj(SRC0, 'nodeVix') : INJ === 'noSyncDist' ? inj(SRC0, 'noSyncDist') : SRC0;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ffz-'));
fs.mkdirSync(path.join(TMP, 'scripts'));
fs.copyFileSync(path.join(ROOT, 'scripts/lib_appextract.mjs'), path.join(TMP, 'scripts/lib_appextract.mjs'));
fs.writeFileSync(path.join(TMP, 'scripts/forecast_freeze.mjs'), INJ === 'ignoreMark' ? inj(FF0, 'ignoreMark') : INJ === 'fetchThrow' ? inj(FF0, 'fetchThrow') : FF0);
fs.writeFileSync(path.join(TMP, 'index.html'), SRC_NODE);
const FF = await import(pathToFileURL(path.join(TMP, 'scripts/forecast_freeze.mjs')).href);
const { buildApp, srcHash } = await import(pathToFileURL(path.join(TMP, 'scripts/lib_appextract.mjs')).href);

let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 400)}`); if (!c) fails++; };

// ── 情境產生器(固定種子)──
let seed = 20261126; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = a => a[Math.floor(rnd() * a.length)], maybe = (v, p = 0.85) => (rnd() < p ? v : null), r2 = v => Math.round(v * 100) / 100;
const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
function mkState(i) {
    const day = d => new Date(Date.UTC(2026, 3, 1) + d * 864e5).toISOString().slice(0, 10);
    let c = 30000 + rnd() * 15000; const hist = [], kl = [], rh = [], bh = [];
    for (let k = 0; k < 160; k++) {
        c *= 1 + (rnd() - 0.5) * 0.04; const dd = day(k);
        hist.push({ date: dd, close: r2(c), volume: 0 });
        kl.push({ date: dd.replace(/-/g, '/'), open: r2(c), high: r2(c * 1.01), low: r2(c * 0.99), close: r2(c), volume: 0, amount: i % 9 === 3 ? 0 : Math.round((5000 + rnd() * 9000) * 1e8) });
        rh.push({ date: dd, fi_futures_net: Math.round(-80000 + rnd() * 30000), margin_100m: Math.round(3000 + rnd() * 3000), fi_spot_net: Math.round((rnd() - 0.5) * 600) });
        bh.push({ d: dd, amt: Math.round(6000 + rnd() * 8000) });
    }
    const usd = pick(['2026-11-24', '2026-11-25']);
    const mr = {
        updated: `${today} 08:30 +0800`, vix: i % 11 === 5 ? null : maybe(r2(12 + rnd() * 30)), sp500_chg_pct: maybe(r2((rnd() - 0.6) * 6)), nasdaq_chg_pct: maybe(r2((rnd() - 0.6) * 6)),
        dji_chg_pct: maybe(r2((rnd() - 0.6) * 5)), sox_chg_pct: maybe(r2((rnd() - 0.6) * 8)), tsm_chg_pct: maybe(r2((rnd() - 0.6) * 8)), asx_chg_pct: maybe(r2((rnd() - 0.5) * 6)), umc_chg_pct: maybe(r2((rnd() - 0.5) * 6)),
        sp500_date: usd, nasdaq_date: usd, tsm_date: pick([usd, '2026-11-19']), asx_date: usd, umc_date: usd,
        usdtwd: r2(29 + rnd() * 4), usdtwd_chg_pct: maybe(r2((rnd() - 0.5))), usdtwd_chg_5d: maybe(r2((rnd() - 0.5) * 2)), krw_chg_5d: maybe(r2((rnd() - 0.5) * 3)), cny_chg_5d: maybe(r2((rnd() - 0.5) * 1.5)),
        kospi_chg_pct: maybe(r2((rnd() - 0.55) * 8)), nikkei_chg_pct: maybe(r2((rnd() - 0.55) * 8)), hsi_chg_pct: maybe(r2((rnd() - 0.5) * 4)), wti_chg_pct: maybe(r2((rnd() - 0.5) * 8)), jpy_chg_3d: maybe(r2((rnd() - 0.5) * 6)),
        fear_greed: maybe(Math.round(rnd() * 100)), fi_futures_net: i % 11 === 5 ? null : maybe(Math.round(-90000 + rnd() * 40000), 0.95), tw_vix: rnd() < 0.3 ? r2(15 + rnd() * 25) : null,
        taifex_backwardation: maybe(Math.round(-450 + rnd() * 550)), taiex_date: '2026-11-25', fi_three_date: '20261125', fi_spot_date: '20261125',
        nq_fut_chg_pct: maybe(r2((rnd() - 0.5) * 2)), ust10y_chg_pct: maybe(r2((rnd() - 0.5) * 2)), fi_spot_net: maybe(Math.round((rnd() - 0.5) * 800)), fi_total_net: maybe(Math.round((rnd() - 0.5) * 1000)),
        taifex_tx_now: rnd() < 0.55 ? { sess: 'night', chg: r2((rnd() - 0.5) * 4), date: today, time: pick(['05:00', '05:05', '04:30']) } : null,
    };
    if (i % 7 === 2) { mr.sp500_intraday = `${today} 01:30`; mr.tsm_intraday = '01:20'; }
    if (i % 13 === 4) mr.vix_intraday = '01:10';
    if (i % 5 === 1) { mr.vix = 34; mr.sp500_chg_pct = -3.4; }   // 黑天鵝
    for (const k of Object.keys(mr)) if (mr[k] === undefined || mr[k] === null && rnd() < 0.3) delete mr[k];
    const usm = {
        dji: { chg_pct: r2((rnd() - 0.5) * 3), date: usd }, sp500: { chg_pct: mr.sp500_chg_pct ?? 0.3, date: usd }, nasdaq: { chg_pct: r2((rnd() - 0.5) * 3), date: usd },
        sox: { chg_pct: r2((rnd() - 0.5) * 4), date: usd }, tsm: { chg_pct: r2((rnd() - 0.5) * 4), date: usd }, asx: { chg_pct: 1, date: usd }, umc: { chg_pct: -1, date: usd },
        twii: { close: 40100, chg_pct: 0.5 }, twoii: { close: 300.5, chg_pct: -0.3 }, twii_history: i % 10 === 7 ? [] : hist.slice(i % 6 === 0 ? -45 : -120),
    };
    return {
        mr, usm, rh: i % 8 === 6 ? null : rh.slice(-90), bub: i % 4 === 3 ? null : { margin_leverage: { total_100m: 3200 + Math.round(rnd() * 3000) } },
        twii: i % 9 === 8 ? null : kl, breadth: { history: bh },
    };
}
const N_STATES = 36;
const states = Array.from({ length: N_STATES }, (_, i) => mkState(i));
// ② 專門一組:派發日背景那支還沒算(_distDayCount 空)、日 K 已載好
const distState = mkState(100);

// ── 瀏覽器真的跑 App ──
let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(exe) ? { executablePath: exe } : {}), args: ['--no-sandbox', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
const htmlB = path.join(TMP, 'browser.html'); fs.writeFileSync(htmlB, SRC_BROWSER);
await page.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
await page.goto(pathToFileURL(htmlB).href, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._renderReboundRadar && !!app._premktX, null, { timeout: 60000 });
await page.waitForTimeout(2000);
const runB = async sts => page.evaluate(async sts => {
    const res = [];
    for (const st of sts) {
        const A = app;
        A._macroRiskCache = JSON.parse(JSON.stringify(st.mr)); A.usMacroCache = JSON.parse(JSON.stringify(st.usm)); A._marketSnapshot = A.usMacroCache;
        A._riskHistCache = st.rh; A._bubbleCache = st.bub; A._distDayCount = null; A._futuresCache = null;
        A._twiiKlineCache = st.twii ? { rows: st.twii, at: Date.now() } : null; A._breadthHist = st.breadth ? st.breadth.history : null;
        A._reboundVerdict = null; A._preOpenCalc = null;
        let v = null, pre = null, call = null, err = '';
        try { A._renderReboundRadar(); v = A._reboundVerdict ? { ...A._reboundVerdict } : null; } catch (e) { err += 'R:' + e.message; }
        try { await A.renderMarketBriefing(); pre = A._preOpenCalc ? { s: A._preOpenCalc.s, sPct: A._preOpenCalc.sPct, raw: A._preOpenCalc.raw } : null;
              const t = (document.getElementById('marketBriefing') || {}).innerText || ''; call = (t.match(/開高偏多|開低偏空|中性震盪/) || [null])[0]; } catch (e) { err += 'B:' + e.message; }
        res.push({ v, pre, call, err });
    }
    return res;
}, sts);
const B = await runB(states);
const [Bdist] = await runB([distState]);
await browser.close();

// ① Node vs 瀏覽器
const r1 = v => (v == null ? null : Math.round(+v * 100) / 100);
let diff = [], nSwan = 0, nFormed = 0, nNa = 0, nCalls = new Set();
states.forEach((st, i) => {
    const F = FF.freeze({ src: SRC_NODE, ...st, app: 'T' });
    const b = B[i];
    if (b.err) { diff.push(`#${i} 瀏覽器出錯 ${b.err}`); return; }
    const sameOut = b.pre && r1(F.out.s) === r1(b.pre.s) && F.out.sPct === b.pre.sPct && r1(F.out.raw) === r1(b.pre.raw) && F.out.call === b.call;
    let sameRadar;
    if (!b.v) sameRadar = !!F.radar.na;
    else sameRadar = !F.radar.na && F.radar.passN === b.v.passN && F.radar.judged === b.v.total && F.radar.need === b.v.need && F.radar.lvl === b.v.lvl && F.radar.lit === b.v.lit;
    if (!sameOut) diff.push(`#${i} 開盤 Node ${JSON.stringify([F.out.s, F.out.sPct, F.out.call])} vs App ${JSON.stringify([b.pre && b.pre.s, b.pre && b.pre.sPct, b.call])}`);
    if (!sameRadar) diff.push(`#${i} 雷達 Node ${JSON.stringify(F.radar.na || [F.radar.passN, F.radar.judged, F.radar.need, F.radar.lvl, F.radar.lit])} vs App ${JSON.stringify(b.v && [b.v.passN, b.v.total, b.v.need, b.v.lvl, b.v.lit])}`);
    if (F.radar.lvl === 'swan') nSwan++; if (F.radar.lvl === 'formed') nFormed++; if (F.radar.na) nNa++; nCalls.add(F.out.call);
});
ok(`① ⭐ ${N_STATES} 種情境:伺服器算的 == 瀏覽器真的跑 App(分數 / 開盤那一句 / 雷達過幾條・門檻・哪一級・每一條)`, diff.length === 0, diff.slice(0, 3).join(' | '));
ok('①b 🚧 空過守門:情境有涵蓋 黑天鵝 / 卡片藏起來 / 三種開盤說法', nSwan > 0 && nNa > 0 && nCalls.size === 3, JSON.stringify({ nSwan, nFormed, nNa, calls: [...nCalls] }));
// ①c 條件名字(產業作戰室健康檢查照名字對):跟 lit 一樣長、順序 = App 卡片上的條件順序
const Fn = states.map(st => FF.freeze({ src: SRC_NODE, ...st, app: 'T' }).radar).find(r => !r.na);
const nmL = Fn && typeof Fn.nm === 'string' ? Fn.nm.split('|') : [];
ok('①c 雷達存條件名字:跟 lit 一樣長、第 1 條美股止穩・第 4 條外資期貨回補・最後一條融資斷頭宣洩', nmL.length === Fn.lit.length && nmL.length === Fn.judged + (Fn.lit.match(/x/g) || []).length
   && nmL[0] === '美股止穩' && nmL[3] === '外資期貨回補' && nmL[nmL.length - 1] === '融資斷頭宣洩' && JSON.stringify(Fn).length < 1200, JSON.stringify([nmL, Fn && Fn.lit, JSON.stringify(Fn).length]));

// ② 派發日當場算
const Fd = FF.freeze({ src: SRC_NODE, ...distState });
ok('② 派發日背景那支還沒跑完、日 K 已載好 → 當場算(雷達第 10 條不是 x;App 同一格也不是 ⏳)', Fd.radar.lit && Fd.radar.lit[9] !== 'x' && Bdist.v && Bdist.v.lit[9] !== 'x', `${Fd.radar.lit} / ${Bdist.v && Bdist.v.lit}`);

// ③ 標記
const mk = (w, rec) => ({ premkt_w: w, premkt_recent: rec });
ok('③ markOf:標記跟 premkt_recent 同一個 d / at 才算', JSON.stringify(FF.markOf(mk({ d: today, at: '08:20' }, [{ d: today, at: '08:20', x: {} }]))) === JSON.stringify({ d: today, at: '08:20' })
    && FF.markOf(mk({ d: today, at: '08:10' }, [{ d: today, at: '08:20', x: {} }])) === null && FF.markOf({ premkt_recent: [{ d: today, at: '08:20', x: {} }] }) === null);
{
    const mrp = path.join(TMP, 'mr.json'), outp = path.join(TMP, 'out.json');
    fs.writeFileSync(mrp, JSON.stringify({ ...states[0].mr, premkt_recent: [{ d: today, at: '08:20', x: {} }] }));
    const r = spawnSync(process.execPath, [path.join(TMP, 'scripts/forecast_freeze.mjs'), mrp, outp], { encoding: 'utf8', timeout: 60000 });
    ok('③b 這一輪沒寫今天那一筆(沒有 premkt_w)→ 不寫檔、exit 0、⛔ 打網路', r.status === 0 && !fs.existsSync(outp) && /不凍結/.test(r.stdout), `${r.status} ${r.stdout.slice(0, 120)} ${fs.existsSync(outp)}`);
}

// ④ 缺檔
let F4 = null, e4 = '';
try { F4 = FF.freeze({ src: SRC_NODE, mr: states[1].mr, usm: null, rh: null, bub: null, twii: null, breadth: null }); } catch (e) { e4 = e.message; }
ok('④ 其他檔全部抓不到 → 照樣算、雷達那幾條是 x(⛔ 丟例外)', F4 && !e4 && (F4.radar.na || /x/.test(F4.radar.lit)) && typeof F4.out.s === 'number', e4 || JSON.stringify(F4 && F4.radar));
let f4 = null, fe4 = '';
try { f4 = await FF.fetchPub('data/risk_history.json', async () => { throw new Error('連不上'); }); } catch (e) { fe4 = e.message; }
ok('④b 抓檔失敗 → 回 null + 原因(網站、data 分支都試過),⛔ 丟例外', !fe4 && f4 && f4.j === null && /連不上 \/ 連不上/.test(f4.why), fe4 || JSON.stringify(f4));
// ④c macro_cache.json(只在網站根目錄)網站抓不到 → 退 gh-pages 分支 raw(⛔ 整格變沒有)
const seen4 = [];
const g4 = await FF.fetchPub('macro_cache.json', async u => { seen4.push(u); if (u.includes('github.io')) throw new Error('連不上'); return { ok: true, json: async () => ({ sp500: { chg_pct: 1 } }) }; });
ok('④c macro_cache.json 網站抓不到 → 退 gh-pages 分支 raw 拿到', g4.j && g4.src === 'gh-pages 分支' && seen4.length === 2 && /raw\.githubusercontent\.com\/xin7355-collab\/StockAI-DB\/gh-pages\/macro_cache\.json/.test(seen4[1]), JSON.stringify([g4.src, seen4]));

// ⑤ 公式指紋
const vA = srcHash(SRC0, FF.VER_PRE);
const vB = srcHash(SRC0.replace("_add('🏭 台積電 ADR', _sd(tsmChg, x.tsm) * 2,", "_add('🏭 台積電 ADR', _sd(tsmChg, x.tsm) * 3,"), FF.VER_PRE);
const vC = srcHash(SRC0.replace('🎲 開盤發生率(', '🎲 開盤的發生率('), FF.VER_PRE);
ok('⑤ 公式指紋:改到算分的程式就變、只改畫面文字 ⛔ 變', vA !== vB && vA === vC && /^[0-9a-f]{8}$/.test(vA), `${vA} ${vB} ${vC}`);

// ⑥ 讀到沒抽出來的成員要叫
let e6 = '';
try { const A6 = buildApp(SRC0, FF.NEED.filter(n => n !== '_intraAt'), { _macroRiskCache: {}, usMacroCache: {}, _marketSnapshot: {}, _riskHistCache: null, _futuresCache: null }); A6._premktX({ sp500_chg_pct: 1, sp500_intraday: '01:00' }, {}); } catch (e) { e6 = e.message; }
ok('⑥ 讀到沒抽出來的 this._intraAt → 直接丟錯(⛔ 靜默變 undefined)', /_intraAt/.test(e6), e6 || '沒丟錯');

fs.rmSync(TMP, { recursive: true, force: true });

// 🧪 INJECT=1:四種壞寫法各跑一次子行程,每一種都要有 ❌
if (process.env.INJECT && !INJ) {
    let allRed = true;
    for (const k of Object.keys(INJECTS)) {
        const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, INJECT: '', _FF_INJ: k }, encoding: 'utf8', timeout: 400000 });
        const reds = (r.stdout || '').split('\n').filter(l => l.startsWith('❌'));
        const hit = r.status !== 0 && reds.length > 0;
        console.log(`${hit ? '✅' : '❌'} 注入 ${k} → ${reds[0] ? reds[0].slice(0, 90) : '沒叫出來'}`);
        allRed = allRed && hit;
    }
    ok('🧪 四種注入全部叫得出來', allRed);
}
console.log(fails ? `\n❌ ${fails} 條沒過` : '\n✅ FORECAST_FREEZE_PASS');
process.exit(fails ? 1 : 0);
