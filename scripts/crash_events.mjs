#!/usr/bin/env node
// 🌪️ V82.0.0 大跌事件 —— 全 repo 唯一一份(App 跳通知、Telegram 08:00 都只讀它產的 data/crash_events.json)
//
// 定義跟 scripts/lib_crash.mjs corrLegs(收盤離近 250 天最高收盤跌 ≥10% 進修正段、回到 5% 以內結束)
//   + crash_cycle_probe.fastEvents(收盤 ≤ 前 25 天最高收盤 × 0.85,⛔ 不含當天)一字不差 —— App `_crashFastState` 逐日比(test_crash_events)
// 事件(每一段每一種只算一次,全部是「收盤之後已經發生的事」):
//   leg10  = 這一段第一天(收盤離近 250 天最高收盤跌 ≥10%)
//   fast15 = 這一段裡第一次「收盤 ≤ 前 25 天最高收盤 × 0.85」
//   bear20 = 這一段裡第一次收盤離近 250 天最高收盤跌 ≥20%
//   end    = 這一段結束那天(收盤回到離近 250 天最高收盤 5% 以內)
// ⛔ 只描述;⛔ 不是買賣訊號。發生率 OCC 由 --occ 用加權 2000 起算好抄進來(⛔ 手改)。
//
// 跑法:
//   node scripts/crash_events.mjs [DATA=data] [OUT=data/crash_events.json]
//   IDX_LONG=… IDX_EARLY=… TWII_NOW=… node scripts/crash_events.mjs --occ      (印出 OCC)
//   node scripts/crash_events.mjs --selftest
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { corrLegs } from './lib_crash.mjs';
import { tpeNow, addOpenDays, fetchClosed } from './dip_pick.mjs';

export const W = 250, FW = 25, FX = 0.85;
const r1 = x => Number.isFinite(x) ? Math.round(x * 10) / 10 : null;

// 🎲 發生率(--occ 算的;加權 2000-01 起 = idx_long_early + idx_long + ^TWII,只算已經走完的段)
//   ⛔ 手改 —— 重跑 --occ 再抄。fast15 那一組是 crash_global_probe(1990 起,8 個市場)= index.html `_CRASH_OCC` 同一份(test 跨檔比)
export const OCC = {
    from: 2000, to: '2026-11-05',
    leg10: { n: 24, d15: 16, d20: 9, end20: 6 },      // 走完的 24 段:最深跌到 15% 以上 16 段、20% 以上 9 段;20 個交易日內就結束 6 段
    bear20: { n: 9, more10: 5, end250: 5 },           // 跌到 20% 的 9 段:之後最低再比那天收盤低 ≥10% 有 5 段;250 個交易日內結束 5 段
    end: { n: 23, again60: 6 },                       // 結束之後 60 個交易日內又進新的一段:23 次裡 6 次
    fast15: { from: 1990, n: 21, leg: 20, wk: 8, mo: 7, half: 5, re: 12, reN: 19, base: 57 },
};

/** 一份收盤序列 → 每一段 + 四種事件(純函式) */
export function legsWithEvents(c, d) {
    const { corr, legs, hi } = corrLegs(c, W, 10, 5);
    return legs.map((L, k) => {
        const ev = [], pk = { d: d[L.peakI], c: L.peak };
        const mk = (kind, i) => ({ k: kind, d: d[i], c: c[i], dd: r1((c[i] / hi[i] - 1) * 100) });
        ev.push(mk('leg10', L.s));
        for (let i = Math.max(L.s, FW); i <= L.e; i++) {
            if (corr[i] !== k) continue;
            let mx = -Infinity; for (let j = i - FW; j < i; j++) if (c[j] > mx) mx = c[j];
            if (c[i] <= mx * FX) { ev.push(mk('fast15', i)); break; }
        }
        for (let i = L.s; i <= L.e; i++) if (corr[i] === k && c[i] / hi[i] - 1 <= -0.20) { ev.push(mk('bear20', i)); break; }
        if (!L.open && L.e + 1 < c.length) ev.push(mk('end', L.e + 1));
        return { s: d[L.s], si: L.s, peak: pk, low: { d: d[L.lowI], c: L.low }, depth: r1(L.depth), open: L.open ? 1 : 0, ei: L.open ? null : L.e + 1, ev };
    });
}

