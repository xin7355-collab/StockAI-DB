// 🗣️ V77.7.9 實測總表「白話層」守門(使用者附件 overlay.py / build.py 的做法)
//  ① ✅ 每一條都帶合法的 pl:[分組, 環節, 可信度1~3, 一句話, 對你的意思, 白話數字](⛔ 新條目沒帶 → 紅)
//  ② 「已被新版取代」的那幾條,「對你的意思」要說出被誰取代
//  ③ 畫面:✅ 分頁照「可以照做 → 當參考 → 要避開 → 長期存股 → 已被取代」分組;第一張仍是 🧬 + 🥇
//  ④ ⛔ 燈號鐵則:白話層(分組標題 / 一句話 / 可信度 / 環節)不可出現 🔴🟢
//  ⑤ 沒有 pl 的欄位照 build.py 規則:標題「——」前半 = 一句話;⛔ 沒用那欄 = 「結果:…」
//  ⑥ 搜尋「對你的意思」裡才有的字要找得到;點環節 = 搜尋那個環節
//  ⑦ 匯出:有 pl 的條目要帶「一句話 / 對你的意思 / 分類」,而且在「判定」之前
//  ⑧ 決定性對照:改一條 pl 的一句話 → 畫面與匯出一起變;拿掉一條 pl → ① 會紅
// 跑法:node scripts/test_labplain.mjs
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
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) || String(e); if (!/Failed to load|net::ERR_|CORS/i.test(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'pro.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.PRO, null, { timeout: 30000 });
await page.waitForTimeout(800);

const R = await page.evaluate(() => {
    const G = PRO.LAB_GRP.map(z => z[0]), SEG = PRO.LAB_SEG;
    const bad = [];
    for (const x of PRO.LAB.ok) {
        const t = PRO._labPlain(x.t).slice(0, 24);
        if (!Array.isArray(x.pl) || x.pl.length !== 6) { bad.push(`${t}:沒有 pl`); continue; }
        const [g, e, c, p, m, pn] = x.pl;
        if (!G.includes(g)) bad.push(`${t}:分組 ${g}`);
        if (!SEG.includes(e)) bad.push(`${t}:環節 ${e}`);
        if (![1, 2, 3].includes(c)) bad.push(`${t}:可信度 ${c}`);
        if (!p || !m || typeof pn !== 'string') bad.push(`${t}:一句話/意思空白`);
    }
    const oldNoRef = PRO.LAB.ok.filter(x => x.pl?.[0] === 'old' && !/取代|預設|沒有採用/.test(x.pl[4])).length;
    // ③ 畫面
    PRO.switchTab('lab'); PRO.labSearch(''); PRO.selLab('ok');
    const list = document.getElementById('labList');
    const grpOrder = [...list.querySelectorAll('.lgrp b')].map(e => e.textContent.trim());
    const seq = [...list.children].map(e => e.classList.contains('lgrp') ? 'H' : (e.className.match(/g-(\w+)/) || [])[1]);
    // 每張卡所屬的分組要跟它上面那個標題一致
    let cur = -1, mism = 0; const names = PRO.LAB_GRP.map(z => z[1]);
    for (const el of list.children) {
        if (el.classList.contains('lgrp')) { cur = names.indexOf(el.querySelector('b').textContent.trim()); continue; }
        const g = (el.className.match(/g-(\w+)/) || [])[1]; if (G[cur] !== g) mism++;
    }
    const first = list.querySelector('.labitem');
    const firstLt = first?.querySelector('.lt')?.textContent || '', firstRank = first?.querySelector('.lrank')?.textContent.trim();
    const cardsHaveM = [...list.querySelectorAll('.labitem')].every(e => e.querySelector('.lm'));
    // ④ 燈號
    const plainTxt = [...list.querySelectorAll('.lgrp, .lt, .lm, .lpn, .lmeta')].map(e => e.textContent).join(' ');
    const redGreen = (plainTxt.match(/[🔴🟢]/gu) || []).length;
    // ⑤ fallback
    const tr = PRO.LAB.trap.find(x => !x.pl && / —— /.test(PRO._labPlain(x.t)));
    const trP = tr ? PRO._labPlainOf({ ...tr, _col: 'trap' }) : null;
    const trHead = tr ? PRO._labPlain(tr.t).replace(/\*\*/g, '').split(/\s*——\s*/)[0] : '';
    const nx = PRO._labPlainOf({ ...PRO.LAB.next[1], _col: 'next' });
    // ⑥ 搜尋:拿「對你的意思」裡的字(只在 pl 出現、⛔ 不在原文)
    const probeM = PRO.LAB.ok.map(x => x.pl?.[4] || '').join('');
    const hay = PRO.LAB.ok.map(x => `${x.t} ${x.d} ${x.how} ${x.n} ${x.w} ${x.s}`).join(' ');
    let word = ''; for (let i = 0; i + 6 <= probeM.length && !word; i++) { const w = probeM.slice(i, i + 6); if (!/[\s,。、:;()「」]/.test(w) && !hay.includes(w)) word = w; }
    PRO.labSearch(word); const qHits = document.querySelectorAll('#labList .labitem').length;
    PRO.labSearch(''); PRO.selLab('ok');
    const seg = list.querySelector('.labitem .lseg'); const segTxt = seg?.textContent; seg?.click();
    const segQ = PRO._labQ; PRO.labSearch(''); PRO.selLab('ok');
    // ⑦ 匯出
    const ex = PRO.labExportText({ scope: 'all' });
    const okPart = ex.split('\n## ').find(s => s.startsWith('✅')) || '';
    const blocks = okPart.split('\n### ').slice(1);
    const exOk = blocks.length === PRO.LAB.ok.length && blocks.every(b => /\n- 一句話:[^\n]+\n- 對你的意思:[^\n]+/.test(b) && b.indexOf('- 一句話:') < b.indexOf('- 判定:') && /\n- 分類:[^\n]+・環節/.test(b));
    const trapPart = ex.split('\n## ').find(s => s.startsWith('⛔')) || '';
    const trapNoPl = !/- 一句話:/.test(trapPart);
    // ⑧ 決定性對照
    const tgt = PRO.LAB.ok.find(x => x.pl?.[0] === 'do'); const keep = tgt.pl[3];
    tgt.pl[3] = '注入測試一句話ZZ'; PRO.renderLab();
    const injScreen = list.innerText.includes('注入測試一句話ZZ'), injExport = PRO.labExportText({ scope: 'all' }).includes('- 一句話:注入測試一句話ZZ');
    tgt.pl[3] = keep; PRO.renderLab();
    const backClean = !list.innerText.includes('注入測試一句話ZZ');
    return { n: PRO.LAB.ok.length, bad, oldNoRef, grpOrder, seqHead: seq.slice(0, 3), mism, firstLt, firstRank, cardsHaveM,
             redGreen, trP, trHead, nx, word, qHits, segTxt, segQ, exOk, trapNoPl, injScreen, injExport, backClean,
             nGrp: document.querySelectorAll('#labList .lgrp').length };
});

ok('① ✅ 每一條都有合法的白話欄 pl(分組 / 環節 / 可信度 1~3 / 一句話 / 對你的意思)', R.bad.length === 0 && R.n > 50, R.bad.slice(0, 4).join(' | '));
ok('② 「已被新版取代」要說出被誰取代(⛔ 只寫「舊的」使用者不知道去看哪一條)', R.oldNoRef === 0, R.oldNoRef);
ok('③ ✅ 分頁照「可以照做 → 當參考 → 要避開 → 長期存股 → 已被取代」分組', JSON.stringify(R.grpOrder) === JSON.stringify(['✅ 可以照做', '📌 當參考', '🚫 要避開', '🐢 長期存股', '🗄️ 已被新版取代']), R.grpOrder.join(' / '));
ok('③b 每張卡都在自己分組的標題底下(⛔ 不可跑到別組)', R.mism === 0 && R.seqHead[0] === 'H', `mism=${R.mism} seq=${R.seqHead}`);
ok('③c 第一張仍是 🧬(排名第一)+ 🥇(V74.4.4 排名不動)', /🧬/.test(R.firstLt) && R.firstRank === '🥇', `${R.firstLt.slice(0, 30)} ${R.firstRank}`);
ok('③d 每一張卡在不展開時就看得到「對你的意思」', R.cardsHaveM, '');
ok('④ ⛔ 白話層不可出現 🔴🟢(分組 / 可信度 / 環節不是漲跌)', R.redGreen === 0, R.redGreen);
ok('⑤ 沒有 pl 的「實測沒用」:一句話 = 標題「——」前半、意思 = 「結果:…」', !!R.trP && R.trHead.endsWith(R.trP.p) && /^結果:/.test(R.trP.m), JSON.stringify(R.trP)?.slice(0, 160));
ok('⑤b 推薦下一步兩條用附件 NEXT 的白話(資料 / 2027)', R.nx.own && /2027/.test(R.nx.p) && R.nx.e === '資料', JSON.stringify(R.nx).slice(0, 120));
ok('⑥ 搜尋「對你的意思」裡才有的字找得到(⛔ 只搜原文會漏)', R.word.length === 6 && R.qHits >= 1, `${R.word} → ${R.qHits}`);
ok('⑥b 點環節小標 = 搜尋那個環節(⛔ 不做常駐篩選列)', !!R.segTxt && R.segQ === R.segTxt, `${R.segTxt} → ${R.segQ}`);
ok('⑦ 匯出:✅ 每條帶「一句話 / 對你的意思 / 分類・環節」而且排在「判定」之前', R.exOk, '');
ok('⑦b 匯出:沒有 pl 的欄位⛔ 不重複印一句話(推出來的就是標題本身)', R.trapNoPl, '');
ok('⑧ 決定性對照:改 pl 的一句話 → 畫面與匯出一起變,改回就消失', R.injScreen && R.injExport && R.backClean, [R.injScreen, R.injExport, R.backClean]);
ok('⓪ 沒有 pageerror', errs.length === 0, errs.slice(0, 2).join(' | '));

await browser.close();
console.log(FAIL.length ? `❌ ${FAIL.length} 條沒過` : '✅ 全部通過');
process.exit(FAIL.length ? 1 : 0);
