#!/usr/bin/env node
/**
 * 🧾 V82.2.9 名單層濾網疊到現行策略的判定(EXP-20261113-03:申報轉讓那天起 20 個交易日先不買)
 *
 * 讀兩個引擎吐出來的逐日淨值(同一種格式 {rows:[{d, cash, park, mv}]}):
 *   🔥 portfolio_backtest EQUITY_OUT='…/eq_{W}.json'(W = 起點)・👑 leader_probe EQ_DIR(eq_0 ~ eq_16)
 * 判定條件照登記寫死(⛔ 跑完再改;改了要重新登記):
 *   ① 16 年 17 條起點:濾網最後的錢 > 現行 ≥ 13 條(同一個起點配對)
 *   ② 16 年 17 條中位數最後的錢:濾網 > 每一組安慰劑(同一份事件日期整份配給別檔)
 *   ③ 16 年 17 條中位數最大回撤:濾網 ≥ 現行 − 2 個百分點(⛔ 更深超過 2pp)
 *   ④ 近 4 年 17 條中位數最後的錢:濾網 ≥ 現行
 * 另外寫(只描述、⛔ 影響判定):近 4 年配對、2011~2018 / 2019~ 兩段配對、逐筆多賺少賺(🔥 TAKEN_OUT)拿掉影響最大 3 筆。
 *
 * 用法:
 *   node scripts/ccwin_overlay_probe.mjs eq <逐日淨值目錄> <out.json>         一組 → finals / mdd / 兩段(要 17 條)
 *   node scripts/ccwin_overlay_probe.mjs verdict <目錄> [out.json]              目錄裡要有 BASE16 FILT16 S1_16 S2_16 S3_16 BASE4 FILT4 .json
 *   node scripts/ccwin_overlay_probe.mjs tail <現行 TAKEN 目錄> <濾網 TAKEN 目錄>  🔥 逐筆:只有一邊有的成交 → 差在哪幾筆
 *   node scripts/ccwin_overlay_probe.mjs panic <組目錄>...                        😱 恐慌賣(EXP-20261119-02):每組 eq16/sum_*.json + taken16/ → 賣幾天幾筆、鎖跌停延後、每筆「開盤賣 − 照規則賣」
 *   node scripts/ccwin_overlay_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';

export const RULE = { minWins: 13, mddTol: 2, shams: 3, paths: 17, splitYear: '2019' };
const med = a => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); if (!b.length) return null; const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const r2 = x => x == null || !isFinite(x) ? null : Math.round(x * 100) / 100;

/** 一條淨值 → 最後 ÷ 一開始、最大回撤(%,負數)、兩段(切在 splitYear 第一天之前)各自的倍數 */
export function pathStats(rows, splitYear = RULE.splitYear) {
    const R = (rows || []).filter(r => r && r.d);
    const eq = R.map(r => (+r.cash || 0) + (+r.park || 0) + (+r.mv || 0));
    if (!eq.length || !(eq[0] > 0)) return null;
    let peak = -Infinity, mdd = 0;
    for (const v of eq) { peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1); }
    const d = R.map(r => String(r.d).replace(/\//g, '-'));
    const cut = d.findIndex(x => x >= `${splitYear}-01-01`);   // 第一個在 splitYear 的交易日
    const seg = cut > 0 ? { a: eq[cut - 1] / eq[0], b: eq[eq.length - 1] / eq[cut - 1] } : null;
    return { fin: eq[eq.length - 1] / eq[0], mdd: mdd * 100, seg, from: d[0], to: d[d.length - 1] };
}

/** 一個目錄裡的 eq_*.json → {paths, finals:{鍵: 倍數}, mdd:{鍵: %}, seg:{鍵: {a, b}}} */
export function eqDir(dir) {
    const files = fs.readdirSync(dir).filter(f => /^eq_\d+\.json$/.test(f)).sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]);
    const finals = {}, mdd = {}, seg = {};
    let from = null, to = null;
    for (const f of files) {
        const k = f.match(/^eq_(\d+)\.json$/)[1];
        const s = pathStats(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).rows);
        if (!s) continue;
        finals[k] = s.fin; mdd[k] = s.mdd; if (s.seg) seg[k] = s.seg;
        from = from && from < s.from ? from : s.from; to = to && to > s.to ? to : s.to;
    }
    return { paths: Object.keys(finals).length, finals, mdd, seg, from, to };
}

