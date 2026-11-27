// 🇺🇸 premkt_ushol_probe.mjs —— 美國放假、台股有開的隔天:美股四項 + 三檔 ADR 改成只列出來(⛔ 算分),猜開盤會不會比較準?(EXP-20261127-01 事先登記)
//
// 為什麼(V82.7.1 驗收 V82.7.0 第一次凍結時查到,11/27):11/26 美國感恩節休市 → 11/27 早上的盤前分數用的還是 11/25 的美股(sp500_date = 11/25),
//   可是台股 11/26 那一盤已經反應過那天的美股 → 那斯達克 −1、費半 −1.5、台積電 ADR −2 等於算第二次。
//   App `_premktFieldAge` 只檢查亞股(對台股上一個交易日)與 ADR(對美股指數那天)的日期,沒檢查美股指數本身(V79.5.2 亞股那條是同一個道理)。
//
// 資料:
//   DUMP_OLD  premkt_app_probe.mjs 的 DUMP(HTML = 現行 index.html)
//   DUMP_NEW  同一份輸入、HTML = 改好的副本(只多一條:美股指數那天早於台股上一個交易日 → 美股四項 + 三檔 ADR 算舊、只列出來)
//   TXNIGHT   txnight.json(正式公式有夜盤 → 兩邊都加 App 那條夜盤分數,同 txnight_probe;2017-05 以前 0 分 = App 當時)
//   B0050     0050 日 K(台股交易日曆)
//   HTML      現行 index.html(夜盤分數從 App 自己的 _preOpenScore 拿,⛔ 另抄)
// H = 「分數用的那次美股收盤(dump 的 usd)早於台股上一個交易日」的日子(= 那次美股,台股已經開過一盤)。
// ⭐ 判定(EXP 寫死,⛔ 跑完再改):見 RULE 與 verdict。只用到 2026-11-06(封存日之前)。
//   ① H 那幾天「開反」次數:新 ≤ 舊 ② H 那幾天名次相關(分數 vs 0050 開盤跳空):新 ≥ 舊 ③ 全期方向猜對 / 開反變差都不超過 0.1 個百分點 → 三個都過才改 App
//   守門:H 以外的日子分數必須一分不差(否則副本改到別的東西 → 停);H 裡沒有任何一天分數不一樣 = 副本沒改到 → 停;美股日期不早於那天 = 前視 → 停。
//
// 跑法:DUMP_OLD DUMP_NEW TXNIGHT B0050 [HTML] node scripts/premkt_ushol_probe.mjs [out.json]
//       node scripts/premkt_ushol_probe.mjs --selftest
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { judge, spearman } from './premkt_app_probe.mjs';
import { alignCheck, nightMove, appNightPoints } from './txnight_probe.mjs';
import { load0050 } from './btc_tw_probe.mjs';
import { rng } from './lib_crash.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RULE = { cut: '2026-11-06', allTol: 0.1, band: 0.3 };

/** 台股交易日 → 前一個台股交易日 */
export function prevMap(TD) { const m = new Map(); for (let i = 1; i < TD.length; i++) m.set(TD[i], TD[i - 1]); return m; }
/** H:分數用的美股收盤(usd)早於台股上一個交易日的那幾天 */
export function hSet(rows, TD) {
    const pv = prevMap(TD), H = new Set();
    for (const r of rows) { const p = pv.get(r.d); if (p && r.usd && r.usd < p) H.add(r.d); }
    return H;
}
/** 正式公式 = dump 的分數 + App 那條夜盤分數(有夜盤的日子) */
export function sTot(r, NM, pts) { const o = NM && NM.get(r.d); return Math.round((r.s + (o ? (pts.get(o.nm) ?? 0) : 0)) * 10) / 10; }
/** 次數版(judge 給的是比例;判定 ① 要次數) */
export function counts(rows, sOf) {
    let up = 0, dn = 0, hit = 0, wrong = 0;
    for (const r of rows) {
        const s = sOf(r);
        if (s >= 3) { up++; if (r.gap > 0) hit++; if (r.gap < -RULE.band) wrong++; }
        else if (s <= -3) { dn++; if (r.gap < 0) hit++; if (r.gap > RULE.band) wrong++; }
    }
    return { n: rows.length, up, dn, call: up + dn, hit, wrong, rho: Math.round(spearman(rows.map(sOf), rows.map(r => r.gap)) * 1000) / 1000 };
}
const pick = j => ({ hit: Math.round(j.hit * 10) / 10, wrong: Math.round(j.wrong * 10) / 10, call: Math.round(j.call * 10) / 10, rho: Math.round(j.rho * 1000) / 1000 });

