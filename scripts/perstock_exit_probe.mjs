#!/usr/bin/env node
/**
 * 🚪 逐檔「這一檔最適合哪一種出場」實測(V74.6.1)
 *
 * 使用者:「對於每個個股個性,他們的進場、加碼及退場都有做了嗎?」
 * ⭐ 進場已經是 per-stock(這一檔自己最會賺的那一招);
 *   ⛔ 但**出場全 App 共用同一條 `_exitPrimary`** —— 「哪一種出場最適合這一檔」從來沒有逐檔挑過。
 *
 * 🚨 實驗設計上最關鍵的一件事(第一版做錯,寫下來免得再犯):
 *   一開始想「用 6 種 EXIT 各跑一次 portfolio_backtest,再逐檔比」——⛔ **那不可比**,
 *   因為 `portfolio_backtest` 的訊號推進是 `i = exitIdx + 1`(出場早 → 下一個訊號更早進得來)
 *   → **不同出場會產生不同的進場點集合**,比到最後分不出是「出場好」還是「進場點不同」。
 *   ⭐ 正解:**固定同一批進場點**,只換出場 —— 這支就是這樣做的(控制變因)。
 *
 * 做法跟 `perstock_indicator_probe.mjs` 完全一樣(⛔ 不另立一套判準):
 *  ① 前半段學「這一檔哪種出場最好」→ 後半段驗收;⭐ 再反過來做一次
 *  ② 排序用保守下界 mean − 1.28×sd/√n(⛔ 不排點估計值)
 *  ③ 🚨 **先報「學到的東西穩不穩」(兩段挑到同一種的比例),再談報酬**
 *  ④ 對照組**共用同一批股票、同一段時間**:隨便挑一種 / 全市場最好的那一種 / **現行的跌破 5 日線**
 *
 * 進場點 = `lib_indicators.signalsFor()` 的全部事件(⛔ 不自己再定義訊號);訊號日收盤價進場。
 * 出場 = 跟 App `_exitLines()` **同一組公式**(ma5 / 唐奇安20 / 進場後最高收盤−2×ATR14 / 移動停利8%),
 *        再加 App 同款的停損 min(前一根低點, −5%) 與最長 20 個交易日。
 * ⚠️ 這是這組公式在本 repo 的**第三份實作**(App / portfolio_backtest / 這裡)——
 *   ⛔ 改任何一邊都要三邊一起改;`--selftest` 用合成 K 線把每一種出場的行為釘住。
 */
import fs from 'fs';
import path from 'path';
import { signalsFor } from './lib_indicators.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const COST = 0.44, MAXD = 20, HOLD_STOP = 5;
const MIN_TRAIN = 5, MIN_TEST = 3;
const LIMIT = +(process.env.LIMIT || 0);
const SELFTEST = process.argv.includes('--selftest');

const RULES = ['ma5', 'don20', 'atr2', 'trail8'];
const NAME = { ma5: '跌破 5 日線(現行)', don20: '唐奇安 20 日', atr2: 'ATR 追蹤 K=2', trail8: '移動停利 8%' };

// ═══ 出場模擬:同一個進場點 → 四種出場各自的報酬 ═══
//   ⛔ 一律只用「當天為止」的資訊(peak/atr/don 都是到 j 為止),零前視。
function simExits(R, eIdx) {
    const n = R.length, entry = R[eIdx].c;
    if (!(entry > 0)) return null;
    const stop0 = Math.min(R[eIdx].l, entry * (1 - HOLD_STOP / 100));   // App 同款:前一根低點與 −5% 取較近
    const endJ = Math.min(n - 1, eIdx + MAXD);
    const atrAt = j => { let s = 0, m = 0;
        for (let q = Math.max(1, j - 13); q <= j; q++) { const pc = R[q - 1].c; if (!(pc > 0)) continue;
            s += Math.max(R[q].h - R[q].l, Math.abs(R[q].h - pc), Math.abs(R[q].l - pc)); m++; }
        return m ? s / m : 0; };
    const out = {};
    for (const rule of RULES) {
        let peak = entry, exitP = null, exitIdx = endJ;
        for (let j = eIdx + 1; j <= endJ; j++) {
            const c = R[j].c;
            if (c > peak) peak = c;
            if (c <= stop0) { exitP = stop0; exitIdx = j; break; }          // 停損優先(跟 App 一致)
            if (rule === 'ma5' && j >= 4) {
                let s = 0; for (let q = j - 4; q <= j; q++) s += R[q].c;
                if (c < s / 5) { exitP = c; exitIdx = j; break; }
            } else if (rule === 'don20') {
                let lo = Infinity; for (let q = Math.max(0, j - 20); q < j; q++) lo = Math.min(lo, R[q].l);
                if (isFinite(lo) && c < lo) { exitP = c; exitIdx = j; break; }
            } else if (rule === 'atr2') {
                const at = atrAt(j);
                if (at > 0 && c <= peak - 2 * at) { exitP = c; exitIdx = j; break; }
            } else if (rule === 'trail8') {
                if (c <= peak * 0.92) { exitP = c; exitIdx = j; break; }
            }
            if (j === endJ) { exitP = c; exitIdx = j; }
        }
        if (exitP == null) { exitP = R[endJ].c; exitIdx = endJ; }
        out[rule] = { ret: (exitP - entry) / entry * 100, outIdx: exitIdx };
    }
    return out;
}

