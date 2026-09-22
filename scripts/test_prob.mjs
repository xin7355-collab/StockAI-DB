// 🧪📊 V77.4.6 條件式機率引擎 —— 守門
//
// ⛔ 這支釘的是**用意**:
//   ① 平盤 = 扣成本 ±0.44%(使用者選的口徑)
//   ② 進場 = **訊號日尾盤**(V77.4.8 統一;`h=1` 就是「明天收盤」)、創新高基準⛔ 不含今天、鎖漲停剔除
//   ⑪ ⭐ **「明天」那一列要在第一眼看得到**,而且三件誠實話(漲跌對半 / 三成是平 / 量不到優勢)要一起印
//   ③ **一定要同時顯示全市場基準率**(⛔ 少了它,44% 會被讀成「這檔很差」)
//   ④ **一定要顯示「🆚 贏大盤」**(⛔ 少了它,空頭裡的跌深反彈會被讀成選股很強)
//   ⑤ 樣本不足 → 說「樣本不足」,⛔ 不補值、⛔ 不跟隔壁格借
//   ⑥ ⛔ 不把三個機率加權成一個分數(陷阱 #38)
//   ⑦ ⭐⭐ **跨檔比對**:`index.html._probFeatures` 是 `lib_prob.featuresAt` 的複製品 →
//      把前端那支抽出來用 `new Function` 跑,逐根跟 lib 比,公式一分叉當場紅
//   ⑧ ⭐ `index.html` 與 `pro.html` 的 `_PROB_TABLE` 必須**逐字相同**
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { featuresAt, labelOf, outcomeAt, FLAT_BAND, N_CELLS } from './lib_prob.mjs';
const ROOT = '/home/user/StockAI-DB';
let fails = [];
const ok = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  → ' + JSON.stringify(x)}`); if (!c) fails.push(n); };

const SRC = fs.readFileSync(`${ROOT}/index.html`, 'utf8');
const PRO = fs.readFileSync(`${ROOT}/pro.html`, 'utf8');

// ═══ ⑧ 跨檔:兩個 _PROB_TABLE 必須逐字相同 ═══
{
    const a = SRC.split('\n').find(l => l.trim().startsWith('_PROB_TABLE:'));
    const b = PRO.split('\n').find(l => l.trim().startsWith('_PROB_TABLE:'));
    ok('⑧ index.html 與 pro.html 都有 `_PROB_TABLE`', !!a && !!b);
    ok('⑧b ⭐ 兩個檔逐字相同(⛔ 只改一邊 = 同一個機率兩個數字)',
        !!a && !!b && a.trim() === b.trim(), { a: (a || '').length, b: (b || '').length });
    ok('⑧c ⛔ 不可是空的(placeholder 沒被嵌入 = 功能整個不作用)',
        !!a && !/_PROB_TABLE:\s*null/.test(a), (a || '').slice(0, 60));
}

