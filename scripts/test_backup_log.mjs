#!/usr/bin/env node
/**
 * 🛟 V82.5.1 你的賣出紀錄(勝率鏡子靠它)不可以整本不見
 *
 * 查到的三個洞(11/18):
 *   A. 觸發專欄用 _lsJson 讀賣出紀錄 —— _lsJson 讀不出來會把那個鍵**刪掉**(快取可以重建,你的紀錄不行)
 *   B. 賣出時讀不出來就當成空的、把新的一筆寫回去 → 以前的全部被蓋掉
 *   C. 備份匯出 / 還原沒有賣出紀錄 → 換手機、清瀏覽器就沒了
 * ⛔ 釘死:
 *   ① _userLogRead:沒有 / 讀得出來 / 半截 / 不是陣列 四種分得清楚;半截的救回前面幾筆、原文另存、⛔ 動原本那個鍵
 *   ② ⭐ 決定性對照:同一份半截資料用舊讀法(_lsJson)→ 整個鍵被刪;觸發專欄現在不走它
 *   ③ 以前的紀錄讀不出來時賣一筆 → 新紀錄 = 救回來的 + 這一筆(⛔ 只剩這一筆)、原文留著
 *   ④ 連原文都存不下(空間滿)→ 這次不寫、原本那個鍵一個位元都不變、庫存不動、講出原因
 *   ⑤ 備份(完整 / 持股自選)帶賣出紀錄;只備份金鑰不帶
 *   ⑥ 還原 = 合併:已經有的不重複、現有的一筆不少、照賣出日排;還原兩次筆數不變
 *   ⑥b ⭐ 決定性對照:沒有賣出紀錄欄的舊備份 → 現有紀錄一個位元都不變
 *   ⑦ 鏡子:有讀不出來的那一段才講一聲;清空時一起清
 *   ⑧ 靜態:全檔唯一寫入點、⛔ 再用 _lsJson / 裸 JSON.parse 讀賣出紀錄
 * 跑法:node scripts/test_backup_log.mjs ・INJECT=1 node scripts/test_backup_log.mjs(四種注入必紅)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const INJ = {
    // A 復活:觸發專欄又用會刪鍵的讀法
    lsjson: ["for (const t of this._userLogRead('proTerminalTradeLog').arr) {", "for (const t of (this._lsJson('proTerminalTradeLog', []) || [])) {"],
    // B 復活:讀不出來 → 當成空的照寫
    blank: ["const tradeLog = _rd.arr.slice();", "const tradeLog = _rd.bad ? [] : _rd.arr.slice();"],
    // 空間滿了也照寫(原文沒留住就蓋掉)
    noguard: ["if (_rd.bad && !_rd.saved) { msg(", "if (false) { msg("],
    // C:還原變成覆蓋
    overwrite: ["const mg = this._tradeLogMerge(rd.arr, add);", "const mg = { arr: add.slice(), added: add.length };"],
    // C:備份不帶
    noexport: ["if (rd.arr.length) data.tradeLog = rd.arr;", ""],
};

async function run(html) {
    const fails = [];
    const ok = (n, c, e = '') => { if (!process.env.QUIET) console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 320)}`); if (!c) fails.push(n); };

    // ⑧ 靜態
    const strip = html.replace(/\/\/[^\n]*/g, '');
    ok('⑧ 全檔只有一處寫賣出紀錄(_tradeLogWrite)', (html.match(/setItem\(\s*'proTerminalTradeLog'/g) || []).length === 1);
    ok("⑧ ⛔ 再用 _lsJson 讀賣出紀錄(讀壞了會把整本刪掉)", !/_lsJson\(\s*'proTerminalTradeLog'/.test(strip));
    ok("⑧ ⛔ 裸的 JSON.parse(localStorage.getItem('proTerminalTradeLog')(壞了就當空的)", !/JSON\.parse\(\s*localStorage\.getItem\(\s*'proTerminalTradeLog'/.test(strip));

    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bklog-')), 'index.html');
    fs.writeFileSync(tmp, html);
    const exe = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    const browser = await chromium.launch({ ...(fs.existsSync(exe) ? { executablePath: exe } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    await page.goto('file://' + tmp, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window.app || typeof app !== 'undefined'), null, { timeout: 30000 });
    await page.waitForTimeout(1500);

    const R = await page.evaluate(async () => {
        const A = window.app || app, K = 'proTerminalTradeLog', BK = K + '_bad';
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const o = {};
        const T = (sym, d, px, extra = {}) => ({ symbol: sym, name: sym, cost: 100, sellPrice: px, shares: 1, pnlNTD: (px - 100) * 1000, pnlPct: px - 100, buyDate: '2026-09-01', date: d, holdDays: 10, net: 1, ...extra });
        const full = [T('2330', '2026/10/01', 110), T('2317', '2026/10/05', 95), T('2454', '2026/10/09', 120)];
        const fullS = JSON.stringify(full);
        const half = fullS.slice(0, fullS.lastIndexOf('{"symbol":"2454"') + 40);   // 第三筆寫到一半
        const clean = () => { for (const k of [K, BK, BK + '2']) localStorage.removeItem(k); };
        const raw = k => localStorage.getItem(k);

        // ── ① 四種情況
        clean(); o.r0 = A._userLogRead(K);
        localStorage.setItem(K, fullS); o.r1 = A._userLogRead(K); o.r1bad = raw(BK);
        clean(); localStorage.setItem(K, half); o.r2 = A._userLogRead(K); o.r2main = raw(K) === half; o.r2bad = raw(BK) === half;
        o.r2again = A._userLogRead(K); o.r2bad2 = raw(BK + '2');                       // 同一份再讀 ⛔ 多存一份
        clean(); localStorage.setItem(K, '{"a":1}'); o.r3 = A._userLogRead(K); o.r3main = raw(K) === '{"a":1}';
        clean(); localStorage.setItem(K, 'not json at all'); o.r4 = A._userLogRead(K);
        o.salv = [A._jsonArrSalvage(half)?.length, A._jsonArrSalvage('[{"a":1}')?.length, A._jsonArrSalvage('[{"a":1},{"b":'), A._jsonArrSalvage('xyz'), A._jsonArrSalvage('[1,2')];

        // ── ② 決定性對照:舊讀法會把鍵刪掉
        clean(); localStorage.setItem(K, half);
        const cw = console.warn; console.warn = () => {};
        A._lsJson(K, []); console.warn = cw;
        o.oldDeletes = raw(K) === null;
        // 觸發專欄那一段現在怎麼讀(實際跑一次掃描;網路全部失敗沒關係,只看那個鍵還在不在)
        clean(); localStorage.setItem(K, half);
        const kS = A.settings.stratUnlock, kD = A.settings.deckShow;
        try {
            A.settings.stratUnlock = true; A.settings.deckShow = { ...(A.settings.deckShow || {}), col: true };
            A._colTrigCache = null; A._colTrigAt = 0;
            await Promise.race([A._colTrigScan(true).catch(() => {}), sleep(8000)]);
        } finally { A.settings.stratUnlock = kS; A.settings.deckShow = kD; }
        o.scanKeeps = raw(K) === half;

        // ── ③ 讀不出來時賣一筆
        const seedInv = () => { A.inventory = [{ symbol: '5483', cost: 224.47, shares: 1, buyDate: '2026-07-02', currentPrice: 225.5 }]; localStorage.setItem('proTerminalInv', JSON.stringify(A.inventory)); };
        const sell = () => { A._invEditDraft = A.inventory.map((it, i) => ({ ...it, _oi: i })); return A._invSellCommit(0, { price: 230, shares: 1000, date: '2026-10-20' }); };
        clean(); seedInv(); localStorage.setItem(K, half);
        o.sell3 = sell();
        try { o.after3 = JSON.parse(raw(K)); } catch (_) { o.after3 = null; }
        o.bad3 = raw(BK) === half; o.inv3 = A.inventory.length;

        // ── ④ 連原文都存不下
        clean(); seedInv(); localStorage.setItem(K, half);
        // ⚠️ App 自己把 localStorage.setItem 換成一支包了一層的(_hookAutoSync,而且早就綁住原生那支)
        //   → 改 Storage.prototype 攔不到;要包在它外面那一層才模擬得了「這個鍵存不進去」
        const realSet = localStorage.setItem;
        localStorage.setItem = function (k, v) { if (String(k).startsWith(BK)) throw new Error('QuotaExceeded'); return realSet.call(localStorage, k, v); };
        o.stubOk = (() => { try { localStorage.setItem(BK + '_probe', '1'); return false; } catch (_) { return true; } })();
        let msg4 = '';
        try {
            A._invEditDraft = A.inventory.map((it, i) => ({ ...it, _oi: i }));
            const host = document.createElement('div'); host.setAttribute('data-sellpanel', '0'); host.innerHTML = '<div data-sellmsg></div>'; document.body.appendChild(host);
            o.sell4 = A._invSellCommit(0, { price: 230, shares: 1000, date: '2026-10-20' });
            msg4 = host.textContent; host.remove();
        } finally { localStorage.setItem = realSet; }
        o.msg4 = msg4; o.main4 = raw(K) === half; o.inv4 = A.inventory.length; o.inv4ls = JSON.parse(raw('proTerminalInv')).length;

        // ── ⑤ 備份帶不帶
        const cap = {};
        const kO = A._obfuscate, kDl = A._downloadBackupFile, kSave = A.saveSettings, kPwd = A._getBackupPwd, kToast = A.showToast;
        A._obfuscate = s => { cap.last = s; return 'X'; }; A._downloadBackupFile = () => {}; A.saveSettings = () => {}; A._getBackupPwd = () => ''; A.showToast = (t) => { cap.toast = String(t); };
        // 剪貼簿在無頭瀏覽器裡要等很久才回 → 完成那句會晚到、蓋掉後面還原的那句;拿掉它,完成那句就在同一拍出來
        try { Object.defineProperty(navigator, 'canShare', { value: () => false, configurable: true }); } catch (_) {}
        try { Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }); } catch (_) {}
        o.clipOff = !navigator.clipboard;
        clean(); localStorage.setItem(K, fullS);
        for (const sc of ['all', 'holdings', 'keys']) { cap.last = ''; await A.exportData(sc); await sleep(30); o['exp_' + sc] = JSON.parse(cap.last || '{}'); o['toast_' + sc] = cap.toast; }
        clean(); localStorage.setItem(K, half); await A.exportData('all'); o.exp_half = JSON.parse(cap.last || '{}');
        clean(); await A.exportData('all'); o.exp_none = JSON.parse(cap.last || '{}');
        A._obfuscate = kO; A._downloadBackupFile = kDl; A.saveSettings = kSave; A._getBackupPwd = kPwd;

        // ── ⑥ 還原 = 合併
        const kDe = A._deobfuscate, kConf = A.showConfirm, kRef = A.refreshInventoryPrices, kTabs = A.renderFavTabs, kAn = A.analyze;
        const area = document.getElementById('exportArea');
        A._deobfuscate = s => s; A.showConfirm = (m, cb) => { cap.msg = m; cb(); }; A.refreshInventoryPrices = () => {}; A.renderFavTabs = () => {}; A.analyze = () => {};
        const imp = async data => { area.value = JSON.stringify(data); cap.msg = ''; cap.toast = ''; await A.confirmImportData(); await sleep(30); };
        const mine = [T('2330', '2026/10/01', 110), T('3008', '2026/10/12', 90, { why: 'app' })];   // 手機上現有的
        const bk = { inv: [{ symbol: '2330', cost: 500, shares: 1 }], favGroups: { '自選清單': ['2330'] },
                     tradeLog: [T('2330', '2026-10-01', 110), T('2317', '2026/10/05', 95), T('2454', '2026/09/20', 120), null, { foo: 1 }, 'x'] };   // 第一筆 = 同一筆(日期寫法不同)
        clean(); localStorage.setItem(K, JSON.stringify(mine));
        await imp(bk);
        o.m1 = JSON.parse(raw(K)); o.m1msg = cap.msg; o.m1toast = cap.toast; o.m1inv = A.inventory.length;
        await imp(bk);
        o.m2 = JSON.parse(raw(K)); o.m2toast = cap.toast;
        // ⑥b 決定性對照:舊備份(沒有 tradeLog)→ 一個位元都不變
        const before = raw(K);
        await imp({ inv: [{ symbol: '2330', cost: 500, shares: 1 }], favGroups: { '自選清單': ['2330'] } });
        o.oldSame = raw(K) === before; o.oldMsg = cap.msg;
        // 只有賣出紀錄的備份也還原得了
        clean(); await imp({ tradeLog: [T('1101', '2026/08/01', 105)] });
        o.only = JSON.parse(raw(K) || '[]').length; o.onlyMsg = cap.msg;
        // 現有的讀不出來(半截)+ 還原 → 救回來的 + 備份的,原文留著
        clean(); localStorage.setItem(K, half); await imp(bk);
        try { o.m3 = JSON.parse(raw(K)); } catch (_) { o.m3 = null; }
        o.m3bad = raw(BK) === half;
        // 純函式
        const mg = A._tradeLogMerge([T('A', '2026/10/09', 1), T('B', '2026/10/01', 2)], []);
        o.mergeNoAdd = mg.added === 0 && mg.arr.map(t => t.symbol).join('') === 'AB';   // 沒有新增 → ⛔ 重排現有的
        A._deobfuscate = kDe; A.showConfirm = kConf; A.refreshInventoryPrices = kRef; A.renderFavTabs = kTabs; A.analyze = kAn; A.showToast = kToast;

        // ── ⑦ 鏡子那一行
        clean(); localStorage.setItem(K, fullS); o.note0 = /data-tradelogbad/.test(A._tradeJournalHtml());
        localStorage.setItem(BK, half); o.note1 = /data-tradelogbad/.test(A._tradeJournalHtml());
        clean(); localStorage.setItem(BK, half); o.note2 = /data-tradelogbad/.test(A._tradeJournalHtml());   // 一筆都救不回時也要講
        A.showConfirm = (m, cb) => cb(); localStorage.setItem(K, fullS); localStorage.setItem(BK + '2', 'x'); A._clearTradeLog(); A.showConfirm = kConf;
        o.cleared = raw(K) === null && raw(BK) === null && raw(BK + '2') === null;
        clean(); localStorage.removeItem('proTerminalInv'); A.inventory = [];
        return o;
    });
    await browser.close();

    const syms = a => (a || []).map(t => t && t.symbol).join(',');
    ok('① 沒有這個鍵 → 空的、不算壞', R.r0.arr.length === 0 && R.r0.bad === false);
    ok('① 讀得出來 → 3 筆、不算壞、⛔ 多存一份', R.r1.arr.length === 3 && !R.r1.bad && R.r1bad === null);
    ok('① 第三筆寫到一半 → 救回前 2 筆、標壞、原文另存、原本那個鍵沒被動', R.r2.arr.length === 2 && R.r2.bad && R.r2.saved && R.r2main && R.r2bad, JSON.stringify(R.r2));
    ok('① 同一份再讀一次 → ⛔ 多存第二份', R.r2again.saved && R.r2bad2 === null);
    ok('① 不是陣列 / 完全不是 JSON → 標壞、0 筆、原本那個鍵沒被動', R.r3.bad && R.r3.arr.length === 0 && R.r3main && R.r4.bad && R.r4.arr.length === 0);
    ok('① _jsonArrSalvage:半截 → 2 筆、少了結尾的 ] → 1 筆、第二筆半截 → 1 筆、不是陣列 → null、沒有物件 → null', R.salv[0] === 2 && R.salv[1] === 1 && Array.isArray(R.salv[2]) && R.salv[2].length === 1 && R.salv[3] === null && R.salv[4] === null, JSON.stringify(R.salv));
    ok('② ⭐ 決定性對照:同一份半截資料用舊讀法(_lsJson)→ 整個鍵被刪掉', R.oldDeletes);
    ok('② 觸發專欄掃過一輪 → 那份半截資料還在(⛔ 被刪)', R.scanKeeps);
    ok('③ 讀不出來時賣一筆:成功、紀錄 = 救回來的 2 筆 + 這一筆(⛔ 只剩這一筆)', R.sell3 === true && Array.isArray(R.after3) && syms(R.after3) === '2330,2317,5483', syms(R.after3));
    ok('③ 原文留著、庫存照扣', R.bad3 && R.inv3 === 0);
    ok('④ 測試自己有沒有真的模擬到「那個鍵存不進去」(沒有 → 下面兩條不算數)', R.stubOk === true);
    ok('④ 連原文都存不下 → 這次不寫(回 false)、原本那個鍵一個位元都不變', R.sell4 === false && R.main4, `${R.sell4} ${R.main4}`);
    ok('④ 庫存不動(記憶體與存檔都是)、畫面講出原因', R.inv4 === 1 && R.inv4ls === 1 && /讀不出來/.test(R.msg4) && /備份/.test(R.msg4), R.msg4);
    ok('⑤ 測試自己把剪貼簿拿掉了(完成那句才不會晚到)', R.clipOff === true);
    ok('⑤ 完整備份 / 持股自選備份都帶 3 筆賣出紀錄', R.exp_all.tradeLog?.length === 3 && R.exp_holdings.tradeLog?.length === 3 && R.exp_all._meta.trade_count === 3);
    ok('⑤ 只備份金鑰 → 不帶', R.exp_keys.tradeLog === undefined && R.exp_keys.inv === undefined);
    ok('⑤ 備份完成那句有寫幾筆賣出紀錄', /3 筆賣出紀錄/.test(R.toast_all || '') && /3 筆賣出紀錄/.test(R.toast_holdings || ''), R.toast_all);
    ok('⑤ 現有的是半截 → 備份帶救回來的 2 筆 + 讀不出來那段的原文', R.exp_half.tradeLog?.length === 2 && typeof R.exp_half.tradeLogBad === 'string' && R.exp_half.tradeLogBad.length > 20);
    ok('⑤ 一筆都沒有 → 備份裡沒有那一欄(⛔ 塞空陣列)', !('tradeLog' in R.exp_none) && !('tradeLogBad' in R.exp_none));
    ok('⑥ 還原 = 合併:現有 2 筆 + 備份 3 筆(1 筆重複、3 個亂七八糟的不收)→ 4 筆', R.m1.length === 4, syms(R.m1));
    ok('⑥ 現有的一筆不少(含只有手機上有的 3008 與它的買進理由)', R.m1.some(t => t && t.symbol === '3008' && t.why === 'app') && R.m1.filter(t => t && t.symbol === '2330').length === 1);
    ok('⑥ 照賣出日排(9/20 → 10/01 → 10/05 → 10/12)', syms(R.m1) === '2454,2330,2317,3008', syms(R.m1));
    ok('⑥ 確認視窗寫「合併、不會蓋掉」;完成那句寫併進幾筆', /賣出紀錄\(跟現有的合併,不會蓋掉\)/.test(R.m1msg) && /賣出紀錄除外/.test(R.m1msg) && /併進 2 筆/.test(R.m1toast), R.m1msg + ' | ' + R.m1toast);
    ok('⑥ 持股照舊還原(這一段沒被動到)', R.m1inv === 1);
    ok('⑥ 同一份備份還原第二次 → 還是 4 筆、寫「本來就都有了」', R.m2.length === 4 && /本來就都有了/.test(R.m2toast), R.m2toast);
    ok('⑥b ⭐ 決定性對照:沒有賣出紀錄欄的舊備份 → 現有紀錄一個位元都不變、確認視窗沒有那一行', R.oldSame && !/賣出紀錄/.test(R.oldMsg));
    ok('⑥ 只有賣出紀錄的備份也還原得了', R.only === 1 && /1 筆賣出紀錄/.test(R.onlyMsg));
    ok('⑥ 現有的是半截 → 還原後 = 救回來的 2 筆 + 備份多的 1 筆、原文留著', Array.isArray(R.m3) && R.m3.length === 3 && R.m3bad, syms(R.m3));
    ok('⑥ 沒有新增 → ⛔ 重排現有的順序', R.mergeNoAdd);
    ok('⑦ 鏡子:沒有讀不出來的 → 一個字都不印;有 → 講一聲(連一筆都救不回時也講)', !R.note0 && R.note1 && R.note2);
    ok('⑦ 清空紀錄時連那份原文一起清', R.cleared);
    ok('⓪ 沒有頁面錯誤', errs.length === 0, errs.slice(0, 2).join(' | '));
    return fails;
}

if (process.env.INJECT) {
    let missed = 0;
    for (const [k, [a, b]] of Object.entries(INJ)) {
        if (!SRC.includes(a)) { console.log(`❌ 注入 ${k}:原始碼找不到要換的那一段(程式改了?)`); missed++; continue; }
        process.env.QUIET = '1';
        const f = await run(SRC.replace(a, b));
        delete process.env.QUIET;
        console.log(`${f.length ? '✅' : '❌'} 注入 ${k} → ${f.length ? `紅 ${f.length} 條(${f.slice(0, 2).join(' / ').slice(0, 150)})` : '⛔ 沒有任何一條紅'}`);
        if (!f.length) missed++;
    }
    process.exit(missed ? 1 : 0);
}
const fails = await run(SRC);
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ 全部通過');
process.exit(fails.length ? 1 : 0);
