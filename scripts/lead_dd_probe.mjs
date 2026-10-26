#!/usr/bin/env node
/**
 * 🛡️ V79.9.1 👑 領頭羊「中途最多賠」能不能少一點、而且賺的不變少?(使用者 10/26)
 *
 * 判準(使用者選的):**4 年(2022-09-16 起)和 16 年(2011-01-03 起)都要**
 *   ① 回撤中位變小 ② 100 萬變多少中位 ≥ 現在 ③ 17 條起點配對贏 ≥13(賺的)—— 三件都過才叫「兩全」;
 *   只過一半的列成「取捨」(少賠幾 %、少賺幾萬)給使用者挑。
 *
 * 跟看板同一把尺:DATA_DIR=<d16> DIV=<d16>/_div16.json END=2026-09-24、capital 100 萬、17 條起點(間距 3)、種子 1000+k
 *   → 現在那一列的中位要**逐元重現**看板的數字(決定性對照:對不上 exit 1)
 *
 * 兩類做法:
 *   A. 引擎變體(真的重跑 simulate):兩本帳錯開 3~7 天、先衝再穩(門檻 1.5/2/3/4 × 換成三成/五成放 0050)
 *   B. 帳戶分兩桶(⭐ 真實帳戶做得到:一部分照 👑 做、其餘放 0050,規則只決定兩桶比例):
 *      dd    = 👑 那一桶從最高點跌 X% → 只留 lo 在 👑;回到自己 N 日均線之上(或創新高)→ 恢復全部
 *      vt    = 👑 那一桶最近 N 天年化波動 > 目標 → 比例 = 目標 ÷ 波動(下限 lo),每 10 天調一次
 *      trend = 👑 那一桶在自己 N 日均線之上 → 全部,之下 → lo(每 5 天看一次)
 *      mkt   = 0050 含息在 N 日均線之上 → 全部,之下 → lo(對照組:看大盤不看自己)
 *      fix   = 永遠 w 在 👑(每 10 天調回)= 已知的「報酬換回撤」那條線,當參考
 *      ⛔ 只用到當天收盤為止的資料決定,**隔天收盤**才調(慢一天,保守);調整要付手續費 + 證交稅(股票 0.3%、0050 0.1%)
 *      🎲 安慰劑:同一條比例序列整段平移(6 種位移)再跑一次 —— 規則要贏它才算「時機對」,不然只是「少放一點錢」
 *
 * 用法:DATA_DIR=<d16> DIV=<d16>/_div16.json END=2026-09-24 node --max-old-space-size=12000 scripts/lead_dd_probe.mjs out.json
 *       node scripts/lead_dd_probe.mjs --selftest
 *   可選:ONLY=A|B(只跑一類)、SETS_A / RULES_B(JSON 覆寫)、SLEEVE(分兩桶時 👑 那一桶用哪種做法,例 {"books":2,"bookOff":3})
 */
import fs from 'fs';
import path from 'path';

const FEE = 0.001425, TAX = 0.003, ETF_TAX = 0.001, STEP = 3, PATHS = 17;
const median = a => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); if (!b.length) return NaN; const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const r2 = x => Math.round(x * 100) / 100;
const mddOf = eq => { let pk = -Infinity, m = 0; for (const v of eq) { pk = Math.max(pk, v); m = Math.min(m, v / pk - 1); } return m * 100; };

