#!/usr/bin/env node
/**
 * 📞 法說會「內容」有沒有賺錢機會(V79.6.3 ③)
 *
 * 已經知道的:「有開法說會」本身 → 開完隔天買,比同一天其他股票差,每一年都是負的(實測總表 confcall-react)。
 * 這支問的是**內容**:簡報裡「這次第一次提到」的東西多 / 講到之後的語氣偏正 / 有給數字展望的那幾場,之後會不會比較好?
 *
 * ⭐ 口徑(跟 dispo_backtest / retail_inst_probe 同一套,import 那幾支共用函式,⛔ 不另寫一份):
 *   - 進場 = 法說會那天之後第一個交易日**開盤**(零前視;盤中開的也一樣等隔天),抱 5 / 10 / 20 天收盤
 *   - 對照 = **同一天進場、同樣抱法的全部一般股票平均**(陷阱 #50);那天對照少於 30 檔 → 那筆不算
 *   - 開盤鎖漲停買不到 → 剔除(lib_limit 2015-06 前 ±7%);窗口碰到價格斷崖 → 剔除
 *   - 同一檔 20 個交易日內只算第一場(後面的多半是同一份簡報拿去券商場重講)
 * ⭐⭐ 乾淨對照(這支真正要量的):同一個月裡**也有讀到簡報、但那個特徵低**的場次
 *   → 「高 − 低」量的是「內容」,⛔ 不是「有開法說會」也不是「那個月行情」
 * 判準(全部成立才算有用):
 *   ① 高組比同一天所有股票,20 天超額扣掉來回成本 0.44% 還站得住(或「避開」方向:低於 −0.44%)
 *   ② 高組比同月低組(月內配對)也超過成本,前後半同向、每一年同向、拿掉最好那年仍同向
 *   ③ 安慰劑:同一個月裡把「高 / 低」標籤打亂 300 次,實際差距要比 95% 的亂標大
 *   ④ 門檻高原:新詞 ≥1~5 個(或語氣 ≥1~3)多數門檻同方向且超過成本
 * ⚠️ 只有 2021-07 以後(簡報從那時候才回補得到;含 2022 空頭)。樣本不夠 → 印「樣本不足」⛔ 下結論。
 *
 * 跑法:CC_DIR=$S/ccd python3 scripts/confcall_feat_dump.py $S/ccfeat.json
 *       FEAT=$S/ccfeat.json DATA_DIR=$S/d16 OUT=$S/cc_content.json node scripts/confcall_content_probe.mjs
 *       node scripts/confcall_content_probe.mjs --selftest
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildCtrl, sampleEv, mkIndex, loadK, COST } from './dispo_backtest.mjs';

export const DEDUP = 20;
export const MIN_MONTH_LOW = 8;      // 月內配對:同月低組至少幾筆才算
export const SHUFFLES = 300;
const iso = d => String(d).replace(/\//g, '-').slice(0, 10);
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const f2 = v => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2);

function rng(seed) { let x = seed >>> 0; return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }

/** 事件表(confcall_feat_dump 的輸出)→ 每筆抽樣:{…特徵, d, entryDate, ex:{5,10,20}};同一檔 20 個交易日只留第一場。 */
export function sampleAll(dir, ctrl, mktRet, feats) {
    const bySym = new Map();
    for (const e of feats) { if (!e || !e.s || !e.d) continue; (bySym.get(e.s) || bySym.set(e.s, []).get(e.s)).push(e); }
    const rows = [], skip = {};
    const sk = w => { skip[w] = (skip[w] || 0) + 1; };
    for (const [sym, evs] of bySym) {
        const K = loadK(dir, sym);
        if (!K) { sk('nok'); continue; }
        let lastE = -1e9;
        for (const e of evs.slice().sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : 0)) {
            const s = sampleEv(K, ctrl, mktRet, sym, iso(e.d));
            if (s.skip) { sk(s.skip); continue; }
            const ei = K.dates.indexOf(s.entryDate);
            if (ei - lastE < DEDUP) { sk('dedup'); continue; }
            lastE = ei;
            rows.push({ ...e, d: iso(e.d), entryDate: s.entryDate, ex: s.ex });
        }
    }
    return { rows, skip };
}

