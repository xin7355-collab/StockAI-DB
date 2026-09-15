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
    const k = cv.width / (A._RP_STYLE.W || 1080);   // ⚠️ V76.3.9 畫布寬是常數 → ⛔ 不可寫死 1080,否則取樣座標整個偏掉
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
    // ── V76.3.8 ⓟ~ⓤ ──
    A._rpLast.pC = pC0; A._rpDrawOwn('2330');                       // 還原現價,重畫一張乾淨的
    const S = A._RP_STYLE, dbg = A._rpOwnDbg || { cards: [], bars: [] };
    const pr = A._reportChartPrompt('2330');
    // ⚠️ V76.4.1 起海報是**無框**的 → `S.card`(卡片底色)畫布上一次都沒用到,
    //    再要求它出現在提示詞裡等於逼提示詞去描述一個不存在的東西。改比「畫布真的會用到」的那幾個,
    //    並補上 `S.line`(分隔線 —— 無框版面就是靠它分段)。
    const promptHas = [S.bg, S.line, S.pos, S.amb, S.risk.mid, S.risk.lo].map(h => pr.includes(h));
    // 🚨 只比**規則那半**:提示詞尾巴接著 `_reportFacts`,那裡也有同一句白話 →
    //    整串比會被自己的資料段救活(注入「提示詞拿掉白話那條」照樣綠 —— 本 repo 第四次踩到)。
    const prRule = pr.split(/\n---\n【資料】\n/)[0];   // ⚠️ 「【資料】」在規則裡也出現過 → 一定要用**整行**的那個分隔,⛔ 不可只比四個字
    const promptGl = prRule.includes(A._RP_GLOSSARY['本益比']);
    const cardGap = dbg.cards.map(c => ({ t: c.title, gap: c.yFirst - c.yTitle }));
    const px = (x, y) => { const d = g.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data; return { r: d[0], gg: d[1], b: d[2] }; };
    // 🎨 V77.1.1 量條改成**同色系明暗漸變** → 取兩點:
    //   `p` 在 85%(亮端)驗色相、`pL` 在 8%(暗端)驗「右邊真的比左邊亮」。
    //   ⛔ 只取一點的話,「改回單色」那種注入叫不出來。
    const bars = dbg.bars.map(b => ({ ...b,
        p: px(b.x + Math.max(4, b.w * 0.85), b.y + b.h / 2),
        pL: px(b.x + Math.max(2, b.w * 0.08), b.y + b.h / 2) }));
    const valOk = !FT.val || !FT.val.length || (FT.val.every((x, i, a) => i === 0 || a[i - 1].v <= x.v) && FT.val.some(x => x.t === 'now'));
    const w1440 = await (async () => {
        const cvw = document.getElementById('rpOwnCv'); return cvw ? cvw.getBoundingClientRect().width : 0; })();
    // ── V76.3.9 ⓥ~ⓩ ──
    const lad = (dbg.lad || []).slice();
    const tips = Object.values(A._GAUGE_SPEC || {}).map(x => x.tip).filter(Boolean);
    const glN = Object.keys(A._RP_GLOSSARY || {}).length;
    const nWhite = ((facts || '').match(/白話:/g) || []).length;
    const tipInFacts = tips.some(t => (facts || '').includes(t));
    // 📏 手機(390px 視窗)上這張海報的顯示寬約 358px;沙箱沒有 Tailwind、祖先鏈會塌掉(陷阱 #40)
    //    → ⛔ 不量 live 寬度(那會量到假的),改用「設計契約」:字級 ÷ 畫布寬 × 358 = 螢幕上幾 px。
    const fsBody = (A._RP_STYLE.font || {}).body, Wc = A._RP_STYLE.W;
    const onScreen = fsBody * 358 / Wc;
    const ry = typeof A._revYoY === 'function'
        ? A._revYoY({ yoy: 7.6, mrh: [['2026-07', 1], ['2026-08', 2]] }, { rev_yoy: 27.7 }, null) : null;
    // ── V76.4.1 ⓐ2~ⓒ2 無框 ──
    //   ⓐ2 內容有多寬(佔畫布幾 %)・ⓒ2 每張卡的左界是不是同一條(⛔ 兩套邊界就是使用者看到的那個歪)
    const widths = dbg.cards.map(c => ({ t: c.title, x0: c.x0, x1: c.x1, pct: (c.x1 - c.x0) / S.W }));
    //   ⓖ2 段與段⛔ 不可重疊:每一段回報的高度必須真的蓋住它畫出去的東西
    //      (V76.4.1 實跑截圖抓到 ② 的最後三列壓在 ③ 上面 —— 舊的測試一條都沒抓到)
    const overlap = dbg.cards.slice(1).map((c, i) => ({ a: dbg.cards[i].title, b: c.title, gap: (c.yTitle - 26) - dbg.cards[i].yEnd }));
    const ladOut = (dbg.lad || []).map(x => { const c = dbg.cards.find(c => c.sec === x.sec);
        return c ? { n: x.name, t: c.title, out: Math.round(x.y - c.yEnd) } : null; }).filter(Boolean);
    //   ⓑ2 卡片左上角那一點:無框 → 一定是底色 S.bg。⛔ 取樣點要落在**卡片範圍內**而不是分隔線上
    //      (用第 2 張卡的 yTitle − 20,那是舊版外框會塗到、新版不會的位置)
    const c1 = dbg.cards[1] || dbg.cards[0];
    const corner = c1 ? px(c1.x0 + 2, c1.yTitle - 20) : null;
    const hexBg = (() => { const h = S.bg.replace('#', ''); return { r: parseInt(h.slice(0, 2), 16), gg: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }; })();
    const noFrameRule = /不要畫卡片外框/.test(prRule);
    return { ...base, ...chk, promptHas, cardGap, bars, valOk, w390: w1440, lad, glN, nWhite, tipInFacts, onScreen, ry, fsBody, Wc, promptGl, notes: dbg.notes, widths, corner, hexBg, noFrameRule, overlap, ladOut, PADx: dbg.pad, up, dn, same: a1 === a2, pxSame: s1 === s2, w: cv.width, h: cv.height,
             hasNow: (FT.lv || []).some(x => x.t === 'now'), nLv: (FT.lv || []).length,
             nEv: (FT.evs || []).length, nDim: (FT.dims || []).length };
});
// ── 📄 V76.4.1 報告頁(HTML 那半)也去框了 → 量「內容真的變寬了沒」+「三種 tone 有沒有對齊」──
//   ⚠️ 幾何一律先注入版面 shim(⛔ 沙箱沒有 Tailwind,不注入量到的全是假的 —— 陷阱 #40)。
//   ⚠️ 這一段**排在最後**:shim 會加一張 <style>,⛔ 不可影響上面那些量測。
const { rwdShim } = await import(path.join(ROOT, 'scripts/lib_rwdshim.mjs'));
const shimBad = await page.evaluate(rwdShim);
const rep = await page.evaluate(() => {
    const A = window.app || app;
    A.switchAppTab('diag'); A.switchSubTab('report');       // ⚠️ init 會在幾秒後把分頁切回庫存頁 → 再切一次
    const C = document.getElementById('subContentReport');
    if (!C || !C.clientWidth) return { no: 1 };
    C.querySelectorAll('details').forEach(d => { d.open = true; });   // 收起來的量不到寬度
    const pick = id => { const e = document.getElementById(id); if (!e) return null;
        const body = e.querySelector('details > div:not(summary)') || e.firstElementChild;
        return body ? Math.round(body.getBoundingClientRect().width) : null; };
    const pr = C.querySelector('[data-priceruler]');
    // 三種 tone(warn / ok / 中性)的標題文字左緣要**完全一樣**
    // ⚠️ 只取**最外層**的摺疊節(⛔ 巢狀在別的 details 裡面的本來就該縮排)
    //    ⚠️ 一個 details 只取**第一個**節標(summary 裡的 note 那行也有 span,不去重會把它算成第二節)
    const lefts = [...C.querySelectorAll('details')]
        .filter(d => !d.parentElement.closest('details'))
        .map(d => d.querySelector('summary > div > span'))
        .filter(Boolean).map(s => Math.round(s.getBoundingClientRect().left));
    // ⚠️ 琥珀色只能比 class:shim ⛔ 不補顏色(它只補會影響幾何的),computed 出來一律是預設色
    const warn = [...C.querySelectorAll('details')].filter(d => /border-l-amber/.test(d.className)).length;
    return { cw: C.clientWidth, walls: pick('rpWalls'), ruler: pr ? Math.round(pr.getBoundingClientRect().width) : null, lefts, warn };
});
{
    // 💾c 🚨 **行為**驗證:讓下載真的失敗 → toast ⛔ 不可說成功
    const t = await page.evaluate(async () => {
        const A = window.app || app;
        const said = [];
        const origToast = A.showToast, origCOU = URL.createObjectURL, origShare = navigator.share;
        A.showToast = (m) => { said.push(String(m)); };
        URL.createObjectURL = () => { throw new Error('boom'); };
        try { delete navigator.share; } catch (_) {}
        const cv = document.createElement('canvas'); cv.width = 10; cv.height = 10;
        // ⚠️ 先空跑一次 toBlob 暖機 —— 這一頁跑過完整 analyze,第一次 toBlob 會慢到超過斷言的等待時間
        //   (⛔ 這一筆**不可**進 said,否則它會自己把「有沒有跳 toast」那條斷言餵飽 = 假綠燈)
        try { await new Promise(res => { cv.toBlob(() => res()); setTimeout(res, 800); }); } catch (_) {}
        A._savePng(cv, 'x.png');
        await new Promise(r => setTimeout(r, 1200));
        A.showToast = origToast; URL.createObjectURL = origCOU; if (origShare) navigator.share = origShare;
        return said.join(' | ');
    });
    ck(t.length > 0, '💾c0 完全沒跳 toast → 這一條不算數(使用者會以為按鈕沒反應)');
    ck(!/已存成|已下載|✅/.test(t),
       `💾c 🚨 下載失敗時還跟使用者說成功了:「${t}」—— 這正是他回報「壞掉」的原因(toast 不可無條件跳)`);
    ck(/長按圖片|存不起來/.test(t), `💾c2 失敗時沒告訴使用者可以怎麼辦:「${t}」`);
}
await browser.close();

