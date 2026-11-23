// ₿ btc_tw_probe.mjs —— 比特幣跟台股:盤前(美股收盤後那段)・盤中(09:00→10:00)・信心(20 天大跌)(EXP 事先登記)
//
// 為什麼(V82.6.7,使用者 11/23):「新增比特幣判讀是否與股市有關聯,最好是能提前在盤中或盤前能知道目前股市信心之類的,
//   或者有更好的判讀機率」。App 現在有兩句沒驗證過的話(名詞解釋「比特幣暴漲 = 股市偏多」、全球大玩家卡「跌 5% = 科技股小心」),
//   盤前體檢也沒有比特幣 → 先驗證,過了才接。
//
// 資料:
//   BTC_HIST  btc_1h.json.gz(scripts/btc_hist_miner.py,premkt_hist 分支):c[k] = t0 + (k+1) 小時那一刻的價
//   DUMP      premkt_app_probe.mjs 的逐日明細(App 自己的 _preOpenScore 每天重建;d / gap / io / s / usd = 分數用的那次美股日期)
//   B0050     0050 日 K(逗號分隔多份,先出現的優先;16 年:<d16>/_bench0050.json,再接 gh-pages data/0050.json)
//   DIV       0050 股利(_div0050.json);C 那題的 20 天報酬含息(us_tw_lead_probe.benchFactory)
//   KBAR5_DIR 5 分 K(kbar5_deep:kbar5;冒號分隔);B 那題只用 0050
//   FRED_HIST (只描述)FRED CBBTCUSD 是一天裡哪個時間點
//
// ⏰ 時間(錯了整份作廢):
//   某一刻 T 的比特幣價 = 開始於 T − 1 小時那根的收盤(px;⛔ 用開始於 T 那根 = 偷看之後那一小時);最多往前找 2 根
//   台北 08:00 = UTC 00:00;美股收盤 = 紐約 16:00(夏令 20:00 / 冬令 21:00 UTC,同 worker _lastUsCloseMs);台股收盤 → 用 14:00(06:00 UTC)
// ⭐ 判定(EXP 寫死,⛔ 跑完再改;四個判定一起校正 → 看機率的都用 p ≤ 0.01):見 RULE 與 judgeA / judgeB / judgeC。
//   判定只用到 2026-11-06(之後封存,只描述現在)。
//
// 跑法:BTC_HIST DUMP B0050 DIV KBAR5_DIR [FRED_HIST] node scripts/btc_tw_probe.mjs [out.json]
//       node scripts/btc_tw_probe.mjs --selftest
import fs from 'fs';
import zlib from 'zlib';
import path from 'path';
import { fileURLToPath } from 'url';
import { judge, spearman } from './premkt_app_probe.mjs';
import { benchFactory } from './us_tw_lead_probe.mjs';
import { rng, mean, med, r2 } from './lib_crash.mjs';
import { yearPos } from './mood_build.mjs';

export const RULE = {
    cut: '2026-11-06', alpha: 0.01,
    A: { dz: 2, w: 1, grid: [[1, 0.5], [1, 1], [2, 0.5], [2, 1], [3, 0.5], [3, 1]], yearShare: 0.76, callKeep: 0.8, nbrNeed: 4,
         wfFrom: 2019, wfNeed: 6, perm: 2000, trim: 0.01, longH: 24 },
    B: { minN: 1000, rho: 0.08, yrsNeed: 4, spread: 0.25, perm: 2000, minBars: 50, lastMin: 805 },
    C: { pct: 5, h: 20, refr: 20, minPrior: 300, minN: 12, effect: 2, matched: 1, sims: 2000, rotFrom: 60, rotStep: 20, rotPct: 0.95 },
};
const H = 3600;
const d10 = s => String(s || '').replace(/\//g, '-').slice(0, 10);
export const utc = d => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 1000;
const isoD = t => new Date(t * 1000).toISOString().slice(0, 10);
const addD = (d, n) => isoD(utc(d) + n * 86400);

// ───────────────────────────── 時間點
/** 某一刻 T(UTC 秒、整點)的價 = 開始於 T − 1 小時那根的收盤;那根沒有 → 往前最多 2 根;都沒有 → null */
export function px(B, T) {
    const k = (T - B.t0) / H - 1;
    if (!Number.isInteger(k)) return null;
    for (let j = 0; j <= 2; j++) { const i = k - j; if (i >= 0 && i < B.c.length && B.c[i] != null) return B.c[i]; }
    return null;
}
const _nyFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' });
/** 美股日期 usd 的收盤(紐約 16:00)→ UTC 秒;同 worker _lastUsCloseMs 的判法(20:00 UTC 那一刻在紐約是不是 16 點) */
export function nyClose(usd) {
    const day = utc(usd);
    const c20 = day + 20 * H;
    return +_nyFmt.format(new Date(c20 * 1000)) === 16 ? c20 : day + 21 * H;
}
/** A:分數用的那次美股收盤(週一要往前接到上一個台股交易日 14:00)→ D 的 08:00;→ { x %, h 小時 } 或 null */
export function btcWindow(B, D, usd, prevTW, endOff = 0) {
    if (!usd || !prevTW) return null;
    const s = Math.max(nyClose(usd), utc(prevTW) + 6 * H), e = utc(D) + endOff;
    if (!(s < e)) return null;
    const a = px(B, s), b = px(B, e);
    return a && b ? { x: (b / a - 1) * 100, h: (e - s) / H } : null;
}

// ───────────────────────────── 統計小工具
function ranks(v) {
    const o = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]), r = new Array(v.length);
    let i = 0;
    while (i < o.length) { let j = i; while (j + 1 < o.length && o[j + 1][0] === o[i][0]) j++; for (let q = i; q <= j; q++) r[o[q][1]] = (i + j) / 2; i = j + 1; }
    return r;
}
function pearson(a, b) {
    const n = a.length; if (n < 3) return 0;
    let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
    let cv = 0, va = 0, vb = 0; for (let i = 0; i < n; i++) { const p = a[i] - ma, q = b[i] - mb; cv += p * q; va += p * p; vb += q * q; }
    return va && vb ? cv / Math.sqrt(va * vb) : 0;
}
const pcorr = (xy, xz, yz) => { const d = Math.sqrt((1 - xz * xz) * (1 - yz * yz)); return d ? (xy - xz * yz) / d : 0; };
/** 偏 Spearman ρ(x, y | z) + 在同一組(grp)裡打亂 x 的置換檢定;side 'pos' = 單邊(正),'two' = 雙邊 */
export function partialPerm(x, y, z, grp, nPerm, seed, side = 'two') {
    const rx = ranks(x), ry = ranks(y), rz = ranks(z), yz = pearson(ry, rz);
    const obs = pcorr(pearson(rx, ry), pearson(rx, rz), yz);
    const G = new Map(); grp.forEach((g, i) => { if (!G.has(g)) G.set(g, []); G.get(g).push(i); });
    const R = rng(seed), px_ = rx.slice();
    let hit = 0;
    for (let s = 0; s < nPerm; s++) {
        for (const ix of G.values()) for (let i = ix.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); const a = ix[i], b = ix[j]; const t = px_[a]; px_[a] = px_[b]; px_[b] = t; }
        const v = pcorr(pearson(px_, ry), pearson(px_, rz), yz);
        if (side === 'pos' ? v >= obs : Math.abs(v) >= Math.abs(obs)) hit++;
    }
    return { rho: obs, p: (hit + 1) / (nPerm + 1) };
}

