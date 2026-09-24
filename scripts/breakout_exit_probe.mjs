#!/usr/bin/env node
/**
 * 📢🚪 「突破之後,哪一種出場賺最多」實測(V77.4.6)
 *
 * 使用者:「以聯發科為例,像這種突破上方無壓力,要用什麼方式才能讓獲利最高?」
 *
 * ⭐⭐ 這支問的**不是**「突破會不會漲」——那個本站已經測過三次而且答案是不會:
 *   ・`overhead_probe`      上方套牢區:穿不穿得過測得到(79→47.6% 單調),**賺不賺得到測不到**(六關 0 過)
 *   ・`breakoutdist_probe`  「快突破」排序:排最前那桶 +0.14pp、扣成本 −0.30、連漏斗本身都是 −0.22pp
 *   ・`accel_probe`         突破品質(CLV+量比) vs 素的創 60 日新高:**−0.01pp = 零**
 *   → 所以這支問的是 **V75.0.9 那條鐵則的延伸**:「贏不贏高度取決於**出場**,不是選股」。
 *      同一批突破事件,只換出場,差多少?
 *
 * 🚨 實驗設計(控制變因,照 `perstock_exit_probe.mjs` V74.6.1 的做法):
 *   ⭐ **固定同一批進場點,只換出場** —— ⛔ 不可各跑一次組合回測再比
 *      (出場早 → 下一個訊號更早進得來 → 比到最後分不出是出場好還是進場點不同)。
 *   ⭐ 模擬器走**共用的** `lib_exitsim.mjs`(跟 perstock_exit_probe 同一份)——
 *      ⛔ 不在這裡複製第二份出場公式。
 *
 * ⛔ 五個一定要有、少一個結論就不算數的對照:
 *   ① **對照組 = 同一批股票、同一段時間「隨便挑一天」買**(用同一組出場規則跑)
 *      —— 沒有它就分不出「這是突破的功勞」還是「這段本來就在漲」。
 *   ② **sham 安慰劑**:從同一母體隨機抽**同樣多**的日子(V77.3.3 的教訓:
 *      本金/檔數變少本身就會改變數字,增量一律跟 sham 比,⛔ 不跟「不濾」比)。
 *   ③ **扣同期加權**(超額)—— 絕對報酬會被那段多頭灌水。
 *   ④ **扣來回成本 0.44%**。
 *   ⑤ **門檻高原**:突破門檻 20/60/120/250 × 量比 1.0/1.2/1.5/2.0 —— 孤峰⛔ 不採用。
 *
 * ⚠️ 已知限制(一律印在報告裡):
 *   ・`data/*.json` 只回溯 2023-06 → **窗口不含 2022 空頭**,「逐年同向」只驗得到 2023~2026。
 *     要含 2022 請 `DATA_DIR=<klines_deep 合併過的目錄>`(`scripts/merge_deep_klines.mjs`)。
 *   ・倖存者偏誤:`data/` 只有還活著的股票。
 *   ・進場價 = **訊號日收盤**(V72.9.0 實測有效進場點只有訊號日尾盤);
 *     鎖漲停那天買不到 → 剔除。
 *   ・MAXD 封頂會**砍掉大贏家** → 預設 60 天,另跑 20 天當敏感度(⛔ 只看一個會誤判)。
 */
import fs from 'fs';
import path from 'path';
import { simExits, exitName } from './lib_exitsim.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const COST = 0.44;
const MAXD = +(process.env.MAXD || 60);
const DEDUP = +(process.env.DEDUP || 20);
const LIMIT = +(process.env.LIMIT || 0);
const SELFTEST = process.argv.includes('--selftest');
// 🛑 V77.5.9 停損成交價(stop = 舊版 / close = auto_trade / touch = 觸價智慧單),見 lib_exitsim
const STOPFILL = process.env.STOPFILL || 'stop';
// 🕯️ V77.5.9 突破那根 K 的幅度 ÷ ATR14(ATR 逐字稿:「1~2 倍 ATR 的突破 K 才進場」)
//   ⭐ ATR 只用**訊號日之前**的 14 根(陷阱 #43:基準⛔ 不可包含被判斷的那根)
const TA_BINS = [[0, 1], [1, 1.5], [1.5, 2], [2, 3], [3, Infinity]];
export function trAtr(R, i) {
    if (i < 15) return null;
    const tr = q => Math.max(R[q].h - R[q].l, Math.abs(R[q].h - R[q - 1].c), Math.abs(R[q].l - R[q - 1].c));
    let s = 0; for (let q = i - 14; q < i; q++) s += tr(q);
    const atr = s / 14;
    return atr > 0 ? tr(i) / atr : null;
}

