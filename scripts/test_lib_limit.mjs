#!/usr/bin/env node
/**
 * 📏🧱 test_lib_limit.mjs —— 回測共用的「漲跌幅制度」與「斷崖守門」(V79.4.2,陷阱 #52 / #50)
 *
 * ① lib_limit:2015-06-01 前 ±7%、之後 ±10%;lockedBar 一價到底才算鎖死
 * ② lib_cliff:×1.5 / ×0.67 才算斷崖、只看窗口、開盤跳也算
 * ③ 已經改用共用工具的探針 ⛔ 不可再寫死 9.7 / 1.095 / 整檔剔除(⭐ 決定性對照:把寫死的那行塞回去 → 這條要紅)
 * ④ 還沒改的探針只列出來(⛔ 不擋 —— S2 重跑那一支時才改,改完加進 ③ 的清單)
 */
import fs from 'fs';
import path from 'path';
import { limitOf, lockedBar, LIMIT_CHANGE } from './lib_limit.mjs';
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

// ③ 已經接上共用工具的探針:⛔ 不可再寫死
const MIGRATED = ['dispo_backtest.mjs', 'breakout_exit_probe.mjs', 'leader_probe.mjs'];
const BANNED = [
    [/\*\s*1\.095\b/, '× 1.095(寫死 ±10% 的鎖漲停)'],
    [/>=\s*9\.7\b/, '>= 9.7(寫死 ±10% 的鎖死)'],
    [/d\s*<\s*'2015-06-01'\s*\?\s*0\.07/, '自己再寫一份 2015 的換制度判斷'],
    [/rr\s*>\s*1\.4\s*\|\|\s*rr\s*<\s*0\.6/, '整檔剔除的斷崖判斷'],
];
const strip = src => src.split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');   // 註解裡提到舊寫法不算
const scan = (name, src) => BANNED.filter(([re]) => re.test(strip(src))).map(([, w]) => w);
for (const f of MIGRATED) {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8');
    const hit = scan(f, src);
    ok(`③ ${f}:沒有寫死的漲跌幅 / 斷崖判斷`, hit.length === 0, hit);
    ok(`③ ${f}:有 import 共用工具`, /from '\.\/lib_limit\.mjs'/.test(src), f);
}
// 決定性對照:把舊寫法塞回去要抓得到
ok('③ 決定性對照:塞回「c >= pc * 1.095」→ 抓得到', scan('x', 'if (c >= pc * 1.095) skip++;').length === 1);
ok('③ 決定性對照:註解裡寫舊寫法 → 不算(說明文字可以提)', scan('x', '// 舊版寫死 c >= pc * 1.095').length === 0);

// ④ 還沒改的(只列,⛔ 不擋)
const todo = fs.readdirSync(path.join(ROOT, 'scripts'))
    .filter(f => /(probe|backtest)\.mjs$/.test(f) && !MIGRATED.includes(f))
    .filter(f => scan(f, fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8')).length);
console.log(`ℹ️ ④ 還寫死漲跌幅 / 斷崖的探針 ${todo.length} 支(S2 重跑那一支時改):${todo.join('、')}`);

console.log(bad ? `\n❌ ${bad} 條失敗` : '\n✅ LIB_LIMIT_PASS');
process.exit(bad ? 1 : 0);
