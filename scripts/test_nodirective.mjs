#!/usr/bin/env node
/**
 * 🧹 V79.5.6 行事曆 📚 與個股頁頂端訊號標籤 ⛔ 不可再下買賣指令(巡邏找到的漏網,陷阱 #37 又一次)
 *
 * ① 行事曆每一列的 📚(`_MACRO_EVENT_PLAYBOOK`):以前「事前要做 / 事後要做」寫
 *    「減碼短線部位、現金比例拉到 30%」「跳空高開買進」「強力買進主流股」「先賣 1/3 鎖利」「買 VIX Call」——
 *    違反 V76.3.5 鐵則(財經行事曆的日子只准講波動會不會變大、盯哪個數字;37 種行事曆日方向一個都不成立)。
 *    → 每一則只講波動 + 要看什麼,`after` 一律收在「手上的照你的出場規則走」那一句。
 * ② 個股頁頂端標籤(KD 交叉 / 破季線 / 大黑K…)的說明以前寫「可分批建倉」「賣 1/3 ~ 1/2」「考慮減碼或出場」
 *    → 跟「照出場規則走、⛔ 不用先賣一半」打架。
 * ③ V79.5.7 全檔靜態掃描:看得到的字 ⛔ 不可再叫人「分批停利 / 減量或空手 / 持股減碼 / 現金為王 / 空手觀望 / 反向操作」
 *    —— 死碼(容器早就不存在)與理論原文頁(葛蘭碧 / K 棒型態說明 / 朱老師選股說明,頁尾已講清楚本站規則)列白名單、各附理由。
 * ④ V79.5.7 永豐智慧單攻略「直接照抄」那塊:讀 `_exitDistance` 的三條出場線,⛔ 不可再有停利觸發價 / 先賣一半 / 回檔 5% / −10%。
 * INJECT=1:把 CPI 的事前換回舊指令 → ① 必須紅;INJECT=2:標籤說明換回「賣 1/3 ~ 1/2」→ ② 必須紅;
 * INJECT=3:多空計分卡換回「持股分批停利」→ ③ 必須紅;INJECT=4:智慧單那塊換回「先賣一半」→ ④ 必須紅。
 * ⑤ V79.5.9 K 線頁「🗣️ 朱老師這樣看」(renderChuKbarVerdict + 主升段體檢 _mainRiseStage)⛔ 不可自己給進出指令
 *    (跌破 5MA 先停利 / 持股分批出 / 跌破前低就撤 / 快進快出 / 站穩月線 + 帶量長紅再進 …)——
 *    全站只有一套:要不要買照決策台(這一檔自己的觸發價),手上的照三條出場。INJECT=5:換回「順勢做多,買點守 5MA」→ ⑤ 必須紅。
 * ⑥ V79.6.1 盤中即時警報(`_watchlistPulse`,設定「自選盯盤提醒」打開才跑)⛔ 不可再跳沒回測過的買賣指令:
 *    ・K 線偵測器類(量價情境 / 頂背離 / 口袋支點・費波納契)先過 `_alertWorthIt`,沒過 → 只記在 🔔(`quiet`)
 *    ・低基期起漲 / 權值股超跌反彈 / 多訊號共振 → 只記在 🔔、只描述(⛔「停損設今日最低」「可小量搏反彈」「最高信度買點」「持股快出」)
 *    ・六脈點火 / 熄火只在實驗室模式(V79.0.3 那條當時漏了這處)
 *    ・設定「嚴格提醒」關掉(`alertStrict === false`)= 舊行為:那些照樣跳(⭐ 決定性對照,同一份資料)
 *    INJECT=6:低基期起漲換回 trigger + 舊文字 → ⑥ 必須紅;INJECT=7:六脈拿掉實驗室守門 → ⑥ 必須紅。
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INJ = process.env.INJECT || '';
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 260)}`}`); if (!c) fails.push(n); };

const SAME = '手上的股票照你的出場規則走,⛔ 不用因為這個事件先賣或加碼;要不要買照決策台,事件本身不是買賣訊號。';
// ⛔ 指令字(那句固定的「⛔ 不用…先賣或加碼」先拿掉再掃,否則否定句也會被當成指令)
const BAN = /(減碼|加碼|買進|賣出|賣 ?1\/3|現金比例|Call|Put|做多|做空|出脫|鎖利|停損|全面|強力|空手者|承接|試單|追高|守 ?\d+ ?MA|分批)/;

let src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let file = path.join(ROOT, 'index.html');
if (['1', '2', '3', '4', '5', '6', '7'].includes(INJ)) {
    if (INJ === '6') src = src.replace("quiet('lowbaseIgnite', '🧊 低基期起漲',", "trigger('lowbaseIgnite', '🧊 低基期起漲',")
                              .replace('(跌深後第一根大量;⛔ 不是買進訊號,要不要買照決策台)', ' → 跌深打底第一根攻擊量;鐵律:停損設今日最低,收盤跌破就走');
    else if (INJ === '7') src = src.replace('const _needFire = _lab6 && _chgNow >= 2,', 'const _needFire = _chgNow >= 2,');
    else if (INJ === '5') src = src.replace("'型態偏多 —— 要不要買照決策台(看這一檔自己的觸發價),手上的照你的出場規則走。'", "'順勢做多,買點守 5MA,跌破 5MA 先停利,別凹單。'");
    else if (INJ === '3') src = src.replace("'弱勢明顯 —— 別接刀;手上的照你的出場規則走'", "'弱勢明顯,持股分批停利、空手不接刀'");
    else if (INJ === '4') src = src.replace('<div>• ⛔ 不設停利單、⛔ 不先賣一半 —— 照上面三條走就好</div>', '<div>• 停利觸發 ≥ 120(先賣一半,剩的守月線)</div>');
    else if (INJ === '1') src = src.replace("before: '公布前後這兩天,台股波動常常比較大;但漲跌方向沒有固定規律。',", "before: '事前 1-2 天:減碼短線部位、現金比例拉到 30%。',");
    else src = src.replace("tip: '偏弱的單一訊號 —— ⛔ 不是賣出指令,手上的照你的出場規則走(⛔ 不用先賣一部分)'", "tip: '走弱明顯,持有者降低部位(賣 1/3 ~ 1/2)'");
    file = path.join(ROOT, '_nodirective_inject.html');
    fs.writeFileSync(file, src);
    console.log(`💉 INJECT=${INJ}:換回舊的指令寫法 → 對應那一條必須紅`);
}

// ② 頂端標籤:靜態抽出 _actionCfg 那一塊(它是 render 函式裡的區域常數)
const m = src.match(/const _actionCfg = \{([\s\S]*?)\n        \};/);
ok('②a 找得到頂端標籤的 _actionCfg', !!m);
if (m) {
    const tips = [...m[1].matchAll(/tip: '([^']*)'/g)].map(x => x[1]);
    ok('②b 五顆標籤都有說明', tips.length === 5, tips.length);
    const bad = tips.filter(t => /(分批建倉|降低部位|賣 ?1\/3|考慮減碼|收緊停利|出場$)/.test(t));
    ok('②c 說明 ⛔ 不可再下指令(分批建倉 / 降低部位 / 賣 1/3 / 考慮減碼)', bad.length === 0, bad.join(' | '));
    const labels = [...m[1].matchAll(/label: '([^']*)'/g)].map(x => x[1]);
    ok('②d 標籤名字是描述(偏多 / 中性 / 留意 / 偏弱 / 偏空),⛔ 不是布局 / 減碼 / 避開', !labels.some(l => /布局|減碼|避開/.test(l)), labels.join(','));
    // ②e 燈號鐵則:講方向就照台股慣例(紅漲綠跌)+ 🔺🔻;⛔ 不可用 ✅❌(那是「安全 / 危險」的圖示)
    const row = k => (m[1].match(new RegExp(`${k}:\\s*\\{([^}]*)\\}`)) || [, ''])[1];
    const okDir = /emoji: '🔺'/.test(row('buy')) && /text-red-/.test(row('buy'))
               && /emoji: '🔻'/.test(row('avoid')) && /text-green-/.test(row('avoid'))
               && /text-green-/.test(row('reduce')) && !/emoji: '(✅|❌)'/.test(m[1]);
    ok('②e 偏多 = 🔺 紅字、偏弱 / 偏空 = 綠字 🔻(台股慣例),⛔ 不用 ✅❌', okDir, `buy{${row('buy').slice(0, 80)}} avoid{${row('avoid').slice(0, 80)}}`);
}

// ③ 全檔靜態掃描(V79.5.7):看得到的字 ⛔ 不可再叫人先賣 / 減碼 / 空手 / 現金為王
{
    const BAN3 = /分批停利|減量或空手|持股減碼|現金為王|空手觀望|反向操作|提防分批/;
    const ALLOW = {   // 所在的函式(或屬性)→ 為什麼可以留著
        renderDispHeadline: '死碼:V70.3.1 注意股 8 款推估下架,容器 dispHeadlineCard 不存在',
        _renderAttentionScanInner: '死碼:同上',
        renderDispBigShotCard: '死碼:容器 dispBigShotCard 不存在',
        _showAttentionRulesHelp: '死碼:只有上面那張死掉的卡會叫它',
        renderBsiLight: '死碼:景氣燈號元素 bsiLight V30.0 就拿掉了',
        updateChiefAIBoard: '死碼:首席腳本那一格 sccChiefScript V31.6 拿掉了',
        showGranvilleFull: '理論原文(葛蘭碧),頁尾講清楚本站規則 → ③b 另驗',
        showKbarSignalHelp: '理論原文(K 棒型態),頁尾講清楚本站規則 → ③b 另驗',
        _CHU_DESC: '朱老師原本的說法,說明下面補一行本站規則 → ③b 另驗',
    };
    const L = src.split('\n');
    const owner = i => { for (let k = i; k >= 0; k--) { const m = L[k].match(/^    (?:async )?([_A-Za-z0-9]+)(?:\(|: )/); if (m) return m[1]; } return '(html)'; };
    const hits = [], used = new Set();
    L.forEach((ln, i) => {
        const code = ln.replace(/^\s*\/\/.*$/, '').replace(/[ \t]+\/\/[^\n]*$/, '');   // ⛔ 註解不算(講「以前寫了什麼」的註解很多)
        if (!BAN3.test(code)) return;
        const o = owner(i);
        if (ALLOW[o]) { used.add(o); return; }
        hits.push(`L${i + 1} ${o}:${code.match(BAN3)[0]}`);
    });
    ok('③ 看得到的字 ⛔ 不可再叫人分批停利 / 減量或空手 / 持股減碼 / 現金為王 / 空手觀望 / 反向操作', hits.length === 0, hits.slice(0, 6).join(' | '));
    // 空過守門:白名單裡的每一條都要真的用到(⛔ 留著用不到的白名單 = 下次有人在那裡加新字也不會被抓)
    const unused = Object.keys(ALLOW).filter(k => !used.has(k));
    ok('③a 空過守門:白名單每一條都對得上(用不到的要刪掉)', unused.length === 0, unused.join(','));
    ok('③b 理論原文頁要講清楚本站的規則(葛蘭碧 / K 棒型態 / 朱老師選股說明)',
       /以上是葛蘭碧理論原本的說法/.test(src) && /data-kbhelpnote="1"/.test(src) && /data-chudescnote="1"/.test(src));
}

// ⑤ 🧹 V79.5.9 K 線頁「🗣️ 朱老師這樣看」⛔ 不可自己給進出指令(靜態掃這兩支函式的程式碼,⛔ 註解不算)
{
    const BAN5 = /停利|分批出|分批進|就撤|快進快出|續抱|再進|再追|鐵血停損|直接放棄|翻臉出場|以偏多為主|先觀望|順勢做多,|順勢做、|買點守|搶反彈|等打底|再說|再動作|先減碼|趁反彈減碼|高信度買點|最高信度|回檔就是機會|逃命|快出|部位砍半/;
    const L = src.split('\n');
    const head = /^    (?:async )?([_A-Za-z0-9]+)\(.*\) *\{ *$/;
    const body = name => {
        const i = L.findIndex(x => (x.match(head) || [])[1] === name);
        if (i < 0) return null;
        let j = i + 1; while (j < L.length && !head.test(L[j])) j++;
        return L.slice(i, j).map(x => x.replace(/^\s*\/\/.*$/, '').replace(/[ \t]+\/\/[^\n]*$/, '')).join('\n');
    };
    const ck = body('renderChuKbarVerdict'), st = body('_mainRiseStage'), rs = body('_resonanceHtml');   // 共振框排在朱老師卡最上面
    ok('⑤a 空過守門:找得到朱老師卡 / 主升段體檢 / 共振框三支函式', !!ck && !!st && !!rs && ck.length > 3000 && /kbarCtaTxt/.test(ck) && /isBullGrade/.test(rs), `${(ck || '').length} / ${(st || '').length} / ${(rs || '').length}`);
    const hits = [ck || '', st || '', rs || ''].join('\n').split('\n').filter(x => BAN5.test(x)).map(x => x.match(BAN5)[0] + ' ← ' + x.trim().slice(0, 70));
    ok('⑤b 朱老師卡 ⛔ 不再自己給停損價與進出指令(停利 / 分批出 / 就撤 / 快進快出 / 續抱 / 再進 / 再追 / 以偏多為主 …)', hits.length === 0, hits.slice(0, 4).join(' | '));
    ok('⑤c 💡 操作一律指回同一套:要不要買照決策台、手上的照你的出場規則走',
       /要不要買照決策台/.test(ck || '') && ((ck || '').match(/照你的出場規則走/g) || []).length >= 9, ((ck || '').match(/照你的出場規則走/g) || []).length);
}

// ⑥ 🔕 V79.6.1 盤中即時警報(_watchlistPulse)⛔ 不可再跳沒回測過的買賣指令(靜態;⛔ 註解不算)
{
    const L = src.split('\n');
    const head = /^    (?:async )?([_A-Za-z0-9]+)\(.*\) *\{ *$/;
    const i = L.findIndex(x => (x.match(head) || [])[1] === '_watchlistPulse');
    let j = i + 1; while (i >= 0 && j < L.length && !head.test(L[j])) j++;
    const wp = i < 0 ? '' : L.slice(i, j).map(x => x.replace(/^\s*\/\/.*$/, '').replace(/[ \t]+\/\/[^\n]*$/, '')).join('\n');
    ok('⑥a 空過守門:找得到 _watchlistPulse 而且有 quiet / gated 兩個 helper', wp.length > 5000 && /const quiet = \(signal, title, body\) =>/.test(wp) && /const gated = \(signal, det, s, dispTitle\) =>/.test(wp), wp.length);
    const BAN6 = /停損設今日最低|收盤跌破就走|可小量搏反彈|最高信度買點|回檔就是機會|持股快出|空手勿接刀|逃命訊號|停利訊號|持股先減碼|參考買進|A\+ 級買點|逃頂共振/;
    const hits = wp.split('\n').filter(x => BAN6.test(x)).map(x => x.match(BAN6)[0] + ' ← ' + x.trim().slice(0, 70));
    ok('⑥b 盤中警報 ⛔ 不再寫「停損設今日最低 / 可小量搏反彈 / 最高信度買點 / 持股快出 / 停利訊號 / 持股先減碼」', hits.length === 0, hits.slice(0, 3).join(' | '));
    ok('⑥c 六脈點火 / 熄火只在實驗室模式(兩個 _need* 都要先過 _lab6)',
       /const _lab6 = this\._labMode\(\);/.test(wp) && /const _needFire = _lab6 && /.test(wp) && /_needOut = _lab6 && /.test(wp));
    const viaGate = ['vpScenario_', 'topdiv_', 'buyset_'];
    ok('⑥d 量價情境 / 頂背離 / 口袋支點・費波納契 一律先過實測守門(gated),⛔ 直接 trigger',
       viaGate.every(k => wp.includes(`gated('${k}'`) && !wp.includes(`trigger('${k}'`)), viaGate.filter(k => !wp.includes(`gated('${k}'`)).join(','));
    const viaQuiet = ['lowbaseIgnite', 'heavyRebound', 'resoAplus', 'resoTop'];
    ok('⑥e 低基期起漲 / 權值股超跌反彈 / 兩種共振 只記在 🔔(quiet),⛔ 直接 trigger',
       viaQuiet.every(k => wp.includes(`quiet('${k}'`) && !wp.includes(`trigger('${k}'`)), viaQuiet.filter(k => !wp.includes(`quiet('${k}'`)).join(','));
    ok('⑥f quiet 照「嚴格提醒」逃生門:alertStrict === false → 走 trigger(舊行為)',
       /const quiet = [^\n]*\n(?:[ \t]*\n)*[^\n]*alertStrict === false\) return trigger\(signal, title, body\)/.test(wp));
}

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
try {
    const page = await browser.newPage();
    await page.route('**/*', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
    await page.goto('file://' + file, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof app !== 'undefined' && !!app._MACRO_EVENT_PLAYBOOK && !!app.showMacroEventPlaybook, null, { timeout: 30000 });
    const R = await page.evaluate(() => {
        const pb = app._MACRO_EVENT_PLAYBOOK;
        const rows = Object.entries(pb).map(([k, v]) => ({ k, before: v.before, after: v.after, title: v.title }));
        app.vibrate = () => {};
        app.showMacroEventPlaybook('CPI 消費者物價指數');
        const md = [...document.querySelectorAll('body > div.fixed')].pop();
        const txt = md ? md.innerText : '';
        if (md) md.remove();
        return { rows, txt };
    });
    ok('①a 7 個事件都還在(只改寫,⛔ 沒刪)', R.rows.length === 7, R.rows.map(r => r.k).join(','));
    const bad = R.rows.filter(r => BAN.test(r.before) || BAN.test(String(r.after).split(SAME).join('')))
        .map(r => `${r.k}: ${(r.before.match(BAN) || r.after.split(SAME).join('').match(BAN) || [''])[0]}`);
    ok('①b 事前 / 事後 ⛔ 沒有買賣 / 部位指令', bad.length === 0, bad.join(' | '));
    ok('①c 每一則的事後都收在「手上的照你的出場規則走」那一句', R.rows.every(r => String(r.after).includes(SAME)));
    ok('①d 彈窗標題是「事前留意 / 事後看什麼」,⛔ 不是「要做」', /事前留意/.test(R.txt) && /事後看什麼/.test(R.txt) && !/要做/.test(R.txt), R.txt.slice(0, 120));
    ok('①e 彈窗內文 ⛔ 沒有指令字', !BAN.test(R.txt.split(SAME).join('')), (R.txt.split(SAME).join('').match(BAN) || [''])[0]);

    // ④ 永豐智慧單攻略「直接照抄」那塊 —— 讀 _exitDistance 的三條出場線(⛔ 停利觸發 / 先賣一半 / 回檔 5% / −10%)
    const G = await page.evaluate(async () => {
        const rows = await (await fetch('data/2330.json')).json();
        app.currentSymbolId = '2330'; app.baseRawData = rows; app.rawDailyData = rows;
        app._showSinoPacGuide();
        const body = document.getElementById('sinopacGuideBody');
        // ⚠️ 只量「直接照抄」那一塊 —— 下面 7 種單型是永豐產品本身的說明(移動出場單本來就叫「回檔 X% 出場」)
        const plan = body && body.querySelector('[data-sinopacplan]');
        const t = (plan ? plan.innerText : '').replace(/\s+/g, ' ');
        const m = document.getElementById('sinopacGuideModal'); if (m) { m.classList.add('hidden'); m.style.display = 'none'; }
        app.showKbarSignalHelp('夜星轉折');
        const md = [...document.querySelectorAll('body > div.fixed')].pop();
        const kb = md ? md.innerText.replace(/\s+/g, ' ') : ''; if (md) md.remove();
        return { t, kb, lines: (app._exitDistance(rows, '2330') || {}).lines || [] };
    });
    ok('④ 空過守門:智慧單攻略真的畫出 2330 的出場線', /出場線/.test(G.t) && G.lines.length > 0, G.t.slice(0, 160));
    ok('④b 照抄那塊的價位 = _exitDistance 的出場線(⛔ 第二份算法)',
       G.lines.every(l => G.t.includes((+l.v).toFixed(2))), JSON.stringify(G.lines.map(l => l.v)));
    ok('④c ⛔ 停利觸發 / 先賣一半(否定句以外)/ 回檔 5% / −10% 鐵血停損',
       !/停利觸發|回檔 5%|-10%|−10%/.test(G.t) && !/先賣一半/.test(G.t.replace('⛔ 不先賣一半', '')), G.t.slice(0, 300));
    ok('④d K 棒型態說明頁尾要講本站規則', /本站的買賣照決策台/.test(G.kb), G.kb.slice(-160));

    // ⑥ 實跑:同一份假資料跑三次 —— 一般模式 / 實驗室模式 / 關掉嚴格提醒(⭐ 決定性對照)
    const P = await page.evaluate(async () => {
        const SYM = '9999';
        const KD = [];
        for (let i = 0; i < 130; i++) {   // 一年高點 150 → 跌到 100 打底、最後 6 天量縮;今天 103(漲 4%、站上 5 日線、爆量)
            const c = i < 70 ? 150 : (i < 129 ? 100 : 99);
            const d = new Date(Date.UTC(2025, 9, 1) + i * 86400000).toISOString().slice(0, 10);
            KD.push({ date: d, open: c, high: c * 1.01, low: c * 0.99, close: c, volume: i >= 124 ? 500 : 1000 });
        }
        const keep = {};
        const stub = (k, v) => { keep[k] = app[k]; app[k] = v; };
        const fired = [], quietL = [];
        let sixCalls = 0;
        stub('isMarketOpen', () => true);
        stub('_comboWatchGet', () => ({}));
        stub('_getInventory', () => []);
        stub('_isEtfSym', () => false);
        stub('fetchFugleData', async () => ({ price: 103, open: 100, high: 104, low: 99.5, dayHigh: 104, dayLow: 99.5, volume: 9000 }));
        stub('_patchQuoteVol', () => {});
        stub('_comboCheck', () => {});
        stub('_intradayQuickTag', () => '');
        stub('_chuVolumeProgress', () => ({ estimated: 5000, prevVol: 100 }));
        stub('_chuElapsedMinutes', () => null);
        stub('_kbarTryFire', () => {});
        stub('_leaderMine', () => new Set());
        stub('_exitPrimary', () => null);
        stub('_kbarFiredToday', () => true);
        stub('_sixMeridianCalc', d => { sixCalls++; return { okN: d.length > KD.length ? 5 : 1 }; });
        stub('_detectVolPriceScenario', () => [{ title: '🔴 高檔出貨量', tone: 'bear', msg: '<b>高檔爆量</b>' }]);
        stub('_detectRsiDivergence', () => []);
        stub('_detectObvDivergence', () => [{ title: 'OBV 頂背離', tone: 'bear', msg: '價創高 OBV 沒創高' }]);
        stub('_detectIndicatorDivergence', () => []);
        stub('_detectPocketPivot', () => [{ title: '💰 口袋支點(主力偷買)', tone: 'bull', msg: '下跌日量都小於今天' }]);
        stub('_detectFibRetrace', () => []);
        stub('_signalResonance', () => ({ nb: 5, ns: 0, bull: ['甲', '乙', '丙', '丁', '戊'], bear: [] }));
        stub('_fireAlert', (t, b) => { fired.push(`${t}｜${b}`); });
        stub('_alertQuiet', (t, b) => { quietL.push(`${t}｜${b}`); });
        const keepFav = [app.favGroups, app.activeGroupName, app.monitorList, app.settings];
        app.favGroups = { T6: [SYM] }; app.activeGroupName = 'T6'; app.monitorList = [];
        const idbGet = app.idb.get;
        app.idb.get = async k => (k === `proTerm_kline_${SYM}` ? { data: KD } : idbGet.call(app.idb, k));
        const N0 = window.Notification;
        try { Object.defineProperty(window, 'Notification', { value: { permission: 'granted' }, configurable: true, writable: true }); } catch (_) {}
        const st0 = window.setTimeout;
        window.setTimeout = (f, ms, ...a) => st0(f, ms === 1500 ? 0 : ms, ...a);   // 每檔間隔 1.5 秒 → 測試裡不用等
        const run = async (lab, strict) => {
            fired.length = 0; quietL.length = 0; sixCalls = 0; app._alertCache = {}; app._wlCursor = 0;
            app.settings = Object.assign({}, keepFav[3] || {}, { watchlistAlert: true, alertStrict: strict });
            document.documentElement.classList.toggle('lab', !!lab);
            await app._watchlistPulse();
            return { fired: fired.slice(), quiet: quietL.slice(), sixCalls };
        };
        let R;
        try {
            R = { norm: await run(false, undefined), lab: await run(true, undefined), loose: await run(false, false) };
        } finally {
            window.setTimeout = st0;
            document.documentElement.classList.remove('lab');
            Object.entries(keep).forEach(([k, v]) => { app[k] = v; });
            [app.favGroups, app.activeGroupName, app.monitorList, app.settings] = keepFav;
            app.idb.get = idbGet;
            try { Object.defineProperty(window, 'Notification', { value: N0, configurable: true, writable: true }); } catch (_) {}
        }
        return R;
    });
    const has = (arr, re) => arr.some(x => re.test(x));
    const NOPOP = [/^🧊 低基期起漲/, /^🔴 高檔出貨量/, /^⚠️ OBV 頂背離/, /^💰 口袋支點/, /^🔴 看多訊號共振/, /^⚡ 六脈點火/];
    ok('⑥g 空過守門:實跑真的走到盤中掃描(突破 5 日線那則有跳)', has(P.norm.fired, /^🔴 突破 5MA｜/), JSON.stringify(P.norm.fired).slice(0, 200));
    ok('⑥h 一般模式:沒把握的那幾則 ⛔ 跳出來(低基期起漲 / 量價情境 / 頂背離 / 口袋支點 / 共振 / 六脈)',
       NOPOP.every(re => !has(P.norm.fired, re)), P.norm.fired.filter(x => NOPOP.some(re => re.test(x))).join(' | ').slice(0, 260));
    const QWANT = ['🧊 低基期起漲', '🔴 高檔出貨量', '⚠️ OBV 頂背離', '💰 口袋支點(主力偷買)', '🔴 看多訊號共振(強)'];
    ok('⑥i 那幾則改成只記在 🔔(一則都沒不見)', QWANT.every(t => P.norm.quiet.some(x => x.startsWith('（只記錄、不跳提醒）' + t))),
       QWANT.filter(t => !P.norm.quiet.some(x => x.startsWith('（只記錄、不跳提醒）' + t))).join(','));
    const BANRT = /停損設今日最低|收盤跌破就走|可小量搏反彈|最高信度買點|回檔就是機會|停利訊號|參考買進/;
    ok('⑥j 跳出來的與記在 🔔 的文字都 ⛔ 有買賣指令', ![...P.norm.fired, ...P.norm.quiet, ...P.lab.fired].some(x => BANRT.test(x)),
       [...P.norm.fired, ...P.norm.quiet, ...P.lab.fired].filter(x => BANRT.test(x)).join(' | ').slice(0, 260));
    ok('⑥k 一般模式連六脈都不算(_sixMeridianCalc 0 次)', P.norm.sixCalls === 0, P.norm.sixCalls);
    ok('⑥l 實驗室模式:六脈點火照樣跳、而且寫「⛔ 不是買進訊號」(決定性對照:同一份資料)',
       P.lab.sixCalls > 0 && has(P.lab.fired, /^⚡ 六脈點火\(盤中\)｜.*⛔ 不是買進訊號/), JSON.stringify(P.lab.fired).slice(0, 200));
    ok('⑥m 關掉嚴格提醒 = 舊行為:同一份資料那五則都跳出來(⭐ 決定性對照)',
       QWANT.every(t => P.loose.fired.some(x => x.startsWith(t))) && !P.loose.quiet.some(x => x.startsWith('（只記錄')),
       JSON.stringify(P.loose.fired).slice(0, 260));
} finally {
    await browser.close();
    if (file !== path.join(ROOT, 'index.html')) fs.rmSync(file, { force: true });
}

console.log(fails.length ? `\n❌ NODIRECTIVE_FAIL ${fails.length} 條` : '\n✅ NODIRECTIVE_PASS');
process.exit(fails.length ? 1 : 0);
