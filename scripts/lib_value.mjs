/**
 * 💎 「價值 × 成長 × 週期」三個 strategy module 的唯一一份定義 —— V77.4.4
 *   (value_probe.mjs 與 portfolio_backtest.mjs 的 VAL= 濾網共用;⛔ 陷阱 #37:回測腳本⛔ 不可自己再寫一份)
 *
 * 來源:使用者貼的 54 節《不盯盤、不看線圖》規格。⭐ 先對表:安全邊際 / X 光機 / 價值陷阱 / 12 季趨勢 本站早就有;
 *      這裡只做三件**真的沒測過**的:① PB × ROE 交叉(資產價值)② 四項同步改善連續 N 季(收益價值)③ 個股自身低谷反轉(週期價值)
 *
 * 季序列(每季一筆,依公布日排序):
 *   bvps  = eq ÷ (cap ÷ 10)                          每股淨值(面額 10 假設,同 valuation_deep_probe:67 / fin_slice)
 *   roe4  = Σ ni(近 4 季) ÷ 期末 eq × 100            ⛔ 必須逐值等於 fin_slice.mjs 的 roe4(value_probe --selftest ⓪a 拿真實切片對表)
 *   ni    = 官方稅後淨利;沒有才 eps × 股數(同 fin_slice);par = 面額變更守門(同 fin_slice.mjs:75-81 那一條)→ 觸發那一季起 bvps/roe4/epsY 一律 NaN
 *   revY / gmY / epsY / fcfY = 跟**去年同季**比的差值(rev 用 %、其餘用差值 —— EPS/FCF 會負,⛔ 不用比值)
 *   fcf   = 單季 ocf + 單季 capex(capex 為負;ocf/capex 是**累計**欄 → 走 quarterValue 還原,⛔ 不憑印象)
 *   revQ / gmQ = 跟上一季比(週期反轉的 QoQ 版;⚠️ 季營收有季節性,Q1→Q2 會系統性誤亮 → cycleY 一律要並列)
 *   ttmPos12 = TTM 營收在自身近 12 個 TTM 裡的分位(0=最低)
 *   nImp  = 到這一季為止「四項(rev/gm/eps/fcf)同時比去年同季好」連續幾季;nDet = rev/gm/fcf 三項裡幾項比去年同季差
 *
 * 可用日 = `lib_fundamentals.pubDate`(法定截止日 5/15・8/14・11/14・3/31,保守,零前視)。
 * valueOnAt(series, day, kind, {close}) → true / false / **null**(缺欄位、還沒有任何一季、沒 close → 不知道;呼叫端剔除並計數)
 */
import { pubDate, detectCumulative, quarterValue } from './lib_fundamentals.mjs';

/** 景氣循環產業(產業代碼,= miner.py CYCLICAL_INDUSTRIES 那 9 類;⛔ 清單本身沒有回測背書,探針同時跑 @noncyc 證偽) */
export const CYC_IND = ['01', '03', '07', '09', '10', '11', '15', '21', '23'];
/** 變體:規格 §10 把半導體/光電/零組件也算週期 → 只當變體,⛔ 不進預設 */
export const CYC_IND_WIDE = [...CYC_IND, '24', '26', '28'];
export const FIN_IND = ['17'];   // 金融:PB<1 是常態,資產價值那一桶要另出 ex金融

export const KINDS = ['asset', 'asset2', 'asset3', 'earn', 'earn2', 'earn4', 'earnLo', 'cycle', 'cycleY', 'trap', 'ab', 'ac', 'bc', 'multi'];
/** 每個 kind 需要哪個模組(呼叫端拿來判「循環類要不要先問產業」) */
export const NEEDS = { asset: 'A', asset2: 'A', asset3: 'A', earn: 'B', earn2: 'B', earn4: 'B', earnLo: 'B', cycle: 'C', cycleY: 'C', trap: 'T', ab: 'AB', ac: 'AC', bc: 'BC', multi: 'ABC' };

const num = v => (v == null || !Number.isFinite(+v)) ? NaN : +v;

/** 一次算好欄位索引 + 哪些流量欄是累計(整份 fin_deep 只判一次;⛔ 每檔重判會慢 2,000 倍) */
export function valuePrep(FD) {
    const I = Object.fromEntries(FD.f.map((k, i) => [k, i]));
    const CUM = {}; for (const f of ['ocf', 'capex', 'rev', 'cogs']) CUM[f] = detectCumulative(FD, f);
    return { I, CUM };
}

