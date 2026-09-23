#!/usr/bin/env node
/**
 * ⏱️ 當沖「非 5 分K 不可」的那幾條(V77.5.0)—— 讀 `kbar5` 分支(量前 80 + 台指期近月)
 *
 * ⚠️⚠️ 先講限制(⛔ 每一次輸出都會印):
 *   ・只有約 88 個交易日(2026-05 起)→ **逐年那關做不了**,結論只能當「方向提示」⛔ 不下操作指令
 *   ・母體 = 當天成交量前 80 = **天生只收「當天夠熱」的日子**(選樣偏誤),而且含 ETF(這裡排掉 0 開頭)
 *   ・扣當沖來回成本 0.25%;隔夜那組(F5)扣 0.44%
 *
 * 測什麼(逐字稿編號見 EXTERNAL_REVIEWS ㉜):
 *   F1 🕘 開盤四法(#16):昨天 5 分K 趨勢(多/空/盤整)× 第一根 5 分K(開高/低 × 收紅/黑)= 8+4 種組合,
 *      照他說的進場;停損第一根低(高)點、停利 +2%、碰漲停就賣、13:25 平倉
 *      ⭐ 對照組 = 同一天同一檔「⛔ 不分類,一律第一根收盤、同方向、同出場」→ 量的是「分類」本身有沒有用
 *   F2 🧭 大盤順風(#14):09:30 台指期在它 09:00 之上 → 個股 09:30 做多到收盤;之下 → 做空
 *   F3 ⏰ 「當天高低點 7~8 成出在 10:30 前」(#16 #17)—— 描述
 *   F4 🧲 「收盤會被吸回量最大的價位」(#13)—— 描述:收盤離量最大價位 vs 離 VWAP / 離中點
 *   F5 🚀 「尾盤 12:30 在 +6~8% → 會被拉漲停、隔天開高」(#17)—— 12:30 買、隔天開盤賣(⚠️ 隔日沖)
 *   F6 ⚖️ **勝率 vs 期望值**(#11 #16 #21):第一根收盤進場 × 停利 × 停損 → 勝率可以調,期望值才是真的
 *   F7 ⚡ 熱門股的跳空回歸 × 進場時點(接日K探針 D2c/D2d):開盤 / 09:05 / 09:30 進
 *
 * 跑法:git archive origin/kbar5 | tar -x -C $S/k5 ; KBAR5_DIR=$S/k5/kbar5 DATA_DIR=$S/dd node scripts/dt_kbar5_probe.mjs [out.json]
 *       node scripts/dt_kbar5_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const COST = 0.25, COST_ON = 0.44;
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;

/** 通用出場:從 bars[j] 開始(含),停損 / 停利 / 碰漲停(多)/ 碰跌停(空)/ 收盤。
 *  ⚠️ 同一根同時碰停損與停利 → 一律算停損(保守)。回 未扣成本 %。 */
export function exitSim(bars, j, side, entry, stop, tgt, pc) {
    const upLim = pc ? pc * 1.095 : Infinity, dnLim = pc ? pc * 0.905 : 0;
    for (let k = j; k < bars.length; k++) {
        const [, , h, l] = bars[k];
        if (side > 0) {
            if (stop != null && l <= stop) return (stop / entry - 1) * 100;
            if (tgt != null && h >= tgt) return (tgt / entry - 1) * 100;
            if (h >= upLim) return (upLim / entry - 1) * 100;
        } else {
            if (stop != null && h >= stop) return (1 - stop / entry) * 100;
            if (tgt != null && l <= tgt) return (1 - tgt / entry) * 100;
            if (l <= dnLim) return (1 - dnLim / entry) * 100;
        }
    }
    const c = bars[bars.length - 1][4];
    return side > 0 ? (c / entry - 1) * 100 : (1 - c / entry) * 100;
}

