#!/usr/bin/env node
// 📉 V82.0.0 大跌撿便宜清單 —— 全 repo 唯一一份算法(App 決策台「📉 大跌撿便宜」、App 提醒、Telegram 08:00 都只讀它產的 data/dip_pick.json)
//
// 規則(= dipleader_probe 的 RSlo|o|40,資金版 policy 'each';A1 補驗 16 年 d16 含下市:門檻 2.5 / 3 / 3.5 / 4% 都贏一直放 0050、
//        前後半段同向、拿掉 2026 / 最好那年 / 成本 ×2 仍為正、贏同次數隨便挑日子 —— 抱 20 天那版沒過,所以是 40 天):
//   ① 加權收盤對收盤跌 ≥3% 那天(收盤後才知道)
//   ② 熱門股 = 那天近 20 日平均成交金額最大的 100 檔(四碼普通股、120 天內沒有價格斷崖、有 60 日線與 ATR —— 同 rankAt)
//      → 當天跌最多的 10 檔(還原除權息)
//   ③ 下一個開盤日**開盤**買,10 檔等金額;開盤 ≥ 昨收 ×(1 + 漲停 − 0.3%)= 買不到,⛔ 不遞補
//   ④ 抱 40 個交易日:觸發那天往後數第 40 個交易日收盤賣(買進那天算第 1 天)
//   ⑤ 每一批拿總資金 1 成;同時最多 3 批 —— 第 4 次觸發時前面 3 批都還沒賣 → 這次不買(記一筆 skip)
//
// 產物 data/dip_pick.json(⛔ 只增不改):
//   batches[] 每一次觸發一筆。第一次寫進檔案就**凍結**名單 / 昨收 / 限價 / 是否 skip(⛔ 之後資料修正也不改,
//   不然「當晚給你的名單」跟「事後的名單」會不一樣);會更新的只有:實際開盤價 / 買不到、賣出日(颱風假會順延)、狀態。
//   bf:1 = 這一批第一次寫進檔案時已經過了買點(回算的歷史,或那晚採礦沒跑到),⛔ 不是當晚就給你的。
//
// 跑法:
//   node --max-old-space-size=4096 scripts/dip_pick.mjs [DATA=data] [OUT=data/dip_pick.json]
//   node scripts/dip_pick.mjs --selftest
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadCtx, prepStock } from './leader_probe.mjs';
import { idxRet, dropEvents, lists } from './dipleader_probe.mjs';
import { loadPx } from './lib_totalreturn.mjs';
import { tickOf, floorTick } from './gap_base.mjs';

export const RULE = { X: 3, H: 40, N: 10, U: 100, W: 0.1, maxB: 3, entry: 'open' };
export const HOL_URL = 'https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule';
const UA = 'Mozilla/5.0 (compatible; StockAI-DB dip_pick/1.0; +https://github.com/xin7355-collab/stockai-db)';
const limitOf = d => d < '2015-06-01' ? 0.07 : 0.10;
const r2 = x => Number.isFinite(x) ? Math.round(x * 100) / 100 : null;

// ───────── 日期 / 交易日 ─────────
const dOf = s => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const sOf = t => t.toISOString().slice(0, 10);
/** 台北現在的 { d:'YYYY-MM-DD', min: 從 00:00 起的分鐘 } */
export function tpeNow(now = new Date()) {
    const t = new Date(now.getTime() + 8 * 3600e3);
    return { d: sOf(t), min: t.getUTCHours() * 60 + t.getUTCMinutes() };
}
/** 證交所官方休市表 → Set('YYYY-MM-DD')(⛔ 收「開始交易」「最後交易」那兩種有交易的日子;同 miner.parse_official_closed) */
export function parseClosed(rows) {
    const out = new Set();
    for (const r of Array.isArray(rows) ? rows : []) {
        if (!r || typeof r !== 'object') continue;
        const name = String(r.Name || '');
        if (name.includes('開始交易') || name.includes('最後交易')) continue;
        const m = /^(\d{3})(\d{2})(\d{2})$/.exec(String(r.Date || '').trim());
        if (m) out.add(`${+m[1] + 1911}-${m[2]}-${m[3]}`);
    }
    return out;
}
/** 一個日子會不會開盤(只用來推「還沒到的日子」;過去的日子一律以加權有沒有那根為準) */
export function isOpenDay(s, closed) {
    const w = dOf(s).getUTCDay();
    if (w === 0 || w === 6) return false;
    if (s.slice(5) === '01-01') return false;          // 元旦一定休市(明年的休市表還沒公布時也成立)
    return !closed.has(s);
}
/** from 之後第 k 個開盤日(k ≥ 1) */
export function addOpenDays(from, k, closed) {
    let t = dOf(from), c = 0;
    for (let guard = 0; guard < 400 && c < k; guard++) { t = new Date(t.getTime() + 86400e3); if (isOpenDay(sOf(t), closed)) c++; }
    return sOf(t);
}

