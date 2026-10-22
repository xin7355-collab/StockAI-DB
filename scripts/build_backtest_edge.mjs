#!/usr/bin/env node
/**
 * 🔁 V77.3.5 每週自動回測的產物 `data/backtest_edge.json`(給 `.github/workflows/weekly_backtest.yml` 用)
 *
 * 吃三份輸入,合成一份「成績單 + 跟嵌入版差在哪」:
 *   ① data/signal_edge.json          ← scripts/signal_backtest.mjs(129 個 K 線訊號,~17 分)
 *   ② SUMMARY_GENE / SUMMARY_CASH   ← scripts/portfolio_backtest.mjs SUMMARY_OUT=(🅿️ 現行預設 / 💵 錢放現金;🧾 V79.5.1 起全市場 + 前一晚名單買法)
 *   ③ index.html 的 `_SIGNAL_EDGE` / `_SIGNAL_EDGE_META` / `_DECK_TRACK49`(嵌入版 = 目前 App 在用的成績)
 *   + 上一版 data/backtest_edge.json(從 data 分支還原)當空過守門的基準
 *
 * ⛔ 三條不可改:
 *   ① **只標示不換預設**:等級變動(A↔C)、成績單勝率差 >5pp 都寫進 `diff`,⛔ 不改 App 常數(V75.0.9 五條件由人判)
 *   ② **空過守門**:訊號總 n 或成績單筆數 < 上一版的 80% → exit 1、不寫檔(資料不完整就不推);另外一律要過絕對下限 `FLOOR`
 *   ③ **產物格式跟嵌入版一模一樣**(signal.table 的 value 就是 `_SIGNAL_EDGE` 那 10 欄)
 *      🔁 V79.4.5 起 App 一律讀內嵌的 16 年表,這份只在實驗室模式當「最近幾年」的參考(⛔ 不再蓋掉內嵌表)
 *
 * 🔁 V79.4.5 「換設定那一次重新起算基準」(使用者選:查清楚再改成現行設定):
 *   🚨 真因:9/21 那份產物是**舊引擎**產的(`EXIT=don` 沒被認得 + 停損用停損價成交,V77.4.9 / V77.6.0 修掉)→ 1,233 筆;
 *      之後同設定只剩 918~926 筆,而守門一直拿凍結的 1,233 比 → 9/28 起每週都擋、產物停在 9/21(全綠零訊息)。
 *   規則:成績單 cfg(`DECK_SIG` 那幾欄)或訊號方法(`match`)跟上一版不同 → **這一次不比 80%**,重新起算並印「舊 → 新」;
 *         ⛔ 但絕對下限 `FLOOR` 照樣要過(防「換設定」被拿來掩護一次真的壞掉的產物);
 *         沒有上一版 → ⛔ 不拿內嵌表當基準(內嵌是 16 年、每週是最近 3 年,樣本差好幾倍 → 永遠擋)。
 *
 * 🧾 V79.5.1 每週回測改成全市場 + 照 App「前一晚名單」買(使用者 10/22 選:放棄尾盤掃描、每週回測照樣改全市場、改用名單買法):
 *   第二趟「不挑 🧬」在名單買法下做不到(`_DECK_TRACK49` 也這樣寫)→ 換成「💵 錢放現金」(`deck.cash`;App 從來沒讀 `deck.plain`)。
 *   新守門:成績單是名單買法(cfg.listK)→ ① 一定要接上「明天會不會觸發」的判定(listk.trig)② 判得夠深:
 *   「可能不準」的晚數 ≤ max(FLOOR.inexact, 1% 晚數)(陷阱 #58:只判前 30 筆時 16 年有 229 晚可能不準)。
 *
 * 用法:SUMMARY_GENE=/tmp/g.json [SUMMARY_CASH=/tmp/c.json] [PREV=data/backtest_edge.json] node scripts/build_backtest_edge.mjs [out]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 🔁 V79.4.5 成績單「設定」的簽章:這幾欄任一不同 = 換設定(那一次重新起算基準)
// 🔥 V79.4.9 補上選股規則 / 斷崖 / 回看天數 / 買法 / 停 0050(以前這幾欄換了守門看不出來 = 拿不同設定比 80%)
export const DECK_SIG = ['syms', 'picks', 'lot', 'capital', 'exit', 'stop', 'entry', 'self', 'filter', 'rankMin', 'volatMin', 'stopFill', 'maxd', 'warmup', 'div',
    'gate', 'minN', 'lbZ', 'lbTop', 'cliff', 'statsWin', 'allFire', 'listK', 'park', 'nolock', 'minMktN'];
export const deckSig = cfg => DECK_SIG.map(k => `${k}=${cfg && cfg[k] != null ? cfg[k] : ''}`).join('|');
// 🔁 V79.4.5 絕對下限(⛔ 不管有沒有換設定都要過):2026-10-20 本機重現(同 workflow 的資料與設定)成績單 1,024 筆・47 個月、
//   3 年訊號樣本 1,915,189 → 取約一半。⚠️ 改了成績單設定 / 訊號回測的方法,要重現一次再改這裡。
// 🔥 V79.4.9 照新設定(GATE=lb 照平均・≥8 次・斷崖・回看 1,200 天・停 0050)本機重現:成績單 1,108 筆・49 個月(不挑 🧬 675 筆)→ 550
// 🧾 V79.5.1 全市場 + 照 App 前一晚名單買(2026-10-22 本機重現,每週同一份資料 2,369 檔):成績單 294 筆・47 個月・
//   可能不準 2 / 974 晚 → 150(名單買法只在名單前 2 名當天觸發才買,筆數本來就只有舊買法的三成)
export const FLOOR = { deckN: 150, months: 36, sigN: 900000, inexact: 5 };
// 🅿️ V79.5.1 停 0050 的成績單:引擎的 cum 只算股票(0050 損益在 park 欄,⛔ 不混進 cum),
//   而 `_DECK_TRACK49.gene` 是「股票 + 0050」的合計 → 比較一律用合計(⛔ 拿只算股票的 cum 跟合計比 = 兩把尺)
export const deckTotal = g => (g ? (+g.cum || 0) + (+g.park || 0) : null);
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

/** 從 index.html 抓嵌入版常數(同 embed_signal_edge 的做法:兩行都是單獨一行) */
export function readEmbedded(html) {
    const lines = html.split('\n');
    const grab = (prefix) => { const l = lines.find(x => x.trimStart().startsWith(prefix)); if (!l) return null; try { return JSON.parse(l.trim().replace(new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*'), '').replace(/,$/, '')); } catch (_) { return null; } };
    const table = grab('_SIGNAL_EDGE:'), meta = grab('_SIGNAL_EDGE_META:');
    // ⚠️ V78.1.2 舊版一條 regex 要求 `to:` 到 `gene:` 之間 ≤400 字 —— V77.7.6 / V78.0.7 在中間加了幾行註解就超過,
    //   deck 恆為 null(每週回測「跟嵌入版比」那一步跟著失效,test_backtest_edge ⓪ 長期紅燈)。
    //   → 先切出 `_DECK_TRACK49: {` 那一段(到下一個頂層成員為止),再逐欄取**第一次**出現的值
    //     (gene/geneDD/plain/plainDD 的頂層那行排在 prev:/ma5: 之前,⛔ 不會誤抓到巢狀那份);逐行剝掉 // 註解。
    const i0 = html.indexOf('_DECK_TRACK49:');
    let deck = null;
    if (i0 >= 0) {
        const blk = html.slice(i0, i0 + 6000).split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
        const m1 = /_DECK_TRACK49:\s*\{\s*months:\s*(\d+),\s*from:\s*'([^']+)',\s*to:\s*'([^']+)'/.exec(blk);
        const num = k => { const m = new RegExp('[{,\\s]' + k + ':\\s*([\\d.]+)').exec(blk); return m ? +m[1] : null; };
        const g = num('gene'), gd = num('geneDD'), pl = num('plain'), pd = num('plainDD');
        if (m1 && g != null && gd != null) deck = { months: +m1[1], from: m1[2], to: m1[3], gene: g, geneDD: gd, plain: pl, plainDD: pd };
    }
    return { table, meta, deck };
}

/** 把 signal_edge.json 轉成跟 `_SIGNAL_EDGE` 一模一樣的表(⛔ 同 embed_signal_edge 的 8 欄) */
export function signalTable(j) {
    const table = {};
    // 🔁 V79.4.5 跟內嵌表一樣 10 欄:第 9 欄 xr(每趟比同一天平均股票)、第 10 欄 tone(bull / bear / warn)
    for (const s of (j.signals || [])) { if (!s.key) throw new Error('訊號缺 key'); table[s.key] = [s.grade, s.n, s.e10, s.w10, s.p, s.e20, s.payoff == null ? null : s.payoff, s.exp == null ? null : s.exp, (typeof s.xr === 'number' && isFinite(s.xr)) ? s.xr : null, s.tone || null]; }
    return table;
}

export function build({ sig, gene, cash = null, embedded, prev = null, now = new Date(), floor = FLOOR }) {
    const table = signalTable(sig);
    const keys = Object.keys(table);
    if (!keys.length) throw new Error('signal_edge 沒有訊號');
    const nSig = keys.reduce((s, k) => s + (+table[k][1] || 0), 0);
    const cnt = { A: 0, B: 0, C: 0 }; for (const k of keys) cnt[table[k][0]] = (cnt[table[k][0]] || 0) + 1;
    // 空過守門:跟上一版比 80%(🔁 V79.4.5 換設定 / 換訊號方法那一次重新起算;沒有上一版 ⛔ 不拿內嵌表比)+ 絕對下限
    const pGene = prev && prev.deck && prev.deck.gene ? prev.deck.gene : null;
    const sigMatch = sig.match || null, prevMatch = prev && prev.signal ? (prev.signal.match || null) : null;
    const sigRebase = !!(prev && prev.signal) && prevMatch !== sigMatch;
    const deckRebase = !!pGene && !!gene && deckSig(pGene.cfg) !== deckSig(gene.cfg);
    const baseSigN = prev && prev.signal && !sigRebase ? prev.signal.n : null;
    const baseDeckN = pGene && !deckRebase ? pGene.n : null;
    const errs = [];
    if (!(nSig >= floor.sigN)) errs.push(`訊號總樣本 ${nSig.toLocaleString()} < 絕對下限 ${floor.sigN.toLocaleString()}`);
    if (baseSigN && nSig < baseSigN * 0.8) errs.push(`訊號總樣本 ${nSig.toLocaleString()} < 上一版 ${baseSigN.toLocaleString()} 的 80%`);
    if (!gene || !(gene.n > 0)) errs.push('成績單(🧬)沒有筆數');
    else {
        if (gene.n < floor.deckN) errs.push(`成績單筆數 ${gene.n} < 絕對下限 ${floor.deckN}`);
        if (!(gene.months >= floor.months)) errs.push(`成績單窗口 ${gene.months} 個月 < ${floor.months} 個月`);
        if (baseDeckN && gene.n < baseDeckN * 0.8) errs.push(`成績單筆數 ${gene.n} < 上一版 ${baseDeckN} 的 80%`);
        // 🧾 V79.5.1 名單買法:判觸發要真的接上、而且判得夠深(⛔ 名單排到沒判過的那幾晚,買的可能不是 App 會買的)
        if (gene.cfg && gene.cfg.listK) {
            const lk = gene.listk || {}, lim = Math.max(floor.inexact ?? 5, Math.ceil((+lk.days || 0) * 0.01));
            if (!lk.trig) errs.push('成績單是名單買法,但沒有接上「明天會不會觸發」的判定(LIST_TRIG)');
            else if (!(+lk.inexact <= lim)) errs.push(`名單判斷太淺:${lk.inexact} 晚可能不準(上限 ${lim} 晚;把 TOPN / LIST_DUMP_N 加大)`);
        }
    }
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
        const gTot = deckTotal(gene);
        if (Math.abs(gTot - embedded.deck.gene) / Math.max(1, Math.abs(embedded.deck.gene)) > 0.30) diff.push({ k: 'deck.gene', what: 'cum', old: embedded.deck.gene, new: gTot });
        if (Math.abs(Math.abs(gene.dd) - embedded.deck.geneDD) > 5) diff.push({ k: 'deck.geneDD', what: 'dd', old: embedded.deck.geneDD, new: Math.abs(gene.dd) });
        void winOld;
    }
    // 勝率跟上一版比(⛔ 換設定那一次不比 —— 那是兩套規則,差多少都不代表「變了」)
    if (pGene && gene && !deckRebase && Math.abs(gene.win - pGene.win) > 5) diff.push({ k: 'deck.win', what: 'win_vs_prev', old: pGene.win, new: gene.win });
    const rebase = (deckRebase || sigRebase) ? {
        deck: deckRebase ? { from: deckSig(pGene.cfg), to: deckSig(gene.cfg), oldN: pGene.n, newN: gene.n } : null,
        signal: sigRebase ? { from: prevMatch, to: sigMatch, oldN: prev.signal.n, newN: nSig } : null,
    } : null;
    return {
        run_at: now.toISOString().slice(0, 10), kind: 'weekly',
        signal: { table, n: nSig, grades: cnt, syms: sig.syms, base_win: sig.base && sig.base.win ? sig.base.win['10'] : null, window: sig.window || null, match: sigMatch, cost: sig.cost ?? null },
        rebase, floor,
        deck: { gene, cash },
        embedded: { sigA: embedded.meta ? embedded.meta.A : null, sigB: embedded.meta ? embedded.meta.B : null, sigC: embedded.meta ? embedded.meta.C : null,
                    deck: embedded.deck },
        diff, prev: prev ? { run_at: prev.run_at } : null,
        note: '⛔ 只標示不換預設:等級或成績有變一律寫在 diff,App 的預設要換得過 V75.0.9 那五個條件(由人判)',
    };
}

if (isMain) {
    const out = process.argv[2] || path.join(ROOT, 'data', 'backtest_edge.json');
    const sig = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'signal_edge.json'), 'utf8'));
    const gene = process.env.SUMMARY_GENE ? JSON.parse(fs.readFileSync(process.env.SUMMARY_GENE, 'utf8')) : null;
    const cash = process.env.SUMMARY_CASH && fs.existsSync(process.env.SUMMARY_CASH) ? JSON.parse(fs.readFileSync(process.env.SUMMARY_CASH, 'utf8')) : null;
    const prevP = process.env.PREV || out;
    const prev = fs.existsSync(prevP) ? (() => { try { return JSON.parse(fs.readFileSync(prevP, 'utf8')); } catch (_) { return null; } })() : null;
    const embedded = readEmbedded(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'));
    if (!embedded.table || !embedded.deck) { console.error('🚨 index.html 讀不到嵌入版 _SIGNAL_EDGE / _DECK_TRACK49 → 停'); process.exit(1); }
    let r;
    try { r = build({ sig, gene, cash, embedded, prev }); } catch (e) { console.error(`❌ ${e.message}${e.gate ? '(⛔ 不寫檔、不推)' : ''}`); process.exit(1); }
    fs.writeFileSync(out, JSON.stringify(r));
    if (r.rebase && r.rebase.deck) console.log(`🔁 成績單換設定 → 這一次重新起算守門基準(⛔ 不跟舊設定比 80%):\n   舊 ${r.rebase.deck.from}(${r.rebase.deck.oldN} 筆)\n   新 ${r.rebase.deck.to}(${r.rebase.deck.newN} 筆)`);
    if (r.rebase && r.rebase.signal) console.log(`🔁 訊號回測換方法 ${r.rebase.signal.from || '(舊:整段平均)'} → ${r.rebase.signal.to || '(未標)'}:重新起算(樣本 ${r.rebase.signal.oldN.toLocaleString()} → ${r.rebase.signal.newN.toLocaleString()})`);
    console.log(`✅ backtest_edge.json:訊號 ${Object.keys(r.signal.table).length} 個(A=${r.signal.grades.A} B=${r.signal.grades.B} C=${r.signal.grades.C},n=${r.signal.n.toLocaleString()})・成績單 🅿️ ${gene.n} 筆 / 勝率 ${gene.win}% / 累積 ${deckTotal(gene).toLocaleString()}${gene.park != null ? `(股票 ${gene.cum.toLocaleString()} + 0050 ${gene.park.toLocaleString()})` : ''} / 回撤 ${gene.dd}%${gene.listk ? ` / 名單 ${gene.listk.days} 晚・可能不準 ${gene.listk.inexact ?? '?'} 晚` : ''}${cash ? ` ・💵 錢放現金 ${cash.cum.toLocaleString()}` : ''}`);
    console.log(`   跟嵌入版的差異 ${r.diff.length} 項${r.diff.length ? ':' + r.diff.slice(0, 8).map(d => `${d.k}(${d.what} ${d.old}→${d.new})`).join(' / ') : ''}`);
    console.log('   ⛔ 只標示不換預設');
}
