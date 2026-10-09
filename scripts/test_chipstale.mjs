#!/usr/bin/env node
/**
 * 💳 V78.7.0 分點停住要說原因(`_chipStaleWhy`)守門
 *   2026-10-01 起 FinMind 付費金鑰失效 → 分點全市場停在 09/30,籌碼頁只寫「⚠️ 9天前」、
 *   而明日劇本那段還寫「這檔這輪還沒輪到、下次採礦補上就會變最新」(那句已經不對)。陷阱 #22。
 * 釘住:
 *   ⓐ broker_chip:false + 落後 ≥2 個交易日 → 有原因(含分點日、落後幾天、付費)
 *   ⓑ 決定性對照:broker_chip:true(這一輪有抓到)→ ''(⛔ 不可冤枉成付費失效)
 *   ⓒ 落後 1 個交易日 → ''(週末/剛收盤不叫)
 *   ⓓ 切股殘留:_fenSym ≠ currentSymbolId → ''
 *   ⓔ 籌碼卡真的畫出 [data-chipstale];明日劇本那句改讀同一支(⛔ 兩處各寫一份)
 *   注入:INJECT=nogate(拿掉 broker_chip 判斷)→ ⓑ 必紅
 */
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
let chromium;
try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); }
catch (_) { ({ chromium } = await import('playwright')); }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
if (process.env.INJECT === 'nogate') src = src.replace("if (!dc || dc.broker_chip !== false || ", "if (!dc || ");
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 300)}`}`); if (!c) fails.push(n); };

{   // 靜態:兩處讀同一支
    ok('ⓔa 明日劇本「落後」那句改讀 _chipStaleWhy(⛔ 另寫一份)', /\$\{this\._chipStaleWhy\(\) \|\| '分點是全市場輪流更新/.test(src));
    ok('ⓔb 籌碼卡最上方插 staleLine', /const _staleWhy = this\._chipStaleWhy\(\);/.test(src) && /rounded-lg p-3">\n\s*\$\{staleLine\}/.test(src));
    ok('ⓔc 讀 chips 檔時存 data_completeness', /this\._fenDc = \(raw && raw\.data_completeness/.test(src));
}

const TMP = path.join(ROOT, 'index.__chipstale_test.html');
fs.writeFileSync(TMP, src);
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const errs = [];
try {
    const p = await browser.newPage({ viewport: { width: 390, height: 844 } });
    p.on('pageerror', e => errs.push(String(e)));
    await p.goto('file://' + TMP);
    await p.waitForFunction(() => typeof app !== 'undefined' && typeof app._chipStaleWhy === 'function', null, { timeout: 30000 });
    const r = await p.evaluate(() => {
        const dates = ['2026/09/25', '2026/09/26', '2026/09/29', '2026/09/30', '2026/10/01', '2026/10/02', '2026/10/05', '2026/10/06', '2026/10/07', '2026/10/08'];
        const setup = (dc, fenDate, fenSym) => {
            app.currentSymbolId = 'TST1';
            app.rawDailyData = dates.map((d, i) => ({ date: d, open: 100, high: 101, low: 99, close: 100 + i, volume: 1000 }));
            app._fenSym = fenSym || 'TST1'; app._fenDataDate = fenDate || '2026-09-30'; app._fenDc = dc;
        };
        const out = {};
        setup({ broker_chip: false }); out.a = app._chipStaleWhy();
        setup({ broker_chip: true }); out.b = app._chipStaleWhy();
        setup(null); out.b2 = app._chipStaleWhy();
        setup({ broker_chip: false }, '2026-10-07'); out.c = app._chipStaleWhy();
        setup({ broker_chip: false }, null, 'OTHER'); out.d = app._chipStaleWhy();
        // 真的畫一次籌碼卡
        setup({ broker_chip: false });
        if (!document.getElementById('chipPaneBroker')) { const d = document.createElement('div'); d.id = 'chipPaneBroker'; document.body.appendChild(d); }
        app._fenPeriods = { '3d': { buy: [{ broker_name: '甲券商', net: 500, buy: 600, sell: 100 }], sell: [{ broker_name: '乙券商', net: -300, buy: 50, sell: 350 }] } };
        try { app._renderBrokerFenDian('3d'); } catch (e) { out.err = String(e); }
        const el = document.querySelector('#chipPaneBroker [data-chipstale]');
        out.e = el ? el.innerText : '';
        setup({ broker_chip: true });
        try { app._renderBrokerFenDian('3d'); } catch (e) { out.err2 = String(e); }
        out.e2 = !!document.querySelector('#chipPaneBroker [data-chipstale]');
        return out;
    });
    ok('ⓐ 分點停住 → 說原因(分點日 + 落後交易日 + 付費)', /09\/30/.test(r.a) && /落後 6 個交易日/.test(r.a) && /付費/.test(r.a), r.a);
    ok('ⓑ 決定性對照:這一輪有抓到 → 不說付費失效', r.b === '' && r.b2 === '', JSON.stringify([r.b, r.b2]));
    ok('ⓒ 只落後 1 個交易日 → 不叫', r.c === '', r.c);
    ok('ⓓ 切股殘留 → 不叫', r.d === '', r.d);
    ok('ⓔ 籌碼卡畫出 [data-chipstale](有抓到的那檔⛔ 不畫)', /分點資料停住了/.test(r.e) && /付費/.test(r.e) && r.e2 === false, JSON.stringify({ e: r.e.slice(0, 80), e2: r.e2, err: r.err, err2: r.err2 }));
} finally {
    await browser.close();
    try { fs.unlinkSync(TMP); } catch (_) {}
}
ok('pageerror 0', errs.length === 0, errs.slice(0, 3).join(' | '));
console.log(fails.length ? `\n❌ ${fails.length} 條失敗:${fails.join(' / ')}` : '\n✅ test_chipstale 全過');
process.exit(fails.length ? 1 : 0);
