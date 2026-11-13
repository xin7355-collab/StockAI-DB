#!/usr/bin/env node
/**
 * 🧭 V82.1.2 把自我進化工程的量測結果嵌進 pro.html `_EVOLVE`(App 體檢頁 E / F / G 那幾段讀它;⛔ 手改)
 *   --perf <leader_probe 輸出> --perf-to YYYY-MM-DD   📐 風險調整後(SETS 要有「現行」「錢放現金」,兩段窗口)
 *   --wf <lead_wf_probe analyze 輸出>                🧭 樣本內膨脹率
 *   --wf-hot <hot_wf_probe analyze 輸出> [--wf-hot-meta <json>]   🧭 🅿️ 的樣本內膨脹率(V82.2.7;0050 那塊來自 analyze 第 3 個參數;meta = run / 釘住的資料)
 *   --trades <trade_base 輸出>                       🩺 交易層基準
 *   --pack <MANIFEST.json>                           📦 用哪一份研究資料包算的
 * 只更新有給的那幾塊,其他照舊。讀回來逐字比對,不一樣 exit 1。
 * 跑法:node scripts/embed_evolve.mjs [--perf f --perf-to d] [--wf f] [--trades f] [--pack f]    node scripts/embed_evolve.mjs --selftest
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PRO = path.join(ROOT, 'pro.html');
const r2 = x => (x == null || !Number.isFinite(+x)) ? null : Math.round(+x * 100) / 100;
const LINE_RE = /^  _EVOLVE: (\{.*\}),$/m;

export function readEvolve(src) { const m = src.match(LINE_RE); return m ? JSON.parse(m[1]) : null; }

export function fromPerf(J, to) {
    const W = { '2022-09-16': 'ai', '2011-01-03': 'long' }, rows = {}, b = {};
    for (const R of J.sets || []) {
        const w = W[R.from]; if (!w || !R.perf) continue;
        const k = R.name === '現行' ? 'lead' : R.name === '錢放現金' ? 'leadcash' : null; if (!k) continue;
        rows[k] = rows[k] || {};
        rows[k][w] = { sharpe: r2(R.perf.sharpe), sortino: r2(R.perf.sortino), calmar: r2(R.perf.calmar), roll24: r2(R.perf.roll24), vol: r2(R.perf.vol), cagr: r2(R.cagr), mdd: r2(R.mdd) };
        b[w] = { sharpe: r2(R.perf.b.sharpe), sortino: r2(R.perf.b.sortino), calmar: r2(R.perf.b.calmar) };
    }
    if (!rows.lead || !rows.lead.ai || !rows.lead.long) throw new Error('perf 檔要有「現行」兩段窗口(2022-09-16 / 2011-01-03)');
    return { to, rows, b0050: b };
}
export function fromWf(A) {
    const p = x => ({ cagr: r2(x.cagr), w: r2(x.w), gap: r2(x.cagrGap), inflate: r2(x.inflate), beatY: x.beatY, hitCur: x.hitCur });
    return { test: A.meta.test, n: A.meta.n, configs: A.meta.configs, from: A.meta.from, to: A.meta.to, cur: { k: A.cur.k, cagr: r2(A.cur.cagr), w: r2(A.cur.w), rank: A.cur.rank },
        best: { k: A.best.k, cagr: r2(A.best.cagr) }, median: { cagr: r2(A.median.cagr) }, b0050: { cagr: r2(A.b0050.cagr), w: r2(A.b0050.w) }, beat0050: A.beat0050, exp: p(A.exp), roll3: p(A.roll3) };
}
/** 🧭 V82.2.7 🅿️(🔥 名單 + 閒錢停 0050)walk-forward:hot_wf_probe analyze 的輸出(含 b0050 跟 0050 含息比那一塊)+ meta(run、釘住的資料版本) */
export function fromWfHot(A, M = {}) {
    if (!A || !A.meta || !A.cur || !A.exp || !A.roll3) throw new Error('wf-hot 檔不是 hot_wf_probe analyze 的輸出');
    // top = 最常被挑中的那組(同次數取先出現的;頁面只顯示,不在瀏覽器裡重算)
    const top = ks => { const c = {}; ks.forEach(k => { c[k] = (c[k] || 0) + 1; }); return ks.reduce((m, k) => (c[k] > (c[m] || 0) ? k : m), ''); };
    const p = x => { const ks = (x.picks || []).map(q => q.k), t = top(ks);
        return { cagr: r2(x.cagr), w: r2(x.w), gap: r2(x.cagrGap), inflate: r2(x.inflate), hitCur: x.hitCur, picks: (x.picks || []).map(q => `${q.Y}:${q.k}`).join(' '),
            top: t, topN: ks.filter(k => k === t).length, years: ks.length }; };
    return { test: A.meta.test, n: A.meta.n, configs: A.meta.configs, cur: { k: A.cur.k, cagr: r2(A.cur.cagr), w: r2(A.cur.w), rank: A.cur.rank },
        best: { k: A.best.k, cagr: r2(A.best.cagr), w: r2(A.best.w) }, median: { k: A.median.k, w: r2(A.median.w) }, exp: p(A.exp), roll3: p(A.roll3),
        ...(A.b0050 ? { b0050: { cagr: r2(A.b0050.cagr), w: r2(A.b0050.w), n: A.b0050.n, beatY: A.b0050.beatY, beatAll: A.b0050.beatAll, pre: A.b0050.pre } } : {}),
        ...(M.run ? { run: M.run } : {}), ...(M.pin ? { pin: M.pin } : {}) };
}
export function fromTrades(B) { return { lead: { from: B.from, to: B.to, cost: B.cost, lv: B.lv, w: B.w, rule: B.rule, avg: B.avg, win: B.win, trades: B.trades } }; }
export function fromPack(M) { return { hash: M.hash, built: String(M.built || '').slice(0, 10), refs: Object.fromEntries(Object.entries(M.refs || {}).map(([k, v]) => [k, String(v).slice(0, 10)])), stocks: M.key && M.key.stocks }; }

