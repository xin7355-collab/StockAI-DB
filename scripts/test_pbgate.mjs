#!/usr/bin/env node
/**
 * 🎯🧱 V79.4.7 `portfolio_backtest.mjs` 兩個新開關守門:GATE=lb(= App 的 🔥 選股規則)與 CLIFF(價格斷崖)
 *
 * 為什麼:全市場第一條 🔥 近 4 年只賺 34 萬・中途最多賠 71%,查出兩件事 ——
 *   ① 引擎一直用舊規則(這檔這招 ≥4 次、照平均排),App 的 playbook_scan 從 V72.9.2 起是
 *      「≥8 次、照保守下界 平均 − 1.28×標準差/√n 排、一檔最多 2 招」(陷阱 #37:規則只改了一邊);
 *      抽 600 檔時看不太出來,全市場時前段班被「樣本少但剛好很賺」佔滿。
 *   ② 5314 / 6949 1 拆 20 沒還原 → 回測當成 −92%(資料問題)。
 *
 * 釘住:
 *   ⓢ 靜態:四個都⛔ 不進 CACHE_KEY;預設值跟 playbook_scan 一樣(MIN_N 8 / 1.28 / 前 2 招);公式只在 lib_lb.mjs;
 *          STATS_WIN 扣回時平方和也扣;斷崖剔除在股利與 byIn 之前
 *   ⓛ lib_lb 跟 App 的公式逐筆比(playbook_scan 的 lb + index.html _patternFitBacktest 的 sd,從原始碼抽出來跑)
 *   ⓐ 決定性對照:GATE=lb LB_Z=0 MIN_N=4 LB_TOP=99 == 不設(成績 + 逐日淨值逐位相同)
 *   ⓑ GATE=lb 預設值真的生效、cfg 記下
 *   ⓒ 一檔前 1 招:每一筆成交的招 = 那天這檔下界第 1 名(用快取逐筆重算);決定性對照:不限招數時至少一筆不是第 1 名
 *   ⓓ CLIFF:注入 1 拆 20 → 不設時有 −90% 的假虧損;CLIFF=0 剔除筆數 == 用 lib_cliff 逐筆算的數、成交裡沒有跨過斷崖的
 *   ⓔ 設錯格式 → exit 1
 * ⚠️ 真跑引擎(repo data/ 少數幾檔 + 一份注入過的暫存資料夾),約 2~3 分鐘。
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { lbOf } from './lib_lb.mjs';
import { cliffPrefix, cliffIn } from './lib_cliff.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = process.env.PB_FILE || path.join(ROOT, 'scripts', 'portfolio_backtest.mjs');
const strip = t => t.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
const CODE = strip(fs.readFileSync(FILE, 'utf8'));
const SCAN = strip(fs.readFileSync(path.join(ROOT, 'scripts', 'playbook_scan.mjs'), 'utf8'));
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };

// ── ⓢ 靜態 ──
const ck = (CODE.match(/const CACHE_KEY = JSON\.stringify\(\{[^}]*\}\)/) || [''])[0];
ok('ⓢ1 CACHE_KEY ⛔ 沒有 GATE / LB_Z / LB_TOP / CLIFF', ck && !/GATE|LB_Z|LB_TOP|CLIFF/.test(ck), ck);
const scanMinN = +((SCAN.match(/const MIN_N = \+\(process\.env\.MIN_N \|\| (\d+)\)/) || [])[1]);
const scanZ = +((SCAN.match(/const lb = x => x\.expectancy - ([\d.]+) \* \(x\.sd \|\| 0\) \/ Math\.sqrt\(Math\.max\(1, x\.count\)\);/) || [])[1]);
const scanTop = +((SCAN.match(/for \(const g of good\.slice\(0, (\d+)\)\)/) || [])[1]);
const pbMinN = +((CODE.match(/const MIN_N = \+\(process\.env\.MIN_N \|\| \(process\.env\.GATE === 'lb' \? (\d+) : 4\)\);/) || [])[1]);
const pbZ = +((CODE.match(/const LB_Z = process\.env\.GATE === 'lb' \? \+\(process\.env\.LB_Z \?\? ([\d.]+)\) : 0;/) || [])[1]);
const pbTop = +((CODE.match(/const LB_TOP = process\.env\.GATE === 'lb' \? \+\(process\.env\.LB_TOP \|\| (\d+)\) : 0;/) || [])[1]);
ok(`ⓢ2 預設值跟 App 一樣(playbook_scan MIN_N ${scanMinN} / z ${scanZ} / 前 ${scanTop} 招 ↔ 引擎 ${pbMinN} / ${pbZ} / ${pbTop})`, scanMinN > 0 && scanZ > 0 && scanTop > 0 && scanMinN === pbMinN && scanZ === pbZ && scanTop === pbTop);
ok('ⓢ3 下界公式只在 lib_lb.mjs(引擎兩處都呼叫 lbOf、⛔ 自己沒有 n − 1 的變異數)', /lbOf\(s2\.n, s2\.sum, s2\.sq, LB_Z\)/.test(CODE) && /lbOf\(s\.n, s\.sum, s\.sq, LB_Z\)/.test(CODE) && !/\(n - 1\)/.test(CODE));
ok('ⓢ4 STATS_WIN 扣回時平方和也扣(⛔ 只扣總和 → 標準差越算越歪)', /s\.sq = s\.n \? s\.sq - b\[q \+ 2\] \* b\[q \+ 2\] : 0;/.test(CODE) && /s\.n\+\+; s\.sum \+= t\.ret; s\.sq \+= t\.ret \* t\.ret;/.test(CODE));
ok('ⓢ5 斷崖剔除在算股利與 byIn 之前(⛔ 剔完還進每檔成績)', (() => { const a = CODE.indexOf('cliffIn(X.pre, a - CLIFF, b)'), b = CODE.indexOf('const DIV_TRADES = '), c = CODE.indexOf('const byIn = new Map()'); return a > 0 && b > a && c > a; })());
ok('ⓢ6 兩種門檻共用同一份其餘濾網 restOk(⛔ 各寫一份)', (CODE.match(/restOk\(x\)/g) || []).length === 2 && /const restOk = x => x\.m && x\.m\.n >= MIN_MKT_N/.test(CODE));

// ── ⓛ lib_lb 跟 App 的公式比 ──
{
    const sdSrc = (HTML.match(/const sd = n > 1 \? Math\.sqrt\(trades\.reduce\(\(a, b\) => a \+ \(b - mean\) \*\* 2, 0\) \/ \(n - 1\)\) : 0;/) || [])[0];
    const lbSrc = (SCAN.match(/const lb = x => x\.expectancy - [\d.]+ \* \(x\.sd \|\| 0\) \/ Math\.sqrt\(Math\.max\(1, x\.count\)\);/) || [])[0];
    ok('ⓛ0 從 index.html / playbook_scan.mjs 抽得到 App 的 sd 與 lb 原文', !!sdSrc && !!lbSrc);
    if (sdSrc && lbSrc) {
        const appSd = new Function('trades', 'n', 'mean', sdSrc + '\nreturn sd;');
        const appLb = new Function('x', lbSrc + '\nreturn lb(x);');
        let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
        let maxErr = 0, cases = 0, inc = 0;
        for (let k = 0; k < 400; k++) {
            const n = 1 + (k % 40); const tr = Array.from({ length: n }, () => (rnd() - 0.45) * 30);
            const mean = tr.reduce((a, b) => a + b, 0) / n, sd = appSd(tr, n, mean);
            const want = appLb({ expectancy: mean, sd, count: n });
            const sum = tr.reduce((a, b) => a + b, 0), sq = tr.reduce((a, b) => a + b * b, 0);
            maxErr = Math.max(maxErr, Math.abs(lbOf(n, sum, sq, scanZ) - want)); cases++;
            // 加進來又扣回去(STATS_WIN 的路徑)也要一樣
            const extra = Array.from({ length: 5 }, () => (rnd() - 0.5) * 40);
            let s2 = sum, q2 = sq; for (const e of extra) { s2 += e; q2 += e * e; } for (const e of extra) { s2 -= e; q2 -= e * e; }
            maxErr = Math.max(maxErr, Math.abs(lbOf(n, s2, q2, scanZ) - want)); inc++;
        }
        ok(`ⓛ1 lib_lb == App(${cases} 組 + ${inc} 組先加後扣,最大誤差 ${maxErr.toExponential(1)})`, maxErr < 1e-8, maxErr);
        ok('ⓛ2 z = 0 → 回傳 sum / n 本身(⛔ 任何其他運算 → 舊排序逐位相同的前提)', Object.is(lbOf(7, 12.345, 999, 0), 12.345 / 7) && Object.is(lbOf(1, 3.3, 10.89, 1.28), 3.3));
    }
}

// ── 執行期 ──
const DATA = path.join(ROOT, 'data');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbgate-'));
const base = { ...process.env, LOT: '150000', SELF: 'high+hivolat', RANK_MIN: '75', VOLAT_MIN: '60', EXIT: 'chand2', MAXD: '20', FILTER: 'bear60', STOPFILL: 'close', WARMUP: '240' };
for (const k of ['STATS_WIN', 'STATS_FROM', 'GATE', 'LB_Z', 'LB_TOP', 'MIN_N', 'CLIFF', 'RANKBY', 'WARMUPS', 'WARMUP', 'YEARRUNS', 'YEAR_OFFSET', 'VOLCAP', 'EQGATE', 'ROTATE', 'COST_X', 'PARK', 'DIV', 'DIV_TRADES', 'EQUITY_OUT', 'YEAR', 'EMERGING', 'BENCH0050']) delete base[k];
const run = (tag, extra, dataDir, maxSyms = '25', cache = 'c.json') => {
    const r = spawnSync(process.execPath, ['--max-old-space-size=3000', FILE, maxSyms, '2'], { env: { ...base, DATA_DIR: dataDir, TRADES_CACHE: path.join(tmp, cache), ...extra, SUMMARY_OUT: path.join(tmp, `s_${tag}.json`), EQUITY_OUT: path.join(tmp, `e_${tag}.json`), TAKEN_OUT: path.join(tmp, `t_${tag}.json`) }, encoding: 'utf8', timeout: 420000, maxBuffer: 64 << 20 });
    const rd = f => { try { return JSON.parse(fs.readFileSync(path.join(tmp, f), 'utf8')); } catch (_) { return null; } };
    let e = null; try { e = fs.readFileSync(path.join(tmp, `e_${tag}.json`), 'utf8'); } catch (_) {}
    return { r, s: rd(`s_${tag}.json`), t: rd(`t_${tag}.json`), e };
};
const core = s => s && JSON.stringify({ n: s.n, cum: s.cum, per: s.per, dd: s.dd, win: s.win, skipped: s.skipped, byYear: s.byYear, from: s.from, to: s.to });

if (!fs.existsSync(path.join(DATA, '^TWII.json'))) { console.log('❌ data/ 沒有 ^TWII.json → 執行期沒驗到'); fails.push('no-data'); }
else {
    const A = run('a', {}, DATA);
    ok('🚧 基準跑得起來', A.r.status === 0 && A.s && A.s.n > 5, `status=${A.r.status} ${(A.r.stderr || A.r.stdout || '').slice(-300)}`);
    ok('ⓐ0 不設時 cfg 沒有 gate / cliff、summary 沒有 cliff', A.s && !('gate' in A.s.cfg) && !('cliff' in A.s.cfg) && !('cliff' in A.s), JSON.stringify(A.s?.cfg));
    const Z = run('z', { GATE: 'lb', LB_Z: '0', MIN_N: '4', LB_TOP: '99' }, DATA);
    ok('ⓐ 決定性對照:GATE=lb LB_Z=0 MIN_N=4 LB_TOP=99 == 不設(成績 + 逐日淨值逐位相同)', Z.s && core(Z.s) === core(A.s) && Z.e === A.e, `${core(Z.s)} vs ${core(A.s)}`);
    const L = run('l', { GATE: 'lb' }, DATA);
    ok('ⓑ GATE=lb 預設值真的生效(成績跟不設不一樣)、cfg 記下 8 / 1.28 / 2', L.r.status === 0 && L.s && core(L.s) !== core(A.s) && L.s.cfg.gate === 'lb' && L.s.cfg.minN === 8 && L.s.cfg.lbZ === 1.28 && L.s.cfg.lbTop === 2, `${JSON.stringify(L.s?.cfg)} ${(L.r.stderr || '').slice(-200)}`);

    // ⓒ 一檔前 1 招:用快取把「那天以前出場的交易」逐筆重算成績 → 每一筆成交的招必須是這檔下界第 1 名
    const C = JSON.parse(fs.readFileSync(path.join(tmp, 'c.json'), 'utf8')).trades;
    const bySym = new Map(); for (const t of C) (bySym.get(t.sym) || bySym.set(t.sym, []).get(t.sym)).push(t);
    const COST = 0.44, MN = 4, Zc = 1.28;
    const topKey = (sym, inD) => {
        const st = new Map();
        for (const t of bySym.get(sym) || []) { if (!(t.outD < inD)) continue; const s = st.get(t.key) || { n: 0, sum: 0, sq: 0 }; s.n++; s.sum += t.ret; s.sq += t.ret * t.ret; st.set(t.key, s); }
        const arr = []; for (const [k, s] of st) { if (s.n < MN) continue; const v = lbOf(s.n, s.sum, s.sq, Zc); if (v - COST > 0) arr.push([k, v]); }
        arr.sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        return arr.length ? arr[0][0] : null;
    };
    const T1 = run('t1', { GATE: 'lb', MIN_N: '4', LB_TOP: '1' }, DATA);
    const T9 = run('t9', { GATE: 'lb', MIN_N: '4', LB_TOP: '99' }, DATA);
    const bad1 = (T1.t || []).filter(t => topKey(t.sym, t.d) !== t.key), bad9 = (T9.t || []).filter(t => topKey(t.sym, t.d) !== t.key);
    ok(`ⓒ LB_TOP=1:${(T1.t || []).length} 筆成交全部是那天這檔下界第 1 名`, T1.t && T1.t.length >= 5 && bad1.length === 0, JSON.stringify(bad1.slice(0, 3)));
    ok(`ⓒ2 決定性對照:LB_TOP=99 有 ${bad9.length} 筆不是第 1 名(> 0 → ⓒ 有鑑別力)`, T9.t && bad9.length > 0, `n=${(T9.t || []).length}`);

    // ⓓ CLIFF:複製幾檔到暫存資料夾,對其中一檔注入 1 拆 20(之後價格 ÷20、量 ×20)
    const DD = path.join(tmp, 'data'); fs.mkdirSync(DD);
    for (const f of ['^TWII.json', '0050.json']) fs.copyFileSync(path.join(DATA, f), path.join(DD, f));
    const cnt = new Map(); for (const t of C) cnt.set(t.sym, (cnt.get(t.sym) || 0) + 1);
    const pick = [...cnt.entries()].filter(([s]) => /^[1-9]\d{3}$/.test(s)).sort((a, b) => b[1] - a[1]).slice(0, 8).map(x => x[0]);
    for (const s of pick) fs.copyFileSync(path.join(DATA, `${s}.json`), path.join(DD, `${s}.json`));
    const TGT = pick[0];
    const rows = JSON.parse(fs.readFileSync(path.join(DD, `${TGT}.json`), 'utf8'));
    const cut = Math.floor(rows.length * 0.6);
    for (let k = cut; k < rows.length; k++) { for (const f of ['open', 'high', 'low', 'close']) if (rows[k][f] != null) rows[k][f] = +(rows[k][f] / 20).toFixed(2); if (rows[k].volume != null) rows[k].volume = rows[k].volume * 20; }
    fs.writeFileSync(path.join(DD, `${TGT}.json`), JSON.stringify(rows));
    const N0 = run('n0', { SELF: '', FILTER: '' }, DD, '99', 'cd.json');
    const CD = JSON.parse(fs.readFileSync(path.join(tmp, 'cd.json'), 'utf8')).trades;
    const pre = new Map(), at = new Map();
    for (const s of fs.readdirSync(DD).filter(f => /^\d{4}\.json$/.test(f)).map(f => f.slice(0, 4))) { const R = JSON.parse(fs.readFileSync(path.join(DD, `${s}.json`), 'utf8')).map(r => ({ d: String(r.date).replace(/\//g, '-').slice(0, 10), c: +r.close, o: +r.open })); pre.set(s, cliffPrefix(R.map(r => r.c), R.map(r => r.o))); at.set(s, new Map(R.map((r, k) => [r.d, k]))); }
    const crosses = (t, back) => { const a = at.get(t.sym)?.get(t.inD), b = at.get(t.sym)?.get(t.outD); return a != null && b != null && cliffIn(pre.get(t.sym), a - back, b); };
    const inj = CD.filter(t => t.sym === TGT && crosses(t, 0));
    ok(`ⓓ0 注入 ${TGT} 1 拆 20:有 ${inj.length} 筆候選跨過、都是 −80% 以下的假虧損(不設 CLIFF 時)`, N0.r.status === 0 && inj.length >= 1 && inj.every(t => t.ret < -80), `${inj.map(t => t.ret.toFixed(1)).join(',')} ${(N0.r.stderr || '').slice(-200)}`);
    const K0 = run('k0', { SELF: '', FILTER: '', CLIFF: '0' }, DD, '99', 'cd.json');
    const want0 = CD.filter(t => crosses(t, 0)).length, want20 = CD.filter(t => crosses(t, 20)).length;
    ok(`ⓓ CLIFF=0 剔除 ${K0.s?.cliff?.dropped} 筆 == lib_cliff 逐筆算 ${want0} 筆、成交裡沒有跨過斷崖的`, K0.s && K0.s.cliff && K0.s.cliff.dropped === want0 && (K0.t || []).every(t => !crosses({ ...t, inD: t.d }, 0)) && K0.s.cfg.cliff === 0, JSON.stringify(K0.s?.cliff));
    const K20 = run('k20', { SELF: '', FILTER: '', CLIFF: '20' }, DD, '99', 'cd.json');
    ok(`ⓓ2 CLIFF=20 剔除 ${K20.s?.cliff?.dropped} 筆 == 逐筆算 ${want20}(往前多看 20 根 → ≥ CLIFF=0)`, K20.s && K20.s.cliff && K20.s.cliff.dropped === want20 && want20 >= want0, JSON.stringify(K20.s?.cliff));

    // ⓦ WARMUPS:一次載入連跑幾個起點 == 每個起點單獨跑(成績 / 逐日淨值 / 成交逐位相同);含隨機排序(種子要每個起點重設)與停車 0050(停車帳要重設)
    const WS = ['240', '262', '301'];
    for (const [nm, env] of [['預設', {}], ['GATE=lb + 隨機排序', { GATE: 'lb', MIN_N: '4', RANKBY: 'rand' }], ['停車 0050 + CLIFF', { PARK: 'idle', CLIFF: '20' }]]) {
        const M = spawnSync(process.execPath, ['--max-old-space-size=3000', FILE, '25', '2'], { env: { ...base, DATA_DIR: DATA, TRADES_CACHE: path.join(tmp, 'c.json'), ...env, WARMUPS: WS.join(','), SUMMARY_OUT: path.join(tmp, 'ms_{W}.json'), EQUITY_OUT: path.join(tmp, 'me_{W}.json'), TAKEN_OUT: path.join(tmp, 'mt_{W}.json') }, encoding: 'utf8', timeout: 420000, maxBuffer: 64 << 20 });
        let same = M.status === 0, why = `status=${M.status} ${(M.stderr || '').slice(-200)}`;
        for (const w of WS) {
            if (!same) break;
            const S1 = run(`w${w}`, { ...env, WARMUP: w }, DATA);
            const rd = f => { try { return fs.readFileSync(path.join(tmp, f), 'utf8'); } catch (_) { return null; } };
            const a = [rd(`ms_${w}.json`), rd(`me_${w}.json`), rd(`mt_${w}.json`)], b = [rd(`s_w${w}.json`), rd(`e_w${w}.json`), rd(`t_w${w}.json`)];
            if (!a[0] || a.some((x, k) => x !== b[k])) { same = false; why = `起點 ${w}:${a.map((x, k) => x === b[k] ? '同' : '不同').join('/')}`; }
        }
        ok(`ⓦ ${nm}:WARMUPS=${WS.join(',')} 一次跑 == 三個起點各自單獨跑(成績・淨值・成交逐位相同)`, same, why);
    }
    // ⓨ YEARRUNS:一次跑幾個「逐年模式」== 各自 YEAR=… YEAR_OFFSET=… 單獨跑(成績單逐位相同);那一年一筆都沒有 → 寫 n=0 換下一個(⛔ 整支結束)
    const tw0 = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8')).map(r => String(r.date).replace(/\//g, '-').slice(0, 4));
    const yrs = [...new Set(tw0)].filter(y => tw0.filter(x => x === y).length > 200).slice(-2);
    const YR = [`${yrs[0]}:0`, `${yrs[0]}:5`, `${yrs[1]}:0`];
    const YM = spawnSync(process.execPath, ['--max-old-space-size=3000', FILE, '25', '2'], { env: { ...base, DATA_DIR: DATA, TRADES_CACHE: path.join(tmp, 'c.json'), YEARRUNS: YR.join(','), SUMMARY_OUT: path.join(tmp, 'ys_{Y}_{O}.json') }, encoding: 'utf8', timeout: 420000, maxBuffer: 64 << 20 });
    let ysame = YM.status === 0 && yrs.length === 2, ywhy = `status=${YM.status} yrs=${yrs} ${(YM.stderr || '').slice(-200)}`;
    for (const yo of YR) {
        if (!ysame) break;
        const [y, o] = yo.split(':');
        run(`y${y}_${o}`, { YEAR: y, YEAR_OFFSET: o }, DATA);
        const a = (() => { try { return fs.readFileSync(path.join(tmp, `ys_${y}_${o}.json`), 'utf8'); } catch (_) { return null; } })(), b = (() => { try { return fs.readFileSync(path.join(tmp, `s_y${y}_${o}.json`), 'utf8'); } catch (_) { return null; } })();
        if (!a || a !== b) { ysame = false; ywhy = `${yo}:${a ? (b ? '不同' : '單獨跑沒檔') : '一次跑沒檔'}`; }
    }
    ok(`ⓨ YEARRUNS=${YR.join(',')} 一次跑 == 三次 YEAR / YEAR_OFFSET 單獨跑(成績單逐位相同)`, ysame, ywhy);
    const Y0 = spawnSync(process.execPath, ['--max-old-space-size=3000', FILE, '25', '2'], { env: { ...base, DATA_DIR: DATA, TRADES_CACHE: path.join(tmp, 'c.json'), RANK_MIN: '101', YEARRUNS: `${yrs[0]}:0,${yrs[1]}:0`, SUMMARY_OUT: path.join(tmp, 'y0_{Y}_{O}.json') }, encoding: 'utf8', timeout: 420000, maxBuffer: 64 << 20 });
    const y0ok = [yrs[0], yrs[1]].every(y => { try { return JSON.parse(fs.readFileSync(path.join(tmp, `y0_${y}_0.json`), 'utf8')).n === 0; } catch (_) { return false; } });
    ok('ⓨ2 那一年一筆都沒進場(位階門檻 101)→ 每一年都寫出 n=0、整支 rc=0(⛔ 第一年就結束)', Y0.status === 0 && y0ok, `status=${Y0.status} ${(Y0.stderr || '').slice(-200)}`);
    // ⓨ4 yearly_bt YB_BATCH=1(一個策略一個程序)== 一格一格跑(逐年成績單每一格逐位相同)
    const YB = path.join(ROOT, 'scripts', 'yearly_bt.mjs');
    const ybEnv = o => ({ ...base, DATA_DIR: DATA, YB_SYMS: '25', ONLY: 'now807', YEARS_RUN: yrs.join(','), OUT_DIR: path.join(tmp, `yb_${o}`), CACHE_DIR: path.join(tmp, 'ybc'), LANES: '2', ...(o === 'b' ? { YB_BATCH: '1' } : {}) });
    const YB1 = spawnSync(process.execPath, [YB], { env: ybEnv('s'), encoding: 'utf8', timeout: 900000, maxBuffer: 64 << 20 });
    const YB2 = spawnSync(process.execPath, [YB], { env: ybEnv('b'), encoding: 'utf8', timeout: 900000, maxBuffer: 64 << 20 });
    const fs1 = (() => { try { return fs.readdirSync(path.join(tmp, 'yb_s')).filter(f => f.endsWith('.json')).sort(); } catch (_) { return []; } })();
    const fs2 = (() => { try { return fs.readdirSync(path.join(tmp, 'yb_b')).filter(f => f.endsWith('.json')).sort(); } catch (_) { return []; } })();
    const ybSame = YB1.status === 0 && YB2.status === 0 && fs1.length === yrs.length * 5 && JSON.stringify(fs1) === JSON.stringify(fs2)
        && fs1.every(f => fs.readFileSync(path.join(tmp, 'yb_s', f), 'utf8') === fs.readFileSync(path.join(tmp, 'yb_b', f), 'utf8'));
    ok(`ⓨ4 yearly_bt YB_BATCH=1 == 一格一格跑(${fs1.length} 格逐位相同)`, ybSame, `rc ${YB1.status}/${YB2.status} 檔 ${fs1.length}/${fs2.length} ${(YB2.stderr || YB1.stderr || '').slice(-200)}`);
    const YW = spawnSync(process.execPath, [FILE, '25', '2'], { env: { ...base, DATA_DIR: DATA, TRADES_CACHE: path.join(tmp, 'c.json'), YEARRUNS: `${yrs[0]}:0`, WARMUPS: '240' }, encoding: 'utf8', timeout: 120000 });
    ok('ⓨ3 YEARRUNS 跟 WARMUPS 同時設 → exit 1', YW.status === 1 && /不可跟 WARMUPS/.test(YW.stderr || ''), (YW.stderr || '').slice(-200));
    const MB = spawnSync(process.execPath, [FILE, '25', '2'], { env: { ...base, DATA_DIR: DATA, TRADES_CACHE: path.join(tmp, 'c.json'), WARMUPS: '240,262', SUMMARY_OUT: path.join(tmp, 'nobrace.json') }, encoding: 'utf8', timeout: 120000 });
    ok('ⓦ2 WARMUPS 時輸出檔名沒有 {W} → exit 1(⛔ 後面的起點蓋掉前面的)', MB.status === 1 && /檔名要有 \{W\}/.test(MB.stderr || ''), (MB.stderr || '').slice(-200));
    const MV = spawnSync(process.execPath, [FILE, '25', '2'], { env: { ...base, DATA_DIR: DATA, TRADES_CACHE: path.join(tmp, 'c.json'), WARMUPS: '240,262', VOLCAP: '5' }, encoding: 'utf8', timeout: 120000 });
    ok('ⓦ3 WARMUPS 配還沒驗過的開關(VOLCAP)→ exit 1', MV.status === 1 && /還沒驗過/.test(MV.stderr || ''), (MV.stderr || '').slice(-200));

    // ⓔ 設錯格式
    const bad = (tag, env, re) => { const B = run(tag, env, DATA); ok(`ⓔ ${JSON.stringify(env)} → exit 1 並說原因`, B.r.status === 1 && re.test(B.r.stderr || ''), (B.r.stderr || '').slice(-200)); };
    bad('b1', { GATE: 'xx' }, /GATE=xx 不認得/);
    bad('b2', { CLIFF: 'abc' }, /CLIFF=abc 不認得/);
    bad('b3', { GATE: 'lb', LB_TOP: '0' }, /GATE=lb 參數不認得/);
    bad('b4', { GATE: 'lb', LB_Z: '-1' }, /GATE=lb 參數不認得/);
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ test_pbgate 全過');
process.exit(fails.length ? 1 : 0);
