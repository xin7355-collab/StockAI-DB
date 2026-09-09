#!/usr/bin/env node
/**
 * 🏦 證券股跟「大盤成交量」到底是什麼關係?(V74.7.1,外部參考資料評估紀錄⑲)
 *
 * 使用者上傳的 Gemini 對話主張:
 *   「證券股的獲利高度取決於大盤成交量;大盤交投熱絡時,證券股爆發力強」
 *   「(1張改1股)會讓台股越來越活絡 → 是不是可以提早布局證券股」
 *
 * ⭐⭐ 這一題最容易做錯的地方:**證券股是高 beta** —— 大盤漲它就漲。
 *   ⛔ 不扣同期加權的話,量到的是 beta 不是「成交量帶來的額外報酬」。
 *   所以每一格的報酬**一律扣同期加權**。
 *
 * ⭐ 第二個關鍵:**同期相關 vs 隔天相關**(本站鐵則,評估紀錄⑧)——
 *   「今天量大、今天證券股漲」是廢話(同一件事的兩種記法);
 *   要能拿來布局,必須是「**今天**量大 → **未來**證券股比大盤強」。
 *
 * 資料:`data/^TWII.json` 的 `amount`(證交所官方集中市場成交值,1,214 根全有)
 *      + 證券/金控股 K 線。⛔ 零新資料源。
 */
import fs from 'fs';
import path from 'path';

