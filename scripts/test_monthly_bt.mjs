#!/usr/bin/env node
/**
 * 🗓️ V77.8.4 AI 時代逐月成績單守門(month_probe.mjs → embed_monthly_bt.mjs → pro.html `_MONTHLY_BT` / `_mbHtml`)
 *   ① 探針 selftest 全過(月底切點 / 不完整月 / 複利 / 捕捉率恆等式 / 預測檢定抓得到反轉、隨機不過 / 0050 含息 / 沒涵蓋 ⛔ 補 0)
 *   ② 嵌入:兩個 leg、17 條起點、≥36 個完整月、持有 1/3/6/12 四格、預測三條
 *   ③ 畫面:數字讀常數(⭐ 決定性對照:改一格常數,那一格跟著變)・⛔ 沒有 🔴🟢・一定寫「不是幾月比較好」・
 *      預測全部量不到時要明說「不要因為上個月輸就加碼」・390px 不橫捲(表格自己捲)
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRO_PATH = process.env.PRO_HTML || path.join(ROOT, 'pro.html');
const PRO = fs.readFileSync(PRO_PATH, 'utf8');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 240)}`); if (!c) fails.push(n); };

// ①
let st = ''; try { st = execFileSync('node', [path.join(ROOT, 'scripts/month_probe.mjs'), '--selftest'], { encoding: 'utf8' }); } catch (e) { st = String(e.stdout || e); }
ok('① month_probe --selftest 全過', /✅ selftest (\d+)\/\1/.test(st) && !/❌/.test(st), st.split('\n').filter(l => /❌/.test(l)).join(' | '));

// ②
const line = PRO.split('\n').find(l => /^\s*_MONTHLY_BT: \{/.test(l)) || '';
let M = null; try { M = JSON.parse(line.replace(/^\s*_MONTHLY_BT: /, '').replace(/,$/, '')); } catch (_) {}
ok('② 🚧 空過守門:讀得到 `_MONTHLY_BT` 且有兩個 leg', !!(M && M.legs && M.legs.pb && M.legs.idle), line.slice(0, 80));
if (M && M.legs && M.legs.pb) {
    for (const [k, L] of Object.entries(M.legs)) {
        ok(`②b ${k}:17 條起點、完整月 ≥ 36`, L.paths === 17 && L.desc.n >= 36, `${L.paths} / ${L.desc.n}`);
        ok(`②c ${k}:持有 1/3/6/12 個月四格都有`, [1, 3, 6, 12].every(h => L.roll[h] && L.roll[h].beat != null));
        ok(`②d ${k}:預測檢定三條都在,而且每條都有 t 與配對數`, Object.values(L.predict).length >= 3 && Object.values(L.predict).every(v => v.t != null && v.na > 0 && v.nb > 0));
    }
    ok('②e 起點是 AI 時代(2022-09 之後)、表格至少 45 格', M.from >= '2022-09' && M.legs.pb.t.length >= 45, `${M.from} / ${M.legs.pb.t.length}`);
}

// ③ 畫面
let chromium;
try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto('file://' + PRO_PATH, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof PRO !== 'undefined' && !!PRO._mbHtml, null, { timeout: 30000 });
const r = await page.evaluate(() => {
    const host = document.createElement('div'); host.style.width = '358px'; document.body.appendChild(host);
    host.innerHTML = PRO._mbHtml(); host.querySelector('details').open = true;
    const txt = host.innerText;
    const first = PRO._MONTHLY_BT.legs.pb.t.find(x => !x[4]);
    const cellTxt = () => (host.querySelector(`[data-mb="${first[0]}"]`) || {}).innerText || '';
    const before = cellTxt();
    const keep = first[1]; first[1] = 77.7;                    // ⭐ 決定性對照
    host.innerHTML = PRO._mbHtml(); host.querySelector('details').open = true;
    const after = cellTxt(); first[1] = keep;
    const r3 = PRO._MONTHLY_BT.legs.pb.roll[3], keepB = r3.beat; r3.beat = 12.3;
    host.innerHTML = PRO._mbHtml(); host.querySelector('details').open = true;
    const rollTxt = (host.querySelector('[data-mbroll="3"]') || {}).innerText || ''; r3.beat = keepB;
    host.innerHTML = PRO._mbHtml(); host.querySelector('details').open = true;
    window.scrollTo(80, 0);
    const over = [...host.querySelectorAll('*')].filter(el => { const b = el.getBoundingClientRect(); const inScroll = el.closest('[style*="overflow-x:auto"]'); return !inScroll && b.width > 0 && b.right > host.getBoundingClientRect().right + 1; }).length;
    const scrollers = [...host.querySelectorAll('[style*="overflow-x:auto"]')].map(el => el.getBoundingClientRect().width);
    return { txt, before, after, rollTxt, over, sx: window.scrollX, scrollers, hostW: host.getBoundingClientRect().width };
});
ok('③ 🚧 空過守門:畫面有字、host 有寬度', r.txt.length > 400 && r.hostW > 350, `${r.txt.length} / ${r.hostW}`);
ok('③b ⭐ 決定性對照:改常數一格 → 那一格跟著變(⛔ 不可寫死)', /\+77\.7%/.test(r.after) && !/77\.7/.test(r.before), `${r.before} → ${r.after}`);
ok('③c ⭐ 決定性對照:持有 3 個月「贏 0050 機率」讀常數', /12%/.test(r.rollTxt), r.rollTxt);
const w = M.legs.pb.desc.worst, wantW = `${Math.abs(w).toFixed(1)} 萬`;
ok(`③c2 元換算:最壞一個月 ${w}% → 100 萬本金賠 ${wantW}(1% = 1 萬)`, r.txt.includes(`100 萬賠 ${wantW}`), (r.txt.match(/100 萬賠[^;)]*/) || [''])[0]);
ok('③d ⛔ 沒有 🔴🟢(贏不贏用 ✔,漲跌用顏色)', !/[🔴🟢]/u.test(r.txt));
ok('③e 一定寫「不是幾月比較好」與樣本限制', /不是「幾月比較好」/.test(r.txt) && /只有 \d+ 個月/.test(r.txt));
const allFail = Object.values(M.legs.pb.predict).every(v => !v.pass);
ok('③f 預測檢定全部量不到時,要明說「⛔ 不要因為上個月輸就加碼」', !allFail || /不要因為上個月輸就加碼/.test(r.txt));
ok('③g 對短中線的意思:明說「不要用一兩個月的成績判斷」', /不要用一兩個月的成績判斷/.test(r.txt));
ok('③h 390px:頁面不橫捲、表格以外的元素不超出(表格自己捲)', r.sx <= 2 && r.over === 0 && r.scrollers.every(w => w <= 360), `scrollX ${r.sx} over ${r.over} ${r.scrollers}`);
ok('③i 無 pageerror', !errs.length, errs.join(' | '));
await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ 全過');
process.exit(fails.length ? 1 : 0);
