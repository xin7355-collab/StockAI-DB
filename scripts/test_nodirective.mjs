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
if (['1', '2', '3', '4'].includes(INJ)) {
    if (INJ === '3') src = src.replace("'弱勢明顯 —— 別接刀;手上的照你的出場規則走'", "'弱勢明顯,持股分批停利、空手不接刀'");
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
} finally {
    await browser.close();
    if (file !== path.join(ROOT, 'index.html')) fs.rmSync(file, { force: true });
}

console.log(fails.length ? `\n❌ NODIRECTIVE_FAIL ${fails.length} 條` : '\n✅ NODIRECTIVE_PASS');
process.exit(fails.length ? 1 : 0);