/** 配對:同一個起點(鍵)兩邊都有才算 */
const paired = (A, B, f = x => x) => Object.keys(A).filter(k => k in B).map(k => [f(A[k]), f(B[k])]);

/** 照登記的四條判定 → {pass, c:{c1..c4}, 數字} */
export function verdict(G) {
    for (const k of ['BASE16', 'FILT16', 'BASE4', 'FILT4']) if (!G[k] || !G[k].paths) throw new Error(`少了 ${k}`);
    const shams = ['S1_16', 'S2_16', 'S3_16'].filter(k => G[k] && G[k].paths);
    if (shams.length < RULE.shams) throw new Error(`安慰劑只有 ${shams.length} 組(要 ${RULE.shams})`);
    for (const k of ['BASE16', 'FILT16', 'BASE4', 'FILT4', ...shams]) if (G[k].paths !== RULE.paths) throw new Error(`${k} 只有 ${G[k].paths} 條(要 ${RULE.paths})`);
    const p16 = paired(G.FILT16.finals, G.BASE16.finals), p4 = paired(G.FILT4.finals, G.BASE4.finals);
    const wins16 = p16.filter(([f, b]) => f > b).length, wins4 = p4.filter(([f, b]) => f > b).length;
    const mF = med(Object.values(G.FILT16.finals)), mB = med(Object.values(G.BASE16.finals));
    const mS = shams.map(k => med(Object.values(G[k].finals)));
    const ddF = med(Object.values(G.FILT16.mdd)), ddB = med(Object.values(G.BASE16.mdd));
    const m4F = med(Object.values(G.FILT4.finals)), m4B = med(Object.values(G.BASE4.finals));
    const c = {
        c1: wins16 >= RULE.minWins,
        c2: mS.every(s => mF > s),
        c3: ddF >= ddB - RULE.mddTol,
        c4: m4F >= m4B,
    };
    // 只描述:兩段配對(16 年那組;2011~2018 / 2019~)
    const sa = paired(G.FILT16.seg, G.BASE16.seg, s => s.a), sb = paired(G.FILT16.seg, G.BASE16.seg, s => s.b);
    const desc = { segA: sa.filter(([f, b]) => f > b).length, segB: sb.filter(([f, b]) => f > b).length, segN: sa.length,
                   segAmed: r2((med(sa.map(([f]) => f)) - med(sa.map(([, b]) => b))) * 100), segBmed: r2((med(sb.map(([f]) => f)) - med(sb.map(([, b]) => b))) * 100) };
    return { pass: Object.values(c).every(Boolean), c, wins16, wins4,
        fin16: { filt: r2((mF - 1) * 100), base: r2((mB - 1) * 100), shams: mS.map(s => r2((s - 1) * 100)) },   // 中位數總報酬 %
        mdd16: { filt: r2(ddF), base: r2(ddB) }, fin4: { filt: r2((m4F - 1) * 100), base: r2((m4B - 1) * 100) },
        range16: [G.BASE16.from, G.BASE16.to], range4: [G.BASE4.from, G.BASE4.to], desc };
}

/** 😱 EXP-20261119-02 恐慌賣:一個起點的 TAKEN_OUT 裡被提早賣掉的那幾筆(有 pan 欄)→ 每筆「開盤賣 − 照規則賣」(含息,%)
 *  u = (pan.ret + pan.dv) −(ret + dv);平均 / 中位數 / 比照規則差的筆數 / 拿掉往同方向推最大的 k 筆後的平均(同 tailOf 的拿法)/ 兩段 */