/** 規則 → 第 t 天收盤後想要的 👑 比例(⛔ 只看 eq[0..t]、tr[0..t])。st = 規則自己的狀態(呼叫端每條路徑給一份新的) */
export function wantAt(rule, eq, tr, t, st) {
    const ma = (a, N) => { if (t + 1 < N) return NaN; let s = 0; for (let j = t - N + 1; j <= t; j++) s += a[j]; return s / N; };
    switch (rule.k) {
        case 'full': return 1;
        case 'fix': return t % 10 === 0 ? rule.w : null;
        case 'dd': {
            st.pk = Math.max(st.pk ?? -Infinity, eq[t]);
            if (!st.def) { if (eq[t] / st.pk - 1 <= -rule.X / 100) st.def = true; }
            else {
                const back = rule.rec === 'hi' ? eq[t] >= st.pk : eq[t] > ma(eq, rule.rec === 'ma20' ? 20 : 60);
                if (back) st.def = false;
            }
            return st.def ? rule.lo : 1;
        }
        case 'vt': {
            if (t % 10 !== 0) return null;
            if (t < rule.N) return 1;
            let s = 0, s2 = 0; for (let j = t - rule.N + 1; j <= t; j++) { const r = Math.log(eq[j] / eq[j - 1]); s += r; s2 += r * r; }
            const m = s / rule.N, sd = Math.sqrt(Math.max(0, s2 / rule.N - m * m)) * Math.sqrt(244);
            const w = sd > 0 ? Math.min(1, Math.max(rule.lo, rule.tgt / 100 / sd)) : 1;
            return Math.round(w * 10) / 10;
        }
        case 'trend': { if (t % 5 !== 0) return null; const m = ma(eq, rule.N); return Number.isFinite(m) && eq[t] < m ? rule.lo : 1; }
        case 'mkt': { if (t % 5 !== 0) return null; const m = ma(tr, rule.N); return Number.isFinite(m) && tr[t] < m ? rule.lo : 1; }
        default: throw new Error('認不得的規則 ' + rule.k);
    }
}

/** 兩桶帳戶:eq = 👑 那一桶(全部錢照 👑)的淨值、tr = 0050 含息;sched = 預先給好的比例序列(安慰劑用)
 *  回 {acct, w}:acct = 帳戶淨值(第 0 天 = eq[0])、w = 每一天收盤後實際的 👑 比例 */
export function overlay(eq, tr, rule, sched = null) {
    const n = eq.length, acct = new Array(n), wArr = new Array(n);
    let A = eq[0], B = 0, cur = 1, pend = null;
    const st = {};
    acct[0] = A; wArr[0] = 1;
    for (let t = 1; t < n; t++) {
        A *= eq[t] / eq[t - 1]; B *= tr[t] / tr[t - 1];
        if (pend != null) {                                              // 前一天決定 → 今天收盤調
            const V = A + B, tgtA = pend * V, d = tgtA - A;
            if (d < 0) { const mv = -d, c = mv * (FEE + TAX) + mv * FEE; A = tgtA; B = V - tgtA - c; }
            else if (d > 0) { const c = d * (FEE + ETF_TAX) + d * FEE; A = tgtA; B = V - tgtA - c; }
            pend = null;
        }
        const w = sched ? sched[t] : wantAt(rule, eq, tr, t, st);
        if (w != null && Math.abs(w - cur) >= 0.05) { pend = w; cur = w; }
        acct[t] = A + B; wArr[t] = cur;
    }
    return { acct, w: wArr };
}

const shiftSched = (w, off) => { const n = w.length, out = new Array(n); for (let t = 0; t < n; t++) out[t] = w[(t + off) % n]; out[0] = 1; return out; };

/** 一個做法在一個窗口:17 條的 {fin[], mdd[]} → 中位 / 最差 / 配對 */
function summarize(rows, base) {
    const fin = rows.map(r => r.fin), mdd = rows.map(r => r.mdd);
    const o = { fin: r2(median(fin) / 1e4), worst: r2(Math.min(...fin) / 1e4), mdd: r2(median(mdd)), mddW: r2(Math.min(...mdd)) };
    if (base) { o.winFin = rows.filter((r, k) => r.fin > base[k].fin).length; o.winMdd = rows.filter((r, k) => r.mdd > base[k].mdd).length; }
    if (rows[0].low != null) o.low = r2(median(rows.map(r => r.low)));
    return o;
}

