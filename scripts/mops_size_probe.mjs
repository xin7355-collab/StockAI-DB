#!/usr/bin/env node
/**
 * 🏛️ V82.7.5 公司公告的「消息大小」→ 之後 20 天(評估紀錄 58 第 2 步;事先登記 EXP-20261128-02,判準照登記寫死、⛔ 跑完再改)
 *
 *   H1 訂單:金額 ÷ 公告日之前已知的最近 12 個月營收(連續 12 個月都要有);hi = ≥ 10%、lo = < 2% → ✅ mean(hi) − mean(lo) ≥ +2.0pp
 *   H2 公司自己的現金增資 / 私募(⛔ 盈餘 / 資本公積轉增資、⛔ 代子公司):金額 ÷ 公告前一個交易日市值(發行股數 × 收盤);
 *      hi = ≥ 10%、lo = < 3%;事先寫方向「hi 比較差」→ ✅ mean(lo) − mean(hi) ≥ +2.0pp
 *   兩題共同(全部成立才 ✅):兩組各 ≥ 50 筆・逐年(那年兩組各 ≥ 5 筆)同向 ≥ 2/3・年內打亂分組 2,000 次 p < 0.05
 *      ・安慰劑(同一檔、日期往前或往後挪 40~120 個交易日、分組不變,每筆 20 次,種子 20261128)的差距比真的少 ≥ 1.0pp
 *      ・門檻高原:hi 門檻 5% / 10% / 20%(lo 固定)三格差距都 ≥ +1.0pp
 *   事件:只收新台幣金額;H1 同一檔 20 個交易日內只算第一則、H2 60 個交易日;事件日與 20 天出場日都 ≤ 2026-11-06(封存)。
 *   報酬 = dispo_backtest.sampleEv 20 天超額(公告日隔一個交易日開盤進、扣同一天全部股票平均;鎖漲停 / 斷崖不算)。
 *
 * 重用(⛔ 第二份):dispo_backtest loadK / buildCtrl / sampleEv / mkIndex・news_consensus_probe lastLE / sealOK
 *   ・營收月份規則同 rev_decline_probe(revenue_year-revenue_month,資料月 M 在 M+1 月 AVAIL=11 日起才算知道)。
 *   ⛔ judge 不借 news_runup_probe 那支:那支的門檻(各 ≥ 30、那年 ≥ 15、比 baseline)跟這次登記的不一樣。
 *
 * 用法:DATA_DIR=<d16> REV_DIR=<stock_deep/rev> SHARE_DIR=<stock_deep/share> DEEP_DIR=<mops_deep> DETAIL_DIR=<mops_detail> \
 *        node --max-old-space-size=8000 scripts/mops_size_probe.mjs out.json
 *       node scripts/mops_size_probe.mjs --selftest(MS_INJECT=peek / nodedupe / noseal / h2all 各自必紅)
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { loadK, buildCtrl, sampleEv, mkIndex } from './dispo_backtest.mjs';
import { lastLE, sealOK } from './news_consensus_probe.mjs';
import { AVAIL as AVAIL0 } from './rev_decline_probe.mjs';

const INJ = process.env.MS_INJECT || '';
export const AVAIL = INJ === 'peek' ? 1 : AVAIL0;     // peek:營收在資料月的下個月 1 號就當作知道(前視,⛔ 正式)
export const RULE = {
    seal: INJ === 'noseal' ? '9999-12-31' : '2026-11-06', h: 20,
    h1: { kind: '訂單', hi: 10, lo: 2, grid: [5, 10, 20], sign: +1, gap: INJ === 'nodedupe' ? 0 : 20 },
    h2: { kind: '增資', hi: 10, lo: 3, grid: [5, 10, 20], sign: -1, gap: INJ === 'nodedupe' ? 0 : 60 },
    minN: 50, minYear: 5, needSame: 2 / 3, diff: 2.0, plcGap: 1.0, plateau: 1.0, nShuf: 2000,
    plcLo: 40, plcHi: 120, plcK: 20, seed: 20261128, cost: 0.44,
};
// H2 只收公司自己的現金增資 / 私募
export const H2_IN = /現金增資|私募/;
// 🩹 V82.7.6(跑真資料之前):「參與 XX(股)公司私募」「擬現金增資中一食品股份有限公司」「間接轉投資(現金增資)」= 投資別家,⛔ 公司自己的增資
//   (登記原文「公司自己的現金增資 / 私募」;⛔ 誤殺「洽由 XX 股份有限公司認購」「認購價格」「董監事放棄認購」「參與發行海外存託憑證」—— 後面要接公司名、中間有發行 / 洽 / 由 / 特定人 / 應募 / 股東就不算)
export const H2_OUT = /盈餘|資本公積|員工|代子公司|子公司|轉投資|(?:參與|認購|增資)(?:(?!發行|洽|由|特定人|應募|股東)[^,，。;；]){0,20}?(?:\(股\)|（股）|股份有限公司|有限公司)/;
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const med = a => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const r2 = x => x == null || !Number.isFinite(x) ? null : +x.toFixed(2);
const lcg = seed => { let s = seed % 2147483647; if (s <= 0) s += 2147483646; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; };
const ymAdd = (ym, k) => { let y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1 + k; y += Math.floor(m / 12); m = ((m % 12) + 12) % 12; return `${y}-${String(m + 1).padStart(2, '0')}`; };

// ── 讀檔 ──
const gz = f => JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString('utf8'));
export function readMonths(dir) { return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}\.json\.gz$/.test(f)).sort().map(f => gz(path.join(dir, f))) : []; }
/** stock_deep/rev/{代號}.json.gz → Map('YYYY-MM' 資料月 → 營收 元) */
export function revMap(j) {
    const m = new Map(); if (!j || !Array.isArray(j.c)) return m;
    const ci = j.c.indexOf('revenue'), cy = j.c.indexOf('revenue_year'), cm = j.c.indexOf('revenue_month');
    for (const v of j.v || []) { const y = +v[cy], mo = +v[cm], r = +v[ci]; if (y > 1990 && mo >= 1 && mo <= 12 && r > 0) m.set(`${y}-${String(mo).padStart(2, '0')}`, r); }
    return m;
}
/** stock_deep/share/{代號}.json.gz → {d:[日期], n:[發行股數]} */
export function shareSeries(j) {
    if (!j || !Array.isArray(j.c)) return null;
    const ci = j.c.indexOf('NumberOfSharesIssued'); if (ci < 0) return null;
    const d = [], n = [];
    for (let k = 0; k < (j.d || []).length; k++) { const v = +((j.v || [])[k] || [])[ci]; if (v > 0) { d.push(j.d[k]); n.push(v); } }
    return { d, n };
}