/** 一串 {d, v} → 統計:平均 / t / 前後半 / 逐年(≥15 筆的年)/ 拿掉最好那年 */
export function stat(xs) {
    const v = xs.map(x => x.v).filter(Number.isFinite);
    const n = v.length;
    if (n < 30) return { n, thin: true };
    const m = mean(v), sd = Math.sqrt(mean(v.map(a => (a - m) ** 2))), t = m / (sd / Math.sqrt(n) || 1);
    const ds = xs.map(x => x.d).sort(), mid = ds[ds.length >> 1];
    const h1 = mean(xs.filter(x => x.d < mid).map(x => x.v)), h2 = mean(xs.filter(x => x.d >= mid).map(x => x.v));
    const yr = {}; xs.forEach(x => (yr[x.d.slice(0, 4)] = yr[x.d.slice(0, 4)] || []).push(x.v));
    const years = Object.entries(yr).filter(([, a]) => a.length >= 15).map(([y, a]) => [y, mean(a), a.length]).sort((a, b) => a[0] < b[0] ? -1 : 1);
    const sign = m >= 0 ? 1 : -1;
    const best = years.slice().sort((a, b) => sign * (b[1] - a[1]))[0];
    const exBest = best && years.length >= 2 ? mean(xs.filter(x => !x.d.startsWith(best[0])).map(x => x.v)) : null;
    return { n, m, t, h1, h2, years, sign, exBest,
        sameHalf: h1 != null && h2 != null && h1 * h2 > 0 && h1 * sign > 0,
        allYears: years.length >= 2 && years.every(y => y[1] * sign > 0),
        keepNoBest: exBest != null && exBest * sign > 0 };
}

/** 高組 vs 低組(同一個月配對):高組每筆減掉同月低組 20 天超額的平均 */
export function matched(hi, lo, h = 20) {
    const byM = new Map();
    for (const r of lo) if (r.ex[h] != null) { const k = r.d.slice(0, 7); (byM.get(k) || byM.set(k, []).get(k)).push(r.ex[h]); }
    const out = [];
    for (const r of hi) {
        if (r.ex[h] == null) continue;
        const a = byM.get(r.d.slice(0, 7));
        if (!a || a.length < MIN_MONTH_LOW) continue;
        out.push({ d: r.d, v: r.ex[h] - mean(a) });
    }
    return out;
}

/** 安慰劑:同一個月裡把高 / 低標籤打亂(各月高組筆數不變),回 實際差距、亂標差距 ≥ 實際的比例 */
export function placebo(rows, isHi, isLo, h = 20, n = SHUFFLES, seed = 11) {
    const pool = rows.filter(r => r.ex[h] != null && (isHi(r) || isLo(r)));
    const diff = (lab) => {
        const a = [], b = [];
        pool.forEach((r, i) => (lab[i] ? a : b).push(r.ex[h]));
        return a.length >= 30 && b.length >= 30 ? mean(a) - mean(b) : null;
    };
    const lab0 = pool.map(r => isHi(r));
    const act = diff(lab0);
    if (act == null) return { act: null };
    const byM = new Map();
    pool.forEach((r, i) => { const k = r.d.slice(0, 7); (byM.get(k) || byM.set(k, []).get(k)).push(i); });
    const R = rng(seed);
    let ge = 0, done = 0;
    for (let s = 0; s < n; s++) {
        const lab = lab0.slice();
        for (const idx of byM.values()) {
            const labs = idx.map(i => lab0[i]);
            for (let k = labs.length - 1; k > 0; k--) { const j = Math.floor(R() * (k + 1)); [labs[k], labs[j]] = [labs[j], labs[k]]; }
            idx.forEach((i, k) => { lab[i] = labs[k]; });
        }
        const d = diff(lab);
        if (d == null) continue;
        done++;
        if (Math.abs(d) >= Math.abs(act)) ge++;
    }
    return { act, p: done ? ge / done : null, n: done };
}