ck(shimBad.length === 0, `📄0 版面 shim 有規則沒生效(${shimBad.join('、')})→ ⛔ 底下的報告頁幾何全部不可信`);
if (!rep.no) {
    ck(rep.cw >= 350, `📄0b 🚧 空過守門:報告頁容器只有 ${rep.cw}px → 下面幾條沒有鑑別力`);
    const lim = (rep.cw - 16) * 0.94;   // 扣掉頁面對螢幕邊緣那道 px-2,再要求內容佔 94%(把 px-3 加回去 = 349px 就會紅)
    ck(rep.walls == null || rep.walls >= lim,
       `ⓓ2 §11 價格牆那一節的內容只有 ${rep.walls}px(容器 ${rep.cw})→ 卡片框又把寬度吃回去了(無框前只有 310px)`);
    ck(rep.ruler == null || rep.ruler >= lim,
       `ⓓ2b 價格位置圖只有 ${rep.ruler}px → 它外面那層框又回來了`);
    ck(rep.lefts.length >= 3, `ⓔ20 只量到 ${rep.lefts.length} 個摺疊節標 → 這一條不算數`);
    ck(new Set(rep.lefts).size <= 1,
       `ⓔ2 摺疊節的標題左緣不一致 ${JSON.stringify(rep.lefts)} → 只有「有事」那幾節縮排 = 看起來歪掉(透明左邊框就是為了這個)`);
    ck(rep.warn >= 1, 'ⓔ2b 找不到任何琥珀色左邊框 → ⚠️「這一節有事」的那條色邊不見了(⛔ 那個框在講事情,不可拿掉)');
} else {
    ck(false, '📄0c 切不到報告頁 → 上面幾條不算數');
}

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
    // ── V76.3.8 ──
    ck(r.promptHas.every(Boolean), `ⓟ 做圖提示詞沒把 _RP_STYLE 的每一個 hex 寫給 AI(${r.promptHas.map(Number).join('')})→ 兩張圖配色會各自一套`);
    ck(r.cardGap.length >= 6, `ⓤ0 只記到 ${r.cardGap.length} 張卡 → 這一條不算數`);
    for (const c of r.cardGap) ck(c.gap >= 30, `ⓤ 卡片「${c.t}」第一列跟標題基線只差 ${c.gap}px → 疊字(V76.3.8 第一版就這樣)`);
    ck(r.bars.length >= 3, `ⓢ0 五個面向只記到 ${r.bars.length} 條 → 這一條不算數`);
    for (const b of r.bars) {
        const p = b.p, isRed = p.r > 150 && p.r > p.gg + 40, isGreen = p.gg > 150 && p.gg > p.r + 40, isSky = p.b > 150 && p.b > p.r + 40, isAmber = p.r > 180 && p.gg > 100 && p.b < p.gg - 50;   // amber-200/400/600 三階都要收,紅(#f87171)不可誤收
        if (b.kind === 'dir') ck((b.score >= 58 && isRed) || (b.score <= 42 && isGreen) || (b.score > 42 && b.score < 58), `ⓢ 方向類「${b.name}」${b.score} 分的量條不是紅/綠(${JSON.stringify(p)})`);
        else if (b.kind === 'risk') ck(isAmber, `ⓢ 風險類「${b.name}」的量條不是琥珀(${JSON.stringify(p)})→ 燈號鐵則:安全/危險⛔ 不用紅綠`);
        else ck(isSky, `ⓢ 位置類「${b.name}」的量條不是天藍(${JSON.stringify(p)})`);
        // 🎨 V77.1.1 同色系漸變 = **左深右亮**(⛔ 不是綠→黃→紅跨色 —— 燈號鐵則也管刻度尺)。
        //   ⚠️ 量條太短(w < 24px)時兩個取樣點會撞在一起 → 那一列不算(空過守門)。
        if (b.w >= 24) {
            const L = b.pL.r + b.pL.gg + b.pL.b, R = p.r + p.gg + p.b;
            ck(R > L + 30, `ⓢb 「${b.name}」的量條不是同色系明暗漸變(左 ${L} / 右 ${R})→ 改回單色了?`);
        }
    }
    ck(r.valOk, 'ⓣ 估值對照價位沒有由小到大、或沒把現價插進去');
    // ── ⓥ 直式價格軸:價格越高畫得越上面,而且⛔ 不可疊字 ──
    ck(r.lad.length >= 3, `ⓥ0 直式價格軸只記到 ${r.lad.length} 個刻度 → 這一條不算數(空過守門)`);
    // ⚠️ lad 裡有**兩座**軸(② 關鍵價位 / ④ 對照價位)→ 一定要分組比,
    //    跨組比的話「下一組從頭開始」會被誤判,而且注入「拿掉排序」時會溜過去(第一版就是這樣)。
    const grp = {}; for (const x of r.lad) (grp[x.g] = grp[x.g] || []).push(x);
    ck(Object.keys(grp).length >= 2, `ⓥ0b 只畫到 ${Object.keys(grp).length} 座價格軸 → ② 或 ④ 沒走直式軸`);
    let ladderedAny = 0;
    for (const gk of Object.keys(grp)) {
        const G = grp[gk];
        for (let i = 1; i < G.length; i++) {
            ck(G[i].v <= G[i - 1].v,
               `ⓥ 第 ${gk} 座軸沒照價格高低排:「${G[i - 1].name} ${G[i - 1].v}」畫在「${G[i].name} ${G[i].v}」上面`);
            ck(G[i].y - G[i - 1].y >= 30,
               `ⓥ2 「${G[i - 1].name}」跟「${G[i].name}」只差 ${Math.round(G[i].y - G[i - 1].y)}px → 兩列疊在一起`);
            if (Math.abs(G[i].y - G[i - 1].y - 46) > 1) ladderedAny += 1;
        }
    }
    ck(ladderedAny > 0, 'ⓥ3 每一列間距都剛好等於固定列高 → 那是等距清單不是價格軸(看不出誰離現價近)');
    // ── V76.4.1 ⓐ2/ⓑ2/ⓒ2 無框:框拿掉之後,寬度要**真的**還給內容 ──
    //   ⛔ 一律釘「量得到的結果」(內容佔畫布幾 % / 那一點是什麼顏色),⛔ 不釘 class 或常數等於多少
    ck(r.widths.length >= 6, `ⓐ20 只記到 ${r.widths.length} 張卡的寬度 → 這一條不算數(空過守門)`);
    for (const w of r.widths) ck(w.pct >= 0.9,
        `ⓐ2 「${w.t}」的內容只有畫布的 ${(w.pct * 100).toFixed(1)}%(${w.x0}→${w.x1})→ 框又把寬度吃回去了(無框前是 86.2%)`);
    ck(r.PADx != null && r.widths.every(w => w.x0 === r.PADx),
       `ⓒ2 有卡片的左界不等於頁首那條邊(PAD=${r.PADx}):${JSON.stringify(r.widths.map(w => w.x0))} → 標題會比內文寬一截(使用者截圖上看得出來)`);
    ck(r.widths.every(w => Math.abs((w.x1 - w.x0) - (r.Wc - 2 * r.PADx)) < 0.5),
       'ⓒ2b 左右邊界不對稱 → 內容沒有置中在畫布上');
    ck(!!r.corner, 'ⓑ20 取樣不到卡片左上角 → 這一條不算數');
    if (r.corner) ck(r.corner.r === r.hexBg.r && r.corner.gg === r.hexBg.gg && r.corner.b === r.hexBg.b,
       `ⓑ2 卡片左上角那一點是 rgb(${r.corner.r},${r.corner.gg},${r.corner.b}),不是底色 ${JSON.stringify(r.hexBg)} → 卡片外框/底色被加回來了(使用者要的是無框)`);
    ck(r.noFrameRule, 'ⓕ2 做圖提示詞沒寫「⛔ 不要畫卡片外框」→ 外部 AI 那張又會長回有框的樣子(兩張圖對不起來)');
    // ── ⓖ2 段與段⛔ 不可重疊(沒有框之後,重疊就是「兩段的字黏在一起」,比有框時更難看出來)──
    ck(r.overlap.length >= 5, `ⓖ20 只比得到 ${r.overlap.length} 對相鄰段 → 這一條不算數`);
    for (const o of r.overlap) ck(o.gap >= 0,
        `ⓖ2 「${o.b}」的標題壓進「${o.a}」裡面 ${-o.gap}px → 兩段的字疊在一起`);
    for (const x of r.ladOut) ck(x.out <= 0,
        `ⓖ3 「${x.t}」的價格軸把「${x.n}」畫到自己這一段外面 ${x.out}px → 會壓到下一段(V76.4.1 實跑截圖抓到的)`);
    // ── ⓦ 字級:⛔ 釘「螢幕上實際幾 px」,不是釘畫布寬等於多少 ──
    ck(r.onScreen >= 11, `ⓦ 手機上內文只有 ${r.onScreen.toFixed(1)}px(內文 ${r.fsBody}px ÷ 畫布 ${r.Wc}px × 358)→ 太小看不清楚`);
    // ── ⓧ 每個數字都要有一句白話(使用者:「產出來的資料還要敘述那是什麼意思」)──
    ck(r.glN >= 15, `ⓧ0 _RP_GLOSSARY 只有 ${r.glN} 條 → 這一條不算數`);
    ck(r.notes >= 10, `ⓧ3 圖上只畫了 ${r.notes} 行白話 → 格子沒有在說明那個數字是什麼意思`);
    ck(r.promptGl, 'ⓧ4 做圖提示詞沒把白話**逐字**寫給 AI → 它會自己編一句解釋');
    ck(r.nWhite >= 5, `ⓧ 餵給外部 AI 的資料裡只有 ${r.nWhite} 處「白話:」→ 它會自己編一句(或整段不寫)`);
    // ── ⓨ 五個面向的白話走現成的 _GAUGE_SPEC.tip,⛔ 不另寫一份 ──
    ck(r.tipInFacts, 'ⓨ _reportFacts 沒把 _GAUGE_SPEC 的 tip 餵出去 → 外部 AI 只拿到「技術 62」這種光禿禿的數字');
    // ── ⓩ 營收年增只有一個聲音 ──
    ck(r.ry && r.ry.v === 7.6 && r.ry.month === '2026-08',
       `ⓩ0 _revYoY 沒有回「哪一個月」或優先序不對:${JSON.stringify(r.ry)}`);
}
// ── ⓠ 顏色一律走 _RP_STYLE(⛔ 畫圖程式裡不可寫死 hex);ⓣ2 產業四格只有一份 ──
ck(!/'#[0-9a-fA-F]{3,6}'/.test(fn), 'ⓠ _rpDrawOwn 裡寫死了 hex 顏色 → 跟提示詞那份會分歧,一律讀 _RP_STYLE');
// ── ⓧ2 每一個格子的標題都要查得到白話(⛔ 不可有一格沒解釋)──
{
    const gl = code.slice(code.indexOf('_RP_GLOSSARY: {'), code.indexOf('_rpIndustryFacts(sym) {'));
    const keys = new Set([...gl.matchAll(/'([^']+)':\s*'/g)].map(m => m[1]));
    const labs = [...fn.matchAll(/cells\(\[([\s\S]*?)\], yy/g)]
        .flatMap(m => [...m[1].matchAll(/\['([^']+)'/g)].map(x => x[1]));
    ck(labs.length >= 8, `ⓧ2-0 只掃到 ${labs.length} 個格子標題 → 這一條不算數(切片或正則過時)`);
    const miss = [...new Set(labs)].filter(l => !keys.has(l));
    ck(miss.length === 0, `ⓧ2 這幾格沒有白話說明:${miss.join(' / ')} → 補進 _RP_GLOSSARY(或用第三個參數指定鍵)`);
}
// ── ⓩ 營收年增:兩個呼叫端都要走同一支(⛔ 以前報告頁跟 X 光機的優先序是相反的)──
ck((code.match(/_revYoY\(/g) || []).length >= 3, 'ⓩ _revYoY 沒有被兩個呼叫端用到 → 年增又會有兩個數字');
ck(!/Number\.isFinite\(\+fy\?\.yoy\)\s*\?\s*\+fy\.yoy/.test(code) && !/num\(f\.rev_yoy\)\s*!=\s*null\s*\?\s*num\(f\.rev_yoy\)/.test(code),
   'ⓩ2 舊的「自己排優先序」寫法還在 → 報告頁與 X 光機會各顯示一個年增');
{
    const fa = code.slice(code.indexOf('_reportFacts(sym) {'), code.indexOf('_reportPrompt(sym) {'));
    const fo = code.slice(code.indexOf('_rpOwnFacts(sym) {'), code.indexOf('_rpDrawOwn(sym) {'));
    ck(/_rpIndustryFacts\(/.test(fa) && /_rpIndustryFacts\(/.test(fo), 'ⓣ2 產業四格(產業別/題材/名次/AI 鏈)沒有走同一份 _rpIndustryFacts → 兩張圖會各講各的');
}
// ── ⓡ 桌機海報限寬(畫布字級不吃 App 字級設定;使用者:「筆電的字體太大」) ──
{
    const i0 = SRC.indexOf('@media (min-width: 1024px)');
    const blk = SRC.slice(i0, SRC.indexOf('@media', i0 + 10));
    ck(i0 > 0 && /\.rp-poster\s*\{[^}]*max-width:\s*6\d\dpx/.test(blk), 'ⓡ 桌機那個 @media 區塊裡沒有 .rp-poster 限寬 → 筆電上整張圖放大兩倍');
    ck(/id="rpOwnCv" class="rp-poster"/.test(SRC) && /alt="短評報告" class="rp-poster"/.test(SRC), 'ⓡ2 兩張海報(canvas / 外部 AI 圖)沒有都掛 rp-poster → 一張限寬一張沒有,兩張又對不起來');
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
    // V76.3.8 起關鍵價位每一列由 rowLv 畫(定義在 run() 之前)→ 切片從 rowLv 開始到五個面向為止
    const seg = fn.slice(fn.indexOf('const rowLv'), fn.indexOf('五個面向'));
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

// ── 🧭 V77.0.2 「五個面向」標題不可寫死(使用者:「不是說有5個面向,為何只有4個」)──
{
    const dw = code.slice(code.indexOf('_rpDrawOwn(sym) {'), code.indexOf('_rpOwnSave(sym) {'));
    ck(dw.length > 1000, '🧭a0 切不到 _rpDrawOwn → 這幾條不算數');
    ck(!/card\('五個面向|card\("五個面向|card\(`五個面向/.test(dw),
       '🧭a 海報的面向標題又被寫死成「五個面向」了 —— ⛔ 要跟著 dims.length 走(V76.0.8 已經為同一句抱怨修過 HTML 版)');
    ck(/\$\{dims\.length\}\s*個面向/.test(dw), '🧭a2 標題沒有用 ${dims.length} 帶入實際列數');
    ck(/_gaugeMiss\(/.test(dw),
       '🧭b 海報沒有畫出「缺哪一格 + 為什麼」—— 少一格卻不說原因,使用者只會以為壞掉');
    // ⛔ 不可自己再寫一份判斷(不產生第二份真相)
    ck(!/技術['"]\s*,\s*['"]大盤/.test(dw), '🧭b2 海報自己抄了一份面向清單 → ⛔ 一律轉述 _gaugeMiss');
    // ⚠️ 終點要**從起點之後**找 —— `_regaugeStrip(` 在檔案更前面就出現過(22862),直接 indexOf 會切出空字串
    const _gi = code.indexOf('_gaugeStripHtml(sym) {');
    const gs = code.slice(_gi, code.indexOf('_regaugeStrip(', _gi));
    ck(gs.length > 200 && /_gaugeMiss\(/.test(gs), '🧭b3 儀表列沒有走同一支 _gaugeMiss → 兩邊會各講一套');
}

// ── 💾 V77.0.2 存成圖片(使用者回報「壞掉,沒有作用」)──────────────
//   🚨 舊寫法用 `<a download>` + **data: URL**(iOS Safari/PWA 基本不支援),而且
//      toast 是**無條件**跳的 → 檔案沒落地卻跟使用者說「已存成圖片」。
//   ⭐ 釘的是用意:① 不可再自己寫一份下載 ② 三條路徑都在 ③ **失敗時不可說成功**
{
    const sv = code.slice(code.indexOf('_rpOwnSave(sym) {'), code.indexOf('async _saveBlob(blob, fileName, opts = {}) {'));
    ck(sv.length > 50 && sv.length < 900, '💾a0 切不到 _rpOwnSave → 這幾條不算數(空過守門)');
    ck(!/toDataURL|a\.click\(/.test(sv),
       '💾a _rpOwnSave 又自己寫 toDataURL / a.click() 了 —— ⛔ 一律轉呼叫 _savePng(全 App 只有一份)');
    ck(/_savePng\(/.test(sv), '💾a2 _rpOwnSave 沒有轉呼叫 _savePng');

    const sb = code.slice(code.indexOf('async _saveBlob(blob, fileName, opts = {}) {'), code.indexOf('_savePng(cv, fileName) {'));
    ck(sb.length > 400, '💾b0 切不到 _saveBlob → 這幾條不算數');
    ck(/navigator\.canShare/.test(sb) && /navigator\.share/.test(sb),
       '💾b _saveBlob 沒有「先試原生分享」那一層 —— iOS 存圖的正解就是它');
    ck(/AbortError/.test(sb), '💾b2 使用者自己取消分享被當成失敗了(⛔ 那不是錯誤)');
    ck(/Line\\\/|FBAV|FB_IAB|Instagram|MicroMessenger/.test(sb),
       '💾b3 _saveBlob 少了 LINE/FB/IG 內建瀏覽器特判 —— 那些瀏覽器會擋下載,⛔ 不可硬試');
    ck(/setTimeout\(/.test(sb), '💾b4 清理 <a> 沒有延遲 —— 同步 remove 在 Safari 會讓下載中斷');
    // ⛔ 全 App 不可再有第 2、3 份下載寫法
    const others = (code.match(/URL\.createObjectURL/g) || []).length;
    ck(others <= 2, `💾b5 全檔還有 ${others} 處 URL.createObjectURL —— 下載寫法應該只剩 _saveBlob 一份(Worker 那處不算)`);
}

if (fail.length) { console.log('❌ RPOWN_FAIL'); fail.forEach(f => console.log('   ・' + f)); process.exit(1); }
console.log('✅ RPOWN_PASS(全部通過)');
