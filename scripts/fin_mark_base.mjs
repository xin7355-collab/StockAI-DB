#!/usr/bin/env node
/**
 * 📈 V77.3.0 財報「事實標記」的全市場基準率 —— 報告頁 §4 近 8 季趨勢上那三種圓點
 *
 *   ① 毛利率 QoQ 掉 ≥ TH_GM pp   ② 營業現金流(單季)正 → 負   ③ 存貨天數 QoQ +TH_DOI% 以上
 *
 * 為什麼要量:V77.1.6 的規則 —— **任何旗標先量全市場有幾 % 會亮**。這三個實測都是 13~21% 的常見事件,
 *   → 畫面上一律是「事實紀錄」⛔ 不是警示(不用 ⚠️/紅色),而且**基準率要印在畫面上**。
 * 讀什麼:`data/fin/{sym}.json`(採礦端 `fin_slice.mjs` 切好的 12 季),分母 = 所有「相鄰兩季都有值」的季對季。
 * 用法:node scripts/fin_mark_base.mjs            → 印出三個比例(拿去更新 index.html 的 `_FIN_MARK_BASE`)
 *       node scripts/fin_mark_base.mjs --check    → 跟 index.html 裡嵌的常數比,差 >1pp 就 exit 1(照 embed_signal_edge 的交叉驗證先例)
 * ⛔ 門檻 TH_GM / TH_DOI 是**唯一一份**,`--check` 也會確認 App 常數裡的門檻跟這裡一樣(門檻不同 = 基準率不可比)。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TH_GM = 3;      // pp
export const TH_DOI = 30;    // %

export function markRules(a, b) {
    // a = 前一季、b = 這一季(都是切片裡的一列);回 {gm, ocf, doi} 三個布林 + 各自「可比」與否
    const out = { gm: null, ocf: null, doi: null };
    if (a.gm != null && b.gm != null) out.gm = (b.gm - a.gm) <= -TH_GM;
    if (a.ocf != null && b.ocf != null) out.ocf = a.ocf > 0 && b.ocf < 0;
    if (a.doi != null && b.doi != null && a.doi > 0) out.doi = (b.doi / a.doi - 1) >= TH_DOI / 100;
    return out;
}

export function measure(dir = path.join(ROOT, 'data', 'fin')) {
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^\d{4,6}[A-Z]?\.json$/.test(f)) : [];
    const cnt = { gm: [0, 0], ocf: [0, 0], doi: [0, 0] };
    let nf = 0, pairs = 0;
    for (const f of files) {
        let j; try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { continue; }
        const q = Array.isArray(j.q) ? j.q : [];
        if (q.length < 2) continue;
        nf++;
        for (let i = 1; i < q.length; i++) {
            pairs++;
            const r = markRules(q[i - 1], q[i]);
            for (const k of ['gm', 'ocf', 'doi']) if (r[k] !== null) { cnt[k][1]++; if (r[k]) cnt[k][0]++; }
        }
    }
    const pct = k => cnt[k][1] ? Math.round(cnt[k][0] / cnt[k][1] * 1000) / 10 : null;
    return { files: nf, pairs, gm: { th: TH_GM, base: pct('gm'), hit: cnt.gm[0], n: cnt.gm[1] },
             ocf: { base: pct('ocf'), hit: cnt.ocf[0], n: cnt.ocf[1] },
             doi: { th: TH_DOI, base: pct('doi'), hit: cnt.doi[0], n: cnt.doi[1] } };
}

export function readAppConst(src) {
    const m = /_FIN_MARK_BASE:\s*(\{[^\n]*\})/.exec(src);
    if (!m) return null;
    try { return Function(`return (${m[1]})`)(); } catch (_) { return null; }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
    const R = measure();
    if (R.files < 500) { console.error(`🚨 data/fin 只有 ${R.files} 檔(<500)→ 基準率不可信,⛔ 不印結論`); process.exit(1); }
    console.log(`📈 財報事實標記的全市場基準率(${R.files} 檔 ・${R.pairs.toLocaleString()} 個季對季)`);
    console.log(`   毛利率 QoQ 掉 ≥${TH_GM}pp:${R.gm.base}%(${R.gm.hit.toLocaleString()}/${R.gm.n.toLocaleString()})`);
    console.log(`   營業現金流 正→負:${R.ocf.base}%(${R.ocf.hit.toLocaleString()}/${R.ocf.n.toLocaleString()})`);
    console.log(`   存貨天數 +${TH_DOI}% 以上:${R.doi.base}%(${R.doi.hit.toLocaleString()}/${R.doi.n.toLocaleString()})`);
    const today = new Date().toISOString().slice(0, 10);
    console.log(`\n   _FIN_MARK_BASE: { gm: { th: ${TH_GM}, base: ${R.gm.base} }, ocf: { base: ${R.ocf.base} }, doi: { th: ${TH_DOI}, base: ${R.doi.base} }, n: ${R.pairs}, files: ${R.files}, asof: '${today}' },`);
    if (process.argv.includes('--check')) {
        const A = readAppConst(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'));
        if (!A) { console.error('🚨 index.html 裡找不到 `_FIN_MARK_BASE`'); process.exit(1); }
        const bad = [];
        if (A.gm.th !== TH_GM || A.doi.th !== TH_DOI) bad.push(`門檻不同:App gm ${A.gm.th}/doi ${A.doi.th} vs 這裡 ${TH_GM}/${TH_DOI}`);
        for (const k of ['gm', 'ocf', 'doi']) if (Math.abs((A[k] || {}).base - R[k].base) > 1) bad.push(`${k}:App ${(A[k] || {}).base}% vs 實測 ${R[k].base}%`);
        if (bad.length) { console.error(`\n❌ --check 不符(差 >1pp 或門檻不同):\n   ${bad.join('\n   ')}\n   → 把上面那行貼回 index.html`); process.exit(1); }
        console.log(`\n✅ --check:App 常數(asof ${A.asof})與實測一致(差 ≤1pp)`);
    }
}
