#!/usr/bin/env node
/**
 * 💧 V76.0.3 大盤頁第 4 格「板塊輪動」測試
 *
 * 使用者:「新增市場板塊輪動頁面,放在盤前檢視右手邊,把市場板塊輪動移到這裡面;
 *          PRO 的板塊輪動要不要?我不要資料太亂,應該簡化還有重新設計介面」
 *
 * ⛔ 這支要擋住的(每條先想「注入什麼它會叫」):
 *   ① 按鈕位置錯(不在盤前檢視右邊)              ② 搬卡漏 id / id 重複(陷阱:搬卡必驗唯一性)
 *   ③ 🚨 名次自己算一份(⛔ 唯一真相 = _regimeStats)  ④ 390px / 橫版溢出
 *   ⑤ 這一頁下操作指令(它只准描述)              ⑥ 選股快照沒載到 → 空殼(要誠實空狀態)
 *   ⑦ 切到 rot 時別格還露出來                     ⑧ 實測數字沒帶來源
 *
 * 測資:真實 gh-pages 的 screener.json(本機 data/ 退回);抓不到就誠實 exit 1(陷阱 #40)。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 300)}`}`); if (!c) fails.push(n); };
if (!fs.existsSync(path.join(ROOT, 'data', 'screener.json'))) { console.log('❌ 沒有 data/screener.json(跑 bash scripts/fetch_testdata.sh)—— ⛔ 不跑假測試'); process.exit(1); }

// ── 靜態 ──
ok('① 按鈕順序:行情 → 盤前檢視 → 💧板塊輪動 → 消息面(注入:搬回最後 → 必紅)',
   /id="subTab_tw2"[\s\S]{0,600}?id="subTab_rot"[\s\S]{0,600}?id="subTab_global2"/.test(SRC));
const MOVED = ['sectorSource', 'sectorIntradayBtn', 'sectorIntradayBar', 'sectorIdxStrip', 'sectorAiResult', 'predictGapTableResult'];
ok('②a 搬過去的 6 個 id 各出現一次(搬卡必驗唯一性)', MOVED.every(id => (SRC.match(new RegExp(`id="${id}"`, 'g')) || []).length === 1));
{
    const i = SRC.indexOf('id="subContent_rot"'), j = SRC.indexOf('id="subContent_global"', i);
    const seg = SRC.slice(i, j);
    ok('②b 那 6 個 id 全部落在 #subContent_rot 裡(⛔ 不可還留在行情格)', i > 0 && j > i && MOVED.every(id => seg.includes(`id="${id}"`)), MOVED.filter(id => !seg.includes(`id="${id}"`)).join(','));
    ok('②c 行情格原位留了指路註解', /市場板塊輪動」卡已搬到第 4 格/.test(SRC));
}
{
    // ⛔ 先剝註解 —— 說明「不可自己從 sector_rot 排」的註解本身就含被禁字串(本專案第 17 次踩)
    const strip = x => x.replace(/^\s*\/\/.*$/gm, '').replace(/[ \t]+\/\/[^\n]*/g, '');
    const fn = strip(SRC.slice(SRC.indexOf('    _ROT_EDGE: {'), SRC.indexOf('    switchSccTab(tab) {')));   // 含 _ROT_EDGE(來源探針寫在那裡)
    ok('③a 🚨 名次只准讀 _regimeStats(),⛔ 不可自己從 sector_rot 排(注入:改讀 _loadSectorRot 排 → 必紅)',
       /_regimeStats\(\)/.test(fn) && !/_loadSectorRot|sector_rot\.json|\bsector_rot\b|\.r20\b/.test(fn), '');   // ⚠️ \b:別把來源名 sector_rotation_probe 誤判成違規
    ok('⑧ 實測數字帶來源探針與窗口', /sector_rotation_probe/.test(fn) && /2022/.test(fn));
    ok('⑤a 原始碼裡不寫操作指令詞', !/(可以進場|可進場|建議買進|建議賣出|可加碼|放心做多|買進這|進場買)/.test(fn));
}

