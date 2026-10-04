#!/usr/bin/env node
/**
 * 🥊 V78.4.8 賣出彈窗「連續技」× 選領頭羊 / 出場線已在現價上面
 *   使用者截圖(選 👑+停車 0050,持有中美晶 5483):彈窗「急漲過熱 → 先出一半 ≈500 股 ・第 2 擊 跌破吊燈 252.71 → 賣在這裡 +27,346 元」
 *   而總覽寫「今天不用賣・等換倉日」→ 兩套規則打架;而且 252.71 > 現價 221.5 = 早就跌破,那個金額賣不到。
 * 釘住:
 *   ① 👑 持股 + 風險訊號 → ⛔ 不跳大視窗(_fireAlert 0)、每一則都進 🔔 歷史(_alertQuiet 數 == 🔥 時跳的則數);決定性對照:切回 🔥 → 會跳
 *   ② 👑 持股的連續技 ⛔ 不出現「先出一半 / 吊燈 / 你設定的出場規則」,要講換倉日排名
 *   ③ 🔥 出場線 ≥ 現價 → ⛔ 不印「賣在這裡」「先出一半」,要講「已經在現價上面」;線 < 現價照舊三擊
 *   ④ 題材龍頭徽章⛔ 不用 👑
 */
import path from 'path';
import fs from 'fs';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const HTML = process.env.INDEX_HTML || path.join(ROOT, 'index.html');
let fails = 0;
const ok = (n, c, e = '') => { if (c) console.log(`✅ ${n}`); else { fails++; console.log(`❌ ${n}${e ? '  ' + String(e).slice(0, 300) : ''}`); } };

const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
await page.goto('file://' + HTML);
await page.waitForFunction(() => typeof app !== 'undefined' && app._kbarTryFire && app._comboPlan, null, { timeout: 30000 });
const R = await page.evaluate(() => {
    const A = app, o = {};
    const rows = []; for (let i = 0; i < 60; i++) rows.push({ date: '2026/08/' + String(i % 28 + 1).padStart(2, '0'), open: 200, high: 205, low: 195, close: 200 + i * 0.3, volume: 5000 });
    A.settings.stratUnlock = true;
    A._getInventory = () => [{ symbol: '5483', cost: 224.47, shares: 1 }]; A.inventory = A._getInventory();
    // ① sweep:一則 warn 訊號、入場券放行
    A._tagPush = (arr) => { arr.push({ tone: 'warn', title: '急漲過熱(高檔留意)', msg: 'x', _d: '_detectChuOverheat' }); };
    A._alertWorthIt = () => ({ ok: true, why: '', edge: null });
    A._kbarFiredToday = () => false;
    const run = (strat) => {
        A.settings.strategy = strat;
        let fire = 0, quiet = 0;
        const f0 = A._fireAlert, q0 = A._alertQuiet;
        A._fireAlert = () => { fire++; }; A._alertQuiet = () => { quiet++; };
        try { A._kbarTryFire('5483', '中美晶', rows, { left: 3, extra: 0 }); } finally { A._fireAlert = f0; A._alertQuiet = q0; }
        return { fire, quiet };
    };
    o.lead = run('leadpark'); o.gene = run('gene');
    // ②③ 連續技:_exitLines stub 成截圖的數字
    A._exitLines = () => ({ cost: 224.47, shares: 1, pC: 221.5, atr2: 252.71, don40: 165, don: 170, trail8: 255.76, ma5: 203.3 });
    A._exitRuleKey = () => 'atr2';
    A._leadVerdict = () => ({ left: 6, isRebal: false, H: 10 });
    A.settings.strategy = 'leadpark';
    const pl = A._comboPlan('5483', rows); o.leadHtml = A._comboPlanHtml('5483', pl, '⚠️ 急漲過熱(高檔留意)');
    A.settings.strategy = 'gene';
    const pg = A._comboPlan('5483', rows); o.aboveHtml = A._comboPlanHtml('5483', pg, '⚠️ 急漲過熱(高檔留意)'); o.above = !!(pg && pg.prim && pg.prim.above);
    A._exitLines = () => ({ cost: 224.47, shares: 1, pC: 221.5, atr2: 210.4, don40: 165, don: 170, trail8: 255.76, ma5: 203.3 });
    const pb = A._comboPlan('5483', rows); o.belowHtml = A._comboPlanHtml('5483', pb, '⚠️ 急漲過熱(高檔留意)');
    return o;
});
const txt = h => String(h || '').replace(/<[^>]+>/g, '');
ok('① 👑 持股 + 風險訊號 → ⛔ 不跳大視窗、進 🔔 歷史', R.lead.fire === 0 && R.lead.quiet > 0, JSON.stringify(R.lead));
ok('① 決定性對照:🔥 同一則 → 會跳', R.gene.fire > 0 && R.gene.fire === R.lead.quiet, JSON.stringify(R.gene));
ok('② 👑 連續技⛔ 不出現先出一半 / 吊燈 / 你設定的出場規則', !/先出一半|吊燈|你設定的出場規則|賣在這裡/.test(txt(R.leadHtml)), txt(R.leadHtml));
ok('② 👑 連續技講換倉日排名 + 剩幾天(讀 _leadVerdict)', /換倉日/.test(txt(R.leadHtml)) && /6 個交易日/.test(txt(R.leadHtml)), txt(R.leadHtml));
ok('③ 🔥 線 252.71 > 現價 221.5 → 標 above', R.above === true);
ok('③ 線已破:⛔ 不印「賣在這裡」「先出一半」,要講已經在現價上面', !/賣在這裡|先出一半/.test(txt(R.aboveHtml)) && /已經在現價上面/.test(txt(R.aboveHtml)), txt(R.aboveHtml));
ok('③ 參考線在現價上方要標出來(移動停利 255.76)', /255\.76\(已在現價上方\)/.test(txt(R.aboveHtml)), txt(R.aboveHtml));
ok('③ 決定性對照:線 210.4 < 現價 → 照舊先出一半 + 賣在這裡', /先出一半/.test(txt(R.belowHtml)) && /賣在這裡/.test(txt(R.belowHtml)) && !/已經在現價上面/.test(txt(R.belowHtml)), txt(R.belowHtml));
const SRC = fs.readFileSync(HTML, 'utf8');
ok('④ 題材龍頭徽章⛔ 不用 👑', /🏅 \$\{leader\}/.test(SRC) && !/👑 \$\{leader\}/.test(SRC));
ok('無 pageerror', errs.length === 0, errs.join(' | '));
await browser.close();
console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ 全部通過');
process.exit(fails ? 1 : 0);
