#!/usr/bin/env node
/**
 * 📦 V82.1.2 研究資料包 —— 一個指令組出 16 年回測資料夾 d16 + MANIFEST(SELF_EVOLVING_AUDIT G1)
 *
 * 為什麼:d16 以前是每個工作階段手動組的、沒有版本 → 2026-11-11 第一次跑星期幾探針,d16 少了 `_bench0050.json` /
 *   `_div0050.json`,16 年的「贏 0050」整欄是空的(印出 NaN 才發現)。同一個問題換一個工作階段也可能用到不同版本的資料。
 *
 * 做法(⛔ 不另寫合併邏輯,全部呼叫既有那幾支):
 *   ① 從 origin 的 data / klines_deep / stock_deep 分支取出(記 commit;可用 DATA_REF / KD_REF / SD_REF 釘版本)
 *   ② dd = data 分支的 data/*.json + `merge_deep_klines.mjs`(2021 起深歷史)
 *   ③ base = 加權 / 櫃買 / 0050 / 產業表 / 股名 + `merge_k66_history.py --idx-long-only`(加權 2010 起、`_bench0050`、`_div0050`)
 *   ④ `merge_stock_deep.py`(2010~2021 全市場含下市、股利 `_div16.json`)→ <OUT>/d16
 *   ⑤ `checkPack`:缺件 / 0050 含息起點晚於 2010-12 / 加權不到 4,000 天 / 個股不到 2,000 檔 → exit 1(⛔ 壞的包不寫 MANIFEST)
 *   ⑥ MANIFEST.json:來源 commit、這支程式的 commit、每個關鍵檔筆數與起訖、每一檔 sha256、整包雜湊
 *
 *   ⑦ 🇹🇼 TW04=1(V82.1.2 B9):再從 tw_deep04 分支取 2004~2009(上市全市場日 K + 除權息 + 加權),`tw04_merge.py` 接成 <OUT>/d04
 *      (d16 一個位元組都不動;d04 另寫一份 MANIFEST,記 tw_deep04 的 commit 與抓到幾個月)。月份或加權沒抓齊 → exit 1。
 * 跑法:node scripts/research_pack.mjs <OUT 資料夾>(約 10 分;會用到 <OUT>/src 與 <OUT>/work,做完刪掉,KEEP_SRC=1 留著)
 *       node scripts/research_pack.mjs --check <d16 資料夾>     → 只驗、印雜湊
 *       node scripts/research_pack.mjs --selftest
 * 用法:探針一律 `DATA_DIR=<OUT>/d16 DIV=<OUT>/d16/_div16.json`;實驗登錄記 MANIFEST 的 `hash`。
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync, execSync } from 'child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const isStock = n => /^\d{4,6}[A-Z]?$/.test(n);
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const readRows = f => { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(j) ? j : (j.data || []); };
const nd = d => String(d || '').replace(/\//g, '-').slice(0, 10);

/** 驗一個 d16 資料夾 → 問題清單(空 = 合格)+ 關鍵檔摘要 */
export function checkPack(dir) {
    const bad = [], key = {};
    const need = ['^TWII.json', '_bench0050.json', '_div0050.json', '_div16.json', 'industry_map.json', '0050.json'];
    for (const f of need) if (!fs.existsSync(path.join(dir, f))) bad.push(`缺 ${f}`);
    const rowsOf = f => { try { return readRows(path.join(dir, f)); } catch (_) { return null; } };
    for (const f of ['^TWII.json', '_bench0050.json', '0050.json']) {
        const R = fs.existsSync(path.join(dir, f)) ? rowsOf(f) : null;
        if (R) key[f] = { rows: R.length, from: nd(R[0] && R[0].date), to: nd(R.at(-1) && R.at(-1).date) };
    }
    if (key['^TWII.json'] && (key['^TWII.json'].rows < 4000 || key['^TWII.json'].from > '2010-01-31')) bad.push(`^TWII 只有 ${key['^TWII.json'].rows} 天、從 ${key['^TWII.json'].from}(要 2010-01 起 ≥ 4,000 天)`);
    if (key['_bench0050.json'] && key['_bench0050.json'].from > '2010-12-31') bad.push(`0050 含息對照從 ${key['_bench0050.json'].from} 才開始(16 年的「贏 0050」會是空的)`);
    if (fs.existsSync(path.join(dir, '_div0050.json'))) {
        try { const j = JSON.parse(fs.readFileSync(path.join(dir, '_div0050.json'), 'utf8')); const h = ((j.d || {})['0050'] || {}).h || []; key['_div0050.json'] = { events: h.length, from: h[0] && h[0][0] }; if (h.length < 20) bad.push(`0050 除息只有 ${h.length} 次`); } catch (e) { bad.push('_div0050.json 讀不出來'); }
    }
    const stocks = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json') && isStock(f.slice(0, -5))) : [];
    key.stocks = stocks.length;
    if (stocks.length < 2000) bad.push(`個股只有 ${stocks.length} 檔(要 ≥ 2,000)`);
    return { bad, key };
}

