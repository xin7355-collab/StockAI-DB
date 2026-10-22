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
 * INJECT=1:把 CPI 的事前換回舊指令 → ① 必須紅;INJECT=2:標籤說明換回「賣 1/3 ~ 1/2」→ ② 必須紅。
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
if (INJ === '1' || INJ === '2') {
    if (INJ === '1') src = src.replace("before: '公布前後這兩天,台股波動常常比較大;但漲跌方向沒有固定規律。',", "before: '事前 1-2 天:減碼短線部位、現金比例拉到 30%。',");
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
} finally {
    await browser.close();
    if (file !== path.join(ROOT, 'index.html')) fs.rmSync(file, { force: true });
}

console.log(fails.length ? `\n❌ NODIRECTIVE_FAIL ${fails.length} 條` : '\n✅ NODIRECTIVE_PASS');
process.exit(fails.length ? 1 : 0);