// ───────────────────────────── A:盤前增量(疊在 App 自己的分數上)
const candF = (dz, w, onlyLong) => r => (r.bx == null || (onlyLong && r.bh < RULE.A.longH) || Math.abs(r.bx) < dz) ? r.s : Math.round((r.s + w * Math.sign(r.bx)) * 10) / 10;
const yearsOf = rows => [...new Set(rows.map(r => r.d.slice(0, 4)))].sort();
/** 一格候選 vs 現行:逐年名次相關 / 方向猜對都要比較好(平手算沒有)、講話天數 ≥ 八成 */
export function cellCheck(rows, f, need) {
    const ys = yearsOf(rows), S0 = r => r.s;
    let a = 0, b = 0;
    for (const y of ys) {
        const R = rows.filter(r => r.d.startsWith(y)), J0 = judge(R, S0), J1 = judge(R, f);
        if (J1.rho > J0.rho) a++;
        if (Number.isFinite(J1.hit) && Number.isFinite(J0.hit) && J1.hit > J0.hit) b++;
    }
    const all0 = judge(rows, S0), all1 = judge(rows, f);
    const callOk = all1.call >= RULE.A.callKeep * all0.call;
    return { a, b, n: ys.length, need, callOk, pass: a >= need && b >= need && callOk, gain: all1.rho - all0.rho, hit0: all0.hit, hit1: all1.hit, rho0: all0.rho, rho1: all1.rho };
}
export function judgeA(rows0, onlyLong, opt = {}) {
    const A = RULE.A, seed = opt.seed || 20261123;
    const rows = rows0.filter(r => r.bx != null && (!onlyLong || r.bh >= A.longH));
    const ys = yearsOf(rows), need = Math.ceil(A.yearShare * ys.length);
    const cells = A.grid.map(([dz, w]) => ({ dz, w, ...cellCheck(rows, candF(dz, w, onlyLong), need) }));
    const main = cells.find(c => c.dz === A.dz && c.w === A.w), others = cells.filter(c => c !== main);
    const nbr = others.filter(c => c.pass).length, noNeg = cells.every(c => c.gain >= 0);
    // 逐年樣本外:每一年只看以前的年份挑最好的一格(全期名次相關增加最多),再看那一年有沒有贏現行
    let wfW = 0, wfN = 0; const wf = [];
    for (const y of ys.filter(y => +y >= A.wfFrom)) {
        const past = rows.filter(r => r.d.slice(0, 4) < y); if (past.length < 100) continue;
        const best = A.grid.map(([dz, w]) => ({ dz, w, g: judge(past, candF(dz, w, onlyLong)).rho - judge(past, r => r.s).rho })).sort((p, q) => q.g - p.g)[0];
        const R = rows.filter(r => r.d.startsWith(y)), win = judge(R, candF(best.dz, best.w, onlyLong)).rho > judge(R, r => r.s).rho;
        wfN++; wfW += win; wf.push(`${y}:${best.dz}%×${best.w}${win ? '✓' : '✗'}`);
    }
    const pp = partialPerm(rows.map(r => r.bx), rows.map(r => r.gap), rows.map(r => r.s), rows.map(r => r.d.slice(0, 4) + (r.bh >= A.longH ? 'w' : 'd')), A.perm, seed, 'pos');
    const cut = [...rows].sort((p, q) => Math.abs(q.bx) - Math.abs(p.bx)).slice(0, Math.ceil(rows.length * A.trim)).map(r => r.d), drop = new Set(cut);
    const rest = rows.filter(r => !drop.has(r.d)), f = candF(A.dz, A.w, onlyLong);
    const trimGain = judge(rest, f).rho - judge(rest, r => r.s).rho;
    const pass = [main.pass, nbr >= A.nbrNeed && noNeg, wfW >= A.wfNeed, pp.rho > 0 && pp.p <= RULE.alpha, trimGain > 0];
    return { n: rows.length, years: ys.length, need, main, cells, nbr, noNeg, wf: { w: wfW, n: wfN, list: wf }, pp, trimGain, pass, ok: pass.every(Boolean) };
}

