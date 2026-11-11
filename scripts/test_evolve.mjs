// 🧭 V82.1.2 自我進化工程(SELF_EVOLVING_AUDIT)App 體檢頁 E / F / G 三段 + _EVOLVE 常數
//   ⛔ 這支釘的用意:
//     ① _EVOLVE 讀得出來、有 perf / wf / trades / pack 四塊,而且是 embed_evolve.mjs 寫的那一行(⛔ 手改:改了 readEvolve 讀回來要一致)
//     ② E 表每一格 == _EVOLVE.perf(決定性對照:改一格 → 畫面跟著變)
//     ③ F 表 == _EVOLVE.wf(決定性對照同上)
//     ④ G:_healthTrades 規則照 _EVOLVE.trades.lead.rule —— 一直低於線 → 第 2 次檢查就標;偶爾一次低於不標;不到 20 筆寫還差幾筆;
//        假的成績單 👑 模擬帳(只算封存日之後賣掉的)接到畫面上;讀不到成績單要明講(⛔ 空白、⛔ 寫成很正常)
//     ⑤ 三段 ⛔ 🔴🟢(只准講漲跌)、匯出精簡版也帶得到
//     ⑥ H 每週體檢(data/l1_report.json):四列照檔案、守門紅要寫出來、讀不到 / 讀取中 / 太舊各自講清楚
//   INJECT=noflag(標記規則失效)/ static(E 表寫死不讀 _EVOLVE)注入必紅
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC0 = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 400)}`); if (!c) fails.push(n); };
const { readEvolve } = await import(path.join(ROOT, 'scripts/embed_evolve.mjs'));
const E0 = readEvolve(SRC0);
ok('① _EVOLVE 讀得出來、四塊都在', E0 && E0.perf && E0.wf && E0.trades && E0.pack && E0.trades.lead.rule && E0.trades.lead.rule.every > 0, JSON.stringify(Object.keys(E0 || {})));

let SRC = SRC0;
const I = process.env.INJECT || '';
if (I === 'noflag') SRC = SRC.replace('if (run >= R.times && flag == null) flag = x.at;', 'if (false) flag = x.at;');
if (I === 'static') SRC = SRC.replace("rows.push(row('📏 0050 含息(買了放著)', B5.ai, B5.long));", "rows.push(['📏 0050 含息(買了放著)', '1.77', '2.75', '1.76', '—', '0.95', '1.41', '0.51', '—']);");
const TMP = path.join(ROOT, '.test_evolve_pro.html');
fs.writeFileSync(TMP, SRC);

let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const errs = [];
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', e => errs.push(e.message));
  await page.goto('file://' + TMP, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof PRO !== 'undefined' && PRO._tab, null, { timeout: 30000 });
  const R = await page.evaluate(() => {
    const o = {}, seal = PRO._HEALTH_BASE.seal, TB = PRO._EVOLVE.trades.lead, lim20 = TB.w[20].m[TB.lv.indexOf(TB.rule.below)];
    // ④ 規則
    const bad = Array.from({ length: 40 }, () => lim20 - 3), good = Array.from({ length: 40 }, () => lim20 + 3);
    // 只有一次檢查掉下去:第 21~25 筆很差(落在第 30、40 筆那兩次檢查的窗口裡),第 31~40 筆很好 → 第 30 筆那次低於線、第 40 筆那次又回來
    const once = [...good.slice(0, 20), ...Array.from({ length: 5 }, () => lim20 - 30), ...good.slice(0, 5), ...Array.from({ length: 10 }, () => lim20 + 40)];
    const Hb = PRO._healthTrades(bad), Hg = PRO._healthTrades(good), H1 = PRO._healthTrades(once), Hs = PRO._healthTrades(good.slice(0, 7));
    o.flagBad = Hb.w[20].flag; o.flagGood = Hg.w[20].flag; o.flagOnce = H1.w[20].flag; o.onceBelow = H1.w[20].checks.filter(x => x.below).length; o.need = Hs.w[20].need; o.need60 = Hg.w[60].need;
    // ④ 接線:假成績單(封存日前賣掉的 ⛔ 算、還抱著的 ⛔ 算)
    const mk = (d1, net, open = false) => ({ st: { d1, net, open } });
    const fakeT = [mk('2026-11-01', -50), mk('2026-11-20', 1.2, true), ...Array.from({ length: 32 }, (_, i) => mk(`2027-01-${String(i + 1).padStart(2, '0')}`, lim20 - 5))];
    PRO._auditLed = { start: '2026-10-22', trades: fakeT };
    const blk = () => PRO._auditEvolveBlocks().map(b => b.t || (b.rows ? b.rows.map(r => r.join('|')).join('\n') : '')).join('\n');
    o.g = blk();
    PRO._auditLed = { err: '假的讀不到', trades: [] }; o.gErr = blk();
    PRO._auditLed = null; o.gWait = blk();
    // ②③ 決定性對照
    const E = PRO._EVOLVE; o.e0 = blk();
    const keep = JSON.stringify(E);
    E.perf.rows.lead.ai.sharpe = 9.87; E.perf.b0050.long.calmar = 7.65; E.wf.exp.cagr = 12.34; o.e1 = blk();
    PRO._EVOLVE = JSON.parse(keep);
    // ⑥ H 每週體檢:讀得到 → 四列照檔案;讀不到 → 明講;還在讀 → 讀取中;守門紅 → 要寫出不一樣(決定性對照)
    const fakeL1 = (gok) => ({ at: new Date().toISOString().slice(0, 16), audit: { ref: 'origin/gh-pages', bad: 2, warn: 5, items: [['❌', 'A', 'data/x.json 是空的']] },
      edge: { updated: '2026-11-13', signals: 3, deck: true, diff: 4 }, gate: gok ? { ok: true, msg: '✅' } : { ok: false, msg: '❌ ① 實盤策略參數跟使用者核准那份不一樣' }, reg: { n: 21, open: ['EXP-20261112-01'], retro: 20, last: 'EXP-20261112-01' } });
    const hb = () => PRO._auditL1Blocks().map(b => b.t || (b.rows ? b.rows.map(r => r.join('|')).join('\n') : '') || (b.items || []).join('\n')).join('\n');
    PRO._auditL1 = fakeL1(true); o.h1 = hb();
    PRO._auditL1 = fakeL1(false); o.h2 = hb();
    PRO._auditL1 = { err: '假的讀不到', miss: 1 }; o.hErr = hb();
    PRO._auditL1 = { ...fakeL1(true), at: '2026-01-01T09:00' }; o.hOld = hb();
    PRO._auditL1 = null; o.hWait = hb();
    o.seal = seal; o.lim20 = lim20;
    o.txt = PRO.auditText({ full: false });
    return o;
  });
  ok('④a 一直低於線 → 第 2 次檢查(第 30 筆)就標;一直正常 → 不標', R.flagBad === 30 && R.flagGood == null, JSON.stringify(R));
  ok('④b 只有一次檢查掉下去 → 不標(要連 2 次)', R.flagOnce == null && R.onceBelow === 1, JSON.stringify([R.flagOnce, R.onceBelow]));
  ok('④c 不到 20 筆 → 寫還差幾筆', R.need === 13 && R.need60 === 20, `${R.need} ${R.need60}`);
  ok('④d 接線:只算封存日之後賣掉的(32 筆)、連 2 次低於線 → 要重驗', /封存日之後已經賣掉 32 筆/.test(R.g) && /⚠️ 要重驗/.test(R.g), R.g.slice(-600));
  ok('④e 讀不到成績單 → 明講,⛔ 寫成很正常;還在讀 → 寫讀取中', R.gErr.includes('讀不到成績單 👑 模擬帳(假的讀不到)') && !/在 16 年的範圍內/.test(R.gErr) && /讀成績單 👑 模擬帳中/.test(R.gWait), R.gErr.slice(-300));
  ok('②③ 改 _EVOLVE 一格,E / F 表跟著變(決定性對照)', !/9\.87|7\.65|12\.3%/.test(R.e0) && /9\.87/.test(R.e1) && /7\.65/.test(R.e1) && /12\.3%/.test(R.e1), R.e1.slice(0, 500));
  ok('⑤a 三段 ⛔ 🔴🟢', !/[🔴🟢]/u.test(R.e0 + R.g), '');
  ok('⑤b 匯出精簡版帶得到 E / F / G', /E\. 風險調整後/.test(R.txt) && /F\. 看板的數字有多少是「事後挑出來的」/.test(R.txt) && /G\. 最近的交易正不正常/.test(R.txt), '');
  ok('⑥a H 讀得到:資料體檢 2 錯 5 留意、回測 3 個訊號 / 4 處不同、登錄 21 筆 1 筆沒收、前幾條列得出來', /❌ 2 個錯・⚠️ 5 個要留意/.test(R.h1) && /訊號 3 個/.test(R.h1) && /不同 4 處/.test(R.h1) && /21 筆・還沒收結果 1 筆・事後補登 20 筆/.test(R.h1) && /data\/x\.json 是空的/.test(R.h1) && /跟你核准那份一樣/.test(R.h1), R.h1.slice(0, 600));
  ok('⑥b 守門紅 → 寫出不一樣(決定性對照:同一份只換 gate)', !/跟你核准那份一樣/.test(R.h2) && /跟你核准那份不一樣:❌ ① 實盤策略參數/.test(R.h2), R.h2.slice(0, 400));
  ok('⑥c 讀不到 → 明講 ⛔ 都沒問題;還在讀 → 讀取中;太舊 → 寫幾天沒更新', /假的讀不到 —— ⛔ 不是「都沒問題」/.test(R.hErr) && !/沒有錯/.test(R.hErr) && /讀每週體檢報告中/.test(R.hWait) && /天沒更新/.test(R.hOld) && !/天沒更新/.test(R.h1), R.hErr + ' | ' + R.hOld.slice(-200));
  ok('⑥d H ⛔ 🔴🟢', !/[🔴🟢]/u.test(R.h1 + R.h2), '');
  ok('⓪ 沒有 pageerror', !errs.length, errs.join(' | '));
} finally { await browser.close(); fs.rmSync(TMP, { force: true }); }
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ 全過');
process.exit(fails.length ? 1 : 0);
