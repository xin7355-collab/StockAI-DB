#!/usr/bin/env node
/**
 * 📅 日子清單(2026-11-17,docs/DECISIONS.md V82.5.0;實驗 EXP-20261117-01)
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
 *   ⑥(第三階段)句子只在 embed 產生(`line`;App 印的 == day_facts.json);沒測過方向的(rev)⛔ 講方向;
 *      休市前後三邊(探針 / App / 採礦端 Python)同一組日期一模一樣;總覽那一則只留 vol;
 *      今天是連休後第一天(用大盤實際的交易日)也看得到;決策台「下一個交易日」那一列(收盤前 / 收盤後 / 星期五晚上 / 沒有項目);
 *      日子提醒通知:一個交易日一則、關掉不跳、勿擾不跳。
 *
 *   注入必紅:INJECT=1 改一個倍數 / 2 把還沒測過的日子加上倍數 / 3 橫幅換回指令 / 4 日期大約的放進橫幅 / 5 把 +10 放回風險分數
 *            6 總覽那一則不只留 vol / 7 App 自己再組句子 / 8 今天那一筆不算 / 9 收盤後還講今天 / 10 通知不去重 / 11 舊的去重鍵不清 / 12 App 不讀官方休市表
 *   跑法:node scripts/test_dayfacts.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildDayFacts, MAP, UNTESTED } from './embed_day_facts.mjs';
import { series, buildSets } from './daytype_probe.mjs';
import { badOf } from './lib_retailbad.mjs';
import { spawnSync } from 'child_process';
let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INJ = process.env.INJECT || '';
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 400)}`); if (!c) fails.push(n); };

let src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const inj = (a, b) => { const n = src.split(a).length - 1; if (n !== 1) { ok(`INJECT=${INJ} 沒有注進去(找到 ${n} 處,要剛好 1 處)`, false, a.slice(0, 80)); } src = src.replace(a, b); };
if (INJ === '1') inj('"mult":1.75', '"mult":1.85');
if (INJ === '2') inj('"msci":{"type":"untested"', '"msci":{"type":"vol","mult":1.3,"big":25,"base":19');
if (INJ === '3') inj('<div class="text-gray-200 font-black text-[11px] mb-0.5">📅 明天 / 今天</div>', '<div class="text-red-200 font-black text-[11px] mb-1 animate-pulse">🚨 重大事件來襲 — 新單暫緩</div>');
if (INJ === '4') inj('if (!ev || this._evApprox(ev)) continue;', 'if (!ev) continue;');
if (INJ === '5') inj('    _calcRiskScore() {\n', "    _calcRiskScore() {\n        if (this._dayBannerItems(this._upcomingMacroEvents || [], [], this.getTodayStr().replace(/\\//g, '-')).length) return Math.min(100, (this._calcRiskScore0() ?? 0) + 10);\n        return this._calcRiskScore0();\n    },\n    _calcRiskScore0() {\n");
if (INJ === '6') inj("K[x.ev.kind].type === 'vol' && K[x.ev.kind].short", 'true');
if (INJ === '7') inj("        return f.line;\n    },", "        return f.line.replace('大盤', '');\n    },");
if (INJ === '8') inj('if (!(h.date >= today && h.date <= end)) continue;', 'if (!(h.date > today && h.date <= end)) continue;');
if (INJ === '9') inj('if (!isOpen(T.tdy) || min >= 13 * 60 + 30) {', 'if (!isOpen(T.tdy) || min >= 24 * 60) {');
if (INJ === '10') inj('                if (localStorage.getItem(key)) return false;\n', '');
if (INJ === '12') inj("for (const d of ((tc && Array.isArray(tc.days)) ? tc.days : []))", 'for (const d of [])');
if (INJ === '11') inj('if (m && m[1] < old) localStorage.removeItem(k);', '');
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
const dirGot = Object.fromEntries(Object.entries(F.kinds).map(([k, v]) => [k, v.dir]));
ok('①h dir:rev(月營收公布期)沒測過方向 = false,其餘測過的都是 true,還沒測過的 false',
   dirGot.rev === false && Object.keys(MAP).filter(k => k !== 'rev').every(k => dirGot[k] === true) && Object.keys(UNTESTED).every(k => dirGot[k] === false), JSON.stringify(dirGot));
ok('①i 句子:vol 講「大盤比平常顛」、none 講「大盤方向沒有規律」、rev 只講「大盤沒有比平常顛」(⛔ 講方向)、maybe「還不算確定」',
   /^這種日子:大盤比平常顛 1\.75 倍\(一天漲跌超過 1\.5% 的機率 46\.7%,平常 19\.9%\);會漲還是會跌沒有規律。$/.test(F.kinds.post6.line)
   && F.kinds.settle.line === '這種日子:大盤方向沒有規律,也沒有比平常顛。' && F.kinds.rev.line === '這種日子:大盤沒有比平常顛。' && !/方向|漲|跌/.test(F.kinds.rev.line)
   && /^這種日子:大盤方向沒有規律;公布後第一個交易日可能稍微顛一點\(1\.17 倍\),還不算確定。$/.test(F.kinds.fomc.line)
   && F.kinds.msci.line === '這種日子:還沒測過。' && F.kinds.post6.short === '大盤比平常顛 1.75 倍,會漲還是會跌沒有規律。' && !('short' in F.kinds.settle),
   JSON.stringify([F.kinds.post6.line, F.kinds.rev.line, F.kinds.fomc.line]));
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
// 採礦端 Python `_holiday_kinds`(Telegram / Worker 讀它算的 calc 事件)—— 同一組日期
const pyCode = `import sys, json, types, os
os.chdir(${JSON.stringify(ROOT)}); sys.path.insert(0, '.')
sys.modules.setdefault('yfinance', types.ModuleType('yfinance'))
import macro_miner as mm
from datetime import date
d = [date.fromisoformat(x) for x in json.loads(sys.stdin.read())]
o = {'post45': [], 'post6': [], 'pre45': [], 'pre6': []}
for x, k, g in mm._holiday_kinds(d): o[k].append(x.isoformat())
print(json.dumps({k: sorted(set(v)) for k, v in o.items()}))`;
const pyR = spawnSync('python3', ['-c', pyCode], { input: JSON.stringify(openDays), encoding: 'utf8', cwd: ROOT });
let py = null; try { py = JSON.parse(String(pyR.stdout).trim().split('\n').pop()); } catch (_) {}

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
    ok('②c 採礦端 Python `_holiday_kinds` 也一模一樣(三邊一致)', !!py && JSON.stringify(py) === JSON.stringify(probe), `py ${JSON.stringify(py)} ${String(pyR.stderr || '').slice(-200)}`);

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
        const imm = app._dayBannerItems(ev, app._appDayEvents(ev, '2027-02-03', 14, app._twiiKlineCache && app._twiiKlineCache.rows), '2027-02-03').map(x => x.ev.event);
        const dfl = [...list.querySelectorAll('[data-evrow]')].map(r => { const k = r.dataset.kind, f = r.querySelector('[data-dayfact]'); return f ? [k, f.innerText.trim()] : null; }).filter(Boolean);
        const vn = app._dayVolNotes();   // 2/3:明天是結算日(none)+ 連休前(none)→ 總覽那一則一件都沒有
        // ④ 風險分數:有 / 沒有今天明天的事件(⛔ 再加分)
        const keep = app._upcomingMacroEvents;
        app._upcomingMacroEvents = ev; const withEv = app._calcRiskScore();
        app._upcomingMacroEvents = []; const noEv = app._calcRiskScore();
        app._upcomingMacroEvents = keep;
        // ⑤ 名稱留「(日期大約)」
        const nm = [app._evName({ event: '📊 MSCI 季度成分股調整 (日期大約)', approx: true }), app._evName('🇺🇸 美國 CPI 消費者物價指數公布 (日期大約)'),
                    app._evName({ event: '🇹🇼 台指期月結算 (每月第三個星期三)' }), app._evName({ event: '舊資料 (提防外資結算洗盤)' })];
        return { rows, banner: banner ? banner.outerHTML : '', bannerTxt: banner ? banner.innerText.replace(/\s+/g, ' ') : '', facts,
                 all: list.innerText.replace(/\s+/g, ' '), imm, withEv, noEv, nm, hasOld: typeof app._hasImminentMacroEvent, dfl, vn,
                 sev: [...list.querySelectorAll('[data-sev]')].map(x => ({ c: x.className, t: x.title })),
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
    // ── ⑥ 第三階段 ─────────────────────────────────────────
    const lineBad = R.dfl.filter(([k, t]) => !F.kinds[k] || t !== F.kinds[k].line);
    ok('⑥a 畫面上的每一句 == day_facts.json 那種日子的 line(⛔ App 自己再組字串)', R.dfl.length >= 4 && !lineBad.length, JSON.stringify(lineBad).slice(0, 300));
    ok('⑥b 重要度小標灰階(⛔ 紅 / 橘 / 黃)而且 title 寫「大家關注的程度,⛔ 不是風險高低」',
       R.sev.length >= 3 && R.sev.every(x => !/red|orange|yellow|amber/.test(x.c) && /大家關注的程度/.test(x.t) && /不是風險高低/.test(x.t)), JSON.stringify(R.sev.slice(0, 2)));
    ok('⑥c 總覽那一則:明天只有結算日 / 連休前(測過跟平常一樣)→ 一件都不列', Array.isArray(R.vn) && R.vn.length === 0, JSON.stringify(R.vn));
    // ⑥d 今天是連休後第一天:2027-02-15(一)09:00,大盤實際交易日到 2/4(春節 2/5~2/14 已經過去,行事曆裡沒有了)
    const twRows = openDays.filter(d => d <= '2027-02-04').map(d => ({ date: d.replace(/-/g, '/'), close: 100 }));
    await page.clock.setFixedTime(new Date('2027-02-15T01:00:00Z'));
    const T15 = await page.evaluate(rows => {
        app._twiiKlineCache = { rows, at: Date.now() };
        const ev = [{ date: '2027-02-17', event: '🇺🇸 FOMC 聯準會利率決議 (台灣時間隔天凌晨公布)', kind: 'fomc', severity: 'high' }];
        app._macroRiskCache = Object.assign({}, app._macroRiskCache || {}, { upcoming_macro_events: ev });
        app._renderUpcomingMacroEvents(ev);
        const b = document.querySelector('#macroEventsList [data-daybanner]');
        return { banner: b ? b.innerText.replace(/\s+/g, ' ') : '', vn: app._dayVolNotes(), info: app._dayNextInfo() };
    }, twRows);
    ok('⑥d 今天是連休後第一天(過去的休市日不在行事曆裡,靠大盤實際交易日)→ 行事曆那一條講「今天」',
       /今天/.test(T15.banner) && /連休 10 天後的第一個交易日/.test(T15.banner) && /大盤比平常顛 1\.75 倍/.test(T15.banner), T15.banner);
    ok('⑥e 總覽那一則:「📅 今天是連休 10 天後的第一個交易日:大盤比平常顛 1.75 倍,會漲還是會跌沒有規律。」',
       T15.vn.length === 1 && T15.vn[0] === '📅 今天是連休 10 天後的第一個交易日:' + F.kinds.post6.short, JSON.stringify(T15.vn));
    ok('⑥f 決策台(收盤前 09:00)講「今天」那一件', T15.info.mode === 'today' && T15.info.target === '2027-02-15' && T15.info.items.some(x => /連休 10 天後/.test(x.name)), JSON.stringify(T15.info));
    // ⑥g 決策台四種時鐘
    const deck = async (iso, evs) => { await page.clock.setFixedTime(new Date(iso)); return page.evaluate(ev => {
        app._macroRiskCache = Object.assign({}, app._macroRiskCache || {}, { upcoming_macro_events: ev }); app._upcomingMacroEvents = ev;
        const I = app._dayNextInfo(); const d = document.createElement('div'); d.innerHTML = app._dayNextRowHtml(I);
        return { I, txt: d.innerText.replace(/\s+/g, ' '), html: d.innerHTML };
    }, evs); };
    const EVF = [
        ...['2027-02-05', '2027-02-08', '2027-02-09', '2027-02-10', '2027-02-11', '2027-02-12'].map(d => ({ date: d, event: '🧧 春節 (台股休市)', severity: 'low' })),
        { date: '2027-02-04', event: '🇹🇼 台指期月結算 (每月第三個星期三)', kind: 'settle', severity: 'high' },
        { date: '2027-02-22', event: '🇹🇼 台指期月結算 (每月第三個星期三)', kind: 'settle', severity: 'high' },
        { date: '2027-02-22', event: '📊 MSCI 季度成分股調整 (日期大約)', kind: 'msci', severity: 'high', approx: true },
        { date: '2027-02-15', event: '🗓️ 連休 10 天後的第一個交易日', kind: 'post6', calc: true, severity: 'low' },   // 採礦端算的 → App 略過(自己算一份)
    ];
    const pre = await deck('2027-02-04T02:00:00Z', EVF);    // 星期四 10:00(收盤前)
    ok('⑥g1 收盤前:講「今天」(結算日 + 連休前最後一個交易日)', pre.I.mode === 'today' && /📅 今天:/.test(pre.txt) && /台指期月結算/.test(pre.txt) && /連休前最後一個交易日\(接著休 10 天\)/.test(pre.txt), pre.txt);
    const aft = await deck('2027-02-04T06:00:00Z', EVF);    // 星期四 14:00(收盤後)→ 跳過春節到 2/15
    ok('⑥g2 收盤後:講下一個交易日(跳過春節 → 02/15 週一),連休後那一句帶倍數;採礦端的 calc 那筆 ⛔ 重複',
       aft.I.mode === 'next' && /📅 下一個交易日\(02\/15 週一\):/.test(aft.txt) && /大盤比平常顛 1\.75 倍/.test(aft.txt) && aft.I.items.length === 1, aft.txt);
    const fri = await deck('2027-02-19T12:00:00Z', EVF);    // 星期五 20:00 → 星期一 2/22
    ok('⑥g3 星期五晚上 → 星期一(02/22 週一);日期大約的 MSCI ⛔ 列', fri.I.target === '2027-02-22' && /02\/22 週一/.test(fri.txt) && /台指期月結算/.test(fri.txt) && !/MSCI/.test(fri.txt), fri.txt);
    const none = await deck('2027-02-26T12:00:00Z', EVF);   // 星期五晚上,下週一沒有任何日子
    ok('⑥g4 沒有任何一件 → 那一列整個不畫', none.I.items.length === 0 && none.html === '', none.html);
    const lineBad2 = [pre, aft, fri].flatMap(x => x.I.items).filter(x => x.kind && F.kinds[x.kind] && x.line && x.line !== F.kinds[x.kind].line);
    ok('⑥g5 決策台那一列的句子 == day_facts.json 的 line', !lineBad2.length, JSON.stringify(lineBad2));
    // ⑥h 日子提醒通知:收盤後 2/4 → 一則;再檢查一次 ⛔ 再發;關掉這一類 / 勿擾 → 只進鈴鐺 ⛔ 跳
    await page.clock.setFixedTime(new Date('2027-02-04T06:00:00Z'));
    const N = await page.evaluate(ev => {
        app._macroRiskCache = Object.assign({}, app._macroRiskCache || {}, { upcoming_macro_events: ev }); app._upcomingMacroEvents = ev;
        try { Object.keys(localStorage).filter(k => k.startsWith('proTerm_dayRemind_')).forEach(k => localStorage.removeItem(k)); } catch (_) {}
        const fired = []; const keep = app._fireAlert; app._fireAlert = (t, b) => fired.push([t, b]);
        try { localStorage.setItem('proTerm_dayRemind_2026-12-01', '1'); localStorage.setItem('proTerm_dayRemind_2027-01-20', '1'); } catch (_) {}   // 65 天前 / 15 天前
        const a1 = app._dayRemindCheck(), a2 = app._dayRemindCheck();
        const oldGone = localStorage.getItem('proTerm_dayRemind_2026-12-01') === null, recentKept = localStorage.getItem('proTerm_dayRemind_2027-01-20') === '1';
        app._fireAlert = keep;
        const cat = app._alertCatOf(fired[0] ? fired[0][0] : '').k;
        const toasts = () => document.querySelectorAll('div[data-alert-toast]').length;
        const pop = (off, quiet) => { document.querySelectorAll('div[data-alert-toast]').forEach(e => e.remove());
            app.settings = app.settings || {}; app.settings.alertOff = off ? { dayfact: true } : {}; const q = app._inQuiet; if (quiet) app._inQuiet = () => true;
            try { Object.keys(localStorage).filter(k => k.startsWith('proTerm_dayRemind_')).forEach(k => localStorage.removeItem(k)); } catch (_) {}
            app._dayRemindCheck(); app._inQuiet = q; app.settings.alertOff = {}; return toasts(); };
        return { a1, a2, fired, cat, oldGone, recentKept, on: pop(false, false), off: pop(true, false), quiet: pop(false, true) };
    }, EVF);
    ok('⑥h1 收盤後有項目 → 發一則「📅 日子提醒」,分類是 dayfact,內文 == 那一句', N.a1 === true && N.fired.length === 1 && /^📅 日子提醒｜下一個交易日 02\/15 週一$/.test(N.fired[0][0]) && N.cat === 'dayfact' && N.fired[0][1].includes(F.kinds.post6.line), JSON.stringify(N.fired));
    ok('⑥h2 同一個交易日 ⛔ 再發第二則', N.a2 === false && N.fired.length === 1, JSON.stringify(N));
    ok('⑥h4 去重鍵:發的時候清掉 30 天以前的(⛔ 無限累積),30 天內的留著', N.oldGone && N.recentKept, JSON.stringify([N.oldGone, N.recentKept]));
    ok('⑥h3 開著 → 跳出來;關掉這一類 / 勿擾時段 → ⛔ 跳(只進鈴鐺)', N.on === 1 && N.off === 0 && N.quiet === 0, `${N.on} / ${N.off} / ${N.quiet}`);
    // ⑦ 證交所官方休市表(macro_risk.json `tw_closed`):行事曆裡沒有春節,只有官方表 → 一樣知道 2/4 是連休前、2/15 是連休後
    const TC = await page.evaluate(() => {
        const keep = app._macroRiskCache;
        const tc = { src: 'x', years: [2027], days: ['2027-02-05', '2027-02-08', '2027-02-09', '2027-02-10', '2027-02-11', '2027-02-12'] };
        app._macroRiskCache = Object.assign({}, keep || {}, { tw_closed: tc, upcoming_macro_events: [] });
        const withTc = app._appDayEvents([], '2027-02-01', 14).map(e => e.date + ':' + e.kind);
        app._macroRiskCache = Object.assign({}, keep || {}, { upcoming_macro_events: [] }); delete app._macroRiskCache.tw_closed;
        const noTc = app._appDayEvents([], '2027-02-01', 14).map(e => e.date + ':' + e.kind);
        app._macroRiskCache = keep;
        return { withTc, noTc };
    });
    ok('⑦a App 讀官方休市表(tw_closed.days):行事曆裡沒寫春節也知道 2/4 連休前、2/15 連休後', TC.withTc.includes('2027-02-04:pre6') && TC.withTc.includes('2027-02-15:post6'), JSON.stringify(TC.withTc));
    ok('⑦b 決定性對照:舊資料沒有 tw_closed → 照舊只靠行事曆(這一組不知道春節),⛔ 壞掉', !TC.noTc.some(x => /pre6|post6/.test(x)), JSON.stringify(TC.noTc));
    // ⑥i 個股層級的舊倍數(_calDayVol / _HOLIDAY_EDGE)畫面上標「個股」,⛔ 讀起來跟大盤那一句打架
    ok('⑥i 個股頁的連假提醒寫「個股」、實驗室那段寫「個股層級」', /這種日子個股通常比較顛/.test(src) && /個股層級 \$\{H\.vol\.x\.toFixed\(2\)\}x/.test(src) && !/—— 這種日子通常比較顛<\/div>/.test(src));
    ok('⑥ 沒有 pageerror', !errsP.length, errsP.slice(0, 3).join(' | '));
} finally {
    await browser.close();
    fs.rmSync(tmp, { force: true });
}

console.log(fails.length ? `\n❌ DAYFACTS_FAIL ${fails.length} 條` : '\n✅ DAYFACTS_PASS');
process.exit(fails.length ? 1 : 0);