// ───────────────────────────── B:盤中(比特幣 09:00→10:00 → 0050 10:05→收盤)
/** 一天 0050 的 5 分 K(開始分鐘 540 = 09:00)→ { open, c595, c600, last } 或 null */
export function dayBars(bars) {
    if (!Array.isArray(bars) || bars.length < RULE.B.minBars) return null;
    const by = new Map(bars.map(b => [b[0], b]));
    const f = bars[0], L = bars.at(-1), b595 = by.get(595), b600 = by.get(600);
    if (!f || f[0] > 545 || !L || L[0] < RULE.B.lastMin || !b595 || !b600 || !(f[1] > 0)) return null;
    return { open: f[1], c595: b595[4], c600: b600[4], last: L[4] };
}
export function judgeB(rows, opt = {}) {
    const Bc = RULE.B, n = rows.length;
    if (n < 10) return { n, pass: [false], ok: false };
    const pp = partialPerm(rows.map(r => r.x), rows.map(r => r.y), rows.map(r => r.z), rows.map(r => r.d.slice(0, 4)), Bc.perm, opt.seed || 20261124, 'two');
    const sgn = Math.sign(pp.rho), half = n >> 1;
    const pr = R => { const x = R.map(r => r.x), y = R.map(r => r.y), z = R.map(r => r.z); return pcorr(spearman(x, y), spearman(x, z), spearman(y, z)); };
    const h1 = pr(rows.slice(0, half)), h2 = pr(rows.slice(half));
    const ys = yearsOf(rows), yr = ys.map(y => [y, pr(rows.filter(r => r.d.startsWith(y)))]);
    const ysame = yr.filter(([, v]) => Math.sign(v) === sgn && sgn !== 0).length;
    const srt = [...rows].sort((p, q) => p.x - q.x), q5 = Math.floor(n / 5);
    const spread = mean(srt.slice(-q5).map(r => r.y)) - mean(srt.slice(0, q5).map(r => r.y));
    const pass = [n >= Bc.minN, Math.abs(pp.rho) >= Bc.rho && pp.p <= RULE.alpha, Math.sign(h1) === sgn && Math.sign(h2) === sgn,
                  ysame >= Bc.yrsNeed, Math.sign(spread) === sgn && Math.abs(spread) >= Bc.spread];
    return { n, pp, h1, h2, yr, ysame, spread, pass, ok: pass.every(Boolean) };
}

// ───────────────────────────── C:信心(比特幣 20 天漲跌在過去一年最低 5%)
/** 每一個日曆天台北 08:00 的價 → 20 天漲跌 → 一年位置(人性頁 yearPos;前面要有 ≥ minPrior 個值) */
export function btcPctSeries(B, d0, d1) {
    const days = []; for (let d = d0; d <= d1; d = addD(d, 1)) days.push(d);
    const p = days.map(d => px(B, utc(d)));
    const r20 = days.map((d, i) => i >= 20 && p[i] && p[i - 20] ? (p[i] / p[i - 20] - 1) * 100 : null);
    const pts = days.map((d, i) => [d, r20[i]]).filter(q => q[1] != null);
    const pct = new Map(); let lo = 0;
    for (let i = 0; i < pts.length; i++) {
        const [d, v] = pts[i], cut = addD(d, -365);
        while (lo < i && pts[lo][0] <= cut) lo++;
        if (i - lo < RULE.C.minPrior) continue;
        pct.set(d, { r20: v, pct: yearPos(pts.slice(lo, i), v, d).pct });
    }
    return pct;
}
/** 事件:台股交易日、位置 ≤ pct(或 ≥ 100 − pct)、前一個事件之後至少隔 refr 個交易日 */
export function eventsC(TD, pctMap, side = 'lo', thr = RULE.C.pct, refr = RULE.C.refr, rot = 0) {
    const sc = TD.map(d => (pctMap.get(d) || {}).pct ?? null);
    const valid = sc.map((v, i) => v == null ? -1 : i).filter(i => i >= 0);
    let vals = sc;
    if (rot) { const L = valid.length, s2 = sc.slice(); valid.forEach((ix, k) => { s2[ix] = sc[valid[((k - rot) % L + L) % L]]; }); vals = s2; }
    const ev = []; let last = -1e9;
    for (let i = 0; i < TD.length; i++) {
        const v = vals[i]; if (v == null) continue;
        const hit = side === 'lo' ? v <= thr : v >= 100 - thr;
        if (hit && i - last >= refr) { ev.push(i); last = i; }
    }
    return ev;
}
export function judgeC(TD, pctMap, bench, ret20prior, opt = {}) {
    const C = RULE.C, h = opt.h || C.h, side = opt.side || 'lo';
    const pool = TD.map((d, i) => ({ i, d, y: bench(d, h), q: ret20prior(i) })).filter(o => o.y != null && pctMap.has(o.d));
    const P = new Set(pool.map(o => o.i));
    const ev = eventsC(TD, pctMap, side).filter(i => P.has(i)), E = ev.map(i => pool.find(o => o.i === i));
    if (E.length < 3) return { n: E.length, pass: [false], ok: false };
    const base = mean(pool.map(o => o.y)), em = mean(E.map(o => o.y)), diff = em - base;
    const R = rng(opt.seed || 20261125); let lo = 0, hi = 0;
    for (let s = 0; s < C.sims; s++) { let sum = 0; for (let k = 0; k < E.length; k++) sum += pool[Math.floor(R() * pool.length)].y; const m = sum / E.length; if (m <= em) lo++; if (m >= em) hi++; }
    const p = Math.min(1, 2 * Math.min(lo, hi) / C.sims);
    const half = E.length >> 1, h1 = mean(E.slice(0, half).map(o => o.y)) - base, h2 = mean(E.slice(half).map(o => o.y)) - base;
    // 跟「台股前 20 天漲跌同一級(五等分)」的日子比
    const qs = pool.map(o => o.q).filter(v => v != null).sort((a, b) => a - b), qOf = v => v == null ? null : Math.min(4, Math.floor(qs.filter(x => x < v).length / qs.length * 5));
    const qm = [0, 1, 2, 3, 4].map(k => mean(pool.filter(o => qOf(o.q) === k).map(o => o.y)));
    const mt = E.filter(o => qOf(o.q) != null).map(o => o.y - qm[qOf(o.q)]), matched = mean(mt);
    // 整串循環挪:真的那個比 95% 的挪法更極端
    const valid = TD.filter(d => pctMap.has(d)).length, rots = [];
    for (let k = C.rotFrom; k <= valid - C.rotFrom; k += C.rotStep) {
        const e2 = eventsC(TD, pctMap, side, C.pct, C.refr, k).filter(i => P.has(i));
        if (e2.length >= 3) rots.push(Math.abs(mean(e2.map(i => pool.find(o => o.i === i).y)) - base));
    }
    const beat = rots.length ? rots.filter(v => Math.abs(diff) > v).length / rots.length : 0;
    const pass = [E.length >= C.minN, Math.abs(diff) >= C.effect, p <= RULE.alpha, Math.sign(h1) === Math.sign(diff) && Math.sign(h2) === Math.sign(diff),
                  Math.sign(matched) === Math.sign(diff) && Math.abs(matched) >= C.matched, beat > C.rotPct];
    return { n: E.length, base, em, diff, p, h1, h2, matched, beat, rotN: rots.length, dates: E.map(o => o.d), ys: E.map(o => r2(o.y)), pass, ok: pass.every(Boolean) };
}

