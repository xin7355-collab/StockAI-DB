#!/usr/bin/env node
/**
 * 🐢🆚 ETF 三題探針(V74.4.7,只讀 data/,零 API)
 *
 * 使用者問(2026-08-31):
 *   ① 0050 vs 台積電(2330),買進持有誰比較好?
 *   ② 「大跌時買 00981A(反彈比較大),等它績效沒有 0050 好時賣掉換回 0050」這個輪動策略行不行?
 *
 * ⚠️ ② 的誠實限制:00981A 是 2025/05/16 才上市的主動式 ETF → 只有 ~15 個月、
 *    一段行情,「大跌」事件個位數 → **任何參數化的輪動規則都驗不出穩健性**。
 *    → 做兩件事:(a) 在重疊窗口量它的體質(beta/漲跌日彈性)看「反彈比較大」是不是真的;
 *      (b) 用長歷史代理把同一套輪動規則測到夠多事件(含 2022 空頭)。
 *
 * 🚨🚨 第一版用 00631L(0050 正2)當代理 → 實跑印出「只抱 00631L +453%、回撤 −96.4%、
 *    輪動 +6753%」—— 那些數字**物理上不可能**,去驗資料才發現 `data/00631L.json`
 *    有兩處巨大斷崖(2024/08/01 10.63→242 = ×22.8、2026/03/25 443→20 = ×0.045)
 *    = **陷阱 #21 那批未修復的價格斷崖檔之一**(它是槓桿 ETF,正是名單裡的高風險族群)。
 *    ⭐ 又一次「先看基準像不像話,再看策略賺多少」救了結論。⛔ 00631L 修好前不可用。
 *    → 代理改用兩個乾淨的:
 *      (b1) **合成正2**:用 0050 的日報酬 ×2、每年扣 1.5% 費用拖累(槓桿 ETF 的標準近似),
 *           從 2021-01 起 → 含 2022 那段 −36% 空頭(輪動策略最怕的正是抱著槓桿撞上空頭)。
 *      (b2) **2330 當高彈性標的**(真實資料、乾淨、beta 高於 0050)。
 *    ⛔ 兩個都 ≠ 00981A(槓桿/單一股 vs 主動選股),驗的是「大跌換高彈性、落後換回」
 *       這個**邏輯**,不是 00981A 本身。
 *
 * ⛔ 三個不可拿掉的設計:
 *   1. 輪動規則一次測一整格參數(回檔門檻 × 相對落後窗口),⛔ 不挑單一格報數字
 *      (9 格裡挑最好的一格 = 多重比較假象);要嘛整排同向,要嘛就說不穩。
 *   2. 每次「換」收成本 0.27%(賣一邊+買另一邊:手續費 0.1425%×0.6×2 + ETF 證交稅 0.1%)。
 *   3. 價格系列**不含配息** —— 0050 殖利率 ~3%/年、2330 ~1.5%/年、00631L 不配息
 *      → 買進持有的比較要在結論裡把這件事講出來,⛔ 不可假裝含息。
 */
import fs from 'fs';

