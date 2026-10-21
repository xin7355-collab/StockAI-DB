#!/usr/bin/env node
/**
 * ⏱️ V79.4.9(給 V80.0.0「尾盤即時掃描」的事前誠實檢查,A5)—— 「13:20 判的」跟「收盤判的」差多少
 *
 *   node scripts/eod_partial_probe.mjs <eod_dump.ndjson> [out.json]
 *     eod_dump = portfolio_backtest.mjs `EOD_DUMP=… EOD_DUMP_SYMS=<每月名單>` 的產物:
 *       每天一行 {d, c:[[代號, 招, 排序值, n]](收盤判:今天觸發的候選,照排序), q:[[代號, 招, 排序值, n]](名單上那幾檔今天所有過門檻的招)}
 *   env:DATA_DIR(日 K,預設 repo data/)・KBAR5_DIR(kbar5_deep 的 YYYY-MM.json.gz 那個資料夾,必填)
 *       HTML_DIR(放 index.html 的資料夾,預設 repo 根目錄 —— 跑 App 自己的偵測器)・WIN(預設 1200 = App 的 K 線上限)
 *       CUT(預設 795 = 13:15 那根 5 分 K;13:20 掃描時看得到的最後一根)・RANK_MIN(85)・VOL_MIN(60)
 *       PICKS(預設 2 = 一天買幾檔)・SELFTEST=1(只跑合成資料的自我檢查)
 *
 * 問的是:尾盤掃描如果在 13:20 用「到 13:20 為止」那根 K 判,跟收盤那根判的結果差多少?
 *   ① 觸發一致率(同一檔同一招)② 🧬(位階 / 波動)與「這檔自己破 20/60 日線」一致率
 *   ③ 每天「會買的前 2 檔」一致率(照排序值,一檔只留最好那一招)
 *   ④ 成交量兩種:原始(只到 13:20)與「÷ 13:20 前通常成交的比例」(同一檔前 20 天自己的比例,⛔ 不偷看當天)
 *   ⑤ 涵蓋率:收盤判的「每天前 2 檔」有幾 % 在 kbar5_deep 那 100 檔裡(⛔ 太低就只寫限制,⛔ 不硬下結論)
 *
 * ⭐ 判法:直接呼叫 App 的 `_playbookPatternDefs`(同 list_trig.mjs / playbook_scan.mjs,⛔ 不複製偵測器);
 *    🧬 / 破線用 playbook_scan.mjs 那一段的同一條公式(位階 = 近 250 根收盤 ≤ 今天的比例、波動 = 近 20 日報酬年化、
 *    破線 = 收盤 < 20 日均 且 < 60 日均)。
 * ⚠️ 限制(要跟數字一起寫):kbar5_deep 只有「每月成交值前 100 大」(2021-05 起)→ 只量得到熱門股;
 *    冷門股的 13:20 跟收盤差得可能更多(成交稀、最後 10 分鐘一筆就改變收盤)。
 */