// ───────────────────────────── 讀檔
export function loadBtc(file) {
    const buf = fs.readFileSync(file);
    const j = JSON.parse((buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf).toString('utf8'));
    if (!j || !Number.isFinite(j.t0) || !Array.isArray(j.c) || j.step !== H) throw new Error('btc_1h.json.gz 格式不對(要有 t0 / step 3600 / c[])');
    return j;
}
export function load0050(files) {
    const m = new Map();
    for (const f of files) {
        if (!f || !fs.existsSync(f)) continue;
        for (const r of JSON.parse(fs.readFileSync(f, 'utf8'))) { const d = d10(r.date); if (+r.open > 0 && +r.close > 0 && !m.has(d)) m.set(d, { d, o: +r.open, c: +r.close }); }
    }
    return [...m.values()].sort((a, b) => a.d < b.d ? -1 : 1);
}
export function loadK0050(spec) {
    const out = new Map();
    for (const dir of String(spec || '').split(':').filter(Boolean)) {
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}\.json\.gz$/.test(f)).sort()) {
            const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, f))).toString());
            for (const [d, v] of Object.entries(j.d || {})) { const b = v && v.k && v.k['0050']; if (b && !out.has(d)) out.set(d, b); }
        }
    }
    return out;
}

/** 截到封存日(含)→ 判定只用這些 */
export function sealBtc(B, cut) {
    const end = utc(cut) + 86400;      // 封存日隔天 00:00 UTC(= 封存日那天台北 08:00 之後的都不要)
    const n = Math.max(0, Math.min(B.c.length, (end - B.t0) / H - 1));
    return { ...B, c: B.c.slice(0, n) };
}

