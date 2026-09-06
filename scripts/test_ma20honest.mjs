#!/usr/bin/env node
/**
 * 📉 「跌破月線」文案誠實度測試(V71.9.2)
 *
 * 逐字稿(權證小哥)整段在嗆「跌破月線就停損」:
 *   「站上月線買進、跌破月線賣出…你不知道停損多少次」「你的停損點就是我的買點」
 *
 * `ma20_probe.py` 用 2,227 檔、38,923 次跌破實測(報酬扣同期加權、10 日去重):
 *   ① 跌破組 vs 沒跌破組:20 日只差 **−0.11pp** → 幾乎沒有鑑別力
 *   ② **69.2% 在 10 個交易日內又站回月線**(5 日內 55.3%)→ 他這句話成立
 *   ③ ❌ 但他說的「低檔破月線是買點」**不成立**(低位階 −4.27% 比高位階 −3.65% 還差)
 *   ④ ⏳ **大盤**自己跌破月線只有 6 次 → 樣本不足,所以 regime 降級邏輯**不動**
 *
 * 這支釘住「不可把跌破月線寫成賣訊/停損訊號」,以及「不可反向照抄他的低檔買點說法」。
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'index.html'), 'utf-8');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 200)}`}`); if (!c) fails.push(n); };

// ── ① 盤中推播:⛔ 不可再叫「中線停損警告」──────────────────────
const alertLine = (src.match(/trigger\('dn20'[^\n]*/) || [''])[0];
ok('① 找得到 dn20 推播那一行', !!alertLine);
ok('① ⛔ 推播不可寫「停損警告」(69% 會站回,叫人砍是錯的)',
   !/停損警告/.test(alertLine), alertLine);
ok('① ⭐ 推播要帶實測基準率(69% / 10 天)',
   /69%/.test(alertLine) && /10\s*天/.test(alertLine), alertLine);
ok('① 要明說「不是賣訊」', /不是賣訊/.test(alertLine), alertLine);

// ── ② 教學卡:要把實測數字寫出來,不能只說「不等於必賣」──────────
const teach = (src.match(/模組 C 淘汰選股法[\s\S]{0,1400}/) || [''])[0];
ok('② 教學卡有帶樣本數 38,923', /38,923/.test(teach), teach.slice(0, 300));
ok('② 教學卡有帶 69%', /69%/.test(teach));
ok('② 教學卡有帶「差 0.11%」(說明幾乎沒鑑別力)', /0\.11/.test(teach));
ok('② ⭐ 要講到來回成本 0.44%(頻繁停損真正的殺傷力)', /0\.44/.test(teach));
ok('② 要給建議而不是只講問題', /建議/.test(teach));

// ── ③ ⛔ 不可反向照抄「低檔破月線是買點」(實測不成立)──────────────
// ⚠️ 只抓「主張」,不抓「引用後打臉」—— 更新紀錄裡寫『他說「低檔破月線反而是買點」→ 我實測不成立』
//    是正確的寫法。判斷方式:同一句話裡有沒有跟著否定詞。
const claims = (src.match(/[^。<>\n]{0,40}破月線[^。<>\n]{0,14}(?:是|為)[^。<>\n]{0,8}買點[^。<>\n]{0,30}/g) || [])
    .filter(s => !/不成立|沒有比較好|實測.{0,6}不|不是|別照抄|不會叫你|refut/.test(s));
ok('③ ⛔ 不可主張「破月線是買點」(引用後打臉的寫法可以)',
   claims.length === 0, claims.join(' | '));

// ── ④ ⭐ regime(大盤)那條**不准動** —— 大盤只有 6 次事件,樣本不足 ────
// 個股的結論不可越推到大盤:指數是一籃子、雜訊被平均掉,均線行為跟個股不同。
ok('④ ⭐ 大盤 regime 的「破月線降級」仍在(個股結論不可越推到大盤)',
   /破月季線|已破月線\+季線|破月線與季線|破月線\+季線/.test(src));

// ── ⑤ 註解要留下依據,免得日後被改回去 ─────────────────────
ok('⑤ 程式碼註解要指向 ma20_probe.py / CLAUDE.md',
   /ma20_probe\.py/.test(src), '找不到依據註解');
ok('⑤ 註解要寫「別改回停損警告」', /別改回「停損警告」|⛔ 別改回/.test(src));

console.log('');
if (fails.length) { console.log(`❌ MA20HONEST_TEST_FAIL: ${JSON.stringify(fails)}`); process.exit(1); }
console.log('✅ MA20HONEST_TEST_PASS');