/** 公告日 d 之前已知的最近 12 個月營收(元):資料月 M 在 M+1 月 AVAIL 日起才算知道;連續 12 個月缺一個 → null */
export function rev12At(rm, d) {
    if (!rm || !rm.size) return null;
    let last = null;
    for (const ym of rm.keys()) { const known = `${ymAdd(ym, 1)}-${String(AVAIL).padStart(2, '0')}`; if (known <= d && (!last || ym > last)) last = ym; }
    if (!last) return null;
    let sum = 0;
    for (let k = 0; k < 12; k++) { const v = rm.get(ymAdd(last, -k)); if (!(v > 0)) return null; sum += v; }
    return { sum, last };
}
/** 公告前一個交易日的市值(元)= 那天(或之前最近一筆)的發行股數 × 那天收盤 */
export function mcapAt(sh, K, d) {
    if (!sh || !K) return null;
    const i = lastLE(K, d); if (i < 0) return null;
    const p = K.dates[i] === d ? i - 1 : i; if (p < 0 || !(K.c[p] > 0)) return null;
    const dp = K.dates[p];
    let lo = 0, hi = sh.d.length - 1, a = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (sh.d[m] <= dp) { a = m; lo = m + 1; } else hi = m - 1; }
    return a < 0 ? null : sh.n[a] * K.c[p];
}

