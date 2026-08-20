#!/usr/bin/env node
/**
 * 🌅 盤前台指期領先條(V73.7.6)測試
 *
 * 使用者:「新增期貨,因為期貨比現股早開盤,我覺得可以用來比對,給我建議或者有沒有說錯」
 *
 * ⛔ 這支要釘死的六件事:
 *   ① **時間窗**:只在台北 08:30~09:20 的**平日**顯示;其餘時間 ⛔ 整條不顯示(大盤頁已有,不重複佔版面)。
 *   ② **資料優先序**:採礦端即時快照 → Yahoo 電子盤;兩層都沒有 → ⛔ 整條不顯示(不留空殼)。
 *   ③ **拿不到可信基準時不給方向**(V72.0.5 教訓):只顯價位 + 「方向待確認」,⛔ 不硬算漲跌%。
 *   ④ ⛔ **不下操作指令** —— 而且必須寫出本站實測(隔天開盤買少賺 54 萬 / 跳空不追倒賠),
 *      否則使用者會拿期貨方向去決定要不要追。
 *   ⑤ ⛔ **不顯示「期貨 − 現貨」價差點數** —— 基差常態幾百到上千點,而順逆價差歷史只有 18 筆,
 *      沒有「平常是多少」的基準 → 顯示它只會被誤讀成「大漲」。
 *   ⑥ 紅綠只用在**漲跌方向**(台股色),符合燈號鐵則。
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 260)}`}`); if (!c) fails.push(n); };

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined|Tailwind/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._renderPreOpenFut, null, { timeout: 25000 });

const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// ⚠️ 時間窗要能**在任何時刻跑測試**都驗得到 → stub 掉 `_preOpenFutWindow`,
//    ⛔ 不可等「剛好 08:45 才驗得到」(那種測試等於沒有)。
const R = await page.evaluate(async () => {
    const out = {};
    const el = () => document.getElementById('preOpenFutBar');
    const realWin = app._preOpenFutWindow;
    // 真實時間窗函式:直接驗它對各種時刻的判斷(⛔ 不改系統時間)
    out.winFnSrc = String(realWin);

    // ── 情境 A:不在時間窗 → 整條不顯示 ──
    app._preOpenFutWindow = () => ({ on: false });
    app._liveIdx = { txf: { p: 46033, c: 0.18 } };
    await app._renderPreOpenFut();
    out.offHidden = el().classList.contains('hidden') && el().innerHTML === '';

    // ── 情境 B:盤前 + 有採礦快照(有漲跌%)──
    app._preOpenFutWindow = () => ({ on: true, pre: true, hhmm: '08:47' });
    app._liveIdx = { txf: { p: 46033, c: 0.18 } };
    await app._renderPreOpenFut();
    out.preHtml = el().innerHTML;
    out.preShown = !el().classList.contains('hidden');

    // ── 情境 C:盤前 + 只有價沒有漲跌%(拿不到可信基準)──
    app._liveIdx = { txf: { p: 46033, c: null } };
    await app._renderPreOpenFut();
    out.noDirHtml = el().innerHTML;

    // ── 情境 D:負的漲跌(驗台股色:綠 = 跌)──
    app._liveIdx = { txf: { p: 45500, c: -1.23 } };
    await app._renderPreOpenFut();
    out.downHtml = el().innerHTML;

    // ── 情境 E:兩層資料都沒有 → 整條不顯示(Yahoo 在沙箱一定失敗)──
    app._liveIdx = null;
    app._fetchLiveIndexYahoo = async () => null;
    await app._renderPreOpenFut();
    out.noDataHidden = el().classList.contains('hidden') && el().innerHTML === '';

    // ── 情境 F:採礦快照壞值(0 / 非數字)→ 要退到 Yahoo,Yahoo 也沒有 → 不顯示 ──
    app._liveIdx = { txf: { p: 0, c: 5 } };
    await app._renderPreOpenFut();
    out.badPxHidden = el().classList.contains('hidden');
    app._liveIdx = { txf: { p: 'abc' } };
    await app._renderPreOpenFut();
    out.nanPxHidden = el().classList.contains('hidden');

    // ── 情境 G0:🚨 盤前快照的**新鮮度守門** ──
    //   `live_index.json` 會一直留在伺服器上 → 08:35 開 App(當天第一輪 08:45 還沒跑)
    //   會讀到**昨天**的期貨價。⛔ 必須擋掉(同陷阱 #34「守門擋掉了、舊值卻被沿用」)。
    const mkIdx = (iso) => ({ updated: iso, ts: '08:47', premarket: true, idx: { txf: { p: 46500, c: 0.5 } } });
    const realFetch = window.fetch;
    const stubJson = (obj) => { window.fetch = async () => ({ ok: true, json: async () => obj }); };
    const nowIso = new Date().toISOString();
    const yesterdayIso = new Date(Date.now() - 26 * 3600e3).toISOString();
    const oldIso = new Date(Date.now() - 90 * 60e3).toISOString();
    stubJson(mkIdx(nowIso));      out.preFresh = await app._loadPreOpenIdx();
    stubJson(mkIdx(yesterdayIso)); out.preYesterday = await app._loadPreOpenIdx();
    stubJson(mkIdx(oldIso));      out.preStale = await app._loadPreOpenIdx();
    stubJson({ idx: { txf: { p: 46500 } } });   // 沒有 updated 欄
    out.preNoTs = await app._loadPreOpenIdx();
    // 新鮮的盤前快照要真的被用到(優先於 Yahoo)
    stubJson(mkIdx(nowIso));
    app._liveIdx = null;
    app._fetchLiveIndexYahoo = async () => ({ price: 99999, prev: 99000, chgPct: 1.0 });
    await app._renderPreOpenFut();
    out.preUsedHtml = el().innerHTML;
    window.fetch = realFetch;

    // ── 情境 G:Yahoo 兜底(採礦快照沒有,但電子盤有)──
    app._liveIdx = null;
    app._fetchLiveIndexYahoo = async (s) => (s === '^TXF=F' ? { price: 46100, prev: 46000, chgPct: 0.2174 } : null);
    await app._renderPreOpenFut();
    out.yahooHtml = el().innerHTML;

    // ── 情境 H:開盤後(pre:false)文案要換 ──
    app._preOpenFutWindow = () => ({ on: true, pre: false, hhmm: '09:12' });
    await app._renderPreOpenFut();
    out.openHtml = el().innerHTML;

    app._preOpenFutWindow = realWin;
    return out;
});

const strip = h => String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

// ── ① 時間窗 ───────────────────────────────────────────────────────
ok('① 不在時間窗 → ⛔ 整條不顯示', R.offHidden, '');
{
    // ⭐ 直接驗真函式的邊界(⛔ 不靠「剛好現在是幾點」)
    const f = R.winFnSrc;
    ok('①b 時間窗要用台北時間(⛔ 不可用瀏覽器本地時區)', /Asia\/Taipei/.test(f), '');
    ok('①c 要擋週末', /Sat/.test(f) && /Sun/.test(f), '');
    ok('①d 窗口是 08:30~09:20', /8 \* 60 \+ 30/.test(f) && /9 \* 60 \+ 20/.test(f), '');
}

// ── ② 資料優先序 / 空過守門 ────────────────────────────────────────
ok('② 有採礦即時快照 → 顯示', R.preShown && /46,033/.test(strip(R.preHtml)), strip(R.preHtml).slice(0, 120));
ok('②b 兩層資料都沒有 → ⛔ 整條不顯示(不留空殼)', R.noDataHidden, '');
ok('②c 快照價是 0 / 非數字 → ⛔ 不可顯示垃圾', R.badPxHidden && R.nanPxHidden, JSON.stringify([R.badPxHidden, R.nanPxHidden]));
ok('②d 採礦快照沒有時,退到 Yahoo 電子盤(盤前也有)', /46,100/.test(strip(R.yahooHtml)) && /電子盤/.test(strip(R.yahooHtml)), strip(R.yahooHtml).slice(0, 120));

// ── ③ 沒有可信基準就不給方向 ───────────────────────────────────────
{
    const t = strip(R.noDirHtml);
    ok('③ 只有價、沒有漲跌基準 → 標「方向待確認」', /方向待確認/.test(t), t.slice(0, 140));
    ok('③b ⛔ 這種情況不可硬掰出一個 %', !/[+-]\d+\.\d+%/.test(t), t.slice(0, 160));
}

// ── ⑥ 燈號:紅綠只用在漲跌方向 ─────────────────────────────────────
ok('⑥ 上漲用紅(台股色)', /text-red-300/.test(R.preHtml), '');
ok('⑥b 下跌用綠(台股色)', /text-green-300/.test(R.downHtml) && /🔻/.test(R.downHtml), '');

// ── ④⑤ 文案 ───────────────────────────────────────────────────────
{
    const t = strip(R.preHtml);
    ok('④ 要說明期貨早開盤(08:45)+ 夜盤時段', /08:45/.test(t) && /15:00/.test(t), t.slice(0, 220));
    ok('④b 🚨 必須寫本站實測:隔天開盤買少賺 54 萬 + 跳空不追倒賠',
       /54 萬/.test(t) && /倒賠/.test(t), t.slice(-260));
    ok('④c ⭐ 要明說「這是期貨自己的漲跌,不是現貨開盤預測」',
       /期貨自己的漲跌/.test(t) && /不是現貨開盤預測/.test(t), '');
    // ⛔ 不可下操作指令 —— 先 strip 掉否定句(本專案踩過 6 次)
    const stripped = t.replace(/別拿期貨方向決定要不要追/g, '').replace(/就不追/g, '').replace(/不是現貨開盤預測/g, '');
    ok('④d ⛔ 不可下操作指令', !/(可以買|可以進場|建議買進|可加碼|做多|放空|停損設|掛單)/.test(stripped), stripped.slice(0, 200));
    ok('⑤ ⛔ 不可顯示「期貨 − 現貨」的價差點數', !/價差|基差|逆價差|正價差/.test(t), t.slice(0, 200));
    ok('⑤b 開盤後文案要換掉「現貨還沒開盤」', !/現貨還沒開盤/.test(strip(R.openHtml)) && /現貨已開盤/.test(strip(R.openHtml)), strip(R.openHtml).slice(0, 140));
}

// ── 🚨 盤前快照新鮮度守門 ──────────────────────────────────────────
ok('⑨ 今天剛產出的盤前快照 → 採用', !!R.preFresh && R.preFresh.p === 46500, JSON.stringify(R.preFresh));
ok('⑨b 🚨 **昨天**的檔 → ⛔ 一律不用(不然 08:35 開 App 會看到昨天的期貨價)', R.preYesterday === null, JSON.stringify(R.preYesterday));
ok('⑨c 🚨 超過 30 分鐘 → ⛔ 不用', R.preStale === null, JSON.stringify(R.preStale));
ok('⑨d 沒有 updated 欄 → ⛔ 不用(⛔ 不可當作「應該是新的」)', R.preNoTs === null, JSON.stringify(R.preNoTs));
ok('⑨e 新鮮的盤前快照要**優先於** Yahoo 被用到',
   /46,500/.test(R.preUsedHtml.replace(/<[^>]+>/g, ' ')) && /盤前/.test(R.preUsedHtml), R.preUsedHtml.replace(/<[^>]+>/g, ' ').slice(0, 140));

// ── 接線 ───────────────────────────────────────────────────────────
ok('⑦ 容器在自選頁「多頭待發射」之上',
   /id="preOpenFutBar"[\s\S]{0,200}多頭待發射/.test(src), '');
ok('⑦b 已接進 30 秒更新迴圈', /setInterval\(\(\) => \{ try \{ this\._renderPreOpenFut\(\); \} catch\(_\) \{\} \}, 30_000\);/.test(src), '');
ok('⑦c ⛔ 沒有新增卡片(只有一個容器 div)', (src.match(/id="preOpenFutBar"/g) || []).length === 1, '');
ok('⑧ 無 pageerror', errs.length === 0, errs.join(' | '));

await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ PREOPENFUT_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
