#!/usr/bin/env node
/**
 * 🎞️ V74.7.5 使用者三點回報
 *  ① 「我沒看到你做好的東西」—— 上下游卡第一版只放在 `openStock()` 的**快捷面板**
 *     (要點股票名字才跳出來),而星圖頁是「查一檔 → 往下看表格」,根本不會經過它。
 *     ⭐ 陷阱 #32 的又一次:**功能做好了 ≠ 使用者找得到**。
 *  ② 「泡泡圖新增走過的線紀錄,過了一陣子就會淡化」
 *  ③ 「格子大小也不會變化,那個是不是應該要依照今天的資金去做變化的嗎?」
 *     ⭐ **他是對的** —— 面積本來就該跟著時間軸動,以前做不到只是因為每日成交額沒有存歷史。
 *     V74.7.5 起採礦端算出來了(零額外 API:收盤 × 成交股數,兩個欄位本來就在同一筆 K 線裡)。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');
const MIN = fs.readFileSync(path.join(ROOT, 'miner.py'), 'utf8');
let fails = 0;
const ok = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${x}`}`); if (!c) fails++; };

// ── ⓪ 採礦端要真的產出每日成交額 ──
ok('⓪ 💰 miner 要累加每日成交額(收盤 × 成交股數,⛔ 零額外 API)',
   /_amt = float\(r\.get\('volume'\)/.test(MIN) && /o\['amt'\] \+= _amt/.test(MIN));
ok('⓪b 💰 而且要寫進 sector_rot.json 的輸出', /'amt': amt,/.test(MIN) && /amt\.append\(/.test(MIN));
// ── ⓪c 版面計算要是純函式(⛔ inline 的話沒辦法每一拍重排) ──
ok('⓪c 🗺️ treemap 版面要抽成純函式 `_treeLayout`', /_treeLayout\(amts, items, W, H\)/.test(SRC));
ok('⓪d ⛔ 重排時只可改幾何屬性,不可重建 SVG(重建會洗掉 transition)',
   /_rotTreeSeek[\s\S]{0,2600}rc\.setAttribute\('width'/.test(SRC) && !/_rotTreeSeek[\s\S]{0,2600}box\.innerHTML/.test(SRC));

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
const perr = [];
page.on('pageerror', e => perr.push(e.message.slice(0, 160)));
await page.goto('file://' + path.join(ROOT, 'pro.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.PRO, null, { timeout: 30000 });
await page.waitForTimeout(1200);

const R = await page.evaluate(async () => {
    const P = window.PRO;
    const out = {};
    // ── ① 星圖頁本身要看得到「它做什麼 / 上下游」 ──
    await P.fetchJson('data/screener.json').catch(() => null);
    await P.fetchJson('data/stock_tags.json').catch(() => null);
    P.switchTab('star'); await new Promise(r => setTimeout(r, 2200));
    await P.starGo('2330'); await new Promise(r => setTimeout(r, 1000));
    out.star = (document.getElementById('starList').innerText || '').replace(/\s+/g, ' ');

    // ── ②③ 用合成資料驗「面積會變 + 軌跡會淡」(沙箱沒有 sector_rot.json) ──
    const days = [], ind = {}, names = {};
    for (let i = 0; i < 40; i++) days.push('2026-07-' + String(i + 1).padStart(2, '0'));
    const codes = ['24', '25', '14', '15', '23', '20', '01', '02'];
    ['半導體', '電腦週邊', '電子零組件', '光電', '通信網路', '其他電子', '水泥', '食品']
        .forEach((n, i) => names[codes[i]] = n);
    codes.forEach((c, ci) => {
        ind[c] = { n: 10, r20: days.map((_, i) => Math.sin((i + ci * 3) / 4) * 12),
            amt: days.map((_, i) => 50 + ci * 20 + Math.sin((i + ci) / 3) * 40),
            flow: { f: days.map((_, i) => Math.cos((i + ci) / 5) * 20), t: days.map(() => 0), dl: days.map(() => 0), mg: days.map(() => 0) } };
    });
    const J = { days, ind, th: {}, flow_keys: { f: '外資', t: '投信', dl: '自營', mg: '融資' }, data_date: days[39] };
    P._cache['data/sector_rot.json'] = J;
    P.IND_NAME = Object.assign({}, P.IND_NAME, names);
    P.switchTab('rot'); await new Promise(r => setTimeout(r, 2500));
    const geo = () => [...document.querySelectorAll('#rotTree .cell rect')].map(r => +r.getAttribute('width'));
    const trail = () => [...document.querySelectorAll('#rotTrail line')];
    P.rotSeek(5); await new Promise(r => setTimeout(r, 600));
    out.w5 = geo(); out.t5 = trail().length;
    P.rotSeek(30); await new Promise(r => setTimeout(r, 600));
    out.w30 = geo(); out.t30 = trail().length;
    out.ops = trail().map(l => +l.getAttribute('opacity'));
    out.cells = document.querySelectorAll('#rotTree .cell').length;
    out.note = (document.getElementById('rotTreeNote') || {}).innerText || '';
    // 軌跡條數 ≪ 全部產業數(⛔ 32 條全畫會糊成一團)
    out.watchers = new Set(trail().map(l => l.getAttribute('stroke'))).size;
    // ⛔ 軌跡圖層要在泡泡**下面**
    const kids = [...document.querySelector('#rotTrail').parentNode.children].map(x => x.id);
    out.order = kids.indexOf('rotTrail') < kids.indexOf('rotBubs');
    // ③b 沒有 amt 時要退回固定面積 + 誠實說
    const J2 = JSON.parse(JSON.stringify(J));
    for (const c of Object.keys(J2.ind)) delete J2.ind[c].amt;
    P._cache['data/sector_rot.json'] = J2; P._rotData = J2; P._tree = null;
    await P.renderRot(); await new Promise(r => setTimeout(r, 1500));
    P.rotSeek(5); await new Promise(r => setTimeout(r, 400)); const a5 = geo();
    P.rotSeek(30); await new Promise(r => setTimeout(r, 400)); const a30 = geo();
    out.noAmtSame = JSON.stringify(a5) === JSON.stringify(a30);
    out.noAmtNote = (document.getElementById('rotTreeNote') || {}).innerText || '';
    return out;
});
await browser.close();

ok('⓪e 沒有 pageerror', perr.length === 0, perr.join('|'));
// ── ① ──
ok('① 🏭 **星圖頁本身**要看得到「它做什麼」(⛔ 不可只放在點名字才跳出來的面板)',
   /🏭 它做什麼/.test(R.star) && /先進製程/.test(R.star), R.star.slice(0, 200));
// ⚠️ V74.7.7 起上下游改用分層看板 → 斷言釘**用意**(星圖頁看得到上下游),⛔ 不釘 ⬆️/⬇️ 那兩個標題
ok('①b ⬆️⬇️ 上下游也要在星圖頁上', /上游/.test(R.star) && /下游/.test(R.star) && /環球晶/.test(R.star));
ok('①c 誠實限制要跟著一起出現(⛔ 搬位置不可把警語漏掉)',
   /不等於「這個題材佔它營收九成」/.test(R.star) && /製造流程的先後/.test(R.star));
// ── ② 軌跡 ──
ok('②⓪ 空過守門:真的畫出軌跡了', R.t5 > 0 && R.t30 > 0, `t5=${R.t5} t30=${R.t30}`);
ok('② 🌠 拉得越遠,軌跡越長(⛔ 不是固定長度)', R.t30 > R.t5, `${R.t5} → ${R.t30}`);
ok('②b ⭐ 越舊越淡(透明度要有明顯落差)',
   Math.min(...R.ops) < 0.12 && Math.max(...R.ops) > 0.3, `${Math.min(...R.ops)} ~ ${Math.max(...R.ops)}`);
ok('②c 🚨 ⛔ 只跟前3/後3+選中(⛔ 32 條全畫會糊成一團)—— 條數要遠少於「產業數 × 窗口」',
   R.t30 <= 7 * 13, `t30=${R.t30}`);
ok('②d ⛔ 軌跡圖層必須在泡泡**下面**(不然線會蓋住泡泡)', R.order);
// ── ③ 面積 ──
ok('③⓪ 空過守門:熱力圖真的畫出來了', R.cells >= 5, `cells=${R.cells}`);
ok('③ 💰 磚面積要跟著時間軸變(這正是使用者問的)',
   JSON.stringify(R.w5) !== JSON.stringify(R.w30), `w5=${R.w5.slice(0, 4)} w30=${R.w30.slice(0, 4)}`);
ok('③b 提示要說「面積與顏色都會動」+ 那一天的合計金額', /面積與顏色都會動/.test(R.note) && /億/.test(R.note), R.note.slice(0, 160));
ok('③c 🚨 沒有每日成交額歷史時 → 面積**固定**(⛔ 不可亂動)', R.noAmtSame);
ok('③d 🚨 而且要誠實說「還沒讀到每日成交額歷史」(⛔ 靜默固定 = 使用者以為壞掉)',
   /還沒讀到每日成交額歷史/.test(R.noAmtNote), R.noAmtNote.slice(0, 200));
ok('③e ⛔ 熱力圖仍然只是事實描述,不是輪動訊號', /不是輪動訊號/.test(R.note));

console.log(fails ? `\n❌ ROTMOTION_FAIL(${fails})` : '\n✅ ROTMOTION_PASS(全部通過)');
process.exit(fails ? 1 : 0);
