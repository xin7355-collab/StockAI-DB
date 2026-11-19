#!/usr/bin/env node
/**
 * 🧠 V82.5.5 產業作戰室「🧠 人性」頁的數字(使用者 11/18:「App 太理性 —— 貪婪與恐懼、大戶外資的角度、匯率風向」)
 *
 * ⛔ 只描述:⛔ 合成總分、⛔ 下買賣指令、⛔ 用紅綠講好壞。每一條 = 今天的值 + 那個值的資料日 + 在它自己的歷史排第幾 + 歷史起訖
 *   + 實測總表(pro.html PRO.LAB)那一條的主題鍵 lab(頁面只轉述那一條的結論,⛔ 這裡另寫結論)。
 * 資料原則:
 *   ① 今天的值 ← 每天都會更新的檔(macro_risk / risk_history / breadth / attention_history / ^TWII / screener);
 *      長歷史只拿來算排第幾(fi_mkt_hist / taifex_hist 只有手動補挖,停在哪天就寫哪天、標 stale)。
 *   ② 兩份來源接在一起之前,先比重疊那段的值(陷阱 #17:同名不同單位 / 不同算法)→ 對不上那條就不接、進 miss 寫原因。
 *      實例:risk_history.retail_ls_pct 跟 taifex_hist.rl[3] 名字都叫散戶多空比,數字完全對不上 → 分開,只用前者自己的 90 天。
 *   ③ 讀不到 / 算不出來 → miss 寫原因(⛔ 當 0、⛔ 默默不顯示)。
 *   ④ ⛔ 加總 risk_history 的每日外資(快照有時晚一天、會重複 —— 陷阱 #16)→ 外資只給官方的「今天」與「本月累計」。
 * 心理狀態 = psych_state_probe 的 states()(⛔ 抄一份規則);加權 = lib_crash.loadIndex(idx_long_early + idx_long + ^TWII)。
 * 另寫 mood_hist.json:每天一列原始值(短歷史的那幾條之後才有長歷史可以排);同一天後跑的蓋前面;讀壞 ⛔ 寫回(exit 1)。
 *
 * 跑法:node scripts/mood_build.mjs <data 目錄> <out mood.json> [<mood_hist.json>]
 *       node scripts/mood_build.mjs --selftest
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadIndex } from './lib_crash.mjs';
import { states, ZH, STATE_RULES } from './psych_state_probe.mjs';
import { NSF } from './stopfall_probe.mjs';
import { NSF_EXIT } from './nsf_probe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MIN_N = 20;          // 歷史不到 20 天 → 不給排第幾(只寫「還在累積」)
export const STALE_D = 4;   // 比加權最新那天舊幾個日曆天就算停了(同畫面 ≥4 天轉黃 ⚠️ 那條)
export const HIST_MAX = 5000;     // mood_hist 最多留幾列
export const FI_WIN = 750;        // 外資 / 投信買賣超只跟近 3 年比(早年規模小,整段比不公平)
const r2 = x => x == null || !isFinite(x) ? null : Math.round(x * 100) / 100;
const d10 = s => s == null ? null : (/^\d{8}$/.test(String(s)) ? `${String(s).slice(0, 4)}-${String(s).slice(4, 6)}-${String(s).slice(6, 8)}` : String(s).replace(/\//g, '-').slice(0, 10));
const num = v => (v == null || v === '' || !isFinite(+v)) ? null : +v;
const med = a => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); if (!b.length) return null; const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };

/** 今天的值在「歷史 + 今天」裡排第幾:≤ 它的比例 × 100(含今天;同 psych_state_probe.expPct 的口徑)。歷史不夠 → pct null */
export function rankPct(hist, v) {
    const a = (hist || []).filter(Number.isFinite);
    if (!Number.isFinite(v)) return { pct: null, n: a.length };
    const all = [...a, v], n = all.length;
    if (n < MIN_N) return { pct: null, n };
    // ⭐ 同分算一半(mid-rank):跌停家數 / 注意股家數這種整數很多天一樣(例:一半的日子是 0),
    //   「≤ 今天」會把一樣的日子算成比較低 → 寫出「比 65% 的日子高」其實只是一樣(⛔)。
    //   lo / hi = 真的比較低 / 比較高的比例 → 畫面的字只用這兩個(⛔ 用 pct 講「比 X% 高」)
    const lo = all.filter(x => x < v).length, hi = all.filter(x => x > v).length;
    return { pct: r2((lo + (n - lo - hi) / 2) / n * 100), n, lo: r2(lo / n * 100), hi: r2(hi / n * 100) };
}

/** 讀 JSON:{j} 或 {err: 原因}(⛔ 丟例外 —— 一份讀不到不拖垮整頁) */
function rdj(dir, f) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) return { err: `讀不到 ${f}(檔案不在)` };
    try { return { j: JSON.parse(fs.readFileSync(p, 'utf8')) }; } catch (e) { return { err: `讀不到 ${f}(${String(e.message || e).slice(0, 60)})` }; }
}

/** 兩份來源同一個欄位,重疊那幾天比一比:同單位才接(中位數相對差 < tol);重疊不到 minN 天 → 不知道(也不接) */
export function sameUnit(a, b, tol = 0.02, minN = 5) {
    const ks = Object.keys(a).filter(k => k in b && Number.isFinite(a[k]) && Number.isFinite(b[k]) && b[k] !== 0);
    if (ks.length < minN) return { ok: false, n: ks.length, why: `重疊只有 ${ks.length} 天,比不出單位` };
    const rel = med(ks.map(k => Math.abs(a[k] - b[k]) / Math.abs(b[k])));
    return rel < tol ? { ok: true, n: ks.length, rel: r2(rel * 100) } : { ok: false, n: ks.length, rel: r2(rel * 100), why: `重疊 ${ks.length} 天的值差中位數 ${r2(rel * 100)}%(單位或算法不一樣)` };
}

// ───────── 💱 V82.5.6 FRED 每日歷史(data/fred_hist.json,scripts/fred_hist_miner.py)─────────
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const dayGap = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
/** FRED 那一條 → 由舊到新 [[iso, 值]];before(不含)之前的 */
export function fredPts(FH, key, before) {
    const s = FH && FH[key];
    if (!s || !s.d) return [];
    return Object.entries(s.d).filter(([d, v]) => (!before || d < before) && Number.isFinite(+v)).map(([d, v]) => [d, +v]).sort((a, b) => a[0] < b[0] ? -1 : 1);
}
/** 今天的值跟歷史最後一筆是不是同一把尺(陷阱 #17):abs = 差幾個點以內(殖利率),否則差幾成以內 */
export function sameLevel(v, last, tol, abs = false) {
    if (!Number.isFinite(v) || !Number.isFinite(last) || last === 0) return false;
    return abs ? Math.abs(v - last) <= tol : Math.abs(v / last - 1) <= tol;
}
/** 20 日變化(%)= 今天 ÷「28 個日曆天前(含)最近那一筆」− 1;那一筆離 28 天前超過 10 天(斷太久)→ null */
export function chg20(pts, v, asOf, days = 28) {
    const cut = addDays(asOf, -days);
    let base = null, bd = null;
    for (const [d, x] of pts) { if (d <= cut) { base = x; bd = d; } else break; }
    if (!Number.isFinite(base) || base === 0 || dayGap(bd, cut) > 10) return null;
    return r2((v / base - 1) * 100);
}
/** 一年位置 = 過去 365 個日曆天(不含今天)+ 今天 → rankPct(同分算一半 + lo / hi) */
export function yearPos(pts, v, asOf) {
    const cut = addDays(asOf, -365), P = pts.filter(([d]) => d > cut && d < asOf);
    const R = rankPct(P.map(([, x]) => x), v);
    return { ...R, from: P.length ? P[0][0] : null, to: asOf };
}
// macro_risk 的 key → [FRED 那一條, 同一把尺的容許差, 是不是用「差幾個點」]
//   ⛔ 油價不接:總經風險檔的油價是期貨近月(CL=F)、FRED 是現貨(DCOILWTICO)—— 11/19 實測差 7%(現貨 89.5 vs 期貨 83.3),
//     接在一起 20 日會被算成 −24%(只看現貨是 −18%)= 陷阱 #17 → 油價只用 App 自己每天存的(同一個來源)
export const FX_FRED = { usdtwd: ['usdtwd', 0.05, false], jpy: ['jpy', 0.05, false], krw: ['krw', 0.05, false], cny: ['cny', 0.05, false],
    ust10y: ['ust10y', 0.5, true], us2y_yield: ['us2y', 0.5, true], btc_usd: ['btc', 0.15, false] };
