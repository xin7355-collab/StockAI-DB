#!/usr/bin/env node
/**
 * ⏱️ 盤中「時段口訣」描述型探針 —— 讀 kbar5 分支的 5 分 K,只印事實、⛔ 不下結論(評估紀錄㉘)
 *
 * 老余逐字稿(17 / 19.txt)講了幾條盤中時段規律:
 *   ① 「早盤很習慣在 11 點或 11 點半附近出現停頓 / 轉折」(台灣大戶休息、陸股 11:30 午休)
 *   ② 「10 點半過後容易出現下殺到某個程度開始慢慢反彈;大成交量在 9~10 點多」
 *   ③ 「尾盤(12:30 後)拉抬」/ 「結算日當天 12 點半開始的尾盤做選擇權很有利」
 *
 * ⛔ 為什麼這一支**只描述**:
 *   ・kbar5 只有 2026-05 起約 90 個交易日 → 六關的「逐年同向 / 去最好年」做不到(CLAUDE.md:約 2027-02 才滿一年)
 *   ・母體是「當日成交量前 80」(使用者選的)→ 每天名單不同、天生只收「當天夠熱」的日子 = 選樣偏誤
 *   → 這裡的每一個數字都是「在這 90 天、這批熱門股上長什麼樣」,⛔ 不可講得像全市場、⛔ 不可當訊號。
 *
 * 用法:KBAR5_DIR=<git archive origin/kbar5 解出來的 kbar5/ 目錄> node scripts/kbar5_tod_probe.mjs [輸出.json]
 *       node scripts/kbar5_tod_probe.mjs --selftest
 * 只讀、不打 API;exit 0(探針不進四驗證)。
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = process.env.KBAR5_DIR || path.join(ROOT, 'kbar5');
const SELFTEST = process.argv.includes('--selftest');
const OUT = process.argv.slice(2).find(a => a.endsWith('.json')) || '';
const f2 = (x, w = 6, p = 2) => (x >= 0 ? '+' : '') + x.toFixed(p).padStart(w);
const hmTxt = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// 30 分鐘時段桶(09:00 = 540)
const SLOTS = [[540, 570], [570, 600], [600, 630], [630, 660], [660, 690], [690, 720], [720, 750], [750, 780], [780, 811]];
// 第三個週三 = 台指期結算日(與 calendar_stock_probe 同一套定義)
function isSettle(d) {
    const [y, m, day] = d.split('-').map(Number);
    let cnt = 0;
    for (let k = 1; k <= 31; k++) { const x = new Date(Date.UTC(y, m - 1, k)); if (x.getUTCMonth() !== m - 1) break; if (x.getUTCDay() === 3) { cnt++; if (cnt === 3) return k === day; } }
    return false;
}

/** 把一天一檔的 5 分 K 壓成事實(全部相對開盤價 %) */
export function dayFacts(bars) {
    if (!Array.isArray(bars) || bars.length < 40) return null;
    const b = bars.filter(x => Array.isArray(x) && x.length >= 6 && x[1] > 0).sort((a, c) => a[0] - c[0]);
    if (b.length < 40) return null;
    const o0 = b[0][1];
    const at = hm => { let best = null; for (const x of b) if (x[0] <= hm) best = x; return best; };   // 該時刻(含)之前最後一根
    const pct = (a, c) => (c / a - 1) * 100;
    // 每個時段的收盤相對開盤 / 該時段內的量佔全日
    const totV = b.reduce((s, x) => s + (+x[5] || 0), 0) || 1;
    const slots = SLOTS.map(([a, z]) => {
        const inb = b.filter(x => x[0] >= a && x[0] < z);
        const last = inb.length ? inb[inb.length - 1] : null;
        return { a, z, path: last ? pct(o0, last[4]) : null, vol: inb.reduce((s, x) => s + (+x[5] || 0), 0) / totV * 100,
                 ret: inb.length ? pct(inb[0][1], inb[inb.length - 1][4]) : null };
    });
    // 全日最低 / 最高出現在哪一段
    let lo = Infinity, loHm = 0, hi = -Infinity, hiHm = 0;
    for (const x of b) { if (x[3] < lo) { lo = x[3]; loHm = x[0]; } if (x[2] > hi) { hi = x[2]; hiHm = x[0]; } }
    const slotOf = hm => SLOTS.findIndex(([a, z]) => hm >= a && hm < z);
    // ① 11:00~11:30 轉折:10:30→11:15 與 11:15→12:00 方向相反;對照 = 其他每個 45 分窗口的翻轉率
    const flip = (m1, m2, m3) => { const p1 = at(m1), p2 = at(m2), p3 = at(m3); if (!p1 || !p2 || !p3) return null; const r1 = p2[4] - p1[4], r2 = p3[4] - p2[4]; return (r1 !== 0 && r2 !== 0) ? (Math.sign(r1) !== Math.sign(r2)) : null; };
    const flips = {};
    for (let m = 570; m + 90 <= 810; m += 15) flips[hmTxt(m + 45)] = flip(m, m + 45, m + 90);
    // ③ 尾盤:12:30→13:30 報酬;13:00→13:30
    const p1230 = at(750), p1300 = at(780), pEnd = b[b.length - 1];
    return {
        slots, loSlot: slotOf(loHm), hiSlot: slotOf(hiHm), flips,
        tail1230: p1230 ? pct(p1230[4], pEnd[4]) : null, tail1300: p1300 ? pct(p1300[4], pEnd[4]) : null,
        day: pct(o0, pEnd[4]),
    };
}