/** 一個特徵(高組條件 / 低組條件)→ 三個天期的「比同一天」+ 月內配對 + 安慰劑 + 判定 */
export function judge(rows, isHi, isLo, opts = {}) {
    const hi = rows.filter(isHi), lo = rows.filter(isLo);
    const vsDay = h => stat(hi.filter(r => r.ex[h] != null).map(r => ({ d: r.d, v: r.ex[h] })));
    const vsLowDay = stat(lo.filter(r => r.ex[20] != null).map(r => ({ d: r.d, v: r.ex[20] })));
    const d5 = vsDay(5), d10 = vsDay(10), d20 = vsDay(20);
    const mt = stat(matched(hi, lo, 20));
    const pl = opts.noPlacebo ? { act: null } : placebo(rows, isHi, isLo, 20, opts.shuffles || SHUFFLES, opts.seed || 11);
    let ok = false, why = [];
    if (d20.thin || mt.thin) why.push('樣本不足');
    else {
        const s = mt.sign;
        if (!(Math.abs(d20.m) > COST && d20.m * s > 0)) why.push(`比同一天所有股票 ${f2(d20.m)}pp 沒超過成本 ${COST}`);
        if (!(Math.abs(mt.m) > COST)) why.push(`比同月低組 ${f2(mt.m)}pp 沒超過成本`);
        if (!mt.sameHalf) why.push('前後半不同向');
        if (!mt.allYears) why.push('有一年反向');
        if (!mt.keepNoBest) why.push('拿掉最好那年就沒了');
        if (!(pl.p != null && pl.p < 0.05)) why.push(`安慰劑 p=${pl.p == null ? '—' : pl.p.toFixed(3)}`);
        ok = !why.length;
    }
    return { nHi: hi.length, nLo: lo.length, d5, d10, d20, lowDay: vsLowDay, mt, pl, ok, why };
}

const FEATS = {
    new: { name: '這次第一次提到的詞', ks: [1, 2, 3, 4, 5], hi: k => r => r.first === false && r.n_new >= k, lo: () => r => r.first === false && r.n_new === 0, mid: 2 },
    tone: { name: '講到之後的語氣(正向詞 − 保守詞)', ks: [1, 2, 3], hi: k => r => (r.pos - r.neg) >= k, lo: () => r => (r.pos - r.neg) <= 0, mid: 2 },
    olfig: { name: '有給數字的展望句', ks: [1, 2, 3], hi: k => r => r.ol_fig >= k, lo: () => r => r.ol_fig === 0, mid: 1 },
};

export function analyze(rows, opts = {}) {
    const out = { base: stat(rows.filter(r => r.ex[20] != null).map(r => ({ d: r.d, v: r.ex[20] }))), feats: {} };
    for (const [key, F] of Object.entries(FEATS)) {
        const res = {};
        for (const k of F.ks) res[k] = judge(rows, F.hi(k), F.lo(), { ...opts, noPlacebo: opts.noPlacebo || k !== F.mid });
        const ref = res[F.mid];
        const refSign = ref.mt && !ref.mt.thin ? ref.mt.sign : 0;
        const plateau = F.ks.filter(k => res[k].mt && !res[k].mt.thin && res[k].mt.sign === refSign && Math.abs(res[k].mt.m) > COST).length;
        out.feats[key] = { name: F.name, res, plateau, ks: F.ks.length, ok: !!ref.ok && plateau >= Math.ceil(F.ks.length * 0.6) };
    }
    return out;
}

