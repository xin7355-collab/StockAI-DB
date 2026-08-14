#!/usr/bin/env node
/**
 * 📐 PE「vs 自己歷史位階」(V73.3.9)測試
 *
 * 背景:CLAUDE.md 原本判定「假的河流圖,不要做」—— 因為只有當前 PE、得用現在的 EPS 回推。
 *   `TaiwanStockPER` 給的是每一天當時的**真實** PE → 那個理由不成立了。
 *   `pe_band_probe.py` 實測(300 檔跨代號段均勻抽樣、11 年、扣同期加權):
 *     最低10% +0.68pp ・最低25% +0.63 ・中間 −0.31 ・最高25% −0.43 ・最高10% −0.49
 *   **完全單調 + 反向檢定成立** → 六道關卡全過,才落地。
 *
 * ⛔ 這支要擋住五件事:
 *   ① 沒資料時假裝知道(②)          ② 切股殘留(⑤)
 *   ③ 在這格下買賣指令(④)          ④ 用紅綠表示便宜/貴(③,燈號鐵則)
 *   ⑤ ETF 早退沒清這一格(⑥,陷阱 #19 已犯兩次)
 *   ⑥ 共用函式寫好卻沒接上呼叫點(⑦,陷阱 #37)
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 260)}`}`); if (!c) fails.push(n); };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._renderPeBand, null, { timeout: 20000 });

// 注入假的 pe_band 快取(⛔ 沙箱抓不到 gh-pages)
const seed = (data) => page.evaluate(d => {
    app._peBandAll = { ts: Date.now(), data: { edge: { lo10: 0.68, lo25: 0.63, mid: -0.31, hi25: -0.43, hi10: -0.49,
                                                       horizon: 60, cost: 0.44, files: 300, years: 11 }, data: d } };
}, data);
const render = async (sym) => {
    await page.evaluate(s => { app.currentSymbolId = s; }, sym);
    await page.evaluate(s => app._renderPeBand(s), sym);
    return page.evaluate(() => {
        const e = document.getElementById('xrayPeBand'), t = document.getElementById('xrayPeBandTag');
        return { v: e ? e.textContent : null, cls: e ? e.className : '', title: e ? e.title : '',
                 tag: t ? t.textContent : null };
    });
};

// ① 格子存在
ok('① DOM 格子存在', await page.evaluate(() => !!document.getElementById('xrayPeBand') && !!document.getElementById('xrayPeBandTag')));

// ② ⛔ 沒資料時不可假裝知道
{
    await seed({});
    const r = await render('9999');
    ok('② 沒資料 → 留 --', r.v === '--', JSON.stringify(r));
    ok('②b 沒資料 → 標籤要空', !r.tag, JSON.stringify(r));
}

// ③ 有資料 → 顯示位階;⛔ 但不可用紅綠(燈號鐵則:紅綠只准表示漲跌)
{
    await seed({ '2330': { pe: 18.5, pct: 8.2, lo: 12.1, hi: 34.5, med: 22.3, n: 730, d: '2026-08-13' } });
    const r = await render('2330');
    ok('③ 顯示位階 8%', r.v === '8%', JSON.stringify(r));
    ok('③b 標籤「近3年最便宜」', r.tag === '近3年最便宜', JSON.stringify(r));
    ok('③c ⛔ 不可用紅綠表示便宜/貴(燈號鐵則)', !/text-(red|green)-/.test(r.cls), r.cls);
    ok('③d title 要給區間與樣本數當佐證', /12\.1~34\.5/.test(r.title) && /730/.test(r.title), r.title);
}
{
    await seed({ '2330': { pe: 40, pct: 95, lo: 12.1, hi: 44, med: 22.3, n: 730, d: '2026-08-13' } });
    const r = await render('2330');
    ok('③e 高位階 → 「近3年最貴」', r.tag === '近3年最貴', JSON.stringify(r));
    ok('③f ⛔ 高位階也不可用紅綠', !/text-(red|green)-/.test(r.cls), r.cls);
}

// ④ ⛔ 說明裡不可下買賣指令,而且必須寫出限制
{
    const help = await page.evaluate(() => {
        let t = ''; const o = window.alert; window.alert = s => { t = s; };
        app.currentSymbolId = '2330'; app._showPeBandHelp(); window.alert = o; return t;
    });
    // ⚠️ 免責句本身含被禁的字 → 先 strip 掉否定形(這個坑本專案踩過 6 次)
    const st = help.replace(/⛔[^\n]*/g, '').replace(/別[^\n。]*/g, '').replace(/不[是可要能代][^\n。]*/g, '');
    ok('④ ⛔ 說明不可下買賣指令', !/(買進|該買|進場理由|加碼|快去)/.test(st), st.slice(0, 300));
    ok('④b 必須寫「跟 vs 同業不一樣」', /vs 同業/.test(help) && /vs 自己/.test(help), help.slice(0, 400));
    ok('④c 必須給實測數字', /0\.68/.test(help) && /單調/.test(help), help.slice(0, 900));
    ok('④d 必須寫扣成本後只剩多少', /0\.24/.test(help), help.slice(0, 1400));
    ok('④e 必須提醒景氣循環股 PE 低≠便宜', /景氣循環股/.test(help), help.slice(0, 1600));
    ok('④f ⭐ 必須說明 P/B 刻意沒做 + 原因', /P\/B/.test(help) && /方向完全相反/.test(help), help.slice(-500));
}