function selftest() {
    let bad = 0; const ck = (ok, m) => { console.log((ok ? '✅ ' : '❌ ') + m); if (!ok) bad++; };
    // 合成一天:09:00 開 100,一路跌到 11:15 = 97(最低),之後漲到 13:30 = 101;量集中在 09:00~10:00
    const bars = [];
    for (let m = 540; m <= 810; m += 5) {
        const px = m <= 675 ? 100 - 3 * (m - 540) / 135 : 97 + 4 * (m - 675) / 135;
        bars.push([m, px, px + 0.05, px - 0.05, px, m < 600 ? 1000 : 100]);
    }
    const F = dayFacts(bars);
    ck(!!F, '合成日算得出事實');
    ck(F && F.loSlot === 4, `全日最低落在 11:00~11:30 那一桶(loSlot=${F && F.loSlot})`);
    ck(F && F.flips['11:15'] === true, '10:30→11:15→12:00 判定為轉折');
    ck(F && F.flips['10:15'] === false, '09:30→10:15→11:00 一路跌 ⛔ 不是轉折');
    ck(F && Math.abs(F.tail1230 - (101 / (97 + 4 * 75 / 135) - 1) * 100) < 1e-9, '12:30 之後的尾盤報酬算對');
    ck(F && Math.abs(F.slots[0].vol - 6000 / 16300 * 100) < 1e-6, `09:00~09:30 量佔全日 ${F && F.slots[0].vol.toFixed(1)}%(合成:6 根×1000 ÷ 全日 16,300 = 36.8%)`);
    ck(isSettle('2026-09-16') && !isSettle('2026-09-17') && !isSettle('2026-09-09'), '結算日 = 第三個週三(2026-09-16)');
    // 打亂順序也要算對(bars 不保證有序)
    const F2 = dayFacts([...bars].reverse());
    ck(F2 && F2.loSlot === 4 && Math.abs(F2.day - F.day) < 1e-9, '亂序輸入結果一樣');
    console.log('\n' + (bad ? `❌ SELFTEST_FAIL:${bad}` : '✅ SELFTEST_PASS'));
    process.exit(bad ? 1 : 0);
}
if (SELFTEST) selftest();

