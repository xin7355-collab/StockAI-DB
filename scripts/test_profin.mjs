#!/usr/bin/env node
// 📑 V78.6.9 產業作戰室「財報」分頁守門(使用者貼的 financial-analyst 子代理 → 網頁版)
//   ① 有分頁鈕 + TABS 有 fin + div
//   ② 切過去自動讀 2330:表格每一格 == data/fin/2330.json(⛔ 前端不另算)
//   ③ 季營收年增 = 第 i 季 ÷ 第 i−4 季(跟散戶救星 `_finTrend` 同一條;靜態 + 行為都比)
//   ④ 每一欄有季別 + 法定公布期限,檔頭有來源與更新日
//   ⑤ null 一律「—」+ 原因(⛔ 不補 0);舊檔沒有負債欄 → 原因寫「等財報回算」
//   ⑥ 合成一檔有負債欄 → 負債比 / 流動比照 JSON 顯示;面額變更 nm_error 進原因
//   ⑦ ⛔ 不評分、不給買賣字眼
//   ⑧ 390px 頁面⛔ 不橫向捲動(表格自己在框裡捲)
//   ⑨ 複製給 AI 的文字:有期間、有來源、null 寫 null、有「⛔ 不要自己推估」
//   ⑩ 名稱也查得到(台積電 → 2330)
// 注入:INJECT=yoy1(年增改 i−1)/ zero(null 印成 0)/ nowhy(拿掉原因)→ 必紅
import fs from 'fs';
let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 240)}`}`); if (!c) fails.push(n); };
const ROOT = new URL('..', import.meta.url).pathname;
let PRO = fs.readFileSync(ROOT + 'pro.html', 'utf8');
const IDX = fs.readFileSync(ROOT + 'index.html', 'utf8');
const INJ = process.env.INJECT || '';
if (INJ === 'yoy1') PRO = PRO.replace('(i >= 4 && r.rev != null && q[i - 4].rev > 0) ? (r.rev / q[i - 4].rev - 1) * 100', '(i >= 1 && r.rev != null && q[i - 1].rev > 0) ? (r.rev / q[i - 1].rev - 1) * 100');
if (INJ === 'zero') PRO = PRO.replace("if (v == null) return '—';", "if (v == null) return '0';");
if (INJ === 'nowhy') PRO = PRO.replace("${whys.length ? `<div data-finwhy", "${0 ? `<div data-finwhy");

ok('① 分頁鈕 + TABS + div', /id="tabBtnFin"[^>]*>📑 財報</.test(PRO) && /\['fin',\s*'Fin'\]/.test(PRO) && /<div id="tabFin"/.test(PRO));
// ③ 靜態:兩邊都是「位置往前 4 格」
const idxYoy = /rows\[i - 4\]\.rev > 0\) \? \(r\.rev \/ rows\[i - 4\]\.rev - 1\) \* 100/.test(IDX);
const proYoy = /q\[i - 4\]\.rev > 0\) \? \(r\.rev \/ q\[i - 4\]\.rev - 1\) \* 100/.test(PRO);
ok('③a 季營收年增:散戶救星 _finTrend 與財報分頁同一條(第 i 季 ÷ 第 i−4 季)', idxYoy && proYoy, JSON.stringify({ idxYoy, proYoy }));

// ⑥ 合成一檔(有負債欄 + 面額變更 nm_error)—— data/ 是 gitignore,用完刪掉
const FIX = ROOT + 'data/fin/TST9.json';
const qs = [];
for (const [y, m] of [[2024, '03-31'], [2024, '06-30'], [2024, '09-30'], [2024, '12-31'], [2025, '03-31'], [2025, '06-30']]) {
    qs.push({ p: `${y}-${m}`, pub: `${y}-08-14`, rev: 2e10, gm: 30, oim: 10, nm: 8, ocf: 3e9, fcf: 1e9, ta: 1e11, li: 4e10, debt: 40, cur: 150 });
}
qs[5].nm = null; qs[5].nm_error = '疑似面額變更(2025-06 起 EPS 縮小、股本金額不變 → 股數變多)';
fs.writeFileSync(FIX, JSON.stringify({ sym: 'TST9', updated: '2026-10-08', src: 'test', cum_fixed: ['ocf'], q: qs, flags: [], caveat: '測試' }));
const TMP = ROOT + 'pro.__profin_test.html';
fs.writeFileSync(TMP, PRO);