export function verdict(rowsOld, rowsNew, TD, NM, pts) {
    const cut = RULE.cut;
    const A = rowsOld.filter(r => r.d <= cut && !r.ex);
    const B = new Map(rowsNew.filter(r => r.d <= cut && !r.ex).map(r => [r.d, r]));
    const look = A.filter(r => !(r.usd && r.usd < r.d)).length;
    if (look) return { stop: `有 ${look} 天的美股日期不早於那天(前視)` };
    if (A.length !== B.size || A.some(r => !B.has(r.d))) return { stop: `兩份明細的日子對不上(舊 ${A.length} / 新 ${B.size})` };
    const H = hSet(A, TD);
    const so = r => sTot(r, NM, pts), sn = r => sTot(B.get(r.d), NM, pts);
    const diffOut = A.filter(r => !H.has(r.d) && so(r) !== sn(r));
    if (diffOut.length) return { stop: `H 以外有 ${diffOut.length} 天分數不一樣(副本改到的不只美國假日;例:${diffOut.slice(0, 3).map(r => r.d).join(' ')})` };
    const RH = A.filter(r => H.has(r.d));
    const changed = RH.filter(r => so(r) !== sn(r));
    if (!changed.length) return { stop: 'H 裡沒有任何一天分數不一樣 = 副本沒改到(⛔ 拿來判)' };
    const cO = counts(RH, so), cN = counts(RH, sn), jO = judge(A, so), jN = judge(A, sn);
    const pass = [cN.wrong <= cO.wrong, cN.rho >= cO.rho, jN.hit >= jO.hit - RULE.allTol && jN.wrong <= jO.wrong + RULE.allTol];
    // 只描述(⛔ 拿來判)
    const nonH = A.filter(r => !H.has(r.d)), yrs = {};
    for (const r of RH) yrs[r.d.slice(0, 4)] = (yrs[r.d.slice(0, 4)] || 0) + 1;
    const flip = changed.map(r => ({ d: r.d, usd: r.usd, so: so(r), sn: sn(r), gap: Math.round(r.gap * 100) / 100 }));
    const callOff = flip.filter(f => (f.so >= 3 || f.so <= -3) && f.sn > -3 && f.sn < 3);
    return {
        n: A.length, h: RH.length, changed: changed.length, old: cO, neu: cN, allOld: pick(jO), allNew: pick(jN), pass, ok: pass.every(Boolean),
        desc: { yrs, oldOnH: pick(judge(RH, so)), oldOffH: pick(judge(nonH, so)), callOff: { n: callOff.length, wrong: callOff.filter(f => (f.so >= 3 && f.gap < -RULE.band) || (f.so <= -3 && f.gap > RULE.band)).length,
                hit: callOff.filter(f => (f.so >= 3 && f.gap > 0) || (f.so <= -3 && f.gap < 0)).length }, recent: flip.slice(-12) },
    };
}

