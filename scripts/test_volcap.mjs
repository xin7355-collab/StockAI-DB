#!/usr/bin/env node
/**
 * 🧱🛡️ V79.0.4 `portfolio_backtest.mjs` 成交量上限(VOLCAP)與帳戶淨值閘門(EQGATE)守門(StockSharp 評估紀錄㊼)
 *
 * 釘住:
 *   ⓐ 不設時一個字都不變:兩個都⛔ 不進 CACHE_KEY;不設的成績兩次逐位相同、summary 沒有 volcap / eqgate
 *   ⓑ VOLCAP 真的生效:上限壓到很低 → 有被減量的、成績跟不設不一樣;分母是**訊號日**成交額(t.amt)
 *   ⓒ EQGATE 零前視:判第 k 天只用 v[k-1] 以前的淨值;只擋開新倉(在候選之前 continue,⛔ 不碰出場)
 *   ⓓ 安慰劑 shift:K=0 跟原本逐位相同(決定性對照)、K≠0 暫停天數一樣多但日子不同
 *   ⓔ 空過守門:EQGATE 沒給 src / 一天都沒暫停 → exit 1
 * ⚠️ 真跑引擎(repo `data/` 25 檔),約 2~3 分鐘。
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = process.env.PB_FILE || path.join(ROOT, 'scripts', 'portfolio_backtest.mjs');
const CODE = fs.readFileSync(FILE, 'utf8').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 240)}`); if (!c) fails.push(n); };

// ── 靜態 ──
const ck = (CODE.match(/const CACHE_KEY = JSON\.stringify\(\{[^}]*\}\)/) || [''])[0];
ok('ⓐs CACHE_KEY ⛔ 沒有 VOLCAP / EQGATE', ck && !/VOLCAP|EQGATE/.test(ck), ck);
ok('ⓑs 上限分母 = 訊號日成交額 t.amt(億 → 元)', /const lim = \(\+t\.amt \|\| 0\) \* 1e8 \* VOLCAP \/ 100;/.test(CODE));
ok('ⓒs 零前視:判第 k 天用 v[k - 1]', /const y = v\[k - 1\];/.test(CODE) && /for \(let j = k - N; j < k; j\+\+\)/.test(CODE) && /for \(let j = 0; j < k; j\+\+\) pk = Math\.max/.test(CODE));
const iGate = CODE.indexOf('if (EQ_BLOCK && EQ_BLOCK.has(d))'), iExit = CODE.indexOf('live = live.filter(x => outIdx(x) > i);'), iCand = CODE.indexOf('const cand = todays');
ok('ⓒs2 閘門在「出場」之後、「挑候選」之前(只擋開新倉)', iExit > 0 && iGate > iExit && iGate < iCand, `${iExit} ${iGate} ${iCand}`);
ok('ⓔs 一天都沒暫停 → exit 1', /一天都沒暫停[^\n]*\n?[^\n]*process\.exit\(1\)|一天都沒暫停.*process\.exit\(1\)/.test(CODE));

// ── 執行期 ──
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
if (!fs.existsSync(path.join(DATA, '^TWII.json'))) { console.log(`❌ ${DATA} 沒有 ^TWII.json → 執行期沒驗到`); fails.push('no-data'); }
else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbvc-'));
    const base = { ...process.env, DATA_DIR: DATA, LOT: '150000', SELF: 'high+hivolat', RANK_MIN: '75', VOLAT_MIN: '60', EXIT: 'chand2', MAXD: '20', FILTER: 'bear60', STOPFILL: 'close', WARMUP: '240', TRADES_CACHE: path.join(tmp, 'c.json') };
    for (const k of ['VOLCAP', 'VOLCAP_MODE', 'EQGATE', 'EQGATE_SRC', 'ROTATE', 'COST_X', 'PARK', 'DIV', 'DIV_TRADES', 'EQUITY_OUT']) delete base[k];
    const run = (tag, extra) => { const r = spawnSync(process.execPath, ['--max-old-space-size=3000', FILE, '25', '2'], { env: { ...base, ...extra, SUMMARY_OUT: path.join(tmp, `s_${tag}.json`) }, encoding: 'utf8', timeout: 420000, maxBuffer: 64 << 20 }); let s = null; try { s = JSON.parse(fs.readFileSync(path.join(tmp, `s_${tag}.json`), 'utf8')); } catch (_) {} return { r, s }; };
    const EQ = path.join(tmp, 'eq.json');
    const A = run('a', { EQUITY_OUT: EQ }), B = run('b', {});
    ok('🚧 基準跑得起來', A.r.status === 0 && A.s && A.s.n > 5, `status=${A.r.status} ${(A.r.stderr || A.r.stdout || '').slice(-300)}`);
    ok('ⓐ 決定性對照:不設時兩次逐位相同、summary 沒有 volcap / eqgate', A.s && B.s && A.s.cum === B.s.cum && A.s.n === B.s.n && !('volcap' in A.s) && !('eqgate' in A.s), `${A.s?.cum} vs ${B.s?.cum}`);
    const V = run('v', { VOLCAP: '0.05' });
    ok('ⓑ VOLCAP=0.05% 真的有減量、成績跟不設不一樣', V.r.status === 0 && V.s && V.s.volcap && V.s.volcap.cut > 0 && V.s.cum !== A.s?.cum, JSON.stringify(V.s?.volcap) + ' ' + (V.r.stderr || '').slice(-200));
    const V2 = run('v2', { VOLCAP: '1000' });
    ok('ⓑ2 上限很寬(1000%)→ 0 次碰到、成績跟不設一模一樣', V2.s && V2.s.volcap && V2.s.volcap.hit === 0 && V2.s.cum === A.s?.cum, JSON.stringify(V2.s?.volcap));
    const G = run('g', { EQGATE: 'ma:20', EQGATE_SRC: EQ });
    ok('ⓒ EQGATE=ma:20 有暫停的日子、成績跟不設不一樣', G.r.status === 0 && G.s && G.s.eqgate && G.s.eqgate.days > 0 && G.s.cum !== A.s?.cum, JSON.stringify(G.s?.eqgate) + ' ' + (G.r.stderr || '').slice(-200));
    const G0 = run('g0', { EQGATE: 'shift:ma:20:0', EQGATE_SRC: EQ }), G7 = run('g7', { EQGATE: 'shift:ma:20:37', EQGATE_SRC: EQ });
    ok('ⓓ 決定性對照:shift K=0 跟原本逐位相同', G0.s && G.s && G0.s.cum === G.s.cum && G0.s.n === G.s.n, `${G0.s?.cum} vs ${G.s?.cum}`);
    ok('ⓓ2 安慰劑 K=37:暫停天數一樣多、成績不同', G7.s && G.s && G7.s.eqgate.days === G.s.eqgate.days && G7.s.cum !== G.s.cum, `${G7.s?.eqgate?.days} ${G.s?.eqgate?.days} ${G7.s?.cum}`);
    const N = run('n', { EQGATE: 'ma:20' });
    ok('ⓔ 沒給 EQGATE_SRC → exit 1 並說原因', N.r.status === 1 && /EQGATE_SRC/.test(N.r.stderr || ''), (N.r.stderr || '').slice(-200));
    const Z = run('z', { EQGATE: 'dd:99', EQGATE_SRC: EQ });
    ok('ⓔ2 dd:99 一天都沒暫停 → exit 1(⛔ 不是「沒差別」)', Z.r.status === 1 && /一天都沒暫停/.test(Z.r.stderr || ''), (Z.r.stderr || '').slice(-200));
    fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ test_volcap 全過');
process.exit(fails.length ? 1 : 0);
