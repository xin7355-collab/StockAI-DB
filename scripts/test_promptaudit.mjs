// 🧾 V77.7.9 提示詞稽核守門(使用者:「/checkup prompt-audit」)
//  逐一釘住這次查到的四個違規,⛔ 不可回來:
//  ① 盤前速報 runGlobalMarketAI:⛔ 不可再有「憑空係數算出來的機率」(陷阱 #38)、⛔ 不叫 AI 點名個股進場、
//     ⛔ AI 不自己寫壓力/支撐點數(禁 AI 算數)、⛔ 🟢 不可當「偏多/進攻」(燈號鐵則)、⛔「可加碼」
//  ② 總經深度分析 _deepAnalyzeMacro:⛔ 不給部位成數(行事曆日方向實測 0 個成立)、VIX 走 _vixState、外資期走 _fiFutState
//  ③ 事件影響 askEventImpactAI:⛔ 不問利多利空、⛔ 不叫 App 內 AI 寫股票代號、輸出掛「🤖 AI 推測」、舊快取換鍵
//  ⚠️ 原始碼斷言一律先剝掉 // 註解(本 repo 第三次:被自己寫的註解救活 = 假綠燈)
// 跑法:node scripts/test_promptaudit.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const FAIL = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 200)}`); if (!c) FAIL.push(n); };
const body = name => {
    const i = SRC.indexOf(`    async ${name}(`); if (i < 0) return '';
    const j = SRC.indexOf('\n    async ', i + 10), k = SRC.indexOf('\n    _', i + 10);
    const end = Math.min(...[j, k].filter(x => x > 0));
    return SRC.slice(i, end).split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
};

const G = body('runGlobalMarketAI'), M = body('_deepAnalyzeMacro'), E = body('askEventImpactAI');
ok('⓪ 三支函式都找得到(⛔ 空字串 = 假綠燈)', G.length > 3000 && M.length > 800 && E.length > 800, [G.length, M.length, E.length]);

ok('① 盤前速報⛔ 不可再有「機率 ${_p…}%」(係數沒驗證過,陷阱 #38)', !/機率\s*\$\{_p/.test(G) && !/_pBull|_pBear|_pNeutral/.test(G), (G.match(/機率[^\n]{0,30}/) || [])[0]);
ok('①b ⛔ 不叫 AI 點名個股進場(大盤結論套個股實測 −0.27%)', !/具體進場指令|挑 1-2 檔代碼/.test(G), (G.match(/具體進場指令|挑 1-2 檔代碼/) || [])[0]);
ok('①c ⛔ AI 不自己寫壓力/支撐點數(禁 AI 算數)', !/壓力 \[數值\]|支撐 \[數值\]/.test(G), '');
ok('①d ⛔ 🟢 不可當「偏多 / 進攻」的標題(燈號鐵則:🟢 = 跌)', !/🟢 (隔夜定調|劇本|情況)/.test(G), (G.match(/🟢[^\n]{0,12}/) || [])[0]);
ok('①e ⛔ 族群同步判讀不下「可加碼 / 避險」指令', !/\(可加碼\)|\(避險\)/.test(G), '');
ok('①f ⛔ 不叫 App 內 AI 寫股票代號(它沒連網)', !/點名台股代號|帶出低軌衛星台股代碼/.test(G), '');

ok('② 總經深度分析⛔ 不給部位成數', !/部位建議\(幾成\)|立刻降部位/.test(M) && /不要給部位成數/.test(M), '');
ok('②b VIX 走 _vixState()(⛔ 不直接讀 mr.vix)', /_vixState\(\)/.test(M) && !/\$\{N\(mr\.vix\)\}/.test(M), '');
ok('②c 外資台指期走 _fiFutState()(⛔ 不給絕對口數)', /_fiFutState\(\)/.test(M) && !/fi_futures_net\)\} 口/.test(M), '');

ok('③ 事件影響⛔ 不問利多利空', !/多空方向\(利多\/利空\/震盪\)|利多利空\?/.test(E), '');
ok('③b 事件影響⛔ 不叫 AI 寫代號', !/代號\+名稱|代表股 2-3 檔/.test(E) && /不要寫股票代號/.test(E), '');
// 🧹 V78.3.6 散戶 App 不印「實測背書」字樣 → 改釘「🤖 AI 推測(⛔ 僅供參考;行事曆日只代表波動變大)」+ 那行⛔ 不可有實測/回測字樣
ok('③c 輸出掛「🤖 AI 推測」而且要說「僅供參考、只代表波動變大」(🧹 V78.3.6 取代「沒有實測背書」)', /🤖 AI 推測\(⛔ 僅供參考;行事曆日只代表「波動變大」\)/.test(E) && !/'🤖 AI 推測[^']*(實測|回測)/.test(E), (E.match(/🤖 AI 推測[^\n]{0,60}/) || [])[0]);
ok('③d 舊快取(有利多利空 + 代號的那版)換鍵且清掉', /'evImpact2_'/.test(E) && /removeItem\('evImpact_'/.test(E), '');

console.log(FAIL.length ? `❌ ${FAIL.length} 條沒過` : '✅ 全部通過');
process.exit(FAIL.length ? 1 : 0);
