#!/usr/bin/env node
/**
 * 🧠 V82.5.5 產業作戰室「🧠 人性」頁的數字(使用者 11/18:「App 太理性 —— 貪婪與恐懼、大戶外資的角度、匯率風向」)
 *
 * ⛔ 只描述:⛔ 合成總分、⛔ 下買賣指令、⛔ 用紅綠講好壞。每一條 = 今天的值 + 那個值的資料日 + 在它自己的歷史排第幾 + 歷史起訖
 *   + 實測總表(pro.html PRO.LAB)那一條的主題鍵 lab(頁面只轉述那一條的結論,⛔ 這裡另寫結論)。
 * 資料原則:
 *   ① 今天的值 ← 每天都會更新的檔(macro_risk / risk_history / breadth / attention_history / ^TWII / screener);
 *      長歷史只拿來算排第幾(fi_mkt_hist / taifex_hist:V82.5.7 起明日作戰清單那一步每天接著補(scripts/hist_daily.py),
 *      停在哪天就寫哪天;比加權最新那天舊 ≥ STALE_D 天自動標 stale)。
 *   ② 兩份來源接在一起之前,先比重疊那段的值(陷阱 #17:同名不同單位 / 不同算法)→ 對不上那條就不接、進 miss 寫原因。
 *      實例:risk_history.retail_ls_pct 跟 taifex_hist.rl[3] 名字都叫散戶多空比,數字完全對不上 → 分開,只用前者自己的 90 天。
 *   ③ 讀不到 / 算不出來 → miss 寫原因(⛔ 當 0、⛔ 默默不顯示)。
 *   ④ ⛔ 加總 risk_history 的每日外資(快照有時晚一天、會重複 —— 陷阱 #16)→ 外資「今天」「本月累計」照官方那兩格;
 *      V82.5.7 起「5 日 / 20 日 / 今年」= fi_mkt_hist.spot(官方每天一個值、一天一筆)加總 —— 最後一天要跟加權最新那天一樣才算「到今天」。
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
import { concDaily, rollMean } from './lib_conc.mjs';
import { adjust as adrAdjust, premium as adrPremium } from './adr_premium_probe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MIN_N = 20;          // 歷史不到 20 天 → 不給排第幾(只寫「還在累積」)
export const STALE_D = 4;   // 比加權最新那天舊幾個日曆天就算停了(同畫面 ≥4 天轉黃 ⚠️ 那條)
export const HIST_MAX = 5000;     // mood_hist 最多留幾列
export const FI_WIN = 750;        // 外資 / 投信買賣超只跟近 3 年比(早年規模小,整段比不公平)
export const DTR_WIN = 750;       // 📊 V82.6.4 當沖占比也只跟近 3 年比:歷史往前補到 2014,而 2014 年初占比不到 1%(可以當沖的只有 150 檔)、2018 約 24%、2022 約 46%
                                  //   → 整段一起比,今天天天「比幾乎所有日子高」(⛔ 把制度變化當成人心)
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

/** 💹 V82.5.7 外資現貨「最後 N 筆」加總(fi_mkt_hist.spot 的外資那一格,億;官方每天一個值、一天一筆)
 *  → { last, roll: {n: [[日期, 到那天為止 N 筆的加總]…]}, days: {n: [第一天, 最後一天]}, ytd, ytdN };沒有 → null
 *  cal(加權有開盤的日子)有給 → 最後 N 筆要剛好是最後 N 個交易日,跨過缺資料的日子 → gap 列出來(⛔ 默默多算一天) */
