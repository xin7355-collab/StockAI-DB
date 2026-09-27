// 📤 V77.7.3 實測總表「匯出給 AI」守門
//
// 使用者:「把實測總表做個可以匯出,我要拿去問 AI」。
// 釘住:
//  ① 全部匯出 = LAB 五欄條數加總(⛔ 不可漏條、⛔ 不可自己另存一份)
//  ② 沒有 HTML 標籤 / 實體(外部 AI 讀到 <b> 會當成雜訊)
//  ③ 一定帶「回測方法」段:36% 基準・0.44% 成本・六道關卡・17 條起點・修資料的警語
//  ④ 提問範本帶「⛔ 不要再推薦實測沒用的」「⛔ 不要自己編數字」;ask:false 時不帶
//  ⑤ 精簡版比完整版短,而且不含「說明:」
//  ⑥ 搜尋一個主題後「目前畫面」只匯出那幾條(= labRows),數字從 LAB 現讀
//  ⑦ ✅有用 照 r 由大到小;其他欄照 u 新→舊(跟畫面同一個排序規則)
//  ⑧ 按鈕/面板存在,面板打開後選單三個 + 兩顆動作鈕;📋 複製失敗要改口叫人下載(⛔ 靜默)
//  ⑨ 決定性對照:把 LAB 某一條的數字改掉 → 匯出文字跟著變(證明不是寫死)
// 跑法:node scripts/test_labexport.mjs
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAIL = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 240)}`); if (!c) FAIL.push(n); };

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) || String(e); if (!/Failed to load|net::ERR_|CORS/i.test(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'pro.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof PRO === 'object' && typeof PRO.labExportText === 'function', null, { timeout: 20000 });

const R = await page.evaluate(() => {
    const cols = PRO.LAB_TABS.map(t => t[0]).filter(k => Array.isArray(PRO.LAB[k]));
    const total = cols.reduce((s, k) => s + PRO.LAB[k].length, 0);
    const all = PRO.labExportText({ scope: 'all' });
    const brief = PRO.labExportText({ scope: 'all', full: false });
    const noAsk = PRO.labExportText({ scope: 'all', ask: false });
    // ⑦ 排序:V77.7.9 ✅ 改成「分組 → r」(白話層),⭐ 釘的是用意 =「匯出順序 = 畫面順序」—— 直接讀畫面上的原始標題
    PRO.switchTab('lab'); PRO.labSearch(''); PRO.selLab('ok');
    const norm = t => String(t).replace(/——|\*\*|\s/g, '');
    const okSorted = [...document.querySelectorAll('#labList .labitem .lot')].map(e => e.textContent);
    const okSortedN = okSorted.map(norm);
    const okOrderFn = PRO._labOkOrder(PRO.LAB.ok).map(x => norm(PRO._labPlain(x.t)));
    const trapSorted = PRO.LAB.trap.slice().sort((a, b) => (b.u || '').localeCompare(a.u || '')).map(x => PRO._labPlain(x.t));
    const heads = all.split('\n').filter(l => l.startsWith('### ')).map(l => l.replace(/^### \d+\. /, ''));
    const headsN = heads.map(norm);
    // ⑥ 搜尋
    PRO.switchTab('lab');
    PRO.labSearch('出場');
    const view = PRO.labExportText({ scope: 'view' });
    const nRows = PRO._labRows().length;
    // ⑧ 面板
    PRO.labExportToggle();
    const panel = document.getElementById('labExport');
    const panelOpen = panel && !panel.classList.contains('hidden');
    const sel = panel ? panel.querySelectorAll('select').length : 0;
    const btns = panel ? [...panel.querySelectorAll('button')].map(b => b.textContent) : [];
    const scopeVal = (document.getElementById('labExScope') || {}).value;
    // 複製失敗 → toast 要叫人下載
    const oc = PRO._copySync, ot = PRO.toast; let msg = '';
    PRO._copySync = () => false; PRO.toast = m => { msg = m; };
    PRO.labExportDo('copy');
    PRO._copySync = oc; PRO.toast = ot;
    PRO.labSearch('');
    // ⑨ 決定性對照
    const it = PRO.LAB.trap[0]; const bak = it.n;
    it.n = '注入值 12345.678';
    const inj = PRO.labExportText({ scope: 'all' });
    it.n = bak;
    return { total, all, brief, noAsk, okSorted, okSortedN, okOrderFn, headsN, nOk: PRO.LAB.ok.length, trapSorted, heads, view, nRows, panelOpen, sel, btns, scopeVal, msg, inj };
});

// ⚠️ 只認真的 HTML 標籤名(內文本來就有「ma5<ma20」這種比較式,⛔ 不可當成標籤)
const TAG = /<\/?(b|i|u|em|strong|span|div|br|mark|a|small|code|details|summary|p|li|ul|sup|sub)\b[^>]*>|&(nbsp|amp|lt|gt|quot|#39);/i;
const nHead = R.all.split('\n').filter(l => l.startsWith('### ')).length;
ok(`① 全部匯出 ${nHead} 條 = LAB 五欄加總 ${R.total} 條`, nHead === R.total && R.total > 250, `${nHead} vs ${R.total}`);
ok('② 沒有 HTML 標籤或實體', !TAG.test(R.all), (R.all.match(new RegExp('.{0,30}(' + TAG.source + ').{0,30}', 'i')) || [''])[0]);
ok('③ 帶回測方法段(基準 36%・成本 0.44%・六道關卡・17 條起點・修資料警語)',
   /## 回測方法/.test(R.all) && /36%/.test(R.all) && /0\.44%/.test(R.all) && /六道關卡/.test(R.all) && /17 次/.test(R.all) && /V77\.7\.0/.test(R.all));
ok('④ 提問範本:⛔ 不要再推薦實測沒用的 + ⛔ 不要自己編數字', /## 我想請你做的事/.test(R.all) && /不要再推薦/.test(R.all) && /不要自己編數字/.test(R.all));
ok('④b ask:false 就不帶提問範本(但方法段照帶)', !/## 我想請你做的事/.test(R.noAsk) && /## 回測方法/.test(R.noAsk));
ok('⑤ 精簡版比完整版短且不含「完整說明:」', R.brief.length < R.all.length && !/- 完整說明:/.test(R.brief) && /- 完整說明:/.test(R.all), `${R.brief.length}/${R.all.length}`);
const nView = R.view.split('\n').filter(l => l.startsWith('### ')).length;
ok(`⑥ 搜尋「出場」後目前畫面匯出 ${nView} 條 = 畫面上 ${R.nRows} 條`, nView === R.nRows && nView > 0 && nView < R.total, `${nView} vs ${R.nRows}`);
ok('⑦ ✅有用 匯出順序 = 畫面順序(V77.7.9 分組 → r;56 條逐條比)', R.okSortedN.length === R.nOk && R.okSortedN.every((t, i) => R.headsN[i] === t), R.heads.slice(0, 3).join(' | '));
ok('⑦a 畫面順序 = 共用排序函式 _labOkOrder(⛔ 兩邊各排一次會對不上)', R.okOrderFn.length === R.nOk && R.okOrderFn.every((t, i) => R.okSortedN[i] === t), R.okSorted.slice(0, 2).join(' | '));
{
    const iTrap = R.heads.indexOf(R.trapSorted[0]);
    ok('⑦b 其他欄照 u 新→舊(實測沒用那欄的第一條 = u 最新的那條)', iTrap > 0 && R.heads[iTrap + 1] === R.trapSorted[1], iTrap);
}
ok('⑧ 面板打開:3 個選單 + 📋 複製 + ⬇️ 下載', R.panelOpen && R.sel === 3 && R.btns.some(b => /複製/.test(b)) && R.btns.some(b => /下載/.test(b)), JSON.stringify(R.btns));
ok('⑧b 搜尋中打開面板,預設就是「目前畫面」', R.scopeVal === 'view', R.scopeVal);
ok('⑧c 📋 複製失敗 ⛔ 不可靜默 → 叫人改用下載', /下載/.test(R.msg), R.msg);
ok('⑨ ⭐ 決定性對照:改 LAB 一條的數字 → 匯出跟著變', R.inj.includes('注入值 12345.678') && !R.all.includes('注入值 12345.678'));
{
    const blocks = R.all.split('\n### ').slice(1);
    ok('⑩ 每一條都有「判定」與「技術備註」,而且技術備註排在最後', blocks.length === R.total && blocks.every(b => /\n- 判定:/.test(b) && /\n- 技術備註:[^\n]*$/.test(b.split('\n## ')[0].trimEnd())), blocks.find(b => !/\n- 判定:/.test(b))?.slice(0, 80));
    ok('⑪ 研究速記「做多」「配置」匯出時翻成白話(判定那一行不可出現「(做多」)', !/- 判定:[^\n]*\(做多/.test(R.all) && /偏向可用/.test(R.all), '');
    ok('⑫ 名詞先翻譯:六道關卡 / 高原 / 安慰劑 / pp 都在方法段', ['六項穩定性檢查', '孤峰', '安慰劑', '百分點'].every(w => R.all.split('## ✅')[0].includes(w)), '');
}
ok('⓪ 沒有 pageerror', errs.length === 0, errs.join(' | '));

await browser.close();
console.log(`\n${FAIL.length ? '❌ ' + FAIL.length + ' 條沒過' : '✅ 全部通過'}`);
process.exit(FAIL.length ? 1 : 0);
