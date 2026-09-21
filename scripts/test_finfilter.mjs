#!/usr/bin/env node
/**
 * 📦 V77.4.2 營收 YoY 加速:lib_finaccel + portfolio_backtest 的 FIN=acc|gm|eps|sham 濾網守門
 *   ① finSeries:yoy / acc / gmq / epsy 算對(合成 fin_deep)・負 EPS 用差值  ② finOnAt:pub 之前⛔ 不可知道那一季(法定截止日)、
 *      還沒有任何一季 → null  ③ FIN ⛔ 不進 CACHE_KEY(同 TURN/FILTER 慣例)  ④ 回測與探針都 import lib(⛔ 不可各寫一份 yoy 公式)
 *   ⑤ finOk 對 null 回 false(剔除並計數,⛔ 不可當成通過)  ⑥ sham 跟財報無關、通過率對齊 FIN=acc(⛔ 不寫死三分之一)
 * 注入:① lib 的 `q.pub <= day` 改成 `q.p <= day` → ②b 紅 ② 把 FIN 塞進 CACHE_KEY → ③ 紅 ③ finOk 對 v==null 回 true → ⑤ 紅
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { finSeries, finKnownAt, finOnAt } from './lib_finaccel.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const strip = f => fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');   // ⚠️ 先剝註解(被自己的註解救活已經六次)
const PB = strip('portfolio_backtest.mjs'), AP = strip('accel_probe.mjs'), LIB = strip('lib_finaccel.mjs');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 200)}`); if (!c) fails.push(n); };

// ① 合成 fin_deep:rev 每季 +10%(yoy 固定 46.4%,acc=0)→ 第 8 季 ×1.5(加速)→ 第 9 季回落
const F = ['inv', 'cogs', 'capex', 'dep', 'ocf', 'rev', 'eq', 'cap', 'eps', 'ni'];
const Q = []; for (let y = 2022; y <= 2024; y++) for (const m of ['03-31', '06-30', '09-30', '12-31']) Q.push(`${y}-${m}`);
const S = {}; Q.forEach((p, k) => { const rev = 1000 * Math.pow(1.1, k) * (k === 8 ? 1.5 : 1); S[p] = [null, rev * (k === 8 ? 0.5 : 0.6), null, null, null, rev, null, null, k === 8 ? -1 : (k >= 4 ? 2 : 1), null]; });
const ser = finSeries({ q: Q, f: F, s: { 9999: S } }, '9999');
const q7 = ser.find(x => x.p === Q[7]), q8 = ser.find(x => x.p === Q[8]), q9 = ser.find(x => x.p === Q[9]);
ok('①a 季 8 加速:yoy = 1.1⁴×1.5−1 = +119.6%、acc = +73.2pp、毛利率 +10pp、EPS 差值 −3(負 EPS 用差值)', q8 && Math.abs(q8.yoy - 119.615) < 0.01 && Math.abs(q8.acc - 73.205) < 0.01 && Math.abs(q8.gmq - 10) < 1e-9 && q8.epsy === -3 && q8.ok, JSON.stringify(q8));
ok('①b 季 7 固定成長:yoy = 46.41%、acc = 0(⛔ 不亮:acc 要 >0)', q7 && Math.abs(q7.yoy - 46.41) < 0.01 && Math.abs(q7.acc) < 1e-9, JSON.stringify(q7));
ok('①c 季 9 回落:acc 為負、pub 由 lib_fundamentals 給(季 9 = 2024-06-30 → 2024-08-14)', q9 && q9.acc < 0 && q9.pub === '2024-08-14', JSON.stringify(q9));
ok('①d 序列按 pub 排序、前 5 季 ok=false(算不出 acc)', ser.every((x, i) => !i || x.pub >= ser[i - 1].pub) && ser.slice(0, 5).every(x => !x.ok), '');

// ② 可用日
const pub8 = q8.pub;   // 2024-03-31 → 2024-05-15
ok('② 季 8 的公布日 = 法定截止日 2024-05-15', pub8 === '2024-05-15', pub8);
const dayBefore = '2024-05-14', dayOn = '2024-05-15';
ok('②b pub 前一天「知道」的是季 7(acc=0 → 不亮);pub 當天起才是季 8(亮)—— ⛔ 季末日當可用日就是前視', finKnownAt(ser, dayBefore).p === Q[7] && finOnAt(ser, dayBefore) === false && finKnownAt(ser, dayOn).p === Q[8] && finOnAt(ser, dayOn) === true, `${finKnownAt(ser, dayBefore).p} / ${finOnAt(ser, dayOn)}`);
ok('②c 還沒有任何一季可用 → null(⛔ 不是 false)', finOnAt(ser, '2022-01-01') === null && finKnownAt(ser, '2022-01-01') === null, '');
ok('②d 變體:gm 要 gmq≥0、eps 要 epsy>0(季 8 EPS 差值 −3 → eps 版不亮)', finOnAt(ser, dayOn, 'gm') === true && finOnAt(ser, dayOn, 'eps') === false, '');
ok('②e 沒這檔 → null', finSeries({ q: Q, f: F, s: {} }, '1234') === null && finOnAt(null, dayOn) === null, '');

// ③ CACHE_KEY
const ck = (/const CACHE_KEY = JSON\.stringify\(\{([^}]*)\}\)/.exec(PB) || [])[1] || '';
ok('③0 空過守門:切得到 CACHE_KEY', ck.length > 20, ck);
ok('③ ⛔ FIN 不可進 CACHE_KEY(候選階段的濾網,交易快取要重用 —— 同 TURN/FILTER)', !/\bFIN\b/.test(ck) && !/\bTURN\b/.test(ck), ck);

// ④ 零第二份定義
ok('④a portfolio_backtest import lib_finaccel 的 finSeries/finOnAt', /import \{[^}]*finSeries[^}]*finOnAt[^}]*\} from '\.\/lib_finaccel\.mjs'/.test(PB), '');
ok('④b accel_probe import lib_finaccel 的 finSeries', /import \{ finSeries \} from '\.\/lib_finaccel\.mjs'/.test(AP), '');
const yoyFormula = /rev\s*\/\s*rev4\s*-\s*1/;
ok('④c yoy 公式只住在 lib(回測與探針裡⛔ 不可再出現 rev/rev4−1)', yoyFormula.test(LIB) && !yoyFormula.test(PB) && !yoyFormula.test(AP), '');

// ⑤ finOk 對 null 剔除
const finOkSrc = (/const finOk = t => \{([\s\S]*?)\n\};/.exec(PB) || [])[1] || '';
ok('⑤0 空過守門:切得到 finOk', finOkSrc.length > 100, finOkSrc.slice(0, 80));
ok('⑤ finOk:v == null → return false(剔除並計數,⛔ 不可當成通過)', /if \(v == null\) return false;/.test(finOkSrc), finOkSrc);
ok('⑤b 缺季序列的檔要計數並印出來(finNoData)', /finNoData\+\+/.test(PB) && /缺 \$\{finNoData\} 檔剔除/.test(PB), '');

// ⑥ sham
ok('⑥a sham 走 _shamHash(跟財報無關),而且通過率 = finFrac(從候選實測,⛔ 不寫死 % 3)', /_shamHash\(`\$\{t\.sym\}\|\$\{t\.inD\}\|fin`\)\s*%\s*10000\)\s*<\s*finFrac \* 10000/.test(finOkSrc) && !/% 3 === 0/.test(finOkSrc), finOkSrc);
ok('⑥b finFrac 由 byIn 全部候選算(on / n),空的話 0', /finFrac = n \? on \/ n : 0/.test(finOkSrc), '');
ok('⑥c 候選過濾串上 finOk(x.t)', /turnOk\(x\.t\) && finOk\(x\.t\)\)/.test(PB), '');
ok('⑥d FIN 只認 acc|gm|eps|sham,其他直接停', /\['acc', 'gm', 'eps', 'sham'\]\.includes\(FIN\)/.test(PB) && /process\.exit\(1\)/.test(PB), '');

console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ FINFILTER_PASS');
process.exit(fails.length ? 1 : 0);
