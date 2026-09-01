#!/usr/bin/env node
/**
 * ⚔️ 六脈共振計分 —— 這張卡的判定到底有沒有用?(V74.1.8)
 *
 * 背景:雜訊清洗第一波把 `sixMeridianCard` 收起,理由是「複合訊號沒回測過」。
 *   使用者:「把要驗證的加到實測總表裡面待驗證」→ ⭐ 它其實**現在就測得動**
 *   (純公式、只吃 K 線 + foreign_net)→ 直接驗掉,別掛著。
 *
 * ⭐ 核心設計:跑**真正的** `app._sixMeridianCalc()`(headless 載入 index.html),
 *   ⛔ 不在探針裡複製一份判定邏輯(那會變成第二份真相 —— test_lowsample 的教訓)。
 *
 * 事件(= 卡片上會顯示的四種結論):
 *   🔴 強共振・買點(okN≥4 且有趨勢)  🟡 右側第1點・試單   ⚖️ 多空未定   🟢 訊號不足・觀望
 *   另收「⚡ 點火」(前 1~3 日 ≤2 分 → 今日 ≥4 分 + 量 1.5×)—— 卡片的加強訊號。
 *
 * 方法論(跟 signal_backtest 同一套,結果才可互相比):
 *   ・報酬 = 訊號日收盤 → N 日後收盤,**扣同期加權指數**
 *   ・對照組 = 所有掃到的交易日(「隨便挑一天」)
 *   ・同檔同結論 10 日去重;六道關卡(前後半/逐年/去最好年/扣成本 0.44%)
 *
 * 跑法:node scripts/sixmeridian_probe.mjs [檔數上限]
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const MAX_SYMS = +(process.argv[2] || 99999);
const STEP = 3;
const DEDUP = 10;
const HORIZONS = [10, 20];
const COST = 0.44;

function loadSeries(p) {
    try {
        const rows = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (!Array.isArray(rows)) return null;
        const out = [];
        for (const r of rows) {
            const c = +(r.close || 0), d = String(r.date || '').replace(/\//g, '-');
            if (c > 0 && d) out.push({ date: d, open: +(r.open || c), high: +(r.high || c), low: +(r.low || c),
                close: c, volume: +(r.volume || 0), foreign_net: +(r.foreign_net || 0) });
        }
        return out.length >= 320 ? out : null;
    } catch (_) { return null; }
}

const twiiRows = loadSeries(path.join(DATA, '^TWII.json'));
const TWII = Object.fromEntries(twiiRows.map(r => [r.date, r.close]));
const files = fs.readdirSync(DATA).filter(f => /^\d{4}\.json$/.test(f)).sort();
console.log(`📂 掃描 ${files.length} 檔(上限 ${MAX_SYMS >= 99999 ? '全市場' : MAX_SYMS})`);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
page.on('pageerror', () => {});
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._sixMeridianCalc, null, { timeout: 25000 });

const acc = new Map();          // key → [{ex10, ex20, date}]
const base = { 10: [], 20: [] };
const baseMeta = [];            // {date} for 前後半/逐年 of base
let used = 0; const t0 = Date.now();

for (const f of files) {
    if (used >= MAX_SYMS) break;
    const rows = loadSeries(path.join(DATA, f));
    if (!rows) continue;
    used++;
    let fired;
    try {
        fired = await page.evaluate(({ rows, step }) => {
            const out = [];
            for (let i = 250; i < rows.length - 20; i += step) {
                const slice = rows.slice(0, i + 1);
                let v = null;
                try { v = app._sixMeridianCalc(slice); } catch (_) { continue; }
                if (!v) continue;
                // 事件 = 卡片顯示的結論(取 verdict 開頭的 emoji 分類)
                const tag = v.verdict.startsWith('🔴') ? 'strong'
                          : v.verdict.startsWith('🟡') ? 'trial'
                          : v.verdict.startsWith('⚖️') ? 'mixed' : 'weak';
                const tags = [tag];
                // ⚡ 點火(照 renderSixMeridian 的定義:前 1~3 日曾 ≤2 分 → 今日 ≥4 + 量 1.5×)
                if (v.okN >= 4) {
                    let wasLow = false;
                    for (let k = 1; k <= 3 && i - k >= 250; k++) {
                        try { const pv = app._sixMeridianCalc(rows.slice(0, i + 1 - k)); if (pv && pv.okN <= 2) { wasLow = true; break; } } catch (_) { }
                    }
                    if (wasLow) {
                        let vm = 0; for (let q = i - 5; q < i; q++) vm += rows[q].volume;
                        if (vm > 0 && rows[i].volume >= vm / 5 * 1.5) tags.push('ignite');
                    }
                }
                out.push([i, tags]);
            }
            return out;
        }, { rows, step: STEP });
    } catch (_) { continue; }

    const lastSeen = new Map();
    for (const [i, tags] of fired) {
        const d0 = rows[i].date;
        if (!(d0 in TWII)) continue;
        const ex = {};
        for (const h of HORIZONS) {
            const j = i + h;
            if (j < rows.length && rows[j].date in TWII && TWII[d0] > 0)
                ex[h] = (rows[j].close - rows[i].close) / rows[i].close * 100 - (TWII[rows[j].date] - TWII[d0]) / TWII[d0] * 100;
        }
        if (ex[20] == null) continue;
        for (const h of HORIZONS) if (ex[h] != null) base[h].push(ex[h]);
        baseMeta.push({ date: d0, ex20: ex[20] });
        for (const t of tags) {
            const k = `${f.slice(0, 4)}|${t}`;
            if (lastSeen.has(k) && i - lastSeen.get(k) < DEDUP) continue;
            lastSeen.set(k, i);
            if (!acc.has(t)) acc.set(t, []);
            acc.get(t).push({ date: d0, ex10: ex[10], ex20: ex[20] });
        }
    }
    if (used % 300 === 0) console.log(`  …${used} 檔(${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
await browser.close();

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const med = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return b[b.length >> 1]; };
console.log(`\n📊 ${used} 檔 ・對照組 ${base[20].length} 個(股·日)`);
const b20 = mean(base[20]);
console.log(`🎯 對照組 20 日超額:平均 ${b20.toFixed(2)}% ・中位 ${med(base[20]).toFixed(2)}% ・勝率 ${(base[20].filter(x => x > 0).length / base[20].length * 100).toFixed(1)}%`);

// 前後半中點:依樣本數(⛔ 不可用日期軸中間值 —— genezone 那次的教訓)
const dsAll = baseMeta.map(x => x.date).sort();
const midDate = dsAll[Math.floor(dsAll.length / 2)];
const baseYr = {}, baseHalf = [[], []];
for (const x of baseMeta) { (baseYr[x.date.slice(0, 4)] ||= []).push(x.ex20); baseHalf[x.date < midDate ? 0 : 1].push(x.ex20); }
const yrKeys = Object.keys(baseYr).sort();
console.log(`🗓️ 中點 ${midDate} ・逐年對照:${yrKeys.map(y => `${y} ${mean(baseYr[y]).toFixed(2)}(n=${baseYr[y].length})`).join(' ・ ')}`);

const LBL = { strong: '🔴 強共振・買點(卡片叫你加碼的)', trial: '🟡 右側第1點・試單', mixed: '⚖️ 多空未定', weak: '🟢 訊號不足・觀望', ignite: '⚡ 點火(低分→高分+放量)' };
console.log(`\n結論                                   n      10日    20日   中位差   勝率   前半   後半  去最好年  扣成本  六關`);
const fmt = v => v == null ? '  —  ' : (v >= 0 ? '+' : '') + v.toFixed(2);
const out = {};
for (const t of ['strong', 'trial', 'ignite', 'mixed', 'weak']) {
    const a = acc.get(t) || [];
    if (a.length < 200) { console.log(`${(LBL[t] || t).padEnd(34)} ${String(a.length).padStart(6)}  (樣本不足)`); continue; }
    const e10 = mean(a.map(x => x.ex10).filter(x => x != null)) - mean(base[10]);
    const e20 = mean(a.map(x => x.ex20)) - b20;
    const md = med(a.map(x => x.ex20)) - med(base[20]);
    const win = a.filter(x => x.ex20 > 0).length / a.length * 100;
    const half = [[], []]; const yr = {};
    for (const x of a) { half[x.date < midDate ? 0 : 1].push(x.ex20); (yr[x.date.slice(0, 4)] ||= []).push(x.ex20); }
    const h = half.map((hh, i) => hh.length >= 30 ? mean(hh) - mean(baseHalf[i]) : null);
    const yv = yrKeys.map(y => (yr[y] || []).length >= 30 ? mean(yr[y]) - mean(baseYr[y]) : null).filter(v => v != null);
    let exBest = null;
    if (yv.length >= 2) {
        const bestY = yrKeys.filter(y => (yr[y] || []).length >= 30).sort((x, y2) => (mean(yr[y2]) - mean(baseYr[y2])) - (mean(yr[x]) - mean(baseYr[x])))[0];
        const rest = [], restB = [];
        for (const y of yrKeys) if (y !== bestY && (yr[y] || []).length) { rest.push(...yr[y]); restB.push(...baseYr[y]); }
        if (rest.length >= 100) exBest = mean(rest) - mean(restB);
    }
    const sameHalf = h[0] != null && h[1] != null && Math.sign(h[0]) === Math.sign(h[1]);
    const sameYr = yv.length >= 2 && yv.every(v => Math.sign(v) === Math.sign(yv[0]));
    const pass = e20 > 0 && sameHalf && sameYr && exBest > 0 && e20 > COST;
    console.log(`${(LBL[t] || t).padEnd(34)} ${String(a.length).padStart(6)} ${fmt(e10).padStart(7)} ${fmt(e20).padStart(7)} ${fmt(md).padStart(7)} ${win.toFixed(1).padStart(6)}% ${fmt(h[0]).padStart(6)} ${fmt(h[1]).padStart(6)} ${fmt(exBest).padStart(8)} ${fmt(e20 - COST).padStart(7)}   ${pass ? '✅' : '❌'}`);
    out[t] = { n: a.length, e10, e20, md, win, half: h, exBest, sameHalf, sameYr, pass, yr: Object.fromEntries(yrKeys.map(y => [y, (yr[y] || []).length >= 30 ? +(mean(yr[y]) - mean(baseYr[y])).toFixed(2) : null])) };
}
console.log('\n🔍 逐年邊際(pp):');
for (const t of Object.keys(out)) console.log(`  ${LBL[t].padEnd(30)} ${yrKeys.map(y => fmt(out[t].yr[y]).padStart(7)).join('')}`);
console.log('\n⚠️ 限制:窗口偏多頭;倖存者偏誤;訊號日收盤價進出(跟 _SIGNAL_EDGE 同一套口徑,兩邊可互比)。');
fs.writeFileSync('/tmp/sixmeridian_out.json', JSON.stringify({ base: { m: +b20.toFixed(2), n: base[20].length }, mid: midDate, out }, null, 1));
console.log('💾 /tmp/sixmeridian_out.json');
