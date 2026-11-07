#!/usr/bin/env node
/**
 * ✂️ V82.0.7 👑「跌 20% 收一半」—— 全站唯一一份判斷(使用者 11/07 選「做成開關並幫我打開」)
 *
 * 規則:看「完全照 👑 這套做」的那一份帳(⛔ 不是使用者自己的帳戶 —— App / 自動下單都沒有那條歷史淨值)
 *   ・從它的最高點跌 ≥ th%(20)→ 進入「一半」(lo = 0.5)
 *   ・已經在一半、而且回到最高點(創新高)→ 恢復全部
 *   ・⛔ 只用到當天收盤為止的淨值(selftest ② 前視)
 *
 * 誰在用(⛔ 不可各寫一份):
 *   ・scripts/leader_probe.mjs  ddHalf 參數(回測:換倉日才收 / 才補)
 *   ・scripts/lead_dd_probe.mjs 'dd' 'hi' 規則(兩桶回測,改成呼叫 ddStep —— 逐位相同)
 *   ・scripts/lead_dd_state.mjs 每晚寫 data/lead_dd.json(App / 自動下單 / Telegram 只讀那一份)
 *
 * 用法:node scripts/lib_leaddd.mjs --selftest
 */
import path from 'path';

/** 上線的規則(⛔ 改任何一個數字都要重跑 scripts/lead_ddhalf_gate.mjs)
 *   from = 每晚那條模型帳的起點(固定寫死:網站上的個股 K 線 2023-06 起,一年位置要 252 根暖身 → 2024-07 起才算得準;
 *          ⛔ 每晚「最早那天 + 暖身」會讓整條帳每天重算成不同的路徑)
 *   live = 第一次真的照這條規則做的換倉決策日(這一天以前的換倉一律當成「全部做」—— 那時候還沒有這個開關) */
export const LEAD_DD = Object.freeze({ th: 20, lo: 0.5, rec: 'hi', top: 1, from: '2024-07-01', live: '2026-11-12' });
/** 模型帳的引擎設定(= 回測過關那一組的「全攻」那一趟:看板 👑 規則 + 跌停賣不掉隔天再賣) */
export const LEAD_DD_MODEL = Object.freeze({ capital: 1e6, ldLock: 1 });

const KEYS = ['th', 'lo', 'rec', 'at', 'top', 'shift', 'src', '_w'];

/** 檢查並補齊規則;打錯字 / 範圍不對一律 throw(⛔ 打錯字安靜地變成「不收」= 看起來沒差的假結論) */
export function ddRule(o = {}) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('ddHalf 要是物件');
    for (const k of Object.keys(o)) if (!KEYS.includes(k)) throw new Error(`ddHalf 認不得的欄位 ${k}`);
    const r = { th: LEAD_DD.th, lo: LEAD_DD.lo, rec: LEAD_DD.rec, at: 'reb', top: LEAD_DD.top, shift: 0, src: '', ...o };
    if (!(Number.isFinite(r.th) && r.th > 0 && r.th < 100)) throw new Error(`ddHalf.th 要在 0~100 之間(不含),收到 ${r.th}`);
    if (!(Number.isFinite(r.lo) && r.lo > 0 && r.lo < 1)) throw new Error(`ddHalf.lo 要在 0~1 之間(不含),收到 ${r.lo}`);
    if (r.rec !== 'hi') throw new Error(`ddHalf.rec 只認 'hi'(回到最高點)—— 只有這一種驗過,收到 ${JSON.stringify(r.rec)}`);
    if (!['reb', 'next'].includes(r.at)) throw new Error(`ddHalf.at 只認 'reb'(換倉日才收)/ 'next'(隔天就收),收到 ${JSON.stringify(r.at)}`);
    if (![0, 1].includes(r.top)) throw new Error(`ddHalf.top 只認 0 / 1(回到最高點時手上的要不要補回),收到 ${JSON.stringify(r.top)}`);
    if (!(Number.isInteger(r.shift) && r.shift >= 0 && r.shift <= 6)) throw new Error(`ddHalf.shift 只認 0~6(安慰劑:狀態整段平移 len×k/7),收到 ${JSON.stringify(r.shift)}`);
    if (!['', 'park'].includes(r.src)) throw new Error(`ddHalf.src 只認 '' / 'park'(狀態看哪一條帳),收到 ${JSON.stringify(r.src)}`);
    return r;
}

