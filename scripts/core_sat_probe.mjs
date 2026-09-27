#!/usr/bin/env node
/**
 * 🐢🛰️ 0050 核心 × 本站策略衛星 —— 固定比例 + 再平衡 的組合回測(V77.7.7)
 *
 * 起因:外部 AI 建議「0050 Core + 策略 Satellite(100/0、90/10 … 50/50;CAGR/Sharpe/Sortino/Calmar/MDD/turnover/
 *   滾動 12/24 月超額)」。本站以前只有 V74.3.2 的近似版(兩條曲線加權相加、**沒有再平衡**)與 `PARK=idle`(閒錢停 0050)。
 *   引擎補了 `EQUITY_OUT`(逐日市值淨值)之後才做得動「再平衡」。
 *
 * 口徑(⭐ 這一段最重要,兩個帳戶的尺不一樣):
 *   `portfolio_backtest` 的策略成績是「100 萬本金、每筆固定 15 萬、**單利加總**」;0050 是複利。
 *   ⛔ 不能拿元對元相加 → 統一成**日報酬流**:r_s(t) = E(t)/E(t−1)−1(E = cash + 停泊 + 持倉市值,含未實現),
 *   r_c(t) = 0050 含息序列(`lib_totalreturn.trSeries`,除息再投入 + 二代健保)差分。
 *   每條腿各自複利、依權重再平衡(月/季期初把總值 V 重切成 w_c / w_s;不再平衡 = 各自滾)。
 *   兩個假設寫在畫面:(a) 策略腿可線性縮放(流動性忽略)(b) 「策略單獨複利」跟 PB 單利數字會不同,兩個都列(bridge)。
 *   ⚠️ 策略腿本身**含閒置現金**(1 筆 15 萬 × 最多幾筆,其餘現金 0 利率)—— 這是 PB 帳戶真實的樣子;
 *      另一個變體 `PARK=idle` 的淨值(閒錢停 0050)當第二條衛星(`EQ_IDLE_GLOB`)。
 *
 * 輸入:EQ_GLOB=<glob 或逗號清單>(17 條 EQUITY_OUT)・EQ_IDLE_GLOB(可選)・DATA_DIR(要有 0050.json)・DIV(dividends_hist.json)
 * 輸出:{grid:[{leg,w,rb, med:{…}, lines:[…]}], bridge, meta};`--selftest` 用合成序列驗恆等式。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { trSeries, loadPx } from './lib_totalreturn.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEIGHTS = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0];        // w_c(0050 比重);0 = 純策略
const REBAL = ['none', 'M', 'Q'];
const TRADING_DAYS = 244;

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = a => { if (a.length < 3) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const r2 = x => x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100;

/** 對齊:0050 含息序列 → 策略淨值的日期(取 ≤ d 的最後一筆) */
export function alignTR(tr, dates) {
    const out = []; let j = 0, last = null;
    for (const d of dates) { while (j < tr.d.length && tr.d[j] <= d) { last = tr.v[j]; j++; } out.push(last); }
    return out;
}
/** 模擬一條組合:legs = {c:[值序列], s:[值序列]}(同長度、同日期),w_c 比重,rb 再平衡;回 {V:[], turnover} */
export function simulate(dates, C, Sv, wc, rb) {
    const n = dates.length; const V = new Array(n); let vc = wc, vs = 1 - wc, turn = 0;
    V[0] = 1;
    const period = d => rb === 'M' ? d.slice(0, 7) : rb === 'Q' ? `${d.slice(0, 4)}Q${Math.floor((+d.slice(5, 7) - 1) / 3)}` : null;
    for (let i = 1; i < n; i++) {
        const rc = C[i] / C[i - 1] - 1, rs = Sv[i] / Sv[i - 1] - 1;
        vc *= 1 + rc; vs *= 1 + rs;
        const v = vc + vs;
        if (rb !== 'none' && period(dates[i]) !== period(dates[i - 1])) {   // 新期間第一天:期初重切
            const tc = wc * v; turn += Math.abs(tc - vc) / v; vc = tc; vs = v - tc;
        }
        V[i] = v;
    }
    return { V, turnover: turn };
}
export function metrics(dates, V, C) {
    const n = V.length; const yrs = (n - 1) / TRADING_DAYS;
    const rets = []; for (let i = 1; i < n; i++) rets.push(V[i] / V[i - 1] - 1);
    const tot = (V[n - 1] / V[0] - 1) * 100, cagr = (Math.pow(V[n - 1] / V[0], 1 / yrs) - 1) * 100;
    const m = mean(rets), s = sd(rets), dn = sd(rets.filter(x => x < 0).length > 2 ? rets.map(x => Math.min(0, x)) : []);
    const sharpe = s > 0 ? (m / s) * Math.sqrt(252) : null, sortino = dn > 0 ? (m / dn) * Math.sqrt(252) : null;
    let peak = -Infinity, mdd = 0; for (const v of V) { if (v > peak) peak = v; mdd = Math.min(mdd, (v - peak) / peak * 100); }
    const calmar = mdd < 0 ? cagr / -mdd : null;
    const roll = k => { const xs = []; for (let i = k; i < n; i++) { const x = (V[i] / V[i - k] - C[i] / C[i - k]) * 100; xs.push(Math.abs(x) < 1e-9 ? 0 : x); } return xs.length ? { mean: r2(mean(xs)), min: r2(Math.min(...xs)), pos: r2(xs.filter(x => x > 0).length / xs.length * 100), n: xs.length } : null; };   // ⚠️ 100/0 那格 V≡C,浮點雜訊會讓「為正比例」變 75% → 先歸零
    return { tot: r2(tot), cagr: r2(cagr), sharpe: r2(sharpe), sortino: r2(sortino), mdd: r2(mdd), calmar: r2(calmar), roll12: roll(252), roll24: roll(504), yrs: r2(yrs) };
}
export function runOne(eq, tr, { leg = 'pb' } = {}) {
    const rows = eq.rows.filter(r => r && r.d);
    const dates = rows.map(r => r.d);
    const E = rows.map(r => r.cash + (r.park || 0) + r.mv);
    const C = alignTR(tr, dates);
    if (C.some(x => x == null)) throw new Error(`0050 含息序列對不到策略起點 ${dates[0]}`);
    const Sv = E.map(x => x / E[0]);
    const Cn = C.map(x => x / C[0]);
    const out = { leg, from: dates[0], to: dates[dates.length - 1], days: dates.length, grid: [] };
    for (const wc of WEIGHTS) for (const rb of REBAL) {
        if ((wc === 1 || wc === 0) && rb !== 'none') continue;          // 單腿沒有再平衡可言
        const { V, turnover } = simulate(dates, Cn, Sv, wc, rb);
        out.grid.push({ w: wc, rb, ...metrics(dates, V, Cn), turnover: r2(turnover / ((dates.length - 1) / TRADING_DAYS) * 100) });
    }
    // 橋:PB 帳戶總報酬(含閒置現金與停泊;⚠️ 同一條淨值曲線,「單利/複利」只是 PB 用固定 15 萬一筆下單的部位邏輯,⛔ 不是第二個數字)vs 0050 含息
    out.bridge = { pbPct: r2((E[E.length - 1] - E[0]) / eq.capital * 100), etf0050trPct: r2((Cn[Cn.length - 1] - 1) * 100), capital: eq.capital, lot: eq.lot, note: '策略腿 = PB 帳戶逐日市值(1 筆 15 萬・含閒置現金);線性縮放假設' };
    return out;
}
export function aggregate(runs) {
    // 同一格(w,rb)在 17 條起點上取中位 / 最差 / 配對贏 0050 幾條
    const keys = runs[0].grid.map(g => `${g.w}|${g.rb}`);
    const grid = keys.map((k, gi) => {
        const cells = runs.map(r => r.grid[gi]);
        const c0 = runs.map(r => r.grid.find(g => g.w === 1));                 // 100% 0050 同一條起點
        const pick = f => cells.map(f).filter(x => x != null);
        const beat = cells.filter((c, i) => c.tot > c0[i].tot).length;
        const ddBetter = cells.filter((c, i) => c.mdd > c0[i].mdd).length;
        return { w: cells[0].w, rb: cells[0].rb, n: cells.length, beat0050: beat, ddBetter0050: ddBetter,
                 med: { tot: r2(median(pick(c => c.tot))), cagr: r2(median(pick(c => c.cagr))), sharpe: r2(median(pick(c => c.sharpe))), sortino: r2(median(pick(c => c.sortino))), mdd: r2(median(pick(c => c.mdd))), calmar: r2(median(pick(c => c.calmar))), turnover: r2(median(pick(c => c.turnover))), roll12: r2(median(pick(c => c.roll12?.mean))), roll12pos: r2(median(pick(c => c.roll12?.pos))), roll24: r2(median(pick(c => c.roll24?.mean))), roll24pos: r2(median(pick(c => c.roll24?.pos))) },
                 worst: { tot: r2(Math.min(...pick(c => c.tot))), mdd: r2(Math.min(...pick(c => c.mdd))) } };
    });
    return grid;
}

