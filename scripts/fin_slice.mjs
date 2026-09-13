#!/usr/bin/env node
/**
 * ✂️ 財報三表深歷史 → 每檔一個切片 `data/fin/{sym}.json`(V76.1.8)
 *
 * 為什麼要切:`fin_deep/fin_deep.json` **7.8 MB**(gz 2.2 MB)→ ⛔ 不可整檔給手機讀。
 *   每檔切片約 1~2 KB,2,351 檔 ≈ 3.5 MB(gh-pages 目前 388 MB,沒問題)。
 *
 * 🚨 FinMind 三表是**混的**:損益表(rev/cogs/eps)單季、現金流量表(capex/dep/ocf)**累計**。
 *   切片一律存**單季**值(用 lib_fundamentals 的 detectCumulative + quarterValue,⛔ 不在這裡再寫一份),
 *   並在檔內標 `cum_fixed`(哪些欄位是相減還原的),前端只顯示、⛔ 不再算一次。
 *
 * 派生欄位(全部純公式,一份公式住這裡):
 *   gm 毛利率 = (rev − cogs) ÷ rev ・ doi 存貨天數 = inv ÷ 單季 cogs × 90(lib_fundamentals.doi)
 *   fcf 自由現金流 = 單季 ocf + 單季 capex(FinMind 的 capex 是負數)
 *   ni 淨利 = eps × (cap ÷ 10)(⚠️ 假設面額 10 元;面額不是 10 的股會失真 → `shares_note` 寫明)
 *   nm 淨利率 = ni ÷ rev ・ roe4 = 近 4 季 ni 合計 ÷ 期末權益
 * 兩道旗標(⛔ 只標事實、不下結論):
 *   ① eps_drop_biz:單季 EPS 掉 ≥50%,但營收沒減(≥ 前季 97%)、毛利率沒降(≥ 前季 −1pp)
 *      → 「多半是業外/費用/一次性,⛔ 不是本業變差,要去查」(國巨 2025Q3 就是這個)
 *   ② cap_chg:股本 QoQ 變動 >20% → 「前後 EPS 不可直接比」
 *
 * 用法:FIN=fin_deep/fin_deep.json OUT=data/fin node scripts/fin_slice.mjs
 *   守門:切出來 <500 檔就 exit 1(⛔ 不可用半份覆蓋)。
 */
import fs from 'fs';
import path from 'path';
import { pubDate, doi, detectCumulative, quarterValue } from './lib_fundamentals.mjs';

export const N_Q = 12;
export const MIN_OK = 500;
const FLOW = ['cogs', 'rev', 'capex', 'ocf', 'dep'];
const r0 = v => (v == null || !Number.isFinite(+v)) ? null : Math.round(+v);
const r1 = v => (v == null || !Number.isFinite(+v)) ? null : Math.round(+v * 10) / 10;
const r2 = v => (v == null || !Number.isFinite(+v)) ? null : Math.round(+v * 100) / 100;

export function detectAll(F, log = false) {
    return Object.fromEntries(FLOW.map(f => [f, detectCumulative(F, f, log)]));
}

