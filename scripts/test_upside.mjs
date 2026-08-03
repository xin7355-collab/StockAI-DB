// 🧪 「我現在買,還有多少空間」測試(V71.7.8)
// 使用者要求:上方壓力區要能直接回答「還有多少利潤空間 %」+ 實際金額。
// 釘住:① 只用既有價位不自己發明 ② % 一定配「一張淨賺元」 ③ 淨額有扣費稅
// ④ 風報比用出場總表的停損 ⑤ 兩個地方顯示同一組數字(不打架)⑥ 創高時誠實說沒壓力
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
import { pathToFileURL } from 'node:url';
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
const benign = t => /Failed to load resource|net::ERR_|ERR_FAILED|ERR_ABORTED|CORS|Cross origin|vibrate|chromestatus|Access to fetch/i.test(t);
pg.on('pageerror', e => { const t = e && e.message ? e.message : String(e); if (!benign(t)) errs.push(t); });
await pg.route('**/*', r => { const u = r.request().url(); if (u.startsWith('file://')) return r.continue(); if (/cdn|jsdelivr|unpkg|tailwind|echarts|cloudflare|googleapis|gstatic/i.test(u)) return r.continue(); return r.abort(); });
await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
await pg.waitForTimeout(2500);

const R = await pg.evaluate(() => {
    // 造 130 根日K:前面做出兩個明顯的前高(壓力),最後把價格壓在下面
    const data = [];
    for (let i = 0; i < 130; i++) {
        let base = 100;
        if (i === 40) base = 118;            // 前高 A
        else if (i === 80) base = 112;       // 前高 B
        else base = 100 + Math.sin(i / 7) * 1.5;
        if (i > 120) base = 100;             // 最後壓在 100
        data.push({ date: `2026-0${1 + (i % 9)}-01`, open: base, high: base + 0.6, low: base - 0.6, close: base, volume: 1000 });
    }
    const last = data.length - 1;
    const pC = data[last].close;
    app.settings = app.settings || {}; app.settings.feeDiscount = 0.28;
    app._dynExit = { t1: 106, t2: 115, def: 95, t1L: '🎯 第一目標', t2L: '🚀 第二目標', defL: '停損', pC };
    app._guardStash = { g5: 99, g20: 97, g60: 104, boMid: 96, boLow: 94 };

    const out = {};
    const u = app._upsideRoom(pC, data, last);
    out.u = u ? { list: u.list.map(x => ({ n: x.n, v: +x.v.toFixed(2), pct: +x.pct.toFixed(2), ntd: x.ntd })), rr: u.rr, stop: u.stop, risk: u.risk } : null;
    app._renderGuardRuler(pC, data, last);
    // 📈 V71.8.8 拆成兩張:上檔空間在 #upsideRoomCard(進場頁籤)、防守價在 #guardRuler(出場頁籤)
    const up = document.getElementById('upsideRoomCard');
    const el = document.getElementById('guardRuler');
    out.ruler = (up.innerText || '') + '\n' + (el.innerText || '');
    out.upTxt = up.innerText; out.guardTxt = el.innerText;
    out.upHidden = up.classList.contains('hidden');
    out.hidden = el.classList.contains('hidden');
    out.zoneHtml = app._renderChuResistanceZonesHtml(data, last);
    // 手算一次淨損益對照(不可跟程式算的差)
    out.manual106 = Math.round((106 - pC) * 1000 - (pC + 106) * 1000 * 0.001425 * 0.28 - 106 * 1000 * 0.003);

    // 創高情境:上面完全沒壓力
    const hi = data.map(d => ({ ...d }));
    hi[last] = { ...hi[last], close: 200, high: 200, low: 199 };
    app._dynExit = { def: 190, pC: 200 }; app._guardStash = {};
    app._renderGuardRuler(200, hi, last);
    out.topHtml = (document.getElementById('upsideRoomCard').innerText || '')
                + (document.getElementById('guardRuler').innerText || '');
    return out;
});
await b.close();

ok('渲染無 pageerror', errs.length === 0, errs[0] || '');
const u = R.u;
console.log('   上檔清單:', JSON.stringify(u.list));
ok('① 有抓到上檔價位', u.list.length >= 3, JSON.stringify(u.list));
ok('① 由近到遠排序', u.list.every((x, i) => i === 0 || x.v >= u.list[i - 1].v), JSON.stringify(u.list.map(x => x.v)));
ok('① 不收現價以下的(那是防守不是空間)', u.list.every(x => x.v > 100), JSON.stringify(u.list.map(x => x.v)));
ok('① 已跌破的均線(99/97/96)不列進上檔', !u.list.some(x => x.v < 100));
ok('① 60MA 104 在上方 → 要被收進來當壓力', u.list.some(x => Math.abs(x.v - 104) < 0.01), JSON.stringify(u.list.map(x => x.v)));
ok('② 每一道都有「一張淨賺元」', u.list.every(x => Number.isFinite(x.ntd)));
const t1 = u.list.find(x => Math.abs(x.v - 106) < 0.01);
ok('③ 淨額有扣費稅(跟手算一致,且小於帳面價差 6,000)',
   t1 && t1.ntd === R.manual106 && t1.ntd < 6000, `${t1 && t1.ntd} vs 手算 ${R.manual106}`);
ok('④ 風報比用出場總表的停損 95', u.stop === 95 && u.risk < 0, `stop=${u.stop} risk=${u.risk}`);
ok('④ 風報比 = 第一道淨賺 ÷ 停損淨賠', Math.abs(u.rr - (u.list[0].ntd / -u.risk)) < 1e-9, String(u.rr));
ok('⑤ 上檔空間自成一張卡(在進場頁籤,使用者才找得到)',
   !R.upHidden && R.upTxt.includes('上檔空間'), `hidden=${R.upHidden} ${R.upTxt.slice(0,40)}`);
ok('⑤ 防守價仍是另一張卡(出場頁籤)', R.guardTxt.includes('防守價一覽'), R.guardTxt.slice(0, 40));
ok('⑤ 防守價那張要指路到進場頁籤看上檔空間', R.guardTxt.includes('進場'), R.guardTxt.slice(-120));
ok('⑤ 卡上有白話那句「現在買,先碰到的是」', R.ruler.includes('現在買,先碰到的是'), R.ruler.slice(0, 200));
ok('⑤ 卡上有風報比', R.ruler.includes('風報比'), '');
ok('⑤ 金額有千分位逗號', /[+−]\d{1,3},\d{3} 元/.test(R.ruler), (R.ruler.match(/[+−][\d,]+ 元/g) || []).slice(0, 3).join(' '));
ok('⑥ 「上方壓力區」那塊引用同一組數字(不重算)',
   R.zoneHtml.includes(`+${u.list[0].pct.toFixed(1)}%`) && R.zoneHtml.includes(u.list[0].v.toFixed(2)),
   R.zoneHtml.slice(0, 300));
ok('⑦ 同一道價位不會在同一張卡出現兩次(已跌破的不重列)',
   !(R.ruler.includes('已跌破(現在變成上方壓力)') && R.ruler.includes('上檔空間(由近到遠')), '');
ok('⑧ 創高時誠實說「上方已經沒有近期壓力」', R.topHtml.includes('沒有近期壓力'), R.topHtml.slice(0, 200));

console.log();
if (fails.length) { console.log('❌ UPSIDE_TEST_FAIL:', fails); process.exit(1); }
console.log('✅ UPSIDE_TEST_PASS');
