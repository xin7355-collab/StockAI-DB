#!/usr/bin/env node
/**
 * 🧭 grs「四大買賣點」(toomore/grs BestFourPoint,外部評估㊾)有沒有用 —— V79.0.6
 *
 * 四大買點:B1 量大收紅(今天量 > 昨天量 且 收 > 開)・B2 量縮價不跌(今天量 < 昨天量 且 收 > 昨收)
 *          B3 三日均價由下往上(3 日均剛轉上)・B4 三日均價 > 六日均價
 * 四大賣點:S1 量大收黑 ・S2 量縮價跌 ・S3 三日均價由上往下 ・S4 三日均價 < 六日均價
 * ⚠️ B1 要量增、B2 要量縮 → 「四條同時成立」**物理上不可能** → 改測「三條同時」(B1 或 B2 + B3 + B4)
 * ⚠️ grs 的合併判斷還要「3 日 / 6 日乖離在轉折點」—— 這裡用「乖離昨天是谷底(<0)今天翻上」近似,⛔ 不是逐字照抄
 *
 * 口徑(本站一律):訊號日收盤之後才知道 → **隔天開盤**買、抱 H 天收盤賣;
 *   隔天開盤就在漲停附近(≥ 昨收 +9.5%)= 買不到 → 剔除並計數;
 *   對照 = **同一天**全部股票同樣買法的平均(大盤抵銷);同一檔同一條 10 日內只算一次;
 *   量的基準只跟**昨天**比(⛔ 不含今天,陷阱 #43)。
 *
 * 🔁 V80.1.3「精確版」(19 個專案評估 4-3,照 twstock analytics.py BestFourPoint 逐條對):
 *   B2x = 量縮 且 收盤 > **前一天開盤**(我們舊版用前一天收盤)
 *   GRSx = 任一買點(B1 / B2x / B3 / B4)且「最近 5 天的 3 日均 − 6 日均全部 < 0、最低那天在 1~2 天前」
 *          (twstock ma_bias_ratio_pivot:用差值不是比率;同一個最低值取第一次出現)
 *   隔天開盤買不到的判斷改用 lib_limit(2015-06 以前漲跌停 7%;舊版寫死 9.5%,陷阱 #52)
 * 用法:DATA_DIR=<修好日 K 的目錄> node scripts/bestfour_probe.mjs [out.json]
 *       node scripts/bestfour_probe.mjs --selftest
 */
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { baseAdd, increments, gates, negate, fmtG } from './lib_evgate.mjs';
import { limitOf } from './lib_limit.mjs';

