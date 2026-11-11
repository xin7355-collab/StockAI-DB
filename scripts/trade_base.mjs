#!/usr/bin/env node
/**
 * 🩺 V82.1.2 交易層失效預警的基準(SELF_EVOLVING_AUDIT G5)—— 👑「最近 20 / 60 筆交易」在 16 年裡算不算正常
 *
 * 做法(⛔ 第二份挑股:跑 leader_probe 的 simulate + log):看板那組設定(100 萬、起點間距 3、17 條),16 年到封存日,
 *   把每一條路徑每一筆賣出照「賣出日」排好,算每一筆的扣成本報酬(成本 = 成績單 `_STL_COST` 0.44%,同一把尺),
 *   再滾動算「連續 20 / 60 筆的平均報酬」與「勝率」→ 17 條全部放在一起取百分位 → `_EVOLVE.trades.lead`。
 * 用法(App 體檢頁 `_healthTrades`):成績單 👑 模擬帳封存日之後賣掉的交易,每 10 筆看一次最近 20 / 60 筆,
 *   連 2 次低於 2.5 百分位才標「要重驗」(事先寫死,⛔ 自動停用)。
 * ⚠️ 17 條路徑大部分交易是同一批(陷阱 #62)→ 百分位比較像「這套在 16 年裡的樣子」,⛔ 當成精確的機率。
 *
 * 跑法:DATA_DIR=<pack>/d16 DIV=<pack>/d16/_div16.json [END=2026-11-07] node --max-old-space-size=9000 scripts/trade_base.mjs out.json
 *       node scripts/trade_base.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { loadCtx, simulate } from './leader_probe.mjs';

export const COST = 0.44;                         // = pro.html _STL_COST(成績單同一把尺)
export const WINS = [20, 60];
export const LV = [1, 2.5, 5, 10, 25, 50, 75, 90];
const r2 = x => Math.round(x * 100) / 100;
export function pctl(a, p) { const b = [...a].sort((x, y) => x - y); if (!b.length) return null; const k = (b.length - 1) * p / 100, lo = Math.floor(k), hi = Math.ceil(k); return b[lo] + (b[hi] - b[lo]) * (k - lo); }

/** 一條路徑的 log → 依賣出日排好的扣成本報酬(%)。只收整筆賣出(⛔ 收一半那種部分賣出) */
export function netsOf(log) {
    return log.filter(x => x.side === 'S' && x.why !== 'ddtrim' && x.cost > 0 && x.px > 0).sort((a, b) => a.d.localeCompare(b.d) || a.s.localeCompare(b.s))
        .map(x => (x.px / x.cost - 1) * 100 - COST);
}
/** 滾動 w 筆 → [{m 平均, wr 勝率%}] */
export function rolling(nets, w) {
    const out = []; let s = 0, k = 0;
    for (let i = 0; i < nets.length; i++) {
        s += nets[i]; if (nets[i] > 0) k++;
        if (i >= w) { s -= nets[i - w]; if (nets[i - w] > 0) k--; }
        if (i >= w - 1) out.push({ m: s / w, wr: k / w * 100 });
    }
    return out;
}
export function base(pathsNets) {
    const out = {};
    for (const w of WINS) {
        const R = pathsNets.flatMap(n => rolling(n, w));
        out[w] = { n: R.length, m: LV.map(p => r2(pctl(R.map(x => x.m), p))), wr: LV.map(p => r2(pctl(R.map(x => x.wr), p))) };
    }
    const all = pathsNets[0] || [];
    return { lv: LV, w: out, trades: all.length, avg: r2(all.reduce((a, x) => a + x, 0) / Math.max(1, all.length)), win: r2(all.filter(x => x > 0).length / Math.max(1, all.length) * 100) };
}

function main() {
    const out = process.argv[2], DATA = process.env.DATA_DIR, DIV = process.env.DIV;
    if (!DATA) { console.error('要 DATA_DIR'); process.exit(1); }
    const ctx = loadCtx(DATA, DIV);
    if (ctx.meta.stocks < 1000) { console.error('🚨 檔數 < 1000'); process.exit(1); }
    const s0 = ctx.cal.findIndex(d => d >= '2011-01-03'), P = [];
    for (let k = 0; k < 17; k++) { const log = []; simulate(ctx, s0 + 3 * k, { capital: 1e6, log }, 1000 + k); P.push(netsOf(log)); }
    const B = { ...base(P), from: ctx.cal[s0], to: ctx.cal.at(-1), cost: COST, paths: 17, rule: { every: 10, below: 2.5, times: 2 } };
    console.log(`👑 16 年 ${B.from}~${B.to}:第一條 ${B.trades} 筆・每筆平均 ${B.avg}%・勝率 ${B.win}%`);
    for (const w of WINS) console.log(`  最近 ${w} 筆平均報酬 百分位 ${LV.join('/')}:${B.w[w].m.join(' / ')}・勝率 ${B.w[w].wr.join(' / ')}(${B.w[w].n} 個窗口)`);
    if (out) fs.writeFileSync(out, JSON.stringify(B));
}

function selftest() {
    let ok = 0, bad = 0; const t = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); c ? ok++ : bad++; };
    const log = [{ side: 'B', s: 'A', d: '2020-01-02', px: 10 }, { side: 'S', s: 'A', d: '2020-01-10', px: 11, cost: 10 }, { side: 'S', s: 'B', d: '2020-01-05', px: 9, cost: 10 }, { side: 'S', s: 'C', d: '2020-01-06', px: 20, cost: 10, why: 'ddtrim' }];
    const n = netsOf(log);
    t(n.length === 2 && Math.abs(n[0] - (-10 - COST)) < 1e-9 && Math.abs(n[1] - (10 - COST)) < 1e-9, `① 照賣出日排、扣 ${COST}%、收一半那筆不算:${n.map(r2).join(', ')}`);
    const R = rolling([1, 2, 3, 4], 2);
    t(R.length === 3 && R[0].m === 1.5 && R[2].m === 3.5 && R[0].wr === 100, `② 滾動 2 筆平均:${R.map(x => x.m).join(', ')}`);
    t(Math.abs(pctl([1, 2, 3, 4, 5], 50) - 3) < 1e-9 && Math.abs(pctl([0, 10], 2.5) - 0.25) < 1e-9, '③ 百分位內插');
    console.log(`\n${bad ? '❌' : '✅'} selftest ${ok}/${ok + bad}`);
    return bad ? 1 : 0;
}

const _isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (_isMain) { if (process.argv.includes('--selftest')) process.exit(selftest()); else main(); }
