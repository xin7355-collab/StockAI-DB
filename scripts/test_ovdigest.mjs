#!/usr/bin/env node
/**
 * 🧠 總覽三頁「一句話消化」(V73.7.0)測試 —— 用**真實 data/*.json** 實跑。
 *
 * 使用者:「把不必要的雜訊移除」+「把籌碼及 K 線有用資訊,你消化完直接告訴我不用猜」。
 *
 * ⛔ 這支要釘死的:
 *  ① **三頁問的問題不同** → 開頭那句不可長一樣(⛔ 否則就是同一張卡貼三次)
 *  ② **只轉述,不新增判斷** —— `_ovDigest` 原始碼裡不可自己算均線/籌碼
 *     (那會變成第二份真相,兩張卡會講不一樣的話)
 *  ③ **單一劇本**:進場/出場頁必須寫明「動作以主卡為準」;⛔ 只有主卡能下指令
 *  ④ **空頭/出場守門**:空頭或出場狀態時,⛔ 不可出現「可以加碼」那類話
 *  ⑤ **出場頁不講買** —— ⛔ 不可在「該不該跑」那頁講「可以進場」
 *  ⑥ **算不出來整條不顯示**(⛔ 不留空殼、不寫「整備中」佔版面)
 *  ⑦ `_ovTopEdge` 與 `_ovDigest` 必須共用同一個挑法(`_ovEdgePick`)
 *  ⑧ 雜訊移除:深度診斷(844 字,佔「現在怎麼做」攤開字數的 76%)要收進摺疊,⛔ 但不可刪掉
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 260)}`}`); if (!c) fails.push(n); };

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined|Tailwind/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._ovDigest, null, { timeout: 25000 });

const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const blk = src.slice(src.indexOf('    _ovDigest(pane, data, sym) {'), src.indexOf('    _ovTopEdge(data, sym) {'));

// ── ② 只轉述,不新增判斷 ──
{
    ok('② ⛔ _ovDigest 裡不可自己算均線/統計',
       !/\bMA\d|\.reduce\(|for \(let|Math\.(max|min)\(.*close/.test(blk), '');
    ok('②b 只讀既有結論(_bearGate / _inExitMode / _ovEdgePick / _chipEdgeState / _ovTrend)',
       /_bearGate\(/.test(blk) && /_inExitMode\(/.test(blk) && /_ovEdgePick\(/.test(blk) && /_chipEdgeState\(/.test(blk), '');
    ok('⑦ _ovTopEdge 與 _ovDigest 共用同一個挑法',
       /_ovTopEdge\(data, sym\) \{[\s\S]{0,160}_ovEdgePick\(data, sym\)/.test(src), '');
    // ⚠️ 這裡要釘的是「**挑訊號的那條規則**只有一份」,
    //    ⛔ 不是「_entryCheckup 只被呼叫一次」—— 它有 5 個**不同**的消費端(進場體檢卡自己等),
    //    那不是重複。第一版訂錯了,寫下來免得再改回去。
    const picks = src.match(/x\.tone === 'bull' \? \(x\._e\.exp != null && x\._e\.exp > 0\) : true/g) || [];
    ok('⑦b ⛔ 「挑哪個實測訊號」的規則只可有一份',
       picks.length === 1, `找到 ${picks.length} 份`);
}

// ── ⑧ 雜訊:深度診斷要收進摺疊、但不可刪 ──
{
    ok('⑧ deepBriefCard 還在(⛔ 不可刪掉)', /id="deepBriefCard"/.test(src), '');
    const i = src.indexOf('id="ovNowMore"');
    const j = src.indexOf('</details>', i);
    ok('⑧b ⭐ deepBriefCard 已移進「📖 更多解讀」摺疊裡',
       src.slice(i, j).includes('id="deepBriefCard"'), '');
    const paneNow = src.slice(src.indexOf('data-ovpane="now"'), src.indexOf('data-ovpane="entry"'));
    ok('⑧c 仍在「現在怎麼做」pane 內(⛔ 不可又跑到 pane 外,陷阱 #32)',
       paneNow.includes('id="deepBriefCard"'), '');
    ok('⑧d 三個 pane 各有一個消化條容器',
       /id="ovDigestNow"/.test(src) && /id="ovDigestEntry"/.test(src) && /id="ovDigestExit"/.test(src), '');
}

// ── 實跑:真實資料 ──
const R = await page.evaluate(async () => {
    const out = { cases: [] };
    app.switchAppTab('diag');
    for (const s of ['2330', '2327', '2317']) {
        await app.analyze(s);
        await new Promise(r => setTimeout(r, 3500));
        const d = app.rawDailyData || [];
        const strip = h => (h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        out.cases.push({
            sym: s, bars: d.length,
            pick: !!app._ovEdgePick(d, s), chip: !!app._chipEdgeState(s),
            now: strip(app._ovDigest('now', d, s)),
            entry: strip(app._ovDigest('entry', d, s)),
            exit: strip(app._ovDigest('exit', d, s)),
            bad: strip(app._ovDigest('nosuchpane', d, s)),
        });
    }
    // ④ 強制空頭 / 出場 → 守門要生效(⛔ 不可等「剛好遇到空頭」才驗)
    const d = app.rawDailyData || [], s = String(app.currentSymbolId || '');
    const keepTrend = app._ovTrend, keepExit = app._exitMode;
    app._ovTrend = { sym: s, trend: 'bear', txt: '空頭' };
    app._exitMode = null;
    out.bearNow = (app._ovDigest('now', d, s) || '').replace(/<[^>]+>/g, ' ');
    out.bearEntry = (app._ovDigest('entry', d, s) || '').replace(/<[^>]+>/g, ' ');
    app._exitMode = { sym: s, on: true, big: false, slF: 0 };
    out.exitNow = (app._ovDigest('now', d, s) || '').replace(/<[^>]+>/g, ' ');
    out.exitEntry = (app._ovDigest('entry', d, s) || '').replace(/<[^>]+>/g, ' ');
    app._ovTrend = keepTrend; app._exitMode = keepExit;
    // ⑥ 兩邊都沒訊號 → 空字串
    const fake = [{ date: '2026-01-01', open: 1, high: 1, low: 1, close: 1, volume: 0 }];
    out.emptyCase = app._ovDigest('now', fake, 'ZZZZ');
    return out;
});

for (const c of R.cases) {
    const tag = `${c.sym}(K=${c.bars} K線訊號=${c.pick} 籌碼=${c.chip})`;
    if (!c.pick && !c.chip) {
        ok(`⑥ ${tag} 兩邊都沒訊號 → ⛔ 整條不顯示`, c.now === '' && c.entry === '' && c.exit === '', c.now.slice(0, 90));
        continue;
    }
    ok(`🚧 ${tag} 有訊號 → 三頁都要生得出東西`, !!c.now && !!c.entry && !!c.exit, '');
    ok(`① ${c.sym} 三頁開頭句不可長一樣`,
       c.now.slice(0, 24) !== c.entry.slice(0, 24) && c.entry.slice(0, 24) !== c.exit.slice(0, 24),
       `${c.now.slice(0, 24)} | ${c.entry.slice(0, 24)} | ${c.exit.slice(0, 24)}`);
    ok(`③ ${c.sym} 進場/出場頁要寫明「以主卡為準」`,
       /以「?🚦? ?現在怎麼做/.test(c.entry) && /以「?🚦? ?現在怎麼做/.test(c.exit), c.entry.slice(-70));
    ok(`③b ${c.sym} ⛔ 主卡那頁不必再寫「以主卡為準」(它自己就是)`, !/以「?🚦? ?現在怎麼做/.test(c.now), '');
    ok(`⑤ ${c.sym} ⛔ 出場頁不可講「可以進場/可以買」`,
       !/可以進場|可以買|可加碼|建議買進/.test(c.exit), c.exit.slice(0, 120));
    ok(`🧾 ${c.sym} 每條都要附實測數字(⛔ 不可只給形容詞)`,
       /\d+(\.\d+)?(%|pp)/.test(c.now), c.now.slice(0, 100));
    ok(`⚠️ ${c.sym} 要附免責(基準 36% + 沒扣成本)`,
       /36%/.test(c.now) && /沒扣/.test(c.now), '');
}
ok('①b ⛔ 不認得的 pane 要回空字串', R.bad === '' || R.cases.every(c => c.bad === ''), String(R.bad).slice(0, 60));
ok('④ ⭐ 空頭時 ⛔ 不可出現「可以加碼」', !/可以加碼|建議加碼/.test(R.bearNow + R.bearEntry), (R.bearNow + R.bearEntry).slice(0, 140));
ok('④b ⭐ 空頭時要明說「只做短、不加碼」', /不加碼|只做短/.test(R.bearEntry), R.bearEntry.slice(0, 140));
ok('④c ⭐ 出場狀態要明說「不是叫你進場」', /不是叫你進場|出場管理狀態/.test(R.exitEntry), R.exitEntry.slice(0, 140));
ok('④d ⭐ 出場狀態優先於空頭(⛔ 兩個都成立時要講出場)', /出場管理狀態/.test(R.exitNow), R.exitNow.slice(0, 100));
ok('⑥b 沒有 K 線也沒有籌碼 → 回空字串', R.emptyCase === '', String(R.emptyCase).slice(0, 80));
ok('⑨ 無 pageerror', errs.length === 0, errs.join(' | '));

await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ OVDIGEST_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