/** 📂 讀一份或多份 kbar5 目錄(`a:b`)。⭐ **寫在前面的優先**(同一天只採一份,⛔ 不混:
 *  同一天兩份的名單不同,混在一起會出現「半天是 A 母體、半天是 B 母體」)。
 *  ⭐ 分析時用 `KBAR5_DIR=<kbar5_deep>:<kbar5>` → **同一種母體**(每月初前 100)優先、每日那份只補 deep 沒有的日子
 *     (兩份存在不同分支,⛔ 誰都沒覆蓋誰 —— 回算鐵則第 2 條管的是「寫入」,這裡只是讀的時候挑一份)。
 *  ⛔ 只讀 YYYY-MM.json.gz(`_meta.json` 之類不會被當成月檔)。 */
export function loadKbar5(spec) {
    const days = {}, src = []; let bias = '';
    for (const dir of String(spec || '').split(':').filter(Boolean)) {
        if (!fs.existsSync(dir)) { src.push({ dir, days: 0, used: 0, bias: '(目錄不存在)' }); continue; }
        let n = 0, used = 0, b = '';
        for (const f of fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}\.json\.gz$/.test(f)).sort()) {
            const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, f))).toString());
            b = j.bias || b;
            for (const [d, v] of Object.entries(j.d || {})) { n++; if (!days[d]) { days[d] = v; used++; } }
        }
        bias = bias || b; src.push({ dir, days: n, used, bias: b });
    }
    return { days, bias, src };
}

/** 昨天 5 分K 趨勢:後半段的高低點 vs 前半段(⭐ 「高點過高、低點不破低」的量化代理) */
export function prevTrend(bars) {
    if (!bars || bars.length < 20) return null;
    const h = bars.length >> 1, A = bars.slice(0, h), B = bars.slice(h);
    const hA = Math.max(...A.map(b => b[2])), lA = Math.min(...A.map(b => b[3]));
    const hB = Math.max(...B.map(b => b[2])), lB = Math.min(...B.map(b => b[3]));
    if (hB > hA && lB > lA) return '多頭';
    if (hB < hA && lB < lA) return '空頭';
    return '盤整';
}

/** 開盤四法:回 {combo, side, j(進場那根的下一根), entry, stop} 或 null。bars 只取 13:25 之前。 */
export function fourOpen(trend, bars, pc) {
    const b1 = bars[0]; if (!b1) return null;
    const [, o1, h1, l1, c1] = b1;
    const hi = o1 >= pc, red = c1 >= o1;
    const type = (hi ? '開高' : '開低') + (red ? '收紅' : '收黑');
    const combo = `${trend}・${type}`;
    const W = bars.findIndex(b => b[0] >= 630); const last = W < 0 ? bars.length : W;   // 10:30 前才進場
    const at1 = (side) => ({ combo, side, j: 1, entry: c1, stop: side > 0 ? l1 : h1 });
    const firstBlack = () => { for (let k = 1; k < last; k++) if (bars[k][4] < bars[k][1]) return { combo, side: -1, j: k + 1, entry: bars[k][4], stop: Math.max(h1, bars[k][2]) }; return null; };
    const pullbackRed = (noBreak) => { let seenBlack = false;
        for (let k = 1; k < last; k++) { const b = bars[k];
            if (noBreak && b[3] < l1) return null;
            if (b[4] < b[1]) seenBlack = true; else if (seenBlack && b[4] > b[1]) return { combo, side: 1, j: k + 1, entry: b[4], stop: Math.min(l1, b[3]) }; }
        return null; };
    const breakHigh = () => { for (let k = 1; k < last; k++) if (bars[k][2] > h1) return { combo, side: 1, j: k + 1, entry: Math.max(bars[k][1], h1), stop: l1 }; return null; };
    if (trend === '多頭') {
        if (type === '開高收紅') return at1(1);
        if (type === '開高收黑') return pullbackRed(false);
        if (type === '開低收紅') return breakHigh();
        return pullbackRed(true);                 // 開低收黑:反彈上來、不破前低才做
    }
    if (trend === '空頭') {
        if (type === '開高收黑' || type === '開低收黑') return at1(-1);
        return firstBlack();                       // 強強 / 弱強:彈後空
    }
    // 盤整:看第一根表態
    if (type === '開高收紅') return at1(1);
    if (type === '開低收黑') return at1(-1);
    if (type === '開高收黑') return breakHigh();
    return firstBlack();
}

