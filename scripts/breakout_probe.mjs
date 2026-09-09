#!/usr/bin/env node
/**
 * 🚀 「底部 + 連續漲停拉開成本區」實測(外部教學文評估⑫)
 *
 * 使用者上傳 5 份教學檔。⭐ 依鐵則先做重複比對 + 掃量化門檻:
 *   ・2 份內容**完全重複**(同一份「飆股怎麼來的」的 PDF 版與彙整版)
 *   ・3 份是**新手教學 / 交易心法**(股市超入門 63 頁、股海爭鋒、交易者的養成)——
 *     ⛔ 通篇沒有可量化的門檻(掃出來的「數字句」全是舉例與敘事),測不了也不用測
 *   ・唯一有**可回測主張**的是「飆股怎麼來的」那一份,而且它的主張很明確:
 *
 *   ① ⭐「主力用**連續漲停**把股價從**底部**拉開成本區」= 表態,才值得追蹤
 *   ② ⛔「**不是從底部**、已經漲一段才漲停」→ 主力成本早拉開,追進去是幫忙抬轎
 *   ③ ⛔「第一波**不是用快速漲停**、只是普通強勢」→「主力意願並非那麼強烈,沒有切入的必要」
 *   ④ ⭐ 拉開後的洗盤:「**量縮,但價格不跌**」= 籌碼沉澱,可以等發動
 *   ⑤ 「出貨與否只要看成交量,**沒有爆量之前不需要擔心**」
 *
 * ⚠️ 為什麼這值得測(⛔ 不是又一個抄底招式):
 *   本站 V73.8.3 剛實測「等回檔再買」那批 21 個有 18 個是負期望值,**抄底基本上是輸的**;
 *   但這一份講的是「**底部 + 動能**」的組合(要漲停才算數),⛔ 跟純抄底不是同一件事,
 *   而且本站測過的是「**單根**漲停的**隔日**動能」(V72.0.1,只有次日有效),
 *   **「連續漲停」與「底部 vs 非底部」的對比從來沒測過**。
 *
 * ⛔ 六道關卡:對照組不抽樣・20 日去重・扣同期加權・前後半同向・去最好年仍成立・扣成本 0.44%。
 * ⚠️ 漲停判定用「相對前一日收盤 ≥ +9.5%」(台股 ±10%,留跳動單位誤差)。
 *    `data/*.json` 已做過分割還原,但漲停是**當日**相對變化 → 不受影響。
 * ⚠️ 已知限制:倖存者偏誤(已下市的不在 data/ 裡)。
 * 🚨 V74.2.8 起 K 線已補深到 2021(**含 2022 那次空頭**)→ 舊註解寫的「整段偏多頭」已不成立;
 *    窗口以實跑輸出的那一行為準,⛔ 別再照抄這裡的敘述。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const LOOK = 250, VOLN = 20, DEDUP = 20, COST = 0.44, MIN_EV = 400;
const LIMIT = 9.5;            // 漲停門檻 %
const HOR = [20, 60];

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

const files = fs.readdirSync(DATA).filter(x => /^\d{4}\.json$/.test(x) && !x.startsWith('00'));
const ST = new Map();
let used = 0;
for (const fn of files) {
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
    ST.set(fn.slice(0, 4), { c, v }); used++;
}
const cover = days.map((_, i) => { let k = 0; for (const s of ST.values()) if (!Number.isNaN(s.c[i])) k++; return k; });
const START = Math.max(LOOK + 5, cover.findIndex(k => k >= used * 0.7));
const HALF_I = Math.floor((START + days.length) / 2);
const fwdEx = (c, i, h) => {
    const j = i + h; if (j >= days.length) return null;
    const a = c[i], b = c[j]; if (Number.isNaN(a) || Number.isNaN(b) || !(a > 0)) return null;
    return (b / a - 1) * 100 - (tw[j] / tw[i] - 1) * 100;
};

const EV = [
    ['bot_lim2', '⭐① 底部(位階≤25) + 連2根漲停 ← 他的主打'],
    ['bot_lim1', '　 底部 + 只有 1 根漲停'],
    ['bot_str', '⛔③ 底部 + 強勢紅K但沒漲停(他說不必切入)'],
    ['hi_lim2', '⛔② 非底部(位階≥60) + 連2根漲停(他說會被出貨)'],
    ['mid_lim2', '　 中間位階(25~60) + 連2根漲停'],
    ['wash_ok', '⭐④ 連漲停後洗盤:量縮且價不跌'],
    ['wash_bad', '　 連漲停後洗盤:爆量或跌破起漲點'],
];
const mk = () => ({ n: 0, r: { 20: [], 60: [] }, half: { a: [], b: [] }, yr: {} });
const bag = {}; for (const [k] of EV) bag[k] = mk();
const base = mk();
const lastHit = new Map();
let events = 0;

const put = (o, i, y, xs) => {
    o.n++;
    for (const h of HOR) if (xs[h] !== null) o.r[h].push(xs[h]);
    if (xs[20] !== null) { (i < HALF_I ? o.half.a : o.half.b).push(xs[20]); (o.yr[y] ||= []).push(xs[20]); }
};

for (const [sym, S] of ST) {
    const { c, v } = S;
    const chg = new Float64Array(days.length).fill(NaN);
    for (let i = 1; i < days.length; i++) { const a = c[i - 1], b = c[i]; if (a > 0 && b > 0) chg[i] = (b / a - 1) * 100; }
    const av = new Float64Array(days.length).fill(NaN);
    for (let i = VOLN; i < days.length; i++) {
        let s = 0, n = 0;
        for (let j = i - VOLN; j < i; j++) { const x = v[j]; if (!Number.isNaN(x)) { s += x; n++; } }
        if (n >= VOLN * 0.7) av[i] = s / n;
    }
    for (let i = START; i < days.length; i++) {
        if (Number.isNaN(c[i])) continue;
        const y = days[i].slice(0, 4);
        const xs = {}; for (const h of HOR) xs[h] = fwdEx(c, i, h);
        // 對照組:所有掃到的(股·日)。⛔ 不抽樣;⚠️ 這裡逐日掃(事件本來就稀少)
        put(base, i, y, xs);

        // 位階(近 250 日)
        let lo = Infinity, hi = -Infinity, ok = 0;
        for (let j = i - LOOK + 1; j <= i; j++) { const x = c[j]; if (!Number.isNaN(x)) { if (x < lo) lo = x; if (x > hi) hi = x; ok++; } }
        if (ok < LOOK * 0.7 || !(hi > lo)) continue;
        const posPct = (c[i] - lo) / (hi - lo) * 100;

        const hits = [];
        const lim = x => !Number.isNaN(chg[x]) && chg[x] >= LIMIT;
        const two = lim(i) && lim(i - 1);          // ⭐ 連 2 根漲停(今天是第 2 根)
        const one = lim(i) && !lim(i - 1);
        if (two) {
            if (posPct <= 25) hits.push('bot_lim2');
            else if (posPct >= 60) hits.push('hi_lim2');
            else hits.push('mid_lim2');
        } else if (one && posPct <= 25) hits.push('bot_lim1');
        else if (!lim(i) && posPct <= 25 && chg[i] >= 5) hits.push('bot_str');

        // ④ 洗盤:往前找 5~20 日內的「連 2 根漲停」,之後量縮且價沒跌破那根漲停的起點
        if (!lim(i)) {
            let src = -1;
            for (let j = i - 5; j >= i - 20; j--) { if (j > 1 && lim(j) && lim(j - 1)) { src = j; break; } }
            if (src > 0 && !Number.isNaN(av[i]) && !Number.isNaN(av[src])) {
                // 洗盤期均量 vs 漲停當時均量
                let s = 0, n = 0;
                for (let j = src + 1; j <= i; j++) { const x = v[j]; if (!Number.isNaN(x)) { s += x; n++; } }
                const washAv = n ? s / n : NaN;
                const startPx = c[src - 2];        // 連 2 根漲停之前那天的收盤 = 起漲點
                const shrink = !Number.isNaN(washAv) && washAv < av[src] * 0.7;
                const held = !Number.isNaN(startPx) && c[i] > startPx;
                hits.push((shrink && held) ? 'wash_ok' : 'wash_bad');
            }
        }
        for (const st of hits) {
            const key = sym + '|' + st;
            if (i - (lastHit.get(key) ?? -1e9) < DEDUP) continue;
            lastHit.set(key, i);
            bag[st].n++; events++;
            put(bag[st], i, y, xs);
        }
    }
}

if (events < MIN_EV || used < 300) {
    console.error(`❌ 空過守門:${used} 檔 / ${events} 事件(門檻 300 / ${MIN_EV})`);
    process.exit(1);
}

const yrs = [...new Set(days.slice(START).map(d => d.slice(0, 4)))].sort().filter(y => (base.yr[y] || []).length >= 400);
const b20 = mean(base.r[20]), bw = wr(base.r[20]);
console.log('═'.repeat(102));
console.log('🚀 「底部 + 連續漲停拉開成本區」實測');
console.log('═'.repeat(102));
console.log(`樣本:${used} 檔 ・ 窗口 ${days[START]} ~ ${days[days.length - 1]} ・ 事件 ${events.toLocaleString()} 個(同檔同型 ${DEDUP} 日去重)`);
console.log(`對照組:所有掃到的(股·日)共 ${base.n.toLocaleString()} 個,⛔ 沒有抽樣 ・ 20日平均超額 ${f(b20)}% ・ 勝率 ${bw.toFixed(1)}%`);
console.log('⚠️ 報酬扣同期加權指數;「扣成本後」那欄才是真的能不能賺(來回 0.44%)\n');
console.log('型態                                     事件數  20日平均 60日平均 20日勝率  vs對照  前半    後半   同向 去最好年 扣成本 判定');
const rows = [];
for (const [k, name] of EV) {
    const B = bag[k];
    if (B.r[20].length < 60) { console.log(`${name.padEnd(40)} ${String(B.n).padStart(6)}   —(樣本不足 ${B.r[20].length})`); continue; }
    const d = mean(B.r[20]) - b20;
    const h1 = B.half.a.length >= 25 ? mean(B.half.a) - mean(base.half.a) : null;
    const h2 = B.half.b.length >= 25 ? mean(B.half.b) - mean(base.half.b) : null;
    const same = h1 !== null && h2 !== null && (h1 > 0) === (h2 > 0);
    const per = yrs.map(y => {
        const a = B.yr[y] || [], bb = base.yr[y] || [];
        return (a.length >= 15 && bb.length >= 15) ? mean(a) - mean(bb) : null;
    });
    const okv = per.filter(x => x !== null);
    let drop = null;
    if (okv.length >= 2) {
        const iB = per.reduce((bi, x, ii) => (x !== null && (bi < 0 || x > per[bi])) ? ii : bi, -1);
        const r = [], rb = [];
        yrs.forEach((y, ii) => { if (ii === iB) return; for (const x of (B.yr[y] || [])) r.push(x); for (const x of (base.yr[y] || [])) rb.push(x); });
        if (r.length >= 25 && rb.length >= 25) drop = mean(r) - mean(rb);
    }
    const net = d - COST;
    const pass = d > 0 && same && drop !== null && drop > 0 && net > 0;
    rows.push({ k, name, d, net, pass, n: B.n });
    console.log(`${name.padEnd(40)} ${String(B.n).padStart(6)}  ${f(mean(B.r[20]))} ${f(mean(B.r[60]))} ${wr(B.r[20]).toFixed(1).padStart(6)}% ${f(d, 7)}pp ${h1 === null ? '  --  ' : f(h1, 6)} ${h2 === null ? '  --  ' : f(h2, 6)} ${same ? ' ✅ ' : ' ❌ '} ${drop === null ? '  --  ' : f(drop, 6)} ${f(net, 6)}pp ${pass ? '⭐全過' : '❌'}`);
}
console.log('\n' + '─'.repeat(102));
console.log('【直接回答他的三個對比】');
console.log('─'.repeat(102));
const g = k => rows.find(r => r.k === k);
const [a, b, cc, dd] = [g('bot_lim2'), g('hi_lim2'), g('bot_str'), g('bot_lim1')];
if (a && b) console.log(`①vs② 底部連2漲停 ${f(a.d)}pp  vs  非底部連2漲停 ${f(b.d)}pp → 「底部才能買」${a.d > b.d ? '✅ 方向對' : '❌ 方向相反'}(差 ${f(a.d - b.d)}pp)`);
if (a && cc) console.log(`①vs③ 底部連2漲停 ${f(a.d)}pp  vs  底部強勢紅K沒漲停 ${f(cc.d)}pp → 「要漲停才算表態」${a.d > cc.d ? '✅ 方向對' : '❌ 方向相反'}(差 ${f(a.d - cc.d)}pp)`);
if (a && dd) console.log(`①vs　 連2根 ${f(a.d)}pp  vs  只有1根 ${f(dd.d)}pp → 「連續」${a.d > dd.d ? '✅ 有加分' : '❌ 沒有加分'}(差 ${f(a.d - dd.d)}pp)`);
const w1 = g('wash_ok'), w2 = g('wash_bad');
if (w1 && w2) console.log(`④　　 洗盤量縮價不跌 ${f(w1.d)}pp  vs  爆量或破底 ${f(w2.d)}pp → 「量縮價不跌才安全」${w1.d > w2.d ? '✅ 方向對' : '❌ 方向相反'}(差 ${f(w1.d - w2.d)}pp)`);
console.log(`\n⭐ 全過六關的型態:${rows.filter(r => r.pass).map(r => r.name).join(' / ') || '(一個都沒有)'}`);

// ═══ 🚨 兩道決定性的追加檢定 ═══
// ⛔ 沒做這兩條之前,上面那個「全過」不可以拿去做功能。
console.log('\n' + '═'.repeat(102));
console.log('🚨 追加檢定 A:漲停當天收盤根本買不到 —— 改成「隔天開盤買」還剩多少?');
console.log('═'.repeat(102));
console.log('（本站 V72.9.0 已記過:同一套邏輯只改進場時機,隔天開盤買會少賺一大半;');
console.log('  而漲停鎖死時**當天收盤買不到**,所以這條是可行性檢定,⛔ 不是可選的。）');
{
    // 重掃一次,報酬改從「隔天開盤價」起算
    const OP = new Map();
    for (const fn of files) {
        const sym = fn.slice(0, 4);
        if (!ST.has(sym)) continue;
        let arr; try { arr = JSON.parse(fs.readFileSync(path.join(DATA, fn), 'utf8')); } catch (_) { continue; }
        const o = new Float64Array(days.length).fill(NaN);
        for (const r of arr) { const i = dPos.get(nd(r.date)); const x = +r.open; if (i !== undefined && x > 0) o[i] = x; }
        OP.set(sym, o);
    }
    const bag2 = {}; for (const [k] of EV) bag2[k] = { n: 0, r: [] };
    const base2 = { n: 0, r: [] };
    const last2 = new Map();
    for (const [sym, S] of ST) {
        const { c } = S; const o = OP.get(sym); if (!o) continue;
        const chg = new Float64Array(days.length).fill(NaN);
        for (let i = 1; i < days.length; i++) { const a = c[i - 1], b = c[i]; if (a > 0 && b > 0) chg[i] = (b / a - 1) * 100; }
        // 買在 i+1 開盤,賣在 i+1+20 收盤;扣同期大盤(同一段)
        const fwdOpen = i => {
            const e = i + 1, j = i + 21;
            if (j >= days.length) return null;
            const p0 = o[e], p1 = c[j];
            if (Number.isNaN(p0) || Number.isNaN(p1) || !(p0 > 0)) return null;
            return (p1 / p0 - 1) * 100 - (tw[j] / tw[e] - 1) * 100;
        };
        for (let i = START; i < days.length; i++) {
            if (Number.isNaN(c[i])) continue;
            const x = fwdOpen(i); if (x === null) continue;
            base2.n++; base2.r.push(x);
            let lo = Infinity, hi = -Infinity, ok = 0;
            for (let j = i - LOOK + 1; j <= i; j++) { const q = c[j]; if (!Number.isNaN(q)) { if (q < lo) lo = q; if (q > hi) hi = q; ok++; } }
            if (ok < LOOK * 0.7 || !(hi > lo)) continue;
            const posPct = (c[i] - lo) / (hi - lo) * 100;
            const lim = z => !Number.isNaN(chg[z]) && chg[z] >= LIMIT;
            let k = null;
            if (lim(i) && lim(i - 1)) k = posPct <= 25 ? 'bot_lim2' : (posPct >= 60 ? 'hi_lim2' : 'mid_lim2');
            if (!k) continue;
            const key = sym + '|' + k;
            if (i - (last2.get(key) ?? -1e9) < DEDUP) continue;
            last2.set(key, i);
            bag2[k].n++; bag2[k].r.push(x);
        }
    }
    const b2 = mean(base2.r);
    console.log(`對照組(隔天開盤買、持有 20 日):${base2.n.toLocaleString()} 個 ・ 平均超額 ${f(b2)}%`);
    for (const k of ['bot_lim2', 'mid_lim2', 'hi_lim2']) {
        const B = bag2[k];
        if (B.r.length < 60) { console.log(`  ${k} —(樣本不足)`); continue; }
        const d = mean(B.r) - b2;
        const nm = (EV.find(e => e[0] === k) || [])[1] || k;
        console.log(`  ${nm.padEnd(40)} n=${String(B.n).padStart(5)} ・ vs對照 ${f(d, 7)}pp ・ 扣成本 ${f(d - COST, 7)}pp ${d - COST > 0 ? '' : '❌'}`);
    }
    console.log('  ⚠️ 跟上面「當天收盤買」的差距,就是**買不到的代價**。');
}

console.log('\n' + '═'.repeat(102));
console.log('🚨 追加檢定 B:它是不是只是把「🧬 高位階 + 高波動」再數一次?(V73.2.5 的增量檢定)');
console.log('═'.repeat(102));
{
    let both = 0, onlyEv = 0, tot = 0;
    for (const [sym, S] of ST) {
        const { c } = S;
        const chg = new Float64Array(days.length).fill(NaN);
        const rr = new Float64Array(days.length).fill(NaN);
        for (let i = 1; i < days.length; i++) { const a = c[i - 1], b = c[i]; if (a > 0 && b > 0) { chg[i] = (b / a - 1) * 100; rr[i] = chg[i]; } }
        const vol = new Float64Array(days.length).fill(NaN);
        for (let i = VOLN; i < days.length; i++) {
            let s = 0, s2 = 0, n = 0;
            for (let j = i - VOLN + 1; j <= i; j++) { const x = rr[j]; if (!Number.isNaN(x)) { s += x; s2 += x * x; n++; } }
            if (n >= VOLN * 0.7) { const m = s / n; vol[i] = Math.sqrt(Math.max(0, s2 / n - m * m)); }
        }
        for (let i = START; i < days.length; i++) {
            const lim = z => !Number.isNaN(chg[z]) && chg[z] >= LIMIT;
            if (!(lim(i) && lim(i - 1))) continue;
            let lo = Infinity, hi = -Infinity, ok = 0;
            for (let j = i - LOOK + 1; j <= i; j++) { const q = c[j]; if (!Number.isNaN(q)) { if (q < lo) lo = q; if (q > hi) hi = q; ok++; } }
            if (ok < LOOK * 0.7 || !(hi > lo)) continue;
            const posPct = (c[i] - lo) / (hi - lo) * 100;
            const w = []; for (let j = Math.max(0, i - LOOK); j < i; j++) if (!Number.isNaN(vol[j])) w.push(vol[j]);
            if (w.length < 120 || Number.isNaN(vol[i])) continue;
            const s = Float64Array.from(w).sort();
            let lt = 0; for (const x of s) if (x < vol[i]) lt++;
            const volPct = lt / s.length * 100;
            tot++;
            if (posPct >= 75 && volPct >= 60) both++; else onlyEv++;
        }
    }
    const c1 = pct(both, tot);
    console.log(`  「連 2 根漲停」的日子共 ${tot.toLocaleString()} 個,其中 ${c1.toFixed(1)}% 同時也是「位階≥75 且 波動≥60」`);
    console.log(`  → ${c1 >= 80 ? '⛔ 幾乎是同一件事,加它不會有增量(同 V73.2.5 乖離那次)'
        : c1 >= 50 ? '⚠️ 重疊過半,要在現行配置之上做增量回測才知道值不值得加'
            : '⭐ 重疊不高 → 它帶的是**獨立**資訊,值得進一步評估'}`);
}

console.log('\n' + '═'.repeat(102));
console.log('🚨 追加檢定 C(決定性):在「🧬 高位階+高波動」子集合裡,「連2漲停」還有沒有增量?');
console.log('═'.repeat(102));
console.log('（⭐ 這條才是決定要不要做的關鍵 —— B 只說重疊 68%,C 才回答「多的那 32% 有沒有用」。');
console.log('  ⚠️ 報酬一律用**隔天開盤買**,因為漲停當天收盤買不到。）');
{
    const OP = new Map();
    for (const fn of files) {
        const sym = fn.slice(0, 4);
        if (!ST.has(sym)) continue;
        let arr; try { arr = JSON.parse(fs.readFileSync(path.join(DATA, fn), 'utf8')); } catch (_) { continue; }
        const o = new Float64Array(days.length).fill(NaN);
        for (const r of arr) { const i = dPos.get(nd(r.date)); const x = +r.open; if (i !== undefined && x > 0) o[i] = x; }
        OP.set(sym, o);
    }
    const hiBase = { n: 0, r: [], half: { a: [], b: [] }, yr: {} };
    const hiLim = { n: 0, r: [], half: { a: [], b: [] }, yr: {} };
    const last3 = new Map();
    for (const [sym, S] of ST) {
        const { c } = S; const o = OP.get(sym); if (!o) continue;
        const chg = new Float64Array(days.length).fill(NaN);
        for (let i = 1; i < days.length; i++) { const a = c[i - 1], b = c[i]; if (a > 0 && b > 0) chg[i] = (b / a - 1) * 100; }
        const vol = new Float64Array(days.length).fill(NaN);
        for (let i = VOLN; i < days.length; i++) {
            let s = 0, s2 = 0, n = 0;
            for (let j = i - VOLN + 1; j <= i; j++) { const x = chg[j]; if (!Number.isNaN(x)) { s += x; s2 += x * x; n++; } }
            if (n >= VOLN * 0.7) { const m = s / n; vol[i] = Math.sqrt(Math.max(0, s2 / n - m * m)); }
        }
        for (let i = START; i < days.length; i++) {
            const e = i + 1, j = i + 21;
            if (j >= days.length) continue;
            const p0 = o[e], p1 = c[j];
            if (Number.isNaN(p0) || Number.isNaN(p1) || !(p0 > 0)) continue;
            const x = (p1 / p0 - 1) * 100 - (tw[j] / tw[e] - 1) * 100;
            let lo = Infinity, hi = -Infinity, ok = 0;
            for (let q = i - LOOK + 1; q <= i; q++) { const z = c[q]; if (!Number.isNaN(z)) { if (z < lo) lo = z; if (z > hi) hi = z; ok++; } }
            if (ok < LOOK * 0.7 || !(hi > lo)) continue;
            const posPct = (c[i] - lo) / (hi - lo) * 100;
            const w = []; for (let q = Math.max(0, i - LOOK); q < i; q++) if (!Number.isNaN(vol[q])) w.push(vol[q]);
            if (w.length < 120 || Number.isNaN(vol[i])) continue;
            const s = Float64Array.from(w).sort();
            let lt = 0; for (const z of s) if (z < vol[i]) lt++;
            if (!(posPct >= 75 && (lt / s.length * 100) >= 60)) continue;   // ⭐ 只看現行配置的母體
            const y = days[i].slice(0, 4);
            hiBase.n++; hiBase.r.push(x); (i < HALF_I ? hiBase.half.a : hiBase.half.b).push(x); (hiBase.yr[y] ||= []).push(x);
            const lim = z => !Number.isNaN(chg[z]) && chg[z] >= LIMIT;
            if (!(lim(i) && lim(i - 1))) continue;
            const key = sym + '|c';
            if (i - (last3.get(key) ?? -1e9) < DEDUP) continue;
            last3.set(key, i);
            hiLim.n++; hiLim.r.push(x); (i < HALF_I ? hiLim.half.a : hiLim.half.b).push(x); (hiLim.yr[y] ||= []).push(x);
        }
    }
    const bb = mean(hiBase.r), d = mean(hiLim.r) - bb;
    const h1 = mean(hiLim.half.a) - mean(hiBase.half.a), h2 = mean(hiLim.half.b) - mean(hiBase.half.b);
    const yy = Object.keys(hiBase.yr).sort().filter(y => (hiBase.yr[y] || []).length >= 200);
    const per = yy.map(y => (hiLim.yr[y] || []).length >= 15 ? mean(hiLim.yr[y]) - mean(hiBase.yr[y]) : null);
    let drop = null;
    const okv = per.filter(z => z !== null);
    if (okv.length >= 2) {
        const iB = per.reduce((bi, z, ii) => (z !== null && (bi < 0 || z > per[bi])) ? ii : bi, -1);
        const r = [], rb = [];
        yy.forEach((y, ii) => { if (ii === iB) return; for (const z of (hiLim.yr[y] || [])) r.push(z); for (const z of (hiBase.yr[y] || [])) rb.push(z); });
        if (r.length >= 25 && rb.length >= 25) drop = mean(r) - mean(rb);
    }
    console.log(`  母體(位階≥75 且 波動≥60):${hiBase.n.toLocaleString()} 個 ・ 平均超額 ${f(bb)}%`);
    console.log(`  其中「連 2 根漲停」:${hiLim.n.toLocaleString()} 個 ・ 平均超額 ${f(mean(hiLim.r))}%`);
    console.log(`  ⭐ 增量 ${f(d)}pp ・ 前半 ${f(h1)} / 後半 ${f(h2)} ${(h1 > 0) === (h2 > 0) ? '✅同向' : '❌不同向'}` +
        ` ・ 逐年 ${per.map(z => z === null ? '--' : z.toFixed(1)).join('/')} ・ 去最好年 ${drop === null ? '--' : f(drop)}` +
        ` ・ 扣成本 ${f(d - COST)}pp`);
    const pass = d > 0 && (h1 > 0) === (h2 > 0) && drop !== null && drop > 0 && (d - COST) > 0;
    console.log(`  → ${pass ? '⭐⭐ 全過:在現行配置之上真的有增量,值得做' : '⛔ 沒有全過 → 疊上去沒有增量,⛔ 不做'}`);
}

console.log('\n⚠️ 倖存者偏誤(已下市的不在 data/);窗口見上方輸出 —— K 線補深後已含 2022 空頭。⛔ 沒有全過的一律不上功能。');
