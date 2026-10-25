#!/usr/bin/env node
/**
 * 🎤🎲 V79.8.6 法說會「股性」(使用者:「有常常把法說會說成法會的,當然也有反之,用發生率去告訴使用者就好」)
 *   ① `_ccHabitTxt` 只轉述 confcall.json 的 react.hb / react.habit(⛔ 前端重算):三個比例一定一起出現(這檔過去 / 這檔平常 2 天 / 一般股票)
 *   ② 決定性對照:改 hb 的數字 → 畫面跟著變;沒有 hb → 一個字都不多
 *   ③ 場數 <5 → 多一句「先看一般股票那個比例」;一律寫「⛔ 不是會漲或會跌」
 *   ④ 三個地方都接上:現價下方法說會提醒 / 基本頁法說會那格 / 決策台「快開法說會」專欄(data-occ="cc")
 *   ⑤ ⛔ 研究字樣(lib_retailbad)、⛔ 方向字(偏多 / 偏空 / 買進 / 賣出)
 *   ⑥ pro.html 公司檔案:會後統計那格多一段 🎲(全體 + 這一檔 + LAB 結論)
 *   注入:INJECT=nobase(拿掉「平常 2 天」那段)/ INJECT=noocc(專欄那行拿掉)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { badOf } from './lib_retailbad.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let IDX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const ORIG = IDX, INJ = process.env.INJECT || '';
if (INJ === 'nobase') IDX = IDX.replace(" ・這檔平常隨便 2 天:差 ${t}% 以上 ${h.odn}%、好 ${t}% 以上 ${h.oup}%", '');
if (INJ === 'noocc') IDX = IDX.replace("if (o) hits[hits.length - 1].occ = o;", '');
if (INJ && IDX === ORIG) { console.log('❌ 注入沒有注進去'); process.exit(1); }
const TMP = path.join(ROOT, '.test_cchabit.html');
fs.writeFileSync(TMP, IDX);
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };
let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const errs = [];
try {
    const p = await browser.newPage({ viewport: { width: 390, height: 844 } });
    p.on('pageerror', e => errs.push(String(e)));
    await p.goto('file://' + TMP);
    await p.waitForFunction(() => typeof app !== 'undefined' && typeof app._ccHabitTxt === 'function', null, { timeout: 60000 });
    const R = await p.evaluate(() => {
        const tdy = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
        const D = { react: { habit: { th: 3, ev: { n: 17945, dn: 13.5, up: 17.0 }, ord: { n: 6e6, dn: 11.3, up: 11.0 }, how: 'x' }, hb: { '2330': [9, 4, 1, 18.2, 20.4], '1101': [3, 0, 1, 5.0, 5.2] } },
                    upcoming: [{ s: '2330', d: tdy, t: '14:00' }], recent: [], hist: {} };
        const o = {};
        o.long = app._ccHabitTxt('2330', D); o.short = app._ccHabitTxt('2330', D, true);
        o.html = app._ccHabitHtml('2330', D); o.few = app._ccHabitHtml('1101', D); o.none = app._ccHabitTxt('9999', D);
        D.react.hb['2330'] = [12, 7, 2, 25.5, 9.9]; o.long2 = app._ccHabitTxt('2330', D); D.react.hb['2330'] = [9, 4, 1, 18.2, 20.4];
        o.noHabit = app._ccHabitTxt('2330', { react: { hb: D.react.hb } });
        // ④ 三個地方
        app._confcallCache = D; app.currentSymbolId = '2330';
        app._findEarningsEvent = () => ({ date: tdy.replace(/-/g, '/'), days: 0 });
        let el = document.getElementById('stockEarningsReminder');
        if (!el) { el = document.createElement('div'); el.id = 'stockEarningsReminder'; document.body.appendChild(el); }
        app._renderStockEarningsReminder('2330'); o.rem = (el.querySelector('[data-occ="cc"]') || {}).innerText || '';
        o.corp = (() => { const h = app._corpConfCallHtml('2330', { decks: [{ d: tdy, st: 'ok', s: [{ t: '營收創新高 10%', p: 3 }] }] }); const b = document.createElement('div'); b.innerHTML = h; return (b.querySelector('[data-occ="cc"]') || {}).innerText || ''; })();
        const hits = app._colTrigEval({ tw: [], today: { tdy, wk: 2, weekday: true }, held: new Map([['2330', { cost: 500 }]]), bars: new Map([['2330', []]]), fav: [], cc: D, events: [] });
        const ccHit = hits.find(h => h.id === 'cc_soon'); o.hitOcc = ccHit ? ccHit.occ || '' : null;
        const G = app._colTrigGroups(hits); const b2 = document.createElement('div'); b2.innerHTML = app._deckColHtml(G);
        o.deckOcc = (b2.querySelector('[data-occ="cc"]') || {}).innerText || '';
        return o;
    });
    ok('① 長版三個比例一起(這檔過去 9 場 / 平常 2 天 18.2% / 一般股票 13.5%)', /過去 9 場/.test(R.long) && /4 場/.test(R.long) && /18\.2%/.test(R.long) && /20\.4%/.test(R.long) && /13\.5%/.test(R.long) && /17%/.test(R.long), R.long);
    ok('① 短版也是三個比例', /過去 9 場/.test(R.short) && /18\.2%/.test(R.short) && /13\.5%/.test(R.short), R.short);
    ok('② 決定性對照:hb 換數字 → 畫面跟著變', /過去 12 場/.test(R.long2) && /7 場/.test(R.long2) && /25\.5%/.test(R.long2), R.long2);
    ok('② 沒有這一檔 / 沒有全體比例 → 空字串(⛔ 半句)', R.none === '' && R.noHabit === '', JSON.stringify([R.none, R.noHabit]));
    ok('③ 場數 <5 → 先看一般股票那個比例;一律寫「⛔ 不是會漲或會跌」', /場數少/.test(R.few) && !/場數少/.test(R.html) && /不是會漲或會跌/.test(R.html), R.few.slice(0, 200));
    ok('④ 現價下方法說會提醒有 🎲 那行', /過去 9 場/.test(R.rem), R.rem);
    ok('④ 基本頁法說會那格有 🎲 那行', /過去 9 場/.test(R.corp), R.corp);
    ok('④ 決策台「快開法說會」專欄那一檔有 🎲 那行(data-occ)', /過去 9 場/.test(R.hitOcc || '') && /過去 9 場/.test(R.deckOcc), JSON.stringify([R.hitOcc, R.deckOcc]));
    const all = [R.long, R.short, R.few, R.html.replace(/<[^>]+>/g, '')].join('\n');
    ok('⑤ ⛔ 研究字樣(lib_retailbad)', !badOf(all).length, badOf(all).join(','));
    ok('⑤ ⛔ 方向字 / 買賣指令', !/偏多|偏空|看多|看空|買進|賣出|先賣|加碼|減碼/.test(all), (all.match(/偏多|偏空|看多|看空|買進|賣出|先賣|加碼|減碼/) || [])[0]);
    // ⑥ pro.html
    const q = await browser.newPage({ viewport: { width: 390, height: 844 } });
    q.on('pageerror', e => errs.push(String(e)));
    await q.goto('file://' + path.join(ROOT, 'pro.html'));
    await q.waitForFunction(() => typeof PRO !== 'undefined' && typeof PRO._confHabitHtml === 'function', null, { timeout: 60000 });
    const P = await q.evaluate(() => {
        PRO._confData = { react: { n: 1, events: 1, syms: 1, base: {}, how: 'x', caveat: 'y', habit: { th: 3, ev: { n: 17945, dn: 13.5, up: 17.0 }, ord: { n: 6e6, dn: 11.3, up: 11.0 } }, hb: { '2330': [9, 4, 1, 18.2, 20.4] } } };
        const b = document.createElement('div'); b.innerHTML = PRO._confReactHtml('2330');
        return b.innerText;
    });
    ok('⑥ pro 公司檔案:全體 13.5% / 17% + 這一檔 9 場 4 法會 + LAB 結論那句', /13\.5%/.test(P) && /自己過去 9 場/.test(P) && /股性/.test(P), P.slice(0, 400));
} finally { await browser.close(); try { fs.unlinkSync(TMP); } catch (_) {} }
ok('pageerror 0', !errs.length, errs.slice(0, 3).join(' | '));
if (fails.length) { console.log(`❌ CCHABIT_FAIL(${fails.length})`); process.exit(1); }
console.log('✅ CCHABIT_TEST_PASS');
