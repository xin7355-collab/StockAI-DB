#!/usr/bin/env node
/**
 * 🔒 V79.1.2 預設(沒解鎖)時,散戶救星畫面上⛔ 不可露出領頭羊那一套
 *   使用者:「app 預設策略符合進場,我要點進階才能是領頭羊策略…文字敘述不要露餡,現在有些文字有點疑似露餡了」
 *   實測(V79.1.2 修之前):更新紀錄 5 行(換倉 / LEADER_WINDOW / 前 5 名 / 停車 0050)、機率框「成交額前 100 大那一組」、
 *   設定「決策台要顯示什麼」的 🚪 / 🔥 說明「選 👑 時…」—— 全部漏網。
 *   ① 乾淨的手機(沒解鎖、預設):主頁 + 設定(⭐ 含展開「決策台要顯示什麼」)+ 個股 9 分頁 + 更新紀錄,
 *      可見文字與 title ⛔ 不可有 LEAK 字樣
 *   ② ⭐ 決定性對照:同一頁解鎖 + 👑 → 同一支掃描**必須掃得到**(⛔ 掃不到 = 沒有鑑別力)
 *   ③ 🗑️ 頂部跑馬燈已移除(#marketAlertBanner / .marquee-track 不存在),大盤風險推播仍會叫 _fireAlert
 *   ④ 📈 預設決策台:fit 開、pb 收(頂端寫出來);👑 時 pb 預設開;搬家旗標只清 pb / fit
 *   ⑤ 🔁 讀不到全市場快照⛔ 不可以「記住失敗」:60 秒內不重抓、之後自動再抓
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 400)}`); if (!c) fails++; };
const LEAK = '領頭羊|👑|換倉|LEADER_|成交額前 ?100|停車 ?0050';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
const errs = [];
page.on('pageerror', e => { const m = String(e); if (!/echarts is not defined/.test(m)) errs.push(m); });
await page.addInitScript(() => { try { if (!sessionStorage.getItem('__lf')) { localStorage.clear(); sessionStorage.setItem('__lf', '1'); } } catch (_) {} });
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && app._strat && app.renderDeck, null, { timeout: 60000 });
await page.waitForTimeout(4000);

const scan = () => page.evaluate((src) => {
    const RE = new RegExp(src); const out = [];
    const vis = el => { for (let e = el; e && e !== document.body; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden' || e.classList.contains('hidden')) return false; } return true; };
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n; while ((n = tw.nextNode())) { const t = n.nodeValue; if (t && RE.test(t) && n.parentElement && vis(n.parentElement)) { const p = n.parentElement.closest('[id]'); out.push((p ? '#' + p.id : '?') + ' | ' + t.trim().slice(0, 120)); } }
    document.querySelectorAll('[title]').forEach(e => { if (RE.test(e.title) && vis(e)) out.push('title ' + (e.id || e.tagName) + ' | ' + e.title.slice(0, 120)); });
    return out;
}, LEAK);

const sweep = async (label) => {
    const hits = new Set();
    const add = a => a.forEach(h => hits.add(h));
    for (const t of ['desk', 'inv', 'fav', 'market', 'radar']) {
        await page.evaluate(t => { try { app.switchAppTab(t); } catch (_) {} }, t); await page.waitForTimeout(1500); add(await scan());
    }
    // 設定(⭐ 展開「決策台要顯示什麼」—— 以前就是漏在這裡)
    await page.evaluate(() => { try { app.openSettings(); } catch (_) {} const b = document.getElementById('deckShowBox'); if (b) { b.classList.remove('hidden'); app._renderDeckShowList(); }
        document.querySelectorAll('#settingsModal details').forEach(d => d.open = true); });
    await page.waitForTimeout(800); add(await scan());
    await page.evaluate(() => { document.querySelectorAll('[id$="Modal"]').forEach(m => { m.classList.add('hidden'); m.style.display = 'none'; }); });
    // 更新紀錄(全部)
    await page.evaluate(() => { try { app._showUpdateLog(); } catch (_) {} }); await page.waitForTimeout(600); add(await scan());
    await page.evaluate(() => { document.querySelectorAll('[id$="Modal"]').forEach(m => { m.classList.add('hidden'); m.style.display = 'none'; }); });
    // 個股 9 分頁
    await page.evaluate(() => { app.switchAppTab('diag'); app.analyze('2330'); }); await page.waitForTimeout(5000);
    for (const st of ['strategy', 'report', 'live', 'daytrade', 'chart', 'chip', 'corp', 'backtest', 'bullbear']) {
        await page.evaluate(st => { try { app.switchSubTab(st); } catch (_) {} }, st); await page.waitForTimeout(1200);
        await page.evaluate(() => document.querySelectorAll('#appMainArea details').forEach(d => d.open = true));
        add(await scan());
    }
    console.log(`  [${label}] 掃到 ${hits.size} 處`);
    return [...hits];
};

// ① 預設
const st0 = await page.evaluate(() => ({ s: app._strat(), u: !!app.settings.stratUnlock }));
ok('①0 空過守門:真的是乾淨的預設(🧬・沒解鎖)', st0.s === 'gene' && !st0.u, JSON.stringify(st0));
const def = await sweep('預設');
ok('① 預設時畫面(含設定展開・更新紀錄・個股 9 分頁)⛔ 沒有領頭羊字樣', def.length === 0, def.join('\n   '));

// ② 決定性對照:解鎖 + 👑 → 同一支掃描要掃得到
await page.evaluate(() => { app.settings.stratUnlock = true; app.settings.strategy = 'leadpark'; app._leadCtx = null; try { app.saveSettings(); } catch (_) {} });
const on = await sweep('👑');
ok('② 決定性對照:解鎖 + 👑 時同一支掃描掃得到(⛔ 掃不到 = 沒有鑑別力)', on.length > 0, on.length);
const box = await page.evaluate(() => { app._renderStratBox(); const b = document.getElementById('stratBox');
    return { main: [...b.querySelectorAll('[data-stratopt]')].filter(x => !x.closest('[data-advbox]')).map(x => x.dataset.stratopt),
             adv: [...b.querySelectorAll('[data-advbox] [data-stratopt]')].map(x => x.dataset.stratopt) }; });
ok('②b 👑 兩個選項在「🔓 進階功能」那一區,上面只有 📈 / 🅿️', box.adv.length === 2 && box.adv.every(k => /^lead/.test(k)) && box.main.every(k => !/^lead/.test(k)), JSON.stringify(box));

// ③ 跑馬燈已移除、推播照舊
const mq = await page.evaluate(() => {
    const o = { banner: !!document.getElementById('marketAlertBanner'), track: !!document.querySelector('.marquee-track') };
    const f = []; const _f = app._fireAlert, _r = app._calcRiskScore;
    app._fireAlert = (t) => f.push(t); app._calcRiskScore = () => 85; app._alertCache = {};
    const _s = { ...app.settings }; app.settings.watchlistAlert = true; app.settings.riskAlertThreshold = 60;
    const N = window.Notification; try { Object.defineProperty(window, 'Notification', { value: { permission: 'granted' }, configurable: true }); } catch (_) {}
    try { app._checkMarketAlerts(); } catch (e) { o.err = String(e); }
    app._fireAlert = _f; app._calcRiskScore = _r; Object.assign(app.settings, _s);
    try { Object.defineProperty(window, 'Notification', { value: N, configurable: true }); } catch (_) {}
    o.fired = f; o.track2 = !!document.querySelector('.marquee-track');
    return o;
});
ok('③ 跑馬燈已移除(⛔ #marketAlertBanner / .marquee-track)', !mq.banner && !mq.track && !mq.track2, JSON.stringify(mq));
ok('③b 大盤風險推播照舊(85 分 → _fireAlert 一次)', mq.fired.length === 1 && /大盤極度恐慌/.test(mq.fired[0]) && !mq.err, JSON.stringify(mq));

// ④ 預設決策台
const dk = await page.evaluate(() => {
    const o = {};
    app.settings.stratUnlock = false; app.settings.strategy = 'gene'; app.settings.deckShow = null;
    o.gene = app._deckShow();
    app.settings.stratUnlock = true; app.settings.strategy = 'leadpark';
    o.lead = app._deckShow();
    app.settings.stratUnlock = false; app.settings.strategy = 'gene'; app.settings.deckShow = null;
    return o;
});
ok('④ 預設:📈 符合進場開、🔥 觸發價收起', dk.gene.fit === true && dk.gene.pb === false, JSON.stringify(dk.gene));
ok('④b 👑 時 🔥 預設開(那時它是名單外的買點)', dk.lead.pb === true, JSON.stringify(dk.lead));
// ④c 搬家:把 index.html 那一段原樣抽出來,拿假的 settings 跑(⛔ 測試裡不另寫一份邏輯)
{
    const SRC = (await import('fs')).readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const i = SRC.indexOf('if (!this.settings.deckMigr7912) {'), j = SRC.indexOf('// 👑 V78.1.9 舊的「👑 領頭羊」選項', i);
    const run = (st) => { const ctx = { settings: st }; globalThis.localStorage = { setItem() {} }; new Function(SRC.slice(i, j)).call(ctx); return ctx.settings; };
    const g = run({ strategy: 'gene', deckShow: { pb: true, fit: false, sell: false, col: true } });
    const l = run({ strategy: 'leadpark', deckShow: { pb: true, fit: false } });
    const again = run({ strategy: 'gene', deckMigr7912: 1, deckShow: { pb: true } });
    ok('④c 搬家:只清 pb / fit、其他勾選不動;👑 的人不清;只搬一次', i > 0 && j > i && !('pb' in g.deckShow) && !('fit' in g.deckShow) && g.deckShow.sell === false && g.deckShow.col === true && g.deckMigr7912 === 1
        && l.deckShow.pb === true && again.deckShow.pb === true, JSON.stringify([g, l, again]));
}

// ⑤ 讀不到快照⛔ 不可記住失敗
const rt = await page.evaluate(async () => {
    const o = {}; const F = window.fetch; let n = 0, fail = true;
    window.fetch = async (u, ...a) => { if (String(u).includes('screener.json')) { n++; if (fail) throw new TypeError('net'); } return F(u, ...a); };
    app._scrData = undefined; app._scrFailAt = 0;
    o.r1 = await app._loadScreener(); o.err1 = app._scrErr; o.n1 = n;
    o.r2 = await app._loadScreener(); o.n2 = n;                 // 60 秒內 → 不重抓
    app._scrFailAt = Date.now() - 61000; fail = false;
    o.r3 = await app._loadScreener(); o.n3 = n; o.ok3 = !!(o.r3 && o.r3.cols);
    o.r3 = null;
    window.fetch = F;
    return o;
});
ok('⑤ 第一次失敗:回 null 並記原因(網路不通)', rt.r1 === null && rt.err1 === 'net' && rt.n1 === 1, JSON.stringify(rt));
ok('⑤b 60 秒內不重抓(⛔ 不可一直打網站)', rt.r2 === null && rt.n2 === 1, JSON.stringify(rt));
ok('⑤c 60 秒後自動再抓、讀到就有資料(⛔ 不可永遠記住失敗)', rt.n3 === 2 && rt.ok3, JSON.stringify(rt));

ok('⑨ 無 pageerror', errs.length === 0, errs.slice(0, 3).join(' | '));
await browser.close();
console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ LEAKFREE_PASS');
process.exit(fails ? 1 : 0);
