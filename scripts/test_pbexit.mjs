#!/usr/bin/env node
/**
 * 🚨 V77.4.9 `portfolio_backtest.mjs` 的 EXIT 解析守門
 *
 * 真 bug:App 的設定 key 是 `don`,而回測只認 `/^don(\d+)w?$/` → 裸字 `EXIT=don` **從來沒被認得**,
 *   整支靜默退回「只有停損 + 抱滿 20 天」,log 卻照印「出場=don/20日」。受害:V76.0.5 ADD / V77.3.3 TURN /
 *   V77.4.2 FIN / V77.4.4 VAL 的「現行配置」基準,以及 weekly_backtest.yml 的 `EXIT: don`。
 * 同版另兩件:
 *   ・don55 在歷史前段 `data[j − 55]` 取到負索引直接崩(以前只測過 don10/don20)
 *   ・WARMUP 做成可調(起點穩健性檢定)—— ⛔ 不可進 CACHE_KEY(它只影響模擬,交易快取要重用)
 *
 * 注入(逐一確認會紅):拿掉 don 別名 / 拿掉認不得就 exit 1 / CACHE_KEY 用原字 EXIT_RAW / don 迴圈拿掉 Math.max(0, …)
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = process.env.PB_FILE || path.join(ROOT, 'scripts', 'portfolio_backtest.mjs');
const SRC = fs.readFileSync(FILE, 'utf8');
const CODE = SRC.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');   // ⚠️ 先剝註解(被自己的註解救活已經七次)
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 220)}`); if (!c) fails.push(n); };

// ① 別名
const alias = (/const _EXIT_ALIAS = (\{[^}]*\})/.exec(CODE) || [])[1] || '';
ok('①0 空過守門:切得到 _EXIT_ALIAS', alias.length > 5, alias);
ok('① 🚨 裸字 don → don20(App 的設定 key 就是 don)', /don:\s*'don20'/.test(alias), alias);
ok('①b EXIT 用正規化後的名字(`EXIT = _EXIT_ALIAS[EXIT_RAW] || EXIT_RAW`)', /const EXIT = _EXIT_ALIAS\[EXIT_RAW\] \|\| EXIT_RAW;/.test(CODE), '');
// ② 認不得 → exit 1(執行期,不需要資料)
const run = (exit) => spawnSync(process.execPath, [FILE, '3', '2'], { env: { ...process.env, EXIT: exit, DATA_DIR: '/nonexistent_pbexit' }, encoding: 'utf8', timeout: 30000 });
const bad = run('foo');
// ⚠️ DATA_DIR 故意給不存在的 —— 如果守門沒有自己停下,後面會因為 ENOENT 崩掉,那**也是 status 1**
//    (注入「拿掉 exit(1)」第一次就是這樣被救活的)→ 必須是「乾淨地」因為不認得而停,⛔ 不可有其他錯誤
ok('② 🚨 EXIT=foo → exit 1 而且說出來(⛔ 不可靜默退回「不執行出場」)', bad.status === 1 && /不認得/.test(bad.stderr + bad.stdout) && !/ENOENT|Error:|at /.test(bad.stderr || ''), `status=${bad.status} ${(bad.stderr || '').slice(0, 160)}`);
// ⚠️ 只看 EXIT 那一行(VAL= 那行也有「不認得」,會救活)
ok('②s 靜態:印完「不認得」就是 process.exit(1)', /EXIT=\$\{EXIT_RAW\} 不認得[^\n]*\);\s*process\.exit\(1\);/.test(CODE), '');
const bad2 = run('donn20');
ok('②b 打錯字 donn20 也要擋', bad2.status === 1, `status=${bad2.status}`);
// ③ 全 repo 用過的 EXIT 值都要被接受(⛔ 守門不可誤殺既有的實驗)
const used = new Set();
for (const f of ['docs/DECISIONS.md', 'CLAUDE.md', 'pro.html', '.github/workflows/weekly_backtest.yml']) {
    try { const t = fs.readFileSync(path.join(ROOT, f), 'utf8'); for (const m of t.matchAll(/EXIT[=:]\s*([A-Za-z0-9_.]+)/g)) used.add(m[1]); } catch (_) {}
}
['ma5', 'ma10', 'ma20', 'trail8', 'chand2', 'chand2.5', 'chandd3', 'atrt3', 'don10', 'don10w', 'don20', 'don30', 'don55', 'plow', 'sar', 'x5_20', 'none', 'ma5tp10', 'ma5be5', 'ma5rr2', 'ma5half10', 'ma5tm5_0', 'nonetm5_2'].forEach(x => used.add(x));
const reOK = (() => { const m = /const _EXIT_OK = (\/.*\/);/.exec(CODE); try { return m ? eval(m[1]) : null; } catch (_) { return null; } })();
const aliasObj = (() => { try { return eval('(' + alias + ')'); } catch (_) { return {}; } })();
// ⚠️ 文件裡的 `chandK` / `donN` 是**佔位字**(大寫字母 = 代數),⛔ 不是真的參數
const rejected = [...used].filter(x => !/[A-Z]/.test(x)).filter(x => !(reOK && reOK.test(aliasObj[x] || x)));
ok('③ 全 repo 文件與 workflow 用過的 EXIT 值全部被接受(⛔ 守門不可誤殺)', reOK && rejected.length === 0, rejected.join(','));
// ④ CACHE_KEY 用正規化後的 EXIT;WARMUP 不進去
const ck = (/const CACHE_KEY = JSON\.stringify\(\{([^}]*)\}\)/.exec(CODE) || [])[1] || '';
ok('④0 空過守門:切得到 CACHE_KEY', ck.length > 20, ck);
ok('④ CACHE_KEY 用 EXIT(正規化後)⛔ 不是 EXIT_RAW → don 與 don20 共用同一份快取', /\bEXIT\b/.test(ck) && !/EXIT_RAW/.test(ck), ck);
ok('④b ⛔ WARMUP 不可進 CACHE_KEY(它只影響模擬;進去的話換起點就要重掃 9 分鐘)', !/WARMUP/.test(ck), ck);
ok('④c WARMUP 可由環境變數調(起點穩健性檢定),預設仍是 240', /process\.env\.WARMUP \|\| 240/.test(CODE), '');
// ⑤ don55 不再崩
ok('⑤ 🐛 唐奇安回看從 Math.max(0, j − donN) 起算(⛔ don55 在歷史前段會取到負索引直接崩)', /for \(let q = Math\.max\(0, j - donN\); q < j; q\+\+\)/.test(CODE), '');

console.log();
console.log(fails.length ? `❌ ${fails.length} 條失敗` : '✅ PBEXIT_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
