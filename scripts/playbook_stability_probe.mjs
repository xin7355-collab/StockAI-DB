#!/usr/bin/env node
/**
 * 🎯 App「每一檔挑它自己最會賺的那一招」—— 名單穩定度 + 樣本外每趟(V74.9.3)
 *
 * 使用者(V74.5.9 之後一直掛在 LAB `next`):
 *   「App 的『挑打法』名單穩定度從來沒量過」——
 *   V72.9.0 只比過「這一檔自己的成績 +136 萬 vs 全市場型態平均 +3.5 萬」,
 *   ⛔ 沒問過「前半段挑到的那一招,後半段還是同一招嗎」。
 *
 * ⭐ 為什麼這題重要:分點同盟集團(Jaccard 0%)/ 逐檔挑指標(穩定度 2.7% ≈ 隨機)/
 *   逐檔挑出場(83% 都挑同一種 = 假穩定)三次都證明「**先報名單穩定度,再談報酬**」——
 *   報酬會騙人,成員名單不會。這次是拿同一把尺量 **App 現在正在用的**那套。
 *
 * 方法(⛔ 直接呼叫 App 自己的 `_patternFitBacktest`,不複製判定邏輯):
 *   每一檔切前半 H1 / 後半 H2(H2 往前多接 45 根當指標暖身,交易從 mid 起算 → 零前視),
 *   兩段各跑一次 → 各自用 App 的規則挑「最會賺的那一招」
 *   (n ≥ 8 且 保守下界 − 成本 0.44 > 0,下界 = exp − 1.28×sd/√n,排下界)。
 *   ① 穩定度:H1 挑到的招 == H2 挑到的招 的比例;對照 = 隨機從 H1 候選裡挑一招會撞上的機率。
 *   ② 樣本外每趟:H1 挑到的那一招,在 H2 實際的每趟(扣成本)—— 對照:
 *        (a) H2 裡隨便挑一招的平均   (b) 全市場在 H1 最常被挑到的那一招   (c) H2 自己事後最好的那招(上限)
 *   ③ 反向(H2 學 → H1 驗)再做一次;④ 挑到的招的分布(⛔ 集中在一種 = 假穩定,V74.6.1 的教訓)。
 *
 * 跑法:node scripts/playbook_stability_probe.mjs [最多幾檔]      (--selftest 用假的偵測器驗 harness)
 */
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
let chromium;
try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); }
catch (_) { ({ chromium } = await import('playwright')); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const SELFTEST = process.argv.includes('--selftest');
const MAX_SYMS = +(process.argv.find(a => /^\d+$/.test(a)) || 99999);
const MIN_N = 8, COST = 0.44, MIN_BARS = +(process.env.MIN_BARS || 700), WARM = 45;
const t0 = Date.now();
const log = (...a) => console.log(...a);
const f2 = v => (v == null || !isFinite(v)) ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2);
const pct = v => (v == null || !isFinite(v)) ? '—' : (v * 100).toFixed(1) + '%';
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const lb = x => x.expectancy - 1.28 * (x.sd || 0) / Math.sqrt(Math.max(1, x.count));
const pickOf = ranked => (ranked || []).filter(x => x.count >= MIN_N && (lb(x) - COST) > 0).sort((a, b) => lb(b) - lb(a));

