#!/usr/bin/env node
/**
 * 📐 V79.9.0 量化實驗室核心 `scripts/lib_quant.mjs` 跨檔守門
 *   ① lib 自己的 selftest(前視 / 去重 / 交叉 / 營收公布日 / 打錯字 throw)
 *   ② 指標 == index.html masterWorker(真的把那段 worker 程式拿來跑):ma20 / ma60 / k / d / rsi5 / rsi10 / ema20 逐根相同
 *   ③ 出場 `chand{K}`(lib_exitsim)== index.html `_exitLevelAt(…, 'atr2')`(進場那天的 ATR):每一天的出場線逐日相同、
 *      而且跟「每天重算 ATR」的 `atr2`(動態版)不一樣(決定性對照)
 *   ④ pro.html / index.html 的 QCORE 區塊跟 lib 那段逐字相同(⛔ 抄一半)
 *   注入:INJECT=kd(lib 的 KD 起始值改 0)/ INJECT=look(hhc 含今天)/ INJECT=chand(chand 改用當天 ATR)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { execFileSync } from 'child_process';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INJ = process.env.INJECT || '';
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };
// 注入:複製一份改過的 lib 到暫存檔再 import
const libSrc0 = fs.readFileSync(path.join(ROOT, 'scripts/lib_quant.mjs'), 'utf8'), exSrc0 = fs.readFileSync(path.join(ROOT, 'scripts/lib_exitsim.mjs'), 'utf8');
let libSrc = libSrc0, exSrc = exSrc0;
if (INJ === 'kd') libSrc = libSrc.replace('let pk = 50, pd = 50;', 'let pk = 0, pd = 0;');
if (INJ === 'look') libSrc = libSrc.replace('for (let j = i - p; j < i; j++) x = f === ', 'for (let j = i - p + 1; j <= i; j++) x = f === ');
if (INJ === 'chand') exSrc = exSrc.replace('const atE = atrAt(eIdx);', 'const atE = atrAt(Math.max(eIdx, 1));').replace("hit = atE > 0 && c <= peak - P.k * atE;", "{ const at2 = atrAt(j); hit = at2 > 0 && c <= peak - P.k * at2; }");
if (INJ && libSrc === libSrc0 && exSrc === exSrc0) { console.log('❌ 注入沒有注進去'); process.exit(1); }
const TMPD = path.join(ROOT, 'scripts');
const tmpLib = path.join(TMPD, '.tq_lib_quant.mjs'), tmpEx = path.join(TMPD, '.tq_lib_exitsim.mjs');
fs.writeFileSync(tmpLib, libSrc); fs.writeFileSync(tmpEx, exSrc);
try {
    const Q = (await import(pathToFileURL(tmpLib).href)).default;
    const { simExits } = await import(pathToFileURL(tmpEx).href);
    // ① selftest(子程序跑正本;注入時跑改過的那份)
    let selfOk = true; try { execFileSync('node', [tmpLib, '--selftest'], { stdio: 'pipe' }); } catch (_) { selfOk = false; }
    ok('① lib_quant --selftest', selfOk);
    // 合成 K 線(固定種子)
    const days = n => { const D = []; let t = Date.UTC(2021, 0, 4); while (D.length < n) { const d = new Date(t); if (d.getUTCDay() % 6) D.push(d.toISOString().slice(0, 10)); t += 864e5; } return D; };
    const D = days(400); let seed = 9; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    let c = 80; const bars = D.map(d => { const p = c; c = +(p * (1 + (rnd() - 0.49) * 0.05)).toFixed(2); const hi = +(Math.max(p, c) * (1 + rnd() * 0.02)).toFixed(2), lo = +(Math.min(p, c) * (1 - rnd() * 0.02)).toFixed(2); return { date: d, open: p, high: hi, low: lo, close: c, volume: Math.round(5e5 + rnd() * 5e6) }; });
    // ② masterWorker 真的跑一次
    const idx = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const a0 = idx.indexOf('const masterWorkerCode = `'), a1 = idx.indexOf('`;', a0);
    let W = null;
    if (a0 > 0 && a1 > a0) {
        const code = idx.slice(a0 + 'const masterWorkerCode = `'.length, a1);
        const self = { postMessage: x => { W = x; } };
        new Function('self', code)(self);
        self.onmessage({ data: { activeData: bars, marketCtx: {} } });
    }
    ok('② 抽得到 masterWorker 而且跑得出指標', W && Array.isArray(W.k) && W.k.length === bars.length, W ? Object.keys(W).slice(0, 8).join(',') : 'null');
    if (W) {
        const S = Q.series(bars), same = (a, b) => a.every((x, i) => (x == null && b[i] == null) || Math.abs(x - b[i]) < 1e-9);
        const cmp = { ma20: [{ f: 'ma', n: 20 }, W.ma20], ma60: [{ f: 'ma', n: 60 }, W.ma60], k: [{ f: 'k' }, W.k], d: [{ f: 'd' }, W.d], rsi5: [{ f: 'rsi', n: 5 }, W.rsi5], rsi10: [{ f: 'rsi', n: 10 }, W.rsi10], ema20: [{ f: 'ema', n: 20 }, W.ema20] };
        const bad = Object.entries(cmp).filter(([, [op, w]]) => !Array.isArray(w) || !same(S.get(op), w)).map(([k]) => k);
        ok('② ma20 / ma60 / K / D / RSI5 / RSI10 / EMA20 跟 App 逐根相同', !bad.length, bad.join(','));
        // ⚡ V80.1.2 MACD 改成 26 日 EMA 只算一次:跟「每一根重算整條」的舊寫法逐根相同(⛔ 只能快、不能變)
        const cl = bars.map(r => r.close), em = (a, p) => { const kf = 2 / (p + 1), r = [a[0]]; for (let i = 1; i < a.length; i++) r.push(a[i] * kf + r[i - 1] * (1 - kf)); return r; };
        const dif0 = em(cl, 12).map((v, i) => v - em(cl, 26)[i]), mac0 = em(dif0, 9), osc0 = dif0.map((v, i) => (v - mac0[i]) * 2);
        ok('② ⚡ MACD(dif / macd / osc)== 舊的逐根重算寫法(逐根相同)', ['dif', 'macd', 'osc'].every(k => Array.isArray(W[k]) && same(W[k], { dif: dif0, macd: mac0, osc: osc0 }[k])));
        ok('② ⚡ 原始碼 ⛔ 不可再在 map 裡重算 ema(closes, 26)', !/ema\(closes, 26\)\[i\]/.test(idx));
    }
    // ③ chand2 == App _exitLevelAt(atr2):把 App 那兩支抽出來跑
    const grab = name => { const m = new RegExp(`\\n    ${name}\\(`).exec(idx); const s = idx.indexOf('{', m.index); let d = 0, i = s; for (; i < idx.length; i++) { if (idx[i] === '{') d++; else if (idx[i] === '}' && --d === 0) break; } return idx.slice(m.index + 5, i + 1); };
    const A = (0, eval)('({' + grab('_atrTR14') + ',' + grab('_exitLevelAt') + '})');
    const R = bars.map(r => ({ o: r.open, h: r.high, l: r.low, c: r.close }));
    let mism = [], cnt = 0, diffDyn = 0;
    for (const e of [40, 90, 150, 220, 300]) {
        // App 的出場線:每一天 peak − 2 × 進場那天的 ATR;回測:第一天收盤 ≤ 那條線就出場
        let appOut = null;
        for (let j = e + 1; j <= Math.min(R.length - 1, e + 20); j++) { const lv = A._exitLevelAt(bars, e, j, 'atr2'); if (lv != null && bars[j].close <= lv) { appOut = j; break; } }
        const r = simExits(R, e, { rules: ['chand2', 'atr2'], maxD: 20, holdStop: 99 });
        const mine = r.chand2.why === '規則' ? r.chand2.outIdx : null;
        if (mine !== appOut) mism.push(`${e}:${mine}/${appOut}`); else cnt++;
        if (r.chand2.outIdx !== r.atr2.outIdx) diffDyn++;
    }
    ok('③ chand2 出場日 == App 出場線(進場那天的 ATR)', !mism.length && cnt === 5, mism.join(' '));
    ok('③ 有鑑別力:chand2(進場那天 ATR)跟 atr2(每天重算)至少有一筆出場日不同', diffDyn >= 1, diffDyn);
    // ④ pro.html 的 QCORE 區塊(有的話)逐字相同
    const pro = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');
    const blk = s => { const i = s.indexOf('// ==QCORE BEGIN=='), j = s.indexOf('// ==QCORE END=='); return i >= 0 && j > i ? s.slice(i, j) : null; };
    const pb = blk(pro), ib = blk(idx);
    ok('④ pro.html 的 QCORE 區塊 == lib_quant(逐字)', pb != null && pb === blk(libSrc0), pb == null ? 'pro.html 沒有 QCORE' : 'pro 跟 lib 不一樣 → 跑 embed_quant_lab.mjs');
    ok('④ index.html 的 QCORE 區塊 == lib_quant(逐字;散戶 App 追高買點用)', ib != null && ib === blk(libSrc0), ib == null ? 'index.html 沒有 QCORE' : 'index 跟 lib 不一樣 → 跑 embed_quant_lab.mjs --core');
    // 🧪 V79.9.0 沙盒的出場 = lib_exitsim 的 EXSIM 區塊(⛔ 第二份出場公式)
    const xb = s => { const i = s.indexOf('// ==EXSIM BEGIN=='), j = s.indexOf('// ==EXSIM END=='); return i >= 0 && j > i ? s.slice(i, j) : null; };
    ok('④ pro.html 的 EXSIM 區塊 == lib_exitsim(逐字;沙盒的出場)', xb(pro) != null && xb(pro) === xb(exSrc0), xb(pro) == null ? 'pro.html 沒有 EXSIM' : 'pro 跟 lib 不一樣 → 跑 embed_quant_lab.mjs');
    { const EX = (0, eval)(xb(exSrc0) + '\nEXSIM'), r1 = EX.simExits(R, 90, { rules: ['chand2', 'ma5'], maxD: 20, holdStop: 5 }), r2 = simExits(R, 90, { rules: ['chand2', 'ma5'], maxD: 20, holdStop: 5 });
      ok('④ EXSIM 區塊單獨拿出來跑(瀏覽器那樣)== 模組匯出的 simExits', JSON.stringify(r1) === JSON.stringify(r2), JSON.stringify([r1, r2]).slice(0, 200)); }
} finally { try { fs.unlinkSync(tmpLib); fs.unlinkSync(tmpEx); } catch (_) {} }
if (fails.length) { console.log(`❌ QCORE_FAIL(${fails.length})`); process.exit(1); }
console.log('✅ QCORE_TEST_PASS');
