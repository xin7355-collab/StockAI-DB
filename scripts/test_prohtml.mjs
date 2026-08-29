#!/usr/bin/env node
/**
 * 🛰️ 產業作戰室 PRO(pro.html,V74.0.1)測試
 *
 * 使用者:「以散戶救星當作資料庫,新增一個介面,不顯示在散戶救星裡面,完成後給我一個網址」
 *         + 進階產業估值系統(防幻覺)+ AI 產業鏈儀表板重新設計。
 *
 * ⛔ 要釘死的十件事:
 *   ① 部署佈線:pro.html 必須同時接進 deploy_pages.yml 與 daily_miner.yml **各 4 處**
 *      (paths/checkout・cp 到暫存・cp 回來・git add)—— 少 git add 就是 V69.8.7 圖示那種
 *      「放回去了卻沒 commit,每天被洗掉、零錯誤訊息」。
 *   ② ⛔ 不顯示在散戶救星裡面:index.html 不可出現 pro.html 連結。
 *   ③ 估值數學:隱含區間 = 年化EPS(現價÷官方PE) × 近3年 P5/中位/P95 —— 數字要對。
 *   ④ 虧損股/無 PE 帶 → 誠實說「不適用」,⛔ 不硬給區間;prompt 表格填「—」。
 *   ⑤ prompt 必含防幻覺約束(禁目標價/買賣評等)+ 「不是分析師預估」的誠實標示。
 *   ⑥ 畫面與 prompt 不可出現 NaN/undefined。
 *   ⑦ AI 鏈表格 67 檔、排序有作用、null 一律排最後(null-sort 陷阱)。
 *   ⑧ 燈號鐵則:不可用 🔴🟢 表品質(regex 必加 u flag —— surrogate 陷阱)。
 *   ⑨ peRank 分段插值:pe = 中位 → 50、pe ≤ 最低 → 0、pe ≥ 最高 → 100。
 *   ⑩ 主 App(index.html)完全沒被改到 —— 這是獨立頁。
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 240)}`}`); if (!c) fails.push(n); };

// ① 部署佈線(兩條路徑各 4 處)
for (const [f, min] of [['.github/workflows/deploy_pages.yml', 4], ['.github/workflows/daily_miner.yml', 4]]) {
    const y = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const n = (y.match(/pro\.html/g) || []).length;
    ok(`① ${f} 含 pro.html ≥${min} 處(paths/checkout・cp・cp回・git add)`, n >= min, n);
    ok(`①b ${f} 有 git add pro.html(⛔ 少了=每天被洗掉)`, /git add -f pro\.html/.test(y));
}
ok('①c deploy_pages 的 push paths 有 pro.html(改它才會觸發部署)',
   /- 'pro\.html'/.test(fs.readFileSync(path.join(ROOT, '.github/workflows/deploy_pages.yml'), 'utf8')));
// ② 不顯示在散戶救星裡面
ok('② ⛔ index.html 不可出現 pro.html 連結(使用者明示不掛在 App 內)',
   !/pro\.html/.test(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')));

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|Access to fetch/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'pro.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__pageComplete === true && !!window.PRO, null, { timeout: 15000 });

const R = await page.evaluate(async () => {
    // ── stub 資料庫(⛔ 不打網路)──
    PRO._names = { '2382': '廣達', '1111': '假虧損', '2222': '假無帶' };
    PRO._cache['data/screener.json'] = {
        data_date: '2026-08-28',
        cols: ['c', 'pe', 'chg', 'yoy', 'gm', 'f5', 't5', 'chg20', 'f10'],
        rows: {
            '2382': [100, 10, 1.5, 20, 15, 500, 300, 5, 800],
            '1111': [50, null, -2, -5, 3, -100, null, null, null],
            '2222': [80, 16, 0.5, 8, 22, 0, 0, 2, 10],
        },
        ind: { '2382': '25' },
    };
    PRO._cache['data/pe_band.json'] = {
        updated: '2026-08-14T01:00:00Z',
        data: { '2382': { pe: 10, pct: 25, lo: 6, hi: 24, p5: 8, p25: 10, med: 12, p75: 16, p95: 20, n: 750, d: '2026-08-13' } },
    };
    PRO._cache['data/industry_pe.json'] = { industries: { '25': { median_pe: 18.9 } } };
    document.getElementById('inIndustry').value = '測試產業';
    document.getElementById('inCodes').value = '2382, 1111, 2222';
    document.getElementById('inNews').value = '測試動態';
    await PRO.runValuation();
    const out = document.getElementById('valOut').innerText;
    const prompt = PRO.buildPrompt();
    const r2382 = PRO._valRows.find(r => r.code === '2382');
    // ⑨ peRank
    const b = PRO._cache['data/pe_band.json'].data['2382'];
    const ranks = [PRO.peRank(12, b), PRO.peRank(5, b), PRO.peRank(30, b), PRO.peRank(8, b)];
    // ── AI 鏈 ──
    // 給兩檔特殊值驗排序:2330 yoy 最大、4585 yoy null(要排最後)
    const scr = PRO._cache['data/screener.json'];
    for (const s of PRO.CHAIN.stocks) scr.rows[s[0]] = scr.rows[s[0]] || [100, 15, 0, 10, 20, 0, 0, 1, 0];
    scr.rows['2330'] = [2400, 30, 1, 999, 60, 0, 0, 9.7, -1500];
    scr.rows['4585'] = [200, 50, 1, null, 30, 0, 0, null, 0];
    // ⚠️ 一定要有一檔**負值** —— 否則「null 當 0」的壞排序也剛好把 null 排最後,注入驗證會漏(測資盲點)
    scr.rows['2317'] = [180, 12, -1, 5, 6, 0, 0, -3, 0];
    PRO.switchTab('chain');
    await new Promise(r => setTimeout(r, 50));
    PRO._sortK = 'yoy'; PRO._sortD = -1; await PRO.renderChain();
    const rows1 = [...document.querySelectorAll('#chainBody tr')];
    const firstCode = rows1[0] ? rows1[0].innerText.trim().slice(0, 4) : '';
    const lastCell = rows1.length ? rows1[rows1.length - 1].innerText : '';
    PRO._sortK = 'chg20'; PRO._sortD = -1; await PRO.renderChain();
    const rows2 = [...document.querySelectorAll('#chainBody tr')];
    const last2 = rows2.length ? rows2[rows2.length - 1].innerText : '';
    const chainTxt = document.getElementById('tabChain').innerText;
    return {
        out, prompt, nCards: (document.getElementById('valOut').innerHTML.match(/class="vcard"/g) || []).length,
        lo: r2382.lo, mid: r2382.mid, hi: r2382.hi, eps: r2382.eps, rank: r2382.rank, peer: r2382.peer,
        ranks, rowsN: rows1.length, firstCode, lastHasNull: /—/.test(lastCell), last2,
        lamp: /[🔴🟢]/u.test(document.body.innerHTML),
        nan: /NaN|undefined/.test(out) || /NaN|undefined/.test(prompt),
        poolNamed: /台積電/.test(chainTxt),
    };
});
await browser.close();

// ③ 數學
ok('③ 年化EPS = 100/10 = 10', R.eps === 10, R.eps);
ok('③b 隱含區間 = 10×(8/12/20) = 80/120/200', R.lo === 80 && R.mid === 120 && R.hi === 200, [R.lo, R.mid, R.hi]);
ok('③c PE 位階:pe=10 落在 P25 → 25%', R.rank === 25, R.rank);
ok('③d 同業中位 PE 讀 industry_pe(18.9)', R.peer === 18.9, R.peer);
ok('⑨ peRank:中位→50、帶外低→0、帶外高→100、P5→5', R.ranks[0] === 50 && R.ranks[1] === 0 && R.ranks[2] === 100 && R.ranks[3] === 5, R.ranks);
// ④ 不適用要誠實
ok('④ 虧損股(無官方 PE)→ 顯「不適用/不硬給」', /不適用|不硬給/.test(R.out), R.out.slice(0, 300));
ok('④b 三檔都有卡(⛔ 不可把算不出來的整檔藏掉)', R.nCards === 3, R.nCards);
ok('④c prompt 表格對虧損股填 —', /\| 1111 \| 假虧損 \| 50\.0 \| — \| — \|/.test(R.prompt), R.prompt.split('\n').filter(l => l.includes('1111')).join(''));
// ⑤ prompt 內容
ok('⑤ prompt 含防幻覺約束(禁目標價/買賣評等)', /禁止.{0,30}目標價/.test(R.prompt) && /買賣評等/.test(R.prompt));
ok('⑤b prompt 誠實標示 EPS 是近4季年化、不是分析師預估', /不是分析師預估/.test(R.prompt) && /年化EPS/.test(R.prompt));
ok('⑤c prompt 有循環股警語(獲利頂峰時 PE 最低)', /循環股.{0,40}PE 最低/.test(R.prompt));
ok('⑤d prompt 代入真實數字(2382 廣達 100.0 / 8.0 / 12.0 / 20.0)', /\| 2382 \| 廣達 \| 100\.0 \| 10\.00 \| 8\.0 \/ 12\.0 \/ 20\.0 \| 25% \| 18\.9 \| 20\.0 \| 15\.0 \| \+800 \|/.test(R.prompt),
   R.prompt.split('\n').filter(l => l.includes('2382')).join(''));
// ⑥⑧
ok('⑥ 畫面與 prompt 無 NaN/undefined', !R.nan);
ok('⑧ 燈號鐵則:不可用 🔴🟢(u flag)', !R.lamp);
// ⑦ AI 鏈
ok('⑦ 戰情表 67 檔', R.rowsN === 67, R.rowsN);
ok('⑦b 按 YoY 排序 → 2330(stub 999)排第一', R.firstCode === '2330', R.firstCode);
ok('⑦c null 排最後(4585 chg20=null)', /4585/.test(R.last2), R.last2.slice(0, 60));
ok('⑦d 利潤池有中文名', R.poolNamed);
ok('⑩ 載入無 pageerror', errs.length === 0, errs.join(' | '));

console.log();
console.log(fails.length ? `❌ ${fails.length} 條失敗` : '✅ PROHTML_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
