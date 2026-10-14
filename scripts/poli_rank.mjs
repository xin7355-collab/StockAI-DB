#!/usr/bin/env node
// 🏆 V79.2.1 立委持股排行 —— 在 Actions 先算好,寫回 data/legislator_holdings.json 的 rank / rank_meta
//   ⛔ 算法只有一份:直接從 pro.html 抽 _poli* 那幾支函式來跑(⛔ 不在這裡另寫一份)
//   ⛔ 手機不重算:一百多位立委的持股加起來幾百檔,每檔 K 線約 160KB,手機一檔一檔讀會讀到好幾十 MB
//   用法:node scripts/poli_rank.mjs <holdings.json> [--ref origin/data]   ・ node scripts/poli_rank.mjs --selftest
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const FNS = ['_poliScale', '_poliTr', '_poliBars', '_poliAt', '_poliHold', '_poliBench', '_poliCalc', '_poliCov', '_poliRankRow'];

/** 從 pro.html 原始碼抽出物件方法,組成一個物件(this 指向它自己) */
export function extractPoli(src = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8')) {
  const parts = [];
  for (const name of FNS) {
    const i = src.indexOf(`\n  ${name}(`);
    if (i < 0) throw new Error(`pro.html 找不到 ${name}`);
    const lineEnd = src.indexOf('\n', i + 1);
    const line = src.slice(i + 1, lineEnd);
    let body;
    if (/\},\s*$/.test(line) && (line.match(/\{/g) || []).length === (line.match(/\}/g) || []).length) body = line;
    else {
      const j = src.indexOf('\n  },\n', i + 1);
      if (j < 0) throw new Error(`${name} 找不到結尾`);
      body = src.slice(i + 1, j + 5);
    }
    parts.push(body.trim().replace(/,\s*$/, ''));
  }
  return (0, eval)('({\n' + parts.join(',\n') + '\n})');
}

