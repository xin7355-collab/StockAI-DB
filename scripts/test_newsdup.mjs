#!/usr/bin/env node
/**
 * 🧩 V79.0.6 「另 N 家也報」前端守門(採礦端 universal_radar 同一事件歸群)
 *   ① 有 dup 的那則印「・另 N 家也報」,滑過去列出是哪幾家;沒有 dup ⛔ 一個字都不多
 *   ② 兩個畫新聞的地方都接上(總覽消息面 _ovNewsHtml / AI 股神最新焦點 _appendAiGodNews)
 *   ③ also 是外部字串 → 要跳脫(⛔ 不可把 <img> 原樣塞進 title)
 *   ④ ⛔ 不用顏色(灰字)
 *   ⑤~⑧ 🐛 V82.1.5 四個新聞畫面 ⛔ 再標採礦端 AI 判的利多 / 利空(tone / ai_sentiment 前後定義不一致、研究不可用):
 *      ⑤ 總覽消息面 ⑥ 最新焦點(新的在前) ⑦ 即時情報新聞 ⑧ 盤前新聞的台股那幾則(國際那幾則照舊上色 = 對照)
 *      每條都有決定性對照:同一批新聞把 AI 判的方向整個對調 → 畫面一個字都不能變(證明沒讀那個欄位)。
 */
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = process.env.ND_FILE || path.join(ROOT, 'index.html');
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 240)}`); if (!c) fails++; };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const page = await browser.newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
await page.goto(pathToFileURL(HTML).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._newsDupTxt && !!app._ovNewsHtml, null, { timeout: 60000 });
await page.waitForTimeout(800);

const R = await page.evaluate(async () => {
    const A = app, out = {};
    const items = [
        { title: '華邦電8月營收273.09億元', tone: 'pos', source: '鉅亨網', date: '2026-10-08 09:30', dup: 2, also: ['經濟日報', '<img src=x onerror=alert(1)>', 'x" onmouseover="alert(1)'] },
        { title: '華邦電砸354億買英飛凌', tone: 'neu', source: '工商時報', date: '2026-10-08 10:00' },
    ];
    A._stockNewsCache = { '2344': { items } }; A._stockNewsAt = Date.now();
    A.currentSymbolId = '2344';
    const box = document.createElement('div'); box.innerHTML = A._ovNewsHtml(); document.body.appendChild(box);
    const d = [...box.querySelectorAll('[data-newsdup]')];
    out.ovN = d.length; out.ovTxt = d.map(e => e.textContent.trim()); out.ovTitle = d[0] ? d[0].getAttribute('title') : '';
    out.ovHasImg = !!box.querySelector('img'); out.ovEvil = d[0] ? d[0].hasAttribute('onmouseover') : true; out.ovCls = d[0] ? d[0].className : '';
    // AI 股神最新焦點
    const g = document.createElement('div'); g.id = 'aiGodNewsBox'; document.body.appendChild(g);
    await A._appendAiGodNews(['2344'], '庫存');
    const d2 = [...g.querySelectorAll('[data-newsdup]')];
    out.godN = d2.length; out.godTxt = d2.map(e => e.textContent.trim());
    out.none = A._newsDupTxt({ title: 'x' }) === '' && A._newsDupTxt({ title: 'x', dup: 0 }) === '';

    // ⑤~⑧ 🐛 V82.1.5 ⛔ AI 利多利空:同一批新聞跑兩次,第二次把 AI 判的方向整個對調
    const flip = t => ({ pos: 'neg', neg: 'pos', neu: 'pos', '利多': '利空', '利空': '利多', '中立': '利多' }[t] || t);
    const RED_GREEN = /text-(red|green)-|border-(red|green)-|bg-(red|green)-|🔴|🟢|🟥|🟩/;
    const stockItems = [
        { title: '甲公司接大單', tone: 'pos', source: '自由財經', date: '2026-11-01 09:00', reason: '董事長看好明年' },
        { title: '甲公司跌停', tone: 'neg', source: '聯合新聞網', date: '2026-11-03 10:00', reason: '權值股失守' },
        { title: '甲公司股東會', tone: 'neu', source: '中央社', date: '2026-11-02 11:00' },
    ];
    const ov = items2 => { A._stockNewsCache = { '9999': { items: items2 } }; A.currentSymbolId = '9999'; return A._ovNewsHtml(); };
    const ovA = ov(stockItems), ovB = ov(stockItems.map(x => ({ ...x, tone: flip(x.tone) })));
    const ovT = (() => { const b = document.createElement('div'); b.innerHTML = ovA; return b.textContent; })();
    out.ov5 = { html: ovA, same: ovA === ovB, txt: ovT, rg: RED_GREEN.test(ovA), neutral: /data-newsneutral="1"/.test(ovA),
        reason: /董事長看好明年/.test(ovT), src: /自由財經/.test(ovT) };

    g.innerHTML = '';
    A._stockNewsCache = { '9998': { items: stockItems } };
    await A._appendAiGodNews(['9998'], '庫存');
    const gA = g.innerHTML, gTxt = g.textContent;
    A._stockNewsCache = { '9998': { items: stockItems.map(x => ({ ...x, tone: flip(x.tone) })) } };
    await A._appendAiGodNews(['9998'], '庫存');
    const gB = g.innerHTML;
    // 最新焦點每檔只拿前 2 則 → 11/01(利多)、11/03(利空);新的在前 = 11/03 那則先出現
    out.god6 = { same: gA === gB, rg: RED_GREEN.test(gA), txt: gTxt,
        order: gTxt.indexOf('甲公司跌停') > -1 && gTxt.indexOf('甲公司跌停') < gTxt.indexOf('甲公司接大單') };

    // ⑦ 即時情報新聞(用真頁面上的 #newsModalBody / #twNewsListEmbed;走 1 分鐘快取那條路,⛔ 連網)
    const radar = [
        { title: '乙公司營收創高', ai_sentiment: '利多', ai_reason: '營收年增三成', source_name: '科技新報', link: 'https://x/1' },
        { title: '乙公司遭調降', ai_sentiment: '利空', ai_reason: '外資調降評等', source_name: '鉅亨網', link: 'https://x/2' },
        { title: '乙公司法說會', ai_sentiment: '中立', ai_reason: '說明展望', source_name: '中央社', link: 'https://x/3' },
    ];
    out.live7 = !!document.getElementById('newsModalBody') && !!document.getElementById('twNewsListEmbed');
    const hl = async its => { A._newsCache = { ts: Date.now(), fetchedAt: Date.now(), items: its }; await A.loadNewsHeadlines(false);
        return document.getElementById('newsModalBody').innerHTML; };
    const hA = await hl(radar), hB = await hl(radar.map(x => ({ ...x, ai_sentiment: flip(x.ai_sentiment) })));
    const hTxt = document.getElementById('newsModalBody').textContent;
    out.hl7 = { same: hA === hB, rg: RED_GREEN.test(hA), order: hTxt.indexOf('乙公司營收創高') < hTxt.indexOf('乙公司遭調降') && hTxt.indexOf('乙公司遭調降') < hTxt.indexOf('乙公司法說會'),
        embedSame: document.getElementById('twNewsListEmbed').innerHTML === hB };

    // ⑧ 盤前新聞:fetchGlobalNews 的正式入口(fetch 換成假資料)→ 台股那幾則灰字 + AI 摘要;國際那則照舊上色(對照)
    const realFetch = window.fetch;
    const glob = { items: [{ source: 'Reuters', title: 'Oil jumps', title_zh: '油價大漲', url: 'https://r/1', impact: '對台股偏空', impact_level: 'bearish' }] };
    const runG = async rad => {
        window.fetch = async u => {
            const s2 = String(u);
            const body = /global_news\.json/.test(s2) ? glob : /radar_news\.json/.test(s2) ? { items: rad } : null;
            return body ? new Response(JSON.stringify(body), { status: 200 }) : new Response('{}', { status: 404 });
        };
        try { await A.fetchGlobalNews(); } finally { window.fetch = realFetch; }
        const rows = [...document.getElementById('globalNewsList').children];
        return rows.map(r => r.outerHTML);
    };
    const gl1 = await runG(radar);
    const keep1 = (A._globalNewsItems || []).filter(x => x.tw).map(x => x.impact_level).join(',');
    const gl2 = await runG(radar.map(x => ({ ...x, ai_sentiment: flip(x.ai_sentiment) })));
    const twRows = gl1.filter(h => /乙公司/.test(h)), twRows2 = gl2.filter(h => /乙公司/.test(h)), fx = gl1.filter(h => /油價大漲/.test(h));
    out.gl8 = { n: gl1.length, tw: twRows.length, same: JSON.stringify(twRows) === JSON.stringify(twRows2),
        rg: twRows.some(h => /text-(red|green)-/.test(h)), word: twRows.some(h => />利多<|>利空</.test(h)),
        sum: twRows.some(h => /營收年增三成/.test(h)), fxColored: fx.length === 1 && /text-green-400/.test(fx[0]),
        // 風險指數 / AI 提示詞還在讀的欄位這輪 ⛔ 動(只改畫面)
        keep: keep1 };
    // ⑧b 另一個畫面(AI 翻譯後重畫用的 _renderGlobalNewsList)也要一致
    A._renderGlobalNewsList(A._globalNewsItems);
    const r2 = [...document.getElementById('globalNewsList').children].map(r => r.outerHTML);
    out.gl8b = { rg: r2.filter(h => /乙公司/.test(h)).some(h => /text-(red|green)-/.test(h)), sum: r2.some(h => /營收年增三成/.test(h)),
        fxColored: r2.filter(h => /油價大漲/.test(h)).some(h => /text-green-400/.test(h)) };
    return out;
});

ok('① 有 dup 的那則印一次「另 2 家也報」', R.ovN === 1 && /另 2 家也報/.test(R.ovTxt[0] || ''), JSON.stringify(R.ovTxt));
ok('① 滑過去列出是哪幾家', /經濟日報/.test(R.ovTitle || ''), R.ovTitle);
ok('① 沒有 dup ⛔ 一個字都不多', R.none);
ok('② AI 股神最新焦點也接上', R.godN === 1 && /另 2 家也報/.test(R.godTxt[0] || ''), JSON.stringify(R.godTxt));
ok('③ also 跳脫:⛔ 不可生出 <img> 元素', !R.ovHasImg);
ok('③ also 跳脫:引號⛔ 不可跳出 title 屬性', !R.ovEvil && /onmouseover/.test(R.ovTitle || ''), R.ovTitle);
ok('④ 灰字(⛔ 不用紅綠)', /text-gray/.test(R.ovCls) && !/text-(red|green)/.test(R.ovCls), R.ovCls);
const NOWORD = t => !/利多|利空/.test(String(t).replace(/不標利多利空|不幫你判利多利空/g, ''));
ok('⑤ 總覽消息面:⛔ 利多 / 利空字樣、⛔ 紅綠(外框 / 字 / 圖示)、標中性', !R.ov5.rg && NOWORD(R.ov5.txt) && R.ov5.neutral, R.ov5.html);
ok('⑤ 總覽消息面:摘要、來源照舊留著', R.ov5.reason && R.ov5.src, R.ov5.txt);
ok('⑤ 決定性對照:AI 方向整個對調 → 畫面一個字不變', R.ov5.same);
ok('⑥ 最新焦點:⛔ 🔴利多 / 🟢利空、⛔ 紅綠', !R.god6.rg && NOWORD(R.god6.txt), R.god6.txt);
ok('⑥ 最新焦點:新的在前(⛔ 照 AI 方向排)', R.god6.order, R.god6.txt);
ok('⑥ 決定性對照:AI 方向對調 → 畫面不變', R.god6.same);
ok('⑦ 即時情報新聞:畫在真頁面的兩個區塊上', R.live7);
ok('⑦ 即時情報新聞:⛔ 🟥🟩、⛔ 紅綠左框、照採礦端時間序(⛔ 利多利空排前)', !R.hl7.rg && R.hl7.order, JSON.stringify(R.hl7));
ok('⑦ 決定性對照:AI 方向對調 → 畫面不變(兩個區塊都是)', R.hl7.same && R.hl7.embedSame);
ok('⑧ 盤前新聞(正式入口):台股那幾則灰字、印 AI 摘要、⛔ 利多 / 利空字', R.gl8.tw === 3 && !R.gl8.rg && !R.gl8.word && R.gl8.sum, JSON.stringify(R.gl8));
ok('⑧ 對照:國際那則照舊上色(這輪只動台股那幾則)', R.gl8.fxColored, JSON.stringify(R.gl8));
ok('⑧ 決定性對照:AI 方向對調 → 台股那幾則畫面不變', R.gl8.same);
ok('⑧ 風險指數 / 提示詞讀的欄位照舊(只改畫面)', R.gl8.keep === 'bullish,bearish,neutral', R.gl8.keep);
ok('⑧b AI 翻譯後重畫(_renderGlobalNewsList)也一樣:台股灰字 + 摘要、國際照舊', !R.gl8b.rg && R.gl8b.sum && R.gl8b.fxColored, JSON.stringify(R.gl8b));
ok('🚧 沒有 pageerror', !errs.length, errs.join(' | '));
await browser.close();
console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ test_newsdup 全過');
process.exit(fails ? 1 : 0);