/** fin_deep 一檔 → 依公布日排序的季序列;沒這檔回 null。prep 可省(自己算,慢) */
export function valueSeries(FD, sym, prep = null) {
    const rec = FD.s[sym]; if (!rec) return null;
    const P = prep || valuePrep(FD);
    const qs = Object.keys(rec).sort();
    const raw = (q, k) => { const j = P.I[k]; return j == null ? NaN : num((rec[q] || [])[j]); };
    const qv = (q, k) => num(quarterValue(FD, sym, q, k, P.CUM));   // 累計欄自動相減;找不到前一季 → NaN
    // ── 每季基礎值 ──
    const rows = qs.map(q => {
        const rev = qv(q, 'rev'), cogs = qv(q, 'cogs'), ocf = qv(q, 'ocf'), capex = qv(q, 'capex');
        const eq = raw(q, 'eq'), cap = raw(q, 'cap'), eps = raw(q, 'eps'), niOff = raw(q, 'ni');
        const shares = cap > 0 ? cap / 10 : NaN;
        const gm = (rev > 0 && Number.isFinite(cogs)) ? Math.round((rev - cogs) / rev * 1e6) / 1e4 : NaN;   // 四捨五入到 1e-4 pp:⛔ 浮點雜訊不可被當成「反轉」
        const ni = Number.isFinite(niOff) ? niOff : (Number.isFinite(eps) && shares > 0 ? eps * shares : NaN);
        const niSrc = Number.isFinite(niOff) ? 'fs' : (Number.isFinite(ni) ? 'eps' : null);
        const fcf = (Number.isFinite(ocf) && Number.isFinite(capex)) ? ocf + capex : NaN;
        return { p: q, pub: pubDate(q), rev, gm, eps, eq, cap, ni, niSrc, fcf, bvps: (eq > 0 && shares > 0) ? eq / shares : NaN, ttm: NaN };
    });
    // ── 面額變更守門(⛔ 同 fin_slice.mjs 那一條,一字不差的判式)——只在沒有官方淨利、只能 EPS×股數推的時候 ──
    let parQ = null;
    for (let i = 1; i < rows.length; i++) {
        const a = rows[i - 1], b = rows[i];
        if (a.eps > 0 && Number.isFinite(b.eps) && b.eps <= a.eps * 0.5 && a.rev > 0 && b.rev >= a.rev * 0.97 && Number.isFinite(a.gm) && Number.isFinite(b.gm) && b.gm >= a.gm - 1
            && a.cap > 0 && b.cap > 0 && Math.abs(b.cap / a.cap - 1) < 0.05 && b.niSrc === 'eps') { parQ = b.p; break; }
    }
    // ── 衍生欄 ──
    const out = [];
    for (let k = 0; k < rows.length; k++) {
        const r = rows[k]; if (!r.pub) continue;
        const par = !!(parQ && r.p >= parQ);
        const y4 = k >= 4 ? rows[k - 4] : null, q1 = k >= 1 ? rows[k - 1] : null;
        const sameQ = y4 && y4.p.slice(5) === r.p.slice(5);                 // 去年同季要真的是同一季(缺季時 k−4 可能不是)
        // TTM 營收 + 自身 12 個 TTM 分位
        let ttm = NaN; if (k >= 3) { let s = 0, ok = true; for (let j = k - 3; j <= k; j++) { if (!(rows[j].rev > 0)) { ok = false; break; } s += rows[j].rev; } if (ok) ttm = s; }
        r.ttm = ttm;
        let ttmPos12 = NaN; if (Number.isFinite(ttm)) { const hist = []; for (let j = Math.max(0, k - 11); j <= k; j++) if (Number.isFinite(rows[j].ttm)) hist.push(rows[j].ttm); if (hist.length >= 8) { let lo = 0; for (const v of hist) if (v < ttm) lo++; ttmPos12 = lo / (hist.length - 1); } }
        // ROE 近 4 季
        let roe4 = NaN; if (k >= 3 && r.eq > 0) { let s = 0, ok = true; for (let j = k - 3; j <= k; j++) { if (!Number.isFinite(rows[j].ni)) { ok = false; break; } s += rows[j].ni; } if (ok) roe4 = s / r.eq * 100; }
        const revY = (sameQ && r.rev > 0 && y4.rev > 0) ? (r.rev / y4.rev - 1) * 100 : NaN;
        const gmY = sameQ ? r.gm - y4.gm : NaN;
        const epsY = sameQ ? r.eps - y4.eps : NaN;
        const fcfY = sameQ ? r.fcf - y4.fcf : NaN;
        const revQ = (q1 && r.rev > 0 && q1.rev > 0) ? (r.rev / q1.rev - 1) * 100 : NaN;
        const gmQ = q1 ? r.gm - q1.gm : NaN;
        const imp4 = revY > 0 && gmY > 0 && epsY > 0 && fcfY > 0;
        const impKnown = [revY, gmY, epsY, fcfY].every(Number.isFinite);
        const prev = out.length ? out[out.length - 1] : null;
        const nImp = !impKnown ? NaN : (imp4 ? ((prev && Number.isFinite(prev.nImp) && prev.p === (k >= 1 ? rows[k - 1].p : '')) ? prev.nImp + 1 : 1) : 0);
        const detKnown = [revY, gmY, fcfY].every(Number.isFinite);
        const nDet = detKnown ? (revY < 0 ? 1 : 0) + (gmY < 0 ? 1 : 0) + (fcfY < 0 ? 1 : 0) : NaN;
        out.push({
            p: r.p, pub: r.pub, par, niSrc: r.niSrc,
            bvps: par ? NaN : r.bvps, roe4: par ? NaN : roe4, epsY: par ? NaN : epsY,
            rev: r.rev, gm: r.gm, fcf: r.fcf, ni: par ? NaN : r.ni,
            revY, gmY, fcfY, revQ, gmQ, ttmPos12,
            nImp: par ? NaN : nImp, nDet,
            // 只營收改善、其餘沒跟(低品質成長):rev 好 ∧ gm/eps/fcf 都沒有比去年同季好
            lowQ: impKnown ? (revY > 0 && !(gmY > 0) && !(epsY > 0) && !(fcfY > 0)) : null,
        });
    }
    return out.sort((a, b) => a.pub < b.pub ? -1 : 1);
}

