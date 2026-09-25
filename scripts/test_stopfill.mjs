// 🛑📐 V77.5.9 停損成交價三種口徑 + ATR 反比部位 —— 回測腳本守門
//   ATR 逐字稿檢視時照出來的:同一條停損,全站有三種執行方式
//     回測(舊)= 收盤跌破 → 用**停損價**算(收盤已經在下面了,那個價其實賣不到)
//     auto_trade.py = 現價 <= 停損 → 用**現價**賣(≈ close)
//     App 複製智慧單 = 盤中**觸價**就賣(≈ touch)
//
// ⛔ 這支釘的用意(每條都做過注入驗證):
//   ⓐ 出場模擬器三種口徑的數字對(跑 breakout_exit_probe --selftest ⑨~⑨e)
//   ⓑ portfolio_backtest 認不得的 STOPFILL / SIZING 一律 exit 1(打錯字⛔ 不可安靜地退回預設)
//   ⓒ 預設 STOPFILL=stop ⛔ 不進 CACHE_KEY(舊快取照樣重用、舊輸出逐位元組相同)
//   ⓓ 累積損益用**每一筆自己的投入金額**(⛔ 寫死 LOT 會讓 risk / volpar 的總獲利是錯的)
//   ⓔ volpar 的參考 ATR% ⛔ 不含今天的候選(今天的候選要在挑完之後才放進歷史)
//   ⓕ 三種口徑在 portfolio_backtest 裡都有分支,而且 close 用收盤、touch 用 min(開盤, 停損)
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

