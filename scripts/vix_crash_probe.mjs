// 🌪️ V77.8.1 外部評估㊶(global_asset_history 的「VIX 閾值後遠期收益」「暴跌統計」)—— 本站以前沒量過的兩件
//
//  (A) 美國 VIX 衝過門檻之後,0050 接下來 5 / 20 / 60 / 120 天
//      事件:VIX 收盤首次 ≥ T(T = 20/25/30/35/40),前 20 個美股交易日都在 T 之下才算一次(去重)
//            + 252 日百分位 ≥ 90 / 95(⛔ 窗口不含當天),台股端同一事件源 20 個交易日內只算一次
//      對應:美股 D → 第一個日期 **>** D 的台股交易日(同日期 = 前視;共用 us_tw_lead_probe.nextTwFactory)
//      報酬:0050 **自己的**開盤買(⛔ 不用 ^TWII 開盤價,陷阱 #47)/ 收盤買 → T+h 收盤;含息(lib_totalreturn.trSeries)
//      對照組:同期每一個台股交易日同口徑
//  (B) 加權大跌之後(2010~2026,idx_long.json 的 twii 價格指數 + twii_tr 含息報酬指數)
//      每一段回撤只算一次:從前高回撤首次觸及 −10 / −15 / −20 / −30% → 再跌多深、幾天到底、
//      從觸發到回到前高要幾天(還沒回來的 ⛔ 不可算成 0)、觸發後 60/120/250 天含息報酬 vs 隨便挑一天
//      ⛔ 描述,不是訊號
//
// 跑法:
//   US_HIST=$S/us_hist.json DATA_DIR=$S/dd2 DIV=$S/od/data/dividends_hist.json IDX_LONG=$S/idx_long.json \
//     node scripts/vix_crash_probe.mjs out.json
//   node scripts/vix_crash_probe.mjs --selftest
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { trSeries, d10, num } from './lib_totalreturn.mjs';
import { nextTwFactory } from './us_tw_lead_probe.mjs';

export const HS = [5, 20, 60, 120];
export const TS = [20, 25, 30, 35, 40];
export const PCTS = [90, 95];
export const DEDUP_US = 20, DEDUP_TW = 20, PCT_WIN = 252;
export const LEVELS = [10, 15, 20, 30];

