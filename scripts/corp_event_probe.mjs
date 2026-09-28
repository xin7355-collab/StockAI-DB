#!/usr/bin/env node
/**
 * 🏢 corp_event_probe.mjs —— 「減資後恢復買賣那天買進」有沒有東西?(外部評估 ㊷ FinPilot 的 capital_reduction 模板)
 *
 * FinPilot 的假說:「現金減資 = 公司還錢股東,恢復交易日計價基準重設有反彈空間」。
 * 資料:data/corp_events.json(corp_events.yml 手動採礦,FinMind TaiwanStockCapitalReductionReferencePrice;date = 恢復買賣日)
 *
 * 口徑(⭐ 只用「恢復買賣日當天及之後」的價格 —— 之前的價格尺標可能沒還原,陷阱 #21):
 *   A 恢復買賣日**開盤**買 → 那天之後第 h 個交易日收盤(h = 1/5/20/60)
 *   B 恢復買賣日**收盤**買 → 同上
 *   市場腿 = 0050 同一段同口徑(開盤買用 0050 自己的開盤,⛔ 不用 ^TWII 開盤 —— 陷阱 #47)
 *   買不到:開盤就在參考價 +9.5% 以上而且整天最低也在那裡(鎖漲停)→ 剔除並計數
 *   尺標守門:恢復買賣日收盤 ÷ 官方參考價 不在 0.8~1.25 → 資料對不上,剔除並計數(⛔ 不硬算)
 *   去重:同一檔 120 天內只算一次
 *   關卡:全期 / 前後半 / 逐年 / 去最好年 / 扣成本 0.44% 後的**絕對**報酬(⛔ 不只看超額)
 *   分組:原因(現金減資 / 彌補虧損 / 其他)× 口徑
 *
 * 跑法:CORP=$S/corp_events.json DATA_DIR=$S/d10n node scripts/corp_event_probe.mjs out.json
 *       node scripts/corp_event_probe.mjs --selftest
 */
import fs from 'node:fs';
import path from 'node:path';

export const COST = 0.0044;
export const HS = [1, 5, 20, 60];
const d10 = s => String(s).replace(/\//g, '-').slice(0, 10);

export function reasonOf(r) {
    const t = String(r.ReasonforCapitalReduction || r.reason || '');
    if (/彌補|虧損|making up|loss/i.test(t)) return '彌補虧損';
    if (/現金|退還|返還|股款|cash|refund/i.test(t)) return '現金減資';   // ⚠️ FinMind 這欄中英混雜(實測 Cash refund 212 / Making up losses 180)
    return t ? '其他:' + t.slice(0, 8) : '不明';
}

/** 一個事件 → 各口徑各天期的 {ret, mkt, ex};bars/bench = [{d,o,h,l,c}] 依日期排序 */
export function eventOutcome(bars, bench, D, ref) {
    const i = bars.findIndex(b => b.d === D);
    if (i < 0) return { skip: 'no-bar' };
    const b = bars[i];
    if (ref > 0 && !(b.c / ref > 0.8 && b.c / ref < 1.25)) return { skip: 'scale' };
    if (ref > 0 && b.o >= ref * 1.095 && b.l >= ref * 1.095) return { skip: 'locked' };
    const j = bench.findIndex(x => x.d === D);
    if (j < 0) return { skip: 'no-bench' };
    const out = {};
    for (const h of HS) {
        const e = bars[i + h], m = bench[j + h];
        if (!e || !m || !(e.c > 0)) continue;
        out['o' + h] = { ret: e.c / b.o - 1, mkt: m.c / bench[j].o - 1 };
        out['c' + h] = { ret: e.c / b.c - 1, mkt: m.c / bench[j].c - 1 };
        for (const k of ['o' + h, 'c' + h]) out[k].ex = out[k].ret - out[k].mkt;
    }
    return out;
}

export function tstat(a) {
    const n = a.length; if (n < 2) return { n, mean: NaN, t: NaN };
    const m = a.reduce((x, y) => x + y, 0) / n, sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (n - 1));
    const s = [...a].sort((x, y) => x - y);
    return { n, mean: m, med: s[n >> 1], t: sd > 0 ? m / (sd / Math.sqrt(n)) : 0, win: a.filter(v => v > 0).length / n };
}

