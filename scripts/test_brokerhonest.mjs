#!/usr/bin/env node
/**
 * 🏅 分點卡的誠實話(V77.0.4)
 *
 * 使用者問:「有沒有關鍵分點已經偷偷佈局,我是不是跟著他做就可以了」。
 * ⭐ 本站已經測到底:分點慣性(377 萬筆)/ 分點同盟(467 天×7,140 對)/
 *   分點×產業(546 萬筆)/ 隱形吃貨 —— **全部沒有預測力**,
 *   其中「連買但還沒漲」(= 偷偷佈局)只有 +0.06pp ≈ 零。
 * ⭐⭐ 唯一成立的那條**方向相反**:「已經發動才跟」(連買 ≥3 天 + 5 日已漲 ≥8% → +1.36pp)。
 *
 * 🚨 而 App 裡有四張分點卡還在用推薦口吻,其中「🎯 跟單精選 · 今日最值得跟」最嚴重 ——
 *   它在**主動推薦股票**,而**同一頁**的券商榜底部白紙黑字寫著
 *   「⛔ 這是成績記錄不是買進名單,實測跟著分點做沒有預測力」= 同一頁自己跟自己打架。
 *
 * ⛔ 使用者選的處置是「**保留卡片 + 寫上實測數字**」(⛔ 不下架)——
 *   同 V74.9.0 選股榜 23→10 的做法。
 *
 * ⛔ 這支釘住的是**用意**(⛔ 不釘完整字串 —— 那會讓改文案就紅):
 *   ① 四張卡都要出現「這不是買進名單 / 不是訊號」這類**明確否定**
 *   ② 每張卡都要帶**實測數字**(⛔ 沒有數字的意見不算誠實話)
 *   ③ ⛔ 不可再出現「最值得跟 / 主力共識強」這種**帶方向的推薦語**
 *   ④ 誠實話**只能有一份**(`_BROKER_NOEDGE`)—— ⛔ 各卡各寫一份 = 陷阱 #37
 *   ⑤ 唯一有效那條要寫出**方向**(「已經發動才跟」),⛔ 不可只寫 +1.36pp
 *
 * ⚠️ 斷言**先剝掉註解**再比 —— 本 repo 已踩過 6 次「被自己寫的註解救活」。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 200)}`}`); if (!c) fails.push(n); };

// ⚠️ 剝掉 `//` 行註解與 HTML 註解(⛔ 否則註解裡提到的字會把斷言救活)
const raw = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
// ⚠️ `_CHANGELOG` 整段要排除 —— 更新紀錄**本來就要引用舊文案**才講得清楚改了什麼
//    (「原本寫『今日最值得跟』,已改成…」)。⛔ 不排除的話,寫一筆誠實的更新紀錄反而會讓測試紅。
//    ⭐ 用**區段**排除(`_CHANGELOG: [` 到對應的 `],`),⛔ 不是逐行比 —— 一筆紀錄會跨好幾行。
const cgStart = raw.indexOf('_CHANGELOG: [');
const cgEnd = cgStart >= 0 ? raw.indexOf('\n    ],', cgStart) : -1;
const noCg = (cgStart >= 0 && cgEnd > cgStart) ? raw.slice(0, cgStart) + raw.slice(cgEnd) : raw;
const src = noCg.replace(/<!--[\s\S]*?-->/g, '').split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');

// ── ① 共用誠實話只有一份,而且四個 kind 都在
const kinds = ['conc', 'ally', 'myst', 'follow'];
const hasTable = /_BROKER_NOEDGE:\s*\{/.test(src);
ok('① 誠實話有唯一一份共用表 _BROKER_NOEDGE', hasTable);
for (const k of kinds) ok(`①b _BROKER_NOEDGE 有 ${k} 這一條`, new RegExp(`\\b${k}:\\s*['\`]`).test(src));

// ── ② 每一條誠實話都要帶「實測數字」(pp / 萬 / n= / % 任一)
const tbl = src.slice(src.indexOf('_BROKER_NOEDGE: {'), src.indexOf('_BROKER_ONLY_EDGE'));
for (const k of kinds) {
    const m = new RegExp(`\\b${k}:\\s*'([^']*)'`).exec(tbl);
    const t = m ? m[1] : '';
    ok(`② ${k} 帶實測數字(⛔ 沒有數字的意見不算誠實話)`, /pp|萬筆|萬\(|n=|\d+\s*%/.test(t), t.slice(0, 90));
}

// ── ③ 四張卡都真的呼叫了共用工具(⛔ 寫了工具卻只接一處 = 陷阱 #37)
const calls = (src.match(/_brokerNoEdgeHtml\(/g) || []).length;
ok('③ 共用工具至少被 5 處呼叫(4 張卡 + 券商榜)', calls >= 6, `實際 ${calls} 次(含定義 1 次)`);

// ── ④ ⛔ 不可再有帶方向的推薦語
const banned = [
    ['今日最值得跟', '跟單精選卡的標題'],
    ['主力共識強', '跟單精選卡的結語'],
];
for (const [w, where] of banned) {
    const hits = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => l.includes(w) && !/_CHANGELOG|v: 'V/.test(l));
    ok(`④ ⛔ 不再出現推薦語「${w}」(${where})`, hits.length === 0, hits.map(([n]) => 'L' + n).join(','));
}

// ── ⑤ 唯一有效那條要寫出**方向**(⛔ 只寫 +1.36pp 會被讀成「跟就對了」)
const edge = /_BROKER_ONLY_EDGE:\s*'([^']*)'/.exec(src);
ok('⑤ 唯一有效那條存在且寫出 +1.36pp', !!edge && /1\.36pp/.test(edge[1]));
ok('⑤b 而且寫出方向:「已經發動才跟」⛔ 不是「偷偷跟」', !!edge && /已經發動/.test(edge[1]) && /不是/.test(edge[1]), edge ? edge[1].slice(0, 120) : '');

// ── ⑥ 「這不是買進名單」這句明確否定要在(共用表外的那層)
ok('⑥ 明確否定「不是買進名單」還在', /不是買進名單/.test(src));

console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ BROKERHONEST_PASS');
process.exit(fails.length ? 1 : 0);
