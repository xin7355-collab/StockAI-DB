// 🔄 V77.7.6 「情勢變了自動換出場規則」的排程產生器(給 portfolio_backtest.mjs 的 EXIT_SCHED 用)
//
// 使用者:「應該以現行最厲害的策略執行,情勢改變需要的時候再自動改成其它策略」。
// ⭐ 「自動換」本身就是一個策略,⛔ 沒回測過不上線 —— 它最常見的失敗是「追逐最近表現」(剛好換在轉折點)。
//
// 做法(零前視):每個月第一個交易日 T,對每一套候選規則,看它的**全部候選交易**裡
//   「出場日 < T 而且 ≥ T 往前 L 個月」的那些(= T 那天已經知道結果的)→ 算績效 → 選最好的那套,
//   當作「這個月新進場的交易用哪一套」。持有中的部位⛔ 不換(由引擎處理)。
//   績效 METRIC=day(預設):Σ(報酬 − 成本) ÷ Σ 持有天數 = 每一天資金的效率
//   (⛔ 不用「平均每筆」:出場快的規則每筆小但次數多,平均每筆會系統性偏向出場慢的)
//        METRIC=trade:平均每筆(對照用)
//   SIGNAL=pool(預設):上面那樣看「全部候選交易」—— ⚠️ 母體比實際買的大很多(沒過 🧬 / 每天 2 檔 / 錢夠不夠)
//   SIGNAL=taken:改看每一套**固定用那一套的影子組合**實際成交的交易(TAKENS=「規則=portfolio_backtest TAKEN_OUT 檔,…」)
//     分數 = 過去 L 個月出場的那些筆 Σ(報酬 + 股利 − 成本)= 影子組合那段期間實現的損益(每筆金額相同)
//     ⛔ 一樣只用出場日 < T 的;影子組合是另一個假想的帳戶,T 那天在真實世界也算得出來 → 零前視
// 對照:MODE=sham 每月隨機挑一套(安慰劑,⛔ 用固定種子);MODE=fixed:<規則> 全期同一套(決定性對照用)。
//
// 跑法:DATA_DIR=<K 線目錄(要有 ^TWII.json)> SCHED_CACHES="chand2:20=a.json,don40:40=b.json,…" \
//       L=12 METRIC=day MODE=best node scripts/exit_switch_probe.mjs out_sched.json
//       node scripts/exit_switch_probe.mjs --selftest
import fs from 'fs';
import path from 'path';

const COST = 0.44;

/** 月初交易日清單(days 已排序) */
export function monthStarts(days) {
    const out = []; let last = '';
    for (const d of days) { const m = d.slice(0, 7); if (m !== last) { out.push(d); last = m; } }
    return out;
}
/** 往前 L 個月的日期(字串比較用) */
export function monthsBack(d, L) {
    const y = +d.slice(0, 4), m = +d.slice(5, 7) - 1 - L;
    const yy = y + Math.floor(m / 12), mm = ((m % 12) + 12) % 12 + 1;
    return `${yy}-${String(mm).padStart(2, '0')}${d.slice(7)}`;
}
/**
 * 產生排程。rules = [{r, trades:[{inD,outD,ret}]}](trades 依 outD 排序最好,不排也可)
 * ⛔ 只用 outD < T 的交易(T 那天收盤後才知道的不算)。
 */
