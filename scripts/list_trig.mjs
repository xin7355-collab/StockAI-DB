#!/usr/bin/env node
/**
 * 🎯 V79.4.8 重現 App 名單那道「明天漲 6% 內觸發不了就不列」—— 給 portfolio_backtest.mjs 的 LIST_TRIG 用
 *
 *   node scripts/list_trig.mjs <dump.ndjson> <out.ndjson>
 *     dump = portfolio_backtest.mjs `LISTK=… LIST_DUMP=…` 的產物(每晚排好的候選:昨天沒觸發・🧬・每檔前 2 招,照下界排)
 *   env:DATA_DIR(K 線,預設 repo data/)・HTML_DIR(放 index.html 的資料夾,預設 repo 根目錄 —— 跑 App 自己的偵測器)
 *       TOPN(每晚判前幾筆,預設 20)・NEAR(預設 6 = playbook_scan)・WIN(預設 1200 = App 的 K 線上限)
 *       SHARD=k/K(照代號分片平行跑)・SKIP=<舊產物>(已判過的跳過)
 *   產物一行一筆 {n: 那一晚, s: 代號, k: 招, t, f, z}
 *     t = 0 明天漲 6% 內都不會觸發(App 不列)・1 漲到某個價會觸發(有觸發價)・2 跌 6% 也觸發(不靠價位)
 *     f = 隔天那根真的 K 有沒有觸發(1/0;沒有隔天 = −1)・z = 那一晚自己就已經觸發(App 放「今天已觸發」不列)
 *
 * ⭐ 判法跟 playbook_scan.mjs 的 trigOf 一樣:合成「明天那根 K」(平盤開、收在 P、量 = 近 5 日平均),
 *    P 從 −6% 到 +NEAR% 分 14 段由低到高掃,第一個會觸發的價 = 觸發價;第 0 段就觸發 = 不靠價位;都不觸發 = 不列。
 *    ⛔ 不複製偵測器:直接呼叫 App 的 `_playbookPatternDefs`(同一份 index.html)。
 *    ⚠️ App 的 K 線最多 1,200 根 → 只用那一晚往前 WIN 根(⛔ 用整段歷史,有些型態會跟 App 判得不一樣)。
 *    ⚠️ 不算觸發價本身(名單只需要「列不列」);App 二分後「觸發價 ≤ 現價」改叫不靠價位的那種,這裡算 1(一樣會列)。
 * 測試:scripts/test_listtrig.mjs(跟真的 playbook_scan 同一份資料逐筆比 + 引擎決定性對照)
 */
import { fileURLToPath, pathToFileURL } from 'url';
import fs from 'fs';
import path from 'path';

