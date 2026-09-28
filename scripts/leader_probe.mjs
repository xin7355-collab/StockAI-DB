#!/usr/bin/env node
/**
 * 👑🚀 V77.8.5「領頭羊短線輪動」—— 自創一套「AI 時代選股 + 出場」,目標:贏 0050 含息
 *
 * 使用者:「請你自創適合 AI 選股法,還有出場,適合做短線的,我要贏 0050」。
 * 為什麼長這樣(每一條都有本站實測撐著,⛔ 不是憑感覺):
 *   - V77.8.4 逐月:現行預設 12 個月贏 0050 只有 34%,**AI 行情集中在大型權值股、它挑的高波動小型股跟不上**。
 *   - kingpool_probe:「成交額前 50」是唯一六關全過的池子(+0.98pp);外加的六層全部沒用。
 *   - 動能(追強 > 抄底):screener_edge_probe / sector_pick「板塊內最強」/ breakout_exit「砍得越早賺越少」。
 *   - 閒錢停 0050(PARK=idle)是目前最強的一個改動(434 vs 324 萬,17/17)。
 *   → 🧭 規則(驗證後的版本):每 10 個交易日收盤,在**近 20 日平均成交額前 100 大**(⛔ 不含 ETF)裡,挑**近 10 日漲最多**、
 *     而且收盤 > 20 日線 > 60 日線的前 5 檔,隔天開盤等權買;下次換倉還在前 10 名就續抱,掉出去就隔天開盤賣;
 *     ⛔ 不用停損線(吊燈 2/3 倍實測都讓它變差);沒用到的錢停 0050;大盤嚴格空頭(加權 < 60 日線且 20 日線 < 60 日線)不開新倉。
 *   ⚠️ 最初設計是「60 日動能 + 吊燈 2 倍 + 每週換 + 前 50 大」→ 實測輸 0050(17 條 0 條贏),網格之後才落到上面這組。
 *   ⛔ 刻意**不用**「AI 題材名單」:本站那份是 2026 年手選的(後見之明,layer_accel_probe 已寫明),拿它回測等於作弊。
 *     「AI 時代的領頭羊」改用**當時就看得到的**成交額排名來抓。
 *
 * 零前視:第 t 天收盤算分數 → 第 t+1 天**開盤**成交(開盤接近漲停買不到 → 不買);吊燈看收盤、收盤賣(STOPFILL=close)。
 * 成本:買 0.1425%、賣 0.1425% + 0.3%;0050 賣 0.1% 稅。除權息:持有中碰到 → 份數 × (除權息前價 ÷ 參考價)(2021 起才有股利資料)。
 * 資料斷崖:單日(已調除權息)漲跌超過當時漲跌幅限制 + 1.5% → 那一檔 120 天內⛔ 不進池子、持有中碰到就用前一天收盤出場。
 * 對照:0050 含息(同起點、同一天買)・sham = 同一個池子、同樣過濾後**隨機**挑 N 檔(固定種子)・不選股 = 池子等權。
 * 起點穩健:17 條(每 5 個交易日一條)。窗口:AI 時代(2022-09-16 起,同本站其他回測)+ 長歷史 2011~2026(⚠️ 2021 前只有上市、個股沒有股利資料 → 對策略不利)。
 * 跑法:DATA_DIR=$S/d10n DIV=…/dividends_hist.json node --max-old-space-size=8192 scripts/leader_probe.mjs out.json
 *       node scripts/leader_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { trSeries, loadPx } from './lib_totalreturn.mjs';

const COST_X = +(process.env.COST_X || 1);            // 成本壓力(×2 = 手續費與稅都加倍)
const FEE = 0.001425 * COST_X, TAX = 0.003 * COST_X, ETF_TAX = 0.001 * COST_X;
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const r2 = x => x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100;
const limitOf = d => d < '2015-06-01' ? 0.07 : 0.10;

export function rng(seed) { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

/** 一檔股票 → 對齊日曆的欄位 + 指標(全部只用 ≤ i 的資料) */
export function prepStock(sym, rows, cal, divs) {
    const n = cal.length, idx = new Map(cal.map((d, i) => [d, i]));
    const O = new Float64Array(n).fill(NaN), H = O.slice(), L = O.slice(), C = O.slice(), V = O.slice();
    for (const r of rows) { const i = idx.get(r.d); if (i === undefined) continue; O[i] = r.o; H[i] = r.h; L[i] = r.l; C[i] = r.c; V[i] = r.v; }
    const F = new Float64Array(n).fill(1);           // 除權息倍數(除權息前價 ÷ 參考價),只在除權息日 ≠ 1
    let divSkip = 0;
    for (const [dt, , , before, after] of (divs || [])) {
        const i = idx.get(String(dt).slice(0, 10)); if (i === undefined || i === 0) continue;
        let p = i - 1; while (p > 0 && !(C[p] > 0)) p--;
        const b = +before, a = +after;
        if (!(b > 0 && a > 0 && b / a > 1 && b / a < 1.6 && C[p] > 0 && Math.abs(b / C[p] - 1) < 0.03)) { divSkip++; continue; }
        F[i] *= b / a;
    }
    const ind = { val20: new Float64Array(n).fill(NaN), ma20: new Float64Array(n).fill(NaN), ma60: new Float64Array(n).fill(NaN), atr: new Float64Array(n).fill(NaN), jump: new Int32Array(n).fill(-1e9) };
    // 調整後收盤(把除權息倍數累乘回去 → 動能不會被除息日誤判成下跌)
    const A = new Float64Array(n).fill(NaN); let k = 1, lastA = NaN;
    for (let i = 0; i < n; i++) { k *= F[i]; if (C[i] > 0) { A[i] = C[i] * k; lastA = A[i]; } }
    let lastJump = -1e9, prevI = -1;
    const vals = [], cls = [], trs = [];
    let sV = 0, s20 = 0, s60 = 0, sTR = 0;
    const cl20 = [], cl60 = [];
    for (let i = 0; i < n; i++) {
        if (!(C[i] > 0)) continue;
        if (prevI >= 0) {
            const r = C[i] * F[i] / C[prevI] - 1;
            if (Math.abs(r) > limitOf(cal[i]) + 0.015) lastJump = i;
            const tr = Math.max(H[i] - L[i], Math.abs(H[i] - C[prevI]), Math.abs(L[i] - C[prevI]));
            trs.push(tr); sTR += tr; if (trs.length > 14) sTR -= trs.shift();
            if (trs.length === 14) ind.atr[i] = sTR / 14;
        }
        const v = C[i] * V[i]; vals.push(v); sV += v; if (vals.length > 20) sV -= vals.shift();
        if (vals.length === 20) ind.val20[i] = sV / 20;
        cl20.push(A[i]); s20 += A[i]; if (cl20.length > 20) s20 -= cl20.shift();
        cl60.push(A[i]); s60 += A[i]; if (cl60.length > 60) s60 -= cl60.shift();
        if (cl20.length === 20) ind.ma20[i] = s20 / 20;
        if (cl60.length === 60) ind.ma60[i] = s60 / 60;
        ind.jump[i] = lastJump;
        prevI = i;
    }
    return { sym, O, H, L, C, V, F, A, ...ind, divSkip };
}