const RULES = ['hold', 'ma5', 'ma10', 'ma20', 'don10', 'don20', 'donmid20', 'don55', 'atr2', 'atr3', 'trail8', 'trail15'];
const HORIZ = [20, 60, 120, 250];          // 突破門檻:創 N 日新高
const VOLQ = [1.0, 1.2, 1.5, 2.0];         // 量比門檻(1.0 = 不設)

// ═══ 小工具 ═══
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const med = a => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const welch = (a, b) => {   // 回 z(⛔ 不假裝算得出精確 p,大樣本下 |z|≥2 當門檻)
    if (a.length < 3 || b.length < 3) return 0;
    const va = sd(a) ** 2 / a.length, vb = sd(b) ** 2 / b.length;
    return (va + vb) > 0 ? (mean(a) - mean(b)) / Math.sqrt(va + vb) : 0;
};
const pf = a => {   // 獲利因子
    let up = 0, dn = 0; for (const x of a) { if (x > 0) up += x; else dn -= x; }
    return dn > 0 ? up / dn : (up > 0 ? Infinity : 0);
};
// 固定種子亂數(sham 要可重現)
let _seed = 20260922;
const rnd = () => { _seed = (_seed * 1103515245 + 12345) & 0x7fffffff; return _seed / 0x7fffffff; };

