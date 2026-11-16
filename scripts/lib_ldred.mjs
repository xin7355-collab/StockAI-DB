/**
 * 🕯️ 「跌停後紅 K」的事件定義 —— 唯一一份(V82.4.1,EXP-20261116-01)
 *
 * streak_probe.mjs(一筆一筆的事件研究)與 ldred_port.mjs(真的拿錢照做的帳戶版)都 import 這裡,
 * ⛔ 兩邊各寫一份門檻 = 帳戶版測的不是事件研究那一條。
 *
 * 定義(V74.4.0 訂的,這裡只是搬家;參數一個都沒改):
 *   跌停        = 當天收盤漲跌 ≤ −(漲跌幅上限 − 0.8)%  → 10% 制度下 = −9.2%
 *   大盤一起跌  = 跌停那天加權漲跌 ≤ −1%(系統性;> −1% = 個股自己出事)
 *   紅 K        = 跌停的下一個交易日收盤比前一天高;大紅 = 漲 ≥ 3%
 *
 * ⚠️ streak_probe 用的是固定 −9.2%(LD_FLAT):2015-06 以前漲跌幅是 7%,那幾年等於一筆跌停都沒有。
 *    帳戶版要用到 2004~2015 → 用 ldTh(日期)跟著制度走(2015-06 起 == LD_FLAT,selftest 釘住)。
 */
import { limitPct } from './lib_limit.mjs';

export const LD_FLAT = -9.2;      // 10% 制度下的跌停門檻(= 10 − 0.8)
export const RED_BIG = 3;         // 大紅 K:收盤漲 ≥ 3%
export const SYS_DROP = -1;       // 加權那天 ≤ −1% 算「大盤一起跌」

/** 那一天的跌停門檻(%):2015-06 起 −9.2、之前 −6.2 */
export const ldTh = date => (limitPct(date) === 10 ? LD_FLAT : -6.2);

/** 跌停?(date 不給 = 固定 −9.2,streak_probe 的舊行為) */
export const isLD = (chgPct, date) => Number.isFinite(chgPct) && chgPct <= (date ? ldTh(date) : LD_FLAT);

/** 大盤一起跌?(mktChg = 跌停那天加權漲跌 %;null = 不知道 → false) */
export const isSystemic = mktChg => mktChg != null && Number.isFinite(mktChg) && mktChg <= SYS_DROP;

/** 跌停後的紅 K 是不是大紅 */
export const isBigRed = chgPct => Number.isFinite(chgPct) && chgPct >= RED_BIG;

export function selftest() {
  let bad = 0; const ok = (c, m) => { if (!c) { bad++; console.log('❌ ' + m); } else console.log('✅ ' + m); };
  ok(ldTh('2020-03-19') === LD_FLAT && ldTh('2015-06-01') === LD_FLAT, '① 2015-06 起門檻 = −9.2(跟 streak_probe 一字不差)');
  ok(ldTh('2015-05-29') === -6.2 && ldTh('2008-10-27') === -6.2, '② 2015-06 以前門檻 = −6.2(漲跌幅 7%)');
  ok(isLD(-9.2, '2022-10-11') && !isLD(-9.19, '2022-10-11'), '③ −9.2 算跌停、−9.19 不算(邊界含等號)');
  ok(isLD(-6.5, '2008-10-27') && !isLD(-6.5, '2022-10-11'), '④ 同樣跌 6.5%:2008 算跌停、2022 不算');
  ok(isLD(-9.5) && !isLD(-7), '⑤ 不給日期 = 固定 −9.2');
  ok(isSystemic(-1) && !isSystemic(-0.99) && !isSystemic(null) && !isSystemic(NaN), '⑥ 大盤一起跌:≤ −1% 才算;不知道 ⛔ 當成有');
  ok(isBigRed(3) && !isBigRed(2.99) && !isBigRed(NaN), '⑦ 大紅:≥ 3%');
  ok(!isLD(NaN, '2022-01-03') && !isLD(undefined), '⑧ 缺值 ⛔ 當跌停');
  console.log(bad ? `\n❌ ${bad} 條沒過` : '\n✅ lib_ldred selftest 全過');
  return bad;
}

if (process.argv[1] && process.argv[1].endsWith('lib_ldred.mjs') && process.argv.includes('--selftest')) process.exit(selftest() ? 1 : 0);