export function report(V, log = console.log) {
    if (V.stop) { log(`⛔ 停:${V.stop}`); return; }
    const f = v => Number.isFinite(v) ? v.toFixed(1) : '—', f3 = v => (v >= 0 ? '+' : '') + v.toFixed(3);
    log(`🇺🇸 美國放假、台股有開的隔天(H):2010 ~ ${RULE.cut} 共 ${V.h} 天(全部 ${V.n} 天;分數有變的 ${V.changed} 天)`);
    log(`  逐年天數:${Object.entries(V.desc.yrs).map(([y, n]) => `${y} ${n}`).join('・')}`);
    log(`  ① H 開反次數   舊 ${V.old.wrong} 次(講話 ${V.old.call} 天、方向對 ${V.old.hit})→ 新 ${V.neu.wrong} 次(講話 ${V.neu.call} 天、方向對 ${V.neu.hit}) ${V.pass[0] ? '✓' : '✗'}`);
    log(`  ② H 名次相關   舊 ${f3(V.old.rho)} → 新 ${f3(V.neu.rho)} ${V.pass[1] ? '✓' : '✗'}`);
    log(`  ③ 全期        方向猜對 ${f(V.allOld.hit)}% → ${f(V.allNew.hit)}%・開反 ${f(V.allOld.wrong)}% → ${f(V.allNew.wrong)}%(各容許 0.1)・講話 ${f(V.allOld.call)}% → ${f(V.allNew.call)}%・名次相關 ${f3(V.allOld.rho)} → ${f3(V.allNew.rho)} ${V.pass[2] ? '✓' : '✗'}`);
    log(`  → ${V.pass.map(x => x ? '✓' : '✗').join('')} ${V.ok ? '✅ 過 → 改 App' : '⛔ 沒過 → App 不動'}`);
    log('・只描述(⛔ 拿來判):');
    log(`  舊規則在 H:方向猜對 ${f(V.desc.oldOnH.hit)}% 開反 ${f(V.desc.oldOnH.wrong)}% 講話 ${f(V.desc.oldOnH.call)}%・在其他日子 ${f(V.desc.oldOffH.hit)}% / ${f(V.desc.oldOffH.wrong)}% / ${f(V.desc.oldOffH.call)}%`);
    log(`  舊規則講了、新規則改講中性的 ${V.desc.callOff.n} 天:舊的方向對 ${V.desc.callOff.hit} 天、開反 ${V.desc.callOff.wrong} 天`);
    log(`  最近幾天:${V.desc.recent.map(r => `${r.d}(美股 ${r.usd})${r.so}→${r.sn} 跳空 ${r.gap}%`).join(' ・')}`);
}

