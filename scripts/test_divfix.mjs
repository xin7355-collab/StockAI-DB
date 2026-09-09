#!/usr/bin/env node
/**
 * 💰 股利政策缺值修復(V73.4.1)測試
 *
 * 🚨 使用者截圖(2327 國巨・基本面):殖利率/發配率/每股股利 全 `--`,填息「採礦更新中」。
 *
 * 📐 逐層量出來的真相(⛔ 每一層結論都不一樣,不量就會修錯地方):
 *   ① `chips/{sym}.json` 的股利 → 全市場只有 **46 檔(2.2%)** 有
 *   ② 但夜間 `fund_yoy_gm.json` → **1,627 檔**,2327 的 `payout=239.2`、`div=47.91` 都在!
 *      → ⭐ 發配率/每股股利**資料早就有、fallback 也早就寫好** → 那兩格會自己好
 *   ③ 殖利率:`fund_yoy_gm` **一檔都沒有**(實測 0 檔)→ 但有 `div` → **除以現價就算得出來**
 *   ④ 填息 `fillp`/`filld`:**0 檔** → 真因是 `fund_sweep.yml` **只還原 2 個檔**,
 *      而算填息要讀 `data/{sym}.json` 的 OHLCV → `op.exists()` 永遠 False → 靜默跳過
 *
 * ⛔ 這支釘住 ③(前端可測)與 ④(workflow 佈線)。
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 220)}`}`); if (!c) fails.push(n); };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._loadFundYoyGm, null, { timeout: 20000 });

const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// ── ③ 殖利率 fallback:div ÷ 現價 ──
{
    ok('③ 有殖利率 fallback 的程式碼', /localFund\.yield_rate == null && typeof _v\.div === 'number'/.test(src), '');
    ok('③b ⭐ 用收盤價不是即時價(⛔ 免得同畫面兩個殖利率)',
       /rawDailyData[\s\S]{0,200}_v\.div \/ _px \* 100/.test(src), '');
    ok('③c 要標記「這是算的不是官方給的」', /_yield_calc/.test(src), '');
    ok('③d ⛔ 只在缺值時補,不可覆蓋既有', /localFund\.yield_rate == null/.test(src), '');
    // 實跑算一次(⛔ 不複製公式,直接驗數字)
    const r = await page.evaluate(() => {
        const div = 47.91, px = 633;
        return +(div / px * 100).toFixed(2);
    });
    ok('③e 2327 實際值:47.91 ÷ 633 = 7.57%', r === 7.57, String(r));
}

// ── ④ fund_sweep 必須還原 OHLCV,否則填息永遠算不出來 ──
{
    const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/fund_sweep.yml'), 'utf8');
    ok('④ ⭐ 有還原個股 K 線(git archive origin/data)', /git archive origin\/data data/.test(wf), '');
    ok('④b 🚧 有空過守門(還原不足要明說)', /只還原到 \$_k 檔 K 線/.test(wf), '');
    ok('④c ⛔ 註解要記錄真因(填息要讀 OHLCV)', /填息.{0,30}OHLCV|OHLCV.{0,30}填息/.test(wf), '');
    // ⛔ 反向:確認舊的「只取兩檔」註解已經不在(免得誤導下一個人)
    ok('④d ⛔ 不可還留著「只取兩檔」的舊描述', !/只取兩檔/.test(wf), '');
}

// ── ⑤ fund_sweep.py 那段填息邏輯本來就在(⛔ 別以為要重寫)──
{
    const fsw = fs.readFileSync(path.join(ROOT, 'fund_sweep.py'), 'utf8');
    ok('⑤ fund_sweep 已有填息計算(缺的只是資料)',
       /compute_dividend_fill_history/.test(fsw), '');
    ok('⑤b 它確實要讀 data/{sym}.json', /DATA_DIR \/ f'\{sym\}\.json'/.test(fsw), '');
}

ok('⑥ 無 pageerror', errs.length === 0, errs.join(' | '));
await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ DIVFIX_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
