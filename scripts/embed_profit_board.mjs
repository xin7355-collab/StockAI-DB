#!/usr/bin/env node
/**
 * 💰 V77.9.4 「100 萬放進去變多少」—— 把 leader_probe 的三份產物嵌成 pro.html 的 `_PROFIT_BOARD`
 *
 *   node scripts/embed_profit_board.mjs <board.json> <board2.json> <small.json> [--to 2026-09-24] [--gene gene.json]
 *   node scripts/embed_profit_board.mjs --gene gene.json   ← 只換 🧬 那幾列(V78.1.0,gene_board.mjs 產物)
 *     board.json  = ETFS=… 那一輪(`etf[窗口]` 每檔 17 個起點的含息中位 / 最差)
 *     board2.json = CAPITAL=1000000 的四種領頭羊做法(`cap.fin / worstFin`)
 *     small.json  = 10萬/30萬/100萬 × 每月加碼 × 三種打法(`cap`)
 *
 * ⭐ 同一把尺:三份都是 leader_probe 同一組 17 個起點(STEP=3)—— 0050 那一格全頁只有一個數字,
 *    嵌完交叉驗證「策略那邊的 0050(b0050)== ETF 那邊的 0050」,對不上就 exit 1(⛔ 不嵌半套)。
 * ⛔ 這一行由本腳本產生,⛔ 不要手動改 pro.html 那一行。
 */
import fs from 'fs';

const toArg = (() => { const i = process.argv.indexOf('--to'); return i > 0 ? process.argv[i + 1] : null; })();
const geneArg = (() => { const i = process.argv.indexOf('--gene'); return i > 0 ? process.argv[i + 1] : null; })();
const [bf, b2f, sf] = process.argv.slice(2).filter((a, i, A) => !a.startsWith('--') && !['--to', '--gene'].includes(A[i - 1]));
const RE_LINE = /^  _PROFIT_BOARD: \{.*\},$/m;
// 🔥 V78.1.0 把 🧬 那幾套(scripts/gene_board.mjs 產物)加進看板:grp 'gene'
//   ⭐ 交叉驗證:gene 那邊每個起點的 0050 中位 == 看板的 0050(同一組起點),差超過 0.3% → exit 1(⛔ 不嵌半套)
function geneRows(G, wk, from, e50fin, die) {
  const sets = G.sets.filter(s => s.from === from);
  if (sets.length !== 3) die(`${wk} 🧬 做法應為 3 種,實際 ${sets.length}`);
  return sets.map(s => {
    if (Math.abs(s.b0050fin - e50fin) / e50fin > 0.003) die(`${wk} ${s.k} 的 0050 ${s.b0050fin} ≠ 看板 ${e50fin}(起點不同?)`);
    return { k: s.k, n: s.name, grp: 'gene', fin: s.fin, worst: s.worst, mdd: s.mdd, beat: s.beat, yrBeat: s.yrBeat, yrs: s.yrs };
  });
}
// 只換 🧬 那幾列(⛔ 不重跑 leader_probe):node scripts/embed_profit_board.mjs --gene gene.json
if (geneArg && !bf) {
  const P0 = 'pro.html', h0 = fs.readFileSync(P0, 'utf8'), m0 = h0.match(RE_LINE);
  const die0 = m => { console.error('❌ ' + m); process.exit(1); };
  if (!m0) die0('pro.html 沒有 _PROFIT_BOARD 那一行');
  const cur = JSON.parse(m0[0].replace(/^  _PROFIT_BOARD: /, '').replace(/,$/, ''));
  const G = JSON.parse(fs.readFileSync(geneArg, 'utf8'));
  for (const [wk, W] of Object.entries(cur.wins)) {
    const e50 = W.rows.find(r => r.k === '0050'); if (!e50 || e50.late) die0(wk + ' 沒有 0050');
    W.rows = W.rows.filter(r => r.grp !== 'gene').concat(geneRows(G, wk, W.from, e50.fin, die0));
  }
  cur.geneSrc = G.src;
  const ln = '  _PROFIT_BOARD: ' + JSON.stringify(cur) + ',';
  fs.writeFileSync(P0, h0.replace(RE_LINE, () => ln));
  const back = JSON.parse(fs.readFileSync(P0, 'utf8').match(RE_LINE)[0].replace(/^  _PROFIT_BOARD: /, '').replace(/,$/, ''));
  if (JSON.stringify(back) !== JSON.stringify(cur)) die0('讀回來不一樣');
  console.log('✅ 🧬 列已嵌入:' + Object.entries(cur.wins).map(([k, W]) => `${k} ${W.rows.filter(r => r.grp === 'gene').map(r => r.k + ' ' + Math.round(r.fin / 1e4) + '萬').join(' / ')}`).join(' | '));
  process.exit(0);
}
if (!bf || !b2f || !sf) { console.error('用法: embed_profit_board.mjs board.json board2.json small.json [--to YYYY-MM-DD]'); process.exit(2); }
const B = JSON.parse(fs.readFileSync(bf, 'utf8')), B2 = JSON.parse(fs.readFileSync(b2f, 'utf8')), SM = JSON.parse(fs.readFileSync(sf, 'utf8'));
const die = m => { console.error('❌ ' + m); process.exit(1); };

