#!/usr/bin/env node
/**
 * 🇺🇸 V77.7.7 `portfolio_backtest.mjs` 美股訊號濾網(USSIG)守門
 *
 * 起因:外部建議「美股隔夜異常 → 台股」要疊在 🧬 上量增量 —— 引擎以前沒有「外部逐日訊號」的候選層鉤子。
 * 釘住:
 *   ⓐ 不設時一個字都不變:⛔ 不進 CACHE_KEY;不設 USSIG 的成績跟舊版逐位相同、summary 沒有 ussig
 *   ⓑ 全部日期都給 "*|date"=1 且門檻 0 → 筆數跟不設完全相同(= 鉤子接對位置、沒誤剔)
 *   ⓒ 對照表只留一半日期 → 筆數變少而且 summary.ussig.noData > 0(缺鍵 = 剔除並計數,⛔ 不放行)
 *   ⓓ 注入必紅(反向注入):對照表只放行「基準裡賠錢那幾筆」的 (sym|inD) → 成績必低於基準(證明真的在挑)
 *   ⓔ sham 通過率對齊實測通過率(差 <3pp),而且兩次跑逐位相同(固定種子)
 *   ⓕ 對照表讀不到 / 鍵數 <100 → exit 1
 * ⚠️ 真跑引擎(repo `data/` 25 檔),約 2~3 分鐘。
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
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 240)}`); if (!c) fails.push(n); };

// ── 靜態 ──
const ck = (CODE.match(/const CACHE_KEY = JSON\.stringify\(\{[^}]*\}\)/) || [''])[0];
ok('ⓐs CACHE_KEY ⛔ 沒有 USSIG(候選層濾網,既有快取照樣重用)', ck && !/USSIG/.test(ck), ck);
// ⚠️ V78.1.2 鏈尾後來又接了 poolOk / rkShamOk(V78.0.7)→ ⛔ 不釘「usOk 是最後一個」(結尾的 `)`),只釘「在候選鏈上、緊接 emOk」
ok('ⓑs usOk 接在候選過濾鏈上(emOk 之後)', /emOk\(x\.t\) && usOk\(x\.t\)(\)| &&)/.test(CODE), '');
ok('ⓒs 缺鍵 = 剔除並計數(⛔ 不放行)', /if \(v == null\) \{ usNoData\+\+; return false; \}/.test(CODE), '');
ok('ⓔs sham 通過率從候選實測量、固定種子 _shamHash', /usFrac = n \? on \/ n : 0/.test(CODE) && /_shamHash\(`\$\{t\.sym\}\|\$\{t\.inD\}\|us`\)/.test(CODE), '');
ok('ⓕs 對照表讀不到 / <100 鍵 → exit 1', /讀不到 USSIG_MAP[^\n]*process\.exit\(1\)/.test(CODE) && /usMap\.size < 100\)[^\n]*process\.exit\(1\)/.test(CODE), '');

// ── 執行期 ──
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
if (!fs.existsSync(path.join(DATA, '^TWII.json'))) { console.log(`❌ ${DATA} 沒有 ^TWII.json → 執行期沒驗到`); fails.push('no-data'); }
else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbus-'));
    const base = { ...process.env, DATA_DIR: DATA, LOT: '150000', CAPITAL: '1000000', SELF: 'high+hivolat', RANK_MIN: '75', VOLAT_MIN: '60', EXIT: 'chand2', MAXD: '20', FILTER: 'bear60', STOPFILL: 'close', WARMUP: '240', TRADES_CACHE: path.join(tmp, 'c.json') };
    for (const k of ['ROTATE', 'COST_X', 'BEAR_EXIT', 'FORCE_EXIT', 'PARK', 'DIV', 'DIV_TRADES', 'FIN_DEEP', 'TURN', 'FIN', 'VAL', 'USSIG', 'USSIG_MAP', 'USSIG_MIN', 'EQUITY_OUT', 'EXIT_SCHED']) delete base[k];
    const run = (tag, extra) => { const r = spawnSync(process.execPath, ['--max-old-space-size=3000', FILE, '25', '2'], { env: { ...base, ...extra, SUMMARY_OUT: path.join(tmp, `s_${tag}.json`), TAKEN_OUT: path.join(tmp, `t_${tag}.json`) }, encoding: 'utf8', timeout: 420000, maxBuffer: 64 << 20 }); let s = null, t = null; try { s = JSON.parse(fs.readFileSync(path.join(tmp, `s_${tag}.json`), 'utf8')); } catch (_) {} try { t = JSON.parse(fs.readFileSync(path.join(tmp, `t_${tag}.json`), 'utf8')); } catch (_) {} return { r, s, t }; };
    const A = run('a', {}), B = run('b', {});
    ok('🚧 基準跑得起來', A.r.status === 0 && A.s && A.s.n > 5 && A.t && A.t.length === A.s.n, `status=${A.r.status} ${(A.r.stderr || A.r.stdout || '').slice(-300)}`);
    ok('ⓐ 決定性對照:不設時兩次逐位相同、summary 沒有 ussig', A.s && B.s && A.s.cum === B.s.cum && A.s.n === B.s.n && !('ussig' in A.s), `${A.s?.cum} vs ${B.s?.cum}`);
    // 對照表:從快取裡的所有候選日期造
    const cache = JSON.parse(fs.readFileSync(path.join(tmp, 'c.json'), 'utf8'));
    const allDays = [...new Set(cache.trades.map(t => t.inD))].sort();
    const mapAll = { kind: 'test', min: 1, map: Object.fromEntries(allDays.map(d => [`*|${d}`, 1])) };
    // 鍵數守門:日期不夠 100 天時補假鍵(不影響候選)
    for (let k = mapAll.map && Object.keys(mapAll.map).length; k < 120; k++) mapAll.map[`ZZZZ|1900-01-${String(k % 28 + 1).padStart(2, '0')}-${k}`] = 1;
    const fAll = path.join(tmp, 'm_all.json'); fs.writeFileSync(fAll, JSON.stringify(mapAll));
    const C = run('all', { USSIG: 'test', USSIG_MAP: fAll, USSIG_MIN: '0' });
    ok('ⓑ 全部日期放行 → 筆數/成績跟不設完全相同、noData = 0', C.r.status === 0 && C.s && C.s.n === A.s.n && C.s.cum === A.s.cum && C.s.ussig && C.s.ussig.noData === 0, `${C.s?.n} vs ${A.s?.n} ・ ${JSON.stringify(C.s?.ussig)}`);
    // 只留一半日期
    const half = { kind: 'test', min: 1, map: Object.fromEntries(allDays.filter((_, i) => i % 2 === 0).map(d => [`*|${d}`, 1])) };
    for (let k = Object.keys(half.map).length; k < 120; k++) half.map[`ZZZZ|1900-01-01-${k}`] = 1;
    const fHalf = path.join(tmp, 'm_half.json'); fs.writeFileSync(fHalf, JSON.stringify(half));
    const H = run('half', { USSIG: 'test', USSIG_MAP: fHalf });
    ok('ⓒ 只留一半日期 → 筆數變少、noData > 0(缺鍵剔除並計數)', H.r.status === 0 && H.s && H.s.n < A.s.n && H.s.ussig.noData > 0, `${H.s?.n} vs ${A.s?.n} ・ ${JSON.stringify(H.s?.ussig)}`);
    // 反向注入:只放行基準裡賠錢那幾筆
    const losers = A.t.filter(x => x.ret < 0);
    const inj = { kind: 'test', min: 1, map: {} };
    for (const x of losers) inj.map[`${x.sym}|${x.d}`] = 1;
    for (let k = Object.keys(inj.map).length; k < 120; k++) inj.map[`ZZZZ|1900-01-01-${k}`] = 1;
    const fInj = path.join(tmp, 'm_inj.json'); fs.writeFileSync(fInj, JSON.stringify(inj));
    const I = run('inj', { USSIG: 'test', USSIG_MAP: fInj });
    ok('ⓓ 反向注入(只放行基準裡賠錢的)→ 成績必低於基準、每筆平均為負', I.r.status === 0 && I.s && I.s.cum < A.s.cum && I.s.per < 0, `${I.s?.cum} vs ${A.s?.cum} ・ per ${I.s?.per}`);
    // sham
    const S1 = run('sh1', { USSIG: 'sham:test', USSIG_MAP: fHalf }), S2 = run('sh2', { USSIG: 'sham:test', USSIG_MAP: fHalf });
    const fracLine = (S1.r.stdout.match(/通過率對齊[^:]*:([\d.]+)%\((\d+)\/(\d+)/) || []);
    ok('ⓔ sham 兩次逐位相同(固定種子)且印出通過率', S1.r.status === 0 && S2.r.status === 0 && S1.s && S2.s && S1.s.cum === S2.s.cum && S1.s.n === S2.s.n && fracLine.length > 3, `${S1.s?.cum} vs ${S2.s?.cum} ・ ${fracLine[0] || '(沒印通過率)'}`);
    if (fracLine.length > 3) {
        // 通過率 = 有鍵的候選裡 score>=min 的比例;half 的鍵全是 1 → 有鍵者 100% 通過,所以對齊值應接近 100%
        ok('ⓔ2 通過率對齊實測(half 對照表鍵值全 1 → ≈100%)', Math.abs(+fracLine[1] - 100) < 3, fracLine[1]);
    }
    const bad = spawnSync(process.execPath, [FILE, '25', '2'], { env: { ...base, USSIG: 'test', USSIG_MAP: path.join(tmp, 'nope.json') }, encoding: 'utf8', timeout: 120000, maxBuffer: 64 << 20 });
    ok('ⓕ 對照表讀不到 → exit 1 並說原因', bad.status === 1 && /讀不到 USSIG_MAP/.test(bad.stderr || ''), (bad.stderr || '').slice(-200));
    const tiny = path.join(tmp, 'm_tiny.json'); fs.writeFileSync(tiny, JSON.stringify({ kind: 'test', min: 1, map: { 'A|2024-01-01': 1 } }));
    const bad2 = spawnSync(process.execPath, [FILE, '25', '2'], { env: { ...base, USSIG: 'test', USSIG_MAP: tiny }, encoding: 'utf8', timeout: 120000, maxBuffer: 64 << 20 });
    ok('ⓕ2 對照表 <100 鍵 → exit 1', bad2.status === 1 && /<100/.test(bad2.stderr || ''), (bad2.stderr || '').slice(-200));
    fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${fails.length ? '❌ ' + fails.length + ' 條沒過' : '✅ 全部通過'}`);
process.exit(fails.length ? 1 : 0);