// ═══ 🧪 自我驗證:合成 K 線,每一種出場都要在**已知的那一天**觸發 ═══
if (SELFTEST) {
    const mk = a => a.map(x => ({ d: '', o: x, h: x * 1.002, l: x * 0.998, c: x, v: 1 }));
    let bad = 0;
    const chk = (nm, c, k, want) => { const ok = c === want; if (!ok) bad++;
        console.log(`${ok ? '✅' : '❌'} ${nm}:${k} 在第 ${c} 根出場(預期 ${want})`); };
    // ① 一路漲到第 30 根、之後直直落
    //   ⚠️ 測資**自己先算一遍**(⛔ 別讓斷言去猜):
    //     進場 index 18 → entry 118、endJ = 18+20 = 38(⛔ 第一版進場放 10 → endJ 只到 30,
    //     根本到不了預期那一天,是「測資錯不是程式錯」)。
    //     peak = 130(index 30)→ trail8 觸發價 130×0.92 = 119.6
    //     → 跌序列 128,126,124,122,120,118 → 第一根 ≤119.6 的是 118 = index 36
    //     停損 = min(前一根低點 117.76, 118×0.95 = 112.1) = 112.1 → 在 36 還沒被摸到 ✓
    {
        const a = []; for (let i = 0; i < 31; i++) a.push(100 + i);          // 100→130
        for (let i = 1; i <= 20; i++) a.push(130 - i * 2);                    // 128,126,…
        const R = mk(a), r = simExits(R, 18);
        chk('移動停利 8%', r.trail8.outIdx, 'trail8', 36);
        // ⭐ 結構性斷言(⛔ 不猜確切那一天):2×ATR(≈2.5)遠小於 8%×130(=10.4)
        //   → ATR 追蹤一定比移動停利早出;而 5 日線又比 ATR 更敏感
        chk('ATR 追蹤要早於移動停利', r.atr2.outIdx < r.trail8.outIdx, 'atr2<trail8', true);
        chk('5 日線要早於(或等於)ATR 追蹤', r.ma5.outIdx <= r.atr2.outIdx, 'ma5<=atr2', true);
    }
    // ② 一路漲、完全不回頭 → 四種都應該撐到 MAXD 封頂
    {
        const a = []; for (let i = 0; i < 60; i++) a.push(100 * Math.pow(1.02, i));
        const R = mk(a), r = simExits(R, 20);
        for (const k of RULES) chk('一路漲不回頭 → 撐到 20 天封頂', r[k].outIdx, k, 40);
    }
    console.log(bad ? `\n❌ selftest ${bad} 條不符` : '\n✅ selftest 通過');
    process.exit(bad ? 1 : 0);
}