export function panicOf(rows, k = 3, splitYear = RULE.splitYear) {
    const P = (rows || []).filter(t => t && t.pan).map(t => ({ d: String(t.pan.d), u: ((+t.pan.ret || 0) + (+t.pan.dv || 0)) - ((+t.ret || 0) + (+t.dv || 0)) }));
    const n = P.length;
    if (!n) return { n: 0 };
    const us = P.map(x => x.u), sum = us.reduce((s, x) => s + x, 0), sgn = Math.sign(sum);
    const rest = us.slice().sort((x, y) => sgn >= 0 ? y - x : x - y).slice(k);
    const restSum = rest.reduce((s, x) => s + x, 0);
    const mOf = a => a.length ? r2(a.reduce((s, x) => s + x.u, 0) / a.length) : null;
    const A = P.filter(x => x.d < splitYear), B = P.filter(x => x.d >= splitYear);
    return { n, days: new Set(P.map(x => x.d)).size, mean: r2(sum / n), med: r2(med(us)), worse: us.filter(x => x < 0).length,
             restMean: rest.length ? r2(restSum / rest.length) : null, holds: sum !== 0 && rest.length > 0 && Math.sign(restSum) === sgn,
             a: { n: A.length, mean: mOf(A) }, b: { n: B.length, mean: mOf(B) } };
}

/** 🔥 逐筆:每個起點只有一邊有的成交(代號 + 進場日)→ 報酬加總差多少、拿掉影響最大 3 筆後同號嗎 */
export function tailOf(baseRows, filtRows, k = 3) {
    const key = t => `${t.sym}|${t.d}`;
    const B = new Map(baseRows.map(t => [key(t), t])), F = new Map(filtRows.map(t => [key(t), t]));
    const onlyB = baseRows.filter(t => !F.has(key(t))), onlyF = filtRows.filter(t => !B.has(key(t)));
    const contrib = [...onlyF.map(t => +t.ret || 0), ...onlyB.map(t => -(+t.ret || 0))];   // 濾網那邊多出來的 − 現行那邊被拿掉的
    const diff = contrib.reduce((s, x) => s + x, 0);
    const sgn = Math.sign(diff);
    const rest = contrib.slice().sort((x, y) => sgn >= 0 ? y - x : x - y).slice(k).reduce((s, x) => s + x, 0);   // 拿掉往同方向推最大的 k 筆
    return { onlyBase: onlyB.length, onlyFilt: onlyF.length, diff: r2(diff), rest: r2(rest), holds: diff === 0 ? false : Math.sign(rest) === sgn };
}