// ═══════════ 實跑 ═══════════
const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter(f => /^\d{4}-\d{2}\.json\.gz$/.test(f)).sort() : [];
if (!files.length) { console.log(`❌ ${DIR} 裡沒有 kbar5/*.json.gz(先 git archive origin/kbar5 | tar -x)`); process.exit(1); }
const perSym = new Map();     // sym → 天數
let days = 0, obs = 0, bias = '';
const agg = { slotPath: SLOTS.map(() => ({ s: 0, n: 0 })), slotVol: SLOTS.map(() => ({ s: 0, n: 0 })), slotRetPos: SLOTS.map(() => ({ p: 0, n: 0 })),
              loSlot: SLOTS.map(() => 0), hiSlot: SLOTS.map(() => 0), flips: {}, tail1230: { s: 0, n: 0, p: 0 }, tail1300: { s: 0, n: 0, p: 0 },
              settle: { s: 0, n: 0, p: 0 }, nonSettle: { s: 0, n: 0, p: 0 }, dayLimit: 0 };
const dayList = [];
for (const f of files) {
    const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DIR, f))).toString('utf8'));
    bias = bias || j.bias || '';
    for (const d of Object.keys(j.d || {}).sort()) {
        const D = j.d[d]; if (!D || !D.k) continue;
        days++; dayList.push(d);
        const settle = isSettle(d);
        for (const sym of Object.keys(D.k)) {
            const F = dayFacts(D.k[sym]); if (!F) continue;
            obs++; perSym.set(sym, (perSym.get(sym) || 0) + 1);
            F.slots.forEach((s, i) => { if (s.path != null) { agg.slotPath[i].s += s.path; agg.slotPath[i].n++; } agg.slotVol[i].s += s.vol; agg.slotVol[i].n++; if (s.ret != null) { agg.slotRetPos[i].n++; if (s.ret > 0) agg.slotRetPos[i].p++; } });
            if (F.loSlot >= 0) agg.loSlot[F.loSlot]++; if (F.hiSlot >= 0) agg.hiSlot[F.hiSlot]++;
            for (const [k, v] of Object.entries(F.flips)) { if (v == null) continue; const a = agg.flips[k] || (agg.flips[k] = { f: 0, n: 0 }); a.n++; if (v) a.f++; }
            if (F.tail1230 != null) { agg.tail1230.s += F.tail1230; agg.tail1230.n++; if (F.tail1230 > 0) agg.tail1230.p++; const T = settle ? agg.settle : agg.nonSettle; T.s += F.tail1230; T.n++; if (F.tail1230 > 0) T.p++; }
            if (F.tail1300 != null) { agg.tail1300.s += F.tail1300; agg.tail1300.n++; if (F.tail1300 > 0) agg.tail1300.p++; }
        }
    }
}
const cnts = [...perSym.values()].sort((a, b) => a - b);
const med = cnts[Math.floor(cnts.length / 2)] || 0;
console.log('⏱️ 盤中時段口訣 —— 描述型探針(⛔ 只印事實,不下結論)');
console.log(`📅 ${dayList[0]} ~ ${dayList[dayList.length - 1]} ・${days} 個交易日 ・${obs.toLocaleString()} 個(股·日)・${perSym.size} 檔曾入榜`);
console.log(`🚧 母體:${bias || '當日成交量前 80'}`);
console.log(`   每檔在窗口內的天數:中位 ${med} ・最少 ${cnts[0]} ・最多 ${cnts[cnts.length - 1]} ・只出現 ≤5 天的 ${cnts.filter(x => x <= 5).length} 檔 → ⚠️ 名單天天變,結論⛔ 不可講得像全市場`);
console.log(`⛔ 只有 ${days} 天 → 六關的「逐年同向 / 去最好年」做不到(約 2027-02 滿一年);下面每個數字都只是「這 ${days} 天長什麼樣」\n`);
console.log('時段         相對開盤%  該段報酬>0  量佔全日%  全日最低落此  全日最高落此');
SLOTS.forEach(([a, z], i) => {
    const P = agg.slotPath[i], V = agg.slotVol[i], R = agg.slotRetPos[i];
    console.log(`${hmTxt(a)}~${hmTxt(Math.min(z, 810))}  ${f2(P.n ? P.s / P.n : 0, 8)}  ${(R.n ? R.p / R.n * 100 : 0).toFixed(1).padStart(9)}%  ${(V.n ? V.s / V.n : 0).toFixed(1).padStart(8)}%  ${(obs ? agg.loSlot[i] / obs * 100 : 0).toFixed(1).padStart(11)}%  ${(obs ? agg.hiSlot[i] / obs * 100 : 0).toFixed(1).padStart(11)}%`);
});
console.log(`\n① 「11:00~11:30 轉折」:45 分窗口方向翻轉率(對照 = 其他窗口;⛔ 翻轉率高 ≠ 可交易)`);
const fk = Object.keys(agg.flips).sort();
const fr = fk.map(k => ({ k, r: agg.flips[k].n ? agg.flips[k].f / agg.flips[k].n * 100 : 0, n: agg.flips[k].n }));
const meanFlip = fr.reduce((s, x) => s + x.r, 0) / (fr.length || 1);
for (const x of fr) console.log(`   轉折點 ${x.k}:${x.r.toFixed(1).padStart(5)}%${x.k === '11:15' || x.k === '11:30' ? '  ⬅ 口訣講的' : ''}`);
console.log(`   全部窗口平均 ${meanFlip.toFixed(1)}%(隨機遊走理論值 50%)`);
console.log(`\n② 「10:30 後下殺再反彈」:全日最低落在 10:30~11:30 的比例 ${(obs ? (agg.loSlot[3] + agg.loSlot[4]) / obs * 100 : 0).toFixed(1)}%(均分 9 段的話 2 段 = 22.2%);09:00~10:00 量佔 ${((agg.slotVol[0].s + agg.slotVol[1].s) / (agg.slotVol[0].n || 1)).toFixed(1)}%`);
const T = agg.tail1230, T3 = agg.tail1300;
console.log(`\n③ 尾盤:12:30→收盤 平均 ${f2(T.n ? T.s / T.n : 0)}%、>0 的 ${(T.n ? T.p / T.n * 100 : 0).toFixed(1)}%;13:00→收盤 平均 ${f2(T3.n ? T3.s / T3.n : 0)}%、>0 的 ${(T3.n ? T3.p / T3.n * 100 : 0).toFixed(1)}%`);
console.log(`   結算日(第三個週三)12:30→收盤 平均 ${f2(agg.settle.n ? agg.settle.s / agg.settle.n : 0)}%(n=${agg.settle.n},>0 ${(agg.settle.n ? agg.settle.p / agg.settle.n * 100 : 0).toFixed(1)}%)vs 非結算日 ${f2(agg.nonSettle.n ? agg.nonSettle.s / agg.nonSettle.n : 0)}%(n=${agg.nonSettle.n})`);
console.log('\n⚠️ 這是個股的 5 分 K;他講的多半是台指期 —— kbar5 目前沒有台指期(V77.3.8 起才加收)。');
console.log('⛔ 沒有對照組、沒有關卡、沒有成本 → 一個都不可寫成訊號;2027-02 之後用 intraday_probe 的七關版重測。');
if (OUT) {
    fs.writeFileSync(OUT, JSON.stringify({ from: dayList[0], to: dayList[dayList.length - 1], days, obs, syms: perSym.size, medDays: med, bias,
        slots: SLOTS.map(([a, z], i) => ({ a, z, path: agg.slotPath[i].n ? agg.slotPath[i].s / agg.slotPath[i].n : null, vol: agg.slotVol[i].n ? agg.slotVol[i].s / agg.slotVol[i].n : null, lo: agg.loSlot[i] / (obs || 1), hi: agg.hiSlot[i] / (obs || 1) })),
        flips: fr, meanFlip, tail1230: T, tail1300: T3, settle: agg.settle, nonSettle: agg.nonSettle }, null, 1));
    console.log(`💾 ${OUT}`);
}