// ═══ 🧪 自我驗證 ═══
if (SELFTEST) {
    let bad = 0;
    const ok = (nm, cond, got) => { if (!cond) bad++; console.log(`${cond ? '✅' : '❌'} ${nm}${cond ? '' : `  → 實際:${JSON.stringify(got)}`}`); };
    const mk = a => a.map(x => ({ d: '', o: x, h: x * 1.002, l: x * 0.998, c: x, v: 1000 }));

    // ① 突破判定⛔ 不可含今天(陷阱 #43):一路走平再跳一根高的 → 只有那一根算突破
    {
        const a = []; for (let i = 0; i < 40; i++) a.push(100); a.push(110); for (let i = 0; i < 5; i++) a.push(109);
        const R = mk(a);
        const hit = [];
        for (let i = 20; i < R.length; i++) { let mx = -Infinity; for (let q = i - 20; q < i; q++) mx = Math.max(mx, R[q].h); if (R[i].c > mx) hit.push(i); }
        ok('① 突破基準⛔ 不含今天 → 只有跳上去那一根算(index 40)', hit.length === 1 && hit[0] === 40, hit);
    }
    // ①b 決定性對照:把基準改成**含今天**(退回錯的寫法)→ 一根都不該亮
    {
        const a = []; for (let i = 0; i < 40; i++) a.push(100); a.push(110);
        const R = mk(a); const hit = [];
        for (let i = 20; i < R.length; i++) { let mx = -Infinity; for (let q = i - 20; q <= i; q++) mx = Math.max(mx, R[q].h); if (R[i].c > mx) hit.push(i); }
        ok('①b ⭐ 決定性對照:基準含今天 → 數學上不可能成立(0 根)', hit.length === 0, hit);
    }
    // ② `hold` 對照組:一路漲不回頭 → 一定撐到封頂,而且報酬 ≥ 任何有出場的規則
    {
        const a = []; for (let i = 0; i < 90; i++) a.push(100 * Math.pow(1.01, i));
        const r = simExits(mk(a), 20, { rules: RULES, maxD: MAXD });
        ok('② hold 撐到封頂', r.hold.outIdx === 20 + MAXD, r.hold.outIdx);
        ok('②b 一路漲時 hold 的報酬 ≥ 每一種有出場的', RULES.every(k => r.hold.ret >= r[k].ret - 1e-9), Object.fromEntries(RULES.map(k => [k, +r[k].ret.toFixed(2)])));
    }
    // ③ 一路跌 → 停損是**下限**,而有出場規則的會更早跑掉
    //   🚨 **我第一版的期望值寫錯了**(寫成「全部走停損」)—— 一路跌時 ma/don 當然比停損更早觸發,
    //   那正是出場規則的用意。⭐ 通用:斷言紅燈先分「程式錯 vs 期望值錯」,⛔ 別回頭去改程式遷就它。
    {
        const a = []; for (let i = 0; i < 60; i++) a.push(100 - i);
        const r = simExits(mk(a), 20, { rules: RULES, maxD: MAXD });
        ok('③ hold(沒有出場規則)一路跌 → 一定走停損', r.hold.why === '停損', r.hold.why);
        const rets = RULES.map(k => r[k].ret);
        ok('③b 一路跌 → 沒有任何一種能賺', rets.every(x => x < 0), rets.map(x => +x.toFixed(2)));
        ok('③c ⭐ 停損是下限:沒有任何一種比 hold 更慘(有出場 = 早點跑)',
            rets.every(x => x >= r.hold.ret - 1e-9), { hold: +r.hold.ret.toFixed(2), rets: rets.map(x => +x.toFixed(2)) });
        ok('③d 而且敏感的規則真的更早出(ma5 早於 hold)', r.ma5.outIdx < r.hold.outIdx, { ma5: r.ma5.outIdx, hold: r.hold.outIdx });
    }
    // ④ 唐奇安天期越長越晚出場(單調)—— 認不得的 key 要 throw
    {
        const a = []; for (let i = 0; i < 40; i++) a.push(100 + i * 0.5);
        for (let i = 1; i <= 30; i++) a.push(120 - i * 0.6);
        const r = simExits(mk(a), 25, { rules: ['don10', 'don20', 'don55'], maxD: 60 });
        ok('④ don10 ≤ don20 ≤ don55(天期越長越晚出)', r.don10.outIdx <= r.don20.outIdx && r.don20.outIdx <= r.don55.outIdx,
            { don10: r.don10.outIdx, don20: r.don20.outIdx, don55: r.don55.outIdx });
        let threw = false; try { simExits(mk(a), 25, { rules: ['don20x'] }); } catch { threw = true; }
        ok('④b ⛔ 打錯字的規則要 throw(安靜地永不出場是最糟的失敗)', threw, threw);
    }
    // ④c 唐奇安中軌(donmid,V77.5.6 新增)⭐ 中軌 ≥ 下軌 → 觸發門檻更高 → 一定比 don{N} 更早出場
    {
        const a = []; for (let i = 0; i < 40; i++) a.push(100 + i * 0.5);
        for (let i = 1; i <= 30; i++) a.push(120 - i * 0.6);
        const r = simExits(mk(a), 25, { rules: ['don20', 'donmid20'], maxD: 60 });
        ok('④c donmid20 的出場點 ≤ don20(中軌天生比下軌鬆,更早觸發)',
            r.donmid20.outIdx <= r.don20.outIdx, { donmid20: r.donmid20.outIdx, don20: r.don20.outIdx });
    }
    // ⑤ 鎖漲停剔除:訊號日 +9.6% → 尾盤買不到
    {
        const lim = (c, pc) => c >= pc * 1.095;
        ok('⑤ 鎖漲停(+9.6%)要被剔除、+9.4% 不剔除', lim(109.6, 100) && !lim(109.4, 100), [lim(109.6, 100), lim(109.4, 100)]);
    }
    // ⑥ 20 日去重
    {
        const idxs = [10, 15, 31, 33, 60], keep = []; let last = -999;
        for (const i of idxs) if (i - last >= 20) { keep.push(i); last = i; }
        ok('⑥ 20 日去重:10,15,31,33,60 → 只留 10,31,60', JSON.stringify(keep) === '[10,31,60]', keep);
    }
    // ⑦ sham 抽到的日子數量必須跟事件數一樣
    {
        const pool = Array.from({ length: 500 }, (_, i) => i), want = 37;
        const pick = []; const p2 = [...pool];
        for (let i = 0; i < want && p2.length; i++) pick.push(p2.splice(Math.floor(rnd() * p2.length), 1)[0]);
        ok('⑦ sham 抽同樣多的日子(37)且不重複', pick.length === want && new Set(pick).size === want, pick.length);
    }
    // ⑧ 突破 K ÷ ATR:ATR⛔ 不含當根 —— 平平 20 根(幅度 2)後一根幅度 10 → 比值 = 5;含當根的錯寫法會算成 < 5
    {
        const R = []; for (let q = 0; q < 20; q++) R.push({ o: 100, h: 101, l: 99, c: 100 });
        R.push({ o: 100, h: 110, l: 100, c: 110 });
        const v = trAtr(R, 20);
        ok('⑧ 突破 K ÷ ATR 的 ATR 不含當根(=5.0)', v != null && Math.abs(v - 5) < 1e-9, v);
    }
    // ⑨ 停損成交價:跳空開在停損下面 → stop 記停損價、close 記收盤、touch 記開盤
    {
        const a = []; for (let q = 0; q < 30; q++) a.push(100);
        const R = a.map(x => ({ o: x, h: x * 1.002, l: x * 0.998, c: x }));
        R.push({ o: 88, h: 90, l: 86, c: 87 });            // 停損 = min(99.8, 95) = 95 → 開盤 88、收 87
        for (let q = 0; q < 5; q++) R.push({ o: 87, h: 88, l: 86, c: 87 });
        const f = m => simExits(R, 29, { rules: ['hold'], maxD: 10, stopFill: m }).hold;
        const s0 = f('stop'), s1 = f('close'), s2 = f('touch');
        ok('⑨ stop 口徑 = 停損價(−5%,⚠️ 收盤其實在 87)', Math.abs(s0.ret - (-5)) < 0.01, s0.ret);
        ok('⑨b close 口徑 = 收盤(−13%)', Math.abs(s1.ret - (-13)) < 0.01, s1.ret);
        ok('⑨c touch 口徑 = 開盤(−12%)', Math.abs(s2.ret - (-12)) < 0.01, s2.ret);
        // ⑨d touch:盤中碰到但收盤站回 → touch 要出場、close 不出場
        const R2 = a.map(x => ({ o: x, h: x * 1.002, l: x * 0.998, c: x }));
        R2.push({ o: 100, h: 100.5, l: 94, c: 100.2 });   // 盤中殺到 94(< 95)、收盤站回
        for (let q = 0; q < 5; q++) R2.push({ o: 100, h: 100.5, l: 99.9, c: 100.2 });
        const t1 = simExits(R2, 29, { rules: ['hold'], maxD: 5, stopFill: 'touch' }).hold;
        const t0 = simExits(R2, 29, { rules: ['hold'], maxD: 5, stopFill: 'close' }).hold;
        ok('⑨d 盤中碰到收盤站回:touch 出場、close 不出場', t1.why === '停損' && t0.why !== '停損', [t1.why, t0.why]);
        let threw = false; try { simExits(R2, 29, { rules: ['hold'], stopFill: 'x' }); } catch { threw = true; }
        ok('⑨e 認不得的 stopFill 要 throw', threw, threw);
    }
    console.log(bad ? `\n❌ BREAKOUT_EXIT_SELFTEST_FAIL ${bad} 條` : '\n✅ BREAKOUT_EXIT_SELFTEST_PASS');
    process.exit(bad ? 1 : 0);
}

