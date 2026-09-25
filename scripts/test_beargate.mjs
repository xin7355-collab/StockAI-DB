#!/usr/bin/env node
/**
 * 🐻 V77.6.5 預設策略換成「唐奇安 40 日 + 最長 40 天 + 大盤嚴格空頭不開新倉」的守門
 *   ① 空頭判斷:App `_bear60Of` 跟回測 `portfolio_backtest.mjs` 的 `notBear60` **逐日一模一樣**(真的 ^TWII)
 *   ② 最長天數三份實作一致(index.html `_MAX_HOLD_BY_RULE` / pro.html / auto_trade.py `MAX_HOLD_BY_RULE`)
 *   ③ 唐奇安 40 日三份實作一致(App `_exitLevelAt` / auto_trade.py `exit_line` / pro.html `_settleReplay`)
 *   ④ 決策台:大盤嚴格空頭 → 「不開新倉」,名單收進摺疊;關掉守門 → 回到原本清單(決定性對照)
 *   ⑤ 一次性搬家:存著舊預設 'don' → don40;已搬過而且自己選回 don 的 → 尊重
 *   ⑥ 策略變更彈窗:最新一筆有 backBear:false,「換回舊的」同時關掉空頭守門
 *   ⑦ playbook_scan 直接呼叫 App 的 `_bear60Of`(⛔ 不另寫公式)、auto_trade 讀 `mkt.bear60` 擋買進
 * 注入(逐一確認會紅):_bear60Of 把 < 改成 <= / _MAX_HOLD_BY_RULE 改 30 / 決策台拿掉 gate 分支 / 搬家不設旗標
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IDX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const PRO = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');
const AT = fs.readFileSync(path.join(ROOT, 'auto_trade.py'), 'utf8');
const PB = fs.readFileSync(path.join(ROOT, 'scripts/portfolio_backtest.mjs'), 'utf8');
const SCAN = fs.readFileSync(path.join(ROOT, 'scripts/playbook_scan.mjs'), 'utf8');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 240)}`); if (!c) fails.push(n); };

// ── 靜態 ──
ok('① 回測那份的定義沒變(收盤 < 60 日均 且 20 日均 < 60 日均)',
   /const notBear60 = i => !\(twiiMa60\[i\] != null && twii\[i\]\.c < twiiMa60\[i\] && twiiMa20\[i\] < twiiMa60\[i\]\);/.test(PB));
const mhIdx = (IDX.match(/_MAX_HOLD_BY_RULE: (\{[^}]*\})/) || [])[1], mhPro = (PRO.match(/_MAX_HOLD_BY_RULE: (\{[^}]*\})/) || [])[1];
const mhPy = (AT.match(/MAX_HOLD_BY_RULE = (\{[^}]*\})/) || [])[1];
const norm = x => String(x || '').replace(/['"\s]/g, '');
ok('② 最長天數三份實作一致(index / pro / auto_trade)', mhIdx && norm(mhIdx) === norm(mhPro) && norm(mhIdx) === norm(mhPy) && /don40:40/.test(norm(mhIdx)),
   `${mhIdx} / ${mhPro} / ${mhPy}`);
ok('⑦ playbook_scan 直接呼叫 App 的 `_bear60Of`,產物有 `mkt`', /app\._bear60Of\(rows\)/.test(SCAN) && /\n\s+mkt,\n/.test(SCAN));
ok('⑦b auto_trade 讀 `mkt.bear60` 擋買進(賣出在它之前處理)、預設開',
   /_mkt\.get\('bear60'\) is True/.test(AT) && /BEAR_GATE = \(os\.getenv\('BEAR_GATE'\) or '1'\) == '1'/.test(AT)
   && AT.indexOf("_mkt.get('bear60') is True") > AT.indexOf('先處理出場'));
ok('⑦c auto_trade 的持倉記下自己的上限(`mh`)—— 換規則前買的照舊規則走', /'mh': max_hold\(EXIT_RULE\)/.test(AT) && /pos\.get\('mh'\)/.test(AT));

// ── ③ 唐奇安 40 日:auto_trade.py 跟 App 同一個價 ──
const sym = '2330';
const rowsPath = path.join(ROOT, 'data', `${sym}.json`);
if (!fs.existsSync(rowsPath) || !fs.existsSync(path.join(ROOT, 'data', '^TWII.json'))) {
    console.log('❌ 沒有 data/2330.json 或 data/^TWII.json(跑 bash scripts/fetch_testdata.sh)—— ⛔ 不跑假測試'); process.exit(1);
}
const rows = JSON.parse(fs.readFileSync(rowsPath, 'utf8')).filter(r => r && r.close);
const pyLine = +execFileSync('python3', ['-c', `
import json,sys; sys.path.insert(0,'${ROOT}')
import auto_trade as A
rows=[r for r in json.load(open('${rowsPath}')) if r.get('close')]
print(A.exit_line(rows,'don40',rows[-30]['date']))`], { encoding: 'utf8' }).trim().split('\n').pop();

let chromium;
try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });

// ⑤ 搬家:兩種人各開一次
const mig = async (saved) => {
    const pg = await browser.newPage();
    await pg.addInitScript(v => { try { localStorage.setItem('proTerminalSettings', JSON.stringify(v)); } catch (_) {} }, saved);
    await pg.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
    await pg.waitForFunction(() => typeof app !== 'undefined' && app.settings && app.settings.exitMigr765 !== undefined, null, { timeout: 30000 }).catch(() => {});
    const r = await pg.evaluate(() => ({ k: app._exitRuleKey(), flag: app.settings.exitMigr765, mh: app._maxHold() }));
    await pg.close(); return r;
};
const M1 = await mig({ exitRule: 'don' });
const M2 = await mig({ exitRule: 'don', exitMigr765: 1 });
const M3 = await mig({ exitRule: 'atr2' });
ok('⑤ 存著舊預設 don 的人 → 搬成 don40、最長 40 天、記旗標', M1.k === 'don40' && M1.flag === 1 && M1.mh === 40, JSON.stringify(M1));
ok('⑤b 已搬過、自己選回 don 的人 → ⛔ 不再動(最長 20 天)', M2.k === 'don' && M2.mh === 20, JSON.stringify(M2));
ok('⑤c 自己選 ATR 的人 → ⛔ 一個都不動', M3.k === 'atr2' && M3.mh === 20, JSON.stringify(M3));

const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app.renderDeck && !!app._bear60Of, null, { timeout: 30000 });
const TW = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', '^TWII.json'), 'utf8'));
const R = await page.evaluate(async ({ TW, rows }) => {
    const A = app, o = {};
    // ① 逐日跟回測那份比(回測 = 簡單平均、含當天)
    const c = TW.map(r => +r.close);
    let diff = 0, n = 0, on = 0;
    for (let i = 59; i < c.length; i++) {
        let s20 = 0, s60 = 0; for (let k = i - 19; k <= i; k++) s20 += c[k]; for (let k = i - 59; k <= i; k++) s60 += c[k];
        const bt = c[i] < s60 / 60 && s20 / 20 < s60 / 60;
        const ap = A._bear60Of(TW.slice(0, i + 1));
        n++; if (!ap || ap.on !== bt) diff++; if (bt) on++;
    }
    o.b = { n, diff, on }; o.short = A._bear60Of(TW.slice(0, 30));
    // ③ App 的唐奇安 40
    const n1 = rows.length - 1; o.app40 = A._exitLevelAt(rows, null, n1, 'don40');
    let lo = Infinity; for (let i = n1 - 40; i < n1; i++) lo = Math.min(lo, +rows[i].low); o.ref40 = lo;
    o.mh = { d40: A._maxHold('don40'), d: A._maxHold('don'), a: A._maxHold('atr2') };
    // ④ 決策台
    const pb = { data_date: '2026-09-16', updated: '2026-09-16T12:00:00Z', picks: [{ s: '2330', hq: 1, k: '測試招', trig: 1000, stop: 950, lb: 1, w: 30, n: 20, v: 1 }] };
    A._loadPlaybookEdge = async () => pb; A._invExitScan = async () => []; A._invExitSkip = []; A._invExitN = 0; A._deckFitScan = async () => null;
    const draw = async () => { A._deckBusy = false; await A.renderDeck(); return { buy: document.getElementById('deckBuy').innerHTML, idle: document.getElementById('deckIdle').innerText }; };
    A._mktBear60 = async () => ({ on: true, c: 40000, ma20: 41000, ma60: 42000, d: '2026-09-16' });
    A.settings.bearGate = true; o.gOn = await draw();
    A.settings.bearGate = false; o.gOff = await draw();
    A.settings.bearGate = true; A._mktBear60 = async () => ({ on: false, c: 45000, ma20: 44000, ma60: 43000, d: '2026-09-16' }); o.gBull = await draw();
    // 💰 閒錢停 0050 那一行:數字讀常數(決定性對照)
    const E = A._IDLE0050_EDGE, b0 = E.main.on; E.main.on = 98765; o.idleInj = (await draw()).buy; E.main.on = b0;
    // ⑥ 彈窗
    const c0 = A._STRAT_CHANGES[0]; o.chg = { back: c0.back, backBear: c0.backBear, v: c0.v };
    A._showStratChange(c0); o.modal = (document.getElementById('richHelpModal') || {}).innerHTML || '';
    return o;
}, { TW, rows });
await browser.close();

ok(`① App 的空頭判斷跟回測逐日一樣(${R.b.n} 天、空頭 ${R.b.on} 天)`, R.b.n > 500 && R.b.diff === 0 && R.b.on > 20, JSON.stringify(R.b));
ok('①b 不到 60 根 → null(⛔ 不猜)', R.short === null);
ok('③ App 唐奇安 40 = 前 40 根最低(⛔ 不含今天)', Math.abs(R.app40 - R.ref40) < 1e-9, `${R.app40} vs ${R.ref40}`);
ok('③b auto_trade.py 的唐奇安 40 跟 App 同一個價(那支會動真錢)', Math.abs(+pyLine - R.ref40) < 1e-6, `${pyLine} vs ${R.ref40}`);
ok('②b `_maxHold`:唐奇安 40 = 40、其他 = 20', R.mh.d40 === 40 && R.mh.d === 20 && R.mh.a === 20, JSON.stringify(R.mh));
ok('④ 大盤嚴格空頭 → 決策台寫「不開新倉」,原本那檔收進摺疊(⛔ 不刪)',
   /data-beargate="1"/.test(R.gOn.buy) && /不開新倉/.test(R.gOn.buy) && /<details/.test(R.gOn.buy) && /2330/.test(R.gOn.buy));
ok('④b 🔬 決定性對照:關掉守門 → 回到原本清單', !/data-beargate/.test(R.gOff.buy) && /今天可以買的/.test(R.gOff.buy) && /2330/.test(R.gOff.buy));
ok('④c 不是空頭 → 照常列出', !/data-beargate/.test(R.gBull.buy) && /2330/.test(R.gBull.buy));
ok('④e 💰「閒錢停 0050」那一行在(一般清單與空頭那格都有),而且寫明自動下單不會做',
   /data-idle0050="1"/.test(R.gBull.buy) && /data-idle0050="1"/.test(R.gOn.buy) && /自動下單不會/.test(R.gBull.buy));
ok('④f 🔬 那一行的數字讀 `_IDLE0050_EDGE`(改常數要跟著變)', /98765 萬/.test(R.idleInj));
ok('④d ⛔ 空頭那一格只擋買進 —— 不可叫人賣', !/(全部賣|出清|減碼)/.test(R.gOn.buy));
ok('⑥ 最新一筆策略變更:換回舊的 = don + 關掉空頭守門', R.chg.back === 'don' && R.chg.backBear === false && /toggleBearGate\(false, true\)/.test(R.modal), JSON.stringify(R.chg));
ok('⑧ 無 pageerror', !errs.length, errs.join(' | '));
console.log(fails.length ? `\n❌ ${fails.length} 條沒過` : '\n✅ BEARGATE_PASS');
process.exit(fails.length ? 1 : 0);