const load = s => {
    const rows = JSON.parse(fs.readFileSync(`data/${s}.json`, 'utf8'))
        .filter(r => +r.close > 0)
        .map(r => ({ d: String(r.date).replace(/\//g, '-'), c: +r.close }));
    return rows;
};
const pct = (a, b) => (a / b - 1) * 100;
const f1 = v => (v >= 0 ? '+' : '') + v.toFixed(1);
const f2 = v => (v >= 0 ? '+' : '') + v.toFixed(2);

const S = {};
for (const s of ['0050', '2330', '00981A']) S[s] = load(s);

// 🚧 資料斷崖守門(⛔ 別拿掉 —— 00631L 就是被這個抓出來的):
//    相鄰收盤差超過 ±40%(台股一天最多 ±10%)= 資料壞了,直接拒用。
for (const [s, rows] of Object.entries(S)) {
    for (let i = 1; i < rows.length; i++) {
        const k = rows[i].c / rows[i - 1].c;
        if (k > 1.4 || k < 0.7) { console.error(`⛔ ${s} 在 ${rows[i].d} 有 ×${k.toFixed(2)} 斷崖 → 資料壞了,拒跑`); process.exit(1); }
    }
}
// 🧪 合成正2(代理):0050 日報酬 ×2,每年扣 1.5% 費用拖累
{
    const base = S['0050'];
    let px = 100; const syn = [{ d: base[0].d, c: px }];
    for (let i = 1; i < base.length; i++) {
        px *= 1 + 2 * (base[i].c / base[i - 1].c - 1) - 0.015 / 244;
        syn.push({ d: base[i].d, c: px });
    }
    S['合成正2'] = syn;
}

// ── 對齊:兩檔共同交易日 ──
const align = (a, b) => {
    const mb = new Map(b.map(r => [r.d, r.c]));
    return a.filter(r => mb.has(r.d)).map(r => ({ d: r.d, a: r.c, b: mb.get(r.d) }));
};
const mdd = closes => {
    let peak = -1, worst = 0;
    for (const c of closes) { if (c > peak) peak = c; const dd = (c / peak - 1) * 100; if (dd < worst) worst = dd; }
    return worst;
};
const yearly = rows => {
    const by = {};
    for (const r of rows) (by[r.d.slice(0, 4)] ||= []).push(r);
    return Object.entries(by).map(([y, rr]) => [y, pct(rr[rr.length - 1].a, rr[0].a), pct(rr[rr.length - 1].b, rr[0].b)]);
};

// ═══ ① 0050 vs 2330 ═══
console.log('═'.repeat(70));
console.log('① 0050 vs 台積電(2330)—— 買進持有(⛔ 不含配息,見檔頭)');
const AB = align(S['0050'], S['2330']);
for (const from of ['2021-01-01', '2022-08-24', '2023-06-01']) {
    const w = AB.filter(r => r.d >= from);
    if (w.length < 100) continue;
    const yrs = w.length / 244;
    const ra = pct(w[w.length - 1].a, w[0].a), rb = pct(w[w.length - 1].b, w[0].b);
    console.log(`\n  📅 ${w[0].d} ~ ${w[w.length - 1].d}(${yrs.toFixed(1)} 年)`);
    console.log(`     0050:${f1(ra)}%(年化 ${f1((Math.pow(1 + ra / 100, 1 / yrs) - 1) * 100)}%)・最大回撤 ${mdd(w.map(r => r.a)).toFixed(1)}%`);
    console.log(`     2330:${f1(rb)}%(年化 ${f1((Math.pow(1 + rb / 100, 1 / yrs) - 1) * 100)}%)・最大回撤 ${mdd(w.map(r => r.b)).toFixed(1)}%`);
}
console.log('\n  📆 逐年(0050 / 2330):');
for (const [y, a, b] of yearly(AB)) console.log(`     ${y}:${f1(a)}% / ${f1(b)}%  ${b > a ? '← 2330 贏' : '← 0050 贏'}`);
{   // 定期定額(每月第一個交易日投 1 萬)
    const dca = key => {
        let units = 0, put = 0, lastM = '';
        for (const r of AB) { const m = r.d.slice(0, 7); if (m !== lastM) { lastM = m; units += 10000 / r[key]; put += 10000; } }
        const v = units * AB[AB.length - 1][key];
        return { put, v, ret: pct(v, put) };
    };
    const a = dca('a'), b = dca('b');
    console.log(`\n  💰 每月定期定額 1 萬(${AB[0].d} 起,投入 ${(a.put / 10000).toFixed(0)} 萬):`);
    console.log(`     0050:市值 ${(a.v / 10000).toFixed(1)} 萬(${f1(a.ret)}%) ・ 2330:市值 ${(b.v / 10000).toFixed(1)} 萬(${f1(b.ret)}%)`);
}

// ═══ ② 00981A 的體質(重疊窗口)═══
console.log('\n' + '═'.repeat(70));
console.log('② 00981A(主動式)vs 0050 —— 上市以來的體質(樣本只有一段行情,⚠️ 只能當描述)');
const Q = align(S['00981A'], S['0050']);
{
    console.log(`  重疊 ${Q.length} 個交易日(${Q[0].d} ~ ${Q[Q.length - 1].d})`);
    console.log(`  累積:00981A ${f1(pct(Q[Q.length - 1].a, Q[0].a))}% ・ 0050 ${f1(pct(Q[Q.length - 1].b, Q[0].b))}%`);
    console.log(`  最大回撤:00981A ${mdd(Q.map(r => r.a)).toFixed(1)}% ・ 0050 ${mdd(Q.map(r => r.b)).toFixed(1)}%`);
    // 日漲跌配對 → beta 與漲跌日彈性(「大跌時反彈比較大」的前提檢驗)
    const days = [];
    for (let i = 1; i < Q.length; i++) days.push({ x: pct(Q[i].b, Q[i - 1].b), y: pct(Q[i].a, Q[i - 1].a) });
    const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
    const mx = mean(days.map(p => p.x)), my = mean(days.map(p => p.y));
    let cov = 0, varx = 0;
    for (const p of days) { cov += (p.x - mx) * (p.y - my); varx += (p.x - mx) ** 2; }
    const beta = cov / varx;
    const up = days.filter(p => p.x >= 1), dn = days.filter(p => p.x <= -1);
    console.log(`  📐 對 0050 的 beta:${beta.toFixed(2)}(1 = 同幅度;>1 = 漲跌都比較大)`);
    console.log(`  0050 大漲日(≥+1%,${up.length} 天):0050 平均 ${f2(mean(up.map(p => p.x)))}% → 00981A ${f2(mean(up.map(p => p.y)))}%`);
    console.log(`  0050 大跌日(≤−1%,${dn.length} 天):0050 平均 ${f2(mean(dn.map(p => p.x)))}% → 00981A ${f2(mean(dn.map(p => p.y)))}%`);
}

// ═══ ③ 輪動規則:平時抱 0050,大跌換「高彈性」,落後換回 ═══
// 規則(把使用者的話寫死成可測的):
//   ・平時抱 0050
//   ・0050 從近 250 日高回檔 ≥ DD% 的那天收盤 → 換成 alt
//   ・換入後,alt 近 REL 日累積報酬 < 0050 近 REL 日(= 「績效沒有比較好」)→ 換回 0050
//   ・每次換(單程)扣 0.27%
// 🚨 第一版(episode=false)就是使用者講的字面規則 —— 實跑發現它會**打乒乓**:
//    落後 → 換回 0050 → 隔天還在「回檔 ≥DD%」→ 又換進去 → 5.6 年換 583 次,
//    全部在繳手續費。⭐ 這本身就是這條規則的第一個問題(要寫進結論)。
//    episode=true 是**對這個想法比較有利**的版本:每一波大跌只換一次,
//    要等 0050 回到高點附近(−1% 內)才重新武裝 —— 這才是「大跌時買」的合理讀法。
const rot = (P, DD, REL, episode) => {
    let hold = 'b', units = 1e6 / P[0].b, switches = 0, armed = true;   // b = 0050, a = alt
    const eq = [];
    for (let i = 0; i < P.length; i++) {
        const r = P[i];
        if (i > 0) {
            // 換倉判斷用**昨天收盤已知**的資訊,今天收盤價執行(零前視)
            const hi = Math.max(...P.slice(Math.max(0, i - 250), i).map(x => x.b));
            const ddNow = pct(P[i - 1].b, hi);
            if (episode && !armed && ddNow >= -1) armed = true;         // 回到高點附近 → 這一波結束
            if (hold === 'b' && ddNow <= -DD && (!episode || armed)) {
                units = units * P[i - 1].b / P[i - 1].a * (1 - 0.0027); hold = 'a'; switches++;
                if (episode) armed = false;
            } else if (hold === 'a' && i > REL) {
                const relA = pct(P[i - 1].a, P[i - 1 - REL].a), relB = pct(P[i - 1].b, P[i - 1 - REL].b);
                if (relA < relB) { units = units * P[i - 1].a / P[i - 1].b * (1 - 0.0027); hold = 'b'; switches++; }
            }
        }
        eq.push(units * (hold === 'a' ? r.a : r.b));
    }
    return { ret: pct(eq[eq.length - 1], 1e6), mdd: mdd(eq), switches, eq };
};
const rotGrid = (P, name, altName, episode) => {
    const yrs = P.length / 244;
    const pureB = pct(P[P.length - 1].b, P[0].b), pureA = pct(P[P.length - 1].a, P[0].a);
    console.log(`\n  🧪 ${name}(${P[0].d} ~ ${P[P.length - 1].d},${yrs.toFixed(1)} 年)${episode ? '【每波大跌只換一次】' : '【字面規則】'}`);
    console.log(`     只抱 0050:${f1(pureB)}%(回撤 ${mdd(P.map(r => r.b)).toFixed(1)}%) ・ 只抱 ${altName}:${f1(pureA)}%(回撤 ${mdd(P.map(r => r.a)).toFixed(1)}%)`);
    console.log(`     回檔門檻\\落後窗口   5日          10日          20日`);
    for (const DD of [3, 5, 8]) {
        const cells = [5, 10, 20].map(REL => {
            const r = rot(P, DD, REL, episode);
            return `${f1(r.ret)}%(換${r.switches},撤${r.mdd.toFixed(0)}%)`.padEnd(20);
        });
        console.log(`     跌 ${String(DD).padStart(2)}% 換入        ${cells.join(' ')}`);
    }
};
console.log('\n' + '═'.repeat(70));
console.log('③ 輪動:平時 0050 → 大跌換高彈性 → 落後換回(每次換扣 0.27%)');
const L = align(S['合成正2'], S['0050']);
const T = align(S['2330'], S['0050']);
rotGrid(Q, '00981A 版(⚠️ 只有 15 個月,看看就好)', '00981A', true);
rotGrid(L, '合成正2 長歷史代理版(2021 起,含 2022 空頭)', '合成正2', false);
rotGrid(L, '合成正2 長歷史代理版', '合成正2', true);
rotGrid(T, '2330 當高彈性標的版(真實資料,2021 起)', '2330', true);
for (const [nm2, P] of [['合成正2', L], ['2330', T]]) {
    // 前後半各自看(⛔ 00981A 版樣本太短沒資格做這一步);用對想法有利的 episode 版
    const half = Math.floor(P.length / 2);
    console.log(`\n  🔪 ${nm2} 版前後半各自跑(每波只換一次;基準 = 同段只抱 0050):`);
    for (const [tag, seg] of [['前半', P.slice(0, half)], ['後半', P.slice(half)]]) {
        const pureB = pct(seg[seg.length - 1].b, seg[0].b);
        const cells = [];
        for (const DD of [3, 5, 8]) for (const REL of [5, 10, 20]) cells.push(rot(seg, DD, REL, true).ret - pureB);
        const wins = cells.filter(v => v > 0).length;
        console.log(`     ${tag}(${seg[0].d}~${seg[seg.length - 1].d}):9 格贏過只抱 0050 的有 ${wins} 格(相對 ${cells.map(v => f1(v)).join(' / ')})`);
    }
}
console.log('\n✅ ETF_SWITCH_PROBE_DONE');
