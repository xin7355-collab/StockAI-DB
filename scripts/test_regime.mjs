#!/usr/bin/env node
/**
 * 🏭 「這波是誰在漲?」(V73.7.4)測試 —— 用**真實 `data/screener.json`** 實跑。
 *
 * 來源:`scripts/regime_probe.mjs`(1,076 檔 × 2023-06~2026-08 × 68,082 個事件)。
 *
 * ⛔ 這支要釘死的七件事:
 *   ① **母體必須跟回測一致** —— 只用「有官方產業別」的那 1,075 檔算全市場分位,
 *      ⛔ 不可拿 screener 全部 2,356 檔(上櫃沒有產業別,母體不同 = 數字不能用)。
 *   ② **「沒有資料」與「條件沒過」要分開講** —— 上櫃股要誠實說「判斷不了」,
 *      ⛔ 不可靜默不顯示(使用者會以為壞了)。
 *   ③ **只有「獨走」可以講有邊際**,其餘六種一律要寫「扣完成本後是負的」。
 *   ④ **獨走要明說是「賠率型」** —— 中位跟平常一樣,賺在右尾。⛔ 不可只講平均 +0.89%。
 *   ⑤ ⛔ **不下進出場指令**(K線頁只解讀,單一劇本原則)。
 *   ⑥ **K 棒沒訊號時這條仍要顯示** —— ⛔ 否則變成「有時有有時沒有」。
 *   ⑦ screener 非同步載入要有**重繪 + 防無限迴圈旗標**。
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 260)}`}`); if (!c) fails.push(n); };

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined|Tailwind/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._stockRegime, null, { timeout: 25000 });

const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const scr = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'screener.json'), 'utf8'));

// 把真實 screener 灌進去(⛔ 不自己編假資料 —— 要驗的正是「真實母體」對不對得上)
const R = await page.evaluate(async (D) => {
    app._scrData = D;
    app._scrC = {}; D.cols.forEach((k, i) => { app._scrC[k] = i; });
    app._regCache = null;
    const S = app._regimeStats();
    const out = { stats: S ? { n: S.n, inds: S.rank.size, mktMed: S.mktMed, mktP80: S.mktP80 } : null, cases: [], counts: {} };
    // 分類全市場,看五種狀態各有幾檔(驗分類真的在動,⛔ 不是全部落到 none)
    for (const s of Object.keys(D.rows)) {
        const r = app._stockRegime(s);
        const k = r ? (r.k || ('na:' + (r.na || '?'))) : 'null';
        out.counts[k] = (out.counts[k] || 0) + 1;
    }
    // 各狀態抓一個樣本出來看 HTML
    const seen = {};
    for (const s of Object.keys(D.rows)) {
        const r = app._stockRegime(s);
        const k = r ? (r.k || ('na:' + (r.na || '?'))) : 'null';
        if (seen[k]) continue;
        seen[k] = true;
        out.cases.push({ k, sym: s, ind: r && r.ind, me: r && r.me, indMed: r && r.indMed,
                         html: app._stockRegimeHtml(s) });
    }
    // 沒載入 screener 時要回 null(⛔ 不可 throw、不可硬給結論)
    const keep = app._scrData; app._scrData = undefined; app._regCache = null;
    out.noData = app._stockRegime('2330');
    out.noDataHtml = app._stockRegimeHtml('2330');
    app._scrData = keep; app._regCache = null;
    return out;
}, scr);

// ── ① 母體 ──────────────────────────────────────────────────────────
{
    const withInd = Object.keys(scr.rows).filter(s => (scr.ind || {})[s]).length;
    ok('① ⭐ 全市場分位只用「有官方產業別」的那批(⛔ 不可用全部 2,356 檔)',
       !!R.stats && Math.abs(R.stats.n - withInd) <= 5, `stats.n=${R.stats && R.stats.n} vs 有產業別 ${withInd} / 全部 ${Object.keys(scr.rows).length}`);
    ok('①b 產業數要接近 TWSE 33 大類', !!R.stats && R.stats.inds >= 20 && R.stats.inds <= 40, JSON.stringify(R.stats));
    ok('①c p80 要大於中位(⛔ 分位算錯的話會相等)', !!R.stats && R.stats.mktP80 > R.stats.mktMed, JSON.stringify(R.stats));
}

// ── ② 沒有資料 vs 條件沒過 要分開 ────────────────────────────────────
{
    const otc = R.cases.find(c => c.k === 'na:noind');
    ok('② 上櫃股(沒有官方產業別)→ 回 na:noind', !!otc, JSON.stringify(Object.keys(R.counts)));
    ok('②b ⭐ 上櫃股要**誠實說判斷不了**,⛔ 不可靜默不顯示',
       !!otc && otc.html.length > 50 && /判斷不了/.test(otc.html) && /只涵蓋上市/.test(otc.html), (otc && otc.html || '').slice(0, 160));
    ok('②c ⭐ 而且要說「不是程式壞掉,是資料源就沒有」',
       !!otc && /不是程式壞掉/.test(otc.html), '');
    ok('②d screener 還沒載入 → 回 null 且 HTML 空(⛔ 不可硬給結論、不可 throw)',
       R.noData === null && R.noDataHtml === '', JSON.stringify([R.noData, R.noDataHtml]));
}

// ── 分類真的在動(空過守門)────────────────────────────────────────
{
    const K = ['ind_up_follow', 'ind_up_lag', 'solo', 'ind_dn_follow', 'ind_dn_strong'];
    const hit = K.filter(k => (R.counts[k] || 0) > 0);
    ok('🚧 空過守門:五種狀態至少要命中 3 種(⛔ 全部落到 none = 分類根本沒作用)',
       hit.length >= 3, JSON.stringify(R.counts));
    const tot = K.reduce((a, k) => a + (R.counts[k] || 0), 0);
    ok('🚧b 命中的檔數要合理(⛔ 不可是 0,也不可全部命中)',
       tot > 50 && tot < (R.stats.n || 0) * 0.95, `命中 ${tot} / 母體 ${R.stats && R.stats.n}`);
}

// ── ③④⑤ 文案 ───────────────────────────────────────────────────────
for (const c of R.cases) {
    if (!c.k.startsWith('ind_') && c.k !== 'solo') continue;
    const txt = (c.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const tag = `${c.k}(${c.sym} ${c.ind})`;
    ok(`③ ${tag} 要附樣本數與實測數字`, /\d[\d,]* 次/.test(txt) && /勝率 \d/.test(txt), txt.slice(0, 140));
    if (c.k === 'solo') {
        // 🚨 V74.2.8 補上 2022 空頭重跑之後,獨走那格**不再全關通過**(2022 是 −0.34pp)
        //    → 斷言從「要說它唯一通過」改成「要說它只在多頭成立」。⛔ 數字不寫死(重跑會變)。
        ok('③b 🎯 獨走:要誠實說「補上空頭之後不成立」+ 扣成本那句仍在',
           /空頭/.test(txt) && /扣掉來回成本 0\.44%/.test(txt), txt.slice(0, 260));
        ok('④ 🎯 獨走:⭐ 必須明說是「賠率型不是勝率型」+ 右尾數字',
           /賠率型/.test(txt) && /勝率型/.test(txt) && /最好的 10%/.test(txt) && /中位數跟平常一樣/.test(txt), txt.slice(0, 300));
        ok('④b 🎯 獨走:要給可操作的一句(不能重壓)', /不能重壓/.test(txt), '');
    } else {
        ok(`③c ${tag} ⛔ 沒通過的一律要寫「扣完成本後是負的」`,
           /實測沒有可用的邊際/.test(txt) && /拿掉最好的那一年/.test(txt), txt.slice(0, 200));
        ok(`③d ${tag} ⭐ 要明說「只是告訴你現在是什麼盤,不是叫你買或賣」`,
           /不是叫你買或賣/.test(txt), '');
    }
    // ⑤ ⛔ 不可下指令 —— 先 strip 掉否定句(本專案踩過 6 次:免責句本身含被禁的字)
    const stripped = txt
        .replace(/不是叫你買或賣/g, '').replace(/不是進場理由/g, '')
        .replace(/不是進出場訊號/g, '').replace(/不能重壓/g, '');
    ok(`⑤ ${tag} ⛔ 不可下進出場指令`,
       !/(可以買|可以進場|建議買進|可加碼|停損設|掛單|目標價|該賣|快進)/.test(stripped), stripped.slice(0, 180));
}

// ── ⑥⑦ 接線 ───────────────────────────────────────────────────────
// ⚠️ V74.0.2 起 `_luOddsHtml`(明天漲停/大漲機率)插在 _headline 與這條之間 →
//    斷言改成「在 _headline 之後、rows 之前」,⛔ 不再要求緊貼(不然每加一條就假失敗)。
ok('⑥ 已接進 K棒戰法卡(_headline 之後、K 棒訊號列之前)',
   /\$\{_headline\}[\s\S]{0,200}\$\{this\._stockRegimeHtml\(this\.currentSymbolId\)\}[\s\S]{0,200}\$\{rows\}/.test(src), '');
ok('⑥b ⭐ K 棒沒訊號時這條仍要顯示(⛔ 否則變成有時有有時沒有)',
   /if \(!sigs\.length\) \{[\s\S]{0,700}_stockRegimeHtml\(this\.currentSymbolId\)/.test(src), '');
ok('⑦ screener 非同步載入要重繪 + 防無限迴圈旗標',
   /_scrData === undefined && !this\._regLoading/.test(src) && /this\._regLoading = true;/.test(src), '');
ok('⑦b 重繪前要確認還是同一檔(⛔ 防切股殘留)',
   /String\(this\.currentSymbolId \|\| ''\) === _sym/.test(src), '');
ok('⑧ ⛔ 沒有新增卡片 id', !/id="stockRegime/.test(src), '');
ok('⑨ 無 pageerror', errs.length === 0, errs.join(' | '));

console.log('\n📊 全市場分類分布:', JSON.stringify(R.counts));
await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ REGIME_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