/** 動能:近 L 個「有交易的」日子的調整後報酬(只用 ≤ i) */
function momSkip(S, i, L, k) { let j = i, c = 0; while (j > 0 && c < k) { j--; if (S.A[j] > 0) c++; } return c === k ? mom(S, j, L) : NaN; }
function mom(S, i, L) { if (!(S.A[i] > 0)) return NaN; let j = i, c = 0; while (j > 0 && c < L) { j--; if (S.A[j] > 0) c++; } return c === L ? S.A[i] / S.A[j] - 1 : NaN; }

// ⭐ 預設 = 兩個窗口網格(216 + 81 + 9 組)驗出來的中心點;⛔ 最初設計的「60 日動能 + 吊燈 2 倍 + 每週換」實測是輸的(見 DECISIONS V77.8.5)
export const DEF = { U: 100, N: 5, R: 10, L: 10, chand: 0, park: true, bear: true, trend: true, hyst: 2, pick: 'mom', core: 0, maExit: 0, tp: 0, skip: 0, riskadj: false, fill: 'open', noAtt: 0, noDisp: 0, sellDisp: false };
// V77.8.9 自動下單接線前的兩個問題:fill = 'open'(隔天開盤成交,回測原設定)| 'nextclose'(隔天收盤成交 = 自動下單尾盤跑、名單是前一晚算的)
//   noAtt = N:決策日之前 N 個交易日內有「注意股」公告就不買 ・noDisp = N:之前 N 個交易日內有「處置」公告就不買 ・sellDisp:持股被公告處置 → 下一個成交點賣
//   ⚠️ 事件一律只認「決策日之前」的公告(官方公告在收盤後,當天收盤決策時還看不到 = ⛔ 前視)
// V77.8.6 穩定度變體:core = 永遠留幾成在 0050 ・maExit = 收盤跌破 N 日線隔天開盤賣 ・tp = 收盤賺 x 就隔天開盤停利 ・skip = 動能不算最近幾天 ・riskadj = 動能 ÷ ATR 排名

/**
 * 模擬一條路徑。ctx = {cal, stocks:[S], etf:{tr:Float64Array (0050 含息指數,對齊 cal)}, bear:Uint8Array}
 * 回 {eq:Float64Array(從 s0 起), trades, turnover, ...}
 */
