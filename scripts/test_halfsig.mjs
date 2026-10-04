#!/usr/bin/env node
/**
 * ✂️ V78.4.9 回測引擎 HALFSIG(持有中出現賣出彈窗那種訊號 → 當天收盤先賣一半)守門
 *   ① 不設 → CACHE_KEY 一字不變(HALFSIG 只在設了才進鍵)
 *   ② 認不得的值 → exit 1(⛔ 不可靜默當成沒設)
 *   ③ gate 走 App 同一條路(_KBAR_DET_LIST + _tagPush + _alertWorthIt),⛔ 不另寫一份判定
 *   ④ 小樣本真跑:gate 一定有交易被先賣一半(hf),而且一天都沒亮要 exit 1 的守門在
 */
import fs from 'fs';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'scripts/portfolio_backtest.mjs'), 'utf8');
let fails = 0;
const ok = (n, c, e = '') => { if (c) console.log(`✅ ${n}`); else { fails++; console.log(`❌ ${n}${e ? '  ' + String(e).slice(0, 300) : ''}`); } };

ok('① HALFSIG 只在設了才進 CACHE_KEY', /\.\.\.\(HALFSIG \? \{ HALFSIG \} : \{\}\)/.test(SRC));
const r = spawnSync('node', [path.join(ROOT, 'scripts/portfolio_backtest.mjs'), '5', '2'], { env: { ...process.env, HALFSIG: 'bogus' }, encoding: 'utf8' });
ok('② HALFSIG=bogus → exit 1', r.status === 1 && /不認得/.test(r.stderr + r.stdout), (r.stderr || '').slice(0, 200));
const body = SRC.slice(SRC.indexOf('const hsAt = j =>'), SRC.indexOf('_hsM.set(j, v)'));
ok('③ gate 走 App 的 _KBAR_DET_LIST / _tagPush / _alertWorthIt(⛔ 不另寫判定)',
    /app\._KBAR_DET_LIST/.test(body) && /app\._tagPush/.test(body) && /app\._alertWorthIt/.test(body) && !/streak|riseP/.test(body), body.slice(0, 200));
ok('④ 一天都沒亮 → exit 1 的空過守門還在', /HALFSIG 一天都沒亮/.test(SRC) && /process\.exit\(1\)/.test(SRC.slice(SRC.indexOf('HALFSIG 一天都沒亮') - 200, SRC.indexOf('HALFSIG 一天都沒亮') + 200)));
const DD = process.env.DATA_DIR;
if (DD && fs.existsSync(DD)) {
    const tmp = path.join(process.env.TMPDIR || '/tmp', `hs_${process.pid}.json`);
    const out = execFileSync('node', [path.join(ROOT, 'scripts/portfolio_backtest.mjs'), '20', '2'],
        { env: { ...process.env, HALFSIG: 'gate', EXIT: 'chand2', MAXD: '20', STOPFILL: 'close', TRADES_CACHE: tmp }, encoding: 'utf8', maxBuffer: 1 << 26 });
    const m = /先賣一半 ([\d,]+) \/ ([\d,]+) 筆/.exec(out);
    ok('④ 小樣本真跑:gate 有交易被先賣一半', m && +m[1].replace(/,/g, '') > 0, out.split('\n').filter(l => /HALFSIG/.test(l)).join(' '));
    try { fs.unlinkSync(tmp); } catch (_) {}
} else console.log('⏭️ 沒設 DATA_DIR → 略過真跑(只做靜態檢查)');
console.log(fails ? `\n❌ HALFSIG_FAIL(${fails})` : '\n✅ HALFSIG_PASS');
process.exit(fails ? 1 : 0);