export function writeEvolve(src, E) {
    const line = `  _EVOLVE: ${JSON.stringify(E)},`;
    if (LINE_RE.test(src)) return src.replace(LINE_RE, () => line);
    const at = src.indexOf('\n  _HEALTH_BASE: ');
    if (at < 0) throw new Error('pro.html 找不到 _HEALTH_BASE(插入點)');
    return src.slice(0, at + 1) + line + '\n' + src.slice(at + 1);
}

function selftest() {
    let ok = 0, bad = 0; const t = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); c ? ok++ : bad++; };
    const J = { sets: [['現行', '2022-09-16'], ['現行', '2011-01-03'], ['錢放現金', '2022-09-16']].map(([name, from]) => ({ name, from, cagr: 10, mdd: -20, perf: { sharpe: 1.234, sortino: 2, calmar: 0.5, roll24: 60, vol: 30, b: { sharpe: 0.9, sortino: 1.2, calmar: 0.4 } } })) };
    const P = fromPerf(J, '2026-09-24');
    t(P.rows.lead.ai.sharpe === 1.23 && P.rows.leadcash.ai && !P.rows.leadcash.long && P.b0050.long.sharpe === 0.9, '① perf 檔 → 兩段窗口、兩列、0050 對照');
    let threw = false; try { fromPerf({ sets: [] }, 'x'); } catch (_) { threw = true; }
    t(threw, '② 沒有「現行」 → 拒絕');
    const src = 'a\n  _HEALTH_BASE: {"x":1},\nb', s1 = writeEvolve(src, { perf: P }), s2 = writeEvolve(s1, { perf: P, wf: { n: 1 } });
    t(readEvolve(s1).perf.to === '2026-09-24' && s2.split('_EVOLVE').length === 2 && readEvolve(s2).wf.n === 1, '③ 第一次插在 _HEALTH_BASE 前面、第二次換掉同一行');
    // ④ 🧭 V82.2.7 wf-hot:analyze 輸出 → 照抄數字、picks 串成一行、analyze 的 0050 那塊 / meta 的 run 帶進來;不是 analyze 的檔 → 拒絕
    const A = { meta: { test: '2014~2026', n: 13, configs: 12 }, cur: { k: 'R85_V60', cagr: 18.961, w: 9.554, rank: 5 }, best: { k: 'R90_V50', cagr: 20.49, w: 11.28 },
        median: { k: 'R80_V60', w: 9.09 }, exp: { cagr: 18.3, w: 8.88, cagrGap: 0.66, inflate: 7.02, hitCur: 0, picks: [{ Y: '2014', k: 'R85_V50' }, { Y: '2015', k: 'R90_V50' }] },
        roll3: { cagr: 16.02, w: 6.9, cagrGap: 2.94, inflate: 27.73, hitCur: 0, picks: [] },
        b0050: { cagr: 19.414, w: 10.03, n: 13, beatY: { cur: 6, exp: 5, roll3: 5 }, beatAll: 3, pre: { from: '2011', to: '2013', cur: 1.93, b: 1.05 } } };
    const H = fromWfHot(A, { run: 'r' });
    t(H.cur.cagr === 18.96 && H.exp.gap === 0.66 && H.exp.picks === '2014:R85_V50 2015:R90_V50' && H.b0050.cagr === 19.41 && H.b0050.beatY.exp === 5 && H.b0050.pre.b === 1.05 && H.run === 'r' && H.configs === 12,
        '④ wf-hot → 照抄、picks 一行、0050 對照 / run 帶進來');
    const { b0050: _drop, ...A0 } = A;
    const H3 = fromWfHot({ ...A0, exp: { ...A0.exp, picks: [{ Y: '1', k: 'A' }, { Y: '2', k: 'B' }, { Y: '3', k: 'B' }, { Y: '4', k: 'A' }, { Y: '5', k: 'B' }] } });
    t(H3.exp.top === 'B' && H3.exp.topN === 3 && H3.exp.years === 5 && H3.roll3.top === '' && H3.roll3.topN === 0 && !('b0050' in H3), '④c 最常挑中的那組 = 次數最多(不是第一個、不是最後一個);analyze 沒跟 0050 比就不帶');
    let threw2 = false; try { fromWfHot({ meta: {} }); } catch (_) { threw2 = true; }
    t(threw2, '④b 不是 analyze 的輸出 → 拒絕');
    console.log(`\n${bad ? '❌' : '✅'} selftest ${ok}/${ok + bad}`);
    return bad ? 1 : 0;
}

