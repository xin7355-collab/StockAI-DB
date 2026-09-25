#!/usr/bin/env node
/**
 * 📦 V77.4.3 決策台選項「只挑營收年增加速的」—— ⛔ 六條不可改掉的設計
 *
 * ① **預設關**(取捨型:賺更少、回撤更小 → V75.0.9 第 5 條「判準 = 總獲利最大」⛔ 不換預設)
 * ② **決定性對照**:關掉時名單要跟沒有這個功能之前**一模一樣**,而且⛔ 連一次 `data/fin` 都不可以去抓
 * ③ ⛔ **不可靜默過濾**(V74.8.8):擋掉誰、各自的年增/加速幾 pp,一律寫在畫面上
 * ④ 🚨 **可用日守門**:只認 `pub <= 今天`(法定截止日)—— ⛔ 拿季別當可用日就是前視
 * ⑤ ⭐⭐ **`null` 是「不知道」⛔ 不是「沒過」**:沒有財報切片的那一列**照留**,但要掛 🏷️ 標記。
 *    ⚠️ 這跟回測端 `portfolio_backtest.finOk` 對 `null` 回 `false`(剔除)**刻意相反** ——
 *    回測要乾淨的統計母體,畫面是給人看的名單,默默少一檔才是更大的錯。
 * ⑥ **五件事一件都不可少**:亮燈率 / 三組對照 / 「少賺」/「回撤變小有一大半只是少挑一點」/「一季才換一次」
 *
 * ⚠️ `data/fin/*.json` 與 `playbook_edge.json` 在 file:// 下都抓不到 → 一律**注入**,
 *    ⛔ 不可靠真檔(那會變成「今天剛好有沒有」決定測試綠不綠)。
 * 注入驗證:拿掉 pub 守門 / 把被擋清單改成靜默 / `null` 改成當作沒過而擋掉 /
 *          亮燈率寫死字面值 / 拿掉「少賺」那句 / 開關關時照樣去抓 fin —— 六種都要叫得出來。
 */
import fs from 'fs';
import path from 'path';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let fails = 0;
const ok = (n, c, e = '') => { if (c) console.log(`✅ ${n}`); else { fails++; console.log(`❌ ${n}${e ? '  ' + String(e).slice(0, 220) : ''}`); } };

