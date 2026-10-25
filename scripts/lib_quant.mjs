#!/usr/bin/env node
/**
 * 📐 V79.9.0 量化實驗室的核心:策略 = 一段 JSON(積木),解譯器只有這一份
 *   用的人:scripts/quant_lab_build.mjs(16 年全市場定案)・pro.html「📐 量化實驗室」沙盒(瀏覽器近 3 年)
 *   ⭐ pro.html 的 QCORE 區塊由 scripts/embed_quant_lab.mjs 從下面「QCORE BEGIN ~ END」原封不動抄過去,
 *      scripts/test_quant_core.mjs 逐字比對 —— ⛔ 改一邊不改另一邊。
 *   ⛔ 三條:① 每個指標只用第 i 根(含)以前的資料(爆量 / 新高的基準⛔ 含第 i 根自己,陷阱 #43)
 *            ② 法人 / 融資當天收盤後才公布 → 第 i 根的訊號最快第 i+1 根收盤才買(進場規則在呼叫端)
 *               月營收:那個月的下個月 10 號之後第一個交易日才算「已公布」
 *            ③ 認不得的積木一律 throw(打錯字安靜地「永遠不成立」= 假的「沒用」)
 *   KD = index.html masterWorker 同一條(9 日、1/3 平滑、第 8 根從 50 起算)・RSI = 同一支 Wilder 平滑
 *   跑法:node scripts/lib_quant.mjs --selftest
 */
