#!/usr/bin/env node
/**
 * 🎫 權證小哥《哥有籌必爆》S1+S2 第二批 —— 只測「新的 + 可測的」兩條
 *
 * 使用者又上傳 40 份逐字稿(0.81 MB)。⭐ 依 CLAUDE.md 鐵則,**先比對已評估過的**:
 * 這批 = 評估紀錄⑥(2026-08-05,57 份)的**同一個系列**,絕大多數已經測過或已判定缺資料源。
 * 逐條掃完 40 份的量化門檻後,只有**兩條**是「⑥ 沒測過、而且用既有 `data/*.json` 就測得動」的:
 *
 *   【A】布林**帶寬(袋寬)**分級 —— 他給了明確公式與門檻:
 *        帶寬 = 上通道 ÷ 下通道 − 1;「3% 窄到不行、5% 以下很窄、10% 正常、20% 以上就寬」
 *        ⚠️ 評估紀錄⑥ 當時寫「布林平行 vs 壓縮…他自己判定都靠目視,無法程式化」——
 *           那句講的是「離開下軌的紅K」與「平行」,**帶寬這條是有公式的**,所以可以測。
 *
 *   【B】地板股**要有量** —— ⑥ 只測過「跌到地板會不會反彈」(V71.8.9,實測接刀輸大盤),
 *        **沒測過他附加的量能條件**:「當天出現在地板線下 + 成交量要是 20 均量的 **2 倍以上**」。
 *        他自己舉的反例正是國巨:「跌慘了…但他沒有出量」。
 *        ⚠️ V72.4.9 `floorcount_probe` 測的是**全市場家數對大盤**,跟「這一檔能不能接」是兩個問題。
 *
 * ⛔ 掃完後**確定不測**的(理由寫下來免得下次再問一次):
 *   ・融資維持率 130% / 使用率 >70%(第1集)→ ⑥ 已評估;使用率無歷史、無法回算
 *   ・週轉率一天 >20% / 一週 >100%(第19集)→ ⑥ 已測**兩次**都不成立
 *   ・券資比 >30%、回補力道 >50%(第3/6集)→ `short_balance` 只回溯到 2026/05(V71.9.2 同一個死因)
 *   ・主力5日籌碼集中度 >5%(第14/20集)→ 需**逐日**分點歷史,`data/chips/` 只有滾動快照
 *   ・可轉債市值 >120(第2/10集)→ V71.9.1 已測;CB 只有今天的快照
 *   ・大戶 400 張 ±3%(第5集)→ V71.9.0 兩上兩下已測
 *   ・投量比 >10%(S1 第11集)→ V71.9.5 已有
 *   ・均線扣抵(S1 第2集)/ 葛蘭碧(S1 第7集)/ 光頭大紅棒 ≥5%(S1 第1集)→ 偵測器都已存在
 *   ・權證差槓比 <0.3%、價內 >20%(S1 第4/6/17集)→ **無權證報價資料源**(V73.4.0 實測仍是 422)
 *   ・盤前試撮 3 訊號(S1 第16集)→ 無逐筆歷史
 *   ・庫藏股(S1 第9集)→ 無資料源
 *
 * ⛔ 六道關卡(缺一條結論就會歪,全部照 regime_probe 的標準):
 *   ① 對照組 = **同一批(股·日)全部**,⛔ 不抽樣(V72.4.4 抽樣害基準被壓低那次)
 *   ② 同檔同事件 **20 日去重**(連續多天觸發是同一件事)
 *   ③ 報酬**扣同期加權指數**(不扣會把大盤的漲算到訊號頭上)
 *   ④ **前後半段同向**
 *   ⑤ **拿掉最好的那一年**還要站得住(V73.2.0 那次兩個「贏家」全靠 2026-04 一個月)
 *   ⑥ 跟**來回成本 0.44%** 比 —— 統計顯著 ≠ 值得做(V72.0.3)
 *
 * ⚠️ 已知限制(⛔ 報告不可省略):窗口約 3 年且整段偏多頭;倖存者偏誤(已下市的不在 data/)。
 * ⚠️ 量的單位:`data/*.json` 的 volume 個股是**股**,但這裡一律拿「自己 ÷ 自己的 20 日均量」
 *    → **單位會約掉**,不受陷阱 #17/#29 影響。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const N_BB = 20;        // 布林週期
const K_BB = 2;         // ±2σ
const VOL_N = 20;       // 均量週期
const DEDUP = 20;
const STEP = 3;
const MIN_EV = 1500;    // 空過守門
const COST = 0.44;
const HOR = [5, 20, 60];

const nd = d => String(d || '').replace(/\//g, '-').slice(0, 10);
const sum = a => a.reduce((x, y) => x + y, 0);
const mean = a => a.length ? sum(a) / a.length : 0;
const med = a => { if (!a.length) return 0; const s = Float64Array.from(a).sort(); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (x, n) => n ? x / n * 100 : 0;
const f = (x, w = 7, p = 2) => (x >= 0 ? '+' : '') + x.toFixed(p).padStart(w);
const wr = a => pct(a.filter(x => x > 0).length, a.length);

// ═══ 1. 大盤日曆 ═══
const twiiRaw = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8'))
    .map(r => ({ d: nd(r.date), c: +r.close })).filter(r => r.d && r.c > 0);
const days = twiiRaw.map(r => r.d);
const dPos = new Map(days.map((d, i) => [d, i]));
const tw = Float64Array.from(twiiRaw.map(r => r.c));

// ═══ 2. 個股 OHLCV ═══
const files = fs.readdirSync(DATA).filter(x => /^\d{4}\.json$/.test(x) && !x.startsWith('00'));
const ST = new Map();   // sym → {c,v,firstIdx}
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
const START = Math.max(N_BB + VOL_N + 2, cover.findIndex(k => k >= used * 0.7));
const HALF_I = Math.floor((START + days.length) / 2);

// 未來 h 日超額報酬(扣同期加權)
const fwdEx = (c, i, h) => {
    const j = i + h; if (j >= days.length) return null;
    const a = c[i], b = c[j]; if (Number.isNaN(a) || Number.isNaN(b) || !(a > 0)) return null;
    const t0 = tw[i], t1 = tw[j]; if (!(t0 > 0) || !(t1 > 0)) return null;
    return (b / a - 1) * 100 - (t1 / t0 - 1) * 100;
};

// ═══ 3. 事件定義 ═══
// ⛔ 【A】刻意**同時**用他的絕對門檻與「自己的歷史位階」兩種切法:
//    絕對門檻是為了直接回答「他說的 5%/10%/20% 對不對」;
//    位階是本專案的鐵則(V71.1.6 外資期貨、V71.8.1 波動率:寫死門檻會隨行情失真)。
const EVENTS = [
    ['bb_lt5', '【A】帶寬 <5%(他說「很窄」)'],
    ['bb_5_10', '【A】帶寬 5~10%'],
    ['bb_10_20', '【A】帶寬 10~20%(他說「正常」)'],
    ['bb_gt20', '【A】帶寬 >20%(他說「就寬」)'],
    ['bb_sq_self', '【A】帶寬在自己近250日最低20%(壓縮)'],
    ['bb_wd_self', '【A】帶寬在自己近250日最高20%(擴張)'],
    ['bb_break', '【A】壓縮後開始擴張(壓縮→帶寬放大1.2倍)'],
    ['bb_ride', '【A】站上中軌且帶寬>10%(他說「上通道間震盪=多頭」)'],
    ['floor_vol', '【B】地板(跌≥9%)+ 量≥2倍均量 ⭐他的版本'],
    ['floor_novol', '【B】地板(跌≥9%)但 量<2倍均量(他說不能接)'],
];
const bag = {}; const byHalf = { __base: { a: [], b: [] } }; const byYear = { __base: {} };
for (const [k] of EVENTS) { bag[k] = { n: 0, r: { 5: [], 20: [], 60: [] } }; byHalf[k] = { a: [], b: [] }; byYear[k] = {}; }
const base = { n: 0, r: { 5: [], 20: [], 60: [] } };
const lastHit = new Map();
let events = 0;

for (const [sym, S] of ST) {
    const { c, v } = S;
    // 滾動布林帶寬
    const bwArr = new Float64Array(days.length).fill(NaN);
    const midArr = new Float64Array(days.length).fill(NaN);
    for (let i = N_BB - 1; i < days.length; i++) {
        let s = 0, s2 = 0, n = 0;
        for (let j = i - N_BB + 1; j <= i; j++) { const x = c[j]; if (Number.isNaN(x)) { n = 0; break; } s += x; s2 += x * x; n++; }
        if (n !== N_BB) continue;
        const m = s / n; const sd = Math.sqrt(Math.max(0, s2 / n - m * m));
        const up = m + K_BB * sd, lo = m - K_BB * sd;
        if (!(lo > 0)) continue;
        bwArr[i] = (up / lo - 1) * 100;     // ⭐ 他的定義:上通道 ÷ 下通道 − 1
        midArr[i] = m;
    }
    // 20 日均量
    const avArr = new Float64Array(days.length).fill(NaN);
    for (let i = VOL_N; i < days.length; i++) {
        let s = 0, n = 0;
        for (let j = i - VOL_N; j < i; j++) { const x = v[j]; if (!Number.isNaN(x)) { s += x; n++; } }
        if (n >= VOL_N * 0.7) avArr[i] = s / n;
    }

    for (let i = START; i < days.length; i += STEP) {
        if (Number.isNaN(c[i])) continue;
        const y = days[i].slice(0, 4);
        // 對照組:所有掃到的(股·日),⛔ 不抽樣
        base.n++;
        for (const h of HOR) { const x = fwdEx(c, i, h); if (x !== null) base.r[h].push(x); }
        { const x = fwdEx(c, i, 20); if (x !== null) { (i < HALF_I ? byHalf.__base.a : byHalf.__base.b).push(x); (byYear.__base[y] ||= []).push(x); } }

        const hits = [];
        const bw = bwArr[i];
        if (!Number.isNaN(bw)) {
            if (bw < 5) hits.push('bb_lt5');
            else if (bw < 10) hits.push('bb_5_10');
            else if (bw < 20) hits.push('bb_10_20');
            else hits.push('bb_gt20');
            // 自己的歷史位階(近 250 日)
            const w = []; for (let j = Math.max(0, i - 250); j < i; j++) if (!Number.isNaN(bwArr[j])) w.push(bwArr[j]);
            if (w.length >= 120) {
                const s = Float64Array.from(w).sort();
                const p20 = s[Math.floor(s.length * 0.2)], p80 = s[Math.floor(s.length * 0.8)];
                if (bw <= p20) hits.push('bb_sq_self');
                if (bw >= p80) hits.push('bb_wd_self');
                // 壓縮後開始擴張:5 天前還在壓縮區,今天帶寬是那時的 1.2 倍以上
                const bPrev = bwArr[i - 5];
                if (!Number.isNaN(bPrev) && bPrev <= p20 && bw >= bPrev * 1.2) hits.push('bb_break');
            }
            if (bw > 10 && !Number.isNaN(midArr[i]) && c[i] > midArr[i]) hits.push('bb_ride');
        }
        // 【B】地板 + 量
        const cPrev = c[i - 1];
        if (!Number.isNaN(cPrev) && cPrev > 0) {
            const chg = (c[i] / cPrev - 1) * 100;
            if (chg <= -9) {
                const av = avArr[i], vol = v[i];
                if (!Number.isNaN(av) && !Number.isNaN(vol) && av > 0) hits.push(vol >= av * 2 ? 'floor_vol' : 'floor_novol');
            }
        }
        for (const st of hits) {
            const key = sym + '|' + st;
            if (i - (lastHit.get(key) ?? -1e9) < DEDUP) continue;
            lastHit.set(key, i);
            bag[st].n++; events++;
            for (const h of HOR) { const x = fwdEx(c, i, h); if (x !== null) bag[st].r[h].push(x); }
            const x = fwdEx(c, i, 20);
            if (x !== null) { (i < HALF_I ? byHalf[st].a : byHalf[st].b).push(x); (byYear[st][y] ||= []).push(x); }
        }
    }
}

if (events < MIN_EV || used < 300) {
    console.error(`❌ 空過守門:${used} 檔 / ${events} 個事件(門檻 300 / ${MIN_EV})—— 掃不到東西時要吵,⛔ 不可安靜地回「沒有訊號」`);
    process.exit(1);
}

// ═══ 4. 報告 ═══
console.log('═'.repeat(104));
console.log('🎫 權證小哥 S1+S2 第二批 —— 只測「⑥ 沒測過 + 用既有資料測得動」的兩條');
console.log('═'.repeat(104));
console.log(`樣本:${used} 檔(⛔ 不限上市,兩個假設都不需要產業別)`);
console.log(`窗口:${days[START]} ~ ${days[days.length - 1]} ・ 事件 ${events.toLocaleString()} 個(同檔同事件 ${DEDUP} 日去重)`);
console.log(`對照組:同一批(股·日)全部 ${base.n.toLocaleString()} 個,⛔ 沒有抽樣`);
console.log('⚠️ 報酬全部**扣掉同期加權指數**;下面「扣成本」那欄才是真的能不能賺(來回 0.44%)');

const bw20 = wr(base.r[20]), bavg = mean(base.r[20]);
console.log('\n' + '─'.repeat(104));
console.log('【1】事件之後的超額報酬');
console.log('─'.repeat(104));
console.log('事件                                      事件數   5日平均  20日平均 60日平均  20日勝率  vs對照20日');
console.log(`${'(對照組:所有掃到的股·日)'.padEnd(40)} ${String(base.n).padStart(7)}  ${f(mean(base.r[5]))}  ${f(bavg)}  ${f(mean(base.r[60]))}  ${bw20.toFixed(1).padStart(6)}%       —`);
const rows = [];
for (const [k, name] of EVENTS) {
    const B = bag[k];
    if (!B.r[20].length) { console.log(`${name.padEnd(40)} ${String(B.n).padStart(7)}   —(樣本不足)`); continue; }
    const o = { k, name, n: B.n, a5: mean(B.r[5]), a20: mean(B.r[20]), a60: mean(B.r[60]), w: wr(B.r[20]) };
    o.d20 = o.a20 - bavg;
    rows.push(o);
    console.log(`${name.padEnd(40)} ${String(B.n).padStart(7)}  ${f(o.a5)}  ${f(o.a20)}  ${f(o.a60)}  ${o.w.toFixed(1).padStart(6)}%  ${f(o.d20, 8)}pp`);
}

console.log('\n' + '─'.repeat(104));
console.log('【2】穩健性 ⭐ 六道關卡(⛔ 全過才算數;用平均超額=期望值,不用中位)');
console.log('─'.repeat(104));
const yrs = [...new Set(days.slice(START).map(d => d.slice(0, 4)))].sort().filter(y => (byYear.__base[y] || []).length >= 400);
console.log('事件                                      全期(pp)  前半     後半   同向  ' + yrs.map(y => y.slice(2)).join('     ') + '   逐年同向 去最好年 扣成本後  判定');
for (const o of rows) {
    const h1 = byHalf[o.k].a.length >= 30 ? mean(byHalf[o.k].a) - mean(byHalf.__base.a) : null;
    const h2 = byHalf[o.k].b.length >= 30 ? mean(byHalf[o.k].b) - mean(byHalf.__base.b) : null;
    const same = h1 !== null && h2 !== null && (h1 > 0) === (h2 > 0);
    const per = yrs.map(y => {
        const a = byYear[o.k][y] || [], b = byYear.__base[y] || [];
        return (a.length >= 20 && b.length >= 20) ? mean(a) - mean(b) : null;
    });
    const ok9 = per.filter(x => x !== null);
    const yrSame = ok9.length >= 2 && (ok9.every(x => x > 0) || ok9.every(x => x < 0));
    // ⭐ 拿掉貢獻最大的那一年之後還站得住嗎(V73.2.0 的關鍵檢定)
    let dropBest = null;
    if (ok9.length >= 2) {
        const iBest = per.reduce((bi, x, i) => (x !== null && (bi < 0 || x > per[bi])) ? i : bi, -1);
        // ⚠️ ⛔ 不可用 `push(...arr)` —— 大陣列會爆呼叫堆疊(CLAUDE.md V73.2.0 記過一次,
        //    這支第一版又踩了),而且爆掉時如果被 try/catch 吞了就會變成「安靜地少算」。
        const rest = []; const restB = [];
        yrs.forEach((y, i) => {
            if (i === iBest) return;
            for (const x of (byYear[o.k][y] || [])) rest.push(x);
            for (const x of (byYear.__base[y] || [])) restB.push(x);
        });
        if (rest.length >= 30 && restB.length >= 30) dropBest = mean(rest) - mean(restB);
    }
    const net = o.d20 - COST;
    const pass = o.d20 > 0 && same && yrSame && dropBest !== null && dropBest > 0 && net > 0;
    const cells = per.map(x => x === null ? '  --  ' : f(x, 6, 2)).join(' ');
    console.log(`${o.name.padEnd(40)} ${f(o.d20, 8)}  ${h1 === null ? '   --  ' : f(h1, 7)}  ${h2 === null ? '   --  ' : f(h2, 7)}  ${same ? ' ✅ ' : ' ❌ '} ${cells}  ${yrSame ? '  ✅  ' : '  ❌  '} ${dropBest === null ? '   --  ' : f(dropBest, 7)} ${f(net, 8)}pp  ${pass ? '⭐ 全過' : '❌'}`);
}

console.log('\n' + '─'.repeat(104));
console.log('【3】直接回答他的兩個說法');
console.log('─'.repeat(104));
const g = k => rows.find(r => r.k === k);
const bbA = ['bb_lt5', 'bb_5_10', 'bb_10_20', 'bb_gt20'].map(g).filter(Boolean);
if (bbA.length === 4) {
    const monoUp = bbA.every((o, i) => i === 0 || o.d20 >= bbA[i - 1].d20);
    const monoDn = bbA.every((o, i) => i === 0 || o.d20 <= bbA[i - 1].d20);
    console.log(`【A】帶寬四段 vs 對照(20日,pp):${bbA.map(o => f(o.d20, 6)).join('  ')}`);
    console.log(`     單調?${monoUp ? '越寬越好' : monoDn ? '越寬越差' : '⛔ 非單調(= 他那幾條線是隨口訂的)'}`);
}
const fv = g('floor_vol'), fn = g('floor_novol');
if (fv && fn) {
    console.log(`【B】地板+有量 ${f(fv.d20)}pp(n=${fv.n}) ・ 地板但無量 ${f(fn.d20)}pp(n=${fn.n}) ・ 差 ${f(fv.d20 - fn.d20)}pp`);
    console.log(`     他的說法(要有量才能接)${fv.d20 > fn.d20 ? '✅ 方向對' : '❌ 方向相反'};` +
        ` 但扣成本後 ${f(fv.d20 - COST)}pp → ${fv.d20 - COST > 0 ? '值得做' : '⛔ 不值得做'}`);
}
// ═══ 5. ⭐ 「帶寬 >20%」是不是只是把『高波動』再數一次? ═══
// V73.2.5 的教訓:正/負乖離加分疊在「高位階+高波動」之上**沒有增量**,
// 因為乖離大本來就是波動大的另一種說法。帶寬 = 20 日標準差 ÷ 均價 → 嫌疑一模一樣。
// ⛔ 不可用「講得通」當結論 —— 直接量重疊率。
{
    let both = 0, bbOnly = 0, volOnly = 0, neither = 0;
    for (const [sym, S] of ST) {
        const { c } = S;
        // 該股「近 20 日報酬標準差」的自身 250 日位階(= App `_stockRegime`/V73.2.3 用的波動概念)
        const rr = new Float64Array(days.length).fill(NaN);
        for (let i = 1; i < days.length; i++) { const a = c[i - 1], b = c[i]; if (a > 0 && b > 0) rr[i] = (b / a - 1) * 100; }
        const vol = new Float64Array(days.length).fill(NaN);
        for (let i = N_BB; i < days.length; i++) {
            let s = 0, s2 = 0, n = 0;
            for (let j = i - N_BB + 1; j <= i; j++) { const x = rr[j]; if (!Number.isNaN(x)) { s += x; s2 += x * x; n++; } }
            if (n >= N_BB * 0.7) { const m = s / n; vol[i] = Math.sqrt(Math.max(0, s2 / n - m * m)); }
        }
        const bwArr2 = new Float64Array(days.length).fill(NaN);
        for (let i = N_BB - 1; i < days.length; i++) {
            let s = 0, s2 = 0, n = 0;
            for (let j = i - N_BB + 1; j <= i; j++) { const x = c[j]; if (Number.isNaN(x)) { n = 0; break; } s += x; s2 += x * x; n++; }
            if (n !== N_BB) continue;
            const m = s / n, sd = Math.sqrt(Math.max(0, s2 / n - m * m)), lo = m - K_BB * sd;
            if (lo > 0) bwArr2[i] = ((m + K_BB * sd) / lo - 1) * 100;
        }
        for (let i = START; i < days.length; i += STEP) {
            const b = bwArr2[i], v2 = vol[i];
            if (Number.isNaN(b) || Number.isNaN(v2)) continue;
            const w = []; for (let j = Math.max(0, i - 250); j < i; j++) if (!Number.isNaN(vol[j])) w.push(vol[j]);
            if (w.length < 120) continue;
            const s = Float64Array.from(w).sort();
            const p60 = s[Math.floor(s.length * 0.6)];
            const isBB = b > 20, isVol = v2 >= p60;      // ⭐ 60 分位 = V73.2.3 建議的「高波動」門檻
            if (isBB && isVol) both++; else if (isBB) bbOnly++; else if (isVol) volOnly++; else neither++;
        }
    }
    const tot = both + bbOnly + volOnly + neither;
    console.log('\n' + '─'.repeat(104));
    console.log('【4】⭐「帶寬 >20%」是不是只是把「高波動」再數一次?(V73.2.5 的增量檢定)');
    console.log('─'.repeat(104));
    console.log(`   兩個都成立 ${pct(both, tot).toFixed(1)}% ・ 只有帶寬>20% ${pct(bbOnly, tot).toFixed(1)}%` +
        ` ・ 只有高波動 ${pct(volOnly, tot).toFixed(1)}% ・ 都不成立 ${pct(neither, tot).toFixed(1)}%`);
    const cond = pct(both, both + bbOnly);
    console.log(`   ⭐ 帶寬>20% 的樣本裡有 ${cond.toFixed(1)}% 同時也是「高波動」`);
    console.log(`   → ${cond >= 80 ? '⛔ 幾乎是同一件事,加它不會有增量(同 V73.2.5 乖離那次)' : '⚠️ 重疊沒那麼高,理論上還有獨立資訊,但它扣成本後是負的,仍不值得做'}`);
}

console.log('\n⚠️ 窗口整段偏多頭 + 倖存者偏誤 → 空頭未驗證;⛔ 沒有全過六關的一律不上功能。');
