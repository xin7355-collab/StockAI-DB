#!/usr/bin/env node
/**
 * 📈🗓️ V77.1.2 —— 評估紀錄㉗ 的真缺口 A / B 守門
 *
 *   A 財報 **12 季趨勢**(營收年增 / 毛利率 / 每股盈餘)—— 資料早就在手上,以前只印最新一季
 *   B 事件講「**會動到哪個數字**」—— ⛔ 但只能講波動,⛔ 不可講方向、⛔ 不可給 ★ 重要度
 *
 * ⛔ 每一條先想「注入什麼它會叫」:
 *   ⓐ 年增改成跟上一季比(季 EPS 有季節性)  ⓑ 趨勢那條跟月營收同名(同名不同義)
 *   ⓒ 判讀寫成買賣指令                      ⓓ 顯示端自己算(不讀 `_finTrend`)
 *   ⓔ 事件表塞方向詞 / ★ 重要度            ⓕ 對不到事件時硬給一句話
 *
 * ⚠️ 原始碼斷言先剝掉 `//` 註解(本 repo 被自己的註解救活已經六次)。
 * ⚠️ 讀 `<details>` 內容前要先 `open = true`(關著的 innerText 讀不到)。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CODE = SRC.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 300)}`}`); if (!c) fails.push(n); };

if (!fs.existsSync(path.join(ROOT, 'data', '2330.json'))) { console.log('❌ 沒有 data/2330.json(跑 bash scripts/fetch_testdata.sh)—— ⛔ 不跑假測試'); process.exit(1); }
if (!fs.existsSync(path.join(ROOT, 'data', 'fin', '2330.json'))) { console.log('❌ 沒有 data/fin/2330.json —— ⛔ 不跑假測試'); process.exit(1); }

// ═══ 靜態 ═══════════════════════════════════════════════════════
{
    const fn = CODE.slice(CODE.indexOf('_finTrend(C) {'), CODE.indexOf('_sparkSvg(vals, o = {}) {'));
    ok('⓪a 切得到 _finTrend(空過守門)', fn.length > 600, String(fn.length));
    ok('ⓐs ⭐ 年增跟**去年同季**比(⛔ 不可跟上一季比 —— 季營收有季節性)',
       /i >= 4 && r\.rev != null && rows\[i - 4\]\.rev > 0/.test(fn), '');
    ok('ⓒs 判讀⛔ 不可出現買賣指令(這是事實描述,本站沒有回測過它能不能預測股價)',
       !/該買|該賣|進場|加碼|停損|可以買|建議/.test(fn), '');
    const tr = CODE.slice(CODE.indexOf('_rpTrendHtml(C) {'), CODE.indexOf('_rpHiBold(t) {'));
    ok('⓪b 切得到 _rpTrendHtml(空過守門)', tr.length > 400, String(tr.length));
    ok('ⓓs 顯示端只轉述 `_finTrend`(⛔ 不可自己去讀 C.fin.q 重算)',
       /this\._finTrend\(C\)/.test(tr) && !/C\.fin\.q|\.slice\(-12\)/.test(tr), '');
    ok('ⓑs ⭐ 趨勢那條叫「**季**營收年增」(⛔ 不可跟上面那格「月營收年增」同名 —— 同名不同義)',
       /季營收年增/.test(tr) && /季營收年增/.test(CODE.slice(CODE.indexOf('_rpDrawOwn(sym) {'), CODE.indexOf('_rpOwnSave(sym) {'))), '');
    const ev = CODE.slice(CODE.indexOf('_EVENT_AFFECT: ['), CODE.indexOf('_rpEventsHtml(C) {'));
    ok('⓪c 切得到 _EVENT_AFFECT / _eventAffect(空過守門)', ev.length > 400 && /_eventAffect\(name\)/.test(ev), String(ev.length));
    ok('ⓔs ⭐ 事件表⛔ 不可有方向詞或 ★ 重要度(calendar_stock_probe 37 種行事曆日**方向 0 個成立**)',
       !/利多|利空|看多|看空|偏多|偏空|會漲|會跌|★|重要度|建議買|建議賣/.test(ev),
       (ev.match(/利多|利空|看多|看空|偏多|偏空|會漲|會跌|★|重要度/g) || []).join(','));
    ok('ⓕs 對不到就回 null(⛔ 不硬給一句話 —— 編的比沒有更糟)', /return hit \? hit\.aff : null;/.test(ev), '');
}

// ═══ 執行期 ═════════════════════════════════════════════════════
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
page.on('pageerror', () => {});
await page.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app.analyze, null, { timeout: 25000 });
await page.waitForTimeout(2000);
await page.evaluate(s => { app.switchAppTab('diag'); return app.analyze(s); }, '2330');
await page.waitForTimeout(8000);

const R = await page.evaluate(async () => {
    const A = (typeof window !== 'undefined' && window.app) || app;
    A.switchSubTab('report');
    for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 600)); if (document.querySelector('[data-rptrend]')) break; }
    const box = document.getElementById('rpFund');
    if (box) box.querySelectorAll('details').forEach(d => { d.open = true; });
    const T = A._finTrend(A._rpLast);
    const names = [...document.querySelectorAll('[data-rptrend]')].map(e => e.dataset.rptrend);
    const vd = document.querySelector('[data-rptrendvd]');
    // ⭐ 決定性對照:改來源的最新季毛利率 → 判讀必須跟著變(⛔ 顯示端不重算)
    //   🚨 一定要走**顯示路徑** `_rpTrendHtml`,⛔ 不可只呼叫 `_finTrend` ——
    //      注入「顯示端把 verdict 寫死」時,只比 `_finTrend` 的回傳會**整條溜過去**(實測踩到)。
    const rendKey = h => { const m = /data-rptrendvd="([^"]+)"/.exec(String(h || '')); return m ? m[1] : null; };
    const q = A._rpLast.fin.q, L = q[q.length - 1], gm0 = L.gm;
    L.gm = (q[q.length - 5].gm || 0) - 9.9;              // 逼成「營收上、毛利率下」
    const vd2 = { verdict: { key: rendKey(A._rpTrendHtml(A._rpLast)) } };
    L.gm = gm0;
    const vd3 = { verdict: { key: rendKey(A._rpTrendHtml(A._rpLast)) } };
    return {
        n: T && T.n, yoyN: T && T.yoy.filter(x => x != null).length,
        names, vdKey: vd ? vd.dataset.rptrendvd : null, vdTxt: vd ? vd.innerText.trim() : '',
        sparks: [...document.querySelectorAll('[data-spark]')].map(e => +e.dataset.spark),
        // ⭐ 逐條抓自己的 svg:斷線 = polyline 段數 ≥2;零線 = 有虛線 <line>
        fundTxt: (() => { const el = document.getElementById('rpFund'); return el ? el.innerText : ''; })(),
        fundHtml: (() => { const el = document.getElementById('rpFund'); return el ? el.innerHTML : ''; })(),
        // 📊 D:TTM 回溯必須跟採礦端 `scripts/fin_slice.mjs` 完全一致
        ttm: (() => {
            const F = A._rpLast && A._rpLast.fin; if (!F) return null;
            const a = A._finTtmAt(F, 0), b = A._finTtmAt(F, 4);
            return { a, b, real: { roe4: F.roe4, fcf4: F.fcf4, capex4: F.capex4 }, nq: (F.q || []).length };
        })(),
        rowSvg: Object.fromEntries([...document.querySelectorAll('[data-rptrend]')].map(e => {
            const sv = e.querySelector('svg');
            return [e.dataset.rptrend, sv ? { seg: sv.querySelectorAll('polyline').length, zero: !!sv.querySelector('line[stroke-dasharray]') } : null];
        })),
        // 🚨 canvas 海報那份的線名(⛔ 不可跟 HTML 各排一份)
        canvasNames: (() => { try { return (A._rpOwnDbg && A._rpOwnDbg.trendNames) || null; } catch (_) { return null; } })(),
        // ⛔ 決定性對照:把最新季 fcf 改掉 → 自由現金流那條的尾巴數字要跟著變
        fcfTail: (() => {
            const g = h => { const m = /data-rptrend="自由現金流"[\s\S]{0,4000}?text-align:right">([^<]*)</.exec(String(h || '')); return m ? m[1].trim() : null; };
            const qq = A._rpLast.fin.q, LL = qq[qq.length - 1], f0 = LL.fcf;
            const a = g(A._rpTrendHtml(A._rpLast));
            LL.fcf = -98765000000; const b = g(A._rpTrendHtml(A._rpLast));
            LL.fcf = f0;
            return { a, b };
        })(),
        flip: vd2 && vd2.verdict ? vd2.verdict.key : null,
        back: vd3 && vd3.verdict ? vd3.verdict.key : null,
        // B:事件
        evHtml: (() => { const el = document.getElementById('rpRisk'); if (el) el.querySelectorAll('details').forEach(d => { d.open = true; }); return el ? el.innerText : ''; })(),
        affFin: A._eventAffect('第 3 季財報'), affRev: A._eventAffect('月營收'), affNone: A._eventAffect('莫名其妙的事件'),
        affBoj: A._eventAffect('🇯🇵 日銀 BOJ 利率決議'), affFomc: A._eventAffect('🇺🇸 FOMC 聯準會利率決議'),
        prompt: (() => { try { return A._reportChartPrompt('2330'); } catch (_) { return ''; } })(),
        facts: (() => { try { return A._reportFacts('2330'); } catch (_) { return ''; } })(),
        tr: !!(A._rpOwnFacts('2330') || {}).tr,
    };
});

// ── A ──
ok('ⓐ0 抓得到 12 季趨勢(空過守門)', R.n >= 8, String(R.n));
ok('ⓐ ⭐ 年增只有 i≥4 之後才有值(⛔ 前 4 季算不出「跟去年同季比」)', R.yoyN === R.n - 4, `${R.yoyN} vs ${R.n - 4}`);
// 📈 V77.1.3 五條(⛔ 營益率算不出來 —— data/fin 的 q[] 只有營業成本、沒有營業費用)
const WANT5 = ['季營收年增', '毛利率', '淨利率', '每股盈餘', '自由現金流'];
ok('ⓐ2 五條線都畫出來了,而且順序固定', R.names.length === 5 && WANT5.every((k, i) => R.names[i] === k), JSON.stringify(R.names));
ok('ⓐ2b ⭐ canvas 海報那份的線名**逐字一致**(⛔ 兩邊各排一份 = 同一份資料兩種說法)',
   !R.canvasNames || (R.canvasNames.length === 5 && WANT5.every((k, i) => R.canvasNames[i] === k)), JSON.stringify(R.canvasNames));
ok('ⓐ3 sparkline 真的有點(⛔ 空 SVG 不算)', R.sparks.length >= 5 && R.sparks.every(x => x >= 2), JSON.stringify(R.sparks));
ok('ⓐ4 ⭐ 決定性對照:改來源的最新季自由現金流 → 那條的尾巴數字要跟著變(⛔ 不可寫死)',
   !!R.fcfTail.a && !!R.fcfTail.b && R.fcfTail.a !== R.fcfTail.b && /987/.test(R.fcfTail.b), JSON.stringify(R.fcfTail));
// ⭐ 斷線規則:面額變更只影響**每股數**的東西 → 淨利率(舊切片是 EPS×股本/10 推的)與每股盈餘要斷,
//   營收年增 / 毛利率 / 自由現金流⛔ 不可斷(注入:把 `{ gap: gaps }` 拿掉 → 這條會紅)
{
    const body = (SRC.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n').match(/const body = line\('季營收年增'[\s\S]{0,900}?;\n/) || [''])[0];
    const gapOf = nm => { const m = new RegExp(`line\\('${nm}'[^\\n]*`).exec(body); return m ? /gap:\s*gaps/.test(m[0]) : null; };
    ok('ⓐ5 淨利率 / 每股盈餘吃 gap(面額變更那段刻意斷線)', gapOf('淨利率') === true && gapOf('每股盈餘') === true, body.slice(0, 40));
    ok('ⓐ5b 營收年增 / 毛利率 / 自由現金流 ⛔ 不可斷線(面額變更不影響它們)',
       gapOf('季營收年增') === false && gapOf('毛利率') === false && gapOf('自由現金流') === false, body.slice(0, 40));
    ok('ⓐ5c 自由現金流吃 zero(它會是負的,沒有零線看不出正負)', /line\('自由現金流'[^\n]*zero:\s*1/.test(body), body.slice(0, 40));
}
ok('ⓐ6 ⛔ 營益率的說法不可跟同一張卡上方的「📈 三率(近三季)」自打嘴巴(⛔ 不可寫「資料源沒有」)',
   /營益率/.test(R.fundTxt) && /3 季/.test(R.fundTxt) && /營業費用/.test(R.fundTxt)
   && !/營益率[^。]{0,12}資料源沒有/.test(R.fundTxt), R.fundTxt.slice(0, 200));
ok('ⓐ6b ⭐ 而且那一段「📈 三率(近三季)」真的還在(空過守門:它不在 = 上面那條沒有鑑別力)',
   /三率\(近三季\)/.test(R.fundTxt) && /營益率/.test(R.fundTxt), '');
// ── D 變化量(V77.1.3)──
ok('ⓑ0 抓得到 TTM(空過守門)', !!(R.ttm && R.ttm.a && R.ttm.nq >= 8), JSON.stringify(R.ttm && R.ttm.nq));
ok('ⓑ ⭐⭐ `_finTtmAt(F,0)` **逐字等於** 採礦端算的 roe4/fcf4/capex4(公式一分叉這條當場紅)',
   R.ttm.a.roe4 === R.ttm.real.roe4 && R.ttm.a.fcf4 === R.ttm.real.fcf4 && R.ttm.a.capex4 === R.ttm.real.capex4,
   `${JSON.stringify(R.ttm.a)} vs ${JSON.stringify(R.ttm.real)}`);
ok('ⓑ2 往前挪 4 季真的挪到**不同**的窗口(⛔ back 沒生效 = 一年前跟今天一樣)',
   !!R.ttm.b && R.ttm.b.fcf4 !== R.ttm.a.fcf4 && R.ttm.b.capex4 !== R.ttm.a.capex4,
   `${JSON.stringify(R.ttm.b)} vs ${JSON.stringify(R.ttm.a)}`);
ok('ⓑ3 畫面上真的印出「一年前」與變化量(↑/↓ pp 或 %)',
   /一年前/.test(R.fundTxt) && /[↑↓]/.test(R.fundTxt), (R.fundTxt.match(/[^\n]*一年前[^\n]*/g) || []).slice(0, 3).join(' | '));
