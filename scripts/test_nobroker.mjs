#!/usr/bin/env node
/**
 * 🗑️ V79.0.0 券商分點 + 10 個付費資料集移除守門(FinMind 付費金鑰 2026-10-01 失效,使用者決定一起拿掉)
 *
 * 釘住的用意:
 *   ① 付費產物⛔ 不可再被前端 fetch(停在 09/30 的舊檔不可冒充現在)
 *   ② 券商頁 / 🏅 券商模式 / 籌碼頁「券商分點」子頁籤⛔ 不可悄悄回來
 *   ③ ⛔ 不可刪過頭:籌碼頁仍有三大法人 + 融資券 + 集保分佈
 *   ④ 報告頁的基本面備援仍讀得到 chips/{sym}.json 的 fundamentals —— 決定性對照:
 *      把那份 fundamentals 拿掉,PE 那格就要變「—」(證明數字真的是從那裡來的)
 *   ⑤ 採礦端 / workflow ⛔ 不可再碰分點與付費資料集
 * ⚠️ 原始碼斷言一律先剝註解(被自己的註解救活已經七次)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(process.env.NB_FILE || path.join(ROOT, 'index.html'), 'utf8');
const PRO = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');
const MINER = fs.readFileSync(path.join(ROOT, 'miner.py'), 'utf8');
const RADAR = fs.readFileSync(path.join(ROOT, 'radar_miner.py'), 'utf8');
const WF = fs.readFileSync(path.join(ROOT, '.github/workflows/daily_miner.yml'), 'utf8');
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 240)}`); if (!c) fails++; };
const noCmt = t => t.replace(/<!--[\s\S]*?-->/g, '').split('\n').map(l => l.replace(/(^|[^:'"`])\/\/.*$/, '$1')).join('\n');
const noPyCmt = t => t.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
const JS = noCmt(SRC), PJS = noCmt(PRO);

// ① 付費產物⛔ 不可再被 fetch
const PAID = ['broker_perf', 'broker_radar', 'broker_book', 'broker_dt', 'broker_signals', 'broker_names', 'fmx_pack', 'govbank',
    'lending', 'holders', 'daytrade', 'industry_chain', 'foreign_hold', 'blocktrade', 'cb_overview', 'warrant_premium', 'disposition'];
for (const f of PAID) {
    const re = new RegExp(`['"\`/]data/${f}\\.json`);
    ok(`① index ⛔ 不可再 fetch data/${f}.json`, !re.test(JS), (JS.match(new RegExp(`.{40}data/${f}\\.json.{20}`)) || [''])[0]);
    ok(`① pro ⛔ 不可再 fetch data/${f}.json`, !re.test(PJS), '');
}
// ② 券商頁 / 券商模式 / 分點子頁籤
for (const id of ['tabContentBroker', 'navBtnBroker', 'radarModeBroker', 'radarModeBrokerBtn', 'chipTabBtn-broker', 'chipPaneBroker',
    'chipScenarioSlot', 'premiumChipCards', 'brokerChipContent', 'chainRow', 'ovTomorrowPlaybook', 'toggleMainCost'])
    ok(`② ⛔ id="${id}" 不可復活`, !SRC.includes(`id="${id}"`), '');
for (const fn of ['_renderBrokerFenDian(', '_brokerLeagueHtml(', '_loadBrokerData(', '_chipScenarioCalc(', '_chipRunBuy(', '_tomorrowPlaybookHtml(',
    '_keyBrokers(', '_geoBrokers(', '_loadFmx(', '_fmx(', 'loadBrokerChips(', '_loadFenPeriodsDirect(', 'fetchChipCost(', '_chipConsensusLine('])
    ok(`② ⛔ ${fn} 不可復活`, !JS.includes(fn), '');
ok('② switchChipTab 只剩 flow / dist', /\['flow', 'dist'\]\.forEach/.test(JS) && !/broker: 'chipPaneBroker'/.test(JS), '');

// ⑤ 採礦 / workflow
const PY = noPyCmt(MINER);
for (const fn of ['def fetch_broker_chips', 'def build_broker_perf', 'def build_broker_radar', 'def build_broker_book', 'def detect_finmind_paid',
    'def fm_paid_get', 'def _fetch_twse_bsr', 'def fetch_govbank_buysell', 'def fetch_securities_lending', 'def fetch_daytrade_ratio',
    'def fetch_holder_distribution', 'def build_fmx_pack', 'def fetch_official_margin_maintenance', 'import ddddocr'])
    ok(`⑤ miner.py ⛔ ${fn} 不可復活`, !PY.includes(fn), '');
ok('⑤ miner.py 有 fetch_free_fundamentals 且接進主流程', /def fetch_free_fundamentals\(\)/.test(PY) && /_safe_step\("每檔基本面 fetch_free_fundamentals", fetch_free_fundamentals\)/.test(PY), '');
ok('⑤ radar_miner ⛔ 不可再讀 chips 的分點', !/get\('chips'\)|\.get\("chips"\)|\['buyers'\]|get\('buyers'\)/.test(noPyCmt(RADAR)), '');
ok('⑤ workflow ⛔ 不可再裝 ddddocr / 推 chips_deep', !/ddddocr/.test(WF) && !/push origin HEAD:chips_deep/.test(WF), '');
ok('⑤ workflow 部署前要清掉付費舊檔(⛔ 否則鋪底層會一直帶著 09/30 的)', /for f in govbank lending[\s\S]{0,400}rm -f "data\/\$f\.json"/.test(WF), '');
ok('⑤ chips_backfill / finmind_check 已刪', !fs.existsSync(path.join(ROOT, '.github/workflows/chips_backfill.yml'))
    && !fs.existsSync(path.join(ROOT, 'scripts/chips_backfill.py')) && !fs.existsSync(path.join(ROOT, 'finmind_check.py')), '');

// ③④ 實跑:籌碼頁沒刪過頭 + 報告頁基本面備援(決定性對照)
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--allow-file-access-from-files'] });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', e => { const t = String(e && e.message || e); if (!/echarts|vibrate|Failed to load|net::ERR_|CORS/i.test(t)) errs.push(t); });
await page.goto(pathToFileURL(process.env.NB_FILE || path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._loadChipFund, null, { timeout: 30000 });
const R = await page.evaluate(async () => {
    const out = {};
    out.chipFlow = !!document.getElementById('chipPaneFlow') && !document.getElementById('chipPaneFlow').classList.contains('hidden');
    out.inst = !!document.getElementById('chipInstVisualBars');
    out.margin = !!document.getElementById('chipMarginVisualBars');
    out.dist = !!document.getElementById('chipPaneDist');
    // 報告頁 PE 備援:官方 fundamentals_cache 沒這檔 → 讀 chips 檔的 fundamentals
    const A = app, sym = '9988';
    A._loadFundCache = async () => ({});
    A._loadFundYoyGm = async () => ({});
    const FUND = { pe: 12.34, eps: 5, yield_rate: 3.1 };
    let give = FUND;
    A._loadChipFund = async function (s) { s = String(s); if (!give) return false; this._fenSym = s; this._fenFund = give; this._fenDataDate = '2026-10-08'; return true; };
    const run = async () => {
        const rows = []; let px = 60;
        for (let i = 0; i < 300; i++) { px *= 1 + Math.sin(i / 7) * 0.01; const d = new Date(2025, 0, 1 + i); rows.push({ date: d.toISOString().slice(0, 10).replace(/-/g, '/'), open: px, high: px * 1.01, low: px * 0.99, close: px, volume: 5e6 }); }
        A.currentSymbolId = sym; A.rawDailyData = rows; A.activeData = rows;
        try { await A.renderReportTab(sym); } catch (e) { return 'ERR ' + e.message; }
        await new Promise(r => setTimeout(r, 300));
        const txt = (document.getElementById('subContentReport')?.innerText || '').replace(/\s+/g, ' ');
        const L = A._rpLast || {};
        return { txt, pe: L.pe ?? null, peSrc: L.peSrc || '' };
    };
    out.withFund = await run();
    give = null; A._fenSym = null; A._fenFund = null;
    out.noFund = await run();
    return out;
});
await browser.close();
ok('③ 籌碼頁「籌碼進出」是預設、三大法人與融資券長條還在', R.chipFlow && R.inst && R.margin, JSON.stringify(R));
ok('③ 籌碼分佈(集保)子頁籤還在', R.dist, '');
ok('④ 🚧 空過守門:報告頁真的渲染出東西', typeof R.withFund === 'object' && R.withFund.txt.length > 500, JSON.stringify(R.withFund).slice(0, 200));
ok('④ 有 chips fundamentals → 報告頁的本益比讀到 12.34(來源 = 採礦那份)', R.withFund.pe === 12.34 && /採礦/.test(R.withFund.peSrc), JSON.stringify({ pe: R.withFund.pe, src: R.withFund.peSrc }));
ok('④ ⭐ 決定性對照:拿掉 fundamentals → 本益比變成沒有(證明數字真的從那裡來)', R.noFund.pe == null, JSON.stringify({ pe: R.noFund.pe, src: R.noFund.peSrc }));
ok('⑥ 無 pageerror', errs.length === 0, errs.join(' | '));
console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ NOBROKER_PASS(全部通過)');
process.exit(fails ? 1 : 0);
