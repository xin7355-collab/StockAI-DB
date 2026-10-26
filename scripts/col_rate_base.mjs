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
import { simExits } from './lib_exitsim.mjs';
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
export const NEED = ['_COL_OCC', '_QLAB_SIGS', '_colOccDef', '_colOccIds', '_qlabAt', '_colLim', '_colEvAt', '_colOutAt', '_colOcc', '_floorTick', '_tickOf', '_marginCallState', '_bear60Of', '_atrTR14'];
export function buildApp(src) {
    // 📐 V79.8.9 `ql_` 那幾條走 QCORE(index.html 檔案上層那一段,⛔ 另抄一份)
    const qi = src.indexOf('// ==QCORE BEGIN=='), qj = src.indexOf('// ==QCORE END==');
    if (qi >= 0 && qj > qi) globalThis.QCORE = (0, eval)(src.slice(qi, qj) + '\nQCORE');
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

/** 全市場等權指數(價格,同一天所有股票平均;一天 < 100 檔不算)—— ql_ 的「比同一天所有股票好」用它當大盤(= 量化實驗室的比法) */
export function ewIndex(load, files) {
    const sum = new Map(), cnt = new Map();
    for (const s of files) { const b = load(s); if (!b || b.length < 60) continue;
        for (let j = 1; j < b.length; j++) { const c0 = +b[j - 1].close, c1 = +b[j].close; if (!(c0 > 0 && c1 > 0)) continue; const g = c1 / c0; if (!(g >= 0.67 && g <= 1.5)) continue;
            const d = iso(b[j].date); sum.set(d, (sum.get(d) || 0) + g - 1); cnt.set(d, (cnt.get(d) || 0) + 1); } }
    const EW = new Map(); let L = 1;
    for (const d of [...sum.keys()].sort()) { if (cnt.get(d) >= 100) { L *= 1 + sum.get(d) / cnt.get(d); EW.set(d, L); } }
    return EW;
}
/** 📐 V79.8.9 ql_(pool):結果比「同一天所有股票」(EW)、基準 = 同一檔同一年隨便一天(⛔ 只跟全市場比 —— 這種買點集中在熱的年份,
 *    比全部日子會看起來比較好,跟量化實驗室「比同一年亂買」的判定打架)。條件 / 結果一律呼叫 App 的 `_colEvAt` / `_colOutAt`(⛔ 第二份) */
export function poolOcc(A, id, b, sym, EW) {
    const D = A._colOccDef(id), yb = new Map(), ev = []; let last = -1e9, f = null;
    for (let i = 1; i < b.length; i++) {
        const y = A._colOutAt(D.o, b, i, EW); if (y == null) continue;
        const yr = iso(b[i].date).slice(0, 4), a = yb.get(yr) || yb.set(yr, [0, 0]).get(yr); a[0]++; a[1] += y;
        if (i - last < D.gap || !A._colEvAt(id, b, i, sym)) continue;
        last = i; ev.push([yr, y]); if (f == null) f = iso(b[i].date);
    }
    let n = 0, k = 0, sn = 0, sk = 0;
    for (const [yr, y] of ev) { n++; k += y; const a = yb.get(yr); if (a && a[0] >= 20) { sn++; sk += a[1] / a[0]; } }
    let bn = 0, bk = 0; for (const [, a] of yb) { bn += a[0]; bk += a[1]; }
    return { n, k, sn, sk, bn, bk, f };
}
export function aggregatePool(perStock, ids) {
    const out = {}, r1 = x => Math.round(1000 * x) / 10;
    for (const id of ids) {
        let n = 0, k = 0, sn = 0, sk = 0, bn = 0, bk = 0, f = null;
        for (const r of perStock) { const x = r[id]; if (!x) continue; n += x.n; k += x.k; sn += x.sn; sk += x.sk; bn += x.bn; bk += x.bk; if (x.f && (!f || x.f < f)) f = x.f; }
        out[id] = { n, k, p: n ? r1(k / n) : null, sy: sn ? r1(sk / sn) : null, base: bn ? r1(bk / bn) : null, from: f ? f.slice(0, 4) : null, pool: 1 };
    }
    return out;
}

/** 個股:合併每一檔的 _colOcc → 一般股票的比例 + 自己的過去猜不猜得準 */
export function aggregate(perStock, ids) {
    const out = {};
    for (const id of ids) {
        let n = 0, k = 0, bn = 0, bk = 0, f = null, sbw = 0; const seqs = [];
        // sb = 「同一批股票平常隨便一天」:每一次事件配上那一檔自己平常的比例再平均(⛔ 只跟全市場比 —— 事件常常集中在本來就比較會動的股票)
        for (const r of perStock) { const x = r[id]; if (!x) continue; n += x.n; k += x.k; bn += x.bn; bk += x.bk; if (x.n && x.bn) sbw += x.n * x.bk / x.bn; if (x.ys.length >= 4) seqs.push(x.ys); if (x.f && (!f || x.f < f)) f = x.f; }
        const p = n ? k / n : null;
        let bo = 0, bg = 0, m = 0;
        for (const ys of seqs) for (let j = 3; j < ys.length; j++) {
            const po = ys.slice(0, j).reduce((a, b) => a + b, 0) / j;
            bo += (po - ys[j]) ** 2; bg += (p - ys[j]) ** 2; m++;
        }
        const r1 = x => Math.round(1000 * x) / 10;
        out[id] = { n, k, p: p == null ? null : r1(p), base: bn ? r1(bk / bn) : null, sb: n ? r1(sbw / n) : null, from: f ? f.slice(0, 4) : null,
                    own: m >= 200 ? bo < bg : null, ownN: m, bOwn: m ? +(bo / m).toFixed(4) : null, bGen: m ? +(bg / m).toFixed(4) : null };
    }
    return out;
}

function main() {
    const DIR = process.env.DATA_DIR, NAMES = process.env.NAMES;
    if (!DIR) { console.error('❌ 要 DATA_DIR'); process.exit(1); }
    const A = buildApp(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'));
    const ids = A._colOccIds().filter(x => !process.env.ONLY || new RegExp(process.env.ONLY).test(x));   // ONLY=^ql_ 只算那幾條(研究用;⛔ 拿去嵌入 —— embed_col_base 會擋缺的)
    const typeOf = {};
    if (NAMES) { try { const j = JSON.parse(fs.readFileSync(NAMES, 'utf8')); for (const [k, v] of Object.entries(j.names || j)) if (Array.isArray(v) && v[2]) typeOf[k] = String(v[2]).toLowerCase().includes('tpex') || /櫃|otc/i.test(v[2]) ? 'tpex' : 'twse'; } catch (_) {} }
    const load = s => { try { const j = JSON.parse(fs.readFileSync(path.join(DIR, s + '.json'), 'utf8')); return Array.isArray(j) ? j.filter(r => r && r.date && +r.close > 0) : null; } catch (_) { return null; } };
    const tw = load('^TWII'); if (!tw || tw.length < 1000) { console.error('❌ 讀不到 ^TWII 或太短'); process.exit(1); }
    const M = new Map(tw.map(r => [iso(r.date), +r.close]));
    const files = fs.readdirSync(DIR).filter(f => /^[1-9]\d{3}\.json$/.test(f)).map(f => f.slice(0, -5));   // 4 碼普通股(⛔ 00 開頭的 ETF / 權證 / 指數)
    const poolIds = ids.filter(id => (A._colOccDef(id) || {}).pool), stdIds = ids.filter(id => !poolIds.includes(id));
    const EW = poolIds.length ? ewIndex(load, files) : new Map();
    if (poolIds.length && EW.size < 1000) { console.error(`❌ 全市場等權指數只有 ${EW.size} 天`); process.exit(1); }
    const per = []; let first = '9999', lastD = '0000', t0 = Date.now();
    for (const [i, sym] of files.entries()) {
        const b = load(sym); if (!b || b.length < 300) continue;
        A.allStockList = [{ stock_id: sym, type: typeOf[sym] || '' }];
        const r = {};
        for (const id of stdIds) r[id] = A._colOcc(id, b, sym, M);
        for (const id of poolIds) r[id] = poolOcc(A, id, b, sym, EW);
        per.push(r);
        if (iso(b[0].date) < first) first = iso(b[0].date); if (iso(b[b.length - 1].date) > lastD) lastD = iso(b[b.length - 1].date);
        if (i % 300 === 0) console.log(`  ${i}/${files.length} ${sym} ${Math.round((Date.now() - t0) / 1000)}s`);
    }
    const stk = { ...aggregate(per, stdIds), ...aggregatePool(per, poolIds) };
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
    for (const id of A._colOccIds()) for (const i of [120, 200, 260, 350]) {
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
    // ⑨ 📐 V79.8.9 量化實驗室的追高買點(`ql_`):每一根的判斷 == QCORE 直接跑那條策略(gap 1 = 每一根都看);合成跳空 3.5% 收紅 → 有、2.5% → 沒有
    const qids = A._colOccIds().filter(x => /^ql_/.test(x));
    ok('⑨ _QLAB_SIGS 有「比亂買還差」的那幾條,而且都接進 _colOccIds', qids.length >= 1 && qids.length === ((A._QLAB_SIGS || {}).bad || []).length, qids.join(','));
    { let c2 = 50; const bq = D.map((d, i) => { const p = c2, gp = i % 37 === 20 ? 1.035 : i % 41 === 25 ? 1.025 : 1; const o = +(p * gp).toFixed(2); c2 = +(o * (gp > 1 ? 1.01 : 1 + ((i * 7) % 11 - 5) / 1000)).toFixed(2);
          return { date: d, open: o, high: Math.max(o, c2) * 1.005, low: Math.min(o, c2) * 0.995, close: c2, volume: 1000 + (i * 97) % 5000, margin_balance: 5000 - (i % 30) * 60 }; });
      let same = true, any = 0;
      for (const id of qids) {
          const st = { ...A._colOccDef(id).ql.st, gap: 1 }, want = new Set(QCORE.signals(st, bq));
          for (let i = 1; i < bq.length; i++) { const a = !!A._colEvAt(id, bq, i, '9999'); if (a !== want.has(i)) same = false; if (a) any++; }
      }
      ok('⑨ ql_ 每一根的判斷 == QCORE.signals(同一條策略)、而且合成資料上真的有成立過', same && any > 0, JSON.stringify([same, any]));
      if (qids.includes('ql_gap_up')) {
          const r35 = A._colOcc('ql_gap_up', bq, '9999', M);
          const flat = bq.map((r, i) => i % 37 === 20 ? { ...r, open: +(bq[i - 1].close * 1.025).toFixed(2), close: +(bq[i - 1].close * 1.035).toFixed(2) } : r);
          const r25 = A._colOcc('ql_gap_up', flat, '9999', M);
          ok('⑨ 決定性對照:跳空 3.5% 收紅 → 算到;同幾天改成跳空 2.5% → 算不到(門檻 3%)', r35.n >= 5 && r25.n === 0, JSON.stringify([r35.n, r25.n]));
      }
    }
    // ⑩ 📐 ex20(ql_ 的結果)== lib_exitsim chand2(最長 20 天・−5% 硬停損・收盤成交)出場那一天,再比加權扣 0.44%;決定性對照:買完隔天大跌 → 0
    { let c3 = 100, s3 = 7; const rnd = () => { s3 = (s3 * 16807) % 2147483647; return s3 / 2147483647; };
      const bx = D.map((d, i) => { const p = c3; c3 = +(p * (1 + (rnd() - 0.49) * 0.06)).toFixed(2); const hi = Math.max(p, c3) * (1 + rnd() * 0.01), lo = Math.min(p, c3) * (1 - rnd() * 0.01);
          return { date: d, open: p, high: +hi.toFixed(2), low: +lo.toFixed(2), close: c3, volume: 1000 }; });
      const Mx = new Map(D.map((d, i) => [d, 1000 * (1 + 0.0004 * i)])), R = bx.map(r => ({ o: r.open, h: r.high, l: r.low, c: r.close }));
      let same = true, n1 = 0, n0 = 0;
      for (let i = 20; i + 21 < bx.length; i++) {
          const ex = simExits(R, i + 1, { rules: ['chand2'], maxD: 20, holdStop: 5, stopFill: 'close' }).chand2, o = ex.outIdx, e = i + 1;
          const want = (R[o].c / R[e].c - Mx.get(D[o]) / Mx.get(D[e])) * 100 - 0.44 > 0 ? 1 : 0, got = A._colOutAt('ex20', bx, i, Mx);
          if (got !== want) same = false; if (want) n1++; else n0++;
      }
      ok('⑩ ex20 == 隔天收盤買 + lib_exitsim chand2 出場(最長 20 天・−5% 硬停損・收盤成交)比加權扣 0.44%,兩種結果都有', same && n1 > 5 && n0 > 5, JSON.stringify([same, n1, n0]));
      const up = bx.map((r, i) => i > 100 ? { ...r, open: 100 * 1.01 ** (i - 100), high: 100 * 1.01 ** (i - 100) * 1.005, low: 100 * 1.01 ** (i - 100) * 0.995, close: 100 * 1.01 ** (i - 100) } : r);
      const dn = up.map((r, i) => i === 103 ? { ...r, close: up[102].close * 0.9, low: up[102].close * 0.9 } : r);
      ok('⑩ 決定性對照:一路漲 → 1;同一份買完隔天跌 10% → 0(停損)', A._colOutAt('ex20', up, 101, Mx) === 1 && A._colOutAt('ex20', dn, 101, Mx) === 0, JSON.stringify([A._colOutAt('ex20', up, 101, Mx), A._colOutAt('ex20', dn, 101, Mx)]));
      ok('⑩ 往後不到 21 根 → 不判(⛔ 只算到很快停損的那幾次)', A._colOutAt('ex20', bx, bx.length - 21, Mx) === null && A._colOutAt('ex20', bx, bx.length - 22, Mx) !== null);
      const lk = up.map((r, i) => i === 102 ? { ...r, open: A._floorTick(up[101].close * 1.1), high: A._floorTick(up[101].close * 1.1), low: A._floorTick(up[101].close * 1.1), close: A._floorTick(up[101].close * 1.1) } : r);
      ok('⑩ 隔天一整天鎖漲停 → 買不到(null);同一份隔天沒鎖 → 照算', A._colOutAt('ex20', lk, 101, Mx) === null && A._colOutAt('ex20', up, 101, Mx) !== null);
    }
    // ⑪ pool 的基準是「同一檔同一年」:前一年天天贏、後一年天天輸,事件只在前一年 → 事件 100%、同年基準 100%、全部日子 50%(決定性對照:⛔ 只跟全部日子比會以為事件比較好)
    { const bp = D.slice(0, 400).map(d => ({ date: d, close: 10 })), yr = i => D[i].slice(0, 4), y0 = yr(0);
      const St = { _colOccDef: () => ({ o: 'x', gap: 1 }), _colOutAt: (o, b, i) => yr(i) === y0 ? 1 : 0, _colEvAt: (id, b, i) => yr(i) === y0 && i % 10 === 0 ? {} : null };
      const r = aggregatePool([{ q: poolOcc(St, 'q', bp, '9999', new Map()) }], ['q']).q;
      ok('⑪ pool:事件只在贏的那一年 → p 100、同一檔同一年 100、全部日子 ≈ 50', r.p === 100 && r.sy === 100 && r.base > 40 && r.base < 70 && r.n > 10, JSON.stringify(r)); }
    { const mk = (s, k) => D.slice(0, 70).map((d, i) => ({ date: d, close: i === 69 ? (s === 'a' ? 11 : 9) : 10 }));
      const E = ewIndex(s => mk(s), Array.from({ length: 120 }, (_, i) => i ? 'b' + i : 'a')), E2 = ewIndex(s => mk(s), Array.from({ length: 99 }, (_, i) => 'c' + i));
      ok('⑪ 等權指數:平均日報酬;一天不到 100 檔不算', Math.abs(E.get(D[69]) - (1 + (0.1 - 0.1 * 119) / 120)) < 1e-9 && E2.size === 0, JSON.stringify([E.get(D[69]), E2.size])); }
    console.log(fails.length ? `❌ ${fails.length} 條失敗` : '✅ SELFTEST_PASS');
    process.exit(fails.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    if (process.argv.includes('--selftest')) selftest(); else main();
}
