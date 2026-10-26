#!/usr/bin/env node
/**
 * 🧪 V79.9.0 產業作戰室「📐 量化實驗室 › 🧪 沙盒」(瀏覽器、近 3 年、⛔ 不是結論)
 *   ① 進得去:qlMode('box') → 固定橫幅寫「不是結論」;範本 == PRO.QLAB 每一支(用到月營收的那支⛔ 能選)
 *   ② `_qlbCompute` 決定性對照:合成 20 檔,其中一檔埋 6 次「跳空 3.5% 收紅」→ 跳空開高範本抓到 6 筆;同幾天改跳空 2.5% → 0 筆
 *      一筆手算:固定 10 天 → (第 o 天收盤 ÷ 第 e 天收盤 − 1) − 同一天這一池的等權平均 − 0.44% == 畫面那一筆
 *      隔天收在漲停 → 不買、記一次「收在漲停」;吊燈出場 == EXSIM.simExits(同一份公式)
 *   ③ 端到端(假資料走 fetchJson):▶ 跑跑看 → 結果那一塊⛔ ✅🏆★、⛔ 紅綠(灰字);16 年最接近的那一行有;試過幾種:新設定 +1、同一種不加
 *   ④ 改條件:換範本 → 條件 == 那一支的中心參數;改數字 / 加一條 → 白話跟著變;📤 送 16 年驗證 → 複製的字有條件 JSON
 *   ⑤ 股票池:成交額前 N 檔(⛔ ETF)+ 你的庫存 / 自選
 *   ⑥ 390px:整頁不橫捲、表單右邊界在畫面內
 *   注入:INJECT=nocost(成本拿掉 → ② 手算那筆對不上)/ INJECT=color(結果數字上紅綠 → ③ 紅)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let SRC = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');
const ORIG = SRC, INJ = process.env.INJECT || '';
if (INJ === 'nocost') SRC = SRC.replace("const iso = x => String(x || '').replace(/\\//g, '-').slice(0, 10), COST = 0.44;", "const iso = x => String(x || '').replace(/\\//g, '-').slice(0, 10), COST = 0;");
if (INJ === 'color') SRC = SRC.replace("  _qlbN(x, d = 2) {", "  _qlbN(x, d = 2) { return this._qlPct(x, d); },\n  _qlbN0(x, d = 2) {");
if (INJ && SRC === ORIG) { console.log('❌ 注入沒有注進去'); process.exit(1); }
const TMP = path.join(ROOT, '.test_qlab_box.html'); fs.writeFileSync(TMP, SRC);
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
    await p.waitForFunction(() => typeof PRO !== 'undefined' && PRO.QLAB && typeof PRO._qlbCompute === 'function' && typeof EXSIM !== 'undefined', null, { timeout: 60000 });
    R = await p.evaluate(async () => {
        const o = {};
        // ── 合成資料:20 檔、2023-06 起 400 個交易日,平常每天 ±0.4% 輪流(固定),第 0 檔在第 60 + 50k 天跳空 3.5% 收紅、之後 10 天每天 +0.5%
        const D = []; let t = Date.UTC(2023, 5, 1); while (D.length < 400) { const d = new Date(t); if (d.getUTCDay() % 6) D.push(d.toISOString().slice(0, 10)); t += 864e5; }
        const plant = new Set([60, 110, 160, 210, 260, 310]);
        const mk = (s, g) => { let c = 50 + s; return D.map((d, i) => { const pc = c; let op = pc;
            if (s === 0 && plant.has(i)) { op = +(pc * (1 + g)).toFixed(2); c = +(op * 1.01).toFixed(2); }
            else if (s === 0 && [...plant].some(q => i > q && i <= q + 10)) { c = +(pc * 1.005).toFixed(2); }
            else { c = +(pc * (1 + (((i + s) % 5) - 2) * 0.002)).toFixed(2); }
            return { date: d.replace(/-/g, '/'), open: op, high: Math.max(op, c), low: Math.min(op, c), close: c, volume: 100000 + s }; }); };
        const K35 = new Map(), K25 = new Map(); for (let s = 0; s < 20; s++) { K35.set(String(1101 + s), mk(s, 0.035)); K25.set(String(1101 + s), mk(s, 0.025)); }
        const gap = PRO.QLAB.fam.find(x => x.id === 'gap_up');
        o.hasGap = !!(gap && gap.stc);
        const r35 = PRO._qlbCompute(gap.stc, 'fix10', K35), r25 = PRO._qlbCompute(gap.stc, 'fix10', K25);
        o.n35 = r35.n; o.n25 = r25.n; o.x35 = r35.x;
        // 手算第一筆(第 61 天買、第 71 天賣)
        const b = K35.get('1101'), e = 61, oo = 71;
        let lv = new Map(), L = 1; for (let i = 1; i < D.length; i++) { let s = 0, m = 0; for (const k of K35.values()) { const r = k[i].close / k[i - 1].close; if (r >= 0.67 && r <= 1.5) { s += r - 1; m++; } } L *= 1 + s / m; lv.set(i, L); }
        const hand = (b[oo].close / b[e].close - 1) * 100 - (lv.get(oo) / lv.get(e) - 1) * 100 - 0.44;
        o.hand = hand;
        // 抓 _qlbCompute 第一筆:只留一個埋點重算
        const one = new Map(K35); const b1 = b.map((r, i) => (plant.has(i) && i !== 60) ? { ...r, open: b[i - 1].close } : r); one.set('1101', b1);
        const r1 = PRO._qlbCompute(gap.stc, 'fix10', one); o.oneN = r1.n; o.oneX = r1.x;
        // 隔天收在漲停 → 不買
        const lk = new Map(one), b2 = b1.map((r, i) => i === 61 ? { ...r, close: +(b1[60].close * 1.1).toFixed(2), high: +(b1[60].close * 1.1).toFixed(2) } : r); lk.set('1101', b2);
        const r2 = PRO._qlbCompute(gap.stc, 'fix10', lk); o.lockN = r2.n; o.lockB = r2.blk.lock;
        // 吊燈出場 == EXSIM
        const r3 = PRO._qlbCompute(gap.stc, 'chand2', one);
        const R1 = b1.map(r => ({ o: r.open, h: r.high, l: r.low, c: r.close })), ex = EXSIM.simExits(R1, 61, { rules: ['chand2'], maxD: 20, holdStop: 5, stopFill: 'close' }).chand2;
        o.chandN = r3.n; o.chandDays = r3.days; o.exDays = ex.outIdx - 61;
        // ── ① 進得去
        PRO.navGo('qlab'); PRO.qlMode('box');
        const ban = document.querySelector('[data-qlbban]'); o.ban = ban ? ban.innerText : '';
        const tp = document.querySelector('[data-qlbtpl]'); o.tplN = tp ? [...tp.options].filter(x => x.value).length : 0; o.famN = PRO.QLAB.fam.filter(x => x.stc).length;
        o.revDis = tp ? [...tp.options].filter(x => x.disabled).map(x => x.value) : [];
        // ── ④ 改條件
        PRO.qlbTpl('bias_low'); o.tplSt = JSON.stringify(PRO._qlb.st) === JSON.stringify(PRO.QLAB.fam.find(x => x.id === 'bias_low').stc);
        const d0 = document.querySelector('.qlbdesc').innerText;
        PRO.qlbSet(0, 'b', 'v', -12); const d1 = document.querySelector('.qlbdesc').innerText;
        PRO.qlbAdd(); o.rows = document.querySelectorAll('[data-qlbcond]').length; const d2 = document.querySelector('.qlbdesc').innerText;
        o.descChg = d0 !== d1 && /-12|−12/.test(d1) && d2 !== d1;
        let copied = ''; const cs = PRO._copySync; PRO._copySync = t => { copied = t; return true; }; PRO.qlbSend(); PRO._copySync = cs;
        o.sendOk = /16 年/.test(copied) && /"st":\{"all":\[/.test(copied);
        // ── ⑤ 股票池
        const scr = { cols: ['c', 'amt20', 'etf'], rows: { '0050': [1, 999, 1], '2330': [1, 500, 0], '2317': [1, 300, 0], '2454': [1, 400, 0], '9999': [1, 1, 0] } };
        const pe0 = PRO._cache['data/playbook_edge.json']; PRO._cache['data/playbook_edge.json'] = { picks: [] };
        try { localStorage.setItem('proTerminalInv', JSON.stringify([{ symbol: '9999' }])); localStorage.removeItem('proTerminalFavGroups'); } catch (_) {}
        o.pool = PRO._qlbPool(scr, 2);
        try { localStorage.removeItem('proTerminalInv'); } catch (_) {} PRO._cache['data/playbook_edge.json'] = pe0;
        // ── ③ 端到端(假資料)
        const fj = PRO.fetchJson.bind(PRO);
        const SCR = { cols: ['c', 'amt20', 'etf'], rows: Object.fromEntries([...K35.keys()].map((s, i) => [s, [1, 1000 - i, 0]])) };
        PRO.fetchJson = async (pth) => pth === 'data/screener.json' ? SCR : (/data\/(\d+)\.json/.test(pth) ? K35.get(pth.match(/data\/(\d+)\.json/)[1]) : null);
        try { localStorage.removeItem('qlbTries_v1'); } catch (_) {}
        PRO.qlbTpl('gap_up'); PRO.qlbOpt('pool', 30); await PRO.qlbRun();
        const res = document.querySelector('[data-qlbres]');
        o.resTxt = res ? res.innerText : ''; o.resHtml = res ? res.innerHTML : '';
        o.near = (document.querySelector('[data-qlbnear]') || {}).innerText || '';
        o.tries1 = PRO._qlb.res && PRO._qlb.res.tries;
        await PRO.qlbRun(); o.tries2 = PRO._qlb.res && PRO._qlb.res.tries;
        PRO.qlbOpt('exit', 'fix5'); await PRO.qlbRun(); o.tries3 = PRO._qlb.res && PRO._qlb.res.tries;
        o.triesTxt = (document.querySelector('[data-qlbtries]') || {}).innerText || '';
        // ── ⑥ 390px
        window.scrollTo(80, 0); o.sx = window.scrollX;
        const f = document.querySelector('.qlbform'); o.formR = f ? f.getBoundingClientRect().right : 9999;
        PRO.fetchJson = fj;
        return o;
    });
} finally { await browser.close(); try { fs.unlinkSync(TMP); } catch (_) {} }
ok('pageerror 0', !errs.length, errs.slice(0, 3).join(' | '));
ok('② 跳空開高範本在 PRO.QLAB 裡有中心參數(stc)', R.hasGap);
ok('② 決定性對照:埋 6 次跳空 3.5% 收紅 → 6 筆;同幾天改 2.5% → 0 筆', R.n35 === 6 && R.n25 === 0, JSON.stringify([R.n35, R.n25]));
ok('② 一筆手算 == _qlbCompute(固定 10 天、扣同一天這一池的平均、扣 0.44%)', R.oneN === 1 && Math.abs(R.oneX - R.hand) < 1e-9, JSON.stringify([R.oneN, R.oneX, R.hand]));
ok('② 隔天收在漲停 → 不買、記一次「收在漲停」', R.lockN === 0 && R.lockB === 1, JSON.stringify([R.lockN, R.lockB]));
ok('② 吊燈出場 == EXSIM.simExits(同一份公式)', R.chandN === 1 && R.chandDays === R.exDays, JSON.stringify([R.chandN, R.chandDays, R.exDays]));
ok('① 沙盒橫幅寫「不是結論」+ 近 3 年 + 只有還在交易的', /不是結論/.test(R.ban) && /近 3 年/.test(R.ban) && /還在交易/.test(R.ban), R.ban);
ok('① 範本 == PRO.QLAB 每一支;用到月營收的⛔ 能選', R.tplN === R.famN && R.famN >= 8 && JSON.stringify(R.revDis) === '["rev_hi"]', JSON.stringify([R.tplN, R.famN, R.revDis]));
ok('④ 換範本 → 條件 == 那一支的中心參數', R.tplSt);
ok('④ 改數字 / 加一條 → 白話跟著變', R.descChg && R.rows === 2, JSON.stringify([R.descChg, R.rows]));
ok('④ 📤 送 16 年驗證:複製的字有條件 JSON', R.sendOk);
ok('⑤ 股票池:成交額前 N(⛔ ETF)+ 你的庫存', JSON.stringify(R.pool && R.pool.syms) === '["2330","2454","9999"]' && R.pool.nTop === 2 && R.pool.nMine === 1, JSON.stringify(R.pool));
ok('③ 端到端:結果出來了、⛔ ✅🏆★', /筆/.test(R.resTxt || '') && !/[✅🏆★]/u.test(R.resTxt || ''), String(R.resTxt).slice(0, 200));
ok('③ 結果數字⛔ 紅綠(灰字)', !/qlup|qldn|var\(--up\)|var\(--dn\)/.test(R.resHtml || ''), String(R.resHtml).slice(0, 200));
ok('③ 16 年最接近的那一行:跳空開高走高', /跳空開高走高/.test(R.near || ''), R.near);
ok('③ 試過幾種:同一種不加、新的 +1;畫面寫出純運氣', R.tries1 === 1 && R.tries2 === 1 && R.tries3 === 2 && /純運氣/.test(R.triesTxt), JSON.stringify([R.tries1, R.tries2, R.tries3, R.triesTxt]));
ok('⑥ 390px 不橫捲、表單在畫面內', R.sx <= 2 && R.formR <= 392, JSON.stringify([R.sx, R.formR]));
if (fails.length) { console.log(`❌ QLAB_BOX_FAIL(${fails.length})`); process.exit(1); }
console.log('✅ QLAB_BOX_TEST_PASS');