export const FRED_MAX_LAG = 45;   // FRED 最後一筆比今天舊超過幾天就不接(歷史斷太久)

/** 一條量條 */
function gauge(k, name, side, v, unit, d, hist, lab, extra = {}) {
    const R = rankPct(hist.vals, v);
    return { k, name, side, v: r2(v), unit, d: d10(d), pct: R.pct, lo: R.lo ?? null, hi: R.hi ?? null, n: R.n, from: hist.from || null, to: hist.to || null, lab: lab || null, ...extra };
}

/** 心理狀態:最後一天的狀態、從哪天開始、連續幾天、D / V / M、最近 250 天各狀態幾天 */
export function stateOf(S) {
    const { st, F } = states(S);
    let i = st.length - 1; while (i >= 0 && !st[i]) i--;
    if (i < 0) return null;
    let j = i; while (j > 0 && st[j - 1] === st[i]) j--;
    const cnt = {}; for (let k = Math.max(0, i - 249); k <= i; k++) if (st[k]) cnt[st[k]] = (cnt[st[k]] || 0) + 1;
    return { k: st[i], zh: ZH[st[i]], d: S.d[i], since: S.d[j], days: i - j + 1, D: r2(F.D[i]), V: r2(F.V[i]), M: r2(F.M[i]), vol: r2(F.vol[i]), last250: cnt, rules: STATE_RULES, names: ZH, lab: 'psych-state', _i: i, _F: F };
}

