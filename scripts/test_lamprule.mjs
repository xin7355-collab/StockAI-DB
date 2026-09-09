#!/usr/bin/env node
/**
 * 🚦 燈號鐵則巡邏(V74.8.8)—— 使用者:「台股紅漲綠跌會搞混,幫我用別的方式呈現」
 *
 * ⭐ 鐵則(CLAUDE.md V70.2.8 使用者明示):
 *   ① 🔴🟢 **只准表示「漲跌方向」**(🔴=漲/偏多、🟢=跌/偏空)
 *   ② **風險/好壞/通過與否**一律用非顏色圖示:✅ ⚠️ ⛔ 🚨 ➖ ⏳ 💡 📍
 *   ③ 文字顏色仍照台股慣例(紅漲綠跌),**只有 emoji 改**
 *
 * 🚨 為什麼要有這支:V74.8.8 掃出 **29 處**違反,其中最嚴重的是
 *   「🟢 現在可進場」「🟢 續抱」「🟢 偏多」—— **台股綠色是跌**,使用者會直接看反。
 *   而且有幾處 emoji 與文字色**自己打架**(🟢 配 text-red-300)。
 *   ⛔ 這種錯不會報錯、測試也抓不到 —— 只能靠巡邏。
 *
 * ⛔ 例外(⭐ 白名單,只有這一類):**國發會景氣對策信號**是官方名稱
 *   (紅燈=過熱、綠燈=穩定),⛔ 不可改名(改了使用者查不到官方資料),
 *   但顯示時必須帶「官方」兩個字,讓它跟本站的紅漲綠跌區分開。
 *
 * ⚠️ regex 一律加 u flag —— 不加會把 emoji 拆成 surrogate 半碼,🔄 會被誤判成 🔴。
 */
import fs from 'fs';
import path from 'path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

let fails = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log(`✅ ${name}`);
  else { fails++; console.log(`❌ ${name}${extra ? '  ' + extra : ''}`); }
};

// 🟢 不可配的詞(那些是「好」不是「跌」)
const POS = /(偏多|可以買|可進場|續抱|加碼|安定|燃料飽|健康|通過|安全|有資料|新進|良好|乾淨|齊發|買點|做多)/;
// 🔴 不可配的詞(那些是「壞」不是「漲」)
const NEG = /(偏空|賣出|避開|停損出場|過熱|不足|危險|警報|沒資料|落跑|跑了|失敗|錯誤|全忙|凌亂|三降|處置中|做頭|別買)/;
const OFFICIAL = /官方(紅燈|綠燈|藍燈|黃藍|黃紅)/;   // ⭐ 國發會官方燈號,唯一例外