/** 那一天「已經公布」的最後一季;沒有回 null。⭐ 回測一律用這支,⛔ 不可拿季別當可用日 */
export function valueKnownAt(series, day) {
    if (!series || !series.length) return null;
    let best = null;
    for (const q of series) { if (q.pub <= day) best = q; else break; }
    return best;
}

/** 資產價值三級(規格 §2):PB 用**訊號日收盤**;回 true/false/null */
export function assetAt(q, close, level = 1) {
    if (!q || !(close > 0) || !(q.bvps > 0) || !Number.isFinite(q.roe4)) return null;
    const pb = close / q.bvps;
    if (level === 3) return pb <= 0.5 && q.roe4 > 30;
    if (level === 2) return pb <= 0.5 && q.roe4 > 15;
    return pb <= 0.8 && q.roe4 > 10;
}
/** 收益價值:四項同步改善連續 ≥ n 季(規格 §6/§7;「12 季同步」照字面幾乎空集合 → 台股調適成 1/2/4) */
export function earnAt(q, n = 1) {
    if (!q || !Number.isFinite(q.nImp)) return null;
    return q.nImp >= n;
}
/** 週期價值:自身 TTM 營收在近 12 個 TTM 的低谷(≤ pos)∧ 最新季 rev 與 gm 同時反轉(yoy=true 比去年同季;否則比上一季) */
export function cycleAt(q, { pos = 0.25, yoy = false } = {}) {
    if (!q || !Number.isFinite(q.ttmPos12)) return null;
    const dr = yoy ? q.revY : q.revQ, dg = yoy ? q.gmY : q.gmQ;
    if (!Number.isFinite(dr) || !Number.isFinite(dg)) return null;
    return q.ttmPos12 <= pos && dr > 0 && dg > 0;
}
/** 價值陷阱(規格 §19):便宜(PB ≤ 0.8)∧ rev/gm/fcf 三項都比去年同季差 */
export function trapAt(q, close, nDet = 3) {
    if (!q || !(close > 0) || !(q.bvps > 0) || !Number.isFinite(q.nDet)) return null;
    return close / q.bvps <= 0.8 && q.nDet >= nDet;
}

/** 那天 kind 亮不亮:true / false / null(不知道)。opt.close = 訊號日收盤(asset/trap/ab/ac/multi 必須給,沒給 → null) */
export function valueOnAt(series, day, kind, opt = {}) {
    const q = valueKnownAt(series, day);
    if (!q) return null;
    const c = opt.close;
    const and = (...vs) => vs.some(v => v === null) ? null : vs.every(Boolean);
    switch (kind) {
        case 'asset': return assetAt(q, c, 1);
        case 'asset2': return assetAt(q, c, 2);
        case 'asset3': return assetAt(q, c, 3);
        case 'earn': return earnAt(q, 1);
        case 'earn2': return earnAt(q, 2);
        case 'earn4': return earnAt(q, 4);
        case 'earnLo': return q.lowQ == null ? null : q.lowQ;
        case 'cycle': return cycleAt(q, { pos: 0.25, yoy: false });
        case 'cycleY': return cycleAt(q, { pos: 0.25, yoy: true });
        case 'trap': return trapAt(q, c, 3);
        case 'ab': return and(assetAt(q, c, 1), earnAt(q, 1));
        case 'ac': return and(assetAt(q, c, 1), cycleAt(q, { pos: 0.25, yoy: true }));
        case 'bc': return and(earnAt(q, 1), cycleAt(q, { pos: 0.25, yoy: true }));
        case 'multi': return and(assetAt(q, c, 1), earnAt(q, 1), cycleAt(q, { pos: 0.25, yoy: true }));
        default: throw new Error(`valueOnAt: 不認得的 kind ${kind}`);
    }
}