// ───────────────────────────── selftest
const addD = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
export function synth(seed, opt = {}) {
    const R = rng(seed), g = () => { let s = 0; for (let i = 0; i < 6; i++) s += R(); return s - 3; };
    const TD = []; for (let d = '2012-01-02'; d <= '2026-12-31'; d = addD(d, 1)) { const w = new Date(d + 'T00:00:00Z').getUTCDay(); if (w && w < 6) TD.push(d); }
    const hol = new Set(TD.filter((d, i) => i > 2 && i % 37 === 0));   // 「美股放假、台股有開」的那天 → 它的下一個台股交易日就是 H
    const H = new Set(); const old = [], neu = [];
    for (let i = 2; i < TD.length; i++) {
        const d = TD[i], prev = TD[i - 1];
        const usd = hol.has(prev) ? TD[i - 2] : prev;            // 前一天美國放假 → 最近一次美股收盤是再前一天
        const isH = usd < prev; if (isH) H.add(d);
        const b = Math.round(g() * 3), u = isH ? (R() < 0.5 ? -4 : 4) : 0;   // b = 兩邊都有的那一半;u = 只在 H、舊規則多算的那幾項
        const gap = 0.25 * b + (opt.momentum ? 0.4 * u : 0) + g() * 0.1;
        old.push({ d, usd, s: b + u, gap, ex: false });
        neu.push({ d, usd, s: b + (opt.same ? u : 0), gap, ex: false });
    }
    return { TD, H, old, neu };
}
async function selftest() {
    let bad = 0; const ok = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + x}`); if (!c) bad++; };
    const S = synth(7), NM = new Map(), pts = new Map();
    const H = hSet(S.old, S.TD);
    ok('① H = 「美股那天早於台股上一個交易日」那幾天(一天不多一天不少)', H.size === S.H.size && [...S.H].every(d => H.has(d)), `${H.size} vs ${S.H.size}`);
    ok('① 一般日子(美股 = 台股上一個交易日)⛔ 算進 H', S.old.filter(r => !S.H.has(r.d)).every(r => !H.has(r.d)));
    const V1 = verdict(S.old, S.neu, S.TD, NM, pts);
    ok('② 舊規則多算的那幾項跟開盤無關 → 新規則開反較少、名次相關較高 → 過', V1.ok && V1.neu.wrong < V1.old.wrong && V1.neu.rho > V1.old.rho, JSON.stringify({ o: V1.old, n: V1.neu, p: V1.pass, s: V1.stop }));
    const M = synth(7, { momentum: true }), V2 = verdict(M.old, M.neu, M.TD, NM, pts);
    ok('③ ⭐ 決定性對照:那幾項其實猜得到開盤(美股延續)→ 新規則比較差 → ⛔ 不過', !V2.ok && V2.neu.rho < V2.old.rho, JSON.stringify({ o: V2.old, n: V2.neu, p: V2.pass }));
    const Z = synth(7, { same: true }), V3 = verdict(Z.old, Z.neu, Z.TD, NM, pts);
    ok('④ 副本沒改到(H 裡分數全一樣)→ 停(⛔ 拿來判)', !!V3.stop && /沒改到/.test(V3.stop), JSON.stringify(V3).slice(0, 200));
    const X = synth(7), i0 = X.neu.findIndex(r => !X.H.has(r.d) && r.d > '2015'); X.neu[i0] = { ...X.neu[i0], s: X.neu[i0].s + 1 };
    const V4 = verdict(X.old, X.neu, X.TD, NM, pts);
    ok('⑤ H 以外有一天分數不一樣 → 停(副本改到別的東西)', !!V4.stop && /H 以外/.test(V4.stop), JSON.stringify(V4).slice(0, 200));
    const F = synth(7); F.old[5] = { ...F.old[5], usd: F.old[5].d }; const V5 = verdict(F.old, F.neu, F.TD, NM, pts);
    ok('⑥ 美股日期 = 那天(偷看)→ 停', !!V5.stop && /前視/.test(V5.stop), JSON.stringify(V5).slice(0, 200));
    const C = synth(7), V6 = verdict(C.old.map(r => r.d > RULE.cut ? r : r), C.neu.map(r => r.d > RULE.cut ? { ...r, s: 99 } : r), C.TD, NM, pts);
    ok('⑦ 封存日之後的日子 ⛔ 進判定(那幾天改成 99 分,結果不變)', V6.ok === V1.ok && V6.old.wrong === V1.old.wrong && V6.neu.wrong === V1.neu.wrong);
    const nmMap = new Map([[S.old[10].d, { nm: 1.2 }]]), p2 = new Map([[1.2, 1.5]]);
    ok('⑧ 正式公式 = dump 分數 + 夜盤分數(有夜盤的那天才加)', sTot(S.old[10], nmMap, p2) === Math.round((S.old[10].s + 1.5) * 10) / 10 && sTot(S.old[11], nmMap, p2) === S.old[11].s);
    console.log(bad ? `\n❌ ${bad} 條沒過` : '\n✅ PREMKT_USHOL_SELFTEST_PASS');
    return bad ? 1 : 0;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
    if (process.argv.includes('--selftest')) process.exit(await selftest());
    const need = k => { if (!process.env[k]) throw new Error(`${k} 沒給`); return process.env[k]; };
    const dOld = JSON.parse(fs.readFileSync(need('DUMP_OLD'), 'utf8')), dNew = JSON.parse(fs.readFileSync(need('DUMP_NEW'), 'utf8'));
    const T = JSON.parse(fs.readFileSync(need('TXNIGHT'), 'utf8'));
    const TD = load0050(need('B0050').split(',').filter(Boolean)).map(b => b.d);
    const html = fs.readFileSync(process.env.HTML || path.join(ROOT, 'index.html'), 'utf8');
    const al = alignCheck({ d: Object.fromEntries(Object.entries(T.d || {}).filter(([d]) => d <= RULE.cut)) });
    if (!al.by) { console.log('⛔ 夜盤日期歸屬判不出(同 txnight_probe)→ 停'); process.exit(1); }
    const NM = nightMove({ d: T.d }, TD.filter(d => d <= RULE.cut), al.by);
    const pts = await appNightPoints([...new Set([...NM.values()].map(o => o.nm))], html);
    const V = verdict(dOld, dNew, TD, NM, pts);
    report(V);
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify({ rule: RULE, ...V }, null, 1));
    process.exit(V.stop ? 1 : 0);
}