/** mops_detail 列 [代號, 日期, 時間, 類, 億元, 幣別, ev, seq] → 事件;subjOf('代號|日期|時間') → 主旨(H2 要篩) */
export function buildEvents(detailRows, subjOf, H) {
    const out = [];
    for (const r of detailRows) {
        if (!Array.isArray(r) || r[3] !== H.kind || r[5] !== 'TWD' || !(+r[4] > 0) || !/^\d{4}$/.test(String(r[0]))) continue;
        const sub = subjOf(`${r[0]}|${r[1]}|${r[2]}`) || '';
        if (H.kind === '增資' && INJ !== 'h2all' && (!H2_IN.test(sub) || H2_OUT.test(sub))) continue;
        out.push({ sym: String(r[0]), d: r[1], t: r[2], yi: +r[4], sub });
    }
    return out.sort((a, b) => (a.sym === b.sym ? (a.d + a.t < b.d + b.t ? -1 : 1) : (a.sym < b.sym ? -1 : 1)));
}
/** 同一檔 gap 個交易日內只算第一則(cal = 交易日曆) */
export function dedupe(evs, cal, gap) {
    const idx = d => { let lo = 0, hi = cal.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (cal[m] <= d) { a = m; lo = m + 1; } else hi = m - 1; } return a; };
    const out = [], lastOf = new Map();
    for (const e of evs) {
        const i = idx(e.d), p = lastOf.get(e.sym);
        if (gap > 0 && p != null && i - p < gap) continue;
        lastOf.set(e.sym, i); out.push(e);
    }
    return out;
}

/** 一檔的事件 → 樣本列 + 安慰劑。ratioOf(e) → 比值 % 或 null;sample(K, sym, d) → 20 天超額或 null */
export function stockRows(sym, K, evs, ratioOf, sample, H, rnd, R = RULE) {
    const rows = [], plc = [], skip = {};
    const sk = k => { skip[k] = (skip[k] || 0) + 1; };
    for (const e of evs) {
        if (!sealOK(K, e.d, R)) { sk('seal'); continue; }
        const ratio = ratioOf(e); if (ratio == null) { sk('ratio'); continue; }
        const sx = sample(K, sym, e.d), x = sx != null && typeof sx === 'object' ? sx.x : sx;   // sample 回數字或 {x, rx}(rx = 扣加權,只描述)
        if (x == null) { sk('ret'); continue; }
        const g = ratio >= H.hi ? 'hi' : ratio < H.lo ? 'lo' : null;
        rows.push({ sym, d: e.d, y: e.d.slice(0, 4), ratio, x, rx: sx != null && typeof sx === 'object' ? sx.rx : null, g });
        if (!g) continue;
        const i = lastLE(K, e.d); if (i < 0) continue;
        for (let k = 0; k < R.plcK; k++) {
            const off = (R.plcLo + Math.floor(rnd() * (R.plcHi - R.plcLo + 1))) * (rnd() < 0.5 ? -1 : 1);
            const j = i + off; if (j < 25 || j >= K.n - 1) continue;
            const dj = K.dates[j]; if (!sealOK(K, dj, R)) continue;
            const sp = sample(K, sym, dj), xp = sp != null && typeof sp === 'object' ? sp.x : sp; if (xp != null) plc.push({ g, x: xp });
        }
    }
    return { rows, plc, skip };
}

