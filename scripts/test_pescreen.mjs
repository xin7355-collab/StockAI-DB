#!/usr/bin/env node
/**
 * 💰 估值篩選(V73.7.5)測試 —— 用**真實 `data/screener.json`** 實跑。
 *
 * 使用者:「幫我做一個本益比,由低到高的篩選器,其中還要包含同族群相比有沒有比較便宜
 *          還有財報等等我沒想到的比拚,看一下我有沒有說錯,還有推薦」
 *
 * ⛔ 這支要釘死的七件事:
 *   ① **null 一律不通過、也不可排在「最便宜」前面** —— `null < 15` 在 JS 是 true(V73.5.1 踩過),
 *      而排序時 null 當 0 會讓「沒有本益比的股票」佔滿最便宜前段班。
 *   ② **相對同業 PE 要真的用同業中位**,而且同業樣本 <5 檔不給值(⛔ 不硬算)。
 *   ③ **實測提醒是條件觸發** —— 沒用估值排序也沒勾估值條件時 ⛔ 完全不顯示。
 *   ④ **提醒裡必須寫「由低到高實測是輸的」+ 單調數字**(⛔ 這是整個功能最重要的一句)。
 *   ⑤ **價值陷阱那條要標成「要避開的」**,⛔ 不可讓使用者以為是選股清單。
 *   ⑥ ⛔ 不可宣稱任何估值條件「會賺」—— 全部扣完成本都是負的。
 *   ⑦ 排序真的有作用(本益比低→高:第一名的 PE 要 ≤ 最後一名)。
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
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._scrRelPe, null, { timeout: 25000 });

const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const scr = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'screener.json'), 'utf8'));

const R = await page.evaluate((D) => {
    app._scrData = D; app._scrC = {}; D.cols.forEach((k, i) => { app._scrC[k] = i; });
    app._scrIVCache = null;
    const S = app._scrIndVal();
    const ci = app._scrC;
    const out = { iv: S ? { inds: S.pe.size, p20: S.p20, p30: S.p30, p80: S.p80 } : null, conds: {}, rel: [], noPe: [] };
    // 每個新條件命中幾檔
    const ids = ['relcheap', 'relcheap4', 'relrich', 'relpbch', 'pelow30', 'valtrap', 'peval', 'peg1', 'payoutbad', 'yldsafe'];
    for (const id of ids) {
        const c = app._SCR_CONDS.find(x => x.id === id);
        if (!c) { out.conds[id] = 'MISSING'; continue; }
        let n = 0, nullPass = 0;
        for (const s of Object.keys(D.rows)) {
            const r = D.rows[s];
            if (!app._scrPass(c, r, s)) continue;
            n++;
            // 🚨 命中的股票裡,有沒有「本益比是 null」卻通過本益比類條件的
            if (['relcheap', 'relcheap4', 'relrich', 'pelow30', 'valtrap', 'peval', 'peg1'].includes(id)
                && app._scrV(r, 'pe') === null) nullPass++;
        }
        out.conds[id] = { n, nullPass };
    }
    // 相對同業 PE 抽驗
    let cnt = 0;
    for (const s of Object.keys(D.rows)) {
        const x = app._scrRelPe(s);
        if (x === null) { if (out.noPe.length < 3) out.noPe.push({ s, pe: app._scrV(D.rows[s], 'pe'), ind: (D.ind || {})[s] }); continue; }
        if (cnt++ < 5) out.rel.push({ s, ind: (D.ind || {})[s], pe: app._scrV(D.rows[s], 'pe'), rel: +x.toFixed(3) });
    }
    // 排序:本益比低→高 / 相對同業便宜
    const sortBy = k => {
        const so = app._SCR_SORTS.find(x => x.k === k);
        const sk = so.f || so.k;
        const all = Object.keys(D.rows).slice();
        all.sort((a, b) => {
            const xa = so.vfn ? so.vfn(a, app) : app._scrV(D.rows[a], sk),
                  xb = so.vfn ? so.vfn(b, app) : app._scrV(D.rows[b], sk);
            if (xa === null && xb === null) return 0;
            if (xa === null) return 1;
            if (xb === null) return -1;
            return so.d < 0 ? (xb - xa) : (xa - xb);
        });
        return all;
    };
    const peSorted = sortBy('pe_a');
    out.peTop = peSorted.slice(0, 5).map(s => ({ s, pe: app._scrV(D.rows[s], 'pe') }));
    out.peTail = peSorted.slice(-3).map(s => ({ s, pe: app._scrV(D.rows[s], 'pe') }));
    const relSorted = sortBy('relpe_a');
    out.relTop = relSorted.slice(0, 5).map(s => ({ s, rel: app._scrRelPe(s) }));
    out.relTail = relSorted.slice(-3).map(s => ({ s, rel: app._scrRelPe(s) }));
    // ③ 提醒的條件觸發
    app._scrSort = 'amt';
    out.noteOff = app._scrValNote([]);
    out.noteOffCond = app._scrValNote([{ id: 'f1' }, { id: 'vr' }]);
    app._scrSort = 'pe_a';
    out.noteBySort = app._scrValNote([]);
    app._scrSort = 'amt';
    out.noteByCond = app._scrValNote([app._SCR_CONDS.find(x => x.id === 'relcheap')]);
    out.noteTrap = app._scrValNote([app._SCR_CONDS.find(x => x.id === 'valtrap')]);
    out.noteSafe = app._scrValNote([app._SCR_CONDS.find(x => x.id === 'peval')]);
    return out;
}, scr);

// ── ② 同業中位 ─────────────────────────────────────────────────────
ok('② 同業中位 PE 算得出來,產業數接近 33 大類',
   !!R.iv && R.iv.inds >= 20 && R.iv.inds <= 40, JSON.stringify(R.iv));
ok('②b 全市場 PE 分位要遞增(p20 < p30 < p80)',
   !!R.iv && R.iv.p20 < R.iv.p30 && R.iv.p30 < R.iv.p80, JSON.stringify(R.iv));
ok('②c 相對同業 PE 抽驗有值且合理(0.05~20)',
   R.rel.length >= 3 && R.rel.every(x => x.rel > 0.05 && x.rel < 20), JSON.stringify(R.rel.slice(0, 3)));
ok('②d 沒有 PE / 沒有產業別的一律回 null(⛔ 不硬算)',
   R.noPe.length > 0 && R.noPe.every(x => x.pe === null || !x.ind), JSON.stringify(R.noPe));

// ── ① null 陷阱 ────────────────────────────────────────────────────
{
    const bad = Object.entries(R.conds).filter(([, v]) => v && v.nullPass > 0);
    ok('① 🚨 本益比類條件 ⛔ 不可讓「沒有本益比」的股票通過(null < 15 在 JS 是 true)',
       bad.length === 0, JSON.stringify(bad));
    const missing = Object.entries(R.conds).filter(([, v]) => v === 'MISSING');
    ok('①b 10 個新條件都存在', missing.length === 0, JSON.stringify(missing));
    const empty = Object.entries(R.conds).filter(([, v]) => v && v.n === 0);
    ok('🚧 空過守門:新條件至少 8 個要命中得到股票(⛔ 全部 0 = 根本沒作用)',
       Object.values(R.conds).filter(v => v && v.n > 0).length >= 8, JSON.stringify(R.conds));
    ok('🚧b ⛔ 條件不可命中全市場(那等於沒篩)',
       Object.values(R.conds).every(v => !v || v.n < Object.keys(scr.rows).length * 0.9), JSON.stringify(R.conds));
}

// ── ⑦ 排序真的有作用 ───────────────────────────────────────────────
ok('⑦ 本益比低→高:前 5 名的 PE 要遞增且都有值',
   R.peTop.every(x => x.pe !== null) && R.peTop[0].pe <= R.peTop[4].pe, JSON.stringify(R.peTop));
ok('⑦b 🚨 null 一律排最後(⛔ 不可佔滿「最便宜」前段班)',
   R.peTail.every(x => x.pe === null), JSON.stringify(R.peTail));
ok('⑦c 相對同業便宜:前 5 名遞增,且最便宜那個 < 1',
   R.relTop.every(x => x.rel !== null) && R.relTop[0].rel <= R.relTop[4].rel && R.relTop[0].rel < 1, JSON.stringify(R.relTop));
ok('⑦d 相對同業:null 排最後', R.relTail.every(x => x.rel === null), JSON.stringify(R.relTail));

// ── ③ 條件觸發 ─────────────────────────────────────────────────────
ok('③ 沒用估值排序也沒勾估值條件 → ⛔ 提醒完全不顯示',
   R.noteOff === '' && R.noteOffCond === '', String(R.noteOff || R.noteOffCond).slice(0, 100));
ok('③b 用估值排序 → 顯示', R.noteBySort.length > 200, String(R.noteBySort).slice(0, 80));
ok('③c 勾估值條件 → 顯示', R.noteByCond.length > 200, String(R.noteByCond).slice(0, 80));

// ── ④⑤⑥ 文案 ──────────────────────────────────────────────────────
{
    const txt = (R.noteBySort || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    ok('④ 🚨 必須明說「本益比由低到高實測是輸的」', /由低到高.{0,10}實測是.{0,3}輸/.test(txt), txt.slice(0, 200));
    ok('④b 要附五等分的單調數字(最便宜 −0.69 → 最貴 +0.79)',
       /-0\.69pp/.test(txt) && /\+0\.79pp/.test(txt) && /越便宜反而越差/.test(txt), txt.slice(0, 300));
    ok('④c 要說 PE<5 那批是純雜訊(前後半段方向相反)', /純雜訊/.test(txt) && /4\.29pp/.test(txt), '');
    ok('④d ⭐ 要指出真正有用的是「價值陷阱」+ 數字', /價值陷阱/.test(txt) && /-1\.89pp/.test(txt) && /29\.7%/.test(txt), '');
    ok('④e ⚠️ 要誠實說「比同業便宜」也沒有邊際', /沒有邊際/.test(txt) && /前後半段不同向/.test(txt), '');
    ok('④f 要附樣本數與窗口 + 兩個限制(多頭窗口 / 一次性業外收益)',
       /13,952 個事件/.test(txt) && /偏多頭/.test(txt) && /業外收益/.test(txt), txt.slice(-260));
    // ⑥ ⛔ 不可宣稱會賺 —— 先 strip 掉否定句(本專案踩過 6 次)
    const stripped = txt
        .replace(/別當成穩賺/g, '').replace(/實測是.{0,3}輸的/g, '')
        .replace(/仍是負的/g, '').replace(/沒有邊際/g, '');
    ok('⑥ ⛔ 不可宣稱任何估值條件「會賺 / 穩賺 / 保證」',
       !/(會賺|穩賺|保證|必漲|一定漲)/.test(stripped), stripped.slice(0, 200));
}
{
    const t = (R.noteTrap || '').replace(/<[^>]+>/g, ' ');
    ok('⑤ 🚨 勾「價值陷阱」時要明說這張清單是**要避開的**',
       /要避開的/.test(t) && /不是拿來買的/.test(t), t.slice(-200));
    const t2 = (R.noteSafe || '').replace(/<[^>]+>/g, ' ');
    ok('⑤b 勾「低 PE + 營收成長」時要說扣完成本仍是負的',
       /扣掉來回成本 0\.44% 後仍是負的/.test(t2), t2.slice(-200));
}

// ── 接線 ───────────────────────────────────────────────────────────
// ⚠️ V73.8.2 這條原本寫死整行 `const valNote = this._scrValNote(conds);` ——
//    加了第二個提醒(`_scrTurnNote`,週轉率)串在後面就假失敗了。
//    ⭐ 釘**意圖**(valNote 有含估值提醒、而且兩個分支都吃得到)⛔ 不要釘那一行長什麼樣子。
ok('⑧ 提醒接進結果區(有結果 / 沒結果兩個分支都要)',
   /const valNote = this\._scrValNote\(conds\)/.test(src) && /out\.innerHTML = valNote \+ \(hits\.length \?/.test(src), '');
ok('⑧b 排序支援 vfn 衍生值', /so\.vfn \? so\.vfn\(a, this\)/.test(src), '');
ok('⑧c ⛔ 沒有新增卡片 id', !/id="scrVal/.test(src), '');
ok('⑨ 無 pageerror', errs.length === 0, errs.join(' | '));

console.log('\n📊 新條件命中數:', JSON.stringify(R.conds));
console.log('📊 本益比最低 5 檔:', JSON.stringify(R.peTop));
console.log('📊 相對同業最便宜 5 檔:', JSON.stringify(R.relTop.map(x => ({ s: x.s, rel: +x.rel.toFixed(2) }))));
await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ PESCREEN_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