/** 開盤限價:嚴格低於「昨收 ×(1 + 漲停 − 0.3%)」的最高跳動價(= 回測判買不到的那條線,同 dipleader_probe retOf) */
export function limPx(pc, buyDate) {
    const thr = pc * (1 + limitOf(buyDate) - 0.003);
    let p = floorTick(thr);
    if (p >= thr - 1e-9) p = +(p - tickOf(p)).toFixed(2);
    return p;
}

/** 讀舊檔:讀不到 → null;壞掉 → 救前面那份完整的(同 lib_jsonsafe「完整 JSON + 尾巴」);救不回 → { _bad: 原因 } */
export function loadOld(file) {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    try { return JSON.parse(raw); } catch (_) { /* 往下救 */ }
    for (let k = raw.lastIndexOf('}'), tries = 0; k > 0 && tries < 50; k = raw.lastIndexOf('}', k - 1), tries++) {
        try { const j = JSON.parse(raw.slice(0, k + 1)); if (j && Array.isArray(j.batches)) return j; } catch (_) { /* 再往前 */ }
    }
    return { _bad: `舊檔讀不出來(${raw.length} bytes)` };
}

/**
 * 主計算(純函式,selftest 直接驅動)
 * @param ctx   loadCtx 的結果(cal / stocks)
 * @param twc   跟 ctx.cal 對齊的加權收盤
 * @param old   上一次的 dip_pick.json(或 null)
 * @param opt   { now: Date, closed: Set, rule }
 */
