#!/usr/bin/env node
/**
 * 📐→💰 V79.9.1 量化實驗室某一支 / 某一組(兩兩一起成立)的**中心條件** → 整套資金回測的外部候選檔
 *   (portfolio_backtest PSRC=ext:<檔> + GATE=ext:訊號日收盤後才知道 → 隔天收盤買)
 *   ⭐ 條件一律從 qlab_strategies.json + quant_lab_build 的 expand / pairVars 來(⛔ 第二份);訊號 = QCORE.signals(同一檔 gap 天內只算第一次)
 *   排序分一律 1(⛔ 自己編排名 —— 引擎同分照 20 日均額排 = 成交額大的先買)
 *
 * 用法:DATA_DIR=<d16m_fi> REV_DIR=<stock_deep/rev> node scripts/qlab_ext.mjs ma_bull+rev_hi out.json
 *       node scripts/qlab_ext.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import QCORE from './lib_quant.mjs';
import { expand, pairVars, loadRev } from './quant_lab_build.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iso = x => String(x || '').replace(/\//g, '-').slice(0, 10);

/** id(單支 kd_gold 或兩兩 ma_bull+rev_hi)→ 中心條件 */
export function centerSt(S, id) {
    const [a, b] = id.split('+'), A = S.families.find(f => f.id === a), B = b ? S.families.find(f => f.id === b) : null;
    if (!A || (b && !B)) throw new Error(`認不得 ${id}`);
    return (B ? pairVars(A, B) : expand(A)).find(v => v.center).st;
}
/** 一檔的訊號日 → {日期: [1, 20 日均額]}(均額只用到那一天) */
export function extOf(st, bars, ctx) {
    const sig = QCORE.signals(st, bars, null, QCORE.series(bars, ctx)), out = {};
    for (const i of sig) {
        if (i < 20) continue;
        let s = 0; for (let j = i - 19; j <= i; j++) s += (+bars[j].close) * (+bars[j].volume || 0);
        out[iso(bars[i].date)] = [1, Math.round(s / 20)];
    }
    return out;
}

function selftest() {
    let bad = 0; const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + e}`); if (!c) bad++; };
    const S = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/qlab_strategies.json'), 'utf8'));
    const st = centerSt(S, 'gap_up+kd_gold'), s1 = centerSt(S, 'gap_up');
    ok('① 兩兩的中心條件 = 兩支中心條件接在一起', st.all.length === s1.all.length + centerSt(S, 'kd_gold').all.length);
    let threw = false; try { centerSt(S, 'nope'); } catch (_) { threw = true; } ok('① 認不得的 id → 丟錯(⛔ 默默變成空清單)', threw);
    const D = []; let t = Date.UTC(2015, 0, 5); while (D.length < 200) { const d = new Date(t); if (d.getUTCDay() % 6) D.push(d.toISOString().slice(0, 10)); t += 864e5; }
    let c = 50; const bars = D.map((d, i) => { const p = c; const op = i === 100 ? p * 1.04 : p; c = i === 100 ? op * 1.01 : p * (1 + ((i % 5) - 2) * 0.002); return { date: d.replace(/-/g, '/'), open: op, high: Math.max(op, c), low: Math.min(op, c), close: c, volume: 1000 }; });
    const ex = extOf(s1, bars, { idx: new Map(), rev: [] });
    ok('② 跳空 4% 收紅那天(第 100 根)是訊號日、排序分 1、均額 = 前 20 天平均(只用到那天)', Object.keys(ex).length === 1 && ex[D[100]] && ex[D[100]][0] === 1 && Math.abs(ex[D[100]][1] - bars.slice(81, 101).reduce((a, r) => a + r.close * r.volume, 0) / 20) <= 1, JSON.stringify(ex));
    console.log(bad ? `❌ ${bad} 條失敗` : '✅ QLAB_EXT_SELFTEST_PASS'); process.exit(bad ? 1 : 0);
}

async function main() {
    const [id, out] = process.argv.slice(2), DIR = process.env.DATA_DIR, REV = process.env.REV_DIR || '';
    if (!id || !out || !DIR) { console.error('用法:DATA_DIR=… REV_DIR=… node scripts/qlab_ext.mjs <id> out.json'); process.exit(1); }
    const S = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/qlab_strategies.json'), 'utf8')), st = QCORE.check(centerSt(S, id));
    if (QCORE.needs(st).includes('rev') && !REV) { console.error('🚨 用到月營收,要 REV_DIR'); process.exit(1); }
    const load = s => { try { const j = JSON.parse(fs.readFileSync(path.join(DIR, s + '.json'), 'utf8')); return Array.isArray(j) ? j.filter(r => r && r.date && +r.close > 0) : null; } catch (_) { return null; } };
    const tw = load('^TWII'), idx = new Map((tw || []).map(r => [iso(r.date), +r.close]));
    const M = {}; let n = 0;
    for (const s of fs.readdirSync(DIR).filter(f => /^[1-9]\d{3}\.json$/.test(f)).map(f => f.slice(0, -5))) {
        const b = load(s); if (!b || b.length < 120) continue;
        const e = extOf(st, b, { idx, rev: (REV ? loadRev(REV, s) : null) || [] }), k = Object.keys(e).length;
        if (k) { M[s] = e; n += k; }
    }
    if (!n) { console.error('🚨 一個訊號都沒有 → ⛔ 不寫'); process.exit(1); }
    fs.writeFileSync(out, JSON.stringify(M));
    console.log(`💾 ${id}:${Object.keys(M).length} 檔 ・${n.toLocaleString()} 個訊號日 → ${out}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) { if (process.argv.includes('--selftest')) selftest(); else main(); }
