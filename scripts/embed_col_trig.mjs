#!/usr/bin/env node
/**
 * 📰 V78.4.2 把「有觸發條件的專欄」從 pro.html LAB 抄進 index.html 的 `_COL_TRIG`(散戶 App 決策台「今天碰到的專欄」用)
 *   ⭐ 專欄內容的唯一來源是 pro.html LAB 的 `col`;index.html 不能 import → 用這支抄一份,⛔ 不手改那一行。
 *   ⛔ 只抄「問題 / 怎麼做 / 什麼時候不靈」,⛔ 不抄數字(散戶 App 畫面不放研究數字,V78.3.4);
 *      抄之前每一句都過 `lib_retailbad.mjs`(跟 test_retail_clean 同一份清單),「怎麼做」被擋光 → exit 1。
 *   ⛔ 每個 trig id 必須在 index.html 的 `_COL_TRIG_IDS` 裡,對不上 → exit 1。
 *   🔒 V82.3.3 沒標 👑 的專欄(標題 / 鍵沒有領頭羊字樣)⛔ 在問題 / 怎麼做 / 提醒裡提到領頭羊 → exit 1(沒選 👑 的人也看得到)。
 *   跑法:node scripts/embed_col_trig.mjs            → 寫入 index.html
 *         node scripts/embed_col_trig.mjs --check    → 只比對(test_column 用;抄本跟 pro 不一致就 exit 1)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { badOf } from './lib_retailbad.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRO = path.join(ROOT, 'pro.html'), IDX = path.join(ROOT, 'index.html');
const CHECK = process.argv.includes('--check');
const die = m => { console.error('❌ ' + m); process.exit(1); };

// JSON 物件抓取(字串內的大括號不算)
function objAt(s, i) {
    let depth = 0, ins = false, esc = false;
    for (let j = i; j < s.length; j++) {
        const ch = s[j];
        if (ins) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') ins = false; continue; }
        if (ch === '"') ins = true;
        else if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) return s.slice(i, j + 1);
    }
    throw new Error('unbalanced at ' + i);
}

export function buildColTrig(proSrc, idxSrc) {
    const leadRe = (() => { const m = proSrc.match(/_LEAD_HIDE_RE:\s*\/(.+?)\/,/); return m ? new RegExp(m[1]) : /領頭羊|👑|成交額前 ?100/; })();
    const idsM = idxSrc.match(/_COL_TRIG_IDS:\s*\[([\s\S]*?)\n\s*\],/);
    if (!idsM) throw new Error('index.html 找不到 _COL_TRIG_IDS');
    const ids = new Set([...idsM[1].matchAll(/id:\s*'([^']+)'/g)].map(m => m[1]));
    const cols = [], errs = [], none = [];
    for (const m of proSrc.matchAll(/col: \{"s"/g)) {
        const i = m.index + 5;
        const col = JSON.parse(objAt(proSrc, i));
        const ls = proSrc.lastIndexOf('\n', m.index) + 1, le = proSrc.indexOf('\n', i);
        const line = proSrc.slice(ls, le);
        const k = (line.match(/\bk: '([^']+)'/) || [])[1];
        const r = +((line.match(/\br: (\d+)/) || [])[1] || 0);
        const t = (line.match(/\bt: '([^']*)'/) || [])[1] || '';
        if (!k) { errs.push('有一篇 col 沒有 k:' + line.slice(0, 60)); continue; }
        if (col.trig === 'none') { if (!String(col.trigWhy || '').trim()) errs.push(`${k}:trig 是 'none' 但沒寫 trigWhy`); none.push(k); continue; }
        if (!Array.isArray(col.trig) || !col.trig.length) { errs.push(`${k}:沒有 trig(要嘛寫條件,要嘛寫 'none' + trigWhy)`); continue; }
        for (const id of col.trig) if (!ids.has(id)) errs.push(`${k}:trig '${id}' 不在 index.html 的 _COL_TRIG_IDS`);
        const q = String(col.q || '');
        if (badOf(q).length) errs.push(`${k}:問題句含研究字樣 ${badOf(q)}`);
        const doL = (col.do || []).map(String).filter(d => !badOf(d).length);
        if (!doL.length) errs.push(`${k}:「怎麼做」全部含研究字樣,散戶 App 放不了`);
        const warn = badOf(col.warn || '').length ? '' : String(col.warn || '');
        const lead = leadRe.test(t) || leadRe.test(k);
        // 🔒 V82.3.3 沒標 👑 的專欄,散戶 App 沒選 👑 的人也看得到 → 問題 / 怎麼做 / 提醒 ⛔ 提到領頭羊(V82.3.1 rev-decline 那句就這樣漏出去,test_leakfree 沒觸發到那一篇所以沒抓到)
        if (!lead) { const leak = [q, ...doL, warn].filter(x => leadRe.test(x)); if (leak.length) errs.push(`${k}:沒標 👑 的專欄提到領頭羊(${leak[0].slice(0, 40)}…)—— 沒選 👑 的人也看得到,改寫法`); }
        cols.push({ k, r, myth: col.s === '破解迷思', q, do: doL, warn, trig: col.trig, lead });
    }
    const asof = [...proSrc.matchAll(/"u": "(\d{4}-\d{2}-\d{2})"/g)].map(m => m[1]).sort().pop() || '';
    return { obj: { asof, cols }, errs, none, ids };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const pro = fs.readFileSync(PRO, 'utf8'), idx = fs.readFileSync(IDX, 'utf8');
    const { obj, errs, none } = buildColTrig(pro, idx);
    if (errs.length) die('專欄觸發條件有問題:\n  ' + errs.join('\n  '));
    const line = `    _COL_TRIG: ${JSON.stringify(obj)},`;
    const re = /^    _COL_TRIG: \{.*\},$/m;
    if (!re.test(idx)) die('index.html 找不到 `    _COL_TRIG: {…},` 那一行');
    if (CHECK) {
        const cur = idx.match(re)[0];
        if (cur !== line) die('index.html 的 _COL_TRIG 跟 pro.html 的專欄對不上 → 跑 node scripts/embed_col_trig.mjs');
        console.log(`✅ _COL_TRIG 跟 pro.html 一致(有觸發 ${obj.cols.length} 篇・沒有觸發 ${none.length} 篇)`);
    } else {
        fs.writeFileSync(IDX, idx.replace(re, () => line));
        const back = fs.readFileSync(IDX, 'utf8').match(re);
        if (!back || back[0] !== line) die('寫回後讀不到同一行');
        console.log(`✅ 已寫入 _COL_TRIG:有觸發 ${obj.cols.length} 篇・沒有觸發 ${none.length} 篇・最新 ${obj.asof}`);
    }
}
