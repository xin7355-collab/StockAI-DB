#!/usr/bin/env node
/**
 * 📈 V77.7.7 `portfolio_backtest.mjs` 逐日市值淨值輸出(EQUITY_OUT)守門
 *
 * 起因:0050 核心 × 策略衛星要做「再平衡」,需要策略每一天的淨值 —— 引擎以前只有「成本計、只在交易點跳動、
 *       被 regime/bear60 擋掉的日子還缺天」的 `equity` 陣列,而且沒輸出。
 * 釘住:
 *   ⓐ 不設時一個字都不變(summary 逐位相同;mdd 仍沿用舊的成本計 equity)
 *   ⓑ 天數 = 從暖身結束那天到最後一天,一天都不缺(被 bear60 擋掉不開新倉的日子也要有一列)
 *   ⓒ 日期嚴格遞增、無重複、跟 ^TWII 日曆一致
 *   ⓓ 最後一天 cash + park + cost − CAPITAL == 已出場那些筆的淨損益加總(從 TAKEN_OUT 重算;⛔ 不是抄 summary)
 *   ⓔ mv 每天 ≥ 0;持倉 0 筆時 mv == cost == 0;有持倉時 mv 跟 cost 差不超過 ±60%(市值不是亂數)
 * ⚠️ 真跑引擎(repo `data/` 25 檔),約 1~2 分鐘。
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
ok('ⓐs mdd 仍讀舊的 equity(成本計),⛔ 不改成 eqRows', /for \(const e of equity\) \{ if \(e > peak\) peak = e;/.test(CODE), '');
ok('ⓑs 六個「今天不開新倉」的 continue 之前都有 pushEq', (CODE.match(/pushEq\(i, d\); continue;|pushEq\(i, d\);\n\s*continue;/g) || []).length >= 6, String((CODE.match(/pushEq\(i, d\)/g) || []).length));
ok('ⓑs2 主迴圈結尾有 pushEq', /equity\.push\(cash \+ \(PARK && parkOf[^\n]*\n\s*pushEq\(i, d\);\n\}/.test(CODE), '');

// ── 執行期 ──
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
if (!fs.existsSync(path.join(DATA, '^TWII.json'))) { console.log(`❌ ${DATA} 沒有 ^TWII.json → 執行期沒驗到`); fails.push('no-data'); }
else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbeq-'));
    const base = { ...process.env, DATA_DIR: DATA, LOT: '150000', CAPITAL: '1000000', SELF: 'high+hivolat', RANK_MIN: '75', VOLAT_MIN: '60', EXIT: 'chand2', MAXD: '20', FILTER: 'bear60', STOPFILL: 'close', WARMUP: '240', TRADES_CACHE: path.join(tmp, 'c.json') };
    for (const k of ['ROTATE', 'COST_X', 'BEAR_EXIT', 'FORCE_EXIT', 'PARK', 'DIV', 'DIV_TRADES', 'FIN_DEEP', 'TURN', 'FIN', 'VAL', 'USSIG', 'USSIG_MAP', 'EQUITY_OUT', 'EXIT_SCHED']) delete base[k];
    const run = (tag, extra) => { const r = spawnSync(process.execPath, ['--max-old-space-size=3000', FILE, '25', '2'], { env: { ...base, ...extra, SUMMARY_OUT: path.join(tmp, `s_${tag}.json`), TAKEN_OUT: path.join(tmp, `t_${tag}.json`) }, encoding: 'utf8', timeout: 420000, maxBuffer: 64 << 20 }); let s = null, t = null; try { s = JSON.parse(fs.readFileSync(path.join(tmp, `s_${tag}.json`), 'utf8')); } catch (_) {} try { t = JSON.parse(fs.readFileSync(path.join(tmp, `t_${tag}.json`), 'utf8')); } catch (_) {} return { r, s, t }; };
    const A = run('a', {});
    const eqf = path.join(tmp, 'eq.json');
    const E = run('e', { EQUITY_OUT: eqf });
    ok('🚧 基準跑得起來', A.r.status === 0 && A.s && A.s.n > 5, `status=${A.r.status} ${(A.r.stderr || A.r.stdout || '').slice(-300)}`);
    ok('ⓐ 設 EQUITY_OUT 後 summary 逐位相同(mdd 也一樣)', E.r.status === 0 && E.s && JSON.stringify(E.s) === JSON.stringify(A.s), `${A.s?.dd} vs ${E.s?.dd}`);
    let eq = null; try { eq = JSON.parse(fs.readFileSync(eqf, 'utf8')); } catch (_) {}
    ok('🚧 有寫出 EQUITY_OUT', eq && Array.isArray(eq.rows) && eq.rows.length > 100, eq ? eq.rows?.length : 'no file');
    if (eq) {
        const tw = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8')).map(r => String(r.date || r.d || '').replace(/\//g, '-').slice(0, 10)).filter(Boolean);
        const days = tw.filter(d => d >= eq.from && d <= eq.to);
        ok('ⓑ 天數 = 暖身後每一個交易日(bear60 擋掉的日子也有)', eq.rows.length === days.length, `${eq.rows.length} vs ${days.length}`);
        const ds = eq.rows.map(r => r.d);
        ok('ⓒ 日期嚴格遞增、無重複、跟 ^TWII 日曆一致', ds.every((d, i) => !i || d > ds[i - 1]) && ds.every((d, i) => d === days[i]), `${ds.slice(0, 3)} … ${ds.slice(-2)}`);
        const last = eq.rows[eq.rows.length - 1];
        // 已出場那些筆的淨損益(含股利,扣 COST 0.44):cash 只收「outD ≤ to」的錢
        const COST = 0.44;
        const exited = E.t.filter(x => x.outD <= eq.to);
        const pnl = exited.reduce((a, x) => a + eq.lot * (x.ret + (x.dv || 0) - COST) / 100, 0);
        ok('ⓓ 最後一天 cash+park+cost−CAPITAL == 已出場筆的淨損益(從 TAKEN_OUT 重算)', Math.abs(last.cash + last.park + last.cost - eq.capital - pnl) < 5, `${last.cash + last.park + last.cost - eq.capital} vs ${Math.round(pnl)}`);
        ok('ⓔ mv ≥ 0;無持倉時 mv=cost=0;有持倉時 mv/cost 在 0.4~1.6', eq.rows.every(r => r.mv >= 0 && (r.n === 0 ? (r.mv === 0 && r.cost === 0) : (r.mv / r.cost > 0.4 && r.mv / r.cost < 1.6))), JSON.stringify(eq.rows.find(r => !(r.mv >= 0 && (r.n === 0 ? (r.mv === 0 && r.cost === 0) : (r.mv / r.cost > 0.4 && r.mv / r.cost < 1.6))))));
        ok('ⓔ2 市值真的在動(有持倉的日子裡 mv≠cost 的比例 >50%)', (() => { const h = eq.rows.filter(r => r.n > 0); return h.length > 20 && h.filter(r => r.mv !== r.cost).length / h.length > 0.5; })(), '');
    }
    fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${fails.length ? '❌ ' + fails.length + ' 條沒過' : '✅ 全部通過'}`);
process.exit(fails.length ? 1 : 0);