export function buildDip(ctx, twc, old, opt = {}) {
    const R = { ...RULE, ...(opt.rule || {}) }, closed = opt.closed || new Set();
    const now = opt.now || new Date(), T = tpeNow(now);
    const cal = ctx.cal, n = cal.length;
    // 最後一根是今天、還沒 14:30 → 可能是盤中那根,不拿它判觸發(⛔ 盤中跌 3% 收盤可能沒有)
    let last = n - 1;
    const partial = cal[last] === T.d && T.min < 14 * 60 + 30;
    const lastClosed = partial ? last - 1 : last;
    const ir = idxRet(twc);
    const D = dropEvents(ir, R.X);
    const trig = [...D.set].filter(i => i <= lastClosed && i >= 1).sort((a, b) => a - b);
    const idx = new Map(cal.map((d, i) => [d, i]));
    const oldBy = new Map(((old && !old._bad && old.batches) || []).map(b => [b.t, b]));
    const through = old && !old._bad && old.through ? old.through : '';
    const cache = new Map(), out = [], taken = [];
    for (const i of trig) {
        const t = cal[i], ob = oldBy.get(t);
        taken.splice(0, taken.length, ...taken.filter(e => e > i));   // 還沒賣的批(賣出那天收盤賣掉,當天觸發就有空位)
        let skip, list, frozen = false, late = 0, why = '';
        const b = i + 1 <= last ? cal[i + 1] : addOpenDays(t, 1, closed);
        if (ob) { skip = ob.st === 'skip'; list = ob.L || []; frozen = true; why = ob.why || ''; }
        else {
            if (t <= through) late = 1;                                 // 以前那幾輪沒看到這一天(資料後來才補上)
            skip = taken.length >= R.maxB;
            list = [];
            if (skip) why = `手上已經有 ${R.maxB} 批還沒賣(同時最多 ${R.maxB} 批)`;
            else {
                const L = lists(ctx, i, cache).RSlo;
                // RSlo 是由漲到跌排、取最後 10 檔 → 這裡改成「跌最多的排第一」
                list = L.map(S => ({ s: S.sym, pc: S.C[i], r: r2((S.C[i] * S.F[i] / S.C[i - 1] - 1) * 100) }))
                    .sort((a, c) => a.r - c.r)
                    .map(x => ({ ...x, lim: limPx(x.pc, b) }));
                // 那天熱門股資料不足(資料最前面那幾個月)→ 不算一批(同 dipleader_probe money():算不出報酬的觸發不佔名額)
                if (!list.length) { skip = true; why = '那天的熱門股資料不足(資料最前面那段)'; }
            }
        }
        if (!skip) taken.push(i + R.H);
        const sIdx = i + R.H, sp = sIdx > last ? 1 : 0;
        const s = sIdx <= last ? cal[sIdx] : addOpenDays(cal[last], sIdx - last, closed);
        const row = { t, ix: r2(ir[i] * 100), b, s, sp, bear: ctx.bear ? ctx.bear[i] | 0 : 0 };
        if (skip) {
            const freeAt = taken.length ? Math.min(...taken) : null;    // 最早那一批哪天賣
            row.st = 'skip';
            row.why = why;
            if (freeAt != null && /批還沒賣/.test(why)) row.free = freeAt <= last ? cal[freeAt] : addOpenDays(cal[last], freeAt - last, closed);
        } else {
            const a = i + 1;
            let nb = 0, nx = 0;
            list = list.map(x => {
                const y = { s: x.s, pc: x.pc, r: x.r, lim: x.lim };
                const S = ctx.bySymDip ? ctx.bySymDip.get(x.s) : null;
                if (a <= last && S) {
                    const o = S.O[a];
                    if (o > 0) {
                        y.o = o;
                        if (o * S.F[a] >= x.pc * (1 + limitOf(cal[a]) - 0.003)) { y.x = 1; nx++; } else nb++;
                    }
                }
                if (sIdx <= last && S && S.C[sIdx] > 0 && !y.x) y.c = S.C[sIdx];
                return y;
            });
            row.L = list;
            row.st = a > last ? 'wait' : sIdx <= last ? 'sold' : 'hold';
            if (a <= last) { row.nb = nb; row.nx = nx; row.dh = Math.min(last, sIdx) - i; }
        }
        // 第一次發布的時間 / 是不是回算(第一次寫進檔案時已過買點 = bf)
        if (ob) { row.pub = ob.pub; if (ob.bf) row.bf = 1; if (ob.late) row.late = 1; }
        else {
            row.pub = T.d;
            const before = T.d < b || (T.d === b && T.min < 9 * 60);
            if (!before) row.bf = 1;
            if (late) row.late = 1;
        }
        out.push(row);
    }
    // 舊檔有、這次資料裡找不到那一天(例:那根是假日幽靈 K 後來被刪掉)→ 照留,標 gone(⛔ 靜默消失)
    for (const [t, ob] of oldBy) if (!idx.has(t) || !D.set.has(idx.get(t))) { if (!out.some(r => r.t === t)) out.push({ ...ob, gone: 1 }); }
    out.sort((a, c) => a.t < c.t ? -1 : 1);
    const open = out.filter(r => !r.gone && (r.st === 'hold' || r.st === 'wait'));
    return {
        v: 1, rule: { ...R, txt: `加權收盤跌 ≥${R.X}% → 隔天開盤買熱門股(近 20 日成交金額前 ${R.U})當天跌最多 ${R.N} 檔 → 抱 ${R.H} 個交易日收盤賣;每批 ${Math.round(R.W * 100)}% 資金、同時最多 ${R.maxB} 批` },
        asof: cal[last], partial: partial ? 1 : 0, through: cal[lastClosed],
        updated: now.toISOString(), open: open.length,
        free: open.length >= R.maxB ? open.map(r => r.s).sort()[0] : null,
        batches: out,
    };
}

// ───────── 正式入口 ─────────
export async function fetchClosed() {
    try {
        const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 15000);
        const r = await fetch(HOL_URL, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ac.signal });
        clearTimeout(to);
        if (!r.ok) return { set: new Set(), why: `HTTP ${r.status}` };
        const txt = await r.text();
        let j; try { j = JSON.parse(txt); } catch (_) { return { set: new Set(), why: `回的不是 JSON(${txt.slice(0, 40).replace(/\s+/g, ' ')})` }; }
        const set = parseClosed(j);
        return { set, why: set.size ? '' : '回應裡沒有休市日' };
    } catch (e) { return { set: new Set(), why: e.name || 'fetch 失敗' }; }
}

