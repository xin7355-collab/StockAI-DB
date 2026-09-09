#!/usr/bin/env node
/**
 * 🚦 ETF 跟車狀態:基準重建守門 + 燈號鐵則(V72.3.1)
 *
 * ⚠️ 釘的 bug(使用者截圖:「🚦 ETF 跟車狀態這裡怪怪的」):
 *   etf_miner.py 只存前 15 大持股(`holdings: curr_h[:HOLD_TOP]`),
 *   diff 卻拿**完整**持股清單去比截斷的昨日檔 →
 *   排名 16 名以後的每一檔持股「每天」被重標 🆕換入
 *   (實測 gh-pages:added=38 > holdings=15,removed/up/down 全 0)。
 *   → 長抱幾個月的股票也天天顯「多檔 ETF 共識加碼 → 適合跟車」,完全誤導。
 *
 * 三層修法都要釘住:
 *   ① 礦端:diff 基準改用完整 `hold_all`;prev 沒有 hold_all(舊 schema)= 基準重建,不算換股
 *   ② 前端守門:一天 added ≥8 檔且 removed/up/down 全 0 = 基準重建殘留 → 不顯 🆕換入
 *   ③ 燈號鐵則:跟車燈講的是「風險」不是「方向」→ ⛔ 不可用 🟢🟡(✅/⚠️/⛔/💡/⏳)
 *
 * 跑法:node scripts/test_etffollow.mjs
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath, pathToFileURL } from 'url';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 260)}`}`); if (!c) fails.push(n); };

// ── ⓪ 礦端原始碼守門(不用跑網路,直接驗邏輯存在)────────────────────
const miner = fs.readFileSync(path.join(ROOT, 'etf_miner.py'), 'utf8');
ok('⓪ ⭐ 礦端 prev 基準優先讀 hold_all(完整清單)', /e\.get\("hold_all"\) or e\.get\("holdings"/.test(miner));
ok('⓪ ⭐ 礦端有存 hold_all(給明天的 diff 當基準)', /"hold_all":\s*\[/.test(miner));
ok('⓪ ⭐ 過渡輪守門:prev 沒 hold_all → 視同基準重建不算換股', /prev_has_full\.get\(s\)/.test(miner));

// ── ⓪b 礦端 diff 純函式:完整 vs 完整 不可再生出假 added ────────────
// ⚠️ 第一版用 `python3 -c ${JSON.stringify(py)}` → shell 把 \n 當字面量、Python SyntaxError,
//    但 SyntaxError 會**回顯原始碼**、裡面剛好有 print("PYOK") → regex 假綠燈(空過)。
//    → 改寫進暫存檔執行;marker 用拼接字串,原始碼回顯裡永遠湊不出完整 marker。
const py = [
    `import sys; sys.path.insert(0, ${JSON.stringify(ROOT)})`,
    'import etf_miner as m',
    'full_y = [{"sym": f"{1000+i}", "weight": 5.0} for i in range(40)]',
    'full_t = [dict(h) for h in full_y]',
    'd = m.diff_holdings(full_y, full_t)',
    'assert not d["added"] and not d["removed"], f"same-list diff should be empty: {d}"',
    '# 截斷 prev(重現舊 bug 的輸入)→ 這種輸入交給 diff 一定會爆 added,所以 main() 必須擋在 diff 之前',
    'd2 = m.diff_holdings(full_y[:15], full_t)',
    'assert len(d2["added"]) == 25, "truncated-prev vs full-curr must mass-add (proves the old bug mechanism)"',
    'print("PY" + "OK_MARKER")',
].join('\n');
const pyFile = path.join(ROOT, 'scripts', '.test_etffollow_tmp.py');
fs.writeFileSync(pyFile, py);
let pyOut = '';
try { pyOut = execSync(`python3 ${JSON.stringify(pyFile)}`, { encoding: 'utf8', stderr: 'pipe' }); }
catch (e) { pyOut = String(e.stdout || '') + String(e.stderr || ''); }
finally { try { fs.unlinkSync(pyFile); } catch (_) { } }
ok('⓪b ⭐ diff_holdings 純函式行為驗證(同清單=空 diff;截斷基準=必然假 added)', pyOut.includes('PYOK_MARKER'), pyOut);

// ── headless 載入 app ────────────────────────────────────────────────
const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
await page.addInitScript(() => {
    const noop = () => inst;
    const inst = new Proxy({}, { get: (_t, k) => (k === 'getWidth' || k === 'getHeight') ? (() => 300) : noop });
    Object.defineProperty(window, 'echarts', { value: new Proxy({}, { get: (_t, k) => k === 'init' ? (() => inst) : (k === 'graphic' ? {} : noop) }), writable: true, configurable: true });
});
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._etfActionsForStock, null, { timeout: 25000 });

const R = await page.evaluate(() => {
    const mk = (added, removed = [], up = [], dn = []) => ({
        symbol: '00999A', name: '測試主動', holdings_count: 50,
        changes: { added, removed, weight_up: up, weight_down: dn },
    });
    const out = {};
    // ① 基準重建殘留:38 檔 added、其餘全 0 → ⛔ 不可顯 🆕換入
    app._etfCache = { etfs: [mk(Array.from({ length: 38 }, (_, i) => ({ sym: i === 0 ? '2327' : `${3000 + i}`, est_shares: 10 })))] };
    out.rebuilt = app._etfActionsForStock('2327').length;
    // ② 真換股:只換入 2 檔 → 照顯
    app._etfCache = { etfs: [mk([{ sym: '2327', est_shares: 10 }, { sym: '2330', est_shares: 5 }])] };
    out.real = app._etfActionsForStock('2327').length;
    // ③ 整批 added 但同時有 removed → 不是基準重建(真的大幅換股)→ 照顯
    app._etfCache = { etfs: [mk(Array.from({ length: 9 }, (_, i) => ({ sym: `${2320 + i}`, est_shares: 10 })), [{ sym: '9999', est_shares: 3 }])] };
    out.bigReal = app._etfActionsForStock('2327').length;
    // ④ 燈號鐵則:跟車燈不可用 🟢🟡🔴
    out.lamps = [app._etfFollowLamp(100, 102).lamp, app._etfFollowLamp(100, 110).lamp,
                 app._etfFollowLamp(100, 130).lamp, app._etfFollowLamp(100, 98).lamp,
                 app._etfFollowLamp(null, null).lamp];
    // ⑤ 「適合跟車」進場指令必須過 _bearGate
    out.verdictSrc = app.renderEtfFollowCard.toString();
    return out;
});

ok('① ⭐⛔ 基準重建殘留(added=38、其餘全0)不可顯 🆕換入', R.rebuilt === 0, `拿到 ${R.rebuilt} 筆`);
ok('② 真換股(added=2)照顯', R.real === 1, `拿到 ${R.real} 筆`);
ok('③ added=9 但有 removed → 是真換股,照顯', R.bigReal === 1, `拿到 ${R.bigReal} 筆`);
ok('④ ⭐ 燈號鐵則:跟車燈只用 ✅/⚠️/⛔/💡/⏳,⛔ 不可 🟢🟡🔴',
   R.lamps.join('') === '✅⚠️⛔💡⏳' || (!/[🟢🟡🔴⚪🔵]/u.test(R.lamps.join('')) && R.lamps.includes('✅')),
   JSON.stringify(R.lamps));
ok('⑤ ⭐「適合跟車」前有過 _bearGate(進場指令鐵則)', /_bearGate/.test(R.verdictSrc));
ok('⑤ 空頭時的替代文案不可叫人進場(只觀察)', /等趨勢翻多再考慮跟車/.test(R.verdictSrc));

await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n🎉 全數通過');
process.exit(fails.length ? 1 : 0);