export function report(A, log = console.log) {
    const b = A.base;
    log(`\n📞 全部有讀到簡報的場次(= 有開法說會)比同一天所有股票:${b.thin ? `n=${b.n} ⏳ 樣本不足` : `n=${b.n} ・20 天 ${f2(b.m)}pp(t=${b.t.toFixed(2)})・逐年 ${b.years.map(([y, v]) => `${y}:${f2(v)}`).join(' ')}`}`);
    for (const [key, F] of Object.entries(A.feats)) {
        log(`\n── ${F.name}(門檻高原 ${F.plateau}/${F.ks})${F.ok ? ' ✅ 內容有用' : ' ⛔'}`);
        for (const [k, r] of Object.entries(F.res)) {
            const d = r.d20, m = r.mt;
            log(`  ≥${k}:高 ${r.nHi} / 低 ${r.nLo} 場 ・比同一天 5/10/20 天 ${r.d5.thin ? '—' : f2(r.d5.m)}/${r.d10.thin ? '—' : f2(r.d10.m)}/${d.thin ? '—' : f2(d.m)}pp` +
                ` ・比同月低組 ${m.thin ? `⏳ n=${m.n}` : `${f2(m.m)}pp(t=${m.t.toFixed(2)}・前後半 ${f2(m.h1)}/${f2(m.h2)}・逐年 ${m.years.map(([y, v]) => `${y}:${f2(v)}`).join(' ')})`}` +
                (r.pl.act != null ? ` ・安慰劑 p=${r.pl.p == null ? '—' : r.pl.p.toFixed(3)}` : '') +
                (r.why.length ? ` ・沒過:${r.why.join('、')}` : ''));
        }
    }
}

export function run(dir, feats, opts = {}) {
    const log = opts.log || console.log;
    const rows0 = JSON.parse(fs.readFileSync(path.join(dir, '^TWII.json'), 'utf8'));
    const twii = { dates: [], c: [] };
    for (const r of rows0) if (Number.isFinite(+r.close) && +r.close > 0) { twii.dates.push(iso(r.date)); twii.c.push(+r.close); }
    const mktRet = mkIndex(twii);
    const syms = fs.readdirSync(dir).filter(x => x.endsWith('.json') && !x.startsWith('^') && !x.startsWith('_')).map(x => x.slice(0, -5))
        .filter(s => /^[1-9]\d{3}$/.test(s));
    const ctrl = buildCtrl(dir, syms, mktRet);
    log(`🧮 對照組:${ctrl.nStock} 檔 ・${ctrl.nObs.toLocaleString()} 筆 ・${ctrl.first} ~ ${ctrl.last}`);
    const S = sampleAll(dir, ctrl, mktRet, feats);
    log(`📞 事件 ${feats.length} 場 → 可用 ${S.rows.length} 場 ・剔除 ${JSON.stringify(S.skip)}`);
    return { ...S, A: analyze(S.rows, opts) };
}

// ───────────────────────── selftest(合成資料)─────────────────────────
function synth(dir, { plant = 0, callEffect = 0, plantSameDay = false, nStock = 160, nDay = 700, seed = 5 } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const R = rng(seed);
    const dates = [];
    for (let t = Date.UTC(2021, 6, 1); dates.length < nDay; t += 86400000) { const wd = new Date(t).getUTCDay(); if (wd && wd < 6) dates.push(new Date(t).toISOString().slice(0, 10)); }
    fs.writeFileSync(path.join(dir, '^TWII.json'), JSON.stringify(dates.map((d, i) => ({ date: d, open: 100 + i * 0.01, high: 101, low: 99, close: 100 + i * 0.01 }))));
    const feats = [];
    for (let s = 0; s < nStock; s++) {
        const sym = String(1101 + s), evAt = new Map();
        for (let k = 30 + (s % 9) * 7; k < nDay - 30; k += 63) {
            const nNew = R() < 0.4 ? 0 : 1 + Math.floor(R() * 5);   // 四成 0 個新詞(低組要夠多,月內配對才配得到)
            evAt.set(k, nNew);
            feats.push({ s: sym, d: dates[k], f: `${sym}_${k}.pdf`, inv: 0, first: k < 40, n_new: k < 40 ? null : nNew, pos: Math.floor(R() * 4), neg: Math.floor(R() * 3), n_ol: 3, ol_fig: Math.floor(R() * 3), n_nums: 2, pages: 10 });
        }
        const rows = []; let p = 50 + R() * 50, boost = 0, cboost = 0;
        for (let i = 0; i < nDay; i++) {
            let o = p * (1 + (R() - 0.5) * 0.004);
            if (plantSameDay && evAt.has(i) && evAt.get(i) >= 2) o = p * 1.05;          // 法說會當天大漲(⛔ 隔天開盤才進,不可算到)
            let r = (R() - 0.5) * 0.02;
            if (boost > 0) { r += plant; boost--; }
            if (cboost > 0) { r += callEffect; cboost--; }
            const c = o * (1 + r);
            rows.push({ date: dates[i], open: +o.toFixed(2), high: +(Math.max(o, c) * 1.005).toFixed(2), low: +(Math.min(o, c) * 0.995).toFixed(2), close: +c.toFixed(2), volume: 1e6 });
            if (evAt.has(i) && i >= 40 && evAt.get(i) >= 2) boost = 20;                  // 新詞 ≥2 的那幾場 → 之後 20 天每天 +plant
            if (evAt.has(i) && i >= 40) cboost = 20;                                        // 「有開法說會」本身(高低組都有)→ 之後 20 天每天 +callEffect
            p = c;
        }
        fs.writeFileSync(path.join(dir, sym + '.json'), JSON.stringify(rows));
    }
    return feats;
}

