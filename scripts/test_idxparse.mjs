#!/usr/bin/env node
// 🧪 V77.6.7 pro.html 從 index.html「原地解析常數」的守門
//
// 🚨 起因:正式網站(gh-pages)上的 index.html 是**壓縮版**(deploy_pages.yml → scripts/build_min.mjs),
//   整份只有一行、鍵前面是 `,` 不是換行。pro.html 的 `_cutLiteral` 舊寫法要求「換行 + 空白」開頭 →
//   正式網站上 `_SIGNAL_EDGE / _TIDY / _NOISE_GONE / _NOISE_KEEP / _CHANGELOG / _EDGE_RULES` **六個全部解析不到**:
//   🎣 釣魚池寫「🧬 門檻現在讀不到」、雜訊清單與更新紀錄一起空掉。
//   ⚠️ 而 test_fishrod 讀的是**未壓縮原檔** → 永遠綠(陷阱 #40:測試環境 ≠ 正式環境)。
//
// ① 真正的正式產物:`git show origin/gh-pages:index.html`(壓縮版)六個常數都要解析得到、而且跟原檔內容一樣
// ② 合成單行測資:鍵前面是 `,` / `{` 要抓得到;`this._X:` 那種(前面是 `.`)⛔ 不可被當成定義
// ③ 兩個呼叫端同時 loadIdx() → 兩個都要等到資料(⛔ 後到的不可立刻 return 拿到 null)
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

let fail = 0;
const ok = (c, m, d = '') => { console.log((c ? '✅ ' : '❌ ') + m + (d ? ' — ' + d : '')); if (!c) fail++; };

const pro = readFileSync(new URL('../pro.html', import.meta.url), 'utf8');
const grab = name => {
  const m = new RegExp('\\n  ' + name + '\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n  \\},').exec(pro);
  if (!m) throw new Error('pro.html 找不到 ' + name);
  return m[0].trim().replace(/,$/, '');
};
const obj = new Function('return ({' + grab('_cutLiteral') + ',' + grab('loadIdx') + ',' + grab('async _loadIdxOnce') + '})')();
const NAMES = ['_SIGNAL_EDGE', '_TIDY', '_NOISE_GONE', '_NOISE_KEEP', '_CHANGELOG', '_EDGE_RULES'];
const val = (src, n) => { const lit = obj._cutLiteral(src, n); return lit ? new Function('return (' + lit + ')')() : null; };

// ① 正式產物
let gp = null;
try { gp = execSync('git show origin/gh-pages:index.html', { maxBuffer: 64 << 20 }).toString(); } catch (_) {}
const src = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
if (!gp) {
  console.log('⚠️ ① 讀不到 origin/gh-pages:index.html(先 git fetch origin gh-pages)→ 這一條沒驗到');
  fail++;
} else {
  // 空過守門:這一份必須是「舊寫法抓不到」的那種形狀(鍵不在行首),否則①驗的不是壓縮版
  const oldForm = NAMES.filter(n => new RegExp('\\n\\s*' + n + ':\\s*[\\[{]').test(gp));
  ok(oldForm.length === 0, '①0 空過守門:gh-pages 那份真的是壓縮版(六個鍵都不在行首 = 舊寫法會全部抓不到)',
     `${gp.split('\n').length} 行 vs 原檔 ${src.split('\n').length} 行${oldForm.length ? ' ・行首仍有:' + oldForm.join(',') : ''}`);
  const miss = NAMES.filter(n => { try { return val(gp, n) == null; } catch (_) { return true; } });
  ok(!miss.length, '① 壓縮版 index.html 六個常數都解析得到', miss.length ? '解析不到:' + miss.join(',') : '');
  const er = (() => { try { return val(gp, '_EDGE_RULES'); } catch (_) { return null; } })();
  ok(!!(er && er.gene && er.gene.pos != null), '①b 🧬 門檻(_EDGE_RULES.gene)讀得到', er && er.gene ? `pos=${er.gene.pos} amp=${er.gene.amp}` : '');
  const srcEr = val(src, '_EDGE_RULES');
  ok(!!(er && srcEr && JSON.stringify(er.gene) === JSON.stringify(srcEr.gene)), '①c 壓縮版與原檔的 🧬 門檻一模一樣');
}

// ② 合成單行
const one = 'const app={x:1,y:this._EDGE_RULES?1:2,z:a._EDGE_RULES,_EDGE_RULES:{gene:{pos:75,amp:3.2}},_TIDY:[["a","b"]]};';
const e2 = val(one, '_EDGE_RULES');
ok(!!(e2 && e2.gene && e2.gene.pos === 75), '② 單行測資:`,_EDGE_RULES:{` 抓得到', JSON.stringify(e2));
ok(JSON.stringify(val(one, '_TIDY')) === '[["a","b"]]', '②b 單行測資:`,_TIDY:[` 抓得到');
ok(obj._cutLiteral('x={a:b._TIDY:[1]}', '_TIDY') === null, '②c `._TIDY:` 前面是 `.` ⛔ 不可被當成定義');

// ③ 兩個呼叫端同時 loadIdx
const minimal = 'x={_SIGNAL_EDGE:[1],_TIDY:[2],_NOISE_GONE:[3],_NOISE_KEEP:[4],_CHANGELOG:[{v:"V1"}],_EDGE_RULES:{gene:{pos:75}},_APP_VERSION:"V9.9.9"}';
let calls = 0;
globalThis.fetch = async () => { calls++; await new Promise(r => setTimeout(r, 30)); return { ok: true, text: async () => minimal }; };
const A = Object.assign({ _idxData: null, _idxErr: null, _idxLoading: false }, obj);
const seen = [];
await Promise.all([A.loadIdx().then(() => seen.push(!!A._idxData)), A.loadIdx().then(() => seen.push(!!A._idxData))]);
ok(seen.length === 2 && seen.every(Boolean), '③ 兩個呼叫端同時 loadIdx() → 兩個都等到資料(⛔ 後到的不可拿到 null)', JSON.stringify(seen));
ok(calls === 1, '③b 只抓一次 index.html(共用同一個 promise)', `fetch ${calls} 次`);
await A.loadIdx();
ok(calls === 1, '③c 已經有資料就不再抓', `fetch ${calls} 次`);

console.log(fail ? `\n❌ IDXPARSE_FAIL(${fail})` : '\n✅ IDXPARSE_PASS(全部通過)');
process.exit(fail ? 1 : 0);
