#!/usr/bin/env node
/**
 * 📅 2026-11-17 日子清單的數字:research/daytype_20261117/out.json → data/day_facts.json + index.html 的 `_DAY_FACTS`
 *   (docs/PLAN_day_list.md A4;實驗 EXP-20261117-01)
 *
 *   為什麼要這支:行事曆每一列下面那句「這種日子:…」的倍數 / 比例只能有一個來源。
 *   index.html 不能 import → 用這支抄一份,⛔ 手改那一行(scripts/test_dayfacts.mjs 逐格比對三邊)。
 *   data/day_facts.json 是同一份,之後給 Python / Worker 讀(⛔ 各自再寫一份數字)。
 *
 *   每種日子的 type 由 out.json 每一格「已經算好的」判定與數字決定(規則寫在 typeOf,⛔ 寫死結果):
 *     vol      = 顛不顛那格過關(verdict = 'wild')
 *     maybe    = 顛不顛那格沒過關,但 p < 0.05 而且前半、後半倍數都 ≥ 1.10(「可能稍微顛一點,還不算確定」)
 *     none     = 其餘有測過的
 *     untested = out.json 裡沒有那種日子
 *   ⛔ 方向那幾格只要有一格過關 → exit 1:那時候「方向沒有規律」這句就是錯的,要先改句子再說。
 *   dir = out.json 裡有沒有那種日子的方向格(rev 只測了顛不顛)→ 沒測過方向的 ⛔ 講方向。
 *   line = 畫面 / 通知 / Telegram / Worker 印的那一句,**只在這裡產生**(lineOf);short = 總覽那一則用的短句(只有 vol)。
 *   「還沒測過的只在重要度高時顯示」留在讀的那一端(要看事件的 severity)。
 *
 *   跑法:node scripts/embed_day_facts.mjs          → 寫 data/day_facts.json 與 index.html
 *         node scripts/embed_day_facts.mjs --check  → 只比對(兩邊跟 out.json 算出來的不一樣就 exit 1)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SRC = 'research/daytype_20261117/out.json';
export const EXP = 'EXP-20261117-01';
const OUT_JSON = path.join(ROOT, 'data', 'day_facts.json'), IDX = path.join(ROOT, 'index.html');
const MAYBE_P = 0.05, MAYBE_HALF = 1.10;

// 每種日子用到 out.json 的哪幾格(這是「對應」不是結果;vol = 顛不顛那格、dir = 方向那幾格)
// ⚠️ rev(月營收公布期)out.json 只有顛不顛那格,方向在個股層級另外測過(myth-revday)
export const MAP = {
    post45: { vol: 'v_post45', dir: ['thru45', 'thru45_1'], label: '休市 4~5 天後的第一個交易日' },
    post6: { vol: 'v_post6', dir: ['thru6', 'thru6_1'], label: '休市 6 天以上後的第一個交易日' },
    pre45: { vol: 'v_pre45', dir: ['pre45_day'], label: '休市 4~5 天前的最後一個交易日' },
    pre6: { vol: 'v_pre6', dir: ['pre6_day'], label: '休市 6 天以上前的最後一個交易日' },
    settle: { vol: ['v_settle', 'v_settle_next'], dir: ['settle_day', 'settle_next', 'settle_5', 'settle_rev'], label: '台指期結算日' },
    wit: { vol: 'v_wit_next', dir: ['wit_day', 'wit_next'], label: '美股四巫日' },
    opx: { vol: 'v_opx_next', dir: ['opx_day', 'opx_next'], label: '美股每月選擇權結算' },
    fomc: { vol: 'v_fomc_next', dir: ['fomc_day', 'fomc_next'], label: '聯準會決議' },
    cpi: { vol: 'v_cpi_next', dir: ['cpi_day', 'cpi_next'], label: '美國 CPI' },
    nfp: { vol: 'v_nfp_next', dir: ['nfp_day', 'nfp_next'], label: '美國非農' },
    rev: { vol: 'v_rev', dir: [], label: '月營收公布期(每月 9~11 日)' },
};
export const UNTESTED = { msci: 'MSCI 調整', boj: '日銀', cbc: '央行理監事會', ism: 'ISM', ppi: 'PPI', earn: '法說 / 財報' };

const r2 = v => Math.round(v * 100) / 100, r1 = v => Math.round(v * 10) / 10;

/** 那種日子的那一句(⛔ 講會漲會跌、⛔ 🔴🟢、⛔ 買賣與部位;數字是加權指數量的 → 一律講「大盤」) */
export function lineOf(o, bigTh) {
    const p1 = v => (+v).toFixed(1);
    if (o.type === 'vol') return `這種日子:大盤比平常顛 ${o.mult} 倍(一天漲跌超過 ${bigTh}% 的機率 ${p1(o.big)}%,平常 ${p1(o.base)}%);會漲還是會跌沒有規律。`;
    if (o.type === 'maybe') return `這種日子:大盤方向沒有規律;公布後第一個交易日可能稍微顛一點(${o.mult} 倍),還不算確定。`;
    if (o.type === 'none') return o.dir ? '這種日子:大盤方向沒有規律,也沒有比平常顛。' : '這種日子:大盤沒有比平常顛。';
    return '這種日子:還沒測過。';
}
export const shortOf = o => (o.type === 'vol' ? `大盤比平常顛 ${o.mult} 倍,會漲還是會跌沒有規律。` : '');