/** 整包雜湊:每一檔 sha256(排序後)再雜湊一次 → 同一份資料兩次組出來一樣 */
export function packHash(dir) {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'MANIFEST.json').sort();
    const per = {}; for (const f of files) per[f] = sha(fs.readFileSync(path.join(dir, f)));
    return { hash: sha(files.map(f => `${f}:${per[f]}`).join('\n')).slice(0, 16), per };
}

const sh = (cmd, opt = {}) => execSync(cmd, { stdio: ['ignore', 'inherit', 'inherit'], cwd: ROOT, maxBuffer: 1 << 28, ...opt });
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();

function build(OUT) {
    const t0 = Date.now(), src = path.join(OUT, 'src'), work = path.join(OUT, 'work'), d16 = path.join(OUT, 'd16');
    for (const d of [src, work, d16]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }
    const refs = {};
    for (const [b, env] of [['data', 'DATA_REF'], ['klines_deep', 'KD_REF'], ['stock_deep', 'SD_REF']]) {
        if (process.env[env]) { git('fetch', '-q', 'origin', process.env[env]); refs[b] = git('rev-parse', process.env[env]); }
        else { git('fetch', '-q', '--depth=1', 'origin', `+refs/heads/${b}:refs/remotes/origin/${b}`); refs[b] = git('rev-parse', `origin/${b}`); }
    }
    console.log(`📥 來源:data ${refs.data.slice(0, 10)}・klines_deep ${refs.klines_deep.slice(0, 10)}・stock_deep ${refs.stock_deep.slice(0, 10)}`);
    sh(`git archive ${refs.data} data | tar -x -C "${src}"`);
    sh(`git archive ${refs.klines_deep} | tar -x -C "${src}"`);
    sh(`git archive ${refs.stock_deep} | tar -x -C "${src}"`);
    const od = path.join(src, 'data'), kd = path.join(src, 'klines_deep'), sd = path.join(src, 'stock_deep');
    for (const [n, p] of [['data', od], ['klines_deep', kd], ['stock_deep', sd]]) if (!fs.existsSync(p)) throw new Error(`取出 ${n} 之後找不到 ${p}`);
    if (!fs.existsSync(path.join(od, 'idx_long.json'))) throw new Error('data 分支沒有 idx_long.json(加權 / 0050 長歷史)');
    // ② dd = data/*.json + 深歷史
    const dd = path.join(work, 'dd'); fs.mkdirSync(dd);
    for (const f of fs.readdirSync(od)) if (f.endsWith('.json')) fs.copyFileSync(path.join(od, f), path.join(dd, f));
    sh(`node scripts/merge_deep_klines.mjs "${kd}" "${dd}"`);
    // ③ base = 非個股檔 + 長歷史加權 / 0050
    const base = path.join(work, 'base'); fs.mkdirSync(base);
    for (const f of ['0050.json', '^TWII.json', '^TWOII.json', 'industry_map.json', 'stock_names.json']) if (fs.existsSync(path.join(od, f))) fs.copyFileSync(path.join(od, f), path.join(base, f));
    sh(`python3 scripts/merge_k66_history.py --idx-long-only "${base}" "${base}" --idx-long "${path.join(od, 'idx_long.json')}"`);
    // ④ 16 年
    sh(`python3 scripts/merge_stock_deep.py --dd "${dd}" --kd "${kd}" --sd "${sd}" --base "${base}" --out "${d16}" --div-in "${path.join(od, 'dividends_hist.json')}" --div-out "${path.join(d16, '_div16.json')}"`);
    // ⑤ 驗
    const C = checkPack(d16);
    if (C.bad.length) { console.error('🚨 資料包不合格(⛔ 不寫 MANIFEST):\n  ' + C.bad.join('\n  ')); process.exit(1); }
    // ⑥ MANIFEST
    const H = packHash(d16);
    const M = { built: new Date().toISOString(), hash: H.hash, refs, idx_long_sha: sha(fs.readFileSync(path.join(od, 'idx_long.json'))).slice(0, 16),
        code: git('rev-parse', 'HEAD'), key: C.key, files: Object.keys(H.per).length, per: H.per };
    fs.writeFileSync(path.join(d16, 'MANIFEST.json'), JSON.stringify(M, null, 1));
    if (process.env.TW04 === '1') {
        git('fetch', '-q', '--depth=1', 'origin', '+refs/heads/tw_deep04:refs/remotes/origin/tw_deep04');
        const twRef = git('rev-parse', 'origin/tw_deep04');
        sh(`git archive ${twRef} | tar -x -C "${src}"`);
        const tw = path.join(src, 'tw_deep04'), stt = JSON.parse(fs.readFileSync(path.join(tw, '_status.json'), 'utf8'));
        if (!(stt.months_complete === stt.months_total && stt.idx_months === stt.months_total))
            throw new Error(`tw_deep04 還沒抓齊:日 K ${stt.months_complete}/${stt.months_total} 個月、加權 ${stt.idx_months ?? 0}/${stt.months_total} 個月`);
        const d04 = path.join(OUT, 'd04');
        sh(`python3 scripts/tw04_merge.py --tw "${tw}" --d16 "${d16}" --sd "${sd}" --out "${d04}"`);
        const C4 = checkPack(d04);
        if (C4.bad.length) { console.error('🚨 d04 不合格(⛔ 不寫 MANIFEST):\n  ' + C4.bad.join('\n  ')); process.exit(1); }
        const H4 = packHash(d04);
        fs.writeFileSync(path.join(d04, 'MANIFEST.json'), JSON.stringify({ ...M, hash: H4.hash, refs: { ...refs, tw_deep04: twRef }, from_d16: H.hash,
            tw04: { months: stt.months_complete, idx_months: stt.idx_months, days: stt.days_with_data, updated: stt.updated }, key: C4.key, files: Object.keys(H4.per).length, per: H4.per }, null, 1));
        console.log(`✅ d04(2004 起)${d04}:加權 ${C4.key['^TWII.json'].from}~${C4.key['^TWII.json'].to}・0050 含息 ${C4.key['_bench0050.json'].from} 起・雜湊 ${H4.hash}`);
    }
    if (!process.env.KEEP_SRC) { fs.rmSync(src, { recursive: true, force: true }); fs.rmSync(work, { recursive: true, force: true }); }
    console.log(`✅ 研究資料包 ${d16}:${C.key.stocks} 檔・加權 ${C.key['^TWII.json'].from}~${C.key['^TWII.json'].to}・0050 含息 ${C.key['_bench0050.json'].from} 起・雜湊 ${H.hash}・${((Date.now() - t0) / 60000).toFixed(1)} 分`);
}

