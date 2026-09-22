#!/usr/bin/env node
/**
 * 📊 條件式機率表 —— 產生 `_PROB_TABLE`(V77.4.6)
 *
 * 使用者:「我想你用機率計算每個個股他的預判上漲、平盤、下跌機率,機率我還是想要,幫我做」。
 *
 * ⭐ 它產出的是**歷史頻率查表**,⛔ 不是預測模型(分桶與三分類的定義全在 `lib_prob.mjs`)。
 * ⭐ 產物**嵌進 `index.html` 當常數**(同 `_SIGNAL_EDGE` / `_DECK_TRACK49`)——
 *   ⛔ 不走採礦:它是「回測結論」,跟分桶公式綁;而「這一檔今天落在哪一格」前端自己用 K 線算,
 *   那才永遠最新(⛔ 也不必為了它動 workflow)。
 *
 * ⛔ 四個一定要有的東西(少一個這張表就會誤導人):
 *   ① **全市場基準率** —— 隨便買一檔台股扣完成本,20 日「跌」本來就比「漲」多。
 *   ② **每格的 n** —— 少於門檻一律標樣本不足,⛔ 不補值。
 *   ③ **校準**:前半段的機率拿去後半段驗,差太多要標 Overconfident。
 *   ④ **分位數 / MAE / MFE / 獲利因子 / 期望值** —— 機率講不出「賠的時候賠多少」。
 *
 * 用法:DATA_DIR=<合併過 klines_deep 的目錄> node --max-old-space-size=6144 scripts/prob_probe.mjs [out.json]
 *      node scripts/prob_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import {
    FLAT_BAND, HORIZONS, N_CELLS, cellName, featuresAt, labelOf, outcomeAt, LIMIT_UP,
} from './lib_prob.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const OUT = process.argv.find(a => a.endsWith('.json')) || path.join(ROOT, 'data', 'prob_table.json');
const MIN_N = +(process.env.MIN_N || 200);      // ② 一格至少要這麼多筆才給機率
const LIMIT = +(process.env.LIMIT || 0);
const SELFTEST = process.argv.includes('--selftest');

const med = a => { if (!a.length) return 0; const b = Float64Array.from(a).sort(); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const qtl = (a, p) => { if (!a.length) return 0; const b = Float64Array.from(a).sort(); return b[Math.min(b.length - 1, Math.max(0, Math.round((b.length - 1) * p)))]; };
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;

// ═══ 🧪 自我驗證 ═══
if (SELFTEST) {
    let bad = 0;
    const ok = (n, c, x = '') => { if (!c) bad++; console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  → ' + JSON.stringify(x)}`); };
    const mk = a => a.map(c => ({ o: c, h: c * 1.01, l: c * 0.99, c, v: 1000 }));

    // ① 三分類:平盤帶 = 來回成本
    ok('① 平盤帶 = ±0.44%(+0.44 是平、+0.45 才算漲)',
        labelOf(0.44) === 1 && labelOf(0.45) === 0 && labelOf(-0.45) === 2 && labelOf(0) === 1,
        [labelOf(0.44), labelOf(0.45), labelOf(-0.45)]);

    // ② 進場是 t+1 開盤(⛔ 不是訊號日收盤)—— 決定性對照:只改 t+1 那根的開盤價,報酬必須變
    {
        const a = []; for (let i = 0; i < 300; i++) a.push(100);
        const R = mk(a); R[201].c = 110;
        const o1 = outcomeAt(R, 200, 5);
        R[201].o = 50;
        const o2 = outcomeAt(R, 200, 5);
        ok('② 進場價 = t+1 開盤(改那根開盤價,報酬必須跟著變)', o1 && o2 && Math.abs(o1.ret - o2.ret) > 10, [o1, o2]);
    }
    // ③ 鎖漲停剔除
    {
        const a = []; for (let i = 0; i < 300; i++) a.push(100);
        const R = mk(a); R[200].c = 100 * LIMIT_UP;
        ok('③ 訊號日鎖漲停 → 剔除(買不到)', outcomeAt(R, 200, 5) === null, outcomeAt(R, 200, 5));
        R[200].c = 100 * 1.09;
        ok('③b +9% 沒鎖 → 不剔除', outcomeAt(R, 200, 5) !== null);
    }
    // ④ 創新高的基準⛔ 不含今天 —— 決定性對照:一路走平 + 跳一根
    {
        const a = []; for (let i = 0; i < 300; i++) a.push(100 + Math.sin(i / 5) * 2);
        a[299] = 200;
        const f = featuresAt(mk(a), 299, 0);
        ok('④ 跳上去那一根 → 判定為創 120 日以上新高', f && f.nh === 2, f && { nh: f.nh, nhN: f.nhN });
        const a2 = a.slice(0, 299);
        for (let i = 0; i < 60; i++) a2.push(100 + Math.sin((299 + i) / 5) * 2);
        const f2 = featuresAt(mk(a2), 298, 0);
        ok('④b ⭐ 決定性對照:沒有那一根 → ⛔ 不可判成創新高', f2 && f2.nh === 0, f2 && { nh: f2.nh });
    }
    // ⑤ 位階:一路漲 → 高檔;一路跌 → 谷底
    {
        const up = []; for (let i = 0; i < 300; i++) up.push(100 + i);
        const dn = []; for (let i = 0; i < 300; i++) dn.push(400 - i);
        const fu = featuresAt(mk(up), 299, 0), fd = featuresAt(mk(dn), 299, 0);
        ok('⑤ 一路漲 → 位階桶 3(高檔)', fu && fu.pos === 3, fu && fu.posPct);
        ok('⑤b 一路跌 → 位階桶 0(谷底)', fd && fd.pos === 0, fd && fd.posPct);
    }
    // ⑥ 桶 id 可逆
    {
        let allOk = true;
        for (let i = 0; i < N_CELLS; i++) if (!cellName(i)) allOk = false;
        ok('⑥ 72 格每一格都有名字', allOk && N_CELLS === 72, N_CELLS);
    }
    // ⑦ 資料不足 → null(⛔ 不硬給)
    {
        const a = []; for (let i = 0; i < 100; i++) a.push(100);
        ok('⑦ K 線不足 250 根 → 回 null(⛔ 不補值)', featuresAt(mk(a), 99, 0) === null);
    }
    console.log(bad ? `\n❌ PROB_SELFTEST_FAIL ${bad} 條` : '\n✅ PROB_SELFTEST_PASS');
    process.exit(bad ? 1 : 0);
}

// ═══ 1. 大盤 regime(加權 vs 自己的 200 日均線)═══
let MKT = null;
try {
    const t = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8'));
    const cs = t.map(r => +r.close);
    MKT = new Map();
    for (let i = 0; i < t.length; i++) {
        if (i < 200) continue;
        let s = 0; for (let q = i - 199; q <= i; q++) s += cs[q];
        MKT.set(String(t[i].date).replace(/\//g, '-').slice(0, 10), cs[i] < s / 200 ? 1 : 0);
    }
    console.log(`📈 大盤 regime:${MKT.size} 天(年線之下 ${[...MKT.values()].filter(x => x === 1).length} 天)`);
} catch { console.error('⛔ 讀不到 ^TWII.json → 算不出大盤 regime,⛔ 不硬給'); process.exit(1); }

// 🆚 大盤同期報酬(⭐ 沒有它,「谷底 ・ 大盤在年線之下」那一格的 63% 會被讀成選股很強,
//    而它其實大半是**大盤自己反彈**)。進出場口徑跟個股完全一樣:t+1 開盤 → t+1+h 收盤。
let TWI = null;
try {
    const t = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8'));
    TWI = { idx: new Map(), o: t.map(r => +r.open), c: t.map(r => +r.close) };
    t.forEach((r, i) => TWI.idx.set(String(r.date).replace(/\//g, '-').slice(0, 10), i));
} catch { TWI = null; }
const mktRet = (date, h) => {
    if (!TWI) return null;
    const i = TWI.idx.get(date); if (i == null) return null;
    const a = TWI.o[i + 1], b = TWI.c[i + 1 + h];
    return (a > 0 && b > 0) ? (b - a) / a * 100 : null;
};

// ③ 校準的切點 = **交易日曆的中位數**(⛔ 不可用「掃到一半」—— 那會依檔案順序而變)
const _mkDates = [...MKT.keys()].sort();
const SPLIT = _mkDates[Math.floor(_mkDates.length / 2)];
console.log(`🪞 校準切點:前半 < ${SPLIT} ≤ 後半`);

// ═══ 2. 掃全市場 ═══
const files = fs.readdirSync(DATA).filter(x => /^\d{4}\.json$/.test(x));
const syms = (LIMIT ? files.slice(0, LIMIT) : files).map(f => f.replace('.json', ''));
console.log(`📊 條件式機率表 —— ${syms.length} 檔 ・平盤帶 ±${FLAT_BAND}% ・天期 ${HORIZONS.join('/')} ・一格至少 ${MIN_N} 筆`);

// acc[cell][hi] = { lab:[0,0,0], ret:[], mae:[], mfe:[] }
const mkAcc = () => ({ lab: [0, 0, 0], ret: [], mae: [], mfe: [], ex: [] });
const ACC = Array.from({ length: N_CELLS }, () => HORIZONS.map(mkAcc));
const BASE = HORIZONS.map(mkAcc);
// ③ 校準用:前半 / 後半(依日期切)
const H1 = Array.from({ length: N_CELLS }, () => HORIZONS.map(mkAcc));
const H2 = Array.from({ length: N_CELLS }, () => HORIZONS.map(mkAcc));
// 每檔在每一格有幾筆(前端要顯示「這檔自己的樣本」)
const SYMCELL = {};

let nSym = 0, nBar = 0, nCliff = 0, dates = [];
for (const sym of syms) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(DATA, `${sym}.json`), 'utf8')); } catch { continue; }
    if (!Array.isArray(d) || d.length < 300) continue;
    const R = d.map(r => ({ d: String(r.date).replace(/\//g, '-').slice(0, 10), o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +(r.volume || 0) }));
    if (!R.every(r => r.c > 0 && r.o > 0 && r.h > 0 && r.l > 0)) continue;
    // 🚧 斷崖守門(非整數比減資 / 除權留下的尺標斷層,CLAUDE.md V77.2.1)
    let cliff = false;
    for (let q = 1; q < R.length; q++) { const rr = R[q].c / R[q - 1].c; if (rr > 1.4 || rr < 0.6) { cliff = true; break; } }
    if (cliff) { nCliff++; continue; }
    nSym++;
    for (let i = 250; i < R.length - 21; i++) {
        const mk = MKT.get(R[i].d); if (mk == null) continue;
        const f = featuresAt(R, i, mk); if (!f) continue;
        nBar++;
        for (let hi = 0; hi < HORIZONS.length; hi++) {
            const o = outcomeAt(R, i, HORIZONS[hi]); if (!o) continue;
            const l = labelOf(o.ret);
            const mr = mktRet(R[i].d, HORIZONS[hi]);
            for (const T of [ACC[f.cell][hi], BASE[hi]]) {
                T.lab[l]++; T.ret.push(o.ret); T.mae.push(o.mae); T.mfe.push(o.mfe);
                if (mr != null) T.ex.push(o.ret - mr);
            }
            const half = (R[i].d < SPLIT) ? H1 : H2;
            const T2 = half[f.cell][hi]; T2.lab[l]++; T2.ret.push(o.ret);
        }
        if (nSym <= 3 && dates.length < 4) dates.push(R[i].d);
    }
    if (nSym % 400 === 0) process.stdout.write(`\r   ${nSym} 檔 …`);
}
console.log(`\r   ✅ ${nSym} 檔 ・${nBar.toLocaleString()} 股·日 ・🚧 斷崖剔除 ${nCliff} 檔`);


// ═══ 3. 整理成表 ═══
const pctOf = T => { const s = T.lab[0] + T.lab[1] + T.lab[2]; return s ? T.lab.map(x => +(x / s * 100).toFixed(1)) : [0, 0, 0]; };
const pfOf = a => { let up = 0, dn = 0; for (const x of a) { if (x > 0) up += x; else dn -= x; } return dn > 0 ? +(up / dn).toFixed(2) : (up > 0 ? 99 : 0); };
const rowOf = T => {
    const n = T.ret.length;
    if (!n) return null;
    const p = pctOf(T);
    const ex = T.ex;
    return [n, p[0], p[1], p[2],
        +qtl(T.ret, 0.25).toFixed(2), +med(T.ret).toFixed(2), +qtl(T.ret, 0.75).toFixed(2),
        +mean(T.ret).toFixed(2), pfOf(T.ret), +med(T.mae).toFixed(2), +med(T.mfe).toFixed(2),
        // 🆚 ⭐ 這兩欄是「這一格到底有沒有比大盤強」—— ⛔ 少了它,空頭裡的跌深反彈會被讀成選股很強
        ex.length ? +(ex.filter(x => x > 0).length / ex.length * 100).toFixed(1) : null,
        ex.length ? +mean(ex).toFixed(2) : null];
};
const SCHEMA = ['n', '漲%', '平%', '跌%', 'P25', '中位', 'P75', '平均', '獲利因子', 'MAE中位', 'MFE中位', '贏大盤%', '超額平均'];

const cells = {};
let nUsable = 0, nThin = 0;
for (let c = 0; c < N_CELLS; c++) {
    const rows = ACC[c].map(rowOf);
    if (!rows[0] || rows[0][0] < MIN_N) { nThin++; continue; }
    cells[c] = rows;
    nUsable++;
}
const base = BASE.map(rowOf);

// ③ 校準:前半的機率拿去後半驗(整體 reliability)
const calib = HORIZONS.map((_, hi) => {
    const pts = [];
    for (let c = 0; c < N_CELLS; c++) {
        const a = H1[c][hi], b = H2[c][hi];
        const na = a.ret.length, nb = b.ret.length;
        if (na < 100 || nb < 100) continue;
        pts.push({ pred: pctOf(a)[0], act: pctOf(b)[0], n: nb });
    }
    if (pts.length < 5) return null;
    const w = pts.reduce((s, x) => s + x.n, 0);
    const mae = pts.reduce((s, x) => s + Math.abs(x.pred - x.act) * x.n, 0) / w;
    const bias = pts.reduce((s, x) => s + (x.pred - x.act) * x.n, 0) / w;
    return { cells: pts.length, mae: +mae.toFixed(2), bias: +bias.toFixed(2), over: mae > 10 };
});

// ⛔ 刻意**不存**「每一檔待過哪幾格」:單檔 800~1,400 根 ÷ 72 格 = 每格十幾筆,
//    那個數字**不夠下結論**,存了只會讓人以為「這是這一檔自己的統計」。
//    前端只需要算「今天這一根落在哪一格」(一次 featuresAt,瞬間),然後查全市場那一格。
const out = {
    v: 1, src: 'scripts/prob_probe.mjs', built: new Date().toISOString().slice(0, 10),
    flat: FLAT_BAND, hz: HORIZONS, minN: MIN_N, schema: SCHEMA,
    syms: nSym, bars: nBar, win: [_mkDates[0], _mkDates[_mkDates.length - 1]], split: SPLIT,
    base, cells, calib,
    note: '進場 = t+1 開盤;平盤 = 毛報酬在 ±' + FLAT_BAND + '% 內(扣完來回成本等於沒賺沒賠);鎖漲停剔除;⛔ 歷史頻率不是預測',
};
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`\n💾 ${OUT}(${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)・可用 ${nUsable} 格 ・樣本不足 ${nThin} 格`);

// ═══ 4. 報告 ═══
console.log('\n' + '═'.repeat(96));
console.log(`【全市場基準率】隨便挑一檔台股、t+1 開盤買 —— ⭐ 這是每一格都必須一起顯示的對照`);
console.log('═'.repeat(96));
console.log('天期    n          漲%    平%    跌%    P25     中位    P75     平均    獲利因子  贏大盤%  超額平均');
HORIZONS.forEach((h, i) => {
    const r = base[i]; if (!r) return;
    console.log(`${String(h).padStart(3)} 日 ${String(r[0]).padStart(10)} ${r[1].toFixed(1).padStart(7)} ${r[2].toFixed(1).padStart(6)} ${r[3].toFixed(1).padStart(6)} ${r[4].toFixed(2).padStart(8)} ${r[5].toFixed(2).padStart(7)} ${r[6].toFixed(2).padStart(7)} ${r[7].toFixed(2).padStart(7)} ${String(r[8]).padStart(8)} ${(r[11] == null ? '—' : r[11].toFixed(1)).padStart(8)} ${(r[12] == null ? '—' : (r[12] >= 0 ? '+' : '') + r[12].toFixed(2)).padStart(8)}`);
});

const hi20 = HORIZONS.indexOf(20);
console.log('\n' + '═'.repeat(96));
console.log('【20 日「漲」機率最高 / 最低的 8 格】⭐ 一律跟基準比,⛔ 不可只看絕對值');
console.log('═'.repeat(96));
const ranked = Object.entries(cells).filter(([, r]) => r[hi20]).map(([c, r]) => ({ c: +c, r: r[hi20] }))
    .sort((a, b) => b.r[1] - a.r[1]);
const show = arr => arr.forEach(x => {
    const r = x.r, b = base[hi20];
    console.log(`  漲 ${r[1].toFixed(1).padStart(5)}% (基準 ${b[1].toFixed(1)}%,${(r[1] - b[1] >= 0 ? '+' : '') + (r[1] - b[1]).toFixed(1)}pp) ・跌 ${r[3].toFixed(1).padStart(5)}% ・n=${String(r[0]).padStart(7)} ・平均 ${((r[7] >= 0 ? '+' : '') + r[7].toFixed(2) + '%').padStart(7)} ・🆚 贏大盤 ${(r[11] == null ? '—' : r[11].toFixed(1) + '%').padStart(6)}(基準 ${b[11] == null ? '—' : b[11].toFixed(1) + '%'})・超額 ${(r[12] == null ? '—' : (r[12] >= 0 ? '+' : '') + r[12].toFixed(2)).padStart(6)}  ${cellName(x.c)}`);
});
show(ranked.slice(0, 8));
console.log('  ── 最低 ──');
show(ranked.slice(-8).reverse());

console.log('\n' + '═'.repeat(96));
console.log('【校準】前半段(< ' + SPLIT + ')算出來的「漲%」,拿去後半段驗');
console.log('═'.repeat(96));
HORIZONS.forEach((h, i) => {
    const c = calib[i];
    if (!c) { console.log(`${String(h).padStart(3)} 日:格數不足,⛔ 不給校準`); return; }
    console.log(`${String(h).padStart(3)} 日:${String(c.cells).padStart(3)} 格 ・平均差 ${c.mae.toFixed(2)}pp ・偏誤 ${(c.bias >= 0 ? '+' : '') + c.bias.toFixed(2)}pp ${c.over ? '🚨 Overconfident(差 >10pp)' : '✅'}`);
});

console.log('\n' + '═'.repeat(96));
console.log('⚠️ 限制:倖存者偏誤(只有還活著的股票)・⛔ 這是歷史頻率不是預測 ・');
console.log('   ⛔ 機率⛔ 不含出場規則(它假設「抱滿 N 天」)—— 真的做要照出場總表那一條走 ・');
console.log('   ⛔ 一格少於 ' + MIN_N + ' 筆一律不給(⛔ 不補值、⛔ 不跟隔壁格借)');