export function simulate(ctx, s0, cfg, seed = 1) {
    const { cal, stocks, etf } = ctx;
    const P = { ...DEF, ...cfg };
    const n = cal.length;
    let cash = 1, park = 0;                                   // park 用 0050 含息指數的「單位數」
    const pos = new Map();                                    // sym → {sh, entry, atr, hc, S}
    const eq = [];
    let trades = 0, wins = 0, sumRet = 0, turnover = 0, skipLimit = 0, jumpExit = 0;
    const rand = rng(seed);
    let pending = null;                                       // 前一天收盤決定、今天開盤執行的委託
    const dailySell = new Set();
    const value = i => { let v = cash + park * etf.tr[i]; for (const p of pos.values()) { const c = lastC(p.S, i); v += p.sh * c; } return v; };
    const sell = (p, px, i) => { const amt = p.sh * px; cash += amt * (1 - FEE - TAX); turnover += amt; const ret = px / p.cost - 1 - 2 * FEE - TAX; trades++; sumRet += ret; if (ret > 0) wins++; pos.delete(p.S.sym); };
    for (let i = s0; i < n; i++) {
        // ① 成交點:執行上一次決策的委託 —— fill='open' 在今天開盤、'nextclose' 在今天收盤(見 ②b)
        const execPending = (PX, ti) => {   // ti = 0050 用哪一天的價(開盤成交 ≈ 昨收;收盤成交 = 今天收盤)
            for (const sym of pending.sell) { const p = pos.get(sym); if (!p) continue; const o = PX(p.S, i); if (o > 0) sell(p, o, i); }
            const eqNow = value(ti);
            const slot = eqNow * (1 - P.core) / P.N;
            for (const S of pending.buy) {
                if (pos.size >= P.N) break;
                const o = PX(S, i), pc = lastC(S, i - 1);
                if (!(o > 0 && pc > 0)) continue;
                if (o / pc - 1 > limitOf(cal[i]) - 0.003) { skipLimit++; continue; }      // 成交價接近漲停:買不到(開盤 / 收盤同一條)
                let need = slot;
                if (cash < need && P.park && park > 0) {                                   // 賣 0050 補現金
                    const units = Math.min(park, (need - cash) / (etf.tr[ti] * (1 - FEE - ETF_TAX)));
                    cash += units * etf.tr[ti] * (1 - FEE - ETF_TAX); park -= units; turnover += units * etf.tr[ti];
                }
                need = Math.min(need, cash); if (need < slot * 0.2) continue;
                const sh = need / (o * (1 + FEE)); cash -= need; turnover += need;
                pos.set(S.sym, { sh, cost: o, atr: S.atr[i - 1], hc: o, S, entry: P.fill === 'open' ? i : i + 0.5 });   // 收盤成交那天⛔ 不可再跑當天的吊燈 / 出場檢查
            }
            if (P.park && cash > 0.01 * value(ti)) { const units = cash * (1 - FEE) / etf.tr[ti]; park += units; turnover += cash; cash = 0; }
            pending = null;
        };
        if (pending && P.fill === 'open') execPending((S, k) => S.O[k], i - 1);
        // ② 收盤:除權息、斷崖、吊燈
        for (const p of [...pos.values()]) {
            const S = p.S;
            if (S.F[i] !== 1 && S.C[i] > 0) p.sh *= S.F[i];
            if (!(S.C[i] > 0)) continue;
            if (S.jump[i] === i && i > p.entry) { const pc = lastC(S, i - 1); sell(p, pc, i); jumpExit++; continue; }   // 資料斷崖:用前一天收盤出場
            p.hc = Math.max(p.hc, S.C[i]);
            if (P.chand > 0 && i > p.entry && p.atr > 0 && S.C[i] < p.hc - P.chand * p.atr) sell(p, S.C[i], i);
            else if (P.sellDisp && i > p.entry && ctx.disp && evWithin(ctx.disp.get(S.sym), i, 1)) dailySell.add(S.sym);
            else if (i > p.entry && ((P.maExit === 20 && S.C[i] < S.ma20[i]) || (P.maExit === 60 && S.C[i] < S.ma60[i]) || (P.tp > 0 && S.C[i] >= p.cost * (1 + P.tp)))) dailySell.add(S.sym);
        }
        // ②b fill='nextclose':今天收盤執行上一次的決策(在今天的決策之前)
        if (pending && P.fill === 'nextclose') execPending((S, k) => S.C[k], i);
        if (dailySell.size && i + 1 < n) { pending = pending || { sell: [], buy: [] }; for (const sym of dailySell) if (!pending.sell.includes(sym)) pending.sell.push(sym); dailySell.clear(); }
        eq.push(value(i));
        // ③ 換倉日收盤:決定明天開盤要做什麼
        if ((i - s0) % P.R === 0 && i + 1 < n) {
            const univ = [];
            for (const S of stocks) { if (S.val20[i] > 0 && S.C[i] > 0 && i - S.jump[i] > 120 && S.ma60[i] > 0 && S.atr[i] > 0) univ.push(S); }
            univ.sort((a, b) => b.val20[i] - a.val20[i]);
            const pool = univ.slice(0, P.U);
            let ok = pool.filter(S => !P.trend || (S.C[i] > S.ma20[i] && S.ma20[i] > S.ma60[i]));
            if (P.noAtt && ctx.att) ok = ok.filter(S => !evWithin(ctx.att.get(S.sym), i, P.noAtt));
            if (P.noDisp && ctx.disp) ok = ok.filter(S => !evWithin(ctx.disp.get(S.sym), i, P.noDisp));
            let ranked;
            if (P.pick === 'sham') { ranked = ok.map(S => ({ S, k: rand() })).sort((a, b) => a.k - b.k).map(x => x.S); }
            else if (P.pick === 'all') { ranked = ok; }
            else { ranked = ok.map(S => { let m = P.skip ? momSkip(S, i, P.L, P.skip) : mom(S, i, P.L); if (P.riskadj && S.atr[i] > 0) m = m / (S.atr[i] / S.C[i]); return { S, m }; }).filter(x => Number.isFinite(x.m)).sort((a, b) => b.m - a.m).map(x => x.S); }
            const keepSet = new Set(ranked.slice(0, P.pick === 'all' ? ranked.length : P.N * P.hyst).map(S => S.sym));
            const sellL = [...pos.keys()].filter(s => !keepSet.has(s));
            const bearNow = P.bear && ctx.bear[i];
            const N = P.pick === 'all' ? Math.max(1, ranked.length) : P.N;
            const buyL = bearNow ? [] : ranked.filter(S => !pos.has(S.sym)).slice(0, Math.max(0, N - (pos.size - sellL.length)));
            if (sellL.length || buyL.length || (P.park && cash > 0) || pending) pending = { sell: [...new Set([...(pending ? pending.sell : []), ...sellL])], buy: buyL };
            if (P.pick === 'all') P.N = N;
        }
    }
    return { eq, trades, win: trades ? wins / trades : null, avg: trades ? sumRet / trades : null, turnover, skipLimit, jumpExit, from: cal[s0] };
}
/** 決策日 i 之前(⛔ 不含 i)最近 k 個交易日內有沒有公告:arr = 升冪的日曆索引 */
export function evWithin(arr, i, k) { if (!arr || !arr.length) return false; for (let j = arr.length - 1; j >= 0; j--) { const e = arr[j]; if (e >= i) continue; return i - e <= k; } return false; }
function lastC(S, i) { let j = i; while (j >= 0 && !(S.C[j] > 0)) j--; return j >= 0 ? S.C[j] : NaN; }