const WIN = { ai: '2022-09-16', long: '2011-01-03' };
const ETF_NM = {
  '0050': ['元大台灣50', 'mkt'], '006208': ['富邦台50', 'mkt'], '00692': ['富邦公司治理', 'mkt'], '00922': ['國泰台灣領袖50', 'mkt'],
  '0052': ['富邦科技', 'tech'], '00881': ['國泰台灣5G+', 'tech'], '00891': ['中信關鍵半導體', 'tech'], '00892': ['富邦台灣半導體', 'tech'],
  '00733': ['富邦臺灣中小', 'small'],
  '0056': ['元大高股息', 'div'], '00878': ['國泰永續高股息', 'div'], '00919': ['群益台灣精選高息', 'div'], '00713': ['元大台灣高息低波', 'div'],
};
const LEAD_K = { '👑 領頭羊(全攻)': 'lead', '👑 穩定版(一半永遠放 0050)': 'stable', '👑 先衝再穩(翻倍後改穩定版)': 'glide', '👑 尾盤成交(自動下單的做法)': 'close' };
const r0 = v => Math.round(v);

const wins = {};
for (const [wk, from] of Object.entries(WIN)) {
  const rows = [];
  for (const s of B2.sets.filter(x => x.from === from)) {
    const k = LEAD_K[s.name]; if (!k) die('board2 有不認得的做法 ' + s.name);
    if (!s.cap || s.cap.capital !== 1e6) die(s.name + ' 不是 100 萬模式');
    rows.push({ k, n: s.name, grp: 'lead', fin: r0(s.cap.fin), worst: r0(s.cap.worstFin), mdd: s.mdd, beat: s.cap.beatFin,
                yrBeat: s.yrBeat, yrs: Object.keys(s.years).length, b0050: s.b0050 });
  }
  if (rows.length !== 4) die(wk + ' 領頭羊做法應為 4 種,實際 ' + rows.length);
  const etf = (B.etf || {})[from]; if (!etf) die('board.json 沒有 ' + from + ' 的 ETF');
  for (const e of etf) {
    const nm = ETF_NM[e.sym]; if (!nm) die('ETF 名稱表沒有 ' + e.sym);
    if (e.tot == null) { rows.push({ k: e.sym, n: e.sym + ' ' + nm[0], grp: 'etf', kind: nm[1], late: true }); continue; }
    rows.push({ k: e.sym, n: e.sym + ' ' + nm[0], grp: 'etf', kind: nm[1], fin: r0(1e6 * (1 + e.tot / 100)), worst: r0(1e6 * (1 + e.lo / 100)), mdd: e.mdd, beat: null });
  }
  // ⭐ 交叉驗證:策略那邊的 0050 == ETF 那邊的 0050(同一組起點)
  const e50 = rows.find(r => r.k === '0050'); if (!e50 || e50.late) die(wk + ' 沒有 0050');
  for (const r of rows.filter(x => x.grp === 'lead')) {
    const want = r0(1e6 * (1 + r.b0050 / 100));
    if (Math.abs(want - e50.fin) > 1000) die(`${wk} ${r.k} 的 0050 ${want} ≠ ETF 那邊 ${e50.fin}(起點不同?)`);
    delete r.b0050;
  }
  if (geneArg) rows.push(...geneRows(JSON.parse(fs.readFileSync(geneArg, 'utf8')), wk, from, e50.fin, die));
  wins[wk] = { from, rows };
}

const small = {};
for (const [wk, from] of Object.entries(WIN)) {
  const rows = SM.sets.filter(x => x.from === from).map(s => {
    const c = s.cap; if (!c) die('small.json ' + s.name + ' 沒有 cap');
    const mode = /穩定版/.test(s.name) ? 'stable' : /先衝/.test(s.name) ? 'glide' : 'lead';
    return { cap: c.capital, add: c.add, mode, contrib: r0(c.contrib), fin: r0(c.fin), worst: r0(c.worstFin), b0050: r0(c.b0050fin), beat: c.beatFin, mdd: s.mdd };
  });
  if (rows.length !== 18) die(wk + ' 小資金應為 18 組,實際 ' + rows.length);
  small[wk] = { from, rows };
}
// ⭐ 小資金 100 萬沒加碼的全攻 ≈ 100 萬那張表的全攻(同一個模式,±1%)
for (const wk of Object.keys(WIN)) {
  const a = small[wk].rows.find(r => r.cap === 1e6 && !r.add && r.mode === 'lead'), b = wins[wk].rows.find(r => r.k === 'lead');
  if (Math.abs(a.fin - b.fin) / b.fin > 0.01) die(`${wk} 小資金 100 萬全攻 ${a.fin} 跟主表 ${b.fin} 差超過 1%`);
}

const out = { asof: new Date().toISOString().slice(0, 10), to: toArg || null, paths: 17, step: 3, src: 'scripts/leader_probe.mjs', wins, small };
const line = '  _PROFIT_BOARD: ' + JSON.stringify(out) + ',';
const P = 'pro.html', html = fs.readFileSync(P, 'utf8');
const re = /^  _PROFIT_BOARD: \{.*\},$/m;
let next;
if (re.test(html)) next = html.replace(re, () => line);
else {
  const anchor = '  _YEARLY_BT: {';
  const i = html.indexOf(anchor); if (i < 0) die('找不到 _YEARLY_BT 錨點');
  next = html.slice(0, i) + '  // 💰 V77.9.4 「100 萬放進去變多少」—— ⛔ 這一行由 scripts/embed_profit_board.mjs 產生,⛔ 別手動改\n' + line + '\n' + html.slice(i);
}
fs.writeFileSync(P, next);
// 讀回來驗
const back = JSON.parse(fs.readFileSync(P, 'utf8').match(re)[0].replace(/^  _PROFIT_BOARD: /, '').replace(/,$/, ''));
if (JSON.stringify(back) !== JSON.stringify(out)) die('讀回來不一樣');
console.log(`✅ _PROFIT_BOARD 嵌入:AI ${wins.ai.rows.length} 列 / 16 年 ${wins.long.rows.length} 列 / 小資金 ${small.ai.rows.length}+${small.long.rows.length} 組 ・${(line.length / 1024).toFixed(1)} KB`);