function gitJson(ref, file) {
  try {
    const out = execFileSync('git', ['show', `${ref}:${file}`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(out.toString('utf8'));
  } catch (_) { return null; }
}

/** 算全部人的排行;readK(sym) 回 K 線原始陣列(或 null),D = dividends_hist 的 d */
export function rankAll(J, P, readK, D) {
  const need = new Set(['0050']);
  for (const p of Object.values(J.people || {})) for (const d of p.decls || []) for (const r of d.rows || []) need.add(r.sym);
  const K = {};
  for (const s of need) K[s] = P._poliBars(readK(s));
  const B = K['0050'];
  const rows = [];
  for (const [slug, p] of Object.entries(J.people || {})) {
    const r = P._poliRankRow(slug, p, J, K, D || {}, B);
    if (r) rows.push(r);
  }
  const fin = x => typeof x === 'number' && Number.isFinite(x);
  rows.sort((a, b) => (fin(b.ex) ? b.ex : -Infinity) - (fin(a.ex) ? a.ex : -Infinity));
  const ex = rows.map(r => r.ex).filter(fin).sort((a, b) => a - b);
  const med = ex.length ? (ex.length % 2 ? ex[(ex.length - 1) / 2] : (ex[ex.length / 2 - 1] + ex[ex.length / 2]) / 2) : null;
  const meta = { asof: B ? B[B.length - 1].d : null, n_people: rows.length, beat0050: rows.filter(r => fin(r.ex) && r.ex > 0).length,
                 median_ex: med, n_syms: need.size, n_noK: [...need].filter(s => !K[s]).length };
  return { rows, meta };
}

function selftest() {
  let n = 0, ok = 0;
  const t = (c, m) => { n++; if (c) ok++; console.log((c ? '✅ ' : '❌ ') + m); };
  const P = extractPoli();
  t(FNS.every(f => typeof P[f] === 'function'), '從 pro.html 抽到全部函式');
  const bars = (a, b) => [{ date: '2025-10-31', close: a }, { date: '2025-11-04', close: (a + b) / 2 }, { date: '2026-10-13', close: b }];
  const KR = { '0050': bars(10, 15), X: bars(10, 20), Y: bars(10, 5), Z: bars(10, 10) };
  const mk = (sh) => ({
    people: {
      a: { name: '甲', party: 'A黨', decls: [{ date: '2025-11-01', rows: [{ sym: 'X', shares: sh, val: 1000 }] }] },
      b: { name: '乙', party: 'B黨', decls: [{ date: '2025-11-01', rows: [{ sym: 'Y', shares: 1000, val: 1000 }] }] },
    },
    skipped: { b: [{ d: '2025-11-01', name: '未上市', val: 3000 }] },
  });
  const R1 = rankAll(mk(1000), P, s => KR[s] || null, {});
  const A = R1.rows.find(r => r.slug === 'a'), Bp = R1.rows.find(r => r.slug === 'b');
  t(A && Math.abs(A.ret - 1) < 1e-12 && Math.abs(A.bench - 0.5) < 1e-12 && Math.abs(A.ex - 0.5) < 1e-12, '甲:10 → 20 = +100%,0050 +50%,贏 50 個百分點(手算)');
  t(Bp && Math.abs(Bp.ret + 0.5) < 1e-12 && Math.abs(Bp.cov - 0.25) < 1e-12, '乙:−50%,未上市佔面額 3/4 → 算得出 25%');
  t(R1.rows[0].slug === 'a' && R1.meta.beat0050 === 1 && R1.meta.n_people === 2 && R1.meta.asof === '2026-10-13', '排序 + meta');
  // 決定性對照:甲多一檔持平的 Z → 甲的報酬變、乙不變
  const J2 = mk(1000); J2.people.a.decls[0].rows.push({ sym: 'Z', shares: 1000, val: 1000 });
  const R2 = rankAll(J2, P, s => KR[s] || null, {});
  const A2 = R2.rows.find(r => r.slug === 'a'), B2 = R2.rows.find(r => r.slug === 'b');
  t(Math.abs(A2.ret - 0.5) < 1e-12 && B2.ret === Bp.ret, '決定性對照:甲加一檔持平 → +50%,乙不變');
  // 讀不到 K 線 → 那一位沒有排名(⛔ 不編)
  const R3 = rankAll(mk(1000), P, s => (s === 'Y' ? null : KR[s] || null), {});
  t(!R3.rows.find(r => r.slug === 'b') && R3.meta.n_noK === 1, '讀不到 K 線的那位不排(⛔ 不編一個數字)');
  console.log(ok === n ? `✅ POLI_RANK_SELFTEST ${ok}/${n}` : `❌ ${ok}/${n}`);
  return ok === n ? 0 : 1;
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const file = argv.find(a => !a.startsWith('--'));
  const ri = argv.indexOf('--ref'), ref = ri >= 0 ? argv[ri + 1] : 'origin/data';
  if (!file) { console.log('用法:node scripts/poli_rank.mjs <holdings.json> [--ref origin/data]'); return 2; }
  const J = JSON.parse(fs.readFileSync(file, 'utf8'));
  const P = extractPoli();
  const div = gitJson(ref, 'data/dividends_hist.json');
  if (!div) console.log(`⚠️ 讀不到 ${ref}:data/dividends_hist.json → 只算價格(不含息)`);
  const { rows, meta } = rankAll(J, P, s => gitJson(ref, `data/${s}.json`), (div || {}).d || {});
  const nPeople = Object.keys(J.people || {}).length;
  console.log(`🏆 ${rows.length}/${nPeople} 位算得出 ・ 用到 ${meta.n_syms} 檔(讀不到 K 線 ${meta.n_noK})・ 贏 0050 ${meta.beat0050} 位 ・ 現價到 ${meta.asof}`);
  for (const r of rows.slice(0, 10)) console.log(`   ${r.name} ${(r.ret * 100).toFixed(1)}%(0050 ${r.bench === null ? '—' : (r.bench * 100).toFixed(1) + '%'})・ 算得出 ${r.cov === null ? '—' : Math.round(r.cov * 100) + '%'}`);
  if (!meta.asof || rows.length < Math.min(5, nPeople)) {
    console.log(`🚧 ⛔ 不寫:算得出的只有 ${rows.length} 位 / 0050 K 線 ${meta.asof ? '有' : '讀不到'}`);
    return 1;
  }
  J.rank = rows;
  J.rank_meta = meta;
  fs.writeFileSync(file, JSON.stringify(J));
  console.log(`✅ rank 寫回 ${file}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) process.exit(main(process.argv.slice(2)));
