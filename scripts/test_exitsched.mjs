#!/usr/bin/env node
/**
 * 🔄 V77.7.6 `portfolio_backtest.mjs` 的 EXIT_SCHED(照排程換出場規則)守門
 *
 * 起因:使用者要「情勢改變時自動換策略」→ 先回測「照排程換出場」會不會比固定一套好。
 * 釘住:
 *   ⓐ 不設時一個字都不變:EXIT_SCHED ⛔ 不進 CACHE_KEY;stat 鍵的前綴 `_rk` 在不設時是空字串
 *   ⓑ 決定性對照:排程全期同一套 == 直接跑那一套(逐位相同)
 *   ⓒ 真的會換:兩套交替的排程,實際成交兩套都有、成績跟任一套都不同
 *   ⓓ 排程用到沒給快取的規則 → exit 1;快取參數對不上 → exit 1(⛔ 拿別組參數的交易來套等於結論全錯)
 *   ⓔ exit_switch_probe --selftest 全過(零前視 / 決定性注入 / STEP)
 * ⚠️ 真跑引擎(repo `data/` 25 檔),約 3~4 分鐘。
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'scripts', 'portfolio_backtest.mjs');
const CODE = fs.readFileSync(FILE, 'utf8').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 240)}`); if (!c) fails.push(n); };

const ck = (CODE.match(/const CACHE_KEY = JSON\.stringify\(\{[^}]*\}\)/) || [''])[0];
ok('ⓐs CACHE_KEY ⛔ 沒有 EXIT_SCHED', ck && !/EXIT_SCHED|SCHED/.test(ck), ck);
ok('ⓐs2 stat / mkt 鍵走 _rk(不設時空字串)', /const _rk = t => t\._r \? t\._r \+ '#' : '';/.test(CODE) && /stat\[`\$\{_rk\(t\)\}\$\{t\.sym\}\|\$\{t\.key\}`\]/.test(CODE) && /mkt\[_rk\(t\) \+ t\.key\]/.test(CODE), '');
ok('ⓐs3 今天的候選照排程取那一套(不設時仍是 byIn)', /EXIT_SCHED \? \(byInR\.get\(schedRuleOf\(d\)\)/.test(CODE), '');

const sel = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'exit_switch_probe.mjs'), '--selftest'], { encoding: 'utf8' });
ok('ⓔ exit_switch_probe --selftest', sel.status === 0, (sel.stdout || '') + (sel.stderr || ''));

const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
if (!fs.existsSync(path.join(DATA, '^TWII.json'))) { console.log(`❌ ${DATA} 沒有 ^TWII.json → 執行期沒驗到`); fails.push('no-data'); }
else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbsched-'));
    const base = { ...process.env, DATA_DIR: DATA, LOT: '150000', CAPITAL: '300000', SELF: 'high+hivolat', RANK_MIN: '75', VOLAT_MIN: '60', FILTER: 'bear60', STOPFILL: 'close', WARMUP: '240' };
    for (const k of ['ROTATE', 'COST_X', 'BEAR_EXIT', 'FORCE_EXIT', 'PARK', 'DIV', 'DIV_TRADES', 'FIN_DEEP', 'TURN', 'FIN', 'VAL', 'EXIT_SCHED', 'SCHED_CACHES']) delete base[k];
    const run = (tag, extra) => { const r = spawnSync(process.execPath, ['--max-old-space-size=3000', FILE, '25', '2'], { env: { ...base, ...extra, SUMMARY_OUT: path.join(tmp, `s_${tag}.json`) }, encoding: 'utf8', timeout: 420000, maxBuffer: 64 << 20 }); let s = null; try { s = JSON.parse(fs.readFileSync(path.join(tmp, `s_${tag}.json`), 'utf8')); } catch (_) {} return { r, s }; };
    const cA = path.join(tmp, 'a.json'), cB = path.join(tmp, 'b.json');
    const A = run('a', { EXIT: 'don20', MAXD: '20', TRADES_CACHE: cA });
    const B = run('b', { EXIT: 'chand2', MAXD: '20', TRADES_CACHE: cB });
    ok('🚧 兩套固定規則都跑得起來', A.r.status === 0 && B.r.status === 0 && A.s && B.s && A.s.n > 3 && B.s.n > 3, `${A.r.status}/${B.r.status} ${(A.r.stderr || '').slice(-200)}`);
    const tw = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8'));
    const days = (Array.isArray(tw) ? tw : tw.data).map(b => String(b.date).replace(/\//g, '-').slice(0, 10)).sort();
    const months = [...new Set(days.map(d => d.slice(0, 7)))].map(m => days.find(d => d.startsWith(m)));
    const SC = `don20:20=${cA},chand2:20=${cB}`;
    const fix = path.join(tmp, 'fix.json'); fs.writeFileSync(fix, JSON.stringify(Object.fromEntries(months.map(d => [d, 'don20:20']))));
    const F = run('fix', { EXIT: 'chand2', MAXD: '20', EXIT_SCHED: fix, SCHED_CACHES: SC });
    ok('ⓑ 決定性對照:排程全期 don20 == 直接跑 don20(逐位相同)', F.s && A.s && F.s.cum === A.s.cum && F.s.n === A.s.n, `${F.s?.cum} vs ${A.s?.cum} ・${(F.r.stderr || '').slice(-200)}`);
    const alt = path.join(tmp, 'alt.json'); fs.writeFileSync(alt, JSON.stringify(Object.fromEntries(months.map((d, i) => [d, i % 2 ? 'don20:20' : 'chand2:20']))));
    const X = run('alt', { EXIT: 'chand2', MAXD: '20', EXIT_SCHED: alt, SCHED_CACHES: SC });
    const tk = (X.s && X.s.sched && X.s.sched.taken) || {};
    ok('ⓒ 交替排程:實際成交兩套都有', (tk['don20:20'] || 0) > 0 && (tk['chand2:20'] || 0) > 0, JSON.stringify(tk));
    ok('ⓒ2 成績跟任一套固定規則都不同(= 真的在換)', X.s && X.s.cum !== A.s.cum && X.s.cum !== B.s.cum, `${X.s?.cum} / ${A.s?.cum} / ${B.s?.cum}`);
    const miss = run('miss', { EXIT: 'chand2', MAXD: '20', EXIT_SCHED: alt, SCHED_CACHES: `don20:20=${cA}` });
    ok('ⓓ 排程用到沒給快取的規則 → exit 1', miss.r.status === 1 && /沒給它的交易快取/.test(miss.r.stderr || ''), (miss.r.stderr || '').slice(-200));
    const bad = run('bad', { EXIT: 'chand2', MAXD: '20', EXIT_SCHED: alt, SCHED_CACHES: `don20:20=${cB},chand2:20=${cB}` });
    ok('ⓓ2 快取參數對不上 → exit 1', bad.r.status === 1 && /快取參數對不上/.test(bad.r.stderr || ''), (bad.r.stderr || '').slice(-200));
    fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${fails.length ? '❌ ' + fails.length + ' 條沒過' : '✅ 全部通過'}`);
process.exit(fails.length ? 1 : 0);
