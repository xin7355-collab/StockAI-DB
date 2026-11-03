#!/usr/bin/env node
/**
 * 🔀 V81.0.0 交叉提醒(使用者 11/03:「專欄都是單一研究,我要照每一檔的股性 + 遇到的事交叉起來,直接告訴我怎麼做」)
 *   ① 同一檔碰到好幾件事 → 合成一段(⛔ 一件事一段);大盤那天的事放最上面一段、只印一次
 *   ② 怎麼做:手上的第一句一律是「照你的出場規則走」、自選第一句「要買照決策台」
 *   ③ 比例:這檔過去 N 次 + 一般股票 +「⛔ 不是會漲或會跌」(data-occ);⛔ 研究字樣 / 紅綠
 *   ④ 星期五大跌 → 一般股票那行多「其中星期五那幾次」;同一份放在星期四 → 沒有(決定性對照)
 *   ⑤ 大漲那天:很會跳的 / 不太會跳的各自印自己那一組(只印 col_rate_base 判穩的組)
 *   ⑥ 通知:一天每檔一則 + 大盤一則(第二次 0);沒解鎖 / 關掉 → 0;類別 cross、可關、⛔ lock
 *   ⑦ 打開交叉提醒 → 兩支安靜紀錄不再記(⛔ 同一件事記兩筆)
 *   ⑧ 決定性對照:大盤沒大跌 → 沒有大盤那一段
 * 注入(逐一確認會紅):INJECT=nomerge / nogate / nofri
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { badOf } from './lib_retailbad.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const ORIG = SRC, INJ = process.env.INJECT || '';
if (INJ === 'nomerge') SRC = SRC.replace("const g = by.get(h.sym) || { sym: h.sym, sc: h.sc, mh: [], sh: [] };", "const g = { sym: h.sym, sc: h.sc, mh: [], sh: [] };").replace("            by.set(h.sym, g);\n", "            by.set(h.sym + '|' + h.id, g);\n");
if (INJ === 'nogate') SRC = SRC.replace("if (!lastD || !this._deckShow().cross) return 0;\n        const X = this._crossGroups(R && R.hits);", "if (!lastD) return 0;\n        const X = this._crossGroups(R && R.hits);");
if (INJ === 'nofri') SRC = SRC.replace("if (wk && G.by[wk] && G.by[wk].ok) out.push(", "if (false) out.push(");
if (INJ && SRC === ORIG) { console.log('❌ 注入沒有注進去'); process.exit(1); }
const TMP = path.join(ROOT, '.test_crossremind.html');
fs.writeFileSync(TMP, SRC);
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 400)}`); if (!c) fails.push(n); };

let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const errs = [];
const open = async (unlock) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    page.on('pageerror', e => errs.push(e.message));
    await page.addInitScript(u => { try { const s = JSON.parse(localStorage.getItem('proTerminalSettings') || '{}'); s.stratUnlock = u; s.strategy = 'gene'; s.deckShow = {}; localStorage.setItem('proTerminalSettings', JSON.stringify(s)); localStorage.removeItem('crossBell_v1'); } catch (_) {} }, unlock);
    await page.goto('file://' + TMP, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._crossHtml === 'function', null, { timeout: 60000 });
    return page;
};
// 頁面裡用的合成資料(同 test_advunlock 的 mkK:只排平日,最後一根換成指定日期)
const BUILD = () => {
    const iso = d => d.toISOString().slice(0, 10);
    const mkK = (n, endIso, f) => { const out = []; const e = new Date(endIso + 'T00:00:00Z'); let d = new Date(e); d.setUTCDate(d.getUTCDate() - n * 2); const c = 100; while (out.length < n) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w === 0 || w === 6) continue; if (iso(d) >= endIso) break; out.push({ date: iso(d), open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1000 }); } out.push({ date: endIso, open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1000 }); if (f) f(out); return out; };
    const idxMove = r => k => { const n = k.length; Object.assign(k[n - 1], { close: +(k[n - 2].close * (1 + r)).toFixed(2) }); };
    const brk = k => { const n = k.length; for (let j = n - 30; j < n - 1; j++) { const c = 100 + (j - (n - 30)) * 0.3; Object.assign(k[j], { close: c, high: c * 1.01, low: c * 0.99, open: c }); } Object.assign(k[n - 1], { open: k[n - 2].close, close: 95, high: k[n - 2].close, low: 94 }); };
    const lock = k => { const n = k.length, p = k[n - 2].close; Object.assign(k[n - 1], { open: p, close: +(p * 1.1).toFixed(2), high: +(p * 1.1).toFixed(2), low: p }); };
    return { iso, mkK, idxMove, brk, lock };
};

const page = await open(true);
const W = await page.evaluate((BUILDsrc) => {
    const B = (0, eval)('(' + BUILDsrc + ')')();
    const { mkK, idxMove, brk, lock } = B;
    const today = { tdy: '2026-10-19', wk: 1, weekday: true };
    const run = (tw, o) => app._colTrigEval(Object.assign({ tw, today, held: new Map(), bars: new Map(), fav: [], div: null, events: [], floor: null }, o));
    const out = {};
    app.settings.deckShow = Object.assign({}, app.settings.deckShow || {}, { cross: true, col: true });
    out.on = app._deckShow().cross;
    // 星期五(10/16)加權跌 2.5%;9999 手上的跌破月線 + 5 日線、9998 自選鎖漲停
    const twF = mkK(300, '2026-10-16', idxMove(-0.025));
    const hK = mkK(300, '2026-10-16', brk), fK = mkK(300, '2026-10-16', lock);
    const held = new Map([['9999', { cost: 0 }]]);
    const hits = run(twF, { held, bars: new Map([['9999', hK], ['9998', fK]]), fav: ['9998'] });
    out.ids = hits.map(h => h.id + (h.sym ? ':' + h.sym : '')).sort();
    const R = { hits, bars: new Map([['9999', hK], ['9998', fK]]) };
    const box = document.createElement('div'); box.innerHTML = app._crossHtml(R); document.body.appendChild(box);
    out.html = box.innerHTML; out.text = box.innerText;
    out.nSym9999 = box.querySelectorAll('[data-crosssym="9999"]').length;
    const b9 = box.querySelector('[data-crosssym="9999"]'); out.t9999 = b9 ? b9.innerText : '';
    out.nMkt = box.querySelectorAll('[data-crossmkt]').length;
    out.mktText = (box.querySelector('[data-crossmkt]') || {}).innerText || '';
    out.do9999 = [...box.querySelectorAll('[data-crossdo="9999"] li')].map(x => x.innerText);
    out.do9998 = [...box.querySelectorAll('[data-crossdo="9998"] li')].map(x => x.innerText);
    out.occ = [...box.querySelectorAll('[data-occ]')].map(x => x.innerText);
    out.mstk = [...box.querySelectorAll('[data-crossmstk]')].map(x => x.getAttribute('data-crossmstk')).sort();
    // ④ 星期五那幾次:同一份(收盤都一樣)放在星期五 vs 星期四
    const flat = mkK(300, '2026-10-16'), flatT = mkK(300, '2026-10-15');
    const M = new Map(twF.map(r => [r.date, +r.close]));
    const twT = mkK(300, '2026-10-15', idxMove(-0.025)), MT = new Map(twT.map(r => [r.date, +r.close]));
    out.friG = (app._colOccParts('m_dn2', flat, '9997', M) || {}).g || '';
    out.thuG = (app._colOccParts('m_dn2', flatT, '9997', MT) || {}).g || '';
    // ⑤ 大漲那天:很會跳(高低差 30%、位階在中間)/ 不太會跳(高低差 2%)
    const wide = mkK(300, '2026-10-15', k => { for (const r of k) { r.high = 115; r.low = 85; } }), narrow = mkK(300, '2026-10-15');
    out.bkWide = app._crossBucket('m_up2', wide).map(x => x.lbl); out.bkNarrow = app._crossBucket('m_up2', narrow).map(x => x.lbl);
    const twU = mkK(300, '2026-10-15', idxMove(0.025)), MU = new Map(twU.map(r => [r.date, +r.close]));
    out.upT = (app._colOccParts('m_up2', wide, '9996', MU) || {}).t || '';
    // ⑧ 決定性對照:同一天大盤只漲 0.5% → 沒有大盤那一段、也沒有 m_dn2
    const twCalm = mkK(300, '2026-10-16', idxMove(0.005));   // ⚠️ 平盤後 −0.5% 會變成「剛轉空頭」(bear_on),所以用 +0.5%
    const hits0 = run(twCalm, { held, bars: new Map([['9999', hK]]), fav: [] });
    const box0 = document.createElement('div'); box0.innerHTML = app._crossHtml({ hits: hits0, bars: new Map([['9999', hK]]) });
    out.calmMkt = box0.querySelectorAll('[data-crossmkt]').length; out.calmHas9999 = box0.querySelectorAll('[data-crosssym="9999"]').length; out.calmIds = hits0.map(h => h.id + (h.sym ? ':' + h.sym : ''));
    // ⑥ 通知
    const calls = [], quiet = [];
    app._fireAlert = (t, b, s) => calls.push({ t, b, s }); app._alertQuiet = (t, b, s) => quiet.push(t);
    try { localStorage.removeItem('crossBell_v1'); } catch (_) {}
    out.bell1 = app._crossBell(R, '2026-10-16'); out.bell2 = app._crossBell(R, '2026-10-16');
    out.calls = calls.map(c => c.t); out.bodies = calls.map(c => c.b);
    out.catMkt = app._alertCatOf(calls.find(c => /大盤/.test(c.t))?.t || '').k;
    out.catStk = app._alertCatOf(calls.find(c => !/大盤/.test(c.t))?.t || '').k;
    out.catLock = !!(app._ALERT_CATS.find(c => c.k === 'cross') || {}).lock;
    app.settings.alertOff = { cross: true }; out.catOff = app._alertCatOn('🔀 交叉提醒｜大盤 測試'); app.settings.alertOff = {};
    // 關掉 cross → 0
    app.settings.deckShow.cross = false; try { localStorage.removeItem('crossBell_v1'); } catch (_) {}
    out.bellOff = app._crossBell(R, '2026-10-16'); out.htmlOffDeck = '';
    app.settings.deckShow.cross = true;
    return out;
}, BUILD.toString());

// 沒解鎖的頁面
const p2 = await open(false);
const W2 = await p2.evaluate(async () => {
    const o = {};
    o.on = app._deckShow().cross;
    const calls = []; app._fireAlert = t => calls.push(t);
    o.bell = app._crossBell({ hits: [{ id: 'idx_drop2', why: 'x' }, { id: 'ma20_break', sym: '2330', sc: 'held', why: 'y' }] }, '2026-10-16');
    o.calls = calls.length;
    app._colTrigScan = async () => ({ hits: [{ id: 'ma20_break', sym: '2330', sc: 'held', why: 'y' }] });
    const d = document.getElementById('deckCross'); if (d) d.innerHTML = 'X';
    await app._renderDeckCross(); o.deck = d ? d.innerHTML : null;
    o.catShown = (app._ALERT_CATS || []).filter(c => (!c.lead || app._isLead?.()) && (!c.adv || !!(app.settings && app.settings.stratUnlock))).some(c => c.k === 'cross');
    return o;
});
await browser.close(); try { fs.unlinkSync(TMP); } catch (_) {}

ok('pageerror 0', !errs.length, errs.slice(0, 3).join(' | '));
ok('⓪ 解鎖後交叉提醒預設開', W.on === true);
ok('⓪ 星期五跌 2.5% → 大盤 idx_drop2 + fri_drop、兩檔都有 m_dn2', ['idx_drop2', 'fri_drop', 'm_dn2:9999', 'm_dn2:9998'].every(x => W.ids.includes(x)), JSON.stringify(W.ids));
ok('① 同一檔碰到好幾件事 → 只有一段,寫出每一件', W.nSym9999 === 1 && /月線/.test(W.t9999) && /5 日線/.test(W.t9999), JSON.stringify([W.nSym9999, W.t9999]));
ok('① 大盤那一段只印一次、一般股票那行只出現一次', W.nMkt === 1 && (W.text.match(/一般股票碰到大盤單日跌 2% 以上那天/g) || []).length === 1, JSON.stringify([W.nMkt, (W.text.match(/一般股票碰到大盤單日跌 2% 以上那天/g) || []).length]));
ok('① 大盤那一段列出碰到的每一檔(這一檔自己過去的次數)', JSON.stringify(W.mstk) === JSON.stringify(['9998', '9999']) && /這檔過去(沒有)?碰到大盤單日跌 2% 以上/.test(W.mktText), JSON.stringify(W.mstk));
ok('② 手上的第一句 = 照你的出場規則走;自選第一句 = 要買照決策台', /出場規則/.test(W.do9999[0] || '') && /照決策台/.test(W.do9998[0] || '') && W.do9999.length <= 3, JSON.stringify([W.do9999, W.do9998]));
ok('③ 一般股票那幾行都有「⛔ 不是會漲或會跌」', W.occ.filter(t => /一般股票/.test(t)).length >= 1 && W.occ.filter(t => /一般股票/.test(t)).every(t => /不是會漲或會跌/.test(t)), JSON.stringify(W.occ).slice(0, 400));
const bad = badOf(W.text);
ok('③ ⛔ 研究字樣 / 🔴🟢 / 勝率', !bad.length && !/🔴|🟢|勝率|期望值/.test(W.text), JSON.stringify(bad) + W.text.slice(0, 200));
ok('④ 星期五大跌 → 一般股票那行多「其中星期五那幾次」', /其中星期五那幾次/.test(W.friG), W.friG);
ok('④ 決定性對照:同一份放在星期四 → 沒有「其中…那幾次」(星期一到四那組不穩)', !!W.thuG && !/其中/.test(W.thuG), W.thuG);
ok('⑤ 大漲那天:很會跳的 → 「平常很會跳的股票」;不太會跳的 → 「平常不太會跳的股票」', W.bkWide.includes('平常很會跳的股票') && W.bkNarrow.includes('平常不太會跳的股票'), JSON.stringify([W.bkWide, W.bkNarrow]));
ok('⑤ 這一檔的股性那一行有寫出來', /平常很會跳的股票碰到這種日子/.test(W.upT), W.upT);
ok('⑥ 通知:大盤一則 + 每檔一則,第二次 0', W.bell1 === 3 && W.bell2 === 0 && W.calls.filter(t => /大盤/.test(t)).length === 1, JSON.stringify([W.bell1, W.bell2, W.calls]));
ok('⑥ 通知內容帶比例與「照你的出場規則走 / 照決策台」', W.bodies.some(b => /這檔過去/.test(b)) && W.bodies.every(b => /出場規則|照決策台/.test(b)), JSON.stringify(W.bodies).slice(0, 400));
ok('⑥ 類別 cross(大盤那則也是)、可以關、⛔ lock', W.catMkt === 'cross' && W.catStk === 'cross' && !W.catLock && W.catOff === false, JSON.stringify([W.catMkt, W.catStk, W.catLock, W.catOff]));
ok('⑥ 關掉交叉提醒 → 一則都不發', W.bellOff === 0, W.bellOff);
ok('⑥ 沒解鎖:關著、一則都不發、決策台那一塊空、設定的通知分類⛔ 列', W2.on === false && W2.bell === 0 && W2.calls === 0 && W2.deck === '' && W2.catShown === false, JSON.stringify(W2));
ok('⑦ 打開交叉提醒 → 兩支安靜紀錄不記(同一件事只記一次)', /if \(!xOn\) \{ try \{ this\._colTrigBell\(hits, lastD\); \} catch \(_\) \{\} try \{ this\._colOccBell\(hits, lastD\); \} catch \(_\) \{\} \}/.test(ORIG) && /if \(xOn\) \{ try \{ this\._crossBell\(/.test(ORIG));
ok('⑧ 決定性對照:大盤沒大跌 → 沒有大盤那一段;那一檔的事照講', W.calmMkt === 0 && W.calmHas9999 === 1, JSON.stringify([W.calmMkt, W.calmHas9999, W.calmIds]));
console.log(fails.length ? `❌ ${fails.length} 條失敗` : '✅ CROSSREMIND_PASS');
process.exit(fails.length ? 1 : 0);