// ═══ 1. 載入 ═══
const files = fs.readdirSync(DATA).filter(x => /^\d{4}\.json$/.test(x));
const syms = (LIMIT ? files.slice(0, LIMIT) : files).map(f => f.replace('.json', ''));
console.log(`📢🚪 突破 × 出場 實測 —— ${syms.length} 檔 ・封頂 ${MAXD} 日 ・去重 ${DEDUP} 日 ・成本 ${COST}%`);

// 大盤(扣同期超額)
let TW = null;
try {
    const t = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8'));
    TW = new Map(t.map((r, i) => [r.date, i]));
    TW._rows = t;
} catch { console.log('⚠️ 讀不到 ^TWII.json → 只給原始報酬,⛔ 不給超額'); }
const twEx = (d0, days) => {
    if (!TW) return null;
    const i = TW.get(d0); if (i == null) return null;
    const j = Math.min(TW._rows.length - 1, i + days);
    const a = TW._rows[i].close, b = TW._rows[j].close;
    return (a > 0) ? (b - a) / a * 100 : null;
};

// ═══ 2. 掃事件 ═══
//   ev[N][vq] = [{sym, i, date, rets:{rule:ret}, ex:{rule:超額}}]
const EV = {}; for (const N of HORIZ) for (const v of VOLQ) EV[`${N}|${v}`] = [];
const BASE = [];    // 對照組:隨便挑一天(每檔等距抽樣,⛔ 不挑日子)
let nSym = 0, nBar = 0, skipLimit = 0, nCliff = 0;