function expand(spec) { if (!spec) return []; const out = []; for (const s of spec.split(',')) { if (s.includes('*')) { const dir = path.dirname(s), re = new RegExp('^' + path.basename(s).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'); for (const f of fs.readdirSync(dir)) if (re.test(f)) out.push(path.join(dir, f)); } else out.push(s); } return out.sort(); }

function selftest() {
    const fails = []; const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 200)}`); if (!c) fails.push(n); };
    // 合成:0050 每天 +0.05%、策略每天 +0.1%(常數報酬 → CAGR 解析解)
    const dates = []; let d = new Date('2022-01-03T00:00:00Z'); while (dates.length < 2 * TRADING_DAYS + 1) { if (d.getUTCDay() >= 1 && d.getUTCDay() <= 5) dates.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 86400000); }
    const C = dates.map((_, i) => Math.pow(1.0005, i)), S = dates.map((_, i) => Math.pow(1.001, i));
    const a = simulate(dates, C, S, 1, 'none'), b = simulate(dates, C, S, 0, 'none');
    ok('① 100/0 = 0050 曲線逐點相等', a.V.every((v, i) => Math.abs(v - C[i]) < 1e-9));
    ok('② 0/100 = 策略複利曲線逐點相等', b.V.every((v, i) => Math.abs(v - S[i]) < 1e-9));
    const m = metrics(dates, C, C);
    ok('③ 常數日報酬 → CAGR 解析解(1.0005^244−1)', Math.abs(m.cagr - (Math.pow(1.0005, TRADING_DAYS) - 1) * 100) < 0.05 && m.mdd === 0 && m.roll12.mean === 0, JSON.stringify(m));
    const same1 = simulate(dates, C, C, 0.7, 'none'), same2 = simulate(dates, C, C, 0.7, 'M'), same3 = simulate(dates, C, C, 0.7, 'Q');
    ok('④ 兩腿同報酬 → 月/季/無 三種再平衡逐點相同、turnover 0', same1.V.every((v, i) => Math.abs(v - same2.V[i]) < 1e-9 && Math.abs(v - same3.V[i]) < 1e-9) && same2.turnover < 1e-9 && same3.turnover < 1e-9, `${same2.turnover} ${same3.turnover}`);
    // ⑤ 再平衡真的有動:兩腿報酬不同時 M 的 turnover > 0,且 70/30 無再平衡的終值 = 0.7·C + 0.3·S
    const mixN = simulate(dates, C, S, 0.7, 'none'), mixM = simulate(dates, C, S, 0.7, 'M');
    const n = dates.length - 1;
    ok('⑤ 無再平衡終值 = 0.7·C + 0.3·S;月再平衡 turnover > 0 且終值不同', Math.abs(mixN.V[n] - (0.7 * C[n] + 0.3 * S[n])) < 1e-9 && mixM.turnover > 0 && Math.abs(mixM.V[n] - mixN.V[n]) > 1e-6, `${mixN.V[n]} vs ${0.7 * C[n] + 0.3 * S[n]} ・turn ${mixM.turnover}`);
    // ⑥ runOne 端到端:合成 eq(rows)+ tr
    const eq = { capital: 1000000, lot: 150000, rows: dates.map((dd, i) => ({ d: dd, cash: Math.round(700000 * S[i]), park: 0, mv: Math.round(300000 * S[i]), cost: 300000, n: 2 })) };
    const tr = { d: dates, v: C };
    const R = runOne(eq, tr);
    const g0 = R.grid.find(g => g.w === 1), g1 = R.grid.find(g => g.w === 0);
    ok('⑥ runOne:100/0 = 0050 含息總報酬、0/100 = PB 帳戶總報酬(同一條曲線,⛔ 不可出現第二個數字)', Math.abs(g0.tot - R.bridge.etf0050trPct) < 0.01 && Math.abs(g1.tot - R.bridge.pbPct) < 0.01 && !('stratCompoundPct' in R.bridge), JSON.stringify(R.bridge));
    const agg = aggregate([R, R]);
    ok('⑦ aggregate:格數 = 5 個混合 × 3 + 2 個單腿、配對計數 ≤ n', agg.length === 5 * 3 + 2 && agg.every(g => g.beat0050 <= g.n), agg.length);
    console.log(`\n${fails.length ? '❌ ' + fails.length + ' 條沒過' : '✅ selftest 全部通過'}`);
    process.exit(fails.length ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    if (process.argv.includes('--selftest')) selftest();
    else {
        const out = process.argv[2] || 'core_sat.json';
        const DATA = process.env.DATA_DIR, DIV = process.env.DIV;
        const files = expand(process.env.EQ_GLOB), filesIdle = expand(process.env.EQ_IDLE_GLOB);
        if (!files.length) { console.error('❌ 要 EQ_GLOB=<EQUITY_OUT 檔清單>(portfolio_backtest EQUITY_OUT=…)'); process.exit(1); }
        if (!DATA || !fs.existsSync(path.join(DATA, '0050.json'))) { console.error('❌ 要 DATA_DIR(有 0050.json)'); process.exit(1); }
        const b50 = loadPx(DATA, '0050');
        let divs = []; if (DIV && fs.existsSync(DIV)) { const raw = JSON.parse(fs.readFileSync(DIV, 'utf8')); const DV = raw.d || raw; divs = (DV['0050'] || {}).h || []; }
        else console.log('⚠️ 沒給 DIV → 0050 不含息(結果會低估 0050)');
        const tr = trSeries(b50, divs, { capital: 1000000, nhi: true });
        const legs = { pb: files, idle: filesIdle };
        const result = { meta: { generated: new Date().toISOString().slice(0, 16), n0050: b50.length, divs: divs.length, nhi: true, note: '策略腿 = portfolio_backtest 帳戶(含閒置現金)的逐日市值淨值;兩腿各自複利、依權重再平衡;⚠️ 假設策略腿可線性縮放' }, legs: {} };
        for (const [leg, fl] of Object.entries(legs)) {
            if (!fl.length) continue;
            const runs = fl.map(f => runOne(JSON.parse(fs.readFileSync(f, 'utf8')), tr, { leg }));
            const grid = aggregate(runs);
            result.legs[leg] = { n: runs.length, grid, bridge: { pb: r2(median(runs.map(r => r.bridge.pbPct))), etf0050tr: r2(median(runs.map(r => r.bridge.etf0050trPct))) }, lines: runs.map(r => ({ from: r.from, to: r.to, bridge: r.bridge })) };
            console.log(`\n🛰️ 衛星 = ${leg}(${runs.length} 條起點,${runs[0].from}~${runs[0].to} …)・PB 帳戶總報酬 ${result.legs[leg].bridge.pb}% / 0050 含息 ${result.legs[leg].bridge.etf0050tr}%`);
            console.log('  w0050 rb    總報酬%   CAGR%  Sharpe Sortino  MDD%   Calmar 週轉%/年  滾12超額 (為正%)  滾24超額 (為正%)  贏0050  回撤較小');
            for (const g of grid) console.log(`  ${String(Math.round(g.w * 100)).padStart(4)}  ${g.rb.padEnd(4)} ${String(g.med.tot).padStart(8)} ${String(g.med.cagr).padStart(7)} ${String(g.med.sharpe).padStart(7)} ${String(g.med.sortino).padStart(7)} ${String(g.med.mdd).padStart(7)} ${String(g.med.calmar).padStart(7)} ${String(g.med.turnover).padStart(8)}  ${String(g.med.roll12).padStart(8)} (${String(g.med.roll12pos).padStart(5)})  ${String(g.med.roll24).padStart(8)} (${String(g.med.roll24pos).padStart(5)})  ${g.beat0050}/${g.n}   ${g.ddBetter0050}/${g.n}`);
        }
        fs.writeFileSync(out, JSON.stringify(result, null, 1));
        console.log(`\n→ ${out}`);
    }
}
