#!/usr/bin/env node
/**
 * 🔥 V78.1.0 把 🧬 那幾套做法放進「100 萬放進去變多少」那張看板(`_PROFIT_BOARD`)
 *
 *   node scripts/gene_board.mjs <out.json> --eq <EQUITY_OUT 檔所在目錄> --bench <放 0050 的 DATA_DIR> [--div dividends_hist.json] [--to 2026-09-24]
 *   node scripts/gene_board.mjs --selftest
 *
 * ⭐ 同一把尺(⛔ 不可拿 portfolio_backtest 的 WARMUP 240~320 那 17 條直接放上去):
 *    看板的 17 個起點 = 窗口第一天起「每隔 3 個交易日」(leader_probe STEP=3)→
 *    portfolio_backtest 跑的時候 WARMUP 必須等於那 17 個交易日的索引,EQUITY_OUT 第一列的日期要等於起點。
 *    這支會逐條核對「第一列日期 == 看板起點」,對不上就 exit 1(⛔ 不嵌半套)。
 * ⭐ 0050 含息照抄 leader_probe.loadCtx 的讀法(_bench0050.json 優先、_div0050.json / DIV 股利),
 *    算法跟 leader_probe.metrics 一樣(到期扣一次手續費)→ embed_profit_board 再跟看板那邊的 0050 交叉驗證。
 * 檔名規則:<窗口 ai|long>_<做法 hot|park|don>_<WARMUP>.json(portfolio_backtest EQUITY_OUT 產物)
 */
import fs from 'fs';
import path from 'path';
import { trSeries, loadPx } from './lib_totalreturn.mjs';

const FEE = 0.001425;
export const WIN = { ai: '2022-09-16', long: '2011-01-03' };
export const SETS = {
  hot: '🔥 高檔飆股',
  park: '🅿️ 高檔飆股+停車 0050',
  don: '🐢 唐奇安長抱(已換掉)',
};
const median = a => { const s = a.slice().sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };
const r2 = v => Math.round(v * 100) / 100;

