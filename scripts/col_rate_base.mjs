#!/usr/bin/env node
/**
 * 🎲 V79.8.7 觸發專欄的「一般股票」發生率(使用者 10/25:「都要用發生率去說,不能用無法查等等方式回覆」)
 *   ⭐ 條件 / 結果的判斷⛔ 第二份:從 index.html 抽 `_COL_OCC` / `_colEvAt` / `_colOutAt` / `_colOcc`(+ 它們用到的
 *      `_floorTick` / `_tickOf` / `_marginCallState` / `_bear60Of`)原文,用同一段函式掃 16 年全市場(d16,含已下市)。
 *   個股類:每一條 → 一般股票發生幾次、之後那件事發生幾次、隨便一天的比例,以及「這檔自己過去的比例猜不猜得準下一次」
 *            (每一檔第 4 次起,用之前那幾次的比例猜 vs 用一般股票的比例猜,比 Brier;自己的比較差 → own:false)
 *   大盤類:加權 2010 年起 bear_on / bull_on / crash20 / idx_drop3 → 20 個交易日後加權上漲的比例 vs 隨便一天
 *   跑法:DATA_DIR=$S/d16 NAMES=$S/stock_names.json node scripts/col_rate_base.mjs out.json
 *         node scripts/col_rate_base.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iso = x => String(x || '').replace(/\//g, '-').slice(0, 10);

/** 從 index.html 抽 app 物件裡的方法 / 屬性原文(大括號配對;字串與樣板字串裡的括號不算) */
export function extractMember(src, name) {
    const re = new RegExp(`\\n    ${name.replace(/\$/g, '\\$')}(\\(|: \\{)`);
    const m = re.exec(src); if (!m) throw new Error('index.html 找不到 ' + name);
    const start = m.index + 1;
    let i = src.indexOf('{', start + name.length), depth = 0, q = null;
    for (; i < src.length; i++) {
        const c = src[i];
        if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
        if (c === '"' || c === "'" || c === '`') { q = c; continue; }
        if (c === '/' && src[i + 1] === '/' && /\s/.test(src[i - 1])) { i = src.indexOf('\n', i); continue; }   // 註解(⛔ 把 regex 的 /\//g 當註解)
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return src.slice(start, i + 1).trim();
    }
    throw new Error('大括號對不上:' + name);
}
export const NEED = ['_COL_OCC', '_colLim', '_colEvAt', '_colOutAt', '_colOcc', '_floorTick', '_tickOf', '_marginCallState', '_bear60Of'];
export function buildApp(src) {
    const body = NEED.map(n => extractMember(src, n)).join(',\n');
    // eslint-disable-next-line no-eval
    const A = (0, eval)(`({${body}})`);
    A.allStockList = [];
    return A;
}

export const MKT = {
    bear_on: { ev: '剛轉成空頭', out: '20 個交易日後加權上漲' },
    bull_on: { ev: '剛脫離空頭', out: '20 個交易日後加權上漲' },
    crash20: { ev: '離一年最高點跌 20% 以上', out: '20 個交易日後加權上漲' },
    idx_drop3: { ev: '單日跌 3% 以上', out: '20 個交易日後加權上漲' },
};
/** 加權那四條每一天成立嗎:定義照 `_colTrigEval`(bear_on / bull_on 用同一支 `_bear60Of`,5 天內剛翻;crash20 含今天 252 根)
 *  ⭐ test_colocc 拿 App 真的 `_colTrigEval` 逐日比對這份(⛔ 兩份定義分叉) */