const _isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (_isMain) {
    const a = process.argv.slice(2);
    if (a.includes('--selftest')) process.exit(selftest());
    const arg = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
    const rd = f => JSON.parse(fs.readFileSync(f, 'utf8'));
    let src = fs.readFileSync(PRO, 'utf8');
    const E = readEvolve(src) || {};
    if (arg('--perf')) { if (!arg('--perf-to')) { console.error('--perf 要配 --perf-to'); process.exit(1); } E.perf = fromPerf(rd(arg('--perf')), arg('--perf-to')); }
    if (arg('--wf')) E.wf = fromWf(rd(arg('--wf')));
    if (arg('--wf-hot')) E.wfHot = fromWfHot(rd(arg('--wf-hot')), arg('--wf-hot-meta') ? rd(arg('--wf-hot-meta')) : {});
    if (arg('--trades')) E.trades = fromTrades(rd(arg('--trades')));
    if (arg('--pack')) E.pack = fromPack(rd(arg('--pack')));
    E.u = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    src = writeEvolve(src, E);
    fs.writeFileSync(PRO, src);
    const back = readEvolve(fs.readFileSync(PRO, 'utf8'));
    if (JSON.stringify(back) !== JSON.stringify(E)) { console.error('🚨 讀回來不一樣'); process.exit(1); }
    console.log(`✅ _EVOLVE 已寫入:${Object.keys(E).join(' / ')}`);
}
