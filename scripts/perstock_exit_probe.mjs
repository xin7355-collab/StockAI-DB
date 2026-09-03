#!/usr/bin/env node
/**
 * 🚪 逐檔「這一檔最適合哪一種出場」實測(V74.6.1)
 *
 * 使用者:「對於每個個股個性,他們的進場、加碼及退場都有做了嗎?」
 * ⭐ 進場已經是 per-stock(這一檔自己最會賺的那一招);
 *   ⛔ 但**出場全 App 共用同一條規則** —— 「哪一種出場最適合這一檔」從來沒有逐檔挑過。這支就是補這一塊。
 *
 * 做法跟 `perstock_indicator_probe.mjs` **完全一樣**(⛔ 不另立一套判準):
 *  ① 前半段學「這一檔哪種出場最好」→ 後半段驗收;⭐ 再反過來做一次
 *  ② 排序用保守下界 mean − 1.28×sd/√n(⛔ 不排點估計值)
 *  ③ 🚨 **先報「學到的東西穩不穩」(兩段挑到同一種出場的比例),再談報酬**
 *  ④ 對照組**共用同一批股票、同一段時間**:隨便挑一種 / 全市場最好的那一種 / **現行的跌破 5 日線**
 *
 * 輸入:`portfolio_backtest.mjs` 用 6 種 EXIT 各跑一次留下的 TRADES_CACHE
 *   (同一批訊號、只換出場 → 逐檔比較才公平)。⛔ 這支不自己掃 K 線,不會產生第二份真相。
 */
import fs from 'fs';
import path from 'path';

const DIR = process.env.EXITDIR || '/tmp/exitcache';
const COST = 0.44;
const MIN_TRAIN = 5, MIN_TEST = 3;
const RULES = (process.env.RULES || 'ma5,don20,chand2,trail8,don10,ma20').split(',');
const NAME = { ma5: '跌破 5 日線(現行)', ma20: '跌破 20 日線', don20: '唐奇安 20 日', don10: '唐奇安 10 日', chand2: 'ATR 追蹤 K=2', trail8: '移動停利 8%' };

