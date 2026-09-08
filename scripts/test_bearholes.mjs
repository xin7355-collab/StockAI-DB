// 🚨 V75.0.6「講反話」剩下的 3 個守門漏洞(第 9~11 處)
//   本站修過 8 次「主結論是空頭、卡片還在叫人做多」,巡邏之後仍有 3 處裸奔:
//     ⑨ 六脈共振卡的「操作」(函式層與 renderSixMeridian 都沒守,只有 K線頁首有)
//     ⑩ renderChuKbarVerdict —— 6 個分支只有 1 個過守門
//     ⑪ 即時頁整條鏈(_dayTradeVerdict → renderDayTradeLight → _renderLiveLead)0 次守門
//   ⭐ ⑨⑩ 的修法是「改掉那句指令」;⑪ **刻意不同** —— 當沖看今天、主結論看波段,
//      時間尺度不同 ⛔ 不可蓋掉方向 → 方向照給、加一句「逆勢單:不留倉、部位放小」。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
const ROOT = '/home/user/StockAI-DB';
const SRC = fs.readFileSync(ROOT + '/index.html', 'utf8');
const url = pathToFileURL(ROOT + '/index.html').href;
let fails = [];
const ok = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + x}`); if (!c) fails.push(n); };

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu'] });
const pg = await b.newPage();
await pg.addInitScript(() => {
  const noop = () => inst;
  const inst = new Proxy({}, { get: (_t, k) => (k === 'getWidth' || k === 'getHeight') ? (() => 300) : noop });
  Object.defineProperty(window, 'echarts', { value: new Proxy({}, { get: (_t, k) => k === 'init' ? (() => inst) : (k === 'graphic' ? {} : noop) }), writable: true, configurable: true });
});
await pg.route('**/*', r => { const u = r.request().url(); if (u.startsWith('file://')) return r.continue(); if (/cdn|jsdelivr|unpkg|tailwind|echarts|cloudflare|googleapis|gstatic/i.test(u)) return r.continue(); return r.abort(); });
await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
await pg.waitForTimeout(2500);

const R = await pg.evaluate(() => {
    const SYM = 'T9999';
    // 強多頭日K(⭐ 讓 renderChuKbarVerdict 一定落在「順勢做多 / 過前高再追」那兩格)
    //   ⚠️ ⛔ 不可用「一路直線漲」—— 實測那會被判成「末升段過熱·出貨相」(sc 大負),
    //      那兩格根本走不到 → ⑩ 整組變成假綠燈(⑩a 空過守門就是為了抓這件事)。
    //      要的是「波段上升 + 最後一根帶量長紅」:有回檔、乖離不大、頭頭高底底高。
    const daily = [];
    for (let i = 0; i < 320; i++) {
        const px = 50 * Math.pow(1.0035, i) * (1 + 0.045 * Math.sin(i / 9));
        const o = px * 0.994, h = px * 1.008, l = px * 0.988;
        daily.push({ date: new Date(Date.UTC(2024, 0, 1) + i * 864e5).toISOString().slice(0, 10),
            open: +o.toFixed(2), high: +h.toFixed(2), low: +l.toFixed(2), close: +px.toFixed(2),
            volume: 8000000 + (i % 5) * 400000, foreign_net: 900000 });
    }
    { // 最後一根:帶量長紅過前高
        const prev = daily[daily.length - 2].close, c = prev * 1.045;
        daily[daily.length - 1] = { ...daily[daily.length - 1], open: +(prev * 1.001).toFixed(2),
            low: +(prev * 0.999).toFixed(2), high: +(c * 1.003).toFixed(2), close: +c.toFixed(2), volume: 24000000 };
    }
    // 盤中 1 分 K(站上均價、開高、量增 → dir=long)
    const bars = []; let ip = 100;
    for (let i = 0; i < 20; i++) { ip += 0.15; bars.push({ open: ip - 0.05, high: ip + 0.1, low: ip - 0.12, close: ip, average: ip - 0.25, volume: 900 + i * 60 }); }
    const q = { price: bars[19].close + 0.3, prevClose: 99.0 };

    const run = (trend) => {
        app.currentSymbolId = SYM;
        app.rawDailyData = daily;
        app._ovTrend = trend ? { sym: SYM, trend, txt: 'x' } : null;
        const out = {};
        try { app.renderSixMeridian(daily); } catch (e) { out.smErr = String(e); }
        out.sm = (document.getElementById('sixMeridianCard') || {}).innerHTML || '';
        try { app.renderChuKbarVerdict(daily); } catch (e) { out.ckErr = String(e); }
        out.ck = (document.getElementById('chuVerdictCard') || {}).innerHTML || '';
        try { app.renderDayTradeLight(bars, q); } catch (e) { out.dtErr = String(e); }
        out.dt = (document.getElementById('dayTradeLight') || {}).innerHTML || '';
        out.lead = (document.getElementById('liveLead') || {}).innerHTML || '';
        return out;
    };
    return { bear: run('bear'), bull: run('bull') };
});
await b.close();

const strip = h => String(h).replace(/<[^>]*>/g, '');

// ── ⑨ 六脈 ──────────────────────────────────────────────
ok('⑨a 測資守門:六脈卡真的有渲染出來(⛔ 空的話下面全是假綠燈)',
    strip(R.bull.sm).length > 80, `len=${strip(R.bull.sm).length} err=${R.bull.smErr || ''}`);
ok('⑨b 非空頭時「操作」照原樣(⛔ 不可誤傷)',
    strip(R.bull.sm).includes('✅ 操作'), strip(R.bull.sm).slice(0, 200));
ok('⑨c 空頭時「操作」要改口 + 標明是主結論空頭',
    strip(R.bear.sm).includes('操作(主結論空頭)') && strip(R.bear.sm).includes('當反彈看待'), strip(R.bear.sm).slice(-320));
ok('⑨d 空頭時⛔ 不可再出現「突破帶量可追 / 回檔量縮可承接」那種指令',
    !/突破帶量可追|回檔量縮可承接|右側加碼區/.test(strip(R.bear.sm)), strip(R.bear.sm).slice(-320));
ok('⑨e 事實描述(條件明細)一個字不動 —— 兩邊的分數列要一樣',
    strip(R.bear.sm).includes('ADX 趨勢強度') && strip(R.bull.sm).includes('ADX 趨勢強度'), '');

// ── ⑩ renderChuKbarVerdict ──────────────────────────────
ok('⑩a 測資守門:非空頭時真的落在那兩格(⛔ 沒落到的話 ⑩b 是假綠燈)',
    /順勢做多|等帶量長紅過前高再追/.test(strip(R.bull.ck)), strip(R.bull.ck).slice(-300));
//   ⚠️ ⛔ 比對前一定要先剝掉**否定形** —— 我自己寫的正確句子就含被禁的字
//      (「⛔ 不是順勢做多的理由」)。本站已踩過 13 次。
const noNeg = h => strip(h).replace(/⛔ 不是順勢做多的理由/g, '').replace(/⛔ 不是買點/g, '');
ok('⑩b 空頭時⛔ 不可再出現「順勢做多 / 等帶量長紅過前高再追」',
    !/順勢做多|等帶量長紅過前高再追/.test(noNeg(R.bear.ck)), noNeg(R.bear.ck).slice(-320));
ok('⑩e 共振卡(第 12 處)空頭時⛔ 不可寫「高信度買點,順勢做」',
    !/高信度買點/.test(noNeg(R.bear.ck)) && /這檔中期是空頭/.test(strip(R.bear.ck)), strip(R.bear.ck).slice(0, 300));
ok('⑩f 測資守門:非空頭時共振卡真的有出現(⛔ 否則 ⑩e 是假綠燈)',
    /買點共振/.test(strip(R.bull.ck)), strip(R.bull.ck).slice(0, 240));
ok('⑩c 空頭時要說出「主結論是空頭」且只能當反彈看',
    /主結論是空頭/.test(strip(R.bear.ck)) && /反彈/.test(strip(R.bear.ck)), strip(R.bear.ck).slice(-320));
ok('⑩d 事實描述不動:型態 headline 兩邊必須一樣(⛔ 不可連結論一起竄改)',
    (strip(R.bear.ck).match(/型態(讚|偏多成形)/) || [''])[0] === (strip(R.bull.ck).match(/型態(讚|偏多成形)/) || [''])[0],
    `bear=${(strip(R.bear.ck).match(/型態(讚|偏多成形)/) || [''])[0]} bull=${(strip(R.bull.ck).match(/型態(讚|偏多成形)/) || [''])[0]}`);

// ── ⑪ 即時頁 ────────────────────────────────────────────
ok('⑪a 測資守門:當沖燈真的判成做多(⛔ 否則下面驗不到)',
    /偏多・做多/.test(strip(R.bull.dt)), strip(R.bull.dt).slice(0, 200) + ' err=' + (R.bull.dtErr || ''));
ok('⑪b 🚨 空頭時⛔ 不可蓋掉當沖方向(時間尺度不同,蓋掉是另一種說謊)',
    /偏多・做多/.test(strip(R.bear.dt)), strip(R.bear.dt).slice(0, 200));
ok('⑪c 空頭時要加「逆勢單:不留倉、部位放小」',
    /逆勢單/.test(strip(R.bear.dt)) && /不留倉/.test(strip(R.bear.dt)), strip(R.bear.dt).slice(-320));
ok('⑪d 頁首(liveLead)也要有,⛔ 不可只有卡片有',
    /逆勢單/.test(strip(R.bear.lead)), strip(R.bear.lead).slice(-260));
ok('⑪e 非空頭時⛔ 不可出現那句(天天掛著會讓人習慣忽略)',
    !/逆勢單/.test(strip(R.bull.dt)) && !/逆勢單/.test(strip(R.bull.lead)), strip(R.bull.dt).slice(-200));

// ── 靜態:⛔ 全 App 只有一份 `_dtBearNote`(陷阱 #37)──────
const defN = (SRC.match(/\n    _dtBearNote\(/g) || []).length;
const useN = (SRC.match(/this\._dtBearNote\(/g) || []).length;
ok('⑫ `_dtBearNote` 定義 1 份、兩個顯示點各接一次(⛔ 不可各寫一份)',
    defN === 1 && useN === 2, `def=${defN} use=${useN}`);

console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n🎉 全部通過');
process.exit(fails.length ? 1 : 0);
