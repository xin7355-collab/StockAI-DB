#!/usr/bin/env node
/**
 * 🎤 法說會之後那一檔怎麼走 —— 正式回測(V78.2.5)
 *
 * 以前只有 `confcall_miner.build_react` 的事實統計(法說會當天收盤 → +N 天,⛔ 沒扣成本、沒過六關,
 * 而且窗口只從 2026-07 起)。`hist_backfill.yml` 把場次往回補到約 5 年前之後,這支才測得動。
 *
 * ⭐ 口徑:法說會常在盤後 → 一律**隔天開盤**買(零前視),抱 h 天收盤賣,扣 0.44%;同期 0050 同一段(開盤→收盤)扣掉
 * ⭐ 對照組 = **同一檔、同一年的每一個交易日**用一模一樣的做法(量的是「法說會」這件事,⛔ 不是那檔那幾年本來就強 / 弱)
 * ⭐ 同一檔 20 個交易日內只算一次;隔天開盤鎖漲停(買不到)剔除並計數
 * ⭐ 方向事前不知道 → 兩個方向都報;六關照「量到的那個方向」判(⚠️ 這樣做比較寬鬆,結論寫在畫面時要講)
 *
 * 跑法:CONFCALL=$S/confcall.json DATA_DIR=$S/d10n node scripts/confcall_event_probe.mjs [out.json]
 *       node scripts/confcall_event_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { gates } from './maxim_kbar5_probe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const COST = 0.44, DEDUP = 20;
export const HS = [1, 3, 5, 10, 20];

/** K = [{date, open, close}](排序);mk = Map(date → {o, c})(0050)。回這一檔所有「隔天開盤進、抱 h 天」的超額。 */
export function excessAt(K, mk, i, h) {
    const a = K[i + 1], b = K[i + h];
    if (!a || !b || !(a.open > 0)) return null;
    const m1 = mk.get(a.date), m2 = mk.get(b.date);
    if (!m1 || !m2 || !(m1.o > 0)) return null;
    if (a.open >= K[i].close * 1.095) return 'lock';        // 開盤就漲停 → 買不到
    return (b.close / a.open - 1) * 100 - COST - (m2.c / m1.o - 1) * 100;
}

export function run(hist, loadK, mk, h) {
    const ev = [], cnt = { lock: 0, noK: 0, dedup: 0 };
    for (const [sym, dates] of Object.entries(hist)) {
        const K = loadK(sym); if (!K) { cnt.noK += dates.length; continue; }
        const idx = new Map(K.map((r, i) => [r.date, i]));
        // ⭐ V78.2.6 對照改成「同一檔、同一年」的平均(第一版用整段歷史平均 → 結果跟著年份翻正負 = 量到的是那檔股票那幾年強不強,⛔ 不是法說會)
        const by = {}; let nb = 0; for (let i = 0; i < K.length; i++) { const x = excessAt(K, mk, i, h); if (typeof x === 'number') { (by[K[i].date.slice(0, 4)] = by[K[i].date.slice(0, 4)] || []).push(x); nb++; } }
        if (nb < 100) { cnt.noK += dates.length; continue; }
        const bmY = Object.fromEntries(Object.entries(by).filter(([, a]) => a.length >= 60).map(([y, a]) => [y, mean(a)])); let last = -1e9;
        for (const d of [...dates].sort()) {
            const i = idx.get(d); if (i == null) continue;
            if (i - last < DEDUP) { cnt.dedup++; continue; }
            const x = excessAt(K, mk, i, h);
            if (x === 'lock') { cnt.lock++; continue; }
            if (x == null) continue;
            const bm = bmY[d.slice(0, 4)]; if (bm == null) { cnt.noK++; continue; }
            last = i; ev.push({ d, sym, v: x - bm, raw: x });
        }
    }
    return { ev, cnt };
}