export function buildSchedule({ days, rules, L, metric = 'day', mode = 'best', seed = 20260927, dayIdx, minN = 30, step = 1 }) {
    // STEP = 幾個月才重新檢查一次(12 = 一年一次;其他月份沿用上一次的選擇 —— 換得越少,追逐短期表現的傷害越小)
    const starts = monthStarts(days).filter((d, i) => i % step === 0);
    const di = dayIdx || new Map(days.map((d, i) => [d, i]));
    const hold = t => { const a = di.get(t.inD), b = di.get(t.outD); return a != null && b != null && b > a ? b - a : null; };
    const prep = rules.map(({ r, trades }) => ({ r, tr: trades.map(t => ({ out: String(t.outD).replace(/\//g, '-'), v: t.ret + (t.dv || 0) - COST, h: hold({ inD: String(t.inD || t.d).replace(/\//g, '-'), outD: String(t.outD).replace(/\//g, '-') }) })).filter(x => x.h != null).sort((a, b) => a.out < b.out ? -1 : 1) }));
    let s = seed; const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    const sched = {}, detail = [];
    let prev = mode.startsWith('fixed:') ? mode.slice(6) : rules[0].r;
    for (const T of starts) {
        const from = monthsBack(T, L);
        const score = {};
        for (const { r, tr } of prep) {
            let sv = 0, sh = 0, n = 0;
            for (const x of tr) { if (x.out >= T) break; if (x.out < from) continue; sv += x.v; sh += x.h; n++; }
            score[r] = n >= minN ? (metric === 'trade' ? sv / n : metric === 'sum' ? sv : sv / sh) : null;   // ⛔ 樣本不足不比
        }
        let pick = prev;
        if (mode === 'sham') pick = rules[Math.floor(rnd() * rules.length)].r;
        else if (mode.startsWith('fixed:')) pick = mode.slice(6);
        else {
            const ok = Object.entries(score).filter(([, v]) => v != null);
            if (ok.length === rules.length) pick = ok.sort((a, b) => b[1] - a[1])[0][0];   // 有一套樣本不足就沿用上一個月(⛔ 不拿半套資料比)
        }
        sched[T] = pick; prev = pick;
        detail.push({ T, pick, score });
    }
    return { sched, detail };
}

function selftest() {
    const fails = []; const ck = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fails.push(m); };
    const days = []; for (let i = 0; i < 600; i++) { const d = new Date(Date.UTC(2020, 0, 1) + i * 864e5); if (d.getUTCDay() % 6) days.push(d.toISOString().slice(0, 10)); }
    const mk = (fn) => { const t = []; for (let i = 0; i + 5 < days.length; i += 1) t.push({ inD: days[i], outD: days[i + 5], ret: fn(i) }); return t; };
    // ① 決定性注入:A 前半好、B 後半好 → 排程要跟著換(有落後,但要換)
    const half = Math.floor(days.length / 2);
    const A = mk(i => i < half ? 3 : -1), B = mk(i => i < half ? -1 : 3);
    const { sched } = buildSchedule({ days, rules: [{ r: 'A', trades: A }, { r: 'B', trades: B }], L: 2 });
    const ks = Object.keys(sched).sort();
    ck(sched[ks[3]] === 'A' && sched[ks[ks.length - 1]] === 'B', `① 前半選 A、後半換成 B(${sched[ks[3]]} → ${sched[ks[ks.length - 1]]})`);
    // ② 零前視:把「T 當天及以後才出場」的交易改成天大的數,排程不可以變
    const T0 = ks[10];
    const Bpeek = B.map(t => t.outD >= T0 ? { ...t, ret: 999 } : t);
    const s1 = buildSchedule({ days, rules: [{ r: 'A', trades: A }, { r: 'B', trades: B }], L: 2 }).sched;
    const s2 = buildSchedule({ days, rules: [{ r: 'A', trades: A }, { r: 'B', trades: Bpeek }], L: 2 }).sched;
    ck(ks.filter(k => k <= T0).every(k => s1[k] === s2[k]), '② 未來的交易改了,T 以前(含 T)的排程一個都不變 = 零前視');
    // ③ 決定性對照:fixed 全期同一套
    const f = buildSchedule({ days, rules: [{ r: 'A', trades: A }, { r: 'B', trades: B }], L: 2, mode: 'fixed:B' }).sched;
    ck(Object.values(f).every(v => v === 'B'), '③ MODE=fixed:B 全期都是 B');
    // ④ sham 兩套都會出現、而且跟 best 不同
    const sh = Object.values(buildSchedule({ days, rules: [{ r: 'A', trades: A }, { r: 'B', trades: B }], L: 2, mode: 'sham' }).sched);
    ck(sh.includes('A') && sh.includes('B'), '④ sham 兩套都會被隨機挑到');
    // ⑤ METRIC=day:每筆一樣賺但 C 抱 2 倍久 → day 選 D、trade 打平
    const C = []; const D = [];
    for (let i = 0; i + 10 < days.length; i++) { C.push({ inD: days[i], outD: days[i + 10], ret: 2 }); D.push({ inD: days[i], outD: days[i + 5], ret: 2 }); }
    const sd = buildSchedule({ days, rules: [{ r: 'C', trades: C }, { r: 'D', trades: D }], L: 2, metric: 'day' }).sched;
    ck(sd[ks[ks.length - 1]] === 'D', '⑤ 每筆一樣賺、抱比較短的那套每天效率較高 → METRIC=day 選它');
    // ⑦ STEP=12:一年只檢查一次 → 排程點數 = 月數 / 12(進位)
    const y = buildSchedule({ days, rules: [{ r: 'A', trades: A }, { r: 'B', trades: B }], L: 2, step: 12 }).sched;
    ck(Object.keys(y).length === Math.ceil(monthStarts(days).length / 12), `⑦ STEP=12 一年一個檢查點(${Object.keys(y).length})`);
    // ⑥ monthsBack 跨年
    ck(monthsBack('2021-02-01', 3) === '2020-11-01' && monthsBack('2021-01-15', 12) === '2020-01-15', '⑥ 往前 L 個月跨年正確');
    console.log(fails.length ? `❌ ${fails.length} 條沒過` : '✅ selftest 全過'); process.exit(fails.length ? 1 : 0);
}

const _MAIN = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (_MAIN) {
    if (process.argv.includes('--selftest')) selftest();
    const DIR = process.env.DATA_DIR; const out = process.argv[2];
    if (!DIR || !out) { console.error('🚨 要 DATA_DIR 與輸出檔'); process.exit(1); }
    const tw = JSON.parse(fs.readFileSync(path.join(DIR, '^TWII.json'), 'utf8'));
    const bars = Array.isArray(tw) ? tw : (tw.data || tw.k || []);
    const days = bars.map(b => String(b.date || b.d).replace(/\//g, '-').slice(0, 10)).filter(Boolean).sort();
    const SIGNAL = process.env.SIGNAL || 'pool';
    const src = SIGNAL === 'taken' ? process.env.TAKENS : process.env.SCHED_CACHES;
    const rules = (src || '').split(',').filter(Boolean).map(s => { const i = s.indexOf('='); const r = s.slice(0, i); const j = JSON.parse(fs.readFileSync(s.slice(i + 1), 'utf8')); return { r, trades: Array.isArray(j) ? j : j.trades }; });
    if (rules.length < 2) { console.error('🚨 至少要兩套規則'); process.exit(1); }
    const L = +(process.env.L || 12), metric = process.env.METRIC || (SIGNAL === 'taken' ? 'sum' : 'day'), mode = process.env.MODE || 'best';
    const { sched, detail } = buildSchedule({ days, rules, L, metric, mode, seed: +(process.env.SEED || 20260927), minN: SIGNAL === 'taken' ? 5 : 30, step: +(process.env.STEP || 1) });
    fs.writeFileSync(out, JSON.stringify(sched));
    const cnt = {}; for (const v of Object.values(sched)) cnt[v] = (cnt[v] || 0) + 1;
    let sw = 0; const vals = Object.values(sched); for (let i = 1; i < vals.length; i++) if (vals[i] !== vals[i - 1]) sw++;
    console.log(`🔄 SIGNAL=${SIGNAL} STEP=${process.env.STEP || 1} L=${L} METRIC=${metric} MODE=${mode}:${vals.length} 個月・換了 ${sw} 次 ・` + Object.entries(cnt).map(([r, n]) => `${r} ${n}`).join(' ・') + ` → ${out}`);
    if (process.env.DETAIL) fs.writeFileSync(process.env.DETAIL, JSON.stringify(detail));
}
