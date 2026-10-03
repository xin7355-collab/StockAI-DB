#!/usr/bin/env node
/**
 * 🧬 V78.0.7 一年位階門檻 75 → 85 —— 四份實作同一個數字 + 換回舊的真的有效
 *   ① 跨檔:playbook_scan hq 門檻 == index `_GENE_RULE.rank` == pro `_HQ_RULE.pos` == auto_trade 預設 GENE_RANK
 *      舊門檻(prev)三邊都是 75;波動率門檻都是 60
 *   ② index `_hqOf`:位階 80 的那一筆 → 預設不是 🧬、設定換回 75 就是(⭐ 決定性對照);沒帶 rank/vol 退回採礦端 hq
 *   ③ pro `_hqOf` 同一個結果(同一份 localStorage 設定)
 *   ④ auto_trade.gene_hq 同一個結果(GENE_RANK=75 / 預設)
 *   ⑤ `_STRAT_CHANGES` 最新一筆是這次、有「換回舊的」(backGene)而且按鈕接到 setGeneRank
 *   ⑥ 決策台 / 排序 / 評級 / 徽章 / 自訂回測 都走 `_hqOf` / `_geneRank`(⛔ 不可再讀裸的 x.hq)
 * 注入:index `_GENE_RULE.rank` 改 80 → ① 紅;`_hqOf` 改回 `+x.hq` → ② 紅;auto_trade 預設改 75 → ①④ 紅
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const strip = s => s.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
const IDX = rd('index.html'), PRO = rd('pro.html'), SCAN = strip(rd('scripts/playbook_scan.mjs')), AT = rd('auto_trade.py');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };

// ① 跨檔
const scanR = +((/const hq = \(r\.rank != null && r\.rank >= (\d+) && r\.vol != null && r\.vol >= (\d+)\)/.exec(SCAN) || [])[1]);
const scanV = +((/const hq = \(r\.rank != null && r\.rank >= (\d+) && r\.vol != null && r\.vol >= (\d+)\)/.exec(SCAN) || [])[2]);
const idx = /_GENE_RULE: \{ rank: (\d+), vol: (\d+), prev: (\d+),/.exec(IDX) || [];
const pro = /_HQ_RULE: \{ pos: (\d+), vol: (\d+), prev: (\d+),/.exec(PRO) || [];
const atR = /GENE_RANK = (\d+) if os\.getenv\('GENE_RANK', '(\d+)'\)\.strip\(\) == '(\d+)' else (\d+)/.exec(AT) || [];
const atV = +((/GENE_VOL = (\d+)/.exec(AT) || [])[1]);
ok('①0 四份都切得到', scanR && idx[1] && pro[1] && atR[1], JSON.stringify({ scanR, idx: idx[1], pro: pro[1], at: atR[4] }));
ok('① 位階門檻四份相同(採礦 / index / pro / auto_trade 預設)', scanR === +idx[1] && +idx[1] === +pro[1] && +atR[2] === scanR && +atR[4] === scanR,
   `scan ${scanR} idx ${idx[1]} pro ${pro[1]} auto 預設 ${atR[2]}/${atR[4]}`);
ok('①b 舊門檻(換回舊的)三份相同', +idx[3] === +pro[3] && +atR[1] === +idx[3] && +atR[3] === +idx[3], `${idx[3]} ${pro[3]} ${atR[1]} ${atR[3]}`);
ok('①c 波動率門檻四份相同', scanV === +idx[2] && +idx[2] === +pro[2] && atV === scanV, `${scanV} ${idx[2]} ${pro[2]} ${atV}`);
ok('①d 新門檻比舊的高(V78.0.7 是往上調)', +idx[1] > +idx[3], `${idx[1]} vs ${idx[3]}`);

// ⑥ 呼叫端
const pbSort = IDX.slice(IDX.indexOf('_pbSort(list, mine) {'), IDX.indexOf('_pbSort(list, mine) {') + 420);
ok('⑥a 決策台排序 `_pbSort` 走 `_hqOf`', /this\._hqOf\(x\)/.test(pbSort) && !/\+x\.hq/.test(pbSort), pbSort.slice(0, 200));
ok('⑥b 決策台 🧬 名單 / 評級 / 徽章 / 計數都走 `_hqOf`(⛔ 不可再有裸的 +x.hq 判斷)',
   /uniq\.filter\(x => this\._hqOf\(x\) === 1 && !x\.bear\)/.test(IDX) && /const hq = !!this\._hqOf\(x\);/.test(IDX)
   && /\$\{this\._hqOf\(x\) \? `<span/.test(IDX) && /rows\.filter\(x => this\._hqOf\(x\)\)\.length/.test(IDX)
   && !/\(\+x\.hq \|\| 0\) === 1/.test(strip(IDX)), '');
ok('⑥c 自訂回測的 🧬 用 `_geneRank()`', /return rank >= this\._geneRank\(\) && vol >= this\._GENE_RULE\.vol;/.test(IDX), '');
ok('⑥d pro 今天的清單排序 / 徽章走 `_hqOf`,`_recoPicks`(重建過去)刻意仍讀當時的 hq',
   /_pbSort\(a, b\) \{ return PRO\._hqOf\(b\) - PRO\._hqOf\(a\)/.test(PRO) && /this\._hqOf\(b\) - this\._hqOf\(a\)/.test(PRO)
   && /_recoPicks\(pb\) \{[\s\S]{0,400}\(\+b\.hq \|\| 0\) - \(\+a\.hq \|\| 0\)/.test(PRO), '');
ok('⑥e auto_trade 用 gene_hq 重排(⛔ 不過濾)', /raw = sorted\(raw, key=lambda p: -gene_hq\(p\)\)/.test(AT), '');

// ⑤ 彈窗
const sc = (/_STRAT_CHANGES: \[\s*\{([\s\S]{0,3000}?)\n        \},/.exec(IDX) || [])[1] || '';
ok('⑤ 最新一筆策略變更是 V78.0.7 的 🧬 門檻、有 backGene + 代價(逐年)', /v: 'V78\.0\.7'/.test(sc) && /backGene: 75/.test(sc) && /7 年比舊門檻差/.test(sc), sc.slice(0, 200));
ok('⑤b 「換回舊的」按鈕接到 setGeneRank', /c\.backGene \? `app\.setGeneRank\(\$\{\+c\.backGene\}\);`/.test(IDX), '');

// ④ auto_trade 行為(Python)
const py = `
import os, importlib, sys
sys.path.insert(0, ${JSON.stringify(ROOT)})
res = []
for env in ('', '75'):
    if env: os.environ['GENE_RANK'] = env
    else: os.environ.pop('GENE_RANK', None)
    if 'auto_trade' in sys.modules: del sys.modules['auto_trade']
    at = importlib.import_module('auto_trade')
    res.append([at.gene_hq({'rank': 80, 'vol': 70}), at.gene_hq({'rank': 90, 'vol': 70}), at.gene_hq({'rank': 90, 'vol': 50}), at.gene_hq({'hq': 1}), at.GENE_RANK])
print(res)
`;
const r = spawnSync('python3', ['-c', py], { encoding: 'utf8', timeout: 60000 });
const got = (r.stdout || '').trim();
ok('④ auto_trade.gene_hq:預設 80→0 / 90→1 / 波動 50→0 / 沒欄位退回 hq;GENE_RANK=75 時 80→1', got === '[[0, 1, 0, 1, 85], [1, 1, 0, 1, 75]]', got + (r.stderr || '').slice(-300));

// ②③ 瀏覽器
const EXE = fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
const browser = await chromium.launch({ executablePath: EXE, args: ['--allow-file-access-from-files'] });
try {
    const pg = await browser.newPage();
    const errs = []; pg.on('pageerror', e => errs.push(e.message));
    await pg.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
    await pg.waitForFunction(() => typeof app !== 'undefined' && !!app._hqOf, null, { timeout: 60000 });
    const I = await pg.evaluate(() => {
        const a = { rank: 80, vol: 70, hq: 1 }, b = { rank: 90, vol: 70 }, c = { hq: 1 }, d = { rank: 90, vol: 50 };
        const o = {};
        delete app.settings.geneRank;
        o.def = [app._hqOf(a), app._hqOf(b), app._hqOf(c), app._hqOf(d), app._geneRank()];
        app.setGeneRank(75);
        o.old = [app._hqOf(a), app._hqOf(b), app._hqOf(c), app._hqOf(d), app._geneRank()];
        o.saved = JSON.parse(localStorage.getItem('proTerminalSettings') || '{}').geneRank;
        o.sort = app._pbSort([{ s: 'A', rank: 80, vol: 70, lb: 9 }, { s: 'B', rank: 90, vol: 70, lb: 1 }], new Set()).map(x => x.s).join('');
        app.setGeneRank(85);
        o.sort2 = app._pbSort([{ s: 'A', rank: 80, vol: 70, lb: 9 }, { s: 'B', rank: 90, vol: 70, lb: 1 }], new Set()).map(x => x.s).join('');
        app.settings.geneRank = 42; o.bad = app._geneRank();
        app.settings.geneRank = 85;
        app._fillGeneRankDesc?.(); o.desc = (document.getElementById('set_geneRankDesc') || {}).innerText || '';
        return o;
    });
    ok('② index 預設 85:位階 80 不是 🧬、90 是、沒欄位退回 hq、波動不夠不是', JSON.stringify(I.def) === '[0,1,1,0,85]', JSON.stringify(I.def));
    ok('②b ⭐ 決定性對照:換回 75 → 位階 80 變成 🧬,而且存進設定', JSON.stringify(I.old) === '[1,1,1,0,75]' && I.saved === 75, JSON.stringify(I.old) + ' saved=' + I.saved);
    ok('②c 排序跟著門檻變(75:兩檔都 🧬 照下界 → A 先;85:只有 B 是 🧬 → B 先)', I.sort === 'AB' && I.sort2 === 'BA', `${I.sort} / ${I.sort2}`);
    ok('②d 設定壞值一律回預設 85', I.bad === 85, String(I.bad));
    ok('②e 🧹 V78.3.4 設定說明只講門檻(⛔ 不印回測數字)', /位階 ≥ 85%/.test(I.desc) && /75%/.test(I.desc) && !/萬|實測|回測/.test(I.desc), I.desc.slice(0, 200));

    const pp = await browser.newPage();
    pp.on('pageerror', e => errs.push('pro: ' + e.message));
    await pp.addInitScript(() => { try { localStorage.setItem('proTerminalSettings', JSON.stringify({ geneRank: 75 })); } catch (_) {} });
    await pp.goto('file://' + path.join(ROOT, 'pro.html'), { waitUntil: 'domcontentloaded' });
    await pp.waitForFunction(() => typeof PRO !== 'undefined' && !!PRO._hqOf, null, { timeout: 60000 });
    const P = await pp.evaluate(() => {
        const a = { rank: 80, vol: 70 };
        const o = { old: PRO._hqOf(a) };
        localStorage.setItem('proTerminalSettings', JSON.stringify({}));
        o.def = PRO._hqOf(a); o.hi = PRO._hqOf({ rank: 90, vol: 70 }); o.fb = PRO._hqOf({ hq: 1 });
        o.sortFn = typeof PRO._pbSort === 'function';
        return o;
    });
    ok('③ pro 同一份設定同一個結果(75 → 位階 80 是 🧬;預設 85 → 不是)', P.old === 1 && P.def === 0 && P.hi === 1 && P.fb === 1 && P.sortFn, JSON.stringify(P));
    ok('⑦ 沒有 pageerror', errs.length === 0, errs.join(' | '));
} finally { await browser.close(); }

console.log(fails.length ? `\n❌ ${fails.length} 條失敗:${fails.join(' / ')}` : '\n✅ GENERANK_PASS');
process.exit(fails.length ? 1 : 0);