function loadSeries(p) {
    try {
        const rows = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (!Array.isArray(rows)) return null;
        const out = [];
        for (const r of rows) {
            const c = +(r.close || 0), d = String(r.date || '').replace(/\//g, '-').slice(0, 10);
            if (c > 0 && d) out.push({ date: d, open: +(r.open || c), high: +(r.high || c), low: +(r.low || c), close: c, volume: +(r.volume || 0) });
        }
        return out.length >= MIN_BARS ? out : null;
    } catch (_) { return null; }
}

const files = fs.readdirSync(DATA).filter(f => /^\d{4}\.json$/.test(f)).sort();
log(`🎯 挑打法名單穩定度 ・${files.length} 檔(≥${MIN_BARS} 根才算)${MAX_SYMS < 99999 ? ` ・上限 ${MAX_SYMS}` : ''}${SELFTEST ? ' ・🧪 SELFTEST' : ''}`);

const browser = await chromium.launch({ executablePath: fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined, args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage();
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._patternFitBacktest, null, { timeout: 25000 });
if (SELFTEST) {
    // 🧪 假偵測器:mode=stable → 同一檔兩段都挑到同一招(依 window.__sym 決定);mode=random → 每段隨機
    await page.evaluate(() => {
        const KEYS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
        let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
        app._patternFitBacktest = () => {
            const h = [...String(window.__sym)].reduce((s, ch) => s * 31 + ch.charCodeAt(0), 7);
            const best = window.__mode === 'stable' ? KEYS[h % KEYS.length] : KEYS[Math.floor(rnd() * KEYS.length)];
            return KEYS.map(k => ({ key: k, count: 20, sd: 2, winRate: 50, expectancy: k === best ? 3.0 : (window.__mode === 'stable' ? -1 : rnd() * 2 - 1) }));
        };
    });
}

const rows = [];   // per-sym result
let used = 0, tooShort = 0, noPick1 = 0, noPick2 = 0;
for (const mode of (SELFTEST ? ['stable', 'random'] : ['real'])) {
    used = 0; noPick1 = 0; noPick2 = 0; rows.length = 0;
    for (const f of files) {
        if (used >= MAX_SYMS) break;
        const sym = f.slice(0, 4);
        const ser = loadSeries(path.join(DATA, f));
        if (!ser) { tooShort++; continue; }
        used++;
        const mid = Math.floor(ser.length / 2);
        const H1 = ser.slice(0, mid), H2 = ser.slice(Math.max(0, mid - WARM));
        let r;
        try {
            r = await page.evaluate(a => {
                window.__sym = a.sym; window.__mode = a.mode;
                const run = d => { try { return (app._patternFitBacktest(d) || []).map(x => ({ key: x.key, count: x.count, expectancy: x.expectancy, sd: x.sd, winRate: x.winRate })); } catch (_) { return null; } };
                return { r1: run(a.H1), r2: run(a.H2) };
            }, { H1, H2, sym, mode });
        } catch (e) { log(`   ⚠️ ${sym} evaluate 失敗:${String(e).slice(0, 80)}`); continue; }
        if (!r || !r.r1 || !r.r2) continue;
        rows.push({ sym, r1: r.r1, r2: r.r2, mid: ser[mid].date, from: ser[0].date, to: ser[ser.length - 1].date });
        if (used % 200 === 0) log(`   … ${used} 檔 ・${((Date.now() - t0) / 60000).toFixed(1)} 分`);
    }
    report(mode);
}
await browser.close();

function report(mode) {
    log(`\n${'═'.repeat(72)}`);
    log(`📊 ${SELFTEST ? `🧪 ${mode}` : '實測'}:${rows.length} 檔 ・切點中位 ${median(rows.map(x => x.mid))} ・窗口 ${rows[0]?.from} ~ ${rows[0]?.to}(太短 ${tooShort} 檔)`);
    for (const [name, A, B] of [['正向(前半學 → 後半驗)', 'r1', 'r2'], ['反向(後半學 → 前半驗)', 'r2', 'r1']]) {
        const st = { n: 0, same: 0, top3: 0, randP: [], valPick: [], valRand: [], valBest: [], valGlobal: [], dist: {}, byQ: [[], [], [], []] };
        // 全市場在學習段最常被挑到的那一招(對照 b)
        const cnt = {};
        for (const x of rows) { const p = pickOf(x[A])[0]; if (p) cnt[p.key] = (cnt[p.key] || 0) + 1; }
        const globalKey = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0]?.[0];
        const learned = [];
        for (const x of rows) {
            const g1 = pickOf(x[A]), g2 = pickOf(x[B]);
            if (!g1.length) { noPick1++; continue; }
            const p1 = g1[0];
            st.dist[p1.key] = (st.dist[p1.key] || 0) + 1;
            learned.push({ sym: x.sym, lb: lb(p1) });
            // ① 穩定度
            if (g2.length) {
                st.n++;
                if (g2[0].key === p1.key) st.same++;
                if (g2.slice(0, 3).some(z => z.key === p1.key)) st.top3++;
                st.randP.push(g1.some(z => z.key === g2[0].key) ? 1 / g1.length : 0);
            } else noPick2++;
            // ② 樣本外每趟(扣成本):挑到的招 vs 隨便一招 vs 全市場最常挑的招 vs 事後最好的招
            const vb = x[B].filter(z => z.count >= 3);
            const v1 = vb.find(z => z.key === p1.key);
            if (v1 && vb.length) {
                st.valPick.push(v1.expectancy - COST);
                st.valRand.push(mean(vb.map(z => z.expectancy)) - COST);
                st.valBest.push(Math.max(...vb.map(z => z.expectancy)) - COST);
                const vg = vb.find(z => z.key === globalKey); if (vg) st.valGlobal.push(vg.expectancy - COST);
            }
        }
        // 學習段下界分四等份 → 驗證段每趟(有沒有「學習段越強,驗證段越好」的單調)
        const srt = learned.slice().sort((a, b) => a.lb - b.lb);
        srt.forEach((l, i) => { const q = Math.min(3, Math.floor(i / (srt.length / 4))); const x = rows.find(z => z.sym === l.sym); const p1 = pickOf(x[A])[0]; const v1 = x[B].find(z => z.key === p1.key && z.count >= 3); if (v1) st.byQ[q].push(v1.expectancy - COST); });
        const dist = Object.entries(st.dist).sort((a, b) => b[1] - a[1]);
        const tot = learned.length;
        log(`\n▸ ${name}  學到 ${tot} 檔有招(沒招 ${rows.length - tot} 檔 = App 也不會列)`);
        log(`   ① 名單穩定度:兩段挑到**同一招** ${st.same}/${st.n} = ${pct(st.same / st.n)} ・隨機期望 ${pct(mean(st.randP))} ・學到的招落在驗證段前 3 名 ${pct(st.top3 / st.n)}`);
        log(`   ② 樣本外每趟(扣成本 ${COST}%,n=${st.valPick.length}):挑到的招 ${f2(mean(st.valPick))}% ・隨便一招 ${f2(mean(st.valRand))}% ・全市場最常挑的「${globalKey}」${f2(mean(st.valGlobal))}% ・事後最好(上限)${f2(mean(st.valBest))}%`);
        log(`      → 挑到的 − 隨便一招 = ${f2(mean(st.valPick) - mean(st.valRand))}pp ・挑到的 − 全市場那一招 = ${f2(mean(st.valPick) - mean(st.valGlobal))}pp`);
        log(`   ③ 學習段下界 Q1(最弱)→Q4(最強) 的驗證段每趟:${st.byQ.map(q => f2(mean(q)) + '(' + q.length + ')').join(' → ')}`);
        log(`   ④ 挑到的招分布(前 6):${dist.slice(0, 6).map(([k, v]) => `${k} ${pct(v / tot)}`).join(' ・')}${dist.length > 6 ? ` ・其餘 ${dist.length - 6} 種` : ''}`);
        if (dist[0] && dist[0][1] / tot > 0.5) log(`   🚨 過半集中在「${dist[0][0]}」→ 穩定度高可能只是「大家都挑同一種」(V74.6.1 的教訓)`);
    }
    log(`\n⏱️ ${((Date.now() - t0) / 60000).toFixed(1)} 分`);
}
function median(a) { const s = a.slice().sort(); return s[Math.floor(s.length / 2)]; }