/** 指標:總報酬、年化、最大回撤、跟 0050 同窗口比 */
export function metrics(eq, trSlice) {
    const n = eq.length, yrs = (n - 1) / 244;
    let rb = 0, rn = 0; for (let i = 244; i < n; i += 5) { rn++; if (eq[i] / eq[i - 244] > trSlice[i] / trSlice[i - 244]) rb++; }
    const roll12 = rn ? rb / rn * 100 : null;
    let peak = -Infinity, mdd = 0; for (const v of eq) { peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1); }
    let pk2 = -Infinity, mdd0 = 0; for (const v of trSlice) { pk2 = Math.max(pk2, v); mdd0 = Math.min(mdd0, v / pk2 - 1); }
    const tot = eq[n - 1] / eq[0] - 1, b = trSlice[n - 1] / trSlice[0] * (1 - FEE) - 1;
    return { tot: tot * 100, cagr: (Math.pow(eq[n - 1] / eq[0], 1 / yrs) - 1) * 100, mdd: mdd * 100, b0050: b * 100, mdd0050: mdd0 * 100, ex: (tot - b) * 100, roll12 };
}
/** 逐年(日曆年)報酬:策略 vs 0050 */
export function yearly(eq, trSlice, dates) {
    const out = {}; let a = 0;
    for (let i = 1; i <= dates.length; i++) {
        if (i === dates.length || dates[i].slice(0, 4) !== dates[a].slice(0, 4)) {
            const y = dates[a].slice(0, 4), s0 = a === 0 ? 0 : a - 1;
            out[y] = { s: (eq[i - 1] / eq[s0] - 1) * 100, c: (trSlice[i - 1] / trSlice[s0] - 1) * 100 };
            a = i;
        }
    }
    return out;
}

