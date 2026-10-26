#!/usr/bin/env node
/**
 * 📐 V79.8.8 產業作戰室「📐 量化實驗室」分頁(PRO.QLAB 只讀,⛔ 畫面重算)
 *   ① 研究那一類進得去(按鈕 / navGo / 舊名 quant)・② 列數 == 策略數、上面三個數字 == 判定分布
 *   ③ 決定性對照:改 QLAB 的數字 / 判定 → 畫面跟著變 ・④ 表頭排序(同一個再按一次反向)
 *   ⑤ 判定用 ✅⛔➖、⛔ 紅綠 ・⑥ 點一列看細節:八道關卡、參數格 == grid、逐年長條 == 年數
 *   ⑦ 390px 不橫捲、細節不被切 ・⑧ 嵌入的 QLAB:策略數 == qlab_strategies.json、16 年、含已下市、≤ 80 KB
 *   注入:INJECT=nosort(排序沒作用)/ INJECT=redv(判定上紅綠)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let SRC = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');
const ORIG = SRC, INJ = process.env.INJECT || '';
if (INJ === 'nosort') SRC = SRC.replace("qlSort(k) { const S = this._qlSort ||", "qlSort(k) { return; const S = this._qlSort ||");
if (INJ === 'redv') SRC = SRC.replace(".qlv.ok{color:var(--txt)}.qlv.bad{color:var(--amber)}", ".qlv.ok{color:var(--up)}.qlv.bad{color:var(--dn)}");
if (INJ && SRC === ORIG) { console.log('❌ 注入沒有注進去'); process.exit(1); }
const TMP = path.join(ROOT, '.test_qlab_ui.html'); fs.writeFileSync(TMP, SRC);
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
    await p.waitForFunction(() => typeof PRO !== 'undefined' && PRO.QLAB && typeof PRO.renderQlab === 'function', null, { timeout: 60000 });
    const R = await p.evaluate(() => {
        const o = {}, vis = id => { const e = document.getElementById(id); return !!e && !e.classList.contains('hidden'); };
        PRO.navGo('qlab');
        o.shown = vis('tabQlab'); o.btnOn = document.getElementById('tabBtnQlab').classList.contains('on'); o.grp = PRO._navGroupOf('qlab');
        PRO.switchTab('home'); PRO.switchTab('quant'); o.alias = vis('tabQlab') && PRO._tab === 'qlab';
        const F = PRO.QLAB.fam, rows = () => [...document.querySelectorAll('[data-qlrow]')].map(r => r.dataset.qlrow);
        o.n = rows().length; o.nf = F.length;
        o.sum = document.querySelector('[data-qlsum]').innerText;
        o.cnt = ['ok', 'bad', 'none'].map(k => F.filter(x => x.verdict === k).length);
        // ③ 決定性對照
        const keep = JSON.stringify(PRO.QLAB);
        F[0].c.x = 9.876; F[0].verdict = 'ok'; PRO.renderQlab();
        const r0 = document.querySelector(`[data-qlrow="${F[0].id}"]`);
        o.det1 = r0 ? r0.innerText : ''; o.det1v = r0 ? (r0.querySelector('[data-qlv]') || {}).dataset.qlv : '';
        PRO.QLAB = JSON.parse(keep); PRO.renderQlab();
        // ④ 排序
        PRO._qlSort = null; PRO.renderQlab(); const a = rows();
        PRO.qlSort('x'); const b = rows();
        PRO.qlSort('v'); const v1 = [...document.querySelectorAll('[data-qlv]')].map(e => e.dataset.qlv);
        o.sortRev = JSON.stringify(a) === JSON.stringify(b.slice().reverse()) && JSON.stringify(a) !== JSON.stringify(b);
        o.vOrder = v1; o.hdrOn = !!document.querySelector('[data-qlsort="v"].on');
        // ⑤ 判定的顏色
        const up = getComputedStyle(document.documentElement).getPropertyValue('--up').trim(), dn = getComputedStyle(document.documentElement).getPropertyValue('--dn').trim();
        const hex = c => { const m = c.match(/\d+/g); return m ? '#' + m.slice(0, 3).map(x => (+x).toString(16).padStart(2, '0')).join('') : c; };
        o.vCols = [...document.querySelectorAll('[data-qlv]')].map(e => hex(getComputedStyle(e).color)); o.up = up; o.dn = dn;
        o.vTxt = [...document.querySelectorAll('[data-qlv]')].map(e => e.innerText);
        // ⑥ 細節
        const fx = F.find(x => x.verdict === 'bad') || F[0];
        PRO._qlOpen = null; PRO.qlOpen(fx.id);
        const d = document.querySelector(`[data-qldet="${fx.id}"]`);
        o.det = !!d; o.gates = d ? d.querySelectorAll('.qlgates > div').length : 0; o.heat = d ? d.querySelectorAll('.qlheat > div').length : 0; o.grid = fx.grid.length;
        o.bars = d ? d.querySelectorAll('.qlyrs i').length : 0; o.yrs = fx.c.yrs.length;
        o.detRight = d ? d.querySelector('.qlin').getBoundingClientRect().right : 9999;
        window.scrollTo(80, 0); o.sx = window.scrollX;
        PRO.qlOpen(fx.id); o.closed = !document.querySelector('[data-qldet]');
        return o;
    });
    ok('① 研究那一類進得去、按鈕亮、舊名 quant 也進得去', R.shown && R.btnOn && R.grp === 'res' && R.alias, JSON.stringify([R.shown, R.btnOn, R.grp, R.alias]));
    ok('② 列數 == 策略數', R.n === R.nf && R.nf >= 8, JSON.stringify([R.n, R.nf]));
    ok('② 上面三個數字 == 判定分布', R.sum.includes(`有用 ${R.cnt[0]} 支`) && R.sum.includes(`比亂買還差 ${R.cnt[1]} 支`) && R.sum.includes(`跟亂買差不多 ${R.cnt[2]} 支`), R.sum);
    ok('③ 決定性對照:改 QLAB 的數字 / 判定 → 畫面跟著變', /\+9\.88%/.test(R.det1) && R.det1v === 'ok', JSON.stringify([R.det1, R.det1v]));
    ok('④ 表頭排序:同一個再按一次反向', R.sortRev);
    ok('④ 照判定排:有用 → 差不多 → 比亂買還差,表頭亮', R.hdrOn && R.vOrder.join(',') === R.vOrder.slice().sort((a, b) => ({ ok: 0, none: 1, bad: 2 })[a] - ({ ok: 0, none: 1, bad: 2 })[b]).join(','), R.vOrder.join(','));
    ok('⑤ 判定用 ✅⛔➖、⛔ 上紅綠', R.vTxt.every(t => /^(✅|⛔|➖)/.test(t)) && R.vCols.every(c => c !== R.up && c !== R.dn), JSON.stringify([R.vCols, R.up, R.dn]));
    ok('⑥ 細節:八道關卡、參數格 == grid、逐年長條 == 年數', R.det && R.gates === 8 && R.heat === R.grid && R.bars === R.yrs && R.yrs >= 10, JSON.stringify([R.gates, R.heat, R.grid, R.bars, R.yrs]));
    ok('⑥ 同一列再點一次收起來', R.closed);
    ok('⑦ 390px:整頁不橫捲、細節右邊界在畫面內', R.sx <= 2 && R.detRight <= 392, JSON.stringify([R.sx, R.detRight]));
} finally { await browser.close(); try { fs.unlinkSync(TMP); } catch (_) {} }
// ⑧ 嵌入的 QLAB
const m = ORIG.match(/\n  QLAB: (\{.*\}),\n/), S = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/qlab_strategies.json'), 'utf8'));
const Q = m ? JSON.parse(m[1]) : null;
ok('⑧ QLAB:策略數 == qlab_strategies.json、每支都有判定與逐年', Q && Q.fam.length === S.families.length && Q.fam.every(x => ['ok', 'bad', 'none'].includes(x.verdict) && x.c.yrs.length), Q ? Q.fam.length : 'null');
ok('⑧ 16 年(2010 起)・含已下市・≤ 80 KB', Q && Q.win[0] <= '2011-01-31' && /含已下市/.test(Q.src) && Q.syms >= 2000 && m[0].length <= 80000, Q ? JSON.stringify([Q.win, Q.syms, m[0].length]) : '');
ok('pageerror 0', !errs.length, errs.slice(0, 3).join(' | '));
if (fails.length) { console.log(`❌ QLAB_UI_FAIL(${fails.length})`); process.exit(1); }
console.log('✅ QLAB_UI_TEST_PASS');
