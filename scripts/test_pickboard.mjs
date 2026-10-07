// 🏆 V78.1.0 實測總表「選哪一套」守門(pro.html renderPick + STRAT_NAMES + _PROFIT_BOARD 的 gene 列)
//   使用者:「避免名稱重複,你重新命名一個最強的策略」「我看不出最強策略到底能賺多少錢?到底有沒有比 0050 還強」
//          「重新規劃介面,不是微調 —— 讓使用者更明白更簡單知道到底要用什麼策略」
//   ⛔ 這支釘的用意:
//     ① 資料:🧬 那三套(🔥/🅿️/🐢)跟 0050 在同一組 17 個起點(gene_board 對齊);數字讀看板 ⛔ 不寫死
//     ② 一句答案:最強那套的金額 == 看板;一定寫 0050 含息同期多少、贏幾個起點、代價(中途最多賠)
//     ③ 及格線:0050 那一列在排序裡的位置正確,比它低的列變淡寫「輸」
//     ④ 名字:全站一份 STRAT_NAMES、名字不重複、emoji 不重複;畫面⛔ 不再出現「決策台現行 V…」「上一任」當名字
//     ⑤ 🧬 模式看不到任何 👑;👑 模式答案換成領頭羊(決定性對照)
//     ⑥ 三層頁籤:一進來是 🏆 選哪一套;為什麼 / 原始數字各自有子頁籤;390px 不橫捲;⛔ 無 🔴🟢;無 pageerror
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRO = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 260)}`); if (!c) fails.push(n); };

const line = PRO.split('\n').find(l => /^  _PROFIT_BOARD: \{/.test(l)) || '';
let B = null; try { B = JSON.parse(line.replace(/^  _PROFIT_BOARD: /, '').replace(/,$/, '')); } catch (_) {}
ok('① 🚧 空過守門:讀得到 `_PROFIT_BOARD`', !!(B && B.wins && B.wins.ai && B.wins.long));
for (const w of ['ai', 'long']) {
  const G = (B?.wins?.[w]?.rows || []).filter(r => r.grp === 'gene');
  ok(`①b ${w}:🧬 三套(hot/park/don)都在,每列有變成 / 最差 / 中途最多賠 / 贏幾個起點`, JSON.stringify(G.map(r => r.k).sort()) === '["don","hot","park"]'
    && G.every(r => r.fin > 0 && r.worst > 0 && r.worst <= r.fin && r.mdd < 0 && r.beat >= 0 && r.beat <= B.paths), JSON.stringify(G));
}
ok('①c gene 列來源有寫(gene_board.mjs)', /gene_board/.test(B?.geneSrc || ''), B?.geneSrc);
ok('①d 產生者:embed_profit_board.mjs 有 --gene 模式 + 0050 交叉驗證', /--gene/.test(fs.readFileSync(path.join(ROOT, 'scripts/embed_profit_board.mjs'), 'utf8')) && /0050 .* ≠ 看板/.test(fs.readFileSync(path.join(ROOT, 'scripts/embed_profit_board.mjs'), 'utf8')));

let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const run = async (strategy) => {
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  await page.addInitScript(st => { try { const s = JSON.parse(localStorage.getItem('proTerminalSettings') || '{}'); s.strategy = st; s.stratUnlock = st === 'lead'; localStorage.setItem('proTerminalSettings', JSON.stringify(s)); } catch (_) {} }, strategy);
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto('file://' + path.join(ROOT, 'pro.html'), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof PRO !== 'undefined' && !!PRO.renderPick, null, { timeout: 30000 });
  const R = await page.evaluate(async () => {
    const o = {};
    o.defSel = PRO._labSel;
    try { await PRO.switchTab('lab'); } catch (_) {}
    PRO._labSel = 'pick'; PRO._pkSort = null; PRO._pkOpen = null; PRO.renderLab();
    const box = () => document.getElementById('pickBody');
    o.txt = box().innerText;
    o.bar = document.getElementById('labBar').innerText;
    o.big = [...document.querySelectorAll('#labBar .labbig .lbg')].map(e => e.innerText + (e.classList.contains('on') ? '*' : ''));
    o.subRows = document.querySelectorAll('#labBar .labrow').length;
    o.listHidden = document.getElementById('labList').style.display === 'none';
    o.hero = (document.getElementById('pkHero') || {}).innerText || '';
    o.rows = [...box().querySelectorAll('#pkTbl tbody tr[data-pk]')].map(tr => ({ k: tr.dataset.pk, lose: tr.classList.contains('pk-lose'), t: tr.innerText }));
    o.hdr = [...box().querySelectorAll('#pkTbl th.ybsort')].map(th => (th.getAttribute('onclick').match(/'(\w+)'/) || [])[1]);
    // 決定性對照:改看板一格 → 一句答案跟著變
    const Bd = PRO._PROFIT_BOARD, top = o.rows.find(r => r.k !== '0050');
    o.cagrA = (document.querySelector('[data-pkcagr="a"]') || {}).innerText || ''; o.cagrL = (document.querySelector('[data-pkcagr="l"]') || {}).innerText || '';
    const row = Bd.wins.ai.rows.find(r => r.k === top.k), keep = row.fin; row.fin = 98765432; PRO.renderPick();
    o.inj = (document.getElementById('pkHero') || {}).innerText.includes('9,877 萬');
    o.cagrInj = (document.querySelector('[data-pkcagr="a"]') || {}).innerText || ''; row.fin = keep; PRO.renderPick();
    // 排序:點 16 年 → 第一列換;再點反向
    PRO.pkSort('l'); o.s1 = box().querySelector('#pkTbl tbody tr').dataset.pk; PRO.pkSort('l'); o.s2 = box().querySelector('#pkTbl tbody tr').dataset.pk; PRO._pkSort = null; PRO.renderPick();
    // 點開一列 → 三行怎麼做 + 看證據
    PRO.pkOpen(top.k); o.det = (box().querySelector('#pkTbl tr.pk-det') || {}).innerText || ''; PRO.pkOpen(top.k);
    o.whoTxt = (document.getElementById('pkWho') || {}).innerText || '';
    o.names = Object.values(PRO.STRAT_NAMES).map(m => m.n);
    // 子頁籤:為什麼 / 原始數字
    PRO.selLab('ok'); o.whyBar = document.getElementById('labBar').innerText; o.whySub = document.querySelectorAll('#labBar .labrow').length; o.pickClearedOnWhy = document.getElementById('pickBody').innerHTML === '';
    PRO.selLab('bt'); o.numBar = document.getElementById('labBar').innerText;
    document.getElementById('btResearch').open = true;   // ⚠️ 逐年表收在關著的摺疊裡,關著讀不到 innerText
    o.yb = (document.getElementById('yearlyBody') || {}).innerText || '';
    o.pf = (document.getElementById('profitBody') || {}).innerText || '';
    PRO.selLab('pick');
    o.sx = (window.scrollTo(80, 0), window.scrollX);
    { const t = document.getElementById('pkTbl'); o.fit = t ? t.scrollWidth - t.parentElement.clientWidth : 999; }
    return o;
  });
  await page.close();
  return { R, errs };
};

const { R: G, errs: e1 } = await run('gene');
const { R: L, errs: e2 } = await run('lead');
const wan = v => Math.round(v / 10000).toLocaleString() + ' 萬';
const aiRows = B.wins.ai.rows, lgRows = B.wins.long.rows, f = (rows, k) => rows.find(r => r.k === k);

// ② 一句答案
const e50a = f(aiRows, '0050'), e50l = f(lgRows, '0050');
const geneBest = ['park', 'hot', 'don'].map(k => ({ k, a: f(aiRows, k), l: f(lgRows, k) })).filter(x => x.a.fin > e50a.fin && x.l.fin > e50l.fin).sort((a, b) => b.a.fin - a.a.fin)[0];
ok('② 🧬 模式:一句答案的金額 == 看板(近 4 年 / 16 年 / 0050 含息)', geneBest && G.hero.includes(wan(geneBest.a.fin)) && G.hero.includes(wan(geneBest.l.fin)) && G.hero.includes(wan(e50a.fin)) && G.hero.includes(wan(e50l.fin)), G.hero);
ok('②b 一句答案寫:贏幾個起點 + 代價(中途最多賠)', /贏 \d+ \/ \d+ 個/.test(G.hero) && /代價/.test(G.hero) && /中途最多賠/.test(G.hero), G.hero);
ok('②c 最強不是你現在用的 → 要寫「你現在用的是 🔥 高檔飆股」+ 它的金額與結論', geneBest.k === 'hot' || (/你現在用的是\s*🔥 高檔飆股/.test(G.hero) && G.hero.includes(wan(f(aiRows, 'hot').fin))), G.hero);
ok('②d 停車 0050 是最強時要寫「自動下單還沒做」', geneBest.k !== 'park' || /自動下單還沒做/.test(G.hero), G.hero);
ok('②e ⭐ 決定性對照:改看板一格 → 一句答案跟著變', G.inj);

// ②f 📈 V78.5.8 每年 / 每月平均(獨立重算:複利、起訖日 ÷ 365.25)
const cg = (fin, from) => { const y = (Date.parse(B.to) - Date.parse(from)) / (365.25 * 864e5), r = Math.pow(fin / 1e6, 1 / y) - 1; return { y: r * 100, m: (Math.pow(1 + r, 1 / 12) - 1) * 100 }; };
const fx = v => (v < 0 ? '−' : '+') + Math.abs(v).toFixed(1) + '%';
if (geneBest) {
  const ca = cg(geneBest.a.fin, B.wins.ai.from), cl = cg(geneBest.l.fin, B.wins.long.from);
  ok('②f 📈 一句答案的每年 / 每月平均 == 獨立重算(近 4 年 / 16 年)', G.cagrA.includes(`每年平均 ${fx(ca.y)}`) && G.cagrA.includes(`每月平均 ${fx(ca.m)}`) && G.cagrL.includes(`每年平均 ${fx(cl.y)}`) && G.cagrL.includes(`每月平均 ${fx(cl.m)}`), `${G.cagrA} | ${G.cagrL} | 期望 ${fx(ca.y)} ${fx(ca.m)} / ${fx(cl.y)} ${fx(cl.m)}`);
}
ok('②g ⭐ 決定性對照:改看板一格 → 每年平均跟著變', G.cagrInj && G.cagrInj !== G.cagrA, G.cagrInj + ' vs ' + G.cagrA);
ok('②h 寫明「是平均,不是每年都賺」+ 16 年贏 0050 幾年', /是「平均」,不是每年都賺/.test(G.hero) && /16 年裡只有 \d+ 年贏 0050/.test(G.hero), G.hero);
ok('②i 0050 及格線那一列也有每年 %', /每年 \+\d/.test(G.rows.find(r => r.k === '0050')?.t || ''), G.rows.find(r => r.k === '0050')?.t);

// ③ 及格線
const idx50 = G.rows.findIndex(r => r.k === '0050');
const above = G.rows.slice(0, idx50), below = G.rows.slice(idx50 + 1).filter(r => !/太晚上市/.test(r.t));
ok('③ 有 0050 及格線那一列,寫「比這條高才算贏」', idx50 >= 0 && /比這條高才算贏/.test(G.rows[idx50].t), JSON.stringify(G.rows.map(r => r.k)));
ok('③b 預設照近 4 年排:線上面的都比 0050 多、線下面的都變淡', above.every(r => f(aiRows, r.k).fin > e50a.fin && !r.lose) && below.every(r => r.lose && f(aiRows, r.k).fin <= e50a.fin), JSON.stringify(G.rows));
ok('③c 每一套都寫 ✅/⚠️/⛔ 跟 0050 比的結論', G.rows.filter(r => !['0050', '0052', '0056'].includes(r.k)).every(r => /[✅⚠️⛔].*0050/u.test(r.t)), JSON.stringify(G.rows));
ok('③d 表頭每一欄可排序(做法 / 近 4 年 / 16 年 / 中途最多賠 / 贏 0050)、再點反向', JSON.stringify(G.hdr) === '["n","a","l","mdd","beat"]' && G.s1 !== G.s2, JSON.stringify(G.hdr) + G.s1 + G.s2);
ok('③e ⛔ 中途最多賠那一欄在', /中途\s*最多賠/.test(G.txt));
ok('③f 點開一列:三行怎麼做(選股 / 賣 / 錢)+ 看證據', /選股/.test(G.det) && /賣/.test(G.det) && /錢/.test(G.det) && /看這一套的實測證據/.test(G.det), G.det);
ok('③g 三種人怎麼選:想賺最多 / 怕大跌 / 不想每天看盤(0050)', /想賺最多/.test(G.whoTxt) && /不想每天看盤/.test(G.whoTxt), G.whoTxt);

// ④ 名字
const names = G.names, emo = names.map(n => n.split(' ')[0]);
ok('④ 名字表沒有重複的名字、也沒有重複的 emoji', new Set(names).size === names.length && new Set(emo).size === emo.length, JSON.stringify(names));
ok('④b 最強那套叫「🔥 高檔飆股」(使用者選的),畫面上有', /🔥 高檔飆股/.test(G.txt));
ok('④c ⛔ 畫面(選哪一套 / 回測數字 / 逐年表)不再用「決策台現行 V…」「上一任」當名字', !/決策台現行\s*V|上一任/.test(G.txt + G.pf + G.yb), (G.txt + G.pf + G.yb).match(/.{0,20}(決策台現行\s*V|上一任).{0,20}/)?.[0]);
ok('④d 逐年成績單也改用名字表(🔥 / 🐢)', /🔥 高檔飆股/.test(G.yb) && /🐢 唐奇安長抱/.test(G.yb), G.yb.slice(0, 300));

// ⑤ 策略開關
ok('⑤ 🧬 模式:選哪一套 / 回測數字 / 逐年表都看不到 👑 / 領頭羊', !/👑|領頭羊/.test(G.txt + G.pf + G.yb), (G.txt + G.pf + G.yb).match(/.{0,40}(👑|領頭羊).{0,40}/)?.[0]);
const leadA = f(aiRows, 'lead');
ok('⑤b 👑 模式:答案換成 👑 領頭羊+停車 0050、金額 == 看板(決定性對照)', /👑 領頭羊\+停車 0050/.test(L.hero) && L.hero.includes(wan(leadA.fin)), L.hero);

// ⑥ 版面
ok('⑥ 一進來預設是 🏆 選哪一套', G.defSel === 'pick' && G.big[0] === '🏆 選哪一套*', JSON.stringify(G.big) + G.defSel);
ok('⑥b 三顆大頁籤;選哪一套沒有子頁籤、清單藏起來', G.big.length === 3 && G.subRows === 0 && G.listHidden, JSON.stringify(G.big) + G.subRows);
ok('⑥c 🔬 為什麼:子頁籤有 有用 / 沒用 / 坑 / 還沒測;切走時選哪一套清空', G.whySub === 1 && /有用/.test(G.whyBar) && /沒用/.test(G.whyBar) && /坑/.test(G.whyBar) && /還沒測/.test(G.whyBar) && G.pickClearedOnWhy, G.whyBar);
ok('⑥d 📊 原始數字:子頁籤有 回測數字 / 情境 / 機率 / 指標', /回測數字/.test(G.numBar) && /情境/.test(G.numBar) && /機率/.test(G.numBar) && /指標/.test(G.numBar), G.numBar);
ok('⑥e 390px 不橫捲、表格不超出外框', G.sx <= 2 && G.fit <= 2 && L.fit <= 2, `${G.sx} / ${G.fit} / ${L.fit}`);
ok('⑥f ⛔ 無 🔴🟢', !/[🔴🟢]/u.test(G.txt + L.txt));
ok('⑥g 無 pageerror', !e1.length && !e2.length, e1.concat(e2).join(' | '));

await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ test_pickboard 全過');
process.exit(fails.length ? 1 : 0);
