#!/usr/bin/env node
/**
 * 🧪 「同一分點連買 ≥3 天且已發動」顯示(V74.0.6)—— 把五個設計釘死。
 *
 * ① 連買 3 天 + 5日 ≥8% → 顯示(含實測數字)
 * ② 🚨 連買但**還沒漲**(<8%)→ ⛔ 不顯示(隱形吃貨實測 ≈ 0,放寬條件 = 把沒用的顯出來)
 * ③ 🚨 三天不是**連續交易日**(中間缺席)→ ⛔ 不顯示(缺席不算連買)
 * ④ 文案:必須有樣本數/實測數字與「不是進場指令」;⛔ 不可出現指令動詞
 * ⑤ 切股防殘留:_fenSym 不符 → null
 * 全部走真的 app._chipRunBuy(⛔ 不複製判定邏輯);headless 載真 App。
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_MODULE || '/opt/node22/lib/node_modules/playwright');
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = { executablePath: process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' };
let fails = 0;
const ck = (name, cond, extra = '') => {
  console.log((cond ? '  ✅ ' : '  ❌ ') + name + (cond ? '' : `  ← ${extra}`));
  if (!cond) fails++;
};

const browser = await chromium.launch({ ...exe, args: ['--no-sandbox', '--allow-file-access-from-files'] });
const page = await browser.newPage();
// echarts CDN 在沙盒被擋 → 萬用 stub(同 smoke_test 的做法)
await page.addInitScript(() => {
  const noop = () => inst;
  const inst = new Proxy({}, { get: (_t, k) => (k === 'getWidth' || k === 'getHeight') ? (() => 300) : noop });
  const ec = new Proxy({}, { get: (_t, k) => k === 'init' ? (() => inst) : (k === 'graphic' ? {} : noop) });
  window.echarts = ec;
});
page.on('pageerror', (e) => {
  // file:// 下 SW 的 Cache.put 必炸,是環境限制不是 App bug(smoke_test 同樣略過)
  if (/Cache|file' is unsupported/.test(e.message)) return;
  console.error('pageerror:', e.message); fails++;
});
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
// ⚠️ 陷阱 #5:`const app = {}` 不掛 window → 要用裸 `app`(全域 lexical binding)
await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._chipRunBuy === 'function', null, { timeout: 30000 });

const R = await page.evaluate(() => {
  /* global app */
  const mk = (n, base) => {
    // 合成 30 根日 K(平日),最後 6 根走出 +10%
    const rows = []; let d = new Date(Date.UTC(2026, 0, 5)); let c = base;
    while (rows.length < 30) {
      if (d.getUTCDay() >= 1 && d.getUTCDay() <= 5) {
        if (rows.length >= 24) c *= 1.017;          // 最後 6 根 ≈ +10.6%
        rows.push({ date: d.toISOString().slice(0, 10), open: c, high: c * 1.01, low: c * 0.99,
                    close: +c.toFixed(2), volume: 10_000_000 });
      }
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return rows;
  };
  const data = mk(30, 100);
  const dts = data.map((r) => r.date);
  const histOf = (days, name, net) => days.map((di) => ({ d: dts[di], b: [[name, net, 100]], s: [] }));
  const out = {};
  app.rawDailyData = data; app._fenSym = 'TEST';

  // ① 連續 3 天連買(倒數 3 個交易日)且已發動
  out.hit = app._chipRunBuy('TEST', histOf([27, 28, 29], '凱基台北(🔥測試)', 200_000));
  // ② 連買但還沒漲:改用前段平盤區的 3 天
  const flat = mk(30, 100); flat.forEach((r, i) => { if (i >= 24) { r.close = 100; r.open = 100; } });
  app.rawDailyData = flat;
  out.noMove = app._chipRunBuy('TEST', histOf([27, 28, 29], '凱基台北', 200_000));
  app.rawDailyData = data;
  // ③ 三天不連續(27、28、跳過 29 改 26 → 亂序/缺席)
  out.gap = app._chipRunBuy('TEST', histOf([26, 28, 29], '凱基台北', 200_000));
  // ③b 量門檻:淨買 < 0.5% 量(4 萬股 / 1000 萬股 = 0.4%)
  out.small = app._chipRunBuy('TEST', histOf([27, 28, 29], '凱基台北', 40_000));
  // ⑤ 切股殘留
  app._fenSym = 'OTHER';
  out.wrongSym = app._chipRunBuy('TEST', histOf([27, 28, 29], '凱基台北', 200_000));
  app._fenSym = 'TEST';
  // ④ 文案(直接渲染那段模板)
  const rb = out.hit;
  out.html = '';
  if (rb) {
    out.html = `連買 ${rb.days} 天 ` + rb.brokers.map((x) => `${x.nm} ${x.lots}張`).join('、');
  }
  return out;
});

ck('① 連買 3 天 + 已發動 → 有訊號', !!R.hit, JSON.stringify(R.hit));
ck('①b 券商名去掉標籤、張數正確(200,000 股 ×3 = 600 張)',
  R.hit && R.hit.brokers[0].nm === '凱基台北' && R.hit.brokers[0].lots === 600,
  JSON.stringify(R.hit && R.hit.brokers));
ck('② 🚨 連買但還沒漲 → ⛔ 不顯示(隱形吃貨實測 ≈ 0)', R.noMove == null, JSON.stringify(R.noMove));
ck('③ 🚨 三天不連續 → ⛔ 不顯示(缺席不算連買)', R.gap == null, JSON.stringify(R.gap));
ck('③b 淨買 < 0.5% 量 → 不顯示', R.small == null, JSON.stringify(R.small));
ck('⑤ _fenSym 不符 → null(切股防殘留)', R.wrongSym == null, JSON.stringify(R.wrongSym));

// ④ 文案掃描:只掃 _chipRunBuy 注入的那段模板(⛔ 別掃全檔 —— _CHANGELOG 會誤中)
const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const at = src.indexOf('同一分點連買 ${rb.days} 天');
const seg = src.slice(at, at + 1600);
ck('④ 空過守門:模板段真的找得到', at > 0 && seg.length > 800, `at=${at}`);
ck('④b 必須有實測數字與樣本', seg.includes('+0.85%') && seg.includes('+1.36%') && seg.includes('3.4 萬筆'), '實測數字不見了');
ck('④c 必須寫「不是進場指令」與多頭窗口限制',
  seg.includes('不是進場指令') && seg.includes('偏多頭'), '免責不見了');
ck('④d ⛔ 不可出現指令動詞(買進/加碼/追/進場吧)',
  !/(買進|可加碼|快追|進場吧|放心買)/.test(seg), '出現指令動詞');
ck('④e 隱形吃貨的「≈ 0」誠實揭露要在卡上', seg.includes('還沒漲') && seg.includes('≈ 0'), '揭露不見了');

await browser.close();
console.log();
if (fails) { console.log(`❌ ${fails} 條沒過`); process.exit(1); }
console.log('✅ CHIP_RUNBUY_PASS(全部通過)');
