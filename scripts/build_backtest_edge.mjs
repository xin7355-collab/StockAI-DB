#!/usr/bin/env node
/**
 * 🔁 V77.3.5 每週自動回測的產物 `data/backtest_edge.json`(給 `.github/workflows/weekly_backtest.yml` 用)
 *
 * 吃三份輸入,合成一份「成績單 + 跟嵌入版差在哪」:
 *   ① data/signal_edge.json          ← scripts/signal_backtest.mjs(129 個 K 線訊號,~17 分)
 *   ② SUMMARY_GENE / SUMMARY_PLAIN  ← scripts/portfolio_backtest.mjs SUMMARY_OUT=(決策台那套 49 個月)
 *   ③ index.html 的 `_SIGNAL_EDGE` / `_SIGNAL_EDGE_META` / `_DECK_TRACK49`(嵌入版 = 目前 App 在用的成績)
 *   + 上一版 data/backtest_edge.json(從 data 分支還原)當空過守門的基準
 *
 * ⛔ 三條不可改:
 *   ① **只標示不換預設**:等級變動(A↔C)、成績單勝率差 >5pp 都寫進 `diff`,⛔ 不改 App 常數(V75.0.9 五條件由人判)
 *   ② **空過守門**:訊號總 n 或成績單筆數 < 上一版(或嵌入版)的 80% → exit 1、不寫檔(資料不完整就不推)
 *   ③ **產物格式跟嵌入版一模一樣**(signal.table 的 value 就是 `_SIGNAL_EDGE` 那 8 欄)→ App `_sigEdge` 可以直接換讀
 *
 * 用法:SUMMARY_GENE=/tmp/g.json [SUMMARY_PLAIN=/tmp/p.json] [PREV=data/backtest_edge.json] node scripts/build_backtest_edge.mjs [out]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

/** 從 index.html 抓嵌入版常數(同 embed_signal_edge 的做法:兩行都是單獨一行) */
export function readEmbedded(html) {
    const lines = html.split('\n');
    const grab = (prefix) => { const l = lines.find(x => x.trimStart().startsWith(prefix)); if (!l) return null; try { return JSON.parse(l.trim().replace(new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*'), '').replace(/,$/, '')); } catch (_) { return null; } };
    const table = grab('_SIGNAL_EDGE:'), meta = grab('_SIGNAL_EDGE_META:');
    const dm = /_DECK_TRACK49:\s*\{\s*months:\s*(\d+),\s*from:\s*'([^']+)',\s*to:\s*'([^']+)'[\s\S]{0,400}?gene:\s*(\d+),\s*geneDD:\s*([\d.]+),\s*plain:\s*(\d+),\s*plainDD:\s*([\d.]+)/.exec(html);
    const deck = dm ? { months: +dm[1], from: dm[2], to: dm[3], gene: +dm[4], geneDD: +dm[5], plain: +dm[6], plainDD: +dm[7] } : null;
    return { table, meta, deck };
}

/** 把 signal_edge.json 轉成跟 `_SIGNAL_EDGE` 一模一樣的表(⛔ 同 embed_signal_edge 的 8 欄) */
export function signalTable(j) {
    const table = {};
    for (const s of (j.signals || [])) { if (!s.key) throw new Error('訊號缺 key'); table[s.key] = [s.grade, s.n, s.e10, s.w10, s.p, s.e20, s.payoff == null ? null : s.payoff, s.exp == null ? null : s.exp]; }
    return table;
}

export function build({ sig, gene, plain = null, embedded, prev = null, now = new Date() }) {
    const table = signalTable(sig);
    const keys = Object.keys(table);
    if (!keys.length) throw new Error('signal_edge 沒有訊號');
    const nSig = keys.reduce((s, k) => s + (+table[k][1] || 0), 0);
    const cnt = { A: 0, B: 0, C: 0 }; for (const k of keys) cnt[table[k][0]] = (cnt[table[k][0]] || 0) + 1;
    // 空過守門:跟上一版(沒有就跟嵌入版)比 80%
    const baseSigN = prev && prev.signal ? prev.signal.n : (embedded.table ? Object.values(embedded.table).reduce((s, v) => s + (+v[1] || 0), 0) : 0);
    const baseDeckN = prev && prev.deck && prev.deck.gene ? prev.deck.gene.n : null;
    const errs = [];
    if (baseSigN && nSig < baseSigN * 0.8) errs.push(`訊號總樣本 ${nSig.toLocaleString()} < 基準 ${baseSigN.toLocaleString()} 的 80%`);
    if (!gene || !(gene.n > 0)) errs.push('成績單(🧬)沒有筆數');
    else if (baseDeckN && gene.n < baseDeckN * 0.8) errs.push(`成績單筆數 ${gene.n} < 上一版 ${baseDeckN} 的 80%`);
    if (errs.length) { const e = new Error('空過守門:' + errs.join(';')); e.gate = true; throw e; }
    // diff(⛔ 只標示):訊號等級 A↔C 跳兩級、或 A/B ↔ C;成績單勝率差 >5pp、累積差 >30%
    const diff = [];
    if (embedded.table) {
        for (const k of keys) {
            const o = embedded.table[k]; if (!o) { diff.push({ k, what: 'new_signal', old: null, new: table[k][0] }); continue; }
            const g0 = o[0], g1 = table[k][0];
            if (g0 !== g1 && (g0 === 'C' || g1 === 'C')) diff.push({ k, what: 'grade', old: g0, new: g1, e10: [o[2], table[k][2]] });
        }
        for (const k of Object.keys(embedded.table)) if (!table[k]) diff.push({ k, what: 'gone', old: embedded.table[k][0], new: null });
    }
    if (embedded.deck && gene) {
        const winOld = null;   // 嵌入版沒存勝率 → 比累積與回撤
        if (Math.abs(gene.cum - embedded.deck.gene) / Math.max(1, Math.abs(embedded.deck.gene)) > 0.30) diff.push({ k: 'deck.gene', what: 'cum', old: embedded.deck.gene, new: gene.cum });
        if (Math.abs(Math.abs(gene.dd) - embedded.deck.geneDD) > 5) diff.push({ k: 'deck.geneDD', what: 'dd', old: embedded.deck.geneDD, new: Math.abs(gene.dd) });
        void winOld;
    }
    if (prev && prev.deck && prev.deck.gene && gene && Math.abs(gene.win - prev.deck.gene.win) > 5) diff.push({ k: 'deck.win', what: 'win_vs_prev', old: prev.deck.gene.win, new: gene.win });
    return {
        run_at: now.toISOString().slice(0, 10), kind: 'weekly',
        signal: { table, n: nSig, grades: cnt, syms: sig.syms, base_win: sig.base && sig.base.win ? sig.base.win['10'] : null, window: sig.window || null },
        deck: { gene, plain },
        embedded: { sigA: embedded.meta ? embedded.meta.A : null, sigB: embedded.meta ? embedded.meta.B : null, sigC: embedded.meta ? embedded.meta.C : null,
                    sigN: baseSigN || null, deck: embedded.deck },
        diff, prev: prev ? { run_at: prev.run_at } : null,
        note: '⛔ 只標示不換預設:等級或成績有變一律寫在 diff,App 的預設要換得過 V75.0.9 那五個條件(由人判)',
    };
}

if (isMain) {
    const out = process.argv[2] || path.join(ROOT, 'data', 'backtest_edge.json');
    const sig = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'signal_edge.json'), 'utf8'));
    const gene = process.env.SUMMARY_GENE ? JSON.parse(fs.readFileSync(process.env.SUMMARY_GENE, 'utf8')) : null;
    const plain = process.env.SUMMARY_PLAIN && fs.existsSync(process.env.SUMMARY_PLAIN) ? JSON.parse(fs.readFileSync(process.env.SUMMARY_PLAIN, 'utf8')) : null;
    const prevP = process.env.PREV || out;
    const prev = fs.existsSync(prevP) ? (() => { try { return JSON.parse(fs.readFileSync(prevP, 'utf8')); } catch (_) { return null; } })() : null;
    const embedded = readEmbedded(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'));
    if (!embedded.table || !embedded.deck) { console.error('🚨 index.html 讀不到嵌入版 _SIGNAL_EDGE / _DECK_TRACK49 → 停'); process.exit(1); }
    let r;
    try { r = build({ sig, gene, plain, embedded, prev }); } catch (e) { console.error(`❌ ${e.message}${e.gate ? '(⛔ 不寫檔、不推)' : ''}`); process.exit(1); }
    fs.writeFileSync(out, JSON.stringify(r));
    console.log(`✅ backtest_edge.json:訊號 ${Object.keys(r.signal.table).length} 個(A=${r.signal.grades.A} B=${r.signal.grades.B} C=${r.signal.grades.C},n=${r.signal.n.toLocaleString()})・成績單 🧬 ${gene.n} 筆 / 勝率 ${gene.win}% / 累積 ${gene.cum.toLocaleString()} / 回撤 ${gene.dd}%${plain ? ` ・不挑 🧬 ${plain.cum.toLocaleString()}` : ''}`);
    console.log(`   跟嵌入版的差異 ${r.diff.length} 項${r.diff.length ? ':' + r.diff.slice(0, 8).map(d => `${d.k}(${d.what} ${d.old}→${d.new})`).join(' / ') : ''}`);
    console.log('   ⛔ 只標示不換預設');
}
