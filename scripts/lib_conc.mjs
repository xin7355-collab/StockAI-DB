// 📊 lib_conc.mjs —— 成交集中度(前 N 大成交金額 ÷ 全部個股)唯一一份算法
//   人性頁那條量條(scripts/mood_build.mjs)與研究(scripts/conc_probe.mjs)都 import 這一支,⛔ 各自再寫一份
//
// 定義:每一天、每一檔 收盤 × 成交股數 = 成交金額;前 N 大加起來 ÷ 全部個股加起來
//   ⛔ 不算:00 開頭(ETF)、^ 開頭(指數)、_ 開頭(輔助檔)、檔名不是純數字的
//   ⛔ 不算:那天收盤或成交量不是正數的列
// 品質門檻(陷阱 #14:「最新一天」可能只有少數股票有列 → 不可以拿來當今天):
//   那天的檔數 < minN → 不給;< 前 20 個合格日子檔數中位數的 rel 倍 → 不給(盤中只寫了一部分、或資料源那天漏一大半)
//
// 跑法(selftest):node scripts/lib_conc.mjs --selftest
import fs from 'fs';
import os from 'os';
import path from 'path';

export const CONC = { tops: [5, 10, 20], minN: 800, rel: 0.8, relWin: 20 };

const d10 = s => String(s || '').replace(/\//g, '-').slice(0, 10);

/** 只收這種檔名:純數字、⛔ 00 開頭 */
export function stockFile(f) { return /^\d+\.json$/.test(f) && !/^00/.test(f); }

/** 一檔的列 → 累加進 M(date → {tot, n, top: 由小到大、最多 maxTop 個}) */
export function addRows(M, rows, maxTop = Math.max(...CONC.tops)) {
    for (const r of rows || []) {
        const c = +r.close, v = +r.volume;
        if (!(c > 0) || !(v > 0)) continue;
        const d = d10(r.date), x = c * v;
        if (d.length !== 10) continue;
        let o = M.get(d); if (!o) { o = { tot: 0, n: 0, top: [] }; M.set(d, o); }
        o.tot += x; o.n++;
        const t = o.top;
        if (t.length < maxTop) { t.push(x); t.sort((a, b) => a - b); }
        else if (x > t[0]) { t[0] = x; t.sort((a, b) => a - b); }
    }
}

/** M → [{ d, n, tot(元), s5, s10, s20(%) }] 由舊到新,只留通過品質門檻的日子 */
export function finish(M, o = {}) {
    const minN = o.minN ?? CONC.minN, rel = o.rel ?? CONC.rel, W = o.relWin ?? CONC.relWin;
    const out = [], ns = [];
    for (const d of [...M.keys()].sort()) {
        const x = M.get(d);
        if (x.n < minN || !(x.tot > 0)) continue;
        if (ns.length >= 5) {
            const s = ns.slice(-W).sort((a, b) => a - b), med = s[Math.floor(s.length / 2)];
            if (x.n < med * rel) continue;
        }
        ns.push(x.n);
        const desc = [...x.top].sort((a, b) => b - a), sh = k => Math.round(desc.slice(0, k).reduce((s, y) => s + y, 0) / x.tot * 10000) / 100;
        const row = { d, n: x.n, tot: x.tot };
        for (const k of CONC.tops) row['s' + k] = sh(k);
        out.push(row);
    }
    return out;
}

/** 讀一個資料夾裡全部個股檔(一檔一檔讀、只留每天的加總 → ⛔ 整份放進記憶體) */
export function concDaily(dir, o = {}) {
    const M = new Map(); let files = 0, bad = 0;
    for (const f of fs.readdirSync(dir).filter(stockFile)) {
        let a;
        try { a = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { bad++; continue; }
        a = Array.isArray(a) ? a : (a && Array.isArray(a.data) ? a.data : null);
        if (!a) { bad++; continue; }
        addRows(M, a); files++;
    }
    return { rows: finish(M, o), files, bad };
}

/** 近 k 天平均(含當天;前面不夠 k 天 → null) */
export function rollMean(v, k) {
    const out = new Array(v.length).fill(null); let s = 0;
    for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= k) s -= v[i - k]; if (i >= k - 1) out[i] = s / k; }
    return out;
}

/** 擴張百分位:第 i 天的值比之前(⛔ 含當天)幾 % 的日子高;之前不到 minHist 天 → null;同分算一半 */
export function expandingPct(v, minHist = 250) {
    const out = new Array(v.length).fill(null), past = [];
    for (let i = 0; i < v.length; i++) {
        if (v[i] == null) continue;
        if (past.length >= minHist) {
            let lt = 0, eq = 0; for (const x of past) { if (x < v[i]) lt++; else if (x === v[i]) eq++; }
            out[i] = (lt + eq / 2) / past.length * 100;
        }
        past.push(v[i]);
    }
    return out;
}

