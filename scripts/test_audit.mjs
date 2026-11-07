// 🩺 V82.0.3 產業作戰室「App 體檢」分頁 + 匯出給別的 AI 複查
//   使用者 11/07:「把核心重點、各選股邏輯、缺陷、驗證過的資訊做一個分頁,要能匯出提示詞,太多就匯出檔案,讓別的 AI 複查」
//   + 「賺最多 vs 賠最少」選「折衷:先讓我看兩邊數字」(⛔ 這一頁不換任何預設)。
//   ⛔ 這支釘的用意:
//     ① 進得去、只顯示這一頁、🔬 研究那一組亮、排在「選哪一套」後面;?tab=audit 深連結可用
//     ② 💰 A 表 == _PROFIT_BOARD(決定性對照:改看板一格,畫面與匯出一起變)
//     ③ _RISK_MENU 每個數字都在它 src 那條 LAB 原文裡(決定性對照:改 LAB 一個數字 → 這條要抓得到)
//     ④ 匯出:11 節都在、⛔ HTML 標籤、精簡 < 完整、完整附整份實測總表、複製失敗一定 toast、下載檔名 .md;實測總表的下載也走同一支 _dlText
//     ⑤ 這一波:_raceLoad 換成假的 → 數字照出來、起算日 = 這一段高點那天(太早就從名單快照第一天);讀不到 / 算不出來要明講(⛔ 空白);
//        ⛔ 動成績單自己的 _race
//     ⑥ _AUDIT_FACTS 跟 index.html / auto_trade.py / 本檔常數逐項比對(改 App 預設 / 門檻要一起改這裡;V82.0.4 加收工對帳時間 / 虧損安全鎖預設)
//     ⑦ 390 / 844 寬不橫捲、表格在框裡自己捲;⛔ 🔴🟢(只准講漲跌);有勝率就要有「勝率低不代表不賺」
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');
const IDX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const AT = fs.readFileSync(path.join(ROOT, 'auto_trade.py'), 'utf8');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 400)}`); if (!c) fails.push(n); };

// ── ⑥ 靜態:從來源檔讀「現在的預設」(⛔ 在這裡寫死第二份)
const setBlk = (IDX.match(/settings:\s*\{\s*fugleToken1:[^}]*\}/) || [''])[0];
const sv = k => { const m = setBlk.match(new RegExp(`\\b${k}:\\s*('([^']*)'|true|false|\\d+)`)); return m ? (m[2] !== undefined ? m[2] : m[1] === 'true' ? true : m[1] === 'false' ? false : +m[1]) : undefined; };
const brk = IDX.match(/_BRK_LIM:\s*\{\s*day:\s*(\d+),\s*week:\s*(\d+),\s*month:\s*(\d+)\s*\}/);
const trl = IDX.match(/_TOTAL_RISK_LIM:\s*(\d+)/);
const catsBlk = (IDX.match(/_ALERT_CATS:\s*\[([\s\S]*?)\n    \],/) || ['', ''])[1];
const catN = (catsBlk.match(/\{\s*k:\s*'/g) || []).length, lockN = (catsBlk.match(/lock:\s*1/g) || []).length;
const lots = (AT.match(/MAX_LOTS_PER_TRADE\s*=\s*int\(os\.getenv\('MAX_LOTS_PER_TRADE',\s*'(\d+)'\)\)/) || [])[1];
const amt = (AT.match(/MAX_AMT_PER_TRADE\s*=\s*int\(os\.getenv\('MAX_AMT_PER_TRADE',\s*'(\d+)'\)\)/) || [])[1];
const egene = IDX.match(/gene:\s*\{\s*pos:\s*(\d+),\s*amp:\s*([\d.]+)\s*\}/);
const recon = AT.match(/RECON_FROM\s*=\s*(\d+)\s*\*\s*60\s*\+\s*(\d+)/);
const llock = (AT.match(/LOSS_LOCK_PCT\s*=\s*float\(os\.getenv\('LOSS_LOCK_PCT'\)\s*or\s*([\d.]+)\)/) || [])[1];
const expect = {
  strategy: sv('strategy'), hotRule: sv('hotRule'), bearGate: sv('bearGate'), alertStrict: sv('alertStrict'), watchlistAlert: sv('watchlistAlert'),
  // 沒寫在預設物件裡 = 關(index 那邊一律 `=== true` 才算開)
  bearCash: sv('bearCash') === true && /s\.bearCash === true/.test(IDX) ? true : false,
  quietOn: sv('quietOn') === true ? true : false,
  leadBear: /_leadBearOn\(\)\s*\{\s*return true;\s*\}/.test(IDX) ? true : undefined,
  leadBooks: /_leadBooks\(\)\s*\{\s*const s = this\.settings \|\| \{\};\s*return \(s\.leadBooks === 2[^;]*\) \? 2 : 1;\s*\}/.test(IDX) ? 1 : undefined,
  leadTiming: /_leadTiming\(\)\s*\{\s*return \(this\.settings && this\.settings\.leadTiming === 'open'\) \? 'open' : 'split';/.test(IDX) ? 'split' : undefined,
  exitRule: (IDX.match(/_exitRuleKey\(\)\s*\{\s*const k = String\(\(this\.settings && this\.settings\.exitRule\) \|\| '(\w+)'\)/) || [])[1],
  lot: +((SRC.match(/_CAP_RULE:\s*\{\s*lot:\s*(\d+)/) || [])[1]),
};
ok('⑥0 讀得到 index.html / auto_trade.py 的預設(⛔ 空過)', !!setBlk && brk && trl && catN > 5 && lots && amt && egene && recon && llock !== undefined && Object.values(expect).every(v => v !== undefined && !Number.isNaN(v)),
  JSON.stringify({ setBlk: !!setBlk, brk: !!brk, trl: !!trl, catN, lots, amt, egene: !!egene, expect }));

let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const errs = [];
const open = async (w, h, q = '') => {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  page.on('pageerror', e => errs.push(`${w}x${h}${q}: ${e.message}`));
  await page.goto('file://' + path.join(ROOT, 'pro.html') + q, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof PRO !== 'undefined' && PRO._tab, null, { timeout: 30000 });
  await page.waitForTimeout(500);
  return page;
};
// 假的「這一段大跌」+ 假的 100 萬起跑(⛔ 讀真資料 —— 測的是接線,不是那天的行情)
const FIX = () => {
  window.__raceCalls = [];
  PRO._cache['data/crash_events.json'] = { asof: '2026-11-06', legs: [{ s: '2026-11-03', peak: { d: '2026-10-06', c: 49822.55 }, low: { d: '2026-11-06', c: 39701.64 }, depth: -20.3, open: 1,
    ev: [{ k: 'leg10', d: '2026-11-03', c: 43307.54, dd: -13.1 }, { k: 'bear20', d: '2026-11-06', c: 39701.64, dd: -20.3 }] }] };
  PRO._raceLoad = async S => { window.__raceCalls.push(S); return { S, days: 21, last: '2026-11-06', rows: [
    { k: 'lead', name: '👑 假領頭羊', v: 681234, pct: -31.88, dd: 31.7, vs50: -110615, buy: 9, sold: 4, hold: 5, cur: true },
    { k: '0050', name: '📏 假 0050', v: 791849, pct: -20.82, dd: 20.6, vs50: null }] }; };
  PRO._auditReset();
};

// ① ~ ⑤(手機直立)
{
  const page = await open(390, 844);
  const R = await page.evaluate(async FIXs => {
    const o = {};
    eval('(' + FIXs + ')')();
    const vis = () => PRO.TABS.filter(([k, C]) => !document.getElementById('tab' + C).classList.contains('hidden')).map(([k]) => k);
    PRO._race = 'SENTINEL'; PRO._raceSig = 'SIG';   // 成績單自己的那份(⛔ 被這一頁動到)
    const startBefore = PRO._recoStart();
    PRO.navGo('audit');
    await new Promise(r => setTimeout(r, 400));
    await PRO.renderAudit();
    o.vis = vis(); o.cur = PRO._navCur();
    o.gOn = [...document.querySelectorAll('#navTop [data-g]')].filter(b => b.classList.contains('on')).map(b => b.dataset.g);
    o.sOn = [...document.querySelectorAll('#navSub [data-sub]')].filter(b => b.classList.contains('on')).map(b => b.dataset.sub);
    o.res = (PRO.NAV.find(g => g[0] === 'res') || [])[2];
    o.btn = (b => b ? [b.dataset.g, b.dataset.sub] : null)(document.getElementById('tabBtnAudit'));
    const T = s => (document.querySelector(`[data-audsec="${s}"]`) || {}).innerText || '';
    o.secs = [...document.querySelectorAll('[data-audsec]')].map(x => x.dataset.audsec);
    o.money = T('money'); o.risk = T('risk'); o.swan = T('swan'); o.alert = T('alert'); o.gaps = T('gaps');
    o.raceUntouched = PRO._race === 'SENTINEL' && PRO._raceSig === 'SIG' && PRO._recoStart() === startBefore;
    o.calls = window.__raceCalls.slice();
    // ② A 表 == 看板
    const B = PRO._PROFIT_BOARD.wins, rowOf = (w, k) => B[w].rows.find(r => r.k === k);
    const tbl = document.querySelector('[data-audsec="money"] table');
    o.aRows = tbl ? [...tbl.querySelectorAll('tbody tr')].map(tr => [...tr.cells].map(c => c.innerText.trim())) : [];
    o.aExp = PRO._AUDIT_STRATS.filter(k => rowOf('ai', k) || rowOf('long', k)).map(k => {
      const a = rowOf('ai', k), l = rowOf('long', k);
      return [PRO._stratName(k), PRO._auditWan(a.fin), PRO._auditDd(a.mdd), PRO._auditWan(a.worst), PRO._auditWan(l.fin), PRO._auditDd(l.mdd), PRO._auditWan(l.worst)];
    });
    // ② 決定性對照:看板改一格 → 畫面 + 匯出一起變
    const lr = rowOf('ai', 'lead'), keep = lr.fin;
    lr.fin = 12345678; await PRO.renderAudit();
    o.ctlScreen = /1,235 萬/.test(T('money')); o.ctlExport = PRO.auditText().includes('1,235 萬');
    lr.fin = keep; await PRO.renderAudit();
    o.ctlBack = !T('money').includes('1,235 萬');
    // ③ _RISK_MENU 每個數字都在 src 那條 LAB 原文裡
    const numIn = (txt, s) => new RegExp(`(?<![\\d,.])${s.replace(/[.]/g, '\\.')}(?![\\d])`).test(txt);
    const menuMiss = (labOf) => {
      const miss = [];
      for (const key of ['lead', 'park']) {
        const M = PRO._RISK_MENU[key], it = labOf(M.src);
        if (!it) { miss.push(key + ':找不到 ' + M.src); continue; }
        const txt = PRO._labPlain([it.t, it.n, it.d, (it.pl || []).join(' '), it.col ? JSON.stringify(it.col) : ''].join(' '));
        for (const r of M.rows) {
          const ns = [r.a[0].toLocaleString('en-US'), r.a[1].toFixed(1), r.l[0].toLocaleString('en-US'), r.l[1].toFixed(1), ...((r.note || '').match(/\d[\d,]*(?:\.\d+)?/g) || [])];
          for (const s of ns) if (!numIn(txt, s)) miss.push(`${key}:${r.n}:${s}`);
        }
      }
      return miss;
    };
    o.menuMiss = menuMiss(k => (PRO._labByK(k) || {}).it);
    // 決定性對照:LAB 原文裡「兩本帳錯開 4 天」那個數字改掉 → 一定要抓得到
    o.menuCtl = menuMiss(k => { const it = (PRO._labByK(k) || {}).it; if (!it || k !== 'lead-drawdown') return it; return { ...it, n: it.n.replace('1,174・−42.3%', '1,175・−42.3%'), pl: (it.pl || []).map(x => String(x).replace('1,174 萬', '1,175 萬')), col: null, d: it.d, t: it.t }; });
    o.menuSrc = ['lead', 'park'].map(k => PRO._RISK_MENU[k].src);
    // ④ 匯出
    const brief = PRO.auditText({ full: false }), full = PRO.auditText({ full: true });
    o.briefLen = brief.length; o.fullLen = full.length;
    o.h2 = (brief.match(/^## \d+\. .+$/gm) || []).length;
    o.titlesIn = PRO._auditModel().secs.every((s, i) => brief.includes(`## ${i + 1}. ${s.t}`));
    const TAG = /<\/?(?:b|br|div|span|p|li|ul|ol|code|a|i|small|sub|sup|table|thead|tbody|tr|td|th|details|summary|strong|em|button|input|select|option|svg|img)\b[^<>]{0,200}>/gi;
    o.tagB = (brief.match(TAG) || []).slice(0, 3);
    o.tagF = (full.match(TAG) || []).slice(0, 3);
    // 決定性對照:這個偵測器真的抓得到標籤(⛔ 永遠 0 = 假綠燈)
    o.tagCtl = ('x <b>粗</b> <span class="a">y</span>'.match(TAG) || []).length;
    o.fullHasLab = full.includes(PRO.labExportText({ scope: 'all', full: true, ask: false }));
    o.briefNoLab = !brief.includes('# 附錄:整份實測總表');
    o.short = PRO.auditShortPrompt();
    let toastMsg = '', dl = null;
    const t0 = PRO.toast, c0 = PRO._copySync, d0 = PRO._dlText;
    PRO.toast = m => { toastMsg = String(m); };
    PRO._copySync = () => false;
    o.copyRet = PRO.auditDo('copy'); o.copyToast = toastMsg;
    PRO._copySync = () => true; toastMsg = '';
    o.copyOk = PRO.auditDo('copy'); o.copyOkToast = toastMsg;
    PRO._dlText = (t, n) => { dl = { n, len: t.length }; return true; };
    PRO.auditDo('file'); o.dl = dl; dl = null;
    PRO.labExportDo('file'); o.labDl = dl;
    PRO.toast = t0; PRO._copySync = c0; PRO._dlText = d0;
    // ⑤ 這一波:起算日太早 → 從名單快照第一天;讀不到 / 算不出來要明講
    PRO._cache['data/crash_events.json'] = { asof: '2026-11-06', legs: [{ peak: { d: '2026-08-03', c: 40000 }, low: { d: '2026-08-20', c: 36000 }, depth: -10, open: 0, ev: [] }] };
    window.__raceCalls = []; PRO._auditReset(); await PRO.renderAudit();
    o.earlyCall = window.__raceCalls[0]; o.earlyTxt = T('money');
    const r0 = PRO._raceLoad;
    PRO._raceLoad = async () => ({ err: '假的錯誤', rows: [] });
    PRO._auditReset(); await PRO.renderAudit(); o.raceErrTxt = T('money');
    PRO._raceLoad = r0;
    const f0 = PRO.fetchJson; PRO._cache['data/crash_events.json'] = undefined;
    PRO.fetchJson = async () => null; window.__raceCalls = [];
    PRO._auditReset(); await PRO.renderAudit(); o.legErrTxt = T('money'); o.legErrSwan = T('swan'); o.legErrCalls = window.__raceCalls.length;
    PRO.fetchJson = f0;
    // ⑦ 燈號:這一頁自己寫的字 ⛔ 🔴🟢(「🚦 🔴🟢 只代表漲跌方向」那一句是在講規則本身,除外)
    const F = PRO._AUDIT_FACTS, own = JSON.stringify({ ...F, ui: F.ui.filter(x => !x.startsWith('🚦')) }) + JSON.stringify(PRO._RISK_MENU);
    o.redGreen = (own.match(/🔴|🟢/g) || []).length;
    o.facts = F;
    return o;
  }, FIX.toString());
  ok('① 研究那一組有 audit、排在「選哪一套」後面;子頁鈕在', JSON.stringify(R.res) === '["pick","audit","qlab","col","lab","log"]' && JSON.stringify(R.btn) === '["res","audit"]', JSON.stringify([R.res, R.btn]));
  ok('① 進得去、只顯示這一頁、研究亮、子頁亮', JSON.stringify(R.vis) === '["audit"]' && R.cur === 'audit' && JSON.stringify(R.gOn) === '["res"]' && JSON.stringify(R.sOn) === '["audit"]', JSON.stringify([R.vis, R.cur, R.gOn, R.sOn]));
  ok('① 11 節都畫出來(順序固定)', JSON.stringify(R.secs) === '["about","money","rules","ok","trap","risk","swan","ui","alert","gaps","ask"]', JSON.stringify(R.secs));
  ok('② 💰 A 表每一列(名字 / 100 萬→ / 最多賠 / 最差那條 × 兩段)== _PROFIT_BOARD', R.aRows.length === R.aExp.length && R.aExp.every((e, i) => e.every((c, j) => R.aRows[i][j] === c)),
    JSON.stringify({ got: R.aRows.slice(0, 2), exp: R.aExp.slice(0, 2) }));
  ok('② 決定性對照:看板改一格 → 畫面與匯出一起變,改回來就回來', R.ctlScreen && R.ctlExport && R.ctlBack, JSON.stringify([R.ctlScreen, R.ctlExport, R.ctlBack]));
  ok('② 有勝率就要寫「勝率低不代表不賺」', R.money.includes('勝率低不代表不賺'), R.money.slice(0, 200));
  ok('③ 少賠選項的來源是 lead-drawdown / bear-season(兩條都找得到)', JSON.stringify(R.menuSrc) === '["lead-drawdown","bear-season"]' && !R.menuMiss.some(x => /找不到/.test(x)), JSON.stringify(R.menuMiss));
  ok('③ _RISK_MENU 每個數字都在它那條 LAB 原文裡', R.menuMiss.length === 0, JSON.stringify(R.menuMiss));
  ok('③ 決定性對照:LAB 那個數字改掉 → 抓得到', R.menuCtl.some(x => /1,174/.test(x)), JSON.stringify(R.menuCtl));
  ok('③ 兩張表單位不同要明講、⛔ 沒有兩全', /單位跟上一張不一樣/.test(R.money) && /沒有一種兩段都「少賠又不少賺」/.test(R.money), R.money.slice(0, 300));
  ok('④ 匯出 11 節標題都在(## 1. ~ ## 11.)', R.h2 === 11 && R.titlesIn, JSON.stringify([R.h2, R.titlesIn]));
  ok('④ 匯出 ⛔ HTML 標籤(精簡 + 完整;偵測器自己抓得到標籤)', R.tagCtl === 4 && R.tagB.length === 0 && R.tagF.length === 0, JSON.stringify([R.tagCtl, R.tagB, R.tagF]));
  ok('④ 精簡 < 完整;完整附整份實測總表、精簡不附', R.briefLen > 3000 && R.briefLen < R.fullLen && R.fullHasLab && R.briefNoLab, JSON.stringify([R.briefLen, R.fullLen, R.fullHasLab, R.briefNoLab]));
  ok('④ 複製失敗一定 toast(⛔ 靜默)、成功也講幾個字', R.copyRet === false && /不給複製/.test(R.copyToast) && R.copyOk === true && /已複製 [\d,]+ 字/.test(R.copyOkToast), JSON.stringify([R.copyRet, R.copyToast, R.copyOk, R.copyOkToast]));
  ok('④ 下載 = 完整版、檔名 App體檢_日期.md;實測總表的下載也走同一支 _dlText', R.dl && /^App體檢_\d{4}-\d{2}-\d{2}\.md$/.test(R.dl.n) && R.dl.len === R.fullLen && R.labDl && /^實測總表_.+\.md$/.test(R.labDl.n),
    JSON.stringify([R.dl, R.labDl]));
  ok('④ 附檔用的短提示:指到第 11 節、⛔ 推薦個股 / 編數字、夠短', /第 11 節/.test(R.short) && /不推薦個股/.test(R.short) && /不要自己編數字/.test(R.short) && R.short.length < 1000, R.short);
  ok('⑤ 這一波:起算日 = 這一段高點那天,數字照假的 _raceLoad 出來', R.calls[0] === '2026-10-06' && /68 萬/.test(R.money) && /−31\.9%/.test(R.money) && /−11 萬/.test(R.money) && /−20\.3%/.test(R.money),
    JSON.stringify([R.calls, R.money.slice(R.money.indexOf('C.'), R.money.indexOf('C.') + 300)]));
  ok('⑤ ⛔ 動到成績單自己的 _race / 起算日', R.raceUntouched);
  ok('⑤ 高點比名單快照第一天還早 → 從快照第一天算、而且寫出來', R.earlyCall === '2026-09-12' && /名單快照從 2026-09-12 起才有/.test(R.earlyTxt), JSON.stringify([R.earlyCall]));
  ok('⑤ 算不出來 → 寫原因、⛔ 不是 0 元', /算不出來\(假的錯誤\)/.test(R.raceErrTxt) && /不是 0 元/.test(R.raceErrTxt), R.raceErrTxt.slice(-300));
  ok('⑤ 這一段大跌讀不到 → 寫讀不到、⛔ 空白、⛔ 硬算', /讀不到這一段大跌的資料/.test(R.legErrTxt) && /不是沒有跌/.test(R.legErrTxt) && /讀不到/.test(R.legErrSwan) && R.legErrCalls === 0,
    JSON.stringify([R.legErrCalls, R.legErrSwan.slice(0, 200)]));
  // ⑥ 跟來源檔逐項比
  const dv = Object.fromEntries((R.facts.defaults || []).map(d => [d.key, d.val]));
  const keysOk = JSON.stringify(Object.keys(expect).sort()) === JSON.stringify(Object.keys(dv).sort());
  ok('⑥ _AUDIT_FACTS.defaults 每一項 == index.html / pro 常數的預設', keysOk && Object.entries(expect).every(([k, v]) => dv[k] === v), JSON.stringify({ expect, dv }));
  const allTxt = JSON.stringify(R.facts);
  ok('⑥ 帳戶熔斷 / 總風險門檻 == index.html', allTxt.includes(`今天虧到帳戶 ${brk[1]}%、本週 ${brk[2]}%、本月 ${brk[3]}%`) && allTxt.includes(`超過帳戶 ${trl[1]}%`), JSON.stringify([brk && brk.slice(1), trl && trl[1]]));
  ok('⑥ 通知分幾類 / 幾類不能關 == index.html _ALERT_CATS', allTxt.includes(`分 ${catN} 類,其中 ${lockN} 類不能關`), JSON.stringify([catN, lockN]));
  ok('⑥ 自動下單每筆上限 == auto_trade.py 預設', allTxt.includes(`每筆最多 ${lots} 張或 ${+amt / 1e4} 萬元`) && allTxt.includes(`每筆預設最多 ${lots} 張或 ${+amt / 1e4} 萬元`), JSON.stringify([lots, amt]));
  ok('⑥ 🧾 自動下單收工對帳時間 / 虧損安全鎖預設 == auto_trade.py(V82.0.4)', allTxt.includes(`收工 ${recon[1]}:${String(recon[2]).padStart(2, '0')}`)
    && (+llock === 0 ? allTxt.includes('虧損安全鎖預設關') : allTxt.includes(`虧損安全鎖預設 ${llock}%`)), JSON.stringify([recon && recon.slice(1), llock]));
  ok('⑥ 📈 符合進場那把尺 == index.html _EDGE_RULES.gene', allTxt.includes(`位階 ${egene[1]} + 20 日振幅 ${egene[2]}%`), JSON.stringify(egene && egene.slice(1)));
  ok('⑦ 這一頁自己寫的字 ⛔ 🔴🟢(只准講漲跌)', R.redGreen === 0, R.redGreen);
  await page.close();
}

// ① 深連結 + ⑦ 390 / 844 不橫捲、表格自己捲
for (const [w, h] of [[390, 844], [844, 390]]) {
  const page = await open(w, h, '?tab=audit');
  const R = await page.evaluate(async FIXs => {
    eval('(' + FIXs + ')')();
    const deep = PRO._tab;
    await PRO.renderAudit();
    await new Promise(r => setTimeout(r, 200));
    window.scrollTo(80, 0);
    const wraps = [...document.querySelectorAll('#tabAudit .aud-tbl')].map(t => { const w = t.closest('.tblwrap'); return w ? { ov: getComputedStyle(w).overflowX, cw: w.clientWidth } : null; });
    return { deep, sx: window.scrollX, vw: innerWidth, wraps, n: document.querySelectorAll('#tabAudit [data-audsec]').length };
  }, FIX.toString());
  ok(`① ?tab=audit 深連結直接進這一頁(${w}×${h})`, R.deep === 'audit' && R.n === 11, JSON.stringify([R.deep, R.n]));
  ok(`⑦ ${w}×${h} 頁面不橫捲、每張表都在可捲的框裡`, R.sx <= 2 && R.wraps.length >= 4 && R.wraps.every(x => x && /auto|scroll/.test(x.ov) && x.cw <= R.vw), JSON.stringify(R));
  await page.close();
}
await browser.close();
ok('⓪ 沒有 pageerror', errs.length === 0, errs.slice(0, 5).join(' | '));
console.log(fails.length ? `\n❌ ${fails.length} 條沒過` : '\n✅ 全過');
process.exit(fails.length ? 1 : 0);
