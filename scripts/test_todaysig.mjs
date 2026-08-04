#!/usr/bin/env node
/**
 * 🎯 今日實測訊號條(V72.2.0)
 *
 * 使用者原話:「只要給我最好、勝率最高的資料」「一目了然知道現在要怎麼做」。
 *
 * 問題:`_SIGNAL_EDGE` 的實測成績只在**個股頁**看得到 —— 使用者得先想到要看哪一檔,
 *      才知道它今天有沒有訊號,等於要他自己翻 2,315 檔(陷阱 #32 的極端版)。
 * → 採礦端 `daily_signal_scan.mjs` 全市場掃(實測 2,315 檔 / 177 秒 / 產出 3.6 KB),
 *   選股頁最上方常駐一條。實測結果:**全市場今天只有 17 檔**有正期望值訊號。
 *
 * ⛔ 這支釘住:
 *   ① 榜單只收**看多且 exp>0**(常對但不賺的不進榜)
 *   ② ⛔ **不逐檔列出風險股**(全市場 6,158 筆沒有可操作性,截斷反而誤導)—— 只給總數
 *   ③ 沒資料 → **整條不顯示**(不留空殼)
 *   ④ 三個免責必須在:基準勝率不是 50% / 未扣交易成本 / 不是保證
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 240)}`}`); if (!c) fails.push(n); };
const txt = h => String(h == null ? '' : h).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._renderTodaySignalBar, null, { timeout: 20000 });

// ⭐ 用**採礦端真的產出的檔**當測資(⛔ 不用合成的,那驗不到欄位對接)
let real = null;
try { real = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/today_signals.json'), 'utf8')); } catch (_) { }
ok('① ⭐ 採礦端真的產得出 today_signals.json', !!real, '找不到 data/today_signals.json');
if (real) {
    ok('① 有 bull 榜且是陣列', Array.isArray(real.bull), typeof real.bull);
    ok('① ⭐ bull 榜每筆的期望值都必須 > 0(⛔ 常對但不賺的不進榜)',
       real.bull.every(x => x.exp > 0), JSON.stringify(real.bull.filter(x => !(x.exp > 0)).slice(0, 3)));
    ok('① ⭐⛔ 不可輸出風險股清單(只給總數)',
       !Array.isArray(real.risk), `risk 欄位型別 ${typeof real.risk}`);
    ok('① 有給風險總數當大盤氛圍', Number.isFinite(real.risk_n) && Number.isFinite(real.risk_syms),
       JSON.stringify({ n: real.risk_n, s: real.risk_syms }));
    ok('① ⭐ 必須帶交易成本免責欄位', /未扣交易成本/.test(String(real.cost_note)), real.cost_note);
    ok('① 價格要 round(⛔ 不可出現 62.70000076293945 這種)',
       real.bull.every(x => String(x.c).replace(/^-?\d+\.?/, '').length <= 2),
       JSON.stringify(real.bull.map(x => x.c).slice(0, 5)));
    ok('① 檔案要夠小(≤ 30 KB)', JSON.stringify(real).length <= 30720, `${(JSON.stringify(real).length / 1024).toFixed(1)} KB`);
    console.log(`   ↳ 掃 ${real.scanned} 檔 ・命中 ${real.bull.length} 檔 ・風險 ${real.risk_n} 筆/${real.risk_syms} 檔`);
}

const render = d => page.evaluate(async j => {
    app._todaySig = j;
    await app._renderTodaySignalBar();
    const el = document.getElementById('todaySignalBar');
    return { hidden: el.classList.contains('hidden'), html: el.innerHTML };
}, d);

// ── ② 有資料 → 顯示,且免責齊全 ────────────────────────────
const R = await render(real || { bull: [{ s: '8464', c: 382.5, t: '換手量(洗籌續攻)', g: 'A', n: 1309, w: 42.4, exp: 0.68 }], scanned: 2315, base_win: 36.4, data_date: '2026-08-03', cost_note: '期望值未扣交易成本(來回約 0.44%,當沖 0.25%)', risk_n: 6158, risk_syms: 2079 });
const t = txt(R.html);
ok('② 有資料時要顯示', !R.hidden && t.length > 80, `hidden=${R.hidden}`);
ok('② ⭐ 標題要點出「全市場 N 檔只有 M 檔」(這就是「只給最好的」)',
   /全市場 [\d,]+ 檔只有/.test(t), t.slice(0, 160));
ok('② ⭐ 必須標基準勝率(否則 42% 會被誤讀成輸)', /基準勝率 \d+%/.test(t), t.slice(-320));
ok('② ⭐⛔ 必須寫明未扣交易成本', /未扣交易成本/.test(t), t.slice(-320));
ok('② ⭐ 必須寫明「不是保證」', /不是保證/.test(t), t.slice(-320));
ok('② 要標資料日期(⛔ 別讓人以為是即時)', /收盤資料/.test(t), t.slice(-320));
ok('② ⭐ 風險只給檔數、⛔ 不逐檔列', /檔出現風險訊號/.test(t) && /不逐檔列出/.test(t), t.slice(-320));
ok('② ⛔ 代號不可重複顯示兩次(getStockName 沒載入時會回代號本身)',
   !/\b(\d{4})\s+\1\b/.test(t), (t.match(/\b(\d{4})\s+\1\b/) || []).join(','));

// ── ③ 沒資料 → 整條不顯示(⛔ 不留空殼)───────────────────
for (const [name, d] of [['bull 是空陣列', { bull: [], scanned: 2315 }], ['整包 null', null], ['沒有 bull 欄位', { scanned: 1 }]]) {
    const r = await render(d);
    ok(`③ ⛔ ${name} → 整條隱藏且清空`, r.hidden && r.html === '', `hidden=${r.hidden} len=${r.html.length}`);
}

// ── ④ 教學要說清楚「為什麼只有十幾檔」────────────────────────
const help = await page.evaluate(() => {
    let s = ''; const o = window.alert; window.alert = x => { s = x; };
    app._showTodaySigHelp(); window.alert = o; return s;
});
ok('④ ⭐ 教學要解釋「為什麼通常只有十幾檔」', /為什麼通常只有十幾檔/.test(help), help.slice(0, 300));
ok('④ ⭐ 要說明「大部分訊號常對但輸更大」', /輸的時候輸更大/.test(help), help.slice(0, 500));
ok('④ ⭐ 三個免責都要在(基準/成本/不是保證)',
   /不是 50%/.test(help) && /沒有.{0,4}扣交易成本/.test(help) && /不是保證/.test(help), help.slice(-400));
ok('④ 要說明只看 K 線、沒看籌碼基本面', /沒有看籌碼/.test(help), help.slice(-300));

// ── ⑤ 接線:選股頁進入時要載入,ETF 模式要隱藏 ────────────────
const wired = await page.evaluate(() => ({
    tab: /_renderTodaySignalBar\(\)/.test(app.switchAppTab.toString()),
    mode: /_renderTodaySignalBar\(\)/.test(app.switchRadarMode.toString()),
    etfHide: /mode !== 'strategy'\) tsb\.classList\.add\('hidden'\)/.test(app.switchRadarMode.toString()),
}));
ok('⑤ ⭐ 切到選股頁會載入', wired.tab, '');
ok('⑤ 切換策略/ETF 模式也會處理', wired.mode, '');
ok('⑤ ⭐ ETF 模式要隱藏(那條只跟策略選股有關)', wired.etfHide, '');

// ── ⑥ 採礦腳本本身的鐵則(⛔ 別在那裡另立一套判定)──────────────
const scan = fs.readFileSync(path.join(ROOT, 'scripts/daily_signal_scan.mjs'), 'utf8');
ok('⑥ ⭐ 掃描腳本要跑**真的**偵測器(⛔ 不複製判定邏輯)',
   /app\[d\]\(rows\)/.test(scan) && /不複製一份判定邏輯/.test(scan), '');
ok('⑥ ⭐ 看多必須 exp>0 才進榜', /h\.tone === 'bull' && h\.exp != null && h\.exp > 0/.test(scan), '');
ok('⑥ ⭐⛔ 註解要寫明「不輸出風險股清單」的理由', /刻意不輸出風險股清單/.test(scan), '');
ok('⑥ ⛔ 不可在採礦端重複存股票名稱(前端已有 getStockName)',
   /刻意\*\*不存股票名稱\*\*/.test(scan), '');

ok('⑦ 無 pageerror', errs.length === 0, errs.join(' | '));

await browser.close();
console.log('');
if (fails.length) { console.log(`❌ TODAYSIG_TEST_FAIL: ${JSON.stringify(fails)}`); process.exit(1); }
console.log('✅ TODAYSIG_TEST_PASS');