export function run(inp, log = console.log) {
    const cut = RULE.cut, B = sealBtc(inp.btc, cut);
    const b50 = inp.b50.filter(b => b.d <= cut), TD = b50.map(b => b.d), prev = new Map(TD.map((d, i) => [d, TD[i - 1] || null]));
    const bench = benchFactory(b50, inp.divs || []);
    const out = { rule: RULE, cut, judged: {}, desc: {} };
    // A
    const rows = (inp.dump || []).filter(r => r.d <= cut && r.d >= isoD(B.t0 + 2 * 86400)).map(r => {
        const w = btcWindow(B, r.d, r.usd, prev.get(r.d));
        return { d: r.d, s: r.s, gap: r.gap, io: r.io, bx: w ? w.x : null, bh: w ? w.h : null };
    });
    const A1 = judgeA(rows, false), A2 = judgeA(rows, true);
    out.judged.A1 = A1; out.judged.A2 = A2;
    const fA = (nm, J) => {
        log(`  ${nm}:${J.n} 天・${J.years} 年(要 ≥ ${J.need} 年)・主格 2%×1 名次相關 ${J.main.a}/${J.years}、方向猜對 ${J.main.b}/${J.years}`
            + `・方向猜對 ${f1(J.main.hit0)}% → ${f1(J.main.hit1)}%・名次相關 ${f3(J.main.rho0)} → ${f3(J.main.rho1)}・講話天數${J.main.callOk ? '夠' : '不夠'}`);
        log(`     旁邊 5 格過 ${J.nbr}・有沒有一格變差 ${J.noNeg ? '沒有' : '有'}・逐年樣本外 ${J.wf.w}/${J.wf.n}(${J.wf.list.join(' ')})・扣掉分數後比特幣 vs 開盤 偏相關 ${f3(J.pp.rho)}(p ${J.pp.p.toFixed(4)})・拿掉最極端 1% 後 ${f3(J.trimGain)}`);
        log(`     → ${J.pass.map(x => x ? '✓' : '✗').join('')} ${J.ok ? '✅ 過' : '⛔ 沒過'}`);
        for (const c of J.cells) log(`     格 ${c.dz}%×${c.w}:相關 ${c.a}/${c.n}・方向 ${c.b}/${c.n}・全期相關 ${c.gain >= 0 ? '+' : ''}${c.gain.toFixed(4)}・${c.pass ? '✓' : '✗'}`);
    };
    log(`₿ 比特幣 × 台股(判定資料到 ${cut};比特幣每小時 ${isoD(B.t0)} ~ ${isoD(B.t0 + B.c.length * H)})`);
    log('⭐ ① 盤前:美股收盤後 → 台北 08:00 那段比特幣,疊在 App 盤前分數上(結果 = 0050 開盤跳空)');
    fA('A1 全部日子', A1); fA('A2 只算週末 / 美國休市後(區間 ≥ 24 小時)', A2);
    // B
    const K = inp.k0050 || new Map(), Brows = [];
    for (const [d, bars] of [...K.entries()].sort()) {
        if (d > cut) continue;
        const db = dayBars(bars); if (!db) continue;
        const a = px(B, utc(d) + 1 * H), b = px(B, utc(d) + 2 * H); if (!a || !b) continue;
        Brows.push({ d, x: (b / a - 1) * 100, z: (db.c595 / db.open - 1) * 100, y: (db.last / db.c600 - 1) * 100 });
    }
    const JB = judgeB(Brows); out.judged.B = JB;
    log('⭐ ② 盤中:比特幣 09:00→10:00 → 0050 10:05→收盤(扣掉 0050 自己 09:00→10:00)');
    if (JB.pp) log(`  ${JB.n} 天・偏相關 ${f3(JB.pp.rho)}(p ${JB.pp.p.toFixed(4)})・前半 ${f3(JB.h1)} / 後半 ${f3(JB.h2)}・同方向的年 ${JB.ysame}/${JB.yr.length}・比特幣最強五分之一 − 最弱五分之一 ${f2(JB.spread)} 個百分點 → ${JB.pass.map(x => x ? '✓' : '✗').join('')} ${JB.ok ? '✅ 過' : '⛔ 沒過'}`);
    else log(`  只有 ${JB.n} 天 → 判樣本不夠`);
    // C
    const pctMap = btcPctSeries(B, isoD(B.t0 + 86400), cut);
    const ret20prior = i => i >= 21 ? (b50[i - 1].c / b50[i - 21].c - 1) * 100 : null;
    const JC = judgeC(TD, pctMap, bench, ret20prior); out.judged.C = JC;
    log('⭐ ③ 信心:比特幣 20 天漲跌在過去一年最低 5% → 0050 之後 20 個交易日(含息,開盤進)vs 所有日子');
    if (JC.pass.length > 1) log(`  ${JC.n} 次・${f2(JC.em)}% vs ${f2(JC.base)}% → ${f2(JC.diff)} 個百分點(p ${JC.p.toFixed(4)})・前半 ${f2(JC.h1)} / 後半 ${f2(JC.h2)}・跟台股前 20 天同一級比 ${f2(JC.matched)}・比 ${(JC.beat * 100).toFixed(0)}% 的循環挪動極端 → ${JC.pass.map(x => x ? '✓' : '✗').join('')} ${JC.ok ? '✅ 過' : '⛔ 沒過'}`);
    else log(`  只有 ${JC.n} 次 → 判樣本不夠`);
    if (JC.dates) log(`    事件日:${JC.dates.map((d, k) => `${d} ${JC.ys[k] >= 0 ? '+' : ''}${JC.ys[k]}%`).join('、')}`);
    // ── 只描述
    log('・只描述(⛔ 拿來判):');
    const C60 = judgeC(TD, pctMap, bench, ret20prior, { h: 60 }), Chi = judgeC(TD, pctMap, bench, ret20prior, { side: 'hi' });
    out.desc.C60 = C60; out.desc.Chi = Chi;
    if (C60.pass.length > 1) log(`  ③ 換成 60 天:${C60.n} 次 ${f2(C60.em)}% vs ${f2(C60.base)}% → ${f2(C60.diff)}`);
    if (Chi.pass.length > 1) log(`  ③ 大漲那一側(20 天漲幅在過去一年最高 5%):${Chi.n} 次 ${f2(Chi.em)}% vs ${f2(Chi.base)}% → ${f2(Chi.diff)}`);
    // 同一天同步:台北 14:00 → 14:00 比特幣 vs 0050 收盤到收盤
    const co = {};
    for (let i = 1; i < b50.length; i++) {
        const d = b50[i].d, pd = b50[i - 1].d, a = px(B, utc(pd) + 6 * H), b = px(B, utc(d) + 6 * H); if (!a || !b) continue;
        (co[d.slice(0, 4)] = co[d.slice(0, 4)] || [[], []])[0].push((b / a - 1) * 100); co[d.slice(0, 4)][1].push((b50[i].c / b50[i - 1].c - 1) * 100);
    }
    out.desc.co = Object.fromEntries(Object.entries(co).map(([y, [x, z]]) => [y, { n: x.length, rho: r2(spearman(x, z) * 100) / 100 }]));
    log(`  同一天同步(比特幣台北 14:00→14:00 vs 0050 收盤→收盤,名次相關):${Object.entries(out.desc.co).map(([y, v]) => `${y} ${v.rho >= 0 ? '+' : ''}${v.rho.toFixed(2)}`).join('・')}`);
    // 比特幣 24 小時(到台北 08:00)漲跌 ≥ 5% 的日子 → 0050 當天跳空 / 開盤到收盤 / 5 天
    const big = { up: [], dn: [], all: [] };
    for (let i = 1; i < b50.length; i++) {
        const d = b50[i].d, a = px(B, utc(d) - 24 * H), b = px(B, utc(d)); if (!a || !b) continue;
        const x = (b / a - 1) * 100, o = { gap: (b50[i].o / b50[i - 1].c - 1) * 100, io: (b50[i].c / b50[i].o - 1) * 100, d5: bench(d, 4) };
        big.all.push(o); if (x >= 5) big.up.push(o); else if (x <= -5) big.dn.push(o);
    }
    const sm = A => ({ n: A.length, gap: r2(mean(A.map(o => o.gap))), io: r2(mean(A.map(o => o.io))), d5: r2(mean(A.filter(o => o.d5 != null).map(o => o.d5))),
                       gapDn: r2(A.filter(o => o.gap < -0.3).length / (A.length || 1) * 100), gapUp: r2(A.filter(o => o.gap > 0.3).length / (A.length || 1) * 100) });
    out.desc.big = { up: sm(big.up), dn: sm(big.dn), all: sm(big.all) };
    for (const [k, nm] of [['dn', '比特幣 24 小時跌 ≥ 5%'], ['up', '比特幣 24 小時漲 ≥ 5%'], ['all', '所有日子']]) {
        const v = out.desc.big[k]; log(`  ${nm}:${v.n} 天・0050 開低 ${v.gapDn}% / 開高 ${v.gapUp}%・跳空平均 ${v.gap}%・開盤到收盤 ${v.io}%・5 天 ${v.d5}%`);
    }
    // FRED CBBTCUSD 是一天裡哪個時間點(方法紀錄)
    if (inp.fred) {
        const fd = Object.entries(inp.fred).filter(([d, v]) => d >= '2017-01-01' && d <= cut && +v > 0);
        const best = [];
        for (let hr = 0; hr < 48; hr++) {
            const e = fd.map(([d, v]) => { const p = px(B, utc(d) + hr * H); return p ? Math.abs(+v / p - 1) : null; }).filter(x => x != null);
            if (e.length > 100) best.push([hr, med(e)]);
        }
        best.sort((a, b) => a[1] - b[1]);
        out.desc.fred = best.slice(0, 3).map(([hr, e]) => ({ utcH: hr, medErr: +(e * 100).toFixed(3) }));
        if (best.length) log(`  FRED CBBTCUSD 最接近「那個日期 + ${best[0][0]} 小時(UTC)」那一刻的價(中位差 ${(best[0][1] * 100).toFixed(3)}%)→ 次接近 ${best.slice(1, 3).map(([h, e]) => `+${h}h ${(e * 100).toFixed(3)}%`).join('、')}`);
    }
    return out;
}
const f1 = v => Number.isFinite(v) ? v.toFixed(1) : '—', f2 = v => Number.isFinite(v) ? v.toFixed(2) : '—', f3 = v => Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(3) : '—';

