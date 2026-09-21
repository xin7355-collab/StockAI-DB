#!/usr/bin/env node
// 🎣 V77.4.1 釣魚分頁「三步驟化」(01 建池 → 02 拋竿 → 03 驗證)+ 👑 池子 + 一鍵複製 + 外部 AI 只問質化 + 漁獲籃三欄
//   使用者上傳一份外部「股王釣魚」介面問「依照附件的介面方式修改」。借它的**結構**,⛔ 不借它的框、橘色、評分欄。
//
// ⛔ 這支釘的「用意」(每一條都做過注入驗證,見 docs/DECISIONS.md V77.4.1):
//   ⑯ 三段 DOM 順序 + rodGo 不報錯      ⑰ 規則文字讀常數、讀不到就說讀不到、⛔ 不是 XQ 語法
//   ⑱ AI 提示詞只問質化(⛔ 不可要求評分 / 預測 / 隔日表態);沒拋竿要擋
//   ⑲ 漁獲籃補三欄(進池理由 / 隔日漲跌 / 📝 筆記),舊紀錄要誠實標;⛔ 不用 table
//   ⑳ 筆記寫回 + 打字中不重畫          ㉑ 追蹤表 TSV 8 欄、行數對、無 HTML
//   ㉒ 三張紀律卡讀常數(改 `_SIG_EDGE.close` 文字要跟著變)   ㉓ 「今天沒有魚」那張卡要看得見
//   ㉔ 👑 池子:徽章數字讀 `_KINGPOOL_EDGE`(改常數要跟著變)、名單真的是排名 ≤ top
//   ④c 四支新函式⛔ 不寫死數字(同 test_fishrod ④ 那組禁字)    ㉕ 無 pageerror
//
// ⚠️ launch 參數照抄 test_fishrod:`--allow-file-access-from-files` + `browser.newPage()`(⛔ 不可 newContext)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_MODULE || '/opt/node22/lib/node_modules/playwright');
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

