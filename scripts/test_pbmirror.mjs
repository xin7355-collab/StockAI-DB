#!/usr/bin/env node
/**
 * 🪞 V79.4.9 `portfolio_backtest.mjs` 對齊 App 的三個開關 + 尾盤候選輸出(陷阱 #56 / #58:回測要跟 App 一模一樣)
 *
 * 為什麼(A0 實測,d16 2011 起 ALLFIRE 快取的觸發事件):
 *   ・個股自己「收盤同時跌破 20 與 60 日線」:App(playbook_scan 的 bear / 決策台 `_deckBuyOf` / auto_trade)會擋,引擎沒有
 *     → 🧬 觸發事件裡 2.9% 是這種 → `SELF=…+nobear`
 *   ・型態全市場樣本 ≥20 這一關:引擎有、App 沒有 → `MIN_MKT_N=0` = App 對齊(⛔ 不設 = 20,一個字都不變)
 *   ・收盤停在漲停價那天:尾盤 / 收盤競價掛漲停價多半排不到,引擎卻當買得到 → `NOLOCK=1` 量差多少
 *   ・尾盤即時掃描(今天觸發的裡面挑最好):`EOD_DUMP` 把每天的候選照排序寫出來,給 13:20 vs 收盤的核對與重播測試用
 *
 * 釘住:
 *   ⓢ 四個都⛔ 不進 CACHE_KEY;nobear 跟 App 同一條(兩條都破才擋 ⛔ 不是 ma2060);NOLOCK 用 lib_limit 的 upLimitClose
 *   ⓐ 決定性對照:不設 == MIN_MKT_N=20 == NOLOCK=0(成績 + 逐日淨值逐位相同)
 *   ⓑ nobear:成交裡沒有一筆是「訊號日收盤同時破 20 / 60 日線」(獨立重算);對照組(不設)要真的有這種成交
 *   ⓒ NOLOCK:成交裡沒有一筆訊號日收盤停在漲停價(獨立重算);對照組要真的有
 *   ⓓ EOD_DUMP:每天一行、照排序值由大到小、每一筆成交都在當天的候選裡;EOD_DUMP_SYMS 的 q 全部過門檻;設錯 exit 1
 *   ⓔ cfg 記下 park / nolock / minMktN
 * ⚠️ 真跑引擎(repo data/ 前 99 檔),約 3~4 分鐘。
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { upLimitClose } from './lib_limit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = process.env.PB_FILE || path.join(ROOT, 'scripts', 'portfolio_backtest.mjs');
const strip = t => t.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
const CODE = strip(fs.readFileSync(FILE, 'utf8'));
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };

// ── ⓢ 靜態 ──
const ck = (CODE.match(/const CACHE_KEY = JSON\.stringify\(\{[^}]*\}\)/) || [''])[0];
ok('ⓢ1 CACHE_KEY ⛔ 沒有 MIN_MKT_N / NOLOCK / EOD_DUMP / nobear', ck && !/MIN_MKT_N|NOLOCK|EOD_DUMP|nobear/.test(ck), ck);
ok('ⓢ2 nobear = 收盤同時跌破 20 與 60 日線才擋(同 playbook_scan selfBear,⛔ 不是兩條都要站上);只存 0/1(⛔ 不存兩條均線 —— 記憶體)',
   /if \(c === 'nobear' && f\.nb === 1\) return false;/.test(CODE)
   && /_o\.nb = \(dd\[i\]\.c < a20 \/ 20 && dd\[i\]\.c < a60 \/ 60\) \? 1 : 0;/.test(CODE)
   && /const NEED_NB = SELF\.includes\('nobear'\);/.test(CODE) && !/NEED_MA = SELF\.some\([^;]*nobear/.test(CODE));
ok('ⓢ3 NOLOCK 用 lib_limit 的 upLimitClose(⛔ 不寫死 9.7 / 1.095)', /import \{ upLimitClose \} from '\.\/lib_limit\.mjs';/.test(CODE) && /upLimitClose\(t\.inD, f\.c, f\.pc\)/.test(CODE));
ok('ⓢ4 MIN_MKT_N=0 時沒有全市場紀錄也放行(App 沒有這一關);預設 20', /const restOk = x => \(MIN_MKT_N === 0 \|\| \(x\.m && x\.m\.n >= MIN_MKT_N\)\)/.test(CODE) && /=== '' \? 20 : \+process\.env\.MIN_MKT_N/.test(CODE));

// ── 執行期 ──
const DATA = path.join(ROOT, 'data');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbmirror-'));
const base = { ...process.env, LOT: '150000', SELF: 'high+hivolat', RANK_MIN: '75', VOLAT_MIN: '60', EXIT: 'chand2', MAXD: '20', FILTER: '', STOPFILL: 'close', WARMUP: '240', GATE: 'lb', MIN_N: '4' };
for (const k of ['STATS_WIN', 'STATS_FROM', 'LB_Z', 'LB_TOP', 'CLIFF', 'RANKBY', 'WARMUPS', 'YEARRUNS', 'YEAR_OFFSET', 'VOLCAP', 'EQGATE', 'ROTATE', 'COST_X', 'PARK', 'DIV', 'DIV_TRADES', 'EQUITY_OUT', 'YEAR', 'EMERGING', 'BENCH0050', 'MIN_MKT_N', 'NOLOCK', 'EOD_DUMP', 'EOD_DUMP_SYMS', 'LISTK', 'LIST_TRIG', 'LIST_DUMP', 'ALLFIRE']) delete base[k];
const run = (tag, extra, maxSyms = '99') => {
    const r = spawnSync(process.execPath, ['--max-old-space-size=3000', FILE, maxSyms, '2'], { env: { ...base, DATA_DIR: DATA, TRADES_CACHE: path.join(tmp, 'c.json'), ...extra, SUMMARY_OUT: path.join(tmp, `s_${tag}.json`), EQUITY_OUT: path.join(tmp, `e_${tag}.json`), TAKEN_OUT: path.join(tmp, `t_${tag}.json`) }, encoding: 'utf8', timeout: 420000, maxBuffer: 64 << 20 });
    const rd = f => { try { return JSON.parse(fs.readFileSync(path.join(tmp, f), 'utf8')); } catch (_) { return null; } };
    let e = null; try { e = fs.readFileSync(path.join(tmp, `e_${tag}.json`), 'utf8'); } catch (_) {}
    return { r, s: rd(`s_${tag}.json`), t: rd(`t_${tag}.json`), e };
};
const core = s => s && JSON.stringify({ n: s.n, cum: s.cum, per: s.per, dd: s.dd, win: s.win, skipped: s.skipped, byYear: s.byYear, from: s.from, to: s.to });
// 獨立重算:那一天收盤、前收、20 / 60 日線(⛔ 不用引擎的 featOf)
const bars = new Map();
const barOf = (sym, d) => {
    let m = bars.get(sym);
    if (!m) {
        m = new Map();
        let rows = []; try { rows = JSON.parse(fs.readFileSync(path.join(DATA, `${sym}.json`), 'utf8')); } catch (_) {}
        const dd = rows.map(r => ({ d: String(r.date || '').replace(/\//g, '-').slice(0, 10), c: +r.close })).filter(x => x.d && x.c > 0);
        for (let i = 60; i < dd.length; i++) {
            let s20 = 0; for (let k = i - 19; k <= i; k++) s20 += dd[k].c;
            let s60 = 0; for (let k = i - 59; k <= i; k++) s60 += dd[k].c;
            m.set(dd[i].d, { c: dd[i].c, pc: dd[i - 1].c, ma20: s20 / 20, ma60: s60 / 60 });
        }
        bars.set(sym, m);
    }
    return m.get(d);
};
// ⚠️ TAKEN_OUT 的每一筆沒有 inD,只有 d(實際成交那天;ENTRY=close 時 = 訊號日)
const sigD = t => t.inD || t.d;
const isBear = t => { const b = barOf(t.sym, sigD(t)); return !!b && b.c < b.ma20 && b.c < b.ma60; };
const isLock = t => { const b = barOf(t.sym, sigD(t)); return !!b && upLimitClose(sigD(t), b.c, b.pc); };

if (!fs.existsSync(path.join(DATA, '^TWII.json'))) { console.log('❌ data/ 沒有 ^TWII.json → 執行期沒驗到(先跑 scripts/fetch_testdata.sh)'); fails.push('no-data'); }
else {
    const A = run('a', {});
    ok('🚧 基準跑得起來', A.r.status === 0 && A.s && A.s.n > 20, `status=${A.r.status} ${(A.r.stderr || A.r.stdout || '').slice(-300)}`);
    const M20 = run('m20', { MIN_MKT_N: '20' }), N0 = run('n0', { NOLOCK: '0' });
    ok('ⓐ 決定性對照:不設 == MIN_MKT_N=20 == NOLOCK=0(成績 + 逐日淨值逐位相同)', A.s && core(M20.s) === core(A.s) && M20.e === A.e && core(N0.s) === core(A.s) && N0.e === A.e, `${core(M20.s)} / ${core(N0.s)} vs ${core(A.s)}`);
    const M0 = run('m0', { MIN_MKT_N: '0' });
    ok('ⓐ2 MIN_MKT_N=0 跑得起來、cfg 記下 minMktN 0', M0.r.status === 0 && M0.s && M0.s.cfg.minMktN === 0, `status=${M0.r.status} ${(M0.r.stderr || '').slice(-200)}`);

    // ⓑ nobear
    const bearA = (A.t || []).filter(isBear);
    const B = run('b', { SELF: 'high+hivolat+nobear' });
    const bearB = (B.t || []).filter(isBear);
    ok(`ⓑ 對照組(不設)有 ${bearA.length} 筆成交是訊號日收盤同時破 20 / 60 日線(> 0 → 這條有鑑別力)`, bearA.length > 0, `n=${(A.t || []).length}`);
    ok(`ⓑ2 SELF=…+nobear:${(B.t || []).length} 筆成交裡 0 筆是那種(實得 ${bearB.length})、cfg 記下`, B.r.status === 0 && B.t && B.t.length > 10 && bearB.length === 0 && /nobear/.test(B.s.cfg.self), JSON.stringify(bearB.slice(0, 2)));

    // ⓒ NOLOCK
    const lockA = (A.t || []).filter(isLock);
    const L = run('l', { NOLOCK: '1' });
    const lockL = (L.t || []).filter(isLock);
    ok(`ⓒ 對照組(不設)有 ${lockA.length} 筆成交訊號日收盤停在漲停價(> 0 → 有鑑別力)`, lockA.length > 0, `n=${(A.t || []).length}`);
    ok(`ⓒ2 NOLOCK=1:${(L.t || []).length} 筆成交 0 筆停在漲停價(實得 ${lockL.length})、cfg 記下 nolock`, L.r.status === 0 && L.t && lockL.length === 0 && L.s.cfg.nolock === 1, JSON.stringify(lockL.slice(0, 2)));

    // ⓓ EOD_DUMP
    const syms = [...new Set((A.t || []).map(t => t.sym))].slice(0, 5);
    fs.writeFileSync(path.join(tmp, 'syms.json'), JSON.stringify(syms));
    const ED = path.join(tmp, 'eod.ndjson');
    const E = run('e', { EOD_DUMP: ED, EOD_DUMP_SYMS: path.join(tmp, 'syms.json') });
    ok('ⓓ0 EOD_DUMP 不改結果(成績 + 逐日淨值 == 不設)', E.s && core(E.s) === core(A.s) && E.e === A.e, `${core(E.s)} vs ${core(A.s)}`);
    const lines = (() => { try { return fs.readFileSync(ED, 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch (_) { return []; } })();
    const byD = new Map(lines.map(o => [o.d, o]));
    const sorted = lines.every(o => o.c.every((x, k) => k === 0 || o.c[k - 1][2] >= x[2]));
    const inCand = (A.t || []).every(t => { const o = byD.get(t.d); return o && o.c.some(x => x[0] === t.sym && x[1] === t.key); });
    const qOk = lines.some(o => (o.q || []).length) && lines.every(o => (o.q || []).every(x => syms.includes(x[0]) && x[3] >= 4 && x[2] - 0.44 > 0));
    ok(`ⓓ EOD_DUMP ${lines.length} 天:每天一行、照排序值由大到小、每一筆成交都在當天候選裡、q 只有指定那幾檔且全部過門檻`, lines.length > 200 && new Set(lines.map(o => o.d)).size === lines.length && sorted && inCand && qOk, `sorted=${sorted} inCand=${inCand} q=${qOk}`);
    const bad = (tag, env, re) => { const R = run(tag, env); ok(`ⓓ2 ${JSON.stringify(env).replace(tmp, '…')} → exit 1 並說原因`, R.r.status === 1 && re.test(R.r.stderr || ''), (R.r.stderr || '').slice(-200)); };
    bad('x1', { EOD_DUMP: ED, LISTK: '2' }, /不可跟 LISTK 一起用/);
    bad('x2', { EOD_DUMP: ED, GATE: '' }, /EOD_DUMP 要配 GATE=lb/);
    bad('x3', { EOD_DUMP_SYMS: path.join(tmp, 'syms.json') }, /EOD_DUMP_SYMS 要配 EOD_DUMP/);
    bad('x4', { MIN_MKT_N: '-1' }, /MIN_MKT_N=-1 要 ≥ 0 的整數/);

    // ⓔ cfg.park
    const P = run('p', { PARK: 'idle', BENCH0050: path.join(DATA, '0050.json') });
    ok('ⓔ PARK=idle 時 cfg 記下 park(每週回測的成績單簽名要靠它)', P.r.status === 0 && P.s && P.s.cfg.park === 'idle', `status=${P.r.status} ${(P.r.stderr || '').slice(-200)}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ test_pbmirror 全過');
process.exit(fails.length ? 1 : 0);
