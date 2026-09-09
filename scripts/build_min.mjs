#!/usr/bin/env node
/**
 * 部署產物壓縮(OPTIMIZATION_PLAN P2-3,V71.0.8)。
 *
 * 【只在部署時跑,原始碼永遠保留註解】
 * index.html 的 inline <script> 佔全檔絕大部分,其中註解 + 縮排約佔 26%。
 * 這支用 esbuild 真正的 JS parser 壓縮那段 script(⛔ 絕不用「刪掉 // 開頭的行」
 * 那種土法 —— 樣板字串裡本來就有以 // 開頭的中文說明文字,裸刪會把使用者看得到的
 * 文案一起刪掉,而且不會有語法錯誤,壞了也看不出來)。
 *
 * 【安全設計】
 * ・只動「最大的那個 inline <script>」(主程式),其餘 script / HTML / CSS 一律不碰。
 * ・keepNames:true — 保留函式名。onclick="app.xxx()" 是字串,壓縮器看不到,
 *   改名就全壞;這個選項是本專案的硬需求,不可拿掉。
 * ・壓完自動驗證:① esbuild 沒吐 error ② 產物能被 node 解析 ③ 體積有變小但沒小過頭
 *   ④ 抽樣比對關鍵字串(版本號、幾個 onclick 名)還在。任何一項不過就 exit 1,
 *   讓部署失敗而不是推出壞版本。
 *
 * 用法:node scripts/build_min.mjs <來源 index.html> <輸出檔>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const [, , SRC = 'index.html', OUT = 'index.min.html'] = process.argv;

let esbuild;
try {
  esbuild = require('esbuild');
} catch {
  console.error('❌ 找不到 esbuild(部署環境需先 npm i esbuild)');
  process.exit(1);
}

const html = readFileSync(SRC, 'utf8');

// ── 找出最大的 inline <script>(= 主程式)────────────────────────────────
const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi;
let best = null, m;
while ((m = re.exec(html)) !== null) {
  if (!best || m[2].length > best.code.length) best = { i: m.index, len: m[0].length, attrs: m[1], code: m[2] };
}
if (!best || best.code.length < 100000) {
  console.error('❌ 找不到主 inline script(或異常小),不壓縮以策安全');
  process.exit(1);
}

const before = Buffer.byteLength(html);
const codeBefore = Buffer.byteLength(best.code);

let res;
try {
  res = await esbuild.transform(best.code, {
    loader: 'js',
    minify: true,
    keepNames: true,       // ⚠️ 硬需求:onclick="app.xxx()" 是字串,改名即全壞
    legalComments: 'none',
    target: 'es2020',      // 對齊既有寫法(?. / ?? / BigInt 等),不做過度降轉
    charset: 'utf8',       // ⚠️ 必要:esbuild 預設 'ascii' 會把全部中文轉成 \uXXXX
                           //    → 功能相同但體積反而變大、且完全不可讀。本專案幾乎全中文,務必 utf8。
  });
} catch (e) {
  console.error('❌ esbuild 壓縮失敗:', e.message);
  process.exit(1);
}

const minHtml = html.slice(0, best.i) + `<script${best.attrs}>` + res.code + '</script>' + html.slice(best.i + best.len);
const after = Buffer.byteLength(minHtml);
const codeAfter = Buffer.byteLength(res.code);

// ── 驗證關卡(任何一項不過就讓部署失敗)──────────────────────────────
const fail = (msg) => { console.error('❌ ' + msg); process.exit(1); };

// ① 產物 JS 能被解析
try { new Function(res.code); } catch (e) { fail('壓縮後 JS 無法解析:' + e.message); }

// ② 體積要變小,但不能小過頭(小於一半 = 十之八九吃掉了東西)
if (codeAfter >= codeBefore) fail('壓縮後反而變大,放棄');
if (codeAfter < codeBefore * 0.4) fail(`壓縮後只剩 ${(codeAfter / codeBefore * 100).toFixed(0)}%,疑似內容被吃掉`);

// ③ 關鍵字串抽樣(版本號 + 幾個一定要活著的 onclick 目標 + 使用者看得到的文案)
const ver = (html.match(/_APP_VERSION:\s*'([^']+)'/) || [])[1];
const MUST = [ver, 'renderSectorGapTable', '_brokerEl', '_renderGuardRuler',
               '_scheduleChart', 'renderDayTradeTab', '偷布局', '防守價一覽'].filter(Boolean);
const missing = MUST.filter(s => !minHtml.includes(s));
if (missing.length) fail('壓縮後遺失關鍵字串:' + missing.join(', '));

// ④ HTML 部分不可被動到(只換 script 內容,前後長度差應等於 script 的差)
const htmlDelta = before - after, codeDelta = codeBefore - codeAfter;
if (Math.abs(htmlDelta - codeDelta) > 64) fail(`HTML 區段被動到(差 ${htmlDelta - codeDelta} bytes)`);

writeFileSync(OUT, minHtml);
const pct = (1 - after / before) * 100;
console.log(`✅ 壓縮完成:${(before / 1024).toFixed(0)} KB → ${(after / 1024).toFixed(0)} KB(省 ${pct.toFixed(1)}%)`);
console.log(`   inline script:${(codeBefore / 1024).toFixed(0)} KB → ${(codeAfter / 1024).toFixed(0)} KB`);
console.log(`   4 道驗證全過(可解析 / 體積合理 / 關鍵字串齊全 / HTML 未被動)`);