/** 關卡:recs = [{y, ex, ret}];回 {all, half, years, dropBest, absAfterCost, pass} */
export function gates(recs) {
    const all = tstat(recs.map(r => r.ex));
    const sorted = [...recs].sort((a, b) => a.d < b.d ? -1 : 1), mid = sorted.length >> 1;
    const h1 = tstat(sorted.slice(0, mid).map(r => r.ex)).mean, h2 = tstat(sorted.slice(mid).map(r => r.ex)).mean;
    const byY = {}; for (const r of recs) (byY[r.y] ||= []).push(r.ex);
    const years = Object.fromEntries(Object.entries(byY).map(([y, a]) => [y, { n: a.length, mean: tstat(a).mean }]));
    const yVals = Object.values(years).filter(v => v.n >= 3);
    const sameSign = yVals.length >= 3 && yVals.filter(v => Math.sign(v.mean) === Math.sign(all.mean)).length >= Math.ceil(yVals.length * 0.75);
    const best = Object.entries(years).sort((a, b) => b[1].mean * b[1].n - a[1].mean * a[1].n)[0];
    const dropBest = best ? tstat(recs.filter(r => r.y !== best[0]).map(r => r.ex)).mean : NaN;
    const abs = tstat(recs.map(r => r.ret - COST)).mean;
    const g = { all, h1, h2, years, sameSign, dropBest, abs };
    g.pass = [all.mean > 0 && all.t >= 2, h1 > 0 && h2 > 0, sameSign, dropBest > 0, abs > 0];
    return g;
}

function loadBars(file) {
    const a = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (Array.isArray(a) ? a : a.data || []).map(r => ({ d: d10(r.date), o: +r.open, h: +r.high, l: +r.low, c: +r.close })).filter(b => b.c > 0 && b.o > 0).sort((x, y) => x.d < y.d ? -1 : 1);
}

function main(outPath) {
    const CORP = process.env.CORP, DATA = process.env.DATA_DIR;
    if (!CORP || !DATA) { console.error('需要 CORP 與 DATA_DIR'); process.exit(1); }
    const J = JSON.parse(fs.readFileSync(CORP, 'utf8'));
    const bench = loadBars(path.join(DATA, '_bench0050.json'));
    const ev = (J.cr || []).map(r => ({ sym: String(r.stock_id), d: d10(r.date), ref: +r.PostReductionReferencePrice || 0, why: reasonOf(r), raw: r }))
        .filter(e => /^[1-9]\d{3}$/.test(e.sym)).sort((a, b) => a.d < b.d ? -1 : 1);
    console.log(`📦 減資事件 ${ev.length} 筆(4 碼普通股)・${ev[0]?.d} ~ ${ev.at(-1)?.d}`);
    const skip = {}, last = new Map(), recs = [];
    const cache = new Map();
    for (const e of ev) {
        const prev = last.get(e.sym);
        if (prev && (new Date(e.d) - new Date(prev)) / 864e5 < 120) { skip.dedup = (skip.dedup || 0) + 1; continue; }
        const f = path.join(DATA, e.sym + '.json');
        if (!fs.existsSync(f)) { skip.nofile = (skip.nofile || 0) + 1; continue; }
        if (!cache.has(e.sym)) cache.set(e.sym, loadBars(f));
        const o = eventOutcome(cache.get(e.sym), bench, e.d, e.ref);
        if (o.skip) { skip[o.skip] = (skip[o.skip] || 0) + 1; continue; }
        last.set(e.sym, e.d);
        recs.push({ ...e, o });
    }
    console.log(`   可用 ${recs.length} 筆・剔除 ${JSON.stringify(skip)}`);
    const P = x => (x * 100).toFixed(2) + '%';
    const res = {};
    for (const grp of ['全部', '現金減資', '彌補虧損']) {
        const sub = grp === '全部' ? recs : recs.filter(r => r.why === grp);
        for (const k of ['o1', 'o5', 'o20', 'o60', 'c20', 'c60']) {
            const rr = sub.filter(r => r.o[k]).map(r => ({ d: r.d, y: r.d.slice(0, 4), ex: r.o[k].ex, ret: r.o[k].ret }));
            if (rr.length < 10) { res[`${grp}|${k}`] = { n: rr.length, note: '樣本不足' }; continue; }
            const g = gates(rr);
            res[`${grp}|${k}`] = { n: g.all.n, mean: g.all.mean, med: g.all.med, t: g.all.t, win: g.all.win, h1: g.h1, h2: g.h2, dropBest: g.dropBest, abs: g.abs, sameSign: g.sameSign, pass: g.pass, years: g.years };
            console.log(`   ${grp.padEnd(4, ' ')} ${k.padEnd(3)} n=${String(g.all.n).padStart(4)} 超額 ${P(g.all.mean)}(中位 ${P(g.all.med)},t=${g.all.t.toFixed(2)},贏 ${P(g.all.win)})・前/後半 ${P(g.h1)}/${P(g.h2)}・去最好年 ${P(g.dropBest)}・扣成本絕對 ${P(g.abs)}・關卡 ${g.pass.filter(Boolean).length}/5`);
        }
        const yy = res[`${grp}|o20`]?.years;
        if (yy) console.log('      逐年(開盤買 20 日超額):' + Object.entries(yy).map(([y, v]) => `${y} ${P(v.mean)}(${v.n})`).join(' ・'));
    }
    if (outPath) fs.writeFileSync(outPath, JSON.stringify({ updated: new Date().toISOString().slice(0, 10), n: recs.length, skip, res }, null, 0));
}

