#!/usr/bin/env node
/**
 * 📈📊 V77.1.0 使用者四點 —— 測試
 *   1. 符合進場是否要放在決策裡面 → ⓓ 決策台要有,而且⛔ 不可跟「今天可以買的」混為一談
 *   2. 庫存股上下間隔寬一點        → ⓐ 量 computed 的列高(⛔ 不釘 class 字串)
 *   3. 今天盤前體檢 0 分對嘛        → ⓒ 逐項明細要對得起來,超出量表要說出來
 *   4. 板塊輪動沒有寫取得資料日期時間 → ⓑ 日期 + 採礦時間都要有
 *
 * ⛔ 每一條先想「注入什麼它會叫」(注入紀錄在 docs/DECISIONS.md):
 *   ① 庫存 padding 改回去 ② 板塊輪動拿掉時間 ③ 明細少記一項(加總對不上)
 *   ④ 拿掉超出量表的提醒 ⑤ 候選自己寫死門檻 ⑥ 拿掉「扣完成本全負」的警示 ⑦ idle 不看 fit
 *
 * 測資:本機 data/(screener / today_signals / macro_risk / playbook_edge),沒有就誠實 exit 1。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { rwdShim } from './lib_rwdshim.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
// ⚠️ 原始碼斷言一律先剝註解(本 repo 被「自己寫的註解救活斷言」騙過 6 次)
const strip = x => x.replace(/^\s*\/\/.*$/gm, '').replace(/[ \t]+\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 300)}`}`); if (!c) fails.push(n); };
for (const f of ['screener.json', 'today_signals.json', 'macro_risk.json', 'playbook_edge.json'])
    if (!fs.existsSync(path.join(ROOT, 'data', f))) { console.log(`❌ 沒有 data/${f}(跑 bash scripts/fetch_testdata.sh)—— ⛔ 不跑假測試`); process.exit(1); }

// ── 靜態 ──
{
    const fn = strip(SRC.slice(SRC.indexOf('    async _deckFitScan() {'), SRC.indexOf('    async _deckState() {')));
    ok('ⓓs 候選的門檻一律讀 _EDGE_RULES.gene(⛔ 不可寫死 75 / 3.2)',
       /_EDGE_RULES\.gene/.test(fn) && !/>=\s*75\b/.test(fn) && !/>=\s*3\.2\b/.test(fn), '');
    ok('ⓓs2 黑名單一律走 _ovBlockWhy(⛔ 不在這裡另寫一份)', /_ovBlockWhy\(/.test(fn), '');
    ok('ⓓs3 載不到時 ready=false(⛔ 不可把「抓不到」講成「今天沒有」)', /ready:\s*false/.test(fn) && /out\.ready = true/.test(fn), '');
    const fh = strip(SRC.slice(SRC.indexOf('    _deckFitHtml(F) {'), SRC.indexOf('    async _deckFitScan() {')));
    ok('ⓓs4 成本讀產物 playbook_edge.cost(⛔ 不寫死)', /_pbEdge[\s\S]{0,40}\.cost/.test(fh), '');
    const pp = strip(SRC.slice(SRC.indexOf('        // ③ 開盤方向計分(純公式)'), SRC.indexOf('        const _usClosed = (() =>')));
    // ⭐ `_add` 自己那一行 `s += d;` 是合法的 → 釘「只准有那一處」,⛔ 其餘一律要走 _add
    const nAdd = (pp.match(/(^|\n)\s*s \+=/g) || []).length, nSub = (pp.match(/(^|\n)\s*s -=/g) || []).length;
    ok('ⓒs 盤前分數每一筆都走 _add 記錄(⛔ 不可再有裸的 s += / s -=)',
       /_pp\.push/.test(pp) && nAdd === 1 && nSub === 0, `s+= ${nAdd} 處 ・s-= ${nSub} 處`);
    const idl = strip(SRC.slice(SRC.indexOf('            idle.innerHTML = ('), SRC.indexOf('            idle.innerHTML = (') + 400));
    ok('ⓔs 「今天不用做」要把符合進場算進去(⛔ 否則同頁一邊列股票一邊說沒事)', /st\.fit/.test(idl), idl.slice(0, 140));
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errs = [];
page.on('pageerror', e => { const m = String(e); if (!/Cache|file' is unsupported/.test(m)) errs.push(m.slice(0, 160)); });
await page.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app.analyze, null, { timeout: 25000 });
await page.waitForTimeout(3000);
// 🚨 沙箱沒有 Tailwind → 量幾何一定要先注入 shim(陷阱 #40),⛔ 不可複製第二份
await page.evaluate(rwdShim);
{
    // ⭐ shim 自己沒生效的話,底下量到的幾何全是假的 → 直接當紅燈(⛔ 不是印個警告繼續跑)
    const shimBad = await page.evaluate(() => window.__rwdShimBad || []);
    ok('🧩 版面 shim 全部生效(⛔ 沒生效的話幾何量到的是假的)', shimBad.length === 0, JSON.stringify(shimBad).slice(0, 200));
}

// ⓐ 庫存列高
{
    const r = await page.evaluate(() => {
        app.inventory = [{ symbol: '2330', name: '台積電', shares: 1, cost: 100 }, { symbol: '2327', name: '國巨', shares: 1, cost: 100 }];
        app.switchAppTab('inv');
        try { app.renderInventory(); } catch (_) {}
        const rows = [...document.querySelectorAll('[data-inv-sym]')];
        return rows.slice(0, 2).map(e => { const c = getComputedStyle(e); return { pt: parseFloat(c.paddingTop), pb: parseFloat(c.paddingBottom), h: +e.getBoundingClientRect().height.toFixed(1) }; });
    });
    ok('ⓐ 空過守門:庫存列要真的渲染得出來(≥2 列)', r.length >= 2, JSON.stringify(r));
    // ⛔ 釘「用意」(上下要有呼吸空間),⛔ 不釘 py-2.5 這個 class 字串
    ok('ⓐ2 每一列上下 padding ≥ 8px(舊版 4px 太擠)', r.length >= 2 && r.every(x => x.pt >= 8 && x.pb >= 8), JSON.stringify(r));
}

// ⓑ 板塊輪動的日期 + 時間
{
    const r = await page.evaluate(async () => {
        app.switchAppTab('market');
        try { await app._renderRotTab(); } catch (_) {}
        const el = document.getElementById('rotLead');
        return { txt: (el && el.innerText || '').replace(/\s+/g, ' '), upd: (app._scrData || {}).updated || '' };
    });
    ok('ⓑ 空過守門:板塊輪動頁首要有內容', r.txt.length > 40, r.txt.slice(0, 120));
    ok('ⓑ2 有「資料日期」', /\d{2}\/\d{2}\(/.test(r.txt), r.txt.slice(-180));
    // 📅 時間是另一件事(那份名次用哪天收盤算 vs 採礦幾點跑完)
    ok('ⓑ3 有「採礦時間」(⛔ 只有日期不夠)', /採礦/.test(r.txt) && /\d{1,2}:\d{2}/.test(r.txt), r.txt.slice(-180));
}

// ⓒ 盤前體檢明細
{
    const r = await page.evaluate(async () => {
        app.switchAppTab('market');
        try { await app.fetchMacroData?.(); } catch (_) {}
        return new Promise(res => setTimeout(() => {
            const C = app._preOpenCalc || null;
            const det = document.querySelector('[data-ppdet]');
            if (det) det.open = true;   // ⚠️ 關著的 <details> 用 innerText 讀不到內容(card_inventory 踩過同一個坑)
            res({ C, rows: document.querySelectorAll('[data-ppf]').length, clampEl: !!document.querySelector('[data-ppclamp]'),
                  txt: det ? det.innerText.replace(/\s+/g, ' ') : '' });
        }, 9000));
    });
    ok('ⓒ 空過守門:因子明細要有 ≥10 項', !!r.C && r.C.parts.length >= 10 && r.rows >= 10, JSON.stringify({ n: r.C && r.C.parts.length, rows: r.rows }));
    const sum = r.C ? Math.round(r.C.parts.reduce((a, x) => a + x.d, 0) * 10) / 10 : null;
    ok('ⓒ2 逐項加總 == 實際分數(⛔ 明細漏記就會對不上)', sum !== null && Math.abs(sum - r.C.s) < 0.051, `逐項 ${sum} vs s ${r.C && r.C.s}`);
    ok('ⓒ3 顯示分數 = clamp(50 + s×5)', !!r.C && r.C.sPct === Math.max(0, Math.min(100, Math.round(50 + r.C.s * 5))), JSON.stringify({ s: r.C && r.C.s, sPct: r.C && r.C.sPct }));
    // ⭐ 決定性的一條:夾到上下限時**一定要說出來**,否則「剛好到底」跟「遠遠超過」長得一樣
    ok('ⓒ4 超出量表時要明說(clamped → 畫面要有那段提醒)', !r.C || !r.C.clamped || r.clampEl, `clamped=${r.C && r.C.clamped} el=${r.clampEl}`);
    ok('ⓒ5 明細裡要寫出原始分(⛔ 不可只顯夾過的)', !r.C || !r.C.clamped || r.txt.includes(String(r.C.raw)), r.txt.slice(0, 200));
}

// ⓓⓔ 決策台的符合進場
{
    const r = await page.evaluate(async () => {
        app.switchAppTab('desk');
        await app.renderDeck();
        const F = await app._deckFitScan();
        const d = document.querySelector('[data-deckfit]');
        const buy = document.getElementById('deckBuy'), idle = document.getElementById('deckIdle');
        return { F: { n: F.list.length, scanned: F.scanned, bull: F.bullSyms, gene: F.geneN, ready: F.ready },
                 syms: F.list.map(x => String(x.s)), exps: F.list.map(x => +x.exp),
                 has: !!d, rows: document.querySelectorAll('[data-deckfitrow]').length,
                 costWarn: !!document.querySelector('[data-deckfitcost]'),
                 txt: d ? d.innerText.replace(/\s+/g, ' ') : '',
                 buyTxt: (buy && buy.innerText || '').replace(/\s+/g, ' '),
                 idleLen: (idle && idle.innerHTML || '').length };
    });
    ok('ⓓ 空過守門:掃到的母體要合理(≥1000 檔、🧬 ≥10 檔)', r.F.ready && r.F.scanned >= 1000 && r.F.gene >= 10, JSON.stringify(r.F));
    ok('ⓓ2 決策台要有「符合進場」那一段', r.has, r.buyTxt.slice(-150));
    ok('ⓓ3 列出的檔數 == 掃出來的檔數(⛔ 顯示端不另外截斷)', r.rows === r.F.n, `畫面 ${r.rows} vs 掃出 ${r.F.n}`);
    ok('ⓓ4 要寫明它跟「今天可以買的」不是同一個問題', /不是同一個問題/.test(r.txt), r.txt.slice(0, 150));
    ok('ⓓ5 要寫明這是候選、最終判定在個股頁(⛔ 這裡算不出空頭守門)', /候選/.test(r.txt) && /個股頁/.test(r.txt), r.txt.slice(-250));
    // 💸 扣成本後為負的一定要講(⛔ 不可列一排股票卻不說它賺不到手續費)
    const allNeg = r.exps.length > 0 && r.exps.every(e => e - 0.44 < 0);
    ok('ⓓ6 每一列都要寫「扣掉來回成本之後」', r.rows === 0 || /扣掉來回成本/.test(r.txt), r.txt.slice(0, 250));
    ok('ⓓ7 全部賺不到成本時要明說', !allNeg || r.costWarn, `allNeg=${allNeg} warn=${r.costWarn}`);
    ok('ⓔ 有候選時⛔ 不可同時顯示「今天不用做」', r.F.n === 0 || r.idleLen === 0, `fit=${r.F.n} idle=${r.idleLen}`);
}

ok('⑨ 無 pageerror', errs.length === 0, errs.join(' | '));
await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條沒過` : '\n✅ 全部通過');
process.exit(fails.length ? 1 : 0);