// ═══ 大盤(扣同期加權)═══
const twii = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8')).filter(r => r && r.close > 0);
const mkt = new Map(), mdays = [];
for (const r of twii) { const d = String(r.date || '').replace(/\//g, '-').slice(0, 10); if (d) { mkt.set(d, +r.close); mdays.push(d); } }
const mIdx = new Map(mdays.map((d, i) => [d, i]));
const mktBetween = (d0, d1) => { const a = mIdx.get(d0), b = mIdx.get(d1);
    if (a == null || b == null || b <= a) return null; return (mkt.get(mdays[b]) / mkt.get(mdays[a]) - 1) * 100; };

let files = fs.readdirSync(DATA).filter(f => /^\d{4,5}\.json$/.test(f));
if (LIMIT) files = files.slice(0, LIMIT);
const readOne = f => {
    let rows; try { rows = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { return null; }
    if (!Array.isArray(rows) || rows.length < 340) return null;
    const R = rows.filter(r => r && +r.close > 0 && +r.open > 0 && +r.high > 0 && +r.low > 0).map(r => ({
        d: String(r.date || '').replace(/\//g, '-').slice(0, 10),
        o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +r.volume || 0 })).filter(r => r.d);
    return R.length < 340 ? null : R;
};

// ═══ 掃描 ═══
console.log('🔎 掃描中(進場點 = lib_indicators 的全部事件,固定同一批;只換出場)…');
const st = new Map();            // sym → Map(rule → [n1,s1,q1,n2,s2,q2])
const dayCnt = new Map();
const pend = [];                 // 先收 (sym, d, rets),等中點算出來再分半
let nSym = 0, nEv = 0;
for (const f of files) {
    const R = readOne(f); if (!R) continue;
    const sym = f.replace('.json', '');
    const { hits } = signalsFor(R);
    const seen = new Set();
    for (const [, idxs] of hits) for (const i of idxs) seen.add(i);       // ⭐ 進場點去重(同一天只進一次)
    const idxs = [...seen].sort((a, b) => a - b);
    let last = -1e9;
    for (const i of idxs) {
        if (i - last < 10) continue;                                      // 同檔 10 日去重
        if (i + MAXD >= R.length) continue;
        const r = simExits(R, i); if (!r) continue;
        const rec = { sym, d: R[i].d, r: {} };
        let okAll = true;
        for (const k of RULES) {
            const m = mktBetween(R[i].d, R[r[k].outIdx].d);
            if (m == null) { okAll = false; break; }
            rec.r[k] = r[k].ret - m - COST;                               // ⭐ 扣同期大盤 + 來回成本
        }
        if (!okAll) continue;
        last = i; pend.push(rec); nEv++;
        dayCnt.set(rec.d, (dayCnt.get(rec.d) || 0) + 1);
    }
    nSym++;
    if (nSym % 400 === 0) process.stdout.write(`\r   ${nSym} 檔 / ${nEv} 個進場點`);
}
const days = [...dayCnt.keys()].sort();
let tot = 0; for (const d of days) tot += dayCnt.get(d);
let acc = 0, MID = days[0];
for (const d of days) { acc += dayCnt.get(d); if (acc >= tot / 2) { MID = d; break; } }
for (const rec of pend) {
    let m = st.get(rec.sym); if (!m) { m = new Map(); st.set(rec.sym, m); }
    const off = rec.d < MID ? 0 : 3;
    for (const k of RULES) { let a = m.get(k); if (!a) { a = [0, 0, 0, 0, 0, 0]; m.set(k, a); }
        a[off]++; a[off + 1] += rec.r[k]; a[off + 2] += rec.r[k] * rec.r[k]; }
}
console.log(`\r✅ ${nSym} 檔 ・${nEv.toLocaleString()} 個進場點 ・${days[0]} ~ ${days[days.length - 1]} ・中點 ${MID}          \n`);

const H1 = a => [a[0], a[1], a[2]], H2 = a => [a[3], a[4], a[5]];
const lb = h => { const n = h[0]; if (n < 2) return null; const m = h[1] / n;
    const v = Math.max(0, h[2] / n - m * m), sd = Math.sqrt(v * n / (n - 1));
    return m - 1.28 * sd / Math.sqrt(n); };
const pick = half => { const out = new Map();
    for (const [sym, m] of st) { let bk = null, bv = -Infinity;
        for (const [r, a] of m) { const h = half(a); if (h[0] < MIN_TRAIN) continue;
            const v = lb(h); if (v != null && v > bv) { bv = v; bk = r; } }
        if (bk) out.set(sym, bk); }
    return out; };
const b1 = pick(H1), b2 = pick(H2);

console.log('═'.repeat(74));
console.log('🧲 ① 名單穩定度 —— 前半段挑到的出場,後半段還是同一種嗎?');
console.log('   (⭐ 這一關比報酬快也更決定性:學到的不是同一批 → 報酬再漂亮都是湊出來的)');
const both = [...b1.keys()].filter(s => b2.has(s));
let same = 0; for (const s of both) if (b1.get(s) === b2.get(s)) same++;
console.log(`   兩段都挑得出來:${both.length} 檔 ・可挑 ${RULES.length} 種`);
console.log(`   ⭐ 兩段挑到**同一種**:${same} 檔 = ${(same / both.length * 100).toFixed(1)}%   (隨機期望 ${(100 / RULES.length).toFixed(1)}%)`);
const cnt = (mp, r) => [...mp.values()].filter(x => x === r).length;
console.log('   前半挑中:' + RULES.map(r => `${NAME[r]} ${cnt(b1, r)}`).join(' ・'));
console.log('   後半挑中:' + RULES.map(r => `${NAME[r]} ${cnt(b2, r)}`).join(' ・') + '\n');

const agg = a => { let n = 0, s = 0; for (const [x, y] of a) { n += x; s += y; } return { n, m: n ? s / n : null }; };
const run = (label, learn, verify, best) => {
    const syms = [...best.keys()].filter(s => st.has(s));
    const A = [], B = [], C = [], D = [];
    const g = new Map();
    for (const s of syms) for (const [r, a] of st.get(s)) { const h = learn(a); if (!h[0]) continue;
        let o = g.get(r); if (!o) { o = [0, 0, 0]; g.set(r, o); } o[0] += h[0]; o[1] += h[1]; o[2] += h[2]; }
    let gk = null, gv = -Infinity;
    for (const [r, o] of g) { const v = lb(o); if (v != null && v > gv) { gv = v; gk = r; } }
    for (const s of syms) { const m = st.get(s);
        const p = m.get(best.get(s)); if (p) { const h = verify(p); if (h[0] >= MIN_TEST) A.push([h[0], h[1]]); }
        let ks = 0, kn = 0;
        for (const [, a] of m) { const h = verify(a); if (h[0] < MIN_TEST) continue; ks += h[1] / h[0]; kn++; }
        if (kn) B.push([1, ks / kn]);
        if (gk && m.get(gk)) { const h = verify(m.get(gk)); if (h[0] >= MIN_TEST) C.push([h[0], h[1]]); }
        if (m.get('ma5')) { const h = verify(m.get('ma5')); if (h[0] >= MIN_TEST) D.push([h[0], h[1]]); } }
    const a = agg(A), b = agg(B), c = agg(C), d = agg(D);
    const f = x => x.m == null ? '  —  ' : (x.m >= 0 ? '+' : '') + x.m.toFixed(2) + '%';
    console.log(`【${label}】驗收段 ${syms.length} 檔`);
    console.log(`   🎯 逐檔挑出場                  ${f(a)}   n=${a.n}`);
    console.log(`   🎲 對照:隨便挑一種             ${f(b)}   ${b.n} 檔`);
    console.log(`   🌍 對照:全市場最好的那一種     ${f(c)}   n=${c.n}   (${NAME[gk] || gk})`);
    console.log(`   🚪 對照:**現行的跌破 5 日線**  ${f(d)}   n=${d.n}`);
    if (a.m != null) { const e = (x, l) => x.m == null ? '' : ` ・vs ${l} ${(a.m - x.m >= 0 ? '+' : '') + (a.m - x.m).toFixed(2)}pp`;
        console.log(`   ⭐ 逐檔挑${e(b, '隨便挑')}${e(c, '全市場最好')}${e(d, '現行 5 日線')}`); }
    console.log('');
};
console.log('═'.repeat(74));
console.log('📊 ② 每趟報酬(已扣同期大盤 + 來回成本 0.44%;⛔ 四個對照組共用同一批股票)\n');
run(`正向:${days[0]}~${MID} 學 → 之後驗收`, H1, H2, b1);
run(`反向:${MID} 之後學 → ${days[0]}~${MID} 驗收`, H2, H1, b2);
console.log('═'.repeat(74));
console.log('⚠️ 限制:比的是**每一趟的平均**,⛔ 不是整套組合的總獲利(那會被資金路徑帶著跑);');
console.log('   進場點固定用同一批(控制變因)→ ⛔ 不可拿這裡的絕對數字跟組合回測比。窗口偏多頭。');