const DATA = process.env.DATA_DIR || 'data';
const d10 = s => String(s || '').replace(/\//g, '-').slice(0, 10);
const HOR = [5, 10, 20, 60];

// 🏦 分兩類(⭐ 刻意分開:金控旗下證券只佔母公司一部分,受銀行/壽險稀釋)
const PURE = [['6023', '元大期'], ['2855', '統一證'], ['6005', '群益證'], ['6016', '康和證'], ['6015', '宏遠證']];
const FIN = [['2885', '元大金'], ['2890', '永豐金'], ['2883', '開發金'], ['2881', '富邦金'], ['2882', '國泰金']];
const CTRL = [['2412', '中華電'], ['1101', '台泥'], ['2317', '鴻海']];   // 🆚 對照:跟成交量無關的產業

function load(sym) {
  const p = path.join(DATA, `${sym}.json`);
  if (!fs.existsSync(p)) return null;
  let rows; try { rows = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
  const out = new Map();
  for (const r of rows) { const c = +r.close; if (c > 0) out.set(d10(r.date), c); }
  return out.size > 300 ? out : null;
}

// ── 大盤:收盤 + 官方成交金額 ──
const twii = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8'))
  .map(r => ({ d: d10(r.date), c: +r.close, amt: +r.amount || 0 }))
  .filter(x => x.c > 0 && x.amt > 0)
  .sort((a, b) => a.d < b.d ? -1 : 1);
console.log(`\n📊 大盤 ${twii.length} 根(有官方成交金額)・${twii[0].d} ~ ${twii[twii.length - 1].d}`);

const stocks = new Map();
for (const [s, nm] of [...PURE, ...FIN, ...CTRL]) {
  const m = load(s);
  if (m) stocks.set(s, { nm, m });
}
console.log(`   標的 ${stocks.size} 檔(獨立券商 ${PURE.filter(x => stocks.has(x[0])).length} ・金控 ${FIN.filter(x => stocks.has(x[0])).length} ・對照 ${CTRL.filter(x => stocks.has(x[0])).length})`);

const pearson = (a, b) => {
  const n = a.length; if (n < 30) return null;
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let sa = 0, sb = 0, sab = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sa += x * x; sb += y * y; sab += x * y; }
  return (sa > 0 && sb > 0) ? sab / Math.sqrt(sa * sb) : null;
};
const f = (v, dgt = 3) => v === null ? '  —  ' : (v >= 0 ? '+' : '') + v.toFixed(dgt);

// ── ① 成交量變化 vs 證券股「超額」報酬:同期 / 隔天 ──
console.log('\n═══ ① 大盤成交量 vs 證券股「贏大盤多少」 —— 同期 vs 隔天 ═══');
console.log('  🚨 報酬一律**扣同期加權**(⛔ 不扣的話量到的是 beta 不是成交量的效果)');
console.log('  ⛔ 同期相關高是廢話(同一件事的兩種記法),只有**隔天**的才能拿來布局\n');
console.log('  ' + '標的'.padEnd(14) + '同期相關'.padStart(10) + '隔天相關'.padStart(10) + '  判定');
const rows = [];
for (const [s, o] of stocks) {
  const dAmt = [], exSame = [], exNext = [];
  for (let i = 1; i < twii.length - 1; i++) {
    const D = twii[i].d, P = twii[i - 1].d, N = twii[i + 1].d;
    const p0 = o.m.get(P), p1 = o.m.get(D), p2 = o.m.get(N);
    if (!(p0 > 0 && p1 > 0 && p2 > 0)) continue;
    const da = twii[i].amt / twii[i - 1].amt - 1;                 // 成交量變化
    const mkt1 = twii[i].c / twii[i - 1].c - 1, mkt2 = twii[i + 1].c / twii[i].c - 1;
    dAmt.push(da);
    exSame.push((p1 / p0 - 1) - mkt1);                            // 當天超額
    exNext.push((p2 / p1 - 1) - mkt2);                            // 隔天超額
  }
  const rS = pearson(dAmt, exSame), rN = pearson(dAmt, exNext);
  const tag = rN === null ? '樣本不足' : Math.abs(rN) < 0.05 ? '❌ 隔天 ≈ 0(拿不來布局)' : '⭐ 隔天有東西';
  rows.push({ s, nm: o.nm, rS, rN, tag, n: dAmt.length });
  console.log('  ' + `${o.nm}(${s})`.padEnd(14) + f(rS).padStart(10) + f(rN).padStart(10) + '  ' + tag);
}

// ── ② 事件研究:成交量明顯放大之後,證券股未來會不會贏大盤 ──
console.log('\n═══ ② 事件:大盤成交量放大 → 之後 N 日,證券股贏大盤多少(pp) ═══');
console.log('  定義:當日成交金額 > 近 60 日均量 ×1.5(⭐ 門檻用「相對自己」,⛔ 不寫死億元)');
console.log('  對照組 = **所有交易日**(同一批標的、同樣扣同期加權)\n');
const ma60 = twii.map((_, i) => i < 59 ? null : twii.slice(i - 59, i + 1).reduce((a, r) => a + r.amt, 0) / 60);
const grp = { '🏦 獨立券商': PURE, '🏢 金控': FIN, '🆚 對照(非證券)': CTRL };
const hdr = '  ' + '族群'.padEnd(18) + 'n'.padStart(7) + HOR.map(h => `${h}日`.padStart(9)).join('');
const SUM = [];                        // 給最後的「扣成本判定」用
for (const [gname, list] of Object.entries(grp)) {
  console.log(`\n  ── ${gname} ──`);
  console.log(hdr);
  const byYear = {};                       // 只對事件組做逐年
  const keep = {};                         // {hit:{a20,n,h0,h1}, ctrl:{a20}}
  for (const [lab, hit] of [['📈 量放大 ≥1.5×', true], ['(對照)所有交易日', false]]) {
    const acc = HOR.map(() => []);
    const half = [[], []];                 // 前後半(用 20 日那一格)
    let n = 0, lastHit = -99;
    for (let i = 60; i < twii.length - 61; i++) {
      if (hit) {
        if (!(ma60[i] > 0 && twii[i].amt >= ma60[i] * 1.5)) continue;
        // 🚧 20 日去重 —— ⛔ 連續幾天都量放大是**同一件事**,不去重會重複計分
        if (i - lastHit < 20) continue;
        lastHit = i;
      }
      let used = false;
      for (const [s] of list) {
        const o = stocks.get(s); if (!o) continue;
        const p0 = o.m.get(twii[i].d); if (!(p0 > 0)) continue;
        HOR.forEach((h, k) => {
          const j = i + h; if (j >= twii.length) return;
          const p1 = o.m.get(twii[j].d); if (!(p1 > 0)) return;
          const ex = ((p1 / p0 - 1) - (twii[j].c / twii[i].c - 1)) * 100;
          acc[k].push(ex);
          if (h === 20) {
            half[i < twii.length / 2 ? 0 : 1].push(ex);
            if (hit) (byYear[twii[i].d.slice(0, 4)] ||= []).push(ex);
          }
          used = true;
        });
      }
      if (used) n++;
    }
    const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
    const cells = acc.map(a => a.length ? f(avg(a), 2) : '—');
    console.log('  ' + lab.padEnd(18) + String(n).padStart(7) + cells.map(c => c.padStart(9)).join('')
      + `   前後半(20日) ${f(avg(half[0]), 2)} / ${f(avg(half[1]), 2)}`);
    keep[hit ? 'hit' : 'ctrl'] = { a20: avg(acc[HOR.indexOf(20)]), n, h0: avg(half[0]), h1: avg(half[1]) };
  }
  const ys = Object.keys(byYear).sort().filter(y => byYear[y].length >= 5);
  let yrOk = null, yrTxt = '';
  if (ys.length) {
    const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
    const dl = ys.map(y => avg(byYear[y]));
    yrOk = dl.every(x => x > 0);
    yrTxt = ys.map((y, k) => `${y.slice(2)}:${f(dl[k], 1)}`).join(' ');
    console.log('  ' + '逐年(20日,事件組)'.padEnd(18) + yrTxt + (yrOk ? '  ✅ 全正' : '  ❌ 不同向'));
  }
  SUM.push({ gname, ...keep, yrOk, yrTxt, nEv: keep.hit ? keep.hit.n : 0 });
}

// ── ③ 扣成本判定(⭐ 這一段才是結論,⛔ 不可只看 ② 的正負) ──
console.log('\n═══ ③ 判定:邊際 = 事件組 − 對照組,再扣來回成本 0.44% ═══\n');
console.log('  ' + '族群'.padEnd(18) + 'n'.padStart(5) + '事件20日'.padStart(10) + '對照'.padStart(9)
  + '邊際'.padStart(9) + '扣成本'.padStart(9) + '  前後半 / 逐年');
for (const r of SUM) {
  if (!r.hit || r.hit.a20 === null || !r.ctrl || r.ctrl.a20 === null) continue;
  const edge = r.hit.a20 - r.ctrl.a20;
  const net = edge - 0.44;
  const halfOk = (r.hit.h0 > 0) === (r.hit.h1 > 0);
  const pass = net > 0 && halfOk && r.yrOk === true;
  console.log('  ' + r.gname.padEnd(18) + String(r.nEv).padStart(5)
    + f(r.hit.a20, 2).padStart(10) + f(r.ctrl.a20, 2).padStart(9)
    + f(edge, 2).padStart(9) + f(net, 2).padStart(9)
    + `  ${halfOk ? '✅' : '❌'} / ${r.yrOk === true ? '✅' : '❌'}  ${pass ? '⭐ 過關' : '❌'}`);
}

// ── ④ 門檻敏感度:是一片高原還是一根孤峰?(⭐ 本站鐵則,⛔ 只測一個門檻不算數) ──
console.log('\n═══ ④ 門檻敏感度(獨立券商,20 日邊際 = 事件 − 對照,已扣 0.44%) ═══');
console.log('  ⭐ 一片高原 = 真的;只有一格好 = 過度配適\n');
console.log('  ' + '倍數'.padEnd(8) + 'n'.padStart(6) + '事件20日'.padStart(10) + '扣成本邊際'.padStart(12) + '  逐年');
{
  const list = PURE;
  const ctrlA20 = (() => {
    const a = [];
    for (let i = 60; i < twii.length - 61; i++) for (const [s] of list) {
      const o = stocks.get(s); if (!o) continue;
      const p0 = o.m.get(twii[i].d), p1 = o.m.get(twii[i + 20].d);
      if (p0 > 0 && p1 > 0) a.push(((p1 / p0 - 1) - (twii[i + 20].c / twii[i].c - 1)) * 100);
    }
    return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  })();
  for (const mult of [1.2, 1.3, 1.4, 1.5, 1.7, 2.0]) {
    const a = []; const byY = {}; let n = 0, last = -99;
    for (let i = 60; i < twii.length - 61; i++) {
      if (!(ma60[i] > 0 && twii[i].amt >= ma60[i] * mult)) continue;
      if (i - last < 20) continue;
      last = i; let used = false;
      for (const [s] of list) {
        const o = stocks.get(s); if (!o) continue;
        const p0 = o.m.get(twii[i].d), p1 = o.m.get(twii[i + 20].d);
        if (!(p0 > 0 && p1 > 0)) continue;
        const ex = ((p1 / p0 - 1) - (twii[i + 20].c / twii[i].c - 1)) * 100;
        a.push(ex); (byY[twii[i].d.slice(0, 4)] ||= []).push(ex); used = true;
      }
      if (used) n++;
    }
    if (!a.length) continue;
    const avg = x => x.reduce((p, q) => p + q, 0) / x.length;
    const ys = Object.keys(byY).sort().filter(y => byY[y].length >= 5);
    const dl = ys.map(y => avg(byY[y]));
    console.log('  ' + `×${mult}`.padEnd(8) + String(n).padStart(6) + f(avg(a), 2).padStart(10)
      + f(avg(a) - ctrlA20 - 0.44, 2).padStart(12)
      + '  ' + ys.map((y, k) => `${y.slice(2)}:${f(dl[k], 1)}`).join(' ')
      + (dl.length && dl.every(x => x > 0) ? ' ✅' : ' ❌'));
  }
}

console.log('\n' + '═'.repeat(92));
console.log('🧭 怎麼讀');
console.log('   ⭐ ① 的「隔天相關」才是能不能布局的判準;同期相關再高都只是「量大那天它也漲」。');
console.log('   ⭐ ② 要跟**對照組**比,⛔ 不是看正負 —— 證券股本來就有自己的長期漂移。');
console.log('   ⚠️ 窗口 2021-09 起(受 ^TWII 的 amount 欄限制),含 2022 空頭。');
console.log('   ⚠️ 樣本只有 5+5+3 檔,⛔ 不是全市場;獨立券商流動性偏低,實際滑價會更差。');
console.log('   🚨 **n=16 是「16 個大盤日」不是 16 個獨立樣本** —— 5 檔券商在同一天一起動,');
console.log('      所以有效樣本就是那 16 天;⛔ 不可把它當成 80 筆看待。');
console.log('   ⛔ 「1 張改 1 股」沒有實施日 → **無法回測**,⛔ 這支不回答那個問題。');
