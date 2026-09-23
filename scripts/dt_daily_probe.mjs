#!/usr/bin/env node
/**
 * ⚡ 當沖「日K量得到的那幾條」實測(V77.5.0)—— 使用者:「加強當沖勝率…附件是我找到的策略,不要漏掉了」
 *
 * 22 份逐字稿逐條對表後,**日K就驗得動、以前沒測過**的只有這 8 組(其餘見 EXTERNAL_REVIEWS ㉜):
 *   D1 🌗 盤中 vs 隔夜拆解(「每天開盤買收盤賣賠錢、收盤買隔天開盤賣賺錢」)—— 描述型、沒有關卡
 *   D2 🅾️ Oops(開在昨低之下、盤中回到昨低 → 以昨低買、收盤賣;鏡像空)
 *   D3 💥 攻擊日(昨天收破前天低 → 今天過昨高就買、收盤賣;鏡像空)
 *   D4 🔓 連續跌停打開(≥2 根跌停、今天開盤沒鎖 → 開盤買收盤賣;分大型股)
 *   D5 🏦 前一日外資+投信同買 → 今天做多;同賣 → 今天做空(含「起漲第一天」)・投信連 5 買
 *   D6 📏 當沖選股池:波動 × 跳一檔佔成本(⛔ 不是方向訊號,只回答「哪種股票比較好沖」)
 *   D7 🟥 漲停隔天:月線上彎/下彎 → 隔天開盤賣 vs 隔天收盤賣(⚠️ 隔日沖,成本 0.44%)
 *   D8 🖤 多頭高檔爆量黑K → 隔天做空當沖
 *
 * 📐 口徑(⛔ 每一條都一樣,不各自挑):
 *   ・做多 = 進場價 → 當天收盤;做空 = 鏡像。**扣當沖來回成本 0.25%**(另印 0.40 = 手續費不打折的版本)
 *   ・超額 = 扣掉**同一天加權的開→收**(⛔ 不是昨收→今收)
 *   ・**對照組 = 同一批股票的所有交易日、同方向**(⛔ 不是 0、不是 50%)
 *   ・進場一律用「那一刻已經知道的」:前一日的籌碼/K 棒,⛔ 不用當天收盤才知道的東西
 *   ・開在漲停附近 ⛔ 不算做多進場(買不到);開在跌停附近 ⛔ 不算做空進場
 *   ・同檔同事件 5 個交易日內只算一次
 *
 * 🚦 關卡(增量都是「事件超額 − 對照組超額」):
 *   G1 全期增量 > 0 且 p ≤ 0.05 ・G2 前後半同向 ・G3 逐年同向(n≥20 的年)・G4 拿掉最好那年仍 > 0
 *   G5 **扣成本後絕對報酬 > 0**(⭐ 當沖真正的錢關)・G6 拿掉貢獻最多的 10 個交易日仍 > 0
 *   ・高原:門檻左右各挪一格仍成立(D2e 那一格印出來人工判)
 *
 * 跑法:DATA_DIR=<合併過 klines_deep 的目錄> node --max-old-space-size=6144 scripts/dt_daily_probe.mjs [out.json]
 *       node scripts/dt_daily_probe.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ELIG = process.env.DT_ELIG === '1';
export const COST = 0.25, COST_FULL = 0.40, COST_ON = 0.44, DEDUP = 5;

export const tickOf = p => p < 10 ? 0.01 : p < 50 ? 0.05 : p < 100 ? 0.1 : p < 500 ? 0.5 : p < 1000 ? 1 : 5;
const nd = d => String(d).replace(/\//g, '-');
export const ampB = amp => amp < 2 ? '振幅<2%' : amp < 3 ? '2~3%' : amp < 4 ? '3~4%' : amp < 6 ? '4~6%' : '≥6%';

/** 單檔:產生每一天的事件(純函式,selftest 直接測它)。mkt = Map(date → 加權開→收 %) */
export function scanStock(rows, mkt, emit, ctrl, exd, mktGap) {
    const n = rows.length;
    const O = [], H = [], L = [], C = [], V = [], F = [], T = [], D = [], MB = [];
    for (const r of rows) { O.push(+r.open); H.push(+r.high); L.push(+r.low); C.push(+r.close); V.push(+(r.volume || 0));
        F.push(r.foreign_net == null ? null : +r.foreign_net); MB.push(r.margin_balance == null ? null : +r.margin_balance); T.push(r.trust_net == null ? null : +r.trust_net); D.push(nd(r.date)); }
    const last = {};
    let curAb = '';
    const ev = (key, i, side, entry, exit, extra) => {
        if (last[key] != null && i - last[key] < DEDUP) return;
        last[key] = i;
        const raw = side > 0 ? (exit / entry - 1) * 100 : (1 - exit / entry) * 100;
        const m = mkt.get(D[i]);
        emit(key, { d: D[i], side, ab: curAb, net: raw - COST, ex: raw - COST - side * m, ...(extra || {}) });
    };
    const lockUp = i => C[i] >= C[i - 1] * 1.09 && C[i] >= H[i] - 1e-9;
    const lockDn = i => C[i] <= C[i - 1] * 0.91 && C[i] <= L[i] + 1e-9;
    for (let i = 22; i < n; i++) {
        const o = O[i], h = H[i], l = L[i], c = C[i], pc = C[i - 1];
        if (!(o > 0 && h > 0 && l > 0 && c > 0 && pc > 0)) continue;
        const m = mkt.get(D[i]); if (m === undefined) continue;
        if (!(V[i] > 0)) continue;
        if (exd && exd.has(D[i])) continue;   // ⛔ 除權息日:開盤參考價不是昨收,「跳空」是假的
        // 🎫 DT_ELIG=1:只留「前一天有融資餘額」的股票 = 能信用交易 ≈ 能現股當沖的代理
        //   (⛔ 不能當沖的冷門股,開盤價再漂亮也做不到;沒有融資欄的年份一律略過)
        if (ELIG && !(MB[i - 1] > 0)) continue;
        const openUpLimit = o >= pc * 1.095, openDnLimit = o <= pc * 0.905;
        // 波動(前 20 日,⛔ 不含今天)與跳一檔
        let amp = 0; for (let k = i - 20; k < i; k++) amp += (H[k] - L[k]) / C[k - 1 >= 0 ? k - 1 : k] * 100; amp /= 20;
        const tickPct = tickOf(o) / o * 100;
        curAb = ampB(amp);
        const rawL = (c / o - 1) * 100;
        // ── 對照組(所有交易日,兩個方向;開在極端價的不算)
        if (!openUpLimit) ctrl('L', D[i], rawL - COST, rawL - COST - m, amp, tickPct);
        if (!openDnLimit) ctrl('S', D[i], -rawL - COST, -rawL - COST + m, amp, tickPct);
        if (i + 1 < n && O[i + 1] > 0) ctrl('ON', D[i], (O[i + 1] / c - 1) * 100 - COST_ON, null, amp, tickPct);   // 隔夜:今收 → 明開
        const pL = L[i - 1], pH = H[i - 1];
        // ── D2 Oops
        if (o < pL && h >= pL && !openDnLimit) {
            const g = (1 - o / pL) * 100;
            ev('D2 Oops多(開在昨低之下,回到昨低買)', i, 1, pL, c);
            if (g >= 1) ev('D2 Oops多・跌破昨低≥1%', i, 1, pL, c);
            if (g >= 2) ev('D2 Oops多・跌破昨低≥2%', i, 1, pL, c);
        }
        if (o > pH && l <= pH && !openUpLimit) {
            const g = (o / pH - 1) * 100;
            ev('D2 Oops空(開在昨高之上,回到昨高空)', i, -1, pH, c);
            if (g >= 1) ev('D2 Oops空・越過昨高≥1%', i, -1, pH, c);
            if (g >= 2) ev('D2 Oops空・越過昨高≥2%', i, -1, pH, c);
        }
        // ── D3 攻擊日(Smash day)
        if (C[i - 1] < L[i - 2] && h > H[i - 1]) {
            const e = Math.max(o, H[i - 1]);
            if (!(openUpLimit && e === o)) ev('D3 攻擊日多(昨收破前低・今過昨高買)', i, 1, e, c);
        }
        if (C[i - 1] > H[i - 2] && l < L[i - 1]) {
            const e = Math.min(o, L[i - 1]);
            if (!(openDnLimit && e === o)) ev('D3 攻擊日空(昨收過前高・今破昨低空)', i, -1, e, c);
        }
        // ── D4 連續跌停打開
        if (!openDnLimit && !openUpLimit) {
            let k = 0; for (let j = i - 1; j >= 1 && lockDn(j); j--) k++;
            if (k >= 1) {
                let tv = 0; for (let j = i - 20; j < i; j++) tv += C[j] * V[j]; tv /= 20;
                const big = tv >= 3e8;
                ev(`D4 跌停打開・連${k >= 3 ? '≥3' : k}根`, i, 1, o, c);
                if (k >= 2) { ev('D4 連≥2根跌停打開(他說的)', i, 1, o, c); if (big) ev('D4 連≥2根跌停打開・大型股(日均成交≥3億)', i, 1, o, c); }
            }
        }
        // ── D5 籌碼(前一日,⛔ 不用今天的)
        const f1 = F[i - 1], t1 = T[i - 1], v1 = V[i - 1];
        if (f1 != null && t1 != null && v1 > 0 && !(f1 === 0 && t1 === 0)) {
            const r = (f1 + t1) / v1 * 100;
            const up1 = C[i - 1] > C[i - 2];
            const prior = C[i - 2] / C[i - 5] - 1;
            if (f1 > 0 && t1 > 0 && !openUpLimit) {
                ev('D5 昨日外資+投信同買→今天做多', i, 1, o, c);
                for (const th of [2, 5, 10, 20]) if (r >= th) ev(`D5 同買・佔量≥${th}%`, i, 1, o, c);
                if (up1 && prior <= 0) ev('D5 同買・起漲第一天', i, 1, o, c);
            }
            if (f1 < 0 && t1 < 0 && !openDnLimit) {
                ev('D5 昨日外資+投信同賣→今天做空', i, -1, o, c);
                for (const th of [2, 5, 10, 20]) if (-r >= th) ev(`D5 同賣・佔量≥${th}%`, i, -1, o, c);
            }
            let t5 = true; for (let j = i - 5; j < i; j++) if (!(T[j] > 0)) { t5 = false; break; }
            if (t5 && !openUpLimit) ev('D5 投信連 5 買→今天做多', i, 1, o, c);
        }
        // ── D7 漲停隔天(隔日沖:昨收買 → 今開 / 今收)
        if (i >= 26 && lockUp(i - 1)) {
            let ma = 0, ma5 = 0; for (let j = i - 20; j < i; j++) ma += C[j]; for (let j = i - 25; j < i - 5; j++) ma5 += C[j];
            const upSlope = ma > ma5, tag = upSlope ? '月線上彎' : '月線下彎';
            emit(`D7 漲停隔天・${tag}・開盤賣`, { d: D[i], net: (o / pc - 1) * 100 - COST_ON, ex: null, on: 1 });
            emit(`D7 漲停隔天・${tag}・收盤賣`, { d: D[i], net: (c / pc - 1) * 100 - COST_ON, ex: null, on: 2 });
        }
        // ── D8 高檔爆量黑K → 今天做空
        if (i >= 253 && !openDnLimit) {
            let mx = -Infinity, mn = Infinity; for (let j = i - 252; j < i; j++) { if (H[j] > mx) mx = H[j]; if (L[j] < mn) mn = L[j]; }
            const pos = mx > mn ? (C[i - 1] - mn) / (mx - mn) * 100 : 50;
            let va = 0; for (let j = i - 21; j < i - 1; j++) va += V[j]; va /= 20;   // ⛔ 不含爆量那根(陷阱 #43)
            const vm = va > 0 ? V[i - 1] / va : 0;
            const body = (O[i - 1] - C[i - 1]) / O[i - 1] * 100;
            if (body > 0) for (const P of [60, 75, 90]) for (const VM of [1.5, 2, 3]) for (const B of [1, 2, 3])
                if (pos >= P && vm >= VM && body >= B) ev(`D8 高檔爆量黑K→做空・位階≥${P}・量≥${VM}x・實體≥${B}%`, i, -1, o, c);
        }
        // ── D2c 跟 Oops 比:開在昨高之上 → **開盤直接空**(不等它回到昨高)
        let tv20 = 0; for (let j = i - 20; j < i; j++) tv20 += C[j] * V[j]; tv20 /= 20;
        const sqz = c >= pc * 1.095 && c >= h - 1e-9;          // 收在漲停 = 空單當天可能回補不了
        // ── D10 大盤開低那一天,買熱門股(日均成交 ≥5 億)開盤 → 收盤(⭐ 以「天」為樣本,見 main)
        const ig = mktGap && mktGap.get(D[i]);
        if (ig != null && ig <= -1 && tv20 >= 5e8 && !openDnLimit) emit('D10', { d: D[i], ig, net: rawL - COST });
        // ── D11 盤前分數當大盤濾網(PREMKT_SCORES 有給才跑;以「天」為樣本,見 main)
        if (tv20 >= 1e8 && !openDnLimit && !openUpLimit) emit('D11', { d: D[i], net: rawL - COST });
        const tvB = tv20 < 3e7 ? '日均成交<3千萬' : tv20 < 1e8 ? '3千萬~1億' : tv20 < 5e8 ? '1~5億' : '≥5億';
        // 🛑 停損版(⛔ 抱到收盤是理論值,真的當沖一定設停損):價格碰到停損價就出場(用當日高低判斷)
        const stopEv = (key, side, stp) => {
            const sp = side < 0 ? o * (1 + stp / 100) : o * (1 - stp / 100);
            const hit = side < 0 ? h >= sp : l <= sp;
            ev(key, i, side, o, hit ? sp : c, { sqz: side < 0 && !hit && sqz });
        };
        if (o > pH && !openUpLimit) {
            const g = (o / pc - 1) * 100;
            for (const TV of [1e8, 3e8, 5e8, 1e9]) if (tv20 >= TV) for (const th of [1, 2, 3, 5]) if (g >= th)
                ev(`D2e 高原・開高空・日均≥${TV / 1e8}億・跳空≥${th}%`, i, -1, o, c, { sqz });
            if (g >= 2) { ev(`D2c 跳空≥2%→開盤空・${tvB}`, i, -1, o, c, { sqz }); for (const st of [2, 3, 5]) stopEv(`D2c 跳空≥2%→開盤空・停損${st}%・${tvB}`, -1, st); }
            for (const th of [0, 1, 2, 3, 5, 7]) if (g >= th) ev(`D2c 開在昨高之上・跳空≥${th}%→開盤直接空`, i, -1, o, c, { sqz });
            if (g >= 2 && tv20 >= 1e8 && o >= 10) ev('D2c 跳空≥2%→開盤空・只做日均成交≥1億且股價≥10元', i, -1, o, c, { sqz });
            if (g >= 2 && tv20 >= 5e8) ev('D2c 跳空≥2%→開盤空・只做日均成交≥5億', i, -1, o, c, { sqz });
            if (g >= 2 && g < 5) ev('D2c 跳空 2~5%→開盤空', i, -1, o, c, { sqz });
        }
        // ── D2d 鏡像:開在昨低之下 → 開盤直接買(「跳空跌深搶反彈」)
        if (o < pL && !openDnLimit) {
            const g = (1 - o / pc) * 100;
            for (const TV of [1e8, 3e8, 5e8, 1e9]) if (tv20 >= TV) for (const th of [1, 2, 3, 5]) if (g >= th)
                ev(`D2e 高原・開低買・日均≥${TV / 1e8}億・跳空跌≥${th}%`, i, 1, o, c);
            if (g >= 2) { ev(`D2d 跳空跌≥2%→開盤買・${tvB}`, i, 1, o, c); for (const st of [2, 3, 5]) stopEv(`D2d 跳空跌≥2%→開盤買・停損${st}%・${tvB}`, 1, st); }
            for (const th of [0, 1, 2, 3, 5]) if (g >= th) ev(`D2d 開在昨低之下・跳空跌≥${th}%→開盤直接買`, i, 1, o, c);
        }
        // ── 疊加:開盤那一刻知道的四個空方條件,疊越多越好嗎?(⛔ 不假設會更好 —— 本站好幾次疊加反而變差)
        if (!openDnLimit && i >= 253) {
            let mx = -Infinity, mn = Infinity; for (let j = i - 252; j < i; j++) { if (H[j] > mx) mx = H[j]; if (L[j] < mn) mn = L[j]; }
            const pos = mx > mn ? (C[i - 1] - mn) / (mx - mn) * 100 : 50;
            let va = 0; for (let j = i - 21; j < i - 1; j++) va += V[j]; va /= 20;
            const vm = va > 0 ? V[i - 1] / va : 0, body = (O[i - 1] - C[i - 1]) / O[i - 1] * 100;
            const fA = o > pH, fB = pos >= 75 && vm >= 1.5 && body >= 1, fC = f1 != null && t1 != null && f1 < 0 && t1 < 0, fD = amp >= 4;
            const k = (+fA) + (+fB) + (+fC) + (+fD);
            ev(`D9 疊加・開盤前知道的空方條件 ${k} 個→開盤空`, i, -1, o, c);
        }
    }
}