/** 一天:st = {pk, def}(呼叫端每條路徑給一份新的);回這一天收盤後「想要」的比例(1 或 lo)
 *  ⭐ 跟 lead_dd_probe 舊版 wantAt 'dd' 'hi' 一字不差(selftest ①) */
export function ddStep(st, v, rule) {
    st.pk = Math.max(st.pk ?? -Infinity, v);
    if (!st.def) { if (v / st.pk - 1 <= -rule.th / 100) st.def = true; }
    else if (v >= st.pk) st.def = false;
    return st.def ? rule.lo : 1;
}

/** 整條淨值 → 每一天的 {w 想要的比例, def 是否在一半, pk 到這天為止的最高點, dd 離最高點(小數)} */
export function ddSeries(eq, rule) {
    const R = { th: rule.th ?? LEAD_DD.th, lo: rule.lo ?? LEAD_DD.lo };
    const n = eq.length, w = new Float64Array(n), def = new Uint8Array(n), pk = new Float64Array(n), dd = new Float64Array(n);
    const st = {};
    for (let t = 0; t < n; t++) {
        w[t] = ddStep(st, eq[t], R); def[t] = st.def ? 1 : 0; pk[t] = st.pk; dd[t] = eq[t] / st.pk - 1;
    }
    return { w, def, pk, dd };
}

/** 🎲 安慰劑:比例序列整段循環平移 off 天(= lead_dd_probe.shiftSched;第 0 天固定 1) */
export function shiftSched(w, off) {
    const n = w.length, out = new Float64Array(n);
    for (let t = 0; t < n; t++) out[t] = w[(t + off) % n];
    if (n) out[0] = 1;
    return out;
}

/** 每一次換倉「實際用的」比例(每本帳各算各的;rots 照日期排好):
 *   d < live → 1(那時候還沒有這個開關)・想要的 < 現在 → 收(空頭也照收)・想要的 > 現在 → top=0 直接恢復;top=1 空頭那天不補、等下一次換倉 */
export function waChain(rots, rule, live = LEAD_DD.live) {
    const cur = new Map(), top = (rule && rule.top != null) ? rule.top : LEAD_DD.top;
    return rots.map(r => {
        let wa = cur.has(r.b) ? cur.get(r.b) : 1;
        if (!(r.d >= live)) wa = 1;
        else if (r.W < wa) wa = r.W;
        else if (r.W > wa && (!top || !r.bear)) wa = r.W;
        cur.set(r.b, wa);
        return { ...r, wa };
    });
}