// ═══ 讀進來,對齊成 (sym|key|inD) → { rule: ret } ═══
const rows = new Map();          // 訊號 → { d, sym, r: {rule: ret} }
const have = [];
for (const r of RULES) {
    const f = path.join(DIR, r + '.json');
    if (!fs.existsSync(f)) { console.log(`⏭️ 缺 ${r}.json,略過`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    have.push(r);
    for (const t of j.trades) {
        const k = `${t.sym}|${t.key}|${t.inD}`;
        let o = rows.get(k); if (!o) { o = { d: t.inD, sym: t.sym, r: {} }; rows.set(k, o); }
        o.r[r] = +t.ret;
    }
}
if (have.length < 3) { console.log('❌ 至少要 3 種出場才比得動'); process.exit(1); }
// ⛔ 只留「每一種出場都算得出來」的訊號 —— 缺一種就不可比(⛔ 不可用不同母體互比)
const all = [...rows.values()].filter(o => have.every(r => o.r[r] != null));
console.log(`📊 出場規則 ${have.length} 種:${have.join(' / ')}`);
console.log(`   可比訊號 ${all.length.toLocaleString()} 筆(⛔ 已剔除任一種出場算不出來的)`);

// ═══ 中點從**實際樣本**推(⛔ 不寫死)═══
const ds = all.map(o => o.d).sort();
const MID = ds[Math.floor(ds.length / 2)];
console.log(`   ${ds[0]} ~ ${ds[ds.length - 1]} ・樣本中點 ${MID}\n`);

// ═══ 逐檔 × 出場 × 前/後半 統計 ═══
const st = new Map();            // sym → Map(rule → [n1,s1,q1,n2,s2,q2])
for (const o of all) {
    let m = st.get(o.sym); if (!m) { m = new Map(); st.set(o.sym, m); }
    const off = o.d < MID ? 0 : 3;
    for (const r of have) {
        let a = m.get(r); if (!a) { a = [0, 0, 0, 0, 0, 0]; m.set(r, a); }
        const v = o.r[r] - COST;                    // ⭐ 一律先扣成本再比
        a[off]++; a[off + 1] += v; a[off + 2] += v * v;
    }
}
const H1 = a => [a[0], a[1], a[2]], H2 = a => [a[3], a[4], a[5]];
const lb = h => { const n = h[0]; if (n < 2) return null; const m = h[1] / n;
    const v = Math.max(0, h[2] / n - m * m), sd = Math.sqrt(v * n / (n - 1));
    return m - 1.28 * sd / Math.sqrt(n); };

const pick = half => {
    const out = new Map();
    for (const [sym, m] of st) {
        let bk = null, bv = -Infinity;
        for (const [r, a] of m) { const h = half(a); if (h[0] < MIN_TRAIN) continue;
            const v = lb(h); if (v != null && v > bv) { bv = v; bk = r; } }
        if (bk) out.set(sym, bk);
    }
    return out;
};
const b1 = pick(H1), b2 = pick(H2);

// ═══ ① 先報名單穩定度 ═══
console.log('═'.repeat(74));
console.log('🧲 ① 名單穩定度 —— 前半段挑到的出場,後半段還是同一種嗎?');
console.log('   (⭐ 這一關比報酬快、也比報酬決定性 —— 學到的不是同一批,報酬再漂亮都是湊出來的)');
const both = [...b1.keys()].filter(s => b2.has(s));
let same = 0; for (const s of both) if (b1.get(s) === b2.get(s)) same++;
const rnd = 100 / have.length;
console.log(`   兩段都挑得出來的股票:${both.length} 檔 ・可挑 ${have.length} 種出場`);
console.log(`   ⭐ 兩段挑到**同一種**出場:${same} 檔 = ${(same / both.length * 100).toFixed(1)}%   (隨機期望 ${rnd.toFixed(1)}%)`);
// 各出場被挑中的次數(⭐ 若集中在同一種 → 那不是「逐檔個性」,是「那一種本來就比較好」)
const cnt = r => [...b1.values()].filter(x => x === r).length;
console.log('   前半段各出場被挑中:' + have.map(r => `${NAME[r] || r} ${cnt(r)}`).join(' ・') + '\n');

// ═══ ② 報酬 ═══
const agg = a => { let n = 0, s = 0; for (const [x, y] of a) { n += x; s += y; } return { n, m: n ? s / n : null }; };
const run = (label, learn, verify, best) => {
    const syms = [...best.keys()].filter(s => st.has(s));
    const A = [], B = [], C = [], D = [];
    // 全市場最好的那一種(用訓練段選)
    const g = new Map();
    for (const s of syms) for (const [r, a] of st.get(s)) { const h = learn(a); if (!h[0]) continue;
        let o = g.get(r); if (!o) { o = [0, 0, 0]; g.set(r, o); } o[0] += h[0]; o[1] += h[1]; o[2] += h[2]; }
    let gk = null, gv = -Infinity;
    for (const [r, o] of g) { const v = lb(o); if (v != null && v > gv) { gv = v; gk = r; } }
    for (const s of syms) {
        const m = st.get(s);
        const p = m.get(best.get(s)); if (p) { const h = verify(p); if (h[0] >= MIN_TEST) A.push([h[0], h[1]]); }
        let ks = 0, kn = 0;
        for (const [, a] of m) { const h = verify(a); if (h[0] < MIN_TEST) continue; ks += h[1] / h[0]; kn++; }
        if (kn) B.push([1, ks / kn]);
        if (gk && m.get(gk)) { const h = verify(m.get(gk)); if (h[0] >= MIN_TEST) C.push([h[0], h[1]]); }
        if (m.get('ma5')) { const h = verify(m.get('ma5')); if (h[0] >= MIN_TEST) D.push([h[0], h[1]]); }
    }
    const a = agg(A), b = agg(B), c = agg(C), d = agg(D);
    const f = x => x.m == null ? '  —  ' : (x.m >= 0 ? '+' : '') + x.m.toFixed(2) + '%';
    console.log(`【${label}】驗收段 ${syms.length} 檔`);
    console.log(`   🎯 逐檔挑出場                 ${f(a)}   n=${a.n}`);
    console.log(`   🎲 對照:隨便挑一種出場       ${f(b)}   ${b.n} 檔`);
    console.log(`   🌍 對照:全市場最好的那一種   ${f(c)}   n=${c.n}   (${NAME[gk] || gk})`);
    console.log(`   🚪 對照:**現行的跌破 5 日線** ${f(d)}   n=${d.n}`);
    if (a.m != null) {
        const e = (x, l) => x.m == null ? '' : ` ・vs ${l} ${(a.m - x.m >= 0 ? '+' : '') + (a.m - x.m).toFixed(2)}pp`;
        console.log(`   ⭐ 逐檔挑${e(b, '隨便挑')}${e(c, '全市場最好')}${e(d, '現行 5 日線')}`);
    }
    console.log('');
};
console.log('═'.repeat(74));
console.log('📊 ② 每趟報酬(已扣來回成本 0.44%;⛔ 四個對照組共用同一批股票)\n');
run(`正向:${ds[0]}~${MID} 學 → 之後驗收`, H1, H2, b1);
run(`反向:${MID} 之後學 → ${ds[0]}~${MID} 驗收`, H2, H1, b2);
console.log('═'.repeat(74));
console.log('⚠️ 限制:這裡比的是**每一趟的平均報酬**,⛔ 不是整套組合的總獲利');
console.log('   (總獲利會被資金路徑帶著跑 —— V74.4.8 已記過那個坑)。窗口偏多頭。');
