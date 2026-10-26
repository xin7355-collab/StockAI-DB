#!/usr/bin/env node
/**
 * 📚 V79.9.1 量化實驗室沙盒「跑過的紀錄」+「🔁 全部交叉跑一次」(使用者 10/26:「按完不會紀錄,按下一個作法資料都不見了」)
 *   ① 跑一次 → 紀錄 +1(條件白話、出場、筆數、每筆多幾 %);換範本 / 改條件 ⛔ 丟掉結果(寫「設定改過了」)、紀錄還在
 *   ② 同一組再跑一次 → 紀錄 +1(每一次都留)
 *   ③ 交叉跑:組數 == 範本 × 出場 + 兩兩一起成立 × 出場(用到月營收的不算);每一組進紀錄、照「每筆多幾 %」排;寫出「純運氣」那句
 *      兩兩那一組的條件 == 兩支的條件接在一起(決定性對照:兩兩那組的筆數 ≤ 各自單獨的筆數)
 *   ④ 按停止 → ⛔ 寫進半套
 *   ⑤ 表頭排序:同一顆再按一次反向
 *   ⑥ 點一列 → 設定載回表單 ・勾兩筆 → 並排看差 ・✕ 刪一筆
 *   ⑦ 紀錄壞掉 → 當成空的、⛔ pageerror;最多 300 筆(刪最舊;一次交叉跑就 112 筆,100 會把上一次的擠掉)
 *   ⑧ 390px 不橫捲
 *   注入:INJECT=nolog(跑完不存)→ ① 紅
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let SRC = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');
const ORIG = SRC, INJ = process.env.INJECT || '';
if (INJ === 'nolog') SRC = SRC.replace('      this._qlbLogAdd(this._qlbLogRow(st, B.exit, B.pool, B.tpl, res));\n', '');
if (INJ && SRC === ORIG) { console.log('❌ 注入沒有注進去'); process.exit(1); }
const TMP = path.join(ROOT, '.test_qlab_log.html'); fs.writeFileSync(TMP, SRC);
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };
let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const errs = []; let R = {};
try {
    const p = await browser.newPage({ viewport: { width: 390, height: 844 } });
    p.on('pageerror', e => errs.push(String(e)));
    await p.goto('file://' + TMP);
    await p.waitForFunction(() => typeof PRO !== 'undefined' && PRO.QLAB && typeof PRO.qlbCross === 'function', null, { timeout: 60000 });
    R = await p.evaluate(async () => {
        const o = {};
        // 合成 20 檔(同 test_qlab_box):第 0 檔埋 6 次跳空 3.5% 收紅
        const D = []; let t = Date.UTC(2023, 5, 1); while (D.length < 400) { const d = new Date(t); if (d.getUTCDay() % 6) D.push(d.toISOString().slice(0, 10)); t += 864e5; }
        const plant = new Set([60, 110, 160, 210, 260, 310]);
        const mk = s => { let c = 50 + s; return D.map((d, i) => { const pc = c; let op = pc;
            if (s === 0 && plant.has(i)) { op = +(pc * 1.035).toFixed(2); c = +(op * 1.01).toFixed(2); }
            else c = +(pc * (1 + (((i + s) % 5) - 2) * 0.002)).toFixed(2);
            return { date: d.replace(/-/g, '/'), open: op, high: Math.max(op, c), low: Math.min(op, c), close: c, volume: 100000 + s }; }); };
        const K = new Map(); for (let s = 0; s < 20; s++) K.set(String(1101 + s), mk(s));
        const SCR = { cols: ['c', 'amt20', 'etf'], rows: Object.fromEntries([...K.keys()].map((s, i) => [s, [1, 1000 - i, 0]])) };
        const fj = PRO.fetchJson.bind(PRO);
        PRO.fetchJson = async pth => pth === 'data/screener.json' ? SCR : (/data\/(\d+)\.json/.test(pth) ? K.get(pth.match(/data\/(\d+)\.json/)[1]) : null);
        try { localStorage.removeItem('qlbLog_v1'); localStorage.removeItem('qlbTries_v1'); localStorage.removeItem('proTerminalInv'); } catch (_) {}
        PRO.navGo('qlab'); PRO.qlMode('box');
        const n = () => PRO._qlbLogLoad().length;
        // ① 跑一次 → +1;換範本 → 結果還在、寫「改過了」、紀錄還在
        PRO.qlbTpl('gap_up'); PRO.qlbOpt('pool', 30); await PRO.qlbRun();
        o.n1 = n(); o.row1 = PRO._qlbLogLoad()[0] || {};
        PRO.qlbTpl('bias_low');
        o.resKept = !!document.querySelector('[data-qlbres]'); o.stale = !!document.querySelector('[data-qlbstale]'); o.n1b = n();
        o.logTxt = (document.querySelector('[data-qlblog]') || {}).innerText || '';
        // ② 同一組再跑 → +1
        PRO.qlbTpl('gap_up'); await PRO.qlbRun(); o.n2 = n();
        // ④ 停止 → ⛔ 寫進半套
        const pr = PRO.qlbCross(); PRO._qlb.stop = true; await pr; o.nStop = n(); o.stopErr = PRO._qlb.err;
        // ③ 交叉跑
        const L = PRO._qlbCrossList(), F = PRO.QLAB.fam.filter(x => x.stc && !QCORE.needs(x.stc).includes('rev')), E = Object.keys(PRO._QLB_EXITS).length;
        o.crossN = L.length; o.crossWant = F.length * E + F.length * (F.length - 1) / 2 * E;
        await PRO.qlbCross(); o.n3 = n(); o.cross = PRO._qlb.cross;
        o.crossTxt = (document.querySelector('[data-qlbcross]') || {}).innerText || '';
        const rows = PRO._qlbLogLoad(), b = rows.filter(r => r.batch === (PRO._qlb.cross || {}).batch);
        const gapS = b.find(r => r.tpl === 'gap_up' && r.exit === 'fix10'), pair = b.find(r => /跳空開高走高/.test(r.desc) && r.tpl === '' && r.exit === 'fix10' && /均線剛排成多頭|月線/.test(r.desc));
        const pg = b.find(r => r.tpl === '' && r.exit === 'fix10' && r.st.all.length === F.find(f => f.id === 'gap_up').stc.all.length + F.find(f => f.id === 'kd_gold').stc.all.length && JSON.stringify(r.st.all).includes('"gap"') && JSON.stringify(r.st.all).includes('"k"'));
        o.pairOk = !!(pg && gapS && pg.n <= gapS.n);
        o.pairSt = pg ? JSON.stringify(pg.st.all) === JSON.stringify([...F.find(f => f.id === 'kd_gold').stc.all, ...F.find(f => f.id === 'gap_up').stc.all]) || JSON.stringify(pg.st.all) === JSON.stringify([...F.find(f => f.id === 'gap_up').stc.all, ...F.find(f => f.id === 'kd_gold').stc.all]) : false;
        const dom = () => [...document.querySelectorAll('[data-qlblrow]')].map(tr => tr.getAttribute('data-qlblrow'));
        const xs = () => dom().map(id => (PRO._qlbLogLoad().find(r => r.id === id) || {}).x).filter(v => v != null);
        const a1 = xs(); o.sortDesc = a1.every((v, i) => i === 0 || a1[i - 1] >= v);
        // ⑤ 同一顆再按 → 反向
        PRO.qlbLogSort('x'); const a2 = xs(); o.sortAsc = a2.every((v, i) => i === 0 || a2[i - 1] <= v) && a2.length === a1.length;
        o.thOn = !!document.querySelector('[data-qlblsort="x"].on');
        // ⑥ 載回 / 並排 / 刪
        const r0 = PRO._qlbLogLoad().find(r => r.tpl === 'bias_low' && r.exit === 'fix20');
        PRO.qlbLogLoad(r0.id); o.loaded = JSON.stringify(PRO._qlb.st) === JSON.stringify(r0.st) && PRO._qlb.exit === 'fix20';
        const ids = PRO._qlbLogLoad().slice(-2).map(r => r.id); PRO.qlbLogCmp(ids[0]); PRO.qlbLogCmp(ids[1]);
        o.diff = (document.querySelector('[data-qlbdiff]') || {}).innerText || '';
        const before = n(); PRO.qlbLogDel(ids[0]); o.del = n() === before - 1 && !PRO._qlbLogLoad().some(r => r.id === ids[0]);
        // ⑧ 390px
        window.scrollTo(80, 0); o.sx = window.scrollX;
        // ⑦ 壞掉 → 空的;上限 100
        localStorage.setItem('qlbLog_v1', '[{"id":"a","st":{'); o.bad = PRO._qlbLogLoad().length; PRO.renderQlab(); o.badTxt = (document.querySelector('[data-qlblog]') || {}).innerText || '';
        localStorage.removeItem('qlbLog_v1'); for (let i = 0; i < 320; i++) PRO._qlbLogAdd({ id: 'z' + i, ts: i, st: { all: [] }, desc: 'd' + i, x: i });
        const capped = PRO._qlbLogLoad(); o.cap = capped.length; o.capOldest = capped[0] && capped[0].id;
        PRO.fetchJson = fj;
        return o;
    });
} finally { await browser.close(); try { fs.unlinkSync(TMP); } catch (_) {} }
ok('pageerror 0', !errs.length, errs.slice(0, 3).join(' | '));
ok('① 跑一次 → 紀錄 +1(有條件白話、出場、筆數、每筆多幾 %)', R.n1 === 1 && /跳空/.test(R.row1.desc || '') && R.row1.exit && R.row1.n === 6 && Number.isFinite(R.row1.x), JSON.stringify([R.n1, R.row1]));
ok('① 換範本 → 結果還在、寫「設定改過了」、紀錄還在', R.resKept && R.stale && R.n1b === 1 && /跑過的紀錄/.test(R.logTxt), JSON.stringify([R.resKept, R.stale, R.n1b]));
ok('② 同一組再跑一次 → 紀錄 +1(每一次都留)', R.n2 === 2, R.n2);
ok('④ 按停止 → ⛔ 寫進半套、寫「已停止」', R.nStop === 2 && /停止/.test(R.stopErr || ''), JSON.stringify([R.nStop, R.stopErr]));
ok('③ 交叉跑組數 == 範本 × 出場 + 兩兩 × 出場(⛔ 月營收)', R.crossN === R.crossWant && R.crossN >= 100, JSON.stringify([R.crossN, R.crossWant]));
ok('③ 每一組都進紀錄、畫面寫「純運氣」', R.n3 === 2 + R.crossN && R.cross && R.cross.n === R.crossN && /純運氣/.test(R.crossTxt), JSON.stringify([R.n3, R.cross]));
ok('③ 兩兩那一組 = 兩支條件接在一起、筆數 ≤ 單獨那支(決定性對照)', R.pairSt && R.pairOk, JSON.stringify([R.pairSt, R.pairOk]));
ok('③ 交叉跑完照「每筆多幾 %」由高到低', R.sortDesc);
ok('⑤ 同一顆表頭再按一次 → 反向、表頭標著', R.sortAsc && R.thOn);
ok('⑥ 點一列 → 設定載回表單', R.loaded);
ok('⑥ 勾兩筆 → 並排看差', /並排看/.test(R.diff) && /差/.test(R.diff), R.diff);
ok('⑥ ✕ 刪一筆', R.del);
ok('⑦ 紀錄壞掉 → 當成空的、畫面照常', R.bad === 0 && /還沒有/.test(R.badTxt), JSON.stringify([R.bad, R.badTxt]));
ok('⑦ 最多 300 筆(刪最舊;一次交叉跑就 112 筆)', R.cap === 300 && R.capOldest === 'z20', JSON.stringify([R.cap, R.capOldest]));
ok('⑧ 390px 不橫捲', R.sx <= 2, R.sx);
if (fails.length) { console.log(`❌ QLAB_LOG_FAIL(${fails.length})`); process.exit(1); }
console.log('✅ QLAB_LOG_TEST_PASS');
