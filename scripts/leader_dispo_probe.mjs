#!/usr/bin/env node
/**
 * 👑🚨 V78.0.5 領頭羊 × 處置股:事件研究(描述,⛔ 不是訊號)
 *
 * 使用者:「以領頭羊策略,遇到處置股前容易有拉抬行為,快被處置前可能會被大賣,是否順著拉抬先跟、處置前賣,
 *          大跌時再重新買進,因為容易在出關的時候拉?」
 * → 把他講的三段拆開量:① 處置公告前 10 天是不是被拉抬 ② 處置期間是不是大跌 ③ 出關之後是不是再拉。
 *   母體 = 公告當天收盤時在「成交額前 100 大」的股票(領頭羊的池子),另外單列「當天在領頭羊前 10 名」的。
 *   對照 = 同一批股票(同池子)**同一天**沒被處置的平均(⛔ 不拿全市場比 —— 那會量到「池子本身」)。
 *   價格一律用除權息調整後收盤(leader_probe 的 A);超額 = 減同期 0050 含息。
 *   ⭐ 可交易的做法(處置前賣 / 出關買回 / 大跌買回)的成績在 leader_probe 的 dispNow / dispOracle / attSell / rebuy 選項。
 *
 * 零前視:分組只用公告當天收盤看得到的(成交額排名、動能排名);報酬是事後量的 = 描述。
 * 跑法:DATA_DIR=$S/d10n DIV=data/dividends_hist.json DISP_PERIODS=$S/disp_periods.json node scripts/leader_dispo_probe.mjs out.json
 *       node scripts/leader_dispo_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { loadCtx, mom } from './leader_probe.mjs';

const r2 = x => x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100;
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const tstat = a => a.length > 2 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : NaN;
const median = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };

/** i → j 的調整後報酬(%);任何一端沒價 → NaN */
export function ret(S, i, j) { if (i < 0 || j >= S.A.length) return NaN; const a = S.A[i], b = S.A[j]; return a > 0 && b > 0 ? (b / a - 1) * 100 : NaN; }
export function etfRet(tr, i, j) { const a = tr[i], b = tr[j]; return a > 0 && b > 0 ? (b / a - 1) * 100 : NaN; }

/** 一個處置事件的各段報酬(公告日 a、開始 s、結束 e,皆為日曆索引;a 可能是 x.5 = 非交易日公告)
 *  pre10 = a−10 收盤 → a 收盤(處置前的拉抬)・during = a 收盤 → e 收盤(公告後到出關)・post5/post20 = e 收盤 → e+5/e+20(出關行情)*/
export function segs(S, tr, ev) {
    const a = Math.floor(ev.a), e = ev.e;
    const seg = (i, j) => { const x = ret(S, i, j), m = etfRet(tr, i, j); return Number.isFinite(x) && Number.isFinite(m) ? x - m : NaN; };
    // dip = 公告收盤 → 出關前最低收盤(原始跌幅,⛔ 不減 0050)—— 回答「處置期間會不會大跌、跌多少才買回」
    let dip = NaN; if (a >= 0 && e < S.A.length && S.A[a] > 0) { dip = 0; for (let j = a + 1; j <= e; j++) if (S.A[j] > 0) dip = Math.min(dip, (S.A[j] / S.A[a] - 1) * 100); }
    return { pre10: seg(a - 10, a), during: seg(a, e), post5: seg(e, e + 5), post20: seg(e, e + 20), hold: seg(a, e + 20), dip };
}

function selftest() {
    let ok = 0, bad = 0; const t = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); c ? ok++ : bad++; };
    const n = 80, A = new Float64Array(n).map((_, i) => i < 30 ? 100 : i < 40 ? 100 + (i - 29) * 3 : i < 50 ? 130 - (i - 39) * 2 : 110 + (i - 49));
    const S = { A }, tr = new Float64Array(n).fill(1);
    const g = segs(S, tr, { a: 39, s: 40, e: 49 });
    t(Math.abs(g.pre10 - 30) < 1e-9 && g.during < 0 && g.post5 > 0, `① 分段:公告前 10 天漲 ${r2(g.pre10)}% ・處置期間 ${r2(g.during)}% ・出關後 5 天 ${r2(g.post5)}%`);
    const g2 = segs(S, tr, { a: 38.5, s: 39, e: 49 });
    t(Math.abs(g2.pre10 - ret(S, 28, 38)) < 1e-9, '② 非交易日公告(索引 x.5)→ 用公告前最後一個交易日收盤當 0(⛔ 不可用公告後那天 = 偷看)');
    const tr2 = new Float64Array(n).map((_, i) => 1 + i * 0.01);
    t(segs(S, tr2, { a: 39, s: 40, e: 49 }).pre10 < g.pre10, '③ 超額 = 減同期 0050(0050 同期也漲 → 超額變小)');
    t(Number.isNaN(segs(S, tr, { a: 39, s: 40, e: 75 }).post20), '④ 出關後資料不夠 20 天 → 沒有(⛔ 不補 0)');
    t(Math.abs(g.dip - (110 / 130 - 1) * 100) < 1e-9, `⑤ 處置期間最深跌幅 = 公告收盤到出關前最低收盤(${r2(g.dip)}%)`);
    console.log(`\n${bad ? '❌' : '✅'} selftest ${ok}/${ok + bad}`);
    return bad ? 1 : 0;
}

