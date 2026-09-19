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
        n: T && T.n, yoyN: T && T.yoy.filter(x => x != null).length, hasOim: !!(T && T.hasOim), disp: T && T.disp,
        // 📍 V77.3.0 事實標記:合成 12 季 → 逼出三種標記各一次,再走**顯示路徑**數圓點
        marks: (() => {
            const mkC = (over) => { const q = []; for (let i = 0; i < 12; i++) q.push(Object.assign({ p: `202${3 + (i >> 2)}-${['03-31', '06-30', '09-30', '12-31'][i & 3]}`, rev: 100e8, gm: 40, eps: 1, nm: 10, fcf: 5e8, ocf: 8e8, doi: 60, oim: null }, over(i) || {})); return { fin: { q, updated: '2026-09-19' } }; };
            const cnt = (h, k) => (String(h).match(/data-mark="/g) || []).length;
            const trend = C => A._finTrend(C), html = C => A._rpTrendHtml(C);
            const none = mkC(() => null);
            const gm4 = mkC(i => i === 9 ? { gm: 36 } : null);            // 第 10 季毛利率 40 → 36 = −4pp
            const gm29 = mkC(i => i === 9 ? { gm: 37.1 } : null);         // −2.9pp ⛔ 不可標
            const ocfNeg = mkC(i => i === 10 ? { ocf: -1e8 } : null);     // 正 → 負
            const doi30 = mkC(i => i === 11 ? { doi: 78 } : null);        // 60 → 78 = +30%
            const doi29 = mkC(i => i === 11 ? { doi: 77 } : null);        // +28% ⛔ 不可標
            const early = mkC(i => i === 2 ? { gm: 30 } : null);          // 第 3 季掉(在 8 季顯示範圍**外**)
            const T4 = trend(gm4);
            return { none: trend(none).marks.length, gm4: T4.marks.map(m => m.k + '@' + m.q), gm29: trend(gm29).marks.length,
                     ocf: trend(ocfNeg).marks.map(m => m.k), doi30: trend(doi30).marks.map(m => m.k), doi29: trend(doi29).marks.length,
                     earlyAll: trend(early).marks.length, earlyShown: (/data-rpmarks="(\d+)"/.exec(html(early)) || [])[1],
                     dotsGm4: cnt(html(gm4)), dotsNone: cnt(html(none)), htmlGm4: html(gm4), txtGm4: T4.marks[0] && T4.marks[0].txt };
        })(),
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
            const g = h => { const m = /data-rptrend="自由現金流\(單季\)"[\s\S]{0,4000}?text-align:right">([^<]*)</.exec(String(h || '')); return m ? m[1].trim() : null; };
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
// 📈 V77.3.0 八條(+ 營益率那條**只在切片有 oim 時**出現 —— 回算跑完前是 null,線不畫)
//   ⭐ 順序釘住是為了 HTML / canvas 兩邊逐字一致;營益率的位置固定在毛利率之後
const WANT8 = ['營收(單季)', '季營收年增', '毛利率', '淨利率', '每股盈餘', '營業現金流(單季)', '自由現金流(單季)', '存貨天數'];
const wantNames = R.hasOim ? [...WANT8.slice(0, 3), '營益率', ...WANT8.slice(3)] : WANT8;
ok('ⓐ2 八條線都畫出來了(有 oim 時九條),而且順序固定', R.names.length === wantNames.length && wantNames.every((k, i) => R.names[i] === k), JSON.stringify(R.names));
// 🚨 V77.1.4 它正上方那格是「自由現金流**近4季**」(TTM)→ 這條是單季,標籤⛔ 不可撞名(同名不同值)
ok('ⓐ2c ⭐ 現金流那兩條要標「單季」(⛔ 不可跟上面那格「近4季」同名不同值)',
   R.names.filter(n => /現金流/.test(n)).length === 2 && R.names.filter(n => /現金流/.test(n)).every(n => /單季/.test(n)), JSON.stringify(R.names));
ok('ⓐ2b ⭐ canvas 海報那份的線名**逐字一致**(⛔ 兩邊各排一份 = 同一份資料兩種說法)',
   !R.canvasNames || (R.canvasNames.length === R.names.length && R.names.every((k, i) => R.canvasNames[i] === k)), JSON.stringify(R.canvasNames));
ok('ⓐ2d 📅 使用者要「近八季」:每條線正好 8 個點(⛔ 不是 12),而且標題寫「近 8 季」', R.sparks.length >= 8 && R.sparks.every(x => x === 8) && /近 8 季趨勢/.test(R.fundTxt), JSON.stringify(R.sparks));
ok('ⓐ3 sparkline 真的有點(⛔ 空 SVG 不算)', R.sparks.length >= 8 && R.sparks.every(x => x >= 2), JSON.stringify(R.sparks));
ok('ⓐ4 ⭐ 決定性對照:改來源的最新季自由現金流 → 那條的尾巴數字要跟著變(⛔ 不可寫死)',
   !!R.fcfTail.a && !!R.fcfTail.b && R.fcfTail.a !== R.fcfTail.b && /987/.test(R.fcfTail.b), JSON.stringify(R.fcfTail));
// ⭐ 斷線規則:面額變更只影響**每股數**的東西 → 淨利率(舊切片是 EPS×股本/10 推的)與每股盈餘要斷,
//   營收年增 / 毛利率 / 自由現金流⛔ 不可斷(注入:把 `{ gap: gaps }` 拿掉 → 這條會紅)
{
    const body = (SRC.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n').match(/const body = line\('營收\(單季\)'[\s\S]{0,1600}?;\n/) || [''])[0];
    ok('ⓐ5⓪ 空過守門:切得到 body 那一段', body.length > 400, String(body.length));
    const gapOf = nm => { const m = new RegExp(`line\\('${nm}'[^\\n]*`).exec(body); return m ? /gap:\s*gaps/.test(m[0]) : null; };
    ok('ⓐ5 淨利率 / 每股盈餘吃 gap(面額變更那段刻意斷線)', gapOf('淨利率') === true && gapOf('每股盈餘') === true, body.slice(0, 40));
    ok('ⓐ5b 營收 / 營收年增 / 毛利率 / 營益率 / 現金流 / 存貨天數 ⛔ 不可斷線(面額變更不影響它們)',
       gapOf('營收\\(單季\\)') === false && gapOf('季營收年增') === false && gapOf('毛利率') === false && gapOf('營益率') === false
       && gapOf('營業現金流\\(單季\\)') === false && gapOf('自由現金流\\(單季\\)') === false && gapOf('存貨天數') === false, body.slice(0, 40));
    ok('ⓐ5c 兩條現金流都吃 zero(它會是負的,沒有零線看不出正負)', /line\('自由現金流\(單季\)'[^\n]*zero:\s*1/.test(body) && /line\('營業現金流\(單季\)'[^\n]*zero:\s*1/.test(body), body.slice(0, 40));
}
// 📈 V77.3.0 起營益率已加進採礦回算(OperatingIncome)→ 切片有 oim 就畫線;沒有就說「等回算」並指路 3 季那格(⛔ 不可寫「資料源沒有」)
ok('ⓐ6 ⛔ 營益率的說法不可跟同一張卡上方的「📈 三率(近三季)」自打嘴巴(⛔ 不可寫「資料源沒有」)',
   /營益率/.test(R.fundTxt) && !/營益率[^。]{0,12}資料源沒有/.test(R.fundTxt) && !/營業費用/.test(R.fundTxt)
   && (R.hasOim ? R.names.includes('營益率') : (/回算/.test(R.fundTxt) && /3 季/.test(R.fundTxt))), R.fundTxt.slice(0, 200));
ok('ⓐ6b ⭐ 而且那一段「📈 三率(近三季)」真的還在(空過守門:它不在 = 上面那條沒有鑑別力)',
   /三率\(近三季\)/.test(R.fundTxt) && /營益率/.test(R.fundTxt), '');
// ── 📍 V77.3.0 事實標記(使用者:「告訴我哪一季毛利率掉、哪一季現金流轉負、哪一季存貨突然拉高」)──
//   注入:① 把 marks 計算整段拿掉 → ⓐ7 紅 ② 門檻 −3 改 −2 → ⓐ7b 紅 ③ HTML 不畫圓點 → ⓐ8 紅 ④ 基準率那行拿掉 → ⓐ9 紅 ⑤ 標記行加 ⚠️ → ⓐ9b 紅
{
    const M = R.marks;
    ok('ⓐ7 毛利率 40 → 36(−4pp)要在**那一季**標 gm(而且乾淨的 12 季一個都不標)', M.gm4.length === 1 && M.gm4[0] === 'gm@2025-06' && M.none === 0, JSON.stringify([M.gm4, M.none]));
    ok('ⓐ7b 邊界:掉 2.9pp ⛔ 不標、存貨 +28% ⛔ 不標(門檻讀 `_FIN_MARK_BASE`)', M.gm29 === 0 && M.doi29 === 0, JSON.stringify([M.gm29, M.doi29]));
    ok('ⓐ7c 營業現金流 正→負 標 ocf;存貨天數 +30% 標 doi', M.ocf.join() === 'ocf' && M.doi30.join() === 'doi', JSON.stringify([M.ocf, M.doi30]));
    ok('ⓐ7d 標記文字要帶季別與前後數字(使用者要「哪一季」)', /2025-06/.test(M.txtGm4) && /40\.0 → 36\.0/.test(M.txtGm4), M.txtGm4);
    ok('ⓐ8 ⭐ 走顯示路徑:HTML 的 sparkline 真的多了一顆空心圓(乾淨的 0 顆)', M.dotsGm4 === 1 && M.dotsNone === 0, JSON.stringify([M.dotsGm4, M.dotsNone]));
    ok('ⓐ8b 📅 第 3 季(顯示範圍外)的標記:`_finTrend` 有算到,但 8 季畫面⛔ 不列(索引要換算)', M.earlyAll === 1 && M.earlyShown === '0', JSON.stringify([M.earlyAll, M.earlyShown]));
    ok('ⓐ9 ⭐ 基準率一定印在畫面上(V77.1.6:21.8% 的股票都會亮的燈不是警示)', /data-rpmarkbase="21\.8"/.test(M.htmlGm4) && /21\.8%/.test(M.htmlGm4) && /17%/.test(M.htmlGm4) && /15\.3%/.test(M.htmlGm4) && /常見事件/.test(M.htmlGm4), '');
    const mkRow = (/<div[^>]*data-rpmarks="1"[\s\S]*?<\/span><\/div>/.exec(M.htmlGm4) || [''])[0];
    ok('ⓐ9b 🚦 標記那一行⛔ 不可用 ⚠️ / 紅色 / 警示措辭(它是事實紀錄)', mkRow.length > 100 && !/⚠️|🚨|text-red|text-amber|警示|警訊(?!。)/.test(mkRow.replace(/⛔ 不是警訊/g, '')), mkRow.slice(0, 160));
    ok('ⓐ9c 真實資料(2330)那行也印得出來,而且餵給外部 AI 的 facts 有同一份標記(顯示點永遠多一個)', /事實標記/.test(R.fundTxt) && /近 8 季事實標記/.test(R.facts), (R.facts.match(/[^\n]*事實標記[^\n]*/) || [''])[0].slice(0, 120));
}
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