const HOLDS = [5, 10, 20], HI = 1, DEDUP = 10;
const D = s => String(s || '').slice(0, 10).replace(/\//g, '-');

/** rows → 精簡陣列(價格 Float64Array、日期共用同一個字串)—— 16 年 2,400 檔整份載入時省記憶體(結果逐位相同) */
const _dtPool = new Map();
export function compact(rows) {
    const n = rows.length, o = new Float64Array(n), h = new Float64Array(n), l = new Float64Array(n), c = new Float64Array(n), v = new Float64Array(n), dt = new Array(n);
    for (let i = 0; i < n; i++) {
        const r = rows[i];
        o[i] = +r.open; h[i] = +r.high; l[i] = +r.low; c[i] = +r.close; v[i] = +r.volume || 0;
        const d = D(r.date);
        let p = _dtPool.get(d);
        if (p === undefined) { _dtPool.set(d, d); p = d; }
        dt[i] = p;
    }
    return { n, o, h, l, c, v, dt };
}

/** 一檔股票 → 每一天每一條規則亮不亮(⛔ 只用 ≤ i 的資料) */
export function rulesAt(o, h, l, c, v, i, opt = {}) {
    const k = opt.volK ?? 1;
    if (i < 7) return null;
    const ma = (n, j) => { let s = 0; for (let t = j - n + 1; t <= j; t++) s += c[t]; return s / n; };
    const m3 = ma(3, i), m3a = ma(3, i - 1), m3b = ma(3, i - 2), m6 = ma(6, i), m6a = ma(6, i - 1), m6b = ma(6, i - 2);
    const bias = m3 / m6 - 1, biasA = m3a / m6a - 1, biasB = m3b / m6b - 1;
    const B1 = v[i] > v[i - 1] * k && c[i] > o[i];
    const B2 = v[i] < v[i - 1] && c[i] > c[i - 1];
    const B3 = m3 > m3a && m3a <= m3b;
    const B4 = m3 > m6;
    const S1 = v[i] > v[i - 1] * k && c[i] < o[i];
    const S2 = v[i] < v[i - 1] && c[i] < c[i - 1];
    const S3 = m3 < m3a && m3a >= m3b;
    const S4 = m3 < m6;
    const anyB = B1 || B2 || B3 || B4, anyS = S1 || S2 || S3 || S4;
    // 🔁 精確版(twstock):B2 跟前一天「開盤」比;乖離谷底 = 最近 5 天 (3 日均 − 6 日均) 全負、最低在 1~2 天前
    const B2x = v[i] < v[i - 1] && c[i] > o[i - 1];
    let minsBias = false;
    if (i >= 9) {
        const smp = [4, 3, 2, 1, 0].map(k => ma(3, i - k) - ma(6, i - k));
        const mn = Math.min(...smp), at = smp.indexOf(mn);
        minsBias = Math.max(...smp) < 0 && at >= 2 && at <= 3;
    }
    return {
        B1, B2, B3, B4, S1, S2, S3, S4,
        B3x: (B1 || B2) && B3 && B4,                         // 三條同時(四條不可能)
        X36: m3 > m6 && m3a <= m6a,                          // 3 日均剛上穿 6 日均(B4 的「剛發生」版)
        GRS: anyB && biasA < 0 && biasA <= biasB && bias > biasA,   // 近似 grs 合併:乖離谷底翻上 + 任一買點
        BnoS: anyB && !anyS,
        B2x, GRSx: (B1 || B2x || B3 || B4) && minsBias,
    };
}

/** universe: [{sym, rows}] → {events: {rule: [{d:[日期編號], r:[報酬]} per hold]}, base: [Map per hold], skip, dStr}
 *  ⭐ 事件存成兩條數字陣列(⛔ 每筆一個物件)—— 16 年全市場 14 條規則 × 3 個天期約 4 千萬筆,存物件 2.5 GB 會爆;要用時 evList() 一次轉一條
 *  opt.only = Set(規則):只收這幾條(高原那幾輪只看 B1) */
export function scan(universe, opt = {}) {
    const base = HOLDS.map(() => new Map()), events = {}, last = {}, skip = { lock: 0, bad: 0 };
    const dPool = new Map(), dStr = [];
    const di = d => { let x = dPool.get(d); if (x === undefined) { x = dStr.length; dStr.push(d); dPool.set(d, x); } return x; };
    const add = (rule, sym, i, d, rets) => {
        if (opt.only && !opt.only.has(rule)) return;
        const key = rule + '|' + sym;
        if (last[key] != null && i - last[key] < DEDUP) return;
        last[key] = i;
        const E = events[rule] || (events[rule] = HOLDS.map(() => ({ d: [], r: [] })));
        const x = di(d);
        rets.forEach((r, k) => { if (r != null) { E[k].d.push(x); E[k].r.push(r); } });
    };
    for (const u of universe) {
        const sym = u.sym, { n, o, h, l, c, v, dt } = u.A || compact(u.rows);   // loadUniverse 已經轉好(省記憶體);selftest 給 rows
        for (let i = 7; i < n - 1; i++) {
            if (!(c[i] > 0) || !(o[i] > 0) || !(c[i - 1] > 0)) { skip.bad++; continue; }
            const e = o[i + 1];
            if (!(e > 0)) { skip.bad++; continue; }
            if (e >= c[i] * (1 + limitOf(dt[i + 1]) - 0.005)) { skip.lock++; continue; }   // 隔天開在漲停附近 = 買不到(lib_limit:2015-06 前 7%)
            const rets = HOLDS.map(H => (i + H < n && c[i + H] > 0) ? (c[i + H] / e - 1) * 100 : null);
            rets.forEach((r, k) => { if (r != null) baseAdd(base[k], dt[i], r); });
            const R = (opt.rulesAt || rulesAt)(o, h, l, c, v, i, opt);
            if (!R) continue;
            for (const [k2, on] of Object.entries(R)) if (on) add(k2, sym, i, dt[i], rets);
        }
    }
    return { events, base, skip, dStr };
}

/** 一條規則一個天期 → [{d, r}](給 lib_evgate.increments;用完就丟,⛔ 一次全部轉) */
export function evList(S, rule, hi) {
    const E = S.events[rule] && S.events[rule][hi];
    if (!E) return [];
    const out = new Array(E.r.length);
    for (let j = 0; j < E.r.length; j++) out[j] = { d: S.dStr[E.d[j]], r: E.r[j] };
    return out;
}

const NAMES = {
    B1: 'B1 量大收紅', B2: 'B2 量縮價不跌', B3: 'B3 三日均轉上', B4: 'B4 三日均>六日均', B3x: '三條同時(四條不可能)',
    X36: '3日均剛上穿6日均', GRS: 'grs 合併(近似)', BnoS: '有買點且沒賣點',
    B2x: 'B2 精確版(收>前一天開盤)', GRSx: 'grs 合併(精確版 twstock)',
    S1: 'S1 量大收黑', S2: 'S2 量縮價跌', S3: 'S3 三日均轉下', S4: 'S4 三日均<六日均',
};

function loadUniverse(dir) {
    const files = fs.readdirSync(dir).filter(f => /^[1-9]\d{3}\.json$/.test(f));
    const U = [];
    for (const f of files) {
        try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); const rows = Array.isArray(j) ? j : (j.data || []); if (rows.length >= 260) U.push({ sym: f.slice(0, 4), A: compact(rows) }); } catch { }
    }
    return U;
}