// ==QCORE BEGIN==
const QCORE = (() => {
    const VER = 1;
    /** 積木清單(畫面上的下拉選單也讀這份):id → [中文名, 參數說明, 需要的資料] */
    const BLOCKS = {
        c: ['收盤價', '', 'k'], o: ['開盤價', '', 'k'], h: ['最高價', '', 'k'], l: ['最低價', '', 'k'], v: ['成交量(張)', '', 'k'],
        num: ['數字', 'v = 數值', ''],
        ma: ['N 日均線', 'n', 'k'], ema: ['N 日指數均線', 'n', 'k'],
        rsi: ['RSI', 'n', 'k'], k: ['KD 的 K', '', 'k'], d: ['KD 的 D', '', 'k'],
        bias: ['乖離率 %(收盤比 N 日均線)', 'n', 'k'],
        chg: ['N 日漲跌 %', 'n', 'k'], gap: ['今天開盤跳空 %(比昨收)', '', 'k'],
        hhv: ['前 N 日最高價(⛔ 不含今天)', 'n', 'k'], llv: ['前 N 日最低價(⛔ 不含今天)', 'n', 'k'],
        hhc: ['前 N 日最高收盤(⛔ 不含今天)', 'n', 'k'],
        volr: ['成交量 ÷ 前 N 日均量(⛔ 不含今天)', 'n', 'k'],
        fstreak: ['外資連續買超天數', '', 'inst'], tstreak: ['投信連續買超天數', '', 'inst'],
        finst: ['三大法人 N 日買超 ÷ 成交量 %', 'n', 'inst'],
        mgchg: ['融資 N 日增減 %', 'n', 'mg'],
        revhi: ['月營收創 N 個月新高(已公布的;1 = 是)', 'n', 'rev'],
        idxc: ['加權指數收盤', '', 'idx'], idxma: ['加權指數 N 日均線', 'n', 'idx'],
    };
    const OPS = ['>', '<', '>=', '<=', 'xup', 'xdn'];
    const num = x => (x == null || x === '' ? NaN : +x);

    /** 一檔的 K 線 → 指標快取(lazy;同一個 key 只算一次)。bars:[{date,open,high,low,close,volume,foreign_net,...}]
     *  ctx:{ idx:Map(日期→加權收盤), rev:[{ym:'2020-03', v}] } */
    function series(bars, ctx) {
        ctx = ctx || {};
        const n = bars.length, C = bars.map(r => num(r.close)), O = bars.map(r => num(r.open)), H = bars.map(r => num(r.high)), L = bars.map(r => num(r.low));
        const V = bars.map(r => num(r.volume) / 1000);
        const D = bars.map(r => String(r.date || '').replace(/\//g, '-').slice(0, 10));
        const cache = new Map();
        const memo = (key, fn) => { if (!cache.has(key)) cache.set(key, fn()); return cache.get(key); };
        const sma = (arr, p) => { const out = new Array(n).fill(null); let s = 0, m = 0; for (let i = 0; i < n; i++) { const x = arr[i]; s += Number.isFinite(x) ? x : 0; m += Number.isFinite(x) ? 1 : 0; if (i >= p) { const y = arr[i - p]; s -= Number.isFinite(y) ? y : 0; m -= Number.isFinite(y) ? 1 : 0; } if (i >= p - 1 && m === p) out[i] = s / p; } return out; };
        const kd = () => memo('kd', () => {
            const k = new Array(n).fill(null), d = new Array(n).fill(null); let pk = 50, pd = 50;
            for (let i = 8; i < n; i++) {
                let hh = -Infinity, ll = Infinity; for (let j = i - 8; j <= i; j++) { hh = Math.max(hh, H[j]); ll = Math.min(ll, L[j]); }
                const rsv = hh === ll ? 50 : (C[i] - ll) / (hh - ll) * 100;
                pk = (2 / 3) * pk + (1 / 3) * rsv; pd = (2 / 3) * pd + (1 / 3) * pk; k[i] = pk; d[i] = pd;
            }
            return { k, d };
        });
        const streak = f => memo('st_' + f, () => { const out = new Array(n).fill(null); let s = 0; for (let i = 0; i < n; i++) { const x = bars[i][f]; if (x == null || !Number.isFinite(+x)) { s = 0; out[i] = null; continue; } s = +x > 0 ? s + 1 : 0; out[i] = s; } return out; });
        const revAt = p => memo('rev_' + p, () => {
            const out = new Array(n).fill(null), R = (ctx.rev || []).filter(x => x && /^\d{4}-\d{2}$/.test(x.ym) && +x.v > 0).sort((a, b) => a.ym < b.ym ? -1 : 1);
            if (!R.length) return out;
            // 那個月的營收「可以用」= 下個月 10 號之後(⛔ 含 10 號當天)第一個交易日
            const avail = R.map(x => { const [y, m] = x.ym.split('-').map(Number); const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1; return `${ny}-${String(nm).padStart(2, '0')}-10`; });
            let j = -1;
            for (let i = 0; i < n; i++) {
                while (j + 1 < R.length && avail[j + 1] < D[i]) j++;
                if (j < p - 1) continue;
                let hi = -Infinity; for (let q = j - p + 1; q < j; q++) hi = Math.max(hi, +R[q].v);
                out[i] = +R[j].v > hi ? 1 : 0;
            }
            return out;
        });
        /** 取一個積木的整條序列 */
        function get(op) {
            if (typeof op === 'number') return new Array(n).fill(op);
            const f = op && op.f, p = op && op.n != null ? +op.n : null;
            if (!(f in BLOCKS)) throw new Error(`QCORE:認不得的積木 '${f}'`);
            const needN = () => { if (!(p >= 1 && p <= 2000 && Number.isInteger(p))) throw new Error(`QCORE:積木 '${f}' 要給整數 n(1~2000),拿到 ${op.n}`); return p; };
            switch (f) {
                case 'num': { const v = +op.v; if (!Number.isFinite(v)) throw new Error('QCORE:num 要給 v'); return new Array(n).fill(v); }
                case 'c': return C; case 'o': return O; case 'h': return H; case 'l': return L; case 'v': return V;
                case 'ma': return memo('ma' + needN(), () => sma(C, p));
                case 'ema': return memo('ema' + needN(), () => { const out = new Array(n).fill(null), kf = 2 / (p + 1); if (n < p) return out; let s = 0; for (let i = 0; i < p; i++) s += C[i]; s /= p; out[p - 1] = s; for (let i = p; i < n; i++) { s = C[i] * kf + s * (1 - kf); out[i] = s; } return out; });
                case 'rsi': return memo('rsi' + needN(), () => {
                    const out = new Array(n).fill(null); let ag = 0, al = 0;
                    for (let i = 1; i < n; i++) {
                        const ch = C[i] - C[i - 1], g = ch > 0 ? ch : 0, lo = ch < 0 ? -ch : 0;
                        if (i <= p) { ag += g; al += lo; if (i === p) { ag /= p; al /= p; out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); } }
                        else { ag = (ag * (p - 1) + g) / p; al = (al * (p - 1) + lo) / p; out[i] = al === 0 ? (ag === 0 ? 50 : 100) : 100 - 100 / (1 + ag / al); }
                    }
                    return out;
                });
                case 'k': return kd().k; case 'd': return kd().d;
                case 'bias': { const m = get({ f: 'ma', n: needN() }); return memo('bias' + p, () => C.map((c, i) => m[i] > 0 ? (c - m[i]) / m[i] * 100 : null)); }
                case 'chg': return memo('chg' + needN(), () => C.map((c, i) => i >= p && C[i - p] > 0 ? (c / C[i - p] - 1) * 100 : null));
                case 'gap': return memo('gap', () => O.map((o, i) => i >= 1 && C[i - 1] > 0 && o > 0 ? (o / C[i - 1] - 1) * 100 : null));
                case 'hhv': case 'llv': case 'hhc': return memo(f + needN(), () => {
                    const src = f === 'llv' ? L : f === 'hhc' ? C : H, out = new Array(n).fill(null);
                    for (let i = p; i < n; i++) { let x = f === 'llv' ? Infinity : -Infinity; for (let j = i - p; j < i; j++) x = f === 'llv' ? Math.min(x, src[j]) : Math.max(x, src[j]); out[i] = Number.isFinite(x) ? x : null; }
                    return out;
                });
                case 'volr': return memo('volr' + needN(), () => { const out = new Array(n).fill(null); for (let i = p; i < n; i++) { let s = 0; for (let j = i - p; j < i; j++) s += V[j]; out[i] = s > 0 ? V[i] / (s / p) : null; } return out; });
                case 'fstreak': return streak('foreign_net');
                case 'tstreak': return streak('trust_net');
                case 'finst': return memo('finst' + needN(), () => {
                    const out = new Array(n).fill(null);
                    for (let i = p - 1; i < n; i++) { let f2 = 0, v2 = 0, ok = true; for (let j = i - p + 1; j <= i; j++) { const r = bars[j]; if (r.foreign_net == null || r.trust_net == null || r.dealer_net == null) { ok = false; break; } f2 += +r.foreign_net + +r.trust_net + +r.dealer_net; v2 += +r.volume || 0; } out[i] = ok && v2 > 0 ? f2 / v2 * 100 : null; }
                    return out;
                });
                case 'mgchg': return memo('mg' + needN(), () => bars.map((r, i) => { if (i < p) return null; const a = +bars[i - p].margin_balance, b = +r.margin_balance; return a > 0 && b > 0 ? (b / a - 1) * 100 : null; }));
                case 'revhi': return revAt(needN());
                case 'idxc': return memo('idxc', () => D.map(d => { const x = ctx.idx && ctx.idx.get(d); return x > 0 ? +x : null; }));
                case 'idxma': return memo('idxma' + needN(), () => { const s = get({ f: 'idxc' }); return sma(s.map(x => x == null ? NaN : x), p); });
            }
            throw new Error(`QCORE:積木 '${f}' 沒有實作`);
        }
        return { get, n, D };
    }
    /** 一條條件在第 i 根成不成立(任何一邊沒有值 → false) */
    function condAt(S, c, i) {
        if (!OPS.includes(c.op)) throw new Error(`QCORE:認不得的比較 '${c.op}'`);
        const A = S.get(c.a), B = S.get(c.b);
        const a = A[i], b = B[i];
        if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
        switch (c.op) {
            case '>': return a > b; case '<': return a < b; case '>=': return a >= b; case '<=': return a <= b;
            case 'xup': case 'xdn': { if (i < 1) return false; const a0 = A[i - 1], b0 = B[i - 1]; if (!Number.isFinite(a0) || !Number.isFinite(b0)) return false; return c.op === 'xup' ? a > b && a0 <= b0 : a < b && a0 >= b0; }
        }
        return false;
    }
    /** 策略檢查(⛔ 不合格的一律 throw,回傳正規化過的策略) */
    function check(st) {
        if (!st || typeof st !== 'object') throw new Error('QCORE:策略要是物件');
        const all = Array.isArray(st.all) ? st.all : [], any = Array.isArray(st.any) ? st.any : [];
        if (!all.length && !any.length) throw new Error('QCORE:策略至少要一條條件');
        for (const c of [...all, ...any]) { if (!c || !OPS.includes(c.op)) throw new Error(`QCORE:認不得的比較 '${c && c.op}'`); for (const x of [c.a, c.b]) if (typeof x !== 'number' && !(x && x.f in BLOCKS)) throw new Error(`QCORE:認不得的積木 '${x && x.f}'`); }
        const gap = st.gap == null ? 10 : +st.gap;
        if (!(gap >= 1 && gap <= 250)) throw new Error('QCORE:gap 要在 1~250');
        return { ...st, all, any, gap };
    }
    /** 一檔 → 訊號日(第 i 根收盤後判斷成立;同一檔 gap 根內只算第一次)。回傳 index 陣列 */
    function signals(st, bars, ctx) {
        const P = check(st), S = series(bars, ctx), out = []; let last = -1e9;
        for (let i = 1; i < S.n; i++) {
            if (i - last < P.gap) continue;
            if (!P.all.every(c => condAt(S, c, i))) continue;
            if (P.any.length && !P.any.some(c => condAt(S, c, i))) continue;
            out.push(i); last = i;
        }
        return out;
    }
    /** 需要哪幾種資料(畫面用來講「近 3 年沒有月營收 → 這條沙盒跑不了」) */
    function needs(st) { const P = check(st), s = new Set(); for (const c of [...P.all, ...P.any]) for (const x of [c.a, c.b]) if (typeof x !== 'number' && BLOCKS[x.f][2]) s.add(BLOCKS[x.f][2]); return [...s]; }
    /** 白話:「KD 的 K 由下往上穿過 KD 的 D,且 KD 的 K < 30」 */
    function describe(st) {
        const P = check(st), nm = x => typeof x === 'number' ? String(x) : x.f === 'num' ? String(x.v) : BLOCKS[x.f][0].replace('N 日', `${x.n} 日`).replace('N 個月', `${x.n} 個月`).replace('前 N 日', `前 ${x.n} 日`).replace('÷ 前 N 日', `÷ 前 ${x.n} 日`);
        const opw = { '>': '>', '<': '<', '>=': '≥', '<=': '≤', xup: '由下往上穿過', xdn: '由上往下穿過' };
        const one = c => `${nm(c.a)} ${opw[c.op]} ${nm(c.b)}`;
        const a = P.all.map(one).join(',且 '), b = P.any.map(one).join(',或 ');
        return [a, b ? `(${b})` : ''].filter(Boolean).join(',且 ');
    }
    return { VER, BLOCKS, OPS, series, condAt, check, signals, needs, describe };
})();
// ==QCORE END==

export default QCORE;
export const { VER, BLOCKS, OPS, series, condAt, check, signals, needs, describe } = QCORE;

function selftest() {
    const fails = []; const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + e}`); if (!c) fails.push(n); };
    const days = (n, y0 = 2020) => { const D = []; let t = Date.UTC(y0, 0, 2); while (D.length < n) { const d = new Date(t); if (d.getUTCDay() % 6) D.push(d.toISOString().slice(0, 10)); t += 864e5; } return D; };
    const D = days(300); let seed = 3; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    let c = 100; const bars = D.map((d, i) => { const p = c; c = +(p * (1 + (rnd() - 0.5) * 0.06)).toFixed(2); return { date: d, open: p, high: Math.max(p, c) * 1.01, low: Math.min(p, c) * 0.99, close: c, volume: 1000 * (1 + (i === 150 ? 5 : rnd())), foreign_net: i >= 100 && i <= 106 ? 500 : -1, trust_net: 0, dealer_net: 0, margin_balance: 1000 + i }; });
    const S = series(bars);
    // ① 均線 / 乖離 / 新高基準不含今天
    const ma5 = S.get({ f: 'ma', n: 5 }); ok('① ma5 第 4 根 = 前 5 根平均', Math.abs(ma5[4] - (bars.slice(0, 5).reduce((a, r) => a + r.close, 0) / 5)) < 1e-9 && ma5[3] === null);
    const hh = S.get({ f: 'hhc', n: 20 }); ok('① 前 20 日最高收盤⛔ 含今天(陷阱 #43)', hh[50] === Math.max(...bars.slice(30, 50).map(r => r.close)));
    const nh = bars.findIndex((r, i) => i >= 40 && bars.slice(i - 20, i).every(x => x.close < r.close));
    ok('① 創 20 日新高那天:前 20 日最高收盤 < 今天收盤(含今天的話會相等 = 永遠不會「突破」)', nh > 0 && hh[nh] < bars[nh].close, nh);
    const vr = S.get({ f: 'volr', n: 20 }); ok('① 量比基準⛔ 含今天(第 150 根爆 6 倍 → 量比 > 3)', vr[150] > 3 && vr[150] === (bars[150].volume / 1000) / (bars.slice(130, 150).reduce((a, r) => a + r.volume / 1000, 0) / 20));
    // ② 外資連買天數
    const fs = S.get({ f: 'fstreak' }); ok('② 外資連買 7 天(100~106)→ 第 106 根 = 7、第 107 根 = 0', fs[106] === 7 && fs[107] === 0 && fs[99] === 0);
    // ③ 交叉 / 去重
    const st = { all: [{ a: { f: 'fstreak' }, op: '>=', b: 5 }], gap: 10 };
    ok('③ 外資連買 ≥5 天:第 104~106 都成立,gap 10 → 只算第 104 根', JSON.stringify(signals(st, bars)) === '[104]', JSON.stringify(signals(st, bars)));
    ok('③ gap 1 → 104 / 105 / 106 三根', JSON.stringify(signals({ ...st, gap: 1 }, bars)) === '[104,105,106]');
    const xs = signals({ all: [{ a: { f: 'k' }, op: 'xup', b: { f: 'd' } }], gap: 1 }, bars), K = S.get({ f: 'k' }), Dd = S.get({ f: 'd' });
    ok('③ K 由下往上穿過 D:每一個訊號日前一天 K ≤ D、當天 K > D', xs.length > 5 && xs.every(i => K[i] > Dd[i] && K[i - 1] <= Dd[i - 1]), xs.length);
    // ④ ⛔ 前視:第 i 根之後換成亂數,每個積木第 i 根的值不變
    let bad = [];
    const keys = [{ f: 'ma', n: 20 }, { f: 'ema', n: 12 }, { f: 'rsi', n: 14 }, { f: 'k' }, { f: 'd' }, { f: 'bias', n: 20 }, { f: 'chg', n: 5 }, { f: 'gap' }, { f: 'hhv', n: 20 }, { f: 'llv', n: 20 }, { f: 'hhc', n: 60 }, { f: 'volr', n: 20 }, { f: 'fstreak' }, { f: 'finst', n: 5 }, { f: 'mgchg', n: 5 }];
    for (const i of [60, 120, 200, 260]) {
        const cut = bars.slice(0, i + 1).concat(Array.from({ length: 20 }, (_, j) => ({ ...bars[i], date: D[Math.min(299, i + 1 + j)], open: 1, high: 999, low: 0.5, close: 3, volume: 9e9, foreign_net: -9e9 })));
        const S2 = series(cut);
        for (const k of keys) { const a = S.get(k)[i], b = S2.get(k)[i]; if (!(a === b || (Number.isNaN(a) && Number.isNaN(b)))) bad.push(`${k.f}${k.n || ''}@${i}`); }
    }
    ok('④ ⛔ 前視:第 i 根之後換成亂數,15 種積木第 i 根的值都不變', !bad.length, bad.slice(0, 5).join(','));
    // ⑤ 月營收:10 號之後第一個交易日才算公布
    const rev = [{ ym: '2019-12', v: 10 }, { ym: '2020-01', v: 9 }, { ym: '2020-02', v: 11 }, { ym: '2020-03', v: 12 }];
    const S3 = series(bars, { rev }), rh = S3.get({ f: 'revhi', n: 3 });
    const iMar10 = D.findIndex(d => d >= '2020-03-10'), iMar11 = D.findIndex(d => d > '2020-03-10'), iApr = D.findIndex(d => d > '2020-04-10');
    ok('⑤ 2 月營收(3 個月新高)3/10 當天還不能用、3/10 之後第一個交易日才是 1', rh[iMar10] !== 1 && rh[iMar11] === 1, JSON.stringify([D[iMar10], rh[iMar10], D[iMar11], rh[iMar11]]));
    ok('⑤ 3 月營收也創新高 → 4/10 之後仍是 1;前 2 個月還沒滿 3 個月 → null', rh[iApr] === 1 && rh[D.findIndex(d => d > '2020-02-10')] === null);
    // ⑥ 打錯字 throw
    let thrown = 0; for (const bad2 of [{ all: [{ a: { f: 'mma', n: 5 }, op: '>', b: 1 }] }, { all: [{ a: { f: 'ma', n: 5 }, op: '=>', b: 1 }] }, { all: [{ a: { f: 'ma' }, op: '>', b: 1 }] }, {}]) { try { signals(bad2, bars); } catch (_) { thrown++; } }
    ok('⑥ 認不得的積木 / 比較 / 少參數 / 沒條件 → throw', thrown === 4, thrown);
    // ⑦ KD 跟 index.html masterWorker 同一條(第 8 根從 50 起算)
    const k8 = (() => { let hh = -Infinity, ll = Infinity; for (let j = 0; j <= 8; j++) { hh = Math.max(hh, bars[j].high); ll = Math.min(ll, bars[j].low); } const rsv = hh === ll ? 50 : (bars[8].close - ll) / (hh - ll) * 100; return (2 / 3) * 50 + rsv / 3; })();
    ok('⑦ KD:第 8 根 K = 2/3×50 + RSV/3、第 7 根沒有值', Math.abs(K[8] - k8) < 1e-9 && K[7] === null);
    ok('⑧ 白話描述', describe({ all: [{ a: { f: 'k' }, op: 'xup', b: { f: 'd' } }, { a: { f: 'k' }, op: '<', b: 30 }] }) === 'KD 的 K 由下往上穿過 KD 的 D,且 KD 的 K < 30', describe({ all: [{ a: { f: 'k' }, op: 'xup', b: { f: 'd' } }, { a: { f: 'k' }, op: '<', b: 30 }] }));
    ok('⑧ 需要的資料', JSON.stringify(needs({ all: [{ a: { f: 'fstreak' }, op: '>=', b: 5 }, { a: { f: 'revhi', n: 12 }, op: '>=', b: 1 }] })) === '["inst","rev"]');
    console.log(fails.length ? `❌ ${fails.length} 條失敗` : '✅ SELFTEST_PASS');
    process.exit(fails.length ? 1 : 0);
}
if (typeof process !== 'undefined' && process.argv && process.argv.includes('--selftest')) selftest();