let bad = 0;
const ok = (c, n, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${e ? ' — ' + e : ''}`); if (!c) bad++; };

for (const f of ['data/screener.json', 'data/playbook_edge.json']) {
  if (!existsSync(f)) { console.log(`❌ 沒有 ${f}(跑 bash scripts/fetch_testdata.sh)—— ⛔ 不跑假測試`); process.exit(1); }
}
const SCR = JSON.parse(readFileSync('data/screener.json', 'utf8'));
if (Object.keys(SCR.rows || {}).length < 1000) { console.log('❌ 空過守門:screener 太少'); process.exit(1); }

const SRC = readFileSync('pro.html', 'utf8');
const body = (head) => { const i = SRC.indexOf(head); return i < 0 ? '' : SRC.slice(i, SRC.indexOf('\n  },', i)); };
const noComment = t => t.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const pg = await b.newPage();
await pg.emulateMedia({ reducedMotion: 'no-preference' });
const errs = []; pg.on('pageerror', e => errs.push(String(e).slice(0, 200)));
await pg.goto(pathToFileURL(resolve('pro.html')).href);
await pg.waitForFunction(() => typeof PRO !== 'undefined' && !!PRO.renderRod && !!PRO._rodRuleText, null, { timeout: 30000 });

// ── ⑯ 三段順序 ──────────────────────────────────────────────
const T = await pg.evaluate(async () => {
  PRO.switchTab('rod'); try { await PRO._rodP; } catch (_) {}
  const q = id => document.getElementById(id);
  const ids = ['fishPoolPane', 'rodCastPane', 'fishBasketPane'];
  const inRod = ids.every(id => q(id) && q(id).closest('#tabRod'));
  const pos = ids.map(id => [...document.querySelectorAll('#tabRod > .panel')].indexOf(q(id)));
  const ordered = pos.every((p, i) => p >= 0 && (i === 0 || p > pos[i - 1]));
  let goErr = null; try { PRO.rodGo('basket'); PRO.rodGo('cast'); PRO.rodGo('pool'); PRO.rodGo('nope'); } catch (e) { goErr = String(e); }
  const steps = [...document.querySelectorAll('#rodSteps .lbtn')].map(e => e.textContent.trim());
  const castInCast = q('castBtn') && q('castBtn').closest('#rodCastPane'), rulesInBasket = q('rodRules') && q('rodRules').closest('#fishBasketPane');
  const pickInCast = q('fishPickPane') && q('fishPickPane').closest('#rodCastPane');
  return { inRod, ordered, pos, goErr, steps, castInCast: !!castInCast, rulesInBasket: !!rulesInBasket, pickInCast: !!pickInCast, hasD: !!PRO._fishD };
});
ok(T.hasD, '⓪ 魚池資料真的載進來了(🚧 空過守門)');
ok(T.inRod && T.ordered && T.goErr === null && T.steps.length === 3 && T.castInCast && T.rulesInBasket && T.pickInCast,
  '⑯ 三段 01 建池 → 02 拋竿 → 03 驗證 依序在 #tabRod;拋竿鈕在 02、紀律卡在 03、釣到那張卡在 02 底下展開;rodGo 不報錯',
  `pos=${T.pos} steps=${T.steps.join('/')} err=${T.goErr}`);

// ── ⑰ 規則文字 ──────────────────────────────────────────────
const R = await pg.evaluate(() => {
  const g = PRO._geneRule(), H = PRO._HQ_RULE, K = PRO._KINGPOOL_EDGE;
  const t = PRO._rodRuleText();
  const saved = PRO._geneRule; PRO._geneRule = () => null;
  const t0 = PRO._rodRuleText();
  PRO._geneRule = saved;
  return { g, t, t0, hasPos: !!g && t.includes('≥ ' + g.pos), hasAmp: !!g && t.includes('≥ ' + g.amp + '%'),
           hasVol: t.includes('≥ ' + H.vol + '%'), hasTop: t.includes('前 ' + K.top), hasE10: t.includes('+' + K.e10 + 'pp'),
           noHtml: !/<[a-z]/i.test(t), noXq: !/CROSS\(|MA\(|REF\(/.test(t), copyRet: typeof PRO._rodRuleCopy === 'function' };
});
ok(R.g && R.hasPos && R.hasAmp && R.hasVol && R.hasTop && R.hasE10 && R.noHtml && R.noXq,
  '⑰ 規則文字含 🧬 兩道門檻(讀 `_geneRule`)、拋竿的年化波動門檻(`_HQ_RULE`)、👑 的 top 與 e10;純文字、⛔ 不是 XQ 語法',
  `pos=${R.hasPos} amp=${R.hasAmp} vol=${R.hasVol} top=${R.hasTop} e10=${R.hasE10} html=${!R.noHtml}`);
// ⚠️ `_HQ_RULE.pos` 跟 🧬 的 pos 剛好同值(75)→ 要釘的是「🧬 那一行」不見了,⛔ 不可只查數字有沒有出現(拋竿那行合法地帶著同一個數字)
ok(R.g && /讀不到/.test(R.t0) && !R.t0.includes('一年位階 ≥ ' + R.g.pos) && R.t.includes('一年位階 ≥ ' + R.g.pos),
  '⑰b `_geneRule` 讀不到 → 規則文字要說「讀不到」,⛔ 不可兜一個預設數字出來');

// ── ⑱ AI 提示詞 ─────────────────────────────────────────────
const A = await pg.evaluate(() => {
  const saved = PRO._cast; PRO._cast = null;
  const p0 = PRO._rodAiPrompt(); const r0 = PRO._rodAskAi();
  const toast0 = (document.getElementById('toast') || {}).textContent || '';
  PRO._cast = { picked: [{ sym: '2330', warn: [] }, { sym: '2317', warn: ['disp'] }] };
  const p1 = PRO._rodAiPrompt();
  PRO._cast = saved;
  return { p0, r0, toast0, p1 };
});
ok(A.p0 === null && A.r0 === null && /拋竿/.test(A.toast0), '⑱ 沒拋竿 → 提示詞 null、按鈕只 toast「先按 🎣 拋竿」', A.toast0.slice(0, 60));
ok(!!A.p1 && /不要給評分/.test(A.p1) && /不要預測漲跌/.test(A.p1) && /不要判斷明天會不會表態/.test(A.p1)
   && !/請給.*評分|爆發評分|評分[:：]|1~10|是否隔日表態/.test(A.p1) && /來源/.test(A.p1) && /日期/.test(A.p1) && /2330/.test(A.p1) && /2317/.test(A.p1),
  '⑱b 提示詞只問質化:明寫「不要評分 / 不要預測 / 不要判斷表態」、要附來源與日期、名單齊全(⛔ 不可要求 1~10 爆發評分)', A.p1.slice(0, 120));

// ── ⑲⑳㉑ 漁獲籃三欄 / 筆記 / TSV ────────────────────────────
const B = await pg.evaluate(async () => {
  const bak = localStorage.getItem('proWar_catch');
  const D = PRO._fishD, s1 = D.rows[0].sym, s2 = D.rows[1].sym;
  localStorage.setItem('proWar_catch', JSON.stringify([
    { sym: s1, nm: 'A', px: D.rows[0].c, d: D.date, why: { src: 'cast', k: '測試招', warn: ['disp'] }, note: 'hi' },
    { sym: s2, nm: 'B', px: D.rows[1].c, d: D.date }]));
  PRO._stl = {}; PRO._stlSig = null;
  PRO._fishBasketRender();
  await new Promise(r => setTimeout(r, 1500));
  PRO._fishBasketRender();
  const el = document.getElementById('fishBasket');
  const rows = [...el.querySelectorAll('.bkrow')];
  const txt = el.innerText;
  const tableInRow = rows.some(r => r.querySelector('table'));
  const notes = [...el.querySelectorAll('.bknote')];
  const why1 = rows[0] && rows[0].querySelector('.bkwhy') ? rows[0].querySelector('.bkwhy').innerText : '';
  const why2 = rows[1] && rows[1].querySelector('.bkwhy') ? rows[1].querySelector('.bkwhy').innerText : '';
  // ⑳ 筆記寫回 + focus 守門
  const wrote = PRO._catchNote(s1, D.date, '新筆記 xyz');
  const saved = JSON.parse(localStorage.getItem('proWar_catch'))[0].note;
  notes[0].focus(); const before = document.activeElement;
  PRO._fishBasketRender();
  const sameEl = document.activeElement === before && document.body.contains(before);
  before.blur();
  // ㉑ TSV
  const tsv = PRO._rodTrackTsv(), lines = tsv.split('\n');
  const cols = lines.map(l => l.split('\t').length);
  const copyEmpty = (() => { localStorage.setItem('proWar_catch', '[]'); const r = PRO._rodTrackCopy(); return r; })();
  if (bak == null) localStorage.removeItem('proWar_catch'); else localStorage.setItem('proWar_catch', bak);
  PRO._stl = {}; PRO._stlSig = null; PRO._fishBasketRender();
  return { n: rows.length, txt: txt.slice(0, 400), tableInRow, notes: notes.length, why1, why2, hasCopyBtn: /複製追蹤表/.test(txt),
           wrote, saved, sameEl, lines: lines.length, cols, noHtml: !/<[a-z]/i.test(tsv), head: lines[0], copyEmpty };
});
ok(B.n === 2 && !B.tableInRow && B.notes === 2 && /🎣 拋竿・測試招/.test(B.why1) && /⛔處置中/.test(B.why1) && /舊紀錄/.test(B.why2)
   && /隔日/.test(B.why1) && B.hasCopyBtn,
  '⑲ 漁獲籃每列多「進池理由 / 隔日漲跌 / 📝 筆記」,一行一張卡⛔ 不用 table;舊紀錄誠實標「舊紀錄」;有 📋 複製追蹤表',
  `rows=${B.n} notes=${B.notes} why1=${B.why1.slice(0, 40)} why2=${B.why2.slice(0, 30)}`);
ok(B.wrote && B.saved === '新筆記 xyz' && B.sameEl, '⑳ 筆記寫回同一筆;正在打字時重畫要延後(⛔ 不可把游標踢掉)', `saved=${B.saved} sameEl=${B.sameEl}`);
ok(B.lines === 3 && B.cols.every(c => c === 8) && B.noHtml && /進池理由/.test(B.head) && /筆記/.test(B.head) && B.copyEmpty === false,
  '㉑ 追蹤表 TSV:8 欄、行數 = 筆數 + 表頭、無 HTML;籃子空的時候只 toast 不複製', `lines=${B.lines} cols=${B.cols}`);

// ── ㉒ 三張紀律卡 ────────────────────────────────────────────
const C = await pg.evaluate(() => {
  const D = PRO._fishD;
  const h = PRO._rodRulesHtml(D);
  const saved = PRO._SIG_EDGE.close; PRO._SIG_EDGE.close = 1234567;
  const h2 = PRO._rodRulesHtml(D); PRO._SIG_EDGE.close = saved;
  const el = document.getElementById('rodRules');
  return { h, changed: h !== h2 && /123\.5 萬/.test(h2), hasExit: h.includes(PRO._exitRuleName()), hasPicks: new RegExp('最多 ' + PRO._RECO_PICKS + ' 檔').test(h),
           hasLot: h.includes((PRO._CAP_RULE.lot / 10000) + ' 萬'), has13: /13:00/.test(h), n: (h.match(/class="rodrule"/g) || []).length,
           onPage: !!el && el.innerHTML.length > 500, ma5: /ma5up/.test(h) };
});
ok(C.n === 3 && C.hasExit && C.hasPicks && C.hasLot && C.has13 && C.onPage && C.ma5,
  '㉒ 03 段三張紀律卡:進場(尾盤 13:00)/ 出場(讀 `_exitRuleName`)/ 資金(`_RECO_PICKS`、`_CAP_RULE.lot`);外部那條「5 日線」要對到本站 ma5up 的實測',
  `n=${C.n} exit=${C.hasExit} picks=${C.hasPicks} lot=${C.hasLot}`);
ok(C.changed, '㉒b ⭐ 決定性:改 `_SIG_EDGE.close` 紀律卡的數字要跟著變(⛔ 不寫死)');

// ── ㉓ 沒有魚那張卡 ─────────────────────────────────────────
const N = await pg.evaluate(() => {
  PRO._fishShow('pool');
  PRO._castNone({ srcNone: 'empty', thin: 0, disposed: [], avoided: [] });
  const pick = document.getElementById('fishPickPane');
  return { vis: !pick.classList.contains('hidden'), txt: document.getElementById('fishCard').innerText.slice(0, 80) };
});
ok(N.vis && /今天沒有魚上鉤/.test(N.txt), '㉓ 「今天沒有魚上鉤」那張卡要真的看得見(🚨 舊版寫進 hidden 的 pane)', N.txt.slice(0, 40));

// ── ㉔ 👑 池子 ──────────────────────────────────────────────
const K = await pg.evaluate(async () => {
  const K = PRO._KINGPOOL_EDGE, D = PRO._fishD;
  const has = PRO.FISH_POOLS.some(p => p.k === 'king');
  const st = PRO._rodStatus().king;
  const saved = K.e10; K.e10 = 9.87; const st2 = PRO._rodStatus().king; K.e10 = saved;
  const pk = PRO._fishPoolK; PRO._fishPoolK = 'king';
  const rows = PRO._fishPoolRows(D);
  const ranked = rows.length > 0 && rows.length <= K.top && rows.every(r => r.rankAmt <= K.top) && !rows.some(r => r.etf === 1);
  PRO.fishBack(true); await (PRO._rodP = PRO.renderRod());
  const chip = [...document.querySelectorAll('#fishPool .fishpool')].find(e => /👑/.test(e.textContent));
  PRO._fishPoolK = pk; await (PRO._rodP = PRO.renderRod());
  return { has, why: st ? st.why : '', hasE10: !!st && st.why.includes('+' + K.e10 + 'pp'), hasTop: !!st && st.why.includes('前 ' + K.top),
           hasAbs: !!st && st.why.includes(K.abs + '%'), changed: !!st2 && st2.why.includes('+9.87pp'), n: rows.length, ranked,
           chipTxt: chip ? chip.textContent : '', chipTop: !!chip && chip.textContent.includes('前 ' + K.top), notCast: !/進拋竿/.test(st ? st.why.replace(/⛔ 不進拋竿/, '') : '') };
});
ok(K.has && K.hasE10 && K.hasTop && K.hasAbs && K.chipTop, '㉔ 👑 池子存在;徽章讀 `_KINGPOOL_EDGE`(e10 / top / 絕對超額都要印出來,⛔ 不可只講好的那半)', K.why.slice(0, 80));
ok(K.changed, '㉔b ⭐ 決定性:改 `_KINGPOOL_EDGE.e10` 徽章文字要跟著變');
ok(K.ranked && K.n >= 10, '㉔c 👑 名單真的是「成交額排名 ≤ top」(讀 `rankAmt`,不含 ETF)', `n=${K.n}`);
ok(/不換預設|不進拋竿/.test(K.why), '㉔d 👑 要明寫「不換預設 / 不進拋竿」(它只是排序濾網)');

// ── ㉕ 💎 池子(V77.4.4 價值規格裡唯一站得住的:PB×ROE 交叉)────────────────
const VV = await pg.evaluate(async () => {
  const V = PRO._VALUE_EDGE, D = PRO._fishD;
  const has = PRO.FISH_POOLS.some(p => p.k === 'val');
  const st = PRO._rodStatus().val;
  const saved = V.eH; V.eH = 9.87; const st2 = PRO._rodStatus().val; V.eH = saved;
  const pk = PRO._fishPoolK; PRO._fishPoolK = 'val';
  const rows = PRO._fishPoolRows(D);
  const okRows = rows.every(r => r.pb > 0 && r.pb <= V.pb && r.roe4 > V.roe);
  const nRoe = D.rows.filter(r => r.roe4 != null).length, nCheap = D.rows.filter(r => r.pb != null && r.pb > 0 && r.pb <= V.pb).length;
  const nRoeRich = D.rows.filter(r => r.pb > V.pb && r.roe4 != null).length;   // ⛔ 不便宜的那幾檔不該去讀切片
  PRO._fishPoolK = pk;
  return { has, lv: st ? st.lv : '', why: st ? st.why : '', hasE60: !!st && st.why.includes('+' + V.eH + 'pp'), hasAbs: !!st && st.why.includes('+' + V.abs + '%'),
           hasDedup: !!st && st.why.includes('5/6'), changed: !!st2 && st2.why.includes('+9.87pp'), n: rows.length, okRows, nRoe, nCheap, nRoeRich };
});
ok(VV.has && VV.hasE60 && VV.hasAbs && VV.hasDedup, '㉕ 💎 池子存在;徽章讀 `_VALUE_EDGE`(60 日邊際 / 對加權超額 / 去重敏感度 5/6 都要印,⛔ 不可只講好的那半)', VV.why.slice(0, 80));
ok(VV.changed, '㉕b ⭐ 決定性:改 `_VALUE_EDGE.eH` 徽章文字要跟著變');
ok(VV.okRows && VV.n >= 1 && VV.nRoe >= 20 && VV.nRoe <= VV.nCheap && VV.nRoeRich === 0, `㉕c 💎 名單真的是「PB ≤ 門檻 ∧ 近 4 季 ROE > 門檻」,而且切片只讀便宜那幾檔(讀了 ${VV.nRoe} / 便宜 ${VV.nCheap} 檔;不便宜卻讀了 ${VV.nRoeRich})`, `n=${VV.n}`);
ok(/不進拋竿/.test(VV.why) && /不換預設/.test(VV.why) && VV.lv !== '✅', '㉕d 💎 要明寫「不換預設 / 不進拋竿」,徽章⛔ 不可是 ✅(去重一改就 5/6)', VV.lv);

// ── ④c 靜態:新函式不寫死 ────────────────────────────────────
const four = ['  _rodRulesHtml(D) {', '  _rodRuleText() {', '  _rodAiPrompt() {', '  _rodTrackTsv() {'].map(h => noComment(body(h))).join('\n');
const stale = ['75', '3.2', '60', '589', '264', '0.98', '41.4'].filter(t => new RegExp('(?<![0-9.])' + t.replace('.', '\\.') + '(?![0-9])').test(four));
ok(four.length > 1500 && stale.length === 0 && /_KINGPOOL_EDGE/.test(four) && /_geneRule\(\)/.test(four) && /_CAP_RULE/.test(four),
  '④c 四支新函式⛔ 不寫死門檻與成績(同 test_fishrod ④ 那組禁字 + 👑 的數字)', stale.length ? '殘留:' + stale.join(',') : `${four.length} 字`);
ok(!/楊俊益/.test(SRC), '④d ⛔ 人名不進任何文案(使用者明示)');

ok(errs.length === 0, '㉕ ⛔ 無 pageerror(防陷阱 #42:template literal 裡的反引號)', errs.join(' | '));
await b.close();
console.log(bad ? `\n❌ ${bad} 條失敗` : '\n✅ ROD3_PASS(全部通過)');
process.exit(bad ? 1 : 0);