function main() {
    const DIR = process.env.DATA_DIR || 'data';
    const U = loadUniverse(DIR);
    if (U.length < 300) { console.log(`❌ ${DIR} 只有 ${U.length} 檔(<300)→ 母體不夠,停`); process.exit(1); }
    const t0 = Date.now();
    const out = { meta: { dir: DIR, syms: U.length, holds: HOLDS, dedup: DEDUP, cost: 0.44 }, rules: {}, plateau: {} };
    const S = scan(U);
    const d0 = [...S.base[HI].keys()].sort();
    console.log(`📦 ${U.length} 檔 ・${d0[0]} ~ ${d0[d0.length - 1]} ・隔天開盤買 ・對照 = 同一天全部股票 ・漲停買不到剔除 ${S.skip.lock.toLocaleString()} 筆`);
    console.log(`\n🧭 買點(增量 = 比同一天全部股票多賺幾 %;主看抱 ${HOLDS[HI]} 天)`);
    for (const k of ['B1', 'B2', 'B3', 'B4', 'B3x', 'X36', 'GRS', 'BnoS', 'B2x', 'GRSx']) {
        if (!S.events[k]) continue;
        const gs = HOLDS.map((_, hi) => gates(increments(evList(S, k, hi), S.base[hi])));
        out.rules[k] = { name: NAMES[k], dir: 'buy', g: gs.map(g => ({ d: g.d, n: g.n, p: g.p, nPass: g.nPass, H: g.H, YR: g.YR })) };
        console.log('  ' + fmtG(NAMES[k], gs[HI]) + `  (5日 ${gs[0].d.toFixed(2)} / 20日 ${gs[2].d.toFixed(2)})`);
    }
    console.log(`\n🔻 賣點(避雷型:要過的是「之後比較差」→ 增量取負號再過六關)`);
    for (const k of ['S1', 'S2', 'S3', 'S4']) {
        if (!S.events[k]) continue;
        const inc = increments(evList(S, k, HI), S.base[HI]);
        const g = gates(inc), gn = gates(negate(inc));
        out.rules[k] = { name: NAMES[k], dir: 'sell', d: g.d, n: g.n, p: g.p, nPassAvoid: gn.nPass, YR: g.YR };
        console.log('  ' + fmtG(NAMES[k], g) + `  → 當避雷 ${gn.nPass}/6`);
    }
    console.log(`\n⛰️ 高原:B1「量大」門檻改成昨天的幾倍`);
    for (const volK of [1, 1.5, 2, 3]) {
        const SS = scan(U, { volK, only: new Set(['B1']) });
        const g = gates(increments(evList(SS, 'B1', HI), SS.base[HI]));
        out.plateau['B1x' + volK] = { d: g.d, n: g.n, nPass: g.nPass };
        console.log(`  量 > 昨天 ×${volK}`.padEnd(18) + `增量 ${(g.d >= 0 ? '+' : '') + g.d.toFixed(2)}pp ・n=${g.n} ・${g.nPass}/6`);
    }
    out.meta.secs = Math.round((Date.now() - t0) / 1000);
    const best = Object.entries(out.rules).filter(([, x]) => x.dir === 'buy').map(([k, x]) => [k, x.g[HI]]).sort((a, b) => b[1].nPass - a[1].nPass || b[1].d - a[1].d)[0];
    console.log('\n' + '═'.repeat(90));
    console.log(`⭐ 買點最好的是 ${NAMES[best[0]]}:增量 ${best[1].d.toFixed(2)}pp・${best[1].nPass}/6(成本 0.44)`);
    console.log('⚠️ 限制:窗口 = DATA_DIR 有的那幾年 ・倖存者偏誤 ・未計滑價 ・grs 的乖離轉折是近似');
    const f = process.argv.slice(2).find(a => a.endsWith('.json'));
    if (f) { fs.writeFileSync(f, JSON.stringify(out, null, 1)); console.log(`💾 ${f}`); }
}

