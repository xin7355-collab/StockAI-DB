#!/usr/bin/env node
/**
 * 📤 把 index.html 裡的 `_SCR_EDGE`(127 條選股條件實測成績)與 `_SCR_CONDS`(條件定義)
 *    匯出成 data/scr_edge.json,給 pro.html(獨立頁、沒辦法 import index.html)讀。
 *
 * ⛔ 唯一真相仍是 index.html —— 這個 JSON 是**產物**,⛔ 不可手改。
 *    scripts/test_fishtank.mjs 會重跑一次匯出並比對,兩邊不一致就紅(同版本號測試 ㊳ 的做法)。
 * ⭐ 只匯出「k/op/v」型的條件(127 條純資料);43 條 `fn` 型的判斷邏輯留在 index.html,
 *    ⛔ 不在 pro.html 重寫一份(那就是第二份真相)。它們的成績仍會匯出(給顯示用),
 *    但 pro.html 算不出來就不算,⛔ 不硬猜。
 * 用法:node scripts/export_scr_edge.mjs [--check]   (--check:只比對不寫檔,不一致 exit 1)
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// 括號配對切片(跳過字串與 // 註解),⛔ 別用 regex 猜結尾 —— 物件裡有巢狀 {} 與含逗號的字串
function slice(startKey, open, close) {
  const i = src.indexOf(startKey); if (i < 0) throw new Error('找不到 ' + startKey);
  let j = i + startKey.length - 1, depth = 0, inStr = null, k = j;
  for (; k < src.length; k++) {
    const ch = src[k], nx = src[k + 1];
    if (inStr) { if (ch === '\\') { k++; continue; } if (ch === inStr) inStr = null; continue; }
    if (ch === '/' && nx === '/') { k = src.indexOf('\n', k); continue; }
    if (ch === '/' && nx === '*') { k = src.indexOf('*/', k) + 1; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return src.slice(j, k + 1); }
  }
  throw new Error('括號不平衡 ' + startKey);
}
const edgeTxt = slice('_SCR_EDGE: {', '{', '}');
const condTxt = slice('_SCR_CONDS: [', '[', ']');
const EDGE = vm.runInNewContext('(' + edgeTxt + ')');
const CONDS = vm.runInNewContext('(' + condTxt + ')');

const conds = CONDS.filter(c => c.k && c.op && c.v !== undefined)
  .map(c => ({ id: c.id, g: c.g, s: c.s, t: c.t, k: c.k, op: c.op, v: c.v, tone: c.tone || null }));
const fnOnly = CONDS.filter(c => !(c.k && c.op)).map(c => c.id);
const out = {
  _note: '由 scripts/export_scr_edge.mjs 從 index.html 產出,⛔ 不可手改;唯一真相在 index.html 的 _SCR_EDGE / _SCR_CONDS',
  meta: { win: EDGE.win, fwd: EDGE.fwd, cost: EDGE.cost, syms: EDGE.syms, n: EDGE.n, base: EDGE.base, decay: EDGE.decay },
  fmt: '[20日超額扣成本後%, 勝率%, 獨立事件數, 六關全過?, 相對對照組pp]',
  conds, fn_only: fnOnly,
  c: EDGE.c,
};
const json = JSON.stringify(out);
const dst = path.join(ROOT, 'data/scr_edge.json');
if (process.argv.includes('--check')) {
  const cur = fs.existsSync(dst) ? fs.readFileSync(dst, 'utf8') : '';
  if (cur !== json) { console.error('❌ data/scr_edge.json 跟 index.html 不一致 → 重跑 node scripts/export_scr_edge.mjs'); process.exit(1); }
  console.log('✅ data/scr_edge.json 與 index.html 一致'); process.exit(0);
}
fs.writeFileSync(dst, json);
const tested = conds.filter(c => EDGE.c[c.id]);
const fnTested = fnOnly.filter(id => EDGE.c[id]).map(id => [id, EDGE.c[id][4]]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
console.log(`✅ 寫出 ${dst} (${(json.length / 1024).toFixed(1)} KB):條件 ${conds.length} 條(有成績 ${tested.length})・fn 型 ${fnOnly.length} 條(有成績 ${fnTested.length})`);
console.log('fn 型裡 |pp| 最大的 8 條(pro.html 算不到):', fnTested.slice(0, 8).map(x => `${x[0]} ${x[1] >= 0 ? '+' : ''}${x[1]}`).join('  '));
console.log('k/op 型 |pp| 前 8:', tested.map(c => [c.id, c.t, EDGE.c[c.id][4]]).sort((a, b) => Math.abs(b[2]) - Math.abs(a[2])).slice(0, 8).map(x => `${x[1]} ${x[2] >= 0 ? '+' : ''}${x[2]}`).join('  '));
