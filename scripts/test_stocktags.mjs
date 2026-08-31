#!/usr/bin/env node
/**
 * 🏷️ V74.4.8 個股題材標籤(`stock_tags.json` → `_getStockConcepts` / `_renderConceptRow`)
 *
 * 背景:使用者截圖 —— 南亞科(2408)的標籤是「#台塑 #Windows11 #美中貿易戰受惠
 *   #蘋果供應商 #Smart TV」,一個跟記憶體有關的都沒有。真因是 megatime 的題材定義
 *   凍結在 2021 年。→ 改成採礦端每天用「扣掉大盤的殘差相關」重算。
 *
 * ⛔ 六條釘死(每一條都用注入缺陷驗過):
 *   ① 種子題材(人工確認)一定要顯示,而且排在最前面
 *   ② 自動連動的要**長得不一樣**且帶相關數字 —— ⛔ 把「它是」跟「它跟著動」畫成一樣 = 說謊
 *   ③ 🚨 過時題材(Smart TV / Windows11 / 元宇宙 / 五倍券…)一律不可出現
 *   ④ 👑 龍頭優先用採礦端每天算的,⛔ 寫死的 _LEADER_MAP 只能當後備
 *   ⑤ 題材與 megatime 概念重複時只留一個(⛔ 不可同一個名字出現兩次)
 *   ⑥ 讀不到 stock_tags.json 要**退回舊行為**,⛔ 不可整列消失
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const MINER = fs.readFileSync(path.join(ROOT, 'miner.py'), 'utf8');
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${e}`}`); if (!c) fails++; };

// ── 靜態:採礦端 ──
ok('⑦a 採礦端有 build_stock_tags 且**獨立呼叫**(⛔ 不綁在別人的 try 裡)',
    /def build_stock_tags\(\)/.test(MINER) && /build_sector_rotation\(\)\n(?:.*\n){0,3}?\s*build_stock_tags\(\)/.test(MINER));
ok('⑦b 🚨 相關性必須**扣掉大盤**(不扣的話多頭裡每檔都跟每個題材高相關 = 零鑑別度)',
    /out\[d\] = r - mret\[d\]/.test(MINER));
ok('⑦c 🚨 算某一檔時要把它自己從題材中位數裡拿掉(⛔ 否則種子成員拿到灌水的自我相關)',
    /_theme_series\(k, sym\) if sym in th_groups\[k\]/.test(MINER));
ok('⑦d 門檻用**當天分位數**不是憑空寫死(P90 + 下限,兩個都要寫進輸出)',
    /p90 = best\[int\(len\(best\) \* 0\.90\)\]/.test(MINER) && /'thr': thr, 'p90'/.test(MINER));
ok('⑦e 👑 龍頭只能從**種子**挑,而且 key 用題材(⛔ 用代號當 key 會被蓋掉)',
    /for x in th_groups\[k\] if x in amt20/.test(MINER) && /lead\[k\] = ranked\[0\]\[1\]/.test(MINER));
ok('⑦f ⛔ ETF 不進母體(使用者明示)', /not s\.startswith\('00'\)/.test(MINER));
ok('⑦g 產物有被 artifact 收(⛔ 沒收 = 每天被洗掉且零錯誤訊息)',
    /data\/stock_tags\.json/.test(fs.readFileSync(path.join(ROOT, '.github/workflows/daily_miner.yml'), 'utf8')));

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!(window.app || typeof app !== 'undefined'), null, { timeout: 30000 });
await page.waitForTimeout(1500);

const R = await page.evaluate(async () => {
    const A = window.app || app;                       // 陷阱 #5:const app 不掛 window
    const out = {};
    A.allStockList = [{ stock_id: '2408', industry_category: '半導體業' },
                      { stock_id: '1301', stock_name: '台塑' }, { stock_id: '2393', stock_name: '億光' }];
    A._grpNameSet = null;
    // 測資照**真實產物格式**(⛔ 憑印象編會測不到真的問題 —— 陷阱 #40)
    A._tagsCache = {
        updated: 'x', data_date: '2026-08-31', win: 120, thr: 0.45, p90: 0.432, universe: 2319,
        names: { mem: '記憶體', pcb: 'ABF 載板/PCB', sat: '低軌衛星' },
        seed: { mem: ['2408', '2344'], pcb: ['3037'], sat: ['3105'] },
        by_stock: { '2408': { s: ['mem'], n: [] }, '2451': { s: [], n: [['mem', 0.538]] } },   // 1234 刻意沒有題材 → 驗補位
        lead: { mem: '2408', pcb: '3037', sat: '3105' },
    };
    A._conceptCache = { updated: '2026-09-01T00:00:00+08:00',
        by_stock: { '2408': ['Smart TV', 'Windows11', '美中貿易戰受惠', '蘋果供應商', '台塑', '記憶體'],
                    '2451': ['元宇宙', '五倍券', '電動車'],
                    '1234': ['元宇宙', '台塑', '電動車', '車用電子相關'] },   // 沒有題材 → 走補位
        groups: {} };
    A._conceptSizeMap = null;
    const g1 = A._getStockConcepts('2408');
    out.lead2408 = g1.leader; out.tags2408 = g1.tags.map(t => `${t.n}${t.seed ? '(種)' : t.old ? '(舊)' : '(連' + t.c + ')'}`);
    // ④ 用一檔**不在寫死 _LEADER_MAP 裡**的(3105 穩懋)→ 才證明得了走的是採礦端那條路
    out.lead3105 = A._getStockConcepts('3105').leader;
    out.inOldMap3105 = !!A._LEADER_MAP['3105'];
    const g2 = A._getStockConcepts('2451');
    out.tags2451 = g2.tags.map(t => `${t.n}${t.seed ? '(種)' : t.old ? '(舊)' : '(連' + t.c + ')'}`);
    // ③b 沒有題材的股票才走 megatime 補位(⛔ 有題材時不補 —— 舊來源會稀釋新標籤)
    const g3 = A._getStockConcepts('1234');
    out.tags1234 = g3.tags.map(t => t.n);
    // 渲染
    document.body.insertAdjacentHTML('beforeend', '<div id="stockConceptRow"></div>');
    A.currentSymbolId = '2408';
    A._renderConceptRow('2408');
    const el = document.getElementById('stockConceptRow');
    out.html2408 = el.innerHTML; out.txt2408 = el.innerText;
    A.currentSymbolId = '2451'; A._renderConceptRow('2451');
    out.txt2451 = el.innerText; out.html2451 = el.innerHTML;
    // ⑥ 讀不到採礦檔 → 退回舊行為(⛔ 不可整列消失)
    A._tagsCache = null;
    A.currentSymbolId = '2408'; A._renderConceptRow('2408');
    out.fallbackTxt = document.getElementById('stockConceptRow').innerText;
    out.fallbackLead = A._getStockConcepts('2408').leader;
    return out;
});
await browser.close();

ok('① 種子題材要出現而且排最前面(南亞科 → #記憶體)',
    R.tags2408[0] === '記憶體(種)', R.tags2408.join(' / '));
ok('② 自動連動要帶相關數字、而且跟種子分開標(2451 → 記憶體 連動 0.538)',
    R.tags2451.some(t => t === '記憶體(連0.538)') && /連動54|連動 54/.test(R.html2451.replace(/\s+/g, '')),
    R.tags2451.join(' / '));
ok('②b 連動標籤的樣式要跟種子不同(虛線)且 tip 要寫「不是業務屬於它」',
    /border-dashed/.test(R.html2451) && /跟著動/.test(R.html2451));
ok('③ 🚨 過時題材一律不可出現(Smart TV / Windows11 / 元宇宙 / 五倍券 / 美中貿易戰)',
    !/Smart\s*TV|Windows11|元宇宙|五倍券|美中貿易戰/.test(R.txt2408 + ' ' + R.txt2451),
    (R.txt2408 + ' | ' + R.txt2451).slice(0, 160));
ok('③b 沒有題材的股票 → 仍然有效的舊概念要補位(電動車),⛔ 但不可補過時的/集團名',
    R.tags1234.includes('電動車') && !R.tags1234.includes('元宇宙') && !R.tags1234.includes('台塑'),
    R.tags1234.join(' / '));
ok('③c ⛔ 已經有題材標籤的就不補 megatime(舊來源會稀釋新標籤)',
    !R.tags2451.some(t => /\(舊\)/.test(t)), R.tags2451.join(' / '));
ok('③d 🏢 集團/公司名(台塑)要被當成非題材濾掉 —— 判準是「它是某檔股票的名字」',
    !/台塑/.test(R.txt2408 + R.tags1234.join('')), R.txt2408);
ok('④ 👑 龍頭走採礦端那條路 —— 用一檔**不在寫死表裡**的(3105 → 低軌衛星龍頭)才證明得了',
    R.inOldMap3105 === false && R.lead3105 === '低軌衛星龍頭',
    `舊表有3105=${R.inOldMap3105} lead=${R.lead3105}`);
ok('④b 有採礦值時要蓋過寫死表(2408 在舊表裡也是記憶體龍頭,這條只驗有顯示)',
    /👑 記憶體龍頭/.test(R.txt2408), String(R.lead2408));
ok('⑤ 題材與舊概念同名時只留一個(⛔ #記憶體 不可出現兩次)',
    (R.txt2408.match(/#記憶體/g) || []).length === 1, R.txt2408);
ok('⑥ 讀不到採礦檔 → 退回舊行為,⛔ 不可整列消失(產業別與後備龍頭仍在)',
    /半導體業/.test(R.fallbackTxt) && R.fallbackLead === '記憶體龍頭', R.fallbackTxt.slice(0, 80));
ok('⑥b 🚧 空過守門:兩檔都真的渲染出東西了(⛔ 否則上面幾條是假通過)',
    R.txt2408.length > 8 && R.txt2451.length > 4, `${R.txt2408.length}/${R.txt2451.length}`);

console.log(fails ? `❌ ${fails} 條失敗` : '✅ STOCKTAGS_PASS(全部通過)');
process.exit(fails ? 1 : 0);
