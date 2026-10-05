#!/usr/bin/env node
/**
 * 🌅 V78.5.3 開盤跳空分布的「一般股票」基準(總覽「明天開盤怎麼做」那張卡的對照數字)
 *
 * ⛔ 描述型,不是預測、不是訊號:只回答「上市櫃個股過去一年,開盤落在昨收的哪一段」。
 *   - 每一檔取最後 250 根**已收盤**的 K(最後一根若是今天盤中列也算進來 —— 開盤價那時就已經確定)
 *   - 跳空 = 開盤 ÷ 前一根收盤 − 1;|跳空| > 11% 剔除(上市櫃單日 ±10%,超過就是分割 / 資料洞,陷阱 #21)
 *   - 開盤就鎖漲停 = 開盤 ≥ 前一根收盤×1.1 對到跳動單位(無條件捨去)—— 跟 index.html `_floorTick` 同一條
 *   - 母體:stock_names.json 標 twse / tpex 的 4 碼個股(⛔ ETF、⛔ 興櫃 —— 興櫃沒有漲跌幅限制)
 * 產物:0.1% 一格的直方圖(−11%~+11%)+ 開盤鎖漲停 / 跌停次數 → `embed_gap_base.mjs` 嵌進 index.html `_GAP_BASE`
 *
 * 用法:DATA_DIR=<data 目錄> node scripts/gap_base.mjs out.json
 *       node scripts/gap_base.mjs --selftest
 */
import fs from 'fs';
import path from 'path';

export const BIN = 0.1, LO = -11, NB = 220;          // 220 格 × 0.1% = −11% ~ +11%
export const tickOf = p => { const v = +p || 0; return v < 10 ? 0.01 : v < 50 ? 0.05 : v < 100 ? 0.1 : v < 500 ? 0.5 : v < 1000 ? 1 : 5; };
export const floorTick = p => { const t = tickOf(p); return +(Math.floor(p / t + 1e-9) * t).toFixed(2); };
export const ceilTick = p => { const t = tickOf(p); return +(Math.ceil(p / t - 1e-9) * t).toFixed(2); };

/** 一檔 K 線 → 最後 `win` 根的跳空清單 [{g(%), lu, ld}](⛔ 前視:每一根只用自己和前一根) */
export function gapRows(bars, win = 250) {
    if (!Array.isArray(bars) || bars.length < 2) return [];
    const out = [];
    const from = Math.max(1, bars.length - win);
    for (let i = from; i < bars.length; i++) {
        const p = +bars[i - 1].close, o = +bars[i].open;
        if (!(p > 0 && o > 0)) continue;
        const g = (o / p - 1) * 100;
        if (Math.abs(g) > 11) continue;
        out.push({ g, lu: o >= floorTick(p * 1.1) - 1e-9, ld: o <= ceilTick(p * 0.9) + 1e-9 });
    }
    return out;
}

export function histOf(rows) {
    const bins = new Array(NB).fill(0);
    let lu = 0, ld = 0;
    for (const r of rows) {
        const k = Math.min(NB - 1, Math.max(0, Math.floor((r.g - LO) / BIN + 1e-9)));
        bins[k]++;
        if (r.lu) lu++;
        if (r.ld) ld++;
    }
    return { bins, lu, ld, n: rows.length };
}