/** 正式產物(純函式):dates / closes = ^TWII,opt = { now, closed } */
export function buildCrash(dates, closes, opt = {}) {
    const now = opt.now || new Date(), T = tpeNow(now), closed = opt.closed || new Set();
    let n = closes.length;
    const partial = dates[n - 1] === T.d && T.min < 14 * 60 + 30;   // 最後一根是今天、還沒 14:30 → 先不算(同 dip_pick)
    if (partial) n--;
    const c = closes.slice(0, n), d = dates.slice(0, n);
    const legs = n >= W + FW ? legsWithEvents(c, d) : [];
    // 只留資料第 250 天之後開始的段(前面那段的「近 250 天最高」還不滿 250 天),最近 4 段
    const keep = legs.filter(L => L.si >= W).slice(-4).map(({ si, ei, ...L }) => L);
    const through = d[n - 1];
    return { v: 1, asof: dates[dates.length - 1], partial: partial ? 1 : 0, through, nx: addOpenDays(through, 1, closed),
             updated: now.toISOString(), occ: OCC, legs: keep };
}

// ───────── 發生率(--occ)─────────
async function occMain() {
    const { loadIndex } = await import('./lib_crash.mjs');
    const S = loadIndex(process.env);
    const c = S.c, d = S.d;
    const legs = legsWithEvents(c, d);
    const done = legs.filter(L => !L.open);
    const evOf = (L, k) => L.ev.find(e => e.k === k);
    const idx = new Map(d.map((x, i) => [x, i]));
    const o = { from: +d[0].slice(0, 4), to: d[d.length - 1], leg10: { n: done.length, d15: 0, d20: 0, end20: 0 }, bear20: { n: 0, more10: 0, end250: 0 }, end: { n: 0, again60: 0 } };
    for (const L of done) {
        if (L.depth <= -15) o.leg10.d15++;
        if (L.depth <= -20) o.leg10.d20++;
        const s = idx.get(L.s), e = idx.get(evOf(L, 'end').d);
        if (e - s <= 20) o.leg10.end20++;
        const b = evOf(L, 'bear20');
        if (b) { o.bear20.n++; if (L.low.c <= b.c * 0.9) o.bear20.more10++; if (e - idx.get(b.d) <= 250) o.bear20.end250++; }
    }
    const allLegStarts = legs.map(L => idx.get(L.s));
    for (const L of done) {
        const e = idx.get(evOf(L, 'end').d); if (e + 60 >= c.length) continue;
        o.end.n++; if (allLegStarts.some(s => s > e && s <= e + 60)) o.end.again60++;
    }
    console.log(`加權 ${d[0]} ~ ${d[d.length - 1]}(${c.length} 天)・修正段 ${legs.length} 段(走完 ${done.length})`);
    for (const L of legs) console.log(`  ${L.s} 高點 ${L.peak.d} ${Math.round(L.peak.c)} → 低點 ${L.low.d} ${L.depth}% ${L.open ? '(還沒走完)' : ''} 事件:${L.ev.map(e => `${e.k} ${e.d}`).join(' ・')}`);
    console.log('OCC =', JSON.stringify(o));
}

