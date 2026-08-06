#!/usr/bin/env node
/**
 * 🧭 「每頁一句話」頁首結論條(V72.6.0)
 *
 * 使用者原話:「我的總覽、K線、籌碼頁面資料及卡片很多,我開發者都看到混亂」
 * ⭐ 解法**不是**把分頁合併(那只會讓單頁更擠)—— 是每頁最上面先給一句話答案。
 *
 * ⛔ 這支要擋住三件事(每一件都是本專案犯過的錯):
 *   ① 產生**第二份真相** —— 頁首條只能轉述各頁自己算好的結論,⛔ 不可自己再算一套
 *   ② 空頭/出場時還在下多方指令(`_bearGate` / `_inExitMode`,同一個錯已犯 8 次)
 *   ③ 樣本不足還給方向(陷阱 #27:1÷1 也是 100%)
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 260)}`}`); if (!c) fails.push(n); };
const txt = h => String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
const errs = [];
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined/i.test(t);
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._renderPageLead, null, { timeout: 20000 });

const lead = (tab, state) => page.evaluate(a => {
    app.currentSymbolId = 'T1';
    app._ovTrend = a.st.bear ? { sym: 'T1', trend: 'bear', txt: '' } : null;
    app._exitMode = a.st.exit ? { sym: 'T1', on: true, big: '🚪 建議離場' } : null;
    app._lastPlaybook = a.st.pb || null;
    app._lastBBScan = a.st.bb || null;
    app._lastXrayVerdict = a.st.xr || null;
    const id = { backtest: 'pageLeadBacktest', bullbear: 'pageLeadBullBear', corp: 'pageLeadCorp' }[a.tab];
    app._renderPageLead(a.tab);
    const el = document.getElementById(id);
    return { hidden: el.classList.contains('hidden'), html: el.innerHTML };
}, { tab, st: state });

const PB_GOOD = { ranked: [{ key: '🎯 回後買上漲', expectancy: 1.8, winRate: 62, count: 24, firedToday: true }] };
const PB_THIN = { ranked: [{ key: '🌅 晨星轉折', expectancy: 3.1, winRate: 100, count: 3 }] };
const PB_NEG = { ranked: [{ key: '📦 箱型突破', expectancy: -0.8, winRate: 33, count: 40 }] };

// ── ① 有站得住腳的打法 → 給結論 + 觸發提示 ────────────────────────────
{
    const r = await lead('backtest', { pb: PB_GOOD });
    const t = txt(r.html);
    ok('① 有正期望值且樣本足 → 顯示', !r.hidden && /回後買上漲/.test(t), t.slice(0, 200));
    ok('① ⭐ 要同時給期望值與樣本數', /\+1\.8%/.test(t) && /24 次/.test(t), t.slice(0, 220));
    ok('① ⭐ 今天觸發要講出來', /今天剛好觸發/.test(t), t.slice(0, 220));
    ok('① ⭐ 未扣交易成本要寫明', /未扣交易成本/.test(t), t.slice(-140));
}
// ── ② 樣本不足 → ⛔ 不給打法,但資料不藏 ──────────────────────────────
{
    const t = txt((await lead('backtest', { pb: PB_THIN })).html);
    ok('② ⭐ 只有 3 次 → 「沒有站得住腳的打法」', /沒有站得住腳的打法/.test(t), t.slice(0, 200));
    ok('② ⭐ 要說清楚為什麼(樣本不到 10 次)', /3\D{0,4}次/.test(t) && /樣本/.test(t), t.slice(0, 240));
    ok('② ⛔ 不可出現「最會賺的是」', !/最會賺的是/.test(t), t.slice(0, 200));
}
// ── ③ 全部負期望值 → 誠實說不適合 ────────────────────────────────────
{
    const t = txt((await lead('backtest', { pb: PB_NEG })).html);
    ok('③ 全負期望值 → 「不適合用型態打法」', /不適合用型態打法/.test(t), t.slice(0, 200));
}
// ── ④ ⭐⭐ 空頭 / 出場守門(⛔ 這是全 App 犯最多次的錯)────────────────
{
    const tb = txt((await lead('backtest', { pb: PB_GOOD, bear: true })).html);
    ok('④ ⭐ 空頭時要加「只能做短、不是波段進場理由」', /不是波段進場理由/.test(tb), tb.slice(0, 260));
    ok('④ ⛔ 空頭時不可再說「今天剛好觸發」那種鼓勵進場的話', !/今天剛好觸發/.test(tb), tb.slice(0, 260));
    const te = txt((await lead('backtest', { pb: PB_GOOD, exit: true })).html);
    ok('④ ⭐ 出場狀態要說「別反手做多」', /別反手做多/.test(te), te.slice(0, 260));
    // ⚠️ 正常情況不可誤傷(只驗一邊會做出「一律改掉」的過度修正)
    const tn = txt((await lead('backtest', { pb: PB_GOOD })).html);
    ok('④ ⭐ 正常情況不可誤傷', !/不是波段進場理由|別反手做多/.test(tn), tn.slice(0, 200));
}
// ── ⑤ 多空頁:樣本不足 ⛔ 不給方向(陷阱 #27)────────────────────────
{
    const t = txt((await lead('bullbear', { bb: { sym: 'T1', lowSample: true, hits: 2, rulesN: 29, verdict: '訊號不足' } })).html);
    ok('⑤ ⭐ 命中太少 → 「不給方向」', /不給方向/.test(t), t.slice(0, 200));
    // ⚠️ 本 session 第 9 次踩到同一個坑:**正確的免責句本身含有被禁的字串**
    //    (這裡是「命中太少時算出來的百分比沒有意義(1÷1 也是 100%)」)→ 先 strip 掉解釋句再驗。
    const t5 = t.replace(/命中太少時[^。]*。/g, '');
    ok('⑤ ⛔ 結論不可出現百分比(1÷1 也是 100%)', !/\d+%/.test(t5), t5.slice(0, 200));
    ok('⑤ ⭐ 要講「不代表沒有風險」', /不代表沒有風險/.test(t), t.slice(0, 240));
}
// ── ⑥ 多空頁:偏多但價格是空頭 → 要點出「兩者可以背離」──────────────
{
    const bb = { sym: 'T1', lowSample: false, hits: 12, rulesN: 29, bullScore: 20, bearScore: 6, verdict: '多方優勢' };
    const t = txt((await lead('bullbear', { bb, bear: true })).html);
    ok('⑥ ⭐ 條件偏多 × 趨勢空頭 → 要明說可以背離', /可以背離/.test(t), t.slice(0, 280));
    ok('⑥ ⛔ 不可直接當進場理由', /別直接當進場理由/.test(t), t.slice(0, 280));
    ok('⑥ ⭐ 命中數一定要跟著顯示(⛔ 百分比不可孤零零出現)', /命中 12\/29/.test(t), t.slice(0, 200));
}
// ── ⑦ 基本頁:體質 ≠ 時機 ────────────────────────────────────────────
{
    const t = txt((await lead('corp', { xr: { sym: 'T1', verdict: '🔥 體質強勁', tone: 'bull', act: '基本面站在你這邊。' } })).html);
    ok('⑦ 顯示體質結論', /體質強勁/.test(t), t.slice(0, 200));
    ok('⑦ ⭐⛔ 必須寫「體質好壞跟現在該不該買是兩件事」', /兩件事/.test(t), t.slice(-160));
}
// ── ⑧ 算不出來 → 整條不顯(⛔ 不留空殼)──────────────────────────────
{
    for (const [tab, st] of [['backtest', {}], ['bullbear', {}], ['corp', {}]]) {
        const r = await lead(tab, st);
        ok(`⑧ ${tab} 沒資料 → 整條不顯`, r.hidden === true && r.html === '', `hidden=${r.hidden}`);
    }
    // 換股殘留:別檔的結論不可顯在這一檔
    const r = await lead('bullbear', { bb: { sym: '9999', lowSample: false, hits: 12, rulesN: 29, bullScore: 9, bearScore: 1, verdict: '多方優勢' } });
    ok('⑧ ⭐ 綁 sym 防切股殘留', r.hidden === true, r.html.slice(0, 120));
}
// ── ⑨ ⛔ 不可自己算一套(只准轉述)────────────────────────────────────
{
    const src = await page.evaluate(() => [app._leadBacktest, app._leadBullBear, app._leadCorp].map(f => f.toString()).join('\n'));
    ok('⑨ ⛔ 頁首條裡不可出現偵測器/回測呼叫(那會變第二份真相)',
        !/_detect[A-Z]|_patternFitBacktest\(|_calcBullBearScan\(/.test(src), '');
    ok('⑨ ⭐ 三支都有呼叫共用守門', /_bearGate\(/.test(src) && /_inExitMode\(/.test(src), '');
    ok('⑨ ⭐ 樣本門檻走共用 `_wrEnough`(⛔ 不可寫死次數)', /_wrEnough\(/.test(src) && !/count\s*>=\s*\d+/.test(src), '');
}

ok('⑩ 無 pageerror', errs.length === 0, errs.join(' | '));

await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗:\n - ${fails.join('\n - ')}` : '\n✅ PAGELEAD_TEST_PASS');
process.exit(fails.length ? 1 : 0);
