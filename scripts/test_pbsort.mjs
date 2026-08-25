#!/usr/bin/env node
/**
 * 🔁 明日作戰清單排序一致性 + 「怎麼常常是同幾檔」說明(V73.8.7)測試
 *
 * 使用者:「會賺錢訊號怎麼感覺是這幾隻」。
 *
 * 查下去發現**兩件事**:
 *  ⭐ ① 他的感覺是對的:實測隔 3 個交易日(08/19 → 08/24)全清單 167 → 164 檔,
 *       **重疊 111 檔 = 68%**;前 12 名重疊 5/12。
 *       —— 但那是**設計的必然**(清單問的是「這一檔自己歷史上最會賺的招」,歷史不會天天變),
 *       ⛔ 不可為了「看起來新鮮」硬換一批。要做的是**把原因講給使用者聽**。
 *  🚨 ② 順手抓到真 bug:**清單的排序跟實際推播的排序不一樣** ——
 *       `_tomorrowWatchHtml` 只有 `(自己的) || (保守下界)`,
 *       `_eodTriggerSweep` 卻是 `(自己的) || (🧬) || (保守下界)`
 *       → 使用者看到的第 1 名,可能不是真的會通知他的那一檔(邏輯打架)。
 *       ⭐ 而 V73.2.9 實測「不挑 🧬 整套輸 0050 一百多萬」→ 🧬 是必要條件,清單當然也要照它排。
 *
 * ⛔ 這支要釘死的六件事:
 *   ① 兩處排序**必須用同一組鍵**(自己的 → 🧬 → 保守下界)。
 *   ② 排序⛔ 不可用原始期望值 `exp`(V72.9.2:排點估計值必定挑到僥倖股)。
 *   ③ 說明區的打法佔比要**現算**,⛔ 不可寫死。
 *   ④ 說明要講出「每天真正在變的是離觸發價多遠」,⛔ 不可只說「這是正常的」就結束。
 *   ⑤ ⛔ 不可承諾「會換一批」(那會把最會賺的擠掉)。
 *   ⑥ 沒資料 → ⛔ 整塊不顯示(不留空殼)。
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 260)}`}`); if (!c) fails.push(n); };
const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// ── ①② 靜態:兩處排序鍵一致 ──────────────────────────────────────
// ⚠️ 第一版用 `list.slice().sort(` 全檔比對 → 抓到**第三個**不相干的排序而誤判。
//   ⭐ 正解:只看那**兩支函式自己的區塊**(⛔ 別在整份檔案裡撈同樣寫法的東西)。
{
    const block = (startMark, endMark) => {
        const a = src.indexOf(startMark);
        const b = a > 0 ? src.indexOf(endMark, a) : -1;
        return (a > 0 && b > a) ? src.slice(a, b) : '';
    };
    const B = [
        ['明日作戰清單', block('async _tomorrowWatchHtml()', 'const SHOW =')],
        ['尾盤推播', block('async _eodTriggerSweep()', '_pbMark(')],
    ];
    ok('① 兩支函式的區塊都抓得到', B.every(([, s]) => s.length > 200), B.map(([n, s]) => `${n}:${s.length}`).join(' '));
    const keyed = B.map(([n, s]) => ({
        n,
        mine: /mine\.has\(String\(b\.s\)\) - mine\.has\(String\(a\.s\)\)/.test(s),
        hq: /_hq\(b\) - _hq\(a\)/.test(s),
        lb: /_lb\(b\) - _lb\(a\)/.test(s),
        exp: /b\.exp - a\.exp/.test(s),
    }));
    ok('①b 🚨 兩處都要有 🧬(hq)優先 —— ⛔ 不可一邊有一邊沒有',
        keyed.every(k => k.mine && k.hq && k.lb), JSON.stringify(keyed));
    ok('② ⛔ 排序不可用原始期望值 exp(V72.9.2:必定挑到僥倖股)',
        keyed.every(k => !k.exp), JSON.stringify(keyed));
}
ok('②b 兩處都用 `pbHqOff` 開關(使用者可關,但預設開)',
    (src.match(/settings\?\.pbHqOff \? 0 :/g) || []).length === 2,
    String((src.match(/settings\?\.pbHqOff \? 0 :/g) || []).length));

// ── 前端實跑 ─────────────────────────────────────────────────────
const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined|Tailwind/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._pbWhySameHtml, null, { timeout: 25000 });

const R = await page.evaluate(() => {
    // ⚠️ 第一版兩組都用 String(1000+i) → 檔號重疊,檔數變 8 不是 10(測資自己錯,不是程式錯)。
    //   ⭐ 順便把「同一檔可以有 2 招 → 筆數 ≠ 檔數」這個真實性質一起釘住。
    const mk = (k, n, base) => Array.from({ length: n }, (_, i) => ({ s: String(base + i), k }));
    const picks = [...mk('💪 發動棒破昨高', 8, 1000), ...mk('📦 箱型突破', 2, 2000)];
    const dup = [...mk('💪 發動棒破昨高', 3, 1000), ...mk('📦 箱型突破', 1, 1000)];
    return {
        html: app._pbWhySameHtml(picks),
        empty: app._pbWhySameHtml([]),
        bad: app._pbWhySameHtml(null),
        dup: app._pbWhySameHtml(dup),
    };
});
await browser.close();

// ③ 現算
ok('③ 打法佔比是現算的(8/10 → 80%)', /80%/.test(R.html), R.html.slice(0, 300));
// ⚠️ 這條改過兩次:先用 `>10</b>` 抓不到(有 class 屬性),再用 `">10</b>` 又抓不到
//   (class 被 strip 掉之後前面不是引號)。⭐ 教訓:斷言 HTML 內容前先把它正規化,
//   ⛔ 別去猜實際輸出長什麼樣子。
{
    const plain = R.html.replace(/ class="[^"]*"/g, '');
    ok('③b 筆數/檔數也現算', /<b>10<\/b> 筆/.test(plain) && /<b>10<\/b> 檔/.test(plain), plain.slice(0, 420));
    const pd = R.dup.replace(/ class="[^"]*"/g, '');
    ok('③d ⭐ 同一檔多招時「筆數 ≠ 檔數」要分得清楚(4 筆 / 3 檔)',
        /<b>4<\/b> 筆/.test(pd) && /<b>3<\/b> 檔/.test(pd), pd.slice(0, 420));
}
ok('③c 最多的打法名稱要印出來', R.html.includes('發動棒破昨高'));
// ④ 要給可操作的重點
ok('④ 🚨 要講「每天真正在變的是離觸發價多遠」', /離觸發價/.test(R.html) && /先看那個距離/.test(R.html), R.html.slice(0, 400));
ok('④b 要附實測重疊率(⛔ 不可只說「正常」)', /重疊 68%|重疊<\/b>|68%/.test(R.html));
ok('④c 要說明「最多的打法」不代表比較厲害', /不是它比較厲害/.test(R.html));
// ⑤ 不可承諾換一批
ok('⑤ ⛔ 不可承諾「會換一批 / 每天不同」', !/會換一批|每天都不一樣|每天換/.test(R.html.replace(/不會為了[^<]*/g, '')), R.html.slice(0, 300));
// ⑥ 空狀態
ok('⑥ 沒資料 → ⛔ 整塊不顯示', R.empty === '' && R.bad === '', `${R.empty}|${R.bad}`);
// 接線
ok('⑦ 已接進明日作戰清單', /\$\{this\._pbWhySameHtml\(list\)\}/.test(src));
ok('⑦b _pbWhySameHtml 只定義一次', (src.match(/_pbWhySameHtml\(picks\)\s*\{/g) || []).length === 1);
ok('⑧ 載入無 pageerror', errs.length === 0, errs.join(' | '));

console.log();
console.log(fails.length ? `❌ ${fails.length} 條失敗` : '✅ PBSORT_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
