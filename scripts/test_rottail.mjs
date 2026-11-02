#!/usr/bin/env node
/**
 * 🫧 產業作戰室「💧 板塊輪動:四象限泡泡」—— 每一顆泡泡的尾巴(前 TAIL_N 個交易日的位置)
 *   想法參考 xang1234/stock-screener 的 groups RRG 匯出(Apache-2.0,只借「尾巴」這個想法)。
 *   V74.7.5 已經有「前 3 / 後 3 / 選中的」走過的線;其餘泡泡看不出從哪裡移過來 → 補淡淡的小點。
 *
 *  ① 其餘每一顆都有 TAIL_N 個點、前 3 / 後 3 ⛔ 疊點(它們已經有線)・線的條數跟以前一樣(⛔ 32 條線糊成一團)
 *  ② ⭐ 位置是真的:最新那一點 = 那一顆泡泡「前一天」的位置(決定性對照:拉到前一天量泡泡)
 *  ③ 越舊越淡、越舊越小;顏色跟泡泡同一色
 *  ④ 時間軸拉到最前面 → 只畫得出有的那幾天(⛔ 畫到負的日子)
 *  ⑤ 點在泡泡下面(⛔ 蓋住泡泡)、在線下面
 *  ⑥ 系統開了「減少動態效果」→ 點跟線都不畫(跟原本的線同一個開關)
 *  ⑦ 圖例一句話(總覽第一眼有字數上限),長說明在「📖 策略與回測」講「從哪裡移過來、⛔ 不是訊號」;新的字 ⛔ 訊號字(買 / 賣 / 會漲 / 會跌 / 偏多 / 偏空)
 *  ⓪ 沒有 pageerror
 * 跑法:node scripts/test_rottail.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAIL = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) FAIL.push(n); };
const exe = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(exe) ? { executablePath: exe } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });

const run = async (reduce) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    if (reduce) await page.emulateMedia({ reducedMotion: 'reduce' });
    const errs = [];
    page.on('pageerror', e => errs.push(String(e && e.message || e).slice(0, 200)));
    await page.goto('file://' + path.join(ROOT, 'pro.html'), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.PRO, null, { timeout: 30000 });
    await page.waitForTimeout(800);
    const R = await page.evaluate(async () => {
        const P = window.PRO, o = {};
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        // 合成 sector_rot:12 組、60 天,強弱 / 資金流都會動(⛔ 每天一樣 = 點全疊在一起,驗不出位置)
        const D = 60, days = [];
        for (let i = 0; i < D; i++) days.push(`2026-08-${String(1 + (i % 28)).padStart(2, '0')}`);
        const ind = {};
        for (let g = 0; g < 12; g++) {
            const r20 = [], f = [];
            for (let i = 0; i < D; i++) { r20.push(Math.sin((i + g * 5) / 7) * 10 + (g - 6)); f.push(Math.cos((i + g * 3) / 6) * 40 * (1 + g % 3)); }
            ind[String(g + 1).padStart(2, '0')] = { n: 8, r20, amt: r20.map((_, i) => 50 + g * 10 + i), flow: { f } };
        }
        P._cache['data/sector_rot.json'] = { updated: '2026-08-30', days, ind, themes: {}, theme_names: {} };
        P._rotMode = 'ind'; P._rotPick = null; P._rotSmooth = 0; P._rotSel = null; P._rotTrailOff = false;
        P.switchTab('rot'); await sleep(600);
        await P.renderRot(); await sleep(600);
        const tr = el => { const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(el.style.transform || ''); return m ? [+m[1], +m[2]] : null; };
        P.rotSeek(29); await sleep(100);
        const at29 = {}; document.querySelectorAll('#rotBubs .bub').forEach(el => { at29[el.dataset.k] = tr(el); });
        P.rotSeek(30); await sleep(100);
        const dots = [...document.querySelectorAll('#rotTrail circle.rtail')];
        o.nDots = dots.length; o.nLines = document.querySelectorAll('#rotTrail line').length;
        o.nBub = document.querySelectorAll('#rotBubs .bub').length;
        o.TAIL_N = P.TAIL_N;
        const byK = {}; dots.forEach(c => (byK[c.dataset.k] = byK[c.dataset.k] || []).push(c));
        o.perGroup = Object.values(byK).map(a => a.length);
        o.groups = Object.keys(byK);
        // 前 3 / 後 3(跟 rotSeek 同一份排序)
        const G = P._rotSet();
        const list = Object.keys(P._rotBub).map(c => ({ c, v: P._sm((G.grp[c] || {}).r20, 30) })).filter(x => x.v != null).sort((a, b) => b.v - a.v);
        const watch = new Set(list.slice(0, 3).map(x => x.c).concat(list.slice(-3).map(x => x.c)));
        o.watchHasDots = [...watch].some(c => byK[c]);
        // ② 位置:最新那一點(最大、最不透明)= 那一顆前一天的位置
        o.posErr = Object.entries(byK).map(([c, a]) => { const last = a[a.length - 1]; const p = at29[c]; return p ? Math.max(Math.abs(+last.getAttribute('cx') - p[0]), Math.abs(+last.getAttribute('cy') - p[1])) : 999; });
        // ③ 淡 / 小 / 顏色
        o.fade = Object.values(byK).every(a => a.every((c, i) => i === 0 || (+c.getAttribute('opacity') > +a[i - 1].getAttribute('opacity') && +c.getAttribute('r') > +a[i - 1].getAttribute('r'))));
        o.opRange = [Math.min(...dots.map(c => +c.getAttribute('opacity'))), Math.max(...dots.map(c => +c.getAttribute('opacity')))];
        o.colorOk = Object.entries(byK).every(([c, a]) => { const v = list.find(x => x.c === c)?.v; const want = v >= 0 ? 'rgb(255,93,93)' : 'rgb(61,220,132)'; return a.every(d => d.getAttribute('fill') === want); });
        // ⑤ 圖層順序:點在線前面(= 線下面)、整個尾巴圖層在泡泡下面
        const kids = [...document.getElementById('rotTrail').children];
        o.dotsFirst = kids.findIndex(x => x.tagName === 'line') < 0 || kids.findIndex(x => x.tagName === 'line') > kids.map(x => x.tagName).lastIndexOf('circle');
        const svgKids = [...document.getElementById('rotTrail').parentNode.children].map(x => x.id);
        o.underBubs = svgKids.indexOf('rotTrail') < svgKids.indexOf('rotBubs');
        // ④ 拉到第 2 天:只畫得出前 2 天
        P.rotSeek(2); await sleep(100);
        o.at2 = [...document.querySelectorAll('#rotTrail circle.rtail')].length;
        o.nonWatch2 = (() => { const l2 = Object.keys(P._rotBub).map(c => ({ c, v: P._sm((G.grp[c] || {}).r20, 2) })).filter(x => x.v != null).sort((a, b) => b.v - a.v); return l2.length - Math.min(l2.length, 6); })();
        // 選中一顆 → 它改畫線、⛔ 再有點
        P._rotSel = o.groups[0]; P.rotSeek(30); await sleep(100);
        o.selDots = document.querySelectorAll(`#rotTrail circle.rtail[data-k="${o.groups[0]}"]`).length;
        P._rotSel = null;
        o.leg = (document.getElementById('rotBubLeg') || {}).textContent || '';
        o.doc = (() => { try { return P._rotNoteHtml().replace(/<[^>]+>/g, ''); } catch (_) { return ''; } })();
        o.nonWatch30 = list.length - watch.size;
        return o;
    });
    await page.close();
    return { R, errs };
};

const { R, errs } = await run(false);
ok('⓪ 空過守門:泡泡真的畫出來了(12 顆)', R.nBub === 12, R.nBub);
ok(`① 其餘每一顆都有 ${R.TAIL_N} 個點(${R.nonWatch30} 顆 × ${R.TAIL_N})`, R.TAIL_N === 5 && R.nDots === R.nonWatch30 * 5 && R.perGroup.every(n => n === 5), `${R.nDots} / ${JSON.stringify(R.perGroup)}`);
ok('① 前 3 / 後 3 ⛔ 疊點(它們已經有線)', !R.watchHasDots);
ok('① 線的條數照舊只有前 3 / 後 3(⛔ 每一顆都畫線)', R.nLines > 0 && R.nLines <= 6 * 12, R.nLines);
ok('② ⭐ 最新那一點 = 那一顆前一天的位置(決定性對照:拉到前一天量泡泡)', R.posErr.length > 0 && Math.max(...R.posErr) < 0.11, JSON.stringify(R.posErr));
ok('③ 越舊越淡、越舊越小', R.fade && R.opRange[0] < 0.1 && R.opRange[1] > 0.25, JSON.stringify(R.opRange));
ok('③ 顏色跟泡泡同一色(看得出是誰的尾巴)', R.colorOk);
ok('④ 拉到第 2 天 → 每顆只有前 2 天的點(⛔ 畫到負的日子)', R.at2 === R.nonWatch2 * 2, `${R.at2} vs ${R.nonWatch2 * 2}`);
ok('④ 點選的那一顆改畫線、⛔ 再有點', R.selDots === 0, R.selDots);
ok('⑤ 點在線下面、整個尾巴圖層在泡泡下面', R.dotsFirst && R.underBubs);
ok('⑦ 圖例一句話講小點是什麼(第一眼字數有上限,長說明在「📖 策略與回測」那一頁)', /小點 = 每顆前 5 天的位置/.test(R.leg), R.leg.slice(-120));
ok('⑦ 長說明有講「從哪裡移過來」+「⛔ 不是訊號」', /泡泡的尾巴/.test(R.doc) && /從哪裡移過來/.test(R.doc) && /不是訊號/.test(R.doc), R.doc.slice(-200));
const legNew = (R.leg.split('小點 =')[1] || '') + ' ' + ((R.doc.split('泡泡的尾巴')[1] || '').split('不是訊號')[0]);   // 「⛔ 不是訊號」那半句本身含「訊號」兩個字 → 只掃它前面
ok('⑦ 新的那句 ⛔ 訊號字(買 / 賣 / 會漲 / 會跌 / 偏多 / 偏空 / 訊號)', legNew && !/買|賣|會漲|會跌|偏多|偏空|訊號|進場|出場/.test(legNew), legNew);
ok('⓪ 沒有 pageerror', !errs.length, errs.join(' | '));
const { R: Rr, errs: errs2 } = await run(true);
ok('⑥ 減少動態效果 → 點跟線都不畫(跟原本的線同一個開關)', Rr.nDots === 0 && Rr.nLines === 0 && Rr.nBub === 12, `${Rr.nDots} ${Rr.nLines}`);
ok('⓪ 減少動態效果那一輪也沒有 pageerror', !errs2.length, errs2.join(' | '));
await browser.close();
console.log(`\n${FAIL.length ? '❌ ' + FAIL.length + ' 項失敗' : '✅ 全部通過'}`);
process.exit(FAIL.length ? 1 : 0);