for (const sym of syms) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(DATA, `${sym}.json`), 'utf8')); } catch { continue; }
    if (!Array.isArray(d) || d.length < 300) continue;
    const R = d.map(r => ({ d: r.date, o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +(r.volume || 0) }));
    const n = R.length;
    if (!R.every(r => r.c > 0)) continue;
    // 🚧 斷崖守門:相鄰收盤 ±40% 物理上不可能是真實漲跌(非整數比減資/除權留下的尺標斷層,
    //    CLAUDE.md V77.2.1 實測上市櫃 12 檔)→ 整檔剔除,⛔ 不可讓壞掉的價格進到出場模擬。
    {
        let cliff = false;
        for (let q = 1; q < R.length; q++) { const rr = R[q].c / R[q - 1].c; if (rr > 1.4 || rr < 0.6) { cliff = true; break; } }
        if (cliff) { nCliff++; continue; }
    }
    nSym++;

    const lastHit = {}; for (const k in EV) lastHit[k] = -999;
    const maxN = Math.max(...HORIZ);
    for (let i = maxN; i < n - MAXD - 1; i++) {
        nBar++;
        const c = R[i].c, pc = R[i - 1].c;
        if (c >= pc * 1.095) { skipLimit++; continue; }          // 鎖漲停買不到
        // 量比(基準⛔ 不含今天)
        let vb = 0; for (let q = i - 20; q < i; q++) vb += R[q].v; vb /= 20;
        const vr = vb > 0 ? R[i].v / vb : 0;
        let sim = null;
        for (const N of HORIZ) {
            let mx = -Infinity; for (let q = i - N; q < i; q++) mx = Math.max(mx, R[q].h);
            if (!(c > mx)) continue;
            for (const v of VOLQ) {
                if (vr < v) continue;
                const k = `${N}|${v}`;
                if (i - lastHit[k] < DEDUP) continue;
                lastHit[k] = i;
                sim = sim || simExits(R, i, { rules: RULES, maxD: MAXD, stopFill: STOPFILL });
                if (!sim) continue;
                EV[k].push({ sym, i, date: R[i].d, r: sim, ta: trAtr(R, i) });
            }
        }
        // 對照組:每 DEDUP 根抽一根(⛔ 不挑日子;跟事件同一批股票、同一段時間)
        if (i % DEDUP === 0) {
            const s2 = sim || simExits(R, i, { rules: RULES, maxD: MAXD, stopFill: STOPFILL });
            if (s2) BASE.push({ sym, i, date: R[i].d, r: s2 });
        }
    }
    if (nSym % 400 === 0) process.stdout.write(`\r   ${nSym} 檔 …`);
}
console.log(`\r   ✅ ${nSym} 檔 ・${nBar.toLocaleString()} 股·日 ・鎖漲停剔除 ${skipLimit.toLocaleString()} 筆 ・🚧 斷崖剔除 ${nCliff} 檔 ・對照組 ${BASE.length.toLocaleString()} 筆`);
{   // ⛔ 窗口要印出來(⛔ 不可讓「含不含 2022」用猜的)
    const ds = BASE.map(e => e.date); ds.sort();
    console.log(`   📅 事件窗口:${ds[0]} ~ ${ds[ds.length - 1]}\n`);
}

