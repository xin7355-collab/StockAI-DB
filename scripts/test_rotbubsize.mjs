#!/usr/bin/env node
/**
 * 🫧 V74.9.0 板塊輪動泡泡大小 + 🔬 實測總表版面
 *
 * 使用者:①「板塊輪動泡泡那個是不是區分大小泡泡,誰大誰小給你決定」
 *        ②「實測總表右手邊那句副標刪除,把搜尋視窗放在這」
 *        ③「主題標籤隱藏起來,我要的是搜尋時才列出來」
 *
 * ⛔ 六條鐵則:
 *  ① 大小 = **那一族當天的成交金額**(既有 `sector_rot.json` 的 `amt`,⛔ 不是成員檔數 —— 那是固定值)
 *  ② 🚨 尺標**全期固定** —— 拉時間軸大小會變,但尺不變(⛔ 每天各自縮放 = 動畫是假的)
 *  ③ 🚨 用**對數**(實測 1.23 ~ 2,526 億,差 2,000 倍;線性的話小的全縮成一點)
 *  ④ 🚨 圖例必須寫「泡泡大小 = 成交金額」+「泡泡大 ⛔ 不等於值得買」
 *  ⑤ 搜尋框在標題列;⛔ 那句副標不可再出現
 *  ⑥ 主題標籤平常收起來,**搜尋時**或**已選主題時**才出現(⛔ 選了主題還收起來會卡住)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');
let fails = 0;
const ok = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${x}`}`); if (!c) fails++; };

// ── 靜態 ────────────────────────────────────────────────────────────
ok('⑤ ⛔ 那句副標已拿掉', !SRC.includes('回測過的東西,按「能不能用」分類'));
ok('⑤ 搜尋框在標題列裡(h2.labhd 內)',
   /<h2 class="labhd">[\s\S]{0,400}id="labQ"/.test(SRC));
ok('② 🚨 尺標算式 ⛔ 不可只吃「當天」那一格(必須掃全期 amt)',
   /for \(const v of \(G\.grp\[c\]\.amt \|\| \[\]\)\)/.test(SRC));
ok('③ 🚨 半徑用對數(Math.log10)', /_rotR\(c, k\)[\s\S]{0,400}Math\.log10\(a\)/.test(SRC));
ok('① ⛔ 主路徑不可再用成員數當大小(只准當 fallback)',
   /this\._rotR\(c, k\) \?\? \(5 \+ Math\.min\(9, Math\.sqrt\(x\.n\)/.test(SRC));

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
const perr = [];
page.on('pageerror', e => perr.push(e.message.slice(0, 200)));
await page.goto('file://' + path.join(ROOT, 'pro.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.PRO, null, { timeout: 30000 });
await page.waitForTimeout(800);

// 🧪 真實規模的假 sector_rot(⛔ 測資規模跟真實不同 = 那條測試沒驗到,陷阱 #40)
//    amt 刻意做成「差 2,000 倍」+「會隨時間變」,才驗得到對數與「跟著時間軸變」兩件事。
const R = await page.evaluate(async () => {
    const P = window.PRO;
    const D = 120, days = [];
    for (let i = 0; i < D; i++) days.push(`2026-0${1 + (i % 9)}-${String(1 + (i % 28)).padStart(2, '0')}`);
    const ind = {};
    for (let g = 0; g < 32; g++) {
        const r20 = [], amt = [];
        for (let i = 0; i < D; i++) {
            r20.push(Math.sin((i + g) / 9) * 12);
            // 🚨 大小差 2,000 倍,而且第 0 天與最後一天刻意相反 → 驗「會跟著時間軸變」
            amt.push(g === 0 ? (i < D / 2 ? 2500 : 2) : g === 1 ? (i < D / 2 ? 2 : 2500) : 5 + g * 3);
        }
        ind[String(g).padStart(2, '0')] = { n: 5 + g, r20, amt, flow: { f: r20.map(v => v * 3) } };
    }
    // 🚨 ⛔ 不可直接塞 `_rotData` —— renderRot 會 `await fetchJson()` 覆蓋它,
    //    而 file:// 下 fetchJson 一定失敗(它加 ?t= query,file 協定不吃)→ 早退。
    //    ⭐ 正解是塞進**共用快取**(既有測試一律這樣做,陷阱 #40)。
    P._cache['data/sector_rot.json'] = { updated: '2026-09-06', days, ind, themes: {}, theme_names: {} };
    P._rotMode = 'ind'; P._rotPick = null; P._rotSmooth = 0;
    P.switchTab('rot'); await new Promise(r => setTimeout(r, 700));
    P.renderRot(); await new Promise(r => setTimeout(r, 700));
    const rOf = k => { P.rotSeek(k); return null; };
    const rad = () => { const o = {}; document.querySelectorAll('#rotBubs .bub').forEach(el => {
        o[el.dataset.k] = +el.querySelector('circle').getAttribute('r'); }); return o; };
    const o = {};
    rOf(0); await new Promise(r => setTimeout(r, 600)); o.r0 = rad();
    rOf(D - 1); await new Promise(r => setTimeout(r, 600)); o.rEnd = rad();
    o.leg = (document.getElementById('rotBubLeg') || {}).textContent || '';
    o.amtOK = P._rotAmtOK;
    // 🔬 實測總表
    P.switchTab('lab'); await new Promise(r => setTimeout(r, 800));
    const tp = () => document.getElementById('labTopics');
    o.tpHidden0 = tp() ? tp().classList.contains('hidden') : null;
    P.labSearch('分點'); await new Promise(r => setTimeout(r, 400));
    o.tpHiddenQ = tp() ? tp().classList.contains('hidden') : null;
    o.tpN = tp() ? tp().querySelectorAll('.tpc').length : 0;
    P.labSearch(''); await new Promise(r => setTimeout(r, 400));
    o.tpHidden1 = tp() ? tp().classList.contains('hidden') : null;
    // ⑥ 選了主題之後 ⛔ 不可收起來(不然取消不掉)
    const k0 = (P.LAB_TOPICS || [])[0] && P.LAB_TOPICS[0][0];
    if (k0) { P.labTopic(k0); await new Promise(r => setTimeout(r, 400)); }
    o.tpHiddenT = tp() ? tp().classList.contains('hidden') : null;
    o.hdSearch = !!document.querySelector('h2.labhd #labQ');
    return o;
});
await browser.close();

ok('① amt 有被讀到(⛔ 沒讀到就退回成員數,那條就沒驗到)', R.amtOK === true, String(R.amtOK));
ok('② 🚨 拉時間軸泡泡大小真的會變(⛔ 成員數是固定值,永遠不會變)',
   Math.abs((R.r0['00'] || 0) - (R.rEnd['00'] || 0)) > 4,
   `k0=${R.r0['00']} kEnd=${R.rEnd['00']}`);
ok('② 🚨 而且方向相反的那一組要跟著反過來(⛔ 否則可能只是整排一起縮放)',
   (R.r0['00'] > R.r0['01']) && (R.rEnd['00'] < R.rEnd['01']),
   `d0: ${R.r0['00']}vs${R.r0['01']}  dEnd: ${R.rEnd['00']}vs${R.rEnd['01']}`);
// 🚨 注入驗證抓到:只斷言「最大最小差 <20px」擋不住線性 —— 線性下最大最小仍然差 12px,
//   真正被壓扁的是**中間那一大群**(amt 11~98 在線性下全部縮成 4.0~4.5px = 分不出來)。
//   ⭐ 所以要驗**中段的展開度**,⛔ 不是只驗兩端。
{
    const mid = Object.keys(R.r0).filter(k => k !== '00' && k !== '01').map(k => R.r0[k]);
    const spread = Math.max(...mid) - Math.min(...mid);
    ok('③ 🚨 對數:中間那一群 ⛔ 不可被壓成同一個大小(線性會壓扁,展開 <1px)',
       spread > 3, `中段展開 ${spread.toFixed(2)}px`);
}
ok('④ 🚨 圖例要寫「泡泡大小 = 成交金額」', /泡泡大小\s*=\s*那一族當天的成交金額/.test(R.leg), R.leg.slice(0, 90));
ok('④ 🚨 圖例要寫「泡泡大 ⛔ 不等於值得買」', /泡泡大\s*不等於\s*值得買/.test(R.leg), R.leg.slice(0, 120));
ok('⑤ 搜尋框真的在標題列', R.hdSearch === true);
ok('⑥ 平常主題標籤收起來', R.tpHidden0 === true, String(R.tpHidden0));
ok('⑥ 搜尋時主題標籤出現,而且有東西', R.tpHiddenQ === false && R.tpN > 0, `hidden=${R.tpHiddenQ} n=${R.tpN}`);
ok('⑥ 清空搜尋 → 收回去', R.tpHidden1 === true, String(R.tpHidden1));
ok('⑥ 🚨 已選主題時 ⛔ 不可收起來(否則取消不掉)', R.tpHiddenT === false, String(R.tpHiddenT));
ok('⑦ 無 pageerror', perr.length === 0, perr.join(' | '));

console.log(fails ? `\n❌ ${fails} 條未通過` : '\n✅ 全部通過');
process.exit(fails ? 1 : 0);
