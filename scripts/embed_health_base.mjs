#!/usr/bin/env node
/**
 * 🩺 V82.0.6 把 health_base.mjs 的產物嵌進 pro.html 的 `_HEALTH_BASE`(一行;體檢頁第 2 節 D「這一波在歷史裡算不算正常」讀它)
 *   交叉驗證(⛔ 對不上就 exit 1、pro.html 一個字都不改):三套都在、每個天數都有 11 個百分位而且由小到大、
 *   👑 / 🅿️ 各 17 條、封存日與失效規則有寫、讀回來跟產物逐字相同
 *   用法:node scripts/embed_health_base.mjs out.json   ・   node scripts/embed_health_base.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRO = path.join(ROOT, 'pro.html');
const ANCHOR = '  _RISK_MENU: {';

export function check(H) {
    const errs = [];
    for (const k of ['lead', 'park', '0050']) {
        const b = H.s && H.s[k];
        if (!b) { errs.push(`沒有 ${k}`); continue; }
        if (k !== '0050' && b.paths < 17) errs.push(`${k} 只有 ${b.paths} 條`);
        for (const W of H.wins || []) {
            const q = b.q && b.q[W];
            if (!Array.isArray(q) || q.length !== (H.lv || []).length) { errs.push(`${k} 連續 ${W} 天的百分位不齊`); continue; }
            for (let i = 1; i < q.length; i++) if (!(q[i] >= q[i - 1])) { errs.push(`${k} 連續 ${W} 天的百分位沒有由小到大`); break; }
        }
        if (!Array.isArray(b.segs)) errs.push(`${k} 沒有回撤段`);
    }
    if (!H.seal || !H.rule || !(H.rule.every > 0) || !(H.rule.below > 0) || !(H.rule.times > 0)) errs.push('沒有封存日或失效規則');
    if (!Array.isArray(H.wins) || !H.wins.includes(21)) errs.push('天數裡沒有 21(失效規則要用)');
    return errs;
}

export function embed(html, H) {
    const line = `  _HEALTH_BASE: ${JSON.stringify(H)},\n`;
    const re = /^  _HEALTH_BASE: .*,\n/m;
    if (re.test(html)) return html.replace(re, () => line);
    const i = html.indexOf(ANCHOR);
    if (i < 0) throw new Error(`pro.html 找不到 ${ANCHOR.trim()}(插入位置)`);
    return html.slice(0, i) + line + html.slice(i);
}

function selftest() {
    let ok = 0, bad = 0; const t = (c, m) => { console.log((c ? '  ✅ ' : '  ❌ ') + m); c ? ok++ : bad++; };
    const q = [-0.2, -0.15, -0.1, -0.05, -0.02, 0.01, 0.04, 0.08, 0.11, 0.14, 0.2];
    const B = (k, paths) => ({ k, paths, q: { 5: q, 21: q }, segs: [] });
    const H = { seal: '2026-11-07', rule: { every: 21, below: 2.5, times: 2 }, wins: [5, 21], lv: q.map((_, i) => i), s: { lead: B('lead', 17), park: B('park', 17), '0050': B('0050', 1) } };
    t(check(H).length === 0, '① 合格的產物 → 沒有錯');
    t(check({ ...H, s: { ...H.s, park: B('park', 5) } }).some(e => /park 只有 5/.test(e)), '② 🅿️ 只有 5 條 → 擋下');
    const qq = q.slice(); qq[3] = 0.5;
    t(check({ ...H, s: { ...H.s, lead: { ...B('lead', 17), q: { 5: q, 21: qq } } } }).some(e => /由小到大/.test(e)), '③ 百分位沒有由小到大 → 擋下');
    t(check({ ...H, rule: null }).some(e => /失效規則/.test(e)), '④ 沒寫失效規則 → 擋下');
    const html0 = 'x\n  _RISK_MENU: {\n  a: 1,\n';
    const h1 = embed(html0, H), h2 = embed(h1, { ...H, seal: '2027-01-01' });
    t(h1.includes('  _HEALTH_BASE: {') && h1.indexOf('_HEALTH_BASE') < h1.indexOf('_RISK_MENU') && (h2.match(/_HEALTH_BASE/g) || []).length === 1 && h2.includes('2027-01-01'),
        '⑤ 第一次插在 _RISK_MENU 前面、第二次換掉同一行(⛔ 不會變兩行)');
    console.log(`\n${bad ? '❌' : '✅'} selftest ${ok}/${ok + bad}`);
    return bad ? 1 : 0;
}

function main() {
    const src = process.argv[2];
    if (!src) { console.error('用法:node scripts/embed_health_base.mjs out.json'); process.exit(1); }
    const H = JSON.parse(fs.readFileSync(src, 'utf8'));
    const errs = check(H);
    if (errs.length) { console.error('❌ 產物不合格:\n  ' + errs.join('\n  ')); process.exit(1); }
    const html = fs.readFileSync(PRO, 'utf8'), out = embed(html, H);
    const back = out.match(/^  _HEALTH_BASE: (.*),\n/m);
    if (!back || back[1] !== JSON.stringify(H)) { console.error('❌ 讀回來對不上,pro.html 不改'); process.exit(1); }
    fs.writeFileSync(PRO, out);
    console.log(`✅ _HEALTH_BASE 寫進 pro.html(${(JSON.stringify(H).length / 1024).toFixed(1)} KB)・封存日 ${H.seal}・👑 ${H.s.lead.from}~${H.s.lead.to}`);
}

const _isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (_isMain && process.argv.includes('--selftest')) process.exit(selftest());
else if (_isMain) main();
