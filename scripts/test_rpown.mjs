#!/usr/bin/env node
/**
 * 🖼️ 本站自己畫的一頁圖(#rpOwn,V76.3.4)
 *
 * 使用者:「AI 做圖…沒有產出,直接是一鍵可以複製版本,請修正」「⛔ 不要把原本的刪除,直接新增一張卡片」。
 * ⭐ 釘的是**用意**:
 *   ⓐ 真的有畫出東西(⛔ 不是空白 canvas —— 那跟「沒有產出」是同一件事)
 *   ⓑ 數字**來自本站算好的**,⛔ 不是寫死在畫圖程式裡(改來源 → 畫面要跟著變)
 *   ⓒ 台股**紅漲綠跌**(外部 AI 那張圖就是在這裡自打嘴巴的)
 *   ⓓ ⛔ 不顯融合總分(陷阱 #38:憑空權重的分數不可當結論)
 *   ⓔ ⛔ 原本那張「外部 AI 圖」還在(使用者明示不要刪)
 *   ⓕ 免責不可省
 */
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf-8');
const fail = [];
const ck = (ok, m) => { if (!ok) fail.push(m); };

// ── ⓔ 原本那張外部 AI 圖不可被刪掉 ──────────────────────────────
ck(/id="rpImg"/.test(SRC) && /_rpImgHtml\(/.test(SRC), 'ⓔ 原本那張外部 AI 圖(#rpImg)不見了 —— 使用者明示⛔ 不要刪除,只能新增');
ck(SRC.indexOf('id="rpOwn"') < SRC.indexOf('id="rpImg"'),
   'ⓔ2 本站自己畫的那張要排在外部 AI 圖**之前**(主結論最大,⛔ 外部 AI 的東西不可壓在本站結論上面)');
// ⚠️ 原始碼斷言先剝 `//` 註解(本 repo 被自己的註解救活斷言已經三次)
const code = SRC.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
const fn = code.slice(code.indexOf('_rpDrawOwn(sym) {'), code.indexOf('_rpOwnSave(sym) {'));
ck(fn.length > 1000, 'ⓓ0 切不到 _rpDrawOwn → 這一輪不算數(空過守門)');
ck(!/_lastGauge\s*\.\s*total|G\.total|\btotal\b/.test(fn),
   'ⓓ 圖上出現了「融合總分」—— ⛔ 那是憑空權重的分數(陷阱 #38),只准畫各面向分數');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('pageerror', () => {});
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._rpDrawOwn === 'function', null, { timeout: 25000 });