const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const errs = [];
try {
    const p = await browser.newPage({ viewport: { width: 390, height: 844 } });
    p.on('pageerror', e => errs.push(String(e)));
    await p.goto('file://' + TMP);
    await p.waitForTimeout(1500);
    await p.evaluate(() => PRO.switchTab('fin'));
    let r = null;
    for (let i = 0; i < 20; i++) { await p.waitForTimeout(500); r = await p.evaluate(() => PRO._finD && PRO._finSym === '2330' ? 1 : null); if (r) break; }
    ok('② 切到財報分頁自動讀 2330', r === 1 && await p.evaluate(() => !document.getElementById('tabFin').classList.contains('hidden')));
    const J = JSON.parse(fs.readFileSync(ROOT + 'data/fin/2330.json', 'utf8'));
    const cells = await p.evaluate(() => [...document.querySelectorAll('#finBody td[data-fink]')].map(td => ({ k: td.dataset.fink, i: +td.dataset.fini, t: td.textContent.trim(), why: td.title || '' })));
    const fmtB = v => (v / 1e8).toLocaleString('zh-TW', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' 億';
    const bad = [];
    for (const c of cells) {
        const q = J.q[c.i]; let want;
        if (c.k === 'yoy') want = (c.i >= 4 && q.rev != null && J.q[c.i - 4].rev > 0) ? ((q.rev / J.q[c.i - 4].rev - 1) * 100).toFixed(1) + '%' : '—';
        else if (c.k === 'rev' || c.k === 'ocf' || c.k === 'fcf') want = q[c.k] == null ? '—' : fmtB(q[c.k]);
        else if (c.k === 'cur') want = q.cur == null ? '—' : Math.round(q.cur).toLocaleString('zh-TW') + '%';
        else want = q[c.k] == null ? '—' : (+q[c.k]).toFixed(1) + '%';
        if (c.t !== want) bad.push(`${c.k}@${q.p}: ${c.t} ≠ ${want}`);
    }
    ok('② 每一格 == data/fin/2330.json(8 季 × 9 項 = 72 格)', cells.length === 72 && bad.length === 0, `${cells.length} 格;${bad.slice(0, 4).join(' / ')}`);
    ok('③b 季營收年增那一列有數字(第 5 季起)', cells.some(c => c.k === 'yoy' && c.t !== '—'));
    const head = await p.evaluate(() => ({ th: [...document.querySelectorAll('#finBody th[data-finq]')].map(t => t.innerText), src: (document.querySelector('[data-finsrc]') || {}).innerText || '' }));
    ok('④ 每一欄有季別 + 「公布≤」,最新一季在最左', head.th.length === 8 && head.th.every(t => /\d\dQ[1-4]/.test(t) && /公布≤/.test(t)) && /26Q2/.test(head.th[0]), JSON.stringify(head.th.slice(0, 2)));
    ok('④ 檔頭有來源 + 資料更新日 + 「法定最晚公布日」說明', /來源:/.test(head.src) && /資料更新 \d{4}-\d\d-\d\d/.test(head.src) && /法定最晚公布日/.test(head.src), head.src);
    const debt = cells.filter(c => c.k === 'debt');
    const why = await p.evaluate(() => (document.querySelector('[data-finwhy]') || {}).innerText || '');
    ok('⑤ 舊檔沒有負債欄 → 「—」+ title 原因(⛔ 不補 0)', debt.length === 8 && debt.every(c => c.t === '—' && /V78\.6\.9/.test(c.why)), JSON.stringify(debt[0]));
    ok('⑤ 「—」的原因列在表格下方', /負債比:.*等「財報三表深歷史回算」/.test(why), why.slice(0, 200));
    const txt = await p.evaluate(() => document.getElementById('finBody').innerText);
    ok('⑦ ⛔ 不評分、不給買賣字眼', !/買進|賣出|加碼|減碼|目標價|評分\s*\d|\d+\s*分(?!鐘)|偏多|偏空|便宜|昂貴/.test(txt.replace(/⛔ 不評分、不判好壞、不給買賣。/, '')), (txt.match(/買進|賣出|加碼|減碼|目標價|偏多|偏空|便宜|昂貴/) || [''])[0]);
    const sx = await p.evaluate(() => { window.scrollTo(80, 0); return window.scrollX; });
    ok('⑧ 390px 頁面⛔ 不橫向捲動', sx <= 2, String(sx));
    const cp = await p.evaluate(() => PRO._finText());
    ok('⑨ 複製給 AI:季別 + 公布期限 + 來源 + null + 「⛔ 不要自己推估」', /26Q2\(≤2026-08-14\)/.test(cp) && /來源:/.test(cp) && /\bnull\b/.test(cp) && /⛔ 不要自己推估/.test(cp) && /null 的原因:/.test(cp), cp.slice(0, 300));
    await p.evaluate(() => PRO.finToggleN());
    ok('⑨b 切 12 季', await p.evaluate(() => document.querySelectorAll('#finBody th[data-finq]').length) === 12);
    // ⑥ 合成那一檔
    await p.evaluate(async () => { document.getElementById('finSym').value = 'TST9'; await PRO.finLoad(); });
    const t9 = await p.evaluate(() => [...document.querySelectorAll('#finBody td[data-fink]')].map(td => ({ k: td.dataset.fink, i: +td.dataset.fini, t: td.textContent.trim(), why: td.title || '' })));
    const g = (k, i) => t9.find(c => c.k === k && c.i === i) || {};
    ok('⑥a 有負債欄 → 負債比 40.0% / 流動比 150%(照 JSON,⛔ 前端不另算)', g('debt', 5).t === '40.0%' && g('cur', 5).t === '150%', JSON.stringify([g('debt', 5), g('cur', 5)]));
    ok('⑥b 面額變更那一季淨利率「—」,原因 = nm_error', g('nm', 5).t === '—' && /面額變更/.test(g('nm', 5).why), JSON.stringify(g('nm', 5)));
    ok('⑥c 前面不足 4 季 → 年增「—」並說原因', g('yoy', 2).t === '—' && /不足 4 季/.test(g('yoy', 2).why) && g('yoy', 4).t === '0.0%', JSON.stringify([g('yoy', 2), g('yoy', 4)]));
    // ⑩ 名稱
    await p.evaluate(async () => { document.getElementById('finSym').value = '台積電'; await PRO.finLoad(); });
    ok('⑩ 打中文名「台積電」也查得到 2330', await p.evaluate(() => PRO._finSym) === '2330');
    await p.evaluate(async () => { document.getElementById('finSym').value = 'ZZZZ'; await PRO.finLoad(); });
    ok('⑩b 本站沒有切片 → 說原因(⛔ 不留空白)', /本站沒有 ZZZZ 的財報切片/.test(await p.evaluate(() => document.getElementById('finBody').innerText)));
} finally {
    await browser.close();
    try { fs.unlinkSync(FIX); } catch (_) {}
    try { fs.unlinkSync(TMP); } catch (_) {}
}
ok('pageerror 0', errs.length === 0, errs.slice(0, 3).join(' | '));
console.log(fails.length ? `\n❌ ${fails.length} 條失敗:${fails.join(' / ')}` : '\n✅ test_profin 全過');
process.exit(fails.length ? 1 : 0);