// ═══════════ 自我測試 ═══════════
function selftest() {
    let bad = 0;
    const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + e}`); if (!c) bad++; };
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const days = []; { const d = new Date(Date.UTC(2021, 0, 4)); while (days.length < 900) { if (d.getUTCDay() % 6) days.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); } }
    const mkU = (nSym, edge) => Array.from({ length: nSym }, (_, s) => {
        const rows = []; let p = 50, drift = 0;
        for (let i = 0; i < days.length; i++) {
            const op = p * (1 + (rnd() - 0.5) * 0.01);
            p = op * (1 + (rnd() - 0.5) * 0.04 + drift);
            const vol = 1000 + rnd() * 1000;
            rows.push({ date: days[i], open: op, high: Math.max(op, p) * 1.005, low: Math.min(op, p) * 0.995, close: p, volume: vol });
            drift = 0;
            if (edge && i >= 8) { const R = rulesAt(rows.map(r => r.open), null, null, rows.map(r => r.close), rows.map(r => r.volume), i); if (R && R.B1) drift = edge; }
        }
        return { sym: String(1000 + s), rows };
    });
    // ① 純隨機:沒有東西 → 六關不可全過
    const U0 = mkU(120, 0), S0 = scan(U0), g0 = gates(increments(evList(S0, 'B1', HI), S0.base[HI]));
    ok('① 純隨機 → B1 增量接近 0、⛔ 不可六關全過', Math.abs(g0.d) < 0.6 && g0.nPass < 6, `${g0.d.toFixed(2)} ${g0.nPass}`);
    // ② 注入:B1 之後下一根多漲 3% → 量得到(而且只在 B1)
    const U1 = mkU(120, 0.03), S1 = scan(U1), g1 = gates(increments(evList(S1, 'B1', 0), S1.base[0]));
    ok('② 注入 B1 之後多漲 3% → 量到明顯正的增量', g1.d > 1.0 && g1.p < 0.01, `${g1.d.toFixed(2)} p=${g1.p}`);
    // ③ 前視注入:規則偷看隔天收盤 → 一定量到大正數(證明 scan 的報酬窗口真的在訊號之後;規則若前視就會紅)
    const peek = (o, h, l, c, v, i) => (i < 7 ? null : { P: c[i + 1] > c[i] * 1.02 });
    const S2 = scan(U0, { rulesAt: peek }), g2 = gates(increments(evList(S2, 'P', 0), S2.base[0]));
    ok('③ 偷看隔天收盤的規則 → 量到大正數(前視一定會被看見)', g2.d > 1.0, g2.d.toFixed(2));
    // ④ 隔天開在漲停附近 → 剔除
    const rowsL = days.slice(0, 40).map((d, i) => ({ date: d, open: 10, high: 10, low: 10, close: 10, volume: 1000 }));
    rowsL[20] = { ...rowsL[20], open: 11, high: 11, low: 11, close: 11 };
    const SL = scan([{ sym: '9999', rows: rowsL }]);
    ok('④ 隔天開盤 ≥ 昨收 +9.5% → 算進「買不到」', SL.skip.lock === 1, SL.skip.lock);
    // ⑤ 去重:同一檔同一條 10 日內只算一次
    const always = (o, h, l, c, v, i) => (i < 7 ? null : { A: true });
    const SD = scan([{ sym: '9998', rows: U0[0].rows }], { rulesAt: always });
    const nA = SD.events.A[HI].r.length, expect = Math.ceil((U0[0].rows.length - 1 - 7 - HOLDS[HI] + 1) / 10);   // ⛔ 寫死 10(用 DEDUP 變數就測不出去重被拿掉)
    ok('⑤ 每天都亮 → 10 日去重後約 n/10 筆', Math.abs(nA - expect) <= 2, `${nA} vs ${expect}`);
    // ⑥ 量的基準只跟昨天比(⛔ 不含今天):今天量 = 昨天量 → B1 不亮
    const o = [1, 1, 1, 1, 1, 1, 1, 1, 1], c = [1, 1, 1, 1, 1, 1, 1, 1, 1.1], v = [5, 5, 5, 5, 5, 5, 5, 5, 5];
    ok('⑥ 今天量 == 昨天量 → B1 ⛔ 不亮', !rulesAt(o, null, null, c, v, 8).B1);
    // ⑦ 🔁 精確版:B2x 跟前一天開盤比(收盤 > 昨收但 < 昨開 → B2 亮、B2x ⛔)
    const o7 = [1, 1, 1, 1, 1, 1, 1, 1, 1.2, 1], c7 = [1, 1, 1, 1, 1, 1, 1, 1, 1.0, 1.1], v7 = [5, 5, 5, 5, 5, 5, 5, 5, 5, 4];
    const R7 = rulesAt(o7, null, null, c7, v7, 9);
    ok('⑦ 收盤 1.1 > 昨收 1.0 但 < 昨開 1.2、量縮 → B2 亮、B2x ⛔(精確版跟前一天開盤比)', R7.B2 && !R7.B2x);
    // ⑧ 精確版乖離谷底:最近 5 天 (3 日均 − 6 日均) 全負、最低在 2 天前 → 亮;最低在今天 → ⛔;有一天 ≥ 0 → ⛔
    const mkC = tail => { const c = Array(12).fill(10); tail.forEach((x, k) => { c[12 - tail.length + k] = x; }); return c; };
    const down = mkC([9.6, 9.2, 8.8, 8.4, 8.0, 8.3, 8.6]);       // 跌完反彈兩天 → 最近 5 天乖離最低在 2 天前
    const deep = mkC([9.8, 9.6, 9.3, 8.9, 8.4, 7.8, 7.0]);       // 越跌越快 → 最低就是今天
    const vU = Array(12).fill(5); vU[11] = 6;
    const oB = c => c.map((x, k) => (k === 11 ? x * 0.98 : x));  // 最後一根收 > 開 + 量增 → B1 亮(⛔ 讓「谷底」那條變成唯一的差別)
    const Rd = rulesAt(oB(down), null, null, down, vU, 11), Rp = rulesAt(oB(deep), null, null, deep, vU, 11);
    const up5 = mkC([10.4, 10.8, 11.2, 11.6, 12, 11.8, 11.9]), Ru = rulesAt(oB(up5), null, null, up5, vU, 11);
    ok('⑧ 三組都有買點(B1 亮,⛔ 空過)', Rd.B1 && Rp.B1 && Ru.B1, `${Rd.B1} ${Rp.B1} ${Ru.B1}`);
    ok('⑧ 乖離全負、谷底 2 天前 → GRSx 亮;谷底在今天 → ⛔;乖離是正的 → ⛔', Rd.GRSx && !Rp.GRSx && !Ru.GRSx, `${Rd.GRSx} ${Rp.GRSx} ${Ru.GRSx}`);
    // ⑨ 2013 年(漲跌停 7%):隔天開盤 +7% = 買不到(舊版寫死 9.5% 會當成買得到)
    const rows9 = days.slice(0, 40).map(d => ({ date: '2013' + d.slice(4), open: 10, high: 10, low: 10, close: 10, volume: 1000 }));
    rows9[20] = { ...rows9[20], open: 10.7, high: 10.7, low: 10.7, close: 10.7 };
    const S9 = scan([{ sym: '9997', rows: rows9 }]);
    ok('⑨ 2013 年隔天開盤 +7% → 算「買不到」(lib_limit,⛔ 寫死 9.5%)', S9.skip.lock === 1, S9.skip.lock);
    console.log(bad ? `\n❌ ${bad} 條失敗` : '\n✅ SELFTEST_PASS');
    process.exit(bad ? 1 : 0);
}

// ⛔ 被 import 的時候不跑(同 dispo_backtest IS_MAIN)
const IS_MAIN = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN && process.argv.includes('--selftest')) selftest(); else if (IS_MAIN) main();