const r = await page.evaluate(async () => {
    const A = window.app || app;
    A.switchAppTab('diag'); await A.analyze('2330');
    await new Promise(r => setTimeout(r, 4000));
    A.switchSubTab('report');
    for (let i = 0; i < 16; i++) { await new Promise(r => setTimeout(r, 600)); if (document.getElementById('rpOwnCv')) break; }
    const cv = document.getElementById('rpOwnCv');
    if (!cv) return { no: 'canvas' };
    const g = cv.getContext('2d');
    // 「畫了東西沒有」= 非背景色的像素數
    const ink = () => { const d = g.getImageData(0, 0, cv.width, Math.min(cv.height, 500)).data; let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 40 || d[i + 1] > 40 || d[i + 2] > 40) n++; return n; };
    // 🎨 現價那一列的顏色(紅漲綠跌)—— 取「現價大字」那一帶
    // ⚠️ 取樣範圍要**只框住現價那幾個字** —— 框太大會把「近 20 日」那行(顏色是另一個方向)
    //   跟價格位置尺的琥珀色一起算進來,兩邊就分不出來了(第一版就是這樣假失敗的)。
    //   canvas 是照 devicePixelRatio 放大的 → 座標要乘上 k。
    const k = cv.width / 1080;
    const hue = () => { const d = g.getImageData(0, Math.round(96 * k), Math.round(cv.width * 0.42), Math.round(60 * k)).data; let R = 0, G2 = 0;
        for (let i = 0; i < d.length; i += 4) { if (d[i] > 120 && d[i] > d[i + 1] + 40) R++; if (d[i + 1] > 120 && d[i + 1] > d[i] + 40) G2++; }
        return { R, G: G2 }; };
    const base = { ink: ink(), png: cv.toDataURL('image/png').length };
    // ── V76.3.7 ⓚ~ⓝ(⚠️ 排在下面那些「改 pC / chg」的注入**之前**,量的才是真實狀態)──
    const pC0 = +A._rpLast.pC;
    // ⚠️ 2330 常在高檔、上方沒有套牢區 → 用**合成的**一道(形狀照 _upsideRoom 的 list:{lo,hi,sup}),量完還原
    const U0 = A._upsideStash;
    A._upsideStash = { pC: pC0, list: [{ lo: pC0 * 1.05, hi: pC0 * 1.15, sup: 20 }] };
    const F0 = A._rpOwnFacts('2330') || {};
    // ⓚ 套牢區那一列:印的數字跟「距現價 %」必須是同一個點(上一版印中點卻標下緣的 %)
    const zones = (F0.lv || []).filter(x => x.t === 'zone');
    const zoneOk = zones.every(x => Math.abs(x.r - ((x.v / pC0 - 1) * 100)) < 0.05 && String(x.n).includes(`${Math.round(x.v)}~`));
    // ⓛ 接下來怎麼看:出場線在現價**上面**(已跌破)時,第一行要說「已在…之下」,⛔ 不可拿融資追繳線去填「跌破 ___」
    const K0 = A._keyLevels; const kbase = Object.assign({}, K0 || {}, { sym: '2330' });
    const cl = (A._rpLast.mcs && Number.isFinite(+A._rpLast.mcs.callLine)) ? +A._rpLast.mcs.callLine : null;
    A._keyLevels = Object.assign({}, kbase, { slPx: pC0 * 1.2 });
    const nAbove = A._rpNextLines('2330');
    A._keyLevels = Object.assign({}, kbase, { slPx: pC0 * 0.9 });
    const nBelow = A._rpNextLines('2330');
    const facts = A._reportFacts('2330');
    A._keyLevels = K0; A._upsideStash = U0;
    const chk = { zoneN: zones.length, zoneOk,
        aboveTxt: nAbove[0] || '', belowTxt: nBelow[0] || '', cl,
        factsNext: facts.includes('接下來怎麼看') && (nBelow[0] ? facts.includes(nBelow[0]) : true),
        factsTheme: facts.includes('題材標籤'),
        evRev: (F0.evs || []).some(e => /月營收/.test(e.t)),
        hasCall: nBelow.some(t => /融資追繳壓力區/.test(t)) };
    A._rpLast.chg = 5.5; A._rpDrawOwn('2330'); const up = hue();
    A._rpLast.chg = -5.5; A._rpDrawOwn('2330'); const dn = hue();
    // ⓑ 數字不是寫死的:改本站算好的那個值 → 圖要變
    // ⚠️ 整張圖的指紋不夠 —— 只要有一格還在讀真資料,整張就會變,**現價那幾個字寫死照樣過**
    //   (第一版的注入②「把現價寫死」就這樣溜過去了)。⭐ 要再單獨比**現價那一塊**。
    const sig = () => { const d = g.getImageData(0, Math.round(96 * k), Math.round(cv.width * 0.42), Math.round(60 * k)).data;
        let h = 0; for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) % 2147483647; return h; };
    A._rpLast.chg = 0; A._rpDrawOwn('2330'); const a1 = cv.toDataURL('image/png'), s1 = sig();
    A._rpLast.pC = (+A._rpLast.pC || 100) * 2 + 7; A._rpDrawOwn('2330'); const a2 = cv.toDataURL('image/png'), s2 = sig();
    const FT = A._rpOwnFacts('2330') || {};
    return { ...base, ...chk, up, dn, same: a1 === a2, pxSame: s1 === s2, w: cv.width, h: cv.height,
             hasNow: (FT.lv || []).some(x => x.t === 'now'), nLv: (FT.lv || []).length,
             nEv: (FT.evs || []).length, nDim: (FT.dims || []).length };
});
await browser.close();