/** 判定(照登記寫死)。sign:H1 +1(hi − lo)、H2 −1(lo − hi) */
export function judgeSize(rows, plc, H, R = RULE) {
    const G = rows.filter(r => r.g);
    const Hx = G.filter(r => r.g === 'hi').map(r => r.x), Lx = G.filter(r => r.g === 'lo').map(r => r.x);
    const base = { nH: Hx.length, nL: Lx.length, mH: r2(mean(Hx)), mL: r2(mean(Lx)), medH: r2(med(Hx)), medL: r2(med(Lx)) };
    if (Hx.length < R.minN || Lx.length < R.minN) return { ...base, verdict: '⛔ 樣本不夠', ok: false };
    const D = (h, l) => H.sign * (mean(h) - mean(l));
    const diff = D(Hx, Lx);
    const yrs = {}; for (const r of G) (yrs[r.y] ||= { hi: [], lo: [] })[r.g].push(r.x);
    const yd = Object.entries(yrs).filter(([, v]) => v.hi.length >= R.minYear && v.lo.length >= R.minYear).map(([y, v]) => [y, D(v.hi, v.lo)]).sort();
    const same = yd.filter(([, v]) => Math.sign(v) === Math.sign(diff) && v !== 0).length;
    const rnd = lcg(R.seed); let ge = 0;
    const groups = Object.values(yrs);
    for (let k = 0; k < R.nShuf; k++) {
        let sh = 0, nh = 0, sl = 0, nl = 0;
        for (const g of groups) {
            const all = [...g.hi, ...g.lo], nH = g.hi.length;
            for (let a = all.length - 1; a > 0; a--) { const b = Math.floor(rnd() * (a + 1)); [all[a], all[b]] = [all[b], all[a]]; }
            all.forEach((x, j) => { if (j < nH) { sh += x; nh++; } else { sl += x; nl++; } });
        }
        if (nh && nl && H.sign * (sh / nh - sl / nl) >= diff) ge++;
    }
    const p = (ge + 1) / (R.nShuf + 1);
    const pH = plc.filter(r => r.g === 'hi').map(r => r.x), pL = plc.filter(r => r.g === 'lo').map(r => r.x);
    const pd = pH.length && pL.length ? D(pH, pL) : null;
    const plateau = H.grid.map(t => {
        const h = rows.filter(r => r.ratio >= t).map(r => r.x), l = rows.filter(r => r.ratio < H.lo).map(r => r.x);
        return { t, d: h.length && l.length ? r2(D(h, l)) : null, nH: h.length, nL: l.length };
    });
    const top5 = (() => { const s = G.slice().sort((a, b) => Math.abs(b.x) - Math.abs(a.x)).slice(5); const h = s.filter(r => r.g === 'hi').map(r => r.x), l = s.filter(r => r.g === 'lo').map(r => r.x); return h.length && l.length ? r2(D(h, l)) : null; })();
    const half = (lo, hi) => { const s = G.filter(r => r.y >= lo && r.y <= hi); const h = s.filter(r => r.g === 'hi').map(r => r.x), l = s.filter(r => r.g === 'lo').map(r => r.x); return h.length && l.length ? r2(D(h, l)) : null; };
    const ex2022 = (() => { const s = G.filter(r => r.y !== '2020' && r.y !== '2022'); const h = s.filter(r => r.g === 'hi').map(r => r.x), l = s.filter(r => r.g === 'lo').map(r => r.x); return h.length && l.length ? r2(D(h, l)) : null; })();
    // 登記 bias.bench / bias.cost:另附扣加權(rawx)的差距、各組扣 0.44% 來回成本 —— 只描述,⛔ 進判定
    const rawx = (() => { const h = G.filter(r => r.g === 'hi' && r.rx != null).map(r => r.rx), l = G.filter(r => r.g === 'lo' && r.rx != null).map(r => r.rx); return h.length && l.length ? r2(D(h, l)) : null; })();
    const cost = { hi: r2(mean(Hx) - R.cost), lo: r2(mean(Lx) - R.cost) };
    const c = {
        diff: diff >= R.diff, years: yd.length > 0 && same / yd.length >= R.needSame, p: p < 0.05,
        plc: pd != null && diff - pd >= R.plcGap, plateau: plateau.every(x => x.d != null && x.d >= R.plateau),
    };
    const ok = Object.values(c).every(Boolean);
    return { ...base, diff: r2(diff), years: yd.map(([y, v]) => `${y}:${r2(v)}`), same, nY: yd.length, p: r2(p),
        plc: r2(pd), nPlc: plc.length, net: pd == null ? null : r2(diff - pd), plateau, check: c, ok,
        desc: { noTop5: top5, y2010_2017: half('2010', '2017'), y2018_2026: half('2018', '2026'), ex2020_2022: ex2022, rawx, cost },
        verdict: ok ? '✅ 照登記全部成立' : `⛔ 沒過:${Object.entries(c).filter(([, v]) => !v).map(([k]) => k).join('、')}` };
}