function loadCtx(DATA, DIV) {
    const tw = loadPx(DATA, '^TWII'); if (!tw) throw new Error('DATA_DIR 沒有 ^TWII.json');
    const cal = tw.map(x => x.d);
    const idx = new Map(cal.map((d, i) => [d, i]));
    // 大盤嚴格空頭(同 portfolio_backtest bear60):收盤 < 60 日線 且 20 日線 < 60 日線
    const bear = new Uint8Array(cal.length);
    for (let i = 59; i < tw.length; i++) { let a = 0, b = 0; for (let j = i - 59; j <= i; j++) { b += tw[j].c; if (j > i - 20) a += tw[j].c; } a /= 20; b /= 60; bear[i] = tw[i].c < b && a < b ? 1 : 0; }
    // 0050 含息
    const b50p = path.join(DATA, '_bench0050.json');
    const bars = fs.existsSync(b50p) ? JSON.parse(fs.readFileSync(b50p, 'utf8')).map(r => ({ d: String(r.date).replace(/\//g, '-').slice(0, 10), c: +r.close })).filter(x => x.c > 0) : loadPx(DATA, '0050');
    const divP = path.join(DATA, '_div0050.json');
    let d50 = [];
    if (fs.existsSync(divP)) { const raw = JSON.parse(fs.readFileSync(divP, 'utf8')); d50 = Array.isArray(raw) ? raw : (raw.h || ((raw.d || raw)['0050'] || {}).h || []); }
    else if (DIV) { const raw = JSON.parse(fs.readFileSync(DIV, 'utf8')); d50 = ((raw.d || raw)['0050'] || {}).h || []; }
    const tr0 = trSeries(bars, d50);
    const tr = new Float64Array(cal.length).fill(NaN); let j = 0, last = NaN;
    for (let i = 0; i < cal.length; i++) { while (j < tr0.d.length && tr0.d[j] <= cal[i]) { last = tr0.v[j]; j++; } tr[i] = last; }
    // 個股
    let DV = {}; if (DIV && fs.existsSync(DIV)) { const raw = JSON.parse(fs.readFileSync(DIV, 'utf8')); DV = raw.d || raw; }
    const stocks = []; let skipped = 0, divSkip = 0;
    for (const f of fs.readdirSync(DATA)) {
        if (!f.endsWith('.json') || f.startsWith('_') || f.startsWith('^') || f.startsWith('00')) continue;
        const sym = f.slice(0, -5); if (!/^\d{4}$/.test(sym)) continue;           // 只收四碼普通股
        let raw; try { raw = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch (_) { skipped++; continue; }
        if (!Array.isArray(raw) || raw.length < 120) { skipped++; continue; }
        const rows = raw.map(r => ({ d: String(r.date).replace(/\//g, '-').slice(0, 10), o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +r.volume })).filter(r => r.c > 0 && r.o > 0 && idx.has(r.d));
        const S = prepStock(sym, rows, cal, (DV[sym] || {}).h || []);
        divSkip += S.divSkip; stocks.push(S);
    }
    const evMap = f => { if (!f || !fs.existsSync(f)) return null; const j = JSON.parse(fs.readFileSync(f, 'utf8')); const m = new Map(); let n = 0;
        for (const [sym, ds] of Object.entries(j)) { const a = []; for (const d of ds) { const d10 = String(d).slice(0, 10); let k = idx.get(d10); if (k === undefined) { k = cal.findIndex(x => x > d10); if (k < 0) continue; k -= 0.5; } a.push(k); n++; } a.sort((x, y) => x - y); m.set(sym, a); } m.n = n; return m; };
    const att = evMap(process.env.ATT_EVENTS), disp = evMap(process.env.DISP_EVENTS);
    return { cal, stocks, etf: { tr }, bear, att, disp, meta: { stocks: stocks.length, skipped, divSkip, d50: d50.length, att: att ? att.n : 0, disp: disp ? disp.n : 0 } };
}

// ⚠️ 起點間距預設 3(⛔ 不是 5):換倉每 R 天一次,間距 5 碰上 R=10 只會有 2 種換倉相位,17 條其實只有 2 條獨立路徑(實測當場抓到)。
//   3 跟 5、10、20 互質 → 17 條涵蓋所有相位。
const STEP = +(process.env.PATH_STEP || 3);
function runSet(ctx, name, cfg, startDate, paths = 17) {
    const s0 = ctx.cal.findIndex(d => d >= startDate);
    const res = [];
    for (let k = 0; k < paths; k++) {
        const s = s0 + STEP * k;
        const r = simulate(ctx, s, cfg, 1000 + k);
        const trS = Array.from(ctx.etf.tr.slice(s, s + r.eq.length));
        res.push({ ...r, m: metrics(r.eq, trS), y: yearly(r.eq, trS, ctx.cal.slice(s, s + r.eq.length)) });
    }
    const med = f => r2(median(res.map(f)));
    const years = Object.keys(res[0].y);
    return { name, cfg, from: startDate, paths,
        tot: med(r => r.m.tot), b0050: med(r => r.m.b0050), ex: med(r => r.m.ex), cagr: med(r => r.m.cagr), mdd: med(r => r.m.mdd), mdd0050: med(r => r.m.mdd0050),
        beat: res.filter(r => r.m.ex > 0).length, worstEx: r2(Math.min(...res.map(r => r.m.ex))), roll12: med(r => r.m.roll12), worstYr: r2(Math.min(...res.map(r => Math.min(...Object.values(r.y).map(v => v.s - v.c))))), yrBeat: med(r => Object.values(r.y).filter(v => v.s > v.c).length),
        trades: med(r => r.trades), win: med(r => r.win * 100), avg: med(r => r.avg * 100), turnYr: med(r => r.turnover / ((r.eq.length - 1) / 244)),
        years: Object.fromEntries(years.map(y => [y, { s: med(r => r.y[y]?.s ?? NaN), c: med(r => r.y[y]?.c ?? NaN) }])) };
}

function selftest() {
    let ok = 0, bad = 0; const t = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); c ? ok++ : bad++; };
    const n = 200, cal = Array.from({ length: n }, (_, i) => { const d = new Date(Date.UTC(2023, 0, 2 + i)); return d.toISOString().slice(0, 10); });
    const mk = (sym, f) => prepStock(sym, cal.map((d, i) => { const c = f(i); return { d, o: c, h: c * 1.005, l: c * 0.995, c, v: 1e7 }; }), cal, []);
    const flat = { tr: new Float64Array(n).fill(1) };
    // ① 零前視:A 在 i=120 開盤突然 +50%(收盤之前看不到),B 一路緩漲 → 第 119 天收盤決策只能選到 B
    const A = mk('1111', i => 100 + i * 0.05), B = mk('2222', i => 100 + i * 0.3);
    A.O[120] = A.C[119] * 1.5;
    const ctx = { cal, stocks: [A, B], etf: flat, bear: new Uint8Array(n) };
    const r = simulate(ctx, 115, { U: 2, N: 1, R: 5, L: 20, chand: 0, park: false, trend: false });
    t(r.eq.length === n - 115 && r.trades === 0 && Math.abs(r.eq.at(-1) / r.eq[1] - B.C[n - 1] / B.C[116]) < 0.02, '① 決策只用收盤前看得到的:選 B(緩漲最多),不會被 A 隔天的開盤跳空影響');
    // ② 成本:買進後立刻價格不變,一買一賣扣 2×0.1425% + 0.3%
    const C1 = mk('3333', () => 100);
    const ctx2 = { cal, stocks: [C1], etf: flat, bear: new Uint8Array(n) };
    const r2_ = simulate(ctx2, 100, { U: 1, N: 1, R: 1000, L: 20, chand: 0, park: false, trend: false, pick: 'all' });
    t(Math.abs(r2_.eq[r2_.eq.length - 1] - 1 / (1 + FEE)) < 1e-9, '② 買進成本 0.1425%(持有不賣時淨值 = 1 ÷ 1.001425)');
    // ③ 吊燈:漲到 150 後跌到 140(ATR≈1)→ 賣
    const D = mk('4444', i => i < 100 ? 100 : i < 130 ? 100 + (i - 100) * 1.0 : 130 - (i - 130) * 0.5);   // 緩跌(⛔ 不可觸發斷崖出場,否則替吊燈過關)
    const ctx3 = { cal, stocks: [D], etf: flat, bear: new Uint8Array(n) };
    const r3 = simulate(ctx3, 100, { U: 1, N: 1, R: 1000, L: 20, chand: 2, park: false, trend: false, pick: 'all' });
    const r3b = simulate(ctx3, 100, { U: 1, N: 1, R: 1000, L: 20, chand: 0, park: false, trend: false, pick: 'all' });
    t(r3.trades === 1 && r3.jumpExit === 0 && r3b.trades === 0 && r3.eq.at(-1) > r3b.eq.at(-1), '③ 吊燈 ATR 2 倍:從最高收盤回落超過 2×ATR 就收盤賣(對照:不用吊燈就一直抱著、淨值比較低)');
    // ④ 除權息:當天份數 × 倍數,淨值不掉
    const E = prepStock('5555', cal.map((d, i) => { const c = i < 150 ? 100 : 95; return { d, o: c, h: c * 1.005, l: c * 0.995, c, v: 1e7 }; }), cal, [[cal[150], 5, '息', 100, 95]]);
    const r4 = simulate({ cal, stocks: [E], etf: flat, bear: new Uint8Array(n) }, 140, { U: 1, N: 1, R: 1000, L: 20, chand: 0, park: false, trend: false, pick: 'all' });
    t(r4.eq[5] < 0.999 && Math.abs(r4.eq[r4.eq.length - 1] - r4.eq[5]) < 1e-9 && E.F[150] > 1.05, '④ 除息日:份數 × (100/95),淨值不會因為除息假跌(⭐ 先確認真的有買進:淨值扣過買進成本)');
    // ⑤ sham 固定種子可重現
    const many = Array.from({ length: 20 }, (_, k) => mk(String(6000 + k), i => 100 + i * (0.1 + k * 0.01)));
    const ctx5 = { cal, stocks: many, etf: flat, bear: new Uint8Array(n) };
    const a1 = simulate(ctx5, 100, { U: 20, N: 3, R: 5, L: 20, chand: 0, park: false, trend: false, pick: 'sham' }, 7), a2 = simulate(ctx5, 100, { U: 20, N: 3, R: 5, L: 20, chand: 0, park: false, trend: false, pick: 'sham' }, 7);
    t(a1.eq.at(-1) === a2.eq.at(-1), '⑤ 安慰劑固定種子 → 結果一模一樣');
    // ⑥ 動能排名:漲最多的那 3 檔(k=17,18,19)會被選到 → 報酬高於 sham
    const m1 = simulate(ctx5, 100, { U: 20, N: 3, R: 5, L: 20, chand: 0, park: false, trend: false }, 7);
    t(m1.eq.at(-1) > a1.eq.at(-1), '⑥ 動能排名挑到漲最多的,贏安慰劑');
    // ⑦ 開盤接近漲停買不到
    const G = mk('7777', i => 100 + i * 0.5); G.O[101] = G.C[100] * 1.099;
    const r7 = simulate({ cal, stocks: [G], etf: flat, bear: new Uint8Array(n) }, 100, { U: 1, N: 1, R: 1000, L: 20, chand: 0, park: false, trend: false, pick: 'all' });
    t(r7.skipLimit === 1 && r7.eq.at(-1) === 1, '⑦ 開盤接近漲停 → 不買(跟 portfolio_backtest 同一條)');
    // ⑧ 大盤空頭不開新倉
    const bearAll = new Uint8Array(n).fill(1);
    const r8 = simulate({ cal, stocks: [B], etf: flat, bear: bearAll }, 100, { U: 1, N: 1, R: 5, L: 20, chand: 0, park: false, trend: false });
    t(r8.eq.at(-1) === 1, '⑧ 大盤嚴格空頭 → 一檔都不買');
    // ⑨ 閒錢停 0050:0050 漲 10%,沒股票可買 → 淨值 ≈ +10% 扣成本
    const trUp = new Float64Array(n).map((_, i) => 1 + (i >= 101 ? 0.1 * (i - 100) / 99 : 0));
    const r9 = simulate({ cal, stocks: [], etf: { tr: trUp }, bear: new Uint8Array(n) }, 100, { U: 1, N: 1, R: 1, L: 20, chand: 0, park: true, trend: false });
    t(r9.eq.at(-1) > 1.09 && r9.eq.at(-1) < 1.1, '⑨ 閒錢停 0050:0050 漲 10% 時淨值跟著漲(扣買進成本)');
    // ⑩ 資料斷崖:單日 −40% → 用前一天收盤出場
    const J = mk('8888', i => i < 150 ? 100 : 60);
    const r10 = simulate({ cal, stocks: [J], etf: flat, bear: new Uint8Array(n) }, 100, { U: 1, N: 1, R: 1000, L: 20, chand: 0, park: false, trend: false, pick: 'all' });
    t(r10.jumpExit === 1 && r10.eq.at(-1) > 0.99, '⑩ 單日跳超過漲跌幅限制 = 資料斷崖 → 前一天收盤出場,⛔ 不吃那個假跌幅');
    // ⑪ 停利:漲到 +5% 隔天開盤賣
    const T = mk('9991', i => i < 100 ? 100 : 100 + (i - 100) * 0.4);
    const r11 = simulate({ cal, stocks: [T], etf: flat, bear: new Uint8Array(n) }, 100, { U: 1, N: 1, R: 1000, L: 20, chand: 0, park: false, trend: false, pick: 'all', tp: 0.05 });
    t(r11.trades === 1 && r11.win === 1 && r11.avg > 0.04 && r11.avg < 0.07, '⑪ 停利 5%:收盤賺到 5% 就隔天開盤賣(每筆約 +5%)');
    // ⑫ 跌破 20 日線隔天賣
    const M = mk('9992', i => i < 130 ? 100 + i * 0.5 : 165 - (i - 130) * 0.8);
    const r12 = simulate({ cal, stocks: [M], etf: flat, bear: new Uint8Array(n) }, 100, { U: 1, N: 1, R: 1000, L: 20, chand: 0, park: false, trend: false, pick: 'all', maExit: 20 });
    const r12b = simulate({ cal, stocks: [M], etf: flat, bear: new Uint8Array(n) }, 100, { U: 1, N: 1, R: 1000, L: 20, chand: 0, park: false, trend: false, pick: 'all' });
    t(r12.trades === 1 && r12b.trades === 0 && r12.eq.at(-1) > r12b.eq.at(-1), '⑫ 跌破 20 日線隔天開盤賣(對照:不設就抱到底、淨值較低)');
    // ⑬ core=0.5:一半永遠在 0050 → 0050 漲 10% 股票不動時淨值約 +5%
    const r13 = simulate({ cal, stocks: [C1], etf: { tr: trUp }, bear: new Uint8Array(n) }, 100, { U: 1, N: 1, R: 1000, L: 20, chand: 0, park: true, trend: false, pick: 'all', core: 0.5 });
    t(r13.eq.at(-1) > 1.04 && r13.eq.at(-1) < 1.06, '⑬ core 0.5:永遠留一半在 0050(0050 +10%、股票不動 → 淨值約 +5%)');
    // ⑭ 隔天收盤成交:第 100 天收盤決策 → 第 101 天收盤買(不是開盤)
    const Q = mk('9993', i => 100 + i * 0.5); Q.O[101] = Q.C[100] * 0.95;   // 開盤特別低 → 開盤成交會比較便宜
    const q1 = simulate({ cal, stocks: [Q], etf: flat, bear: new Uint8Array(n) }, 100, { U: 1, N: 1, R: 1000, L: 20, chand: 0, park: false, trend: false, pick: 'all', fill: 'open' });
    const q2 = simulate({ cal, stocks: [Q], etf: flat, bear: new Uint8Array(n) }, 100, { U: 1, N: 1, R: 1000, L: 20, chand: 0, park: false, trend: false, pick: 'all', fill: 'nextclose' });
    t(q1.eq.at(-1) > q2.eq.at(-1) && Math.abs(q2.eq[1] - 1 / (1 + FEE)) < 1e-9, '⑭ fill=nextclose:隔天收盤才成交(開盤那個便宜價拿不到;成交那天收盤淨值 = 1 ÷ 1.001425)');
    // ⑮ 事件濾網:只認決策日「之前」的公告
    t(evWithin([95], 100, 5) === true && evWithin([100], 100, 5) === false && evWithin([90], 100, 5) === false && evWithin([98, 100], 100, 3) === true, '⑮ evWithin:決策日當天的公告⛔ 不算(收盤後才公告);之前 k 天內才算');
    const ctxE = { cal, stocks: [B], etf: flat, bear: new Uint8Array(n), att: new Map([['2222', [98]]]) };
    const e1 = simulate(ctxE, 100, { U: 1, N: 1, R: 1000, L: 20, chand: 0, park: false, trend: false, noAtt: 3 });
    const e2 = simulate({ ...ctxE, att: new Map([['2222', [100]]]) }, 100, { U: 1, N: 1, R: 1000, L: 20, chand: 0, park: false, trend: false, noAtt: 3 });
    t(e1.eq.at(-1) === 1 && e2.eq.at(-1) !== 1, '⑯ noAtt:兩天前被公告注意 → 不買;決策日當天才公告 → 照買(那時還看不到)');
    console.log(`\n${bad ? '❌' : '✅'} selftest ${ok}/${ok + bad}`);
    return bad ? 1 : 0;
}

function main() {
    const out = process.argv[2], DATA = process.env.DATA_DIR, DIV = process.env.DIV;
    if (!DATA) { console.error('要 DATA_DIR'); process.exit(1); }
    const t0 = Date.now();
    const ctx = loadCtx(DATA, DIV);
    console.log(`📅 事件:注意 ${ctx.meta.att} 筆・處置 ${ctx.meta.disp} 筆`);
    console.log(`📂 ${ctx.meta.stocks} 檔・日曆 ${ctx.cal[0]}~${ctx.cal.at(-1)}・0050 股利 ${ctx.meta.d50} 筆・除權息對不上排除 ${ctx.meta.divSkip}・${((Date.now() - t0) / 1000).toFixed(0)}s`);
    if (ctx.meta.stocks < 1000) { console.error('🚨 檔數 < 1000,拒跑'); process.exit(1); }
    if (ctx.meta.d50 < 10) { console.error('🚨 0050 股利 < 10 筆 → 對照組不含息會讓策略看起來比較好,拒跑'); process.exit(1); }
    const GRID = process.env.GRID ? JSON.parse(process.env.GRID) : null;   // {L:[..],chand:[..],N:[..],R:[..],U:[..]}
    const gridSets = GRID ? (() => { const keys = Object.keys(GRID); let out = [{}]; for (const k of keys) out = out.flatMap(o => GRID[k].map(v => ({ ...o, [k]: v }))); return out.map(c => [keys.map(k => `${k}${c[k]}`).join('_'), c]); })() : null;
    const SETS = gridSets || JSON.parse(process.env.SETS || 'null') || [
        ['★ 領頭羊短線輪動(10 日動能・前 100 大・5 檔・每 10 天)', {}],
        ['安慰劑:同池子同過濾隨機挑', { pick: 'sham' }],
        ['池子等權(不排名)', { pick: 'all' }],
        ['加吊燈 3 倍', { chand: 3 }],
        ['不用空頭守門', { bear: false }],
        ['閒錢放現金', { park: false }],
    ];
    const WINS = (process.env.WINS || '2022-09-16,2011-01-03').split(',');
    const res = { asof: new Date().toISOString().slice(0, 10), meta: ctx.meta, def: DEF, sets: [] };
    for (const w of WINS) for (const [name, cfg] of SETS) {
        const R = runSet(ctx, name, cfg, w);
        res.sets.push(R);
        console.log(`[${w}] ${name}:總報酬 ${R.tot}% vs 0050 含息 ${R.b0050}%(超額 ${R.ex}pp,17 條贏 ${R.beat},最差 ${R.worstEx})・年化 ${R.cagr}% ・回撤 ${R.mdd}%(0050 ${R.mdd0050}%)・交易 ${R.trades} 筆 勝率 ${R.win}% 每筆 ${R.avg}% ・年換手 ${r2(R.turnYr)}x ・📈 滾動 12 月贏 0050 ${R.roll12}% ・贏 ${R.yrBeat}/${Object.keys(R.years).length} 年 最差年 ${R.worstYr}pp`);
        console.log('    逐年 ' + Object.entries(R.years).map(([y, v]) => `${y} ${r2(v.s)}/${r2(v.c)}`).join(' ・'));
    }
    if (out) fs.writeFileSync(out, JSON.stringify(res));
    console.log(`⏱️ ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

if (process.argv.includes('--selftest')) process.exit(selftest());
else main();
