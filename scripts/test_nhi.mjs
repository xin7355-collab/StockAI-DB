// 🏥 V77.7.1 二代健保補充保費 + 回測股利入帳守門
//   ① 政策時間表(發放日判費率 / 門檻):2013 2% ≥5,000・2016 1.91% ≥20,000・2021 2.11% ≥20,000
//   ② trSeries 不給 opt → 跟舊版一字不差;給 nhi 就只少不多
//   ③ portfolio_backtest:股利只記 t.dv ⛔ 不改 t.ret(t.ret 會被選股門檻拿去用)、net() 與現金模擬都加 dv、NHI=0 可關
//   ④ EMERGING 讀不到市場別要停(⛔ 不可靜默當成沒排除)、sham 同比例
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { nhiRate, trSeries, NHI_TABLE } from './lib_totalreturn.mjs';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0; const ok = (c, m) => { console.log(`${c ? '✅' : '❌'} ${m}`); if (!c) fail++; };

ok(nhiRate('2012-12-31', 1e6) === 0, '①a 2013 以前不扣');
ok(nhiRate('2013-01-01', 4999) === 0 && nhiRate('2013-01-01', 5000) === 0.02, '①b 2013 門檻 5,000、2%');
ok(nhiRate('2016-01-01', 19999) === 0 && nhiRate('2016-01-01', 20000) === 0.0191, '①c 2016 門檻提高到 20,000、1.91%');
ok(nhiRate('2020-12-31', 30000) === 0.0191 && nhiRate('2021-01-01', 30000) === 0.0211, '①d 2021-01-01 起 2.11%(照發放日判)');
ok(NHI_TABLE.length === 3 && NHI_TABLE.every((r, i) => !i || r[0] > NHI_TABLE[i - 1][0]), '①e 時間表遞增');

const bars = Array.from({ length: 300 }, (_, i) => ({ d: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10), c: 100 }));
const divs = [[bars[50].d, 3, '息', 100], [bars[250].d, 3, '息', 100]];
const a = trSeries(bars, divs), b = trSeries(bars, divs, {});
ok(JSON.stringify(a) === JSON.stringify(b), '②a 不給 opt → 結果一字不差');
const big = trSeries(bars, divs, { capital: 1e7, nhi: true }), small = trSeries(bars, divs, { capital: 1e4, nhi: true });
const last = s => s.v[s.v.length - 1];
ok(last(big) < last(a), '②b 領得多 → 被扣 → 終值變小');
ok(Math.abs(last(small) - last(a)) < 1e-12, '②c 領得少(低於門檻)→ 不扣');

const PB = fs.readFileSync(path.join(ROOT, 'scripts/portfolio_backtest.mjs'), 'utf8').replace(/\/\/.*$/gm, '');
const blk = PB.slice(PB.indexOf('if (DIV_TRADES) {'), PB.indexOf("DIV_TRADES 設了卻一筆都沒碰到"));
ok(blk.length > 500, '③0 抓得到股利入帳那一段(空過守門)');
ok(!/t\.ret\s*[+\-*]?=/.test(blk), '③a 股利 ⛔ 不可改 t.ret');
ok(/t\.dv\s*=/.test(blk), '③b 股利記在 t.dv');
ok(/const net = t => t\.ret \+ \(t\.dv \|\| 0\) - COST/.test(PB), '③c 每筆淨報酬加 dv');
ok(/x\.ret \+ \(x\.dv \|\| 0\) - COST/.test(PB), '③d 現金模擬加 dv');
ok(/process\.env\.NHI !== '0'/.test(PB) && /nhiRate\(D,/.test(blk), '③e 預設扣二代健保、NHI=0 可關');
ok((PB.match(/\{ capital: CAPITAL, nhi: NHI \}/g) || []).length >= 2, '③f 0050 含息基準也扣二代健保(兩邊同一把尺)');
ok(/讀不到[\s\S]{0,120}process\.exit\(1\)/.test(PB) && /一檔興櫃都沒有[\s\S]{0,60}process\.exit\(1\)/.test(PB), '④a EMERGING 讀不到市場別 → 停');
ok(/emFrac \* 10000/.test(PB) && /emOk\(x\.t\)/.test(PB), '④b sham 同比例、有接進候選條件');
console.log(fail ? `\n❌ ${fail} 條失敗` : '\n✅ NHI_PASS'); process.exit(fail ? 1 : 0);