function selftest() {
    let bad = 0; const ok = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + x}`); if (!c) bad++; };
    // ① 前 10 大 ÷ 全部:20 檔,一檔 100、其他 1 → 前 10 = 100 + 9、全部 = 119
    const M = new Map(), rows = k => [{ date: '2024/01/02', close: 1, volume: k }];
    addRows(M, rows(100)); for (let i = 0; i < 19; i++) addRows(M, rows(1));
    const r1 = finish(M, { minN: 10 })[0];
    ok('① 前 10 大 ÷ 全部個股(日期換成 2024-01-02)', r1 && r1.d === '2024-01-02' && Math.abs(r1.s10 - 109 / 119 * 100) < 0.01 && Math.abs(r1.s5 - 104 / 119 * 100) < 0.01 && r1.n === 20, JSON.stringify(r1));
    // ② 收盤 / 成交量 ⛔ 正數的列不算
    const M2 = new Map(); addRows(M2, [{ date: '2024-01-02', close: 0, volume: 5 }, { date: '2024-01-02', close: 5, volume: 0 }, { date: '2024-01-02', close: 2, volume: 3 }]);
    ok('② 收盤或成交量不是正數 → 不算', M2.get('2024-01-02').n === 1 && M2.get('2024-01-02').tot === 6);
    // ③ 檔名:00 開頭、^、_、非數字 ⛔ 收
    ok('③ 只收純數字、⛔ 00 開頭的檔', stockFile('2330.json') && !stockFile('0050.json') && !stockFile('^TWII.json') && !stockFile('_div16.json') && !stockFile('mood.json'));
    // ④ 品質門檻:檔數不夠 / 比前面少很多(盤中只寫了一部分)→ 那天不給
    const M4 = new Map();
    for (let dd = 1; dd <= 8; dd++) for (let i = 0; i < 900; i++) addRows(M4, [{ date: `2024-01-${String(dd).padStart(2, '0')}`, close: 1, volume: 1 + i }]);
    for (let i = 0; i < 850; i++) addRows(M4, [{ date: '2024-01-09', close: 1, volume: 1 + i }]);
    for (let i = 0; i < 500; i++) addRows(M4, [{ date: '2024-01-10', close: 1, volume: 1 + i }]);
    const f4 = finish(M4);
    ok('④ 檔數 850 ≥ 前面中位數 900 × 0.8 → 留;500 < 800 → 不給', f4.length === 9 && f4.at(-1).d === '2024-01-09', JSON.stringify(f4.map(x => [x.d, x.n])));
    const M4b = new Map();
    for (let dd = 1; dd <= 8; dd++) for (let i = 0; i < 2000; i++) addRows(M4b, [{ date: `2024-02-${String(dd).padStart(2, '0')}`, close: 1, volume: 1 + i }]);
    for (let i = 0; i < 1200; i++) addRows(M4b, [{ date: '2024-02-09', close: 1, volume: 1 + i }]);
    ok('④ 決定性對照:前面每天 2,000 檔、最後一天只有 1,200(> 800 但 < 0.8 倍)→ 最後一天不給', finish(M4b).at(-1).d === '2024-02-08');
    // ⑤ 擴張百分位 ⛔ 含當天、同分算一半、前面不夠不給
    const p = expandingPct([1, 2, 3, 4, 4, 0, 5], 4);
    ok('⑤ 擴張百分位:第 5 天(4)比前 4 天 3 個小 1 個一樣 → 87.5;第 6 天(0)→ 0;第 7 天(5)→ 100;前 4 天 null', p[4] === 87.5 && p[5] === 0 && p[6] === 100 && p[3] === null, JSON.stringify(p));
    const p2 = expandingPct([1, 2, 3, 4, 4, 0, 99], 4);
    ok('⑤ 改掉最後一天,之前的百分位一個都不變(⛔ 前視)', JSON.stringify(p2.slice(0, 6)) === JSON.stringify(p.slice(0, 6)));
    ok('⑥ 近 k 天平均(含當天,前面不夠 → null)', JSON.stringify(rollMean([1, 2, 3, 4], 2)) === JSON.stringify([null, 1.5, 2.5, 3.5]));
    // ⑦ 讀資料夾:一檔一檔讀;ETF / 指數 / 輔助檔不收、壞檔記下來、兩種格式(陣列 / {data})都吃
    const td = fs.mkdtempSync(path.join(os.tmpdir(), 'conc-'));
    try {
        const wr = (f, x) => fs.writeFileSync(path.join(td, f), typeof x === 'string' ? x : JSON.stringify(x));
        for (let i = 0; i < 12; i++) wr(`${1101 + i}.json`, i % 2 ? [{ date: '2024/03/01', close: 10, volume: 100 * (i + 1) }] : { data: [{ date: '2024/03/01', close: 10, volume: 100 * (i + 1) }] });
        wr('0050.json', [{ date: '2024/03/01', close: 10, volume: 1e9 }]); wr('^TWII.json', [{ date: '2024/03/01', close: 1, volume: 1e9 }]);
        wr('_div16.json', [{ date: '2024/03/01', close: 1, volume: 1e9 }]); wr('9999.json', '{"壞掉');
        const C = concDaily(td, { minN: 10 }), r = C.rows[0], tot = Array.from({ length: 12 }, (_, i) => 1000 * (i + 1)).reduce((s, x) => s + x, 0);
        ok('⑦ 讀資料夾:12 檔都收(兩種格式)、ETF / 指數 / 輔助檔 ⛔、壞檔記 1', C.files === 12 && C.bad === 1 && r && r.n === 12 && r.tot === tot && Math.abs(r.s10 - (tot - 1000 - 2000) / tot * 100) < 0.01, JSON.stringify({ files: C.files, bad: C.bad, r }));
    } finally { fs.rmSync(td, { recursive: true, force: true }); }
    console.log(bad ? `\n❌ ${bad} 條沒過` : '\n✅ LIB_CONC_SELFTEST_PASS');
    return bad ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith('lib_conc.mjs') && process.argv.includes('--selftest')) process.exit(selftest());