function selftest() {
    const fails = [];
    const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + e}`); if (!c) fails.push(n); };
    // ① 已知分布:前收 100、開盤 102 / 100 / 97 / 110(漲停)/ 130(剔除)
    const mk = opens => { const b = [{ close: 100, open: 100 }]; for (const o of opens) b.push({ open: o, close: 100 }); return b; };
    const R = gapRows(mk([102, 100, 97, 110, 130]));
    ok('① 剔除 |跳空| > 11%', R.length === 4, JSON.stringify(R));
    ok('② 漲停開盤旗標(110 = 100×1.1)', R[3].lu === true && R.slice(0, 3).every(r => !r.lu), JSON.stringify(R));
    const H = histOf(R);
    ok('③ 直方圖總數 = 筆數、+2% 落在正確那格', H.n === 4 && H.bins.reduce((a, b) => a + b, 0) === 4 && H.bins[Math.floor((2 - LO) / BIN + 1e-9)] === 1, JSON.stringify(H.bins.map((v, i) => v ? i : null).filter(x => x != null)));
    ok('④ 漲停開盤計數', H.lu === 1 && H.ld === 0, JSON.stringify([H.lu, H.ld]));
    // ⑤ 前視:最後一根改開盤,前面的跳空不變
    const b = mk([102, 100, 97]); const a1 = gapRows(b).slice(0, 2); b[3].open = 50; const a2 = gapRows(b).slice(0, 2);
    ok('⑤ 每一根只用自己和前一根(改最後一根不影響前面)', JSON.stringify(a1) === JSON.stringify(a2));
    // ⑥ 窗口:只取最後 win 根
    ok('⑥ win=2 只取最後 2 根', gapRows(mk([101, 102, 103]), 2).length === 2);
    // ⑦ 跌停開盤(高價股:前收 1000 → 跌停 900)
    ok('⑦ 跌停開盤旗標', gapRows([{ close: 1000, open: 1000 }, { open: 900, close: 900 }])[0].ld === true);
    console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ SELFTEST_PASS');
    process.exit(fails.length ? 1 : 0);
}

async function main() {
    if (process.argv.includes('--selftest')) return selftest();
    const DIR = process.env.DATA_DIR || 'data';
    const out = process.argv[2] || 'gap_base.json';
    let names = null;
    try { names = JSON.parse(fs.readFileSync(path.join(DIR, 'stock_names.json'), 'utf8')).names; } catch (_) {}
    if (!names) { console.error('❌ 讀不到 stock_names.json(要靠它挑出上市櫃個股)'); process.exit(1); }
    const all = [];
    let syms = 0, last = '';
    const d0s = [];
    for (const f of fs.readdirSync(DIR)) {
        const m = f.match(/^(\d{4})\.json$/); if (!m || m[1].startsWith('0')) continue;
        const v = names[m[1]]; const mkt = Array.isArray(v) ? String(v[2] || '') : '';
        if (mkt !== 'twse' && mkt !== 'tpex') continue;
        let bars; try { bars = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch (_) { continue; }
        if (!Array.isArray(bars) || bars.length < 121) continue;
        const R = gapRows(bars);
        if (R.length < 120) continue;
        syms++; for (const r of R) all.push(r);
        const d1 = String(bars[bars.length - 1].date || '').replace(/\//g, '-'), d0 = String(bars[Math.max(1, bars.length - 250)].date || '').replace(/\//g, '-');
        if (d1 > last) last = d1; d0s.push(d0);
    }
    if (syms < 1000) { console.error(`❌ 只有 ${syms} 檔,樣本不夠(要 ≥1000 檔)—— 不寫檔`); process.exit(1); }
    const H = histOf(all);
    d0s.sort(); const first = d0s[Math.floor(d0s.length / 2)] || '';   // 中位起點(少數停牌股的起點會比較早,⛔ 不拿最早那一個)
    const res = { src: 'scripts/gap_base.mjs(V78.5.3)', from: first, to: last, syms, n: H.n, bin: BIN, lo: LO, bins: H.bins, lu: H.lu, ld: H.ld };
    fs.writeFileSync(out, JSON.stringify(res));
    const sh = (a, b) => H.bins.reduce((s, c, k) => { const x = LO + k * BIN; return s + (x >= a && x < b ? c : 0); }, 0) / H.n * 100;
    console.log(`✅ ${syms} 檔・${H.n.toLocaleString()} 次開盤・${first}~${last}`);
    console.log(`   開高 ≥1% ${sh(1, 12).toFixed(1)}% ・平 ±1% ${sh(-1, 1).toFixed(1)}% ・開低 ≥1% ${sh(-12, -1).toFixed(1)}% ・開盤鎖漲停 ${(H.lu / H.n * 100).toFixed(2)}% ・鎖跌停 ${(H.ld / H.n * 100).toFixed(2)}%`);
}
import { fileURLToPath } from 'url';
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();   // ⛔ 被 import 時不跑(gap_after_probe 共用 tick)