// ─────────────────────────── 正式跑 ───────────────────────────
export function run(env, log = console.log, R = RULE) {
    const { DATA_DIR: DATA, REV_DIR, SHARE_DIR, DEEP_DIR, DETAIL_DIR } = env;
    const tw = loadK(DATA, '^TWII'); if (!tw) throw new Error('DATA_DIR 裡沒有 ^TWII.json');
    const mktRet = mkIndex({ dates: tw.dates, c: tw.c });
    const syms = fs.readdirSync(DATA).filter(f => /^\d{4}\.json$/.test(f)).map(f => f.slice(0, 4));
    const ctrl = buildCtrl(DATA, syms, mktRet);
    const sample = (K, sym, d) => { const s = sampleEv(K, ctrl, mktRet, sym, d); return s.skip || s.ex[20] == null ? null : { x: s.ex[20], rx: s.rawx[20] }; };
    const det = readMonths(DETAIL_DIR), deep = readMonths(DEEP_DIR);
    const subj = new Map(); for (const m of deep) for (const r of m.rows || []) subj.set(`${r[0]}|${r[2]}|${r[3]}`, r[4]);
    const detRows = det.flatMap(m => m.rows || []);
    const doneDays = det.reduce((s, m) => s + Object.keys(m.done || {}).length, 0);
    log(`🏛️ 內文 ${detRows.length} 則(${det.length} 個月、做完 ${doneDays} 個日子×市場;有金額 ${detRows.filter(r => r[4] != null).length})・對照組 ${ctrl.nStock} 檔・封存 ${R.seal}`);
    const out = { rule: R, nDetail: detRows.length, months: det.length };
    for (const [key, H] of [['H1', R.h1], ['H2', R.h2]]) {
        const evs = dedupe(buildEvents(detRows, k => subj.get(k), H), tw.dates, H.gap);
        const bySym = new Map(); for (const e of evs) { if (!bySym.has(e.sym)) bySym.set(e.sym, []); bySym.get(e.sym).push(e); }
        const rows = [], plc = [], skip = {}, rnd = lcg(R.seed + (key === 'H2' ? 1 : 0));
        for (const [sym, es] of bySym) {
            const K = loadK(DATA, sym); if (!K) { skip.nok = (skip.nok || 0) + es.length; continue; }
            let ratioOf;
            if (key === 'H1') {
                let rm = null; try { rm = revMap(gz(path.join(REV_DIR, `${sym}.json.gz`))); } catch (_) {}
                ratioOf = e => { const R12 = rev12At(rm, e.d); return R12 ? e.yi * 1e8 / R12.sum * 100 : null; };
            } else {
                let sh = null; try { sh = shareSeries(gz(path.join(SHARE_DIR, `${sym}.json.gz`))); } catch (_) {}
                ratioOf = e => { const mc = mcapAt(sh, K, e.d); return mc ? e.yi * 1e8 / mc * 100 : null; };
            }
            const s = stockRows(sym, K, es, ratioOf, sample, H, rnd, R);
            rows.push(...s.rows); plc.push(...s.plc); for (const [k, v] of Object.entries(s.skip)) skip[k] = (skip[k] || 0) + v;
        }
        const J = judgeSize(rows, plc, H, R);
        out[key] = { events: evs.length, used: rows.length, grouped: rows.filter(r => r.g).length, skip, ...J };
        log(`\n${key === 'H1' ? '🅷1 訂單 ÷ 一年營收' : '🅷2 現金增資 / 私募 ÷ 市值'}:事件 ${evs.length}(去重後)・算得出比值 + 報酬 ${rows.length}・跳過 ${JSON.stringify(skip)}`);
        log(`   hi(≥ ${H.hi}%)${J.nH} 筆 平均 ${J.mH}pp(中位 ${J.medH})・lo(< ${H.lo}%)${J.nL} 筆 平均 ${J.mL}pp(中位 ${J.medL})`);
        log(`   ⭐ 判定:差距 ${J.diff}pp・同向年份 ${J.same}/${J.nY}・p ${J.p}・安慰劑 ${J.plc}pp(${J.nPlc} 筆)→ 多 ${J.net}pp・高原 ${(J.plateau || []).map(x => `${x.t}%→${x.d}`).join(' / ')} → ${J.verdict}`);
        log(`   逐年:${(J.years || []).join(' ')}`);
        if (J.desc) log(`   (只描述)拿掉最大 5 筆 ${J.desc.noTop5}・2010~2017 ${J.desc.y2010_2017}・2018~2026 ${J.desc.y2018_2026}・拿掉 2020 / 2022 ${J.desc.ex2020_2022}`
            + `・扣加權的差距 ${J.desc.rawx}・各組扣 ${R.cost}% 來回成本 hi ${J.desc.cost.hi} / lo ${J.desc.cost.lo}`);
    }
    return out;
}