function selftest() {
    let ok = 0, bad = 0; const t = (c, m) => { console.log(`  ${c ? '✅' : '❌'} ${m}`); c ? ok++ : bad++; };
    const n = 400, eq = [], tr = [];
    for (let i = 0; i < n; i++) { eq.push(100 * Math.pow(1.002, i) * (i > 200 && i < 260 ? 0.6 : 1)); tr.push(50 * Math.pow(1.0004, i)); }
    const f = overlay(eq, tr, { k: 'full' });
    t(f.acct.every((v, i) => Math.abs(v - eq[i]) < 1e-9), '① 永遠全部在 👑 → 帳戶 == 👑 那一桶(一分不差、不付任何費用)');
    const z = overlay(eq, tr, { k: 'fix', w: 0 });
    const want0 = eq[11] * (1 - 2 * FEE - TAX) * tr[n - 1] / tr[11];   // 第 10 天收盤決定(每 10 天看一次)、第 11 天收盤整桶換到 0050
    t(Math.abs(z.acct[n - 1] - want0) < 1e-6 && Math.abs(z.acct[10] - eq[10]) < 1e-9, `② 永遠 0 → 第 11 天收盤換成 0050 之後跟著 0050 走、只付一次賣股票 + 買 0050 的錢(${z.acct[n - 1].toFixed(4)} == ${want0.toFixed(4)})`);
    // ③ ⛔ 前視:改掉第 t 天之後的淨值,第 t 天以前的比例序列一模一樣
    const eq2 = eq.slice(); for (let i = 300; i < n; i++) eq2[i] *= 0.5;
    for (const rule of [{ k: 'dd', X: 20, lo: 0.5, rec: 'ma60' }, { k: 'vt', tgt: 30, N: 20, lo: 0.3 }, { k: 'trend', N: 60, lo: 0.5 }]) {
        const a = overlay(eq, tr, rule).w, b = overlay(eq2, tr, rule).w;
        t(a.slice(0, 300).every((v, i) => v === b[i]), `③ ${rule.k}:改掉第 300 天之後的淨值 → 前 300 天的比例一模一樣(⛔ 偷看未來)`);
    }
    // ④ 回撤剎車:第 201 天跌 40% → 第 201 天收盤決定、第 202 天起只剩 lo;回到 60 日均線之上 → 恢復
    const d = overlay(eq, tr, { k: 'dd', X: 20, lo: 0.5, rec: 'ma60' }).w;
    t(d[200] === 1 && d[201] === 0.5 && d[n - 1] === 1, `④ 回撤剎車:跌 40% 那天之後只留五成、漲回均線之上恢復全部(${d[200]} → ${d[201]} → ${d[n - 1]})`);
    // ⑤ 決定性對照:同一份比例序列當成 sched 再跑一次 == 規則跑出來的帳戶
    const rr = overlay(eq, tr, { k: 'dd', X: 20, lo: 0.5, rec: 'ma60' }), rs = overlay(eq, tr, null, rr.w);
    t(rs.acct.every((v, i) => Math.abs(v - rr.acct[i]) < 1e-9), '⑤ 把規則跑出來的比例當成排程重放 == 原本(安慰劑用的重放器沒有走樣)');
    // ⑥ 波動控管:平穩那段 = 全部、暴跌那段波動大 → 比例降下來
    const v = overlay(eq, tr, { k: 'vt', tgt: 30, N: 20, lo: 0.3 }).w;
    t(v[150] === 1 && Math.min(...v.slice(205, 240)) < 1, `⑥ 波動控管:平穩時全部(${v[150]})、暴跌之後降到 ${Math.min(...v.slice(205, 240))}`);
    // ⑦ 位移安慰劑:位移後比例的平均一樣(只換時機,⛔ 換份量)
    const sh = shiftSched(rr.w, 137), avg = a => a.slice(1).reduce((p, q) => p + q, 0) / (a.length - 1);
    t(Math.abs(avg(sh) - avg(rr.w)) < 0.01, `⑦ 位移安慰劑:平均放在 👑 的比例一樣(${avg(rr.w).toFixed(3)} vs ${avg(sh).toFixed(3)})`);
    console.log(`\n${bad ? '❌' : '✅'} selftest ${ok}/${ok + bad}`);
    return bad ? 1 : 0;
}