function scan(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
  const bad = [];
  src.forEach((raw, idx) => {
    // ⭐⭐ 被「」框起來的是在**引用**(舉例說明「以前寫錯的那句」),⛔ 不是在**使用**
    //    —— 本專案第 16 次踩「正確的句子本身含有被禁的字」;
    //    ⛔ 用「排除整行」會太寬(同一行後面真的用錯也會被放過),所以只剝引號內的。
    const t = raw.trim().replace(/「[^」]{0,60}」/g, '「…」');
    // ⛔ 註解不算(說明「為什麼不用 🟢」的註解本身含 🟢 —— 本專案已踩過 13 次)
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--')) return;
    if (OFFICIAL.test(t)) return;
    // ⛔ 回測成績表是**資料**不是文案(訊號名稱本來就含「買點」「偏多」)
    if (/^_(SIGNAL_EDGE|SCR_EDGE|PLAYBOOK_EDGE|LU_ODDS|EXIT_EDGE):/.test(t)) return;
    // ⛔ 更新紀錄是**決策紀錄**,它會引用「以前寫錯的那句」當例子
    //    (本專案第 15 次踩「正確的句子本身含有被禁的字」—— 這條就是那次補的)
    if (/^\{\s*v:\s*'V[\d.]+'/.test(t)) return;
    // 🚨 先剝掉否定形 —— 「🟢 金剛偏空 = **別做多**」是**對的**,但字面含「做多」
    //    (本專案第 14 次踩「正確的否定句本身含有被禁的字」這個坑)
    const strip = x => x.replace(/(別|不宜|不要|不可|禁止|勿|嚴禁|⛔)[^,。;、\s]{0,6}/g, '');
    for (const m of t.matchAll(/🟢[^🔴🟡🟠⚪🔵]{0,14}/gu))
      if (POS.test(strip(m[0]))) bad.push({ line: idx + 1, kind: '🟢 被拿來表示「好」', txt: t.slice(0, 110) });
    for (const m of t.matchAll(/🔴[^🟢🟡🟠⚪🔵]{0,14}/gu))
      if (NEG.test(strip(m[0]))) bad.push({ line: idx + 1, kind: '🔴 被拿來表示「壞」', txt: t.slice(0, 110) });
  });
  // 去重(同一句話可能在教學與渲染各出現一次)
  const seen = new Set(), out = [];
  for (const b of bad) { if (seen.has(b.txt)) continue; seen.add(b.txt); out.push(b); }
  return out;
}

for (const f of ['index.html', 'pro.html']) {
  const bad = scan(f);
  ok(`① ${f}:🔴🟢 只准表示漲跌方向(⛔ 不可拿來表示好壞/安全)`,
      bad.length === 0,
      bad.length ? '\n' + bad.map(b => `      L${b.line} [${b.kind}] ${b.txt}`).join('\n') : '');
}

// ② 空過守門:掃描真的有掃到東西嗎(⛔ 否則這支測試等於沒作用)
{
  const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const n = (src.match(/[🔴🟢]/gu) || []).length;
  ok('② 空過守門:index.html 裡本來就該有一堆 🔴🟢(表示漲跌方向)', n > 100, `實際 ${n} 個`);
}

// ③ 注入驗證用:確認掃描器真的抓得出來(把一段已知違反塞進來)
{
  const probe = ["const x = '🟢 現在可進場';", "const y = '🔴 籌碼凌亂';"].join('\n');
  const tmp = path.join(ROOT, '.lamp_probe_tmp.html');
  fs.writeFileSync(tmp, probe);
  const got = scan('.lamp_probe_tmp.html');
  fs.unlinkSync(tmp);
  ok('③ 自我驗證:掃描器對「已知違反」真的叫得出來(⛔ 沒這條分不出「乾淨」與「壞掉」)',
      got.length === 2, `抓到 ${got.length} 個`);
}

// ④ 國發會官方燈號要帶「官方」兩個字(⛔ 不然會跟紅漲綠跌混淆)
{
  const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  // ⚠️ 門檻⛔ 不可用「≥N」—— 拿掉其中一個還是會過(注入驗證抓到的假綠燈)
  //   → 改成「五種燈**每一種**都要帶官方」,而且**每一個燈號表都要**(目前 2 份)
  const kinds = ['紅燈', '綠燈', '藍燈', '黃藍', '黃紅'];
  const miss = kinds.filter(k => {
    const bare = (src.match(new RegExp(`[🔴🟢🔵🔷🟠🟡]\\s*${k}`, 'gu')) || []).length;
    const off  = (src.match(new RegExp(`官方${k}`, 'gu')) || []).length;
    return bare > off;                      // 有「裸的」沒帶官方 → 漏了
  });
  ok('④ 景氣對策信號**每一種**都要標「官方」(⭐ 唯一例外,但必須標示清楚)',
      miss.length === 0, miss.length ? `漏標:${miss.join('・')}` : '');
}

console.log(fails ? `\n❌ ${fails} 條失敗` : '\n✅ LAMPRULE_PASS(全部通過)');
process.exit(fails ? 1 : 0);