function selftest() {
    let fail = 0; const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + e}`); if (!c) fail++; };
    // ① 出場:同一根碰停損也碰停利 → 算停損
    ok('① 同一根兩邊都碰 → 保守算停損', Math.abs(exitSim([[545, 100, 103, 98, 101, 1]], 0, 1, 100, 99, 102, 100) - (-1)) < 1e-9);
    ok('①b 碰漲停就賣(+9.5%)', Math.abs(exitSim([[545, 100, 110, 100, 110, 1]], 0, 1, 100, 90, null, 100) - 9.5) < 1e-6);
    ok('①c 沒碰任何一條 → 收盤出', Math.abs(exitSim([[545, 100, 101, 99.5, 100.5, 1], [550, 100.5, 101, 100, 100.8, 1]], 0, 1, 100, 99, 105, 100) - 0.8) < 1e-9);
    // ② 趨勢:後半高低都比較高 → 多頭
    const up = Array.from({ length: 54 }, (_, i) => [540 + i * 5, 100 + i * 0.1, 100.2 + i * 0.1, 99.8 + i * 0.1, 100.1 + i * 0.1, 1]);
    ok('② 昨日一路墊高 → 多頭', prevTrend(up) === '多頭', prevTrend(up));
    ok('②b 鏡像 → 空頭', prevTrend(up.map(b => [b[0], 200 - b[1], 200 - b[3], 200 - b[2], 200 - b[4], 1])) === '空頭');
    // ③ 多頭+開高收紅 → 第一根收盤做多,停損第一根低
    const d = [[540, 101, 102, 100.5, 101.8, 1], [545, 101.8, 102.5, 101.5, 102.2, 1]];
    const s = fourOpen('多頭', d, 100);
    ok('③ 多頭+開高收紅 → 第一根收盤進多、停損第一根低', s && s.side === 1 && s.entry === 101.8 && s.stop === 100.5 && s.j === 1, JSON.stringify(s));
    // ④ 空頭+開高收紅 → ⛔ 不可在第一根就做多(要等彈後出黑K空)
    const s2 = fourOpen('空頭', d, 100);
    ok('④ 空頭+開高收紅 → ⛔ 不做多(彈後空;這組兩根都紅 → 不進場)', s2 === null, JSON.stringify(s2));
    // ⑤ 零前視:第一根的收盤一定要用「第一根收完」的那個價,進場 j ≥ 1
    ok('⑤ 進場點一定在第一根收完之後(j≥1)', s.j >= 1);
    console.log(fail ? `\n❌ ${fail} 條失敗` : '\n✅ DT_KBAR5_SELFTEST_PASS');
    process.exit(fail ? 1 : 0);
}

function stats(a) {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    return { n: a.length, net: +mean(a).toFixed(3), win: +(a.filter(x => x > 0).length / a.length * 100).toFixed(1), med: +s[s.length >> 1].toFixed(3) };
}

async function main() {
    if (process.argv.includes('--selftest')) return selftest();
    const DD = process.env.DATA_DIR || path.join(ROOT, 'data');
    const { days, bias, src } = loadKbar5(process.env.KBAR5_DIR);
    if (!Object.keys(days).length) { console.error('❌ 要 KBAR5_DIR(git archive origin/kbar5 | tar -x;多份用冒號分隔,⭐ 寫在前面的優先)'); process.exit(1); }
    for (const x of src) console.log(`📂 ${x.dir}:${x.days} 天(其中 ${x.used} 天被採用)${x.bias ? ' ・' + x.bias.slice(0, 60) + '…' : ''}`);
    const dates = Object.keys(days).sort();
    if (dates.length < 40) { console.error(`❌ 只有 ${dates.length} 天 → 不下結論`); process.exit(1); }
    const split = dates[dates.length >> 1];
    const nYears = new Set(dates.map(d => d.slice(0, 4))).size;
    console.log('═'.repeat(90));
    console.log(nYears >= 2 ? `📅 5 分K ${dates.length} 個交易日(${dates[0]} ~ ${dates[dates.length - 1]},${nYears} 個年度)→ 逐年那一關做得到了` : `⚠️ 5 分K 只有 ${dates.length} 個交易日(${dates[0]} ~ ${dates[dates.length - 1]})→ ⛔ 逐年那關做不了,只能當方向提示`);
    console.log(`⚠️ 母體偏誤:${bias || '當日量前 80(天生只收當天夠熱的日子)'};ETF(0 開頭)已排除`);
    console.log('═'.repeat(90));
    // 日K(昨收 / 昨高低 / 隔天開盤)
    const dk = new Map();
    const getD = sym => { if (dk.has(sym)) return dk.get(sym); let m = null;
        try { let r = JSON.parse(fs.readFileSync(path.join(DD, `${sym}.json`), 'utf8')); r = Array.isArray(r) ? r : r.data; m = new Map(); r.forEach((x, i) => m.set(String(x.date).replace(/\//g, '-'), { i, r, x })); } catch { }
        dk.set(sym, m); return m; };
    const B = {}; const put = (k, v) => (B[k] = B[k] || []).push({ v, d: cur });
    let cur = '';
    const F3 = { hi: 0, lo: 0, n: 0 }, F4 = { poc: [], vwap: [], mid: [] };
    const F6 = {};
    let prevDayBars = {};
    for (let di = 0; di < dates.length; di++) { const d = dates[di];
        cur = d; const yday = dates[di - 1];
        const day = days[d]; const K = day.k || {};
        // F2 台指期:09:00 那根的開盤 vs 09:30 收盤
        const tx = day.idx && day.idx.TXF;
        // ⚠️ 台指期 5 分K 只從 V77.3.7 開始存(實測只有 4 天)→ 改用**當天這 80 檔 09:00→09:30 的平均漲跌**
        //   當「大盤順不順」的代理(⛔ 那是熱門股的大盤,不是加權指數;台指期存滿之後要換回來)
        let txDir = null;
        { const mv = [];
          for (const [sy, rw] of Object.entries(K)) { if (/^0/.test(sy)) continue; const bb = rw.filter(b => b[0] >= 540);
              const q = bb.findIndex(b => b[0] >= 565); if (bb.length > 10 && q > 0 && bb[0][1] > 0) mv.push(bb[q][4] / bb[0][1] - 1); }
          if (mv.length >= 30) { const m = mean(mv) * 100; txDir = m > 0.3 ? 1 : m < -0.3 ? -1 : 0; } }
        for (const [sym, raw] of Object.entries(K)) {
            if (/^0/.test(sym)) continue;
            const bars = raw.filter(b => b[0] >= 540 && b[0] <= 805);
            if (bars.length < 40) continue;
            const dm = getD(sym); const rec = dm && dm.get(d); if (!rec || rec.i < 1) continue;
            const P = rec.r[rec.i - 1]; const pc = +P.close, pH = +P.high, pL = +P.low; if (!(pc > 0)) continue;
            const o = bars[0][1];
            if (o >= pc * 1.095 || o <= pc * 0.905) { prevDayBars[sym] = { d, bars }; continue; }
            // F3
            const hiI = bars.reduce((m, b, k) => b[2] > bars[m][2] ? k : m, 0), loI = bars.reduce((m, b, k) => b[3] < bars[m][3] ? k : m, 0);
            F3.n++; if (bars[hiI][0] < 630) F3.hi++; if (bars[loI][0] < 630) F3.lo++;
            // F4
            const hi = Math.max(...bars.map(b => b[2])), lo = Math.min(...bars.map(b => b[3])), rg = hi - lo;
            if (rg > 0) { const bk = new Map(); let pv = 0, vv = 0;
                for (const b of bars) { const tp = (b[2] + b[3] + b[4]) / 3; const key = Math.round((tp - lo) / rg * 20); bk.set(key, (bk.get(key) || 0) + b[5]); pv += tp * b[5]; vv += b[5]; }
                const pk = [...bk.entries()].sort((a, b) => b[1] - a[1])[0][0]; const poc = lo + pk / 20 * rg, vw = vv > 0 ? pv / vv : (hi + lo) / 2, c = bars[bars.length - 1][4];
                F4.poc.push(Math.abs(c - poc) / rg); F4.vwap.push(Math.abs(c - vw) / rg); F4.mid.push(Math.abs(c - (hi + lo) / 2) / rg); }
            // 對照:第一根收盤、同出場規則(停損第一根、停利 2%)
            const [, , h1, l1, c1] = bars[0];
            const ctrlL = exitSim(bars, 1, 1, c1, l1, c1 * 1.02, pc) - COST, ctrlS = exitSim(bars, 1, -1, c1, h1, c1 * 0.98, pc) - COST;
            put('對照・多・第一根收盤進(停損第一根低・停利2%)', ctrlL); put('對照・空・第一根收盤進(停損第一根高・停利2%)', ctrlS);
            // F1
            const pb = prevDayBars[sym]; const tr = pb && pb.d === yday ? prevTrend(pb.bars) : null;   // ⛔ 昨天不在量前 80 → 不知道昨天的 5 分K,不猜
            if (tr) { const s = fourOpen(tr, bars, pc);
                if (s) { const g = exitSim(bars, s.j, s.side, s.entry, s.stop, s.entry * (s.side > 0 ? 1.02 : 0.98), pc) - COST;
                    put(`F1 ${s.combo} → ${s.side > 0 ? '做多' : '做空'}`, g); put(`F1 全部照做(${s.side > 0 ? '多' : '空'})`, g); } }
            // F2
            const i930 = bars.findIndex(b => b[0] >= 565);
            if (txDir != null && i930 > 0) { const e = bars[i930][4], c = bars[bars.length - 1][4];
                const rl = (c / e - 1) * 100 - COST, rs = (1 - c / e) * 100 - COST;
                put('對照・09:30 做多到收盤(不看大盤)', rl); put('對照・09:30 做空到收盤(不看大盤)', rs);
                if (txDir > 0) put('F2 熱門股大盤 09:30 平均 >+0.3% → 09:30 做多', rl);
                if (txDir < 0) put('F2 熱門股大盤 09:30 平均 <−0.3% → 09:30 做空', rs);
                if (txDir < 0) put('F2b 大盤走弱時「照樣做多」(他說的反例)', rl); }
            // F5 12:30 在 +6~8% → 買、隔天開盤賣
            const i1230 = bars.findIndex(b => b[0] >= 750);
            if (i1230 > 0) { const e = bars[i1230][4], up = (e / pc - 1) * 100; const nx = rec.r[rec.i + 1];
                if (nx && +nx.open > 0) { const g = (+nx.open / e - 1) * 100 - COST_ON;
                    put('對照・12:30 買、隔天開盤賣', g);
                    if (up >= 6 && up < 8) { put('F5 12:30 在 +6~8% → 買、隔天開盤賣', g); if (bars[bars.length - 1][4] >= pc * 1.095) put('F5b 同上而且真的收漲停(⛔ 事後才知道,只當對照)', g); } } }
            // F6
            for (const T of [0.5, 1, 2, 3]) for (const S of [0.5, 1, 2, 3]) {
                const g = exitSim(bars, 1, 1, c1, c1 * (1 - S / 100), c1 * (1 + T / 100), pc) - COST;
                (F6[`${T}|${S}`] = F6[`${T}|${S}`] || []).push(g); }
            // F7 熱門股跳空回歸 × 進場時點
            const gU = o > pH && (o / pc - 1) * 100 >= 2, gD = o < pL && (1 - o / pc) * 100 >= 2;
            // F7 對照(V77.5.1):**同一個進場時點、同樣抱到收盤**,只是不看跳空 → 量的是「跳空」這個條件本身
            { const c = bars[bars.length - 1][4];
              put('F7 對照・09:05 做空到收盤(不看跳空)', (1 - c / c1) * 100 - COST); put('F7 對照・09:05 做多到收盤(不看跳空)', (c / c1 - 1) * 100 - COST); }
            if (gU || gD) { const side = gU ? -1 : 1, lab = gU ? '開高≥2%(在昨高之上)→ 空' : '開低≥2%(在昨低之下)→ 買';
                const c = bars[bars.length - 1][4], ret = e => (side > 0 ? (c / e - 1) : (1 - c / e)) * 100 - COST;
                put(`F7 ${lab}・開盤價`, ret(o)); put(`F7 ${lab}・09:05`, ret(c1)); if (i930 > 0) put(`F7 ${lab}・09:30`, ret(bars[i930][4])); }
            prevDayBars[sym] = { d, bars };
        }
    }
    const out = { at: new Date().toISOString(), days: dates.length, window: [dates[0], dates[dates.length - 1]], bias, rows: {} };
    const show = (k) => { const a = (B[k] || []).map(x => x.v); const s = stats(a); if (!s) return null;
        const h1 = mean(B[k].filter(x => x.d < split).map(x => x.v)), h2 = mean(B[k].filter(x => x.d >= split).map(x => x.v));
        s.h = [+h1.toFixed(3), +h2.toFixed(3)];
        // 📅 逐年(⭐ 窗口 ≥ 2 年才印;V77.5.1 分K 回補之後才做得到)
        const ys = {}; for (const x of B[k]) (ys[x.d.slice(0, 4)] = ys[x.d.slice(0, 4)] || []).push(x.v);
        // 🔟 拿掉最好的 10 天(⭐ 六關第 6 關:整體正是不是只靠少數幾天撐起來)
        { const byD = new Map(); for (const x of B[k]) { const a = byD.get(x.d) || [0, 0]; a[0] += x.v; a[1]++; byD.set(x.d, a); }
          const top = new Set([...byD.entries()].sort((a, b) => b[1][0] - a[1][0]).slice(0, 10).map(e => e[0]));
          const rest = B[k].filter(x => !top.has(x.d)).map(x => x.v); s.drop10 = rest.length ? +mean(rest).toFixed(3) : null; }
        s.y = Object.fromEntries(Object.entries(ys).filter(([, a]) => a.length >= 10).map(([y, a]) => [y, +mean(a).toFixed(3)]));
        out.rows[k] = s; return s; };
    const line = (k, ctrlK) => { const s = show(k); if (!s) return; const c = ctrlK ? show(ctrlK) : null;
        console.log(`  ${s.n < 30 ? '⏳' : ''}${k.padEnd(44)} n=${String(s.n).padStart(5)} ・淨每趟 ${s.net >= 0 ? '+' : ''}${s.net}% ・勝率 ${s.win}% ・中位 ${s.med}% ・前後半 ${s.h.join('/')}${c ? ` ・vs對照 ${(s.net - c.net >= 0 ? '+' : '')}${(s.net - c.net).toFixed(3)}` : ''}${Object.keys(s.y).length >= 2 ? ` ・逐年 ${Object.entries(s.y).map(([y, v]) => `${y.slice(2)}:${v >= 0 ? '+' : ''}${v}`).join(' ')}` : ''}`); };
    console.log('\n═══ F1 🕘 開盤四法(扣 0.25%;對照 = 不分類一律第一根收盤進、同方向、同出場)═══');
    line('對照・多・第一根收盤進(停損第一根低・停利2%)'); line('對照・空・第一根收盤進(停損第一根高・停利2%)');
    for (const k of Object.keys(B).filter(k => k.startsWith('F1')).sort()) line(k, / 做多|\(多\)/.test(k) ? '對照・多・第一根收盤進(停損第一根低・停利2%)' : '對照・空・第一根收盤進(停損第一根高・停利2%)');
    console.log('\n═══ F2 🧭 大盤順風(代理:當天量前 80 檔 09:00→09:30 平均漲跌;台指期 5 分K 才存 4 天)═══');
    line('對照・09:30 做多到收盤(不看大盤)'); line('對照・09:30 做空到收盤(不看大盤)');
    line('F2 熱門股大盤 09:30 平均 >+0.3% → 09:30 做多', '對照・09:30 做多到收盤(不看大盤)');
    line('F2 熱門股大盤 09:30 平均 <−0.3% → 09:30 做空', '對照・09:30 做空到收盤(不看大盤)');
    line('F2b 大盤走弱時「照樣做多」(他說的反例)', '對照・09:30 做多到收盤(不看大盤)');
    console.log(`\n═══ F3 ⏰ 當天最高點出在 10:30 前 ${(F3.hi / F3.n * 100).toFixed(1)}% ・最低點 ${(F3.lo / F3.n * 100).toFixed(1)}%(n=${F3.n};10:30 前佔全天時間 ${(90 / 265 * 100).toFixed(0)}%)═══`);
    out.F3 = { hi: +(F3.hi / F3.n * 100).toFixed(1), lo: +(F3.lo / F3.n * 100).toFixed(1), n: F3.n };
    console.log(`═══ F4 🧲 收盤離「量最大價位」平均 ${(mean(F4.poc) * 100).toFixed(1)}% 個振幅 ・離 VWAP ${(mean(F4.vwap) * 100).toFixed(1)}% ・離高低中點 ${(mean(F4.mid) * 100).toFixed(1)}%(越小 = 越被吸過去)═══`);
    out.F4 = { poc: +(mean(F4.poc) * 100).toFixed(1), vwap: +(mean(F4.vwap) * 100).toFixed(1), mid: +(mean(F4.mid) * 100).toFixed(1) };
    console.log('\n═══ F5 🚀 12:30 在 +6~8% → 買、隔天開盤賣(扣 0.44%)═══');
    line('對照・12:30 買、隔天開盤賣'); line('F5 12:30 在 +6~8% → 買、隔天開盤賣', '對照・12:30 買、隔天開盤賣'); line('F5b 同上而且真的收漲停(⛔ 事後才知道,只當對照)', '對照・12:30 買、隔天開盤賣');
    console.log('\n═══ F6 ⚖️ 第一根收盤做多 × 停利 × 停損 → 勝率 / 扣 0.25% 期望值(⭐ 勝率可以調,期望值才是真的)═══');
    console.log('   停利\\停損 |' + [0.5, 1, 2, 3].map(S => `  停損${S}%`.padStart(18)).join(''));
    out.F6 = {};
    for (const T of [0.5, 1, 2, 3]) { let row = `   停利${String(T).padEnd(4)}% |`;
        for (const S of [0.5, 1, 2, 3]) { const s = stats(F6[`${T}|${S}`] || []); out.F6[`${T}|${S}`] = s; row += `  勝率${s.win}% ${s.net >= 0 ? '+' : ''}${s.net}%`.padStart(18); }
        console.log(row); }
    console.log('\n═══ F7 ⚡ 熱門股跳空回歸 × 進場時點(接日K 探針 D2c/D2d)═══');
    line('F7 對照・09:05 做空到收盤(不看跳空)'); line('F7 對照・09:05 做多到收盤(不看跳空)');
    for (const k of Object.keys(B).filter(k => k.startsWith('F7') && !k.includes('對照')).sort())
        { line(k, /・09:05$/.test(k) ? (/空/.test(k) ? 'F7 對照・09:05 做空到收盤(不看跳空)' : 'F7 對照・09:05 做多到收盤(不看跳空)') : null);
          const r = out.rows[k]; if (r && r.drop10 != null) console.log(`      └ 拿掉最好的 10 天 → ${r.drop10 >= 0 ? '+' : ''}${r.drop10}%`); }
    const OUT = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : null;
    if (OUT) fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
}
if (import.meta.url === `file://${process.argv[1]}`) main();
