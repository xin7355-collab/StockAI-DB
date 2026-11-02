#!/usr/bin/env node
/**
 * 🏧 V80.2.1 把 fi_outflow_probe.py 的「現在的門檻」寫進 index.html 的 `_FI_OUT`(一行;⛔ 手改)
 *   跑法:DATA_DIR=<d16m_fi> FI_HIST=<fi_mkt_hist.json> US_HIST=<us_hist.json> OUT=fo.json python3 scripts/fi_outflow_probe.py
 *         node scripts/embed_fi_out.mjs fo.json
 *   給觸發專欄「外資提款機的隔天,要不要跟著賣?」(條件 fi_out,`_colTrigEval`):
 *     外資現貨賣超比 spot 還多(億,負數)、或台幣一天貶比 twd 還多(%)= 過去 250 個交易日最多的 5% 那種
 *   交叉驗證(對不上 exit 1):① spot < 0、twd > 0 ② 250 天 / 5% ③ 日期格式 ④ 寫完重新抽出來一樣
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractMember } from './col_rate_base.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IDX = path.join(ROOT, 'index.html');
const die = m => { console.error('❌ ' + m); process.exit(1); };

const f = process.argv[2]; if (!f) die('要給 fi_outflow_probe.py 的 OUT 檔');
const T = (JSON.parse(fs.readFileSync(f, 'utf8')) || {}).thr;
if (!T) die('檔案裡沒有 thr(要用 V80.2.1 以後的 fi_outflow_probe.py 重跑)');
if (!(Number.isFinite(T.spot) && T.spot < 0) || !(Number.isFinite(T.twd) && T.twd > 0)) die(`① 門檻方向不對:spot=${T.spot} twd=${T.twd}`);
if (T.win !== 250 || T.q !== 5) die(`② 不是 250 天 / 5%:win=${T.win} q=${T.q}`);
const iso = /^\d{4}-\d{2}-\d{2}$/;
if (!iso.test(T.spotAsof || '') || !iso.test(T.twdAsof || '')) die(`③ 日期格式不對:${T.spotAsof} / ${T.twdAsof}`);
const out = { spot: T.spot, twd: T.twd, spotAsof: T.spotAsof, twdAsof: T.twdAsof, win: 250, q: 5, src: 'scripts/fi_outflow_probe.py' };
const line = `    _FI_OUT: ${JSON.stringify(out)},`;
let src = fs.readFileSync(IDX, 'utf8');
const re = /\n    _FI_OUT: \{.*\},\n/;
if (!re.test(src)) die('index.html 找不到 `    _FI_OUT: {…},` 那一行(先放一行 `    _FI_OUT: {},`)');
src = src.replace(re, '\n' + line + '\n');
const back = (0, eval)('({' + extractMember(src, '_FI_OUT') + '})')._FI_OUT;
if (back.spot !== out.spot || back.twd !== out.twd) die('④ 寫完重新抽出來對不上');
fs.writeFileSync(IDX, src);
console.log(`✅ _FI_OUT 寫入:外資現貨賣超 < ${out.spot} 億(${out.spotAsof})・台幣一天貶 > ${out.twd}%(${out.twdAsof})`);
