#!/usr/bin/env node
/**
 * 🏦⏳ V75.1.7 兩道「拿常數當訊號」的守門
 *
 * ① **外資台指期一律走 `app._fiFutState()`(相對水位)**
 *    CLAUDE.md V71.1.6 就寫著「⛔ 絕對口數門檻(−10,000 / −25,000 / −40,000)已刪除,
 *    不要再寫回來」,但實跑巡邏發現**還有 9 處**活著:
 *    `twiiState`+`emergencyMode` / 深度診斷 chip / 全球情報 fiLine / 順逆價差判讀 /
 *    小卡文字+圓點 / 當沖方向訊號 / `_dtMktGap` / AI prompt 的 fiLabel / 明日機率 `_pBear`。
 *    🚨 近 22 個交易日淨額全部 ≤ −75,000 → 那些判斷**每天都成立** = 常數:
 *    每天進緊急模式、每天顯「極空」、每天餵 AI「極空」、每天多加 15 分。
 *
 * ② **`daytrade_pack.json` 停產時不可繼續投票**
 *    實測那個檔停在 08/07(33 天),而它餵的兩條當沖方向訊號原本**無條件標「盤後」、
 *    無條件計分** → 拿一個月前的數字當今天的方向(陷阱 #16:快照檔不可當現值)。
 *    ⛔ 過期只做兩件事:不計分 + 把日期寫出來;⛔ 不藏數字。
 *    ⚠️ 吃這個檔的地方有**兩處**(畫面那條 + `_dtMktGap` 推估開盤情境)——
 *       只守一處會變成「畫面說不計分、推估卻照算」(兩份真相)。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 260)}`}`); if (!c) fails++; };

// ── ① 靜態:⛔ 不可再出現「拿 fi 跟絕對口數比」的寫法 ──
{
    // 只收「變數名含 fi 且跟 ±1萬以上的整數比大小」的樣式;⛔ 註解行不算(那是紀錄為什麼不能寫)
    const bad = [];
    SRC.split('\n').forEach((ln, i) => {
        const t = ln.trim();
        if (t.startsWith('//') || t.startsWith('*')) return;
        const m = ln.match(/\b(fi|fq|_fi|fiShortQty|fiNet)\b[^\n]{0,20}?[<>]=?\s*-?\s*(1[0-9]{4,}|[2-9][0-9]{4,})/);
        if (m) bad.push(`L${i + 1}: ${t.slice(0, 110)}`);
    });
    ok('① ⛔ 全 App 不可再用「外資台指期的絕對口數門檻」(一律 `_fiFutState()`)',
       bad.length === 0, bad.join('\n   '));
    ok('① 🚧 空過守門:`_fiFutState` 真的有被大量引用(⛔ 否則上面那條可能只是掃不到)',
       (SRC.match(/_fiFutState\??\.?\(\)/g) || []).length >= 10,
       `${(SRC.match(/_fiFutState\??\.?\(\)/g) || []).length} 處`);
}
// ── ② 靜態:新鮮度判斷只能有一份 ──
ok('② ⛔ `daytrade_pack` 的新鮮度判斷只能有一份(共用 `_dtPackFresh`)',
   (SRC.match(/_dtPackFresh\(d\) \{/g) || []).length === 1
   && (SRC.match(/this\._dtPackFresh\(/g) || []).length >= 3, '');

// ── 動態 ──
const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.addInitScript(() => {
    const inst = new Proxy({}, { get: (_t, k) => (k === 'getWidth' || k === 'getHeight') ? (() => 300) : (() => inst) });
    Object.defineProperty(window, 'echarts', {
        value: new Proxy({}, { get: (_t, k) => k === 'init' ? (() => inst) : (k === 'graphic' ? {} : () => inst) }),
        writable: true, configurable: true,
    });
});
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._fiFutState && !!app._dtPackFresh, null, { timeout: 25000 });

const R = await page.evaluate(() => {
    const o = {};
    const iso = n => { const d = new Date(Date.now() - n * 86400000);
        return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; };
    o.fresh1 = app._dtPackFresh(iso(1));
    o.fresh33 = app._dtPackFresh(iso(33));
    o.freshBad = app._dtPackFresh(null);
    o.freshDash = app._dtPackFresh(`${iso(1).slice(0, 4)}-${iso(1).slice(4, 6)}-${iso(1).slice(6, 8)}`);   // 兩種日期格式都要吃

    // 🏦 `_fiFutState`:同一個「很大的空單」在兩種歷史下要給出**不同**結論(⛔ 不是常數)
    const mk = arr => arr.map(v => ({ fi_futures_net: v }));
    app._futuresCache = { fi_net: -80000 };
    const flat = Array.from({ length: 22 }, () => -80000);
    app._riskHistCache = mk(flat);                                   // 一直都這麼空 → 不該喊緊急
    o.stateFlat = app._fiFutState();
    const surge = flat.slice(); for (let i = 17; i < 22; i++) surge[i] = -80000 - (i - 16) * 3000;
    app._riskHistCache = mk(surge);                                  // 5 日內急遽加空
    o.stateSurge = app._fiFutState();

    // ⏳ `_dtMktGap`:同一份 pack,只有日期不同 → 過期的那份⛔ 不可投票
    app.fiShortQty = null;                                           // 把台指期那票拿掉,只比 pack 的影響
    const pack = d => ({ pcRatio: { date: d, oiRatio: 140 }, largeTrader: { date: d, all: { top10Net: 9000 } } });
    app._daytradePack = pack(iso(1));  o.gapFresh = app._dtMktGap();
    app._daytradePack = pack(iso(33)); o.gapStale = app._dtMktGap();
    app._daytradePack = null;
    return o;
});
await browser.close();

ok('② 一天前的資料 = 新鮮,而且要標日期', R.fresh1.stale === false && /\d\d\/\d\d/.test(R.fresh1.txt), JSON.stringify(R.fresh1));
ok('② 33 天前 = 過期,而且要**寫出停在哪一天、幾天前、不計分**',
   R.fresh33.stale === true && /停在 \d\d\/\d\d/.test(R.fresh33.txt) && /33 天前/.test(R.fresh33.txt) && /不計分/.test(R.fresh33.txt),
   JSON.stringify(R.fresh33));
ok('② 日期拿不到 → 當成過期(⛔ 不可預設當新鮮)', R.freshBad.stale === true, JSON.stringify(R.freshBad));
ok('② 兩種日期格式(20260806 / 2026-08-06)都要吃', R.freshDash.stale === false, JSON.stringify(R.freshDash));
ok('① ⭐ 同一個 −80,000:一直都這麼空 → ⛔ 不可判「急遽加空」',
   R.stateFlat.level !== 'danger', JSON.stringify(R.stateFlat));
ok('① ⭐ 同一個量級但 5 日內急遽加空 → 才是 danger(證明它看的是「相對自己」)',
   R.stateSurge.level === 'danger', JSON.stringify(R.stateSurge));
ok('② ⭐ 新鮮的 pack 會影響推估開盤情境(🚧 空過守門)',
   R.gapFresh && R.gapFresh.key === 'up', JSON.stringify(R.gapFresh));
ok('② ⭐⛔ 過期的 pack 不可再投票(`_dtMktGap` 也要守,⛔ 不是只有畫面那條)',
   R.gapStale && R.gapStale.key !== 'up', JSON.stringify(R.gapStale));

console.log(fails ? `❌ ${fails} 條失敗` : '✅ FIFUT_GATE_PASS(全部通過)');
process.exit(fails ? 1 : 0);
