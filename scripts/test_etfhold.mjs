#!/usr/bin/env node
/**
 * 🐢 V77.6.8 「手上的 ETF ⛔ 不套個股的三條出場」守門
 *
 * 使用者截圖:決策台「今天要賣的」把 0050 與 009816 列成「⏳ 抱滿 40 個交易日了 → 今天尾盤賣」。
 * 真因:`_invExitScan` / `_exitDistance` / `_ovDecide` / `_exitMode` 一處都沒有 `_isEtfSym` 分支 →
 *   手上任何 00xx 都被套上替 🧬 高波動**個股**回測出來的三條出場;而本站對 ETF 自己的實測是反的
 *   (`etf_signal_probe`:63 檔 ETF 沒有任何買賣訊號贏過買了放著;16 年 0050 含息 > 這套)。
 *   ⚠️ `auto_trade.py` 只賣自己買的部位(⛔ 不碰手動庫存)→ 這是畫面講錯,錢沒有危險。
 *
 * 釘住的用意:
 *   ⓐ `_invExitScan`:ETF ⛔ 不進 out/near/far,另列 `_invExitEtf`;個股照舊
 *   ⓑ 決策台:ETF 那一列⛔ 不可跟「抱滿」同一列;有 `[data-exitetf]` 且講「買了放著」;「今天要賣的(N 檔)」的 N 不算 ETF
 *   ⓒ `_ovDecide('0050')`:state `etfhold`、badge 含「ETF」,⛔ 不含「尾盤賣」「守住」
 *   ⓓ `_exitDistance('0050')` 回 `etf:true` 的空三條(⛔ 不回 null —— null 在呼叫端是「還沒辦法幫你看」)
 *   ⓔ 決定性對照:同一份 K 線把代號換成 '2330' → 必須出現「抱滿 40」(分流靠代號,不靠資料)
 *   ⓕ 數字讀常數:改 `_ETF_HOLD_EDGE.n` 畫面要跟著變(⛔ 不寫死)
 *   ⓖ 靜態:`_exitMode` 對 ETF 不進出場狀態;文案只有 `_etfHoldNote` 一份(⛔ 消費端不可自己再寫一份「買了放著」數字)
 * 注入(逐一確認會紅):拿掉 `_invExitScan` 那行 continue → ⓐⓑ 紅;拿掉 `_ovDecide` 的 etfNote 分支 → ⓒ 紅
 */
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
let chromium;
try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); }
catch (_) { ({ chromium } = await import('playwright')); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = process.env.INDEX_HTML || path.join(ROOT, 'index.html');
const src = fs.readFileSync(HTML, 'utf8');
const CODE = src.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 260)}`}`); if (!c) fails.push(n); };