// ⑤ 切股競態守門:await 回來時已經換股 → ⛔ 不可畫上去
{
    await seed({ '2330': { pe: 18.5, pct: 8.2, lo: 12, hi: 34, med: 22, n: 730, d: '2026-08-13' } });
    const r = await page.evaluate(async () => {
        app.currentSymbolId = '2330';
        const p = app._renderPeBand('2330');
        app.currentSymbolId = '2317';          // ⚠️ await 期間切走
        await p;
        const e = document.getElementById('xrayPeBand');
        return e.textContent;
    });
    ok('⑤ 切股後不可畫上舊檔的位階', r === '--', String(r));
}

// ⑥ ⭐ ETF 早退必須清這一格(陷阱 #19 已犯兩次)
{
    const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    ok('⑥ ETF 早退清單要含 xrayPeBand', /'xrayPeg','xrayPeBand'\]/.test(src), '');
    ok('⑥b ETF 早退也要清標籤 xrayPeBandTag', /xrayPeBandTag'\); if \(_t\)/.test(src), '');
}

// ⑦ ⭐ 陷阱 #37:寫好了要真的接上呼叫點
{
    const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const calls = (src.match(/this\._renderPeBand\(/g) || []).length;
    ok('⑦ _renderPeBand 有被呼叫(⛔ 不可只定義不接)', calls >= 1, `呼叫 ${calls} 次`);
    ok('⑦b 定義存在', /_renderPeBand\(sym\) \{/.test(src), '');
    ok('⑦c 載入函式存在', /async _loadPeBand\(\) \{/.test(src), '');
}

// ⑧ 採礦端:⛔ 不可順便做 PB(實測不成立)+ 要有空過守門
{
    const m = fs.readFileSync(path.join(ROOT, 'pe_band_miner.py'), 'utf8');
    ok('⑧ 採礦端有空過守門(成功太少不覆寫)', /ok < MIN_OK/.test(m), '');
    ok('⑧b 位階窗口要跟探針一致(750)', /WIN = 750/.test(m), '');
    ok('⑧c ⛔ 不可輸出 PB 位階(實測不成立)', !/'pb_pct'|pbPct|PBR.*pct/.test(m), '');
    ok('⑧d 每一把 token 都要試', /for k in range\(max\(1, len\(TOKENS\)\)\)/.test(m), '');
    ok('⑧e 實測成績要寫進產物(⛔ 前端別另寫死一份)', /'edge':/.test(m), '');
}

ok('⑨ 無 pageerror', errs.length === 0, errs.join(' | '));
await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ PEBAND_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