// ═══ ⑦ 跨檔:前端複製品 vs lib ═══
{
    const i = SRC.indexOf('    _probFeatures(data) {');
    const j = SRC.indexOf('\n    },', i);
    const body = SRC.slice(SRC.indexOf('{', i) + 1, j);
    ok('⑦s 抓得到 `_probFeatures` 的函式體', i > 0 && j > i && body.length > 400, body.length);
    // 造一組跟 lib 一模一樣的輸入,兩邊各跑一次
    //   🚨 **測資一定要包含「最後一根剛好創新高」那一種** —— 隨機序列的最後一根多半不是新高,
    //      nh 兩邊恆為 0 → 注入「基準含今天」時**叫不出來**(V77.4.6 注入驗證當場抓到的假綠燈)。
    const mkR = (seed, nh) => {
        const a = []; let x = seed;
        for (let k = 0; k < 400; k++) { x = (x * 1103515245 + 12345) & 0x7fffffff; a.push(100 + (x / 0x7fffffff) * 60 + k * 0.1); }
        if (nh) a[a.length - 1] = Math.max(...a) * 1.15;           // 最後一根拉到全期最高 → 一定創 120 日新高
        if (nh === 2) a[a.length - 1] = Math.max(...a.slice(-70)) * 1.02;  // 只創 60 日新高
        return a.map(c => ({ open: c, high: c * 1.03, low: c * 0.97, close: c, volume: 1000, o: c, h: c * 1.03, l: c * 0.97, c }));
    };
    const fe = new Function('data', 'self', `const _t={_probMktRegime(){return self.mkt;}};return (function(){${body}}).call(Object.assign(_t,{}));`);
    let diff = 0, cmp = 0, nhSeen = new Set();
    for (const seed of [1, 7, 99, 12345, 777777]) {
        for (const mkt of [0, 1]) {
            const R = mkR(seed, seed % 3);
            const A = fe(R, { mkt });
            const B = featuresAt(R, R.length - 1, mkt);
            cmp++; if (B) nhSeen.add(B.nh);
            if (JSON.stringify(A && { pos: A.pos, vol: A.vol, nh: A.nh, cell: A.cell }) !==
                JSON.stringify(B && { pos: B.pos, vol: B.vol, nh: B.nh, cell: B.cell })) { diff++; console.log('   ⚠️ 不一致', seed, mkt, A, B); }
        }
    }
    ok('⑦ ⭐⭐ 前端 `_probFeatures` 與 `lib_prob.featuresAt` 逐根一致(10 組)', cmp === 10 && diff === 0, { cmp, diff });
    ok('⑦b 🚧 測資真的走到「有創新高」那條分支(⛔ 否則上一條對創新高的公式沒有鑑別力)',
        nhSeen.size >= 2 && (nhSeen.has(1) || nhSeen.has(2)), [...nhSeen]);
}

// ═══ ①②⑥ lib 本身 ═══
ok('① 平盤帶 = 來回成本 0.44%', FLAT_BAND === 0.44 && labelOf(0.44) === 1 && labelOf(0.45) === 0 && labelOf(-0.45) === 2);
ok('⑥s ⛔ 原始碼裡不可把三個機率加權成分數(陷阱 #38)',
    !/(prob|p)Score|機率.{0,6}總分|漲.{0,4}\*\s*\d.{0,20}跌.{0,4}\*/.test(SRC.slice(SRC.indexOf('_probBox(sym, o)'), SRC.indexOf('_probBox(sym, o)') + 9000)));
ok('②s 72 格', N_CELLS === 72);
// ⭐ 口徑:進場 = 訊號日收盤(尾盤買),⛔ 不是 t+1 開盤 —— 兩個方向各一個決定性對照
{
    const mk = a => a.map(c => ({ o: c, h: c * 1.01, l: c * 0.99, c, v: 1000 }));
    const a = []; for (let i = 0; i < 300; i++) a.push(100);
    const R = mk(a); R[201].c = 130;
    const o1 = outcomeAt(R, 200, 1);
    ok('②t ⭐ h=1 = 明天收盤(今收 100 → 明收 130 = +30%)', o1 && Math.abs(o1.ret - 30) < 0.01, o1);
    R[201].o = 50;
    const o2 = outcomeAt(R, 200, 1);
    ok('②t2 ⭐ 決定性反向對照:改 t+1 開盤 → 報酬⛔ 不可變', o1 && o2 && o1.ret === o2.ret, [o1, o2]);
    R[201].o = 130; R[200].c = 50;
    const o3 = outcomeAt(R, 200, 1);
    ok('②t3 ⭐ 改訊號日收盤 → 報酬必須跟著變(進場價真的是它)', o3 && Math.abs(o3.ret - o1.ret) > 10, o3);
}

// ═══ 前端渲染 ═══
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu'] });
const pg = await b.newPage();
await pg.addInitScript(() => {
    const noop = () => inst;
    const inst = new Proxy({}, { get: (_t, k) => (k === 'getWidth' || k === 'getHeight') ? (() => 300) : noop });
    Object.defineProperty(window, 'echarts', { value: new Proxy({}, { get: (_t, k) => k === 'init' ? (() => inst) : (k === 'graphic' ? {} : noop) }), writable: true, configurable: true });
});
const errs = [];
const benign = t => /Failed to load resource|net::ERR_|ERR_FAILED|ERR_ABORTED|CORS|Cross origin|vibrate|chromestatus|Access to fetch/i.test(t);
pg.on('pageerror', e => { const t = e && e.message ? e.message : String(e); if (!benign(t)) errs.push(t); });
await pg.route('**/*', r => { const u = r.request().url(); if (u.startsWith('file://')) return r.continue(); if (/cdn|jsdelivr|unpkg|tailwind|echarts|cloudflare|googleapis|gstatic/i.test(u)) return r.continue(); return r.abort(); });
await pg.goto(pathToFileURL(`${ROOT}/index.html`).href, { waitUntil: 'domcontentloaded', timeout: 45000 });
await pg.waitForTimeout(2500);