// ── ⓖ 靜態 ──
{
    const i = CODE.indexOf('this._exitMode = {');
    const blk = CODE.slice(Math.max(0, i - 900), i);
    ok('ⓖ 靜態:`_exitMode` 對 ETF ⛔ 不進出場狀態(`cost > 0 && !_exEtf`)', /cost > 0 && !_exEtf/.test(blk) && /_exEtf = this\._isEtfSym\(this\.currentSymbolId\)/.test(blk), '');
    const n = (CODE.match(/_etfHoldNote\(/g) || []).length;
    ok('ⓖb 消費端都走 `_etfHoldNote`(定義 1 + 呼叫 ≥ 4:掃描 / 決策台 / 主卡 / 報告 §11)', n >= 5, `出現 ${n} 次`);
    // 「63 檔」這種數字只准出現在常數裡,⛔ 不可寫死在別處
    // ⚠️ `_CHANGELOG` 是歷史紀錄(V77.5.7 那筆本來就寫著 63 檔)→ 排除 `v: 'V…'` 那種行;要擋的是**顯示邏輯**裡的寫死
    const hits = CODE.split('\n').filter(l => /63 檔/.test(l) && !/_ETF_HOLD_EDGE|etf_signal_probe|E\.n|\{ v: 'V\d/.test(l));
    ok('ⓖc ⛔ ETF 實測數字不可寫死在文案裡(只在 `_ETF_HOLD_EDGE` / 由 `E.n` 帶入)', hits.length === 0, hits.slice(0, 2).join(' | '));
}

const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined|Tailwind/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + HTML, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._exitDistance && !!app.renderDeck && !!app._invExitScan, null, { timeout: 30000 });

const R = await page.evaluate(async () => {
    const out = {};
    // 60 根:前 40 根盤整、後 20 根緩漲;買進日在第 5 根 → 抱了 55 個交易日(> 40 = 個股會判「抱滿」)
    const mk = () => { const rows = []; for (let i = 0; i < 60; i++) { const c = i < 40 ? 95 + (i % 5) : 100 + (i - 39) * 0.5; const d = new Date(Date.UTC(2026, 5, 1) + i * 86400000).toISOString().slice(0, 10).replace(/-/g, '/'); rows.push({ date: d, open: c, high: c + 1, low: c - 1, close: c, volume: 1000 }); } return rows; };
    const rows = mk();
    const buyDate = rows[4].date.replace(/\//g, '-');
    app.currentSymbolId = '9999';
    const inv = [{ symbol: '0050', cost: 90, shares: 3, buyDate }, { symbol: '2330', cost: 90, shares: 1, buyDate }];
    app._getInventory = () => inv;
    app.getStockName = s => ({ '0050': '元大台灣50', '2330': '台積電' }[s] || s);
    await app.idb.put('proTerm_kline_0050', { data: rows, ts: Date.now() });
    await app.idb.put('proTerm_kline_2330', { data: rows, ts: Date.now() });
    // ⓐ
    app._invExitAt = 0;
    const sell = await app._invExitScan();
    out.sellSyms = sell.map(x => x.sym); out.etf = (app._invExitEtf || []).map(x => x.sym);
    out.nearSyms = (app._invExitNear || []).map(x => x.sym); out.farSyms = (app._invExitFar || []).map(x => x.sym); out.skip = app._invExitSkip || [];
    // ⓓ / ⓔ
    const ed0 = app._exitDistance(rows, '0050'), ed2 = app._exitDistance(rows, '2330');
    out.ed0 = ed0 ? { etf: ed0.etf, level: ed0.level, lines: ed0.lines.length, maxd: ed0.maxd } : null;
    out.ed2 = ed2 ? { etf: ed2.etf, level: ed2.level, due: ed2.maxd && ed2.maxd.due, n: ed2.maxd && ed2.maxd.n } : null;
    // ⓒ
    const d0 = app._ovDecide(rows, '0050'), d2 = app._ovDecide(rows, '2330');
    out.d0 = d0 ? { state: d0.state, badge: d0.badge, why: String(d0.why || '').slice(0, 400), plan0: d0.plan && d0.plan[0] && d0.plan[0].t } : null;
    out.d2 = d2 ? { state: d2.state, badge: d2.badge } : null;
    // ⓑ 決策台
    app._invExitAt = 0;
    try { await app.renderDeck(); } catch (e) { out.deckErr = String(e); }
    const etfBox = document.querySelector('[data-exitetf]');
    out.etfBox = etfBox ? { n: etfBox.getAttribute('data-exitetf'), txt: etfBox.innerText.replace(/\s+/g, ' ').slice(0, 300) } : null;
    const rows2330 = document.querySelector('[data-exitrow="2330"]'), rows0050 = document.querySelector('[data-exitrow="0050"]');
    out.row2330 = rows2330 ? rows2330.innerText.replace(/\s+/g, ' ').slice(0, 200) : null;
    out.row0050 = rows0050 ? rows0050.innerText.replace(/\s+/g, ' ').slice(0, 200) : null;
    const hdr = [...document.querySelectorAll('div')].map(d => d.textContent || '').find(t => /今天要賣的\(\d+ 檔\)/.test(t) && t.length < 40) || '';
    out.hdr = hdr;
    // ⓕ 數字讀常數
    const n0 = app._ETF_HOLD_EDGE.n; app._ETF_HOLD_EDGE.n = 99;
    out.note99 = app._etfHoldNote('0050').html.includes('99 檔');
    app._ETF_HOLD_EDGE.n = n0;
    out.noteStock = app._etfHoldNote('2330');
    return out;
});
await browser.close();

ok('🚧 空過守門:掃到兩檔庫存(0050 + 2330),⛔ 沒有被「K 線不足」跳過', R.skip.length === 0 && (R.sellSyms.length + R.nearSyms.length + R.farSyms.length + R.etf.length) === 2, JSON.stringify({ skip: R.skip, sell: R.sellSyms, etf: R.etf }));
ok('ⓐ 0050 ⛔ 不進 out/near/far,另列 `_invExitEtf`', !R.sellSyms.includes('0050') && !R.nearSyms.includes('0050') && !R.farSyms.includes('0050') && R.etf.includes('0050'), JSON.stringify({ sell: R.sellSyms, etf: R.etf }));
ok('ⓐb 2330(同一份 K 線)照舊:抱了 55 天 → 進「今天要賣的」', R.sellSyms.includes('2330'), JSON.stringify(R.sellSyms));
ok('ⓓ `_exitDistance(\'0050\')` 回 `etf:true` 的空三條(⛔ 不是 null)', !!(R.ed0 && R.ed0.etf === true && R.ed0.level === 'etf' && R.ed0.lines === 0 && !R.ed0.maxd), JSON.stringify(R.ed0));
ok('ⓔ 決定性對照:同一份 K 線、代號 2330 → 抱滿 40 天到期(分流靠代號不靠資料)', !!(R.ed2 && !R.ed2.etf && R.ed2.due === true && R.ed2.n === 40), JSON.stringify(R.ed2));
ok('ⓒ `_ovDecide(\'0050\')` state=etfhold、badge 含 ETF', !!(R.d0 && R.d0.state === 'etfhold' && /ETF/.test(R.d0.badge)), JSON.stringify(R.d0 && { s: R.d0.state, b: R.d0.badge }));
ok('ⓒb 主卡文案⛔ 不含「尾盤賣」「守住」,而且講「買了放著」', !!(R.d0 && !/尾盤賣|守住/.test(R.d0.why + R.d0.badge) && /買了放著/.test(R.d0.why)), R.d0 && R.d0.why);
ok('ⓒc 行動清單第一條是「買了放著」(⛔ 不是「今天尾盤賣」)', !!(R.d0 && /買了放著/.test(R.d0.plan0 || '')), R.d0 && R.d0.plan0);
ok('ⓒd 對照:2330 同一份資料 → state=exit(抱滿到期)', !!(R.d2 && R.d2.state === 'exit'), JSON.stringify(R.d2));
ok('ⓑ 決策台有 `[data-exitetf="1"]` 且講「買了放著」與檔數', !!(R.etfBox && R.etfBox.n === '1' && /買了放著/.test(R.etfBox.txt) && /0050/.test(R.etfBox.txt)), JSON.stringify(R.etfBox));
ok('ⓑb 0050 ⛔ 不可出現在賣出列(`[data-exitrow="0050"]` 不存在)', R.row0050 == null, R.row0050);
ok('ⓑc 2330 在賣出列而且寫「時間到期 / 抱滿」', !!(R.row2330 && /抱滿|時間到期/.test(R.row2330)), R.row2330);
ok('ⓑd 「今天要賣的(N 檔)」的 N 不算 ETF(= 1)', /今天要賣的\(1 檔\)/.test(R.hdr), R.hdr);
ok('ⓕ 數字讀常數:`_ETF_HOLD_EDGE.n` 改 99 → 文案跟著變', R.note99 === true, '');
ok('ⓕb 個股⛔ 不會拿到 ETF 文案(`_etfHoldNote(\'2330\')` 是 null)', R.noteStock === null, JSON.stringify(R.noteStock));
ok('無 pageerror', errs.length === 0, errs.join(' | '));
if (R.deckErr) ok('renderDeck 沒有 throw', false, R.deckErr);

console.log(fails.length ? `\n❌ ETFHOLD_FAIL(${fails.length}):${fails.join(' / ')}` : '\n✅ ETFHOLD_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
