/**
 * 🧹 V77.1.3 報告頁「資訊呈現優化」守門
 *   C 一行資料日期列(_rpDateBarHtml)・B 贅詞收斂・E 風報比口徑
 *
 * ⛔ 三條紀律(本 repo 踩過才寫下來的):
 *   ① 原始碼類斷言**先剝掉 `//` 註解**再比 —— 已被自己的註解救活 6 次
 *   ② 斷言範圍要縮到「被改的那一塊」 —— 已被隔壁的同樣字串救活 7 次
 *   ③ 決定性對照:把來源覆寫成不可能的值,畫面必須跟著變(⛔ 只比「有沒有那幾個字」會溜過去)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SRC = CODE.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');   // ① 剝註解
const bad = [];
const ok = (n, c, extra = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(extra).slice(0, 220)}`); if (!c) bad.push(n); };

// ═══ 靜態 ═══════════════════════════════════════════════════════
{
    const fn = SRC.slice(SRC.indexOf('_rpDateBarHtml(C) {'), SRC.indexOf('_rpQuickHtml(C) {'));
    ok('⓪a 切得到 _rpDateBarHtml(空過守門)', fn.length > 400, String(fn.length));
    ok('ⓐs 日期走既有的 `_dChip`(⛔ 禁止自己拼日期字串 —— 過期提醒是它做的)',
       /this\._dChip\(C\.kDate/.test(fn) && /this\._dChip\(C\.fenDate/.test(fn), '');
    ok('ⓐs2 ⛔ 零新計算:四個值全部讀 ctx 既有欄位(⛔ 不可自己去翻 K 線或財報算)',
       /C\.kDate/.test(fn) && /C\.yoyM/.test(fn) && /C\.fin\.q/.test(fn) && /C\.fenDate/.test(fn)
       && !/_finTrend|rawDailyData|_loadFund/.test(fn), '');
    ok('ⓐs3 一格都沒有就整條不顯(⛔ 不留空殼)', /if \(!on\.length\) return '';/.test(fn), '');
    // ⚠️ 月份 / 季別不是日期 → ⛔ 不可套 _dChip 的「幾天沒更新」邏輯(8 月營收不會因為過了 5 天就變舊)
    ok('ⓐs4 ⚠️ 月營收 / 財報季別⛔ 不可套 `_dChip`(月/季不是日期,沒有「過期幾天」這回事)',
       !/_dChip\(.*yoyM/.test(fn) && !/_dChip\(.*qm\[/.test(fn), '');

    // ── B:那幾處「來源對比」是使用者分得出「誰說的」的唯一依據 → ⛔ 一個字都不可刪 ──
    const KEEP = ['本站自己貼的', '本站人工整理', '本站沒有驗證', '不是外資喊的', '本站自己回測的'];
    KEEP.forEach(k => ok(`ⓑs 來源對比「${k}」必須還在(⛔ 刪掉使用者就分不出是誰說的)`, SRC.includes(k), ''));
    ok('ⓑs2 快速判別表的來源標籤「⛔ 本站沒有」是正式圖例 → ⛔ 不可被順手刪掉',
       /⛔ 本站沒有/.test(SRC), '');
    // 「現在的價」只准留在 _CHANGELOG(歷史紀錄⛔ 不可改)
    const chg = SRC.indexOf('_CHANGELOG:');
    const live = [...SRC.matchAll(/現在的價/g)].map(m => m.index).filter(i => !(i > chg && i < chg + 200000));
    ok('ⓑs3 「現在的價」統一成「現價」(⛔ _CHANGELOG 那筆是歷史紀錄,不算)',
       live.length === 0, `還有 ${live.length} 處`);

    // ── E:兩個比值的口徑要寫出來,而且⛔ 不可相同 ──
    ok('ⓔs 風報比那塊有「距現價」(⛔ 只印絕對停損價 = 看不出 12 倍是怎麼來的)',
       /風報比\(到第一道壓力 vs 出場總表停損/.test(SRC) && /距現價 \$\{_stopPct\.toFixed\(1\)\}%/.test(SRC), '');
    ok('ⓔs2 主卡那個標明自己是「到目標價 vs ○○線」(⛔ 兩個口徑不可長得一樣)',
       /賺賠比<span[^>]*>\(到目標價 vs \$\{stopLb\}\)/.test(SRC), '');
    ok('ⓔs3 ⛔ 公式一個字都沒動(主卡的 rr 仍是 upPct/dnPct —— 它會驅動 34549 那句 warn)',
       /const rr = \(upPct != null && dnPct != null && dnPct > 0\.3\) \? upPct \/ dnPct : null;/.test(SRC), '');
    ok('ⓔs4 ⛔ `_upsideRoom` 的 rr 公式也沒動(第一道淨賺 ÷ 停損淨賠)',
       /const rr = \(first && risk != null && risk < 0\) \? \(first\.ntd \/ -risk\) : null;/.test(SRC), '');
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
    for (let i = 0; i < 25; i++) { await new Promise(r => setTimeout(r, 600)); if (document.querySelector('[data-rpdate]')) break; }
    const el = document.querySelector('[data-rpdate]');
    const C = A._rpLast;
    const q = (C && C.fin && Array.isArray(C.fin.q) && C.fin.q.length) ? String(C.fin.q[C.fin.q.length - 1].p || '') : '';
    // ③ 決定性對照:把 kDate 覆寫成不可能的日期 → 那一列必須跟著變(⛔ 不可寫死)
    const ctl = (() => {
        try {
            const h0 = A._rpDateBarHtml(C);
            const h1 = A._rpDateBarHtml(Object.assign({}, C, { kDate: '1999-01-04', fenDate: '1999-01-05' }));
            return { same: h0 === h1, hit: /01\/04/.test(h1) && /01\/05/.test(h1), h1: h1.replace(/<[^>]*>/g, ' ').trim() };
        } catch (e) { return { err: String(e) }; }
    })();
    // ⚠️ 斷言範圍縮到「被改的那一塊」:只取 rpQuick,⛔ 不掃整頁(§0 也有那些日期,會救活)
    const qk = document.getElementById('rpQuick');
    return {
        has: !!el, n: el ? +el.dataset.rpdate : 0, txt: el ? el.innerText.replace(/\s+/g, ' ').trim() : '',
        // 日期列必須是 rpQuick 卡頭的**下一個**元素(⛔ 不可飄到別的卡)
        inQuick: !!(el && qk && qk.contains(el)),
        headFirst: !!(el && el.previousElementSibling && /快速判別表/.test(el.previousElementSibling.innerText || '')),
        ctx: { kDate: C && C.kDate, yoyM: C && C.yoyM, q, fenDate: C && C.fenDate },
        ctl,
        quickTxt: qk ? qk.innerText.replace(/\s+/g, ' ').trim().slice(0, 400) : '',
        // E:風報比那一行(總覽的防守價尺)
        ruler: (() => { const e = document.getElementById('guardRulerBox') || document.body; return (e.innerHTML || ''); })(),
    };
});
await browser.close();

// ── C ──
ok('ⓐ0 日期列渲染得出來(空過守門)', R.has && R.n >= 2, `has=${R.has} n=${R.n}`);
ok('ⓐ 在 ⚡ 快速判別表卡內,而且緊接在卡頭那一列下面(⛔ 不塞進 flex row:390px 會擠爆)',
   R.inQuick && R.headFirst, `inQuick=${R.inQuick} headFirst=${R.headFirst} | ${R.txt}`);
ok('ⓐ2 四格的值逐字對得上 ctx(⛔ 不是另算一份)', (() => {
    const t = R.txt;
    const mm = R.ctx.yoyM ? String(R.ctx.yoyM).slice(5, 7) : null;
    const qm = R.ctx.q.match(/^(\d{4})-(\d{2})/);
    return (!mm || t.includes(`營收 ${mm}月`)) && (!qm || t.includes(`財報 ${qm[1]} Q${Math.ceil(+qm[2] / 3)}`));
})(), `${R.txt} | ctx=${JSON.stringify(R.ctx)}`);
ok('ⓐ3 ⭐⭐ 決定性對照:把 kDate/fenDate 覆寫成 1999-01-04/05 → 日期列必須跟著變(⛔ 寫死就紅)',
   !R.ctl.err && !R.ctl.same && R.ctl.hit, JSON.stringify(R.ctl));
ok('ⓐ4 指路到 §0(陷阱 #32:完整 10 個來源在下面,⛔ 不可讓使用者以為只有這 4 個)',
   /§0/.test(R.txt), R.txt);
ok('ⓐ5 一行(≤60 字,⛔ 不可長成一段)', R.txt.replace(/\s/g, '').length <= 60, `${R.txt.replace(/\s/g, '').length} 字`);

console.log(bad.length ? `\n❌ ${bad.length} 條失敗:${bad.join(' / ')}` : '\n✅ RPTIDY_TEST_PASS');
process.exit(bad.length ? 1 : 0);