function main() {
    const out = process.argv[2], DATA = process.env.DATA_DIR;
    if (!DATA || !process.env.DISP_PERIODS) { console.error('要 DATA_DIR + DISP_PERIODS'); process.exit(1); }
    const ctx = loadCtx(DATA, process.env.DIV);
    if (!ctx.dper || ctx.meta.dper < 500) { console.error(`🚨 處置事件只有 ${ctx.meta.dper} 筆,拒跑`); process.exit(1); }
    const { cal, stocks, etf } = ctx, bySym = new Map(stocks.map(S => [S.sym, S]));
    // 每一天的池子(成交額前 100)與領頭羊名次(趨勢過濾 + 10 日動能)—— 只算事件用到的那幾天
    const poolCache = new Map();
    const poolAt = i => {
        if (poolCache.has(i)) return poolCache.get(i);
        const univ = stocks.filter(S => S.val20[i] > 0 && S.C[i] > 0 && i - S.jump[i] > 120 && S.ma60[i] > 0 && S.atr[i] > 0).sort((a, b) => b.val20[i] - a.val20[i]).slice(0, 100);
        const ranked = univ.filter(S => S.C[i] > S.ma20[i] && S.ma20[i] > S.ma60[i]).map(S => ({ S, m: mom(S, i, 10) })).filter(x => Number.isFinite(x.m)).sort((a, b) => b.m - a.m).map(x => x.S.sym);
        const r = { pool: new Set(univ.map(S => S.sym)), top10: new Set(ranked.slice(0, 10)) };
        poolCache.set(i, r); return r;
    };
    const G = { top10: [], pool: [], other: [] }, CT = { top10: [], pool: [] };
    const K = ['pre10', 'during', 'post5', 'post20', 'hold', 'dip'];
    let used = 0;
    for (const [sym, arr] of ctx.dper) {
        const S = bySym.get(sym); if (!S) continue;
        for (const ev of arr) {
            const a = Math.floor(ev.a); if (a < 260 || cal[a] < '2023-06-01') continue;
            const P = poolAt(a), grp = P.top10.has(sym) ? 'top10' : P.pool.has(sym) ? 'pool' : 'other';
            const g = segs(S, etf.tr, ev); G[grp].push({ sym, d: cal[a], len: ev.e - a, ...g }); used++;
            // 對照:同一天同池子(同組)沒被處置的其他股票,同樣長度的四段
            if (grp !== 'other') {
                const others = [...(grp === 'top10' ? P.top10 : P.pool)].filter(x => x !== sym);
                for (const o of others) { const So = bySym.get(o); const per = ctx.dper.get(o); if (per && per.some(q => Math.abs(q.a - a) <= 20)) continue; CT[grp].push(segs(So, etf.tr, { a: ev.a, s: ev.s, e: ev.e })); }
            }
        }
    }
    const summ = arr => Object.fromEntries(K.map(k => { const v = arr.map(x => x[k]).filter(Number.isFinite); return [k, { n: v.length, mean: r2(mean(v)), med: r2(median(v)), up: r2(v.filter(x => x > 0).length / Math.max(1, v.length) * 100), t: r2(tstat(v)), le10: r2(v.filter(x => x <= -10).length / Math.max(1, v.length) * 100), le15: r2(v.filter(x => x <= -15).length / Math.max(1, v.length) * 100), le20: r2(v.filter(x => x <= -20).length / Math.max(1, v.length) * 100) }]; }));
    const res = { asof: new Date().toISOString().slice(0, 10), used, groups: {}, ctrl: {} };
    const lab = { pre10: '公告前 10 天', during: '公告 → 出關', post5: '出關後 5 天', post20: '出關後 20 天', hold: '公告 → 出關後 20 天(一路抱著)', dip: '處置期間最深跌幅(原始,不減 0050)' };
    for (const grp of ['top10', 'pool', 'other']) {
        res.groups[grp] = summ(G[grp]); if (CT[grp]) res.ctrl[grp] = summ(CT[grp]);
        console.log(`\n== ${grp === 'top10' ? '👑 公告當天在領頭羊前 10 名' : grp === 'pool' ? '成交額前 100 大(其他)' : '池子外'}:${G[grp].length} 次處置`);
        for (const k of K) {
            const g = res.groups[grp][k], c = res.ctrl[grp] ? res.ctrl[grp][k] : null;
            console.log(`  ${lab[k]}:超額平均 ${g.mean}%(中位 ${g.med}%,贏 0050 ${g.up}%,t=${g.t},n=${g.n})` + (k === 'dip' ? ` ・跌 ≥10% 的比例 ${g.le10}% ・≥15% ${g.le15}% ・≥20% ${g.le20}%` : '') + (c ? ` ・對照(同一天同組沒被處置)${c.mean}%(中位 ${c.med}%,n=${c.n})→ 差 ${r2(g.mean - c.mean)}pp` : ''));
        }
    }
    if (out) fs.writeFileSync(out, JSON.stringify(res));
}

const _isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (_isMain && process.argv.includes('--selftest')) process.exit(selftest());
else if (_isMain) main();
