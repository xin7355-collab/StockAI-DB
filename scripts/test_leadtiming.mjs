#!/usr/bin/env node
/**
 * ⏱️ V78.4.4 👑 換倉那天幾點買賣(leader_intraday_probe → 使用者選「決策台和自動下單一起換」)守門
 *   ⓐ 預設 split:`_leadWhen('buy')` 有 13:25 + 開盤跌 3% 例外;`_leadWhen('sell')` 有 09:00 + 09:30~10:00
 *   ⓑ ⭐ 決定性對照:設定 leadTiming='open' → 文案換回全部 09:00 開盤、⛔ 不再出現 13:25
 *   ⓒ 決策台「今天要做的事」/ 總覽主卡 buy・sell / 換倉提醒 都讀 `_leadWhen`(換設定一起變)
 *   ⓓ App 預設 == auto_trade.py 預設(split);worker 推播讀 settings.leadTiming
 *   ⓔ `_STRAT_CHANGES` 有這一筆(lead:true、backLeadTime)→ 換回鈕呼叫 setLeadTiming('open')
 *   ⓕ ⛔ 研究字樣(lib_retailbad)
 * 注入:INJECT=hard(今天要做的事寫死「09:00 開盤買」)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { badOf } from './lib_retailbad.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIG = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let SRC = ORIG;
const INJ = process.env.INJECT || '';
if (INJ === 'hard') SRC = SRC.replace("if (buys.length) p.push(`🛒 明天 ${this._leadWhen('buy', true)} ${names(buys)}`);", "if (buys.length) p.push(`🛒 明天 09:00 開盤買 ${names(buys)}`);");
if (INJ && SRC === ORIG) { console.log('❌ 注入沒有注進去'); process.exit(1); }
const TMP = path.join(ROOT, '.test_leadtiming.html');
fs.writeFileSync(TMP, SRC);
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };

let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const errs = [];
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
page.on('pageerror', e => errs.push(e.message));
await page.goto('file://' + TMP, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._leadWhen === 'function' && typeof app._deckTodoLead === 'function', null, { timeout: 60000 });
const R = await page.evaluate(() => {
    const o = {};
    const txt = h => { const d = document.createElement('div'); d.innerHTML = h; return d.innerText || d.textContent; };
    app.settings = app.settings || {}; delete app.settings.leadTiming;
    app.getStockName = s => ({ 2330: '台積電', 2454: '聯發科', 3008: '大立光' })[s] || s;
    const L = { buy: [{ sym: '2330' }, { sym: '2454' }], all: new Map(), ranked: [] };
    const held = [{ sym: '3008', mine: true, keep: false }];
    const todo = () => txt(app._deckTodoLead({ clk: { isRebal: true }, bearOn: false, L, held, H: 10 }));
    const v = { st: 'sell', where: '第 15 名', H: 10, N: 5, rank: 15, isRebal: true, left: 0 };
    const ov = (st) => { const t = app._leadOvText({ ...v, st, rank: st === 'buy' ? 2 : 15 }, st !== 'buy', 0, false); return txt(t.badge + ' ' + t.why + ' ' + (t.plan || []).map(p => p.t).join(' ')); };
    o.split = { tm: app._leadTiming(), buy: app._leadWhen('buy'), sell: app._leadWhen('sell'), todo: todo(), ovBuy: ov('buy'), ovSell: ov('sell') };
    app.settings.leadTiming = 'open';
    o.open = { tm: app._leadTiming(), buy: app._leadWhen('buy'), sell: app._leadWhen('sell'), todo: todo(), ovBuy: ov('buy'), ovSell: ov('sell') };
    delete app.settings.leadTiming;
    const c = (app._STRAT_CHANGES || []).find(x => x.backLeadTime);
    o.chg = c ? { v: c.v, lead: c.lead, first: (app._STRAT_CHANGES.find(x => x.lead) === c) } : null;
    o.showSrc = app._showStratChange.toString();
    o.alertSrc = app._leadRebalAlert.toString();
    return o;
});
const AT = fs.readFileSync(path.join(ROOT, 'auto_trade.py'), 'utf8');
const WK = fs.readFileSync(path.join(ROOT, 'cloud-worker/worker.js'), 'utf8');
ok('ⓐ 預設 split:買 13:25(開盤跌 3% 例外)・賣 09:00(開盤跌 3% 等到 09:30~10:00)', R.split.tm === 'split' && /13:25/.test(R.split.buy) && /跌 3%/.test(R.split.buy) && /09:00/.test(R.split.sell) && /09:30~10:00/.test(R.split.sell), JSON.stringify(R.split));
ok('ⓑ ⭐ 決定性對照:設 open → 全部 09:00 開盤、⛔ 沒有 13:25', R.open.tm === 'open' && /09:00 開盤買/.test(R.open.buy) && !/13:25/.test(R.open.buy + R.open.todo + R.open.ovBuy), JSON.stringify(R.open));
ok('ⓒ 決策台「今天要做的事」跟著設定變(split 有 13:25、open 沒有)', /13:25 買 台積電/.test(R.split.todo) && /開盤賣 大立光/.test(R.split.todo) && !/13:25/.test(R.open.todo) && /開盤買 台積電/.test(R.open.todo), [R.split.todo, R.open.todo]);
ok('ⓒ2 總覽主卡 買 / 賣 跟著設定變', /13:25/.test(R.split.ovBuy) && /09:30~10:00/.test(R.split.ovSell) && !/13:25/.test(R.open.ovBuy), [R.split.ovBuy.slice(0, 160), R.split.ovSell.slice(0, 160)]);
ok('ⓒ3 換倉提醒讀 _leadWhen', /_leadWhen\('sell'\)/.test(R.alertSrc) && /_leadWhen\('buy'\)/.test(R.alertSrc));
ok('ⓓ App 預設 split == auto_trade.py LEADER_WINDOW 預設 split', /LEADER_WINDOW = \(os\.getenv\('LEADER_WINDOW'\) or 'split'\)/.test(AT) && R.split.tm === 'split');
ok('ⓓ2 Telegram 換倉推播讀 settings.leadTiming', /u\.settings\?\.leadTiming !== 'open'/.test(WK) && /13:25/.test(WK));
ok('ⓔ _STRAT_CHANGES 有這一筆(👑 才跳、是最新的 👑 那筆)且換回鈕 = setLeadTiming(open)', R.chg && R.chg.lead && R.chg.first && /backLeadTime \? "app\.setLeadTiming\('open'\);"/.test(R.showSrc), JSON.stringify(R.chg));
ok('ⓕ ⛔ 研究字樣', !badOf(R.split.todo + R.split.ovBuy + R.split.ovSell + R.split.buy + R.split.sell).length, badOf(R.split.todo + R.split.ovBuy));
ok('ⓩ 無 pageerror', !errs.length, errs.slice(0, 2));
await browser.close();
try { fs.unlinkSync(TMP); } catch (_) {}
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ test_leadtiming 全過');
process.exit(fails.length ? 1 : 0);