/** 現在(封存期,只描述):最後幾天的比特幣 20 天位置、週一那段 */
export function nowState(btc, b50) {
    const last = isoD(btc.t0 + btc.c.length * H - H);
    const pm = btcPctSeries(btc, addD(last, -800), last), ks = [...pm.keys()].sort(), k = ks.at(-1);
    return { asof: last, d: k, ...(pm.get(k) || {}) };
}

// ───────────────────────────── selftest(合成世界,⛔ 碰真資料)
function synth(seed, opt = {}) {
    const R = rng(seed), g = () => { let s = 0; for (let i = 0; i < 6; i++) s += R(); return s - 3; };
    const t0 = utc('2015-06-01'), nH = Math.floor((utc('2027-01-31') - t0) / H);
    const c = new Array(nH); let p = 1000;
    for (let k = 0; k < nH; k++) { p *= 1 + g() * 0.006; c[k] = Math.round(p * 100) / 100; }
    const btc = { v: 1, t0, step: H, c };
    const TD = []; for (let d = '2016-01-04'; d <= '2026-12-31'; d = addD(d, 1)) { const w = new Date(utc(d) * 1000).getUTCDay(); if (w && w < 6) TD.push(d); }
    const usHol = new Set(['2018-01-15', '2019-01-21', '2020-01-20', '2021-01-18', '2022-01-17', '2023-01-16', '2024-01-15', '2025-01-20']);
    const usdOf = d => { let u = addD(d, -1); for (let k = 0; k < 6; k++) { const w = new Date(utc(u) * 1000).getUTCDay(); if (w && w < 6 && !usHol.has(u)) return u; u = addD(u, -1); } return u; };
    // 台股:分數 s(−8..8 的整數)、跳空 gap、開盤到收盤 io;plant = 比特幣那段多少比例進跳空
    const b50 = [], dump = []; let cl = 100;
    const pctC = opt.plantC ? btcPctSeries(btc, '2015-06-02', '2026-12-31') : null;
    let drift = 0, until = -1, last = -1e9;
    for (let i = 0; i < TD.length; i++) {
        const d = TD[i], usd = usdOf(d), prevTW = TD[i - 1] || null, s = Math.round(g() * 4);
        let w = prevTW ? btcWindow(btc, d, usd, prevTW, opt.peekA ? H : 0) : null;
        let bx = w ? w.x : 0;
        if (opt.peekA) { const a = px(btc, utc(d)), b = px(btc, utc(d) + H); bx = a && b ? (b / a - 1) * 100 : 0; }
        const gap = 0.12 * s + (opt.plantA ? opt.plantA * bx : 0) + g() * 0.5;
        if (opt.plantC && pctC && pctC.has(d) && pctC.get(d).pct <= 5 && i - last >= RULE.C.refr) { until = i + RULE.C.h; last = i; }
        drift = opt.plantC && i <= until ? -0.004 : 0;
        const o = cl * (1 + gap / 100), cc = o * (1 + (g() * 0.8 + drift * 100) / 100);
        b50.push({ d, o: Math.round(o * 100) / 100, c: Math.round(cc * 100) / 100 }); cl = cc;
        if (prevTW) dump.push({ d, s, gap: (o / b50[i - 1].c - 1) * 100, io: (cc / o - 1) * 100, usd });
    }
    // 0050 5 分 K:z = 09:00→10:00、y = 10:05→收盤;plantB = 比特幣 09:00→10:00 帶到 y;coB = 只跟 09:00→10:00 同步
    const k0050 = new Map();
    for (const d of TD.filter(d => d >= '2021-05-03')) {
        const a = px(btc, utc(d) + H), b = px(btc, utc(d) + 2 * H); const x = a && b ? (b / a - 1) * 100 : 0;
        const bars = []; let q = 100;
        for (let m = 540; m <= 810; m += 5) {
            let r = g() * 0.1;
            if (m < 600 && opt.coB) r += x * opt.coB / 12;
            if (m >= 605 && opt.plantB) r += x * opt.plantB / 41;
            const o = q; q = q * (1 + r / 100); bars.push([m, o, Math.max(o, q), Math.min(o, q), q, 1]);
        }
        k0050.set(d, bars);
    }
    return { btc, b50, dump, k0050, TD };
}

