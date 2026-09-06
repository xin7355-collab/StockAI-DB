#!/usr/bin/env node
/**
 * 🔄 週轉率「第三次」實測 —— 這次問的是**增量**:疊在現行配置之上還有沒有用?
 *
 * 使用者:「高周轉率有沒有參考價值」。
 *
 * ⚠️ 本專案**已經測過兩次**(⛔ 別再重測同一組):
 *   ① V72.0.1 `turnover_probe.py` —— 週轉率 × **昨日漲跌幅**(2,402 檔 / 227,412 事件)
 *      ・單看週轉率幾乎沒有鑑別力(最好與最差桶只差 0.17pp)
 *      ・❌「昨天小漲小跌 + 今天高週轉 = 今天不錯」不成立(次日 −0.09~−0.20pp)
 *      ・⭐ 真正有邊際的是**漲停隔日動能**,而週轉率決定強弱:中(1~3%)+1.54% 最強、
 *        極高(≥8%)反而衰減到 +0.78% → 已落地成當沖頁 `_limitUpMomentum`(⚠️ 只有次日有效)
 *   ② V72.4.9 `turnover_stage_probe.py` —— 週轉率 × **位階**
 *      ・❌「低檔高週轉 = 起漲」不成立(−0.06 ~ +0.09pp = 雜訊)
 *      ・❌「高檔高週轉 = 出貨」**方向剛好相反**(高檔 20~40% 桶 +0.44/+0.58/+0.87pp)
 *
 * ⭐ 所以這支**不重測那兩組**,只問唯一還沒答過、而且會改變做法的那一個:
 *   **「週轉率疊在現行配置(🧬 高位階 + 高波動)之上,有沒有增量?」**
 *   —— 這是 V73.2.5 的教訓:任何新條件都要測「疊在**現行配置**之上」的增量,
 *      ⛔ 不可只跟原始基準比(乖離那次就是「把高波動再數一次」,單獨看有效、疊上去沒有增量)。
 *
 * ⚠️ 週轉率的分母用集保 `t`(總股數)—— 那是**今天的快照**,回測期間當常數用。
 *    增資/減資的股票會有偏差,⛔ 但那對「分桶比較」的影響是二階的(桶內外都同樣受影響)。
 * ⚠️ 單位:`data/*.json` 個股 volume 是**股**,`t` 也是**股** → 相除單位約掉(不受陷阱 #17 影響)。
 *
 * ⛔ 六道關卡同 regime_probe:對照組不抽樣・20 日去重・扣同期加權・前後半同向・
 *    去最好年仍成立・扣來回成本 0.44%。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const LOOK = 250, VOLN = 20, DEDUP = 20, STEP = 3, COST = 0.44, MIN_EV = 1200;
const POS_MIN = 75, VOL_MIN = 60;      // ⭐ V73.2.3 建議值:位階 ≥75、波動位階 ≥60

const nd = d => String(d || '').replace(/\//g, '-').slice(0, 10);
const sum = a => a.reduce((x, y) => x + y, 0);
const mean = a => a.length ? sum(a) / a.length : 0;
const pct = (x, n) => n ? x / n * 100 : 0;
const f = (x, w = 7, p = 2) => (x >= 0 ? '+' : '') + x.toFixed(p).padStart(w);
const wr = a => pct(a.filter(x => x > 0).length, a.length);

const twiiRaw = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8'))
    .map(r => ({ d: nd(r.date), c: +r.close })).filter(r => r.d && r.c > 0);
const days = twiiRaw.map(r => r.d);
const dPos = new Map(days.map((d, i) => [d, i]));
const tw = Float64Array.from(twiiRaw.map(r => r.c));

const tdcc = JSON.parse(fs.readFileSync(path.join(DATA, 'tdcc_holders.json'), 'utf8'));

const files = fs.readdirSync(DATA).filter(x => /^\d{4}\.json$/.test(x) && !x.startsWith('00'));
const ST = new Map();
let used = 0, noShare = 0;
for (const fn of files) {
    const sym = fn.slice(0, 4);
    const t = +(tdcc[sym]?.t || 0);
    if (!(t > 0)) { noShare++; continue; }           // ⛔ 沒有總股數就算不出週轉率
    let arr; try { arr = JSON.parse(fs.readFileSync(path.join(DATA, fn), 'utf8')); } catch (_) { continue; }
    if (!Array.isArray(arr) || arr.length < 300) continue;
    const c = new Float64Array(days.length).fill(NaN);
    const v = new Float64Array(days.length).fill(NaN);
    let n = 0;
    for (const r of arr) {
        const i = dPos.get(nd(r.date)); const px = +r.close; const vol = +r.volume;
        if (i === undefined || !(px > 0)) continue;
        c[i] = px; if (vol > 0) v[i] = vol; n++;
    }
    if (n < 300) continue;
    ST.set(sym, { c, v, t }); used++;
}
const cover = days.map((_, i) => { let k = 0; for (const s of ST.values()) if (!Number.isNaN(s.c[i])) k++; return k; });
const START = Math.max(LOOK + 5, cover.findIndex(k => k >= used * 0.7));
const HALF_I = Math.floor((START + days.length) / 2);
const fwdEx = (c, i, h) => {
    const j = i + h; if (j >= days.length) return null;
    const a = c[i], b = c[j]; if (Number.isNaN(a) || Number.isNaN(b) || !(a > 0)) return null;
    return (b / a - 1) * 100 - (tw[j] / tw[i] - 1) * 100;
};

// 週轉率分桶(⭐ 對齊 V72.0.1 的桶 + 小哥說的 20%)
const BUCKETS = [
    ['t_lt1', '週轉率 <1%(冷門)', x => x < 1],
    ['t_1_3', '週轉率 1~3%', x => x >= 1 && x < 3],
    ['t_3_8', '週轉率 3~8%', x => x >= 3 && x < 8],
    ['t_8_20', '週轉率 8~20%', x => x >= 8 && x < 20],
    ['t_gt20', '週轉率 >20%(他說「高」)', x => x >= 20],
];
const mk = () => ({ n: 0, r20: [], r5: [], half: { a: [], b: [] }, yr: {} });
// 兩個母體:全市場 / 🧬 高位階+高波動 子集合
const POP = { all: { base: mk(), b: {} }, hi: { base: mk(), b: {} } };
for (const p of Object.values(POP)) for (const [k] of BUCKETS) p.b[k] = mk();
const lastHit = new Map();
let events = 0, hiN = 0;

const put = (o, i, y, x20, x5) => {
    o.n++;
    if (x20 !== null) { o.r20.push(x20); (i < HALF_I ? o.half.a : o.half.b).push(x20); (o.yr[y] ||= []).push(x20); }
    if (x5 !== null) o.r5.push(x5);
};

for (const [sym, S] of ST) {
    const { c, v, t } = S;
    // 日報酬 → 20 日波動
    const rr = new Float64Array(days.length).fill(NaN);
    for (let i = 1; i < days.length; i++) { const a = c[i - 1], b = c[i]; if (a > 0 && b > 0) rr[i] = (b / a - 1) * 100; }
    const vol = new Float64Array(days.length).fill(NaN);
    for (let i = VOLN; i < days.length; i++) {
        let s = 0, s2 = 0, n = 0;
        for (let j = i - VOLN + 1; j <= i; j++) { const x = rr[j]; if (!Number.isNaN(x)) { s += x; s2 += x * x; n++; } }
        if (n >= VOLN * 0.7) { const m = s / n; vol[i] = Math.sqrt(Math.max(0, s2 / n - m * m)); }
    }
    for (let i = START; i < days.length; i += STEP) {
        const px = c[i], vv = v[i];
        if (Number.isNaN(px) || Number.isNaN(vv)) continue;
        const turn = vv / t * 100;
        if (!(turn > 0) || turn > 200) continue;      // ⛔ 明顯異常(股數快照失真)直接丟
        // 位階:近 250 日收盤的百分位
        let lo = Infinity, hi = -Infinity, ok = 0;
        for (let j = i - LOOK + 1; j <= i; j++) { const x = c[j]; if (!Number.isNaN(x)) { if (x < lo) lo = x; if (x > hi) hi = x; ok++; } }
        if (ok < LOOK * 0.7 || !(hi > lo)) continue;
        const posPct = (px - lo) / (hi - lo) * 100;
        // 波動位階:自己近 250 日
        const w = []; for (let j = Math.max(0, i - LOOK); j < i; j++) if (!Number.isNaN(vol[j])) w.push(vol[j]);
        if (w.length < 120 || Number.isNaN(vol[i])) continue;
        const s = Float64Array.from(w).sort();
        let lt = 0; for (const x of s) if (x < vol[i]) lt++;
        const volPct = lt / s.length * 100;

        const y = days[i].slice(0, 4);
        const x20 = fwdEx(c, i, 20), x5 = fwdEx(c, i, 5);
        const isHi = posPct >= POS_MIN && volPct >= VOL_MIN;

        put(POP.all.base, i, y, x20, x5);
        if (isHi) { put(POP.hi.base, i, y, x20, x5); hiN++; }

        const bk = BUCKETS.find(b => b[2](turn));
        if (!bk) continue;
        const key = sym + '|' + bk[0];
        if (i - (lastHit.get(key) ?? -1e9) < DEDUP) continue;
        lastHit.set(key, i);
        events++;
        put(POP.all.b[bk[0]], i, y, x20, x5);
        if (isHi) put(POP.hi.b[bk[0]], i, y, x20, x5);
    }
}

if (events < MIN_EV || used < 300 || hiN < 2000) {
    console.error(`❌ 空過守門:${used} 檔 / ${events} 事件 / 高位階高波動 ${hiN} 個(門檻 300 / ${MIN_EV} / 2000)`);
    process.exit(1);
}

const yrs = [...new Set(days.slice(START).map(d => d.slice(0, 4)))].sort();
const report = (name, P) => {
    const bavg = mean(P.base.r20), bw = wr(P.base.r20);
    console.log('\n' + '─'.repeat(104));
    console.log(name);
    console.log('─'.repeat(104));
    console.log(`對照組(這個母體的全部):${P.base.n.toLocaleString()} 個股·日 ・ 20日平均超額 ${f(bavg)}% ・ 勝率 ${bw.toFixed(1)}%`);
    console.log('週轉率桶                    事件數   5日平均  20日平均  20日勝率  vs對照   前半     後半   同向 去最好年 扣成本後 判定');
    const yOk = yrs.filter(y => (P.base.yr[y] || []).length >= 200);
    for (const [k, label] of BUCKETS) {
        const B = P.b[k];
        if (B.r20.length < 100) { console.log(`${label.padEnd(26)} ${String(B.n).padStart(7)}   —(樣本不足 ${B.r20.length})`); continue; }
        const d = mean(B.r20) - bavg;
        const h1 = B.half.a.length >= 30 ? mean(B.half.a) - mean(P.base.half.a) : null;
        const h2 = B.half.b.length >= 30 ? mean(B.half.b) - mean(P.base.half.b) : null;
        const same = h1 !== null && h2 !== null && (h1 > 0) === (h2 > 0);
        const per = yOk.map(y => {
            const a = B.yr[y] || [], b = P.base.yr[y] || [];
            return (a.length >= 20 && b.length >= 20) ? mean(a) - mean(b) : null;
        });
        let drop = null;
        const okv = per.filter(x => x !== null);
        if (okv.length >= 2) {
            const iB = per.reduce((bi, x, ii) => (x !== null && (bi < 0 || x > per[bi])) ? ii : bi, -1);
            const r = [], rb = [];
            yOk.forEach((y, ii) => { if (ii === iB) return; for (const x of (B.yr[y] || [])) r.push(x); for (const x of (P.base.yr[y] || [])) rb.push(x); });
            if (r.length >= 30 && rb.length >= 30) drop = mean(r) - mean(rb);
        }
        const net = d - COST;
        const pass = d > 0 && same && drop !== null && drop > 0 && net > 0;
        console.log(`${label.padEnd(26)} ${String(B.n).padStart(7)}  ${f(mean(B.r5))}  ${f(mean(B.r20))}  ${wr(B.r20).toFixed(1).padStart(6)}%  ${f(d, 7)}pp ${h1 === null ? '   --  ' : f(h1, 7)} ${h2 === null ? '   --  ' : f(h2, 7)} ${same ? ' ✅ ' : ' ❌ '} ${drop === null ? '   --  ' : f(drop, 7)} ${f(net, 7)}pp ${pass ? '⭐全過' : '❌'}`);
    }
};

console.log('═'.repeat(104));
console.log('🔄 週轉率第三次實測 —— 問的是「疊在現行配置之上有沒有增量」');
console.log('═'.repeat(104));
console.log(`樣本:${used} 檔(⚠️ ${noShare} 檔沒有集保總股數 → 算不出週轉率,已排除)`);
console.log(`窗口:${days[START]} ~ ${days[days.length - 1]} ・ 分桶事件 ${events.toLocaleString()} 個(同檔同桶 ${DEDUP} 日去重)`);
console.log('⚠️ 報酬扣同期加權指數;分母用集保「今天的」總股數當常數(增資減資會有偏差,但桶內外同樣受影響)');
report('【1】全市場母體(= 前兩次測過的角度,這裡只當對照)', POP.all);
report(`【2】⭐ 只看「🧬 高位階(≥${POS_MIN}) + 高波動(≥${VOL_MIN})」的子集合 —— 這才是新問題`, POP.hi);
console.log('\n' + '─'.repeat(104));
console.log('⚠️ 窗口整段偏多頭 + 倖存者偏誤;⛔ 沒有全過的一律不上功能。');
console.log('⛔ 前兩次已測過、別再重測:週轉率 × 昨日漲跌幅(V72.0.1)、週轉率 × 位階(V72.4.9)。');
