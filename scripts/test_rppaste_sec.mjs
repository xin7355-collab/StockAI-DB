#!/usr/bin/env node
/**
 * 📄 貼上報告:第一眼要留哪幾節 + 引註噪音 + 代號對不對(V77.0.8)
 *
 * 使用者(2026-09-15 截圖,富喬 1815 的報告頁):
 *   「完整報告裡面摘錄 §21 來源表我覺得沒有用,應該是 §19 未來 30~90 天觀察清單
 *     及 §20 最後 200 字投資筆記,另外 §19 及 §20 裡面文字很多沒有用」
 *
 * 三件事:
 *  ① 舊版第一眼抓「§1 + **最後一節**」→ 他那份 21 節的最後一節正好是**來源表**(整節只有網址)
 *     → 第一眼被連結佔滿,真正有用的兩節反而被收起來。
 *     ⭐ 改成「排除純來源節之後的**最後兩節**」;⛔ 仍然不寫死編號(21 節 / 20 節都要對)。
 *  ② 每一句後面都掛「(2026-09-15,來源: https://…)」,一節重複 6 次以上 → 剝掉。
 *     ⛔ 只剝**整段結尾**那種括號,⛔ 不動內文的括號與數字。
 *  ③ 🚨 而剝的時候發現:那些網址寫的是 **stock/3441**,但那是**富喬 1815** 的報告頁 ——
 *     3441 是別檔(聯一光電,而且正好是他決策台買單裡的 #1)。
 *     ⛔ 不可以默默剝掉就算了 → 一定要大聲講,否則「拿別檔的報告當這檔讀」會變成隱形的。
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 200)}`}`); if (!c) fails.push(n); };

// ⭐ 測資是使用者那份報告的**真實形狀**(21 節・每行掛引註・代號 3441)——
//    ⛔ 不可憑印象編(陷阱 #40:測資跟程式一起錯,兩邊「對得上」)
const U = 'https://financial-data-platform.internal/stock/3441';
const TXT = `§1 結論:短線籌碼行情
無合理買進理由。(2026-09-15,來源: ${U})
§19 未來 30~90 天觀察清單
2026-10-09 前公布之 9 月營收年增率是否低於 2026-08 的 0.9%。(2026-09-15,來源: ${U})
2026-11-14 前公布之 Q3 財報毛利率是否守住 37.8% 及 131 天存貨天數變化。(2026-09-15,來源: ${U})
每週集保散戶(43.4%)與千張大戶(14.5%)的籌碼消長。(2026-09-15,來源: ${U})
§20 最後 200 字投資筆記
買進理由:無合理買進理由,現階段純屬短線籌碼極致拉抬行情。(2026-09-15,來源: ${U})
主要風險:66.0x PE 與 83% 估值位階極為昂貴。(2026-09-15,來源: ${U})
§21 來源表
${U}
${U}/fin
${U}/chip
${U}/news`;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--allow-file-access-from-files'] });
const page = await browser.newPage();
page.on('pageerror', () => {});
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._rpPasteParse && !!app._rpStripCite, null, { timeout: 25000 });

const r = await page.evaluate((t) => {
    const A = window.app || app;
    const P = A._rpPasteParse(t);
    // ⚠️ 這裡刻意**照抄 _rpPasteHtml 的判準**是不行的(那會變成第二份真相)→
    //    改成走真正的顯示層:把報告存進去、叫它畫出來、再看 DOM。
    A._rpNoteSaveRaw ? A._rpNoteSaveRaw('1815', t) : null;
    return { secs: P.secs.map(x => x.n), n: P.secs.length,
             strip19: A._rpStripCite((P.secs.find(x => x.n === 19) || {}).body || ''),
             warnOther: A._rpCiteWarn('1815', t), warnSame: A._rpCiteWarn('3441', t) };
}, TXT);

ok('⓪ 測資切得出 4 節(§1/§19/§20/§21)', r.n === 4 && r.secs.join() === '1,19,20,21', r.secs.join());

// ── ① 第一眼保留哪幾節:走**真的**顯示層(⛔ 不在測試裡複製一份判準)
const dom = await page.evaluate((t) => {
    const A = window.app || app;
    // ⚠️ V76.2.7 起報告存在 **IndexedDB**,`_rpNote()` 只讀同步的 `_rpNoteCache`
    //    → ⛔ 灌 localStorage 沒用(我第一版就是這樣拿到空 DOM 的)。直接種那個 cache。
    A._rpNoteCache = A._rpNoteCache || {};
    A._rpNoteCache['1815'] = { t, ts: Date.now(), v: 2 };
    const html = A._rpPasteHtml({ sym: '1815', pC: 116, kDate: '2026-09-15' });
    const d = document.createElement('div'); d.innerHTML = html;
    return {
        first: [...d.querySelectorAll('[data-rpsec-first]')].map(e => e.getAttribute('data-rpsec-first')),
        folded: [...d.querySelectorAll('[data-rpsec]')].map(e => e.getAttribute('data-rpsec')),
        cite: (d.querySelector('[data-rpcite]') || {}).getAttribute ? d.querySelector('[data-rpcite]').getAttribute('data-rpcite') : '',
        first1Text: [...d.querySelectorAll('[data-rpsec-first]')].map(e => e.textContent).join(' ').replace(/\s+/g, ' '),
        text: d.textContent.replace(/\s+/g, ' '),
    };
}, TXT);

ok('① 第一眼保留 §1 + §19 + §20(⛔ 不是最後一節 §21)',
   dom.first.includes('1') && dom.first.includes('19') && dom.first.includes('20') && !dom.first.includes('21'),
   '第一眼=' + dom.first.join(','));
ok('①b §21 來源表被收進摺疊(⛔ 不是刪掉 —— 只是不佔第一眼)',
   dom.folded.includes('21'), '摺疊=' + dom.folded.join(','));

// ── ② 引註噪音剝掉,但**數字一個都不能少**
// 🚨 ② 一定要驗**渲染後的畫面**,⛔ 不可只呼叫 _rpStripCite ——
//    我第一版就是直接測那支函式,結果「把顯示層那一行的呼叫拿掉」的注入**照樣全綠**
//    (函式還在、只是沒人用)。⭐ 同一條教訓:斷言要走真正的那條路。
ok('② 畫面上每行結尾的「(日期,來源: 網址)」剝掉了',
   !/來源:\s*https?:/.test(dom.first1Text), dom.first1Text.slice(0, 160));
ok('②a 而且 _rpStripCite 自己也對', !/來源:\s*https?:/.test(r.strip19), r.strip19.slice(0, 120));
for (const v of ['0.9%', '37.8%', '131 天', '43.4%', '14.5%'])
    ok(`②b 內文數字「${v}」⛔ 不可被剝掉`, r.strip19.includes(v), r.strip19.slice(0, 160));
ok('②c 內文的括號⛔ 不可被剝掉', /\(43\.4%\)/.test(r.strip19) || /（43\.4%）/.test(r.strip19), r.strip19.slice(0, 160));

// ── ③ 代號對不上要大聲講
ok('③ 引註代號跟本檔不符 → 有警告', !!r.warnOther && /3441/.test(r.warnOther));
ok('③b 而且顯示在第一眼(⛔ 不可藏進摺疊)', dom.cite === '3441', 'cite=' + dom.cite);
ok('③c 警告要說出「可能是別檔的報告」與「可能是 AI 編的」',
   /別檔/.test(r.warnOther) && /編/.test(r.warnOther));
ok('③d 代號相符時⛔ 不可亂跳警告', r.warnSame === '', r.warnSame.slice(0, 80));

await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ RPPASTE_SEC_PASS');
process.exit(fails.length ? 1 : 0);