ck(!r.no, 'ⓐ0 報告頁上找不到那張 canvas → 這一輪不算數');
if (!r.no) {
    ck(r.ink > 5000, `ⓐ 畫出來幾乎是空白的(只有 ${r.ink} 個非背景像素)→ 跟「沒有產出」是同一件事`);
    ck(r.png > 20000, `ⓐ2 存出來的 PNG 只有 ${r.png} 位元組,太小 → 圖是空的`);
    ck(r.w >= 900, `ⓐ3 圖只有 ${r.w}px 寬 → 存下來看不清楚`);
    ck(r.up.R > r.up.G * 2, `ⓒ 上漲時現價不是紅的(紅 ${r.up.R} / 綠 ${r.up.G})→ ⛔ 違反台股紅漲綠跌`);
    ck(r.dn.G > r.dn.R * 2, `ⓒ2 下跌時現價不是綠的(紅 ${r.dn.R} / 綠 ${r.dn.G})→ ⛔ 違反台股紅漲綠跌`);
    ck(!r.same, 'ⓑ 改掉本站算好的收盤價之後圖完全沒變 → 數字是寫死在畫圖程式裡的(⛔ 那就會騙人)');
    ck(!r.pxSame, 'ⓑ2 改掉收盤價之後**現價那幾個字**沒變 → 它是寫死的(⛔ 圖上印一個跟本站不一樣的價格最會害人)');
    // ⚠️ ⛔ 不可只用原始碼斷言 —— 第一版釘 `/'now'/.test(fn)`,而那個字串在畫圖那半也有,
    //   把 `_rpOwnFacts` 裡真正 push 那一行刪掉照樣綠(注入⑦ 溜過去)。⭐ 改成**行為**斷言。
    ck(r.hasNow, 'ⓖ3 關鍵價位裡沒有「現在的價」那一列 → 看不出哪些在上面、哪些在下面');
    ck(r.nLv >= 3, `ⓖ4 關鍵價位只有 ${r.nLv} 列 → 太少,圖沒有骨架`);
    // ── V76.3.7 ⓚ~ⓝ ──
    ck(r.zoneN > 0, 'ⓚ0 2330 沒有任何套牢區列 → ⓚ 這一條不算數(換一檔有上方套牢區的測資)');
    ck(r.zoneOk, 'ⓚ 套牢區那一列「印的價位」跟「距現價 %」不是同一個點(上一版印中點 193.19 卻標下緣的 +1.5%)');
    ck(/已在你的出場線/.test(r.aboveTxt) && /之下/.test(r.aboveTxt), `ⓛ 出場線在現價上面(已跌破)時第一行沒說「已在你的出場線…之下」:${r.aboveTxt}`);
    ck(!(r.cl != null && r.aboveTxt.includes((+r.cl).toFixed(1))), `ⓛ2 已跌破出場線時,第一行把融資追繳線 ${r.cl} 填進去了 → 跟使用者那張 AI 圖同一個錯`);
    ck(/跌破你的出場線/.test(r.belowTxt), `ⓛ3 出場線在現價下面時第一行沒寫「跌破你的出場線」:${r.belowTxt}`);
    ck(r.hasCall, 'ⓛ4 三行裡沒有那句「融資追繳壓力區…⛔ 不是任何人的紀律線」→ AI 又會拿它當出場線');
    ck(r.factsNext, 'ⓛ5 _reportFacts 沒把「接下來怎麼看」那三行**逐字**餵給 AI → 留空位它就會自己填');
    ck(r.factsTheme, 'ⓝ _reportFacts 沒有「題材標籤」那一格 → 上櫃股會一直印「未分類」');
    ck(r.evRev, 'ⓜ 本站自己畫的圖事件段少了「月營收」(提示詞那邊有,兩張圖對不起來)');
}
// ── ⓞ 畫圖那一段要有 ⑧ 接下來怎麼看;提示詞補的三條 ──
ck(/接下來怎麼看/.test(fn), 'ⓞ 本站自己畫的圖沒有「接下來怎麼看」那一段(骨架跟提示詞對不起來)');
{
    const pr = SRC.slice(SRC.indexOf('_reportChartPrompt(sym) {'), SRC.indexOf('_reportCopyChart(sym) {'));
    ck(/PE 0\.0x/.test(pr), 'ⓞ2 提示詞沒禁止 AI 把沒資料的同業中位畫成「PE 0.0x」');
    ck(/不可自己多加一道/.test(pr), 'ⓞ3 提示詞沒禁止 AI 自己多加一道套牢區');
    ck(/逐字照抄【資料】最後那三行|逐字照抄/.test(pr) && /出場線\*\*可能在現價上面/.test(pr), 'ⓞ4 提示詞沒講「出場線可能在現價上面 → 不可拿追繳線填跌破」+「三行逐字照抄」');
}

