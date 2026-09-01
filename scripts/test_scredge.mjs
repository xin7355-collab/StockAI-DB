#!/usr/bin/env node
/**
 * 🔎 V74.0.3 選股條件實測成績(`_SCR_EDGE` / `_scrEdgeTag` / `_scrEdgeNote` / 只看實測領先)
 *
 * 這組最危險的地方跟 `_luOdds` 一樣:**數字會讓人以為「勾了就會賺」**。
 * 實測是 96 個測得動的條件裡,扣成本後還是正的只有 4 個、六關全過 **0 個**。
 * 少了那句話,這排徽章就變成在推薦一堆賠錢的條件。所以測試釘死:
 *   ① 數字現算自 `_SCR_EDGE`(換假表 → 畫面跟著變)—— ⛔ 不可寫死第二份
 *   ② 🚨 總結一定要寫「沒有一個條件自己會賺」+「不是勾了就會賺」
 *   ③ 🚨 基準必須寫出來(⛔ 不可拿 0% / 50% 當基準 —— 中位數個股本來就輸大盤)
 *   ④ ⛔ 徽章不可用紅綠(講的是「有沒有用」不是「漲還是跌」—— 燈號鐵則)
 *   ⑤ 沒測過的條件 → 整條不顯示(⛔ 不可假裝有成績)
 *   ⑥ 「只看實測領先」要真的過濾,而且⛔ 不可漏掉別的分組
 *   ⑦ 教學要誠實交代「沒有成績的那些是因為沒有歷史,不是它們沒用」
 *   ⑧ 🚧 空過守門:徽章/總結真的渲染出來了
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 220)}`}`); if (!c) fails++; };

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
const errs = [];
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined|Tailwind/i.test(t);
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._scrEdgeTag, null, { timeout: 25000 });

const meta = await page.evaluate(() => {
    const E = app._SCR_EDGE;
    const ids = Object.entries(E.c);
    return {
        n: E.n, syms: E.syms, base: E.base, fwd: E.fwd, cost: E.cost, cnt: ids.length,
        best: ids.slice().sort((a, b) => b[1][4] - a[1][4])[0],
        worst: ids.slice().sort((a, b) => a[1][4] - b[1][4])[0],
        pass: ids.filter(x => x[1][3]).length,
        posAbs: ids.filter(x => x[1][0] > 0).length,
        lead: ids.filter(x => x[1][4] >= 1).length,
        // 條件表裡有多少個 id 在成績表裡查得到
        covered: app._SCR_CONDS.filter(c => !!app._SCR_EDGE.c[c.id]).length,
        total: app._SCR_CONDS.length,
    };
});
console.log(`   ↳ ${meta.syms} 檔 / ${meta.n.toLocaleString()} 事件 ・ 成績表 ${meta.cnt} 個(選股條件共 ${meta.total} 個,查得到 ${meta.covered} 個)`);
console.log(`   ↳ 對照組 ${meta.base[0]}% / 勝率 ${meta.base[1]}% ・ 明顯領先 ${meta.lead} 個 ・ 扣成本後為正 ${meta.posAbs} 個 ・ 六關全過 ${meta.pass} 個`);

// ── ① 常數與資料完整性 ───────────────────────────────────────
ok('①a _SCR_EDGE 有定義且有內容', meta.cnt >= 60, `只有 ${meta.cnt} 個`);
ok('①b 🚧 空過守門:選股條件裡至少一半查得到成績', meta.covered >= meta.total * 0.4,
    `${meta.covered}/${meta.total}`);
ok('①c 🚨 對照組必須是「負的」(中位數個股本來就輸大盤,⛔ 不可寫成 0)',
    meta.base[0] < -0.5, JSON.stringify(meta.base));
ok('①d 🚨 勝率基準必須遠低於 50%(⛔ 不可用丟銅板當基準)',
    meta.base[1] > 25 && meta.base[1] < 45, String(meta.base[1]));

// ── ④⑤ 徽章 ─────────────────────────────────────────────────
const tags = await page.evaluate((b) => ({
    lead: app._scrEdgeTag(b[0]),
    none: app._scrEdgeTag('__不存在的條件__'),
    all: app._SCR_CONDS.map(c => app._scrEdgeTag(c.id)).join(''),
}), meta.best);
ok('⑧a 🚧 空過守門:徽章真的產出內容', tags.lead.length > 30, tags.lead);
ok('④ ⛔ 徽章不可用紅綠(⛔ 那是漲跌方向,不是好壞)',
    !/text-(red|green)-\d/.test(tags.all), (tags.all.match(/text-(red|green)-\d\d\d/g) || []).slice(0, 3).join(','));
ok('⑤ 沒測過的條件 → 整條不顯示(⛔ 不可假裝有成績)', tags.none === '', tags.none);
ok('①e 徽章數字現算(領先最多那個的 pp 要出現在字串裡)',
    tags.lead.includes(`+${meta.best[1][4].toFixed(1)}pp`), tags.lead);
ok('④b 徽章要標樣本數(⛔ 光給數字不給次數會讓人高估可信度)',
    /次/.test(tags.lead) && tags.lead.includes(meta.best[1][2].toLocaleString()), tags.lead);

// ── ② 總結誠實度 ────────────────────────────────────────────
const note = await page.evaluate(b => app._scrEdgeNote([b[0]]), meta.best);
ok('⑧b 🚧 空過守門:總結真的渲染', note.length > 200, note.slice(0, 120));
ok('②a 🚨 總結一定要寫「沒有一個條件自己會賺」',
    /沒有一個條件自己會賺/.test(note), note.slice(0, 400));
ok('②b 🚨 總結一定要寫「不是勾了就會賺」',
    /不是「?勾了就會賺/.test(note), note.slice(0, 500));
ok('②c 總結要交代「六道穩健性檢定全過的是 0 個」', /全過的是 0 個/.test(note));
ok('②d 沒選條件時 → 整條不顯示(⛔ 不留空殼)',
    (await page.evaluate(() => app._scrEdgeNote([]))) === '');
ok('②e ⛔ 總結不可下操作指令',
    !/(買進|進場|停損|停利|可以追|建議買|目標價)/.test(note),
    (note.match(/(買進|進場|停損|停利|可以追|建議買|目標價)/g) || []).join(','));

// ── ③⑦ 教學 ────────────────────────────────────────────────
const help = await page.evaluate(() => {
    let cap = ''; const bak = window.alert; window.alert = m => { cap = m; };
    app.showScrEdgeHelp(); window.alert = bak; return cap;
});
ok('⑧c 🚧 空過守門:教學真的有內容', help.length > 500, String(help).slice(0, 100));
ok('③a 🚨 教學必須寫出對照組的實際數字(⛔ 不可只說「跟平常比」)',
    help.includes(String(meta.base[0])) && help.includes(String(meta.base[1])), help.slice(0, 300));
ok('③b 🚨 教學要明說「基準不是 0% 也不是 50%」', /基準不是 0% 也不是 50%/.test(help));
ok('⑦a 教學要交代「沒成績的是因為沒有歷史,不是它們沒用」',
    /沒有歷史/.test(help) && /不是它們沒用/.test(help), help.slice(-300));
ok('⑦b 教學要提醒「單一條件領先 ≠ 組合起來會賺」',
    /單一條件領先\s*≠\s*組合起來會賺/.test(help));
ok('⑦c 教學要提醒窗口偏多頭 / 空頭沒驗證', /空頭沒驗證過/.test(help));
ok('③c 教學數字現算(換算窗口與事件數要對得上)',
    help.includes(meta.n.toLocaleString()) && help.includes(meta.syms.toLocaleString()));

// ── ⑥ 「只看實測領先」切換 ──────────────────────────────────
// ⛔ 呼叫**真的**那支 `app._scrCondList()`,⛔ 不在測試裡複製一份過濾邏輯 ——
//    第一版就是複製的,結果「把它改成只看當前分組」的注入缺陷**完全抓不到**
//    (那份複製品變成第二份真相)。這是 CLAUDE.md 記過的坑,當場再犯一次。
const filt = await page.evaluate(() => {
    app._scrEdgeOnly = true;
    const on = app._scrCondList();
    app._scrEdgeOnly = false;
    return {
        n: on.length,
        first: on[0] && on[0].id,
        sorted: on.every((c, i) => i === 0 || app._scrEdge(on[i - 1].id).vs >= app._scrEdge(c.id).vs),
        groups: [...new Set(on.map(c => c.s))].length,
        allLead: on.every(c => app._scrEdge(c.id).vs >= 1),
    };
});
ok('⑥a 🚧 空過守門:切換後真的挑得出條件', filt.n >= 5, `只有 ${filt.n} 個`);
ok('⑥b 只留「實測明顯領先」的(⛔ 不可混進沒過的)', filt.allLead);
ok('⑥c 依成績由強到弱排序', filt.sorted);
ok('⑥d ⭐ 要跨分組(⛔ 照分組看永遠拼不出全貌)', filt.groups >= 3, `只涵蓋 ${filt.groups} 個分組`);
ok('⑥e 第一名就是成績表裡領先最多的那個', filt.first === meta.best[0], `${filt.first} vs ${meta.best[0]}`);
ok('⑥f 切換函式存在且會重繪', /scrToggleEdgeOnly\(\)\s*\{[^}]*_renderCustomScreener\(\)/.test(SRC));
// ⚠️ 第一版這條寫成「全檔不可出現 `_scrEdgeOnly ?`」→ 被切換鈕自己的樣式三元擋下(假失敗)。
//    ⭐ 正解:釘「分組過濾那一段只准出現一次」(= 只在 _scrCondList 裡面)。
const groupFilterHits = (SRC.match(/_SCR_CONDS\.filter\(c => c\.g === this\._scrGroup/g) || []).length;
ok('⑥g ⛔ 渲染端必須用共用的 _scrCondList()(⛔ 不可自己再寫一份過濾)',
    /const list = this\._scrCondList\(\);/.test(SRC) && groupFilterHits === 1,
    `分組過濾出現 ${groupFilterHits} 次(應為 1,只在 _scrCondList 裡)`);

// ── ① 換一份假表 → 畫面跟著變(⛔ 證明沒有第二份寫死的數字)──
const fake = await page.evaluate(b => {
    const bak = JSON.parse(JSON.stringify(app._SCR_EDGE));
    app._SCR_EDGE.c[b[0]] = [9.99, 88.8, 123456, 1, 7.77];
    const t = app._scrEdgeTag(b[0]), nt = app._scrEdgeNote([b[0]]);
    app._SCR_EDGE = bak;
    return t + '｜' + nt;
}, meta.best);
ok('①f 換假成績表 → 徽章與總結都跟著變(⛔ 沒有寫死的第二份)',
    /\+7\.8pp|\+7\.77?pp/.test(fake) && /123,456/.test(fake), fake.slice(0, 200));

// ── ⑨ 🚨 V74.0.4「這個優勢正在衰退」──────────────────────────
//   徽章是 3 年平均,而逐年明細顯示前 12 名裡有 8 個最差的就是 2026 年。
//   ⛔ 不講這件事,使用者會拿「創一年新高 +3.3pp」當現在還有效。
const decay = await page.evaluate(b => ({
    line: app._scrDecayLine(),
    note: app._scrEdgeNote([b[0]]),
    D: app._SCR_EDGE.decay,
}), meta.best);
ok('⑨a 🚧 空過守門:衰退提示真的渲染', decay.line.length > 80, decay.line.slice(0, 100));
ok('⑨b 🚨 總結裡一定要含衰退提示(⛔ 不可只藏在教學裡)',
    decay.note.includes(decay.line.trim().slice(0, 40)) || /優勢正在變小/.test(decay.note),
    decay.note.slice(-300));
// ⚠️ V74.2.8:窗口補深到 2021 之後是**五年** → ⛔ 不可寫死「3 年」;
//    斷言改成釘「有講平均幾年」而且**年數要跟 decay.yrs 的長度一致**(⛔ 兩邊對不上比沒寫更糟)。
ok('⑨c 🚨 要明說徽章是「N 年平均」,而且 N 要跟逐年明細的年數一致',
   new RegExp(`${(decay.D.yrs || []).length} 年平均`).test(decay.line), `yrs=${(decay.D.yrs || []).length} / ${decay.line.slice(0, 120)}`);
// 🚨 ⑨c 那條是「兩邊都從 D.yrs.length 推」→ 天然是套套邏輯(注入驗證當場抓到:
//    把 yrs 砍成三年照樣綠)。真正要釘的是**年份標籤數 == 逐年數字的個數** ——
//    對不上就代表重跑之後只改了一半(⛔ 那會讓畫面少印或多印一年,而且不會報錯)。
ok('⑨c2 🚨 yrs 的年數要等於 eg 每一列的數字個數(⛔ 只改一半會靜默出錯)',
   (decay.D.eg || []).every(e => e.length - 1 === (decay.D.yrs || []).length),
   JSON.stringify({ yrs: (decay.D.yrs || []).length, eg: (decay.D.eg || []).map(e => e.length - 1) }));
ok('⑨d 數字現算自 _SCR_EDGE.decay(⛔ 不可寫死第二份)',
    decay.line.includes(String(decay.D.worst26)) && decay.line.includes(decay.D.yrs[decay.D.yrs.length - 1])
    && decay.line.includes(decay.D.eg[0][0]), decay.line.slice(0, 200));
ok('⑨e ⛔ 衰退提示不可用紅綠', !/text-(red|green)-\d/.test(decay.line));
const fakeD = await page.evaluate(() => {
    const bak = JSON.parse(JSON.stringify(app._SCR_EDGE.decay));
    app._SCR_EDGE.decay = { worst26: 3, top: 7, yrs: ['a', 'b', '2099年'], eg: [['測試招式', 1, 2, -9.99], ['第二招', 0, 0, -1]] };
    const l = app._scrDecayLine();
    app._SCR_EDGE.decay = bak;
    return l;
});
ok('⑨f 換一份假衰退資料 → 畫面跟著變',
    /2099年/.test(fakeD) && /測試招式/.test(fakeD) && /-9\.99/.test(fakeD), fakeD.slice(0, 200));
ok('⑨g 教學也要寫衰退(⛔ 兩處都要,別只改一邊)',
    /正在變小/.test(help) && help.includes(decay.D.eg[0][0]), help.slice(-400));

ok('⑧d 🚧 無 pageerror', errs.length === 0, errs.join(' | '));

await browser.close();
console.log();
console.log(fails ? `❌ ${fails} 條失敗` : '✅ SCREDGE_PASS(全部通過)');
process.exit(fails ? 1 : 0);
