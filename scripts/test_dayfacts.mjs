#!/usr/bin/env node
/**
 * 📅 日子清單(2026-11-17,docs/PLAN_day_list.md A3 / A4;實驗 EXP-20261117-01)
 *
 *   財經行事曆每一列下面多一行「這種日子:…」,數字只有一個來源:research/daytype_20261117/out.json
 *   → scripts/embed_day_facts.mjs → data/day_facts.json + index.html `_DAY_FACTS`。
 *
 *   ① 三邊逐格一致:out.json 照規則算 == data/day_facts.json == index.html `_DAY_FACTS`;每種日子的 type 釘住那張表
 *      (長假後 vol、聯準會 maybe、其他測過的 none、MSCI / 日銀 / 央行 / ISM / PPI / 法說 untested);untested ⛔ 帶任何數字。
 *   ② 休市前後的定義跟 scripts/daytype_probe.mjs `buildSets` 是同一條:同一組交易日餵兩邊,日期一模一樣。
 *   ③ 合成行事曆餵進真的 App(Playwright,時間固定在 2027-02-03 台北):長假後 → 倍數;結算日 →「沒有規律」;
 *      MSCI →「還沒測過」而且沒有倍數;日期大約的 ⛔ 進「明天 / 今天」;畫面 ⛔「新單暫緩」、⛔ 閃爍紅框;
 *      每一句過 lib_retailbad.badOf、⛔ 講會漲會跌、⛔ 🔴🟢、⛔ 買賣與部位。
 *   ④ 風險分數 ⛔ 再因為「今天 / 明天有行事曆事件」加分(有 / 沒有事件分數一樣)。
 *   ⑤ 吃括號的地方「(日期大約)」要留著。
 *
 *   注入必紅:INJECT=1 改一個倍數 / 2 把還沒測過的日子加上倍數 / 3 橫幅換回指令 / 4 日期大約的放進橫幅 / 5 把 +10 放回風險分數
 *   跑法:node scripts/test_dayfacts.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildDayFacts, MAP, UNTESTED } from './embed_day_facts.mjs';
import { series, buildSets } from './daytype_probe.mjs';
import { badOf } from './lib_retailbad.mjs';
let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INJ = process.env.INJECT || '';
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 400)}`); if (!c) fails.push(n); };

let src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const inj = (a, b) => { if (!src.includes(a)) { ok(`INJECT=${INJ} 沒有注進去`, false, a.slice(0, 80)); } src = src.replace(a, b); };
if (INJ === '1') inj('"mult":1.75', '"mult":1.85');
if (INJ === '2') inj('"msci":{"type":"untested"', '"msci":{"type":"vol","mult":1.3,"big":25,"base":19');
if (INJ === '3') inj('<div class="text-gray-200 font-black text-[11px] mb-0.5">📅 明天 / 今天</div>', '<div class="text-red-200 font-black text-[11px] mb-1 animate-pulse">🚨 重大事件來襲 — 新單暫緩</div>');
if (INJ === '4') inj('if (!ev || this._evApprox(ev)) continue;', 'if (!ev) continue;');
if (INJ === '5') inj('    _calcRiskScore() {\n', '    _calcRiskScore() {\n        if (this._imminentMacroEvents().length) return Math.min(100, (this._calcRiskScore0() ?? 0) + 10);\n        return this._calcRiskScore0();\n    },\n    _calcRiskScore0() {\n');
if (INJ) console.log(`💉 INJECT=${INJ}`);

// ── ① 三邊逐格一致 ─────────────────────────────────────────────
const OUT = JSON.parse(fs.readFileSync(path.join(ROOT, 'research/daytype_20261117/out.json'), 'utf8'));
const { obj: F, errs } = buildDayFacts(OUT);
ok('①a out.json 照規則算得出來(方向沒有一格過關、該有的格子都在)', !errs.length, errs.join(' / '));
const WANT = { post45: 'vol', post6: 'vol', pre45: 'none', pre6: 'none', settle: 'none', wit: 'none', opx: 'none', fomc: 'maybe',
    cpi: 'none', nfp: 'none', rev: 'none', msci: 'untested', boj: 'untested', cbc: 'untested', ism: 'untested', ppi: 'untested', earn: 'untested' };
const gotT = Object.fromEntries(Object.entries(F.kinds).map(([k, v]) => [k, v.type]));
ok('①b 每種日子的 type 等於定案那張表(⛔ 硬湊:不等於就要停下來回報)', JSON.stringify(gotT) === JSON.stringify(WANT), JSON.stringify(gotT));
// 數字逐格回去對 out.json 那一格(⛔ 只比 embed 自己的輸出 = 自己跟自己比)
const cells = new Map(OUT.cells.map(c => [c.id, c]));
const numBad = [];
for (const [k, v] of Object.entries(F.kinds)) {
    if (v.type === 'vol' || v.type === 'maybe') {
        const c = cells.get(v.cell);
        if (!c || [].concat(MAP[k].vol).indexOf(v.cell) < 0) { numBad.push(`${k}:格子 ${v.cell} 不對`); continue; }
        if (Math.abs(v.mult - c.ratio) > 0.005 || Math.abs(v.big - c.big) > 0.05 || Math.abs(v.base - c.bigBase) > 0.05 || v.n !== c.n) numBad.push(`${k}:${JSON.stringify(v)} vs ${c.ratio}/${c.big}/${c.bigBase}/${c.n}`);
    } else if (['mult', 'big', 'base', 'n'].some(x => x in v)) numBad.push(`${k}:${v.type} 卻帶數字`);
}
ok('①c vol / maybe 的倍數 / 比例 / 次數 == out.json 那一格;none / untested ⛔ 帶數字', !numBad.length, numBad.join(' / '));
ok('①d 長假後的數字是 1.39 / 1.75 倍、聯準會 1.17(對照 out.txt 人工讀的那幾格)',
   F.kinds.post45.mult === 1.39 && F.kinds.post6.mult === 1.75 && F.kinds.fomc.mult === 1.17 && F.kinds.post45.big === 35.5 && F.kinds.post45.base === 19, '');
const dj = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/day_facts.json'), 'utf8'));
ok('①e data/day_facts.json == out.json 照規則算的(⛔ 手改)', JSON.stringify(dj) === JSON.stringify(F), '跑 node scripts/embed_day_facts.mjs');
const lineM = src.match(/^    _DAY_FACTS: (\{.*\}),$/m);
const idxF = lineM ? JSON.parse(lineM[1]) : null;
ok('①f index.html `_DAY_FACTS` == out.json 照規則算的(⛔ 手改)', !!idxF && JSON.stringify(idxF) === JSON.stringify(F), lineM ? lineM[1].slice(0, 200) : '找不到那一行');
ok('①g 還沒測過的日子 ⛔ 帶倍數(index.html 那份)', !!idxF && Object.keys(UNTESTED).every(k => idxF.kinds[k] && idxF.kinds[k].type === 'untested' && !('mult' in idxF.kinds[k])),
   idxF && JSON.stringify(Object.keys(UNTESTED).map(k => idxF.kinds[k])));

// ── ② 休市定義跟 daytype_probe 同一條 ─────────────────────────────
// 合成交易日:2026-12 ~ 2027-04 平日,扣掉元旦、農曆年(9 天)、228 補假、清明連假、一個單獨的星期一
const OFF = new Set(['2027-01-01', '2027-02-05', '2027-02-08', '2027-02-09', '2027-02-10', '2027-02-11', '2027-02-12',
    '2027-03-01', '2027-04-02', '2027-04-05', '2027-04-06', '2027-03-22']);
const openDays = [];
for (let t = Date.UTC(2026, 11, 1); t <= Date.UTC(2027, 3, 30); t += 86400000) {
    const d = new Date(t), w = d.getUTCDay(), s = d.toISOString().slice(0, 10);
    if (w !== 0 && w !== 6 && !OFF.has(s)) openDays.push(s);
}
const Z = series({ d: openDays, c: openDays.map(() => 100) }), SS = buildSets(Z, {});
const probe = {}; for (const k of ['post45', 'post6', 'pre45', 'pre6']) probe[k] = SS[k].map(i => openDays[i]).sort();

const tmp = path.join(ROOT, '.test_dayfacts.html');
fs.writeFileSync(tmp, src);
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const errsP = [];
try {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    page.on('pageerror', e => errsP.push(e.message));
    await page.clock.setFixedTime(new Date('2027-02-03T02:00:00Z'));   // 台北 2027-02-03(三)10:00
    await page.route('**/*', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
    await page.goto('file://' + tmp, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof app !== 'undefined' && !!app._renderUpcomingMacroEvents && !!app._holidayKinds, null, { timeout: 60000 });

    const H = await page.evaluate(open => {
        const o = { post45: [], post6: [], pre45: [], pre6: [] };
        for (const h of app._holidayKinds(open)) o[h.kind].push(h.date);
        for (const k in o) o[k] = [...new Set(o[k])].sort();
        return o;
    }, openDays);
    ok('②a 空過守門:合成交易日裡真的有長假(6 天以上)和 4~5 天的連假', probe.post6.length >= 1 && probe.post45.length >= 2, JSON.stringify(probe));
    ok('②b App `_holidayKinds` 跟 daytype_probe `buildSets` 同一組日期一模一樣(休市前 / 後 × 4~5 天 / 6 天以上)',
       JSON.stringify(H) === JSON.stringify(probe), `App ${JSON.stringify(H)} vs probe ${JSON.stringify(probe)}`);

    // ── ③ 合成行事曆餵進真的 App ──────────────────────────────
    const R = await page.evaluate(() => {
        const ev = [
            { date: '2027-02-04', event: '🇹🇼 台指期月結算 (每月第三個星期三)', kind: 'settle', severity: 'high' },
            { date: '2027-02-04', event: '📊 MSCI 季度成分股調整 (日期大約)', kind: 'msci', severity: 'high', approx: true },
            // 線上舊資料:還沒有 approx 欄位,只有文字 → 一樣 ⛔ 進橫幅
            { date: '2027-02-03', event: '🇺🇸 美國 CPI 消費者物價指數公布 (日期大約)', kind: 'cpi', severity: 'high' },
            { date: '2027-02-04', event: '🇺🇸 美國 ISM 製造業 PMI 公布 (日期大約)', kind: 'ism', severity: 'mid', approx: true },
            ...['2027-02-05', '2027-02-08', '2027-02-09', '2027-02-10', '2027-02-11', '2027-02-12'].map(d => ({ date: d, event: '🧧 春節 (台股休市)', severity: 'low' })),
            { date: '2027-02-17', event: '🇺🇸 FOMC 聯準會利率決議 (台灣時間隔天凌晨公布)', kind: 'fomc', severity: 'high' },
        ];
        app._renderUpcomingMacroEvents(ev);
        const list = document.getElementById('macroEventsList');
        const rows = [...list.querySelectorAll('[data-evrow]')].map(r => ({ kind: r.dataset.kind || '', t: r.innerText.replace(/\s+/g, ' ') }));
        const banner = list.querySelector('[data-daybanner]');
        const facts = [...document.querySelectorAll('#macroEventsList [data-dayfact]')].map(x => x.innerText.trim());
        const imm = app._imminentMacroEvents().map(e => e.event);
        // ④ 風險分數:有 / 沒有今天明天的事件(⛔ 再加分)
        const keep = app._upcomingMacroEvents;
        app._upcomingMacroEvents = ev; const withEv = app._calcRiskScore();
        app._upcomingMacroEvents = []; const noEv = app._calcRiskScore();
        app._upcomingMacroEvents = keep;
        // ⑤ 名稱留「(日期大約)」
        const nm = [app._evName({ event: '📊 MSCI 季度成分股調整 (日期大約)', approx: true }), app._evName('🇺🇸 美國 CPI 消費者物價指數公布 (日期大約)'),
                    app._evName({ event: '🇹🇼 台指期月結算 (每月第三個星期三)' }), app._evName({ event: '舊資料 (提防外資結算洗盤)' })];
        return { rows, banner: banner ? banner.outerHTML : '', bannerTxt: banner ? banner.innerText.replace(/\s+/g, ' ') : '', facts,
                 all: list.innerText.replace(/\s+/g, ' '), imm, withEv, noEv, nm, hasOld: typeof app._hasImminentMacroEvent,
                 note: (document.getElementById('macroEventsNote') || {}).innerText || '' };
    });
    const row = re => R.rows.filter(r => re.test(r.t));
    const post = row(/連休 \d+ 天後的第一個交易日/);
    ok('③a 長假後第一天(App 自己算)→ 顯示倍數與比例', post.length === 1 && /比平常顛 1\.75 倍/.test(post[0].t) && /46\.7%/.test(post[0].t) && /19\.9%/.test(post[0].t) && post[0].kind === 'post6',
       JSON.stringify(post));
    ok('③a2 休市前最後一天也列出來(測過:方向沒有規律、也沒有比平常顛)', row(/連休前最後一個交易日/).some(r => /方向沒有規律,也沒有比平常顛/.test(r.t)), JSON.stringify(R.rows.map(r => r.t)).slice(0, 300));
    const st = row(/台指期月結算/);
    ok('③b 結算日 →「方向沒有規律,也沒有比平常顛」', st.length === 1 && /方向沒有規律,也沒有比平常顛/.test(st[0].t), JSON.stringify(st));
    const ms = row(/MSCI/);
    ok('③c MSCI →「還沒測過」而且那一列沒有任何倍數 / 比例', ms.length === 1 && /還沒測過/.test(ms[0].t) && !/倍|%/.test(ms[0].t), JSON.stringify(ms));
    const ism = row(/ISM/);
    ok('③d 還沒測過、重要度不是高的(ISM)→ 不顯示那一句', ism.length === 1 && !/這種日子/.test(ism[0].t), JSON.stringify(ism));
    const fo = row(/FOMC/);
    ok('③e 聯準會 →「還不算確定」(⛔ 寫成確定的比較顛)', fo.length === 1 && /可能稍微顛一點\(1\.17 倍\),還不算確定/.test(fo[0].t), JSON.stringify(fo));
    ok('③f 空過守門:「明天 / 今天」那一條真的有畫出來(結算日明天)', /明天/.test(R.bannerTxt) && /台指期月結算/.test(R.bannerTxt), R.bannerTxt);
    ok('③g 日期大約的 ⛔ 進「明天 / 今天」(有 approx 欄位的 MSCI、只有文字的舊資料 CPI)',
       !/MSCI|CPI/.test(R.bannerTxt) && !R.imm.some(t => /MSCI|CPI/.test(t)) && R.imm.some(t => /台指期月結算/.test(t)), `${R.bannerTxt} | ${JSON.stringify(R.imm)}`);
    ok('③h 畫面 ⛔「新單暫緩」/「重大事件來襲」、橫幅 ⛔ 閃爍 / 紅框', !/新單暫緩|重大事件來襲/.test(R.all) && !/animate-pulse|bg-red-|border-red-/.test(R.banner), R.banner.slice(0, 200));
    const lines = [...new Set([...R.facts, R.note])].filter(Boolean);
    ok('③i 空過守門:收得到「這種日子」那幾句(四種寫法都有出現)', lines.length >= 4 && ['比平常顛', '方向沒有規律,也沒有比平常顛', '還不算確定', '還沒測過'].every(w => lines.some(l => l.includes(w))), JSON.stringify(lines));
    const DIRBAN = /會漲(?!還是會跌)|(?<!會漲還是)會跌|偏多|偏空|利多|利空|看漲|看跌|反彈|買|賣|部位|減碼|加碼|進場|出場|停損|暫緩|🔴|🟢/;
    const badL = lines.filter(l => badOf(l).length || DIRBAN.test(l));
    ok('③j 每一句過 badOf、⛔ 講會漲會跌、⛔ 🔴🟢、⛔ 買賣與部位', !badL.length, badL.map(l => `${l} → ${badOf(l)} ${(l.match(DIRBAN) || [''])[0]}`).join(' | '));
    ok('③k 卡片最下面寫數字從哪來(日期範圍讀 _DAY_FACTS)', /2000-01-04 ~ 2026-11-16/.test(R.note) && /同星期幾/.test(R.note) && /不預測漲跌/.test(R.note), R.note);
    ok('④a 風險分數 ⛔ 再因為今天 / 明天有行事曆事件而加分', R.withEv === R.noEv && R.withEv != null, `${R.withEv} vs ${R.noEv}`);
    ok('④b 沒人用的 `_hasImminentMacroEvent` 已刪', R.hasOld === 'undefined' && !/_hasImminentMacroEvent/.test(src), R.hasOld);
    ok('⑤a `_evName` 拿掉括號說明但留「(日期大約)」(有欄位 / 只有文字兩種都要)',
       R.nm[0] === '📊 MSCI 季度成分股調整(日期大約)' && R.nm[1] === '🇺🇸 美國 CPI 消費者物價指數公布(日期大約)' && R.nm[2] === '🇹🇼 台指期月結算' && R.nm[3] === '舊資料', JSON.stringify(R.nm));
    // ⑤b 以前直接 replace 括號的三處(報告頁提示詞 / 本檔事件 / 休市前專欄)改走 `_evName`
    const oldStrip = (src.match(/String\((?:x|ev)\.event(?: \|\| '')?\)\.replace\(\/\\s\*\\\((?:\[\^\)\]\*\\\)\\s\*\/g|\.\*\$\/)/g) || []);
    ok('⑤b 吃括號的地方 ⛔ 直接 replace 事件文字(會把「(日期大約)」吃掉)', oldStrip.length === 0 && (src.match(/this\._evName\(x\)/g) || []).length >= 2 && /休市\(\$\{this\._evName\(ev\)\}\)/.test(src), oldStrip.join(' | '));
    ok('⑥ 沒有 pageerror', !errsP.length, errsP.slice(0, 3).join(' | '));
} finally {
    await browser.close();
    fs.rmSync(tmp, { force: true });
}

console.log(fails.length ? `\n❌ DAYFACTS_FAIL ${fails.length} 條` : '\n✅ DAYFACTS_PASS');
process.exit(fails.length ? 1 : 0);