function selftest() {
    let fail = 0;
    const ok = (n, c, e = '') => { console.log((c ? '✅ ' : '❌ ') + n + (c ? '' : '  ' + e)); if (!c) fail++; };
    const quiet = () => {};
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccprobe-'));
    try {
        // ① 埋:新詞 ≥2 的場次之後 20 天每天 +0.3% → 新詞那一組要量得到、安慰劑要擋不住
        const dA = path.join(tmp, 'A'), fA = synth(dA, { plant: 0.003 });
        const A = run(dA, fA, { log: quiet, shuffles: 200 });
        const n2 = A.A.feats.new.res[2];
        ok('① 埋「新詞 ≥2 → 之後每天 +0.3%」→ 比同月低組量得到(> +2pp)', !n2.mt.thin && n2.mt.m > 2, JSON.stringify({ m: n2.mt.m, n: n2.mt.n }));
        ok('①b 安慰劑 p < 0.05(真的效果打亂標籤就不見)', n2.pl.p != null && n2.pl.p < 0.05, n2.pl.p);
        ok('①c 判定 ✅、門檻高原多數過', A.A.feats.new.ok === true && A.A.feats.new.plateau >= 3, JSON.stringify({ ok: A.A.feats.new.ok, why: n2.why, pl: A.A.feats.new.plateau }));
        // ② 決定性對照:同一套產生器不埋 → 新詞那一組量不到、判定 ⛔
        const dB = path.join(tmp, 'B'), fB = synth(dB, { plant: 0 });
        const B = run(dB, fB, { log: quiet, shuffles: 200 });
        const b2 = B.A.feats.new.res[2];
        ok('② 不埋 → |比同月低組| < 1pp 而且判定 ⛔', !b2.mt.thin && Math.abs(b2.mt.m) < 1 && B.A.feats.new.ok === false, JSON.stringify({ m: b2.mt.m, ok: B.A.feats.new.ok }));
        // ③ 法說會當天的大漲 ⛔ 算進來(隔天開盤才進)
        const dC = path.join(tmp, 'C'), fC = synth(dC, { plant: 0, plantSameDay: true });
        const C = run(dC, fC, { log: quiet, noPlacebo: true });
        const c2 = C.A.feats.new.res[2];
        ok('③ 法說會當天大漲 +5% → 不影響(|差距| < 1pp)', !c2.mt.thin && Math.abs(c2.mt.m) < 1, c2.mt.m);
        // ⑦ 決定性對照:只埋「有開法說會」本身(高低組一樣)→ 比同一天是負的,但比同月低組 ≈ 0 → ⛔ 不是內容
        const dE = path.join(tmp, 'E'), fE = synth(dE, { plant: 0, callEffect: -0.002 });
        const E = run(dE, fE, { log: quiet, noPlacebo: true });
        const e2 = E.A.feats.new.res[2];
        ok('⑦ 只埋「有開法說會」−0.2%/天 → 比同一天 < −2pp,但比同月低組 |差距| < 1pp(量的是內容 ⛔ 是法說會本身)',
           !e2.d20.thin && e2.d20.m < -2 && !e2.mt.thin && Math.abs(e2.mt.m) < 1 && E.A.feats.new.ok === false, JSON.stringify({ day: e2.d20.m, mt: e2.mt.m }));
        // ④ 同一檔 20 個交易日內第二場 → 去重
        const K = loadK(dA, '1101');
        const twii = { dates: K.dates, c: K.dates.map((_, i) => 100 + i * 0.01) };
        const mktRet = mkIndex(twii);
        const ctrl = buildCtrl(dA, ['1101', '1102', '1103', '1104', '1105', '1106', '1107', '1108', '1109', '1110', '1111', '1112', '1113', '1114', '1115',
            '1116', '1117', '1118', '1119', '1120', '1121', '1122', '1123', '1124', '1125', '1126', '1127', '1128', '1129', '1130', '1131', '1132'], mktRet);
        const two = [{ s: '1101', d: K.dates[100], first: false, n_new: 3 }, { s: '1101', d: K.dates[105], first: false, n_new: 0 }, { s: '1101', d: K.dates[200], first: false, n_new: 0 }];
        const S = sampleAll(dA, ctrl, mktRet, two);
        ok('④ 同一檔 20 個交易日內的第二場 → 去重(留第一場)', S.rows.length === 2 && S.skip.dedup === 1 && S.rows[0].n_new === 3, JSON.stringify({ n: S.rows.length, skip: S.skip }));
        // ⑤ 沒有上一份的(first)⛔ 算進「新詞 0 個」那一組
        const r5 = [{ d: '2022-01-03', first: true, n_new: null, ex: { 20: 9 } }];
        ok('⑤ 第一份簡報(沒得比)⛔ 進高組也 ⛔ 進低組', !FEATS.new.hi(1)(r5[0]) && !FEATS.new.lo()(r5[0]));
        // ⑥ 樣本太少 → 判定 ⛔ 而且原因寫「樣本不足」
        const j6 = judge(S.rows, FEATS.new.hi(1), FEATS.new.lo(), { noPlacebo: true });
        ok('⑥ 樣本不足 → ⛔、原因寫「樣本不足」(⛔ 下結論)', j6.ok === false && j6.why.includes('樣本不足'), JSON.stringify(j6.why));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log(fail ? `❌ ${fail} 條失敗` : '✅ CONFCALL_CONTENT_SELFTEST_PASS');
    return fail ? 1 : 0;
}

function main() {
    const F = process.env.FEAT, dir = process.env.DATA_DIR;
    if (!F || !fs.existsSync(F) || !dir) { console.error('用法:FEAT=<confcall_feat_dump 的輸出> DATA_DIR=<d16> node scripts/confcall_content_probe.mjs ・--selftest'); process.exit(2); }
    const feats = JSON.parse(fs.readFileSync(F, 'utf8'));
    if (!Array.isArray(feats) || !feats.length) { console.error('❌ 事件表是空的'); process.exit(1); }
    const ds = feats.map(e => e.d).sort();
    console.log(`🧾 ${feats.length} 份簡報 ・${ds[0]} ~ ${ds[ds.length - 1]} ・可判新詞 ${feats.filter(e => e.first === false).length}`);
    const t0 = Date.now();
    const R = run(dir, feats);
    report(R.A);
    if (process.env.OUT) { fs.writeFileSync(process.env.OUT, JSON.stringify({ at: new Date().toISOString(), dir, nEvents: feats.length, used: R.rows.length, skip: R.skip, ...R.A }, null, 1)); console.log(`\n💾 ${process.env.OUT}`); }
    console.log(`⏱️ ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
}

const IS_MAIN = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN && process.argv.includes('--selftest')) process.exit(selftest());
else if (IS_MAIN) main();