async function main() {
    const out = process.argv[2], DATA = process.env.DATA_DIR, DIV = process.env.DIV;
    if (!DATA || !out) { console.error('用法:DATA_DIR=… DIV=… END=2026-09-24 node scripts/lead_dd_probe.mjs out.json'); process.exit(1); }
    const { loadCtx, simulate } = await import('./leader_probe.mjs');
    const t0 = Date.now(), ctx = loadCtx(DATA, DIV);
    console.log(`📂 ${ctx.meta.stocks} 檔・${ctx.cal[0]}~${ctx.cal.at(-1)}・0050 股利 ${ctx.meta.d50} 筆`);
    if (ctx.meta.stocks < 1000 || ctx.meta.d50 < 10) { console.error('🚨 資料不夠(檔數 < 1000 或 0050 股利 < 10),拒跑'); process.exit(1); }
    const WINS = (process.env.WINS || '2022-09-16,2011-01-03').split(',');
    const SETS_A = JSON.parse(process.env.SETS_A || 'null') || [
        ['books2_off3', { books: 2, bookOff: 3 }], ['books2_off4', { books: 2, bookOff: 4 }], ['books2_off5', { books: 2, bookOff: 5 }],
        ['books2_off6', { books: 2, bookOff: 6 }], ['books2_off7', { books: 2, bookOff: 7 }],
        ...[1.5, 2, 3, 4].flatMap(g => [0.3, 0.5].map(c => [`glide${g}_c${c}`, { glide: g, glideCore: c }])),
    ];
    const RULES_B = JSON.parse(process.env.RULES_B || 'null') || [
        ...[10, 15, 20, 25, 30].flatMap(X => [0.3, 0.5].flatMap(lo => ['ma20', 'ma60', 'hi'].map(rec => ({ k: 'dd', X, lo, rec })))),
        ...[20, 25, 30, 35, 40].flatMap(tgt => [20, 60].map(N => ({ k: 'vt', tgt, N, lo: 0.3 }))),
        ...[20, 60, 120].flatMap(N => [0, 0.5].map(lo => ({ k: 'trend', N, lo }))),
        ...[60, 120, 200].map(N => ({ k: 'mkt', N, lo: 0.5 })),
        ...[0.7, 0.5].map(w => ({ k: 'fix', w })),
    ];
    const name = r => r.k === 'dd' ? `dd${r.X}_lo${r.lo}_${r.rec}` : r.k === 'vt' ? `vt${r.tgt}_N${r.N}` : r.k === 'trend' ? `trend${r.N}_lo${r.lo}` : r.k === 'mkt' ? `mkt${r.N}` : `fix${r.w}`;
    const res = { asof: new Date().toISOString().slice(0, 10), data_to: ctx.cal.at(-1), wins: {}, sets: {}, rules: {} };
    for (const w of WINS) {
        const s0 = ctx.cal.findIndex(d => d >= w);
        const run = cfg => Array.from({ length: PATHS }, (_, k) => { const s = s0 + STEP * k, r = simulate(ctx, s, { ...cfg, capital: 1e6 }, 1000 + k); return { eq: r.eq, tr: Array.from(ctx.etf.tr.slice(s, s + r.eq.length)) }; });
        // SLEEVE = 分兩桶時 👑 那一桶用哪一種做法(預設 = 現在;例 {"books":2,"bookOff":3} = 疊在兩本帳上);比較基準永遠是「現在」
        const SLV = JSON.parse(process.env.SLEEVE || 'null');
        const t1 = Date.now(), B00 = run({}), B0 = SLV ? run(SLV) : B00;
        const base = B00.map(p => ({ fin: p.eq.at(-1), mdd: mddOf(p.eq) }));
        res.wins[w] = { base: summarize(base) };
        // 🎯 決定性對照:END 跟看板同一天 → 「現在」那一列的中位要跟看板 👑 全攻逐元相同(對不上 = 尺不同,⛔ 往下比)
        try {
            const pro = fs.readFileSync(new URL('../pro.html', import.meta.url), 'utf8'), a = pro.indexOf('_PROFIT_BOARD: {'), b = pro.indexOf('\n', a);
            const PB = JSON.parse(pro.slice(a + 15, b).trim().replace(/,$/, '')), win = Object.values(PB.wins).find(x => x.from === w), row = win && win.rows.find(x => x.k === 'lead');
            if (row && PB.to === (process.env.END || '')) {
                const me = Math.round(median(base.map(x => x.fin)));
                if (Math.abs(me - row.fin) > 1) { console.error(`🚨 [${w}] 現在 ${me} ≠ 看板 ${row.fin} → 尺不同,拒跑`); process.exit(1); }
                console.log(`🎯 [${w}] 現在 == 看板 👑 全攻(${row.fin.toLocaleString()} 元)`);
            } else console.log(`⚠️ [${w}] END(${process.env.END || '沒設'})跟看板(${PB.to})不同 → 不比對`);
        } catch (e) { console.log('⚠️ 讀不到看板,不比對:' + e.message); }
        console.log(`\n[${w}] 👑 現在:100 萬 → ${res.wins[w].base.fin} 萬(最差 ${res.wins[w].base.worst})・回撤中位 ${res.wins[w].base.mdd}%(最差 ${res.wins[w].base.mddW}%)・${((Date.now() - t1) / 1000).toFixed(0)}s`);
        if (process.env.ONLY !== 'B') for (const [nm, cfg] of SETS_A) {
            const t2 = Date.now(), rows = run(cfg).map(p => ({ fin: p.eq.at(-1), mdd: mddOf(p.eq) }));
            const S = summarize(rows, base); (res.sets[nm] ||= {})[w] = S;
            console.log(`[${w}] A ${nm}:${S.fin} 萬(最差 ${S.worst})・回撤 ${S.mdd}%(最差 ${S.mddW})・17 條賺得比較多 ${S.winFin}・回撤比較小 ${S.winMdd} ・${((Date.now() - t2) / 1000).toFixed(0)}s`);
        }
        if (process.env.ONLY !== 'A') for (const rule of RULES_B) {
            const nm = name(rule), rows = [], plc = [];
            for (let k = 0; k < PATHS; k++) {
                const o = overlay(B0[k].eq, B0[k].tr, rule);
                rows.push({ fin: o.acct.at(-1), mdd: mddOf(o.acct), low: o.w.filter(x => x < 1).length / o.w.length * 100 });
                if (!['fix', 'full'].includes(rule.k)) for (let j = 1; j <= 6; j++) {
                    const sh = shiftSched(o.w, Math.floor(o.w.length * j / 7)), p = overlay(B0[k].eq, B0[k].tr, null, sh);
                    plc.push({ fin: p.acct.at(-1), mdd: mddOf(p.acct) });
                }
            }
            const S = summarize(rows, base);
            if (plc.length) { S.plcFin = r2(median(plc.map(x => x.fin)) / 1e4); S.plcMdd = r2(median(plc.map(x => x.mdd))); }
            (res.rules[nm] ||= { rule })[w] = S;
            console.log(`[${w}] B ${nm}:${S.fin} 萬・回撤 ${S.mdd}%・配對賺 ${S.winFin} 少賠 ${S.winMdd} ・不在 👑 的日子 ${S.low}%` + (S.plcFin != null ? ` ・🎲 安慰劑 ${S.plcFin} 萬 / ${S.plcMdd}%` : ''));
        }
    }
    // ⚖️ 判定:兩段都(回撤中位變小 + 中位賺 ≥ 現在 + 配對賺 ≥13)= 兩全;只有少賠 = 取捨
    const judge = obj => {
        for (const [nm, v] of Object.entries(obj)) {
            const ws = WINS.map(w => v[w]).filter(Boolean); if (ws.length < WINS.length) continue;
            const both = WINS.every(w => v[w].mdd > res.wins[w].base.mdd && v[w].fin >= res.wins[w].base.fin && v[w].winFin >= 13);
            const lessDD = WINS.every(w => v[w].mdd > res.wins[w].base.mdd + 1);
            const plcOk = WINS.every(w => v[w].plcFin == null || (v[w].fin > v[w].plcFin && v[w].mdd >= v[w].plcMdd));
            v.verdict = both ? (plcOk ? 'both' : 'both_noplc') : lessDD ? 'tradeoff' : 'no';
        }
    };
    judge(res.sets); judge(res.rules);
    const show = obj => Object.entries(obj).filter(([, v]) => v.verdict === 'both' || v.verdict === 'both_noplc');
    console.log(`\n⚖️ 兩全(兩段都少賠 + 不少賺 + 配對 ≥13):引擎 ${show(res.sets).map(([k]) => k).join('、') || '沒有'} ・分兩桶 ${show(res.rules).map(([k, v]) => k + (v.verdict === 'both_noplc' ? '(⚠️ 沒贏安慰劑)' : '')).join('、') || '沒有'}`);
    fs.writeFileSync(out, JSON.stringify(res));
    console.log(`💾 ${out} ・⏱️ ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

const _isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (_isMain && process.argv.includes('--selftest')) process.exit(selftest());
else if (_isMain) main();
