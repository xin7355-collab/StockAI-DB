#!/usr/bin/env node
/**
 * ⚡🌙 V77.8.7 領頭羊 × 當沖 / 隔日沖 / 1 日 —— 自創變種(使用者:「以當沖、隔日沖、短線去做個自創策略」)
 *
 * ⛔ 不重跑舊的:當沖 5 分 K 規則(開盤四法 / 大盤順風 / 尾盤追)五年全負(dt_kbar5_probe)、隔日沖「碰得到 ≠ 賺得到」(dtflip)。
 * ⭐ 這一支只問一件新的事:**「領頭羊短線輪動」那個池子(成交額前 100)+ 10 日動能,壓縮到一天 / 一夜還有沒有東西?**
 *   kbar5 的母體本來就是「每月初前 60 日成交額前 100」= 同一個池子(⛔ 選樣偏誤同 kbar5,結論只講這個池子)。
 *
 * 當沖(成本 0.25%,同 dt_kbar5_probe):進場一律用**下一根 5 分 K 的開盤**,出場 13:25 那根收盤(⛔ 13:30 那根是收盤集合競價)
 *   D1 09:00~09:30 漲 ≥1%(vs 09:00 那根開盤)→ 09:35 買   D2 09:00~09:30 跌 ≥1% → 09:35 買(反轉)
 *   D3 09:30 收盤站上昨高(昨高用昨天 5 分 K,⛔ 不讀日 K,陷阱 #46)→ 09:35 買
 *   D4 昨收在 10 日動能前 10(池子內)→ 09:05 買到收盤   D5 = D4 ∧ D1
 *   對照:C0 池子全部 09:35 買到收盤 ・ C1 池子全部 09:05 買到收盤 ・ sham(固定種子,跟 D1 同筆數隨機抽池子日)
 * 隔日沖(成本 0.44%,非當沖):今收(13:25 那根收盤)買 → 明開(09:00 那根開盤)賣;O2 賣明天 13:25
 *   O1 今收在 10 日動能前 5   O2 同上賣明收   O3 動能前 20 且今天跌 ≥2%(強勢回檔)   O4 收在漲停(vs 昨收 ≥ +9.5%)
 *   對照:池子全部 今收→明開 ・ sham
 * 動能:昨天以前用日 K 還原價(d10n),今天用 5 分 K 的 13:25 價接上去(零前視:13:25 決策、13:25 成交同一根 → 標「略樂觀」)。
 * 關卡:平均 > 0(扣成本)・t ≥ 2 ・前後半同向 ・逐年 ≥ 5/6 同向 ・去最好年仍 > 0 ・贏 sham。
 * 跑法:KBAR5_DIR=$S/k5d/kbar5_deep:$S/k5/kbar5 DATA_DIR=$S/d10n node --max-old-space-size=8192 scripts/flip_probe.mjs out.json
 */
import fs from 'fs';
import path from 'path';
import { loadKbar5 } from './dt_kbar5_probe.mjs';

