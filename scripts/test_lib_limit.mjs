#!/usr/bin/env node
/**
 * 📏🧱 test_lib_limit.mjs —— 回測共用的「漲跌幅制度」與「斷崖守門」(V79.4.2,陷阱 #52 / #50)
 *
 * ① lib_limit:2015-06-01 前 ±7%、之後 ±10%;lockedBar 一價到底才算鎖死;limitFlag 收盤漲跌幅到漲跌停
 * ② lib_cliff:×1.5 / ×0.67 才算斷崖、只看窗口、開盤跳也算
 * ③ 已經改用共用工具的程式 ⛔ 不可再寫死 9.6 / 9.7 / 1.095 / 整檔剔除(⭐ 決定性對照:把寫死的那行塞回去 → 這條要紅)
 * ⑤ Python 版 lib_limit.py 跟 JS 版同一批案例逐一相同(⭐ 決定性對照:Python 版忘了 2015 → 要抓得到)
 * ④ 還沒改的探針只列出來(⛔ 不擋 —— 重跑那一支時才改,改完加進 ③ 的清單)
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { limitOf, lockedBar, limitFlag, upLimitClose, LIMIT_CHANGE } from './lib_limit.mjs';
import { cliffPrefix, cliffIn } from './lib_cliff.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
let bad = 0;
const ok = (name, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${name}${c ? '' : ' ・' + JSON.stringify(x)}`); if (!c) bad++; };

// ① 漲跌幅制度
ok('① 2015-05-29 是 ±7%、2015-06-01 起 ±10%(兩種日期格式都收)',
    limitOf('2015-05-29') === 0.07 && limitOf('2015/05/29') === 0.07 && limitOf('2015-06-01') === 0.10 && limitOf('2026/10/20') === 0.10 && LIMIT_CHANGE === '2015-06-01');
ok('① 2012 年一價到底 +7% = 鎖漲停;同一根放到 2020 年不算(那時要 +10%)',
    lockedBar('2012-03-02', 100, 107, 107, 107) === 1 && lockedBar('2020-03-02', 100, 107, 107, 107) === 0);
ok('① 一價到底 −10%(2020)= 鎖跌停;高 ≠ 低(盤中有打開)不算', lockedBar('2020-03-02', 100, 90, 90, 90) === -1 && lockedBar('2020-03-02', 100, 110, 110, 109) === 0);
ok('① upLimitClose:2012 收 +6.6% = 停在漲停(買不到)、2020 要 +9.5% 以上(剛好 9.5 會被浮點數算成 9.50000…01);前收 0 = 不判',
    upLimitClose('2012-03-02', 106.6, 100) && !upLimitClose('2020-03-02', 106.6, 100) && upLimitClose('2020-03-02', 109.6, 100) && !upLimitClose('2020-03-02', 109.6, 0));
ok('① limitFlag:2020 年 +9.6% 算漲停、+9.5% 不算;2012 年 +6.8% 算、+6.5% 不算;缺值 = 0',
    limitFlag('2020-03-02', 9.6) === 1 && limitFlag('2020-03-02', 9.5) === 0 && limitFlag('2012-03-02', 6.8) === 1
    && limitFlag('2012-03-02', 6.5) === 0 && limitFlag('2012-03-02', -6.9) === -1 && limitFlag('2012-03-02', null) === 0 && limitFlag('2012-03-02', undefined) === 0);

// ② 斷崖
{
    const c = [100, 101, 102, 160, 161, 162, 100, 101];          // 第 3 根 ×1.57、第 6 根 ×0.62
    const pre = cliffPrefix(c);
    ok('② 第 3、6 根是斷崖;窗口 0..2 乾淨、2..3 碰到、4..5 乾淨、5..6 碰到',
        !cliffIn(pre, -1, 2) && cliffIn(pre, 2, 3) && !cliffIn(pre, 3, 5) && cliffIn(pre, 5, 6), Array.from(pre));
    const o = [100, 101, 102, 103, 104, 170, 105, 106];          // 收盤連續、但第 5 根開盤跳 ×1.63
    ok('② 開盤跳也算(收盤看起來連續的那種)', cliffIn(cliffPrefix([100, 101, 102, 103, 104, 105, 106, 107], o), 4, 5));
    ok('② ×1.45 / ×0.7 不算斷崖(門檻 ×1.5 / ×0.67)', !cliffIn(cliffPrefix([100, 145, 101.5]), -1, 2));
}

// ③ 已經接上共用工具的程式:⛔ 不可再寫死(路徑相對 repo 根目錄)
const MIGRATED = [
    'scripts/dispo_backtest.mjs', 'scripts/breakout_exit_probe.mjs', 'scripts/leader_probe.mjs',
    'screener_miner.py',
    // 🔁 V79.4.3 S2 前置(16 年全市場重跑前):同一天對照 + 2015 前 ±7% + 只剔斷崖窗口
    'scripts/signal_backtest.mjs', 'scripts/screener_edge_probe.py',
    'scripts/trustvol_probe.mjs', 'scripts/fstreak_probe.py', 'sector_flow_probe.py', 'scripts/sector_rotation_probe.mjs',
    'scripts/value_probe.mjs', 'scripts/prob_factor_probe.mjs', 'scripts/breadth_osc_probe.py', 'scripts/breakoutdist_probe.mjs',
    'scripts/genezone_probe.mjs', 'floorcount_probe.py', 'scripts/indicator_zoo_probe.mjs', 'scripts/calendar_stock_probe.mjs',
    'scripts/regime_probe.mjs',
    // 💰 V79.4.6 重大訊息事件研究(減資類公告就是會出現斷崖的那種)
    'scripts/mops_event_probe.py',
    // 📞 V79.7.3 法說會隔天反應研究
    'scripts/confcall_event_probe.mjs',
    // 🛬 V80.1.3 停機坪 / 四大買點精確版(16 年,2015 前漲停 7%)
    'scripts/parking_apron_probe.mjs', 'scripts/bestfour_probe.mjs',
];
const BANNED = [
    [/\*\s*1\.095\b/, '× 1.095(寫死 ±10% 的鎖漲停)'],
    [/>=\s*9\.[67]\b/, '>= 9.6 / 9.7(寫死 ±10% 的漲停 / 鎖死)'],
    [/<=\s*-\s*9\.[67]\b/, '<= -9.6 / -9.7(寫死 ±10% 的跌停)'],
    [/d\s*<\s*'2015-06-01'\s*\?\s*0\.07/, '自己再寫一份 2015 的換制度判斷'],
    [/rr\s*>\s*1\.4\s*\|\|\s*rr\s*<\s*0\.6/, '整檔剔除的斷崖判斷'],
];
const strip = src => src.split('\n').filter(l => !/^\s*(\/\/|\*|#)/.test(l)).join('\n');   // 註解裡提到舊寫法不算
const scan = (name, src) => BANNED.filter(([re]) => re.test(strip(src))).map(([, w]) => w);
const importsLib = (f, src) => f.endsWith('.py')
    ? /^\s*(import lib_limit|from lib_limit import)/m.test(src)
    : /from '\.\/lib_limit\.mjs'/.test(src);
for (const f of MIGRATED) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const hit = scan(f, src);
    ok(`③ ${f}:沒有寫死的漲跌幅 / 斷崖判斷`, hit.length === 0, hit);
    ok(`③ ${f}:有 import 共用工具`, importsLib(f, src), f);
}
// 決定性對照:把舊寫法塞回去要抓得到
ok('③ 決定性對照:塞回「c >= pc * 1.095」→ 抓得到', scan('x', 'if (c >= pc * 1.095) skip++;').length === 1);
ok('③ 決定性對照:塞回 Python「1 if p >= 9.6 else (-1 if p <= -9.6 else 0)」→ 抓得到',
    scan('x.py', "v = 1 if p >= 9.6 else (-1 if p <= -9.6 else 0)").length === 2);
ok('③ 決定性對照:註解裡寫舊寫法 → 不算(說明文字可以提)',
    scan('x', '// 舊版寫死 c >= pc * 1.095').length === 0 && scan('x.py', '    # 舊版寫死 p >= 9.6').length === 0);

// ⑤ 跨語言:Python 版跟 JS 版同一批案例逐一相同
{
    const cases = [];
    for (const d of ['2010-01-04', '2015/05/29', '2015-05-31', '2015-06-01', '2015/06/02', '2026-10-20', '', null]) cases.push({ f: 'limit_of', d });
    const lb = [
        ['2012-03-02', 100, 107, 107, 107], ['2012-03-02', 100, 106.8, 106.8, 106.8], ['2012-03-02', 100, 106.5, 106.5, 106.5],
        ['2020-03-02', 100, 107, 107, 107], ['2020-03-02', 100, 110, 110, 110], ['2020-03-02', 100, 90, 90, 90],
        ['2020-03-02', 100, 110, 110, 109], ['2012-03-02', 0, 107, 107, 107], ['2012-03-02', 100, 93, 93, 93],
        ['2015-05-29', 50, 53.5, 53.5, 53.5], ['2015-06-01', 50, 53.5, 53.5, 53.5],
    ];
    for (const a of lb) cases.push({ f: 'locked_bar', a });
    for (const a of [['2020-03-02', 9.6], ['2020-03-02', 9.59], ['2012-03-02', 6.6], ['2012-03-02', 6.59], ['2012-03-02', -6.6],
        ['2015-05-29', 9.8], ['2015-06-01', 6.9], ['2020-03-02', null], ['2020-03-02', -9.6]]) cases.push({ f: 'limit_flag', a });
    for (const a of [['2012-03-02', 106.6, 100], ['2012-03-02', 106.4, 100], ['2020-03-02', 106.6, 100], ['2020-03-02', 109.5, 100],
        ['2020-03-02', 109.4, 100], ['2020-03-02', 109.5, 0], ['2015-05-29', 106.5, 100]]) cases.push({ f: 'up_limit_close', a });
    cases.push({ f: 'cliff', c: [100, 101, 102, 160, 161, 162, 100, 101], w: [[-1, 2], [2, 3], [3, 5], [5, 6], [-5, 99], [6, 6]] });
    cases.push({ f: 'cliff', c: [100, 101, 102, 103, 104, 105, 106, 107], o: [100, 101, 102, 103, 104, 170, 105, 106], w: [[4, 5], [-1, 4], [5, 7]] });
    cases.push({ f: 'cliff', c: [100, 0, 102, 145, 101.5, 151, 100], w: [[-1, 6], [0, 2], [4, 5]] });
    const jsOut = cases.map(c => {
        if (c.f === 'limit_of') return limitOf(c.d);
        if (c.f === 'locked_bar') return lockedBar(...c.a);
        if (c.f === 'limit_flag') return limitFlag(...c.a);
        if (c.f === 'up_limit_close') return !!upLimitClose(...c.a);
        const pre = cliffPrefix(c.c, c.o || null);
        return c.w.map(([a, b]) => cliffIn(pre, a, b));
    });
    const runPy = (prelude = '') => {
        const code = `import sys, json; sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'scripts'))}); import lib_limit as L\n${prelude}\nprint(json.dumps(L._eval_cases(json.load(sys.stdin))))`;
        const r = spawnSync('python3', ['-c', code], { input: JSON.stringify(cases), encoding: 'utf8' });
        if (r.status !== 0) return { err: (r.stderr || '').slice(0, 300) };
        try { return { out: JSON.parse(r.stdout) }; } catch (e) { return { err: 'parse ' + r.stdout.slice(0, 200) }; }
    };
    const diff = out => cases.map((c, i) => JSON.stringify(out[i]) === JSON.stringify(jsOut[i]) ? null : { i, f: c.f, js: jsOut[i], py: out[i] }).filter(Boolean);
    const py = runPy();
    ok(`⑤ Python 版 lib_limit.py 跑得起來(${cases.length} 個案例)`, !py.err, py.err);
    if (!py.err) ok('⑤ Python == JS(漲跌幅制度 / 鎖死 / 漲跌停旗標 / 斷崖,逐一相同)', diff(py.out).length === 0, diff(py.out).slice(0, 4));
    const inj = runPy("L.LIMIT_CHANGE = '2000-01-01'");
    ok('⑤ 決定性對照:Python 版忘了 2015(一律 ±10%)→ 比對抓得到', !inj.err && diff(inj.out).length >= 5, inj.err || diff(inj.out).length);
}

// ⑥ 選股快照的漲跌停旗標 lim(screener_miner.build_one):2015 前 +7% 算漲停、之後一樣是 ±9.6% 那條(今天的輸出不變)
{
    const code = `import sys, json; sys.path.insert(0, ${JSON.stringify(ROOT)}); import screener_miner as SM
def one(d0, last):
    rows = [{'date': d0 + '-%02d' % (i % 28 + 1), 'open': 100, 'high': 100, 'low': 100, 'close': 100, 'volume': 1000} for i in range(79)]
    rows.append({'date': d0 + '-28', 'open': last, 'high': last, 'low': last, 'close': last, 'volume': 1000})
    v = SM.build_one(rows)
    return None if v is None else v[SM.CI['lim']]
print(json.dumps([one('2012-03', 107), one('2020-03', 107), one('2020-03', 109.7), one('2020-03', 109.5), one('2012-03', 93.2), one('2026-10', 90.3)]))`;
    const r = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
    let got = null;
    try { got = JSON.parse(r.stdout); } catch (_) { /* 下面印錯誤 */ }
    ok('⑥ screener_miner lim:2012 +7% = 1 ・2020 +7% = 0 ・2020 +9.7% = 1 ・+9.5% = 0 ・2012 −6.8% = −1 ・2026 −9.7% = −1(⚠️ 剛好 9.6 會被浮點數算成 9.5999…)',
        JSON.stringify(got) === JSON.stringify([1, 0, 1, 0, -1, -1]), got || (r.stderr || '').slice(0, 300));
}

// ④ 還沒改的(只列,⛔ 不擋)
const listProbes = dir => fs.readdirSync(path.join(ROOT, dir))
    .filter(f => /(probe|backtest)\.(mjs|py)$/.test(f))
    .map(f => dir === '.' ? f : `${dir}/${f}`);
const todo = [...listProbes('scripts'), ...listProbes('.')]
    .filter(f => !MIGRATED.includes(f))
    .filter(f => scan(f, fs.readFileSync(path.join(ROOT, f), 'utf8')).length);
console.log(`ℹ️ ④ 還寫死漲跌幅 / 斷崖的探針 ${todo.length} 支(重跑那一支時改):${todo.map(f => f.replace(/^scripts\//, '')).join('、')}`);

console.log(bad ? `\n❌ ${bad} 條失敗` : '\n✅ LIB_LIMIT_PASS');
process.exit(bad ? 1 : 0);
