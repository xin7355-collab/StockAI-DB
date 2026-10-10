#!/usr/bin/env node
/**
 * 💵 V79.0.7 盈餘品質避雷濾網守門(lib_accrual + portfolio_backtest ACCR= + leader_probe accAvoid)
 *   ① 月門檻:最高 40% 的切法跟 accrual_probe 的五等分一樣(第 k 名,k ≥ 0.6n)・樣本不足回 null
 *   ② 用的是「嚴格早於那個月 1 號」已公布的季報(零前視)
 *   ③ 不知道 → null(呼叫端保留:避雷型,跟 FIN/VAL 的「剔除」刻意相反)
 *   ④ portfolio_backtest:用 lib(⛔ 不寫第二份)・⛔ 不進 CACHE_KEY・接上候選那一行・sham 對齊 hi・一筆沒剔除要停
 *   ⑤ leader_probe:用 lib・need() 擋沒給資料・金融股排除
 *   ⑥ accrual_probe 用同一份 lib(搬家後 ⛔ 不可留第二份公式)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { accrualMonthCut, accrualHiAt, knownBefore } from './lib_accrual.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const strip = f => fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 200)}`); if (!c) fails.push(n); };

// ① ② ③ lib
const ACC = new Map();
for (let k = 0; k < 200; k++) ACC.set(String(1000 + k), [{ p: '2023-03-31', pub: '2023-05-15', acc: k }, { p: '2023-06-30', pub: '2023-08-14', acc: 199 - k }]);
const cut = accrualMonthCut(ACC, 0.6, 100);
const c6 = cut('2023-06-20');
ok('①a 200 檔 acc = 0..199 → 最高 40% 的門檻 = 120(第 120 名起)', c6 && c6.cut === 120 && c6.n === 200, JSON.stringify(c6));
ok('①b 119 不在、120 在最高 40%', accrualHiAt(ACC, cut, '1119', '2023-06-20') === false && accrualHiAt(ACC, cut, '1120', '2023-06-20') === true, '');
ok('①c 剛好 40% 的檔被標高(80/200)', [...ACC.keys()].filter(s => accrualHiAt(ACC, cut, s, '2023-06-02')).length === 80, '');
ok('①d 樣本不到 minN → null', accrualMonthCut(new Map([...ACC].slice(0, 50)), 0.6, 100)('2023-06-20') === null, '');
ok('②a 8/14 公布的那一季,8 月還不能用(8/1 用 Q1 → 1120 仍是高)', accrualHiAt(ACC, cut, '1120', '2023-08-20') === true, '');
ok('②b 9 月才換成 Q2(1120 的 Q2 acc = 79 → 不在最高 40%)', accrualHiAt(ACC, cut, '1120', '2023-09-04') === false, '');
ok('②c knownBefore 公布日當天 ⛔ 不可用', knownBefore(ACC.get('1000'), '2023-05-15') === null && knownBefore(ACC.get('1000'), '2023-05-16').p === '2023-03-31', '');
ok('③ 沒有季報的檔 → null(不是 false)', accrualHiAt(ACC, cut, '9999', '2023-06-20') === null && accrualHiAt(ACC, cut, '1000', '2023-04-20') === null, '');

// ④ portfolio_backtest
const PB = strip('portfolio_backtest.mjs');
const ck = (/const CACHE_KEY = JSON\.stringify\(\{([^}]*)\}\)/.exec(PB) || [])[1] || '';
ok('④0 空過守門:切得到 CACHE_KEY', ck.length > 20, ck);
ok('④a ⛔ ACCR 不進 CACHE_KEY(候選階段的濾網,交易快取要重用)', !/ACCR/.test(ck), ck);
ok('④b 用 lib_accrual(⛔ 不自己再寫一份)', /from '\.\/lib_accrual\.mjs'/.test(PB) && !/function accrualSeries/.test(PB), '');
ok('④c 候選那一行接上 accrOk', /valOk\(x\.t\) && accrOk\(x\.t\) && emOk\(x\.t\)/.test(PB), '');
const fn = PB.slice(PB.indexOf('const accrOk = t => {'), PB.indexOf('const accrOk = t => {') + 1200);
ok('④d0 空過守門:切得到 accrOk', fn.length > 400, String(fn.length));
ok('④d 不知道 → 保留(return true),而且計數', /if \(hi == null\) \{ accSeen\.unk\.add\(key\); return true; \}/.test(fn), fn.slice(0, 200));
ok('④e sham 剔除率由 hi 在同一批候選上實測對齊(⛔ 不寫死)', /accFrac = n \? on \/ n : 0/.test(fn) && /_shamHash\(`\$\{t\.sym\}\|\$\{t\.inD\}\|acc`\)/.test(fn), '');
ok('④f 一筆都沒剔除 → 停(空過守門)', /if \(!accSeen\.cut\.size\)[^\n]*process\.exit\(1\)/.test(PB), '');
ok('④g 讀不到 fin_deep / industry_map → 停(⛔ 不靜默放行)', /ACCR 要用 fin_deep\.json[^\n]*process\.exit\(1\)/.test(PB) && /ACCR 要 industry_map\.json[^\n]*process\.exit\(1\)/.test(PB), '');
ok('④h 金融股(產業 17)不進門檻', /if \(String\(IND\[sym\] \|\| ''\) === '17'\) continue; const a = accrualSeries/.test(PB), '');

// ⑤ leader_probe
const LP = strip('leader_probe.mjs');
ok('⑤a leader_probe 用 lib_accrual', /from '\.\/lib_accrual\.mjs'/.test(LP), '');
ok('⑤b 候選濾網有 accAvoid,不知道保留並計數', /if \(hi === null\) st\.accUnk\+\+;/.test(LP) && /if \(drop\) \{ st\.accCut\+\+; return false; \}/.test(LP), '');
ok('⑤c 沒給 FIN_DEEP + IND_MAP → need() 拒跑', /need\('accAvoid', ctx\.accHi, 'FIN_DEEP \+ IND_MAP'\)/.test(LP), '');
ok('⑤d 金融股排除', /if \(String\(ind\[S\.sym\] \|\| ''\) === '17'\) continue; const a = accrualSeries/.test(LP), '');

// ⑥ accrual_probe 搬家
const AP = strip('accrual_probe.mjs');
ok('⑥ accrual_probe import lib,⛔ 不留第二份 accrualSeries', /import \{ accrualSeries, knownBefore \} from '\.\/lib_accrual\.mjs'/.test(AP) && !/function accrualSeries/.test(AP), '');

console.log(fails.length ? `\n❌ ${fails.length} 條失敗:${fails.join(' / ')}` : '\n✅ ACCRFILTER_PASS');
process.exit(fails.length ? 1 : 0);
