#!/usr/bin/env node
/**
 * 💳 融資維持率改用官方值 + 11 年實測(V73.3.8)測試
 *
 * 🚨 這一版修的是**方向相反的錯誤資訊**:
 *    V72.0.3 起這張卡顯示的是我自己推估的 **127.9%**,並據此說「已跌破 130% = 斷頭區」。
 *    `margin_maint_probe.py` 拿證交所官方 11 年資料實測,同一天官方是 **194.70%**
 *    —— 差 67pp,而且 194.7% 其實落在**歷史高檔**(11 年 P95 = 182.9%)。
 *
 * ⛔ 這支要擋住四件事:
 *   ① 官方值在時,⛔ 不可再標「推估」或講「跌破 130% 會反彈」(②③)
 *   ② 拿不到官方值退回推估時,⛔ 必須講明那是推估、而且會偏低(④)
 *   ③ 嵌進去的實測數字必須跟探針一致(⑥ 交叉驗證)
 *   ④ ⛔ 這張卡不可下買賣指令(⑤)
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 260)}`}`); if (!c) fails.push(n); };
const txt = h => String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._marginHealthHtml, null, { timeout: 20000 });

const render = (ratio, src, est) => page.evaluate(([ratio, src, est]) => {
    app._marketStats = { margin: { ratio, src, est_ratio: est, n: 1800, lots: 0, val_e: 9948, amt_e: 7812, date: '2026-08-13' },
                         margin_hist: [] };
    return { html: app._marginHealthHtml(), st: app._marginHealth() };
}, [ratio, src, est]);

// 🚧 空過守門:渲染不出來的話,底下「不可出現 X」全部會假綠
const must = async (r, src, est) => {
    const o = await render(r, src, est);
    if (!/融資維持率/.test(txt(o.html))) {
        console.log('❌ 🚧 空過守門:_marginHealthHtml 沒渲染出東西 → 後面斷言全部無效');
        console.log('   實際:', String(o.html).slice(0, 300));
        await browser.close(); process.exit(1);
    }
    return o;
};

// ① 官方值(今天實際是 194.70%)
let off;
{
    off = await must(194.7, 'official', 127.9);
    const t = txt(off.html);
    ok('① 官方值 → state 標 official', off.st && off.st.official === true, JSON.stringify(off.st && off.st.official));
    ok('①b 標題要寫「官方公布值」', /官方公布值/.test(t), t.slice(0, 160));
    ok('①c ⛔ 官方時不可標「推估・非官方」', !/推估・非官方/.test(t), t.slice(0, 200));
    ok('①d 194.7% 要判成「11 年來最高的 5%」', /最高的 5%/.test(t), t.slice(0, 260));
    ok('①e 要把推估值列出來對照', /127\.9/.test(t), t.slice(0, 400));
}

// ②③ ⭐ 最重要:⛔ 不可再講「跌破 130% 會反彈」
{
    const t = txt(off.html);
    ok('② ⛔ 不可再說「跌破 130% 常跟著反彈」', !/跌破.{0,6}130.{0,20}反彈/.test(t), t.slice(0, 300));
    ok('②b 必須明說 11 年一次都沒跌破過 130%', /一次都沒有跌破 130%/.test(t), t.slice(0, 400));
    ok('②c 必須給史上最低值當證據', /130\.4/.test(t), t.slice(0, 400));
    ok('③ 必須點出實測方向跟流行說法相反', /跟流行說法相反/.test(t), t.slice(0, 500));
    ok('③b 必須寫出「融資越健康反而略好」', /融資越健康/.test(t), t.slice(0, 520));
}

// ④ 退回推估時要講清楚
{
    const o = await must(127.9, 'estimate', undefined);
    const t = txt(o.html);
    ok('④ 推估時標題要寫「推估・非官方」', /推估・非官方/.test(t), t.slice(0, 160));
    ok('④b 必須寫明推估會系統性偏低', /系統性偏低/.test(t), t.slice(0, 500));
    ok('④c ⛔ 推估時不可宣稱是官方值', !/證交所公布的官方值/.test(t), t.slice(0, 300));
    ok('④d 127.9% 要判成「最低的 5%」而不是靜靜過去', /最低的 5%/.test(t), t.slice(0, 300));
}

// ⑤ ⛔ 不可下買賣指令(先 strip 掉否定/免責句,免得自己寫對的免責絆倒自己)
{
    const t = txt(off.html);
    const stripped = t.replace(/⛔[^。]*。?/g, '').replace(/不[是可要能足][^。]*。?/g, '').replace(/別[^。]*。?/g, '');
    ok('⑤ ⛔ 不可出現買賣指令', !/(快去撿|該買|買進|進場理由是|加碼|抄底吧)/.test(stripped), stripped.slice(0, 300));
}

// ⑥ 交叉驗證:嵌的數字要跟探針一致
{
    const E = await page.evaluate(() => app._MARGIN_EDGE);
    ok('⑥ 實測窗口 2,821 天 / 2015-01-05', E.days === 2821 && E.from === '2015-01-05', JSON.stringify([E.days, E.from]));
    ok('⑥b 史上最低 130.4 / 中位 168.5 / 最高 210.4', E.lo === 130.4 && E.med === 168.5 && E.hi === 210.4, JSON.stringify(E));
    ok('⑥c 跌破 130% 的天數必須是 0', E.n130 === 0, String(E.n130));
    ok('⑥d 相對位階:最低 5% 必須是負的', E.rel.lo5 < 0, String(E.rel.lo5));
    ok('⑥e 相對位階:最高 20% 必須是正的', E.rel.hi20 > 0, String(E.rel.hi20));
    // ⛔ 三個「低位階」全負 = 方向一致,若哪天重跑變號要立刻發現
    ok('⑥f 三個低位階同向(全負)', E.rel.lo5 < 0 && E.rel.lo10 < 0 && E.rel.lo20 < 0, JSON.stringify(E.rel));
}

// ⑦ 採礦端:官方優先 + 有留 error
{
    const fs = await import('fs');
    const src = fs.readFileSync(path.join(ROOT, 'miner.py'), 'utf8');
    ok('⑦ miner 要有官方抓取函式', /def fetch_official_margin_maintenance/.test(src), '');
    ok('⑦b 官方值要覆蓋 ratio 並標 src', /mh\['src'\] = 'official'/.test(src), '');
    ok('⑦c 推估值要降級保留成 est_ratio(可回頭對照)', /mh\['est_ratio'\]/.test(src), '');
    ok('⑦d 抓不到官方要留 *_error(陷阱 #22)', /margin_official_error/.test(src), '');
    ok('⑦e ⛔ 要有離譜值守門', /50 <= float\(v\) <= 400/.test(src), '');
    ok('⑦f 每一把 token 都要試(V72.5.3)', /for i in range\(len\(toks\)\)/.test(src), '');
}

ok('⑧ 無 pageerror', errs.length === 0, errs.join(' | '));
await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ MARGIN_OFFICIAL_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
