#!/usr/bin/env node
/**
 * 🚨 inline onclick 裡「內插進去的字串」不可含真換行(V73.3.1,使用者截圖抓到)
 *
 * 症狀:點某個元素 → `SyntaxError: Unexpected EOF`,位置 `?source=pwa:1`。
 *   ⚠️ 極易誤診成「檔案被截斷」(陷阱 #20)—— 但那次自我檢查會說「文件**不**完整」,
 *      這次說的是「**文件完整(3390KB)**」→ 檔案好好的,是**那一段 handler 語法錯**。
 *   ⚠️ 而且它**不會在載入時報錯**,只有「點下去那一刻」才炸
 *      → smoke_test / page_sweep 全部抓不到。
 *
 * ⛔⛔ 最重要的一條 —— **不是所有 `\n` 都有問題**:
 *   ・HTML 原始碼裡直接寫 `onclick="alert('第一行\n第二行')"` → ✅ **完全合法**
 *     (那是反斜線+n 兩個字元,JS 會把它當跳脫字元)。全檔有 ~29 處都是這種,⛔ 不可報。
 *   ・出問題的是**樣板內插**:`` `onclick="…('${opt.why}')…"` `` 而 `opt.why` 的值是
 *     JS 字面字串 `'…\n…'` → 執行期展開成**真的換行字元**塞進屬性
 *     → JS 的單引號字串不能跨行 → Unexpected EOF。
 *   🚨 我的第一版就是沒分清這兩者,誤報 29 筆 —— 而 CLAUDE.md 明寫
 *      「誤報會讓人養成無視守門的習慣」,所以那版直接丟掉。
 *
 * ⭐ 正解:**文字不要放進 HTML 屬性**,存進 JS 物件、onclick 只傳 key
 *   (`app._showIdxWhy('twoii')`)。⛔ 只跳脫換行是治標 —— 引號、反斜線、`</script>`
 *   還有一堆邊界。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELFTEST = process.argv.includes('--selftest');
const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function scan(text) {
    const bad = [];
    const lines = text.split('\n');
    lines.forEach((ln, i) => {
        // 找 onclick="…${…}…"(樣板字串產出的 HTML)
        const re = /onclick=\\?"[^"]*?\$\{([^}]{1,200})\}/g;
        let m;
        while ((m = re.exec(ln))) {
            const expr = m[1].trim();
            // (a) 直接內插一個含 \n 的字面字串:`${'…\n…'}`
            if (/^['"`]/.test(expr) && /\\n/.test(expr)) {
                bad.push([i + 1, `onclick 直接內插了含換行的字面字串`, expr.slice(0, 70)]);
                continue;
            }
            // (b) 內插一個變數/屬性,而它在同檔被賦值成含 \n 的字面字串
            const idm = expr.match(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/);
            if (!idm) continue;
            const prop = expr.split('.').pop();
            const asProp = new RegExp(`(?:^|[{,\\s])${prop}\\s*:\\s*(['"])(?:(?!\\1)[^\\\\]|\\\\.)*?\\\\n`, 'm');
            const asVar = new RegExp(`(?:const|let|var)\\s+${prop}\\s*=\\s*(['"])(?:(?!\\1)[^\\\\]|\\\\.)*?\\\\n`, 'm');
            if (asProp.test(text) || asVar.test(text)) {
                bad.push([i + 1, `onclick 內插了 \`${expr}\`,而它被賦值成含換行的字串`, '']);
            }
        }
    });
    return bad;
}

// 🚧 自我驗證:注入已知缺陷,確認它真的叫得出來(⛔「沒有報錯」不能當成「檢查過了」)
if (SELFTEST) {
    const inj1 = 'const h = `<b onclick="alert(\'${\'第一行\\n第二行\'})">x</b>`;';
    const inj2 = 'const o = { why: \'甲\\n乙\' };\nconst h2 = `<b onclick="alert(\'${o.why}\')">x</b>`;';
    const okSrc = '<button onclick="alert(\'第一行\\n第二行\')">合法</button>';
    const r1 = scan(inj1), r2 = scan(inj2), r3 = scan(okSrc);
    console.log(`   注入①(直接內插含換行字面) → ${r1.length ? '✅ 抓到' : '❌ 沒抓到'}`);
    console.log(`   注入②(內插變數,變數含換行) → ${r2.length ? '✅ 抓到' : '❌ 沒抓到'}`);
    console.log(`   對照組(HTML 原始碼的 \\n,合法) → ${r3.length ? '❌ 誤報!' : '✅ 沒誤報'}`);
    if (!r1.length || !r2.length || r3.length) { console.log('❌ 自我驗證失敗'); process.exit(1); }
}

/*
 * 🤦 第二種同族邊界(V73.3.1 我自己當場踩到,寫在這裡當紀錄):
 *   <script> 區塊裡**連註解都不能出現它的結束標籤** —— HTML 解析器看不懂 JS 註解,
 *   看到就當場把 script 切斷 → 後面全變 HTML 文字 → 全 App 白畫面
 *   + `SyntaxError: Unexpected end of input`。
 *   ⚠️ 我就是在寫「別想靠跳脫解決」那句註解時,把它打進括號裡而爆掉的。
 *
 * ⛔ 這一類**不在這支檢查** —— `smoke_test.mjs`(四驗證第 1 項)本來就抓得到
 *    (它是**載入時**就爆,實測當場報 `no app object` + `Unexpected end of input`)。
 *    我原本寫了一個 regex 版,但非貪婪比對會停在第一個結束標籤 → **抓不到**;
 *    ⛔ 與其留一個半殘的偵測器(那比沒有更糟 —— 會讓人以為檢查過了),不如講清楚誰負責。
 */
const bad = scan(src);
if (bad.length) {
    console.log('❌ 🚨 inline onclick 內插了含換行的字串 → 點下去會 SyntaxError: Unexpected EOF');
    for (const [n, why, ctx] of bad) console.log(`   • L${n}  ${why}${ctx ? `\n     ${ctx}` : ''}`);
    console.log("   → ⭐ 修法:文字存進 JS 物件,onclick 只傳 key(例:app._showIdxWhy('twoii'))");
    process.exit(1);
}
console.log('✅ inline onclick 沒有內插含換行的字串(點下去不會 SyntaxError)');