function selftest() {
    let ok = 0, bad = 0; const t = (c, m) => { if (c) { ok++; console.log('  ✅ ' + m); } else { bad++; console.log('  ❌ ' + m); } };
    const mk = (n, f) => Array.from({ length: n }, (_, i) => { const c = f(i); return { d: `2020-01-${String(i + 1).padStart(2, '0')}`, o: c, h: c, l: c, c }; });
    const bars = mk(25, i => 10 * (1 + 0.01 * i)), bench = mk(25, () => 50);
    const o = eventOutcome(bars, bench, '2020-01-03', 10.2);
    t(o.o1 && Math.abs(o.o1.ret - (10.3 / 10.2 - 1)) < 1e-12 && Math.abs(o.o1.ex - o.o1.ret) < 1e-12, '① 開盤買 → 隔天收盤;市場腿 0050 不動 → 超額 = 報酬');
    t(eventOutcome(bars, bench, '2020-01-03', 5).skip === 'scale', '② 收盤 ÷ 參考價 = 2.04 → 尺標對不上,剔除');
    const lk = mk(25, () => 11); t(eventOutcome(lk, bench, '2020-01-03', 10).skip === 'locked', '③ 開盤 = 最低 = 參考價 +10% → 鎖漲停買不到,剔除');
    t(eventOutcome(bars, bench, '2020-02-30', 10).skip === 'no-bar', '④ 恢復買賣日沒有 K 棒 → 剔除(⛔ 不挪到隔天)');
    // ⑤ 前視:只用恢復買賣日當天及之後 —— 把之前的價格改成垃圾,結果不可變
    const b2 = bars.map((b, i) => i < 2 ? { ...b, o: 999, c: 999, h: 999, l: 999 } : b);
    t(JSON.stringify(eventOutcome(b2, bench, '2020-01-03', 10.2)) === JSON.stringify(o), '⑤ 恢復買賣日之前的價格改成垃圾 → 結果一字不變(沒用到舊尺標)');
    t(reasonOf({ ReasonforCapitalReduction: '彌補虧損' }) === '彌補虧損' && reasonOf({ ReasonforCapitalReduction: '退還股款' }) === '現金減資'
      && reasonOf({ ReasonforCapitalReduction: 'Cash refund' }) === '現金減資' && reasonOf({ ReasonforCapitalReduction: 'Making up losses' }) === '彌補虧損', '⑥ 原因分類(中英混雜都要認得)');
    const g = gates([...Array(40)].map((_, i) => ({ d: `20${18 + (i % 4)}-06-01`, y: String(2018 + (i % 4)), ex: 0.02 + (i % 2 ? 0.01 : -0.01), ret: 0.03 })));
    t(g.pass.every(Boolean), '⑦ 全部為正的合成樣本 → 五關全過');
    const g2 = gates([...Array(40)].map((_, i) => ({ d: `20${18 + (i % 4)}-06-01`, y: String(2018 + (i % 4)), ex: -0.02 + (i % 2 ? 0.01 : -0.01), ret: 0.001 })));
    t(!g2.pass[0] && !g2.pass[4], '⑧ 負的合成樣本 → 全期與扣成本那兩關不過');
    console.log(`\n${bad ? '❌' : '✅'} selftest ${ok}/${ok + bad}`);
    process.exit(bad ? 1 : 0);
}

if (process.argv[1] && process.argv[1].endsWith('corp_event_probe.mjs')) {
    if (process.argv.includes('--selftest')) selftest(); else main(process.argv[2]);
}
