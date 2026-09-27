// 🗓️ V77.7.2 回測引擎:出場日不在大盤日曆上 ⛔ 不可讓部位從權益曲線消失
//   實例:dd2 有 349 檔最後一根 09/25、^TWII 停在 09/24 → 以前 dIdx.get() 回 undefined,
//   `undefined <= i` 與 `undefined > i` 都是 false → 部位當天就從 live 被濾掉、錢永遠不回來
//   → 最大回撤被灌成 −55%(修後 −45%;而且錢被鎖住少開倉)。
//   ① 靜態:權益迴圈 ⛔ 不可再直接 dIdx.get(x.outD) ② outIdx 行為(把函式抽出來跑)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0; const ok = (c, m) => { console.log(`${c ? '✅' : '❌'} ${m}`); if (!c) fail++; };
const PB = fs.readFileSync(path.join(ROOT, 'scripts/portfolio_backtest.mjs'), 'utf8').replace(/\/\/.*$/gm, '');
const loop = PB.slice(PB.indexOf('const equity = [];'), PB.indexOf('const net = t =>'));
ok(loop.length > 2000, '⓪ 抓得到權益迴圈(空過守門)');
ok(!/dIdx\.get\(x\.outD\)/.test(loop), '①a 權益迴圈 ⛔ 不可直接 dIdx.get(x.outD)');
ok((loop.match(/outIdx\(x\)/g) || []).length >= 2, '①b 出場結算與 live 過濾都走 outIdx');
const m = PB.match(/const _lastDay = [\s\S]*?\n\};/);
ok(!!m, '①c 抓得到 outIdx 定義');
if (m) {
  const mk = days => { const dIdx = new Map(days.map((d, i) => [d, i])); return new Function('days', 'dIdx', `${m[0]}; return { outIdx, get n() { return _outFix; } };`)(days, dIdx); };
  const days = ['2026-09-21', '2026-09-22', '2026-09-24'];
  const f = mk(days);
  ok(f.outIdx({ outD: '2026-09-22' }) === 1, '②a 在日曆上 → 原樣');
  ok(f.outIdx({ outD: '2026-09-23' }) === 2, '②b 不在日曆上(大盤沒那天)→ 下一個大盤交易日');
  ok(f.outIdx({ outD: '2026-09-25' }) === 2, '②c 超過大盤最後一天 → 算最後一天(⛔ 不可是 undefined)');
  ok(f.n === 2, '②d 有計數(會印出來)');
}
ok(/出場日不在大盤日曆上/.test(PB), '③ 有印修正筆數(⛔ 不可靜默)');
console.log(fail ? `\n❌ ${fail} 條失敗` : '\n✅ PBCAL_PASS'); process.exit(fail ? 1 : 0);
