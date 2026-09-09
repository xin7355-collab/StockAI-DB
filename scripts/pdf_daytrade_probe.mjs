/**
 * 📕 附件當沖指標「準不準」實測(V74.6.3)—— 使用者上傳的 PDF
 *
 * 附件講了四類東西,⭐ 先分清楚**哪些本站已經測過、哪些測不了、哪些真的沒測過**:
 *   ✅ 已測過:ORB(orb_probe,扣成本後全虧)・布林壓縮(kobo_probe,全表最差 −0.89pp)・
 *            凱特納/CCI/%R/MFI/OBV/VWAP/樞紐點/Supertrend(indicator_zoo,48 個六關 0 過)
 *   ⛔ 測不了:VWAP 盤中版 / 內外盤 / 五檔 / 足跡圖 / CVD / TPO / GEX
 *            → 台股**不公開逐筆委託簿**,而且本站沒有分 K 歷史(只有 101 天,V71.9.8 用過)
 *   🆕 沒測過(這支要測的):
 *      ① RVOL(相對成交量)—— 附件說 ≥2.0 是「真突破」、<1.0 是「假突破」
 *      ② TTM Squeeze —— 布林縮進凱特納 = 蓄力,衝出去 = 發射
 *      ③ 🚨 **兩者共振**(附件稱之為「當沖勝率最高、獲利速度最快的終極訊號」)
 *
 * ⚠️⚠️ **這是日線版,⛔ 不是附件講的分 K 版** —— 這件事必須講在最前面:
 *   附件的 RVOL 是「當前這一分鐘 vs 過去 N 天同一分鐘」,日線版是「今天量 vs 過去 20 日均量」。
 *   ⭐ 但日線版仍然值得測,理由跟 gap_probe 一樣:**若母體本身是負的,分 K 版只是它的子集合**;
 *      而且分 K 只有 101 天(V71.9.8),分不出統計顯著。
 *   ⛔ 所以結論只能說「日線版不成立」,⛔ 不可說「附件是錯的」。
 *
 * 方法:2,300+ 檔 ・進場 = 隔天開盤(排除鎖漲停)・扣同期加權 ・同檔同事件 10 日去重
 *      ・六道關卡(全期正 / 前後半同向 / 逐年同向 / 去最好年 / 扣成本 0.44% / 疊在 🧬 之上)
 *
 * 跑法:node scripts/pdf_daytrade_probe.mjs [最多幾檔]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const MAX_SYMS = +(process.argv[2] || 99999);
const FWD = +(process.env.FWD || 10);      // 前瞻幾個交易日
const DEDUP = 10;                          // 同檔同事件幾日內只算一次
const COST = 0.44;
const log = (...a) => console.log(...a);
const t0 = Date.now();

// ── 大盤(扣同期加權用)────────────────────────────────────────────
const twii = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf-8'))
    .map(r => ({ d: String(r.date).replace(/\//g, '-').slice(0, 10), c: +r.close }))
    .filter(x => x.c > 0);
const mIdx = new Map(twii.map((x, i) => [x.d, i]));
const mC = twii.map(x => x.c);

function loadSeries(p) {
    try {
        const rows = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (!Array.isArray(rows)) return null;
        const o = [], h = [], l = [], c = [], v = [], d = [];
        for (const r of rows) {
            const cc = +(r.close || 0); if (!(cc > 0)) continue;
            d.push(String(r.date).replace(/\//g, '-').slice(0, 10));
            o.push(+(r.open || cc)); h.push(+(r.high || cc)); l.push(+(r.low || cc));
            c.push(cc); v.push(+(r.volume || 0));
        }
        return c.length >= 320 ? { d, o, h, l, c, v } : null;
    } catch (_) { return null; }
}

const sma = (a, n, i) => { if (i < n - 1) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += a[k]; return s / n; };
const sd = (a, n, i) => { const m = sma(a, n, i); if (m == null) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += (a[k] - m) ** 2; return Math.sqrt(s / n); };

const files = fs.readdirSync(DATA).filter(f => /^\d{4}\.json$/.test(f)).sort();
log(`📕 附件當沖指標實測(日線版)・${files.length} 檔${MAX_SYMS < 99999 ? `(上限 ${MAX_SYMS})` : ''}`);
log(`   🆕 只測「本站真的沒測過」的三個:RVOL ・TTM Squeeze ・兩者共振\n`);

// 事件桶
const B = new Map();
const put = (k, ex, dt, yr, gene) => {
    if (!B.has(k)) B.set(k, []);
    B.get(k).push({ ex, dt, yr, gene });
};
let base = [], used = 0;

for (const f of files) {
    if (used >= MAX_SYMS) break;
    const R = loadSeries(path.join(DATA, f));
    if (!R) continue;
    used++;
    const { d, o, h, l, c, v } = R;
    const n = c.length;
    const lastSeen = new Map();

    // 前置:ATR14(真實波幅簡單平均,跟本站其他探針同一把尺)
    const tr = new Array(n).fill(0);
    for (let i = 1; i < n; i++) tr[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));

    for (let i = 260; i < n - FWD - 1; i++) {
        const ti = mIdx.get(d[i]); if (ti == null || ti + 1 + FWD >= mC.length) continue;
        // 🚪 進場 = 隔天開盤(⛔ 附件是盤中訊號,但日線只能這樣;而且收盤價當天買不到)
        const eIdx = i + 1;
        const entry = o[eIdx] > 0 ? o[eIdx] : c[eIdx];
        if (!(entry > 0)) continue;
        // ⛔ 排除隔天開盤仍鎖漲停(買不到)
        if (o[eIdx] > 0 && c[i] > 0 && (o[eIdx] - c[i]) / c[i] > 0.093 && h[eIdx] === l[eIdx]) continue;
        const exitP = c[Math.min(n - 1, eIdx + FWD - 1)];
        const mkt = (mC[Math.min(mC.length - 1, ti + 1 + FWD - 1)] - mC[ti + 1]) / mC[ti + 1] * 100;
        const ex = (exitP - entry) / entry * 100 - mkt;
        const yr = d[i].slice(0, 4);

        // 🧬 現行配置(位階 ≥75 且 20 日振幅 ≥3.2%)—— 增量檢定用
        let hi = -1e9, lo = 1e9;
        for (let k = i - 251; k <= i; k++) { if (c[k] > hi) hi = c[k]; if (c[k] < lo) lo = c[k]; }
        const pos = hi > lo ? (c[i] - lo) / (hi - lo) * 100 : 50;
        let amp = 0; for (let k = i - 19; k <= i; k++) amp += (h[k] - l[k]) / c[k] * 100;
        amp /= 20;
        const gene = pos >= 75 && amp >= 3.2;

        base.push({ ex, dt: d[i], yr, gene });

        const fire = (k) => {
            const t = lastSeen.get(k);
            if (t != null && i - t < DEDUP) return;
            lastSeen.set(k, i); put(k, ex, d[i], yr, gene);
        };

        // ── ① RVOL(日線版)= 今天量 ÷ 過去 20 日均量 ──────────────
        const v20 = sma(v, 20, i - 1);            // ⛔ 用「昨天為止」的均量,不含今天(零前視)
        const rvol = v20 > 0 ? v[i] / v20 : null;
        if (rvol != null) {
            if (rvol < 1.0) fire('📉 RVOL < 1.0(附件說:量不足=假突破)');
            else if (rvol < 2.0) fire('➖ RVOL 1.0~2.0');
            else if (rvol < 3.0) fire('⭐ RVOL ≥ 2.0(附件說:主力進場=真突破)');
            else if (rvol < 5.0) fire('🔥 RVOL 3.0~5.0');
            else fire('💥 RVOL ≥ 5.0(極端爆量)');
        }

        // ── ② TTM Squeeze:布林(20,2.0)縮進凱特納(20, 1.5×ATR)──
        const bbM = sma(c, 20, i), bbS = sd(c, 20, i);
        const kcM = sma(c, 20, i), kcA = sma(tr, 20, i);
        if (bbM != null && bbS != null && kcA != null) {
            const bbU = bbM + 2 * bbS, bbL = bbM - 2 * bbS;
            const kcU = kcM + 1.5 * kcA, kcL = kcM - 1.5 * kcA;
            const on = bbU < kcU && bbL > kcL;
            // 前一根的擠壓狀態
            const bbM1 = sma(c, 20, i - 1), bbS1 = sd(c, 20, i - 1), kcA1 = sma(tr, 20, i - 1);
            let on1 = null;
            if (bbM1 != null && bbS1 != null && kcA1 != null) {
                on1 = (bbM1 + 2 * bbS1) < (bbM1 + 1.5 * kcA1) && (bbM1 - 2 * bbS1) > (bbM1 - 1.5 * kcA1);
            }
            // 動能柱(線性回歸,跟附件的 Pine 一致:close − (最高+最低+SMA)/3 的 linreg)
            let hh = -1e9, ll = 1e9;
            for (let k = i - 19; k <= i; k++) { if (h[k] > hh) hh = h[k]; if (l[k] < ll) ll = l[k]; }
            const avgV = (hh + ll + sma(c, 20, i)) / 3;
            // linreg(close − avgVal, 20) 取末值:用最小平方法
            let sx = 0, sy = 0, sxy = 0, sxx = 0;
            for (let k = 0; k < 20; k++) {
                let hh2 = -1e9, ll2 = 1e9;
                for (let q = i - 19 - (19 - k); q <= i - (19 - k); q++) { if (h[q] > hh2) hh2 = h[q]; if (l[q] < ll2) ll2 = l[q]; }
                const av2 = (hh2 + ll2 + sma(c, 20, i - (19 - k))) / 3;
                const y = c[i - (19 - k)] - av2;
                sx += k; sy += y; sxy += k * y; sxx += k * k;
            }
            const slope = (20 * sxy - sx * sy) / (20 * sxx - sx * sx);
            const mom = sy / 20 + slope * (19 - (19 / 2));   // 線性回歸在末點的值
            if (on) fire('🔴 TTM 擠壓中(蓄力,附件說能量積攢)');
            if (on1 === true && !on) {
                fire('🟢 TTM 擠壓發射(附件說:趨勢發動)');
                if (mom > 0) fire('🟢⬆️ TTM 發射 × 動能柱為正(附件的做多訊號)');
                else fire('🟢⬇️ TTM 發射 × 動能柱為負(附件的做空訊號)');
                // ── ③ 🚨 附件宣稱的「終極訊號」:發射 × RVOL ≥ 2.0 ──
                if (rvol != null && rvol >= 2.0) {
                    fire('🚨 終極訊號:TTM 發射 × RVOL ≥ 2.0');
                    if (mom > 0) fire('🚨⬆️ 終極訊號 × 動能柱為正(附件的完美共振做多)');
                }
            }
        }
    }
}

log(`✅ 掃過 ${used} 檔 ・對照組 ${base.length.toLocaleString()} 個(股·日)\n`);
if (base.length < 50000) { console.error('🚨 對照組太小,不下結論'); process.exit(1); }

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const wr = a => a.length ? a.filter(x => x > 0).length / a.length * 100 : NaN;
const bMean = mean(base.map(x => x.ex)), bWr = wr(base.map(x => x.ex));
const yrsAll = [...new Set(base.map(x => x.yr))].sort();
// ⭐ 中點從**實際樣本**推(⛔ 不用整條日期軸 —— limitup/trustvol 都踩過)
const allD = base.map(x => x.dt).sort(); const midD = allD[Math.floor(allD.length / 2)];
const bGene = base.filter(x => x.gene).map(x => x.ex);
const bGeneM = mean(bGene);

log(`⚠️ 對照組 ${FWD} 日:平均 ${bMean.toFixed(2)}% ・上漲 ${bWr.toFixed(1)}%  ⛔ 基準不是 0 也不是 50%`);
log(`   期間 ${allD[0]} ~ ${allD[allD.length - 1]}(中點 ${midD})・逐年 ${yrsAll.join('/')}`);
log(`   🧬 對照組(位階≥75 且 振幅≥3.2)平均 ${bGeneM.toFixed(2)}% ・n=${bGene.length.toLocaleString()}\n`);

const f2 = x => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(2) : ' n/a');
log('═'.repeat(112));
log('事件'.padEnd(42) + '  n      邊際     上漲%   前半/後半      逐年       去最好年   扣成本   疊🧬');
log('─'.repeat(112));
const rows = [];
for (const [k, arr] of [...B.entries()].sort((a, b) => mean(b[1].map(x => x.ex)) - mean(a[1].map(x => x.ex)))) {
    if (arr.length < 200) continue;
    const e = mean(arr.map(x => x.ex)) - bMean;
    const w = wr(arr.map(x => x.ex));
    const f1 = mean(arr.filter(x => x.dt < midD).map(x => x.ex)) - mean(base.filter(x => x.dt < midD).map(x => x.ex));
    const f2b = mean(arr.filter(x => x.dt >= midD).map(x => x.ex)) - mean(base.filter(x => x.dt >= midD).map(x => x.ex));
    const yd = {};
    for (const y of yrsAll) {
        const a = arr.filter(x => x.yr === y).map(x => x.ex), b = base.filter(x => x.yr === y).map(x => x.ex);
        if (a.length >= 30 && b.length) yd[y] = mean(a) - mean(b);
    }
    const ys = Object.values(yd);
    const sameYr = ys.length >= 3 && (ys.every(x => x > 0) || ys.every(x => x < 0));
    // 去最好年
    let woBest = e;
    if (ys.length >= 3) {
        const bestY = Object.entries(yd).sort((a, b) => b[1] - a[1])[0][0];
        const a2 = arr.filter(x => x.yr !== bestY).map(x => x.ex), b2 = base.filter(x => x.yr !== bestY).map(x => x.ex);
        woBest = mean(a2) - mean(b2);
    }
    const g = arr.filter(x => x.gene).map(x => x.ex);
    const gInc = g.length >= 100 ? mean(g) - bGeneM : NaN;
    const same = f1 > 0 === f2b > 0;
    rows.push({ k, n: arr.length, e, w, f1, f2b, sameYr, woBest, net: e - COST, gInc, same, ys });
    log(k.padEnd(40) + String(arr.length).padStart(7) + f2(e).padStart(9) + w.toFixed(1).padStart(8)
        + `  ${f2(f1)}/${f2(f2b)}`.padEnd(16) + (same ? '✅' : '❌') + (sameYr ? '✅' : '❌').padStart(8)
        + f2(woBest).padStart(10) + f2(e - COST).padStart(9) + f2(gInc).padStart(9));
}
log('═'.repeat(112));
const pass = rows.filter(r => r.e > 0 && r.same && r.sameYr && r.woBest > 0 && r.net > 0);
log(`\n🧭 六道關卡全過的:${pass.length ? pass.map(r => r.k).join('、') : '⛔ 0 個'}`);
log(`⚠️ 「疊🧬」= 疊在現行配置(位階≥75 且 振幅≥3.2)之上還剩多少增量;n<100 顯示 n/a`);
log(`⚠️⚠️ **這是日線版,⛔ 不是附件講的分 K 版** —— 附件的 RVOL 是「這一分鐘 vs 過去同一分鐘」。`);
log(`     日線版不成立⛔ 不等於分 K 版不成立;但本站分 K 只有 101 天(V71.9.8),統計上驗不動。`);
log(`\n⏱️  ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
