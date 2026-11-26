#!/usr/bin/env node
/**
 * 🧊 V82.7.0 反攻條件雷達拆成「讀資料 / 純計算 / 畫畫面」三支之後的守門
 *   ① `_reboundCalc` 只讀傳進來的 inp(⛔ 讀快取 / 碰畫面 / 打網路)—— 伺服器每天早上凍結用的就是這一支
 *   ② 門檻公式全 App 只有一份(`_reboundNeed`):index.html 只剩一個 `Math.max(6`;另外兩處(分析師那段 / 加權那頁)讀 rv.need
 *   ③ 用真的 `_reboundCalc`(lib_appextract 抽出來跑)把使用者看到的那幾個數字釘住:
 *      11 條都有資料 → 門檻 9、過半 6;4/11 = ⛔ 空方主控、6/11 = ⚠️ 打底、8/11 = 打底、9/11 = ✅ 成形;有一條沒資料 → 10 條、門檻 8;🚨 蓋過一切
 *   ④ lit 照條件表順序(第 i 條沒過 → 第 i 個字是 0;沒資料 → x)
 *   ⑤ 畫面那支把 need / half / lvl / lit 存進 _reboundVerdict(⛔ 別處再算)
 *   INJECT=1:把 Math.max(6 放回加權那頁 / 計算裡偷讀快取 / 成形改成「超過門檻」—— 三種都要紅
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { buildApp, extractMember } from './lib_appextract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INJ = process.env._RP_INJ || '';
const INJECTS = {
    dupMax: ['門檻 ${rv2.need ?? this._reboundNeed(rv2.total)})', '門檻 ${Math.max(6, rv2.total - 2)})'],
    impure: ['        const { mgNow, mgChg5, vix, fiChg5, fiPct, dist } = inp;', '        const { mgNow, mgChg5, vix, fiChg5, fiPct } = inp; const dist = this._distDayCount;'],
    lvlOff: ["const lvl = isSwan ? 'swan' : passN >= needN ? 'formed'", "const lvl = isSwan ? 'swan' : passN > needN ? 'formed'"],
};
let SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
if (INJ) { const [a, b] = INJECTS[INJ]; if (!SRC.includes(a)) { console.log('❌ 注入點找不到:' + INJ); process.exit(1); } SRC = SRC.replace(a, b); }
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails++; };

// ① 純函式
const calc = extractMember(SRC, '_reboundCalc');
const strip = t => t.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
const thisUse = [...new Set((strip(calc).match(/this\.(\w+)/g) || []).map(s => s.slice(5)))];
ok('① _reboundCalc 只讀 inp:this. 只有純格式化 / 門檻那兩支、⛔ document / localStorage / window / fetch',
    thisUse.every(n => ['_dW', '_reboundNeed'].includes(n)) && !/\bdocument\b|localStorage|\bwindow\b|\bfetch\(/.test(strip(calc)) && calc.length > 5000, thisUse.join(','));
ok('①b 讀快取的那幾段在 _reboundInputs(VIX / 外資期貨 / 派發日當場算 / 成交值 / 波動率 / 去槓桿 / 加權落後)',
    ['_vixState()', '_fiFutState()', '_calcDistributionDays(', '_amtState()', '_twRealizedVol()', '_deleverProgress()', '_twiiLag()'].every(k => extractMember(SRC, '_reboundInputs').includes(k)));

// ② 門檻只有一份
const nMax = (SRC.match(/Math\.max\(6,/g) || []).length;
ok('② 全 App 只剩一個 Math.max(6,(_reboundNeed)', nMax === 1 && /_reboundNeed\(j\) \{ return Math\.max\(6, j - 2\); \}/.test(SRC), `${nMax} 個`);
ok('②b 分析師那段 / 加權那頁讀雷達存好的 need(舊快取沒有才退回 _reboundNeed)',
    /\(_rv\.need \?\? this\._reboundNeed\(_rv\.total\)\)/.test(extractMember(SRC, '_marketAnalystHtml')) && /rv2\.need \?\? this\._reboundNeed\(rv2\.total\)/.test(extractMember(SRC, '_renderIndexCommand')));

// ③④ 用真的 _reboundCalc 釘數字
const A = buildApp(SRC, ['_reboundCalc', '_reboundNeed', '_dW', '_WD'], {});
const rising = Array.from({ length: 80 }, (_, i) => ({ date: `2026-08-${String((i % 28) + 1).padStart(2, '0')}`, close: 30000 + i * 50 }));
const falling = rising.map((r, i) => ({ ...r, close: 40000 - i * 50 }));
const AMT_OK = { tn: 1.2, over1tn: true, label: '集中市場成交值', ma5E: 11000, vsMa5: 5 }, AMT_NO = { ...AMT_OK, tn: 0.8, over1tn: false };
// 每一條「過」與「沒過」的值(照條件表順序 0~10)
function inp(fail = [], na = [], extra = {}) {
    const F = i => fail.includes(i), X = i => na.includes(i);
    const mr = {
        vix: F(0) ? 26 : 18, sp500_chg_pct: 0.5, usdtwd_chg_5d: X(1) ? null : F(1) ? 0.5 : -0.2, usdtwd: 31.5,
        kospi_chg_pct: X(2) ? null : F(2) ? -1 : 1, nikkei_chg_pct: X(2) ? null : 0.5, wti_chg_pct: X(4) ? null : F(4) ? 5 : 1,
        taifex_backwardation: X(6) ? null : F(6) ? -10 : 10, tw_vix: X(8) ? null : F(8) ? 35 : 20, fi_futures_net: -80000, fear_greed: 50,
        ...(extra.mr || {}),
    };
    return {
        mr, usm: { twii_history: X(5) ? [] : F(5) ? falling : rising }, vix: mr.vix,
        mgNow: 4000, mgChg5: X(10) ? null : F(10) ? 10 : -50, fiChg5: X(3) ? null : F(3) ? 0 : 5000, fiPct: 50,
        dist: X(9) ? null : F(9) ? 5 : 1, amt: X(7) ? null : F(7) ? AMT_NO : AMT_OK, rv: null, dl: null, lag: { lag: 0 }, ...(extra.top || {}),
    };
}
const R = (f, n, e) => A._reboundCalc(inp(f, n, e));
const all = R([]);
ok('③ 11 條全過 → ✅ 反攻條件成形、門檻 9、過半 6、lit 全 1', all.judged.length === 11 && all.needN === 9 && all.halfN === 6 && all.lvl === 'formed' && all.heroTxt === '反攻條件成形' && all.lit === '11111111111',
    JSON.stringify([all.judged.length, all.needN, all.halfN, all.lvl, all.lit]));
const r9 = R([0, 1]), r8 = R([0, 1, 2]), r6 = R([0, 1, 2, 3, 4]), r5 = R([0, 1, 2, 3, 4, 5]), r4 = R([0, 1, 2, 3, 4, 5, 6]);
ok('③b 使用者看到的那幾格:9/11 ✅ 成形 ・8/11 ⚠️ 打底 ・6/11 ⚠️ 打底 ・5/11 ⛔ 空方主控 ・4/11 ⛔ 空方主控',
    r9.passN === 9 && r9.lvl === 'formed' && r8.passN === 8 && r8.lvl === 'base' && r6.passN === 6 && r6.lvl === 'base' && r6.heroTxt === '打底觀察中'
    && r5.lvl === 'bear' && r4.passN === 4 && r4.lvl === 'bear' && r4.heroTxt === '空方主控',
    JSON.stringify([[r9.passN, r9.lvl], [r8.passN, r8.lvl], [r6.passN, r6.lvl], [r5.passN, r5.lvl], [r4.passN, r4.lvl]]));
const na1 = R([], [8]);
ok('③c 一條沒資料 → 只算 10 條、門檻變 8(容許 2 條沒過)', na1.judged.length === 10 && na1.needN === 8 && na1.lit[8] === 'x', JSON.stringify([na1.judged.length, na1.needN, na1.lit]));
const sw = R([], [], { mr: { vix: 34 }, top: { vix: 34 } });
ok('③d VIX ≥ 32 → 🚨 外面壓力很大,蓋過「成形」', sw.lvl === 'swan' && sw.isSwan && sw.heroTxt === '外面壓力很大', JSON.stringify([sw.lvl, sw.passN]));
const one = R([3]);
ok('④ lit 照條件表順序:第 4 條(外資期貨回補)沒過 → 第 4 個字是 0', one.lit === '11101111111' && one.C[3].name === '外資期貨回補', one.lit);

// ⑤ 存進 _reboundVerdict
ok('⑤ 畫面那支把 need / half / lvl / lit 存進 _reboundVerdict',
    /this\._reboundVerdict = \{ icon: heroIcon, txt: heroTxt, passN, total: judged\.length, need: needN, half: halfN, lvl: R\.lvl, lit: R\.lit \}/.test(extractMember(SRC, '_renderReboundRadar')));

if (process.env.INJECT && !INJ) {
    let allRed = true;
    for (const k of Object.keys(INJECTS)) {
        const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, INJECT: '', _RP_INJ: k }, encoding: 'utf8', timeout: 120000 });
        const reds = (r.stdout || '').split('\n').filter(l => l.startsWith('❌'));
        const hit = r.status !== 0 && reds.length > 0;
        console.log(`${hit ? '✅' : '❌'} 注入 ${k} → ${reds[0] ? reds[0].slice(0, 90) : '沒叫出來'}`);
        allRed = allRed && hit;
    }
    ok('🧪 三種注入全部叫得出來', allRed);
}
console.log(fails ? `\n❌ ${fails} 條沒過` : '\n✅ RADAR_PURE_PASS');
process.exit(fails ? 1 : 0);