// ── 動態 ──
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const errs = [];
async function boot(viewport) {
    const page = await browser.newPage({ viewport });
    page.on('pageerror', e => { const m = String(e); if (!/Cache|file' is unsupported/.test(m)) errs.push(m.slice(0, 160)); });
    await page.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
    await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => typeof app !== 'undefined' && !!app.switchMarketSubTab, null, { timeout: 25000 });
    await page.waitForTimeout(2500);
    return page;
}
const page = await boot({ width: 390, height: 844 });
const r = await page.evaluate(async () => {
    app.switchAppTab('market'); app.switchMarketSubTab('rot');
    await new Promise(r => setTimeout(r, 3500));
    const vis = id => { const e = document.getElementById(id); return !!e && !e.classList.contains('hidden'); };
    const S = app._regimeStats();
    const truth = S ? [...S.imed.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]) : null;
    const shown = [...document.querySelectorAll('[data-rotrank]')].map(e => e.getAttribute('data-rotind'));
    const lead = document.getElementById('rotLead').innerText.replace(/\s+/g, ' ');
    const card = document.getElementById('rotRankCard').innerText.replace(/\s+/g, ' ');
    window.scrollTo(80, 0);
    return { vis: { idx: vis('subContent_idx'), ad: vis('subContent_advice'), tw: vis('subContent_tw'), rot: vis('subContent_rot'), g: vis('subContent_global') },
             truth, shown, lead, card, scrollX: window.scrollX, m: S ? S.imed.size : 0,
             hasGap: !!document.querySelector('#subContent_rot #predictGapTableResult'), btnRot: !!document.getElementById('subTab_rot') };
});
ok('⑦ 切到 rot:只有 subContent_rot 露出來', r.vis.rot && !r.vis.idx && !r.vis.ad && !r.vis.tw && !r.vis.g, JSON.stringify(r.vis));
ok('③b ⭐⭐ 32 列的順序 = _regimeStats().imed 由強到弱(一字不差)', r.truth && r.shown.length === r.truth.length && r.shown.every((k, i) => k === r.truth[i]), `${r.shown.slice(0, 4)} vs ${r.truth && r.truth.slice(0, 4)}`);
ok('③c 一句話寫的最強/最弱 3 族 = 排名的頭尾 3', r.truth && r.truth.slice(0, 3).every(k => r.lead.includes(k)) && r.truth.slice(-3).every(k => r.lead.includes(k)), r.lead.slice(0, 160));
ok('⑧b 一句話帶實測 +1.44pp 與「避開最弱」那句', /\+1\.44pp/.test(r.lead) && /避開最弱/.test(r.lead), r.lead.slice(0, 200));
ok('⑤b 畫面上不出現操作指令', !/(可以進場|可進場|建議買進|建議賣出|可加碼|放心做多)/.test(r.lead + r.card));
ok('②d 搬過去的美股對標卡就在這一格裡', r.hasGap);
ok('④a 390px 不橫向溢出', r.scrollX <= 2, String(r.scrollX));
ok('⑨ 無 pageerror', errs.length === 0, errs[0] || '');
await page.close();

// ⑥ 空過守門:選股快照抓不到 → 誠實空狀態,⛔ 不留空殼、⛔ 不假造排名
const p2 = await boot({ width: 390, height: 844 });
const e = await p2.evaluate(async () => {
    app._scrData = null; app._scrErr = 'HTTP 404'; app._regCache = null;
    app.switchAppTab('market'); app.switchMarketSubTab('rot');
    await new Promise(r => setTimeout(r, 800));
    return { lead: document.getElementById('rotLead').innerText.replace(/\s+/g, ' '), cardHidden: document.getElementById('rotRankCard').classList.contains('hidden'), n: document.querySelectorAll('[data-rotrank]').length };
});
ok('⑥ 選股快照抓不到 → 一句話說「還沒載入」+ 原因,排名卡藏起、⛔ 沒有任何假名次', /還沒載入/.test(e.lead) && /404/.test(e.lead) && e.cardHidden && e.n === 0, JSON.stringify(e).slice(0, 200));
await p2.close();

// ④b 橫版
const p3 = await boot({ width: 844, height: 390 });
const land = await p3.evaluate(async () => { app.switchAppTab('market'); app.switchMarketSubTab('rot'); await new Promise(r => setTimeout(r, 3000)); window.scrollTo(80, 0); return window.scrollX; });
ok('④b 844×390 橫版不橫向溢出', land <= 2, String(land));
await p3.close();

await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗:${fails.join(' / ')}` : '\n✅ ROTTAB_TEST_PASS');
process.exit(fails.length ? 1 : 0);