/** 0050 含息序列(對到 cal);照抄 leader_probe.loadCtx */
export function bench0050(DATA, DIV, cal) {
  const b50p = path.join(DATA, '_bench0050.json');
  const bars = fs.existsSync(b50p) ? JSON.parse(fs.readFileSync(b50p, 'utf8')).map(r => ({ d: String(r.date).replace(/\//g, '-').slice(0, 10), c: +r.close })).filter(x => x.c > 0) : loadPx(DATA, '0050');
  const divP = path.join(DATA, '_div0050.json');
  let d50 = [];
  if (fs.existsSync(divP)) { const raw = JSON.parse(fs.readFileSync(divP, 'utf8')); d50 = Array.isArray(raw) ? raw : (raw.h || ((raw.d || raw)['0050'] || {}).h || []); }
  else if (DIV) { const raw = JSON.parse(fs.readFileSync(DIV, 'utf8')); d50 = ((raw.d || raw)['0050'] || {}).h || []; }
  return alignTr(trSeries(bars, d50), cal);
}
export function alignTr(tr0, cal) {
  const tr = new Float64Array(cal.length).fill(NaN); let j = 0, last = NaN;
  for (let i = 0; i < cal.length; i++) { while (j < tr0.d.length && tr0.d[j] <= cal[i]) { last = tr0.v[j]; j++; } tr[i] = last; }
  return tr;
}

/** 一條路徑:逐日市值 → 最後值 / 回撤 / 逐年 vs 0050 */
export function pathStats(rows, cal, tr, to) {
  const R = rows.filter(r => !to || r.d <= to);
  if (!R.length) throw new Error('路徑沒有任何一天');
  const idx = new Map(cal.map((d, i) => [d, i]));
  const s = idx.get(R[0].d), e = idx.get(R.at(-1).d);
  if (s == null || e == null) throw new Error('路徑日期對不到日曆:' + R[0].d + ' / ' + R.at(-1).d);
  const eq = R.map(r => r.cash + r.park + r.mv);
  const cap = eq[0];
  let pk = -Infinity, dd = 0; for (const v of eq) { pk = Math.max(pk, v); dd = Math.min(dd, v / pk - 1); }
  const b = tr[e] / tr[s] * (1 - FEE) - 1;
  // 逐年(同 leader_probe.yearly:每年頭一天的前一天當基準)
  const ys = {}; let a = 0;
  for (let i = 1; i <= R.length; i++) {
    if (i === R.length || R[i].d.slice(0, 4) !== R[a].d.slice(0, 4)) {
      const y = R[a].d.slice(0, 4), s0 = a === 0 ? 0 : a - 1;
      ys[y] = { s: eq[i - 1] / eq[s0] - 1, c: tr[idx.get(R[i - 1].d)] / tr[idx.get(R[s0].d)] - 1 };
      a = i;
    }
  }
  return { from: R[0].d, to: R.at(-1).d, fin: eq.at(-1) / cap * 1e6, mdd: dd * 100, b50fin: (1 + b) * 1e6, yrBeat: Object.values(ys).filter(v => v.s > v.c).length, yrs: Object.keys(ys).length };
}

export function summarize(paths) {
  return {
    fin: Math.round(median(paths.map(p => p.fin))), worst: Math.round(Math.min(...paths.map(p => p.fin))),
    mdd: r2(median(paths.map(p => p.mdd))), beat: paths.filter(p => p.fin > p.b50fin).length,
    yrBeat: Math.round(median(paths.map(p => p.yrBeat))), yrs: paths[0].yrs, b0050fin: Math.round(median(paths.map(p => p.b50fin))),
  };
}

function selftest() {
  let ok = 0, bad = 0; const t = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); c ? ok++ : bad++; };
  const cal = Array.from({ length: 600 }, (_, i) => new Date(Date.UTC(2022, 0, 3 + i)).toISOString().slice(0, 10));
  const tr = Float64Array.from(cal, (_, i) => 1 + i * 0.001);
  // ① 一條固定翻倍的路徑:最後 200 萬、回撤 0、0050 照比例
  const rows = cal.slice(10, 400).map((d, k) => ({ d, cash: 1e6 + k * 1e6 / 389, park: 0, mv: 0 }));
  const p = pathStats(rows, cal, tr, null);
  t(Math.abs(p.fin - 2e6) < 1 && p.mdd === 0, '① 市值 = cash + park + mv,從 100 萬一路漲到 200 萬 → 變成 200 萬、回撤 0');
  t(Math.abs(p.b50fin - (tr[399] / tr[10]) * (1 - FEE) * 1e6) < 1, '② 0050 用同一個起點到同一個終點(到期扣一次手續費)');
  // ③ to 截斷
  const p2 = pathStats(rows, cal, tr, cal[200]);
  t(p2.to === cal[200] && p2.fin < 2e6, '③ --to 之後的日子不算');
  // ④ 回撤:漲到 150 萬掉到 120 萬 → −20%
  const r4 = [1e6, 1.5e6, 1.2e6, 1.3e6].map((v, k) => ({ d: cal[k], cash: v, park: 0, mv: 0 }));
  t(Math.abs(pathStats(r4, cal, tr, null).mdd + 20) < 1e-9, '④ 中途最多賠 = 從最高點掉多少');
  // ⑤ 停車 0050 的錢也算(park 欄)
  const r5 = [{ d: cal[0], cash: 1e6, park: 0, mv: 0 }, { d: cal[1], cash: 0, park: 1.1e6, mv: 0 }];
  t(Math.abs(pathStats(r5, cal, tr, null).fin - 1.1e6) < 1, '⑤ 停在 0050 的錢(park)算進市值(⛔ 漏掉會少算一大截)');
  // ⑥ 贏 0050 的起點數 / 中位
  const S = summarize([{ fin: 3e6, b50fin: 2e6, mdd: -10, yrBeat: 2, yrs: 4 }, { fin: 1e6, b50fin: 2e6, mdd: -30, yrBeat: 1, yrs: 4 }, { fin: 2.5e6, b50fin: 2e6, mdd: -20, yrBeat: 3, yrs: 4 }]);
  t(S.fin === 2.5e6 && S.worst === 1e6 && S.beat === 2 && S.mdd === -20, '⑥ 中間那條 / 最差那條 / 贏 0050 幾條');
  // ⑦ 決定性對照:起點挪一天 → 0050 不同
  const r7 = rows.slice(1);
  t(Math.abs(pathStats(r7, cal, tr, null).b50fin - p.b50fin) > 1, '⑦ 起點不同 → 0050 對照跟著換(⛔ 不可全部用同一個 0050)');
  console.log(`\n${bad ? '❌' : '✅'} gene_board selftest ${ok}/${ok + bad}`); process.exit(bad ? 1 : 0);
}

const _isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (_isMain) {
  if (process.argv.includes('--selftest')) selftest();
  const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const out = process.argv[2], EQ = arg('--eq'), BENCH = arg('--bench'), DIV = arg('--div'), TO = arg('--to');
  const die = m => { console.error('❌ ' + m); process.exit(1); };
  if (!out || !EQ || !BENCH) die('用法: gene_board.mjs out.json --eq DIR --bench DATA_DIR [--div dividends_hist.json] [--to YYYY-MM-DD]');
  const tw = loadPx(BENCH, '^TWII'); if (!tw) die(BENCH + ' 沒有 ^TWII.json');
  const cal = tw.map(x => x.d), tr = bench0050(BENCH, DIV, cal);
  const files = fs.readdirSync(EQ).filter(f => /^(ai|long)_(hot|park|don)_\d+\.json$/.test(f));
  const sets = [];
  for (const [wk, from] of Object.entries(WIN)) {
    const s0 = cal.findIndex(d => d >= from); if (s0 < 0) die('日曆沒有 ' + from);
    const want = Array.from({ length: 17 }, (_, k) => cal[s0 + 3 * k]);
    for (const k of Object.keys(SETS)) {
      const fs_ = files.filter(f => f.startsWith(`${wk}_${k}_`));
      if (fs_.length !== 17) die(`${wk} ${k} 應有 17 條,實際 ${fs_.length}`);
      const paths = fs_.map(f => { const j = JSON.parse(fs.readFileSync(path.join(EQ, f), 'utf8')); return pathStats(j.rows, cal, tr, TO); });
      const got = paths.map(p => p.from).sort();
      if (JSON.stringify(got) !== JSON.stringify(want)) die(`${wk} ${k} 起點對不上看板:${got.slice(0, 3).join(',')}… vs ${want.slice(0, 3).join(',')}…`);
      const S = summarize(paths);
      sets.push({ k, name: SETS[k], from, to: paths[0].to, ...S });
      console.log(`[${wk}] ${SETS[k]}:100 萬 → ${(S.fin / 1e4).toFixed(0)} 萬(最差 ${(S.worst / 1e4).toFixed(0)})・中途最多賠 ${S.mdd}% ・贏 0050 ${S.beat}/17 ・逐年 ${S.yrBeat}/${S.yrs} ・0050 含息 ${(S.b0050fin / 1e4).toFixed(0)} 萬`);
    }
  }
  fs.writeFileSync(out, JSON.stringify({ src: 'scripts/portfolio_backtest.mjs + scripts/gene_board.mjs', sets }, null, 1));
  console.log('📤 ' + out);
}
