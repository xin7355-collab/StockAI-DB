#!/usr/bin/env node
/**
 * 🏛️ 2026-11-25 美國官方關稅動作追蹤(tariff_watch.py → data/tariff_watch.json → App 川普那一格最上面 + Telegram + 觸發專欄 tariff_new)
 *   ① tariff_watch.py --selftest(解析 / 去重 / 第一次只建基準 / 送失敗下一輪再試 / 被擋保住舊的 / 訊息跳脫)
 *   ② App `_tariffPaneHtml`(node 直接跑 index.html 抽出來的那一支):點名台灣、標題跳脫、網址只收 http(s)、生效日那幾行(⛔ 意見截止)、
 *      資料太舊要說、讀不到 ≠ 沒有動作;⛔ 研究字樣(lib_retailbad)/ 🔴🟢 / 方向 / 買賣字
 *   ③ workflow:掛在 trump_posts.yml(⛔ 新增排程)、上一份從 gh-pages 拿、Telegram 金鑰只在那一步、不擋川普發文、自己的時限、
 *      部署 gh-pages + data 兩邊、5 次重試、只有變了才部署
 *   ④ Telegram 那一句(tariff_watch.LAB_LINE)== 實測總表 tariff-policy 專欄回答的第一句(⛔ 兩邊各寫一份)
 *   ⑤ Telegram 訊息過 lib_retailbad.badOf(⛔ 研究字樣)
 *   ⑥ index.html 只有一個地方抓 tariff_watch.json(`_loadTariffWatch`,川普那一格與觸發專欄共用)
 *   INJECT=url → 拿掉網址守門(javascript: 會變成連結)→ ② 必紅;INJECT=tw → 拿掉點名台灣 → ② 必紅;INJECT=line → 改 LAB_LINE → ④ 必紅
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { extractMember } from './col_rate_base.mjs';
import { badOf } from './lib_retailbad.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let PY = fs.readFileSync(path.join(ROOT, 'tariff_watch.py'), 'utf8');
const INJ = process.env.INJECT || '';
const inj = (s, a, b) => { if (!s.includes(a)) { console.error(`❌ 注入 ${INJ}:找不到要改的那一行(測試過期了)`); process.exit(1); } return s.replace(a, b); };
if (INJ === 'url') SRC = inj(SRC, "            const u = this._trumpUrl(x.url);\n            out.push(`<div data-tariff-item", "            const u = String(x.url || '');\n            out.push(`<div data-tariff-item");
if (INJ === 'tw') SRC = inj(SRC, "${x.tw ? ' <span class=\"text-[10px] text-amber-300\">⚠️ 點名台灣</span>' : ''}", '');
if (INJ === 'line') PY = inj(PY, "LAB_LINE = '美國正式加徵關稅那幾天", "LAB_LINE = '美國正式加徵關稅那陣子");
let fails = 0;
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 400)}`); if (!c) fails++; };

// ① python selftest
{
    let out = '', code = 0;
    try { out = execFileSync('python3', [path.join(ROOT, 'tariff_watch.py'), '--selftest'], { cwd: ROOT, encoding: 'utf8' }); } catch (e) { code = e.status || 1; out = String(e.stdout || '') + String(e.stderr || ''); }
    ok('① tariff_watch.py --selftest 全過', code === 0 && /TARIFF_WATCH_SELFTEST_PASS/.test(out), out.split('\n').filter(l => /❌/.test(l)).join(' | '));
}

// ② App 那一段(純函式)
const methodMember = (src, name) => {
    const st = src.indexOf(`\n    ${name}(`); if (st < 0) throw new Error('找不到 ' + name);
    let i = src.indexOf(') {', st) + 2, depth = 0, q = null;
    for (; i < src.length; i++) {
        const c = src[i];
        if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
        if (c === '"' || c === "'" || c === '`') { q = c; continue; }
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return src.slice(st + 1, i + 1).trim();
    }
    throw new Error('大括號對不上:' + name);
};
const arrMember = (src, name) => { const m = src.match(new RegExp(`\\n    ${name}: (\\[[^\\n]*\\]),\\n`)); if (!m) throw new Error('找不到 ' + name); return `${name}: ${m[1]}`; };
const body = ['_trumpUrl', '_trumpTpe', '_escHtml', '_tariffPaneHtml'].map(n => extractMember(SRC, n)).concat([methodMember(SRC, '_dW'), arrMember(SRC, '_WD')]).join(',\n');
const A = (0, eval)(`({${body}})`);
const NOW = Date.parse('2026-11-25T03:00:00Z');
const T = {
    v: 1, checked: '2026-11-25T02:00:00Z', ok_at: '2026-11-25T02:00:00Z', src: 'x', err: null, pushed: [],
    items: [
        { id: '2026-22001', date: '2026-11-24', type: 'Notice', kind: '定案', agency: '美國貿易代表署', title: 'Notice of Action <script>alert(1)</script>', zh: '301 條款・產能過剩・定案(點名 16 個:台灣、中國…)', countries: ['台灣', '中國'], tw: true, url: 'https://www.federalregister.gov/d/2026-22001', eff: '2026-12-15' },
        { id: '2026-21500', date: '2026-11-18', type: 'Presidential Document', kind: '總統令', agency: '白宮', title: 'Adjusting Imports of Semiconductors', zh: '232 條款・半導體・總統令', countries: [], tw: false, url: 'javascript:alert(1)' },
    ],
    upcoming: [{ date: '2026-12-01', what: '意見截止', id: 'a', zh: '301 條款' }, { date: '2026-12-15', what: '生效', id: '2026-22001', zh: '301 條款・產能過剩・定案(點名 16 個:台灣、中國…)' }],
};
const strip = h => h.replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const H = A._tariffPaneHtml(T, NOW, '');
const items = H.match(/<div data-tariff-item[\s\S]*?<\/div>\s*<\/div>/g) || [];
ok('② 兩筆公告都列出來,新的在上面(11/24 定案、11/18 總統令)', items.length === 2 && /11\/24/.test(strip(items[0])) && /定案/.test(items[0]) && /總統令/.test(items[1]), items.map(strip).join(' | '));
ok('② 點名台灣那筆有「⚠️ 點名台灣」,沒點名的沒有', /⚠️ 點名台灣/.test(items[0] || '') && !/點名台灣/.test(items[1] || ''), items.map(strip).join(' | '));
ok('② 標題跳脫(⛔ 原樣的 <script>)', !/<script>/.test(H) && /&lt;script&gt;/.test(H));
ok('② 網址只收 http(s):聯邦公報那筆有「🔗 原文」、javascript: 那筆沒有連結', /href="https:\/\/www\.federalregister\.gov\/d\/2026-22001"/.test(H) && !/javascript:/.test(H) && (items[1] || '').indexOf('href=') < 0, items[1]);
ok('② 生效日那一行(⏰ 12/15 美國關稅生效,括號那段不放);意見截止 ⛔ 列', /⏰ <span class="font-mono">12\/15\([^)]*\)<\/span> 美國關稅生效:301 條款・產能過剩・定案</.test(H) && !/意見截止/.test(H), strip(H).slice(0, 300));
ok('② 最後更新時間寫在右上角(台北時間)', /11\/25\([^)]*\) 10:00/.test(H), strip(H).slice(0, 200));
const stale = A._tariffPaneHtml({ ...T, ok_at: '2026-11-23T00:00:00Z' }, NOW, '');
ok('② 最後一次抓到超過 36 小時 → 寫「官方公告停在…」', /官方公告停在 11\/23\([^)]*\) 08:00[((]51 小時前[))]/.test(strip(stale)), strip(stale).slice(0, 260));
const none = A._tariffPaneHtml(null, NOW, 'HTTP 404');
ok('② 讀不到 ≠ 沒有關稅動作(寫原因)', /讀不到美國官方公告的資料[((]HTTP 404[))]/.test(strip(none)) && /不代表沒有新的關稅動作/.test(strip(none)), strip(none));
const empty = A._tariffPaneHtml({ ...T, items: [], upcoming: [] }, NOW, '');
ok('② 沒有公告 → 寫「最近 4 個月沒有」(⛔ 空白)', /最近 4 個月沒有跟關稅有關的正式公告/.test(strip(empty)), strip(empty));
const txt = strip(H + stale + none + empty);
ok('② ⛔ 研究字樣(lib_retailbad)', badOf(txt).length === 0, badOf(txt).join(' '));
ok('② ⛔ 🔴🟢、⛔ 方向 / 買賣指令字', !/[🔴🟢]/u.test(txt) && !/利多|利空|進場|加碼|減碼|會漲|會跌|大漲|大跌|追高|停損/.test(txt), (txt.match(/利多|利空|進場|加碼|減碼|會漲|會跌|大漲|大跌|追高|停損/) || [])[0]);

// ③ workflow
{
    const W = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'trump_posts.yml'), 'utf8');
    const st = W.indexOf('id: tariff'), step = st >= 0 ? W.slice(W.lastIndexOf('- name:', st), W.indexOf('\n      - name:', st)) : '';
    const dep = W.slice(W.indexOf('🚀 部署 tariff_watch.json'));
    ok('③ 掛在 trump_posts.yml(⛔ 新增排程):先 --selftest 再跑、上一份從 gh-pages 拿、產物先搬 /tmp', /python3 tariff_watch\.py --selftest\n\s+python3 tariff_watch\.py\n/.test(step) && /git show FETCH_HEAD:data\/tariff_watch\.json/.test(step) && /cp data\/tariff_watch\.json \/tmp\/tariff\//.test(step), step.slice(0, 300));
    ok('③ Telegram 金鑰只給這一步、不擋川普發文(continue-on-error)、自己的時限', /TELEGRAM_BOT_TOKEN: \$\{\{ secrets\.TELEGRAM_BOT_TOKEN \}\}/.test(step) && /continue-on-error: true/.test(step) && /timeout-minutes: \d/.test(step)
       && (W.match(/secrets\.TELEGRAM_BOT_TOKEN/g) || []).length === 1, step.slice(0, 300));
    ok('③ 部署:只有變了才部署(steps.tariff.outputs.changed)、gh-pages + data 兩邊、5 次重試、只提交這一個檔', /if: steps\.tariff\.outputs\.changed == '1'/.test(dep) && /deploy_tariff gh-pages\n\s+deploy_tariff data/.test(dep)
       && /for i in 1 2 3 4 5; do/.test(dep) && /git commit -q -m "🏛️ 美國官方關稅動作[^"]*" -- data\/tariff_watch\.json/.test(dep), dep.slice(0, 200));
    ok('③ tariff_watch.py 寫 GITHUB_OUTPUT 的 changed(部署那一步靠它)', /changed=\{'1' if changed else '0'\}/.test(PY));
}

// ④ Telegram 那一句 == 實測總表 tariff-policy 專欄回答的第一句
{
    const lab = (PY.match(/^LAB_LINE = '([^']+)'/m) || [])[1] || '';
    const P = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');
    const ln = P.split('\n').find(l => /k: 'tariff-policy'/.test(l)) || '';
    const a = (ln.match(/"a": "([^"]+)"/) || [])[1] || '';
    const first = a.split('。')[0] + '。';
    ok('④ Telegram 那一句(LAB_LINE)== 實測總表 tariff-policy 專欄回答的第一句', lab && lab === first, JSON.stringify([lab, first]));
    ok('④ 實測總表 tariff-policy 是 ⛔ 那一欄、指回 EXP-20261125-03、觸發 tariff_new', /x: 'EXP-20261125-03'/.test(ln) && /"trig": \["tariff_new"/.test(ln), ln.slice(0, 120));
}

// ⑤ Telegram 訊息 ⛔ 研究字樣
{
    let msg = '';
    try {
        msg = execFileSync('python3', ['-c', `import sys, json; sys.path.insert(0, '.'); import tariff_watch as t
x = {'id': '2026-22001', 'date': '2026-11-24', 'kind': '定案', 'agency': '美國貿易代表署', 'zh': '301 條款・產能過剩・定案(點名 16 個:台灣、中國…)', 'tw': True, 'eff': '2026-12-15', 'cmt': None, 'title': 'Notice of Action', 'url': 'https://www.federalregister.gov/d/2026-22001'}
print(t.fmt_msg([x]))`], { cwd: ROOT, encoding: 'utf8' });
    } catch (e) { msg = 'ERR ' + (e.stderr || e.message); }
    ok('⑤ Telegram 訊息有事實 + 實測總表那一句 + 怎麼做,⛔ 研究字樣', /美國官方關稅動作/.test(msg) && /台灣在名單裡/.test(msg) && /生效 12\/15/.test(msg) && badOf(msg).length === 0, badOf(msg).join(' ') || msg.slice(0, 200));
}

// ⑥ index.html 只有一個地方抓 tariff_watch.json
ok('⑥ index.html 只有 _loadTariffWatch 抓 tariff_watch.json(川普那一格與觸發專欄共用,⛔ 各抓一份)', (SRC.match(/data\/tariff_watch\.json', ghBase/g) || []).length === 1 && /async _loadTariffWatch\(force\)/.test(SRC)
   && /tw = await this\._loadTariffWatch\(force\)/.test(SRC) && /tariff = await this\._loadTariffWatch\(\)/.test(SRC));

console.log();
if (fails) { console.log(`❌ TARIFF_WATCH_TEST_FAIL: ${fails}`); process.exit(1); }
console.log('✅ TARIFF_WATCH_TEST_PASS');
