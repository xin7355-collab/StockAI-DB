#!/usr/bin/env node
/**
 * 🚨 同一個物件字面量裡重複定義同名鍵 → **後面那個贏,前面整段變死碼**
 *
 * ⭐ 這是 `check_dup_def.py`(Python 版)的 JS 版本,V74.7.4 實際踩到才寫的:
 *   在 `pro.html` 的 `PRO = { … }` 裡新增了 `FLOW:`,而 4,000 行之後
 *   板塊輪動早就有一個 `FLOW:`(四條法人資金流)→ 我那份**整個變成死碼**,
 *   上下游永遠算出空的,而且**零錯誤訊息、瀏覽器也不會警告**。
 *
 * 掃法:只認**縮排剛好 2 格**的 `  key: `(= `PRO` / `app` 物件的頂層屬性),
 *   ⛔ 巢狀物件與函式內的不算(那些縮排更深)。
 */
import fs from 'fs';
let bad = 0;
// ⚠️ 第一版只看縮排 → 把 `<style>` 裡的 CSS 屬性(background/padding…)全報成重複,17 筆全是誤報。
//   ⭐ 通用:工具報出來的數字,拿去做決策之前要先驗工具本身 → 改成**只掃那個物件字面量的行號範圍**。
for (const [file, indent, opener] of [['pro.html', 2, 'const PRO = {'], ['index.html', 4, 'const app = {']]) {
    const src = fs.readFileSync(file, 'utf8').split('\n');
    const from = src.findIndex(l => l.includes(opener));
    if (from < 0) { console.log(`❌ ${file}: 找不到 \`${opener}\`(空過守門)`); bad++; continue; }
    let to = src.length;
    for (let i = from + 1; i < src.length; i++) if (/^\};?$/.test(src[i])) { to = i; break; }
    const pat = new RegExp(`^ {${indent}}([A-Za-z_$][\\w$]*)\\s*:`);
    const seen = new Map();
    src.slice(from, to).forEach((l, off) => {
        const i = from + off;
        if (/^\s*(\/\/|\*|\/\*)/.test(l)) return;          // ⛔ 註解行不算
        const m = pat.exec(l);
        if (!m) return;
        const k = m[1];
        if (seen.has(k)) {
            console.log(`❌ ${file}: 重複的頂層鍵 \`${k}\` —— L${seen.get(k) + 1} 與 L${i + 1}`);
            console.log(`   🚨 後面那個會贏,前面整段變死碼(而且不會報錯)。`);
            bad++;
        } else seen.set(k, i);
    });
    console.log(`   ${file}: L${from + 1}~L${to} 掃到 ${seen.size} 個頂層鍵`);
    if (seen.size < 20) { console.log(`❌ ${file}: 只掃到 ${seen.size} 個鍵 → 縮排假設可能不對(空過守門)`); bad++; }
}
console.log(bad ? `\n❌ DUP_KEY_FAIL(${bad})` : '\n✅ DUP_KEY_PASS(沒有重複的頂層鍵)');
process.exit(bad ? 1 : 0);
