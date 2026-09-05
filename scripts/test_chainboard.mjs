/**
 * 🔗 供應鏈星脈圖(V74.7.7)—— 分層欄位看板
 *
 * ⛔ 這支釘住的是「為什麼要這樣做」,不是當時的版面:
 *  ① 分層必須用「離終點還有幾站」—— ⛔ 用「離源頭幾站」的話矽晶圓會跟散熱/電源擠在同一欄
 *     (它們都沒有上游),那一欄變成 12 個題材 48 檔 = 等於沒分層。這是實測抓到的。
 *  ② 目前這一檔**一定要留在看板上**,即使它成交額很小被排到後面。
 *  ③ 每層截斷要說出來(⛔ 靜默截斷 = 使用者以為只有這些)。
 *  ④ 🚨 必須寫「⛔ 沒有驗證過『上游漲下游就會漲』」—— 這張圖最容易被當成連動訊號。
 *  ⑤ 名字拿不到時 ⛔ 不可印成「2303 2303」(V74.3.9 那個坑)。
 *  ⑥ 手機寬度下 ⛔ 整頁不可橫向溢出(看板自己橫捲)。
 *
 * ⚠️ 測資的欄位格式**照真實 screener.json**(cols/rows/ind),⛔ 不憑印象編(陷阱 #40)。
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = [];
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fail.push(m); };

const browser = await chromium.launch({ args: ['--allow-file-access-from-files', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });   // ⚠️ 手機寬度
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto('file://' + path.join(ROOT, 'pro.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.PRO, null, { timeout: 30000 });
await page.waitForTimeout(1000);

const R = await page.evaluate(async () => {
    const P = window.PRO;
    // ── 測資:格式照真實 screener.json ──
    const cols = ['c', 'chg', 'chg5', 'chg20', 'chg60', 'amt', 'vr', 'pos252', 'dd60', 'amp20'];
    const rows = {}, ind = {};
    const put = (sy, chg, amt, pos = 50, amp = 2) => {
        rows[sy] = [100, chg, 0, 0, 0, amt, 1, pos, 0, amp]; ind[sy] = '半導體';
    };
    // 把鏈上每個題材的成員都給行情(成交額刻意讓「目前這檔」最小 → 驗②)
    const all = new Set();
    (P.THEMES || []).forEach(t => (t.syms || []).forEach(s => all.add(s)));
    [...all].forEach((sy, i) => put(sy, (i % 3) - 1, 100 - (i % 50)));
    put('6488', -1, 0.01, 90, 5);              // ⭐ 環球晶:成交額墊底 + 符合 🧬
    // 🚨 放一個極端值:中位不動,但平均會被拉高一大截 → 才驗得出「中位 vs 平均」
    const wf = P._themeSyms('wafer'); if (wf[1]) put(wf[1], 80, 50);
    P._cache['data/screener.json'] = { cols, rows, ind, data_date: '2026-09-04' };
    P._cache['data/stock_tags.json'] = { by_stock: {} };
    P._cache['data/live_quotes.json'] = null;

    const grab = (code) => {
        const th = P._bizThemes(code), ks = th.seed.concat(th.auto);
        const html = P._bizChainHtml(code);
        const d = document.createElement('div'); d.innerHTML = html; document.body.appendChild(d);
        const cs = [...d.querySelectorAll('.cbcol')].map(c => ({
            hd: c.querySelector('.cbhd').innerText,
            sub: c.querySelector('.cbsub').innerText,
            med: c.querySelector('.cbmed').innerText,
            syms: [...c.querySelectorAll('.cbn')].map(n => n.getAttribute('onclick').match(/'([^']+)'/)[1]),
            me: [...c.querySelectorAll('.cbn.me')].map(n => n.getAttribute('onclick').match(/'([^']+)'/)[1]),
            names: [...c.querySelectorAll('.cbnm')].map(x => x.innerText),
            codes: [...c.querySelectorAll('.cbcd')].map(x => x.innerText.trim()),
            cls: [...c.querySelectorAll('.cbn')].map(n => n.className),
        }));
        // ⚠️ 這個 Chromium 對**收起的 `<details>`** innerText 回空 → 先展開再讀
        //    (環境限制,⛔ 不是把斷言放寬;正式環境使用者點得開)
        d.querySelectorAll('details').forEach(x => x.open = true);
        const txt = d.innerText.replace(/\s+/g, ' ');
        const leg = (d.querySelector('.cbleg') || {}).innerText || '';
        // 摺疊**外**那一行(第一眼看得到的)—— 關鍵警告必須在這裡,⛔ 不可全部藏進摺疊
        const legTop = ((d.querySelector('.cbleg') || {}).innerText || '').split('📖')[0];
        d.remove();
        return { ks, cols: cs, txt, leg, legTop, html };
    };
    const out = { wafer: grab('6488'), srv: grab('3231'), none: grab('1101') };
    // ⑦c 自己算一次上游那層的中位與平均,跟畫面上的數字對
    {
        const path = P._chainPath(['wafer']);
        const top = path.cols[0];
        const syms = []; top.ks.forEach(k => P._themeSyms(k).forEach(s => syms.push(s)));
        const v = [...new Set(syms)].map(s => P._starChg(s)).filter(Boolean).map(x => x.pct).sort((a, b) => a - b);
        const median = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
        const mean = v.reduce((a, b) => a + b, 0) / v.length;
        const m = (out.wafer.cols[0].med || '').match(/([-+][\d.]+)%/);
        out.medCheck = { median, mean, shown: m ? +m[1] : NaN, n: v.length };
    }
    // ⑥ 手機寬度:整頁不可橫向溢出
    const holder = document.createElement('div');
    holder.innerHTML = out.srv.html; document.body.appendChild(holder);
    await new Promise(r => setTimeout(r, 200));
    window.scrollTo(80, 0);
    out.scrollX = window.scrollX;
    out.wrapScrolls = (() => { const w = holder.querySelector('.cbwrap');
        return w ? { sw: w.scrollWidth, cw: w.clientWidth } : null; })();
    holder.remove(); window.scrollTo(0, 0);
    // ⑥a 量欄高對齊(⚠️ 要在**收起**的狀態量,那才是使用者看到的)
    //  🚨🚨 測兩次:第二次刻意把上游那幾個題材的名字**改成一個字** ——
    //     ⛔ 不這樣做的話每一欄剛好都是 2 行,「欄頭沒有固定高度」這個缺陷根本重現不出來
    //     (第一版注入驗證就是這樣溜過去的:拿掉 height 照樣綠)。
    const measure = () => {
        const h = document.createElement('div'); h.innerHTML = P._bizChainHtml('2330');
        document.body.appendChild(h);
        const ys = [...h.querySelectorAll('.cbcol')].map(c => {
            const n = c.querySelector('.cbn');
            return n ? Math.round(n.getBoundingClientRect().top - c.getBoundingClientRect().top) : 0;
        });
        const r = { ys, gap: ys.length ? Math.max(...ys) - Math.min(...ys) : 999,
                    legLen: ((h.querySelector('.cbleg') || {}).innerText || '').length };
        h.remove(); return r;
    };
    await new Promise(r => setTimeout(r, 150));
    out.align = measure();
    {
        const bak = P.THEMES.map(t => t.n);
        P.THEMES.forEach(t => { if (['wafer', 'asic', 'glass'].includes(t.k)) t.n = '矽'; });
        out.alignShort = measure();
        P.THEMES.forEach((t, i) => t.n = bak[i]);
    }
    // ① 對照:如果改用「離源頭幾站」分層,矽晶圓會跟散熱在同一欄嗎
    const P2 = P._chainPath(['srv']);
    out.lv = P2 ? P2.lv : null;
    return out;
});

const W = R.wafer, S = R.srv;
ok(W.cols.length >= 3, `① 環球晶畫得出分層看板(${W.cols.length} 層)`);

// ① 核心:矽晶圓(wafer)與散熱(cool)⛔ 不可同層
const kOf = (c) => c.sub;
const waferCol = W.cols.findIndex(c => /矽晶圓/.test(kOf(c)));
const coolCol  = W.cols.findIndex(c => /散熱/.test(kOf(c)));
ok(waferCol >= 0 && coolCol >= 0, `①b 兩個題材都出現在看板上(矽晶圓第${waferCol + 1}欄 / 散熱第${coolCol + 1}欄)`);
ok(waferCol !== coolCol,
   '①c 🚨 矽晶圓 ⛔ 不可跟散熱/液冷同一欄 —— 分層要用「離終點幾站」不是「離源頭幾站」');
ok(waferCol < coolCol, '①d 矽晶圓要排在散熱的**左邊**(它離伺服器比較遠)');
ok(R.lv && R.lv.wafer > R.lv.cool,
   `①e 距離值本身:矽晶圓 ${R.lv && R.lv.wafer} 站 > 散熱 ${R.lv && R.lv.cool} 站`);

// ② 目前這一檔不可被成交額截掉
const meAll = W.cols.flatMap(c => c.me);
ok(meAll.includes('6488'), '② ⭐ 目前這一檔(成交額墊底)仍留在看板上並標記');
ok(meAll.length === 1, `②b 只標一格(實際 ${meAll.length})`);
ok(W.cols[waferCol].syms.includes('6488'), '②c 而且要在它自己那一層');

// ③ 截斷要說出來
const cut = W.cols.some(c => c.syms.length < 30);
ok(/還有 \d+ 檔/.test(W.txt) || !cut, '③ 有截斷就要寫「還有 N 檔」');
ok(/只顯示成交額最大的/.test(W.txt), '③b 圖例要說明每層的截斷規則');
ok(/共 \d+ 檔/.test(W.txt), '③c 要寫出這條鏈總共幾檔');

// ④ 免責
// ⚠️ 只掃**看板自己那一段**(.cbleg)—— `沒有驗證過` 在卡片尾巴的免責也有,
//    掃整張卡的話「把看板那句拿掉」照樣會通過(注入驗證抓到的)。
ok(/沒有驗證過/.test(W.legTop) && /上游漲/.test(W.legTop),
   '④ 🚨 關鍵警告必須在**摺疊外**(第一眼看得到),⛔ 不可整段藏進 📖 說明裡');
// ⭐ 引號裡的是「被否定的那句話」→ 先剝掉再檢查有沒有相反的推薦
//    (同本專案「禁止某句話的斷言要先 strip 否定形」那條鐵則)
const legNQ = W.leg.replace(/「[^」]*」/g, '');
ok(!/上游領先|產業常識|會跟著漲|連動性強|可以跟著/.test(legNQ),
   '④a ⛔ 而且不可出現相反的正面說法(只驗「有沒有警告」的話,改寫成推薦會溜過去)');
ok(/不代表這幾家真的有生意往來/.test(W.txt), '④b 必須寫「不代表真的有生意往來」');
ok(!/建議|買進|進場|目標價/.test(W.txt), '④c ⛔ 看板不可下操作指令');

// ⑤ 名字
const bad = W.cols.flatMap(c => c.names.map((n, i) => [n, c.codes[i]]))
                  .filter(([n, c]) => n.replace(/^🧬 /, '') === c);
ok(bad.length === 0, `⑤ ⛔ 不可印成「代號 代號」(違規 ${bad.length} 筆)`);

// ⑥a 🚨 欄高必須對齊 —— 使用者回報的「高高低低」:題材多的那一層會把整欄往下推(實測落差 49px)
ok(R.align && R.align.gap <= 2,
   `⑥a 🚨 每一欄的第一格要從同一個高度開始(落差 ${R.align && R.align.gap}px)`);
ok(R.alignShort && R.alignShort.gap <= 2,
   `⑥a1 🚨 就算某一欄的題材名只有一行,欄頭仍要固定高度(落差 ${R.alignShort && R.alignShort.gap}px)`);
ok(R.align && R.align.legLen <= 80,
   `⑥a2 圖例第一眼不可太長(${R.align && R.align.legLen} 字,上限 80)`);

// ⑥ 手機版面
ok(R.scrollX <= 2, `⑥ 手機寬度整頁不可橫向捲動(scrollX=${R.scrollX})`);
ok(R.wrapScrolls && R.wrapScrolls.sw > R.wrapScrolls.cw,
   `⑥b 看板自己要能橫捲(內容 ${R.wrapScrolls && R.wrapScrolls.sw} > 容器 ${R.wrapScrolls && R.wrapScrolls.cw})`);

// ⑦ 同題材相鄰
const midCol = S.cols[S.cols.length - 2] || S.cols[0];
ok(S.cols.length >= 3, `⑦ 緯創也畫得出來(${S.cols.length} 層)`);
ok(/中位/.test(W.cols[0].med), '⑦b 層的代表數字要標明是**中位**');
// 🚨 只驗文字有「中位」兩個字是**驗文案不是驗行為** —— 把算式偷偷改成平均照樣會過。
//    → 測資裡放一個 +80% 的極端值,中位不動、平均會被拉高一大截。
ok(R.medCheck && Math.abs(R.medCheck.shown - R.medCheck.median) < 0.05,
   `⑦c ⭐ 算出來的要等於中位 ${R.medCheck && R.medCheck.median}(平均是 ${R.medCheck && R.medCheck.mean.toFixed(2)},顯示 ${R.medCheck && R.medCheck.shown})`);

// ⑧ 沒收錄的股票
ok(!/供應鏈星脈圖/.test(R.none.txt), '⑧ 沒有題材的股票 ⛔ 不畫看板');
ok(/沒有收錄|還沒有整理|還沒有人工整理/.test(R.none.txt),
   '⑧b 而且要誠實說「本站沒有收錄」(⛔ 不可靜默空白)');

// ⑨ 紅綠只表示漲跌
ok(W.cols.some(c => c.cls.some(x => /\bup\b/.test(x))) &&
   W.cols.some(c => c.cls.some(x => /\bdn\b/.test(x))), '⑨ 漲跌兩種底色都有出現');
ok(/今日上漲|今日下跌/.test(W.txt), '⑨b 圖例要說明紅綠是「今日漲跌」');

ok(errs.length === 0, `⑩ 載入無 pageerror${errs.length ? ':' + errs[0] : ''}`);

await browser.close();
console.log(fail.length ? `\n❌ CHAINBOARD_FAIL(${fail.length})\n` + fail.map(x => ' - ' + x).join('\n')
                        : '\n✅ CHAINBOARD_PASS(全部通過)');
process.exit(fail.length ? 1 : 0);
