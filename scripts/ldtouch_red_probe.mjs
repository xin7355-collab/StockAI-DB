#!/usr/bin/env node
/**
 * 🟩➡️🟥 ldtouch_red_probe.mjs —— 個股「盤中摸到跌停、收盤翻紅」之後怎麼走?(2026-11-04)
 *
 * 使用者貼了郭哲榮 11/04 的文章(「3374 盤中摸跌停、收盤翻紅」那段),問「有沒有參考價值」。
 * 以前測過的:收盤**鎖**跌停之後隔天收紅(regime-ldred / ld-market,streak_probe)、大盤層級的破底翻(dipbuy_probe F)
 * → 「同一天之內摸跌停又翻紅」一筆都沒測過,這一支只補這一塊。
 *
 * 事件(日 K,只用當天以前的資料):
 *   碰跌停 = 當天最低 ≤ 前收 ×(1 − 跌停幅度 + 0.5 個百分點)—— 2015-06-01 前跌停 7%、之後 10%(lib_limit)
 *   RED   收盤 > 前收(翻紅)
 *   HALF  收盤收回跌幅的一半以上、但沒翻紅(前收 × (1 − 幅度/2) ≤ 收盤 ≤ 前收)
 *   WEAK  收盤還在跌停附近(≤ 前收 ×(1 − 幅度 + 1 個百分點))—— 對照:一樣摸到跌停,但收不回來
 * 進場:**隔天開盤**買(隔天開盤一價鎖死 → 買不到,剔除並計數)→ 抱 1 / 5 / 20 天收盤賣;扣來回成本 0.44%(abs 欄)
 * ⭐ 對照組:同一天全部股票、同一種進出(陷阱 #50:⛔ 拿整段平均比)→ 「增量」= 事件 − 那天平均
 * 分開看:大盤一起跌(加權那天 ≤ −2%)vs 大盤沒怎麼跌(> −2%)—— 照 ld-market 的分法;
 *        另外一組「大盤盤中跌 ≥2.5%、收盤收回 −2% 以內」(2026-11-04 那種日子)
 * 去重:同一檔 20 個交易日只算第一次 ・斷崖守門 lib_cliff(碰到減資 / 停牌斷層的窗口剔除,⛔ 整檔剔除)
 * 安慰劑:同一檔、日期往後挪 120 個交易日(同樣的進出),看是不是「這幾檔本來就會漲」
 * 每格:次數 / 獨立事件 / 增量 / 扣成本 / 賺的比例 / 前後半 / 逐年同向 / 拿掉最好 5 筆
 * ⛔ 只描述與比較,⛔ 不改 App。
 *
 * 跑法:DATA_DIR=$S/d16 node --max-old-space-size=8000 scripts/ldtouch_red_probe.mjs out.json
 *       node scripts/ldtouch_red_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { limitOf, lockedBar } from './lib_limit.mjs';
import { cliffPrefix, cliffIn } from './lib_cliff.mjs';

export const COST = 0.44, DEDUP = 20, HS = [1, 5, 20], MKT_DROP = -2, SHAM_SHIFT = 120;
// 門檻高原:LD_SLACK = 離跌停幾個百分點內算「碰到」(預設 0.5;1 / 2 = 放寬)
const SLACK = Number.isFinite(+process.env.LD_SLACK) && process.env.LD_SLACK !== undefined ? +process.env.LD_SLACK / 100 : 0.005;
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const r2 = x => x == null || !isFinite(x) ? null : +x.toFixed(2);
const d10 = s => String(s || '').replace(/\//g, '-').slice(0, 10);

/** 那一根屬於哪一類(只用當天與前收):'RED' / 'HALF' / 'WEAK' / null */
export function classify(date, pc, l, c) {
    if (!(pc > 0 && l > 0 && c > 0)) return null;
    const lim = limitOf(date);
    if (l > pc * (1 - lim + SLACK)) return null;           // 沒碰到跌停
    if (c > pc) return 'RED';
    if (c >= pc * (1 - lim / 2)) return 'HALF';
    if (c <= pc * (1 - lim + 0.01)) return 'WEAK';
    return null;
}
/** 一檔:回 [{i, k}](同一檔同一類 20 個交易日只算第一次) */
export function eventsOf(R) {
    const out = [], last = {};
    for (let i = 1; i < R.length; i++) {
        if (!(R[i].v > 0)) continue;
        const k = classify(R[i].d, R[i - 1].c, R[i].l, R[i].c);
        if (!k) continue;
        if (last[k] != null && i - last[k] < DEDUP) continue;
        last[k] = i; out.push({ i, k });
    }
    return out;
}
/** 隔天開盤買、第 i+h 天收盤賣(h ≥ 1);隔天開盤鎖死 / 沒量 / 斷崖 → null */
export function tradeRet(R, i, h, pre) {
    const e = i + 1, x = i + h;
    if (x >= R.length) return null;
    const o = R[e].o, pc = R[i].c;
    if (!(o > 0) || !(R[e].v > 0) || !(R[x].c > 0)) return null;
    if (lockedBar(R[e].d, pc, R[e].o, R[e].h, R[e].l) !== 0) return null;
    if (pre && cliffIn(pre, i, x)) return null;
    return (R[x].c / o - 1) * 100;
}
function loadRows(p) {
    let a; try { a = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
    if (!Array.isArray(a)) return null;
    return a.map(r => ({ d: d10(r.date), o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +r.volume }))
        .filter(r => r.c > 0).sort((x, y) => x.d < y.d ? -1 : 1);
}
/** 每一格:增量(事件 − 那天全部股票平均)統計 */
export function cellStats(ev, base) {
    const inc = [], abs = [], yr = {};
    for (const e of ev) {
        const b = base.get(e.d); if (!b || b.n < 50) continue;
        const x = e.r - b.s / b.n; inc.push({ d: e.d, x }); abs.push(e.r - COST);
        const y = e.d.slice(0, 4); (yr[y] = yr[y] || []).push(x);
    }
    if (inc.length < 5) return { n: inc.length };
    inc.sort((a, b) => a.d < b.d ? -1 : 1);
    const xs = inc.map(o => o.x), half = xs.length >> 1, m = mean(xs);
    const ys = Object.values(yr).filter(a => a.length >= 3), yPos = ys.filter(a => mean(a) > 0).length;
    const top5 = xs.slice().sort((a, b) => b - a).slice(5);
    const sd = Math.sqrt(mean(xs.map(v => (v - m) ** 2)));
    return { n: xs.length, inc: r2(m), t: r2(m / (sd / Math.sqrt(xs.length))), abs: r2(mean(abs)), win: r2(abs.filter(v => v > 0).length / abs.length * 100),
        h1: r2(mean(xs.slice(0, half))), h2: r2(mean(xs.slice(half))), yrs: `${yPos}/${ys.length}`, noTop5: r2(mean(top5)) };
}

function main() {
    const DIR = process.env.DATA_DIR; if (!DIR) { console.error('需要 DATA_DIR(d16)'); process.exit(1); }
    const twii = loadRows(path.join(DIR, '^TWII.json'));
    if (!twii || twii.length < 1000) { console.error('⛔ 讀不到 ^TWII.json'); process.exit(1); }
    const mret = new Map(), mlow = new Map();
    for (let i = 1; i < twii.length; i++) { mret.set(twii[i].d, (twii[i].c / twii[i - 1].c - 1) * 100); if (twii[i].l > 0) mlow.set(twii[i].d, (twii[i].l / twii[i - 1].c - 1) * 100); }
    const files = fs.readdirSync(DIR).filter(f => /^[1-9]\d{3}\.json$/.test(f));
    const base = Object.fromEntries(HS.map(h => [h, new Map()]));
    const ev = [], sham = []; let nLock = 0, nCliff = 0, nStk = 0;
    for (const f of files) {
        const R = loadRows(path.join(DIR, f)); if (!R || R.length < 60) continue;
        nStk++;
        const pre = cliffPrefix(R.map(r => r.c), R.map(r => r.o));
        // 同一天全部股票(同一種進出)
        for (let i = 1; i < R.length; i++) for (const h of HS) {
            const r = tradeRet(R, i, h, pre); if (r == null) continue;
            const m = base[h], b = m.get(R[i].d) || { s: 0, n: 0 }; b.s += r; b.n++; m.set(R[i].d, b);
        }
        for (const e of eventsOf(R)) {
            const mk = mret.get(R[e.i].d); if (mk == null) continue;
            const grp = mk <= MKT_DROP ? 'mkt' : 'own';
            // ⭐ 大盤盤中也跌 ≥2.5% 但收盤收回到 −2% 以內(11/04 那種:盤中跌 1,400 點、收盤收回大半)
            const ml = mlow.get(R[e.i].d), hm = ml != null && ml <= -2.5 && mk > MKT_DROP;
            const row = { sym: f.slice(0, 4), d: R[e.i].d, k: e.k, grp, hm, r: {} };
            for (const h of HS) {
                const r = tradeRet(R, e.i, h, pre);
                if (r == null) { if (h === 1) { if (R[e.i + 1] && lockedBar(R[e.i + 1].d, R[e.i].c, R[e.i + 1].o, R[e.i + 1].h, R[e.i + 1].l) !== 0) nLock++; else nCliff++; } continue; }
                row.r[h] = r;
            }
            ev.push(row);
            const j = e.i + SHAM_SHIFT;
            if (j < R.length - 1) { const s = { sym: row.sym, d: R[j].d, k: e.k, grp, hm, r: {} }; for (const h of HS) { const r = tradeRet(R, j, h, pre); if (r != null) s.r[h] = r; } sham.push(s); }
        }
    }
    const span = ev.map(e => e.d).sort();
    console.log(`📊 ${nStk} 檔(含下市)・事件 ${ev.length} 筆(${span[0]} ~ ${span.at(-1)})・隔天開盤鎖死買不到 ${nLock} 筆・斷崖 / 資料不夠 ${nCliff} 筆`);
    const out = { stocks: nStk, n: ev.length, cells: {} };
    const inG = (e, grp) => grp === 'all' || (grp === 'hm' ? e.hm : e.grp === grp);
    for (const k of ['RED', 'HALF', 'WEAK']) for (const grp of ['all', 'mkt', 'own', 'hm']) {
        const E = ev.filter(e => e.k === k && inG(e, grp));
        const Sm = sham.filter(e => e.k === k && inG(e, grp));
        const line = [];
        for (const h of HS) {
            const c = cellStats(E.filter(e => e.r[h] != null).map(e => ({ d: e.d, r: e.r[h] })), base[h]);
            const s = cellStats(Sm.filter(e => e.r[h] != null).map(e => ({ d: e.d, r: e.r[h] })), base[h]);
            out.cells[`${k}/${grp}/${h}`] = { ...c, sham: s.inc };
            line.push(c.n >= 5 ? `${h} 天 增量 ${c.inc}pp(t=${c.t})・扣成本 ${c.abs}%・賺 ${c.win}%・前半 ${c.h1}/後半 ${c.h2}・逐年 ${c.yrs}・拿掉最好 5 筆 ${c.noTop5}・挪 120 天安慰劑 ${s.inc}・n=${c.n}` : `${h} 天 n=${c.n}`);
        }
        console.log(`\n[${k} ${grp === 'all' ? '全部' : grp === 'mkt' ? '大盤一起跌(加權收盤 ≤ −2%)' : grp === 'hm' ? '大盤盤中跌 ≥2.5%、收盤收回 −2% 以內' : '大盤收盤沒跌到 −2%'}] ${E.length} 筆`);
        for (const l of line) console.log('   ' + l);
    }
    // RED vs WEAK(同樣摸跌停,收得回來 vs 收不回來):差多少
    console.log('\n翻紅 − 收在跌停附近(增量的差):' + HS.map(h => { const a = out.cells[`RED/all/${h}`], b = out.cells[`WEAK/all/${h}`]; return `${h} 天 ${a.inc != null && b.inc != null ? r2(a.inc - b.inc) : '-'}pp`; }).join(' ・'));
    const recent = ev.filter(e => e.k === 'RED' && e.d >= '2026-01-01').map(e => `${e.sym} ${e.d.slice(5)}`);
    console.log(`2026 年翻紅的:${recent.length} 筆 ${recent.slice(-15).join(' ')}`);
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
}

function selftest() {
    let ok = 0, bad = 0; const T = (c, m) => { if (c) ok++; else { bad++; console.log('❌', m); } };
    T(classify('2020-03-16', 100, 90.3, 101) === 'RED', '① 摸跌停 −9.7%、收紅 → RED');
    T(classify('2020-03-16', 100, 90.3, 96) === 'HALF', '② 收回一半以上沒翻紅 → HALF');
    T(classify('2020-03-16', 100, 90.3, 90.8) === 'WEAK', '③ 收在跌停附近 → WEAK');
    T(classify('2020-03-16', 100, 91.0, 101) === null, '④ 只跌 9% 沒碰到跌停 → 不算');
    T(classify('2012-03-16', 100, 93.3, 101) === 'RED' && classify('2020-03-16', 100, 93.3, 101) === null, '⑤ 2015-06 前跌停 7%(同一根在 2020 年不算碰跌停)');
    // ⑥ 去重:同一類 20 天內只算一次
    const mk = (n, f) => { const R = []; let p = 100; for (let i = 0; i < n; i++) { const r = f(i, p); R.push({ d: new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString().slice(0, 10), ...r, v: 1000 }); p = r.c; } return R; };
    const Rd = mk(100, (i, p) => (i === 30 || i === 35 || i === 60) ? { o: p, h: p, l: p * 0.905, c: p * 1.01 } : { o: p, h: p, l: p, c: p });
    T(eventsOf(Rd).map(e => e.i).join() === '30,60', '⑥ 20 天內第二次不算(' + eventsOf(Rd).map(e => e.i).join() + ')');
    // ⑦ 隔天開盤鎖死買不到
    const Rl = [{ d: '2020-01-01', o: 100, h: 100, l: 100, c: 100, v: 1 }, { d: '2020-01-02', o: 100, h: 101, l: 90.3, c: 101, v: 1 }, { d: '2020-01-03', o: 111, h: 111, l: 111, c: 111, v: 1 }, { d: '2020-01-04', o: 111, h: 112, l: 110, c: 112, v: 1 }];
    T(tradeRet(Rl, 1, 1, null) === null, '⑦ 隔天開盤鎖漲停 → 買不到');
    T(tradeRet(Rl, 1, 2, null) === null, '⑦b 鎖死那筆所有天期都不算');
    // ⑧ ⛔ 前視:改掉事件之後的資料,事件本身不變
    const Rf = Rd.map((r, k) => k > 40 ? { ...r, c: r.c * 3, l: r.l * 3, h: r.h * 3, o: r.o * 3 } : r);
    T(eventsOf(Rf).filter(e => e.i <= 40).map(e => e.i).join() === '30', '⑧ 改掉之後的資料 → 之前的事件不變');
    // ⑨ 同一天對照:事件跟那天平均一樣 → 增量 0;埋 +2 → 增量 2
    const base = new Map([['2020-01-02', { s: 100, n: 100 }], ['2020-01-03', { s: -100, n: 100 }]]);
    const evs = []; for (let k = 0; k < 10; k++) evs.push({ d: k % 2 ? '2020-01-03' : '2020-01-02', r: k % 2 ? -1 : 1 });
    T(cellStats(evs, base).inc === 0, '⑨ 跟同一天一樣 → 增量 0(⛔ 拿整段平均比會是 +1/−1 混在一起)');
    T(cellStats(evs.map(e => ({ ...e, r: e.r + 2 })), base).inc === 2, '⑩ 埋 +2 → 增量 2');
    console.log(`selftest ${ok} ok / ${bad} bad`); process.exit(bad ? 1 : 0);
}

const IS_MAIN = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) { if (process.argv.includes('--selftest')) selftest(); else main(); }