function loader(DD) {
    const c = new Map();
    return sym => { if (c.has(sym)) return c.get(sym); let K = null;
        try { let r = JSON.parse(fs.readFileSync(path.join(DD, `${sym}.json`), 'utf8')); r = Array.isArray(r) ? r : r.data;
            K = r.map(x => ({ date: String(x.date).replace(/\//g, '-'), open: +x.open, close: +x.close })).filter(x => x.close > 0); } catch (_) {}
        c.set(sym, K); return K; };
}

function selftest() {
    let fail = 0; const ok = (n, c, e = '') => { console.log((c ? '✅ ' : '❌ ') + n + (c ? '' : '  ' + e)); if (!c) fail++; };
    let s = 5; const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
    const D = []; const t0 = Date.UTC(2021, 0, 4);
    for (let i = 0; D.length < 800; i++) { const dt = new Date(t0 + i * 864e5); if (dt.getUTCDay() % 6) D.push(dt.toISOString().slice(0, 10)); }
    const mk = new Map(); let mc = 100; D.forEach(d => { const o = mc * (1 + (rnd() - 0.5) * 0.004); mc = o * (1 + (rnd() - 0.5) * 0.01); mk.set(d, { o, c: mc }); });
    const build = (plant) => { const Ks = {}, hist = {};
        for (let k = 0; k < 40; k++) { const sym = String(3000 + k), ev = new Set(); for (let i = 50; i < 780; i += 60) ev.add(i + (k % 7));
            const K = []; let c = 50, boost = 0;
            D.forEach((d, i) => { const o = c * (1 + (rnd() - 0.5) * 0.006); if (ev.has(i - 1)) boost = plant ? 5 : 0;
                c = o * (1 + (rnd() - 0.5) * 0.02 + (boost > 0 ? 0.006 : 0)); if (boost > 0) boost--; K.push({ date: d, open: o, close: c }); });
            Ks[sym] = K; hist[sym] = [...ev].map(i => D[i]); }
        return { Ks, hist }; };
    const A = build(true), ra = run(A.hist, s => A.Ks[s], mk, 5);
    const ga = gates(ra.ev, ra.ev.map(e => e.raw), 1);
    ok('① 埋「法說會後 5 天每天 +0.6%」→ 量得到、六關 ≥5', ga.inc > 1.5 && ga.pass >= 5, JSON.stringify(ga).slice(0, 160));
    const B = build(false), rb = run(B.hist, s => B.Ks[s], mk, 5);
    ok('② 沒埋 → |增量| < 0.5(對照組有在做事)', Math.abs(mean(rb.ev.map(e => e.v))) < 0.5, mean(rb.ev.map(e => e.v)));
    // ③ 法說會當天的漲跌⛔ 不算(隔天開盤才進)
    const C = build(false); for (const [sym, ds] of Object.entries(C.hist)) { const set = new Set(ds); C.Ks[sym].forEach(r => { if (set.has(r.date)) r.open = r.close / 1.08; }); }
    const rc = run(C.hist, s => C.Ks[s], mk, 5);
    ok('③ 法說會當天大漲 → 不影響(隔天開盤才進)', Math.abs(mean(rc.ev.map(e => e.v))) < 0.8, mean(rc.ev.map(e => e.v)));
    // ④ 20 天內第二場不算
    const H = { '3000': [D[100], D[105], D[200]] }; const rd = run(H, () => A.Ks['3000'], mk, 5);
    ok('④ 同一檔 20 天內的第二場 → 去重', rd.cnt.dedup === 1 && rd.ev.length === 2, JSON.stringify(rd.cnt));
    console.log(fail ? `❌ ${fail} 條失敗` : '✅ CONFCALL_EVENT_SELFTEST_PASS');
    process.exit(fail ? 1 : 0);
}

function main() {
    if (process.argv.includes('--selftest')) return selftest();
    const F = process.env.CONFCALL;
    if (!F || !fs.existsSync(F)) { console.error('❌ 要 CONFCALL=confcall.json(git show origin/data:data/confcall.json > …)'); process.exit(1); }
    const C = JSON.parse(fs.readFileSync(F, 'utf8')); const hist = C.hist || {};
    const all = Object.values(hist).flat().sort();
    console.log(`🎤 hist ${Object.keys(hist).length} 檔 ・${all.length} 場 ・${all[0]} ~ ${all[all.length - 1]}${C.backfill ? ` ・補挖 ${JSON.stringify(C.backfill)}` : ' ・⚠️ 還沒補挖'}`);
    const yrs = new Set(all.map(d => d.slice(0, 4)));
    if (yrs.size < 3) { console.error(`❌ 場次只涵蓋 ${yrs.size} 個年度 → 逐年那一關做不了,⛔ 不下結論(先跑 hist_backfill.yml)`); process.exit(1); }
    const DD = process.env.DATA_DIR || path.join(ROOT, 'data');
    let M = JSON.parse(fs.readFileSync(path.join(DD, '0050.json'), 'utf8')); M = Array.isArray(M) ? M : M.data;
    const mk = new Map(M.map(r => [String(r.date).replace(/\//g, '-'), { o: +r.open, c: +r.close }]));
    const L = loader(DD), out = { generated: new Date().toISOString(), rows: {} };
    console.log('增量 = 這一場的超額(扣 0.44%、減 0050)− 同一檔同一年每一個交易日用同樣做法的平均;方向看量到的正負');
    for (const h of HS) {
        const { ev, cnt } = run(hist, L, mk, h);
        if (ev.length < 30) { console.log(`⏳ 抱 ${h} 天:${ev.length} 場 → 不下結論`); continue; }
        const m = mean(ev.map(e => e.v)), sign = m >= 0 ? 1 : -1;
        const g = gates(ev, ev.map(e => sign > 0 ? e.raw : -e.raw - 2 * COST), sign);
        out.rows[h] = { sign, ...g, cnt };
        console.log(`${g.pass === 6 ? '✅' : g.pass >= 4 ? '⚠️' : '⛔'} 抱 ${h} 天 ・n=${g.n} ・增量 ${g.inc >= 0 ? '+' : ''}${g.inc}pp(t=${g.t})・方向 ${sign > 0 ? '比平常好' : '比平常差'} ・六關 ${g.pass}/6 ・開盤鎖漲停剔除 ${cnt.lock} ・去重 ${cnt.dedup} ・沒 K 線 ${cnt.noK}`);
        console.log(`     逐年 ${JSON.stringify(g.years)} ・沒過:${Object.entries(g.gates || {}).filter(([, v]) => !v).map(([n]) => n).join('、') || '—'}`);
    }
    // ⭐ 對照 B(V78.2.6):同一天**所有股票**的平均(擋掉月份 / 季節效應 —— 對照 A 量到 12 月 −3.4pp、3 月 ≈0,那是日曆不是法說會)
    console.log('\n── 對照 B:同一天所有股票(≥300 檔)用同樣做法的平均');
    const allSyms = fs.readdirSync(DD).filter(f => /^\d{4}\.json$/.test(f)).map(f => f.slice(0, 4)); out.rowsB = {};
    for (const h of HS) {
        const day = new Map();
        for (const sym of allSyms) { const K = L(sym); if (!K) continue; for (let i = 0; i < K.length; i++) { if (K[i].date < '2021-06-01') continue; const x = excessAt(K, mk, i, h); if (typeof x !== 'number') continue; const a = day.get(K[i].date) || [0, 0]; a[0] += x; a[1]++; day.set(K[i].date, a); } }
        const ev = [];
        for (const [sym, dates] of Object.entries(hist)) { const K = L(sym); if (!K) continue; const idx = new Map(K.map((r, i) => [r.date, i])); let last = -1e9;
            for (const d of [...dates].sort()) { const i = idx.get(d); if (i == null || i - last < DEDUP) continue; const x = excessAt(K, mk, i, h); if (typeof x !== 'number') continue; const a = day.get(d); if (!a || a[1] < 300) continue; last = i; ev.push({ d, v: x - a[0] / a[1], raw: x }); } }
        if (ev.length < 30) continue;
        const sign = mean(ev.map(e => e.v)) >= 0 ? 1 : -1, g = gates(ev, ev.map(e => sign > 0 ? e.raw : -e.raw - 2 * COST), sign);
        out.rowsB[h] = { sign, ...g };
        console.log(`${g.pass === 6 ? '✅' : g.pass >= 4 ? '⚠️' : '⛔'} 抱 ${h} 天 ・n=${g.n} ・增量 ${g.inc >= 0 ? '+' : ''}${g.inc}pp(t=${g.t})・六關 ${g.pass}/6 ・逐年 ${JSON.stringify(g.years)}`);
    }
    if (process.argv[2]) { fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1)); console.log('💾 ' + process.argv[2]); }
}
if (import.meta.url === `file://${process.argv[1]}`) main();
