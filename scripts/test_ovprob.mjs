#!/usr/bin/env node
/**
 * 📊 V78.4.3 總覽的機率圖(使用者:「這段改在總覽裡面,並用圖表或其它方式一目了然方式重新」)守門
 *   ⓐ 頂端那一行(#quoteProbLine)已拿掉,總覽有 #ovProbBox,`_renderOvCommand` 會呼叫它
 *   ⓑ ⭐ 決定性對照:把這一格的機率改成 77.7/11.1/11.2 → 圖上的數字與條寬一起變(⛔ 不是寫死、⛔ 不另算)
 *   ⓒ 「一般股票」那條與贏大盤白線讀 `T.base`(⛔ 基準不可省)
 *   ⓓ 白話句門檻:差 <3 個百分點「差不多」、≥3「多 / 少 N 個百分點」(成立 / 不成立各一組)
 *   ⓔ 漲紅 / 平灰 / 跌綠(inline style),⛔ 研究字樣(lib_retailbad)
 *   ⓕ 綁 sym:換別檔 / 指數 → 清空
 *   ⓖ 390px 放進 358px 的容器:每個子元素都不超出(先注入 rwdshim)
 * 注入:INJECT=nobase(拿掉一般股票那條)/ hard(數字寫死)/ nobind(不綁 sym)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { badOf } from './lib_retailbad.mjs';
import { rwdShim } from './lib_rwdshim.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIG = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let SRC = ORIG;
const INJ = process.env.INJECT || '';
if (INJ === 'nobase') SRC = SRC.replace(`<div style="flex:1 1 auto;min-width:0">\${bar(b, false)}</div>`, '');
if (INJ === 'hard') SRC = SRC.replace(`\${seg(r[1], C.up, '漲 ' + fmt1(r[1]), big)}`, `\${seg(40, C.up, '漲 40.0', big)}`);
if (INJ === 'nobind') SRC = SRC.replace(`if (!sym || String(sym) !== String(this.currentSymbolId) || (this._isIndexSym && this._isIndexSym(sym))) return off();
        const h = this._probBox(sym, { mode: 'chart'`, `if (!sym) return off();
        const h = this._probBox(sym, { mode: 'chart'`);
if (INJ && SRC === ORIG) { console.log('❌ 注入沒有注進去'); process.exit(1); }
const TMP = path.join(ROOT, '.test_ovprob.html');
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
await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._probBox === 'function' && app._PROB_TABLE, null, { timeout: 60000 });
const shimFail = await page.evaluate(rwdShim);
ok('⓪ 版面 shim 全部生效(⛔ 沒生效時量到的幾何不可信)', Array.isArray(shimFail) && !shimFail.length, shimFail);

const R = await page.evaluate(() => {
    const o = {};
    const mk = n => { const a = []; let p = 100; for (let i = 0; i < n; i++) { p *= 1 + Math.sin(i / 7) * 0.01 + 0.0006; const d = new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10); a.push({ date: d, open: p, high: p * 1.01, low: p * 0.99, close: p, volume: 1000 }); } return a; };
    const data = mk(400);
    app._scrData = null;
    const T = app._PROB_TABLE, f = app._probFeatures(data);
    o.cell = f && f.cell;
    const hz = T.hz, i1 = hz.indexOf(1), i20 = hz.indexOf(20);
    o.base = [T.base[i1].slice(0, 4), T.base[i20].slice(0, 4), T.base[i20][11]];
    o.noLine = !document.getElementById('quoteProbLine');
    o.box = !!document.getElementById('ovProbBox');
    o.wired = /_renderOvProb\(sym\)/.test(app._renderOvCommand.toString());
    app.currentSymbolId = '9999'; app.rawDailyData = data;
    const el = document.getElementById('ovProbBox');
    const read = () => {
        const c = el.querySelector('[data-probchart]');
        if (!c) return null;
        const hzs = [...c.querySelectorAll('[data-probhz]')].map(b => {
            const bars = [...b.querySelectorAll('div[style*="height:18px"], div[style*="height:6px"]')];
            return { name: b.getAttribute('data-probhz'), txt: b.innerText, w: bars.map(x => [...x.children].map(ch => parseFloat(ch.style.width))), bg: bars.length ? [...bars[0].children].map(ch => ch.style.background) : [] };
        });
        return { txt: c.innerText, hzs, beat: (c.querySelector('[data-probbeat]') || {}).innerText || '' };
    };
    app._renderOvProb('9999'); o.a = read(); o.aHidden = el.classList.contains('hidden');
    // ⓑ 決定性對照
    const keep = T.cells[f.cell];
    const row = keep.map(r => r ? r.slice() : r);
    row[i1] = row[i1].slice(); row[i1][1] = 77.7; row[i1][2] = 11.1; row[i1][3] = 11.2;
    row[i20] = row[i20].slice(); row[i20][1] = T.base[i20][1] + 1; row[i20][11] = 60.0;
    T.cells[f.cell] = row;
    app._renderOvProb('9999'); o.b = read();
    // ⓓ 20 天差 ≥3
    row[i20][1] = T.base[i20][1] + 8.4; app._renderOvProb('9999'); o.d = read();
    T.cells[f.cell] = keep;
    // ⓕ 綁 sym
    app._renderOvProb('1234'); o.other = [el.classList.contains('hidden'), el.innerHTML];
    app._renderOvProb('9999');
    app.currentSymbolId = '^TWII'; app._renderOvProb('^TWII'); o.idx = [el.classList.contains('hidden'), el.innerHTML];
    app.currentSymbolId = '9999'; app._renderOvProb('9999');
    // ⓖ 358px 容器
    const wrap = document.createElement('div'); wrap.style.cssText = 'width:358px;position:absolute;left:0;top:0;background:#000';
    wrap.innerHTML = el.innerHTML; document.body.appendChild(wrap);
    const W = wrap.getBoundingClientRect();
    o.wrapW = W.width;
    o.over = [...wrap.querySelectorAll('*')].map(x => { const r = x.getBoundingClientRect(); return { r: r.right - W.right, l: W.left - r.left, t: (x.innerText || '').slice(0, 20) }; }).filter(x => x.r > 1 || x.l > 1);
    wrap.remove();
    o.html = el.innerHTML;
    return o;
});
const f1 = v => v.toFixed(1);
ok('ⓐ 頂端那一行已拿掉、總覽有 #ovProbBox 並由 _renderOvCommand 呼叫', R.noLine && R.box && R.wired, [R.noLine, R.box, R.wired]);
ok('ⓐ2 圖畫出來了(明天 + 抱 20 天 + 贏大盤)', R.a && !R.aHidden && R.a.hzs.length === 2 && /贏過大盤/.test(R.a.beat), R.a && R.a.txt);
ok('ⓑ ⭐ 決定性對照:這一格改成 77.7/11.1/11.2 → 明天那條數字與寬度跟著變',
    R.b && /漲 77\.7/.test(R.b.hzs[0].txt) && Math.abs(R.b.hzs[0].w[0][0] - 77.7) < 0.01 && Math.abs(R.b.hzs[0].w[0][2] - 11.2) < 0.01, R.b && JSON.stringify(R.b.hzs[0]));
ok('ⓑ2 贏大盤跟著變(60.0%)', R.b && /60\.0%/.test(R.b.beat), R.b && R.b.beat);
ok('ⓒ 「一般股票」那條讀 T.base(明天 / 20 天)', R.a && R.a.hzs[0].w[1] && Math.abs(R.a.hzs[0].w[1][0] - R.base[0][1]) < 0.01 && Math.abs(R.a.hzs[1].w[1][2] - R.base[1][3]) < 0.01
    && R.a.hzs[1].txt.includes(`${f1(R.base[1][1])}/${f1(R.base[1][2])}/${f1(R.base[1][3])}`), R.a && JSON.stringify(R.a.hzs[1].w));
ok('ⓒ2 贏大盤白線 = 一般股票基準', R.a && R.a.beat.includes(`一般股票 ${f1(R.base[2])}%`), R.a && R.a.beat);
ok('ⓓ 差 <3 個百分點 → 「差不多」', R.b && /漲的機會跟一般股票差不多/.test(R.b.hzs[1].txt), R.b && R.b.hzs[1].txt);
ok('ⓓ2 差 ≥3 → 「多 8 個百分點」', R.d && /漲的機會比一般股票多 8 個百分點/.test(R.d.hzs[1].txt), R.d && R.d.hzs[1].txt);
ok('ⓔ 漲紅 / 平灰 / 跌綠', R.a && /217, 83, 79|d9534f/i.test(R.a.hzs[0].bg[0]) && /110, 118, 129|6e7681/i.test(R.a.hzs[0].bg[1]) && /63, 185, 80|3fb950/i.test(R.a.hzs[0].bg[2]), R.a && R.a.hzs[0].bg);
ok('ⓔ2 ⛔ 研究字樣', R.a && !badOf(R.a.txt).length, R.a && badOf(R.a.txt));
ok('ⓔ3 寫明「不是預測」', R.a && /不是預測/.test(R.a.txt));
ok('ⓕ 換別檔 → 清空', R.other[0] === true && R.other[1] === '', R.other);
ok('ⓕ2 指數 → 清空', R.idx[0] === true && R.idx[1] === '', R.idx);
ok('ⓖ 358px 容器(空過守門:容器真的有 358px)', R.wrapW >= 350, R.wrapW);
ok('ⓖ2 每個子元素都在容器內(⛔ 橫向溢出)', !R.over.length, JSON.stringify(R.over.slice(0, 3)));
ok('ⓩ 無 pageerror', !errs.length, errs.slice(0, 2));
await browser.close();
try { fs.unlinkSync(TMP); } catch (_) {}
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ test_ovprob 全過');
process.exit(fails.length ? 1 : 0);
