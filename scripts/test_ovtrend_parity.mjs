// 🚧 `_ovTrend` 公式的第二份真相守門(⛔ 沒有這支就不要跑 ovtrend_probe)
//   趨勢公式同時活在 `index.html`(給使用者看的那份)與 `scripts/ovtrend_probe.mjs`
//   (回測那份)裡 —— 而 index.html **不能** import scripts/ → 唯一的解就是這支測試:
//   把 index.html 那三行 regex 抓出來,跟探針裡寫死的 `OV_TREND_FORMULA` **逐字比對**。
//   ⛔ 兩邊只要有一邊改了、另一邊沒跟上,回測出來的數字就不是在描述 App 的行為。
import fs from 'node:fs';
const ROOT = '/home/user/StockAI-DB';
const IDX = fs.readFileSync(ROOT + '/index.html', 'utf8');
const PRB = fs.readFileSync(ROOT + '/scripts/ovtrend_probe.mjs', 'utf8');
let fails = [];
const ok = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + x}`); if (!c) fails.push(n); };

// ── 探針裡那份(⛔ 不 import,直接讀原始碼 —— import 會把整支探針跑起來)──
const blk = (PRB.match(/export const OV_TREND_FORMULA = \[([\s\S]*?)\];/) || [])[1] || '';
const want = [...blk.matchAll(/'([^']+)'/g)].map(m => m[1]);
ok('① 探針裡抓得到 OV_TREND_FORMULA(3 行)', want.length === 3, JSON.stringify(want));

// ── index.html 裡那份 ──
const norm = s => s.replace(/\s+/g, ' ').trim();
// 🚧 ⛔ 先剝註解 —— 說明這條規則的註解本身就含公式字樣(本站已踩 16 次)
const body = IDX.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
// 🚨🚨 ⛔ 不可用「全檔第一個 const bull = ma5…」抓 —— index.html 裡有 **7 處**各自算三線多空排,
//    而且定義不一致(見下面 ⑥)。第一版就是這樣抓到了 L22911 那份、⑤c 直接報錯。
//    → 一律**從 `this._ovTrend = {` 往回抓那一段**(那才是全 App 方向的根)。
const _ovAt = body.indexOf('this._ovTrend = {');
const ovBlk = _ovAt < 0 ? '' : body.slice(Math.max(0, _ovAt - 1200), _ovAt);
const got = [
    (ovBlk.match(/^\s*(const ma20Up = .*?);\s*$/m) || [])[1],
    (ovBlk.match(/^\s*(const bull = ma5 .*?);\s*$/m) || [])[1],
    (ovBlk.match(/^\s*(const bear = ma5 .*?);\s*$/m) || [])[1],
].map(x => x == null ? null : x + ';');
ok('② index.html 裡抓得到那三行(⛔ 抓不到 = 這支守門形同虛設)',
    got.every(Boolean), JSON.stringify(got));
// 🚧 空過守門:剝完註解之後主體不可以被剝光
ok('③ 剝註解之後 index.html 主體仍在(空過守門)', body.length > IDX.length * 0.6, `${body.length}/${IDX.length}`);

for (let i = 0; i < 3; i++)
    ok(`④${'abc'[i]} 第 ${i + 1} 行逐字相同`, got[i] != null && norm(got[i]) === norm(want[i] || ''),
        `index=${got[i]}\n      probe=${want[i]}`);

// ── 探針的實作真的照那三行寫(⛔ 不可只是把字串抄過去、實作卻是別的)──
const impl = (PRB.match(/export function ovTrendSeries[\s\S]*?\n}/) || [''])[0];
ok('⑤ 探針實作有 ma20Up = a20 > a20p(回看 2 根,⛔ 不是 1 根)',
    /const ma20Up = a20p != null && a20 > a20p;/.test(impl), impl.slice(0, 400));
ok('⑤b 探針實作的 bull/bear 三條腿跟公式一致',
    /const bull = a5 > a20 && a20 > a60 && ma20Up;/.test(impl) && /const bear = a5 < a20 && a20 < a60 && !ma20Up;/.test(impl), impl.slice(0, 600));
// ⚠️ index.html 的 `at(ind.ma20, last - 2)` = 回看 2 根 —— 抄成 last-1 會讓 flat 桶整個變掉
ok('⑤c index.html 那行真的是 last - 2(⛔ 抄成 last-1 結論會歪)',
    /at\(ind\.ma20, last - 2\)/.test(got[0] || ''), got[0]);

// ── ⑥ 順手把「同一套規則寫了幾份」釘住(⛔ 只記錄不強制統一)──
//   V75.0.6 實測 index.html 有 **7 處**自己算三線多空排,而且定義不一致:
//     ・`_ovTrend`(根)與自選列兩處:`ma20 > 兩根前的 ma20`、bear 用 `!ma20Up`
//     ・L9795 / L22488:用 `>=`(等於也算上揚)
//     ・L18166:回看 **5 根** 而且拿不到值時預設 true
//     ・L22911:bear 用嚴格 `ma20 < ma20prev`(⛔ 不等於 `!ma20Up`)
//   ⛔ 這裡**刻意不強制它們一致** —— 每一處的 lookback 與情境不同,盲目統一會改變全 App 行為。
//   ⭐ 這條的用意是「數量再增加時要有人知道」:超過就要回來看是不是又複製了一份。
const nUp = (body.match(/^\s*const ma20Up = /gm) || []).length;
const nBull = (body.match(/^\s*const bull = ma5 /gm) || []).length;
ok('⑥ 三線多空排的複本數沒有再增加(⛔ 增加了要回來確認不是又複製一份)',
    nUp <= 6 && nBull <= 5, `ma20Up ${nUp} 處(上限 6)/ bull ${nBull} 處(上限 5)`);

console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n🎉 全部通過');
process.exit(fails.length ? 1 : 0);
