#!/usr/bin/env node
/**
 * 🧪 fin_slice 守門(V76.1.8)—— 每一條先想「注入什麼它會叫」:
 *   ① 累計欄位(ocf/capex/dep)要還原成單季;把累計當單季 → doi/fcf 必須不一樣(⛔ 沒這條就分不出來)
 *   ② doi = inv ÷ 單季 cogs × 90 手算一致
 *   ③ 旗標①:EPS 掉 ≥50% 而營收/毛利沒掉 → 要亮;營收也跌 → 不亮
 *   ④ 旗標②:股本 +30% → 要亮
 *   ⑤ 不足 4 季 → roe4 / fcf4 回 null(⛔ 不硬算)
 *   ⑥ 沒資料一律 null,⛔ 不補 0
 *   ⑦(有真檔時)2330 切得出 12 季、doi 落在合理範圍
 * 跑法:node scripts/test_fin_slice.mjs [--selftest 同義]
 */
import fs from 'fs';
import path from 'path';
import { sliceOne, sliceAll, detectAll } from './fin_slice.mjs';
import { doi } from './lib_fundamentals.mjs';

const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 240)}`}`); if (!c) fails.push(n); };
const FIELDS = ['inv', 'cogs', 'capex', 'dep', 'ocf', 'rev', 'eq', 'cap', 'eps'];
const Q = [];
for (const y of [2023, 2024, 2025]) for (const m of ['03-31', '06-30', '09-30', '12-31']) Q.push(`${y}-${m}`);
// 合成:cogs/rev/eps 單季;ocf/capex/dep 累計(Q1 10、Q2 25、Q3 45、Q4 70 → 單季 10/15/20/25)
const CUMV = { ocf: [10, 25, 45, 70], capex: [-4, -9, -15, -22], dep: [2, 4, 6, 8] };
const mk = (over = {}) => {
    const s = {};
    Q.forEach((q, i) => {
        const k = i % 4;
        const row = { inv: 150, cogs: 100, capex: CUMV.capex[k], dep: CUMV.dep[k], ocf: CUMV.ocf[k], rev: 200, eq: 1000, cap: 1e9, eps: 1.0 };
        Object.assign(row, over[q] || {});
        s[q] = FIELDS.map(f => row[f]);
    });
    return s;
};
const F = { q: Q, f: FIELDS, meta: { updated: '2026-09-07', n: 4, quarters: Q.length, src: 'test' },
    s: { T1: mk(), T2: mk({ '2025-09-30': { eps: 0.4 } }), T3: mk({ '2025-09-30': { eps: 0.4, rev: 120, cogs: 60 } }),
         T4: mk({ '2025-06-30': { cap: 1.4e9 }, '2025-09-30': { cap: 1.4e9 }, '2025-12-31': { cap: 1.4e9 } }) } };
F.s.T5 = Object.fromEntries(Object.entries(mk()).slice(-3));          // 只有 3 季
F.s.T6 = mk(); Object.values(F.s.T6).forEach(r => { r[FIELDS.indexOf('inv')] = null; r[FIELDS.indexOf('ocf')] = null; });

