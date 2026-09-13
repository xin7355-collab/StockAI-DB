// 🔕 提醒的「入場券」(V76.1.7)—— 使用者 2026-09-12:
//   「彈跳視窗重新檢視,我只想提醒有用資訊,**如果不準就不用提醒**」
//
// 🚨 真因:提醒這條路徑**從來沒查過實測成績**。`_kbarTryFire` 跑 13 類偵測器、命中的全部推出去,
//    中間一行都沒問過 `_sigEdge` —— 而 K線分頁早就會查。那 13 類共 56 種訊號,期望值為正的只有 7 種。
// ⭐ 一個原則兩把尺:「**它宣稱的方向,實測要真的往那邊走**」
//    多方 → `exp > 0` 且 `n ≥ _wrEnough()`;空方/警示 → `e10 < 0` 且 `p ≤ 0.25`;查不到 → 一律擋。
// ⛔⛔ 兩把尺不可互換 —— 拿空方的尺量多方會放行「高勝率做多買點」這種**方向相反的買訊**當警告。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
const url = pathToFileURL('/home/user/StockAI-DB/index.html').href;
let fails = [];
const ok = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + x}`); if (!c) fails.push(n); };

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu'] });
const pg = await b.newPage();
await pg.addInitScript(() => {
  const noop = () => inst;
  const inst = new Proxy({}, { get: (_t, k) => (k === 'getWidth' || k === 'getHeight') ? (() => 300) : noop });
  Object.defineProperty(window, 'echarts', { value: new Proxy({}, { get: (_t, k) => k === 'init' ? (() => inst) : (k === 'graphic' ? {} : noop) }), writable: true, configurable: true });
});
const errs = [];
const benign = t => /Failed to load resource|net::ERR_|ERR_FAILED|ERR_ABORTED|CORS|Cross origin|vibrate|chromestatus|Access to fetch|Cache/i.test(t);
pg.on('pageerror', e => { const t = e && e.message ? e.message : String(e); if (!benign(t)) errs.push(t); });
await pg.route('**/*', r => { const u = r.request().url(); if (u.startsWith('file://')) return r.continue(); if (/cdn|jsdelivr|unpkg|tailwind|echarts/i.test(u)) return r.continue(); return r.abort(); });
await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
await pg.waitForTimeout(2500);

const R = await pg.evaluate(() => {
    const out = {};
    app.settings = app.settings || {};
    app.settings.alertStrict = true;
    const E = app._SIGNAL_EDGE || {};
    const keys = Object.keys(E);
    const det = k => k.split('｜')[0], ttl = k => k.split('｜')[1];

    // ⓐ 多方尺:期望值 > 0 且樣本夠
    out.bullPass = keys.filter(k => app._alertWorthIt(det(k), ttl(k), 'bull').ok);
    out.bullExpect = keys.filter(k => E[k][7] > 0 && app._wrEnough(E[k][1]));
    // ⓑ 空方尺:10 日邊際 < 0 且 p ≤ 0.25
    out.bearPass = keys.filter(k => app._alertWorthIt(det(k), ttl(k), 'bear').ok);
    out.bearExpect = keys.filter(k => E[k][2] < 0 && E[k][4] <= 0.25);
    out.warnSame = keys.filter(k => app._alertWorthIt(det(k), ttl(k), 'warn').ok).length;

    // ⓒ 兩把尺不可互換:挑一個「多方過、空方不過」與「空方過、多方不過」的實例
    const onlyBull = keys.find(k => app._alertWorthIt(det(k), ttl(k), 'bull').ok && !app._alertWorthIt(det(k), ttl(k), 'bear').ok);
    const onlyBear = keys.find(k => app._alertWorthIt(det(k), ttl(k), 'bear').ok && !app._alertWorthIt(det(k), ttl(k), 'bull').ok);
    out.swap = { onlyBull, onlyBear };

    // ⓓ 查不到成績 → 一律擋
    out.unknown = app._alertWorthIt('_detectNotExist', '天下第一招', 'bull');
    out.unknownBear = app._alertWorthIt('_detectNotExist', '天下第一招', 'bear');

    // ⓖ 使用者截圖那 6 則
    const CASES = [
        ['_detect2BarReversal', '長紅遭遇(一日封口)', 'bull', false],
        ['_detectBoxBreakout', 'K線橫盤突破', 'bull', false],
        ['_detectFibRetrace', '📐 費波納契回撤買點', 'bull', false],
        ['_detectBoxBreakout', 'K線橫盤跌破', 'bear', false],
        ['_detectHeavyResistance', '壓力沉重‧反覆過不了', 'warn', false],
        ['_detect2BarReversal', '長黑遭遇(一日封口)', 'bear', true],
    ];
    out.shots = CASES.map(([d, t, tone, want]) => {
        const v = app._alertWorthIt(d, t, tone);
        return { t, tone, want, got: v.ok, why: v.why };
    });

    // 🔁 關掉嚴格模式 → 全放行
    app.settings.alertStrict = false;
    out.loose = app._alertWorthIt('_detectBoxBreakout', 'K線橫盤突破', 'bull').ok;
    app.settings.alertStrict = true;
    return out;
});
await b.close();

ok('渲染無 pageerror', errs.length === 0, errs[0] || '');
console.log(`   多方過 ${R.bullPass.length} 種 ・空方過 ${R.bearPass.length} 種`);
ok('ⓐ 多方尺 = 「期望值>0 且樣本夠」,一個不多一個不少',
   R.bullPass.length === R.bullExpect.length && R.bullPass.length > 0,
   `守門 ${R.bullPass.length} / 直接算 ${R.bullExpect.length}`);
ok('ⓐ 多方過關的應該是個位數(129 種裡期望值為正的只有 9 種)', R.bullPass.length <= 12, String(R.bullPass.length));
ok('ⓑ 空方尺 = 「10日邊際<0 且 p≤0.25」', R.bearPass.length === R.bearExpect.length && R.bearPass.length > 0,
   `守門 ${R.bearPass.length} / 直接算 ${R.bearExpect.length}`);
ok('ⓑ warn 跟 bear 走同一把尺', R.warnSame === R.bearPass.length, `${R.warnSame} vs ${R.bearPass.length}`);
console.log('   互換反例:', JSON.stringify(R.swap));
ok('ⓒ 🚨 兩把尺不可互換:存在「多方過但空方不過」的訊號', !!R.swap.onlyBull, '找不到 → 兩把尺可能被寫成同一把');
ok('ⓒ 🚨 兩把尺不可互換:存在「空方過但多方不過」的訊號', !!R.swap.onlyBear, '找不到 → 兩把尺可能被寫成同一把');
ok('ⓓ 查不到成績 → 多方擋', R.unknown.ok === false && /未驗證|查不到/.test(R.unknown.why), JSON.stringify(R.unknown));
ok('ⓓ 查不到成績 → 空方也擋', R.unknownBear.ok === false, JSON.stringify(R.unknownBear));

console.log();
console.log('   ⓖ 使用者截圖那 6 則:');
let shotFail = 0;
for (const s of R.shots) {
    const good = s.got === s.want;
    if (!good) shotFail++;
    console.log(`     ${good ? '✅' : '❌'} ${s.want ? '應留' : '應砍'} / 實際${s.got ? '留' : '砍'}  ${s.t}  — ${s.why}`);
}
ok('ⓖ 截圖那 6 則:5 砍 1 留', shotFail === 0, `${shotFail} 則判錯`);
ok('🔁 關掉嚴格模式 → 回到舊行為(全放行)', R.loose === true, String(R.loose));

// ── 原始碼層(⚠️ 斷言範圍縮到被改的那一段,⛔ 不可全檔 grep:同樣的字別處也有 = 假綠燈)──
// ⚠️ 先把 `//` 註解剝掉再斷言 —— 第一版兩條**假失敗**都是被**我自己寫的註解**害的
//    (註解裡引用了「以前是裸 push.push(s)」與「🎯 主打型態觸發｜費波納契…」→ indexOf 抓到註解那句)。
//    ⭐ CLAUDE.md 既有鐵則的另一面:斷言範圍要縮到「**真的程式碼**」那一塊。
const RAW = fs.readFileSync('/home/user/StockAI-DB/index.html', 'utf8');
const SRC = RAW.split('\n').map(l => {
    const i = l.indexOf('//');
    // ⛔ 只剝「整行就是註解」與「程式碼後面接註解」,不碰 http:// 這種
    if (i >= 0 && !/https?:$/.test(l.slice(0, i + 1).trim().slice(-6))) return l.slice(0, i);
    return l;
}).join('\n');
{
  const i = SRC.indexOf('_kbarTryFire(sym, name, kdata, budget) {');
  const seg = i > 0 ? SRC.slice(i, i + 3200) : '';
  ok('ⓗ _kbarTryFire 要用 _tagPush 收訊號(沒有 `_d` 守門就查不到成績 = 形同虛設)',
     /this\._tagPush\(push, d, kdata\)/.test(seg) && !/\bpush\.push\(s\)/.test(seg),
     seg ? '那段還在用裸 push.push(s)' : '找不到 _kbarTryFire');
  ok('ⓗ _kbarTryFire 要過 _alertWorthIt', /this\._alertWorthIt\(s\._d, s\.title, s\.tone\)/.test(seg), '沒接上守門');
  ok('ⓗ 原本的 filter ⛔ 不可被拿掉(拿掉會多放一堆訊號進來)',
     /做多買點/.test(seg) && /停利\|爆量隔天\|過熱/.test(seg) && /出貨量\|攻擊量\|換手量/.test(seg), '');
}
{
  // ⓔ ①「你的部位/你自己設的線」⛔ 完全不過守門 —— 那不是訊號準不準,是你的錢到了你設的點
  const CASES = ['🩸 庫存鐵血停損', '🛑 停損到了', '💰 停利條件到了', '🥊 第 2 擊'];
  let bad = [];
  for (const c of CASES) {
    const i = SRC.indexOf(c);
    if (i < 0) { bad.push(c + '(找不到)'); continue; }
    const seg = SRC.slice(Math.max(0, i - 900), i + 300);
    if (/_alertWorthIt|_alertQuiet/.test(seg)) bad.push(c + '(被守門擋住了)');
  }
  ok('ⓔ 🚨 停損/停利/第2擊 ⛔ 不可走實測守門(那是你的部位,不是訊號)', bad.length === 0, bad.join('・'));
}
{
  // ⓕ 被擋下來的必須仍寫進 🔔 通知歷史(使用者要的是不被打擾,不是查不到)
  const i = SRC.indexOf('_alertQuiet(title, body, sym) {');
  const seg = i > 0 ? SRC.slice(i, i + 300) : '';
  ok('ⓕ _alertQuiet 必須寫 🔔 通知歷史', /_recordNotifHistory/.test(seg), '');
  const j = SRC.indexOf('if (!_w.ok) {');
  ok('ⓕ _kbarTryFire 擋下來的那則也要記進歷史',
     j > 0 && /_recordNotifHistory\(`（未達實測門檻）/.test(SRC.slice(j, j + 260)), '');
}
{
  // ③ 方法已被實測打掉的三類 ⛔ 不可再主動推
  const DEAD = [['🔮 明日劇本偏空｜', '明日劇本'], ['🧙 跟單:', '分點跟單'], ['🎯 主打型態觸發｜', '主打型態']];
  let bad = [];
  for (const [k, nm] of DEAD) {
    const i = SRC.indexOf(k);
    if (i < 0) { bad.push(nm + '(找不到)'); continue; }
    const seg = SRC.slice(Math.max(0, i - 260), i + 120);
    if (!/_alertQuiet/.test(seg)) bad.push(nm + '(還在用 _fireAlert 主動推)');
  }
  ok('③ 方法已被實測打掉的(明日劇本/分點跟單/主打型態)⛔ 只記不吵', bad.length === 0, bad.join('・'));
}

console.log();
if (fails.length) { console.log('❌ ALERTGATE_TEST_FAIL:', fails); process.exit(1); }
console.log('✅ ALERTGATE_TEST_PASS');
