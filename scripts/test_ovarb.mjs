#!/usr/bin/env node
/**
 * ⚖️ 仲裁層(V75.0.7 的「一行收斂條」)—— ⚠️ **那張卡 V76.1.2 已經下架、函式也刪了**
 *   (使用者明示;`_ovArbSources` / `_ovArbLine` 整段移除,見 docs/DECISIONS.md V76.1.2)。
 *
 * 🚨 這支從 V76.1.2 起就**每次都 crash**(`app._ovArbLine is not a function`)——
 *    它釘的是「當時的實作」,而那個實作被刻意刪掉了。
 *    ⭐ CLAUDE.md:**永遠紅的測試等於沒有測試** —— 看久了會養成忽略的習慣,真的壞掉那次也會被當成又一個誤報。
 *    → V77.1.4 改成釘**用意**:① 那兩支⛔ 不可復活 ② 它服務的那條鐵則(方向以主卡為準)**沒有廢除**。
 * ⛔ 不刪檔(刪檔要先問使用者);⛔ 也不放寬成「有字就算過」。
 */
import fs from 'node:fs';
const ROOT = '/home/user/StockAI-DB';
const SRC = fs.readFileSync(ROOT + '/index.html', 'utf8');
// ⚠️ 原始碼斷言一律**先剝掉註解**再比(本 repo 已被「自己寫的註解救活斷言」騙過 6 次)
const strip = x => x.replace(/^\s*\/\/.*$/gm, '').replace(/[ \t]+\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const S = strip(SRC);
const fails = [];
const ok = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(x).slice(0, 200)}`); if (!c) fails.push(n); };

ok('⓪ 空過守門:真的讀到 index.html', S.length > 1000000, `len=${S.length}`);
ok('① `_ovArbLine` ⛔ 不可復活(V76.1.2 下架,復活就會多出第二個講方向的聲音)',
   !/_ovArbLine\s*\(/.test(S), (S.match(/.{0,60}_ovArbLine.{0,40}/) || [''])[0]);
ok('② `_ovArbSources` ⛔ 不可復活', !/_ovArbSources\s*\(/.test(S), (S.match(/.{0,60}_ovArbSources.{0,40}/) || [''])[0]);
// ⭐ 卡片下架了,但它服務的那條鐵則沒有廢除 —— 主卡仍然是全 App 方向的唯一真相
ok('③ 「方向以主卡為準」的唯一真相 `_ovTrend` 還在(⛔ 不可跟著卡片一起被清掉)',
   /this\._ovTrend\s*=\s*\{/.test(S) && /_bearGate\s*\(/.test(S), '');
ok('④ 空頭守門 `_bearGate` 仍被多處呼叫(⛔ 不可退回各寫一份判斷式)',
   (S.match(/_bearGate\(/g) || []).length >= 6, `只剩 ${(S.match(/_bearGate\(/g) || []).length} 處`);
ok('⑤ 大盤守門 `_mktGate` 也還在(V75.1.6 追加的第二道)', /_mktGate\s*\(/.test(S), '');

console.log(fails.length ? `\n❌ ${fails.length} 條沒過` : '\n✅ 全部通過');
process.exit(fails.length ? 1 : 0);