export function fiSums(FM, cal = null, ns = [5, 20]) {
    if (!FM || !FM.spot) return null;
    const P = Object.keys(FM.spot).sort().map(k => [d10(k), Array.isArray(FM.spot[k]) ? num(FM.spot[k][0]) : null]).filter(([, v]) => v != null);
    if (!P.length) return null;
    const last = P.at(-1)[0], roll = {}, days = {}, gap = {};
    for (const n of ns) {
        const out = []; let acc = 0;
        for (let i = 0; i < P.length; i++) { acc += P[i][1]; if (i >= n) acc -= P[i - n][1]; if (i >= n - 1) out.push([P[i][0], r2(acc)]); }
        roll[n] = out;
        days[n] = P.length >= n ? [P[P.length - n][0], last] : null;
        if (cal && days[n]) {
            const ci = cal.lastIndexOf(last), have = new Set(P.slice(-n).map(x => x[0]));
            if (ci >= 0) gap[n] = cal.slice(Math.max(0, ci - n + 1), ci + 1).filter(d => !have.has(d));
        }
    }
    const y = last.slice(0, 4), Y = P.filter(([d]) => d.startsWith(y));
    return { last, roll, days, gap, ytd: Y.reduce((a, [, v]) => a + v, 0), ytdN: Y.length };
}

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
            { hiw: '怕', note: '期交所每天的買賣權未平倉量比率(明日作戰清單那一步接著補);> 100 = 賣權比較多' + ((TX.daily && TX.daily.err && TX.daily.err.pc) ? `。⚠️ 最近一次接著補沒成功:${TX.daily.err.pc}` : '') }));
    } else M('pcr', '選擇權賣權 ÷ 買權', tx.err || 'taifex_hist 沒有 pc');
    // ── 外資與大戶(換座位)
    const seats = { fi: [], trust: [], retail: [], insider: [], gov: [] };
    // ⚠️ V82.5.7 fi_mkt_hist 每天接著補之後,它最後一天常常就是「今天」→ 排第幾的歷史只取那一天以前的(⛔ 把今天自己算進去)
    const fiHist = (idx, before) => {
        if (!FM || !FM.spot) return { vals: [] };
        const ks = Object.keys(FM.spot).filter(k => !before || d10(k) < before).sort().slice(-FI_WIN);
        return { vals: ks.map(k => Array.isArray(FM.spot[k]) ? num(FM.spot[k][idx]) : null), from: d10(ks[0]), to: d10(ks.at(-1)) };
    };
    if (num(m.fi_spot_net) != null) seats.fi.push(gauge('fis', '外資現貨買賣超(今天)', 'both', num(m.fi_spot_net), '億', m.fi_spot_date, fiHist(0, d10(m.fi_spot_date)), 'fi-outflow', { hiw: '買超大', low: '賣超大', note: '上市;只跟近 3 年比(早年規模小)' }));
    else M('fis', '外資現貨買賣超', mr.err || 'macro_risk 沒有 fi_spot_net');
    if (num(m.fi_spot_mtd) != null) seats.fi.push({ k: 'fim', name: `外資本月累計(${m.fi_spot_mtd_month || ''})`, v: r2(num(m.fi_spot_mtd)), unit: '億', d: d10(m.fi_spot_date), lab: 'fi-follow',
        note: `證交所月報的累計(這個月 ${num(m.fi_spot_mtd_days) ?? '—'} 個交易日);⛔ 自己把每天加起來(快照會重複)。月中跟整個月不能比 → 不排第幾` });
    // 💹 V82.5.7 外資 5 日 / 20 日 / 今年:fi_mkt_hist.spot = 官方每天一個值(上市三大法人的外資;一天一筆,⛔ 每天的快照)
    //   最後 N 筆加總;排第幾 = 同樣「連續 N 筆」的加總在近 3 年(⛔ 含今天自己)。最後一天比加權最新那天舊 → 下面的 stale 會標出來
    {
        const fsum = fiSums(FM, S ? S.d : null);
        if (!fsum) M('fi5', '外資現貨 5 日 / 20 日 / 今年', fm.err || 'fi_mkt_hist 沒有 spot');
        else {
            for (const [n, k] of [[5, 'fi5'], [20, 'fi20']]) {
                const R = fsum.roll[n], cur = R.at(-1);
                if (!cur) { M(k, `外資現貨 ${n} 日合計`, `fi_mkt_hist.spot 不到 ${n} 筆`); continue; }
                const H = R.slice(0, -1).slice(-FI_WIN), gp = (fsum.gap && fsum.gap[n]) || [];
                seats.fi.push(gauge(k, `外資現貨 ${n} 日合計`, 'both', cur[1], '億', fsum.last, { vals: H.map(x => x[1]), from: H[0] ? H[0][0] : null, to: H.at(-1) ? H.at(-1)[0] : null }, 'fi-outflow',
                    { hiw: '買超大', low: '賣超大', note: `${fsum.days[n][0]} ~ ${fsum.last} 這 ${n} 筆官方每日值加總(上市);跟近 3 年每一段「連續 ${n} 筆」的加總比`
                        + (gp.length ? `。⚠️ 這段有 ${gp.length} 個交易日沒有資料(${gp.join('、')}),實際跨了 ${n + gp.length} 個交易日` : '') }));
            }
            seats.fi.push({ k: 'fiy', name: `外資現貨今年累計(${fsum.last.slice(0, 4)})`, v: r2(fsum.ytd), unit: '億', d: fsum.last, lab: 'fi-follow',
                note: `${fsum.ytdN} 個交易日的官方每日值加總(上市);今年到現在跟整年不能比 → 不排第幾` });
            todayRow.fi5 = r2(fsum.roll[5].at(-1) ? fsum.roll[5].at(-1)[1] : null); todayRow.fid = fsum.last;
        }
    }
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
            { note: `前 10 大淨 ${Array.isArray(x) ? x[1] : '—'} 口 ÷ 全市場 ${Array.isArray(x) ? x[2] : '—'} 口(期交所台指期大額交易人,主力近月;明日作戰清單那一步接著補)` + ((TX.daily && TX.daily.err && TX.daily.err.lt) ? `。⚠️ 最近一次接著補沒成功:${TX.daily.err.lt}` : '') }));
    }
    // 台積電 ADR 溢價:🇺🇸 V82.6.1 跟過去一年(美股 250 天)比 —— 歷史 = us_hist 的 TSM(還原過股利)÷ 2330 用同一種方式還原
    //   (adr_premium_probe 的 adjust / premium,研究同一份 ⛔ 另寫;陷阱 #49 同一把尺);今天 = 總經風險檔的原始價格
    //   (最近一次除息之後兩邊都還沒有還原差)。2330 除息紀錄讀不到 → 不排(⛔ 拿還原過的 ADR 比原始的 2330)
    const k2330 = rdj(dir, '2330.json');
    const r2330 = Array.isArray(k2330.j) ? k2330.j.filter(r => num(r.close) > 0).at(-1) : null;
    if (num(m.tsm) > 0 && num(m.usdtwd) > 0 && r2330) {
        const v = (num(m.tsm) * num(m.usdtwd) / 5 / num(r2330.close) - 1) * 100, td = d10(m.tsm_date) || today;
        let vals = [], hfrom = null, hto = null, hwhy = null;
        const ts = us.j && us.j.syms && us.j.syms.TSM, dv = rdj(dir, 'dividends_hist.json'), dh = dv.j && (dv.j.d || dv.j) && (dv.j.d || dv.j)['2330'];
        if (!ts || !Array.isArray(ts.c) || !Array.isArray(us.j.days)) hwhy = us.err || 'us_hist 沒有 TSM';
        else if (!FH || !FH.usdtwd) hwhy = fh.err || 'fred_hist 沒有 usdtwd';
        else if (!dh || !Array.isArray(dh.h)) hwhy = dv.err || 'dividends_hist 沒有 2330 的除息紀錄(⛔ 拿還原過的 ADR 比原始的 2330)';
        else {
            const US = { d: [], c: [] }; us.j.days.forEach((d, i) => { const x = num(ts.c[i]); if (x > 0 && d10(d) < td) { US.d.push(d10(d)); US.c.push(x); } });
            const fx = fredPts(FH, 'usdtwd'), FX = { d: fx.map(x => x[0]), v: fx.map(x => x[1]) };
            const rows = k2330.j.filter(r => num(r.close) > 0), T = adrAdjust({ d: rows.map(r => d10(r.date)), c: rows.map(r => num(r.close)) }, dh.h);
            const P = adrPremium(US, FX, T, T).slice(-250);
            if (P.length >= MIN_N) { vals = P.map(x => x.p); hfrom = P[0].t; hto = P.at(-1).t; } else hwhy = `ADR 歷史只對得上 ${P.length} 天`;
        }
        seats.fi.push(gauge('adr', '台積電 ADR 溢價', 'both', v, '%', td, { vals, from: hfrom, to: hto }, 'adr-premium', { hiw: '溢價大(美國那邊比較願意付)', low: '溢價小 / 折價',
            note: `ADR ${num(m.tsm)} 美元(${d10(m.tsm_date)})× 匯率 ${num(m.usdtwd)} ÷ 5 vs 台股 ${num(r2330.close)}(${d10(r2330.date)});兩邊收盤時間不同。排第幾 = 跟過去一年(美股 250 天)比${hwhy ? `・⏳ ${hwhy}` : '・歷史 = 美股日線那份(手動更新)÷ 2330 同樣還原過股利'}` }));
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
                seats.fi.push({ k: 'usdtw', name: '這一波:用台幣算 vs 用美元算', v: ddU, unit: '%', d: twNow.d, lab: 'usd-dd', ddT, fxChg,
                    note: `離近一年高點:用台幣算 ${pc(ddT)}(高點 ${hiT[0]})、用美元算 ${pc(ddU)}(高點 ${hiU[0]})` + (fxChg != null ? `;同一段台幣${fxChg > 0 ? '貶' : '升'} ${Math.abs(fxChg)}%(外資用美元記帳,賣股換美元時匯率也算在裡面)` : '')
                        + `。匯率 = FRED(一週更新一次,中間沒有的 ${ff} 天用前面最近一筆)` + (todayOk ? ',今天用總經風險檔那一筆' : ',今天的匯率跟 FRED 對不上 → 用 FRED 最後一筆') });
            } else M('usdtw', '這一波:用台幣算 vs 用美元算', '匯率歷史接不到今天(FRED 太舊或今天的匯率讀不到)');
        } else M('usdtw', '這一波:用台幣算 vs 用美元算', fh.err || (FH ? 'fred_hist 沒有美元台幣(或太短)' : 'fred_hist.json 讀不到'));
    }
    if (num(m.fi_trust_net) != null) seats.trust.push(gauge('fit', '投信買賣超(今天)', 'both', num(m.fi_trust_net), '億', m.fi_three_date, fiHist(1, d10(m.fi_three_date)), 'fi-trust-sync', { hiw: '買超大', low: '賣超大', note: '上市;只跟近 3 年比' }));
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
    // 🔬 V82.5.9 測過的那幾列帶實測總表的主題鍵(畫面轉述那一條的結論;沒測過的列 ⛔ 每一列都印「還沒測過」)
    //   💱 V82.6.6 美元 / 台幣那一列改轉述 twd-weak(EXP-20261123-01「台幣一年最弱 + 修正中 → 台股比較慢回來?」⛔ 量不到)——
    //     那一列印的就是台幣的一年位置,這一題才是在問它;外資座位「用台幣算 vs 用美元算」那一行照舊 usd-dd
    //   ₿ V82.6.7 比特幣那一列轉述 btc-tw(EXP-20261123-02「比特幣能不能提早知道台股開盤 / 盤中 / 大跌之後」⛔ 四個判定全沒過)
    const FX_LAB = { jpy: 'yen-surge', usdtwd: 'twd-weak', btc_usd: 'btc-tw' };
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
        fx.push({ k, name, v, c1: c1 ? num(m[c1]) : null, c5: c5v, c20, pos, hs, hwhy, d: dd, upd: dk ? null : (m.updated || null), note, lab: FX_LAB[k] || null });   // 沒有自己的日期 → 只寫檔案更新時間(⛔ 假裝是今天的)
    }
    todayRow.fx = Object.fromEntries(fx.map(r => [r.k, [r.v, r.d || null]]));
    if (num(m.sox_chg_pct) != null && num(m.sp500_chg_pct) != null) wind.push({ k: 'soxsp', name: '費半 − 標普(今天)', v: r2(num(m.sox_chg_pct) - num(m.sp500_chg_pct)), unit: 'pp', d: d10(m.sox_date), note: `費半 ${num(m.sox_chg_pct)}%・標普 ${num(m.sp500_chg_pct)}%`, lab: null });
    const two = rdj(dir, '^TWOII.json'), tw = rdj(dir, '^TWII.json');
    const r20 = j => { const a = Array.isArray(j) ? j.filter(r => num(r.close) > 0) : []; return a.length > 21 ? { v: (a.at(-1).close / a.at(-21).close - 1) * 100, d: d10(a.at(-1).date) } : null; };
    const A = r20(tw.j), B = r20(two.j);
    if (A && B) wind.push({ k: 'twotc', name: '加權 − 櫃買(近 20 日)', v: r2(A.v - B.v), unit: 'pp', d: A.d === B.d ? A.d : `${A.d} / ${B.d}`, note: `加權 ${r2(A.v)}%・櫃買 ${r2(B.v)}%(正 = 大型股比較撐)`, lab: null });
    else M('twotc', '加權 − 櫃買', two.err || tw.err || '加權或櫃買不到 21 天');
    // 📊 V82.6.0 成交集中度(前 10 大成交金額 ÷ 全部個股,⛔ 00 開頭的 ETF):每晚從 data/ 每一檔 K 線直接算
    //   (lib_conc.concDaily —— 研究 conc_probe 同一份,⛔ 另寫)→ 歷史約 5 年、當天就排得出第幾(以前讀 screener 只有今天、要一天一天累積)
    //   主數字 = 近 20 天平均:EXP-20261120-03 單日擠到很高多半是大漲大跌那一天;結論只轉述實測總表 conc-extreme(⛔ 另寫一句)
    //   最後一天的成交金額不到前 20 天中位數一半 → 看起來還沒收完(盤中那一輪),先不算那一天
    const CC = opt.conc !== undefined ? opt.conc : (() => { try { return concDaily(dir); } catch (e) { return { rows: [], err: String(e && e.message || e) }; } })();
    let cr = (CC && CC.rows) || [], partial = null;
    if (cr.length > 21) {
        const t20 = cr.slice(-21, -1).map(r => r.tot).sort((a, b) => a - b), med = t20[Math.floor(t20.length / 2)];
        if (cr.at(-1).tot < med * 0.5) { partial = cr.at(-1).d; cr = cr.slice(0, -1); }
    }
    if (cr.length >= 20 + MIN_N) {
        const avg = rollMean(cr.map(r => r.s10), 20), i = cr.length - 1, vals = avg.slice(19, i);
        const yrs = Math.round((Date.parse(cr[i].d) - Date.parse(cr[19].d)) / (365.25 * 864e5) * 10) / 10;
        crowd.push(gauge('conc', '成交集中在前 10 檔(近 20 天平均)', 'both', avg[i], '%', cr[i].d, { vals, from: cr[19].d, to: cr[i - 1].d }, 'conc-extreme',
            { hiw: '擠在少數幾檔', low: '大家分散在很多檔', today1: r2(cr[i].s10), note: `今天單日 ${r2(cr[i].s10)}%(前 10 大成交金額 ÷ ${cr[i].n} 檔個股,不含 ETF)・歷史 = data/ 每一檔 K 線自己算(約 ${yrs} 年)${partial ? `・${partial} 那一天的成交金額不到平常一半,看起來還沒收完 → 先不算` : ''}` }));
        todayRow.conc = r2(cr[i].s10); todayRow.conc20 = r2(avg[i]); todayRow.cd = cr[i].d;
    } else M('conc', '成交集中度', (CC && CC.err) || `data/ 的個股 K 線只算得出 ${cr.length} 天(近 20 天平均要再排第幾,至少 ${20 + MIN_N} 天)`);
    // 📊 V82.5.8 全市場當沖占比(上市;data/dtr_hist.json = hist_daily 每晚從證交所 TWTB4U 統計表收的,每晚往前補幾天)
    //   值 = 當沖買進 / 賣出成交金額占市場比重的平均;排第幾只跟自己的歷史比(不到 MIN_N 天寫「還在累積」)
    const dt = rdj(dir, 'dtr_hist.json'), DT = dt.j && dt.j.d && typeof dt.j.d === 'object' ? dt.j.d : null;
    const dtAmt = r => Array.isArray(r) && num(r[1]) != null && num(r[2]) != null ? (num(r[1]) + num(r[2])) / 2 : null;
    if (DT && Object.keys(DT).length) {
        const ks = Object.keys(DT).sort(), lk = ks.at(-1), x = DT[lk], hk = ks.slice(0, -1).slice(-DTR_WIN);
        crowd.push(gauge('dtr', '當沖成交金額占比(上市)', 'greed', dtAmt(x), '%', lk, { vals: hk.map(k => dtAmt(DT[k])), from: hk[0] || lk, to: lk }, null,
            { hiw: '貪(短線進出多)', note: `證交所當日沖銷交易統計:買進 ${x[1]}%、賣出 ${x[2]}%(成交金額占市場比重,取平均);成交股數占 ${x[0]}%。排第幾只跟近 3 年比(2014 年初占比不到 1%,制度跟現在不同);收到的歷史 ${ks[0]} 起(每晚往前補,補到 2014 年初),滿 ${MIN_N} 天才排得出第幾` }));
        todayRow.dtr = r2(dtAmt(x)); todayRow.dtd = lk;
    } else M('dtr', '當沖占比', dt.err || 'dtr_hist.json 還沒有資料');
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
        ok('⑤ 沒有 dtr_hist → 當沖占比進 miss 寫讀不到;沒有 fred_hist → 信用利差 / 用美元算那兩條進 miss 而且寫讀不到', /dtr_hist/.test((mood.miss.find(x => x.k === 'dtr') || {}).why || '')
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
        const M0 = { usdtwd: 32.5, usdtwd_chg_pct: 0.1, usdtwd_date: addDays(asof, -1), dxy: 100, dxy_date: addDays(asof, -1), btc_usd: 61496 };
        W('fred_hist.json', FHfix(lin(30, 32))); W('macro_risk.json', M0);
        const mF = build(tmp, [], new Date('2026-11-19T12:00:00Z'), { today: '2026-11-19', root: ROOT }).mood;
        const tw10 = mF.fx.find(r => r.k === 'usdtwd'), aOf = addDays(asof, -1), base = lin(30, 32)[addDays(aOf, -28)];
        ok('⑩ 匯率接 FRED:20 日 = 今天 ÷ 28 天前那一筆 − 1、一年位置 = 比過去一年都高(hi 0)、寫出來源', tw10 && tw10.c20 === r2((32.5 / base - 1) * 100)
            && tw10.pos && tw10.pos.hi === 0 && tw10.pos.n > 300 && /FRED DEXTAUS/.test(tw10.hs || ''), JSON.stringify(tw10 && { c20: tw10.c20, base, pos: tw10.pos, hs: tw10.hs, hwhy: tw10.hwhy }));
        ok('⑩c 匯率表測過的那一列帶實測總表的主題鍵:台幣 → twd-weak(V82.6.6;一年位置那一題)、比特幣 → btc-tw(V82.6.7)、美元指數沒測過 → null(⛔ 亂掛別條)', tw10 && tw10.lab === 'twd-weak'
            && (mF.fx.find(r => r.k === 'btc_usd') || {}).lab === 'btc-tw' && (mF.fx.find(r => r.k === 'dxy') || {}).lab === null, JSON.stringify(mF.fx.map(r => [r.k, r.lab])));
        const proSrc = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8'), labs = mF.fx.map(r => r.lab).filter(Boolean);
        ok('⑩d 匯率表轉述的主題鍵每一條都真的在實測總表裡(pro.html LAB 的 k;⛔ 打錯字 = 那一列轉述不到)', labs.length >= 2 && labs.every(k => proSrc.includes(`k: '${k}'`)), JSON.stringify(labs.filter(k => !proSrc.includes(`k: '${k}'`))));
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
        ok('⑫c 外資座位「用台幣算 vs 用美元算」那一列帶 usd-dd(畫面轉述 EXP-20261120-02 的結論)', u0 && u0.lab === 'usd-dd', JSON.stringify(u0 && u0.lab));
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
        // ⑭ 💹 V82.5.7 外資 5 日 / 20 日 / 今年(fi_mkt_hist.spot,官方每天一個值;hist_daily 每天接著補)
        const calD = S.d, ai = calD.lastIndexOf(asof), spotD = calD.slice(ai - 799, ai + 1);
        const spot = Object.fromEntries(spotD.map((d, k) => [d, [k % 7 - 3, 1, 0]]));
        spot[asof] = [999, 1, 0];   // 今天特別大 → 拿來驗「排第幾 ⛔ 把今天自己算進去」
        W('fi_mkt_hist.json', { spot });
        W('macro_risk.json', { ...M0, fi_spot_net: 999, fi_spot_date: asof.replace(/-/g, '') });
        const md = build(tmp, [], new Date('2026-11-19T12:00:00Z'), { today: '2026-11-19', root: ROOT }).mood;
        const f5 = md.seats.fi.find(r => r.k === 'fi5'), f20 = md.seats.fi.find(r => r.k === 'fi20'), fy = md.seats.fi.find(r => r.k === 'fiy'), fs_ = md.seats.fi.find(r => r.k === 'fis');
        const sumOf = ds => Math.round(ds.reduce((a, d) => a + spot[d][0], 0) * 100) / 100;
        const y0 = asof.slice(0, 4), yd = spotD.filter(d => d.startsWith(y0));
        ok('⑭ 5 日 / 20 日合計 = 最後 5 / 20 筆官方每日值加總(手算)、資料日 = 加權最新那天、⛔ stale',
            f5 && f5.v === sumOf(spotD.slice(-5)) && f20 && f20.v === sumOf(spotD.slice(-20)) && f5.d === asof && !f5.stale && !f20.stale, JSON.stringify({ f5: f5 && f5.v, f20: f20 && f20.v, want: [sumOf(spotD.slice(-5)), sumOf(spotD.slice(-20))] }));
        ok('⑭ 今年累計 = 那一年每一筆加總、天數對、⛔ 排第幾(今年到現在跟整年不能比)', fy && fy.v === sumOf(yd) && new RegExp(`^${yd.length} 個交易日`).test(fy.note) && !('pct' in fy), JSON.stringify(fy));
        ok('⑭ 5 日排第幾的歷史 = 近 3 年「連續 5 筆」的加總、⛔ 含今天自己(n = 750 + 1、歷史到昨天)', f5.n === FI_WIN + 1 && f5.to === spotD.at(-2), JSON.stringify({ n: f5.n, to: f5.to }));
        ok('⑭ 外資今天那一條(fis):歷史到昨天、⛔ 把今天自己算進去(決定性對照:舊寫法歷史最後一天 = 今天)', fs_ && fs_.to === spotD.at(-2) && fs_.lo === r2(FI_WIN / (FI_WIN + 1) * 100), JSON.stringify(fs_ && { to: fs_.to, lo: fs_.lo, n: fs_.n }));
        ok('⑭ fiSums 純函式:roll 5 第一筆 = 前 5 筆加總', (() => { const F = fiSums({ spot }); return F.roll[5][0][1] === sumOf(spotD.slice(0, 5)) && F.last === asof; })());
        // ⑭b 最後 5 筆中間缺一個交易日 → 寫出缺哪天、實際跨了 6 個交易日(⛔ 默默多算一天)
        const holeD = spotD.at(-3), spotH = { ...spot }; delete spotH[holeD];
        W('fi_mkt_hist.json', { spot: spotH });
        const f5h = build(tmp, [], new Date('2026-11-19T12:00:00Z'), { today: '2026-11-19', root: ROOT }).mood.seats.fi.find(r => r.k === 'fi5');
        ok('⑭b 最後 5 筆跨過缺資料的那天 → 寫出缺哪天、實際跨 6 個交易日', f5h && f5h.note.includes(holeD) && f5h.note.includes('實際跨了 6 個交易日'), f5h && f5h.note);
        // ⑭c 停在 10 個交易日前 → 自動 stale(⛔ 寫死);上面 ⑭ 是決定性對照(到加權最新那天 → 不標)
        W('fi_mkt_hist.json', { spot: Object.fromEntries(spotD.slice(0, -10).map(d => [d, spot[d]])) });
        const f5s = build(tmp, [], new Date('2026-11-19T12:00:00Z'), { today: '2026-11-19', root: ROOT }).mood.seats.fi.find(r => r.k === 'fi5');
        ok('⑭c 外資長歷史停在 10 個交易日前 → 5 日合計標 stale、資料日寫那天', f5s && f5s.stale === true && f5s.d === spotD.at(-11), JSON.stringify(f5s && { d: f5s.d, stale: f5s.stale }));
        // ⑮ 買賣權比 / 期貨大戶:⛔ 寫死 stale,照日期判(hist_daily 每天接著補)
        const txD = calD.slice(ai - 59, ai + 1);
        const mkTX = ds => ({ pc: Object.fromEntries(ds.map((d, k) => [d, [90, 60 + k % 9]])), lt: Object.fromEntries(ds.map((d, k) => [d, { all: [1000, 2000 + k, 130000] }])),
            daily: { err: { pc: '下載頁:2026/11 斷路' } } });
        W('taifex_hist.json', mkTX(txD));
        const m15 = build(tmp, [], new Date('2026-11-19T12:00:00Z'), { today: '2026-11-19', root: ROOT }).mood;
        const pcr = m15.crowd.find(g => g.k === 'pcr'), lt10 = m15.seats.fi.find(g => g.k === 'lt10');
        ok('⑮ 買賣權比 / 期貨大戶到加權最新那天 → ⛔ stale、資料日 = 那天', pcr && !pcr.stale && pcr.d === asof && lt10 && !lt10.stale && lt10.d === asof, JSON.stringify({ pcr: pcr && [pcr.d, pcr.stale], lt10: lt10 && [lt10.d, lt10.stale] }));
        ok('⑮ 最近一次接著補沒成功 → 說明裡寫出來', pcr && pcr.note.includes('最近一次接著補沒成功') && pcr.note.includes('斷路'), pcr && pcr.note);
        W('taifex_hist.json', mkTX(txD.slice(0, -10)));
        const m15s = build(tmp, [], new Date('2026-11-19T12:00:00Z'), { today: '2026-11-19', root: ROOT }).mood;
        const pcrS = m15s.crowd.find(g => g.k === 'pcr'), ltS = m15s.seats.fi.find(g => g.k === 'lt10');
        ok('⑮ 決定性對照:停在 10 個交易日前 → 兩條都自動 stale', pcrS && pcrS.stale === true && ltS && ltS.stale === true, JSON.stringify({ pcr: pcrS && [pcrS.d, pcrS.stale], lt: ltS && [ltS.d, ltS.stale] }));
        // ⑯ 📊 全市場當沖占比(dtr_hist.json,hist_daily 每晚收):值 = 買進 / 賣出金額占比平均、歷史不含今天、不到 20 天不排
        const dtD = calD.slice(ai - 24, ai + 1), mkDT = ds => ({ d: Object.fromEntries(ds.map((d, k) => [d, [25 + k % 3, 38 + k % 4, 38.2 + k % 4, 1, 1, 1]])) });
        const dt25 = mkDT(dtD); dt25.d[asof] = [27.83, 41.29, 41.35, 4259348000, 389437473750, 389961679540];
        W('dtr_hist.json', dt25);
        const g16 = build(tmp, [], new Date('2026-11-19T12:00:00Z'), { today: '2026-11-19', root: ROOT }).mood.crowd.find(g => g.k === 'dtr');
        ok('⑯ 當沖占比 = 買進 41.29 / 賣出 41.35 平均 41.32、資料日 = 那天、歷史到前一天(25 天 → 排得出第幾、今天最高)', g16 && g16.v === 41.32 && g16.d === asof && g16.to === asof
            && g16.n === 25 && g16.hi === 0 && g16.pct != null && /買進 41\.29%、賣出 41\.35%/.test(g16.note), JSON.stringify(g16 && { v: g16.v, n: g16.n, hi: g16.hi, pct: g16.pct }));
        W('dtr_hist.json', mkDT(dtD.slice(-5)));
        const g16b = build(tmp, [], new Date('2026-11-19T12:00:00Z'), { today: '2026-11-19', root: ROOT }).mood.crowd.find(g => g.k === 'dtr');
        ok('⑯ 只有 5 天 → 還在累積(pct null、⛔ 硬排)', g16b && g16b.pct == null && g16b.n === 5, JSON.stringify(g16b && { n: g16b.n, pct: g16b.pct }));
        // ⑯c 📊 V82.6.4 歷史往前補到 2014 之後:排第幾只跟近 3 年(DTR_WIN)比 —— 早年占比不到 1%,一起比今天天天「最高」
        const dtL = calD.slice(ai - (DTR_WIN + 400), ai + 1), dtLong = { d: Object.fromEntries(dtL.map((d, k) => [d, k < 400 ? [0.3, 0.7, 0.7, 1, 1, 1] : [30, 40 + (k % 5), 40 + (k % 5), 1, 1, 1]])) };
        dtLong.d[asof] = [28, 41.5, 41.5, 1, 1, 1];
        W('dtr_hist.json', dtLong);
        const g16c = build(tmp, [], new Date('2026-11-19T12:00:00Z'), { today: '2026-11-19', root: ROOT }).mood.crowd.find(g => g.k === 'dtr');
        const fullR = rankPct(dtL.slice(0, -1).map(d => (dtLong.d[d][1] + dtLong.d[d][2]) / 2), 41.5), winR = rankPct(dtL.slice(-(DTR_WIN + 1), -1).map(d => (dtLong.d[d][1] + dtLong.d[d][2]) / 2), 41.5);
        ok('⑯c 歷史比 3 年長 → 只跟最近 DTR_WIN 天比(n = 750 + 1、起點 = 窗口第一天、說明寫「只跟近 3 年比」)', g16c && g16c.n === DTR_WIN + 1 && g16c.from === dtL.at(-(DTR_WIN + 1)) && g16c.pct === winR.pct
            && /只跟近 3 年比/.test(g16c.note) && g16c.note.includes(dtL[0]), JSON.stringify(g16c && { n: g16c.n, from: g16c.from, pct: g16c.pct, win: winR.pct }));
        ok('⑯c 決定性對照:整段一起比(含早年不到 1% 的那 400 天)→ 排名會不一樣(這組資料分得出來)', fullR.pct != null && winR.pct != null && fullR.pct > winR.pct + 5, JSON.stringify({ full: fullR.pct, win: winR.pct }));
        fs.rmSync(path.join(tmp, 'dtr_hist.json'));
        // ⑰ 📊 V82.6.0 成交集中度:每晚從 data/ 每一檔 K 線算(lib_conc;這裡直接餵算好的每天一列)→ 主數字 = 近 20 天平均、歷史 = 之前每一天的 20 天平均
        const cD = calD.slice(0, ai + 1), ccRows = (lastS10, tail = []) => cD.map((d, k) => ({ d, n: 2000, tot: 1e12, s5: 20, s10: 25 + (k % 7) * 0.5, s20: 40 })).map((r, k, a) => k >= a.length - tail.length ? { ...r, ...tail[k - (a.length - tail.length)] } : r).map((r, k, a) => k === a.length - 1 && lastS10 != null ? { ...r, s10: lastS10 } : r);
        const R0 = ccRows(), ck = c => build(tmp, [], new Date('2026-11-19T12:00:00Z'), { today: '2026-11-19', root: ROOT, conc: c }).mood;
        const m17 = ck({ rows: R0 }), g17 = m17.crowd.find(g => g.k === 'conc'), last20 = R0.slice(-20).map(r => r.s10);
        ok('⑰ 集中度:主數字 = 近 20 天平均、今天單日另外寫、帶實測總表 conc-extreme、⛔ 標「貪」', g17 && Math.abs(g17.v - r2(last20.reduce((s, x) => s + x, 0) / 20)) < 0.011 && g17.today1 === R0.at(-1).s10
            && g17.lab === 'conc-extreme' && g17.d === R0.at(-1).d && g17.from === R0[19].d && g17.n === R0.length - 19 && !/貪/.test((g17.hiw || '') + (g17.low || '')) && /今天單日/.test(g17.note), JSON.stringify(g17 && { v: g17.v, exp: r2(last20.reduce((s, x) => s + x, 0) / 20), t1: g17.today1, t1e: R0.at(-1).s10, d: g17.d, de: R0.at(-1).d, n: g17.n, ne: R0.length - 19, from: g17.from, fe: R0[19].d }));
        const g17b = ck({ rows: ccRows(null, Array.from({ length: 20 }, () => ({ s10: 48 }))) }).crowd.find(g => g.k === 'conc');
        ok('⑰b 決定性對照:最後 20 天都擠到 48% → 排在歷史最高(hi 0)、主數字 48', g17b && g17b.v === 48 && g17b.hi === 0 && g17b.pct > 99, JSON.stringify(g17b && { v: g17b.v, hi: g17b.hi, pct: g17b.pct }));
        const g17c = ck({ rows: ccRows(null, [{ tot: 3e11 }]) }).crowd.find(g => g.k === 'conc');
        ok('⑰c 最後一天成交金額不到平常一半(盤中那一輪)→ 那一天先不算、寫出來', g17c && g17c.d === R0.at(-2).d && /看起來還沒收完/.test(g17c.note), JSON.stringify(g17c && { d: g17c.d, note: g17c.note }));
        const m17d = ck({ rows: R0.slice(-30) }), g17d = m17d.crowd.find(g => g.k === 'conc');
        ok('⑰d 只有 30 天(近 20 天平均排不出第幾)→ ⛔ 那一條、進 miss 寫原因', !g17d && m17d.miss.some(x => x.k === 'conc' && /只算得出 30 天/.test(x.why)), JSON.stringify(m17d.miss.filter(x => x.k === 'conc')));
        const m17e = ck({ rows: [], err: 'data/ 讀不到' });
        ok('⑰e 讀不到 → 原因照寫(⛔ 當 0)', !m17e.crowd.some(g => g.k === 'conc') && m17e.miss.some(x => x.k === 'conc' && /讀不到/.test(x.why)));
        // ⑱ 🇺🇸 V82.6.1 台積電 ADR 溢價:跟過去一年比;歷史 = 還原過股利的 TSM ÷ 2330 用同一種方式還原(adr_premium_probe 同一份)
        //   固定世界:2330 原始 1000、中間某天除息 20(參考價 980)之後 980;TSM 還原過股利 = 980 × 1.2 × 5 ÷ 30 → 溢價一路都是 20%
        const aD = calD.slice(ai - 299, ai + 1), xD = aD[150], usD = aD.slice(0, -1);
        W('2330.json', aD.map(d => ({ date: d.replace(/-/g, '/'), close: d < xD ? 1000 : 980 })));
        W('fred_hist.json', FHfix(Object.fromEntries(aD.map(d => [d, 30]))));
        W('us_hist.json', { adj: true, days: usD, syms: { TSM: { c: usD.map(() => 980 * 1.2 * 5 / 30) } } });
        W('dividends_hist.json', { d: { 2330: { h: [[xD, 20, '息', 1000, 980]] } } });
        const MA = { ...M0, usdtwd: 30, usdtwd_date: asof, tsm: 196, tsm_date: asof };
        W('macro_risk.json', MA);
        const adrOf = () => build(tmp, [], new Date('2026-11-19T12:00:00Z'), { today: '2026-11-19', root: ROOT, conc: { rows: [] } }).mood.seats.fi.find(g => g.k === 'adr');
        const a18 = adrOf();
        ok('⑱ ADR 溢價:今天 20%、過去一年(250 天)還原後也一直是 20% → 排在正中間、帶 adr-premium', a18 && Math.abs(a18.v - 20) < 0.01 && a18.pct === 50 && a18.n === 251 && a18.lab === 'adr-premium' && a18.to === usD.at(-1), JSON.stringify(a18 && { v: a18.v, pct: a18.pct, n: a18.n, from: a18.from, to: a18.to }));
        W('macro_risk.json', { ...MA, tsm: 980 * 1.3 * 5 / 30 });
        const a18b = adrOf();
        ok('⑱b 決定性對照:今天溢價變 30% → 比過去一年都高(hi 0)', a18b && Math.abs(a18b.v - 30) < 0.01 && a18b.hi === 0, JSON.stringify(a18b && { v: a18b.v, hi: a18b.hi }));
        W('macro_risk.json', MA); W('dividends_hist.json', { d: {} });
        const a18c = adrOf();
        ok('⑱c 2330 除息紀錄讀不到 → ⛔ 排第幾、寫原因(⛔ 拿還原過的 ADR 比原始的 2330)', a18c && a18c.pct == null && /除息紀錄/.test(a18c.note), JSON.stringify(a18c && { pct: a18c.pct, note: a18c.note }));
        for (const f of ['2330.json', 'us_hist.json', 'dividends_hist.json']) fs.rmSync(path.join(tmp, f), { force: true });
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
