#!/usr/bin/env node
/**
 * 📊 V81.0.0 散戶 App「🔓 進階功能 › 📊 這套策略每年賺多少」守門
 *   使用者 11/03:「散戶 App 要放的地方是在進階設定裡面…告訴我這個策略的報酬率,我是要每年的報酬率」
 *   ① 跨檔:index `_STRAT_YEARLY` 每一列的 16 年合計 / 中途最多賠 / 勝率・每筆平均・筆數 == pro `_PROFIT_BOARD` 16 年那一列;
 *      每一年(報酬 / 筆數 / 有賺 / 最多賠 / 0050 含息)== pro `_YEARLY_BT` 那一格(每年 1 月重新放 100 萬)—— ⛔ 抄錯就紅
 *   ② 年份連續(起點年 ~ 截止年)、每一格都有數字;四套對到逐年表的 id(🅿️ now949 / 📈 now949c / 👑 lead / 💵 lead_cash)
 *   ③ 沒解鎖:設定裡⛔ 沒有 [data-stratperf]、畫面⛔ 沒有「這套策略每年賺多少」
 *   ④ 解鎖:每一年一列、預設是你現在用的那一套、那一列標「你現在用的」、數字 == `_STRAT_YEARLY`
 *   ⑤ 切到別套 → 數字跟著變;⑥ 表頭排序(同一欄再點一次反向)
 *   ⑦ 決定性對照:改 `_STRAT_YEARLY` 一格 → 畫面跟著變(⛔ 寫死)
 *   ⑧ 390px 不橫捲;⑨ 關掉 perf → 整塊不見;⛔ 🔴🟢
 * 注入:INJECT=copy(抄錯一個數字)/ INJECT=gate(沒解鎖也畫)必紅
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIG = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const INJ = process.env.INJECT || '';
let SRC = ORIG;
if (INJ === 'copy') SRC = SRC.replace(/("k":"park"[^}]*?"y":\{[^}]*?"2015":\[)(-?[\d.]+)/, (_, a, b) => a + (+b + 5));
if (INJ === 'gate') SRC = SRC.replace("+ (s.stratUnlock ? this._advBoxHtml(leadHtml) : '');", "+ this._advBoxHtml(leadHtml);").replace('(c.unlock && !unl)', '(false)');
if (INJ && SRC === ORIG) { console.log('❌ 注入沒有注進去'); process.exit(1); }
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };

// ① ② 靜態
const m = SRC.match(/^    _STRAT_YEARLY: (.*),$/m);
ok('⓪ index.html 有 _STRAT_YEARLY(一行)', !!m);
const SY = m ? JSON.parse(m[1]) : null;
const pm = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8').match(/^  _PROFIT_BOARD: (.*),$/m);
const PB = pm ? JSON.parse(pm[1]) : null;
if (SY && PB) {
    const L = PB.wins.long, g = k => L.rows.find(r => r.k === k);
    const map = { park: 'park', gene: 'hot', leadpark: 'lead', lead: 'leadcash' };
    ok('①a 四套都在(🅿️ / 📈 / 👑 停 0050 / 👑 現金)', ['park', 'gene', 'leadpark', 'lead'].every(k => SY.rows.some(r => r.k === k && r.bk === map[k])), SY.rows.map(r => r.k + ':' + r.bk).join(','));
    const bad = [];
    for (const r of SY.rows) { const b = g(r.bk); if (!b) { bad.push(r.k + ' 看板沒有'); continue; }
        for (const f of ['fin', 'mdd', 'tWin', 'tPer', 'tN']) if (r[f] !== b[f]) bad.push(`${r.k}.${f} ${r[f]} ≠ 看板 ${b[f]}`); }
    if (SY.e50.fin !== g('0050').fin || SY.e50.mdd !== g('0050').mdd) bad.push('0050 fin / mdd 對不上');
    if (SY.from !== L.from || SY.to !== PB.to || SY.paths !== PB.paths) bad.push(`起訖 / 條數 ${SY.from}~${SY.to}/${SY.paths} vs ${L.from}~${PB.to}/${PB.paths}`);
    ok('①b 16 年合計 / 中途最多賠 / 有賺比例 / 每筆平均 / 筆數 == pro 看板(逐字抄)', !bad.length, bad.join(' ・'));
    const ym = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8').match(/^  _YEARLY_BT: (.*),$/m), YB = ym ? JSON.parse(ym[1]) : null;
    const idMap = { park: 'now949', gene: 'now949c', leadpark: 'lead', lead: 'lead_cash' };
    ok('①c 四套對到逐年表 id', SY.rows.every(r => r.yid === idMap[r.k]), SY.rows.map(r => r.k + ':' + r.yid).join(','));
    const bad2 = [];
    if (!YB) bad2.push('pro.html 沒有 _YEARLY_BT');
    else for (const r of SY.rows) {
        const st = YB.strats.find(x => x.id === r.yid); if (!st) { bad2.push(r.yid + ' 逐年表沒有'); continue; }
        const c = (y, f) => st.y[y] ? st.y[y][YB.cols.indexOf(f)] : undefined;
        for (const y of SY.years) {
            const want = [c(y, 'ret'), c(y, 'n'), c(y, 'win'), c(y, 'dd')];
            if (JSON.stringify(r.y[y]) !== JSON.stringify(want)) bad2.push(`${r.k} ${y} ${JSON.stringify(r.y[y])} ≠ ${JSON.stringify(want)}`);
            if (r.e[y] !== (st.yb[y] || {}).e0050tr) bad2.push(`${r.k} ${y} 0050 ${r.e[y]} ≠ ${(st.yb[y] || {}).e0050tr}`);
        }
    }
    ok('①d 每一年(報酬 / 筆數 / 有賺 / 最多賠 / 0050 含息)== pro 逐年表那一格(每年 1 月重新放 100 萬)', !bad2.length, bad2.slice(0, 4).join(' ・'));
    const y0 = +SY.from.slice(0, 4), y1 = +SY.to.slice(0, 4);
    const yrsOk = SY.years.length === y1 - y0 + 1 && SY.years.every((y, i) => +y === y0 + i);
    const cellsOk = SY.rows.every(r => SY.years.every(y => Array.isArray(r.y[y]) && r.y[y].every(Number.isFinite) && Number.isFinite(r.e[y])));
    ok('②a 年份連續、每一格都有數字(含 0050)', yrsOk && cellsOk, SY.years.join(','));
}

const TMP = path.join(ROOT, '.test_stratperf.html');
fs.writeFileSync(TMP, SRC);
let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const errs = [];
const open = async (unlock, strat) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    page.on('pageerror', e => errs.push(e.message));
    await page.addInitScript(([u, st]) => { try { const s = JSON.parse(localStorage.getItem('proTerminalSettings') || '{}'); s.stratUnlock = u; s.strategy = st; localStorage.setItem('proTerminalSettings', JSON.stringify(s)); } catch (_) {} }, [unlock, strat]);
    await page.goto('file://' + TMP, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof app !== 'undefined' && typeof app._renderStratBox === 'function', null, { timeout: 60000 });
    return page;
};
const read = page => page.evaluate(() => {
    app._renderStratBox();
    const b = document.querySelector('#stratBox [data-stratperf]');
    if (!b) return { has: false, txt: (document.getElementById('stratBox') || {}).innerText || '' };
    return { has: true, txt: b.innerText, yrs: [...b.querySelectorAll('[data-perfyr]')].map(e => ({ y: e.dataset.perfyr, t: e.innerText.replace(/\s+/g, ' ').trim() })),
        cur: [...b.querySelectorAll('[data-perfpick]')].filter(e => /你現在用的/.test(e.innerText)).map(e => e.dataset.perfpick),
        sum: (b.querySelector('[data-perfsum]') || {}).innerText || '', key: app._stratKey(), sel: (app._perfSel || null) };
});
try {
    // ③ 沒解鎖
    { const p = await open(false, 'park'); await p.waitForTimeout(800); const r = await read(p);
      ok('③ 沒解鎖:設定裡沒有 📊 那一塊、⛔ 一個字都沒有', !r.has && !/這套策略每年賺多少/.test(r.txt), r.txt.slice(0, 200)); await p.close(); }
    // ④~⑨ 解鎖、選 🅿️
    const p = await open(true, 'park'); await p.waitForTimeout(800);
    const r = await read(p);
    ok('④a 解鎖:📊 那一塊出現', r.has, r.txt && r.txt.slice(0, 200));
    if (r.has && SY) {
        ok('④b 每一年一列、照年份由舊到新', r.yrs.length === SY.years.length && r.yrs.map(x => x.y).join() === SY.years.join(), r.yrs.map(x => x.y).join());
        ok('④c 預設 = 你現在用的那一套(🅿️),那一顆標「你現在用的」', r.key === 'park' && r.cur.join() === 'park', JSON.stringify({ key: r.key, cur: r.cur }));
        const park = SY.rows.find(x => x.k === 'park'), pc = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + '%';
        const y15 = r.yrs.find(x => x.y === '2015');
        const c15 = park.y['2015'];
        ok('④d 數字 == _STRAT_YEARLY(2015 那一列:這一套 / 0050 含息 / 筆數 / 有賺 / 最多賠)', y15 && y15.t.includes(pc(c15[0])) && y15.t.includes(pc(park.e['2015'])) && y15.t.includes(c15[1] + ' 筆') && y15.t.includes(Math.round(c15[2]) + '%') && y15.t.includes(pc(c15[3])), y15 && y15.t);
        ok('④f 註腳講清楚口徑:每年 1 月重新放 100 萬 / 16 年合計是一路滾', /1 月重新放 100 萬/.test(r.txt) && /一路滾/.test(r.txt), '');
        ok('④e 摘要:16 年 100 萬變多少 == 看板', r.sum.includes(Math.round(park.fin / 1e4).toLocaleString() + ' 萬'), r.sum.slice(0, 160));
        // ⑤ 切到 👑 停 0050
        const r5 = await p.evaluate(() => { app._stratPerfPick('leadpark'); const b = document.querySelector('#stratBox [data-stratperf]'); return { sum: b.querySelector('[data-perfsum]').innerText, y: [...b.querySelectorAll('[data-perfyr]')].find(e => e.dataset.perfyr === '2017').innerText.replace(/\s+/g, ' ') }; });
        const lp = SY.rows.find(x => x.k === 'leadpark');
        ok('⑤ 切到別套 → 數字跟著變(👑 2017)', r5.y.includes(pc(lp.y['2017'][0])) && r5.sum.includes(Math.round(lp.fin / 1e4).toLocaleString() + ' 萬'), r5.y + ' | ' + r5.sum.slice(0, 120));
        // ⑥ 排序
        const r6 = await p.evaluate(() => { app._stratPerfSort('s'); const a = [...document.querySelectorAll('#stratBox [data-perfyr]')].map(e => e.dataset.perfyr); app._stratPerfSort('s'); const b = [...document.querySelectorAll('#stratBox [data-perfyr]')].map(e => e.dataset.perfyr); const on = document.querySelector('#stratBox [data-perfsort="s"]').innerText; return { a, b, on }; });
        const ys = SY.years.slice().sort((x, z) => lp.y[z][0] - lp.y[x][0]);
        ok('⑥a 點「這一套」→ 由高到低', r6.a.join() === ys.join(), r6.a.join());
        ok('⑥b 同一欄再點一次 → 反過來、表頭有箭頭', r6.b.join() === ys.slice().reverse().join() && /[▲▼]/.test(r6.on), r6.b.join() + ' ' + r6.on);
        // ⑦ 決定性對照
        const r7 = await p.evaluate(() => { app._perfSort = null; app._STRAT_YEARLY.rows.find(x => x.k === 'leadpark').y['2015'] = [123.4, 7, 50, -9.9]; app._renderStratBox(); return [...document.querySelectorAll('#stratBox [data-perfyr]')].find(e => e.dataset.perfyr === '2015').innerText; });
        ok('⑦ 改 _STRAT_YEARLY 一格 → 畫面跟著變(⛔ 寫死)', /\+123\.4%/.test(r7), r7);
        // ⑧ 390px
        const r8 = await p.evaluate(() => { const m = document.getElementById('settingsModal'); if (m) { m.classList.remove('hidden'); m.style.display = 'flex'; } window.scrollTo(80, 0); const b = document.querySelector('#stratBox [data-stratperf]'); return { sx: window.scrollX, over: b ? b.scrollWidth - b.clientWidth : -1 }; });
        ok('⑧ 390px 不橫捲', r8.sx <= 2 && r8.over <= 2, JSON.stringify(r8));
        // ⑨ 關掉 + ⛔ 🔴🟢
        const r9 = await p.evaluate(() => { const t = document.querySelector('#stratBox [data-stratperf]').innerText; app.toggleDeckShow('perf', false); app._renderStratBox(); return { t, gone: !document.querySelector('#stratBox [data-stratperf]') }; });
        ok('⑨a 畫面 ⛔ 🔴🟢(好壞用 ✅ / ➖)', !/[🔴🟢]/u.test(r9.t), '');
        ok('⑨b 關掉 📊 → 整塊不見', r9.gone, '');
    }
    await p.close();
} finally { await browser.close(); fs.unlinkSync(TMP); }
ok('⑩ 沒有 pageerror', !errs.length, errs.slice(0, 3).join(' | '));
console.log(fails.length ? `\n❌ ${fails.length} 條沒過` : '\n✅ test_stratperf 全過');
process.exit(fails.length ? 1 : 0);