/** VIX 首次衝過 T:前 DEDUP_US 天都在 T 之下 */
export function vixCrossings(vc, T) {
    const out = [];
    for (let i = DEDUP_US; i < vc.length; i++) {
        if (!(vc[i] >= T)) continue;
        let clean = true;
        for (let j = i - DEDUP_US; j < i; j++) if (!(vc[j] < T)) { clean = false; break; }
        if (clean) out.push(i);
    }
    return out;
}
/** 252 日百分位(⛔ 不含當天) */
export function pctRank(vc, i, win = PCT_WIN) {
    if (i < win) return null;
    let below = 0;
    for (let j = i - win; j < i; j++) if (vc[j] < vc[i]) below++;
    return below / win * 100;
}
export function pctEvents(vc, P) {
    const out = [];
    for (let i = PCT_WIN; i < vc.length; i++) { const r = pctRank(vc, i); if (r != null && r >= P) out.push(i); }
    return out;
}
/** 回撤事件(每一段只算一次);closes = [{d,c}] */
export function drawdownEvents(rows, L) {
    const ev = [];
    let peak = rows[0].c, peakI = 0, fired = false, cur = null;
    for (let i = 1; i < rows.length; i++) {
        const c = rows[i].c;
        if (c >= peak) {                                  // 回到前高 = 這一段結束
            if (cur) { cur.recI = i; cur.recD = rows[i].d; cur.recDays = i - cur.trigI; ev.push(cur); cur = null; }
            peak = c; peakI = i; fired = false; continue;
        }
        const dd = (c / peak - 1) * 100;
        if (!fired && dd <= -L) {
            fired = true;
            cur = { peakD: rows[peakI].d, peak, trigI: i, trigD: rows[i].d, botI: i, bot: c, recI: null, recD: null, recDays: null };
        }
        if (cur && c < cur.bot) { cur.bot = c; cur.botI = i; }
    }
    if (cur) ev.push(cur);                                // ⛔ 還沒回來的 recDays = null(不是 0)
    return ev.map(e => ({ ...e, botD: rows[e.botI].d, depth: +((e.bot / e.peak - 1) * 100).toFixed(2), daysToBot: e.botI - e.trigI }));
}
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const med = a => { const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const r2 = x => x == null || !isFinite(x) ? null : +x.toFixed(2);

function statVs(rets, base) {
    if (!rets.length) return { n: 0 };
    const bm = mean(base);
    const diff = mean(rets) - bm;
    const t = rets.length > 1 ? diff / (sd(rets) / Math.sqrt(rets.length)) : null;
    return { n: rets.length, mean: r2(mean(rets)), med: r2(med(rets)), win: r2(rets.filter(x => x > 0).length / rets.length * 100),
             base: r2(bm), baseWin: r2(base.filter(x => x > 0).length / base.length * 100), diff: r2(diff), t: r2(t),
             verdict: rets.length < 10 ? '⏳ 樣本不足,不下結論' : (Math.abs(t) >= 2 ? (diff > 0 ? '比平常好(t≥2)' : '比平常差(t≥2)') : '跟平常沒差') };
}

function runA(U, bars, divs) {
    const vc = U.syms['^VIX'].c.map(num);
    const tr = trSeries(bars.map(b => ({ d: b.d, c: b.c })), divs);
    const twDays = bars.map(b => b.d);
    const nextTw = nextTwFactory(twDays);
    const ret = (k, h, mode) => {
        if (k == null || k + h >= bars.length) return null;
        const g = tr.v[k + h] / tr.v[k];
        return ((mode === 'open' ? g * bars[k].c / bars[k].o : g) - 1) * 100;
    };
    const firstK = nextTw(U.days[0]);
    const base = {}; for (const h of HS) for (const m of ['open', 'close']) {
        const a = []; for (let k = firstK; k < bars.length; k++) { const r = ret(k, h, m); if (r != null) a.push(r); } base[`${m}${h}`] = a;
    }
    const mk = (name, idxs) => {
        const ks = []; let last = -Infinity;
        const evs = [];
        for (const i of idxs) {
            const k = nextTw(U.days[i]); if (k == null) continue;
            if (k - last < DEDUP_TW) continue;
            last = k; ks.push(k);
            evs.push({ us: U.days[i], vix: r2(vc[i]), tw: twDays[k], t20: r2(ret(k, 20, 'open')), t60: r2(ret(k, 60, 'open')) });
        }
        const rows = {};
        for (const h of HS) for (const m of ['open', 'close']) rows[`${m}${h}`] = statVs(ks.map(k => ret(k, h, m)).filter(x => x != null), base[`${m}${h}`]);
        return { name, n: ks.length, rows, evs };
    };
    const out = [];
    for (const T of TS) out.push(mk(`VIX 首次 ≥ ${T}`, vixCrossings(vc, T)));
    for (const P of PCTS) out.push(mk(`VIX 252 日百分位 ≥ ${P}`, pctEvents(vc, P)));
    return { window: [U.days[0], U.days[U.days.length - 1]], twWindow: [twDays[firstK], twDays[twDays.length - 1]], out };
}

function runB(IL) {
    const px = IL.twii.map(r => ({ d: d10(r[0]), c: +r[4] }));
    const trm = new Map(IL.twii_tr.map(r => [d10(r[0]), +r[1]]));
    const trv = px.map(r => trm.get(r.d) ?? null);
    const fwd = (i, h) => (i + h < px.length && trv[i] && trv[i + h]) ? (trv[i + h] / trv[i] - 1) * 100 : null;
    const base = {}; for (const h of [60, 120, 250]) { const a = []; for (let i = 0; i < px.length; i++) { const r = fwd(i, h); if (r != null) a.push(r); } base[h] = a; }
    const trRows = px.map((r, i) => ({ d: r.d, c: trv[i] })).filter(r => r.c);
    const res = [];
    for (const L of LEVELS) {
        const evP = drawdownEvents(px, L), evT = drawdownEvents(trRows, L);
        const rec = evP.filter(e => e.recDays != null).map(e => e.recDays);
        const recT = evT.filter(e => e.recDays != null).map(e => e.recDays);
        const f = {}; for (const h of [60, 120, 250]) f[h] = statVs(evP.map(e => fwd(e.trigI, h)).filter(x => x != null), base[h]);
        res.push({
            L, n: evP.length, unrecovered: evP.filter(e => e.recDays == null).map(e => e.trigD),
            depthMed: evP.length ? r2(med(evP.map(e => e.depth))) : null, depthMin: evP.length ? r2(Math.min(...evP.map(e => e.depth))) : null,
            daysToBotMed: evP.length ? med(evP.map(e => e.daysToBot)) : null,
            recMed: rec.length ? med(rec) : null, recMax: rec.length ? Math.max(...rec) : null,
            recMedTR: recT.length ? med(recT) : null, recMaxTR: recT.length ? Math.max(...recT) : null, nTR: evT.length,
            fwd: f, events: evP.map(e => ({ peak: e.peakD, trig: e.trigD, bot: e.botD, depth: e.depth, daysToBot: e.daysToBot, rec: e.recD, recDays: e.recDays })),
        });
    }
    return { window: [px[0].d, px[px.length - 1].d], days: px.length, res };
}

function selftest() {
    const F = []; const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + e}`); if (!c) F.push(n); };
    // ① 去重:30 天內兩次衝過 25 → 只算第一次
    const v = Array(60).fill(15); v[25] = 27; v[26] = 18; v[30] = 26; v[55] = 26;
    const cr = vixCrossings(v, 25);
    ok('① 去重:前 20 天都在門檻下才算(25 算、30 不算、55 算)', JSON.stringify(cr) === '[25,55]', JSON.stringify(cr));
    // ② 對應 ⛔ 同日期
    const nx = nextTwFactory(['2024-01-02', '2024-01-03', '2024-01-05']);
    ok('② 美股 D → 第一個 > D 的台股日(同日期 = 前視)', nx('2024-01-03') === 2 && nx('2024-01-04') === 2 && nx('2024-01-05') === null, [nx('2024-01-03'), nx('2024-01-04'), nx('2024-01-05')]);
    // ③ 百分位窗口不含當天:當天是新高 → 100
    const w = Array.from({ length: 300 }, (_, i) => 10 + (i % 7)); w[299] = 99;
    ok('③ 百分位窗口不含當天(當天新高 = 100)', pctRank(w, 299) === 100, pctRank(w, 299));
    // ④ 回復天數 + 還沒回來 = null
    const s = [100, 95, 88, 80, 85, 92, 101, 99, 90, 85].map((c, i) => ({ d: `2020-01-${String(i + 1).padStart(2, '0')}`, c }));
    const ev = drawdownEvents(s, 10);
    ok('④ 回撤事件:第一段觸發於 −12%、到底 −20%、4 天後回前高', ev[0] && ev[0].trigD === '2020-01-03' && ev[0].depth === -20 && ev[0].recDays === 4 && ev[0].daysToBot === 1, JSON.stringify(ev[0]));
    ok('⑤ 還沒回來的那段 recDays = null(⛔ 不可是 0)', ev.length === 2 && ev[1].recDays === null, JSON.stringify(ev[1]));
    // ⑥ 同一段只算一次:跌破 −10 後反彈再跌破仍是同一段
    const s2 = [100, 89, 95, 88, 99, 87, 100].map((c, i) => ({ d: `2020-02-0${i + 1}`, c }));
    ok('⑥ 同一段回撤只算一次', drawdownEvents(s2, 10).length === 1, drawdownEvents(s2, 10).length);
    console.log(F.length ? `❌ ${F.length} 條沒過` : '✅ selftest 全部通過');
    process.exit(F.length ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    if (process.argv.includes('--selftest')) selftest();
    const { US_HIST, DATA_DIR, DIV, IDX_LONG } = process.env;
    if (!US_HIST || !DATA_DIR || !IDX_LONG) { console.error('需要 US_HIST / DATA_DIR / IDX_LONG(DIV 選填)'); process.exit(1); }
    const U = JSON.parse(fs.readFileSync(US_HIST, 'utf8'));
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, '0050.json'), 'utf8'));
    const bars = raw.map(r => ({ d: d10(r.date), o: num(r.open), c: num(r.close) })).filter(b => b.o > 0 && b.c > 0).sort((a, b) => a.d < b.d ? -1 : 1);
    let divs = [];
    if (DIV) { const dv = JSON.parse(fs.readFileSync(DIV, 'utf8')); divs = ((dv.d || dv)['0050'] || {}).h || []; }
    if (!U.syms || !U.syms['^VIX'] || U.days.length < 1000) { console.error('us_hist 沒有 ^VIX 或天數 <1000'); process.exit(1); }
    const IL = JSON.parse(fs.readFileSync(IDX_LONG, 'utf8'));
    if (!IL.twii || IL.twii.length < 3000) { console.error('idx_long 的 twii <3000 天'); process.exit(1); }
    const A = runA(U, bars, divs), B = runB(IL);
    console.log(`\n(A) VIX 門檻 → 0050(美股 ${A.window.join(' ~ ')} ・台股 ${A.twWindow.join(' ~ ')} ・含息 ${divs.length} 筆)`);
    for (const r of A.out) {
        console.log(`\n■ ${r.name}  獨立事件 ${r.n}`);
        for (const k of ['open5', 'open20', 'open60', 'open120', 'close20']) { const s = r.rows[k]; if (s.n) console.log(`  ${k.padEnd(8)} n=${s.n} 平均 ${s.mean} 中位 ${s.med} 勝率 ${s.win}% | 平常 ${s.base}(${s.baseWin}%) 差 ${s.diff} t=${s.t} → ${s.verdict}`); }
        console.log('  ' + r.evs.map(e => `${e.us}(VIX ${e.vix})→${e.tw} 20日 ${e.t20} 60日 ${e.t60}`).join('\n  '));
    }
    console.log(`\n(B) 加權大跌之後(${B.window.join(' ~ ')},${B.days} 天)`);
    for (const r of B.res) {
        console.log(`\n■ 回撤 −${r.L}%:${r.n} 段(還沒回來 ${r.unrecovered.length}:${r.unrecovered.join(',')}) ・到底中位再 ${r.depthMed}%(最深 ${r.depthMin}%) ・觸發→到底中位 ${r.daysToBotMed} 天 ・觸發→回前高 中位 ${r.recMed} 天 / 最久 ${r.recMax} 天(含息 中位 ${r.recMedTR} / 最久 ${r.recMaxTR})`);
        for (const h of [60, 120, 250]) { const s = r.fwd[h]; if (s.n) console.log(`  觸發後 ${h} 天含息:n=${s.n} 平均 ${s.mean} 中位 ${s.med} 賺錢 ${s.win}% | 隨便挑一天 ${s.base}(${s.baseWin}%) 差 ${s.diff} t=${s.t} → ${s.verdict}`); }
    }
    const outF = process.argv.find(a => a.endsWith('.json'));
    if (outF) fs.writeFileSync(outF, JSON.stringify({ A, B }, null, 1));
}