let bad = 0;
const ok = (c, n, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${e ? ' — ' + e : ''}`); if (!c) bad++; };
const strip = t => t.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');

// ⓐ
{
    const r = spawnSync('node', ['scripts/breakout_exit_probe.mjs', '--selftest'], { encoding: 'utf8' });
    const out = r.stdout || '';
    ok(r.status === 0 && /⑨ stop 口徑/.test(out) && /⑨d 盤中碰到/.test(out), 'ⓐ 出場模擬器三種口徑 selftest 全過', (out.match(/❌[^\n]*/g) || []).join(' | '));
}
// ⓑ
for (const [k, v] of [['STOPFILL', 'clsoe'], ['SIZING', 'volpr']]) {
    const r = spawnSync('node', ['scripts/portfolio_backtest.mjs', '10', '2'], { encoding: 'utf8', env: { ...process.env, [k]: v, DATA_DIR: '/nonexistent' } });
    ok(r.status === 1 && (r.stderr || '').includes(`${k}=${v} 不認得`), `ⓑ ${k}=${v} 打錯字 → exit 1 並說不認得`, `status=${r.status}`);
}
const SRC = strip(readFileSync('scripts/portfolio_backtest.mjs', 'utf8'));
// ⓒ
ok(/const _ckStopFill = STOPFILL !== 'stop' \? \{ STOPFILL \} : \{\};/.test(SRC) && /CACHE_KEY = JSON\.stringify\(\{[^}]*GRACE, \.\.\._ckStopFill \}\)/.test(SRC), 'ⓒ STOPFILL 只在非預設時進 CACHE_KEY');
// ⓓ
ok(/const money = t => \(t\._amt \|\| LOT\) \* net\(t\) \/ 100;/.test(SRC) && !/const money = t => LOT \*/.test(SRC), 'ⓓ 累積損益用每一筆自己的投入金額');
// ⓔ
{
    const iRef = SRC.indexOf('vpRef = sv[sv.length >> 1]');
    const iPick = SRC.indexOf('taken.push(t); live.push(t); picked++;');
    const iHist = SRC.indexOf('for (const { t } of cand) if (t.ap > 0) vpHist.push(t.ap);');
    ok(iRef > 0 && iPick > iRef && iHist > iPick, 'ⓔ volpar 參考值在挑選之前算、今天的候選在挑完之後才放進歷史', JSON.stringify([iRef, iPick, iHist]));
    ok(/k = vpK\[Math\.floor\(_rnd\(\) \* vpK\.length\)\]/.test(SRC), 'ⓔ2 volsham 的倍數從歷史倍數分布隨機抽(跟這檔 ATR 無關)');
}
// ⓕ
ok(/a\.stopFill === 'touch' \? \(L\(j\) > 0 && L\(j\) <= stop\) : c <= stop/.test(SRC)
    && /exitP = a\.stopFill === 'close' \? c/.test(SRC)
    && /a\.stopFill === 'touch' \? Math\.min\(O\(j\) > 0 \? O\(j\) : stop, stop\)/.test(SRC), 'ⓕ 三種口徑分支都在(close 用收盤、touch 用 min(開盤, 停損))');
ok(/stopFill: STOPFILL \}\);/.test(SRC), 'ⓕ2 STOPFILL 真的傳進掃描(沒傳 = 三種跑出來一模一樣)');

// ⓖ V77.6.0 全站改成收盤成交(使用者選「全站改算法重算」)
ok(/const STOPFILL = process\.env\.STOPFILL \|\| 'close';/.test(SRC), 'ⓖ portfolio_backtest 預設 = close(stop 只留給重現舊數字)');
{
    const LX = strip(readFileSync('scripts/lib_exitsim.mjs', 'utf8'));
    ok(/const FILL = opt\.stopFill \|\| 'close';/.test(LX), 'ⓖ2 lib_exitsim 預設 = close');
    const IX = readFileSync('index.html', 'utf8'), PR = readFileSync('pro.html', 'utf8'), CR = readFileSync('scripts/crash_exit_probe.mjs', 'utf8');
    const bad1 = (IX.match(/exitP = stop;/g) || []).length, bad2 = (PR.match(/done\(stop,/g) || []).length, bad3 = (CR.match(/exitP = stop0;/g) || []).length;
    ok(bad1 === 0 && bad2 === 0 && bad3 === 0, 'ⓖ3 index.html 兩處回測 / pro.html 結算 / crash_exit_probe ⛔ 不可再用停損價成交', JSON.stringify([bad1, bad2, bad3]));
    const BO = strip(readFileSync('scripts/breakout_exit_probe.mjs', 'utf8'));
    ok(/const STOPFILL = process\.env\.STOPFILL \|\| 'close';/.test(BO), 'ⓖ5 breakout_exit_probe 預設 = close(它會把 env 傳給 lib,⛔ 自己的預設不可蓋掉 lib 的)');
    const nIx = (IX.match(/if \(c <= stop\) \{ exitP = c; exitIdx = j; break; \}/g) || []).length;
    ok(nIx === 2, 'ⓖ4 index.html 兩處 App 內回測都改成收盤成交(空過守門:兩處都要找得到)', String(nIx));
}
// ⓗ V77.6.0 畫面上寫出兩種停損賣法的差距(使用者選「維持現狀,只寫出差異」)—— 數字一律讀 `_STOPFILL_EDGE`
{
    let chromium;
    try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); }
    catch (_) { ({ chromium } = await import('playwright')); }
    const { existsSync } = await import('node:fs');
    const path = await import('node:path');
    const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    const browser = await chromium.launch({ ...(existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto('file://' + path.resolve(process.env.INDEX_HTML || 'index.html'), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof app !== 'undefined' && !!app._stopFillNoteHtml, null, { timeout: 30000 });
    const R = await page.evaluate(() => {
        const out = {}, E = app._STOPFILL_EDGE, k0 = app._exitRuleKey;
        out.has = !!(E && E.rows && E.rows.don && E.rows.atr2);
        out.set0 = app._stopFillNoteHtml('settings');
        app._exitRuleKey = () => 'atr2'; out.deckAtr = app._stopFillNoteHtml('deck'); out.setAtr = app._stopFillNoteHtml('settings');
        app._exitRuleKey = () => 'don'; out.deckDon = app._stopFillNoteHtml('deck');
        // 決定性對照:把常數改成不可能巧合的數字,畫面要跟著變
        const bk = JSON.stringify(E);
        E.rows.don.close.med = 987654; E.rows.atr2.touch.med = 876543; E.b0050 = 765432;
        out.setInj = app._stopFillNoteHtml('settings'); out.deckInj = app._stopFillNoteHtml('deck');
        app._exitRuleKey = () => 'atr2'; out.deckAtrInj = app._stopFillNoteHtml('deck');
        Object.assign(E, JSON.parse(bk)); app._exitRuleKey = k0;
        out.E = E;
        return out;
    });
    await browser.close();
    ok(R.has, 'ⓗ 🚧 空過守門:`_STOPFILL_EDGE` 有唐奇安與 ATR 兩列');
    const E = R.E || { rows: { don: { close: {}, touch: {} }, atr2: { close: {}, touch: {} } } };
    ok(R.set0.includes(`${E.rows.don.close.med}</b>`) && R.set0.includes(`${E.rows.don.touch.med}</b>`) && R.set0.includes(`${E.rows.atr2.close.med}</b>`) && R.set0.includes(`${E.rows.atr2.touch.med}</b>`), 'ⓗ2 設定中心那段印出四格(兩種出場 × 兩種賣法)');
    ok(R.setInj.includes('987654') && R.setInj.includes('876543') && R.setInj.includes('765432') && R.deckInj.includes('987654') && R.deckAtrInj.includes('876543'), 'ⓗ3 數字讀常數(決定性對照:改常數畫面要跟著變,⛔ 不可寫死)');
    ok(/停損別掛觸價單/.test(R.deckAtr) && /選 ATR 的人停損別掛觸價單/.test(R.setAtr) && /你選的是 ATR 追蹤/.test(R.setAtr), 'ⓗ4 選 ATR 的人看得到「⛔ 停損別掛觸價單」(決策台一行 + 設定中心)');
    ok(!/停損別掛觸價單/.test(R.deckDon) && /智慧單盤中碰到就賣/.test(R.deckDon), 'ⓗ5 唐奇安那行⛔ 不可講 ATR 的警告(兩種出場結論不同)');
    ok(/一行都沒改/.test(R.set0), 'ⓗ6 寫明「自動下單與智慧單的做法沒改」(使用者選的:只寫出差距)');
    const IX = readFileSync('index.html', 'utf8');
    ok((IX.match(/data-stopfilldeck="1">\$\{this\._stopFillNoteHtml\('deck'\)\}/g) || []).length === 2 && /id="stopFillNote"/.test(IX), 'ⓗ7 決策台兩處 + 設定中心容器都接上');
}
// ⓘ V77.6.0 設定中心出場說明⛔ 不寫死(讀 `_EXIT_EDGE.rob`)+ pro.html 回測計算機橫幅跟 index.html 同一輪
{
    let chromium;
    try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); }
    catch (_) { ({ chromium } = await import('playwright')); }
    const { existsSync } = await import('node:fs'); const path = await import('node:path');
    const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    const browser = await chromium.launch({ ...(existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
    const page = await browser.newPage();
    await page.goto('file://' + path.resolve(process.env.INDEX_HTML || 'index.html'), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof app !== 'undefined' && !!app._exitRuleDescHtml, null, { timeout: 30000 });
    const R = await page.evaluate(() => {
        const E = app._EXIT_EDGE, bk = JSON.stringify(E.rob), o = {};
        o.desc = app._exitRuleDescHtml(); o.sub = app._exitRuleSubHtml('atr2');
        E.rob.rows.don.med = 98765; E.rob.rows.atr2.med = 87654;
        o.descInj = app._exitRuleDescHtml(); o.subInj = app._exitRuleSubHtml('atr2');
        E.rob = JSON.parse(bk); o.T = app._DECK_TRACK49; o.rob = E.rob; o.b0050 = E.b0050;
        return o;
    });
    await browser.close();
    ok(R.desc.includes(`${R.rob.rows.don.med} 萬`) && R.sub.includes(`${R.rob.rows.atr2.med} 萬`), 'ⓘ 設定中心說明與出場鈕印出 17 條路徑中位');
    ok(R.descInj.includes('98765') && R.subInj.includes('87654'), 'ⓘ2 決定性對照:改 `_EXIT_EDGE.rob` 畫面要跟著變(⛔ 不寫死)');
    const IXs = readFileSync('index.html', 'utf8');
    ok(!/ATR 追蹤 <b class="text-gray-300">531 萬<\/b>/.test(IXs) && !/總獲利中位 <b>526 萬<\/b>/.test(IXs), 'ⓘ3 舊的寫死數字(531 / 526 萬)不可再出現在設定中心');
    const PR = readFileSync('pro.html', 'utf8');
    const m = PR.match(/_STOPFILL_NOTE: \{[^}]*gene: (\d+), lo: (\d+), hi: (\d+), plain: (\d+), b0050: ([\d.]+)/);
    ok(m && +m[1] === R.T.rob.med && +m[2] === R.T.rob.lo && +m[3] === R.T.rob.hi && +m[4] === R.T.rob.pmed && +m[5] === R.b0050,
       'ⓘ4 pro.html 回測計算機橫幅的數字 == index.html `_DECK_TRACK49.rob` / `_EXIT_EDGE.b0050`(同一輪)', m ? m.slice(1).join('/') : 'no match');
    ok(/data-stopfillcalc="1"/.test(PR), 'ⓘ5 pro.html 回測計算機頁頂端有「這一頁的數字全部偏高」橫幅');
}
console.log(bad ? `\n❌ ${bad} 條沒過` : '\n✅ test_stopfill 全過');
process.exit(bad ? 1 : 0);