// ═══ 3. 統計 ═══
const netOf = (arr, rule) => arr.map(e => e.r[rule].ret - COST);
const exOf = (arr, rule) => arr.map(e => {
    const b = twEx(e.date, e.r[rule].outIdx - e.i);
    return e.r[rule].ret - COST - (b == null ? 0 : b);
});
const yearOf = e => e.date.slice(0, 4);

function row(arr, rule) {
    const net = netOf(arr, rule), ex = exOf(arr, rule);
    return {
        n: arr.length, net: mean(net), netMed: med(net), ex: mean(ex),
        win: net.filter(x => x > 0).length / (net.length || 1) * 100,
        pf: pf(net), days: mean(arr.map(e => e.r[rule].outIdx - e.i)),
    };
}
const fmtPF = x => !isFinite(x) ? ' ∞ ' : x.toFixed(2);

// ── 主表:各突破門檻 × 各出場 ──
console.log('═'.repeat(112));
console.log(`【主表】同一批突破事件,只換出場(封頂 ${MAXD} 日 ・已扣成本 ${COST}% ・ex = 再扣同期加權)`);
console.log('═'.repeat(112));
const baseRow = {}; for (const r of RULES) baseRow[r] = row(BASE, r);
console.log('\n── 對照組:同一批股票「隨便挑一天」買 ──');
console.log('出場規則'.padEnd(22) + '  n      平均淨%  中位%   超額pp  勝率%  獲利因子 抱幾天');
for (const r of RULES) { const x = baseRow[r];
    console.log(`${exitName(r).padEnd(22)}${String(x.n).padStart(7)} ${x.net.toFixed(2).padStart(8)} ${x.netMed.toFixed(2).padStart(7)} ${x.ex.toFixed(2).padStart(8)} ${x.win.toFixed(1).padStart(6)} ${fmtPF(x.pf).padStart(8)} ${x.days.toFixed(1).padStart(6)}`);
}

const best = [];
for (const N of HORIZ) {
    const k = `${N}|1`; const arr = EV[k];
    if (arr.length < 30) { console.log(`\n── 創 ${N} 日新高:樣本不足(${arr.length}) ⛔ 不下判定 ──`); continue; }
    console.log(`\n── 創 ${N} 日新高(不設量比門檻)・n=${arr.length.toLocaleString()} ──`);
    console.log('出場規則'.padEnd(22) + '  n      平均淨%  中位%   超額pp  勝率%  獲利因子 抱幾天   vs 對照(超額)');
    for (const r of RULES) {
        const x = row(arr, r), b = baseRow[r];
        const dz = welch(exOf(arr, r), exOf(BASE, r));
        const d = x.ex - b.ex;
        console.log(`${exitName(r).padEnd(22)}${String(x.n).padStart(7)} ${x.net.toFixed(2).padStart(8)} ${x.netMed.toFixed(2).padStart(7)} ${x.ex.toFixed(2).padStart(8)} ${x.win.toFixed(1).padStart(6)} ${fmtPF(x.pf).padStart(8)} ${x.days.toFixed(1).padStart(6)}   ${(d >= 0 ? '+' : '') + d.toFixed(2)}pp (z=${dz.toFixed(2)})`);
        best.push({ N, rule: r, ...x, d, z: dz });
    }
}

// ── 量比高原 ──
console.log('\n' + '═'.repeat(112));
console.log('【高原檢定】量比門檻(創 60 日新高 × 唐奇安 20 日)—— ⭐ 孤峰⛔ 不可採用');
console.log('═'.repeat(112));
console.log('量比門檻   n       平均淨%   超額pp   勝率%');
for (const v of VOLQ) {
    const arr = EV[`60|${v}`]; if (arr.length < 30) { console.log(`≥${v.toFixed(1)}x     樣本不足(${arr.length})`); continue; }
    const x = row(arr, 'don20');
    console.log(`≥${v.toFixed(1)}x  ${String(x.n).padStart(7)} ${x.net.toFixed(2).padStart(9)} ${x.ex.toFixed(2).padStart(8)} ${x.win.toFixed(1).padStart(7)}`);
}