// ═══ 靜態 ═══
ok('① 預設關(settings 的預設值)', /deckFinAccel: false/.test(SRC), '');
ok('①b 開關改完要重畫決策台(⭐ 全 App 目前只有這一處設定會 renderDeck)',
   /toggleDeckFinAccel\(checked\) \{[\s\S]{0,400}?renderDeck/.test(SRC), '');
ok('⑥0 畫面數字一律從 `_DECK_FIN` 帶(⛔ `_deckFinNoteHtml` 裡不可出現寫死的萬元/回撤字面值)',
   /_deckFinNoteHtml\(st\) \{[\s\S]*?\n    \},/.test(SRC) &&
   !/(519|473|538|25\.8|11\.5|16\.6|50\.6)/.test(SRC.slice(SRC.indexOf('_deckFinNoteHtml(st) {'), SRC.indexOf('_deckFinNoteHtml(st) {') + 3000)), '');

// ⚠️ 切片必須跟真實 `data/fin/{sym}.json` 同形狀(陷阱 #40)—— 12 季、每季 {p, pub, rev}
const PUBOF = p => { const [y, md] = [p.slice(0, 4), p.slice(5)];
    return md === '03-31' ? `${y}-05-15` : md === '06-30' ? `${y}-08-14` : md === '09-30' ? `${y}-11-14` : `${+y + 1}-03-31`; };
const QS = []; for (let y = 2023; y <= 2025; y++) for (const m of ['03-31', '06-30', '09-30', '12-31']) QS.push(`${y}-${m}`);
/** last = 最後一季的額外倍率(>1 → 年增比上一季高 = 亮;<1 → 沒亮);extra = 再接一季「還沒公布」的 */
const mkSlice = (sym, last, extra) => {
    const q = QS.map((p, k) => ({ p, pub: PUBOF(p), rev: Math.round(1000 * Math.pow(1.05, k) * (k === QS.length - 1 ? last : 1)), cogs: 600, eps: 1 }));
    if (extra) q.push({ p: '2026-09-30', pub: PUBOF('2026-09-30'), rev: Math.round(1000 * Math.pow(1.05, 12) * extra), cogs: 600, eps: 1 });
    return { sym, nq: q.length, q };
};
const FIN = { '1000': mkSlice('1000', 0.7), '1001': mkSlice('1001', 1.4), '1002': mkSlice('1002', 1.4),
              // ④ 最新**已公布**那一季沒加速,但「還沒公布」的那一季暴衝 → ⛔ 不可因此亮
              '1003': mkSlice('1003', 0.7, 5.0) };
const BASE = { s: '0000', c: 100, v: 3000, d: '2026-09-07', k: '💪 發動棒破昨高', w: 61.1, po: 4.8,
               exp: 11.5, lb: 5.4, n: 18, trig: 105, loose: 0, rank: 92, vol: 103, hq: 1, bear: 0, up: 3.1, stop: 95 };

// ═══ 實跑 ═══
const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
await page.goto('file://' + path.join(ROOT, 'index.html'));
await page.waitForFunction(() => typeof app !== 'undefined' && app.renderDeck, null, { timeout: 30000 });

const R = await page.evaluate(async ({ mk, FIN }) => {
    const A = window.app || app;
    const P = (s, o) => Object.assign({ ...mk }, { s }, o || {});
    A.inventory = []; A.favGroups = {};
    A._invExitAt = Date.now(); A._invExitFlags = []; A._invExitSkip = []; A._invExitN = 0;
    // 🧪 注入財報切片(file:// 抓不到真檔)+ 計數「有沒有真的去抓」
    let hits = 0;
    A._loadFinSlim = async sym => { hits++; return FIN[String(sym)] || null; };
    const out = { finOn: {} };
    const buyEl = () => document.getElementById('deckBuy');
    const run = async (on, picks) => {
        A.settings.deckFinAccel = on; A._pbEdge = { data_date: '2026-09-07', picks };
        A._finSlimCache = {}; A._finAccelWhy = {}; hits = 0;
        await A.renderDeck();
        const el = buyEl();
        return { n: el.querySelectorAll('[onclick*="app.analyze"]').length,
                 html: el.innerHTML, txt: el.innerText.replace(/\s+/g, ' '),
                 idle: (document.getElementById('deckIdle').innerText || '').replace(/\s+/g, ' '), hits };
    };
    // 🧪 空過守門:注入的切片真的算得出 true/false(⛔ 全 null 的話下面每一條都沒有鑑別力)
    for (const s of ['1000', '1001', '1002', '1003']) { A._finSlimCache = {}; out.finOn[s] = await A._finAccelOn(s); }
    A._finSlimCache = {};

    // #1 沒加速 / #2#3 有加速 / #4 沒有切片
    const L = [P('1000', { lb: 9.0 }), P('1001', { lb: 8.0 }), P('1002', { lb: 7.0 }), P('4000', { lb: 6.0 })];
    out.off = await run(false, L);
    out.on = await run(true, L);
    // ② 全部都沒加速 → 一檔都不剩
    out.allBlocked = await run(true, [P('1000', { lb: 9 }), P('1003', { lb: 8 })]);
    // ⑤ 全部都沒有切片 → 都留著 + 掛 🏷️ 標記
    out.unknown = await run(true, [P('4000', { lb: 9 }), P('4001', { lb: 8 })]);
    return out;
}, { mk: BASE, FIN });

ok('⓪ 空過守門:注入的切片真的分得出亮/沒亮(⛔ 全 null 的話下面全部沒有鑑別力)',
   R.finOn['1000'] === false && R.finOn['1001'] === true && R.finOn['1002'] === true, JSON.stringify(R.finOn));
ok('④ 🚨 可用日:「還沒公布」的那一季暴衝⛔ 不可讓它亮(1003 最新已公布那季沒加速 → false)',
   R.finOn['1003'] === false, String(R.finOn['1003']));

ok('② 決定性對照:關掉 → 前 2 名是 1000、1001(跟沒有這個功能時一樣)',
   R.off.n === 2 && /1000/.test(R.off.html) && /1001/.test(R.off.html), `n=${R.off.n}`);
ok('②b 關掉時⛔ 連一次 `data/fin` 都不可以去抓(省流量;開著才抓)',
   R.off.hits === 0 && R.on.hits > 0, `off=${R.off.hits} / on=${R.on.hits}`);
ok('②c 打開 → 1000 被擋掉,遞補 1001、1002(⛔ 不是只剩 1 檔)',
   R.on.n === 2 && !/>1000</.test(R.on.html) && /1001/.test(R.on.html) && /1002/.test(R.on.html), `n=${R.on.n}`);

ok('③ ⛔ 不可靜默:被擋掉的代號要寫出來', /1000/.test(R.on.txt) && /已擋掉/.test(R.on.txt), R.on.txt.slice(0, 200));
ok('③b 被擋掉的**理由(年增 / 比上一季幾 pp)**也要寫出來',
   /年增/.test(R.on.txt) && /比上一季/.test(R.on.txt) && /pp/.test(R.on.txt), '');

for (const [k, re] of [['亮燈率(⛔ 它是篩子不是警示)', /全市場有\s*50\.6%\s*會亮/],
                       ['三組對照含**同通過率隨機抽**', /同通過率隨機抽/],
                       ['粗體寫出誠實結論(V77.6.0 起依數字:「打開會少賺」或「功勞不是營收加速」)', /打開會少賺|功勞不是營收加速/],
                       ['回撤變小有一大半只是「少挑一點」', /少挑一點/],
                       ['季報資料一季才換一次', /一季才換一次/]])
    ok(`⑥ 五件事:${k}`, re.test(R.on.txt), R.on.txt.slice(0, 260));

ok('⑦ 全部被擋 → ⛔ 不可說成「今天沒有可以買的」,要說是**你開的濾網**擋的 + 給關掉的路',
   R.allBlocked.n === 0 && /都被你開的濾網擋掉/.test(R.allBlocked.txt) && /設定/.test(R.allBlocked.txt), R.allBlocked.txt.slice(0, 200));
ok('⑦b 全部被擋時⛔ 不可同時出現「✅ 今天不用做」(同一頁不可一邊說有一邊說沒有)',
   !/今天不用做/.test(R.allBlocked.idle), R.allBlocked.idle.slice(0, 120));
ok('⑦c 全部被擋那一格也要附上同一份誠實揭露', /打開會少賺|功勞不是營收加速/.test(R.allBlocked.txt), '');

ok('⑤ ⭐ 沒有財報切片 = 「不知道」⛔ 不是「沒過」→ 那兩列**照留**',
   R.unknown.n === 2 && /4000/.test(R.unknown.html) && /4001/.test(R.unknown.html), `n=${R.unknown.n}`);
ok('⑤b 而且每一列要掛 🏷️ 標記 + 卡底說明「沒被這道濾網驗過」',
   (R.unknown.html.match(/🏷️沒財報/g) || []).length === 2 && /沒被這道濾網驗過/.test(R.unknown.txt), R.unknown.txt.slice(0, 200));

ok('⑧ 無 pageerror', errs.length === 0, errs.join(' | '));
await browser.close();
console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ DECKFIN_PASS');
process.exit(fails ? 1 : 0);
