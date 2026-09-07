/** 📅 財報公布日規則的共用函式 —— ⛔ 這一步錯了整份回測就是前視 */
import { pubDate, knownAsOf, doi, DEADLINES } from './lib_fundamentals.mjs';
let f = 0;
const ok = (n, c, x = '') => { console.log((c ? '✅ ' : '❌ ') + n + (c ? '' : `  ${x}`)); if (!c) f++; };

ok('① 四季各自對到法定公布期限',
   pubDate('2025-03-31') === '2025-05-15' && pubDate('2025-06-30') === '2025-08-14'
   && pubDate('2025-09-30') === '2025-11-14' && pubDate('2025-12-31') === '2026-03-31');
ok('② 🚨 Q4 要跨到**隔年**(⛔ 同年 3/31 = 提早一年知道 = 嚴重前視)',
   pubDate('2024-12-31') === '2025-03-31');
ok('③ 看不懂的輸入回 null(⛔ 不可硬給一個日期)',
   pubDate('') === null && pubDate('abc') === null && pubDate('2025-07-31') === null);

const P = ['2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31'];
ok('④ 公布日**當天**算已知,前一天不算(⛔ 差一天就是前視)',
   knownAsOf(P, '2025-08-14') === '2025-06-30' && knownAsOf(P, '2025-08-13') === '2025-03-31');
ok('⑤ 都還沒公布 → null(⛔ 不可退回最舊那一季)', knownAsOf(P, '2025-01-01') === null);
ok('⑥ 🚨 2026-01 時 Q4 還沒公布 → 只能用 Q3(⛔ 不可用 Q4)',
   knownAsOf(P, '2026-01-05') === '2025-09-30');

ok('⑦ 存貨週轉天數 = 存貨 ÷ 單季營業成本 × 90', Math.round(doi(200, 400) * 100) / 100 === 45);
ok('⑧ 算不出來要回 null(⛔ 不可回 0 或 Infinity)',
   doi(0, 400) === null && doi(200, 0) === null && doi(null, 400) === null);

// ⑨ V74.9.3:6 份 inline 的同一條規則已換成共用版(等值先驗過:164 個季末日四份輸出逐字相同)
//    → ⛔ scripts/ 裡不准再出現第二份(陷阱 #37);而且那 6 支要真的 import 到
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const DIR = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(DIR).filter(x => x.endsWith('.mjs') && x !== 'lib_fundamentals.mjs' && !x.startsWith('test_'));
const dup = files.filter(x => /['`]-?05-15['`]|\}-05-15|\$\{y\}-05-15/.test(fs.readFileSync(path.join(DIR, x), 'utf8')));
ok('⑨ 🚨 scripts/ 裡財報公布日規則只准有 lib 這一份(⛔ 不可再 inline 一份)', dup.length === 0, dup.join(','));
const uses = { pubDate: ['pe_probe.mjs', 'broker_cross_probe.mjs', 'limitup_probe.mjs'], DEADLINES: ['calendar_probe.mjs', 'calendar_stock_probe.mjs', 'portfolio_backtest.mjs'] };
for (const [nm, list] of Object.entries(uses)) {
    const miss = list.filter(x => !new RegExp(`import \\{[^}]*\\b${nm}\\b[^}]*\\} from '\\./lib_fundamentals\\.mjs'`).test(fs.readFileSync(path.join(DIR, x), 'utf8')));
    ok(`⑨b ${list.length} 支探針真的 import 了 ${nm}(⛔ 刪掉 inline 卻沒接上 = ReferenceError)`, miss.length === 0, miss.join(','));
}
ok('⑨c DEADLINES 就是那四個法定截止日', JSON.stringify(DEADLINES) === JSON.stringify(['-03-31', '-05-15', '-08-14', '-11-14']));

console.log(f ? `\n❌ LIB_FUNDAMENTALS_FAIL(${f})` : '\n✅ LIB_FUNDAMENTALS_PASS(全部通過)');
process.exit(f ? 1 : 0);
