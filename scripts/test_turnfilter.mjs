#!/usr/bin/env node
/**
 * 🔄 V77.3.3 週轉率濾網守門(portfolio_backtest.mjs 的 TURN=lo|mid|hi|sham)
 *   ① 三分位切分:邊界 / 樣本不足回 null / NaN 剔除  ② `TURN` ⛔ 不可進 CACHE_KEY(同 FILTER 慣例:換濾網要重用交易快取)
 *   ③ 回測腳本要用 lib 那一份(⛔ 不可自己再寫一份切分)  ④ 沒有集保總股數要「剔除並計數」,⛔ 不可當成通過
 *   ⑤ sham 是安慰劑:跟週轉率無關、固定種子、約三分之一
 * 注入:① 把 `< cuts[0]` 改成 `<=` → ①b 紅 ② 把 TURN 塞進 CACHE_KEY → ② 紅 ③ `turnOk` 對 v==null 回 true → ④ 紅
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { turnCuts, turnBucket } from './lib_turnover.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'portfolio_backtest.mjs'), 'utf8');
const CODE = SRC.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');   // ⚠️ 先剝註解(被自己的註解救活已經六次)
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 200)}`); if (!c) fails.push(n); };

// ① 切分
const vals = Array.from({ length: 90 }, (_, i) => i + 1);          // 1..90 → P33 = 31、P66 = 61
const cuts = turnCuts(vals);
ok('①a 90 個值切成三分位:切點 [31, 61]', JSON.stringify(cuts) === '[31,61]', JSON.stringify(cuts));
ok('①b 邊界:30 → lo、31 → mid、60 → mid、61 → hi(切點本身歸上一桶)', turnBucket(30, cuts) === 'lo' && turnBucket(31, cuts) === 'mid' && turnBucket(60, cuts) === 'mid' && turnBucket(61, cuts) === 'hi', [30, 31, 60, 61].map(v => turnBucket(v, cuts)).join());
ok('①c 樣本不到 30 → null(切不出三分位;呼叫端當「沒切點」→ 剔除)', turnCuts([1, 2, 3]) === null && turnBucket(5, null) === null, '');
ok('①d NaN / null 不進切分、也分不進桶', JSON.stringify(turnCuts([...vals, NaN, null, undefined])) === '[31,61]' && turnBucket(null, cuts) === null && turnBucket(NaN, cuts) === null, '');
// ② CACHE_KEY
const ck = (/const CACHE_KEY = JSON\.stringify\(\{([^}]*)\}\)/.exec(CODE) || [])[1] || '';
ok('②0 空過守門:切得到 CACHE_KEY', ck.length > 20, ck);
ok('② ⛔ TURN 不可進 CACHE_KEY(週轉率是候選階段的濾網,交易快取要重用 —— 同 FILTER 慣例)', !/\bTURN\b/.test(ck) && !/FILTER/.test(ck), ck);
// ③ 用 lib
ok('③ 回測腳本 import lib_turnover(⛔ 不自己再寫一份切分)', /import \{ turnCuts, turnBucket \} from '\.\/lib_turnover\.mjs'/.test(CODE) && !/const turnCuts = /.test(CODE), '');
// ④ 沒有總股數 → 剔除
const fn = CODE.slice(CODE.indexOf('const turnOk = t => {'), CODE.indexOf('const turnOk = t => {') + 700);
ok('④0 空過守門:切得到 turnOk', fn.length > 200, String(fn.length));
ok('④ 沒有週轉率(沒集保總股數)→ return false(⛔ 不可當成通過)', /if \(v == null\) return false;/.test(fn), fn.slice(0, 200));
ok('④b 缺總股數的檔要「計數並印出來」(⛔ 不靜默)', /turnNoT\+\+/.test(CODE) && /缺 \$\{turnNoT\} 檔剔除/.test(CODE), '');
ok('④c 讀不到 tdcc_holders.json 要直接停(⛔ 不靜默放行)', /讀不到 tdcc_holders\.json[\s\S]{0,80}process\.exit\(1\)/.test(CODE), '');
// ⑤ sham
ok('⑤ sham = 固定種子雜湊三分之一,跟週轉率無關', /TURN === 'sham'/.test(fn) && /% 3 === 0/.test(fn) && /_shamHash\(`\$\{t\.sym\}\|\$\{t\.inD\}\|turn`\)/.test(fn), fn.slice(0, 200));
ok('⑤b 候選濾網那一行真的接上 turnOk(⛔ 寫好沒接 = 陷阱 #37)', /selfOk\(x\.t\) && sigOk\(x\.t\) && turnOk\(x\.t\)/.test(CODE), '');
// ⑥ 切點是「當天橫斷面」不是全期(⛔ 寫死 % 會變成只在熱絡日進場)
ok('⑥ 切點按交易日各算一份(turnCutByDay),桶用 t.inD 那天的切點', /turnCutByDay\.set\(d, turnCuts\(a\)\)/.test(CODE) && /turnBucket\(v, turnCutByDay\.get\(t\.inD\)\) === TURN/.test(fn), '');

console.log(fails.length ? `\n❌ ${fails.length} 條失敗:${fails.join(' / ')}` : '\n✅ TURNFILTER_PASS');
process.exit(fails.length ? 1 : 0);