// ─────────────────────────────── 統計 ───────────────────────────────
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const pNorm = z => { const t = 1 / (1 + 0.2316419 * Math.abs(z)); const q = 0.3989423 * Math.exp(-z * z / 2) * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return 2 * q; };

export function makeCtrl() {
    const agg = {};
    const add = (k, v) => { const a = agg[k] || (agg[k] = { n: 0, s: 0, w: 0 }); a.n++; a.s += v; if (v > 0) a.w++; };
    return {
        agg,
        push(side, d, net, ex, amp, tickPct, split) {
            const y = d.slice(0, 4), h = d < split ? 'h1' : 'h2';
            add(`${side}|net|all`, net); add(`${side}|net|${y}`, net);
            if (ex != null) { add(`${side}|ex|all`, ex); add(`${side}|ex|${y}`, ex); add(`${side}|ex|${h}`, ex); }
            if (side !== 'ON') {
                const ab = ampB(amp);
                const tb = tickPct < 0.1 ? '跳一檔<0.10%' : tickPct < 0.2 ? '0.10~0.20%' : tickPct < 0.3 ? '0.20~0.30%' : '≥0.30%';
                add(`${side}|cell|${ab}|${tb}`, net); add(`${side}|cellh|${ab}|${tb}|${h}`, net);
                add(`${side}|amp|${ab}`, net); add(`${side}|tick|${tb}`, net);
                if (ex != null) add(`${side}|exa|${ab}`, ex);
            }
        },
        m(k) { const a = agg[k]; return a && a.n ? a.s / a.n : NaN; },
        n(k) { const a = agg[k]; return a ? a.n : 0; },
        w(k) { const a = agg[k]; return a && a.n ? a.w / a.n * 100 : NaN; },
    };
}