async function main() {
    const DATA = process.argv[2] || 'data', OUT = process.argv[3] || path.join(DATA, 'dip_pick.json');
    const nFiles = fs.existsSync(DATA) ? fs.readdirSync(DATA).filter(f => /^\d{4}\.json$/.test(f)).length : 0;
    if (nFiles < 500) { console.error(`❌ ${DATA} 只有 ${nFiles} 檔個股 K 線(< 500)→ 資料不完整,不寫檔`); process.exit(1); }
    const DIV = fs.existsSync(path.join(DATA, 'dividends_hist.json')) ? path.join(DATA, 'dividends_hist.json') : null;
    const t0 = Date.now();
    const ctx = loadCtx(DATA, DIV);
    const tw = loadPx(DATA, '^TWII'); const tm = new Map(tw.map(x => [x.d, x.c]));
    const twc = ctx.cal.map(d => tm.get(d));
    ctx.bySymDip = new Map(ctx.stocks.map(S => [S.sym, S]));
    console.log(`📂 ${ctx.cal[0]} ~ ${ctx.cal.at(-1)} ・${ctx.stocks.length} 檔 ・讀檔 ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
    const old = loadOld(OUT);
    if (old && old._bad) console.log(`::warning::${old._bad} → 這輪從頭重算(凍結的名單會用今天的資料重排)`);
    const hol = await fetchClosed();
    console.log(hol.why ? `⚠️ 官方休市表抓不到(${hol.why})→ 還沒到的日子只跳過週末與元旦` : `🗓️ 官方休市表 ${hol.set.size} 天`);
    const res = buildDip(ctx, twc, old, { now: new Date(), closed: hol.set });
    res.hol = hol.why ? { n: 0, why: hol.why } : { n: hol.set.size };
    if (old && old._bad) res.rebuilt = old._bad;
    for (const b of res.batches.slice(-8)) {
        const nm = b.st === 'skip' ? `skip(${b.why})` : `${b.st} ${b.L.length} 檔${b.nb != null ? ` 買到 ${b.nb}・買不到 ${b.nx}` : ''}`;
        console.log(`  ${b.t} 加權 ${b.ix}% → 買 ${b.b} ・賣 ${b.s}${b.sp ? '(預估)' : ''} ・${nm}${b.bf ? ' ・回算' : ''}`);
    }
    fs.writeFileSync(OUT, JSON.stringify(res));
    console.log(`✅ ${OUT}:${res.batches.length} 筆(還沒賣 ${res.open} 批)・資料到 ${res.asof}${res.partial ? '(最後一根是盤中,不判)' : ''}`);
}

// ───────── selftest ─────────
function selftest() {
    let ok = 0, bad = 0;
    const T = (c, m) => { if (c) ok++; else { bad++; console.log('❌', m); } };
    // 合成:平日日曆 300 天、140 檔股票(每天成交額不同 → 前 100 大固定)、加權在指定那幾天跌
    const cal = []; { let t = dOf('2024-01-02'); while (cal.length < 300) { const s = sOf(t); if (isOpenDay(s, new Set())) cal.push(s); t = new Date(t.getTime() + 86400e3); } }
    const DROP = { 150: -3.0, 160: -2.9, 170: -4.2, 175: -3.5, 180: -3.1, 215: -3.3, 280: -3.2 };
    const twc = []; { let c = 10000; for (let i = 0; i < cal.length; i++) { c = c * (1 + (DROP[i] ?? 0.1) / 100); twc.push(c); } }
    const stocks = [];
    for (let k = 0; k < 140; k++) {
        const sym = String(1100 + k); let c = 50 + k;
        const rows = cal.map((d, i) => {
            const prev = c;
            const dr = DROP[i] != null ? (DROP[i] - (k % 17) * 0.4) / 100 : ((k * 7 + i * 3) % 11 - 5) / 1000;
            c = +(prev * (1 + dr)).toFixed(2);
            const o = i === 281 && k === 135 ? +(prev * 1.099).toFixed(2) : prev;   // 第 280 天那批:跌最多的那一檔隔天開盤接近漲停
            return { d, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 1000 + k * 100 };
        });
        stocks.push(prepStock(sym, rows, cal, []));
    }
    const ctx = { cal, stocks, bear: new Uint8Array(cal.length) };
    ctx.bySymDip = new Map(stocks.map(S => [S.sym, S]));
    const now = new Date(Date.UTC(2030, 0, 1));
    const res = buildDip(ctx, twc, null, { now });
    const by = new Map(res.batches.map(b => [b.t, b]));
    // ① 決定性對照:−3.0% 觸發、−2.9% 不觸發
    T(by.has(cal[150]), '① −3.0% 那天要觸發');
    T(!by.has(cal[160]), '① −2.9% 那天⛔ 觸發(決定性對照)');
    // ② 名單 = dipleader_probe 的 RSlo(同一天、同一份資料)
    const L150 = lists(ctx, 150, new Map()).RSlo.map(S => S.sym).sort();
    T(JSON.stringify(by.get(cal[150]).L.map(x => x.s).sort()) === JSON.stringify(L150), '② 名單要跟 dipleader_probe RSlo 一模一樣');
    T(by.get(cal[150]).L.length === 10, '② 一批 10 檔');
    T(by.get(cal[150]).L.every((x, j, a) => j === 0 || a[j - 1].r <= x.r), '② 跌最多的排第一');
    // ③ 同時最多 3 批:150 / 170 / 175 拿到,180 時三批都還沒賣 → skip;215 時 150 那批(賣在 190)已經賣了 → 拿到
    T(by.get(cal[170]).st !== 'skip' && by.get(cal[175]).st !== 'skip', '③ 第 2、3 次觸發要買');
    T(by.get(cal[180]).st === 'skip' && /3 批/.test(by.get(cal[180]).why), '③ 第 4 次觸發時三批都還沒賣 → skip');
    T(by.get(cal[180]).free === cal[190], '③ skip 要寫最早哪天有空位(150 那批第 40 天 = 第 190 根)');
    T(by.get(cal[215]).st !== 'skip', '③ 150 那批賣掉之後再觸發 → 要買');
    // ④ 賣出日 = 觸發往後第 40 個交易日;買進日 = 下一個交易日;狀態
    T(by.get(cal[150]).s === cal[190] && by.get(cal[150]).b === cal[151] && by.get(cal[150]).st === 'sold', '④ 賣出日 / 買進日 / 已賣');
    T(by.get(cal[215]).st === 'sold' && by.get(cal[215]).s === cal[255], '④ 215 那批第 40 天(255)賣掉');
    T(by.get(cal[280]).st === 'hold' && by.get(cal[280]).dh === 299 - 280, '④ 還在抱的狀態與第幾天');
    // ⑤ 開盤接近漲停 → 買不到(x),⛔ 不遞補(還是 10 檔)
    const b280 = by.get(cal[280]), lk = b280.L.find(x => x.s === '1235');
    T(b280.L.length === 10 && lk && lk.x === 1 && !('c' in lk), '⑤ 開盤接近漲停那檔標買不到、名單⛔ 遞補');
    T(b280.nx === 1 && b280.nb === 9, '⑤ 買到 9、買不到 1');
    T(by.get(cal[150]).L.every(x => x.c > 0 && x.o > 0 && !x.x), '⑤ 賣掉那批每檔都有開盤價與賣出收盤');
    // ⑥ 限價:嚴格低於門檻、對到跳動單位;2015-06 以前 7%
    T(limPx(100, '2026-01-05') === 109.5 && limPx(100, '2014-01-06') === 106.5, '⑥ 限價 100 元 → 109.5(10%)/ 106.5(7%)');
    T(limPx(50, '2026-01-05') === 54.8 && limPx(1000, '2026-01-05') === 1095, '⑥ 50 → 54.8(不到 54.85 那條線)、1000 → 1095');
    // ⑦ 凍結:舊檔的名單不被今天的資料改掉;新的觸發照常加
    // 資料最前面那段(還沒有 60 日線)跌 3% → 熱門股資料不足 → 不算一批、⛔ 佔名額
    const twc0 = twc.slice(); twc0[20] = twc0[19] * 0.95;
    const e0 = buildDip(ctx, twc0, null, { now }).batches.find(b => b.t === cal[20]);
    T(e0 && e0.st === 'skip' && /資料不足/.test(e0.why) && !e0.free, '⑥b 資料不足那次 → skip、寫原因');
    const old = JSON.parse(JSON.stringify(res)); old.batches = old.batches.filter(b => b.t <= cal[175]);
    old.batches[0].L = old.batches[0].L.map(x => ({ ...x, lim: 1 })); old.through = cal[176];
    const res2 = buildDip(ctx, twc, old, { now });
    const b0 = res2.batches.find(b => b.t === cal[150]);
    T(b0.L.every(x => x.lim === 1), '⑦ 凍結的名單 / 限價⛔ 被改');
    T(res2.batches.some(b => b.t === cal[215]) && res2.batches.find(b => b.t === cal[215]).late !== 1, '⑦ 新觸發照常加、⛔ 標 late');
    const old2 = JSON.parse(JSON.stringify(old)); old2.batches = old2.batches.filter(b => b.t !== cal[170]); old2.through = cal[200];
    T(buildDip(ctx, twc, old2, { now }).batches.find(b => b.t === cal[170]).late === 1, '⑦ 以前那幾輪沒看到的觸發 → late');
    const old3 = JSON.parse(JSON.stringify(old)); old3.batches.push({ t: '2024-03-02', st: 'hold', L: [] });
    T(buildDip(ctx, twc, old3, { now }).batches.some(b => b.t === '2024-03-02' && b.gone === 1), '⑦ 舊檔有、資料沒有的那天 → 留著標 gone');
    // ⑧ 盤中那根不判:最後一根是今天、還沒 14:30
    const twc2 = twc.slice(); twc2[299] = twc[298] * 0.96;
    const lastD = cal[299], noon = new Date(dOf(lastD).getTime() + (11 - 8) * 3600e3), eve = new Date(dOf(lastD).getTime() + (19 - 8) * 3600e3);
    T(!buildDip(ctx, twc2, null, { now: noon }).batches.some(b => b.t === lastD), '⑧ 盤中 11:00 最後一根跌 4% ⛔ 觸發');
    const ev = buildDip(ctx, twc2, null, { now: eve }).batches.find(b => b.t === lastD);
    T(ev && ev.st === 'wait' && !ev.bf, '⑧ 收盤後 19:00 觸發、還沒買(wait)、⛔ 回算');
    T(buildDip(ctx, twc2, null, { now: new Date(dOf(addOpenDays(lastD, 1, new Set())).getTime() + 1.5 * 3600e3) }).batches.find(b => b.t === lastD).bf === 1, '⑧ 買進日 09:30 才第一次寫 → bf');
    // ⑨ 交易日推算:週末 / 官方休市 / 元旦 / 休市表解析
    const C = parseClosed([{ Name: '中秋節', Date: '1151006' }, { Name: '農曆春節前最後交易日', Date: '1150211' }, { Name: '國曆新年開始交易日', Date: '1150102' }]);
    T(C.has('2026-10-06') && !C.has('2026-02-11') && !C.has('2026-01-02'), '⑨ 休市表:⛔ 收「開始交易 / 最後交易」');
    T(addOpenDays('2026-10-02', 1, C) === '2026-10-05' && addOpenDays('2026-10-05', 1, C) === '2026-10-07', '⑨ 跳過週末與休市日');
    T(addOpenDays('2026-12-31', 1, new Set()) === '2027-01-04', '⑨ 元旦一定休市(明年休市表還沒公布)');
    // 賣出日在資料之後 → 用交易日推算、標 sp
    T(by.get(cal[280]).sp === 1 && by.get(cal[280]).s === addOpenDays(cal[299], 280 + 40 - 299, new Set()), '⑨ 還沒到的賣出日用交易日推、標預估');
    T(by.get(cal[150]).sp === 0, '⑨ 已經過的賣出日⛔ 標預估');
    // ⑩ 讀壞掉的舊檔:完整 JSON + 尾巴 → 救前面那份;救不回 → _bad
    const tmp = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'dip-')), 'x.json');
    fs.writeFileSync(tmp, JSON.stringify({ batches: [{ t: 'a' }] }) + '"}],"x":1}'); T(loadOld(tmp)?.batches?.[0]?.t === 'a', '⑩ 完整 JSON + 尾巴 → 救前面');
    fs.writeFileSync(tmp, '{"batches":[{"t":'); T(!!loadOld(tmp)?._bad, '⑩ 救不回 → _bad(⛔ 當成沒有舊檔默默蓋掉)');
    console.log(`selftest:${ok} 過 / ${bad} 失敗`);
    process.exit(bad ? 1 : 0);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) { if (process.argv.includes('--selftest')) selftest(); else main().catch(e => { console.error('❌', e); process.exit(1); }); }
