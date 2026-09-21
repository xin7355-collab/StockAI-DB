#!/usr/bin/env node
/**
 * 💎 V77.4.4 價值 × 成長 × 週期:lib_value + portfolio_backtest 的 VAL=<kind>|sham:<kind> 濾網守門
 *   ① valueSeries:bvps / roe4 / 去年同季差值 / TTM 分位 / 連續季數 算對(合成 fin_deep 帶**季節性** + ocf/capex 年內累計)
 *   ② valueOnAt:pub 之前⛔ 不可知道那一季(法定截止日)、還沒有任何一季 → null、沒 close → null、14 個 kind 都分派得到
 *   ③ VAL ⛔ 不進 CACHE_KEY(同 TURN/FIN 慣例)  ④ 回測與探針都 import lib(⛔ eq/(cap/10)、ocf + capex 只住 lib)
 *   ⑤ valOk 對 null 回 false + valNoData++(剔除並計數,⛔ 不可當成通過)  ⑥ sham 必須帶 kind、通過率對齊(⛔ 不寫死)、白名單 exit(1)
 *   ⑦ 候選鏈 … && finOk(x.t) && valOk(x.t)
 * 注入:① lib 的 `q.pub <= day` 改成 `q.p <= day` → ②b 紅 ② 把 VAL 塞進 CACHE_KEY → ③ 紅 ③ valOk 對 v==null 回 true → ⑤ 紅
 *      ④ 回測裡自己寫一份 `eq / (cap / 10)` → ④c 紅 ⑤ `k - 4` 改 `k - 1` → ①c 紅(季節性測資才叫得出來)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { valuePrep, valueSeries, valueKnownAt, valueOnAt, KINDS, CYC_IND } from './lib_value.mjs';
import { pubDate } from './lib_fundamentals.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const strip = f => fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');   // ⚠️ 先剝註解(被自己的註解救活已經六次)
const PB = strip('portfolio_backtest.mjs'), VP = strip('value_probe.mjs'), LIB = strip('lib_value.mjs');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 220)}`); if (!c) fails.push(n); };

// ── 合成 fin_deep:季節性 [0.8, 1.0, 1.35, 1.05] × 成長 5%/季;ocf/capex **年內累計**(跟真實 FinMind 一樣) ──
const F = ['inv', 'cogs', 'capex', 'dep', 'ocf', 'rev', 'eq', 'cap', 'eps', 'ni'];
const Q = []; for (let y = 2021; y <= 2024; y++) for (const m of ['03-31', '06-30', '09-30', '12-31']) Q.push(`${y}-${m}`);
const SEAS = [0.8, 1.0, 1.35, 1.05];
const mk = (o = {}) => { const r = {}; let co = 0, cc = 0; Q.forEach((p, k) => { const rev = (o.base ?? 1000) * Math.pow(o.g ?? 1.05, k) * SEAS[k % 4]; const gmr = o.gm ? o.gm(k) : 0.30; const eps = o.eps ? o.eps(k) : 1 + k * 0.1; if (p.endsWith('03-31')) { co = 0; cc = 0; } co += rev * (o.ocfR ? o.ocfR(k) : 0.2); cc -= rev * 0.05; r[p] = [rev * 0.4, rev * (1 - gmr), cc, rev * 0.02, co, rev, o.eq ?? 2e9, o.cap ?? 1e9, eps, o.ni === 'off' ? null : eps * 1e8]; }); return r; };
const FD = { q: Q, f: F, s: { up: mk({ gm: k => 0.30 + k * 0.002, ocfR: k => 0.2 + k * 0.003 }), flat: mk({ g: 1, gm: () => 0.30, eps: () => 1 }), noni: mk({ ni: 'off', eps: k => k >= 10 ? 0.5 : 2 }) } };
const P = valuePrep(FD);
ok('⓪ detectCumulative 判 ocf/capex 累計、rev 單季(⛔ 不憑印象)', P.CUM.ocf === true && P.CUM.capex === true && P.CUM.rev === false, JSON.stringify(P.CUM));

// ① 公式
const up = valueSeries(FD, 'up', P), q15 = up.find(x => x.p === Q[15]), q7 = up.find(x => x.p === Q[7]);
ok('①a bvps = eq ÷ (cap/10) = 2e9 ÷ 1e8 = 20', q15 && Math.abs(q15.bvps - 20) < 1e-9, q15 && q15.bvps);
{ const ni4 = [12, 13, 14, 15].reduce((s, k) => s + (1 + k * 0.1) * 1e8, 0); ok('①b roe4 = Σ近4季淨利 ÷ 期末淨值 × 100', q15 && Math.abs(q15.roe4 - ni4 / 2e9 * 100) < 1e-9, q15 && q15.roe4); }
ok('①c revY 跟**去年同季**比(季節性相同 → 剛好 = 1.05⁴−1 = 21.55%),⛔ 不是上一季', q15 && Math.abs(q15.revY - (Math.pow(1.05, 4) - 1) * 100) < 1e-6 && Math.abs(q15.revQ - ((1.05 * SEAS[3] / SEAS[2]) - 1) * 100) < 1e-6, q15 && `${q15.revY} / ${q15.revQ}`);
ok('①d gmY = +0.8pp(0.002×4×100)・epsY = +0.4', q15 && Math.abs(q15.gmY - 0.8) < 1e-6 && Math.abs(q15.epsY - 0.4) < 1e-9, q15 && `${q15.gmY} / ${q15.epsY}`);
{ const raw = FD.s.up, o4 = raw[Q[15]][4] - raw[Q[14]][4], c4 = raw[Q[15]][2] - raw[Q[14]][2]; ok('①e fcf = 單季 ocf + 單季 capex(Q4 = 累計相減)', q15 && Math.abs(q15.fcf - (o4 + c4)) < 1e-6 && Math.abs(q15.fcf - (raw[Q[15]][4] + raw[Q[15]][2])) > 1, q15 && q15.fcf); }
ok('①f 四項一路同升 → nImp 逐季累積(季 15 ≥ 8)、nDet = 0、lowQ = false', q15 && q15.nImp >= 8 && q15.nDet === 0 && q15.lowQ === false, q15 && `${q15.nImp}/${q15.nDet}`);
ok('①g 前 4 季 revY 算不出(沒有去年同季)→ nImp NaN、earn → null', up.slice(0, 4).every(x => Number.isNaN(x.revY) && Number.isNaN(x.nImp)) && valueOnAt(up, up[3].pub, 'earn') === null, '');
ok('①h ttmPos12:一路成長 → 最新 TTM 是自身最高 → 分位 1.0;零成長 → 全相等 → 0', q15 && Math.abs(q15.ttmPos12 - 1) < 1e-9 && valueSeries(FD, 'flat', P).slice(-1)[0].ttmPos12 === 0, q15 && q15.ttmPos12);
ok('①i 序列按 pub 排序、pub 由 lib_fundamentals 給', up.every((x, i) => !i || x.pub >= up[i - 1].pub) && up.every(x => x.pub === pubDate(x.p)), '');
{ const nn = valueSeries(FD, 'noni', P); const f = nn.find(x => x.par); ok('①j 面額變更守門(沒官方淨利、EPS 掉一半、營收毛利股本沒動)→ 那一季起 roe4/bvps NaN', !!f && f.p === Q[10] && nn.filter(x => x.p >= Q[10]).every(x => Number.isNaN(x.roe4) && Number.isNaN(x.bvps)), f && f.p); }

// ② 可用日 / null / kind
const day0 = q15.pub, dayB = (() => { const t = new Date(day0 + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() - 1); return t.toISOString().slice(0, 10); })();
ok('②a 季 15(2024-12-31)的可用日 = 2025-03-31', day0 === '2025-03-31', day0);
ok('②b pub 前一天「知道」的是季 14;pub 當天起才是季 15 —— ⛔ 季末日當可用日就是前視', valueKnownAt(up, dayB).p === Q[14] && valueKnownAt(up, day0).p === Q[15], `${valueKnownAt(up, dayB).p} / ${valueKnownAt(up, day0).p}`);
ok('②c 還沒有任何一季 → null(⛔ 不是 false)', valueOnAt(up, '2021-01-01', 'earn') === null && valueKnownAt(up, '2021-01-01') === null, '');
ok('②d asset / trap / ab / ac / multi 沒給 close → null(⛔ 不是 false)', ['asset', 'trap', 'ab', 'ac', 'multi'].every(k => valueOnAt(up, day0, k) === null), '');
ok('②e asset:PB 用給的 close(bvps 20 → close 15 = PB 0.75 亮、17 = 0.85 不亮)', valueOnAt(up, day0, 'asset', { close: 15 }) === true && valueOnAt(up, day0, 'asset', { close: 17 }) === false, '');
ok('②f 14 個 kind 都分派得到(不 throw)、不認得的 kind 要 throw', KINDS.every(k => { const v = valueOnAt(up, day0, k, { close: 15 }); return v === true || v === false || v === null; }) && (() => { try { valueOnAt(up, day0, 'nope', {}); return false; } catch (_) { return true; } })(), '');
ok('②g 沒這檔 → null', valueSeries(FD, '1234', P) === null && valueOnAt(null, day0, 'asset', { close: 1 }) === null, '');
ok('②h CYC_IND 全是產業代碼(兩位數字),而且跟 miner.py CYCLICAL_INDUSTRIES 同一組', CYC_IND.every(c => /^\d{2}$/.test(c)) && (() => { const m = /CYCLICAL_INDUSTRIES\s*=\s*\{([\s\S]*?)\}/.exec(fs.readFileSync(path.join(ROOT, 'miner.py'), 'utf8')); const codes = m ? [...m[1].matchAll(/'(\d{2})'/g)].map(x => x[1]).sort() : []; return codes.length && JSON.stringify(codes) === JSON.stringify([...CYC_IND].sort()); })(), CYC_IND.join('/'));

// ③ CACHE_KEY
const ck = (/const CACHE_KEY = JSON\.stringify\(\{([^}]*)\}\)/.exec(PB) || [])[1] || '';
ok('③0 空過守門:切得到 CACHE_KEY', ck.length > 20, ck);
ok('③ ⛔ VAL 不可進 CACHE_KEY(候選階段的濾網,交易快取要重用 —— 同 TURN/FIN)', !/\bVAL\b/.test(ck) && !/\bFIN\b/.test(ck), ck);

// ④ 零第二份定義
ok('④a portfolio_backtest import lib_value 的 valueSeries/valueOnAt', /import \{[^}]*valueSeries[^}]*valueOnAt[^}]*\} from '\.\/lib_value\.mjs'/.test(PB), '');
ok('④b value_probe import lib_value 的 valueSeries/valueOnAt', /import \{[^}]*valueSeries[^}]*valueOnAt[^}]*\} from '\.\/lib_value\.mjs'/.test(VP), '');
const bvpsF = /\beq\s*\/\s*(shares|\(\s*(\w+\.)?cap\s*\/\s*10\s*\))/, fcfF = /\bocf\s*\+\s*(\w+\.)?capex\b/;
ok('④c 每股淨值 / 自由現金流 公式只住在 lib(回測與探針裡⛔ 不可再出現)', bvpsF.test(LIB) && fcfF.test(LIB) && !bvpsF.test(PB) && !fcfF.test(PB) && !bvpsF.test(VP) && !fcfF.test(VP), '');

// ⑤ valOk 對 null 剔除
const valOkSrc = (/const valOk = t => \{([\s\S]*?)\n\};/.exec(PB) || [])[1] || '';
ok('⑤0 空過守門:切得到 valOk', valOkSrc.length > 100, valOkSrc.slice(0, 80));
ok('⑤ valOk:v == null → valNoData++ + return false(剔除並計數,⛔ 不可當成通過)', /if \(v == null\) \{ valNoData\+\+; return false; \}/.test(valOkSrc), valOkSrc);
ok('⑤b 循環類 kind 候選不在循環產業 → valNotCyc++ + return false', /if \(v === 'notcyc'\) \{ valNotCyc\+\+; return false; \}/.test(valOkSrc) && /VAL_CYC && !CYC_IND\.includes\(valInd\.get\(sym\)\)/.test(PB), '');
ok('⑤c 剔除的筆數要印出來', /valNoData\.toLocaleString\(\)/.test(PB) && /valNotCyc\.toLocaleString\(\)/.test(PB), '');

// ⑥ sham
ok('⑥a sham 走 _shamHash(跟財報無關),通過率 = valFrac(從候選實測,⛔ 不寫死)', /_shamHash\(`\$\{t\.sym\}\|\$\{t\.inD\}\|val`\)\s*%\s*10000\)\s*<\s*valFrac \* 10000/.test(valOkSrc) && !/% 3 === 0/.test(valOkSrc), valOkSrc);
ok('⑥b valFrac 由 byIn 全部候選對 VAL_KIND 實測(on / n)', /valFrac = n \? on \/ n : 0/.test(valOkSrc) && /valRaw\(x\.sym, x\.inD\)/.test(valOkSrc), '');
ok('⑥c sham 必須帶 kind(VAL_KIND = sham: 後面那段),而且對照的是同一個 kind', /const VAL_KIND = VAL\.startsWith\('sham:'\) \? VAL\.slice\(5\) : VAL;/.test(PB), '');
ok('⑥d VAL 只認 lib 的 KINDS(+ sham:<kind>),其他直接停', /!VAL_KINDS\.includes\(VAL_KIND\)/.test(PB) && /process\.exit\(1\)/.test(PB), '');
ok('⑥e ⛔ 不擴充 FIN= 白名單(sham 的對齊目標不同)', /\['acc', 'gm', 'eps', 'sham'\]\.includes\(FIN\)/.test(PB), '');

// ⑦ 候選鏈
ok('⑦ 候選過濾串上 valOk(x.t)(在 finOk 之後)', /finOk\(x\.t\) && valOk\(x\.t\)\)/.test(PB), '');
ok('⑦b selfFeat 在 VAL 時也要建(PB 要訊號日收盤)', /if \(SELF\.length \|\| TURN \|\| VAL\) \{/.test(PB), '');

console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ VALUE_PASS');
process.exit(fails.length ? 1 : 0);