export function judge(key, evs, ctrl, split) {
    const on = evs.some(e => e.ex == null);
    const side = evs[0] && evs[0].side < 0 ? 'S' : 'L';
    const cs = on ? 'ON' : side;
    const vals = evs.map(e => on ? e.net : e.ex);
    const cAll = ctrl.m(`${cs}|${on ? 'net' : 'ex'}|all`);
    const mg = mean(vals) - cAll;
    const z = vals.length > 2 ? (mean(vals) - cAll) / (sd(vals) / Math.sqrt(vals.length)) : 0;
    const p = pNorm(z);
    const halves = ['h1', 'h2'].map(h => {
        const v = evs.filter(e => (h === 'h1') === (e.d < split)).map(e => on ? e.net : e.ex);
        const cm = on ? ctrl.m(`ON|net|all`) : ctrl.m(`${cs}|ex|${h}`);
        return v.length ? mean(v) - cm : NaN;
    });
    const years = {};
    for (const e of evs) (years[e.d.slice(0, 4)] = years[e.d.slice(0, 4)] || []).push(on ? e.net : e.ex);
    const yr = {};
    for (const [y, v] of Object.entries(years)) if (v.length >= 20) yr[y] = +(mean(v) - ctrl.m(`${cs}|${on ? 'net' : 'ex'}|${y}`)).toFixed(2);
    const bestY = Object.entries(yr).sort((a, b) => b[1] - a[1])[0];
    let dropBest = NaN;
    if (bestY && Object.keys(yr).length >= 2) {
        const rest = evs.filter(e => e.d.slice(0, 4) !== bestY[0]);
        const restCtrlS = Object.keys(years).filter(y => y !== bestY[0]).reduce((s, y) => s + (ctrl.agg[`${cs}|${on ? 'net' : 'ex'}|${y}`] || { s: 0 }).s, 0);
        const restCtrlN = Object.keys(years).filter(y => y !== bestY[0]).reduce((s, y) => s + ctrl.n(`${cs}|${on ? 'net' : 'ex'}|${y}`), 0);
        dropBest = mean(rest.map(e => on ? e.net : e.ex)) - restCtrlS / Math.max(1, restCtrlN);
    }
    const net = mean(evs.map(e => e.net));
    const srt = evs.map(e => e.net).sort((a, b) => a - b);
    const med = srt[srt.length >> 1], p10 = srt[Math.floor(srt.length * 0.1)], worst = srt[0];
    // 🚨 空單收在漲停 = 當天可能買不回來(要標借,費用可到好幾 %)→ 每一筆再扣 7% 當壓力測試
    const sqzN = evs.filter(e => e.sqz).length;
    // 📅 集中度:拿掉「貢獻最多的 10 個交易日」還剩多少(⛔ 可能只是幾次崩盤隔天的大反彈)
    const byD = new Map(); for (const e of evs) byD.set(e.d, (byD.get(e.d) || 0) + e.net);
    const top10 = new Set([...byD.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(x => x[0]));
    const dropTop = mean(evs.filter(e => !top10.has(e.d)).map(e => e.net));
    const nDays = byD.size;
    const netSqz = sqzN ? mean(evs.map(e => e.net - (e.sqz ? 7 : 0))) : net;
    // 🎯 格內對照:每一筆只跟「同振幅區間、同方向」的對照組比(⛔ 否則可能只是挑到高波動的日子)
    const mgMatched = on ? NaN : mean(evs.map(e => e.ex - ctrl.m(`${cs}|exa|${e.ab}`)));
    // 📅 空方敏感度:拿掉 6~8 月(股東會 + 除權息旺季,很多股票停止融券 → 先賣後買做不了)
    const noSeason = side === 'S' && !on ? mean(evs.filter(e => !/-0[678]-/.test(e.d)).map(e => e.net)) : NaN;
    // 💰 回本折數:手續費幾折以下才賺得到(當沖稅 0.15% 固定)
    const gross = net + (on ? COST_ON : COST);
    const beDisc = on ? NaN : (gross - 0.15) / (0.1425 * 2);
    const win = evs.filter(e => e.net > 0).length / evs.length * 100;
    const G = {
        G1: mg > 0 && p <= 0.05, G2: halves.every(h => h > 0), G3: Object.values(yr).length >= 2 && Object.values(yr).every(v => v > 0),
        G4: dropBest > 0, G5: net > 0,
        G6: evs.length >= 30 && dropTop > 0,   // 🚨 拿掉貢獻最多的 10 個交易日仍 > 0(⛔ 否則只是幾次崩盤隔天的反彈)
    };
    return { key, n: evs.length, net: +net.toFixed(3), netFull: +(on ? net : net - (COST_FULL - COST)).toFixed(3), win: +win.toFixed(1),
        ctrlWin: +ctrl.w(`${cs}|net|all`).toFixed(1), ctrlNet: +ctrl.m(`${cs}|net|all`).toFixed(3),
        margin: +mg.toFixed(3), p: +p.toFixed(4), halves: halves.map(x => +x.toFixed(2)), years: yr, dropBest: +(+dropBest).toFixed(2),
        gates: G, pass: Object.values(G).filter(Boolean).length,
        mgMatched: +(+mgMatched).toFixed(3), dropTop: +(+dropTop).toFixed(3), nDays, med: +med.toFixed(3), p10: +p10.toFixed(2), worst: +worst.toFixed(2), sqzPct: +(sqzN / evs.length * 100).toFixed(2), netSqz: +netSqz.toFixed(3), noSeason: +(+noSeason).toFixed(3), gross: +gross.toFixed(3), beDisc: +(+beDisc).toFixed(2) };
}

// ─────────────────────────────── selftest ───────────────────────────────
function selftest() {
    let fail = 0; const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + e}`); if (!c) fail++; };
    const mk = (spec) => { let pc = 100; const rows = []; for (let i = 0; i < spec.length; i++) { const s = spec[i];
        const o = s.o != null ? s.o : pc, c = s.c != null ? s.c : o, h = s.h != null ? s.h : Math.max(o, c) * 1.002, l = s.l != null ? s.l : Math.min(o, c) * 0.998;
        rows.push({ date: `2024/${String(1 + (i / 28 | 0)).padStart(2, '0')}/${String(1 + i % 28).padStart(2, '0')}`, open: o, high: h, low: l, close: c, volume: s.v || 1e6,
            foreign_net: s.f == null ? null : s.f, trust_net: s.t == null ? null : s.t }); pc = c; }
        return rows; };
    const mktOf = rows => new Map(rows.map(r => [nd(r.date), 0]));
    const run = (rows) => { const out = {}; const c = makeCtrl(); scanStock(rows, mktOf(rows), (k, e) => (out[k] = out[k] || []).push(e), (...a) => c.push(...a, '2024-06-01')); return { out, c }; };
    // ① Oops:開在昨低之下 → 進場價必須是昨低(⛔ 不是開盤價)
    {
        const spec = Array.from({ length: 30 }, () => ({ o: 100, c: 100, h: 100.5, l: 99.5 }));
        spec.push({ o: 98, l: 97, h: 101, c: 100.5 });
        const { out } = run(mk(spec));
        const e = (out['D2 Oops多(開在昨低之下,回到昨低買)'] || [])[0];
        ok('① Oops 多:以昨低 99.5 進場(報酬 = 100.5/99.5 − 1 − 成本)', e && Math.abs(e.net - ((100.5 / 99.5 - 1) * 100 - COST)) < 1e-6, JSON.stringify(e));
    }
    // ② 開在漲停附近 ⛔ 不算做多進場(D5)
    {
        const spec = Array.from({ length: 30 }, () => ({ o: 100, c: 100 }));
        spec[29] = { o: 100, c: 100, f: 1000, t: 1000, v: 1e4 };
        spec.push({ o: 110, c: 110, h: 110, l: 109 });
        const { out } = run(mk(spec));
        ok('② 開在漲停附近 ⛔ 不可算成做多進場(買不到)', !(out['D5 昨日外資+投信同買→今天做多'] || []).length);
    }
    // ③ 決定性對照:埋一個 +2% 的邊際 → 事件增量必須量到 ≈ +2;沒埋的 ≈ 0
    {
        const spec = []; let lastEv = -99;
        for (let i = 0; i < 600; i++) {
            const ev = i > 30 && i - lastEv > 6 && i % 7 === 0;
            const s = { o: 100, c: 100 * (1 + (Math.sin(i * 1.7) * 0.01)), f: ev ? 5e4 : -1, t: ev ? 5e4 : -1, v: 1e6 };
            spec.push(s);
            if (i > 0 && spec[i - 1].f > 0) { s.c = s.o * 1.02 * (1 + Math.sin(i * 1.7) * 0.01); }
            if (ev) lastEv = i;
        }
        const rows = mk(spec); const { out, c } = run(rows);
        const r = judge('D5 昨日外資+投信同買→今天做多', out['D5 昨日外資+投信同買→今天做多'] || [], c, '2024-06-01');
        ok('③ 埋 +2% 邊際 → 增量量到 1.5~2.5', r.margin > 1.5 && r.margin < 2.5, JSON.stringify(r));
        const none = judge('D5 昨日外資+投信同賣→今天做空', out['D5 昨日外資+投信同賣→今天做空'] || [], c, '2024-06-01');
        ok('③b 對照:沒埋邊際的那一邊增量 ≈ 0(<0.6)', Math.abs(none.margin) < 0.6 || none.n === 0, JSON.stringify(none));
    }
    // ④ 🚨 前視:D5 必須用**前一日**籌碼 —— 只在「今天」有籌碼的那一根 ⛔ 不可觸發今天的事件
    {
        const spec = Array.from({ length: 30 }, () => ({ o: 100, c: 100, f: -1, t: -1 }));
        spec.push({ o: 100, c: 103, f: 9e5, t: 9e5 });
        const { out } = run(mk(spec));
        ok('④ 前視:今天才出現的同買 ⛔ 不可觸發今天的做多', !(out['D5 昨日外資+投信同買→今天做多'] || []).some(e => e.d === nd(mk(spec)[30].date)));
    }
    // ⑤ D8 爆量基準 ⛔ 不可含爆量那根(陷阱 #43):量 = 2.5 倍 → 要觸發「量≥2x」
    {
        const spec = [];
        for (let i = 0; i < 300; i++) spec.push({ o: 100 + i * 0.1, c: 100 + i * 0.1 + 0.05, v: 1e6 });
        const p = spec[299].c; spec[299] = { o: p * 1.03, c: p, v: 2.1e6, h: p * 1.035, l: p * 0.995 };
        spec.push({ o: p, c: p * 0.99 });
        const { out } = run(mk(spec));
        ok('⑤ 爆量 2.1 倍(基準不含爆量那根;含的話只剩 1.99 倍)→「量≥2x」要觸發', (out['D8 高檔爆量黑K→做空・位階≥75・量≥2x・實體≥2%'] || []).length === 1, Object.keys(out).filter(k => /D8/.test(k)).join(','));
    }
    // ⑥ 去重:同事件 5 日內只算一次
    {
        const spec = Array.from({ length: 40 }, () => ({ o: 100, c: 100, f: 10, t: 10 }));
        const { out } = run(mk(spec));
        const n = (out['D5 昨日外資+投信同買→今天做多'] || []).length;
        ok('⑥ 去重:連續天天同買 → 每 5 天只算一次', n > 0 && n <= Math.ceil(18 / DEDUP) + 1, `n=${n}`);
    }
    console.log(fail ? `\n❌ ${fail} 條失敗` : '\n✅ DT_DAILY_SELFTEST_PASS');
    process.exit(fail ? 1 : 0);
}

// ─────────────────────────────── main ───────────────────────────────
async function main() {
    if (process.argv.includes('--selftest')) return selftest();
    const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
    const OUT = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : null;
    const tw = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8'));
    const twa = Array.isArray(tw) ? tw : tw.data;
    const mkt = new Map(); for (const r of twa) if (+r.open > 0 && +r.close > 0) mkt.set(nd(r.date), (+r.close / +r.open - 1) * 100);
    const dates = [...mkt.keys()].sort(); const split = dates[dates.length >> 1];
    const mktGap = new Map(); { const tws = twa.filter(r => +r.open > 0 && +r.close > 0).sort((a, b) => nd(a.date) < nd(b.date) ? -1 : 1);
        for (let k = 1; k < tws.length; k++) mktGap.set(nd(tws[k].date), (+tws[k].open / +tws[k - 1].close - 1) * 100); }
    console.log(`📈 加權 ${dates.length} 天 ・${dates[0]} ~ ${dates[dates.length - 1]} ・前後半切在 ${split}`);
    const files = fs.readdirSync(DATA).filter(f => /^[1-9]\d{3}\.json$/.test(f));
    // 💰 除權息日(⛔ 不排除的話,「開在昨低之下」會混進一堆除息的假跳空)
    const EXD = new Map();
    try {
        const dv = JSON.parse(fs.readFileSync(process.env.DIV || path.join(ROOT, 'data', 'dividends_hist.json'), 'utf8'));
        for (const [sy, v] of Object.entries(dv.d || {})) EXD.set(sy, new Set((v.h || []).map(x => x[0])));
    } catch (e) { console.error('⚠️ 讀不到 dividends_hist.json → 除權息日沒排除(結論要打折)'); }
    console.log(`💰 除權息日表 ${EXD.size} 檔`);
    const ctrl = makeCtrl(); const B = new Map();
    let used = 0;
    for (const f of files) {
        let rows; try { rows = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { continue; }
        rows = Array.isArray(rows) ? rows : (rows.data || []);
        if (rows.length < 60) continue; used++;
        scanStock(rows, mkt, (k, e) => { if (!B.has(k)) B.set(k, []); B.get(k).push(e); }, (...a) => ctrl.push(...a, split), EXD.get(f.replace('.json', '')), mktGap);
    }
    if (used < 500) { console.error(`❌ 只有 ${used} 檔可用 → 結論不可信`); process.exit(1); }
    console.log(`📂 ${used} 檔 ・對照組 做多 ${ctrl.n('L|net|all').toLocaleString()} ・做空 ${ctrl.n('S|net|all').toLocaleString()} 個(股·日)\n`);

    // D1 盤中 vs 隔夜
    console.log('═══ D1 🌗 盤中(開→收)vs 隔夜(收→明開)—— 全市場每一個(股·日),⛔ 描述不是訊號 ═══');
    console.log('   年   | 開→收 毛 | 開→收 扣0.25 勝率 | 收→明開 毛 | 收→明開 扣0.44 勝率');
    const ys = [...new Set(dates.map(d => d.slice(0, 4)))];
    const D1 = {};
    for (const y of ['all', ...ys]) {
        const oc = ctrl.m(`L|net|${y}`) + COST, on = ctrl.m(`ON|net|${y}`) + COST_ON;
        D1[y] = { oc: +oc.toFixed(3), on: +on.toFixed(3), ocWin: +ctrl.w(`L|net|${y}`).toFixed(1), onWin: +ctrl.w(`ON|net|${y}`).toFixed(1) };
        console.log(`  ${y.padEnd(5)} | ${oc.toFixed(3).padStart(7)}% | ${(oc - COST).toFixed(3).padStart(7)}% ${ctrl.w(`L|net|${y}`).toFixed(1)}% | ${on.toFixed(3).padStart(7)}% | ${(on - COST_ON).toFixed(3).padStart(7)}% ${ctrl.w(`ON|net|${y}`).toFixed(1)}%`);
    }
    // D6 選股池
    console.log('\n═══ D6 📏 當沖選股池:前 20 日平均振幅 × 跳一檔佔股價(做多/做空 扣 0.25% 後的平均 · 勝率 · n)═══');
    const ABs = ['振幅<2%', '2~3%', '3~4%', '4~6%', '≥6%'], TBs = ['跳一檔<0.10%', '0.10~0.20%', '0.20~0.30%', '≥0.30%'];
    const D6 = {};
    for (const s of ['L', 'S']) {
        console.log(`  ${s === 'L' ? '做多' : '做空'}`);
        for (const a of ABs) {
            const cells = TBs.map(t => { const k = `${s}|cell|${a}|${t}`; const r = { m: ctrl.m(k), w: ctrl.w(k), n: ctrl.n(k),
                h1: ctrl.m(`${s}|cellh|${a}|${t}|h1`), h2: ctrl.m(`${s}|cellh|${a}|${t}|h2`) }; D6[`${s}|${a}|${t}`] = r; return r; });
            console.log(`   ${a.padEnd(6)} ` + cells.map((r, j) => `${TBs[j]} ${isFinite(r.m) ? r.m.toFixed(3) : '—'}% ${isFinite(r.w) ? r.w.toFixed(1) : '—'}% n=${r.n}`).join(' | '));
        }
    }
    // 事件表
    console.log('\n═══ 事件(增量 = 事件超額 − 同方向對照組超額;G1 全期+p≤.05 G2 前後半 G3 逐年 G4 去最好年 G5 扣成本絕對 >0)═══');
    const res = [];
    // D10 以「天」為樣本(同一天的熱門股高度相關,⛔ 不可把每一檔當獨立樣本)
    console.log('\n═══ D10 🌧️ 大盤(加權)開低那一天 → 買熱門股(日均成交≥5億)開盤、收盤賣(扣 0.25%;每天先平均再統計)═══');
    const D10 = {};
    for (const th of [-1, -1.5, -2, -3]) {
        const byDay = new Map();
        for (const e of (B.get('D10') || [])) if (e.ig <= th) { const a = byDay.get(e.d) || []; a.push(e.net); byDay.set(e.d, a); }
        const days = [...byDay.entries()].map(([d, a]) => ({ d, m: mean(a), n: a.length })).sort((a, b) => a.d < b.d ? -1 : 1);
        const ms = days.map(x => x.m), srt = [...ms].sort((a, b) => b - a);
        const dropTop3 = mean(srt.slice(3));
        const yrs = {}; for (const x of days) (yrs[x.d.slice(0, 4)] = yrs[x.d.slice(0, 4)] || []).push(x.m);
        D10[th] = { days: days.length, mean: +mean(ms).toFixed(3), winDays: +(ms.filter(x => x > 0).length / Math.max(1, ms.length) * 100).toFixed(1),
            dropTop3: +(+dropTop3).toFixed(3), years: Object.fromEntries(Object.entries(yrs).map(([y, a]) => [y, `${mean(a).toFixed(2)}(${a.length}天)`])) };
        console.log(`  大盤開低 ≤${th}%:${days.length} 天 ・每天平均 ${D10[th].mean}% ・賺的天數 ${D10[th].winDays}% ・拿掉最好 3 天 ${D10[th].dropTop3}% ・逐年 ${JSON.stringify(D10[th].years)}`);
        if (th === -2) console.log('     ' + days.map(x => `${x.d.slice(2)} ${x.m >= 0 ? '+' : ''}${x.m.toFixed(1)}`).join(' ・'));
    }
    B.delete('D10');
    // D11 盤前分數(App 顯示的 0~100 分)× 熱門股(日均≥1億)開盤買收盤賣 / 開盤空收盤補,以「天」為樣本
    const PS = process.env.PREMKT_SCORES;
    const D11 = {};
    if (PS && fs.existsSync(PS)) {
        const sc = new Map();
        for (const ln of fs.readFileSync(PS, 'utf8').split('\n')) { const m = ln.indexOf('SCORES|'); if (m < 0) continue;
            for (const kv of ln.slice(m + 7).trim().split(',')) { const [d, v] = kv.split(':'); if (d && v != null) sc.set(d, 50 + (+v) * 5); } }
        const byDay = new Map();
        for (const e of (B.get('D11') || [])) { const a = byDay.get(e.d) || []; a.push(e.net); byDay.set(e.d, a); }
        const bk = x => x >= 65 ? '偏多 ≥65' : x >= 55 ? '55~65' : x > 45 ? '中性 45~55' : x > 35 ? '35~45' : '偏空 ≤35';
        const G = {};
        for (const [d, a] of byDay) { const v = sc.get(d); if (v == null) continue; const m = mean(a);
            (G[bk(v)] = G[bk(v)] || []).push({ d, L: m, S: -m - 2 * COST }); (G['(對照)所有有分數的日子'] = G['(對照)所有有分數的日子'] || []).push({ d, L: m, S: -m - 2 * COST }); }
        console.log(`\n═══ D11 🌅 盤前分數 × 熱門股(日均≥1億)當沖,每天先平均再統計(分數 ${sc.size} 天)═══`);
        for (const k of ['偏多 ≥65', '55~65', '中性 45~55', '35~45', '偏空 ≤35', '(對照)所有有分數的日子']) {
            const a = G[k] || []; if (!a.length) continue;
            const f = side => { const v = a.map(x => x[side]); const srt = [...v].sort((x, y) => y - x);
                return { m: +mean(v).toFixed(3), win: +(v.filter(x => x > 0).length / v.length * 100).toFixed(1),
                    h: [mean(a.filter(x => x.d < split).map(x => x[side])), mean(a.filter(x => x.d >= split).map(x => x[side]))].map(x => +x.toFixed(3)),
                    drop5: +mean(srt.slice(5)).toFixed(3) }; };
            D11[k] = { days: a.length, long: f('L'), short: f('S') };
            console.log(`  ${k.padEnd(14)} ${String(a.length).padStart(4)} 天 ・做多 ${D11[k].long.m}%(賺的天 ${D11[k].long.win}%・前後半 ${D11[k].long.h.join('/')}・拿掉最好5天 ${D11[k].long.drop5})`
                + ` ・做空 ${D11[k].short.m}%(賺的天 ${D11[k].short.win}%・前後半 ${D11[k].short.h.join('/')}・拿掉最好5天 ${D11[k].short.drop5})`);
        }
    } else console.log('\n⏭️ D11 盤前分數:沒給 PREMKT_SCORES(premkt_probe 的 log)→ 略過');
    B.delete('D11');
    for (const [k, evs] of [...B.entries()].sort()) {
        if (evs.length < 30) { console.log(`  ⏳ ${k}:n=${evs.length} 太少,不下結論`); continue; }
        const r = judge(k, evs, ctrl, split); res.push(r);
        console.log(`  ${r.pass === 6 ? '✅' : r.pass >= 4 ? '⚠️' : '❌'} ${k}\n      n=${r.n} ・扣成本每趟 ${r.net}%(手續費不打折 ${r.netFull}%)・勝率 ${r.win}%(對照 ${r.ctrlWin}%)` +
            ` ・增量 ${r.margin >= 0 ? '+' : ''}${r.margin}pp(格內 ${r.mgMatched}) p=${r.p} ・前後半 ${r.halves.join('/')} ・逐年 ${JSON.stringify(r.years)} ・去最好年 ${r.dropBest} ・關卡 ${r.pass}/6`
            + `\n      ${r.nDays} 個交易日 ・拿掉最好的 10 天 ${r.dropTop}% ・中位 ${r.med}% ・最差10% ${r.p10}% ・最差 ${r.worst}%${r.sqzPct ? ` ・收在漲停(回補不了)${r.sqzPct}% → 每筆多扣 7% 後 ${r.netSqz}%` : ''}`
            + `\n      毛利 ${r.gross}% ・回本要手續費 ≤${isFinite(r.beDisc) ? (r.beDisc * 10).toFixed(1) + ' 折' : '—'}${isFinite(r.noSeason) ? ` ・拿掉 6~8 月 ${r.noSeason}%` : ''}`);
    }
    if (OUT) fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), used, split, window: [dates[0], dates[dates.length - 1]], D1, D6, D10, D11, events: res }, null, 1));
}
if (import.meta.url === `file://${process.argv[1]}`) main();