// ─────────────────────────── selftest ───────────────────────────
function selftest() {
    let bad = 0;
    const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + JSON.stringify(e).slice(0, 300)}`); if (!c) bad++; };
    // 交易日曆 2014-01-01 ~ 2026-12-31 的平日
    const cal = []; for (let t = Date.UTC(2014, 0, 1); t <= Date.UTC(2026, 11, 31); t += 86400000) { const d = new Date(t); if (d.getUTCDay() % 6) cal.push(d.toISOString().slice(0, 10)); }
    const mkK = () => ({ dates: cal, n: cal.length, c: new Float64Array(cal.length).fill(100), o: new Float64Array(cal.length).fill(100) });
    // ① 營收已知日:資料月 2016-04 要到 2016-05-11 才算知道
    const rm = new Map(); for (let k = 0; k < 24; k++) rm.set(ymAdd('2015-01', k), 100);
    rm.set('2016-04', 1000);
    const a = rev12At(rm, '2016-05-05'), b = rev12At(rm, '2016-05-12');
    ok('① 營收:5/05 只知道到 3 月(12 個月 1,200)、5/12 才知道 4 月(2,100)', a && a.last === '2016-03' && a.sum === 1200 && b && b.last === '2016-04' && b.sum === 2100, [a, b]);
    const gap = new Map(rm); gap.delete('2015-08');
    ok('① 連續 12 個月缺一個 → null(⛔ 拿 11 個月當一年)', rev12At(gap, '2016-05-12') === null);
    // ② 市值:前一個交易日的股數 × 收盤
    const K0 = mkK(); const iE = cal.indexOf('2016-06-08'); K0.c[iE - 1] = 50; K0.c[iE] = 999;
    const sh = { d: ['2016-01-04', '2016-06-07', '2016-06-08'], n: [1e6, 2e6, 9e9] };
    ok('② 市值 = 公告前一個交易日股數 2,000,000 × 收盤 50(⛔ 當天的股數 / 收盤)', mcapAt(sh, K0, '2016-06-08') === 1e8, mcapAt(sh, K0, '2016-06-08'));
    // ③ 事件:只收新台幣、H2 只收公司自己的現金增資 / 私募
    const subj = { '1101|2016-03-01|10:00:00': '本公司董事會決議辦理現金增資', '1102|2016-03-01|10:00:00': '本公司辦理盈餘轉增資發行新股',
        '1103|2016-03-01|10:00:00': '代子公司公告辦理現金增資', '1104|2016-03-01|10:00:00': '本公司私募普通股定價' };
    const dr = [['1101', '2016-03-01', '10:00:00', '增資', 5, 'TWD', '', '1'], ['1102', '2016-03-01', '10:00:00', '增資', 5, 'TWD', '', '1'],
        ['1103', '2016-03-01', '10:00:00', '增資', 5, 'TWD', '', '1'], ['1104', '2016-03-01', '10:00:00', '增資', 5, 'TWD', '', '1'],
        ['1105', '2016-03-01', '10:00:00', '訂單', 5, 'CNY', '', '1'], ['1106', '2016-03-01', '10:00:00', '訂單', null, null, '', '1']];
    const e2 = buildEvents(dr, k => subj[k], RULE.h2).map(e => e.sym), e1 = buildEvents(dr, k => subj[k], RULE.h1).map(e => e.sym);
    ok('③ H2 只收現金增資 / 私募(1101 / 1104),⛔ 盈餘轉增資(1102)、⛔ 代子公司(1103)', JSON.stringify(e2) === '["1101","1104"]', e2);
    ok('③ 只收新台幣、要有金額(CNY / 沒金額 ⛔)', e1.length === 0, e1);
    const own = s => H2_IN.test(s) && !H2_OUT.test(s);
    ok('③ 🩹 投資別家 ⛔(參與 / 認購 XX(股)公司私募 / 擬現金增資 XX 股份有限公司 / 轉投資);自己的照收(洽由 XX 股份有限公司認購、認購價格、董監事放棄認購)',
       !own('本公司公告董事會決議以15億元為上限，參與聯成化學科技(股) 公司私募普通股。') && !own('補充98/12/18公告本公司認購得利影視(股)公司九十九年度國內 第一次私募普通股。')
       && !own('本公司擬現金增資中一食品股份有限公司') && !own('公告本公司間接轉投資(現金增資)大陸天韻科技(蘇州)有限公司')
       && own('公告本公司董事會決議辦理現金增資發行新股') && own('辦理現金增資發行新股洽由中華開發資本股份有限公司認購') && own('公告訂定現金增資每股認購價格為30.5元')
       && own('本公司現金增資全體董監事放棄認購股數達得認購股數二分之一以上，並洽特定人認購事宜') && own('公告本公司董事會決議114年第一次私募普通股定價及 應募人資訊')
       && own('董事會決議提請股東常會同意授權董事會辦理現金增資 發行普通股參與發行海外存託憑證') && !own('公告本公司擬參與元隆電子股份有限公司私募普通股事宜'));
    // ④ 去重:同一檔 20 個交易日內只算第一則
    const dd = dedupe([{ sym: '2330', d: '2016-03-01' }, { sym: '2330', d: '2016-03-15' }, { sym: '2330', d: '2016-04-15' }, { sym: '2317', d: '2016-03-02' }], cal, RULE.h1.gap);
    ok('④ 去重:3/15 跟 3/01 只隔 10 個交易日 → 拿掉;4/15 留著;別檔不受影響', dd.length === 3 && !dd.some(e => e.d === '2016-03-15'), dd);
    // ⑤ 封存:事件日或 20 天出場日在 2026-11-06 之後 → 不算
    const K5 = mkK();
    ok('⑤ 封存:2026-10-20 的 20 天出場日在 11/06 之後 → 不算;2026-09-01 → 算', !sealOK(K5, '2026-10-20', RULE) && sealOK(K5, '2026-09-01', RULE));
    // ⑥ 判定:種一個效果 + 安慰劑沒有效果 → ✅;決定性對照:沒有效果 → ⛔
    const build = (eff, H) => {
        const rnd = lcg(7), rows = [], plc = [];
        for (const y of ['2016', '2017', '2018', '2019']) for (let k = 0; k < 40; k++) {
            const ratio = k % 2 ? 15 + (k % 3) * 5 : 1, noise = (rnd() - 0.5) * 6;
            const g = ratio >= H.hi ? 'hi' : ratio < H.lo ? 'lo' : null;
            rows.push({ y, d: `${y}-06-01`, ratio, g, x: noise + (g === 'hi' ? eff : 0) });
            for (let j = 0; j < 3; j++) plc.push({ g, x: (rnd() - 0.5) * 6 });
        }
        return { rows, plc };
    };
    const S1 = build(4, RULE.h1), J1 = judgeSize(S1.rows, S1.plc, RULE.h1);
    ok('⑥ H1 種 +4pp(hi 比較好)、安慰劑沒有 → ✅', J1.ok && J1.diff > 3 && J1.p < 0.05 && J1.same === J1.nY, J1);
    const S0 = build(0, RULE.h1), J0 = judgeSize(S0.rows, S0.plc, RULE.h1);
    ok('⑥ 決定性對照:沒有效果 → ⛔', !J0.ok, J0);
    const S2 = build(-4, RULE.h2), J2 = judgeSize(S2.rows, S2.plc, RULE.h2);
    ok('⑥ H2 方向反過來:hi 比較差 4pp → lo − hi ≈ +4 → ✅', J2.ok && J2.diff > 3, J2);
    const S2b = build(4, RULE.h2), J2b = judgeSize(S2b.rows, S2b.plc, RULE.h2);
    ok('⑥ H2 決定性對照:hi 反而比較好 → ⛔(事先寫好的方向)', !J2b.ok && J2b.diff < 0, J2b);
    const thin = judgeSize(S1.rows.slice(0, 60), S1.plc, RULE.h1);
    ok('⑥ 一組不到 50 筆 → ⛔ 樣本不夠', !thin.ok && /樣本不夠/.test(thin.verdict), thin);
    // ⑦ stockRows:比值算不出來 / 封存 → 跳過;安慰劑分組不變
    const K7 = mkK(), evs = [{ sym: 'X', d: '2016-06-01', yi: 1 }, { sym: 'X', d: '2026-10-20', yi: 1 }, { sym: 'X', d: '2016-09-01', yi: 1 }];
    const s7 = stockRows('X', K7, evs, e => (e.d === '2016-09-01' ? null : 20), () => 1, RULE.h1, lcg(3));
    ok('⑦ 封存那則跳過、比值算不出來那則跳過、剩 1 列 hi;安慰劑 20 筆、分組都是 hi', s7.rows.length === 1 && s7.rows[0].g === 'hi' && s7.skip.seal === 1 && s7.skip.ratio === 1
       && s7.plc.length === RULE.plcK && s7.plc.every(p => p.g === 'hi'), s7);
    // ⑧ 只描述的兩個數字(扣加權 / 扣成本)照算,⛔ 影響判定(決定性對照:rx 全部改成反方向,判定一模一樣)
    const S8 = build(4, RULE.h1), rowsA = S8.rows.map(r => ({ ...r, rx: r.x + 1 })), rowsB = S8.rows.map(r => ({ ...r, rx: -r.x }));
    const JA = judgeSize(rowsA, S8.plc, RULE.h1), JB = judgeSize(rowsB, S8.plc, RULE.h1);
    ok('⑧ 扣加權的差距 = hi − lo(rx 版)、各組扣 0.44%;rx 反過來 → 判定一模一樣(只描述)',
       JA.desc.rawx === JA.diff && JB.desc.rawx === -JA.diff && JA.verdict === JB.verdict && JA.ok === JB.ok && JA.desc.cost.hi === Math.round((JA.mH - 0.44) * 100) / 100, [JA.desc, JB.desc, JA.diff]);
    const s8 = stockRows('X', mkK(), [{ sym: 'X', d: '2016-06-01', yi: 1 }], () => 20, () => ({ x: 2, rx: 3 }), RULE.h1, lcg(3));
    ok('⑧ sample 回 {x, rx}:列上 x 用超額、rx 另外帶著;安慰劑只用 x', s8.rows.length === 1 && s8.rows[0].x === 2 && s8.rows[0].rx === 3 && s8.plc.every(p => p.x === 2), s8.rows);
    console.log(bad ? `\n❌ ${bad} 條沒過` : '\n✅ 全部通過');
    return bad ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.includes('--selftest')) process.exit(selftest());
    const need = ['DATA_DIR', 'REV_DIR', 'SHARE_DIR', 'DEEP_DIR', 'DETAIL_DIR'].filter(k => !process.env[k]);
    if (need.length) { console.error(`❌ 要設 ${need.join(' / ')}(跑法見檔頭)`); process.exit(1); }
    const out = run(process.env);
    const f = process.argv.slice(2).find(a => a.endsWith('.json'));
    if (f) fs.writeFileSync(f, JSON.stringify(out, null, 1));
}
