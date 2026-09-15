#!/usr/bin/env node
/**
 * 📏 「快突破月線」到底是不是「容易繼續飆」?(V77.0.8)
 *
 * 使用者看富喬(1815)現價 116.00、月線 117.38(差 1.2%)問:
 *   「已經快突破月線,這個意思是不是容易繼續飆的意思?應該用顏色區分」
 *
 * ⛔ 這是可以量的,別用猜的。量三件事:
 *   ① 站在月線**下方 0~3%**(= 快突破)之後 5/10/20 日的超額報酬
 *   ② 跟**已經站上**月線、以及**離月線還很遠**的比
 *   ③ 對照組 = **同一批股票的所有交易日**(⛔ 不是只跟 0 比)
 *
 * ⚠️ 超額 = 個股報酬 − 同期加權(^TWII),⛔ 不是絕對報酬。
 * ⚠️ 同一檔 20 個交易日內只算一次(⛔ 否則一波行情被拆成 20 筆假樣本)。
 * ⚠️ 進場價一律用 **t+1 開盤**(⛔ 不可用當天收盤 —— 收盤前你不知道今天會收在哪)。
 *
 * 用法:DATA_DIR=data node scripts/near_ma_probe.mjs
 *       node scripts/near_ma_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';

const DIR = process.env.DATA_DIR || 'data';
const FWD = [5, 10, 20];
const DEDUP = 20;
const COST = 0.44;

const rd = (f) => { try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(j) ? j : (j.data || []); } catch { return []; } };
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const D = s => String(s || '').replace(/\//g, '-');

function main() {
    const twii = rd(path.join(DIR, '^TWII.json'));
    if (twii.length < 300) { console.log('❌ 讀不到 ^TWII(超額報酬要扣同期大盤)'); process.exit(1); }
    const ti = new Map(twii.map((r, i) => [D(r.date), i]));
    const tc = twii.map(r => +r.close || 0);

    const files = fs.readdirSync(DIR).filter(f => /^\d{4}[A-Z]?\.json$/.test(f));
    console.log(`📦 掃 ${files.length} 檔 ・對照組 = 同一批股票的所有交易日 ・超額已扣同期加權`);

    // 桶:0 = 已站上月線 / 1 = 月線下 0~3%(快突破) / 2 = 月線下 3~8% / 3 = 月線下 >8%
    const B = [[], [], [], []].map(() => FWD.map(() => []));
    const base = FWD.map(() => []);
    let nSym = 0, nEv = 0;

    for (const f of files) {
        const rows = rd(path.join(DIR, f));
        if (rows.length < 260) continue;
        nSym++;
        const c = rows.map(r => +r.close || 0);
        const last = {};                      // 每桶最後一次事件的 index(去重用)
        for (let i = 40; i < rows.length - Math.max(...FWD) - 1; i++) {
            if (!(c[i] > 0)) continue;
            // 月線 = 20 日均(⛔ 只用 i 之前含 i 的資料,零前視)
            let s = 0, ok = true;
            for (let k = i - 19; k <= i; k++) { if (!(c[k] > 0)) { ok = false; break; } s += c[k]; }
            if (!ok) continue;
            const ma = s / 20;
            if (!(ma > 0)) continue;
            const gap = (ma - c[i]) / ma * 100;     // >0 = 還在月線下方幾 %
            const b = gap <= 0 ? 0 : (gap <= 3 ? 1 : (gap <= 8 ? 2 : 3));
            // 🚪 進場 = t+1 開盤(⛔ 不用當天收盤)
            const e = +rows[i + 1]?.open || +rows[i + 1]?.close || 0;
            if (!(e > 0)) continue;
            const t0 = ti.get(D(rows[i + 1].date));
            if (t0 == null) continue;
            const push = (arr) => FWD.forEach((n, k) => {
                const cn = +rows[i + 1 + n]?.close || 0, t1 = t0 + n;
                if (!(cn > 0) || !(tc[t1] > 0) || !(tc[t0] > 0)) return;
                arr[k].push((cn / e - 1) * 100 - (tc[t1] / tc[t0] - 1) * 100);
            });
            push(base);
            if (last[b] != null && i - last[b] < DEDUP) continue;   // 同檔同桶 20 日內只算一次
            last[b] = i; nEv++;
            push(B[b]);
        }
    }

    const LAB = ['✅ 已經站上月線', '⭐ 快突破(月線下 0~3%)', '月線下 3~8%', '月線下 >8%'];
    console.log(`\n📊 有效 ${nSym} 檔 ・去重後事件 ${nEv.toLocaleString()} 筆\n`);
    console.log('   ' + '桶'.padEnd(24) + FWD.map(n => `+${n}日`.padStart(9)).join('') + '   樣本');
    const bm = FWD.map((_, k) => mean(base[k]));
    console.log('   ' + '📊 對照組(所有交易日)'.padEnd(22) + bm.map(m => (m == null ? '  —  ' : m.toFixed(2)).padStart(9)).join('') + `   ${base[0].length.toLocaleString()}`);
    const res = [];
    B.forEach((arr, b) => {
        const ms = FWD.map((_, k) => mean(arr[k]));
        res.push(ms);
        console.log('   ' + LAB[b].padEnd(22) + ms.map(m => (m == null ? '  —  ' : m.toFixed(2)).padStart(9)).join('') + `   ${arr[0].length.toLocaleString()}`);
    });
    console.log('\n   📐 減掉對照組之後的**增量**(pp):');
    B.forEach((arr, b) => {
        const d = FWD.map((_, k) => (res[b][k] == null || bm[k] == null) ? null : res[b][k] - bm[k]);
        console.log('   ' + LAB[b].padEnd(22) + d.map(x => (x == null ? '  —  ' : (x >= 0 ? '+' : '') + x.toFixed(2)).padStart(9)).join(''));
    });
    const k20 = FWD.indexOf(20);
    const near = res[1][k20] - bm[k20], above = res[0][k20] - bm[k20];
    console.log('\n' + '═'.repeat(88));
    console.log(`⭐ 「快突破」的 +20 日增量 = ${near >= 0 ? '+' : ''}${near.toFixed(2)}pp ・「已站上」= ${above >= 0 ? '+' : ''}${above.toFixed(2)}pp ・成本 ${COST}%`);
    if (near - COST > 0 && near > above) console.log('   → 「快突破」本身有超過成本的優勢,而且比「已站上」好');
    else if (near <= 0) console.log('   ⛔ 「快突破」**沒有**優勢 —— 它不是「容易繼續飆」的意思');
    else console.log(`   ⚠️ 有一點但**吃不掉成本**(${(near - COST).toFixed(2)}pp)→ ⛔ 不可當買進理由`);
    console.log('═'.repeat(88));
    console.log('\n⚠️ 限制:窗口就是 data/ 有的那幾年(偏多頭)・倖存者偏誤・未計滑價。');
}

function selftest() {
    let bad = 0;
    const ok = (n, c) => { console.log(`${c ? '✅' : '❌'} ${n}`); if (!c) bad++; };
    // 分桶邏輯:gap = (ma - c)/ma*100
    const bucket = gap => gap <= 0 ? 0 : (gap <= 3 ? 1 : (gap <= 8 ? 2 : 3));
    ok('① 已站上月線 → 桶 0', bucket(-1.2) === 0 && bucket(0) === 0);
    ok('② 月線下 1.2%(富喬那種)→ 桶 1', bucket(1.2) === 1);
    ok('③ 邊界 3.0 算桶 1、3.01 算桶 2', bucket(3) === 1 && bucket(3.01) === 2);
    ok('④ 月線下 12% → 桶 3', bucket(12) === 3);
    // 去重
    let last = null, cnt = 0;
    for (const i of [10, 15, 31, 33, 60]) { if (last != null && i - last < 20) continue; last = i; cnt++; }
    ok('⑤ 20 日去重:10/15/31/33/60 → 只算 3 筆', cnt === 3);
    console.log(bad ? `\n❌ ${bad} 條失敗` : '\n✅ SELFTEST_PASS');
    process.exit(bad ? 1 : 0);
}

if (process.argv.includes('--selftest')) selftest(); else main();
