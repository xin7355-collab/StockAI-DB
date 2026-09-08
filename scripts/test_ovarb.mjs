// ⚖️ V75.0.7 仲裁層(一行收斂條)—— 使用者:「整套散戶 App 常常不知道看哪個」
//   ⭐ 它是第三個「只轉述、⛔ 不重算」的轉述器(同 `_ovDigest` / `_renderPageLead`)。
//   ⛔ 三條鐵則:①不投票不加權(陷阱 #38)②方向以主卡為準(單一劇本原則)
//              ③🚨 沒有實測背書的系統必須標出來 —— 5 個裡只有 1 個有回測數字。
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
    const S = 'T8888';
    const set = (o) => {
        app.currentSymbolId = S;
        app._ovTrend = o.trend ? { sym: S, trend: o.trend, txt: o.trend === 'bull' ? '多頭' : o.trend === 'bear' ? '空頭' : '盤整' } : null;
        app._lastTechScore = o.tech == null ? null : { sym: S, score: o.tech };
        app._lastChipScore = o.chip == null ? null : { sym: S, score: o.chip };
        app._lastBBScan = o.bb == null ? null : { sym: S, ratio: o.bb, verdict: '多方優勢', lowSample: !!o.low };
        app._ecCache = o.ec == null ? null : { sym: S, at: Date.now(), r: { score: o.ec } };
        return app._ovArbLine(S);
    };
    const out = {};
    out.clash = set({ trend: 'bear', tech: 72, chip: 65, bb: 0.7, ec: 70 });      // 主結論空、其餘全多 → 打架
    out.agree = set({ trend: 'bull', tech: 72, chip: 65, bb: 0.7, ec: 70 });      // 全部同向
    out.low   = set({ trend: 'bull', tech: 72, chip: 65, bb: 0.7, low: 1, ec: 70 });  // 多空計分樣本不足 → 不當一票
    out.one   = set({ trend: 'bull' });                                            // 只有一個 → 不顯示
    out.other = (() => { app._ovTrend = { sym: 'ZZZZ', trend: 'bull', txt: '多頭' }; app._lastTechScore = { sym: 'ZZZZ', score: 90 };
                         app._lastChipScore = null; app._lastBBScan = null; app._ecCache = null; return app._ovArbLine(S); })();  // 別檔殘留
    return out;
});
await b.close();
const strip = h => String(h).replace(/<[^>]*>/g, '');

ok('① 打架時要講出「它們在打架」', /它們在打架/.test(strip(R.clash)), strip(R.clash).slice(0, 300));
ok('①b 全部同向時⛔ 不可硬說打架', !/它們在打架/.test(strip(R.agree)), strip(R.agree).slice(0, 300));
ok('② 🚨 打架時方向以主卡為準,而且要明寫「不投票」',
    /不投票/.test(strip(R.clash)) && /以上面那張主卡/.test(strip(R.clash)), strip(R.clash).slice(0, 400));
// ⚠️ 第一版這條寫成一個「怎樣都會過」的三元式 = 假綠燈,改成直接驗數字
ok('③ 🚨 必須標出「幾個有實測數字」+「其餘沒有回測過」',
    /有實測數字的\(2\/5\)/.test(strip(R.clash)) && /其餘 3 個/.test(strip(R.clash)) && /從來沒有回測過/.test(strip(R.clash)),
    strip(R.clash).slice(-400));
ok('③b 實測數字要寫出來(1.28 個百分點 + 擋掉率 + 2022 方向相反)',
    /1\.28/.test(strip(R.clash)) && /4\.8%/.test(strip(R.clash)) && /2022/.test(strip(R.clash)), strip(R.clash).slice(-400));
ok('③c ⛔ 不可宣稱「空頭一定會跌」,要說是一致性守門',
    /一致性守門/.test(strip(R.clash)) && !/空頭一定會跌(?!」)/.test(strip(R.clash).replace(/⛔ 不是「空頭一定會跌」/g, '')), strip(R.clash).slice(-300));
ok('④ 多空計分 lowSample 時⛔ 不可當一票(5 個變 4 個)',
    /有 4 個系統/.test(strip(R.low)) && /有 5 個系統/.test(strip(R.agree)), strip(R.low).slice(0, 120));
ok('⑤ 只有一個系統時整條不顯示(⛔ 不留空殼)', R.one === '', String(R.one).slice(0, 120));
ok('⑥ 別檔的快取⛔ 不可被算進來(切股殘留)', R.other === '', String(R.other).slice(0, 200));
ok('⑦ 計數要對:打架那組 偏多 4 / 偏空 1',
    /偏多 4/.test(strip(R.clash)) && /偏空 1/.test(strip(R.clash)), strip(R.clash).slice(0, 300));

// ── 靜態:⛔ 只轉述不重算(跟 `test_ovdigest` ② / `test_pagelead` ⑨ 同一條規矩)──
const fn = (SRC.match(/\n    _ovArbSources\(sym\) \{[\s\S]*?\n    \},[\s\S]*?\n    _ovArbLine\(sym\) \{[\s\S]*?\n    \},/) || [''])[0];
ok('⑧ 取樣守門:抓得到那兩支函式(⛔ 抓不到下面全是假綠燈)', fn.length > 800, `len=${fn.length}`);
ok('⑨ 🚨 ⛔ 不可自己算任何指標(_detectXxx / _calcBullBearScan( / 均線)',
    !/_detect[A-Z]/.test(fn) && !/_calcBullBearScan\(/.test(fn) && !/\bma20\b|\bma60\b/.test(fn), fn.slice(0, 400));
ok('⑩ ⛔ 不可加權平均 / 算總分(陷阱 #38)',
    !/weight|加權|totalScore|\*\s*0\.[0-9]/.test(fn), fn.slice(0, 400));

console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n🎉 全部通過');
process.exit(fails.length ? 1 : 0);
