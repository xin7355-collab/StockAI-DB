#!/usr/bin/env node
/**
 * 🗽🎲 V80.2.1 把 trump_post_probe.py 的 OCC_OUT 寫進 index.html 的 `_TRUMP_OCC`(一行;⛔ 手改)
 *   跑法:DEEP=<trump_deep> DATA_DIR=<含 0050.json> OCC_OUT=occ.json python3 scripts/trump_post_probe.py
 *         node scripts/embed_trump_occ.mjs occ.json
 *   這一行給散戶 App「消息面 › 🗽 川普」那一格印發生率(`_trumpPaneHtml`):
 *     就任後(2025-01-20 起)他在台股收盤後到隔天開盤前講到某一類 → 隔天 0050 開盤漲或跌超過 1% 的次數 / 天數,
 *     平常 = 同期全部交易日(⛔ 不是會漲或會跌)。
 *   交叉驗證(對不上 exit 1,⛔ 寫半套進去):
 *     ① 類別 == lib_trump.py 的 CLS + any(⛔ 兩份分類)② 每一類 n ≥ 0、0 ≤ k ≤ n;平常 n ≥ 200
 *     ③ 門檻 th == 1、from == 2025-01-20 ④ 寫完重新抽出來 == 寫進去的那份
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { extractMember } from './col_rate_base.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IDX = path.join(ROOT, 'index.html');
const die = m => { console.error('❌ ' + m); process.exit(1); };

const f = process.argv[2]; if (!f) die('要給 trump_post_probe.py 的 OCC_OUT 檔');
const J = JSON.parse(fs.readFileSync(f, 'utf8'));
const CLS = JSON.parse(execFileSync('python3', ['-c', 'import json, lib_trump; print(json.dumps(list(lib_trump.CLS)))'], { cwd: ROOT, encoding: 'utf8' }));
const want = [...CLS, 'any'];
const got = Object.keys(J.cls || {});
if (want.length !== got.length || want.some(k => !got.includes(k))) die(`① 類別對不上 lib_trump:要 ${want.join(',')}、拿到 ${got.join(',')}`);
const okNK = x => x && Number.isInteger(x.n) && Number.isInteger(x.k) && x.n >= 0 && x.k >= 0 && x.k <= x.n;
if (!okNK(J.base) || J.base.n < 200) die(`② 平常日子不完整或太少:${JSON.stringify(J.base)}`);
for (const k of want) if (!okNK(J.cls[k]) || !J.cls[k].zh) die(`② ${k} 不完整:${JSON.stringify(J.cls[k])}`);
if (J.th !== 1 || J.from !== '2025-01-20' || !/^\d{4}-\d{2}-\d{2}$/.test(J.to || '')) die(`③ 門檻 / 起點 / 終點不對:th=${J.th} from=${J.from} to=${J.to}`);
const out = { from: J.from, to: J.to, th: J.th, base: { n: J.base.n, k: J.base.k }, cls: Object.fromEntries(want.map(k => [k, { n: J.cls[k].n, k: J.cls[k].k, zh: J.cls[k].zh }])), src: 'scripts/trump_post_probe.py(本站 CNN 存檔 trump_deep + 0050 開盤,除息日接回)' };
const line = `    _TRUMP_OCC: ${JSON.stringify(out)},`;
let src = fs.readFileSync(IDX, 'utf8');
const re = /\n    _TRUMP_OCC: \{.*\},\n/;
if (!re.test(src)) die('index.html 找不到 `    _TRUMP_OCC: {…},` 那一行(先放一行 `    _TRUMP_OCC: {},`)');
src = src.replace(re, '\n' + line + '\n');
const back = (0, eval)('({' + extractMember(src, '_TRUMP_OCC') + '})')._TRUMP_OCC;
if (back.base.n !== out.base.n || want.some(k => !back.cls[k] || back.cls[k].n !== out.cls[k].n || back.cls[k].k !== out.cls[k].k)) die('④ 寫完重新抽出來對不上');
fs.writeFileSync(IDX, src);
console.log(`✅ _TRUMP_OCC 寫入:${want.length} 類(${J.from} ~ ${J.to},平常 ${J.base.k}/${J.base.n})・${line.length} 字`);