// ── ⓕ 免責 ─────────────────────────────────────────────────
ck(/不是買賣建議/.test(fn), 'ⓕ 圖上沒寫「⛔ 不是買賣建議」');
ck(/沒有經過 AI|不是 AI 畫的/.test(fn + SRC), 'ⓕ2 沒有講清楚「這張圖不是 AI 畫的」(那正是它跟上面那張的差別)');


// ── ⓖ 🚨「距現價 %」⛔ 不可用紅綠(它講的是位置不是漲跌)──────────────
//   V76.3.4 第一版就是這樣錯的:季線 +28.2% 塗紅、年線 −23.5% 塗綠 → 讀起來像「季線漲了 28%」。
//   ⭐ 燈號鐵則:紅綠只准表示漲跌方向。位置一律灰 + ▲/▼。
{
    const seg = fn.slice(fn.indexOf('關鍵價位'), fn.indexOf('五個面向'));
    ck(seg.length > 200, 'ⓖ0 切不到關鍵價位那一段 → 這一條不算數');
    ck(/▲|▼/.test(seg), 'ⓖ 關鍵價位沒有用 ▲/▼ 表示在現價上面還是下面');
    ck(!/\bUP\b|\bDN\b/.test(seg), 'ⓖ2 關鍵價位那一段用到了紅(UP)/綠(DN)—— ⛔ 那是漲跌的顏色,距現價 % 是位置(燈號鐵則)');

}

// ── ⓗ 📅 事件段:只講波動,⛔ 不講方向 ─────────────────────────────
{
    const seg = fn.slice(fn.indexOf('未來會震到你的事'));
    ck(seg.length > 100, 'ⓗ0 切不到事件那一段 → 這一條不算數');
    ck(/只講波動|不講漲跌/.test(seg), 'ⓗ 事件段沒寫「只講波動、⛔ 不講漲跌」');
    ck(/方向一個都不成立|方向 0 個/.test(seg), 'ⓗ2 事件段沒把實測結論寫上去(37 種行事曆日 → 方向 0 個成立)');
}

// ── ⓘ 🎨 做圖提示詞要跟本站自己畫的**同一個骨架**(使用者:「兩邊調成一樣」)──
{
    const pr = SRC.slice(SRC.indexOf('_reportChartPrompt(sym) {'), SRC.indexOf('_reportCopyChart(sym) {'));
    ck(pr.length > 2000, 'ⓘ0 切不到做圖提示詞 → 這一條不算數');
    for (const k of ['價格位置', '關鍵價位', '五個面向', '未來會震到你的事'])
        ck(pr.includes(k), `ⓘ 做圖提示詞少了「${k}」這一段 → 兩張圖對不起來`);
    ck(/3c\./.test(pr) && /距現價/.test(pr), 'ⓘ2 做圖提示詞沒把「距現價 % ⛔ 不可用紅綠」那條寫給 AI(本站自己犯過的錯要一起教它)');
    ck(/不可以加總成一個總分|不要自己加總/.test(pr), 'ⓘ3 做圖提示詞沒禁止 AI 把五個面向加總成總分(陷阱 #38)');
    // 提示詞吃的料也要有(⛔ 沒給料,AI 就會自己編)
    const fa = SRC.slice(SRC.indexOf('_reportFacts(sym) {'), SRC.indexOf('_reportPrompt(sym) {'));
    ck(/五個面向/.test(fa), 'ⓘ4 _reportFacts 沒給「五個面向」→ 提示詞叫 AI 畫它卻沒給數字(印「—」它就會自己編)');
    ck(/未來的大盤事件/.test(fa), 'ⓘ5 _reportFacts 沒給大盤行事曆 → 同上');
}

// ── ⓙ 📅 財經行事曆的 AI「怎麼做」必須標明沒有實測背書 ─────────────
{
    ck(/AI 建議\(⛔ 沒有實測背書\)/.test(SRC), 'ⓙ 行事曆那段 AI 的「👉 怎麼做」沒有標明⛔ 沒有實測背書');
    ck(/37 種財經行事曆日/.test(SRC), 'ⓙ2 行事曆區塊沒把實測結論寫上去(方向 0 個成立,只有波動是真的)');
}

if (fail.length) { console.log('❌ RPOWN_FAIL'); fail.forEach(f => console.log('   ・' + f)); process.exit(1); }
console.log('✅ RPOWN_PASS(全部通過)');