/** 一檔 → 切片物件(⛔ 沒資料的欄位一律 null,不補 0) */
export function sliceOne(F, CUM, sym, nq = N_Q) {
    const S = F.s[sym]; if (!S) return null;
    const FI = Object.fromEntries(F.f.map((k, i) => [k, i]));
    const qs = Object.keys(S).sort().slice(-nq);
    const rows = qs.map(q => {
        const raw = S[q] || [];
        const pt = k => (FI[k] == null || raw[FI[k]] == null) ? null : +raw[FI[k]];
        const rev = quarterValue(F, sym, q, 'rev', CUM), cogs = quarterValue(F, sym, q, 'cogs', CUM);
        const capex = quarterValue(F, sym, q, 'capex', CUM), dep = quarterValue(F, sym, q, 'dep', CUM), ocf = quarterValue(F, sym, q, 'ocf', CUM);
        const inv = pt('inv'), eq = pt('eq'), cap = pt('cap'), eps = pt('eps');
        const shares = cap > 0 ? cap / 10 : null;
        const gm = (rev > 0 && cogs != null) ? (rev - cogs) / rev * 100 : null;
        const ni = (eps != null && shares) ? eps * shares : null;
        const nm = (ni != null && rev > 0) ? ni / rev * 100 : null;
        const fcf = (ocf != null && capex != null) ? ocf + capex : null;
        return { p: q, pub: pubDate(q), rev: r0(rev), cogs: r0(cogs), inv: r0(inv), capex: r0(capex), dep: r0(dep), ocf: r0(ocf),
                 eq: r0(eq), cap: r0(cap), eps: r2(eps), gm: r1(gm), nm: (nm != null && Math.abs(nm) <= 100) ? r1(nm) : null,
                 doi: (() => { const d = doi(inv, cogs); return (d != null && d < 2000) ? r0(d) : null; })(),
                 fcf: r0(fcf), ni: r0(ni) };
    });
    const last4 = rows.slice(-4);
    const all4 = k => last4.length === 4 && last4.every(x => x[k] != null);
    const eqL = rows.length ? rows[rows.length - 1].eq : null;
    const ni4 = all4('ni') ? last4.reduce((s, x) => s + x.ni, 0) : null;
    const flags = [];
    for (let i = 1; i < rows.length; i++) {
        const a = rows[i - 1], b = rows[i];
        if (a.eps > 0 && b.eps != null && b.eps <= a.eps * 0.5 && a.rev > 0 && b.rev >= a.rev * 0.97 && a.gm != null && b.gm != null && b.gm >= a.gm - 1) {
            flags.push({ k: 'eps_drop_biz', q: b.p, t: `${b.p.slice(0, 7)} 單季 EPS ${a.eps} → ${b.eps}(${Math.round((b.eps / a.eps - 1) * 100)}%),但營收沒減、毛利率沒降(${a.gm}% → ${b.gm}%)→ 多半是業外、費用或一次性項目,⛔ 不是本業變差;要去查那一季的財報附註` });
        }
        if (a.cap > 0 && b.cap > 0 && Math.abs(b.cap / a.cap - 1) > 0.2) {
            flags.push({ k: 'cap_chg', q: b.p, t: `${b.p.slice(0, 7)} 股本 ${Math.round(a.cap / 1e7) / 10} → ${Math.round(b.cap / 1e7) / 10} 億元(${b.cap > a.cap ? '+' : ''}${Math.round((b.cap / a.cap - 1) * 100)}%)→ 前後的每股數字(EPS)⛔ 不可直接比` });
        }
    }
    return {
        sym, updated: (F.meta && F.meta.updated) || null, src: (F.meta && F.meta.src) || 'FinMind',
        cum_fixed: FLOW.filter(f => CUM[f]), nq: rows.length,
        shares_note: '淨利 = EPS × 股本 ÷ 10(假設面額 10 元);面額不是 10 元的股票淨利率/ROE 會失真',
        q: rows,
        ni4, fcf4: all4('fcf') ? last4.reduce((s, x) => s + x.fcf, 0) : null,
        capex4: all4('capex') ? last4.reduce((s, x) => s + x.capex, 0) : null,
        roe4: (ni4 != null && eqL > 0) ? r1(ni4 / eqL * 100) : null,
        flags,
        caveat: '季報有公布時間差(Q1→5/15・Q2→8/14・Q3→11/14・Q4→隔年3/31);pub 是法定上限,多數公司提早公布。⛔ 這些是事實描述,不是多空訊號。',
    };
}

export function sliceAll(F, nq = N_Q, log = false) {
    const CUM = detectAll(F, log);
    const out = {};
    for (const sym of Object.keys(F.s)) {
        const o = sliceOne(F, CUM, sym, nq);
        if (o && o.nq >= 1) out[sym] = o;
    }
    return { files: out, CUM };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
    const FIN = process.env.FIN || path.join('fin_deep', 'fin_deep.json');
    const OUT = process.env.OUT || path.join('data', 'fin');
    if (!fs.existsSync(FIN)) { console.log(`🚨 找不到 ${FIN}`); process.exit(1); }
    const F = JSON.parse(fs.readFileSync(FIN, 'utf8'));
    console.log(`📥 財報:${F.meta.n} 檔 ・${F.meta.quarters} 季 ・更新 ${F.meta.updated}`);
    const { files, CUM } = sliceAll(F, N_Q, true);
    const n = Object.keys(files).length;
    if (n < MIN_OK) { console.log(`🚨 只切出 ${n} 檔(<${MIN_OK})→ ⛔ 不寫出、不覆蓋`); process.exit(1); }
    fs.mkdirSync(OUT, { recursive: true });
    for (const [sym, o] of Object.entries(files)) fs.writeFileSync(path.join(OUT, `${sym}.json`), JSON.stringify(o));
    const flagged = Object.values(files).filter(o => o.flags.length).length;
    const ref = files['2330'] || files[Object.keys(files)[0]];
    console.log(`✂️ 切出 ${n} 檔 → ${OUT}/ ・累計還原欄位:${Object.keys(CUM).filter(k => CUM[k]).join('/') || '(無)'} ・有旗標 ${flagged} 檔`);
    console.log(`🧪 ${ref.sym} 最近一季:${JSON.stringify(ref.q[ref.q.length - 1])} ・roe4 ${ref.roe4} ・fcf4 ${ref.fcf4}`);
}
