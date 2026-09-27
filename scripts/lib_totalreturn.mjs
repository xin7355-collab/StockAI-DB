/**
 * 📚 含息(total return)共用工具 —— V74.7.1
 *
 * ⭐ 從 `total_return_probe.mjs` 抽出來的,⛔ 不是新寫一份:
 *   股利再投入的尺標對齊(分割/合併)是很容易寫錯的地方,兩份實作遲早只改到一邊(陷阱 #37)。
 *   抽完照本站規矩**先驗「輸出逐位元組相同」**才准開始用。
 */
import fs from 'fs';
import path from 'path';

export const num = x => (x === null || x === undefined || !Number.isFinite(+x) ? null : +x);
export const d10 = s => String(s || '').replace(/\//g, '-').slice(0, 10);

export function loadPx(dir, sym) {
  const p = path.join(dir, `${sym}.json`);
  if (!fs.existsSync(p)) return null;
  let rows; try { rows = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
  if (!Array.isArray(rows)) return null;
  const out = [];
  for (const r of rows) { const c = num(r.close); if (c !== null && c > 0) out.push({ d: d10(r.date), c }); }
  out.sort((a, b) => a.d < b.d ? -1 : 1);
  return out.length ? out : null;
}

/** 股利尺標對齊:回 {k, why} —— k = 要乘在現金股利上的倍率(⛔ 說不出來的一律排除) */
export function scaleFor(before, closeOnDate) {
  if (!(before > 0) || !(closeOnDate > 0)) return { k: 1, why: 'no-before' };
  const ratio = closeOnDate / before;
  if (ratio > 0.9 && ratio < 1.1) return { k: 1, why: 'same' };
  for (const m of [2, 3, 4, 5, 6, 8, 10]) {
    if (Math.abs(ratio - 1 / m) / (1 / m) < 0.08) return { k: 1 / m, why: `split1:${m}` };
    if (Math.abs(ratio - m) / m < 0.08) return { k: m, why: `merge${m}:1` };
  }
  return { k: null, why: `ratio=${ratio.toFixed(3)}` };
}

/**
 * 🏥 V77.7.1 二代健保「補充保費」(股利所得)—— 回傳這一筆現金股利要被扣的**比例**(0 = 不扣)。
 *   政策時間表(衛福部健保署;⛔ 改法要照「發放日」判,不是持有日):
 *     2013-01-01 起 2.00%,單次給付 ≥ 5,000 元才扣
 *     2016-01-01 起 1.91%,門檻提高到 ≥ 20,000 元
 *     2021-01-01 起 2.11%,門檻 ≥ 20,000 元
 *     單次上限 1,000 萬(本站回測金額碰不到,不處理)
 *   ⚠️ 用「除息日」當發放日的代理(實際發放通常晚 3~6 週,跨到下一個費率年的極少數情況會差一個費率)。
 *   ⚠️ 只管現金股利;股票股利是以**面額**計入補充保費,本站 '權' 紀錄存的是市價差,算不出面額 → 不扣(寫進報告)。
 *   ⛔ 個人綜所稅(合併計稅 8.5% 抵減 / 分開 28%)看每個人的級距,回測不模擬。
 */
export const NHI_TABLE = [['2013-01-01', 0.02, 5000], ['2016-01-01', 0.0191, 20000], ['2021-01-01', 0.0211, 20000]];
export function nhiRate(date, amount) {
  let row = null;
  for (const r of NHI_TABLE) if (String(date) >= r[0]) row = r;
  return row && amount >= row[2] ? row[1] : 0;
}

/**
 * ⭐ 含息**逐日**指數 —— `run()` 只給頭尾兩點,做組合(要每天再平衡/算回撤)必須有整條線。
 * 回 `{d:[], v:[]}`,v 從 1 起算,除息當天以收盤價再投入。
 * ⛔ 配股(type '權')不計 —— 本站價格已還原過分割,再計就重複了。
 */
export function trSeries(bars, divs, opt = {}) {
  // opt.capital + opt.nhi:照「這個帳戶實際領到多少」判二代健保(0050 基準用;不給就跟舊版一字不差)
  const idx = new Map(bars.map((b, i) => [b.d, i]));
  const add = new Map();                       // index → 該天每股現金股利(已對齊尺標)
  for (const [dt, amt, typ, before] of (divs || [])) {
    if (typ === '權') continue;
    const c = num(amt); if (!(c > 0)) continue;
    const D = d10(dt), i = idx.get(D);
    if (i === undefined) continue;
    const { k } = scaleFor(num(before), bars[i].c);
    if (k === null) continue;                  // ⛔ 尺標對不上就排除,不硬算
    add.set(i, (add.get(i) || 0) + c * k);
  }
  const out = { d: [], v: [] };
  let sh = 1;
  for (let i = 0; i < bars.length; i++) {
    let cash = add.get(i);
    if (cash && opt.nhi && opt.capital > 0) {
      const pay = (opt.capital / bars[0].c) * sh * cash;          // 這一次實際領到的元
      cash *= 1 - nhiRate(bars[i].d, pay);
    }
    if (cash) sh += (sh * cash) / bars[i].c;
    out.d.push(bars[i].d);
    out.v.push(sh * bars[i].c / bars[0].c);
  }
  return out;
}
