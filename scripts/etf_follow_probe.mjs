/**
 * 🚦 ETF 跟車回測:跟著主動式 ETF 買股票有沒有用?(V74.6.4)
 *
 * ⭐ 這一題本站掛在「等資料」很久了(自己的 mgr_hist 2026-08 才開始存)——
 *   使用者上傳的 `etf_scratch` 有 **10 檔主動式 ETF × 100 個交易日的每日持股**,
 *   而且每一列都帶 `shares` / `weight` / `isNew` → **現在就測得動**。
 *
 * 🚨🚨 **兩層陷阱,用錯定義結論會完全相反**(⛔ 這一段是這支探針的核心):
 *   ① **規模成長**:主動式 ETF 還在建倉/募資,實測 00985A 總股數 100 天內 1,114 萬 → 3,538 萬(3.2 倍)。
 *      → 用 `shares` 變動判「加碼」= 把**申購進來的錢**算成選股訊號(首日 50 檔全部「加碼」)。
 *   ② **價格效應**:`weight` 變化 = 主動調整 **+ 當天漲跌**。實測 00985A 有整天「shares 一檔都沒動、
 *      weight 卻有 17 檔上升」→ 用 `diffWeight` 判「加碼」會退化成「今天漲比較多」= 動能訊號的換皮。
 *   ⭐ **正解:主動變動率 a = 該股 shares 變動率 − 當天所有共同持股變動率的中位數**
 *      —— 剔除規模成長(用中位數對個別大調整穩健),而且完全不含價格。
 *   ⛔ 三種定義都會跑,把「它們給出不同答案」這件事直接印出來。
 *
 * ⭐ 對照組(這題的成敗關鍵):
 *   (A) 全市場同期所有(股·日) —— 量到的是「被主動式 ETF 碰到」的總效果
 *   (B) ⭐⭐ **同一天被同一檔 ETF 持有、但沒有主動調整的股票** —— 共用「被 ETF 挑中」那條腿,
 *       ⛔ 只有這一組才量得到「**加碼這個動作**」本身有沒有資訊。
 *
 * 進場 = **D+1 開盤**(⛔ 不可用 D 日收盤:持股是收盤後才公布的);排除開盤鎖漲停;
 * 扣同期加權;同檔同事件 10 日去重。
 *
 * ⚠️ 資料是**使用者上傳的別人的資料** → ⛔ 不進 repo,路徑用參數傳。
 *   跑法:node scripts/etf_follow_probe.mjs <etf_scratch 的 data 目錄>
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const SRC = process.argv[2];
if (!SRC || !fs.existsSync(SRC)) {
    console.error('用法:node scripts/etf_follow_probe.mjs <etf_scratch/data 目錄>');
    process.exit(1);
}
const FWD = (process.env.FWD || '5,10,20').split(',').map(Number);
const DEDUP = 10, COST = 0.44;
const log = (...a) => console.log(...a);
const t0 = Date.now();

// ── 大盤 ────────────────────────────────────────────────────
const twii = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf-8'))
    .map(r => ({ d: String(r.date).replace(/\//g, '-').slice(0, 10), c: +r.close })).filter(x => x.c > 0);
const mIdx = new Map(twii.map((x, i) => [x.d, i]));
const mC = twii.map(x => x.c);

// ── 個股 K 線(只載 ETF 有碰過的)────────────────────────────
const K = new Map();
function loadK(sym) {
    if (K.has(sym)) return K.get(sym);
    const p = path.join(DATA, `${sym}.json`);
    let r = null;
    try {
        const rows = JSON.parse(fs.readFileSync(p, 'utf-8'));
        const d = [], o = [], h = [], l = [], c = [], amt = [];
        for (const x of rows) {
            const cc = +(x.close || 0); if (!(cc > 0)) continue;
            d.push(String(x.date).replace(/\//g, '-').slice(0, 10));
            o.push(+(x.open || cc)); h.push(+(x.high || cc)); l.push(+(x.low || cc)); c.push(cc);
            amt.push((+(x.volume || 0)) * cc / 1e8);   // 成交金額(億)
        }
        if (c.length > 60) r = { d, o, h, l, c, amt, i: new Map(d.map((x, k) => [x, k])) };
    } catch (_) { r = null; }
    K.set(sym, r); return r;
}

// ── 讀 ETF 持股 ──────────────────────────────────────────────
const days = fs.readdirSync(SRC).filter(x => /^\d{8}$/.test(x)).sort();
const iso = s => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const isTw = s => /^\d{4}$/.test(String(s || '').trim());
log(`🚦 ETF 跟車回測 ・持股資料 ${days.length} 天(${iso(days[0])} ~ ${iso(days[days.length - 1])})`);

// hold[etf] = Map(sym → shares) 上一天的狀態
const prevHold = new Map();
const B = new Map();          // 事件桶
const put = (k, rec) => { if (!B.has(k)) B.set(k, []); B.get(k).push(rec); };
const seen = new Map();       // 去重:`${k}|${sym}` → 上次事件的 index
let baseHeld = [];            // 對照組 B:被持有但沒動
let etfSet = new Set();
const actByDay = new Map();   // `${day}|${sym}` → 幾檔 ETF 主動加碼

function fwdRet(sym, day) {
    const R = loadK(sym); if (!R) return null;
    const i = R.i.get(day); if (i == null) return null;
    const e = i + 1; if (e >= R.c.length) return null;
    const entry = R.o[e] > 0 ? R.o[e] : R.c[e];
    if (!(entry > 0)) return null;
    // ⛔ 排除隔天開盤仍鎖漲停(買不到)
    if (R.c[i] > 0 && (R.o[e] - R.c[i]) / R.c[i] > 0.093 && R.h[e] === R.l[e]) return null;
    const ti = mIdx.get(day); if (ti == null || ti + 1 >= mC.length) return null;
    const out = {};
    for (const f of FWD) {
        const j = Math.min(R.c.length - 1, e + f - 1), tj = Math.min(mC.length - 1, ti + 1 + f - 1);
        if (j <= e - 1) continue;
        out[f] = (R.c[j] - entry) / entry * 100 - (mC[tj] - mC[ti + 1]) / mC[ti + 1] * 100;
    }
    return Object.keys(out).length ? out : null;
}

let dayI = 0;
for (const dstr of days) {
    const day = iso(dstr); dayI++;
    const dir = path.join(SRC, dstr);
    for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        const etf = f.slice(0, -5); etfSet.add(etf);
        let rows; try { rows = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')); } catch (_) { continue; }
        const cur = new Map();
        for (const r of rows) {
            const sc = String(r.stockCode || '').trim();
            if (!isTw(sc)) continue;
            cur.set(sc, { sh: +(r.shares || 0), w: +(r.weight || 0), dw: +(r.diffWeight || 0), isNew: !!r.isNew });
        }
        const prev = prevHold.get(etf);
        prevHold.set(etf, cur);
        if (!prev || !prev.size) continue;

        // ⭐ 規模成長率 g = 共同持股的 shares 變動率**中位數**(⛔ 不用總和 —— 不同股價不可直接加)
        const gs = [];
        for (const [s, v] of cur) { const p = prev.get(s); if (p && p.sh > 0 && v.sh > 0) gs.push(v.sh / p.sh - 1); }
        if (gs.length < 5) continue;
        gs.sort((a, b) => a - b);
        const g = gs[Math.floor(gs.length / 2)];

        for (const [sym, v] of cur) {
            const p = prev.get(sym);
            const ret = fwdRet(sym, day); if (!ret) continue;
            const rec = { ret, day, sym, etf };
            const fire = k => {
                const key = `${k}|${sym}`, last = seen.get(key);
                if (last != null && dayI - last < DEDUP) return;
                seen.set(key, dayI); put(k, rec);
            };
            if (!p || !(p.sh > 0)) { fire('🆕 新買進(ETF 之前沒有這檔)'); continue; }
            const a = (v.sh / p.sh - 1) - g;          // ⭐ 主動變動率(剔除規模)
            const rawUp = v.sh > p.sh;                 // 天真版①:shares 變多
            const wUp = v.dw > 0;                      // 天真版②:weight 變高
            if (a >= 0.20) fire('📈📈 真加碼 ≥20%(剔除規模後)');
            if (a >= 0.05) {
                fire('📈 真加碼 ≥5%(剔除規模後)');
                actByDay.set(`${day}|${sym}`, (actByDay.get(`${day}|${sym}`) || 0) + 1);
            } else if (a <= -0.05) fire('📉 真減碼 ≥5%(剔除規模後)');
            else { baseHeld.push(rec); }               // 對照組 B:持有但沒主動動
            if (rawUp) fire('⚠️ 天真版①:shares 變多就算加碼');
            if (wUp) fire('⚠️ 天真版②:weight 變高就算加碼');
        }
        // 🚪 清倉
        for (const [sym, p] of prev) {
            if (cur.has(sym) || !(p.sh > 0)) continue;
            const ret = fwdRet(sym, day); if (!ret) continue;
            const key = `🚪 清倉|${sym}`, last = seen.get(key);
            if (last != null && dayI - last < DEDUP) continue;
            seen.set(key, dayI); put('🚪 清倉(ETF 整檔賣掉)', { ret, day, sym, etf });
        }
    }
}
// 🔥 多檔 ETF 同一天真加碼
{
    const seen2 = new Map();
    for (const [k, n] of actByDay) {
        if (n < 2) continue;
        const [day, sym] = k.split('|');
        const ret = fwdRet(sym, day); if (!ret) continue;
        const key = sym, last = seen2.get(key);
        const di = days.indexOf(day.replace(/-/g, ''));
        if (last != null && di - last < DEDUP) continue;
        seen2.set(key, di); put('🔥 ≥2 檔 ETF 同一天真加碼', { ret, day, sym });
    }
}

// ── 全市場對照組(A)────────────────────────────────────────
const lo = iso(days[0]), hi = iso(days[days.length - 1]);
const baseAll = [];
for (const f of fs.readdirSync(DATA).filter(x => /^\d{4}\.json$/.test(x))) {
    const R = loadK(f.slice(0, 4)); if (!R) continue;
    for (let i = 0; i < R.d.length; i += 3) {          // 每 3 天取樣(⛔ 只為了控制記憶體,不影響無偏性)
        if (R.d[i] < lo || R.d[i] > hi) continue;
        const r = fwdRet(f.slice(0, 4), R.d[i]); if (r) baseAll.push({ ret: r });
    }
}

// ── ⭐⭐ 對照組(C):同期「成交金額前 N 名」的股票 ──────────────────
//   🚨 為什麼一定要有這一組:對照組(A)是**全市場 2,300 檔**(含一堆冷門小型股),
//   而主動式 ETF 的持股幾乎都是**大型權值股** → 「ETF 持股贏全市場」很可能只是
//   **市值/流動性效應**,⛔ 不是「經理人會選股」。這一組把兩邊的級距拉到同一層。
const TOPN = +(process.env.TOPN || 100);
const baseTop = [];
{
    const syms = fs.readdirSync(DATA).filter(x => /^\d{4}\.json$/.test(x)).map(x => x.slice(0, 4));
    const byDay = new Map();
    for (const sy of syms) {
        const R = loadK(sy); if (!R) continue;
        for (let i = 0; i < R.d.length; i++) {
            const dd = R.d[i]; if (dd < lo || dd > hi) continue;
            if (!byDay.has(dd)) byDay.set(dd, []);
            byDay.get(dd).push([sy, R.amt[i] || 0]);
        }
    }
    for (const [dd, arr] of byDay) {
        arr.sort((a, b) => b[1] - a[1]);
        for (const [sy] of arr.slice(0, TOPN)) {
            const r = fwdRet(sy, dd); if (r) baseTop.push({ ret: r, day: dd });
        }
    }
}
// 🚧 空過守門:ETF 持股真的落在那個級距嗎?對不上的話這組對照就沒有意義
{
    const amtOf = (sy, dd) => { const R = loadK(sy); if (!R) return null; const i = R.i.get(dd); return i == null ? null : R.amt[i]; };
    const hv = baseHeld.map(x => amtOf(x.sym, x.day)).filter(Number.isFinite).sort((a, b) => a - b);
    if (hv.length) log(`   🔎 ETF 持股當日成交金額中位 ${hv[Math.floor(hv.length / 2)].toFixed(1)} 億`
        + ` ・對照組(C)= 每天成交金額前 ${TOPN} 名 ・${baseTop.length.toLocaleString()} 個(股·日)`);
}

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const wr = a => a.length ? a.filter(x => x > 0).length / a.length * 100 : NaN;
const col = (arr, f) => arr.map(x => x.ret[f]).filter(Number.isFinite);
const f2 = x => Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(2) : ' n/a';

log(`✅ ETF ${etfSet.size} 檔 ・事件桶 ${B.size} 種`);
log(`   對照組(A)全市場 ${baseAll.length.toLocaleString()} 個(股·日)・(B)被持有但沒動 ${baseHeld.length.toLocaleString()} 筆\n`);
if (baseAll.length < 5000) { console.error('🚨 對照組太小,不下結論'); process.exit(1); }

for (const F of FWD) {
    const bA = mean(col(baseAll, F)), bB = mean(col(baseHeld, F)), bC = mean(col(baseTop, F));
    log('═'.repeat(108));
    log(`📅 前瞻 ${F} 日 ・對照組(A)全市場 ${f2(bA)}% ・(C)成交額前 ${TOPN} 名 ${f2(bC)}%`
        + ` ・(B)被 ETF 持有沒動 ${f2(bB)}%`);
    log(`   🚨 「被 ETF 持有」vs 全市場 ${f2(bB - bA)}pp ・⭐ vs 同級距(C) ${f2(bB - bC)}pp`
        + `  ← 後者才是「經理人會不會選股」;前者混了市值/流動性效應`);
    log('─'.repeat(108));
    log('事件'.padEnd(36) + '   n      報酬     上漲%   vs全市場   ⭐vs同ETF沒動   前後半');
    const mid = days[Math.floor(days.length / 2)];
    for (const [k, arr] of [...B.entries()].sort((a, b) => mean(col(b[1], F)) - mean(col(a[1], F)))) {
        const v = col(arr, F); if (v.length < 30) continue;
        const m = mean(v);
        const h1 = mean(col(arr.filter(x => x.day.replace(/-/g, '') < mid), F));
        const h2 = mean(col(arr.filter(x => x.day.replace(/-/g, '') >= mid), F));
        const s1 = h1 - mean(col(baseHeld.filter(x => x.day.replace(/-/g, '') < mid), F));
        const s2 = h2 - mean(col(baseHeld.filter(x => x.day.replace(/-/g, '') >= mid), F));
        log(k.padEnd(34) + String(v.length).padStart(7) + f2(m).padStart(9) + wr(v).toFixed(1).padStart(8)
            + f2(m - bA).padStart(10) + f2(m - bB).padStart(13)
            + `   ${f2(s1)}/${f2(s2)}${(s1 > 0) === (s2 > 0) ? ' ✅' : ' ❌'}`);
    }
}
log('═'.repeat(108));
log(`\n🧭 怎麼讀`);
log(`   ⭐ **「vs 同ETF沒動」那一欄才是答案** —— 它共用「被主動式 ETF 挑中」那條腿,`);
log(`      量到的才是「**加碼這個動作**」本身;「vs 全市場」混了「被 ETF 持有」的效果。`);
log(`   🚨 「⚠️ 天真版①/②」是**故意放進來的錯誤定義**:①含基金規模成長 ②含當天漲跌 →`);
log(`      它們跟「真加碼」給出不同答案這件事本身就是結論。`);
log(`\n⚠️ 限制(⛔ 不可省略):`);
log(`   ・持股只有 ${days.length} 天(${lo} ~ ${hi})→ ⛔ **逐年檢定做不了**,只有前後半;`);
log(`   ・主動式 ETF 2025 才上市、期間都在建倉 → 窗口單一,⛔ 不可外推;`);
log(`   ・進場用 D+1 開盤(持股收盤後才公布);若那份資料其實是 D−1 的持股,這樣更保守。`);
log(`   ・報酬**未扣**來回成本 ${COST}%(比較用同一把尺;要當策略請自己扣)。`);
log(`\n⏱️  ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