let chromium;
try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); }
catch (_) { ({ chromium } = await import('playwright')); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [DUMP, OUT] = process.argv.slice(2);
if (!DUMP || !OUT) { console.error('用法:node scripts/list_trig.mjs <dump.ndjson> <out.ndjson>'); process.exit(1); }
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const HTML_DIR = process.env.HTML_DIR || ROOT;
const TOPN = +(process.env.TOPN || 20), NEAR = +(process.env.NEAR || 6), WIN = +(process.env.WIN || 1200);
const SH = (process.env.SHARD || '').trim();
const [SK, SN] = SH ? SH.split('/').map(Number) : [0, 1];
if (!(Number.isInteger(TOPN) && TOPN >= 1) || !(NEAR > 0) || !(Number.isInteger(WIN) && WIN >= 120) || !(Number.isInteger(SK) && Number.isInteger(SN) && SN >= 1 && SK >= 0 && SK < SN)) {
    console.error(`🚨 參數不認得:TOPN=${process.env.TOPN} NEAR=${process.env.NEAR} WIN=${process.env.WIN} SHARD=${SH}`); process.exit(1);
}
if (!fs.existsSync(DUMP)) { console.error(`🚨 讀不到 ${DUMP}`); process.exit(1); }
if (!fs.existsSync(path.join(HTML_DIR, 'index.html'))) { console.error(`🚨 ${HTML_DIR} 沒有 index.html`); process.exit(1); }

// ① 要判的:每晚前 TOPN 筆,照代號分組(一檔載入一次)
const skip = new Set();
for (const f of (process.env.SKIP || '').split(',').map(s => s.trim()).filter(Boolean)) {
    if (!fs.existsSync(f)) { console.error(`🚨 SKIP=${f} 讀不到`); process.exit(1); }
    for (const ln of fs.readFileSync(f, 'utf8').split('\n')) { if (!ln.trim()) continue; const o = JSON.parse(ln); skip.add(`${o.n}|${o.s}|${o.k}`); }
}
const per = new Map();   // sym → Map(night → Set(key))
let nights = 0, want = 0, skipped = 0;
for (const ln of fs.readFileSync(DUMP, 'utf8').split('\n')) {
    if (!ln.trim()) continue;
    const o = JSON.parse(ln); nights++;
    for (const [s, k] of (o.e || []).slice(0, TOPN)) {
        if (skip.has(`${o.n}|${s}|${k}`)) { skipped++; continue; }
        const m = per.get(s) || per.set(s, new Map()).get(s);
        const st = m.get(o.n) || m.set(o.n, new Set()).get(o.n);
        if (!st.has(k)) { st.add(k); want++; }
    }
}
if (!nights) { console.error(`🚨 ${DUMP} 一晚都沒有`); process.exit(1); }
const syms = [...per.keys()].sort().filter((_, i) => i % SN === SK);
console.log(`🎯 list_trig:${nights} 晚 ・每晚前 ${TOPN} 筆 ・要判 ${want.toLocaleString()} 筆(${per.size} 檔${SN > 1 ? `,這一片 ${syms.length} 檔` : ''}${skipped ? `;已判過跳過 ${skipped}` : ''})・NEAR ${NEAR}% ・窗口 ${WIN} 根`);

// ② K 線讀法跟 playbook_scan.mjs loadSeries 一樣(App 那一份)
function loadSeries(p) {
    try {
        const rows = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (!Array.isArray(rows)) return null;
        const out = [];
        for (const r of rows) {
            const c = +(r.close || 0), d = String(r.date || '').replace(/\//g, '-').slice(0, 10);
            if (c > 0 && d) out.push({ date: d, open: +(r.open || c), high: +(r.high || c), low: +(r.low || c), close: c, volume: +(r.volume || 0) });
        }
        return out;
    } catch (_) { return null; }
}

const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({
    ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}),
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
page.on('pageerror', () => {});
await page.goto(pathToFileURL(path.join(HTML_DIR, 'index.html')).href, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._playbookPatternDefs, null, { timeout: 25000 });

fs.writeFileSync(OUT, '');
const t0 = Date.now();
let done = 0, nT = 0, n1 = 0, n2 = 0, nF = 0, nZ = 0, nMiss = 0, errN = 0;
for (const sym of syms) {
    const rows = loadSeries(path.join(DATA, `${sym}.json`));
    const items = [...per.get(sym)].map(([n, ks]) => [n, [...ks]]);
    if (!rows) { nMiss += items.reduce((a, x) => a + x[1].length, 0); done++; continue; }
    let res;
    try {
        res = await page.evaluate(a => {
            const { rows, items, near, win } = a;
            const idx = new Map(rows.map((r, i) => [r.date, i]));
            const test = (defs, key, at) => { const p = defs && defs.find(d => d.key === key); if (!p) return false; try { return !!p.test(at); } catch (_) { return false; } };
            const out = [];
            for (const [night, keys] of items) {
                const i = idx.get(night);
                if (i == null) { for (const k of keys) out.push([night, k, -1, -1, -1]); continue; }
                const w = rows.slice(Math.max(0, i - win + 1), i + 1);
                if (w.length < 120) { for (const k of keys) out.push([night, k, 0, -1, -1]); continue; }   // App 少於 120 根不分析
                const c0 = w[w.length - 1].close;
                const volAvg = Math.round(w.slice(-5).reduce((s, x) => s + (x.volume || 0), 0) / 5);
                // 那一晚自己就觸發了 → App 放「今天已觸發」(⛔ 不列)
                let d0 = null; try { d0 = app._playbookPatternDefs(w); } catch (_) {}
                const z = new Map(keys.map(k => [k, test(d0, k, w.length - 1) ? 1 : 0]));
                // 合成明天那根 K:由低到高掃(⛔ 不假設單調,同 playbook_scan)
                const lo = c0 * 0.94, hi = c0 * (1 + near / 100), STEP = 14;
                const t = new Map(keys.map(k => [k, 0]));
                const pend = new Set(keys);
                for (let k = 0; k <= STEP && pend.size; k++) {
                    const P = lo + (hi - lo) * k / STEP;
                    const ext = w.concat([{ date: '9999-12-31', open: c0, high: Math.max(P, c0), low: Math.min(P, c0), close: P, volume: volAvg }]);
                    let defs; try { defs = app._playbookPatternDefs(ext); } catch (_) { break; }
                    for (const key of [...pend]) if (test(defs, key, ext.length - 1)) { t.set(key, k === 0 ? 2 : 1); pend.delete(key); }
                }
                // 隔天那根真的 K 有沒有觸發(同樣只看 App 那 WIN 根)
                const f = new Map();
                if (i + 1 < rows.length) {
                    const w2 = rows.slice(Math.max(0, i + 1 - win + 1), i + 2);
                    let d2 = null; try { d2 = app._playbookPatternDefs(w2); } catch (_) {}
                    for (const k of keys) f.set(k, test(d2, k, w2.length - 1) ? 1 : 0);
                }
                for (const k of keys) out.push([night, k, t.get(k), f.has(k) ? f.get(k) : -1, z.get(k)]);
            }
            return out;
        }, { rows, items, near: NEAR, win: WIN });
    } catch (e) { errN++; if (errN <= 5) console.error(`⚠️ ${sym}:${String(e && e.message || e).slice(0, 200)}`); done++; continue; }
    const lines = [];
    for (const [n, k, t, f, z] of res) {
        if (t < 0) { nMiss++; continue; }
        lines.push(JSON.stringify({ n, s: sym, k, t, f, z }));
        nT++; if (t === 1) n1++; if (t === 2) n2++; if (f === 1) nF++; if (z === 1) nZ++;
    }
    if (lines.length) fs.appendFileSync(OUT, lines.join('\n') + '\n');
    done++;
    if (done % 100 === 0) console.log(`   ${done}/${syms.length} 檔 ・${nT.toLocaleString()} 筆 ・${((Date.now() - t0) / 60000).toFixed(1)} 分`);
}
await browser.close();
console.log(`✅ 判完 ${nT.toLocaleString()} 筆:會觸發 ${n1.toLocaleString()}(有觸發價)+ ${n2.toLocaleString()}(不靠價位)= ${((n1 + n2) / Math.max(1, nT) * 100).toFixed(1)}% ・隔天真的觸發 ${nF.toLocaleString()} ・那一晚已觸發 ${nZ.toLocaleString()} ・沒資料 ${nMiss} ・例外 ${errN} 檔 ・${((Date.now() - t0) / 60000).toFixed(1)} 分`);
// ⛔ 不可靜默:例外超過 1% 的檔 → 紅燈(陷阱 #57 同一課)
if (errN > Math.max(2, syms.length * 0.01)) { console.error(`🚨 ${errN}/${syms.length} 檔丟出例外 → 結果不可信`); process.exit(1); }
if (!nT) { console.error('🚨 一筆都沒判到(K 線讀不到?日期對不上?)'); process.exit(1); }