/** 一格顛不顛的判定 → type(⛔ 這裡寫死任何一種日子的答案) */
export function typeOf(c) {
    if (c.verdict === 'wild') return 'vol';
    if (c.p < MAYBE_P && c.h1 >= MAYBE_HALF && c.h2 >= MAYBE_HALF) return 'maybe';
    return 'none';
}
const RANK = { vol: 3, maybe: 2, none: 1 };

export function buildDayFacts(out) {
    const cells = new Map((out.cells || []).map(c => [c.id, c]));
    const errs = [], kinds = {};
    for (const [k, m] of Object.entries(MAP)) {
        const vols = [].concat(m.vol).map(id => cells.get(id));
        if (vols.some(c => !c || c.fam !== 'vol')) { errs.push(`${k}:out.json 少了顛不顛那格 ${[].concat(m.vol)}`); continue; }
        const dirs = m.dir.map(id => cells.get(id));
        if (dirs.some(c => !c || c.fam !== 'dir')) { errs.push(`${k}:out.json 少了方向那格 ${m.dir}`); continue; }
        const dirPass = dirs.filter(c => c.verdict !== 'none');
        if (dirPass.length) errs.push(`${k}:方向那格過關了(${dirPass.map(c => c.id)})→「方向沒有規律」這句不成立,先改句子`);
        // 一種日子有好幾格顛不顛(結算日當天 / 隔天)→ 取判定最強的那格;同級取倍數大的
        const best = vols.map(c => ({ c, t: typeOf(c) })).sort((a, b) => (RANK[b.t] - RANK[a.t]) || (b.c.ratio - a.c.ratio))[0];
        const o = { type: best.t, dir: m.dir.length > 0, label: m.label, cell: best.c.id };
        if (best.t === 'vol' || best.t === 'maybe') Object.assign(o, { mult: r2(best.c.ratio), big: r1(best.c.big), base: r1(best.c.bigBase), n: best.c.n });
        // vol / maybe 的句子會講「方向沒有規律」→ 沒測過方向就 ⛔ 這樣講,要先改句子
        if (!o.dir && o.type !== 'none') errs.push(`${k}:${o.type} 但沒測過方向 → 句子會講到方向,先改 lineOf`);
        kinds[k] = o;
    }
    for (const [k, label] of Object.entries(UNTESTED)) kinds[k] = { type: 'untested', dir: false, label };
    const meta = out.meta || {};
    if (!meta.from || !meta.to) errs.push('out.json 沒有 meta.from / meta.to');
    const bigTh = (meta.rule || {}).BIG;
    for (const o of Object.values(kinds)) { o.line = lineOf(o, bigTh); const sh = shortOf(o); if (sh) o.short = sh; }
    return { obj: { src: SRC, exp: EXP, from: meta.from, to: meta.to, days: meta.days, bigTh: (meta.rule || {}).BIG, kinds }, errs };
}

const LINE_RE = /^    _DAY_FACTS: \{.*\},$/m;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const CHECK = process.argv.includes('--check');
    const die = m => { console.error('❌ ' + m); process.exit(1); };
    const out = JSON.parse(fs.readFileSync(path.join(ROOT, SRC), 'utf8'));
    const { obj, errs } = buildDayFacts(out);
    if (errs.length) die('out.json 對不上:\n  ' + errs.join('\n  '));
    const json = JSON.stringify(obj, null, 1) + '\n';
    const line = `    _DAY_FACTS: ${JSON.stringify(obj)},`;
    const idx = fs.readFileSync(IDX, 'utf8');
    if (!LINE_RE.test(idx)) die('index.html 找不到 `    _DAY_FACTS: {…},` 那一行');
    const summary = Object.entries(obj.kinds).map(([k, v]) => `${k}=${v.type}${v.mult ? ' ' + v.mult : ''}`).join(' ');
    if (CHECK) {
        const cur = fs.existsSync(OUT_JSON) ? fs.readFileSync(OUT_JSON, 'utf8') : '';
        if (cur !== json) die('data/day_facts.json 跟 out.json 算出來的不一樣 → 跑 node scripts/embed_day_facts.mjs');
        if (idx.match(LINE_RE)[0] !== line) die('index.html 的 _DAY_FACTS 跟 out.json 算出來的不一樣 → 跑 node scripts/embed_day_facts.mjs');
        console.log(`✅ _DAY_FACTS / data/day_facts.json 跟 out.json 一致:${summary}`);
    } else {
        fs.writeFileSync(OUT_JSON, json);
        fs.writeFileSync(IDX, idx.replace(LINE_RE, () => line));
        if (fs.readFileSync(IDX, 'utf8').match(LINE_RE)[0] !== line) die('寫回後讀不到同一行');
        console.log(`✅ 已寫入 data/day_facts.json 與 index.html _DAY_FACTS:${summary}`);
    }
}