/** 主程式:dir = data 目錄;prevHist = 舊的 mood_hist(陣列);now = 產出時間 → {mood, hist} */
export function build(dir, prevHist = [], now = new Date(), opt = {}) {
    const miss = [], M = (k, name, why) => miss.push({ k, name, why });
    const today = (opt.today || new Date(now.getTime() + 8 * 3600e3).toISOString().slice(0, 10));
    // ── 加權 + 心理狀態
    let S = null, state = null, twNow = null;
    try {
        S = loadIndex({ IDX_LONG: path.join(dir, 'idx_long.json'), IDX_EARLY: path.join(dir, 'idx_long_early.json'), TWII_NOW: path.join(dir, '^TWII.json') });
        state = stateOf(S);
        if (!state) M('state', '心理狀態', '加權資料不夠長(2003 以前只暖機)');
    } catch (e) { M('state', '心理狀態', `加權讀不到(${String(e.message || e).slice(0, 60)})`); }
    const crowd = [], wind = [];
    if (state) {
        const i = state._i, F = state._F, vols = [];
        let first = null; for (let k = 0; k <= i; k++) if (F.vol[k] != null) { vols.push(F.vol[k]); if (!first) first = S.d[k]; }
        crowd.push({ k: 'rv20', name: '加權 20 日實現波動(年化)', side: 'fear', hiw: '怕', v: r2(F.vol[i]), unit: '%', d: S.d[i], pct: r2(F.V[i]), n: vols.length, from: first, to: S.d[i], lab: 'psych-state',
            note: '心理狀態機裡的「波動」就是這一條(恐慌 = 波動在歷史前 10% 而且離一年高點跌 10% 以上)' });
        twNow = { d: S.d[i], c: S.c[i] };
    }
    delete state?._i; if (state) delete state._F;
    // ── 市場廣度(250 天)+ mood_hist 補更早的
    const hb = new Map((prevHist || []).filter(r => r && r.d).map(r => [r.d, r]));
    const br = rdj(dir, 'breadth.json');
    const bh = br.j && Array.isArray(br.j.history) ? br.j.history.filter(r => r && r.d).map(r => ({ ...r, d: d10(r.d) })).sort((a, b) => a.d < b.d ? -1 : 1) : [];
    const todayRow = { d: today };
    if (!bh.length) { for (const [k, n] of [['ld', '跌停家數'], ['flr', '地板股家數'], ['lu', '漲停家數'], ['amtx', '成交金額 ÷ 近一年中位數']]) M(k, n, br.err || 'breadth.json 沒有 history'); }
    else {
        const last = bh.at(-1), bd = new Set(bh.map(r => r.d));
        const older = [...hb.values()].filter(r => r.d < bh[0].d && !bd.has(r.d)).sort((a, b) => a.d < b.d ? -1 : 1);
        const series = (f) => { const rows = [...older.filter(r => Number.isFinite(r[f])), ...bh.slice(0, -1).filter(r => Number.isFinite(+r[f])).map(r => ({ d: r.d, [f]: +r[f] }))]; return { vals: rows.map(r => +r[f]), from: rows[0] ? rows[0].d : null, to: last.d }; };
        crowd.push(gauge('ld', '跌停家數', 'fear', +last.ld, '家', last.d, series('ld'), 'crash-warn', { hiw: '怕', note: '上市櫃個股(不含 ETF)收盤跌 9% 以上' }));
        crowd.push(gauge('flr', '地板股家數', 'fear', +last.flr, '家', last.d, series('flr'), 'mkt-floor300', { hiw: '怕', note: '跟自己歷史比,離 20 日均線最遠的 5% 那種日子(地板股)' }));
        crowd.push(gauge('lu', '漲停家數', 'greed', +last.lu, '家', last.d, series('lu'), 'leader-breadth4', { hiw: '貪', note: '上市櫃個股(不含 ETF)收盤漲 9% 以上' }));
        const amts = bh.slice(0, -1).map(r => +r.amt).filter(x => x > 0), mAmt = med(amts.slice(-250));
        if (mAmt > 0 && +last.amt > 0) {
            const g = gauge('amtx', '成交金額 ÷ 近一年中位數', 'greed', +last.amt / mAmt, '倍', last.d, series('amt'), null, { hiw: '貪', note: `今天 ${Math.round(+last.amt).toLocaleString()} 億;上市 + 上櫃自己加總(⛔ 不是證交所的集中市場成交值)` });
            const RA = rankPct(series('amt').vals, +last.amt);   // 排第幾用成交金額本身(同一段比,倍數只是換個說法)
            Object.assign(g, { pct: RA.pct, lo: RA.lo ?? null, hi: RA.hi ?? null });
            crowd.push(g);
        } else M('amtx', '成交金額 ÷ 近一年中位數', '成交金額讀不到');
        const ud = (+last.up || 0) + (+last.dn || 0);
        if (ud > 0) wind.push({ k: 'upr', name: '上漲家數比例', v: r2(+last.up / ud * 100), unit: '%', d: last.d, note: `漲 ${last.up}・跌 ${last.dn}・平 ${last.flat ?? '—'}`, lab: null });
        if (Number.isFinite(+last.idx) && Number.isFinite(+last.med)) wind.push({ k: 'lag', name: '加權 − 一般股票(中位數)', v: r2(+last.idx - +last.med), unit: 'pp', d: last.d, note: `加權 ${r2(+last.idx)}%・一般股票 ${r2(+last.med)}%(正 = 權值股撐著指數)`, lab: null });
        Object.assign(todayRow, { bd: last.d, ld: +last.ld, lu: +last.lu, flr: +last.flr, amt: +last.amt, up: +last.up, dn: +last.dn });
    }
    // ── 注意 / 處置家數
    const at = rdj(dir, 'attention_history.json');
    if (at.j && at.j.history && typeof at.j.history === 'object') {
        const H = at.j.history, ds = Object.keys(H).sort(), cnt = d => Object.values(H[d] || {}).length;
        const lastD = ds.at(-1), hv = ds.slice(0, -1).map(cnt);
        const older = [...hb.values()].filter(r => r.d < ds[0] && Number.isFinite(r.attn)).sort((a, b) => a.d < b.d ? -1 : 1);
        const vals = [...older.map(r => r.attn), ...hv], from = older[0] ? older[0].d : ds[0];
        const nA = Object.values(H[lastD] || {}).filter(x => String(x).includes('注意')).length, nD = Object.values(H[lastD] || {}).filter(x => String(x).includes('處置')).length;
        crowd.push(gauge('attn', '注意股 + 處置股家數', 'greed', cnt(lastD), '家', lastD, { vals, from, to: lastD }, 'avoid-attn30', { hiw: '貪', note: `注意 ${nA}・處置 ${nD}(官方名單)` }));
        todayRow.attn = cnt(lastD); todayRow.ad = lastD;
    } else M('attn', '注意股 + 處置股家數', at.err || 'attention_history.json 沒有 history');
    // ── 長歷史 + 每天快照
    const mr = rdj(dir, 'macro_risk.json'), m = mr.j || {};
    const rh = rdj(dir, 'risk_history.json'), RH = Array.isArray(rh.j) ? rh.j.filter(r => r && r.date).map(r => ({ ...r, date: d10(r.date) })) : [];
    const fm = rdj(dir, 'fi_mkt_hist.json'), FM = fm.j || null;
    const tx = rdj(dir, 'taifex_hist.json'), TX = tx.j || null;
    const fh = rdj(dir, 'fred_hist.json'), FH = fh.j && fh.j.series ? fh.j.series : null;
    // 融資 20 日變化:今天 = 快照(risk_history,億);排第幾 = 官方長歷史(fi_mkt_hist.mg,億)的 20 日變化
    if (RH.length > 20 && FM && FM.mg) {
        const a = Object.fromEntries(RH.map(r => [r.date, num(r.margin_100m)])), b = Object.fromEntries(Object.entries(FM.mg).map(([k, v]) => [d10(k), num(v)]));
        const U = sameUnit(a, b);
        const ok = RH.filter(r => num(r.margin_100m) > 0), cur = ok.at(-1), prev = ok.at(-21);
        if (!U.ok) M('mg20', '融資餘額 20 日變化', `快照跟官方長歷史接不起來:${U.why}`);
        else if (!cur || !prev) M('mg20', '融資餘額 20 日變化', '快照不到 21 天');
        else {
            const ks = Object.keys(b).sort(), ch = [];
            for (let i = 20; i < ks.length; i++) if (b[ks[i]] > 0 && b[ks[i - 20]] > 0) ch.push((b[ks[i]] / b[ks[i - 20]] - 1) * 100);
            const v = (cur.margin_100m / prev.margin_100m - 1) * 100;
            crowd.push(gauge('mg20', '融資餘額 20 日變化', 'both', v, '%', cur.date, { vals: ch, from: ks[20], to: ks.at(-1) }, 'margin-call-bounce',
                { hiw: '貪(加槓桿)', low: '怕(斷頭、降槓桿)', note: `今天 ${Math.round(cur.margin_100m).toLocaleString()} 億(20 筆快照前 ${Math.round(prev.margin_100m).toLocaleString()} 億);負的很多 = 斷頭 / 降槓桿、正的很多 = 加槓桿。今天的值是每天的快照,有時晚一天`, chk: U }));
            todayRow.mg = cur.margin_100m;
        }
    } else M('mg20', '融資餘額 20 日變化', rh.err || fm.err || '快照或官方長歷史不夠');
    // 期現基差(% of 加權):今天 = macro_risk;排第幾 = fi_mkt_hist.bs
    if (FM && FM.bs && m.taifex_backwardation != null && !m.taifex_backwardation_error && num(m.taiex_close) > 0) {
        const vals = Object.values(FM.bs).filter(x => Array.isArray(x) && num(x[0]) != null && num(x[2]) > 0).map(x => x[0] / x[2] * 100);
        const ks = Object.keys(FM.bs).sort();
        crowd.push(gauge('basis', '台指期 − 加權(%)', 'both', num(m.taifex_backwardation) / num(m.taiex_close) * 100, '%', m.taifex_fut_date || m.taiex_date, { vals, from: d10(ks[0]), to: d10(ks.at(-1)) }, null,
            { hiw: '貪(正價差大)', low: '怕(逆價差深)', note: `今天 ${num(m.taifex_backwardation) > 0 ? '+' : ''}${num(m.taifex_backwardation)} 點;負的 = 逆價差。外資期貨空單有一部分是現貨的避險:空單大但正價差多半是避險,大又深度逆價差才是真的在殺(只描述,沒測過)` }));
    } else M('basis', '台指期 − 加權', m.taifex_backwardation_error || fm.err || mr.err || '基差或加權讀不到');
    // 美國 VIX:今天 = macro_risk;排第幾 = us_hist ^VIX(2009 起)
    const us = rdj(dir, 'us_hist.json');
    if (num(m.vix) > 0 && us.j && us.j.syms && us.j.syms['^VIX'] && Array.isArray(us.j.days)) {
        const c = us.j.syms['^VIX'].c || [], days = us.j.days, vd = d10(m.vix_date);
        const vals = c.filter((x, k) => num(x) > 0 && (!vd || days[k] < vd));
        crowd.push(gauge('vix', '美國恐慌指數 VIX', 'fear', num(m.vix), '', vd, { vals, from: days[0], to: days.at(-1) }, 'vix-tw', { hiw: '怕', note: '歷史 = 美股日線那份(手動更新);今天的值是總經風險檔那一欄' }));
        todayRow.vix = num(m.vix);
    } else M('vix', '美國恐慌指數 VIX', mr.err || us.err || 'VIX 讀不到');
    // 散戶多空比:只用 risk_history 自己的 90 天(⛔ 接 taifex_hist.rl —— 算法不一樣)
    if (RH.length) {
        const ok = RH.filter(r => num(r.retail_ls_pct) != null), cur = ok.at(-1);
        let chk = null;
        if (TX && TX.rl) chk = sameUnit(Object.fromEntries(ok.map(r => [r.date, num(r.retail_ls_pct)])), Object.fromEntries(Object.entries(TX.rl).map(([k, v]) => [d10(k), Array.isArray(v) ? num(v[3]) : null])), 0.05);
        if (cur) crowd.push(gauge('rls', '小台散戶多空比', 'greed', num(cur.retail_ls_pct), '%', cur.date, { vals: ok.slice(0, -1).map(r => num(r.retail_ls_pct)), from: ok[0].date, to: cur.date }, 'retail-ls',
            { hiw: '貪(散戶偏多)', low: '怕(散戶偏空)', note: '正 = 散戶淨做多。只跟自己這份快照的歷史比' + (chk && !chk.ok ? `(期交所長歷史那份算法不一樣:${chk.why},⛔ 接在一起)` : '') }));
        todayRow.rls = cur ? num(cur.retail_ls_pct) : null;
    } else M('rls', '小台散戶多空比', rh.err || 'risk_history 讀不到');
    // 💱 美國信用利差(FRED BAA10Y,1986 起;今天 = FRED 最後一筆 —— 每天更新,晚美國一天)
    const baa = fredPts(FH, 'baa10y');
    if (baa.length > MIN_N) {
        const last = baa.at(-1);
        crowd.push(gauge('credit', '美國信用利差(Baa 公司債 − 10 年美債)', 'fear', last[1], '個百分點', last[0], { vals: baa.slice(0, -1).map(x => x[1]), from: baa[0][0], to: last[0] }, 'credit-diverge',
            { hiw: '怕(公司債要多付利息)', note: 'FRED BAA10Y(穆迪 Baa 公司債殖利率 − 10 年美債)。⚠️ 實測總表那一條過關的是另一種講法(高收益債 ETF ÷ 公債 ETF,只當參考);「這條利差創一年新高」那種講法測過沒過' }));
        todayRow.baa = last[1];
    } else M('credit', '美國信用利差', fh.err || (FH ? 'fred_hist 沒有 baa10y(或不到 20 天)' : 'fred_hist.json 讀不到'));
    // 選擇權 P/C(未平倉)、期貨大戶:只有長歷史,停在哪天就寫哪天
    if (TX && TX.pc) {
        const ks = Object.keys(TX.pc).sort(), lk = ks.at(-1), v = Array.isArray(TX.pc[lk]) ? num(TX.pc[lk][1]) : null;
        crowd.push(gauge('pcr', '選擇權賣權 ÷ 買權(未平倉)', 'fear', v, '%', lk, { vals: ks.slice(0, -1).map(k => Array.isArray(TX.pc[k]) ? num(TX.pc[k][1]) : null), from: d10(ks[0]), to: d10(lk) }, 'pcr-largetrader',
            { hiw: '怕', stale: true, note: '⏳ 只有手動補挖的歷史,每天的值第 6 期才接' }));
    } else M('pcr', '選擇權賣權 ÷ 買權', tx.err || 'taifex_hist 沒有 pc');
    // ── 外資與大戶(換座位)
    const seats = { fi: [], trust: [], retail: [], insider: [], gov: [] };
    const fiHist = idx => {
        if (!FM || !FM.spot) return { vals: [] };
        const ks = Object.keys(FM.spot).sort().slice(-FI_WIN);
        return { vals: ks.map(k => Array.isArray(FM.spot[k]) ? num(FM.spot[k][idx]) : null), from: d10(ks[0]), to: d10(ks.at(-1)) };
    };
    if (num(m.fi_spot_net) != null) seats.fi.push(gauge('fis', '外資現貨買賣超(今天)', 'both', num(m.fi_spot_net), '億', m.fi_spot_date, fiHist(0), 'fi-outflow', { hiw: '買超大', low: '賣超大', note: '上市;只跟近 3 年比(早年規模小)' }));
    else M('fis', '外資現貨買賣超', mr.err || 'macro_risk 沒有 fi_spot_net');
    if (num(m.fi_spot_mtd) != null) seats.fi.push({ k: 'fim', name: `外資本月累計(${m.fi_spot_mtd_month || ''})`, v: r2(num(m.fi_spot_mtd)), unit: '億', d: d10(m.fi_spot_date), lab: 'fi-follow',
        note: `證交所月報的累計(這個月 ${num(m.fi_spot_mtd_days) ?? '—'} 個交易日);⛔ 自己把每天加起來(快照會重複)。月中跟整個月不能比 → 不排第幾` });
    if (num(m.fi_futures_net) != null) {
        // 快照有時晚一天、會重複 → 連續一樣的只留一筆;跟自己最近 20 筆比(⛔ 絕對口數不能跨年比:小台、微台上市後整體放大)
        const fr = RH.filter(r => num(r.fi_futures_net) != null).filter((r, k, a) => k === 0 || num(r.fi_futures_net) !== num(a[k - 1].fi_futures_net));
        const last20 = fr.slice(-21, -1), v = num(m.fi_futures_net);
        seats.fi.push(gauge('fif', '外資台指期淨部位', 'both', v, '口', m.fi_futures_date, { vals: last20.map(r => num(r.fi_futures_net)), from: last20[0] ? last20[0].date : null, to: last20.at(-1) ? last20.at(-1).date : null }, null,
            { hiw: '空單比較輕', low: '空單比較重', note: '跟自己最近 20 筆快照比(連續一樣的只算一筆);⛔ 絕對口數不能跨年比(小台、微台上市後整體放大)' }));
    } else M('fif', '外資台指期淨部位', mr.err || 'macro_risk 沒有 fi_futures_net');
    if (TX && TX.lt) {
        const ks = Object.keys(TX.lt).sort(), lk = ks.at(-1), x = TX.lt[lk] && TX.lt[lk].all;
        const ratio = k => { const a = TX.lt[k] && TX.lt[k].all; return Array.isArray(a) && num(a[2]) > 0 ? num(a[1]) / num(a[2]) * 100 : null; };
        seats.fi.push(gauge('lt10', '台指期前 10 大交易人淨部位 ÷ 未平倉', 'both', ratio(lk), '%', lk, { vals: ks.slice(0, -1).map(ratio), from: d10(ks[0]), to: d10(lk) }, 'pcr-largetrader',
            { stale: true, note: `前 10 大淨 ${Array.isArray(x) ? x[1] : '—'} 口 ÷ 全市場 ${Array.isArray(x) ? x[2] : '—'} 口。⏳ 只有手動補挖的歷史,每天的值第 6 期才接` }));
    }
    // 台積電 ADR 溢價(只有今天;排第幾第 6 期)
    const k2330 = rdj(dir, '2330.json');
    const r2330 = Array.isArray(k2330.j) ? k2330.j.filter(r => num(r.close) > 0).at(-1) : null;
    if (num(m.tsm) > 0 && num(m.usdtwd) > 0 && r2330) {
        seats.fi.push({ k: 'adr', name: '台積電 ADR 溢價', side: 'both', v: r2((num(m.tsm) * num(m.usdtwd) / 5 / num(r2330.close) - 1) * 100), unit: '%', d: d10(m.tsm_date), pct: null, n: 0, lab: null,
            note: `ADR ${num(m.tsm)} 美元(${d10(m.tsm_date)})× 匯率 ${num(m.usdtwd)} ÷ 5 vs 台股 ${num(r2330.close)}(${d10(r2330.date)});兩邊收盤時間不同。歷史排第幾 ⏳:美股日線那份是還原過股利的價格,跟台股原始價格不是同一把尺(陷阱 #46),要等有原始價格的 ADR 歷史` });
    } else M('adr', '台積電 ADR 溢價', mr.err || k2330.err || 'ADR、匯率或 2330 讀不到');
    // 💱 這一波:用台幣算 vs 用美元算(外資看的是美元)—— 加權 ÷ 美元台幣(FRED,沒有的那幾天用前面最近一筆,最多 7 天;今天用總經風險檔的匯率)
    {
        const tw = fredPts(FH, 'usdtwd');
        const vToday = num(m.usdtwd), dToday = d10(m.usdtwd_date);
        if (S && tw.length > 200 && twNow) {
            const n = S.d.length, from = Math.max(0, n - 250);
            const lastFred = tw.at(-1);
            const todayOk = vToday > 0 && sameLevel(vToday, lastFred[1], 0.05) && (!dToday || Math.abs(dayGap(dToday, twNow.d)) <= 3);
            let j = 0, ff = 0;
            const usd = [], twd = [];
            for (let i = from; i < n; i++) {
                const d = S.d[i];
                let fxv = null;
                if (i === n - 1 && todayOk) fxv = vToday;
                else {
                    while (j + 1 < tw.length && tw[j + 1][0] <= d) j++;
                    if (tw[j] && tw[j][0] <= d && dayGap(tw[j][0], d) <= 7) { fxv = tw[j][1]; if (tw[j][0] < d) ff++; }
                }
                twd.push([d, S.c[i]]);
                if (fxv > 0) usd.push([d, S.c[i] / fxv, fxv]);
            }
            const lastU = usd.at(-1);
            if (usd.length >= 200 && lastU && lastU[0] === twNow.d) {
                const hiT = twd.reduce((a, b) => b[1] > a[1] ? b : a), hiU = usd.reduce((a, b) => b[1] > a[1] ? b : a);
                const ddT = r2((twNow.c / hiT[1] - 1) * 100), ddU = r2((lastU[1] / hiU[1] - 1) * 100);
                const fxAtHi = (usd.find(x => x[0] === hiT[0]) || [])[2], fxChg = fxAtHi ? r2((lastU[2] / fxAtHi - 1) * 100) : null;
                const pc = x => (x < 0 ? '−' : x > 0 ? '+' : '') + Math.abs(x) + '%';
                seats.fi.push({ k: 'usdtw', name: '這一波:用台幣算 vs 用美元算', v: ddU, unit: '%', d: twNow.d, lab: null, ddT, fxChg,
                    note: `離近一年高點:用台幣算 ${pc(ddT)}(高點 ${hiT[0]})、用美元算 ${pc(ddU)}(高點 ${hiU[0]})` + (fxChg != null ? `;同一段台幣${fxChg > 0 ? '貶' : '升'} ${Math.abs(fxChg)}%(外資用美元記帳,賣股換美元時匯率也算在裡面)` : '')
                        + `。匯率 = FRED(一週更新一次,中間沒有的 ${ff} 天用前面最近一筆)` + (todayOk ? ',今天用總經風險檔那一筆' : ',今天的匯率跟 FRED 對不上 → 用 FRED 最後一筆') });
            } else M('usdtw', '這一波:用台幣算 vs 用美元算', '匯率歷史接不到今天(FRED 太舊或今天的匯率讀不到)');
        } else M('usdtw', '這一波:用台幣算 vs 用美元算', fh.err || (FH ? 'fred_hist 沒有美元台幣(或太短)' : 'fred_hist.json 讀不到'));
    }
    if (num(m.fi_trust_net) != null) seats.trust.push(gauge('fit', '投信買賣超(今天)', 'both', num(m.fi_trust_net), '億', m.fi_three_date, fiHist(1), 'fi-trust-sync', { hiw: '買超大', low: '賣超大', note: '上市;只跟近 3 年比' }));
    else M('fit', '投信買賣超', mr.err || 'macro_risk 沒有 fi_trust_net');
    for (const g of crowd.filter(x => ['mg20', 'rls'].includes(x.k))) seats.retail.push({ ref: g.k });
    // 內部人(近 5 個交易日):董監 / 大股東在市場上賣、庫藏股
    const ins = rdj(dir, 'insider_recent.json'), mops = rdj(dir, 'mops_recent.json');
    if (ins.j && Array.isArray(ins.j.rows) && Array.isArray(ins.j.cols)) {
        const C = ins.j.cols, ix = n => C.indexOf(n), days = Object.keys(ins.j.days || {}).sort().slice(-5);
        const hit = ins.j.rows.filter(r => days.includes(d10(r[ix('d')])) && r[ix('mc')] === 'mkt' && ['dir', 'big'].includes(r[ix('rc')]));
        const names = [...new Set(hit.map(r => `${r[ix('n')]} ${r[ix('s')]}`))];
        seats.insider.push({ k: 'ins', name: '董監 / 大股東申報在市場上賣(近 5 個交易日)', v: names.length, unit: '家', d: days.at(-1) || null, lab: 'insider-sell', list: names.slice(0, 8),
            note: `${days[0] || '—'} ~ ${days.at(-1) || '—'};經理人 / 信託 / 贈與 ⛔ 算(研究只有這兩種身分比較弱)` + (ins.j.miss && Object.keys(ins.j.miss).length ? `;有沒抓到的日子:${Object.keys(ins.j.miss).join('、')}` : '') });
    } else M('ins', '董監申報轉讓', ins.err || 'insider_recent 格式不對');
    if (mops.j && Array.isArray(mops.j.rows) && Array.isArray(mops.j.cols)) {
        const C = mops.j.cols, ix = n => C.indexOf(n), days = Object.keys(mops.j.days || {}).sort().slice(-5);
        const cnt = cat => new Set(mops.j.rows.filter(r => days.includes(d10(r[ix('d')])) && r[ix('cat')] === cat).map(r => r[ix('s')])).size;
        seats.insider.push({ k: 'bb', name: '董事會決議買回庫藏股(近 5 個交易日)', v: cnt('buyback'), unit: '家', d: days.at(-1) || null, lab: null, note: `同期「庫藏股買完 / 期滿 / 註銷」${cnt('buyback_end')} 家(重大訊息分類)` });
    } else M('bb', '庫藏股', mops.err || 'mops_recent 格式不對');
    // 政府:國安基金最近一次(進場 / 退場)+ 研究資料的規則斷點(限空令)
    const lastN = NSF.at(-1), ex = NSF_EXIT[lastN];
    seats.gov.push({ k: 'nsf', name: '國安基金', v: null, d: lastN, lab: ex ? 'nsf-exit' : 'nsf-entry',
        note: ex ? `最近一次 ${lastN} 進場、${ex} 宣布退場` : `最近一次 ${lastN} 授權進場,還在執行(第 ${NSF.length} 次)` });
    try {
        const RB = JSON.parse(fs.readFileSync(path.join(opt.root || ROOT, 'research', 'regime_breaks.json'), 'utf8'));
        for (const b of (RB.breaks || [])) seats.gov.push({ k: 'rb_' + b.date, name: '規則改變', v: null, d: b.date, lab: null, note: `${b.what}(影響:${(b.affects || []).join('、')})` });
    } catch (e) { M('rb', '規則改變', '讀不到 research/regime_breaks.json'); }
    // ── 匯率與風向
    const FX = [['usdtwd', '美元 / 台幣', 'usdtwd_chg_pct', 'usdtwd_chg_5d', 'usdtwd_date', '數字變大 = 台幣貶'], ['dxy', '美元指數', 'dxy_chg_pct', null, 'dxy_date', ''],
        ['jpy', '美元 / 日圓', 'jpy_chg_pct', null, null, '數字變小 = 日圓升(5 日欄是 3 日)'], ['krw', '美元 / 韓元', 'krw_chg_pct', 'krw_chg_5d', 'krw_date', ''],
        ['cny', '美元 / 人民幣', 'cny_chg_pct', 'cny_chg_5d', 'cny_date', ''], ['ust10y', '美債 10 年殖利率(%)', 'ust10y_chg_pct', null, 'ust10y_date', '1 日 / 20 日欄是殖利率本身變了幾 %(⛔ 不是幾個百分點)'],
        ['us2y_yield', '美債 2 年殖利率(%)', null, null, null, ''], ['gold_usd', '黃金(美元 / 盎司)', null, null, null, ''], ['wti_oil', '西德州原油(美元)', null, null, null, ''],
        ['copper', '銅(美元 / 磅)', 'copper_chg_pct', 'copper_chg_5d', 'copper_date', ''], ['btc_usd', '比特幣(美元)', null, null, null, '']];
    const fx = [];
    // 💱 V82.5.6 20 日 / 一年位置:① FRED 有那一條 → 先比「今天的值 vs FRED 最後一筆」是不是同一把尺,是才接
    //   ② FRED 沒有(美元指數 / 黃金 / 銅)或接不上 → 用 mood_hist 自己每天存的(同一個來源,天生同一把尺;不到 20 天寫「還在累積」)
    const ownFx = k => { const seen = new Set(), P = [];
        for (const r of [...hb.values()].sort((a, b) => a.d < b.d ? -1 : 1)) { const x = r.fx && r.fx[k]; if (!Array.isArray(x) || !Number.isFinite(+x[0])) continue; const dd = d10(x[1]) || r.d; if (seen.has(dd)) continue; seen.add(dd); P.push([dd, +x[0]]); }
        return P; };
    for (const [k, name, c1, c5, dk, note] of FX) {
        if (num(m[k]) == null) { M('fx_' + k, name, mr.err || `macro_risk 沒有 ${k}`); continue; }
        const c5v = c5 ? num(m[c5]) : (k === 'jpy' ? num(m.jpy_chg_3d) : null);
        const v = num(m[k]), dd = dk ? d10(m[dk]) : null, asOf = dd || today;
        let c20 = null, pos = null, hs = null, hwhy = null;
        const F = FX_FRED[k];
        if (F) {
            const P = fredPts(FH, F[0], asOf), last = P.at(-1);
            if (!FH) hwhy = fh.err || 'fred_hist.json 讀不到';
            else if (!last) hwhy = `fred_hist 沒有 ${F[0]}`;
            else if (dayGap(last[0], asOf) > FRED_MAX_LAG) hwhy = `FRED 最後一筆停在 ${last[0]}(太舊)`;
            else if (!sameLevel(v, last[1], F[1], F[2])) hwhy = `今天 ${v} 跟 FRED 最後一筆 ${last[1]}(${last[0]})差太多,不像同一把尺 → 不接`;
            else { c20 = chg20(P, v, asOf); pos = yearPos(P, v, asOf); hs = `FRED ${(FH[F[0]] || {}).sid || F[0]}(到 ${last[0]})`; }
        }
        if (!hs) {
            const P = ownFx(k).filter(([d]) => d < asOf);
            if (P.length) { c20 = chg20(P, v, asOf); pos = yearPos(P, v, asOf); hs = `App 自己每天存的(${P.length} 天)`; }
            else if (!hwhy) hwhy = '還沒有歷史(App 從 11/20 開始每天存)';
        }
        fx.push({ k, name, v, c1: c1 ? num(m[c1]) : null, c5: c5v, c20, pos, hs, hwhy, d: dd, upd: dk ? null : (m.updated || null), note });   // 沒有自己的日期 → 只寫檔案更新時間(⛔ 假裝是今天的)
    }
    todayRow.fx = Object.fromEntries(fx.map(r => [r.k, [r.v, r.d || null]]));
    if (num(m.sox_chg_pct) != null && num(m.sp500_chg_pct) != null) wind.push({ k: 'soxsp', name: '費半 − 標普(今天)', v: r2(num(m.sox_chg_pct) - num(m.sp500_chg_pct)), unit: 'pp', d: d10(m.sox_date), note: `費半 ${num(m.sox_chg_pct)}%・標普 ${num(m.sp500_chg_pct)}%`, lab: null });
    const two = rdj(dir, '^TWOII.json'), tw = rdj(dir, '^TWII.json');
    const r20 = j => { const a = Array.isArray(j) ? j.filter(r => num(r.close) > 0) : []; return a.length > 21 ? { v: (a.at(-1).close / a.at(-21).close - 1) * 100, d: d10(a.at(-1).date) } : null; };
    const A = r20(tw.j), B = r20(two.j);
    if (A && B) wind.push({ k: 'twotc', name: '加權 − 櫃買(近 20 日)', v: r2(A.v - B.v), unit: 'pp', d: A.d === B.d ? A.d : `${A.d} / ${B.d}`, note: `加權 ${r2(A.v)}%・櫃買 ${r2(B.v)}%(正 = 大型股比較撐)`, lab: null });
    else M('twotc', '加權 − 櫃買', two.err || tw.err || '加權或櫃買不到 21 天');
    // 成交集中度(前 10 大成交金額 ÷ 全部個股,⛔ 不含 00 開頭的 ETF):只有今天 → mood_hist 從今天開始累積
    const sc = rdj(dir, 'screener.json');
    if (sc.j && sc.j.rows && Array.isArray(sc.j.cols) && sc.j.cols.includes('amt')) {
        const ia = sc.j.cols.indexOf('amt'), amts = Object.entries(sc.j.rows).filter(([s]) => !/^00/.test(s)).map(([, r]) => num(r[ia])).filter(x => x > 0).sort((a, b) => b - a);
        const tot = amts.reduce((s, x) => s + x, 0);
        if (tot > 0 && amts.length >= 100) {
            const v = amts.slice(0, 10).reduce((s, x) => s + x, 0) / tot * 100;
            const prev = [...hb.values()].filter(r => Number.isFinite(r.conc) && r.d < (d10(sc.j.data_date) || today)).sort((a, b) => a.d < b.d ? -1 : 1);
            crowd.push(gauge('conc', '成交集中在前 10 檔', 'greed', v, '%', sc.j.data_date || sc.j.updated, { vals: prev.map(r => r.conc), from: prev[0] ? prev[0].d : null, to: prev.at(-1) ? prev.at(-1).d : null }, null,
                { hiw: '貪(擠在少數股)', note: `前 10 大成交金額 ÷ ${amts.length} 檔個股(不含 ETF)。⏳ 從 11/20 開始每天累積,滿 ${MIN_N} 天才排得出第幾` }));
            todayRow.conc = r2(v); todayRow.cd = d10(sc.j.data_date) || null;
        } else M('conc', '成交集中度', 'screener 個股成交金額不夠');
    } else M('conc', '成交集中度', sc.err || 'screener 沒有 amt');
    for (const [k, n, why] of [['dtr', '當沖占比', '⏳ 第 6 期(證交所)']]) M(k, n, why);
    // ⚠️ 每天該更新的來源停了(比加權最新那天舊 ≥ STALE_D 天)→ 標 stale:畫面標「資料停在 MM/DD」、頁頂 / 🏠 那一句 ⛔ 挑它當「今天離平常最遠」
    //   (⛔ 跟手機的今天比 —— 連假時大家一起停,那不算;跟加權最新那天比才分得出「只有這一條停了」)
    const asofMs = twNow ? Date.parse(twNow.d) : NaN;
    //   只看量條('pct' in g):國安基金 / 申報轉讓那種「事件那天」的日期是事件本身,⛔ 是資料停了
    if (Number.isFinite(asofMs)) for (const g of [...crowd, ...Object.values(seats).flat()].filter(g => g && 'pct' in g)) {
        const dm = g.d ? Date.parse(String(g.d).slice(0, 10)) : NaN;
        if (!g.stale && Number.isFinite(dm) && (asofMs - dm) / 864e5 >= STALE_D) g.stale = true;
    }
    // ── mood_hist:今天這一列(同一天蓋掉)
    if (state) Object.assign(todayRow, { st: state.k, std: state.d });
    const H = new Map((prevHist || []).filter(r => r && r.d).map(r => [r.d, r]));
    H.set(today, { ...(H.get(today) || {}), ...todayRow });
    const hist = [...H.values()].sort((a, b) => a.d < b.d ? -1 : 1).slice(-HIST_MAX);
    const mood = { v: 1, updated: opt.updated || new Date(now.getTime() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') + ' +0800', asof: twNow ? twNow.d : null,
        state, crowd, seats, fx, wind, miss, minN: MIN_N, src: 'scripts/mood_build.mjs' };
    return { mood, hist };
}

// ───────────────────────── selftest ─────────────────────────
function selftest() {
    let bad = 0;
    const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + e}`); if (!c) bad++; };
    // ① rankPct 手算
    const h19 = Array.from({ length: 19 }, (_, k) => k + 1);
    const R10 = rankPct(h19, 10);
    ok('① 排第幾:1~19 再加 10 → 比較低 9 個、一樣 2 個、比較高 9 個 / 20 → 同分算一半 = 50%、lo 45、hi 45', R10.pct === 50 && R10.lo === 45 && R10.hi === 45 && R10.n === 20, JSON.stringify(R10));
    // ⭐ 同分:15 天 0 家 + 5 天 1 家,今天 0 家 → 沒有一天比較低(最低),跟 16/21 天一樣
    const Rt = rankPct([...Array(15).fill(0), ...Array(5).fill(1)], 0);
    ok('① 同分(很多天都是 0)→ lo 0(= 最低)、hi 23.81、pct 38.1', Rt.lo === 0 && Rt.hi === 23.81 && Rt.pct === 38.1 && Rt.n === 21, JSON.stringify(Rt));
    ok('① 決定性對照:舊的「≤ 今天」會算成 76.19%(= 寫出「比 76% 的日子高」,其實只是一樣)→ 新的 pct 跟它不一樣', Math.round(16 / 21 * 10000) / 100 === 76.19 && Rt.pct !== 76.19);
    ok('① 歷史不夠(3 + 1 天)→ pct null(⛔ 硬給)', rankPct([1, 2, 3], 2).pct === null && rankPct([1, 2, 3], 2).n === 4);
    ok('① 今天讀不到(null)→ pct null', rankPct(h19, null).pct === null);
    // ② sameUnit:同單位 / 差 100 倍 / 重疊太少
    const a = {}, b = {}; for (let k = 0; k < 10; k++) { a['2026-10-' + String(k + 10)] = 6000 + k; b['2026-10-' + String(k + 10)] = 6000 + k + (k % 2 ? 6 : 0); }
    ok('② 同單位(差 0.1%)→ 接', sameUnit(a, b).ok);
    ok('② 決定性對照:一邊 ×100(元 vs 億)→ ⛔ 接、寫原因', !sameUnit(Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v * 100])), b).ok && /單位/.test(sameUnit(Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v * 100])), b).why || ''));
    ok('② 重疊只有 3 天 → ⛔ 接', !sameUnit({ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 3 }).ok);
    // ③ 合成一份 data 目錄走正式入口 build()
    const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'mood_'));
    try {
        const W = (f, j) => fs.writeFileSync(path.join(tmp, f), JSON.stringify(j));
        // 加權:2003 前暖機、平常小漲小跌;最後一段大跌小彈 → 恐慌(⛔ 每天固定跌同樣幅度 —— 那樣波動是 0,反而不是恐慌)
        const days = [], c = []; let p = 5000; const t0 = Date.UTC(2001, 0, 1);
        for (let k = 0; k < 6200; k++) { const d = new Date(t0 + k * 86400e3 * 1.4); const ds = d.toISOString().slice(0, 10); if (days.length && ds <= days.at(-1)) continue; days.push(ds);
            const shock = (k > 6150) ? (k % 2 ? -0.06 : 0.015) : 0.0003 + 0.008 * Math.sin(k * 0.7); p = Math.max(100, p * (1 + shock)); c.push(+p.toFixed(2)); }
        W('idx_long.json', { twii: days.map((d, k) => [d.replace(/-/g, '/'), c[k], c[k], c[k], c[k], 1e11]) });
        W('^TWII.json', []);
        const B = []; for (let k = 0; k < 250; k++) B.push({ d: `2026/${String(1 + (k / 25 | 0)).padStart(2, '0')}/${String(1 + k % 25).padStart(2, '0')}`, ld: k % 10, lu: 5, flr: 20, amt: 5000 + k, up: 900, dn: 1000, flat: 100, idx: -1, med: -2 });
        B[249].ld = 200;   // 今天跌停 200 家 = 前 249 天都沒有這麼多
        W('breadth.json', { history: B });
        W('macro_risk.json', { vix: 30, vix_date: '2026-11-19', fi_spot_net: -500, fi_spot_date: '20261119', taifex_backwardation: -200, taiex_close: 20000, taifex_fut_date: '2026-11-19', usdtwd: 33, usdtwd_chg_pct: 0.3, usdtwd_date: '2026-11-19' });
        const { mood, hist } = build(tmp, [], new Date('2026-11-19T12:00:00Z'), { today: '2026-11-19', root: ROOT });
        const S = loadIndex({ IDX_LONG: path.join(tmp, 'idx_long.json'), TWII_NOW: path.join(tmp, '^TWII.json') });
        const ref = states(S).st.filter(Boolean).at(-1);
        ok('③ 心理狀態 == psych_state_probe.states() 直接算的最後一天(⛔ 自己另寫一份)', mood.state && mood.state.k === ref, `${mood.state && mood.state.k} vs ${ref}`);
        ok('③ 最後一段大跌小彈 → 恐慌', mood.state && mood.state.k === 'PANIC', JSON.stringify(mood.state && { k: mood.state.k, D: mood.state.D, V: mood.state.V }));
        const ld = mood.crowd.find(g => g.k === 'ld');
        ok('③ 跌停 200 家 = 250 天裡最多 → 沒有一天比較高(hi 0)、pct ≥ 99、資料日 2026-10-25(breadth 最後一列)', ld && ld.v === 200 && ld.hi === 0 && ld.pct >= 99 && ld.d === '2026-10-25', JSON.stringify(ld));
        // ④ 決定性對照:mood_hist 有更早一天跌停 500 家 → 今天就不是最多了
        const prev = [{ d: '2025-12-31', ld: 500 }];
        const ld2 = build(tmp, prev, new Date('2026-11-19T12:00:00Z'), { today: '2026-11-19', root: ROOT }).mood.crowd.find(g => g.k === 'ld');
        ok('④ 決定性對照:mood_hist 更早一天 500 家 → 今天不是最多了(hi > 0;短歷史有接上累積的)', ld2 && ld2.hi > 0 && ld2.from === '2025-12-31', JSON.stringify(ld2));
        // ⑤ 讀不到的寫原因(⛔ 當 0)
        const mz = mood.miss.find(x => x.k === 'mg20'), mp = mood.miss.find(x => x.k === 'pcr');
        ok('⑤ 沒有 risk_history / fi_mkt_hist → 融資那條進 miss 而且有原因', mz && /讀不到|不夠/.test(mz.why), JSON.stringify(mz));
        ok('⑤ 沒有 taifex_hist → 買賣權比進 miss', mp && /讀不到/.test(mp.why), JSON.stringify(mp));
        ok('⑤ 當沖占比寫「第 6 期」;沒有 fred_hist → 信用利差 / 用美元算那兩條進 miss 而且寫讀不到', (mood.miss.find(x => x.k === 'dtr') || {}).why?.includes('第 6 期')
            && ['credit', 'usdtw'].every(k => /fred_hist/.test((mood.miss.find(x => x.k === k) || {}).why || '')), JSON.stringify(mood.miss.filter(x => ['dtr', 'credit', 'usdtw'].includes(x.k))));
        const vx = mood.crowd.find(g => g.k === 'vix');
        ok('⑤ VIX:今天有值但沒有美股日線 → miss(⛔ 只給今天沒有歷史卻假裝排第幾)', !vx && mood.miss.some(x => x.k === 'vix'));
        // ⑥ ⛔ 合成總分
        const flat = JSON.stringify(mood);
        ok('⑥ 輸出沒有總分 / 綜合分數那種欄位', !/"(score|total|composite|index)"\s*:/.test(flat), flat.match(/"(score|total|composite|index)"\s*:/)?.[0]);
        // ⑦ mood_hist:今天一列、同一天再跑蓋掉、上限
        ok('⑦ mood_hist 今天那一列有跌停與狀態', hist.at(-1).d === '2026-11-19' && hist.at(-1).ld === 200 && hist.at(-1).st === mood.state.k, JSON.stringify(hist.at(-1)));
        const again = build(tmp, [...hist, { d: '2026-11-18', ld: 1 }], new Date('2026-11-19T13:00:00Z'), { today: '2026-11-19', root: ROOT }).hist;
        ok('⑦ 同一天再跑一次 → 還是一列(蓋掉)、別天的照留', again.filter(r => r.d === '2026-11-19').length === 1 && again.some(r => r.d === '2026-11-18'));
        const big = Array.from({ length: HIST_MAX + 3 }, (_, k) => ({ d: `1990-01-${String(k).padStart(5, '0')}` }));
        ok(`⑦ 超過 ${HIST_MAX} 列 → 刪最舊的`, build(tmp, big, new Date('2026-11-19T12:00:00Z'), { today: '2026-11-19', root: ROOT }).hist.length === HIST_MAX);
        // ⑧ 期現基差換成 % 再排、⛔ 用點數(點數會隨指數水準變大)
        const bs = mood.miss.find(x => x.k === 'basis');
        ok('⑧ 沒有 fi_mkt_hist → 基差進 miss(⛔ 只給今天點數)', !!bs, JSON.stringify(mood.crowd.find(g => g.k === 'basis')));
        // ⑨ 每天該更新的來源停了(breadth 最後一列比加權最新那天舊 ≥ 4 天)→ stale;決定性對照:同一份資料、最後一列就是加權最新那天 → 不標
        const mkB = (end) => { const e = Date.parse(end + 'T00:00:00Z'); return B.map((r, k) => ({ ...r, d: new Date(e - (249 - k) * 864e5).toISOString().slice(0, 10).replace(/-/g, '/') })); };
        const asof = mood.asof, oldEnd = new Date(Date.parse(asof + 'T00:00:00Z') - 10 * 864e5).toISOString().slice(0, 10);
        W('breadth.json', { history: mkB(oldEnd) });
        const ldS = build(tmp, [], new Date('2026-11-19T12:00:00Z'), { today: '2026-11-19', root: ROOT }).mood.crowd.find(g => g.k === 'ld');
        ok('⑨ 跌停那條停在加權最新那天的 10 天前 → stale', ldS && ldS.stale === true && ldS.d === oldEnd, JSON.stringify({ d: ldS && ldS.d, asof, stale: ldS && ldS.stale }));
        W('breadth.json', { history: mkB(asof) });
        const ldF = build(tmp, [], new Date('2026-11-19T12:00:00Z'), { today: '2026-11-19', root: ROOT }).mood.crowd.find(g => g.k === 'ld');
        ok('⑨ 決定性對照:最後一列就是加權最新那天 → ⛔ 標 stale', ldF && !ldF.stale && ldF.d === asof, JSON.stringify({ d: ldF && ldF.d, stale: ldF && ldF.stale }));
        W('breadth.json', { history: B });
        // ⑩~⑬ 💱 FRED 每日歷史(fred_hist.json)
        const dayList = (a, b) => { const out = []; for (let t = Date.parse(a + 'T00:00:00Z'); t <= Date.parse(b + 'T00:00:00Z'); t += 864e5) out.push(new Date(t).toISOString().slice(0, 10)); return out; };
        const fxDays = dayList(addDays(asof, -400), addDays(asof, -1));
        const lin = (a, b) => Object.fromEntries(fxDays.map((d, k) => [d, +(a + (b - a) * k / (fxDays.length - 1)).toFixed(4)]));
        const baaD = Object.fromEntries(fxDays.map((d, k) => [d, +(1.5 + (k % 50) / 100).toFixed(2)]));
        const FHfix = (twd) => ({ v: 1, series: { usdtwd: { sid: 'DEXTAUS', d: twd }, baa10y: { sid: 'BAA10Y', d: baaD } } });
        const M0 = { usdtwd: 32.5, usdtwd_chg_pct: 0.1, usdtwd_date: addDays(asof, -1), dxy: 100, dxy_date: addDays(asof, -1) };
        W('fred_hist.json', FHfix(lin(30, 32))); W('macro_risk.json', M0);
        const mF = build(tmp, [], new Date('2026-11-19T12:00:00Z'), { today: '2026-11-19', root: ROOT }).mood;
        const tw10 = mF.fx.find(r => r.k === 'usdtwd'), aOf = addDays(asof, -1), base = lin(30, 32)[addDays(aOf, -28)];
        ok('⑩ 匯率接 FRED:20 日 = 今天 ÷ 28 天前那一筆 − 1、一年位置 = 比過去一年都高(hi 0)、寫出來源', tw10 && tw10.c20 === r2((32.5 / base - 1) * 100)
            && tw10.pos && tw10.pos.hi === 0 && tw10.pos.n > 300 && /FRED DEXTAUS/.test(tw10.hs || ''), JSON.stringify(tw10 && { c20: tw10.c20, base, pos: tw10.pos, hs: tw10.hs, hwhy: tw10.hwhy }));
        W('macro_risk.json', { ...M0, usdtwd: 3250 });
        const tw10b = build(tmp, [], new Date('2026-11-19T12:00:00Z'), { today: '2026-11-19', root: ROOT }).mood.fx.find(r => r.k === 'usdtwd');
        ok('⑩b 決定性對照:今天的匯率 ×100(單位對不上)→ ⛔ 接、20 日 / 一年位置都空、寫原因', tw10b && tw10b.c20 == null && tw10b.pos == null && /不像同一把尺/.test(tw10b.hwhy || ''), JSON.stringify(tw10b && { c20: tw10b.c20, pos: tw10b.pos, hwhy: tw10b.hwhy }));
        W('macro_risk.json', M0);
        const cr = mF.crowd.find(g => g.k === 'credit');
        ok('⑪ 信用利差:今天 = FRED 最後一筆、跟 FRED 自己的歷史比、⛔ 進 miss', cr && cr.v === baaD[fxDays.at(-1)] && cr.d === fxDays.at(-1) && cr.from === fxDays[0] && cr.lab === 'credit-diverge'
            && !mF.miss.some(x => x.k === 'credit'), JSON.stringify(cr && { v: cr.v, d: cr.d, from: cr.from, pct: cr.pct }));
        // ⑫ 用美元算:匯率不動 → 兩個跌幅一樣(決定性對照);台幣貶 → 用美元算跌比較多
        const flat30 = Object.fromEntries(fxDays.map(d => [d, 30]));
        W('fred_hist.json', FHfix(flat30)); W('macro_risk.json', { ...M0, usdtwd: 30, usdtwd_date: asof });
        const u0 = build(tmp, [], new Date('2026-11-19T12:00:00Z'), { today: '2026-11-19', root: ROOT }).mood.seats.fi.find(r => r.k === 'usdtw');
        ok('⑫ 匯率一直是 30 → 用美元算 == 用台幣算', u0 && Math.abs(u0.v - u0.ddT) < 0.02 && u0.v < -5 && /用台幣算 −/.test(u0.note), JSON.stringify(u0 && { v: u0.v, ddT: u0.ddT, note: u0.note }));
        const rise = Object.fromEntries(fxDays.map((d, k) => [d, k > fxDays.length - 40 ? 33 : 30]));
        W('fred_hist.json', FHfix(rise)); W('macro_risk.json', { ...M0, usdtwd: 33, usdtwd_date: asof });
        const u1 = build(tmp, [], new Date('2026-11-19T12:00:00Z'), { today: '2026-11-19', root: ROOT }).mood.seats.fi.find(r => r.k === 'usdtw');
        const expU = u1 ? r2(((1 + u1.ddT / 100) / (33 / 30) - 1) * 100) : null;
        ok('⑫b 最近台幣從 30 貶到 33(貶 10%)→ 用美元算 = (1 + 台幣跌幅) ÷ 1.1 − 1、寫出台幣貶 10%', u1 && Math.abs(u1.v - expU) < 0.05 && u1.v < u1.ddT && u1.fxChg === 10 && /台幣貶 10%/.test(u1.note),
            JSON.stringify(u1 && { v: u1.v, expU, ddT: u1.ddT, fxChg: u1.fxChg }));
        // ⑬ FRED 沒有的(美元指數)→ 用 mood_hist 自己每天存的;不到 20 天 → 還在累積
        W('fred_hist.json', FHfix(lin(30, 32))); W('macro_risk.json', M0);
        const own = n => Array.from({ length: n }, (_, k) => ({ d: addDays(aOf, -(n - k)), fx: { dxy: [99 + k * 0.01, addDays(aOf, -(n - k))] } }));
        const dx25 = build(tmp, own(25), new Date('2026-11-19T12:00:00Z'), { today: '2026-11-19', root: ROOT }).mood.fx.find(r => r.k === 'dxy');
        ok('⑬ 美元指數:FRED 沒有 → 用 App 自己每天存的 25 天排一年位置(今天 100 = 最高)', dx25 && dx25.pos && dx25.pos.hi === 0 && /自己每天存的\(25 天\)/.test(dx25.hs || ''), JSON.stringify(dx25 && { pos: dx25.pos, hs: dx25.hs }));
        const dx5 = build(tmp, own(5), new Date('2026-11-19T12:00:00Z'), { today: '2026-11-19', root: ROOT }).mood.fx.find(r => r.k === 'dxy');
        ok('⑬b 只存了 5 天 → 一年位置排不出來(還在累積)、⛔ 硬排', dx5 && dx5.pos && dx5.pos.pct == null && dx5.pos.n === 6, JSON.stringify(dx5 && dx5.pos));
        const hF = build(tmp, [], new Date('2026-11-19T12:00:00Z'), { today: '2026-11-19', root: ROOT }).hist.at(-1);
        ok('⑬c mood_hist 今天那一列存了匯率(值 + 那個值的日期)', hF.fx && Array.isArray(hF.fx.usdtwd) && hF.fx.usdtwd[0] === 32.5 && hF.fx.dxy[1] === aOf, JSON.stringify(hF.fx));
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    console.log(bad ? `\n❌ ${bad} 條沒過` : '\n✅ 全部通過');
    return bad ? 1 : 0;
}

const _isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (_isMain) {
    const [a, b, c] = process.argv.slice(2);
    if (a === '--selftest') process.exit(selftest());
    if (!a || !b) { console.error('用法:node scripts/mood_build.mjs <data 目錄> <out mood.json> [<mood_hist.json>]'); process.exit(1); }
    let prev = [];
    if (c && fs.existsSync(c)) {
        try { prev = JSON.parse(fs.readFileSync(c, 'utf8')); if (!Array.isArray(prev)) throw new Error('不是陣列'); }
        catch (e) { console.error(`🚨 ${c} 讀不出來(${String(e.message || e).slice(0, 80)})→ ⛔ 寫回(累積檔讀壞 ⛔ 用今天蓋掉歷史)`); process.exit(1); }
    }
    const { mood, hist } = build(a, prev);
    fs.writeFileSync(b, JSON.stringify(mood));
    if (c) fs.writeFileSync(c, JSON.stringify(hist));
    console.log(`🧠 ${mood.state ? `心理狀態 ${mood.state.zh}(${mood.state.since} 起 ${mood.state.days} 天)` : '心理狀態算不出來'} ・群眾 ${mood.crowd.length} 條 ・座位 ${Object.values(mood.seats).reduce((s, x) => s + x.length, 0)} 條 ・匯率 ${mood.fx.length} ・風向 ${mood.wind.length} ・讀不到 ${mood.miss.length}${c ? ` ・mood_hist ${hist.length} 列` : ''}`);
    if (!mood.state && !mood.crowd.length) { console.error('🚨 一條都算不出來 → exit 1'); process.exit(1); }
}