const R = await pg.evaluate(() => {
    const out = {};
    const mk = (n, f) => { const a = []; for (let i = 0; i < n; i++) { const c = f(i); a.push({ date: '2026-01-01', open: c, high: c * 1.03, low: c * 0.97, close: c, volume: 1000 }); } return a; };
    // 大盤:年線之上
    app._twiiKlineCache = { rows: mk(300, i => 100 + i * 0.5), at: Date.now() };
    const data = mk(400, i => 100 + Math.sin(i / 11) * 8 + i * 0.05);
    out.f = app._probFeatures(data);
    out.full = app._probBox('2330', { mode: 'full', data });
    out.line = app._probBox('2330', { mode: 'line', data });
    // ⑤ 樣本不足:塞一個不存在的格
    const T = app._PROB_TABLE, keep = T.cells;
    T.cells = {};
    out.thin = app._probBox('2330', { mode: 'full', data });
    out.thinLine = app._probBox('2330', { mode: 'line', data });
    T.cells = keep;
    // 算不出來(K 線太短)要說出來
    out.short = app._probBox('2330', { mode: 'full', data: data.slice(-50) });
    // 大盤抓不到 → 也要說出來(⛔ 不可靜默)
    const kc = app._twiiKlineCache; app._twiiKlineCache = null;
    out.noMkt = app._probBox('2330', { mode: 'full', data });
    app._twiiKlineCache = kc;
    // ③④ 決定性對照:改基準率 → 畫面要跟著變
    const bk = JSON.parse(JSON.stringify(T.base));
    const k20 = T.hz.indexOf(20), k1 = T.hz.indexOf(1);
    T.base[k20][1] = 88.8; T.base[k20][11] = 77.7; T.base[k1][2] = 22.2;
    out.full2 = app._probBox('2330', { mode: 'full', data });
    out.line2 = app._probBox('2330', { mode: 'line', data });
    T.base = bk;
    // ④b2 決定性對照:改「漲最高那一格」的贏大盤欄 → 警告段必須跟著變
    let top = null; for (const kk in T.cells) { const rr = T.cells[kk][k20]; if (rr && (!top || rr[1] > top[1])) top = rr; }
    const keep11 = top[11]; top[11] = 11.1;
    out.warn2 = app._probBox('2330', { mode: 'full', data });
    top[11] = keep11;
    out.tbl = { cells: Object.keys(T.cells).length, hz: T.hz, flat: T.flat, minN: T.minN, cols: T.schema.length, base: T.base[k20].length, entry: T.entry };
    return out;
});

ok('②a 合成 K 線算得出特徵(pos/vol/nh/cell)', R.f && R.f.cell >= 0 && R.f.cell < 72, R.f);
ok('③ 完整版**一定要印全市場基準率**', /全市場/.test(R.full), R.full.slice(0, 120));
ok('③b 完整版要把基準率**本身**印出來(⛔ 只印「差幾 pp」不算 —— 那要自己回推)',
    /先看基準/.test(R.full) && /漲 \d+\.\d%/.test(R.full), R.full.slice(0, 200));
ok('③b2 ⭐ 決定性對照:改基準率 → 畫面跟著變(⛔ 不可寫死)',
    /88\.8/.test(R.full2) && /77\.7/.test(R.full2) && !/88\.8/.test(R.full), '');
ok('③c 一行版也要帶基準率', /全市場/.test(R.line), R.line);
ok('③d ⭐ 一行版的基準率也不可寫死', /77\.7|88\.8/.test(R.line2), R.line2.slice(0, 160));
//   🚨 ⛔ 不可只比「整份 HTML 有沒有出現『贏大盤』」—— 底下的警告段本來就寫著它,
//      拿掉逐列那一欄時會被救活(V77.4.6 注入驗證當場抓到,本 repo 第九次)。
//      → 改成數「出現幾次」:5 個天期各一次 + 基準列 + 警告段。
ok('④ **每一個天期那一列都要印「贏大盤」**(⛔ 少了它,跌深反彈會被讀成選股很強)',
    (R.full.match(/贏大盤/g) || []).length >= 6 && /贏大盤/.test(R.line),
    (R.full.match(/贏大盤/g) || []).length);
