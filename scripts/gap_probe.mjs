#!/usr/bin/env node
/**
 * 🌅 「開盤跳空法」探針(V73.6.0)—— 只讀 data/,不打網路、不寫產物。
 *
 * ❓ 來源:使用者上傳的 53 份當沖逐字稿裡,**唯一有完整數字門檻**的一套(摩卡「開盤跳空法」):
 *    ① 開盤跳空 +2% ~ +4%(小於 2% 力道弱、大於 4% 一開盤就被倒)
 *    ② 開盤後前 5 分鐘收在 K 棒上緣
 *    ③ 前 5 分鐘量 ≥ 昨日全日量的 10%
 *    出場:停損下方 2~4 檔、停利上方 2~4 檔。
 *
 * ⭐⭐ **這支刻意只驗條件 ①**,理由是成本:
 *    ②③ 要 1 分 K(Shioaji,雲端跑、深度只有約 81 個交易日)。
 *    而 ① 用**日線就驗得動**(`open` vs 前一日 `close`),而且是**全市場 2 年**。
 *    → 先用便宜的資料排除:**如果「跳空 2~4%」這個母體本身連毛利都是負的,
 *      ②③ 只是它的子集合,不可能救得回來** —— 那就不必花雲端額度去測分 K。
 *    (同 ORB 那次的教訓:當沖策略一定要扣掉來回成本 0.25% 再看。)
 *
 * 📐 六道守門:
 *   ・對照組 = **同一個母體、不抽樣**(所有交易日的所有股票)
 *   ・報酬扣**同期加權指數**(⛔ 大多頭裡什麼都是正的)
 *   ・**扣當沖來回成本 0.25%**
 *   ・同檔同事件 5 日去重
 *   ・前後半段分開看(⛔ 只有一半贏 = 不算數)
 *   ・拿掉最好的那一個月還贏嗎
 *
 * 🚧 空過守門:事件數 < 300 → exit 1(結論不可信)。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const COST = 0.25;          // 當沖來回成本 %(手續費 3 折 + 當沖稅減半)
const DEDUP = 5;

const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;

// 大盤:日期 → 當日 開→收 %(當沖的對照組要用**同一段時間**的大盤,⛔ 不是昨收到今收)
const twRaw = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8'));
const twArr = Array.isArray(twRaw) ? twRaw : (twRaw.data || []);
const twO2C = new Map();
for (const r of twArr) {
    const o = +r.open, c = +r.close;
    if (o > 0 && c > 0) twO2C.set(String(r.date).replace(/\//g, '-'), (c / o - 1) * 100);
}
console.log(`📈 大盤開→收對照表 ${twO2C.size} 天`);

const files = fs.readdirSync(DATA).filter(f => /^\d+\.json$/.test(f));
console.log(`📂 掃 ${files.length} 檔`);

const buckets = new Map();   // 名稱 → [{d, ex}]
const push = (name, d, ex) => { if (!buckets.has(name)) buckets.set(name, []); buckets.get(name).push({ d, ex }); };

let used = 0, allN = 0;
for (const f of files) {
    let rows;
    try { rows = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { continue; }
    rows = Array.isArray(rows) ? rows : (rows.data || []);
    if (rows.length < 60) continue;
    used++;
    let lastEvent = -99;
    for (let i = 1; i < rows.length; i++) {
        const r = rows[i], p = rows[i - 1];
        const o = +r.open, c = +r.close, h = +r.high, l = +r.low, pc = +p.close;
        const vol = +(r.volume || 0), pvol = +(p.volume || 0);
        if (!(o > 0 && c > 0 && pc > 0 && h > 0 && l > 0)) continue;
        const dt = String(r.date).replace(/\//g, '-');
        const mkt = twO2C.get(dt);
        if (mkt === undefined) continue;
        const gap = (o / pc - 1) * 100;                 // 跳空幅度
        const ex = (c / o - 1) * 100 - mkt - COST;      // 開盤買、收盤賣的**淨超額**報酬
        allN++;
        push('(對照組)所有交易日', dt, ex);            // ⛔ 不抽樣,直接同母體

        if (gap <= 0) continue;
        // 分桶看跳空幅度(⭐ 他說 2~4% 是甜蜜點 —— 兩邊都要看才知道是不是真的)
        const b = gap < 1 ? '跳空 0~1%' : gap < 2 ? '跳空 1~2%'
                : gap <= 4 ? '⭐ 跳空 2~4%(他說的)' : gap <= 6 ? '跳空 4~6%' : '跳空 >6%';
        push(b, dt, ex);

        // ⭐ 他的完整條件(日線能近似的兩條):跳空 2~4% + 收在當日 K 棒上緣
        //   ⚠️ 這是「全天 K 棒」不是「前 5 分鐘 K 棒」→ **近似**,結論要標明。
        if (gap >= 2 && gap <= 4) {
            if (i - lastEvent >= DEDUP) {
                lastEvent = i;
                push('⭐ 跳空2~4%(去重)', dt, ex);
                // 🚨🚨 第一版在這裡犯了**前視偏誤**,寫下來免得有人再加一次:
                //    我原本用「今天收在 K 棒上緣」當條件 → 而報酬 `ex` 也是用**今天的收盤價**算的
                //    → 等於拿答案當條件,跑出 +1.20%、勝率 66.4% 的漂亮數字,**完全是假的**。
                //    ⛔ 任何「開盤就要決定進場」的條件,都只能用**開盤那一刻已知**的資訊。
                //    他原本的條件是「**前 5 分鐘**收在 K 棒上緣」—— 那個日線根本沒有,
                //    只能用分 K;⛔ 不可用全天 K 棒代替(同陷阱:同期相關是廢話)。
                //
                // ✅ 以下改用「開盤時就已經知道」的變數:
                const pclr = (+p.high > +p.low) ? (pc - +p.low) / (+p.high - +p.low) * 100 : 50;
                if (pclr >= 70) push('✅ 跳空2~4% + 昨天收上緣(開盤已知)', dt, ex);
                if (pvol > 0) {
                    // 昨日量 vs 前五日均量(開盤已知)
                    let s = 0, k = 0;
                    for (let j = Math.max(0, i - 6); j < i; j++) { s += +(rows[j].volume || 0); k++; }
                    if (k && s / k > 0 && pvol >= s / k * 1.5) push('✅ 跳空2~4% + 昨天爆量(開盤已知)', dt, ex);
                }
            }
        }
    }
}
console.log(`✅ 有效 ${used} 檔・全部樣本 ${allN.toLocaleString()} 筆\n`);

const base = buckets.get('(對照組)所有交易日') || [];
if (!base.length) { console.log('❌ 對照組是空的 → 這一輪無效'); process.exit(1); }
const bMed = med(base.map(x => x.ex)), bWin = base.filter(x => x.ex > 0).length / base.length * 100;

const order = ['(對照組)所有交易日', '跳空 0~1%', '跳空 1~2%', '⭐ 跳空 2~4%(他說的)',
               '跳空 4~6%', '跳空 >6%', '⭐ 跳空2~4%(去重)',
               '✅ 跳空2~4% + 昨天收上緣(開盤已知)', '✅ 跳空2~4% + 昨天爆量(開盤已知)'];
console.log('═══ 當日「開盤買 → 收盤賣」的淨超額報酬(已扣同期大盤 + 來回成本 0.25%)═══');
console.log(`${'情境'.padEnd(34)}${'n'.padStart(9)}${'中位%'.padStart(9)}${'平均%'.padStart(9)}${'勝率%'.padStart(8)}${'vs 對照'.padStart(10)}`);
console.log('─'.repeat(79));
for (const k of order) {
    const a = buckets.get(k);
    if (!a || !a.length) continue;
    const m = med(a.map(x => x.ex)), av = avg(a.map(x => x.ex));
    const w = a.filter(x => x.ex > 0).length / a.length * 100;
    console.log(`${k.padEnd(34)}${a.length.toLocaleString().padStart(9)}${m.toFixed(2).padStart(9)}${av.toFixed(2).padStart(9)}${w.toFixed(1).padStart(8)}${(m - bMed >= 0 ? '+' : '') + (m - bMed).toFixed(2) + 'pp'}`.padEnd(0));
}
console.log(`\n(對照組基準:中位 ${bMed.toFixed(2)}% ・ 勝率 ${bWin.toFixed(1)}%)`);

// ⭐ 穩健性:前後半段 + 拿掉最好的那個月
const key = '⭐ 跳空2~4%(去重)';
const ev = buckets.get(key) || [];
if (ev.length >= 300) {
    const ds = [...new Set(ev.map(x => x.d))].sort();
    const mid = ds[ds.length >> 1];
    const h1 = ev.filter(x => x.d <= mid), h2 = ev.filter(x => x.d > mid);
    const b1 = base.filter(x => x.d <= mid), b2 = base.filter(x => x.d > mid);
    console.log('\n⭐ 穩健性(⛔ 只有一半贏 = 不算數):');
    console.log(`   前半 ${med(h1.map(x => x.ex)).toFixed(2)}% vs 對照 ${med(b1.map(x => x.ex)).toFixed(2)}%  → ${(med(h1.map(x => x.ex)) - med(b1.map(x => x.ex))).toFixed(2)}pp (n=${h1.length})`);
    console.log(`   後半 ${med(h2.map(x => x.ex)).toFixed(2)}% vs 對照 ${med(b2.map(x => x.ex)).toFixed(2)}%  → ${(med(h2.map(x => x.ex)) - med(b2.map(x => x.ex))).toFixed(2)}pp (n=${h2.length})`);
    const bym = {};
    for (const x of ev) { const m = x.d.slice(0, 7); (bym[m] ||= []).push(x.ex); }
    const rank = Object.entries(bym).map(([m, a]) => [m, avg(a) * a.length]).sort((x, y) => y[1] - x[1]);
    const bestM = rank[0][0];
    const wo = ev.filter(x => !x.d.startsWith(bestM));
    console.log(`   最好的月份 ${bestM} 貢獻 ${rank[0][1].toFixed(0)} → 拿掉之後中位 ${med(wo.map(x => x.ex)).toFixed(2)}%`);
} else {
    console.log(`\n⚠️ 完整條件只有 ${ev.length} 筆 < 300 → 🚧 空過守門,不做穩健性檢定`);
}

console.log('\n⛔ 怎麼讀:');
console.log('   ・中位是**負的** → 扣完成本後不划算,⛔ 不必再花雲端額度去測分 K 版');
console.log('   ・「跳空 2~4%」要**明顯優於相鄰兩桶**才算他說的甜蜜點成立;');
console.log('     若相鄰桶差不多 → 那條線是隨口訂的,⛔ 不可照抄');
console.log('   ⚠️ 他的條件②③(前 5 分鐘收上緣 + 前 5 分鐘量)日線做不到,只能用分 K;');
console.log('     ⛔ 但**不可**用「全天 K 棒收上緣」代替 —— 那會拿收盤價當條件又拿收盤價算報酬(前視偏誤)。');

if ((buckets.get('⭐ 跳空2~4%(去重)') || []).length < 300) {
    console.log('\n❌ 事件數不足 300 → 這一輪結論不可信');
    process.exit(1);
}
