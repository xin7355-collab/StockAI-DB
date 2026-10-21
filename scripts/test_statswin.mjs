#!/usr/bin/env node
/**
 * 🪟 V79.4.6 `portfolio_backtest.mjs` 每檔打法成績回看視窗(STATS_WIN / STATS_FROM)守門
 *
 * 為什麼有這個開關:App 的 K 線最多 1,200 根(miner.py `LIMIT 1200`)→ playbook_scan 只看得到最近 ≤1,200 根算每檔成績;
 *   引擎以前從資料第一天一路累加 → 2010 起的資料到 2022 年已經吃了 12 年 → 近 4 年 🔥 +159 萬 vs 只有 2021-10 起資料時 +413 萬。
 *
 * 釘住:
 *   ⓐ 不設時一個字都不變:兩個都⛔ 不進 CACHE_KEY;STATS_WIN=99999 / STATS_FROM=1900-01-01 跟不設逐位相同(含逐日淨值)
 *   ⓑ 真的生效:STATS_WIN=60 有扣回的筆數、成績跟不設不一樣;STATS_FROM 中段日期成績不一樣
 *   ⓒ 扣回時 n 歸零 sum 直接設 0(⛔ 留浮點殘差);掉出視窗的才扣、還在視窗內的⛔ 不扣(進場日判,⛔ 不是出場日)
 *   ⓓ 設錯格式 → exit 1(⛔ 靜默當成沒設)
 * ⚠️ 真跑引擎(repo `data/`,MAX_SYMS=25),約 2~3 分鐘。
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
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 260)}`); if (!c) fails.push(n); };

// ── 靜態 ──
const ck = (CODE.match(/const CACHE_KEY = JSON\.stringify\(\{[^}]*\}\)/) || [''])[0];
ok('ⓐs CACHE_KEY ⛔ 沒有 STATS_WIN / STATS_FROM', ck && !/STATS_WIN|STATS_FROM/.test(ck), ck);
ok('ⓒs 進場日判視窗(calIdx(t.inD)),⛔ 不是出場日', /const swI = STATS_WIN \? calIdx\(t\.inD\) : -1;/.test(CODE) && /if \(STATS_WIN && swI < i - STATS_WIN\) continue;/.test(CODE));
ok('ⓒs2 每天把進場日掉出視窗的扣回去(stat 與 mkt 都扣)', /for \(; swPtr < i - STATS_WIN; swPtr\+\+\)/.test(CODE) && /s\.n--; s\.sum = s\.n \? s\.sum - b\[q \+ 2\] : 0;/.test(CODE) && /m\.n--; m\.sum = m\.n \? m\.sum - b\[q \+ 2\] : 0;/.test(CODE));
ok('ⓒs3 扣回要在挑候選之前(⛔ 不然今天還用到掉出視窗的成績)', (() => { const a = CODE.indexOf('for (; swPtr < i - STATS_WIN; swPtr++)'), b = CODE.indexOf('const cand = todays'); return a > 0 && b > a; })());
ok('ⓓs 設錯格式要 exit 1', /STATS_WIN=\$\{_swRaw\} 不認得[^\n]*process\.exit\(1\)/.test(CODE) && /STATS_FROM=\$\{STATS_FROM\} 不認得[^\n]*process\.exit\(1\)/.test(CODE));

// ── 執行期 ──
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
if (!fs.existsSync(path.join(DATA, '^TWII.json'))) { console.log(`❌ ${DATA} 沒有 ^TWII.json → 執行期沒驗到`); fails.push('no-data'); }
else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbsw-'));
    const base = { ...process.env, DATA_DIR: DATA, LOT: '150000', SELF: 'high+hivolat', RANK_MIN: '75', VOLAT_MIN: '60', EXIT: 'chand2', MAXD: '20', FILTER: 'bear60', STOPFILL: 'close', WARMUP: '240', TRADES_CACHE: path.join(tmp, 'c.json') };
    for (const k of ['STATS_WIN', 'STATS_FROM', 'VOLCAP', 'EQGATE', 'ROTATE', 'COST_X', 'PARK', 'DIV', 'DIV_TRADES', 'EQUITY_OUT', 'YEAR']) delete base[k];
    const run = (tag, extra) => {
        const r = spawnSync(process.execPath, ['--max-old-space-size=3000', FILE, '25', '2'], { env: { ...base, ...extra, SUMMARY_OUT: path.join(tmp, `s_${tag}.json`), EQUITY_OUT: path.join(tmp, `e_${tag}.json`) }, encoding: 'utf8', timeout: 420000, maxBuffer: 64 << 20 });
        let s = null, e = null;
        try { s = JSON.parse(fs.readFileSync(path.join(tmp, `s_${tag}.json`), 'utf8')); } catch (_) {}
        try { e = fs.readFileSync(path.join(tmp, `e_${tag}.json`), 'utf8'); } catch (_) {}
        return { r, s, e };
    };
    const core = s => s && JSON.stringify({ n: s.n, cum: s.cum, per: s.per, dd: s.dd, win: s.win, skipped: s.skipped, byYear: s.byYear, from: s.from, to: s.to });
    const A = run('a', {});
    ok('🚧 基準跑得起來', A.r.status === 0 && A.s && A.s.n > 5, `status=${A.r.status} ${(A.r.stderr || A.r.stdout || '').slice(-300)}`);
    ok('ⓐ 不設時 summary 沒有 stats、cfg 沒有 statsWin / statsFrom', A.s && !('stats' in A.s) && A.s.cfg && !('statsWin' in A.s.cfg) && !('statsFrom' in A.s.cfg), JSON.stringify(A.s?.cfg));
    const W9 = run('w9', { STATS_WIN: '99999' });
    ok('ⓐ2 決定性對照:STATS_WIN=99999 跟不設逐位相同(成績 + 逐日淨值)、扣回 0 筆', W9.s && core(W9.s) === core(A.s) && W9.e === A.e && W9.s.stats && W9.s.stats.dropped === 0, `${core(W9.s)} vs ${core(A.s)} dropped=${W9.s?.stats?.dropped}`);
    const F0 = run('f0', { STATS_FROM: '1900-01-01' });
    ok('ⓐ3 決定性對照:STATS_FROM=1900-01-01 跟不設逐位相同', F0.s && core(F0.s) === core(A.s) && F0.e === A.e, `${core(F0.s)} vs ${core(A.s)}`);
    const W60 = run('w60', { STATS_WIN: '60' });
    ok('ⓑ STATS_WIN=60 真的有扣回、成績跟不設不一樣', W60.r.status === 0 && W60.s && W60.s.stats && W60.s.stats.dropped > 0 && core(W60.s) !== core(A.s) && W60.s.cfg.statsWin === 60, `dropped=${W60.s?.stats?.dropped} ${core(W60.s)} ${(W60.r.stderr || '').slice(-200)}`);
    const tw = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8'));
    const mid = String(tw[Math.floor(tw.length * 0.6)].date).replace(/\//g, '-').slice(0, 10);
    const FM = run('fm', { STATS_FROM: mid });
    ok(`ⓑ2 STATS_FROM=${mid}(中段)成績跟不設不一樣、cfg 記下`, FM.r.status === 0 && FM.s && core(FM.s) !== core(A.s) && FM.s.cfg.statsFrom === mid, `${core(FM.s)} ${(FM.r.stderr || '').slice(-200)}`);
    const BAD = run('bad', { STATS_WIN: 'abc' }), BAD2 = run('bad2', { STATS_FROM: '2021/10/08' });
    ok('ⓓ STATS_WIN=abc → exit 1 並說原因', BAD.r.status === 1 && /STATS_WIN=abc 不認得/.test(BAD.r.stderr || ''), (BAD.r.stderr || '').slice(-200));
    ok('ⓓ2 STATS_FROM=2021/10/08 → exit 1 並說原因', BAD2.r.status === 1 && /STATS_FROM=2021\/10\/08 不認得/.test(BAD2.r.stderr || ''), (BAD2.r.stderr || '').slice(-200));
    fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ test_statswin 全過');
process.exit(fails.length ? 1 : 0);