export function mktEvents(A, tw) {
    const c = tw.map(r => +r.close);
    const bear = []; for (let i = 0; i < tw.length; i++) { let b = null; if (i >= 69) { try { b = A._bear60Of(tw.slice(Math.max(0, i - 299), i + 1)); } catch (_) {} } bear.push(b ? !!b.on : null); }
    const ev = {
        bear_on: i => bear[i] === true && [1, 2, 3, 4, 5].some(j => bear[i - j] === false),
        bull_on: i => bear[i] === false && [1, 2, 3, 4, 5].some(j => bear[i - j] === true),
        crash20: i => { if (i < 69) return false; let hi = 0; for (let j = Math.max(0, i - 251); j <= i; j++) hi = Math.max(hi, c[j]); return hi > 0 && c[i] <= hi * 0.8; },
        idx_drop3: i => i >= 1 && c[i - 1] > 0 && (c[i] / c[i - 1] - 1) * 100 <= -3,
    };
    return ev;
}
export function mktOcc(A, tw) {
    const out = {}, c = tw.map(r => +r.close), ev = mktEvents(A, tw);
    const up20 = i => i + 20 < c.length && c[i] > 0 ? (c[i + 20] > c[i] ? 1 : 0) : null;
    let bn = 0, bk = 0; for (let i = 0; i < c.length; i++) { const y = up20(i); if (y != null) { bn++; bk += y; } }
    for (const id of Object.keys(MKT)) {
        let n = 0, k = 0, last = -1e9;
        for (let i = 1; i < c.length; i++) {
            const y = up20(i); if (y == null || i - last < 20 || !ev[id](i)) continue;
            last = i; n++; k += y;
        }
        out[id] = { ...MKT[id], n, k, base: Math.round(1000 * bk / bn) / 10, from: iso(tw[0].date).slice(0, 4) };
    }
    return out;
}

/** 個股:合併每一檔的 _colOcc → 一般股票的比例 + 自己的過去猜不猜得準 */
export function aggregate(perStock, ids) {
    const out = {};
    for (const id of ids) {
        let n = 0, k = 0, bn = 0, bk = 0, f = null; const seqs = [];
        for (const r of perStock) { const x = r[id]; if (!x) continue; n += x.n; k += x.k; bn += x.bn; bk += x.bk; if (x.ys.length >= 4) seqs.push(x.ys); if (x.f && (!f || x.f < f)) f = x.f; }
        const p = n ? k / n : null;
        let bo = 0, bg = 0, m = 0;
        for (const ys of seqs) for (let j = 3; j < ys.length; j++) {
            const po = ys.slice(0, j).reduce((a, b) => a + b, 0) / j;
            bo += (po - ys[j]) ** 2; bg += (p - ys[j]) ** 2; m++;
        }
        const r1 = x => Math.round(1000 * x) / 10;
        out[id] = { n, k, p: p == null ? null : r1(p), base: bn ? r1(bk / bn) : null, from: f ? f.slice(0, 4) : null,
                    own: m >= 200 ? bo < bg : null, ownN: m, bOwn: m ? +(bo / m).toFixed(4) : null, bGen: m ? +(bg / m).toFixed(4) : null };
    }
    return out;
}