// ── 六關(拿「創 60 日新高」那一組的最佳出場 vs 對照組) ──
console.log('\n' + '═'.repeat(112));
console.log('【六關】創 60 日新高 × 每一種出場 —— 對照組 = 同一批股票隨便挑一天(同一種出場)');
console.log('═'.repeat(112));
const arr60 = EV['60|1'];
if (arr60.length >= 30) {
    const years = [...new Set(BASE.map(yearOf))].sort();
    console.log('出場規則'.padEnd(22) + ' 全期  前半  後半  逐年同向        去最好年  扣成本  |z|≥2  過幾關');
    for (const r of RULES) {
        const ee = exOf(arr60, r), bb = exOf(BASE, r);
        const all = mean(ee) - mean(bb);
        const mid = Math.floor(arr60.length / 2);
        const h1 = mean(exOf(arr60.slice(0, mid), r)) - mean(bb);
        const h2 = mean(exOf(arr60.slice(mid), r)) - mean(bb);
        const yr = years.map(y => {
            const a = arr60.filter(e => yearOf(e) === y), b = BASE.filter(e => yearOf(e) === y);
            if (a.length < 20 || b.length < 20) return null;
            return mean(exOf(a, r)) - mean(exOf(b, r));
        }).filter(x => x != null);
        const yrOK = yr.length >= 2 && yr.every(x => x > 0);
        const drop = yr.length >= 2 ? (() => { const i = yr.indexOf(Math.max(...yr)); const rest = yr.filter((_, k) => k !== i); return rest.length ? mean(rest) > 0 : false; })() : false;
        const z = welch(ee, bb);
        const gates = [all > 0, h1 > 0 && h2 > 0, yrOK, drop, mean(netOf(arr60, r)) > 0, Math.abs(z) >= 2];
        const pass = gates.filter(Boolean).length;
        console.log(`${exitName(r).padEnd(22)}${(all >= 0 ? '+' : '') + all.toFixed(2)} ${(h1 >= 0 ? '+' : '') + h1.toFixed(2)} ${(h2 >= 0 ? '+' : '') + h2.toFixed(2)}  ${yr.map(x => (x >= 0 ? '+' : '') + x.toFixed(1)).join(' ').padEnd(16)} ${drop ? '✅' : '❌'}      ${mean(netOf(arr60, r)) > 0 ? '✅' : '❌'}     ${Math.abs(z) >= 2 ? '✅' : '❌'}    ${pass}/6`);
    }
} else console.log('⛔ 樣本不足');

