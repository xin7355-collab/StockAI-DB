#!/usr/bin/env node
/**
 * 😱 V82.5.5 `portfolio_backtest.mjs` PANIC_SELL(大盤大跌隔天開盤把手上個股全部賣掉,之後照規則再買)守門 —— EXP-20261119-02「恐慌賣的代價」
 *
 * 釘住:
 *   ⓐ 不設時一個字都不變:⛔ 不進 CACHE_KEY;不設兩次逐位相同、summary 沒有 panic、TAKEN_OUT 沒有 pan
 *   ⓑ 順序:每天一開始(⛔ 在「今天到期的先出場」之後 —— 開盤比收盤早);單趟報酬 net 先看 _pan;成交時重設只在設了才做
 *   ⓤ 純函式 panicFill(直接抽出來跑):停牌 → stuck、一價到底鎖跌停 → lock(2015-06 前 7%)、鎖漲停照賣、
 *      賣價 = 開盤、股利只算賣的那天(含)以前除息、配股照倍數(跟 DIV_TRADES 同一條公式)
 *   ⓒ 獨立 oracle(真資料):每一筆恐慌賣的報酬 == 賣的那天開盤 ÷ 買的那天收盤 − 1
 *   ⓓ 獨立 oracle:哪幾筆要賣、哪一天賣 —— 從 ^TWII.json 自己算「前一天收盤跌 ≥ 3%」的日子;
 *      買進之後第一個那種日子 ≤ 照規則賣的那天 → 一定在那天開盤賣;否則 ⛔ 不可以有 pan(⭐ 偷看當天 = INJECT=peek 必紅)
 *   ⓔ 安慰劑:PANIC_SHIFT=0 == 不平移(逐位相同)、SHIFT=37 整段天數一樣、成績不同
 *   ⓕ WARMUPS 一次跑兩個起點 == 各自單獨跑(成績 + 逐筆成交逐位相同;交易物件上的標記沒有跨起點殘留)
 *   ⓗ 帳對得上:最後一天 現金 + 持股市值 − 本金 == summary.cum(⭐ net 沒算 _pan 的話對不上 = INJECT=nopan 必紅)
 *   ⓖ 合成情境(把真資料的一根 K 改掉):那天停牌 → 隔天開盤才賣;那天一價到底鎖跌停 → ⛔ 那天開盤賣(INJECT=nolock 必紅)
 *   ⓩ 空過守門:門檻不是負數 / 整段一天都沒有 / 只設 SHIFT → exit 1
 * INJECT=nolock / peek / nopan / high(賣價改成最高價)各自必紅。
 * ⚠️ 真跑引擎(repo `data/` 抽 25 檔),約 3~5 分鐘。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'scripts', 'portfolio_backtest.mjs');
const INJ = (process.env.INJECT || '').trim();
const INJECTS = {
    nolock: ["    if (lockedBar(d, b.pc, b.o, b.h, b.l) === -1) return { why: 'lock' };\n", ''],
    peek: ['const hit = days.map((_, k) => k >= 2 && twii[k - 2].c > 0 && (twii[k - 1].c / twii[k - 2].c - 1) * 100 <= th);',
           'const hit = days.map((_, k) => k >= 1 && twii[k - 1].c > 0 && (twii[k].c / twii[k - 1].c - 1) * 100 <= th);'],
    nopan: ['const net = t => (t._pan ? t._pan.ret + t._pan.dv : t._rot', 'const net = t => (false ? 0 : t._rot'],
    high: ['    const r = (b.o / x.entry - 1) * 100;\n    const cd = (x._dvEv', '    const r = (b.h / x.entry - 1) * 100;\n    const cd = (x._dvEv'],
};
let FILE = process.env.PB_FILE || SRC, injFile = null;
if (INJ) {
    if (!INJECTS[INJ]) { console.error(`❌ INJECT=${INJ} 不認得(${Object.keys(INJECTS).join(' / ')})`); process.exit(1); }
    const s = fs.readFileSync(SRC, 'utf8'), [a, b] = INJECTS[INJ];
    if (s.split(a).length !== 2) { console.error(`❌ INJECT=${INJ} 注入點找不到(或不只一處)`); process.exit(1); }
    injFile = path.join(ROOT, 'scripts', `_pb_panic_inject_${process.pid}.mjs`);   // ⚠️ 要放在 scripts/ 裡(引擎用相對路徑 import lib)
    fs.writeFileSync(injFile, s.replace(a, b));
    FILE = injFile;
    console.log(`🧪 INJECT=${INJ}`);
}
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 320)}`); if (!c) fails.push(n); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbpanic-'));
const cleanup = () => { try { if (injFile) fs.unlinkSync(injFile); } catch (_) {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} };

try {
    const RAW = fs.readFileSync(FILE, 'utf8');
    const CODE = RAW.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
    // ── ⓐ / ⓑ 靜態 ──
    const ck = (CODE.match(/const CACHE_KEY = JSON\.stringify\(\{[^}]*\}\)/) || [''])[0];
    ok('ⓐs CACHE_KEY ⛔ 沒有 PANIC(只動資金層)', ck && !/PANIC|pnDays|_pan/.test(ck), ck.slice(0, 200));
    const iDay = CODE.indexOf('const d = days[i];\n    \n    if (PANIC_DAYS) {'), iExit = CODE.indexOf('for (const x of live.filter(x => outIdx(x) <= i)) {');
    ok('ⓑs 開盤賣在每天一開始、在「今天到期的先出場」之前(開盤比收盤早)', iDay > 0 && iExit > iDay && iExit - iDay < 2400, `${iDay} ${iExit}`);
    ok('ⓑs2 單趟報酬 net 先看 _pan(恐慌賣掉的那筆用開盤賣價)', /const net = t => \(t\._pan \? t\._pan\.ret \+ t\._pan\.dv : t\._rot/.test(CODE));
    ok('ⓑs3 成交時重設標記只在設了 PANIC_SELL 才做(⛔ 不設時交易物件一個欄位都不多)', /if \(PANIC_DAYS\) \{ t\._pp = 0; t\._pan = null; \}/.test(CODE));
    ok('ⓑs4 每個起點重設計數', /pnDays = 0; pnN = 0; pnLock = 0; pnStuck = 0; pnU = 0;/.test(CODE));

    // ── ⓤ 純函式 panicFill ──
    const m = RAW.match(/function panicFill\(x, b, d\) \{[\s\S]*?\n\}\n/);
    ok('ⓤ0 找得到 panicFill', !!m);
    if (m) {
        const { lockedBar } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib_limit.mjs')).href);
        const pf = new Function('lockedBar', `${m[0]}; return panicFill;`)(lockedBar);
        const X = { entry: 100 };
        ok('ⓤ1 沒有那根 / 開盤價不是正數 → stuck(停牌,隔天再試)', pf(X, null, '2024-08-05').why === 'stuck' && pf(X, { o: 0, h: 0, l: 0, pc: 100 }, '2024-08-05').why === 'stuck');
        const L10 = pf(X, { o: 90, h: 90, l: 90, pc: 100 }, '2024-08-05'), L7 = pf(X, { o: 93, h: 93, l: 93, pc: 100 }, '2012-08-06');
        const N7 = pf(X, { o: 93, h: 93, l: 93, pc: 100 }, '2024-08-05'), U = pf(X, { o: 110, h: 110, l: 110, pc: 100 }, '2024-08-05'), O = pf(X, { o: 90, h: 92, l: 90, pc: 100 }, '2024-08-05');
        ok('ⓤ2 一價到底鎖跌停 → lock(2015-06 起 10%、以前 7%);2024 年只跌 7% 不算鎖死;鎖漲停 / 開在跌停但有成交 → 照賣',
            L10.why === 'lock' && L7.why === 'lock' && !N7.why && !U.why && !O.why && Math.abs(O.r - -10) < 1e-9, JSON.stringify([L10, L7, N7, U, O]));
        const r95 = pf(X, { o: 95, h: 96, l: 94, pc: 97 }, '2024-08-05');
        ok('ⓤ3 賣價 = 開盤(⛔ 最高 / 最低 / 前收)', Math.abs(r95.r - -5) < 1e-9 && Math.abs(r95.dv) < 1e-12, JSON.stringify(r95));
        const D1 = pf({ entry: 100, _dvEv: [['2024-08-01', 2], ['2024-08-09', 3]] }, { o: 95, h: 96, l: 94, pc: 97 }, '2024-08-05');
        const D2 = pf({ entry: 100, _dvEv: [['2024-08-01', 2]], _dvF: [['2024-08-02', 1.1], ['2024-08-20', 1.5]] }, { o: 95, h: 96, l: 94, pc: 97 }, '2024-08-05');
        const D3 = pf({ entry: 100, _dvEv: [['2024-08-05', 2]] }, { o: 95, h: 96, l: 94, pc: 97 }, '2024-08-05');
        ok('ⓤ4 股利只算賣的那天(含)以前除息;配股照倍數(同 DIV_TRADES 公式);除息那天賣照領',
            Math.abs(D1.dv - 2) < 1e-9 && Math.abs(D2.dv - 11.5) < 1e-9 && Math.abs(D3.dv - 2) < 1e-9, JSON.stringify([D1, D2, D3]));
    }

    // ── 執行期 ──
    const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
    if (!fs.existsSync(path.join(DATA, '^TWII.json'))) { ok(`${DATA} 沒有 ^TWII.json → 執行期沒驗到`, false); }
    else {
        const tw = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8')).map(r => ({ d: String(r.date || '').replace(/\//g, '-').slice(0, 10), c: +r.close })).filter(r => r.d && r.c > 0);
        const twD = tw.map(r => r.d);
        // 🧮 oracle:第 k 天開盤要賣 = 第 k−1 天收盤比第 k−2 天跌 ≥ 3%
        const PAN = new Set(); for (let k = 2; k < tw.length; k++) if ((tw[k - 1].c / tw[k - 2].c - 1) * 100 <= -3) PAN.add(tw[k].d);
        const panSorted = [...PAN].sort();
        const firstPanAfter = d => panSorted.find(x => x > d) || null;
        const dayGE = d => twD.find(x => x >= d) || twD[twD.length - 1];
        const WU = 240;
        const base = { ...process.env, DATA_DIR: DATA, LOT: '150000', SELF: 'high+hivolat', RANK_MIN: '75', VOLAT_MIN: '60', EXIT: 'chand2', MAXD: '20', FILTER: '', STOPFILL: 'close', WARMUP: String(WU), TRADES_CACHE: path.join(tmp, 'c.json') };
        for (const k of ['PANIC_SELL', 'PANIC_SHIFT', 'DAYGATE', 'DAYGATE_SHIFT', 'BEAR_MODE', 'BEAR_LAG', 'VOLCAP', 'EQGATE', 'EQGATE_SRC', 'ROTATE', 'COST_X', 'PARK', 'DIV', 'DIV_TRADES', 'EQUITY_OUT', 'TAKEN_OUT', 'WARMUPS', 'YEARRUNS', 'LISTK', 'ALLFIRE', 'SUMMARY_OUT']) delete base[k];
        const run = (tag, extra) => {
            const so = extra.SUMMARY_OUT || path.join(tmp, `s_${tag}.json`);
            const r = spawnSync(process.execPath, ['--max-old-space-size=3000', FILE, '25', '2'], { env: { ...base, ...extra, SUMMARY_OUT: so }, encoding: 'utf8', timeout: 420000, maxBuffer: 64 << 20 });
            let s = null; try { s = JSON.parse(fs.readFileSync(so, 'utf8')); } catch (_) {}
            return { r, s };
        };
        const rd = f => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return ''; } };
        const rj = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
        const A = run('a', { EQUITY_OUT: path.join(tmp, 'eq_a.json'), TAKEN_OUT: path.join(tmp, 't_a.json') }), B = run('b', {});
        ok('🚧 基準跑得起來', A.r.status === 0 && A.s && A.s.n > 5, `status=${A.r.status} ${(A.r.stderr || A.r.stdout || '').slice(-300)}`);
        const tA = rj(path.join(tmp, 't_a.json')) || [];
        ok('ⓐ 不設:兩次逐位相同、summary 沒有 panic、逐筆沒有 pan', A.s && B.s && A.s.cum === B.s.cum && A.s.n === B.s.n && !('panic' in A.s) && tA.length > 0 && !tA.some(t => 'pan' in t), `${A.s?.cum} vs ${B.s?.cum}`);

        const P = run('p', { PANIC_SELL: '-3', EQUITY_OUT: path.join(tmp, 'eq_p.json'), TAKEN_OUT: path.join(tmp, 't_p.json') });
        const tP = rj(path.join(tmp, 't_p.json')) || [];
        const pans = tP.filter(t => t.pan);
        ok('🚧 PANIC_SELL=-3 跑得起來、真的有賣、成績跟不設不同', P.r.status === 0 && P.s && P.s.panic && P.s.panic.n > 0 && P.s.panic.days > 0 && pans.length === P.s.panic.n && P.s.cum !== A.s?.cum,
            `${P.r.status} ${JSON.stringify(P.s?.panic)} pans=${pans.length} ${(P.r.stderr || '').slice(-200)}`);

        // ⓒ 賣價 oracle
        const KC = new Map();
        const kOf = sym => { if (!KC.has(sym)) { let rows = []; try { rows = JSON.parse(fs.readFileSync(path.join(DATA, `${sym}.json`), 'utf8')); } catch (_) {} KC.set(sym, new Map(rows.map(x => [String(x.date || '').replace(/\//g, '-').slice(0, 10), x]))); } return KC.get(sym); };
        const badPx = pans.filter(t => { const k = kOf(t.sym), b = k.get(t.d), s = k.get(t.pan.d); return !(b && s && Math.abs((+s.open / +b.close - 1) * 100 - t.pan.ret) < 1e-3); });
        ok(`ⓒ 每一筆恐慌賣(${pans.length} 筆)的報酬 == 賣的那天開盤 ÷ 買的那天收盤 − 1(獨立重算)`, pans.length > 0 && !badPx.length, JSON.stringify(badPx.slice(0, 2)));

        // ⓓ 哪幾筆、哪一天 oracle(這份測資沒有鎖跌停 / 停牌延後才可以這樣嚴格比;有的話只放行「那天真的鎖死或沒有那根」)
        const lockOr = (sym, d) => { const k = kOf(sym), b = k.get(d); if (!b) return true; const ks = [...k.keys()].sort(), j = ks.indexOf(d), pc = j > 0 ? +k.get(ks[j - 1]).close : 0; return +b.high === +b.low && pc > 0 && (+b.open / pc - 1) <= -0.067; };
        const badSel = [];
        for (const t of tP) {
            const X0 = firstPanAfter(t.d), ex = dayGE(t.outD);
            const want = X0 && X0 <= ex;
            if (!want) { if (t.pan) badSel.push(['不該賣', t.sym, t.d, t.outD, t.pan.d]); continue; }
            if (!t.pan) { badSel.push(['該賣沒賣', t.sym, t.d, t.outD, X0]); continue; }
            if (t.pan.d !== X0 && !lockOr(t.sym, X0)) badSel.push(['日子不對', t.sym, t.d, X0, t.pan.d]);
        }
        ok(`ⓓ 哪幾筆要賣、哪一天賣 == 從 ^TWII.json 自己算的(${tP.length} 筆逐筆比,買進之後第一個「前一天跌 ≥ 3%」的日子 ≤ 照規則賣的那天 → 那天開盤賣)`,
            tP.length > 0 && !badSel.length, JSON.stringify(badSel.slice(0, 3)));

        // ⓗ 帳對得上:最後一天現金 + 持股市值 − 本金 == cum
        const eqP = rj(path.join(tmp, 'eq_p.json')), eqA = rj(path.join(tmp, 'eq_a.json'));
        const lastBal = (eq, s) => { const r = eq && eq.rows && eq.rows[eq.rows.length - 1]; return r && s ? r.cash + r.mv + r.park - (s.cfg && s.cfg.capital || eq.capital) - s.cum : NaN; };
        const gA = lastBal(eqA, A.s), gP = lastBal(eqP, P.s);
        ok('ⓗ 帳對得上:最後一天 現金 + 持股市值 − 本金 == summary.cum(不設 / 設了都要;差 ≤ 5 元四捨五入)', Math.abs(gA) <= 5 && Math.abs(gP) <= 5, `不設差 ${gA} ・設了差 ${gP}`);

        // ⓔ 安慰劑
        const P0 = run('p0', { PANIC_SELL: '-3', PANIC_SHIFT: '0' }), P37 = run('p37', { PANIC_SELL: '-3', PANIC_SHIFT: '37' });
        const allN = o => +((o.r.stdout || '').match(/整段 (\d+)\/\d+ 個交易日開盤/) || [])[1];
        ok('ⓔ 決定性對照:SHIFT=0 == 不平移(逐位相同)', P0.s && P.s && P0.s.cum === P.s.cum && P0.s.n === P.s.n && JSON.stringify({ ...P0.s.panic, shift: 0 }) === JSON.stringify({ ...P.s.panic, shift: 0 }), `${P0.s?.cum} vs ${P.s?.cum}`);
        ok('ⓔ2 SHIFT=37:整段賣的天數一樣多、成績不同', P37.r.status === 0 && P37.s && allN(P37) === allN(P) && allN(P) > 0 && P37.s.panic.shift === 37 && P37.s.cum !== P.s?.cum,
            `${allN(P37)} vs ${allN(P)} cum=${P37.s?.cum} ${(P37.r.stderr || '').slice(-160)}`);

        // ⓕ WARMUPS:兩個起點一次跑 == 各自單獨跑
        const W2 = WU + 40;
        const W = run('w', { PANIC_SELL: '-3', WARMUPS: `${WU},${W2}`, SUMMARY_OUT: path.join(tmp, 'sw_{W}.json'), TAKEN_OUT: path.join(tmp, 'tw_{W}.json') });
        const P2 = run('p2', { PANIC_SELL: '-3', WARMUP: String(W2), TAKEN_OUT: path.join(tmp, 't_p2.json') });
        const w0 = rj(path.join(tmp, `sw_${WU}.json`)), w1 = rj(path.join(tmp, `sw_${W2}.json`));
        const same = (x, y) => x && y && x.cum === y.cum && x.n === y.n && JSON.stringify(x.panic) === JSON.stringify(y.panic);
        ok('ⓕ WARMUPS 兩個起點 == 各自單獨跑(成績 + 恐慌賣計數 + 逐筆成交逐位相同)', W.r.status === 0 && same(w0, P.s) && same(w1, P2.s)
            && rd(path.join(tmp, `tw_${WU}.json`)) === rd(path.join(tmp, 't_p.json')) && rd(path.join(tmp, `tw_${W2}.json`)) === rd(path.join(tmp, 't_p2.json')),
            `${W.r.status} ${w0?.cum}/${P.s?.cum} ${w1?.cum}/${P2.s?.cum} ${JSON.stringify(w1?.panic)} vs ${JSON.stringify(P2.s?.panic)} ${(W.r.stderr || '').slice(-160)}`);

        // ⓖ 合成情境:拿第一筆恐慌賣的那一檔,把它賣的那天那根 K 改掉(其他檔照舊,用符號連結)
        const t0 = pans[0];
        if (t0) {
            const mk = (tag, edit) => {
                const dir = path.join(tmp, `d_${tag}`); fs.mkdirSync(dir);
                for (const f of fs.readdirSync(DATA)) if (f.endsWith('.json') && f !== `${t0.sym}.json`) fs.symlinkSync(path.join(DATA, f), path.join(dir, f));
                const rows = JSON.parse(fs.readFileSync(path.join(DATA, `${t0.sym}.json`), 'utf8'));
                fs.writeFileSync(path.join(dir, `${t0.sym}.json`), JSON.stringify(edit(rows)));
                return dir;
            };
            const dk = r => String(r.date || '').replace(/\//g, '-').slice(0, 10);
            // ① 停牌:那天那根拿掉 → 隔天(那一檔的下一根)開盤才賣
            const dS = mk('stuck', rows => rows.filter(r => dk(r) !== t0.pan.d));
            const S = run('st', { PANIC_SELL: '-3', DATA_DIR: dS, TRADES_CACHE: path.join(tmp, 'c_st.json'), TAKEN_OUT: path.join(tmp, 't_st.json') });
            const tS = (rj(path.join(tmp, 't_st.json')) || []).find(t => t.sym === t0.sym && t.d === t0.d);
            const kS = (JSON.parse(fs.readFileSync(path.join(dS, `${t0.sym}.json`), 'utf8'))).map(dk).sort(), nextS = kS.find(x => x > t0.pan.d);
            ok(`ⓖ 停牌(${t0.sym} ${t0.pan.d} 那根拿掉)→ 那天賣不掉、${nextS} 開盤才賣(stuck ≥ 1)`, S.r.status === 0 && S.s?.panic?.stuck >= 1 && tS && tS.pan && tS.pan.d === nextS,
                `${S.r.status} ${JSON.stringify(S.s?.panic)} ${JSON.stringify(tS?.pan)} ${(S.r.stderr || '').slice(-160)}`);
            // ② 一價到底鎖跌停:那天開高低收 = 前收 × (1 − 限制) → ⛔ 那天開盤賣(不是延到之後開盤賣,就是那天照規則收盤出場)
            const dL = mk('lock', rows => { const R = rows.slice().sort((a, b) => (dk(a) < dk(b) ? -1 : 1)); const j = R.findIndex(r => dk(r) === t0.pan.d); const pc = +R[j - 1].close, v = +(pc * (dk(R[j]) < '2015-06-01' ? 0.93 : 0.9)).toFixed(4); R[j] = { ...R[j], open: v, high: v, low: v, close: v }; return R; });
            const Lk = run('lk', { PANIC_SELL: '-3', DATA_DIR: dL, TRADES_CACHE: path.join(tmp, 'c_lk.json'), TAKEN_OUT: path.join(tmp, 't_lk.json') });
            const tL = (rj(path.join(tmp, 't_lk.json')) || []).find(t => t.sym === t0.sym && t.d === t0.d);
            ok(`ⓖ2 鎖跌停(${t0.sym} ${t0.pan.d} 一價到底)→ ⛔ 那天開盤賣(lock ≥ 1;延到之後再賣,或那天照規則收盤出場)`,
                Lk.r.status === 0 && Lk.s?.panic?.lock >= 1 && tL && !(tL.pan && tL.pan.d === t0.pan.d) && (tL.pan ? tL.pan.d > t0.pan.d : dayGE(tL.outD) === t0.pan.d),
                `${Lk.r.status} ${JSON.stringify(Lk.s?.panic)} ${JSON.stringify(tL && { pan: tL.pan, outD: tL.outD })} ${(Lk.r.stderr || '').slice(-160)}`);
        } else ok('ⓖ 沒有任何一筆恐慌賣 → 合成情境沒驗到', false);

        // ⓩ 空過守門
        const Z1 = run('z1', { PANIC_SELL: '3' }), Z2 = run('z2', { PANIC_SELL: '-99' }), Z3 = run('z3', { PANIC_SHIFT: '5' });
        ok('ⓩ 門檻不是負數 / 整段一天都沒有 / 只設 SHIFT → exit 1(各自說原因)',
            Z1.r.status === 1 && /要是負數/.test(Z1.r.stderr) && Z2.r.status === 1 && /一天都沒有/.test(Z2.r.stderr) && Z3.r.status === 1 && /PANIC_SHIFT 要跟 PANIC_SELL 一起設/.test(Z3.r.stderr),
            `${Z1.r.status} ${Z2.r.status} ${Z3.r.status} ${(Z2.r.stderr || '').slice(-120)}`);
    }
} finally { cleanup(); }
console.log(fails.length ? `\n❌ ${fails.length} 條失敗${INJ ? `(INJECT=${INJ} → 紅才對)` : ''}` : '\n✅ PANICSELL_PASS');
process.exit(fails.length ? 1 : 0);