function selftest() {
    let ok = 0, bad = 0; const t = (c, m) => { console.log(`  ${c ? '✅' : '❌'} ${m}`); c ? ok++ : bad++; };
    // ① 跟舊版 wantAt 'dd' 'hi'(凍結一份)逐日一樣:幾條固定種子的亂走
    const oldDD = (rule, eq, tt, st) => {
        st.pk = Math.max(st.pk ?? -Infinity, eq[tt]);
        if (!st.def) { if (eq[tt] / st.pk - 1 <= -rule.X / 100) st.def = true; }
        else { const back = eq[tt] >= st.pk; if (back) st.def = false; }
        return st.def ? rule.lo : 1;
    };
    let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    let same = true, trig = 0;
    for (let k = 0; k < 6; k++) {
        const eq = [100]; for (let i = 1; i < 800; i++) eq.push(eq[i - 1] * (1 + (rnd() - 0.5) * 0.06));
        for (const X of [10, 20, 30]) {
            const s1 = {}, s2 = {};
            for (let i = 1; i < eq.length; i++) {
                const a = oldDD({ X, lo: 0.5 }, eq, i, s1), b = ddStep(s2, eq[i], { th: X, lo: 0.5 });
                if (a !== b) same = false; if (a < 1) trig++;
            }
        }
    }
    t(same && trig > 50, `① 跟 lead_dd_probe 舊版 'dd' 'hi' 一字不差(6 條亂走 × 3 個門檻,一半的日子 ${trig} 天)`);
    // ② ⛔ 前視:改掉第 300 天之後的淨值 → 前 300 天的狀態一模一樣
    const eq = [100]; seed = 11; for (let i = 1; i < 600; i++) eq.push(eq[i - 1] * (1 + (rnd() - 0.5) * 0.08));
    const eq2 = eq.slice(); for (let i = 300; i < eq2.length; i++) eq2[i] *= 0.3;
    const A = ddSeries(eq, LEAD_DD), B = ddSeries(eq2, LEAD_DD);
    t(Array.from(A.w.slice(0, 300)).every((v, i) => v === B.w[i]) && Array.from(A.def.slice(0, 300)).every((v, i) => v === B.def[i]), '② ⛔ 前視:改掉第 300 天之後的淨值,前 300 天的狀態一模一樣');
    // ③ 門檻邊界:最高 100 → 79.99(−20.01%)進一半;80.01(−19.99%)不進
    const b1 = ddSeries([100, 90, 79.99], LEAD_DD), b2 = ddSeries([100, 90, 80.01], LEAD_DD);
    t(b1.def[2] === 1 && b2.def[2] === 0 && b1.w[2] === 0.5 && b2.w[2] === 1, '③ 門檻:−20.01% 進一半、−19.99% 不進');
    // ④ 恢復:回到最高點那天才恢復(差一點點不算);恢復後再跌 20% 又進一半(用新的最高點)
    const c = ddSeries([100, 75, 99.99, 100, 130, 104.1, 103.9], LEAD_DD);
    t(Array.from(c.def).join('') === '0110001' && c.pk[6] === 130, `④ 回到最高點那天才恢復(99.99 還是一半、100 恢復)、新高 130 之後跌到 103.9(−20.08%)再進一半(${Array.from(c.def).join('')})`);
    // ⑤ 安慰劑平移:第 0 天 = 1、平均比例一樣(只換時機、⛔ 換份量)
    const sh = shiftSched(A.w, 137), avg = a => Array.from(a).slice(1).reduce((p, q) => p + q, 0) / (a.length - 1);
    t(sh[0] === 1 && Math.abs(avg(sh) - avg(A.w)) < 0.01 && Array.from(sh).some((v, i) => v !== A.w[i]), '⑤ 安慰劑平移:第 0 天 = 1、平均比例一樣、真的有換時機');
    // ⑥ waChain:live 以前 = 1;收;空頭時 top=1 不補(等下一次)、top=0 直接恢復;兩本帳各算各的
    const rots = [
        { d: '2026-10-29', b: 'A', W: 0.5, bear: 0 },   // live 以前 → 1
        { d: '2026-11-12', b: 'A', W: 0.5, bear: 0 },   // 收 → 0.5
        { d: '2026-11-16', b: 'B', W: 0.5, bear: 0 },   // 另一本帳自己收
        { d: '2026-11-26', b: 'A', W: 1, bear: 1 },     // 回到最高點但空頭 → top=1 不補
        { d: '2026-12-10', b: 'A', W: 1, bear: 0 },     // 空頭結束 → 補
    ];
    const w1 = waChain(rots, { top: 1 }, '2026-11-12').map(x => x.wa), w0 = waChain(rots, { top: 0 }, '2026-11-12').map(x => x.wa);
    t(w1.join(',') === '1,0.5,0.5,0.5,1' && w0.join(',') === '1,0.5,0.5,1,1', `⑥ 每次換倉實際用的比例:top=1 ${w1.join(',')}(空頭那次不補)・top=0 ${w0.join(',')}`);
    // ⑦ 打錯字 / 範圍不對一律 throw
    const bads = [{ rec: 'ma60' }, { at: 'x' }, { top: 2 }, { th: 0 }, { lo: 1.2 }, { thr: 20 }, { shift: 9 }, { src: 'cash' }];
    let thrown = 0; for (const b of bads) { try { ddRule(b); } catch (_) { thrown++; } }
    const d0 = ddRule({});
    t(thrown === bads.length && d0.th === 20 && d0.lo === 0.5 && d0.at === 'reb' && d0.top === LEAD_DD.top, `⑦ 打錯字 throw(${thrown}/${bads.length})、不給 = 上線的那一組(20% / 一半 / 換倉日)`);
    console.log(`\n${bad ? '❌' : '✅'} lib_leaddd selftest ${ok}/${ok + bad}`);
    return bad ? 1 : 0;
}

const _isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (_isMain && process.argv.includes('--selftest')) process.exit(selftest());
