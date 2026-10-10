#!/usr/bin/env node
// 🧱 fill_cap_probe —— 回測裡每一筆買賣,佔「那一天整天成交金額」幾 %(V79.0.4,StockSharp 評估紀錄㊼)
//
// 為什麼:回測一律假設「觸發就全額成交」。StockSharp 的回測模擬器會限制一筆不可吃掉當根太多量 →
//        先量本站實際成交的那幾筆,佔當天成交額多少,再決定要不要在引擎設上限(portfolio_backtest VOLCAP=)。
// 讀:portfolio_backtest 的 TAKEN_OUT(可以多條起點)+ 同一份 K 線目錄。
// 印:進場日 / 出場日 參與率分布(中位 / P90 / P99 / 最大)+ 超過 1% / 5% / 10% 的筆數。
// ⚠️ 本站進場是「訊號日尾盤」→ 真正能吃的只有最後一盤,用整天成交額當分母是**寬鬆**的那一邊(實際更難成交)。
//
// 用法:DATA_DIR=<K 線目錄> LOT=150000 node scripts/fill_cap_probe.mjs taken_*.json [--out x.json]
//       node scripts/fill_cap_probe.mjs --selftest
import fs from 'node:fs';
import path from 'node:path';

export function amtMap(rows) {
    const m = new Map();
    for (const r of rows || []) {
        const d = String(r.date || '').replace(/\//g, '-').slice(0, 10);
        const a = (+r.volume || 0) * (+r.close || 0);
        if (d && a > 0) m.set(d, a);
    }
    return m;
}
const q = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; };
export function summarize(parts) {
    const ok = parts.filter(x => x != null);
    return { n: ok.length, miss: parts.length - ok.length, med: q(ok, 0.5), p90: q(ok, 0.9), p99: q(ok, 0.99), max: ok.length ? Math.max(...ok) : null,
        over1: ok.filter(x => x > 1).length, over5: ok.filter(x => x > 5).length, over10: ok.filter(x => x > 10).length };
}
export function run(trades, loadK, lot) {
    const cache = new Map(), ent = [], ext = [], worst = [];
    const am = sym => { if (!cache.has(sym)) cache.set(sym, amtMap(loadK(sym))); return cache.get(sym); };
    const seen = new Set();
    for (const t of trades) {
        const key = `${t.sym}|${t.d}|${t.outD}`; if (seen.has(key)) continue; seen.add(key);
        const m = am(t.sym), a = m.get(String(t.d).slice(0, 10)), b = m.get(String(t.outD).replace(/\//g, '-').slice(0, 10));
        const pe = a ? lot / a * 100 : null, px = b ? lot / b * 100 : null;
        ent.push(pe); ext.push(px);
        worst.push({ sym: t.sym, d: t.d, outD: t.outD, pe, px });
    }
    worst.sort((x, y) => Math.max(y.pe || 0, y.px || 0) - Math.max(x.pe || 0, x.px || 0));
    return { trades: seen.size, entry: summarize(ent), exit: summarize(ext), worst: worst.slice(0, 10) };
}

function selftest() {
    let ok = 0, bad = 0; const T = (n, c) => { console.log(`${c ? '✅' : '❌'} ${n}`); c ? ok++ : bad++; };
    const K = { A: [{ date: '2024/01/02', volume: 1000000, close: 10 }, { date: '2024/01/10', volume: 10000, close: 10 }] };
    const r = run([{ sym: 'A', d: '2024-01-02', outD: '2024/01/10' }, { sym: 'A', d: '2024-01-02', outD: '2024/01/10' }], s => K[s], 150000);
    T('① 去重(兩條起點同一筆只算一次)', r.trades === 1);
    T('② 進場參與率 = 15 萬 ÷ 1,000 萬 = 1.5%', Math.abs(r.entry.med - 1.5) < 1e-9);
    T('③ 出場日用出場那天的成交額(150%)', Math.abs(r.exit.med - 150) < 1e-9 && r.exit.over10 === 1);
    const r2 = run([{ sym: 'A', d: '2024-01-03', outD: '2024-01-10' }], s => K[s], 150000);
    T('④ 那天沒有 K 線 → 記成缺,⛔ 不當 0', r2.entry.n === 0 && r2.entry.miss === 1);
    console.log(`selftest ${ok}/${ok + bad}`); process.exit(bad ? 1 : 0);
}

if (process.argv.includes('--selftest')) selftest();
else if (import.meta.url === `file://${process.argv[1]}`) {
    const DATA = process.env.DATA_DIR; const LOT = +(process.env.LOT || 150000);
    if (!DATA) { console.error('❌ 要 DATA_DIR'); process.exit(1); }
    const ai = process.argv.indexOf('--out'), out = ai > 0 ? process.argv[ai + 1] : '';
    const files = process.argv.slice(2).filter((f, i, a) => !f.startsWith('--') && a[i - 1] !== '--out');
    const trades = files.flatMap(f => { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(j) ? j : (j.rows || j.trades || []); });
    if (!trades.length) { console.error('❌ 一筆交易都沒讀到'); process.exit(1); }
    const loadK = sym => { try { const j = JSON.parse(fs.readFileSync(path.join(DATA, `${sym}.json`), 'utf8')); return Array.isArray(j) ? j : (j.data || []); } catch (_) { return []; } };
    const r = run(trades, loadK, LOT);
    const f = x => x == null ? '—' : x.toFixed(2) + '%';
    for (const [k, nm] of [['entry', '進場日'], ['exit', '出場日']]) {
        const s = r[k];
        console.log(`${nm}:${s.n} 筆(缺 ${s.miss})中位 ${f(s.med)} ・P90 ${f(s.p90)} ・P99 ${f(s.p99)} ・最大 ${f(s.max)} ・>1% ${s.over1} 筆 ・>5% ${s.over5} ・>10% ${s.over10}`);
    }
    console.log('最吃量的 10 筆:', r.worst.map(w => `${w.sym} ${w.d} 進 ${f(w.pe)} 出 ${f(w.px)}`).join(' | '));
    if (out) fs.writeFileSync(out, JSON.stringify({ lot: LOT, ...r }, null, 1));
}
