#!/usr/bin/env node
/**
 * 🎯 `_playbookMode` 操作型態回測(V72.4.4)
 *
 * ⭐ 為什麼做這個(而不是再加一個沒驗證過的指標):
 *   深度診斷最上面那句「現在這檔適合的操作方式」是**純公式**算出來的,
 *   但**從來沒有人驗證過它準不準**。與其再加一個 ARBR 那種書上寫的指標
 *   (實測 7 個情境全不成立),不如先回答:
 *     「程式說『順勢做多』的那些日子,後續 20 天到底賺不賺?說『先不做』的呢?」
 *   —— 這是驗證**自己的功能**,而且 `_playbookMode` 是純公式 → **完全可回算**。
 *
 * ⭐ 核心設計:**跑真正的 `app._playbookMode()`**,⛔ 不複製一份判定邏輯
 *   (同 signal_backtest.mjs;複製會變成第二份真相,程式改了回測還是綠的)。
 *
 * 方法論(照 CLAUDE.md 四鐵則):
 *   ① 乾淨對照組:同一批股票同期間「隨便挑一天」→ 報的是**邊際**不是絕對報酬
 *   ② 扣掉同期加權指數(broker_habit 教訓:不扣會得到相反結論)
 *   ③ 事件去重:同檔同型態 20 個交易日內只算一次
 *   ④ 樣本守門:n<50 不下結論
 *
 * ⚠️ `_playbookMode` 會呼叫 `_bearGate` / `_ovTrend` / `_priceRankData` ——
 *    回測時只有 K 線沒有那些快取,所以 `_bearGate` 會回 false、`_ovTrend` 是 null。
 *    → 這等於測「**沒有空頭守門時**的原始分類效果」,是**保守下界**
 *      (真實使用時 `_bearGate` 會再擋掉一部分空頭進場)。⛔ 報告要寫明這件事。
 *
 * 跑法:node scripts/playbook_backtest.mjs [股票數上限]
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const MAX_SYMS = +(process.argv[2] || 99999);
const STEP = 3;                    // 每 3 根 K 取樣一次(型態不會天天變)
const DEDUP = 20;                  // 同檔同型態 20 日內只算一次
const HORIZONS = [10, 20, 60];
const MIN_N = 50;

function loadSeries(p) {
    try {
        const rows = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (!Array.isArray(rows)) return null;
        const out = [];
        for (const r of rows) {
            const c = +(r.close || 0), d = String(r.date || '').replace(/\//g, '-');
            if (c > 0 && d) out.push({ date: d, open: +(r.open || c), high: +(r.high || c), low: +(r.low || c), close: c, volume: +(r.volume || 0) });
        }
        return out.length >= 340 ? out : null;
    } catch (_) { return null; }
}

const twiiRows = loadSeries(path.join(DATA, '^TWII.json'));
if (!twiiRows) { console.log('❌ 找不到 ^TWII.json'); process.exit(2); }
const TWII = Object.fromEntries(twiiRows.map(r => [r.date, r.close]));

const files = fs.readdirSync(DATA).filter(f => /^\d{4}\.json$/.test(f)).sort();
console.log(`📂 掃描 ${files.length} 檔${MAX_SYMS >= 99999 ? '(全市場)' : `,上限前 ${MAX_SYMS} 檔`}`);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
page.on('pageerror', () => { });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._playbookMode, null, { timeout: 25000 });

// ⭐ 空過守門:先確認 _playbookMode 真的回得出東西(否則整份報告會是空的假綠燈)
const smoke = await page.evaluate(() => {
    const rows = Array.from({ length: 300 }, (_, i) => {
        const c = 100 + Math.sin(i / 9) * 12 + i * 0.05;
        return { date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, open: c, high: c * 1.02, low: c * 0.98, close: c, volume: 1e6 };
    });
    app.rawDailyData = rows; app.currentSymbolId = 'BT';
    const r = app._playbookMode(rows, 'BT');
    return r ? r.mode : null;
});
if (!smoke) { console.log('❌ _playbookMode 回 null(合成資料也算不出來)→ 中止,不產生假報告'); await browser.close(); process.exit(2); }
console.log(`🔎 _playbookMode 自檢 OK(合成資料 → ${smoke})`);

const acc = new Map();                       // mode -> {10:[],20:[],60:[]}
const base = { 10: [], 20: [], 60: [] };
let used = 0; const t0 = Date.now();
const prefix = {};

for (const f of files) {
    if (used >= MAX_SYMS) break;
    const rows = loadSeries(path.join(DATA, f));
    if (!rows) continue;
    used++; prefix[f[0]] = (prefix[f[0]] || 0) + 1;

    let fired;
    try {
        fired = await page.evaluate(({ rows, step }) => {
            const out = [];
            for (let i = 300; i < rows.length - 60; i += step) {
                const slice = rows.slice(0, i + 1);
                app.rawDailyData = slice;
                app.currentSymbolId = 'BT';
                app._ovTrend = null;              // 回測沒有主結論快取 → 明確清掉,別吃到上一檔殘留
                let m = null;
                try { m = app._playbookMode(slice, 'BT'); } catch (_) { }
                out.push([i, m ? m.mode : null]);
            }
            return out;
        }, { rows, step: STEP });
    } catch (_) { continue; }

    const lastSeen = new Map();
    for (const [i, mode] of fired) {
        const d0 = rows[i].date;
        if (!(d0 in TWII)) continue;
        // 對照組:**所有掃到的交易日**(⛔ 不抽樣)。
        // ⚠️ 第一版用 `i % 40 === 0` 抽樣 → 實際只在 120 的倍數觸發(因為 i 本來就是 3 的倍數),
        //    樣本稀疏又跟固定索引對齊 → 會**跟特定日期對齊**(市場級事件),
        //    結果基準勝率被壓到 23.6%,而每一種型態都「贏基準 9~15pp」—— 那是抽樣偏誤不是效果。
        // ⭐ 正解:事件本來就是「所有掃到的日子」的子集合 → 基準就用同一個母體,直接可比。
        for (const h of HORIZONS) {
            const d1 = rows[i + h]?.date;
            if (!d1 || !(d1 in TWII)) continue;
            base[h].push((rows[i + h].close / rows[i].close - 1) * 100 - (TWII[d1] / TWII[d0] - 1) * 100);
        }
        if (!mode) continue;
        if ((lastSeen.get(mode) ?? -999) > i - DEDUP) continue;
        lastSeen.set(mode, i);
        if (!acc.has(mode)) acc.set(mode, { 10: [], 20: [], 60: [] });
        const a = acc.get(mode);
        for (const h of HORIZONS) {
            const d1 = rows[i + h]?.date;
            if (!d1 || !(d1 in TWII)) continue;
            a[h].push((rows[i + h].close / rows[i].close - 1) * 100 - (TWII[d1] / TWII[d0] - 1) * 100);
        }
    }
    if (used % 200 === 0) console.log(`   … ${used} 檔 / ${Math.round((Date.now() - t0) / 1000)}s`);
}
await browser.close();

const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const win = a => a.length ? a.filter(x => x > 0).length / a.length * 100 : null;

console.log(`\n✅ 掃完 ${used} 檔 / ${Math.round((Date.now() - t0) / 1000)}s`);
console.log(`   代號開頭分布(檢查有沒有選樣偏誤):${JSON.stringify(prefix)}`);
console.log('\n對照組(同批股票隨便挑一天,扣同期加權後):');
for (const h of HORIZONS) console.log(`  ${String(h).padStart(3)} 日:中位 ${med(base[h]).toFixed(2)}% ・勝率 ${win(base[h]).toFixed(1)}% ・n=${base[h].length.toLocaleString()}`);

console.log('\n各操作型態的超額報酬(⚠️ 邊際 = 中位 − 對照組中位):');
const modes = [...acc.keys()].sort();
for (const m of modes) {
    console.log(`\n■ ${m}`);
    for (const h of HORIZONS) {
        const e = acc.get(m)[h];
        if (e.length < MIN_N) { console.log(`  ${String(h).padStart(3)} 日:樣本不足(n=${e.length})`); continue; }
        const edge = med(e) - med(base[h]);
        console.log(`  ${String(h).padStart(3)} 日:中位 ${med(e).toFixed(2)}%(邊際 ${edge >= 0 ? '+' : ''}${edge.toFixed(2)}pp)・勝率 ${win(e).toFixed(1)}%(基準 ${win(base[h]).toFixed(1)}%)・n=${e.length.toLocaleString()}`);
    }
}

console.log('\n⚠️ 判讀限制(⛔ 別過度解讀):');
console.log('  ・回測時沒有 _bearGate / _ovTrend 快取 → 這是「沒有空頭守門」的**保守下界**');
console.log('  ・邊際在 ±0.5pp 內視為雜訊;未扣交易成本(來回約 0.44%)');
console.log('  ・倖存者偏誤(下市的不在 data/);窗口受 ^TWII 長度限制(約 2 年)');