const CUM = detectAll(F);
ok('①a 自動偵測:ocf/capex/dep 判成累計、cogs/rev 判成單季', CUM.ocf && CUM.capex && CUM.dep && !CUM.cogs && !CUM.rev, JSON.stringify(CUM));
const t1 = sliceOne(F, CUM, 'T1');
const q4 = t1.q.find(x => x.p === '2025-12-31'), q1 = t1.q.find(x => x.p === '2025-03-31');
ok('①b 累計 Q4 70 − Q3 45 → 單季 ocf 25;Q1 照原值 10', q4.ocf === 25 && q1.ocf === 10, JSON.stringify([q1.ocf, q4.ocf]));
ok('①c fcf = 單季 ocf + 單季 capex(Q4:25 + (−7) = 18)', q4.fcf === 18, String(q4.fcf));
ok('①d cum_fixed 標出哪些欄位被還原', JSON.stringify(t1.cum_fixed) === JSON.stringify(['capex', 'ocf', 'dep']), JSON.stringify(t1.cum_fixed));
// 🚨 注入:把累計當單季 → 數字必須不一樣(證明這條測試分得出來,⛔ 不是怎麼改都綠)
const wrong = sliceOne(F, { cogs: false, rev: false, capex: false, ocf: false, dep: false }, 'T1');
ok('①e ⭐ 注入「把累計當單季」→ Q4 ocf 變 70、fcf 變 48(跟正確版不同,測試分得出來)', wrong.q.find(x => x.p === '2025-12-31').ocf === 70 && q4.ocf !== 70, String(wrong.q.find(x => x.p === '2025-12-31').ocf));
ok('② doi = inv ÷ 單季 cogs × 90 = 150/100×90 = 135(手算,跟 lib 同一份)', q4.doi === 135 && q4.doi === Math.round(doi(150, 100)), String(q4.doi));
ok('②b 毛利率 (200−100)/200 = 50.0、淨利率 = 1.0×1e8/200 …超過 100% → null(⛔ 不顯離譜值)', q4.gm === 50 && q4.nm === null, JSON.stringify([q4.gm, q4.nm]));
const t2 = sliceOne(F, CUM, 'T2'), t3 = sliceOne(F, CUM, 'T3'), t4 = sliceOne(F, CUM, 'T4');
ok('③a 旗標①:EPS 1.0 → 0.4 而營收/毛利率沒動 → eps_drop_biz 要亮在 2025-09-30', t2.flags.some(f => f.k === 'eps_drop_biz' && f.q === '2025-09-30'), JSON.stringify(t2.flags));
ok('③b 旗標①:EPS 同樣掉但營收也掉 40% → ⛔ 不亮(那是本業變差,不是業外)', !t3.flags.some(f => f.k === 'eps_drop_biz'), JSON.stringify(t3.flags));
ok('③c 沒事的那檔 0 個旗標', t1.flags.length === 0, JSON.stringify(t1.flags));
// 🚨 V76.2.0 面額變更守門(國巨 2025Q3:EPS 9.74 → 3.10、營收毛利反升、股本金額不變 → 股數 ×4,淨利率被算成 1/4)
ok('③d ⭐ 旗標①的文案要寫出「面額變更」這個可能(⛔ 不可只寫業外 —— 那正是 V76.1.8 誤判國巨的原因)', /面額變更/.test(t2.flags.find(f => f.k === 'eps_drop_biz').t), t2.flags[0].t);
const q3 = t2.q.find(x => x.p === '2025-09-30'), q2 = t2.q.find(x => x.p === '2025-06-30'), qL = t2.q[t2.q.length - 1];
ok('③e 🚨 沒有官方淨利時,疑似面額變更那一季起 nm/ni 一律 null 並寫 nm_error(⛔ 不給算錯 4 倍的數字;注入:拿掉守門 → 這條紅)', q3.nm === null && q3.ni === null && /面額/.test(q3.nm_error || '') && qL.ni === null && q2.ni != null && q2.nm_error == null, JSON.stringify([q2.ni, q3.ni, q3.nm_error]));   // ⚠️ 合成測資的 nm 本來就 >100% → 恆 null,要驗就驗 ni(⛔ 別驗一個在這組測資裡永遠是 null 的欄位 = 假綠燈)
ok('③f 那一季之後 roe4 也不硬算(近 4 季有 null 就 null)、shares_note 講清楚從哪一季起', t2.roe4 === null && t2.par_chg_q === '2025-09-30' && /2025-09/.test(t2.shares_note), JSON.stringify([t2.roe4, t2.par_chg_q, t2.shares_note]));
// T7:有官方「稅後淨利」欄(fin_backfill V76.2.0 起)→ 隱含股數 ×4 直接證實 par_chg,淨利率照給(用官方值)
{
    const F2 = JSON.parse(JSON.stringify(F)); F2.f = [...FIELDS, 'ni'];
    const s7 = {}; Q.forEach((q, i) => { const k = i % 4; const par = q >= '2025-09-30';
        const row = { inv: 150, cogs: 100, capex: CUMV.capex[k], dep: CUMV.dep[k], ocf: CUMV.ocf[k], rev: 200, eq: 1000, cap: 1e9, eps: par ? 0.25 : 1.0, ni: 25 };   // 淨利不變 25、EPS ÷4 = 股數 ×4
        s7[q] = F2.f.map(f => row[f]); });
    F2.s = { T7: s7 };
    const t7 = sliceOne(F2, detectAll(F2), 'T7');
    const q7 = t7.q.find(x => x.p === '2025-09-30');
    ok('③g 有官方淨利:ni 用官方值(25)、nm = 12.5%、⛔ 不再 null', q7.ni === 25 && q7.nm === 12.5 && q7.ni_src === 'fs' && q7.nm_error == null, JSON.stringify(q7));
    ok('③h 有官方淨利:亮 par_chg(股數 ×4.0)而**不是** eps_drop_biz(已經分得出來了)', t7.flags.some(f => f.k === 'par_chg' && f.q === '2025-09-30' && /×4\.0/.test(f.t)) && !t7.flags.some(f => f.k === 'eps_drop_biz'), JSON.stringify(t7.flags));
    ok('③i 有官方淨利:shares_note 寫「不用假設面額」、par_chg_q 為 null', /不用假設面額/.test(t7.shares_note) && t7.par_chg_q === null, t7.shares_note);
}
ok('④ 旗標②:股本 10 → 14 億(+40%)→ cap_chg 要亮、之後季別不重複亮', t4.flags.filter(f => f.k === 'cap_chg').length === 1 && t4.flags[0].q === '2025-06-30', JSON.stringify(t4.flags));
const t5 = sliceOne(F, CUM, 'T5');
ok('⑤ 只有 3 季 → roe4 / fcf4 / ni4 一律 null(⛔ 不硬算)', t5.nq === 3 && t5.roe4 === null && t5.fcf4 === null && t5.ni4 === null, JSON.stringify([t5.nq, t5.roe4, t5.fcf4]));
ok('⑤b 12 季齊全 → roe4 = 4×(1.0×1e8) ÷ 1000 … 超過 100% 也照算(ROE 沒有上限守門,由前端標示)', t1.roe4 != null, String(t1.roe4));
const t6 = sliceOne(F, CUM, 'T6');
ok('⑥ inv/ocf 沒資料 → doi / fcf / ocf 一律 null,⛔ 不補 0', t6.q.every(x => x.doi === null && x.fcf === null && x.ocf === null), JSON.stringify(t6.q[0]));
ok('⑥b 每一季都帶法定公布日 pub(Q3 → 11/14)', t1.q.find(x => x.p === '2025-09-30').pub === '2025-11-14', '');
const all = sliceAll(F);
ok('⑥c sliceAll 每檔都切得出來', Object.keys(all.files).length === 6, String(Object.keys(all.files).length));
// ⑦ 真檔(有的話)
const FIN = process.env.FIN || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'fin_deep', 'fin_deep.json');
if (fs.existsSync(FIN)) {
    const R = JSON.parse(fs.readFileSync(FIN, 'utf8'));
    const C = detectAll(R);
    const s = sliceOne(R, C, '2330');
    ok('⑦a 真檔:2330 切出 12 季、累計欄位被還原', s && s.nq === 12 && s.cum_fixed.length >= 2, s && JSON.stringify([s.nq, s.cum_fixed]));
    ok('⑦b 真檔:2330 存貨天數落在 10~400 天(離譜就是把累計當單季)', s && s.q.slice(-4).every(x => x.doi > 10 && x.doi < 400), s && JSON.stringify(s.q.slice(-4).map(x => x.doi)));
    const g = sliceOne(R, C, '2327');
    ok('⑦c 真檔:國巨 2025Q3 亮旗標①(EPS 9.74 → 3.10、營收毛利沒掉),而且文案要提「面額變更」', g && g.flags.some(f => f.k === 'eps_drop_biz' && f.q === '2025-09-30' && /面額變更/.test(f.t)), g && JSON.stringify(g.flags));
    // ⚠️ 第一版斷言寫「國巨股本沒變」→ 真檔當場打臉:2024Q3 股本 42 → 51 億元(+20%,那年的現增),
    //    旗標亮在 2024-09 是**對的**;錯的是我的前提。
    // 🚨🚨 V76.2.0 再更正一次:V76.1.8 我又推論「股本沒變 → 不是股數的事 → 是業外」—— **也是錯的**。
    //    國巨 2025Q3 是**面額 10 → 2.5 元**:股本(元)一毛不變、股數 ×4、EPS ÷4 —— cap_chg 本來就不會亮,
    //    而「EPS × 股本÷10」推的淨利率因此被低估 4 倍。⭐ 「股本(元)沒變」⛔ 不等於「股數沒變」。
    ok('⑦d 真檔:國巨 2025Q3 cap_chg 不會亮(面額變更股本金額不變 —— 這正是它抓不到的原因,所以要靠 ③e 那道守門)', g && !g.flags.some(f => f.k === 'cap_chg' && f.q === '2025-09-30'), g && JSON.stringify(g.flags));
    const g3 = g && g.q.find(x => x.p === '2025-09-30'), g2 = g && g.q.find(x => x.p === '2025-06-30');
    ok('⑦f 🚨 真檔:國巨 2025Q3 起淨利率 null + nm_error(⛔ 不可再顯 4.9% / 5.3%);2025Q2 仍有 15.4%', g && g3.nm === null && /面額/.test(g3.nm_error || '') && g2.nm === 15.4 && g.roe4 === null, g && JSON.stringify([g2.nm, g3.nm, g3.nm_error, g.roe4]));
    ok('⑦e 真檔:國巨 2024Q3 股本 +20%(現增)要亮 cap_chg、而且單位是「億元」', g && g.flags.some(f => f.k === 'cap_chg' && f.q === '2024-09-30' && /億元/.test(f.t)), g && JSON.stringify(g.flags));
} else console.log(`⏭️ 沒有 ${FIN} → 跳過真檔驗證(git show origin/fin_deep:fin_deep/fin_deep.json > fin_deep/fin_deep.json)`);
console.log(fails.length ? `\n❌ ${fails.length} 條失敗:${fails.join(' / ')}` : '\n✅ test_fin_slice 全過');
process.exit(fails.length ? 1 : 0);