const COST_DT = 0.25, COST_ON = 0.44;
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const r2 = x => Number.isFinite(x) ? Math.round(x * 100) / 100 : null;
export function rng(seed) { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

export function report(name, ev, shamEv) {
    const r = ev.map(e => e.r), n = r.length;
    if (n < 30) return { name, n, note: '樣本 < 30' };
    const m = mean(r), t = m / (sd(r) / Math.sqrt(n));
    const h = n >> 1, f = mean(r.slice(0, h)), s = mean(r.slice(h));
    const byY = {}; for (const e of ev) (byY[e.d.slice(0, 4)] ||= []).push(e.r);
    const yrs = Object.fromEntries(Object.entries(byY).map(([y, a]) => [y, { n: a.length, m: r2(mean(a)) }]));
    const ys = Object.values(byY).map(a => mean(a)); const sameY = ys.filter(x => Math.sign(x) === Math.sign(m)).length;
    const best = Object.entries(byY).sort((a, b) => mean(b[1]) - mean(a[1]))[0][0];
    const dropBest = mean(ev.filter(e => e.d.slice(0, 4) !== best).map(e => e.r));
    const sh = shamEv ? mean(shamEv.map(e => e.r)) : NaN;
    const pass = m > 0 && t >= 2 && Math.sign(f) === Math.sign(s) && Math.sign(f) === Math.sign(m) && sameY >= Math.ceil(ys.length * 0.8) && dropBest > 0 && (!shamEv || m > sh);
    return { name, n, mean: r2(m), med: r2([...r].sort((a, b) => a - b)[n >> 1]), win: r2(r.filter(x => x > 0).length / n * 100), t: r2(t), first: r2(f), second: r2(s), yrs, sameY: `${sameY}/${ys.length}`, dropBest: r2(dropBest), sham: r2(sh), pass };
}

function loadDaily(DATA, syms, cal) {
    const out = {};
    for (const sym of syms) {
        const p = path.join(DATA, `${sym}.json`); if (!fs.existsSync(p)) continue;
        let rows; try { rows = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { continue; }
        const m = new Map(); for (const r of rows) if (+r.close > 0) m.set(String(r.date).replace(/\//g, '-').slice(0, 10), +r.close);
        // 用 d10n 的還原價(已 backadjust)算「昨天以前」的動能
        const A = cal.map(d => m.get(d) ?? NaN);
        out[sym] = A;
    }
    return out;
}

export function main() {
    const out = process.argv[2];
    const K = loadKbar5(process.env.KBAR5_DIR); const cal = Object.keys(K.days).sort();
    console.log(`📼 kbar5 ${cal.length} 天 ${cal[0]}~${cal.at(-1)}・${K.src.map(s => `${path.basename(s.dir)} ${s.used}`).join(' / ')}`);
    if (cal.length < 500) { console.error('🚨 天數 < 500'); process.exit(1); }
    const syms = new Set(); for (const d of cal) for (const s of K.days[d].syms || []) syms.add(s);
    const A = loadDaily(process.env.DATA_DIR, [...syms], cal);
    const idx = new Map(cal.map((d, i) => [d, i]));
    const ev = { D1: [], D2: [], D3: [], D4: [], D5: [], C0: [], C1: [], O1: [], O2: [], O3: [], O3b: [], O3c: [], O4: [], CO: [], CO2: [], CD: [], CD1: [], CD3: [] };
    for (const th of [1, 2, 3]) for (const top of [10, 20, 30]) ev[`G${th}_${top}`] = [];
    const rand = rng(7);
    const L = 10, POOL = [];
    for (let i = 1; i < cal.length; i++) {
        const d = cal[i], D = K.days[d], P = K.days[cal[i - 1]];
        const list = (D.syms || []).filter(s => D.k[s] && P.k[s] && A[s]);
        // 今天池子內每檔的動能(昨天以前日 K 還原 × 今天 13:25 / 昨 13:30)與昨收動能
        const rows = [];
        for (const s of list) {
            const b = D.k[s].filter(x => x[0] >= 540 && x[0] <= 805), pb = P.k[s].filter(x => x[0] >= 540 && x[0] <= 810);
            if (b.length < 40 || pb.length < 40) continue;
            const o0 = b[0][1], c930 = b.find(x => x[0] === 570)?.[4], o935 = b.find(x => x[0] === 575)?.[1], o905 = b.find(x => x[0] === 545)?.[1], c1325 = b.at(-1)[4], c1330 = D.k[s].find(x => x[0] === 810)?.[4] || c1325;
            const pc = pb.at(-1)[4], pH = Math.max(...pb.map(x => x[2]));
            if (!(o0 > 0 && c930 > 0 && o935 > 0 && o905 > 0 && c1325 > 0 && pc > 0)) continue;
            const a = A[s]; const aY = a[i - 1], aL = a[i - 1 - L]; if (!(aY > 0 && aL > 0)) continue;
            const momY = aY / aL - 1;                                  // 昨收的 10 日動能(給當沖用,開盤前就知道)
            const momT = (c1325 / pc) * (aY / a[i - L]) - 1;           // 今天 13:25 的 10 日動能(給隔日沖用)
            rows.push({ s, o0, c930, o935, o905, c1325, c1330, pc, pH, momY, momT, chgT: c1325 / pc - 1, i });
        }
        if (rows.length < 30) continue;
        const rankY = [...rows].sort((a, b) => b.momY - a.momY).map(r => r.s), rankT = [...rows].sort((a, b) => b.momT - a.momT).map(r => r.s);
        const top10Y = new Set(rankY.slice(0, 10)), top5T = new Set(rankT.slice(0, 5)), top20T = new Set(rankT.slice(0, 20)), rankPos = new Map(rankT.map((s, k) => [s, k]));
        // 明天
        const N = K.days[cal[i + 1]];
        for (const r of rows) {
            const dt = (e) => (r.c1325 / e - 1) * 100 - COST_DT;
            const m30 = r.c930 / r.o0 - 1;
            const rec = (k, val) => ev[k].push({ d, s: r.s, r: val });
            rec('C0', dt(r.o935)); rec('C1', dt(r.o905));
            if (m30 >= 0.01) rec('D1', dt(r.o935));
            if (m30 <= -0.01) rec('D2', dt(r.o935));
            if (r.c930 > r.pH) rec('D3', dt(r.o935));
            if (top10Y.has(r.s)) { rec('D4', dt(r.o905)); if (m30 >= 0.01) rec('D5', dt(r.o935)); }
            if (N && N.k[r.s]) {
                const nb = N.k[r.s].filter(x => x[0] >= 540 && x[0] <= 805); if (nb.length < 40) continue;
                const nO = nb[0][1], nC = nb.at(-1)[4]; if (!(nO > 0 && nC > 0)) continue;
                if (r.chgT > 0.095) { rec('O4', (nO / r.c1325 - 1) * 100 - COST_ON); continue; }   // 收漲停買不到(只當已知對照)
                const on = (nO / r.c1325 - 1) * 100 - COST_ON, on2 = (nC / r.c1325 - 1) * 100 - COST_ON, on30 = (nO / r.c1330 - 1) * 100 - COST_ON;
                rec('CO', on); rec('CO2', on2);
                if (top5T.has(r.s)) { rec('O1', on); rec('O2', on2); }
                if (top20T.has(r.s) && r.chgT <= -0.02) { rec('O3', on); rec('O3b', on30); rec('O3c', (nC / r.c1330 - 1) * 100 - COST_ON); }
                if (r.chgT <= -0.02) rec('CD', on); if (r.chgT <= -0.01) rec('CD1', on); if (r.chgT <= -0.03) rec('CD3', on);
                const pos = rankPos.get(r.s);
                for (const th of [1, 2, 3]) for (const top of [10, 20, 30]) if (pos < top && r.chgT <= -th / 100) rec(`G${th}_${top}`, on30);
            }
        }
    }
    const sham = (pool, n, seed) => { const r = rng(seed), out = []; const k = Math.min(n, pool.length); const used = new Set(); while (out.length < k) { const j = Math.floor(r() * pool.length); if (!used.has(j)) { used.add(j); out.push(pool[j]); } } return out; };
    const R = [];
    const put = (k, name, ctrl) => { const rep = report(name, ev[k], ctrl ? sham(ev[ctrl], ev[k].length, 11) : null); R.push(rep); console.log(`${rep.pass ? '✅' : '⛔'} ${name}:n=${rep.n} 平均 ${rep.mean}% 中位 ${rep.med}% 勝率 ${rep.win}% t=${rep.t} 前/後半 ${rep.first}/${rep.second} 逐年同向 ${rep.sameY} 去最好年 ${rep.dropBest} sham ${rep.sham} ・${Object.entries(rep.yrs || {}).map(([y, v]) => `${y}:${v.m}(${v.n})`).join(' ')}`); };
    console.log('\n⚡ 當沖(09:35 或 09:05 買 → 13:25 賣,扣 0.25%)');
    put('C0', '對照 C0 池子全部 09:35→13:25'); put('C1', '對照 C1 池子全部 09:05→13:25');
    put('D1', 'D1 開盤 30 分漲 ≥1% → 09:35 買', 'C0'); put('D2', 'D2 開盤 30 分跌 ≥1% → 09:35 買', 'C0'); put('D3', 'D3 09:30 站上昨高 → 09:35 買', 'C0');
    put('D4', 'D4 昨收 10 日動能前 10 → 09:05 買', 'C1'); put('D5', 'D5 動能前 10 ∧ 開盤 30 分漲 ≥1% → 09:35 買', 'C0');
    console.log('\n🌙 隔日沖(13:25 買 → 明 09:00 開盤賣,扣 0.44%)');
    put('CO', '對照 CO 池子全部 今收→明開'); put('CO2', '對照 CO2 池子全部 今收→明收');
    put('O1', 'O1 今收 10 日動能前 5 → 明開賣', 'CO'); put('O2', 'O2 動能前 5 → 明收賣(1 日)', 'CO2');
    put('O3', 'O3 動能前 20 且今天跌 ≥2% → 13:25 買 明開賣', 'CO'); put('O3b', 'O3b 同上但用 13:30 集合競價買', 'CO'); put('O3c', 'O3c 同上 13:30 買 → 明收賣', 'CO2');
    put('CD', '拆解:只看今天跌 ≥2%(不看動能)→ 明開', 'CO'); put('CD1', '拆解:跌 ≥1%', 'CO'); put('CD3', '拆解:跌 ≥3%', 'CO');
    put('O4', 'O4 收在漲停 → 明開賣(已知對照)');
    console.log('\n⛰️ O3 門檻高原(13:30 買 → 明開,扣 0.44%):列 = 今天跌幅門檻,欄 = 動能前幾名');
    for (const th of [1, 2, 3]) console.log(`  跌 ≥${th}%:` + [10, 20, 30].map(top => { const rep = report(`G${th}_${top}`, ev[`G${th}_${top}`]); return `前${top} ${rep.mean ?? '—'}%(n=${rep.n},t=${rep.t ?? '—'},年 ${rep.sameY ?? '—'})`; }).join(' ・'));
    // 💼 組合層級:每天把 O3b 事件等權(最多 5 檔、每檔 1/5 資金,其餘現金),隔天開盤全賣;跟 0050 同期比(用日曆對齊 d10n 的 0050 收盤)
    const byDay = {}; for (const e of ev.O3b) (byDay[e.d] ||= []).push(e.r);
    let eq = 1, days = 0, act = 0; const yr = {};
    for (const d of cal) { const L2 = byDay[d]; days++; if (!L2) continue; act++; const k = Math.min(5, L2.length); const rday = L2.slice(0, k).reduce((a, x) => a + x, 0) / 5 / 100; eq *= 1 + rday; (yr[d.slice(0, 4)] ||= { eq: 1 }).eq *= 1 + rday; }
    const p50 = path.join(process.env.DATA_DIR, '0050.json'); let b50 = null;
    if (fs.existsSync(p50)) { const m = new Map(JSON.parse(fs.readFileSync(p50, 'utf8')).map(r => [String(r.date).replace(/\//g, '-').slice(0, 10), +r.close])); const a = m.get(cal[0]) || [...m.entries()].find(([d]) => d >= cal[0])?.[1], b = m.get(cal.at(-1)); if (a && b) b50 = (b / a - 1) * 100; }
    console.log(`\n💼 O3b 組合(每天最多 5 檔、每檔 20% 資金、其餘現金):${cal.length} 天有事件 ${act} 天(${r2(act / days * 100)}%)→ 總報酬 ${r2((eq - 1) * 100)}%(0050 價格 ${r2(b50)}%,⚠️ 不含息)・逐年 ${Object.entries(yr).map(([y, v]) => `${y} ${r2((v.eq - 1) * 100)}%`).join(' ')}`);
    R.push({ name: 'O3b 組合', tot: r2((eq - 1) * 100), b0050px: r2(b50), activeDays: act, days: cal.length, yrs: Object.fromEntries(Object.entries(yr).map(([y, v]) => [y, r2((v.eq - 1) * 100)])) });
    const empty = Object.entries(ev).filter(([k, v]) => !v.length).map(([k]) => k);
    if (empty.length) { console.error(`🚨 這幾條規則一筆都沒有:${empty.join(' ')} —— 不是「沒訊號」就是程式把它擋掉了(O4 第一版就是 continue 排在它前面),⛔ 不寫檔`); process.exit(1); }
    const res = { asof: new Date().toISOString().slice(0, 10), days: cal.length, from: cal[0], to: cal.at(-1), bias: K.bias, rules: R };
    if (out) fs.writeFileSync(out, JSON.stringify(res));
}

function selftest() {
    let ok = 0, bad = 0; const t = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); c ? ok++ : bad++; };
    const mk = (d, r) => ({ d, s: 'x', r });
    // ① 全正且穩定 → 過關;② 只靠一年 → 去最好年紅;③ 前後半反向紅;④ 輸 sham 紅
    const good = []; for (let y = 2021; y <= 2026; y++) for (let k = 0; k < 20; k++) good.push(mk(`${y}-01-01`, 0.5 + (k % 3) * 0.1));
    t(report('g', good).pass === true, '① 全期 > 0、t 大、前後半同向、逐年同向、去最好年 > 0 → 過關');
    const oneYear = good.map((e, k) => ({ ...e, r: e.d.startsWith('2023') ? 5 : -0.3 }));
    t(report('o', oneYear).pass === false, '② 只靠一年撐 → 去最好年 < 0 → 不過');
    const flip = good.map((e, k) => ({ ...e, r: k < 60 ? 1 : -0.9 }));
    t(report('f', flip).pass === false, '③ 前後半反向 → 不過');
    const shamBetter = good.map(e => ({ ...e, r: e.r + 1 }));
    t(report('s', good, shamBetter).pass === false && report('s', good, good.map(e => ({ ...e, r: e.r - 1 }))).pass === true, '④ 沒贏 sham 不過、贏 sham 過');
    t(report('n', good.slice(0, 10)).note === '樣本 < 30', '⑤ 樣本 < 30 不下結論');
    const a1 = rng(3), a2 = rng(3); t(a1() === a2(), '⑥ 固定種子');
    console.log(`\n${bad ? '❌' : '✅'} selftest ${ok}/${ok + bad}`); return bad ? 1 : 0;
}
if (process.argv.includes('--selftest')) process.exit(selftest());
else if (process.argv[1] && process.argv[1].endsWith('flip_probe.mjs')) main();