ok('ⓒ3 🚦 ↑↓ 那幾段⛔ 不可用紅綠(燈號鐵則:🔴🟢 只准講漲跌;ROE 上升是「好」不是「漲」)',
   !(R.fundHtml.match(/<span class="[^"]*"[^>]*>\(一年前[^<]*/g) || []).some(x => /text-(red|green)-/.test(x)),
   (R.fundHtml.match(/<span class="[^"]*"[^>]*>\(一年前[^<]*/g) || []).slice(0, 2).join(' | '));
ok('ⓒ 判讀只描述,⛔ 沒有買賣指令', !!R.vdKey && !/該買|該賣|進場|加碼|停損|可以買/.test(R.vdTxt), R.vdTxt);
ok('ⓒ2 卡上寫明「本站沒有回測過它能不能預測股價」(⛔ 不可讓人當訊號用)', /沒有回測過/.test(R.vdTxt) || /沒有回測過/.test(R.evHtml) || SRC.includes('沒有回測過它能不能預測股價'), '');
ok('ⓓ ⭐ 決定性對照:把最新季毛利率壓到比去年同季低 9.9pp → 判讀要翻成「背離」(注入:顯示端自己算 → 紅)',
   R.flip === 'diverge' && R.back === R.vdKey, `${R.vdKey} → ${R.flip} → ${R.back}`);
ok('ⓓ2 canvas 海報也拿得到同一份(⛔ 不可兩邊各算一份)', R.tr === true, String(R.tr));

// ── B ──
ok('ⓔ 事件有「會動到哪個數字」', /會動到/.test(R.evHtml), R.evHtml.slice(0, 200));
ok('ⓔ2 這一節有寫「波動會變大」+「不講方向」(⛔ 只講會動到什麼還不夠)',
   /波動會變大/.test(R.evHtml) && /不講方向/.test(R.evHtml), '');
ok('ⓔ3 🧹 而且整節**只講一次**(⛔ 每一行各印一遍 = 重述;注入:把它塞回 `_aff` → 這條會紅)',
   (R.evHtml.match(/波動會變大/g) || []).length === 1, `出現 ${(R.evHtml.match(/波動會變大/g) || []).length} 次`);
ok('ⓕ 對得到的回字串、對不到回 null(⛔ 不硬給)',
   typeof R.affFin === 'string' && typeof R.affRev === 'string' && R.affNone === null,
   JSON.stringify([R.affFin, R.affRev, R.affNone]));
// 🚨 V77.1.2 實跑截圖抓到:「日銀 BOJ 利率決議」含「利率決議」→ 被 FOMC 那一條先吃掉,
//    印成「美股與台幣匯率」。⭐ **越特定的規則要排在前面**(比對是第一個命中就停)。
ok('ⓕ1b ⭐ 日銀那條⛔ 不可被 FOMC 吃掉(兩條都含「利率決議」—— 越特定的要排前面)',
   R.affBoj === '日圓匯率' && /美股/.test(String(R.affFomc)), JSON.stringify([R.affBoj, R.affFomc]));
ok('ⓕ2 做圖提示詞叫 AI **逐字照抄**本站給的那一行(⛔ 不可留空位給它自己編)',
   /逐字照抄/.test(R.prompt) && /會動到/.test(R.prompt), '');
// 🚨 斷言的搜尋範圍要縮到「被改的那一塊」—— 本檔事件那一行也有「會動到」,
//    整份比的話「大盤事件那行被拿掉」會被它救活(本 repo 第七次踩到)。
const lineOf = (txt, key) => String(txt || '').split('\n').find(x => x.includes(key)) || '';
ok('ⓕ3 ⭐ 餵給 AI 的【資料】段裡**每一行事件**都帶了「會動到」(⛔ 只在規則裡講、資料沒給 = AI 一定自己編)',
   /會動到/.test(lineOf(R.facts, '未來的大盤事件')) && /會動到/.test(lineOf(R.facts, '下一個事件')),
   [lineOf(R.facts, '未來的大盤事件'), lineOf(R.facts, '下一個事件')].join(' || ').slice(0, 260));

await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗:${fails.join(' / ')}` : '\n✅ 全部通過');
process.exit(fails.length ? 1 : 0);