function selftest() {
    let ok = 0, bad = 0; const t = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); c ? ok++ : bad++; };
    const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'rpack-'));
    try {
        const days = []; for (let d = Date.UTC(2010, 0, 4); days.length < 4100; d += 86400000) { const w = new Date(d).getUTCDay(); if (w && w < 6) days.push(new Date(d).toISOString().slice(0, 10)); }
        const bars = n => days.slice(0, n).map((d, i) => ({ date: d.replace(/-/g, '/'), open: 10 + i * 0.01, high: 10, low: 10, close: 10 + i * 0.01, volume: 1 }));
        const mk = dir => {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, '^TWII.json'), JSON.stringify(bars(4100)));
            fs.writeFileSync(path.join(dir, '_bench0050.json'), JSON.stringify(bars(4100)));
            fs.writeFileSync(path.join(dir, '0050.json'), JSON.stringify(bars(800)));
            fs.writeFileSync(path.join(dir, '_div0050.json'), JSON.stringify({ d: { '0050': { h: Array.from({ length: 25 }, (_, i) => [`${2010 + i % 16}-10-2${i % 9}`, 1, '息', 50, 49]) } } }));
            fs.writeFileSync(path.join(dir, '_div16.json'), '{}'); fs.writeFileSync(path.join(dir, 'industry_map.json'), '{}');
            for (let s = 0; s < 2001; s++) fs.writeFileSync(path.join(dir, `${1000 + s}.json`), '[]');
        };
        const A = path.join(tmp, 'a'); mk(A);
        const c0 = checkPack(A);
        t(c0.bad.length === 0 && c0.key.stocks === 2002, `① 齊全的包合格(${c0.key.stocks} 檔、加權 ${c0.key['^TWII.json'].rows} 天)`);
        const h1 = packHash(A).hash, h2 = packHash(A).hash;
        fs.writeFileSync(path.join(A, '1000.json'), '[ ]'); const h3 = packHash(A).hash;
        t(h1 === h2 && h1 !== h3, `② 同一份兩次雜湊一樣(${h1}),改一個位元組就不一樣`);
        fs.rmSync(path.join(A, '_bench0050.json'));
        t(checkPack(A).bad.some(x => /_bench0050/.test(x)), `③ 拿掉 0050 含息對照 → 不合格(${checkPack(A).bad[0]})`);
        const B = path.join(tmp, 'b'); mk(B); fs.writeFileSync(path.join(B, '_bench0050.json'), JSON.stringify(bars(4100).slice(3300)));
        t(checkPack(B).bad.some(x => /0050 含息對照從/.test(x)), `④ 0050 含息從 2023 才開始(今天那個坑)→ 不合格`);
        const C2 = path.join(tmp, 'c'); mk(C2); fs.writeFileSync(path.join(C2, '^TWII.json'), JSON.stringify(bars(1200)));
        t(checkPack(C2).bad.some(x => /\^TWII/.test(x)), `⑤ 加權只有 1,200 天 → 不合格`);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    console.log(`\n${bad ? '❌' : '✅'} selftest ${ok}/${ok + bad}`);
    return bad ? 1 : 0;
}

const _isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (_isMain) {
    const [a, b] = process.argv.slice(2);
    if (a === '--selftest') process.exit(selftest());
    else if (a === '--check') { const C = checkPack(b); console.log(C.bad.length ? '❌ ' + C.bad.join(' / ') : `✅ 合格:${JSON.stringify(C.key)}・雜湊 ${packHash(b).hash}`); process.exit(C.bad.length ? 1 : 0); }
    else if (a) build(path.resolve(a));
    else { console.error('用法:research_pack.mjs <OUT> | --check <d16> | --selftest'); process.exit(1); }
}