// ───────────────────────── selftest ─────────────────────────
function selftest() {
    let bad = 0;
    const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + e}`); if (!c) bad++; };
    // ① pathStats:手算得出來的一條
    const rows = [['2018-12-27', 100], ['2018-12-28', 120], ['2019-01-02', 90], ['2019-01-03', 150]].map(([d, v]) => ({ d, cash: v, park: 0, mv: 0 }));
    const s = pathStats(rows);
    ok('① 最後 ÷ 一開始 = 1.5、最大回撤 = 90 / 120 − 1 = −25%', Math.abs(s.fin - 1.5) < 1e-9 && Math.abs(s.mdd + 25) < 1e-9, JSON.stringify(s));
    ok('① 兩段切在 2019 第一天之前:前段 120/100 = 1.2、後段 150/120 = 1.25', Math.abs(s.seg.a - 1.2) < 1e-9 && Math.abs(s.seg.b - 1.25) < 1e-9, JSON.stringify(s.seg));
    ok('① cash + park + mv 加起來才是淨值', Math.abs(pathStats([{ d: '2020-01-02', cash: 50, park: 30, mv: 20 }, { d: '2020-01-03', cash: 60, park: 30, mv: 30 }]).fin - 1.2) < 1e-9);
    // 合成一組(17 條):base 倍數 2.0 + k×0.01;mdd −30
    const mk = (f, dd = -30, n = 17) => ({ paths: n, finals: Object.fromEntries(Array.from({ length: n }, (_, k) => [String(k), f(k)])),
        mdd: Object.fromEntries(Array.from({ length: n }, (_, k) => [String(k), dd])), seg: {}, from: '2011-01-03', to: '2026-11-11' });
    const base = mk(k => 2 + k * 0.01);
    const G = { BASE16: base, FILT16: mk(k => 2.1 + k * 0.01), S1_16: mk(k => 2 + k * 0.01), S2_16: mk(k => 1.99 + k * 0.01), S3_16: mk(k => 2.02 + k * 0.01),
                BASE4: mk(k => 1.5), FILT4: mk(k => 1.52) };
    const V = verdict(G);
    ok('② 濾網每條都多 0.1、贏三組安慰劑、回撤一樣、近 4 年也多 → 過', V.pass && V.wins16 === 17, JSON.stringify(V.c));
    // ③ 決定性對照:只把一組安慰劑改成比濾網好 → ② 那條不過
    const V2 = verdict({ ...G, S2_16: mk(k => 2.2 + k * 0.01) });
    ok('③ 決定性對照:一組安慰劑比濾網好 → c2 不過、整體不過', !V2.c.c2 && !V2.pass && V2.c.c1, JSON.stringify(V2.c));
    // ④ 只贏 12 條 → c1 不過
    const V3 = verdict({ ...G, FILT16: mk(k => (k < 12 ? 2.1 : 1.9) + k * 0.01) });
    ok('④ 只贏 12 條 → c1 不過(13 條才算)', V3.wins16 === 12 && !V3.c.c1 && !V3.pass);
    const V3b = verdict({ ...G, FILT16: mk(k => (k < 13 ? 2.1 : 1.9) + k * 0.01) });
    ok('④ 贏 13 條 → c1 過(邊界)', V3b.wins16 === 13 && V3b.c.c1);
    // ⑤ 回撤深 2.5pp → c3 不過;深 2pp → 過(邊界)
    ok('⑤ 回撤比現行深 2.5pp → c3 不過', !verdict({ ...G, FILT16: mk(k => 2.1 + k * 0.01, -32.5) }).c.c3);
    ok('⑤ 回撤比現行深 2.0pp → c3 過(邊界)', verdict({ ...G, FILT16: mk(k => 2.1 + k * 0.01, -32) }).c.c3);
    // ⑥ 近 4 年少一點 → c4 不過
    ok('⑥ 近 4 年濾網比較少 → c4 不過', !verdict({ ...G, FILT4: mk(k => 1.49) }).c.c4);
    // ⑦ 空過守門:少一組安慰劑 / 只有 16 條 → 丟例外(⛔ 照算)
    let thr = 0; try { verdict({ ...G, S3_16: undefined }); } catch (_) { thr++; }
    try { verdict({ ...G, FILT16: mk(k => 2.1, -30, 16) }); } catch (_) { thr++; }
    ok('⑦ 少一組安慰劑 / 只有 16 條 → ⛔ 判(丟例外)', thr === 2);
    // ⑧ tailOf:濾網多一筆 +30%、少一筆 −10%(= 被擋掉的那筆是賠的)→ 差 +40;拿掉最大 1 筆(+30)後剩 +10 同號;拿掉 2 筆 → 0 → 不同號
    const bR = [{ sym: 'A', d: '2020-01-02', ret: 5 }, { sym: 'B', d: '2020-01-03', ret: -10 }];
    const fR = [{ sym: 'A', d: '2020-01-02', ret: 5 }, { sym: 'C', d: '2020-01-03', ret: 30 }];
    const T1 = tailOf(bR, fR, 1), T2 = tailOf(bR, fR, 2);
    ok('⑧ 逐筆:兩邊都有的不算、差 = +30 −(−10)= +40;拿掉最大 1 筆還 +10(同號)、拿掉 2 筆 0(不算同號)',
        T1.onlyBase === 1 && T1.onlyFilt === 1 && T1.diff === 40 && T1.rest === 10 && T1.holds && !T2.holds, JSON.stringify([T1, T2]));
    // ⑩ panicOf:A 照規則 +10 → 開盤賣 +2(u −8)・B −5 + 息 1 → −2(u +2)・C +3 → +1 + 息 0.5(u −1.5)・D 沒被提早賣 ⛔ 算
    const pR = [{ ret: 10, dv: 0, pan: { d: '2015-08-24', ret: 2, dv: 0 } }, { ret: -5, dv: 1, pan: { d: '2020-03-12', ret: -2, dv: 0 } },
                { ret: 3, dv: 0, pan: { d: '2020-03-12', ret: 1, dv: 0.5 } }, { ret: 4, dv: 0 }];
    const Q = panicOf(pR, 1);
    ok('⑩ 恐慌賣逐筆:3 筆、2 天、平均 −2.5、中位數 −1.5、比照規則差 2 筆、2011~2018 −8(1 筆)、2019~ +0.25(2 筆)',
        Q.n === 3 && Q.days === 2 && Q.mean === -2.5 && Q.med === -1.5 && Q.worse === 2 && Q.a.n === 1 && Q.a.mean === -8 && Q.b.n === 2 && Q.b.mean === 0.25, JSON.stringify(Q));
    ok('⑩ 決定性對照:拿掉往同方向推最大的 1 筆(−8)→ 剩 −1.5 + 2 = +0.5、平均 +0.25 → 翻號(⛔ 算同號)', Q.restMean === 0.25 && !Q.holds, JSON.stringify(Q));
    ok('⑩ 沒有任何一筆被提早賣 → n = 0(⛔ 當成平均 0)', panicOf([{ ret: 4, dv: 0 }]).n === 0 && panicOf([]).n === 0);
    // ⑨ eqDir 讀真的檔(暫存目錄),鍵 = 檔名數字、照數字排序
    const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'ccov_'));
    try {
        for (const [k, v] of [[251, 2], [254, 3], [1000, 4]]) fs.writeFileSync(path.join(tmp, `eq_${k}.json`), JSON.stringify({ rows: [{ d: '2011-01-03', cash: 1e6, park: 0, mv: 0 }, { d: '2026-11-11', cash: v * 1e6, park: 0, mv: 0 }] }));
        fs.writeFileSync(path.join(tmp, 'sum_251.json'), '{}');
        const E = eqDir(tmp);
        ok('⑨ eqDir:只讀 eq_數字.json、3 條、倍數對', E.paths === 3 && E.finals['251'] === 2 && E.finals['1000'] === 4 && E.from === '2011-01-03', JSON.stringify(E.finals));
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    console.log(bad ? `\n❌ ${bad} 條沒過` : '\n✅ 全部通過');
    return bad ? 1 : 0;
}

const _isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (_isMain) {
    const [cmd, a, b] = process.argv.slice(2);
    if (cmd === '--selftest') process.exit(selftest());
    if (cmd === 'eq') {
        const E = eqDir(a);
        if (E.paths !== RULE.paths) { console.error(`🚨 ${a} 只有 ${E.paths} 條(要 ${RULE.paths})→ ⛔ 寫`); process.exit(1); }
        fs.writeFileSync(b, JSON.stringify(E));
        console.log(`✅ ${a}:${E.paths} 條 ${E.from} ~ ${E.to} ・中位數總報酬 ${r2((med(Object.values(E.finals)) - 1) * 100)}% ・中位數最大回撤 ${r2(med(Object.values(E.mdd)))}%`);
    } else if (cmd === 'verdict') {
        const rd = k => { const f = path.join(a, `${k}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; };
        const G = Object.fromEntries(['BASE16', 'FILT16', 'S1_16', 'S2_16', 'S3_16', 'BASE4', 'FILT4'].map(k => [k, rd(k)]));
        const V = verdict(G);
        const yn = x => x ? '✅' : '❌';
        console.log(`16 年(${V.range16.join(' ~ ')}):① 17 條贏 ${V.wins16} ${yn(V.c.c1)} ・② 中位數總報酬 濾網 ${V.fin16.filt}% vs 安慰劑 ${V.fin16.shams.join(' / ')}%(現行 ${V.fin16.base}%)${yn(V.c.c2)} ・③ 中位數回撤 ${V.mdd16.filt}% vs 現行 ${V.mdd16.base}% ${yn(V.c.c3)}`);
        console.log(`近 4 年(${V.range4.join(' ~ ')}):④ 中位數總報酬 濾網 ${V.fin4.filt}% vs 現行 ${V.fin4.base}% ${yn(V.c.c4)}(只描述:17 條贏 ${V.wins4})`);
        console.log(`只描述:2011~2018 配對贏 ${V.desc.segA}/${V.desc.segN}(中位數差 ${V.desc.segAmed}pp)・2019~ 配對贏 ${V.desc.segB}/${V.desc.segN}(${V.desc.segBmed}pp)`);
        console.log(`⇒ ${V.pass ? '✅ 全部過' : '❌ 沒過'}`);
        if (b) fs.writeFileSync(b, JSON.stringify(V, null, 1));
    } else if (cmd === 'tail') {
        const ks = fs.readdirSync(a).filter(f => /^taken_\d+\.json$/.test(f)).filter(f => fs.existsSync(path.join(b, f))).sort();
        if (!ks.length) { console.error('🚨 兩邊沒有同名的 taken_*.json'); process.exit(1); }
        const T = ks.map(f => ({ k: f, ...tailOf(JSON.parse(fs.readFileSync(path.join(a, f), 'utf8')), JSON.parse(fs.readFileSync(path.join(b, f), 'utf8'))) }));
        for (const t of T) console.log(`${t.k}:只有現行 ${t.onlyBase} 筆・只有濾網 ${t.onlyFilt} 筆 ・報酬加總差 ${t.diff} ・拿掉最大 3 筆 ${t.rest} ${t.holds ? '同號' : '⚠️ 翻號 / 0'}`);
        console.log(`⇒ ${T.length} 個起點裡拿掉最大 3 筆還同號 ${T.filter(t => t.holds).length} 個`);
    } else if (cmd === 'panic') {
        // 😱 每一組(INS / S1 / S2 / S3)的 eq16/sum_*.json(引擎 summary.panic)+ taken16/taken_*.json(逐筆 pan)→ 17 條取中位數、不一樣就印範圍
        const dirs = process.argv.slice(3);
        if (!dirs.length) { console.error('🚨 panic 要給至少一個組的目錄(裡面有 eq16/ 與 taken16/)'); process.exit(1); }
        const rg = a => { const b = a.filter(Number.isFinite); if (!b.length) return '—'; const lo = Math.min(...b), hi = Math.max(...b), m = r2(med(b)); return lo === hi ? `${m}` : `${m}(${r2(lo)}~${r2(hi)})`; };
        let shown = 0;
        for (const g of dirs) {
            const tk = path.join(g, 'taken16'), eq = path.join(g, 'eq16');
            if (!fs.existsSync(tk)) { console.log(`${path.basename(g)}:沒有 taken16/(這一組沒有逐筆)`); continue; }
            const fs16 = fs.readdirSync(tk).filter(f => /^taken_\d+\.json$/.test(f)).sort();
            const P = fs16.map(f => {
                const w = f.match(/\d+/)[0], q = panicOf(JSON.parse(fs.readFileSync(path.join(tk, f), 'utf8')));
                const sf = path.join(eq, `sum_${w}.json`);
                const s = fs.existsSync(sf) ? (JSON.parse(fs.readFileSync(sf, 'utf8')).panic || null) : null;
                return { ...q, eDays: s ? s.days : null, lock: s ? s.lock : null, stuck: s ? s.stuck : null };
            });
            const col = k => P.map(p => p[k]), sub = (k, j) => P.map(p => p[k] ? p[k][j] : null);
            if (!P.some(p => p.n > 0)) { console.log(`${path.basename(g)}:${P.length} 條、一筆都沒有被提早賣(⛔ 當成 0)`); continue; }
            shown++;
            console.log(`${path.basename(g)}(${P.length} 條,中位數・範圍):開盤要賣 ${rg(col('eDays'))} 天 ・賣掉 ${rg(col('n'))} 筆(${rg(col('days'))} 天)・鎖跌停延後 ${rg(col('lock'))} 次 ・停牌延後 ${rg(col('stuck'))} 次`
                + ` ・「開盤賣 − 照規則賣」每筆平均 ${rg(col('mean'))}%、中位數 ${rg(col('med'))}% ・比照規則差 ${rg(col('worse'))} 筆`
                + ` ・拿掉往同方向推最大 3 筆後平均 ${rg(col('restMean'))}%(${P.filter(p => p.holds).length}/${P.length} 條同號)`
                + ` ・2011~2018 ${rg(sub('a', 'mean'))}%(${rg(sub('a', 'n'))} 筆)・2019~ ${rg(sub('b', 'mean'))}%(${rg(sub('b', 'n'))} 筆)`);
        }
        if (!shown) { console.error('🚨 每一組都沒有被提早賣的成交 → 沒生效(⛔ 當成「沒差別」)'); process.exit(1); }
    } else { console.error('用法見檔頭'); process.exit(1); }
}
