#!/usr/bin/env node
/**
 * 🧪 V80.1.7 `portfolio_backtest.mjs` 兩個研究開關守門:
 *   AF_RANK / AF_VOL —— ALLFIRE 快取「建的時候」的位階 / 波動門檻(模擬門檻只能更嚴,重用同一份快取)
 *   VOLAT_MAX        —— SELF 含 lovolat 時的低波動門檻(不設 = 35)
 *
 * 為什麼:next-scr-layer 要看「創一年新高 = 位階 100」疊在 🔥 上;next-gene-lowvol 要看低波動門檻左右挪。
 *   ALLFIRE 快取的 key 原本寫死 AF_RANK = RANK_MIN → 換門檻就得花一小時重建全市場快取(而且會**蓋掉**原本那份)。
 *
 * 釘住:
 *   ⓐ 不設時一個字都不變:AF_RANK / AF_VOL 預設 = RANK_MIN / VOLAT_MIN(key 字串跟舊版相同)、VOLAT_MAX 預設 35
 *   ⓑ ⭐ 決定性對照:「位階 90、快取用 75 建」== 「位階 90、快取用 90 建」逐位相同(子集合推得出來 → 一定相同)
 *   ⓒ 重用時真的沒有重掃(log 有「載入交易快取」)
 *   ⓓ 模擬門檻比快取鬆 → exit 1(⛔ 安靜地少算)
 *   ⓔ VOLAT_MAX=35 跟不設逐位相同、VOLAT_MAX=1000 真的不一樣
 *   ⓕ V80.1.7 AF_VOLMAX(ALLFIRE + lovolat = 照 App 買法測「高位階 × 低波動」):不設時 key 一個字都不變;
 *      ⭐ 決定性對照:「低波動 35、快取只留波動 <45」==「低波動 35、快取全部波動」逐位相同(子集合);快取比模擬窄 / 配 hivolat → exit 1
 *   ⓖ V80.1.7 只看位階(SELF=high、不看波動):快取要全部波動(AF_VOL=0);⭐ 決定性對照:高波動 60 用「全部波動」那份快取 ==
 *      用自己「波動 ≥60」那份快取(逐位相同)→ 換快取不會動到現行那組的成績
 * ⚠️ 真跑引擎(repo `data/`,MAX_SYMS=25),約 3~5 分鐘。
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = process.env.PB_FILE || path.join(ROOT, 'scripts', 'portfolio_backtest.mjs');
const CODE = fs.readFileSync(FILE, 'utf8').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };

// ── 靜態 ──
ok('ⓐs AF_RANK / AF_VOL 預設 = RANK_MIN / VOLAT_MIN', /const AF_RANK = \+\(process\.env\.AF_RANK \|\| RANK_MIN\);/.test(CODE) && /const AF_VOL = \+\(process\.env\.AF_VOL \|\| VOLAT_MIN\);/.test(CODE));
ok('ⓐs2 快取 key 用 AF_RANK / AF_VOL(鍵名不變 → 不設時字串跟舊版一樣)', /const _ckAllFire = ALLFIRE \? \{ ALLFIRE: 1, AF_RANK, AF_VOL \} : \{\};/.test(CODE));
ok('ⓐs3 建快取時多出來的觸發用 AF_RANK / AF_VOL 篩(⛔ 用模擬門檻)', /f\.rank >= AF_RANK && f\.vol >= AF_VOL/.test(CODE) && !/t\.seq === 0\) \{[^\n]*f\.rank >= RANK_MIN/.test(CODE));
ok('ⓓs 模擬門檻比快取鬆 → exit 1', /ALLFIRE && \(RANK_MIN < AF_RANK \|\| VOLAT_MIN < AF_VOL\)\)[^\n]*process\.exit\(1\)/.test(CODE));
ok('ⓕs AF_VOLMAX 不設 = Infinity、只有設了才進快取 key(⛔ 改 _ckAllFire 那一行)、建快取時用它篩',
   /const AF_VOLMAX = process\.env\.AF_VOLMAX \? \+process\.env\.AF_VOLMAX : Infinity;/.test(CODE)
   && /const _ckAfMax = \(ALLFIRE && Number\.isFinite\(AF_VOLMAX\)\) \? \{ AF_VOLMAX \} : \{\};/.test(CODE)
   && /\.\.\._ckAllFire, \.\.\._ckAfMax,/.test(CODE) && /f\.vol >= AF_VOL && f\.vol < AF_VOLMAX/.test(CODE));
ok('ⓕs2 lovolat 要 AF_VOL=0 且 VOLAT_MAX ≤ AF_VOLMAX、hivolat 配 AF_VOLMAX → exit 1',
   /SELF\.includes\('lovolat'\) && !\(AF_VOL <= 0 && VOLAT_MAX <= AF_VOLMAX\)\)[^\n]*process\.exit\(1\)/.test(CODE)
   && /SELF\.includes\('hivolat'\) && Number\.isFinite\(AF_VOLMAX\)\)[^\n]*process\.exit\(1\)/.test(CODE));
ok('ⓖs 只看位階:要 AF_VOL=0、不設 AF_VOLMAX,否則 exit 1',
   /!SELF\.includes\('hivolat'\) && !SELF\.includes\('lovolat'\) && !\(AF_VOL <= 0 && !Number\.isFinite\(AF_VOLMAX\)\)\)[^\n]*process\.exit\(1\)/.test(CODE));
ok('ⓔs VOLAT_MAX 預設 35、lovolat 讀它', /const VOLAT_MAX = \+\(process\.env\.VOLAT_MAX \|\| 35\);/.test(CODE) && /c === 'lovolat' && !\(f\.vol < VOLAT_MAX\)/.test(CODE));

// ── 執行期 ──
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
if (!fs.existsSync(path.join(DATA, '^TWII.json'))) { console.log(`❌ ${DATA} 沒有 ^TWII.json → 執行期沒驗到`); fails.push('no-data'); }
else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbaf-'));
    const base = { ...process.env, DATA_DIR: DATA, LOT: '150000', STOPFILL: 'close', EXIT: 'chand2', MAXD: '20', WARMUP: '240', GATE: 'lb', MIN_N: '4', CLIFF: '20' };
    for (const k of ['AF_RANK', 'AF_VOL', 'VOLAT_MAX', 'RANK_MIN', 'VOLAT_MIN', 'SELF', 'ALLFIRE', 'TRADES_CACHE', 'FILTER', 'PARK', 'DIV', 'DIV_TRADES', 'EQUITY_OUT', 'YEAR', 'LISTK', 'LIST_TRIG', 'LIST_DUMP', 'STATS_WIN', 'STATS_FROM']) delete base[k];
    const run = (tag, extra) => {
        const r = spawnSync(process.execPath, ['--max-old-space-size=3000', FILE, '25', '2'], { env: { ...base, ...extra, SUMMARY_OUT: path.join(tmp, `s_${tag}.json`), EQUITY_OUT: path.join(tmp, `e_${tag}.json`) }, encoding: 'utf8', timeout: 480000, maxBuffer: 64 << 20 });
        let s = null, e = null;
        try { s = JSON.parse(fs.readFileSync(path.join(tmp, `s_${tag}.json`), 'utf8')); } catch (_) {}
        try { e = fs.readFileSync(path.join(tmp, `e_${tag}.json`), 'utf8'); } catch (_) {}
        return { r, s, e, log: (r.stdout || '') + (r.stderr || '') };
    };
    const core = s => s && JSON.stringify({ n: s.n, cum: s.cum, per: s.per, dd: s.dd, win: s.win, skipped: s.skipped, byYear: s.byYear, from: s.from, to: s.to });
    const af = { ALLFIRE: '1', SELF: 'high+hivolat', VOLAT_MIN: '60' };
    const c75 = path.join(tmp, 'c75.json'), c90 = path.join(tmp, 'c90.json');
    const A = run('a', { ...af, RANK_MIN: '75', TRADES_CACHE: c75 });
    ok('🚧 基準(ALLFIRE、位階 75)跑得起來', A.r.status === 0 && A.s && A.s.n > 0, `status=${A.r.status} ${A.log.slice(-300)}`);
    const keyOf = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')).key; } catch (_) { return null; } };
    ok('ⓐ 不設 AF_RANK 時 key = {…ALLFIRE:1, AF_RANK:75, AF_VOL:60}(跟舊版同一個字串)', /"ALLFIRE":1,"AF_RANK":75,"AF_VOL":60/.test(keyOf(c75) || ''), keyOf(c75));
    const A2 = run('a2', { ...af, RANK_MIN: '75', AF_RANK: '75', AF_VOL: '60', TRADES_CACHE: c75 });
    ok('ⓐ2 明寫 AF_RANK=75 == 不設(重用快取、逐位相同)', A2.r.status === 0 && /載入交易快取/.test(A2.log) && core(A2.s) === core(A.s) && A2.e === A.e, `${core(A2.s)} vs ${core(A.s)}`);
    const B = run('b', { ...af, RANK_MIN: '90', AF_RANK: '75', TRADES_CACHE: c75 });
    ok('ⓒ 位階 90 + AF_RANK=75 → 重用位階 75 那份快取(⛔ 重掃)', B.r.status === 0 && /載入交易快取/.test(B.log) && !/重新掃描/.test(B.log), B.log.slice(-300));
    const C = run('c', { ...af, RANK_MIN: '90', TRADES_CACHE: c90 });
    ok('🚧 對照組:位階 90 自己建一份快取', C.r.status === 0 && C.s && /"AF_RANK":90/.test(keyOf(c90) || ''), `status=${C.r.status} ${C.log.slice(-200)}`);
    ok('ⓑ ⭐ 決定性對照:重用 75 那份 == 自己建 90 那份(成績 + 逐日淨值逐位相同)', B.s && C.s && core(B.s) === core(C.s) && B.e === C.e, `${core(B.s)} vs ${core(C.s)}`);
    ok('ⓑ2 而且位階 90 真的跟 75 不一樣(⛔ 兩個都沒生效也會「相同」)', core(B.s) !== core(A.s), core(B.s));
    const D = run('d', { ...af, RANK_MIN: '70', AF_RANK: '75', TRADES_CACHE: c75 });
    ok('ⓓ 模擬門檻(70)比快取(75)鬆 → exit 1', D.r.status === 1 && /只能更嚴/.test(D.log), `status=${D.r.status} ${D.log.slice(-200)}`);
    const lv = { SELF: 'high+lovolat', RANK_MIN: '75', TRADES_CACHE: path.join(tmp, 'clv.json') };
    const L0 = run('l0', lv);
    const L35 = run('l35', { ...lv, VOLAT_MAX: '35' });
    const L1k = run('l1k', { ...lv, VOLAT_MAX: '1000' });
    ok('ⓔ VOLAT_MAX=35 == 不設(逐位相同)', L0.r.status === 0 && L35.s && core(L35.s) === core(L0.s) && L35.e === L0.e, `${core(L35.s)} vs ${core(L0.s)} ${L0.log.slice(-200)}`);
    ok('ⓔ2 VOLAT_MAX=1000 真的不一樣(低波動門檻有生效)', L1k.s && core(L1k.s) !== core(L0.s), core(L1k.s));
    // ⓕ AF_VOLMAX:ALLFIRE + lovolat
    const afl = { ALLFIRE: '1', SELF: 'high+lovolat', RANK_MIN: '75', VOLAT_MIN: '0', VOLAT_MAX: '35' };
    const cAll = path.join(tmp, 'cl_all.json'), c45 = path.join(tmp, 'cl_45.json');
    const F1 = run('f1', { ...afl, TRADES_CACHE: cAll });
    ok('🚧 ALLFIRE + lovolat(快取全部波動)跑得起來', F1.r.status === 0 && F1.s && F1.s.n > 0, `status=${F1.r.status} ${F1.log.slice(-300)}`);
    ok('ⓕ 不設 AF_VOLMAX 時 key 沒有 AF_VOLMAX(跟舊版同一種字串)', /"ALLFIRE":1,"AF_RANK":75,"AF_VOL":0[,}]/.test(keyOf(cAll) || '') && !/AF_VOLMAX/.test(keyOf(cAll) || ''), keyOf(cAll));
    const F2 = run('f2', { ...afl, AF_VOLMAX: '45', TRADES_CACHE: c45 });
    ok('ⓕ2 設了 AF_VOLMAX=45 → 進 key', F2.r.status === 0 && /"AF_VOLMAX":45/.test(keyOf(c45) || ''), `status=${F2.r.status} ${keyOf(c45)} ${F2.log.slice(-200)}`);
    ok('ⓕ3 ⭐ 決定性對照:快取只留波動 <45 == 快取全部波動(低波動 35 的成績 + 逐日淨值逐位相同)', F1.s && F2.s && core(F2.s) === core(F1.s) && F2.e === F1.e, `${core(F2.s)} vs ${core(F1.s)}`);
    const F3 = run('f3', { ...afl, VOLAT_MAX: '60', AF_VOLMAX: '45', TRADES_CACHE: c45 });
    ok('ⓕ4 模擬的低波動門檻(60)比快取(<45)寬 → exit 1', F3.r.status === 1 && /AF_VOLMAX/.test(F3.log), `status=${F3.r.status} ${F3.log.slice(-200)}`);
    const F4 = run('f4', { ...af, RANK_MIN: '75', AF_VOLMAX: '45', TRADES_CACHE: path.join(tmp, 'ch45.json') });
    ok('ⓕ5 hivolat 配 AF_VOLMAX → exit 1', F4.r.status === 1 && /hivolat/.test(F4.log), `status=${F4.r.status} ${F4.log.slice(-200)}`);
    const F5 = run('f5', { ...afl, VOLAT_MIN: '60', TRADES_CACHE: path.join(tmp, 'cl_v60.json') });
    ok('ⓕ6 lovolat 的快取沒有低波動那幾天(AF_VOL=60)→ exit 1', F5.r.status === 1 && /AF_VOL=0/.test(F5.log), `status=${F5.r.status} ${F5.log.slice(-200)}`);
    // ⓖ 只看位階 + 換大快取不動現行成績
    const G1 = run('g1', { ...af, RANK_MIN: '75', AF_VOL: '0', TRADES_CACHE: cAll });
    ok('ⓖ ⭐ 決定性對照:高波動 60 用全部波動的快取 == 用自己 ≥60 的快取(成績 + 逐日淨值逐位相同)', G1.r.status === 0 && /載入交易快取/.test(G1.log) && core(G1.s) === core(A.s) && G1.e === A.e, `${core(G1.s)} vs ${core(A.s)} ${G1.log.slice(-200)}`);
    const G2 = run('g2', { ALLFIRE: '1', SELF: 'high', RANK_MIN: '75', VOLAT_MIN: '0', TRADES_CACHE: cAll });
    ok('ⓖ2 只看位階(全部波動快取)跑得起來、而且跟只買高波動不一樣', G2.r.status === 0 && G2.s && G2.s.n > 0 && core(G2.s) !== core(A.s), `status=${G2.r.status} ${G2.log.slice(-200)}`);
    const G3 = run('g3', { ALLFIRE: '1', SELF: 'high', RANK_MIN: '75', VOLAT_MIN: '60', TRADES_CACHE: c75 });
    ok('ⓖ3 只看位階配「波動 ≥60」的快取 → exit 1(⛔ 安靜地少算)', G3.r.status === 1 && /只看位階/.test(G3.log), `status=${G3.r.status} ${G3.log.slice(-200)}`);
    fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(fails.length ? `\n❌ ${fails.length} 條沒過:${fails.join(' / ')}` : '\n✅ test_afrank 全過');
process.exit(fails.length ? 1 : 0);