function selftest() {
    let bad = 0; const ok = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + x}`); if (!c) bad++; };
    // ① 某一刻的價 = 前一小時那根
    const B1 = { t0: utc('2024-03-04') - 2 * H, step: H, c: [100, 200, 300, null, null, null, 700] };
    ok('① 08:00(UTC 00:00)的價 = 開始於 23:00 那根(c[1] = 200)⛔ 開始於 00:00 那根', px(B1, utc('2024-03-04')) === 200, String(px(B1, utc('2024-03-04'))));
    // c[k] = t0 + (k+1) 小時那一刻 → 01:00 = c[2] = 300、02:00~04:00 = null、05:00 = c[6] = 700
    ok('① 那根沒有 → 往前最多 2 根(03:00 → 01:00 那根 300);往前 3 根都沒有(04:00)→ null', px(B1, utc('2024-03-04') + 3 * H) === 300 && px(B1, utc('2024-03-04') + 4 * H) === null && px(B1, utc('2024-03-04') + 5 * H) === 700,
       `${px(B1, utc('2024-03-04') + 3 * H)} / ${px(B1, utc('2024-03-04') + 4 * H)} / ${px(B1, utc('2024-03-04') + 5 * H)}`);
    // ② 夏令時間
    const hh = d => (nyClose(d) - utc(d)) / H;
    ok('② 紐約收盤:2024-03-08 冬令 21:00 UTC、03-11 夏令 20:00、11-01 夏令 20:00、11-04 冬令 21:00', hh('2024-03-08') === 21 && hh('2024-03-11') === 20 && hh('2024-11-01') === 20 && hh('2024-11-04') === 21,
       [hh('2024-03-08'), hh('2024-03-11'), hh('2024-11-01'), hh('2024-11-04')].join(','));
    // ③ 區間長度
    const S0 = synth(1);
    const wT = btcWindow(S0.btc, '2024-03-05', '2024-03-04', '2024-03-04'), wM = btcWindow(S0.btc, '2024-03-11', '2024-03-08', '2024-03-08'), wH = btcWindow(S0.btc, '2024-01-16', '2024-01-12', '2024-01-15');
    ok('③ 區間:週二 3 小時(夏令前 21:00→00:00)・週一 51 小時・美國週一休市隔天 18 小時(從台股週一 14:00 起)', wT.h === 3 && wM.h === 51 && wH.h === 18, `${wT.h} / ${wM.h} / ${wH.h}`);
    // ④ A 埋效果 → 判得出;沒埋 → 判不出
    const P = synth(3, { plantA: 0.25 }), Z = synth(3);
    const toRows = S => { const prev = new Map(S.TD.map((d, i) => [d, S.TD[i - 1] || null])); return S.dump.map(r => { const w = btcWindow(S.btc, r.d, r.usd, prev.get(r.d)); return { ...r, bx: w ? w.x : null, bh: w ? w.h : null }; }); };
    const jP = judgeA(toRows(P), false), jZ = judgeA(toRows(Z), false);
    ok('④ A 埋了「比特幣那段 → 開盤」→ ✅ 全部過', jP.ok, JSON.stringify({ pass: jP.pass, a: jP.main.a, b: jP.main.b, need: jP.need, pp: jP.pp }));
    ok('④ A 決定性對照:同一個世界沒埋 → ⛔', !jZ.ok, JSON.stringify({ pass: jZ.pass, pp: jZ.pp }));
    // ⑤ 偷看未來:跳空其實是 08:00→09:00 那一小時造成的 → 正確的區間(到 08:00)⛔ 抓到;注入「用到 09:00」才抓到
    const L = synth(5, { plantA: 0.3, peekA: true });
    const rowsL = toRows(L), jL = judgeA(rowsL, false);
    const prevL = new Map(L.TD.map((d, i) => [d, L.TD[i - 1] || null]));
    const rowsPeek = L.dump.map(r => { const w = btcWindow(L.btc, r.d, r.usd, prevL.get(r.d), H); return { ...r, bx: w ? w.x : null, bh: w ? w.h : null }; });
    ok('⑤ ⛔ 前視:跳空來自 08:00→09:00 那一小時 → 正確區間判 ⛔;注入「區間多算到 09:00」→ 判得出(證明那一小時真的會偷看)', !jL.ok && judgeA(rowsPeek, false).pp.rho > jL.pp.rho + 0.05,
       JSON.stringify({ ok: jL.ok, rho: jL.pp.rho, peek: judgeA(rowsPeek, false).pp.rho }));
    // ⑥ B 埋 / 沒埋 / 同步注入
    const bRows = S => { const out = []; for (const [d, bars] of S.k0050) { const db = dayBars(bars); const a = px(S.btc, utc(d) + H), b = px(S.btc, utc(d) + 2 * H); if (db && a && b) out.push({ d, x: (b / a - 1) * 100, z: (db.c595 / db.open - 1) * 100, y: (db.last / db.c600 - 1) * 100, yAll: (db.last / db.open - 1) * 100 }); } return out; };
    const PB = bRows(synth(7, { plantB: 0.6 })), ZB = bRows(synth(7, { coB: 0.6 }));
    ok('⑥ B 埋了「09:00→10:00 比特幣 → 10:05 之後的 0050」→ ✅', judgeB(PB).ok, JSON.stringify(judgeB(PB).pass));
    ok('⑥ B 只有「同一小時同步」(10:00 之後沒關係)→ ⛔', !judgeB(ZB).ok, JSON.stringify(judgeB(ZB).pass));
    const ZBi = ZB.map(r => ({ ...r, y: r.yAll, z: 0 }));
    ok('⑥ B 注入「結果從 09:00 算、⛔ 扣同一小時」→ 同步被當成領先(證明扣掉 09:00→10:00 是必要的)', judgeB(ZBi).pp.rho > 0.3, String(judgeB(ZBi).pp.rho));
    // ⑦ C 埋 / 沒埋 / 安慰劑
    const cJ = S => { const bench = benchFactory(S.b50, []); const pm = btcPctSeries(S.btc, '2015-06-02', '2026-11-06'); const TD = S.b50.filter(b => b.d <= '2026-11-06'); return judgeC(TD.map(b => b.d), pm, (d, h) => { const v = bench(d, h); return v; }, i => i >= 21 ? (TD[i - 1].c / TD[i - 21].c - 1) * 100 : null); };
    const jC = cJ(synth(11, { plantC: true }));
    ok('⑦ C 埋了「比特幣大跌之後 20 天多跌」→ ✅', jC.ok, JSON.stringify({ n: jC.n, diff: jC.diff, p: jC.p, pass: jC.pass }));
    const placebo = [21, 22, 23, 24, 25, 26].map(sd => cJ(synth(sd)));
    const pm6 = mean(placebo.map(j => j.diff ?? 0));
    ok('⑦ C 沒埋的 6 個亂數世界:平均差距 ≈ 0(|平均| < 1 個百分點)、6 個全部 ⛔', Math.abs(pm6) < 1 && placebo.every(j => !j.ok), JSON.stringify({ pm6, v: placebo.map(j => j.ok) }));
    const ev = eventsC(['a', 'b', 'c', 'd', 'e', 'f'], new Map([['a', { pct: 1 }], ['b', { pct: 2 }], ['c', { pct: 50 }], ['f', { pct: 1 }]]), 'lo', 5, 3);
    ok('⑦ 事件之後隔 refr 個交易日才算下一次(連著幾天只算第一天)', JSON.stringify(ev) === '[0,5]', JSON.stringify(ev));
    // ⑧ 一年位置 = 人性頁 yearPos(拿整串算)、⛔ 用到未來
    const S8 = synth(31), pm = btcPctSeries(S8.btc, '2016-01-01', '2018-12-31');
    const allPts = []; for (let d = '2016-01-01'; d <= '2018-12-31'; d = addD(d, 1)) { const i0 = px(S8.btc, utc(d)), i1 = px(S8.btc, utc(addD(d, -20))); if (i0 && i1 && d >= '2016-01-21') allPts.push([d, (i0 / i1 - 1) * 100]); }
    const chk = ['2017-06-01', '2018-02-14', '2018-12-31'].every(d => { const v = pm.get(d); const P = allPts.filter(([x]) => x > addD(d, -365) && x < d); return v && v.pct === yearPos(P, v.r20, d).pct; });
    const pmCut = btcPctSeries({ ...S8.btc, c: S8.btc.c.slice(0, (utc('2018-01-01') - S8.btc.t0) / H) }, '2016-01-01', '2017-12-31');
    ok('⑧ 一年位置跟人性頁 yearPos(整串)一模一樣;砍掉 2018 之後,2017 的位置一個都不變(⛔ 用到未來)', chk && [...pmCut.keys()].every(d => pmCut.get(d).pct === pm.get(d).pct), String(chk));
    // ⑨ 封存:2026-11-06 之後亂改 → 判定一模一樣
    const W = synth(41, { plantA: 0.25 });
    const inp = { btc: W.btc, b50: W.b50, dump: W.dump, k0050: W.k0050, divs: [] };
    ok('⑨ 合成資料真的跨過封存日', W.TD.at(-1) > RULE.cut && W.btc.t0 + W.btc.c.length * H > utc(RULE.cut) + 86400);
    const q = () => {}, key = o => JSON.stringify([o.judged.A1.pass, o.judged.A1.main, o.judged.B.pass, o.judged.C.diff, o.judged.C.pass]);
    const o1 = run(inp, q);
    const kc = (utc(RULE.cut) + 86400 - W.btc.t0) / H;
    const g2 = { btc: { ...W.btc, c: W.btc.c.map((v, k) => k >= kc ? v * (k % 2 ? 3 : 0.3) : v) }, b50: W.b50.map(b => b.d > RULE.cut ? { ...b, o: b.o * 5, c: b.c * 0.2 } : b),
                 dump: W.dump.map(r => r.d > RULE.cut ? { ...r, gap: 99, s: 9 } : r), k0050: new Map([...W.k0050].map(([d, v]) => [d, d > RULE.cut ? v.map(b => [b[0], 1, 1, 1, 1, 1]) : v])), divs: [] };
    ok('⑨ 封存日之後的比特幣 / 0050 / 分數 / 5 分 K 全部亂改 → A / B / C 判定一模一樣', key(o1) === key(run(g2, q)));
    let threw = false; try { loadBtc.call(null, '/nonexistent'); } catch (_) { threw = true; }
    ok('⑩ 讀不到比特幣檔 → 丟例外(⛔ 當成沒事件)', threw);
    console.log(bad ? `\n❌ ${bad} 條沒過` : '\n✅ BTC_TW_SELFTEST_PASS');
    return bad ? 1 : 0;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
    if (process.argv.includes('--selftest')) process.exit(selftest());
    const need = k => { if (!process.env[k]) throw new Error(`${k} 沒給`); return process.env[k]; };
    const btc = loadBtc(need('BTC_HIST'));
    const dump = JSON.parse(fs.readFileSync(need('DUMP'), 'utf8'));
    if (!dump.length || dump[0].usd === undefined) throw new Error('DUMP 沒有 usd 欄(要用 V82.6.7 起的 premkt_app_probe 重產)');
    const b50 = load0050(need('B0050').split(',').filter(Boolean));
    let divs = []; if (process.env.DIV) { const raw = JSON.parse(fs.readFileSync(process.env.DIV, 'utf8')); divs = ((raw.d || raw)['0050'] || {}).h || []; }
    const k0050 = loadK0050(process.env.KBAR5_DIR || '');
    let fred = null; if (process.env.FRED_HIST) { const j = JSON.parse(fs.readFileSync(process.env.FRED_HIST, 'utf8')); fred = ((j.series || {}).btc || {}).d || null; }
    const out = run({ btc, b50, dump, divs, k0050, fred });
    out.now = nowState(btc, b50);
    console.log(`・現在(封存期,只描述):${out.now.d} 比特幣 20 天 ${f2(out.now.r20)}%・一年位置 ${out.now.pct}(資料到 ${out.now.asof})`);
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
}