import { fileURLToPath, pathToFileURL } from 'url';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── 純函式(selftest 直接測)──
/** 13:20 那根:到 CUT 為止的 5 分 K 合成(開 = 第一根開、高低 = 期間最高最低、收 = 最後一根收、量 = 加總 × 1000 = 股) */
export function partialBar(bars, cut) {
    const b = (bars || []).filter(x => x[0] <= cut);
    if (!b.length) return null;
    let h = -Infinity, l = Infinity, v = 0;
    for (const x of b) { if (x[2] > h) h = x[2]; if (x[3] < l) l = x[3]; v += x[5]; }
    return { open: b[0][1], high: h, low: l, close: b[b.length - 1][4], volume: v * 1000, first: b[0][0], last: b[b.length - 1][0] };
}
/** 到 CUT 為止的量佔整天(5 分 K 加總)的比例 */
export function shareAt(bars, cut) {
    let a = 0, t = 0;
    for (const x of (bars || [])) { t += x[5]; if (x[0] <= cut) a += x[5]; }
    return t > 0 ? a / t : null;
}
/** 🧬 / 破線(= playbook_scan.mjs 那一段):rows 最後一根是「今天」 */
export function geneOf(rows, rankMin = 85, volMin = 60) {
    const last = rows.length - 1;
    if (last < 59) return null;
    const w = rows.slice(Math.max(0, last - 249), last + 1).map(r => r.close);
    const rank = Math.round(w.filter(c => c <= rows[last].close).length / w.length * 1000) / 10;
    let s2 = 0, cn = 0;
    for (let k = Math.max(1, last - 19); k <= last; k++) { const pr = (rows[k].close - rows[k - 1].close) / rows[k - 1].close; s2 += pr * pr; cn++; }
    const vol = cn >= 10 ? Math.round(Math.sqrt(s2 / cn) * Math.sqrt(252) * 1000) / 10 : null;
    let m20 = 0, m60 = 0;
    for (let k = last - 19; k <= last; k++) m20 += rows[k].close;
    for (let k = last - 59; k <= last; k++) m60 += rows[k].close;
    m20 /= 20; m60 /= 60;
    const bear = rows[last].close < m20 && rows[last].close < m60;
    return { rank, vol, bear, ok: rank >= rankMin && vol != null && vol >= volMin && !bear };
}
/** 每天會買的前 K 檔:一檔只留排序值最高那一招 → 由高到低 → 取前 K 檔 */
export function topK(cands, K) {
    const best = new Map();
    for (const [sym, key, v] of cands) { const b = best.get(sym); if (!b || v > b[1]) best.set(sym, [key, v]); }
    return [...best.entries()].sort((a, b) => (b[1][1] - a[1][1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, K).map(x => x[0]);
}

function loadSeries(p) {
    try {
        const rows = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (!Array.isArray(rows)) return null;
        const out = [];
        for (const r of rows) {
            const c = +(r.close || 0), d = String(r.date || '').replace(/\//g, '-').slice(0, 10);
            if (c > 0 && d) out.push({ date: d, open: +(r.open || c), high: +(r.high || c), low: +(r.low || c), close: c, volume: +(r.volume || 0) });
        }
        return out;
    } catch (_) { return null; }
}

function selftest() {
    let bad = 0; const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + e}`); if (!c) bad++; };
    const bars = [[540, 10, 10.5, 9.9, 10.2, 100], [545, 10.2, 10.8, 10.1, 10.7, 50], [795, 10.7, 10.9, 10.6, 10.8, 30], [800, 10.8, 11.0, 10.8, 11.0, 40], [810, 11.0, 11.0, 11.0, 11.0, 80]];
    const p = partialBar(bars, 795);
    ok('① 13:20 那根:開 = 第一根開、高低 = 到 13:20 的最高最低、收 = 13:15 那根收、量 = 加總 ×1000(張 → 股)',
       p && p.open === 10 && p.high === 10.9 && p.low === 9.9 && p.close === 10.8 && p.volume === 180000, JSON.stringify(p));
    ok('①b 🔬 對照:13:20 之後那兩根(13:20 / 13:30 收盤競價)⛔ 不算進去', p.high < 11.0 && p.close !== 11.0);
    ok('② 到 13:20 的量佔比 = 180 / 300', Math.abs(shareAt(bars, 795) - 0.6) < 1e-9);
    ok('②b 沒有 5 分 K → null(⛔ 不猜)', partialBar([], 795) === null && shareAt([], 795) === null);
    // ③ 🧬:造一條一路漲的(位階 100、波動夠)與一條一路跌的(破線)
    const up = [], dn = [];
    for (let i = 0; i < 300; i++) { const c = 100 * Math.pow(1.004, i) * (1 + (i % 2 ? 0.03 : -0.03)); up.push({ close: c }); dn.push({ close: 300 - i * 0.5 * (1 + (i % 2 ? 0.03 : -0.03)) }); }
    const gu = geneOf(up), gd = geneOf(dn);
    ok('③ 一路漲又很會跳 → 位階高、波動夠、沒破線 = 🧬', gu && gu.rank >= 85 && gu.vol >= 60 && !gu.bear && gu.ok, JSON.stringify(gu));
    ok('③b 一路跌 → 破線、⛔ 不是 🧬', gd && gd.bear && !gd.ok, JSON.stringify(gd));
    ok('④ 每天前 2 檔:一檔只留最好那一招、照排序值', JSON.stringify(topK([['A', 'x', 1], ['A', 'y', 5], ['B', 'z', 3], ['C', 'w', 4]], 2)) === '["A","C"]');
    console.log(bad ? `❌ ${bad} 條失敗` : '✅ eod_partial_probe selftest 全過');
    process.exit(bad ? 1 : 0);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
    if (process.env.SELFTEST === '1' || process.argv.includes('--selftest')) selftest();
    const [DUMP, OUT] = process.argv.slice(2);
    const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
    const K5 = process.env.KBAR5_DIR || '';
    const HTML_DIR = process.env.HTML_DIR || ROOT;
    const WIN = +(process.env.WIN || 1200), CUT = +(process.env.CUT || 795);
    const RANK_MIN = +(process.env.RANK_MIN || 85), VOL_MIN = +(process.env.VOL_MIN || 60), PICKS = +(process.env.PICKS || 2);
    if (!DUMP || !fs.existsSync(DUMP)) { console.error('用法:node scripts/eod_partial_probe.mjs <eod_dump.ndjson> [out.json](讀不到 dump)'); process.exit(1); }
    if (!K5 || !fs.existsSync(K5)) { console.error(`🚨 KBAR5_DIR=${K5} 讀不到`); process.exit(1); }
    if (!fs.existsSync(path.join(HTML_DIR, 'index.html'))) { console.error(`🚨 ${HTML_DIR} 沒有 index.html`); process.exit(1); }

    // ① 讀 dump
    const days = [];
    for (const ln of fs.readFileSync(DUMP, 'utf8').split('\n')) { if (!ln.trim()) continue; const o = JSON.parse(ln); days.push(o); }
    if (!days.length) { console.error('🚨 dump 一天都沒有'); process.exit(1); }
    const withQ = days.filter(o => Array.isArray(o.q));
    if (!withQ.length) { console.error('🚨 dump 沒有 q(要配 EOD_DUMP_SYMS 才有名單上那幾檔的招)'); process.exit(1); }

    // ② kbar5 每月檔(用到才讀)
    const monthCache = new Map();
    const monthOf = m => {
        if (monthCache.has(m)) return monthCache.get(m);
        const f = path.join(K5, `${m}.json.gz`);
        let j = null; try { j = JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString('utf8')); } catch (_) { j = null; }
        monthCache.set(m, j); return j;
    };

    // ③ 涵蓋率:收盤判的每天前 PICKS 檔,有幾 % 在那個月的 100 檔裡
    let covN = 0, covIn = 0;
    for (const o of days) {
        const M = monthOf(o.d.slice(0, 7)); const U = new Set((M && M.univ) || []);
        for (const s of topK((o.c || []).map(x => [x[0], x[1], x[2]]), PICKS)) { covN++; if (U.has(s)) covIn++; }
    }

    // ④ 要判的:每檔 → 每天 → {keys:[[key, v]], bar(13:20)}
    const per = new Map();
    let pairsDay = 0, noBar = 0;
    for (const o of withQ) {
        const M = monthOf(o.d.slice(0, 7)); const day = M && M.d && M.d[o.d];
        const g = new Map();
        for (const [s, k, v] of o.q) { const a = g.get(s) || g.set(s, []).get(s); a.push([k, v]); }
        for (const [s, keys] of g) {
            const bars = day && day.k ? day.k[s] : null;
            const bar = partialBar(bars, CUT);
            if (!bar) { noBar++; continue; }
            const m = per.get(s) || per.set(s, new Map()).get(s);
            m.set(o.d, { keys, bar, share: shareAt(bars, CUT) });
            pairsDay++;
        }
    }
    console.log(`⏱️ eod_partial_probe:${days.length} 天(有名單 ${withQ.length} 天)・要判 ${pairsDay.toLocaleString()} 個「檔 × 天」(${per.size} 檔;沒有 5 分 K ${noBar})・CUT ${Math.floor(CUT / 60)}:${String(CUT % 60).padStart(2, '0')} 那根為止`);
    console.log(`   涵蓋率:收盤判的每天前 ${PICKS} 檔,${covIn}/${covN}(${(covIn / Math.max(1, covN) * 100).toFixed(1)}%)在 kbar5_deep 那 100 檔裡`);

    let chromium;
    try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
    const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
    const page = await browser.newPage();
    page.on('pageerror', () => {});
    await page.goto(pathToFileURL(path.join(HTML_DIR, 'index.html')).href, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof app !== 'undefined' && !!app._playbookPatternDefs, null, { timeout: 25000 });

    // ⑤ 一檔一檔判(⛔ 只判「至少一邊是 🧬 且沒破線」的那幾天 —— 兩邊都不是就不會買,觸發與否無關)
    const res = [];   // {d, s, gF, gP, gS, tF:Set, tP:Set, tS:Set, keys}
    let errN = 0, nJ = 0, nSkip = 0;
    const t0 = Date.now(); let done = 0;
    for (const [sym, m] of per) {
        const rows = loadSeries(path.join(DATA, `${sym}.json`));
        if (!rows) { done++; continue; }
        const idx = new Map(rows.map((r, i) => [r.date, i]));
        const items = [];
        for (const [d, it] of m) {
            const i = idx.get(d); if (i == null || i < 120) continue;
            const full = rows.slice(Math.max(0, i - WIN + 1), i + 1);
            const prev = rows.slice(Math.max(0, i - WIN + 1), i);
            // 前 20 天自己的「13:20 前成交比例」→ 量換算成整天(⛔ 不偷看當天);沒有就用 1
            let shs = [];
            for (let k = 1; k <= 20; k++) { const d2 = rows[i - k] && rows[i - k].date; const it2 = d2 && m.get(d2); if (it2 && it2.share) shs.push(it2.share); }
            const sh = shs.length >= 5 ? shs.sort((a, b) => a - b)[Math.floor(shs.length / 2)] : null;
            const pb = { date: d, open: it.bar.open, high: it.bar.high, low: it.bar.low, close: it.bar.close, volume: it.bar.volume };
            const pbS = sh ? { ...pb, volume: Math.round(pb.volume / sh) } : null;
            const gF = geneOf(full, RANK_MIN, VOL_MIN), gP = geneOf(prev.concat([pb]), RANK_MIN, VOL_MIN);
            if (!gF || !gP) continue;
            if (!gF.ok && !gP.ok) { nSkip++; res.push({ d, s: sym, gF, gP, tF: [], tP: [], tS: [], keys: it.keys, judged: 0 }); continue; }
            items.push({ d, i, pb, pbS, keys: it.keys.map(x => x[0]), gF, gP, kv: it.keys });
        }
        if (items.length) {
            let out;
            try {
                out = await page.evaluate(a => {
                    const { rows, items, win } = a;
                    const idx = new Map(rows.map((r, i) => [r.date, i]));
                    const trig = (w, keys) => { let defs = null; try { defs = app._playbookPatternDefs(w); } catch (_) { return null; }
                        return keys.filter(k => { const p = defs.find(x => x.key === k); if (!p) return false; try { return !!p.test(w.length - 1); } catch (_) { return false; } }); };
                    return items.map(it => {
                        const i = idx.get(it.d);
                        const full = rows.slice(Math.max(0, i - win + 1), i + 1);
                        const prev = rows.slice(Math.max(0, i - win + 1), i);
                        return { tF: trig(full, it.keys), tP: trig(prev.concat([it.pb]), it.keys), tS: it.pbS ? trig(prev.concat([it.pbS]), it.keys) : null };
                    });
                }, { rows, items: items.map(x => ({ d: x.d, pb: x.pb, pbS: x.pbS, keys: x.keys })), win: WIN });
            } catch (e) { errN++; if (errN <= 5) console.error(`⚠️ ${sym}:${String(e && e.message || e).slice(0, 200)}`); out = null; }
            if (out) out.forEach((r, k) => { const it = items[k]; nJ++; res.push({ d: it.d, s: sym, gF: it.gF, gP: it.gP, tF: r.tF || [], tP: r.tP || [], tS: r.tS, keys: it.kv, judged: 1, bad: !r.tF || !r.tP }); });
        }
        done++;
        if (done % 50 === 0) console.log(`   ${done}/${per.size} 檔 ・判了 ${nJ.toLocaleString()} 個 ・${((Date.now() - t0) / 60000).toFixed(1)} 分`);
    }
    await browser.close();
    if (errN > Math.max(2, per.size * 0.01)) { console.error(`🚨 ${errN}/${per.size} 檔丟出例外 → 結果不可信`); process.exit(1); }
    if (!nJ) { console.error('🚨 一個都沒判到(日期對不上?K 線讀不到?)'); process.exit(1); }

    // ⑥ 彙整
    let kBoth = 0, kF = 0, kP = 0, kS_F = 0, kS_P = 0, kS_both = 0, gSame = 0, gN = 0;
    const byDay = new Map();
    for (const r of res) {
        gN++; if (r.gF.ok === r.gP.ok) gSame++;
        const F = new Set(r.tF), P = new Set(r.tP), Sx = r.tS ? new Set(r.tS) : null;
        for (const [k] of r.keys) {
            const a = F.has(k), b = P.has(k);
            if (a && b) kBoth++; else if (a) kF++; else if (b) kP++;
            if (Sx) { const c = Sx.has(k); if (a && c) kS_both++; else if (a) kS_F++; else if (c) kS_P++; }
        }
        const o = byDay.get(r.d) || byDay.set(r.d, { F: [], P: [], S: [] }).get(r.d);
        const vOf = new Map(r.keys);
        if (r.gF.ok) for (const k of F) o.F.push([r.s, k, vOf.get(k)]);
        if (r.gP.ok) for (const k of P) o.P.push([r.s, k, vOf.get(k)]);
        if (r.gP.ok && Sx) for (const k of Sx) o.S.push([r.s, k, vOf.get(k)]);
    }
    let dN = 0, dSame = 0, dSameS = 0, slots = 0, slotSame = 0, slotSameS = 0, firstSame = 0;
    for (const [, o] of byDay) {
        const tf = topK(o.F, PICKS), tp = topK(o.P, PICKS), ts = topK(o.S, PICKS);
        if (!tf.length && !tp.length) continue;
        dN++;
        if (JSON.stringify([...tf].sort()) === JSON.stringify([...tp].sort())) dSame++;
        if (JSON.stringify([...tf].sort()) === JSON.stringify([...ts].sort())) dSameS++;
        if (tf[0] && tf[0] === tp[0]) firstSame++;
        for (const s of tf) { slots++; if (tp.includes(s)) slotSame++; if (ts.includes(s)) slotSameS++; }
    }
    const pc = (a, b) => b ? +(a / b * 100).toFixed(1) : null;
    const summary = {
        asof: new Date().toISOString().slice(0, 10), cut: CUT, win: WIN, picks: PICKS,
        coverage: { top: covN, inKbar5: covIn, pct: pc(covIn, covN) },
        judged: { pairs: nJ, skipped: nSkip, noBar, errN },
        gene: { n: gN, same: gSame, pct: pc(gSame, gN) },
        trig: { both: kBoth, onlyClose: kF, only1320: kP, agreePct: pc(kBoth, kBoth + kF + kP) },
        trigScaledVol: { both: kS_both, onlyClose: kS_F, only1320: kS_P, agreePct: pc(kS_both, kS_both + kS_F + kS_P) },
        days: { n: dN, top2Same: dSame, top2SamePct: pc(dSame, dN), firstSamePct: pc(firstSame, dN), slotSamePct: pc(slotSame, slots), top2SameScaledPct: pc(dSameS, dN), slotSameScaledPct: pc(slotSameS, slots) },
    };
    console.log(JSON.stringify(summary, null, 1));
    if (OUT) fs.writeFileSync(OUT, JSON.stringify(summary, null, 1));
}
