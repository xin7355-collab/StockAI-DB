#!/usr/bin/env node
/**
 * 🚪 出場價全站統一(V75.0.1)—— 使用者:「以出場進場等等,太多版本應該統一用最厲害的招式,使用者很混亂」
 *
 * ⭐ 唯一真相:`_exitPrimary(data, sym)` → 由 `_exitRuleKey()`(⚙️ 設定中心四選一,預設 `atr2`)決定。
 *   那四條是 49 個月 28 種實測選出來的(`_EXIT_EDGE`);⛔ 其餘全是「參考價位」。
 *
 * 🚨 這一輪修掉的**會害使用者下錯單**的兩個:
 *  ① 永豐智慧單 SOP 的**停利觸發價**用 `takeShort`(MA5,沒有回測背書)——
 *     那是使用者會**照抄去券商掛單**的數字。
 *  ② 盤中推播 `dn5` **寫死 5MA**,而 `_pbExitSweep` 已讀 `_exitPrimary`
 *     → **同一天可能收到兩則互相矛盾的通知**;而且兩支各自去重 → 還會重複。
 *
 * ⛔ 六條不可改掉:
 * ① 掛單用的價位一律讀 `_exitPrimary`(⛔ 不可回頭用 `takeShort`)
 * ② `dn5` 與 `_pbExitSweep` **共用 dedupe key**(⛔ 各自去重 = 同日兩則)
 * ③ 🚨 換了出場規則就要**講落差** —— 歷史成績是用 5 日線算的,⛔ 只換名字 = 成績跟規則對不上
 * ④ 舊的兩條(5MA/20MA)**降級不刪**(⛔ 刪了使用者會以為沒這回事)
 * ⑤ `_aiGodAdviceHtml` 的趨勢讀主結論 `_ovTrend`(⛔ 不可自己再算一份 = 同畫面兩個方向)
 * ⑥ 🚨 `stopFinal`(V72.0.7 的時間守門)⛔ **一行都不可動** —— `test_guardtime` 釘著
 */
import fs from 'fs';
import path from 'path';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let fails = 0;
const ok = (n, c, e = '') => { if (c) console.log(`✅ ${n}`); else { fails++; console.log(`❌ ${n}${e ? '  ' + String(e).slice(0, 220) : ''}`); } };
const blk = (a, b) => { const i = SRC.indexOf(a); const j = i > 0 ? SRC.indexOf(b, i + 1) : -1; return (i > 0 && j > i) ? SRC.slice(i, j) : ''; };

// ═══ 靜態 ═══
// ① 永豐智慧單觸發價
const sino = blk('const sinopacStop =', 'const sinopacHtml');
ok('⓪ 取樣守門:抓得到永豐 SOP 那一段', sino.length > 100);
ok('① 🚨 永豐智慧單的**停利觸發價**要讀 `_exitPrimary`(⛔ 不可用 takeShort ——'
   + ' 那是使用者會照抄去掛單的數字)', /_ep && _ep\.v > 0/.test(sino) && /sinopacTake/.test(sino), sino.slice(0, 160));