// ── 🕯️ 突破 K 的幅度(÷ ATR14)── V77.5.9
console.log('\n' + '═'.repeat(112));
console.log('【突破 K 幅度 ÷ ATR14】同一批突破,依訊號那根的真實波幅分桶 × 唐奇安 20 日 —— 對照 = 同一個門檻的**全部**突破(⛔ 不是全市場)');
console.log('═'.repeat(112));
const TA = {};
for (const N of [20, 60, 120]) {
    const all = EV[`${N}|1`].filter(e => e.ta != null); if (all.length < 100) continue;
    const years = [...new Set(all.map(yearOf))].sort();
    const exAll = exOf(all, 'don20'), mAll = mean(exAll);
    console.log(`\n── 創 ${N} 日新高 ・n=${all.length.toLocaleString()} ・全部突破超額 ${mAll.toFixed(2)}pp ──`);
    console.log('K÷ATR     n       佔比%   超額pp   增量pp  前半  後半  逐年同向            去最好年 扣成本絕對 |z|≥2 過幾關');
    TA[N] = [];
    for (const [lo, hi] of TA_BINS) {
        const a = all.filter(e => e.ta >= lo && e.ta < hi);
        const lab = `${lo}~${isFinite(hi) ? hi : ''}`.padEnd(8);
        if (a.length < 30) { console.log(`${lab} 樣本不足(${a.length})`); continue; }
        const ea = exOf(a, 'don20'), d = mean(ea) - mAll;
        const mid = Math.floor(a.length / 2);
        const h1 = mean(exOf(a.slice(0, mid), 'don20')) - mAll, h2 = mean(exOf(a.slice(mid), 'don20')) - mAll;
        const yr = years.map(y => { const aa = a.filter(e => yearOf(e) === y), bb = all.filter(e => yearOf(e) === y);
            return aa.length >= 20 ? mean(exOf(aa, 'don20')) - mean(exOf(bb, 'don20')) : null; }).filter(x => x != null);
        // ⚠️ 關卡以「這一桶自己的方向」判(增量為負的桶 = 避雷,也要能判得出來)
        const yrOK = yr.length >= 2 && (d > 0 ? yr.every(x => x > 0) : yr.every(x => x < 0));
        const drop = yr.length >= 2 ? (() => { const k = yr.indexOf(d > 0 ? Math.max(...yr) : Math.min(...yr)); const rest = yr.filter((_, q) => q !== k); return rest.length ? (d > 0 ? mean(rest) > 0 : mean(rest) < 0) : false; })() : false;
        const z = welch(ea, exAll), absNet = mean(netOf(a, 'don20'));
        const g = [d > 0, (h1 > 0) === (h2 > 0) && (h1 > 0) === (d > 0), yrOK, drop, absNet > 0, Math.abs(z) >= 2];
        const pass = g.filter(Boolean).length;
        TA[N].push({ lo, hi: isFinite(hi) ? hi : null, n: a.length, ex: mean(ea), d, h1, h2, yr, z, absNet, pass });
        console.log(`${lab}${String(a.length).padStart(7)} ${(a.length / all.length * 100).toFixed(1).padStart(7)} ${mean(ea).toFixed(2).padStart(8)} ${((d >= 0 ? '+' : '') + d.toFixed(2)).padStart(8)} ${((h1 >= 0 ? '+' : '') + h1.toFixed(2)).padStart(6)} ${((h2 >= 0 ? '+' : '') + h2.toFixed(2)).padStart(6)}  ${yr.map(x => (x >= 0 ? '+' : '') + x.toFixed(1)).join(' ').padEnd(20)} ${drop ? '✅' : '❌'}      ${absNet > 0 ? '✅' : '❌'}     ${Math.abs(z) >= 2 ? '✅' : '❌'}    ${pass}/6`);
    }
}
if (process.env.TA_OUT) fs.writeFileSync(process.env.TA_OUT, JSON.stringify({ stopFill: STOPFILL, maxD: MAXD, bins: TA }));

// ── sham 安慰劑 ──
console.log('\n' + '═'.repeat(112));
console.log('【sham】從對照組隨機抽「同樣多」的日子 —— ⭐ 增量要跟這個比,⛔ 不跟「不濾」比(V77.3.3)');
console.log('═'.repeat(112));
if (arr60.length >= 30 && BASE.length > arr60.length) {
    const pool = [...BASE], pick = [];
    for (let i = 0; i < arr60.length && pool.length; i++) pick.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
    console.log('出場規則'.padEnd(22) + '  突破(超額pp)   sham(超額pp)   差');
    for (const r of RULES) {
        const a = mean(exOf(arr60, r)), s = mean(exOf(pick, r));
        console.log(`${exitName(r).padEnd(22)}${a.toFixed(2).padStart(10)} ${s.toFixed(2).padStart(14)} ${((a - s) >= 0 ? '+' : '') + (a - s).toFixed(2)}`);
    }
}

console.log('\n' + '═'.repeat(112));
console.log('⚠️ 限制:窗口' + (DATA.includes('dd') ? '(深歷史)' : ' 2023-06 起 → **不含 2022 空頭**') + ' ・倖存者偏誤 ・進場價 = 訊號日收盤(尾盤)');
console.log(`⚠️ 封頂 ${MAXD} 日會砍掉大贏家 → ⭐ 一定要另跑 MAXD=20 與 MAXD=120 對照,⛔ 只看一個會誤判`);
console.log('⛔ 這裡的絕對數字⛔ 不可跟組合回測比(那邊有本金限制與每天挑 N 檔)');