async function main() {
    const DATA = process.argv[2] || 'data', OUT = process.argv[3] || path.join(DATA, 'crash_events.json');
    const p = path.join(DATA, '^TWII.json');
    if (!fs.existsSync(p)) { console.error(`❌ 沒有 ${p}`); process.exit(1); }
    const rows = JSON.parse(fs.readFileSync(p, 'utf8')).map(r => ({ d: String(r.date).replace(/\//g, '-').slice(0, 10), c: +r.close })).filter(r => r.c > 0).sort((a, b) => a.d < b.d ? -1 : 1);
    if (rows.length < W + FW) { console.error(`❌ 加權只有 ${rows.length} 根(< ${W + FW})→ 不寫檔`); process.exit(1); }
    const hol = await fetchClosed();
    const res = buildCrash(rows.map(r => r.d), rows.map(r => r.c), { now: new Date(), closed: hol.set });
    res.hol = hol.why ? { n: 0, why: hol.why } : { n: hol.set.size };
    fs.writeFileSync(OUT, JSON.stringify(res));
    for (const L of res.legs) console.log(`  ${L.s} 起 ${L.open ? '(還在這一段)' : ''} 最深 ${L.depth}% ・${L.ev.map(e => `${e.k} ${e.d} ${e.dd}%`).join(' ・')}`);
    console.log(`✅ ${OUT}:資料到 ${res.asof}${res.partial ? '(最後一根是盤中,不算)' : ''} ・下一個開盤日 ${res.nx}`);
}

function selftest() {
    let ok = 0, bad = 0;
    const T = (cnd, m) => { if (cnd) ok++; else { bad++; console.log('❌', m); } };
    // 合成:300 天緩漲 → 10 天跌 12%(leg10)→ 再 6 天跌到 −22%(fast15、bear20)→ 回升到高點附近(end)
    const d = [], c = [];
    { let t = Date.UTC(2020, 0, 1), v = 100; const step = () => { do { t += 86400e3; } while ([0, 6].includes(new Date(t).getUTCDay())); return new Date(t).toISOString().slice(0, 10); };
      for (let i = 0; i < 300; i++) { v *= 1.001; d.push(step()); c.push(v); }
      const pk = v;
      for (let i = 0; i < 10; i++) { v *= 0.987; d.push(step()); c.push(v); }
      for (let i = 0; i < 6; i++) { v *= 0.975; d.push(step()); c.push(v); }
      for (let i = 0; i < 60; i++) { v *= 1.005; d.push(step()); c.push(v); }
      T(v / pk > 0.95, '測資:最後要回到離高點 5% 以內'); }
    const L = legsWithEvents(c, d);
    T(L.length === 1, `① 一段(實際 ${L.length})`);
    const ev = Object.fromEntries(L[0].ev.map(e => [e.k, e]));
    const hiAt = i => Math.max(...c.slice(Math.max(0, i - W + 1), i + 1));
    const i10 = c.findIndex((x, i) => i >= W && x / hiAt(i) - 1 <= -0.10);
    T(ev.leg10 && ev.leg10.d === d[i10], '② leg10 = 第一次跌 ≥10% 那天');
    const i20 = c.findIndex((x, i) => i >= W && x / hiAt(i) - 1 <= -0.20);
    T(ev.bear20 && ev.bear20.d === d[i20], '② bear20 = 第一次跌 ≥20% 那天');
    let i15 = -1; for (let i = FW; i < c.length && i15 < 0; i++) { if (i < i10) continue; const mx = Math.max(...c.slice(i - FW, i)); if (c[i] <= mx * FX) i15 = i; }
    T(ev.fast15 && ev.fast15.d === d[i15], '② fast15 = 這一段第一次 25 天內跌 15%(⛔ 含當天)');
    const iEnd = c.findIndex((x, i) => i > i20 && x / hiAt(i) - 1 > -0.05);
    T(ev.end && ev.end.d === d[iEnd], '② end = 回到 5% 以內那天');
    T(L[0].open === 0 && L[0].depth < -20, '② 走完、最深 < −20%');
    // ③ 決定性對照:只跌 9.5% → 沒有任何段
    const c2 = c.slice(0, 300); { let v = c2[299]; for (let i = 0; i < 20; i++) { v *= (i < 10 ? 0.99 : 1.004); c2.push(v); } }
    T(legsWithEvents(c2, d.slice(0, 320)).length === 0, '③ 只跌 9.5% → 沒有修正段(決定性對照)');
    // ④ 盤中那根不算;收盤後才算
    const lastD = d[312], cut = c.slice(0, 313), dd = d.slice(0, 313);
    const noon = new Date(Date.parse(lastD + 'T03:00:00Z')), eve = new Date(Date.parse(lastD + 'T11:00:00Z'));
    const bN = buildCrash(dd, cut, { now: noon }), bE = buildCrash(dd, cut, { now: eve });
    T(bN.partial === 1 && bN.through === d[311] && bE.partial === 0 && bE.through === lastD, '④ 盤中那根不算、收盤後才算');
    T(bE.nx === addOpenDays(lastD, 1, new Set()), '④ nx = 下一個開盤日');
    // ⑤ 只留資料第 250 天之後開始的段
    T(buildCrash(d, c, { now: new Date(Date.UTC(2030, 0, 1)) }).legs.length === 1, '⑤ 正式產物留這一段');
    T(buildCrash(d.slice(0, 200), c.slice(0, 200), { now: new Date(Date.UTC(2030, 0, 1)) }).legs.length === 0, '⑤ 資料太短 → 沒有段(⛔ 硬算)');
    // ⑥ ⛔ 前視:改掉之後的價格,前面的事件不變
    const c3 = c.slice(); for (let i = i20 + 1; i < c3.length; i++) c3[i] = c3[i] * 0.5;
    const ev3 = Object.fromEntries(legsWithEvents(c3, d)[0].ev.map(e => [e.k, e]));
    T(ev3.leg10.d === ev.leg10.d && ev3.fast15.d === ev.fast15.d && ev3.bear20.d === ev.bear20.d && !ev3.end, '⑥ 改掉之後的價格,前面的事件日期不變(⛔ 前視)');
    console.log(`selftest:${ok} 過 / ${bad} 失敗`);
    process.exit(bad ? 1 : 0);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
    if (process.argv.includes('--selftest')) selftest();
    else if (process.argv.includes('--occ')) occMain().catch(e => { console.error('❌', e); process.exit(1); });
    else main().catch(e => { console.error('❌', e); process.exit(1); });
}