// ② dn5 與 _pbExitSweep 共用 dedupe key
const dn5 = blk("const _epL = (() =>", 'dnTag}`);');
ok('⓪b 取樣守門:抓得到 dn5 那一段', dn5.length > 100);
// ⚠️ ⛔ 只驗「`_epL` 宣告還在」是不夠的 —— 把 if 改回 ma5 照樣綠(注入驗證抓到)
//   → 要驗**判斷式本身**真的用了它
ok('② 🚨 盤中推播⛔ 不可再寫死 5MA(⛔ 那是「同日兩則矛盾通知」的來源)',
   /this\._exitPrimary\(this\.rawDailyData, sym\)/.test(dn5)
   && /if \(prevClose >= _exV && nowPrice < _exV/.test(dn5), dn5.slice(0, 200));
ok('②b 🚨 dedupe key 要跟 `_pbExitSweep` **共用**(⛔ 各自去重 = 同一天照樣兩則)',
   /_kbarFiredToday\(`pbtp_\$\{sym\}_/.test(dn5) && /`pbtp_\$\{t\.s\}_/.test(SRC), dn5.slice(0, 200));

// ③ 換規則要講落差(⛔ 只換名字 = 成績跟規則對不上)
const cond = blk('_copyCondOrder(sym) {', '// 🔔 V73.8.4');
ok('③ 🚨 條件單文字要講「你設定的那條」', /_exNm/.test(cond));
ok('③b 🚨 而且要講「歷史成績是用 5 日線算的」那個落差(⛔ 只換名字等於在說謊)',
   /是用\*\*跌破 5 日線\*\*出場算的|用\*\*跌破 5 日線\*\*/.test(cond) || /跌破 5 日線\*\*出場算的/.test(cond), cond.slice(cond.indexOf('_exIsMa5'), cond.indexOf('_exIsMa5') + 300));
const trackBlk = blk('_pbTrackRecordHtml() {', '// 🔔 V73.8.4');
ok('③c 🚨 歷史成績那張卡也要講落差(數字從 `_EXIT_EDGE` 讀,⛔ 不寫死)',
   /_EXIT_EDGE\.rows\.find/.test(trackBlk) && /_EXIT_EDGE\.base\.p/.test(trackBlk), trackBlk.length ? 'block ok' : 'no block');

// ④ 舊的兩條降級不刪
// ⚠️ ⛔ 先剝註解 —— 把那一行註解掉照樣會被字串比對配到(本專案已踩 15 次)
const SRC_NC = SRC.split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
ok('④ 舊的 5MA/20MA 停利**降級不刪**(⛔ 刪了使用者會以為沒這回事)',
   /route\('📤', '短線停利\(舊版\)'/.test(SRC_NC) && /route\('📤', '中長停利\(舊版\)'/.test(SRC_NC)
   && /x\.takeShort, 'text-green-400'/.test(SRC_NC));
ok('④b 防守尺也一樣:主線是設定那條、`dx.def` 降級標「舊版」',
   /停損價\(舊版\)/.test(SRC) && /出場線\(\$\{e\.name\}\)/.test(SRC));

// ⑤ _aiGodAdviceHtml 的趨勢讀主結論
const god = blk('const _selfTrend =', 'const nf = v =>');
// ⚠️ 同上:⛔ 不可只驗 `_ovT` 宣告在不在 —— 要驗 `trend` **真的**吃它
ok('⑤ 🚨 機器人卡的趨勢要讀主結論 `_ovTrend`(⛔ 自己再算一份 = 同畫面兩個方向)',
   /this\._ovTrend && this\._ovTrend\.sym === sym/.test(god)
   && /const trend = _ovT \|\| _selfTrend;/.test(god), god.slice(0, 260));
ok('⑤b 停利價也讀 `_exitPrimary`', /const tpS = \(_epG && _epG\.v > 0\)/.test(SRC));

// ⑥ 🚨 stopFinal ⛔ 一行都不可動
ok('⑥ 🚨 `stopFinal`(V72.0.7 時間守門)⛔ 不可被動到', /const slF = plan\?\.stopFinal;/.test(SRC));

// ⑦ K 線圖疊圖是代理版 → 要說出來
ok('⑦ 填了買進日時要說「圖上那兩條是代理版,以卡上為準」(⛔ 只寫在程式註解裡等於沒說)',
   /K 線圖上疊的那兩條是<b>代理版<\/b>/.test(SRC) && /proxyNote/.test(SRC));

// ═══ 實跑:同一檔同一時刻,三處數字必須相同 ═══
const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const page = await browser.newPage();
await page.goto('file://' + path.join(ROOT, 'index.html'));
await page.waitForFunction(() => typeof app !== 'undefined' && app._exitPrimary, null, { timeout: 30000 });

const R = await page.evaluate(async () => {
    const A = window.app || app;
    const out = {};
    // 合成一段會漲的 K(⭐ 手算得出唯一答案:最後 20 根收盤 100..119 → 5 日線 = (115..119)/5 = 117)
    const k = []; for (let i = 0; i < 80; i++) { const c = 60 + i * 0.75; k.push({ date: `2026-0${1 + (i % 9)}-${String(1 + (i % 28)).padStart(2, '0')}`, open: c - 0.3, high: c + 0.5, low: c - 0.6, close: c, volume: 1e6 }); }
    A.currentSymbolId = '9999'; A.rawDailyData = k; A.activeData = k; A.inventory = []; A.favGroups = {};
    const res = {};
    for (const rule of ['atr2', 'don', 'trail8', 'ma5']) {
        A.settings = A.settings || {}; A.settings.exitRule = rule;
        const ep = A._exitPrimary(k, '9999');
        const lines = A._exitLines(k, '9999');
        res[rule] = { v: ep ? +ep.v.toFixed(2) : null, name: ep ? ep.name : null, card: lines ? +(+lines[rule]).toFixed(2) : null };
    }
    out.res = res;
    // 🚪 換設定 → 卡片上「⭐ 你在用的」要跟著換
    A.settings.exitRule = 'don';
    out.htmlDon = (A._exitLinesHtml(k, '9999') || '').replace(/<[^>]+>/g, ' ');
    A.settings.exitRule = 'trail8';
    out.htmlTrail = (A._exitLinesHtml(k, '9999') || '').replace(/<[^>]+>/g, ' ');
    // 🎯 條件單文字:非 ma5 時要出現落差揭露
    A._pbEdge = { picks: [{ s: '9999', c: 100, trig: 105, stop: 95, k: '💪 測試招', lb: 5, w: 60, n: 20, up: 5, bear: 0 }] };
    A.settings.accountSize = 1000000;
    let copied = ''; const realWrite = navigator.clipboard?.writeText;
    try { Object.defineProperty(navigator, 'clipboard', { value: { writeText: t => { copied = t; return Promise.resolve(); } }, configurable: true }); } catch (_) {}
    A.settings.exitRule = 'don'; A._copyCondOrder('9999');
    await new Promise(r => setTimeout(r, 200));
    out.condDon = copied;
    A.settings.exitRule = 'ma5'; copied = ''; A._copyCondOrder('9999');
    await new Promise(r => setTimeout(r, 200));
    out.condMa5 = copied;
    try { document.getElementById('richHelpModal')?.classList.add('hidden'); } catch (_) {}
    void realWrite;
    return out;
});
await browser.close();

const r = R.res;
ok('⑧ 🚨 四種規則:`_exitPrimary` 的價位跟卡片上那一條**完全一樣**(⛔ 不可有兩份算法)',
   ['atr2', 'don', 'trail8', 'ma5'].every(k => r[k].v != null && r[k].v === r[k].card), JSON.stringify(r));
ok('⑧b 四種規則算出來的價位**互不相同**(⛔ 空過守門:全都一樣代表根本沒切換)',
   new Set(['atr2', 'don', 'trail8', 'ma5'].map(k => r[k].v)).size >= 3, JSON.stringify(r));
ok('⑨ 換設定 → 卡片上「⭐ 你在用的」跟著換',
   /⭐ 你在用的 ・ 唐奇安/.test(R.htmlDon) && /⭐ 你在用的 ・ 移動停利/.test(R.htmlTrail),
   `${R.htmlDon.slice(0, 90)} || ${R.htmlTrail.slice(0, 90)}`);
ok('⑩ 🚨 條件單:設成唐奇安 → 文字要寫唐奇安,而且要講「成績是用 5 日線算的」落差',
   /唐奇安/.test(R.condDon) && /用\*\*跌破 5 日線\*\*出場算的|跌破 5 日線.{0,10}出場算的/.test(R.condDon),
   R.condDon.split('\n').filter(l => /唐奇安|5 日線/.test(l)).join(' | ').slice(0, 220));
ok('⑩b 設回 5 日線 → ⛔ 不可再道歉一次(那句只在「你設的不是 5 日線」時才出現)',
   /5 日線/.test(R.condMa5) && !/出場算的/.test(R.condMa5),
   R.condMa5.split('\n').filter(l => /5 日線/.test(l)).join(' | ').slice(0, 200));

console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ EXITUNIFY_PASS(全部通過)');
process.exit(fails ? 1 : 0);