function main() {
    const DIR = process.env.DATA_DIR, NAMES = process.env.NAMES;
    if (!DIR) { console.error('❌ 要 DATA_DIR'); process.exit(1); }
    const A = buildApp(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'));
    const ids = Object.keys(A._COL_OCC);
    const typeOf = {};
    if (NAMES) { try { const j = JSON.parse(fs.readFileSync(NAMES, 'utf8')); for (const [k, v] of Object.entries(j.names || j)) if (Array.isArray(v) && v[2]) typeOf[k] = String(v[2]).toLowerCase().includes('tpex') || /櫃|otc/i.test(v[2]) ? 'tpex' : 'twse'; } catch (_) {} }
    const load = s => { try { const j = JSON.parse(fs.readFileSync(path.join(DIR, s + '.json'), 'utf8')); return Array.isArray(j) ? j.filter(r => r && r.date && +r.close > 0) : null; } catch (_) { return null; } };
    const tw = load('^TWII'); if (!tw || tw.length < 1000) { console.error('❌ 讀不到 ^TWII 或太短'); process.exit(1); }
    const M = new Map(tw.map(r => [iso(r.date), +r.close]));
    const files = fs.readdirSync(DIR).filter(f => /^[1-9]\d{3}\.json$/.test(f)).map(f => f.slice(0, -5));   // 4 碼普通股(⛔ 00 開頭的 ETF / 權證 / 指數)
    const per = []; let first = '9999', lastD = '0000', t0 = Date.now();
    for (const [i, sym] of files.entries()) {
        const b = load(sym); if (!b || b.length < 300) continue;
        A.allStockList = [{ stock_id: sym, type: typeOf[sym] || '' }];
        const r = {};
        for (const id of ids) r[id] = A._colOcc(id, b, sym, M);
        per.push(r);
        if (iso(b[0].date) < first) first = iso(b[0].date); if (iso(b[b.length - 1].date) > lastD) lastD = iso(b[b.length - 1].date);
        if (i % 300 === 0) console.log(`  ${i}/${files.length} ${sym} ${Math.round((Date.now() - t0) / 1000)}s`);
    }
    const stk = aggregate(per, ids);
    const out = { built: new Date().toISOString().slice(0, 10), src: 'scripts/col_rate_base.mjs(d16,含已下市)', syms: per.length, win: [first, lastD], stk, mkt: mktOcc(A, tw) };
    const f = process.argv[2]; if (f) fs.writeFileSync(f, JSON.stringify(out, null, 1));
    console.log(JSON.stringify(out, null, 1));
}

function selftest() {
    const fails = []; const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + e}`); if (!c) fails.push(n); };
    const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const A = buildApp(src);
    ok('① 抽得到同一段函式(⛔ 第二份條件)', typeof A._colEvAt === 'function' && typeof A._colOcc === 'function' && Object.keys(A._COL_OCC).length >= 10);
    // 合成:400 根,平常每天 +0.1%,第 100/200/300 根鎖漲停(+10%),隔天開盤也漲停;加權不動
    const D = []; let t = Date.UTC(2020, 0, 1); while (D.length < 400) { const d = new Date(t); if (d.getUTCDay() % 6) D.push(d.toISOString().slice(0, 10)); t += 864e5; }
    let c = 50; const b = D.map((d, i) => { const p = c; c = [100, 200, 300].includes(i) ? +(p * 1.1).toFixed(2) : +(p * 1.001).toFixed(4); const o = [101, 201, 301].includes(i) ? +(p * 1.1).toFixed(2) : p; return { date: d, open: o, high: c, low: Math.min(o, c), close: c, volume: 1000 }; });
    for (const i of [101, 201, 301]) { b[i].open = A._floorTick(b[i - 1].close * 1.1); b[i].high = Math.max(b[i].high, b[i].open); }
    const M = new Map(D.map(d => [d, 100]));
    const r = A._colOcc('lu', b, '9999', M);
    ok('② 合成三次鎖漲停 → n = 3、隔天開盤漲停 3 次', r.n === 3 && r.k === 3, JSON.stringify([r.n, r.k]));
    ok('② 平常隨便一天隔天開盤漲停 ≈ 3 / 398', r.bk === 3 && r.bn > 390, JSON.stringify([r.bk, r.bn]));
    // ③ 前視守門:任何一根的條件只看 ≤ i 的資料 —— 截斷後面的 K 線結果一模一樣
    let same = true;
    for (const id of Object.keys(A._COL_OCC)) for (const i of [120, 200, 260, 350]) {
        const a = !!A._colEvAt(id, b.slice(0, 380), i, '9999'), z = !!A._colEvAt(id, b.slice(0, i + 2), i, '9999');
        if (a !== z) same = false;
    }
    ok('③ ⛔ 前視:截斷第 i 根之後的資料,條件判斷不變', same);
    // ④ 決定性對照:把「隔天開盤」改成看今天收盤(偷看)→ 跟原本不一樣才算有鑑別力
    const y1 = A._colOutAt('xr20', b, 100, M), y2 = A._colOutAt('xr20', b, 395, M);
    ok('④ 結果算不出來就 null(最後 20 根之內)', y2 === null && (y1 === 0 || y1 === 1), JSON.stringify([y1, y2]));
    // ⑤ 斷崖:結果窗口裡有 ×0.4 → null
    const bc = b.map(x => ({ ...x })); for (let i = 110; i < bc.length; i++) { bc[i].close *= 0.4; bc[i].open *= 0.4; bc[i].high *= 0.4; bc[i].low *= 0.4; }
    ok('⑤ 碰到價格斷崖的結果窗口不算', A._colOutAt('xr20', bc, 100, M) === null && A._colOutAt('up1', bc, 109, M) === null);
    // ⑥ aggregate:自己的過去猜得比一般股票差 → own:false
    const per = []; for (let s = 0; s < 120; s++) per.push({ x: { n: 6, k: 3, bn: 100, bk: 50, ys: s % 2 ? [1, 0, 1, 0, 1, 0] : [0, 1, 0, 1, 0, 1] } });
    const ag = aggregate(per, ['x']);
    ok('⑥ 一半一半亂跳 → 自己的過去猜不準(own:false)', ag.x.own === false && ag.x.p === 50, JSON.stringify(ag.x));
    const per2 = []; for (let s = 0; s < 120; s++) per2.push({ x: { n: 6, k: s % 2 ? 6 : 0, bn: 100, bk: 50, ys: Array(6).fill(s % 2 ? 1 : 0) } });
    ok('⑥ 決定性對照:每檔自己很固定 → own:true', aggregate(per2, ['x']).x.own === true);
    // ⑦ 大盤:合成加權跌 25% → crash20 有、20 天後上漲判得出來
    const tw = D.map((d, i) => ({ date: d, close: i < 300 ? 100 : i < 320 ? 100 - (i - 299) * 1.4 : 75 + (i - 320) * 0.2 }));
    const mk = mktOcc(A, tw);
    ok('⑦ 大盤 crash20 抓得到(gap 20 天只算一次)', mk.crash20.n >= 1 && mk.crash20.n <= 4, JSON.stringify(mk.crash20));
    // ⑧ 2015-06 以前漲停是 7%(陷阱 #52):2012 年三次 +7% 鎖死 → 抓得到;同一份改成 2016 年 → +7% 不是漲停(決定性對照)
    const mk7 = y0 => { const DD = []; let tt = Date.UTC(y0, 0, 2); while (DD.length < 200) { const d = new Date(tt); if (d.getUTCDay() % 6) DD.push(d.toISOString().slice(0, 10)); tt += 864e5; }
        let cc = 50; return DD.map((d, i) => { const p = cc; cc = [60, 120, 180].includes(i) ? A._floorTick(p * 1.07) : +(p * 1.001).toFixed(4); return { date: d, open: p, high: cc, low: Math.min(p, cc), close: cc, volume: 1000 }; }); };
    const r12 = A._colOcc('lu', mk7(2012), '9999', new Map()), r16 = A._colOcc('lu', mk7(2016), '9999', new Map());
    ok('⑧ 2012 年 +7% 鎖死 = 漲停(3 次);2016 年同一份 = 不是(0 次)', r12.n === 3 && r16.n === 0, JSON.stringify([r12.n, r16.n]));
    ok('⑧ 今天一律 10%(App 判斷不變)', A._colLim(new Date().toISOString().slice(0, 10)) === 0.1 && A._colLim('2015-05-29') === 0.07 && A._colLim('2015/06/01') === 0.1);
    console.log(fails.length ? `❌ ${fails.length} 條失敗` : '✅ SELFTEST_PASS');
    process.exit(fails.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    if (process.argv.includes('--selftest')) selftest(); else main();
}