//   🚨 ⛔ 不可再釘死 63.1 / 36.2 —— V77.4.7 那兩個數字在換口徑之後當場過期。
//      改成**決定性對照**:改掉「漲最高那一格」的贏大盤欄 → 警告段的數字必須跟著變。
ok('④b 完整版要把那個陷阱講出來(漲最高那格 vs 它的贏大盤)',
    /漲」機率最高/.test(R.full) && /贏大盤的機率只有/.test(R.full), R.full.slice(0, 80));
ok('④b2 ⭐ 決定性對照:改那一格的「贏大盤」→ 警告段跟著變(⛔ 不可寫死)',
    /11\.1/.test(R.warn2) && !/11\.1/.test(R.full), (R.warn2.match(/贏大盤的機率只有[^<]*<b>[^<]*/) || [''])[0]);
ok('⑤ 樣本不足 → 說「樣本不足」(⛔ 不補值、⛔ 不借隔壁格)', /樣本不足/.test(R.thin) && /樣本不足/.test(R.thinLine), R.thin.slice(0, 100));
ok('⑤b K 線不足 → 說出原因(⛔ 不靜默空白)', /K 線不足/.test(R.short), R.short.slice(0, 100));
ok('⑤c 大盤年線抓不到 → 也要說出來', /大盤年線/.test(R.noMkt), R.noMkt.slice(0, 100));
ok('②b 完整版要寫明「進場 = 今天尾盤」與「平 = 扣成本」', /今天尾盤/.test(R.full) && new RegExp('扣.{0,4}來回成本').test(R.full), '');
ok('②b2 ⛔ 不可再出現舊口徑「隔天開盤」(換口徑之後那句話是錯的)', !/隔天開盤/.test(R.full), R.full.slice(0, 200));
ok('②c 要寫明「⛔ 不含出場規則」與「歷史頻率不是預測」', /不含出場規則/.test(R.full) && /不是預測/.test(R.full), '');
ok('⑨ 表本身自洽:天期 5 個 ・第一個是 1(明天)・平盤帶 0.44 ・欄數 = schema 長度',
    R.tbl.hz.length === 5 && R.tbl.hz[0] === 1 && R.tbl.flat === 0.44 && R.tbl.cols === R.tbl.base, R.tbl);
ok('⑨b ⭐ 產物要標明口徑 = 尾盤買(`entry:"close"`)—— ⛔ 沒有它就分不出是哪一版跑的', R.tbl.entry === 'close', R.tbl.entry);

// ═══ ⑪ 「明天」那一列(使用者問的就是這個)═══
ok('⑪ 完整版要有「明天」那一列(⛔ 不可只講 20 天)', /明天\(抱 1 天\)/.test(R.full), '');
ok('⑪b 一行版要先講「明天」的漲/平/跌 + 全市場基準', /明天/.test(R.line) && /全市場/.test(R.line), R.line);
ok('⑪c 🚨 三件誠實話要一起印:漲跌對半 / 幾成是平 / 量不到優勢',
    /漲跌幾乎對半/.test(R.full) && /等於白做/.test(R.full) && /量不到優勢/.test(R.full), '');
ok('⑪d ⛔ 「明天」那一段不可給買賣指令', !/(建議|可以買|進場|加碼|放空)/.test(
    R.full.slice(R.full.indexOf('你問的「明天」'), R.full.indexOf('你問的「明天」') + 700)), '');
ok('⑪e ⭐ 一行版的「明天」基準也不可寫死(改基準 → 跟著變)', /22\.2/.test(R.line2), R.line2.slice(0, 200));
ok('⑩ 無 pageerror', errs.length === 0, errs.slice(0, 2));

await b.close();
console.log(fails.length ? `\n❌ TEST_PROB_FAIL ${fails.length} 條:\n  - ${fails.join('\n  - ')}` : '\n✅ TEST_PROB_PASS');
process.exit(fails.length ? 1 : 0);
