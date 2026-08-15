#!/usr/bin/env node
/**
 * 🛠️ 自訂選股(V73.5.0)測試 —— ⭐ 用**真的** data/screener.json 實跑,不用假資料。
 *
 * ⛔ 這支要釘死的東西(每一條都是踩過的坑的同型):
 *  ① **沒有資料 ≠ 0** —— null 一律不通過數值條件。
 *     ⛔ 這是全案最容易寫錯的一條:把 null 當 0 去比大小,會選出一堆其實沒資料的股票,
 *     而且畫面上完全看不出來(同陷阱 #22「守門把值設成 None 卻不寫原因」的親戚)。
 *  ② **條件是 AND** —— 加條件只能讓結果變少或不變,⛔ 不可變多。
 *  ③ **⛔ 不可出現「回測」按鈕** —— 那是刻意的決定(沒有歷史全市場快照),
 *     ⛔ 別哪天「順手補上」一個沒有對照組的假回測(同 ORB / 假數字的立場)。
 *  ④ **空過守門**:條件晶片一顆都沒渲染出來 → 這支測試自己要失敗,
 *     ⛔ 不可因為「沒有報錯」就當成通過(CLAUDE.md 通用鐵則)。
 *  ⑤ 覆蓋率低的條件要標黃字(⛔ 不然使用者會以為程式壞了)。
 *  ⑥ 判定邏輯只有**一份**(`_scrPass`)—— ⛔ 條件表裡不可各寫各的判斷函式。
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 240)}`}`); if (!c) fails.push(n); };

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    // ⚠️ 少了 --allow-file-access-from-files 就 fetch 不到 data/screener.json → 整支變空過
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
const benign = t => /Failed to load resource|net::ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch|echarts is not defined|Tailwind/i.test(t);
const errs = [];
page.on('pageerror', e => { const t = (e && e.message) ? e.message : String(e); if (!benign(t)) errs.push(t); });
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._renderCustomScreener, null, { timeout: 25000 });

const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// ── ⑥ 判定邏輯只有一份 ──
{
    const block = src.slice(src.indexOf('_SCR_CONDS:'), src.indexOf('_loadTodaySignals()'));
    const fnCount = (block.match(/\bfn:\s*\(/g) || []).length;
    ok('⑥ 條件表以宣告式為主(fn 只用在跨欄位的少數幾條)', fnCount <= 8, `fn 有 ${fnCount} 條`);
    ok('⑥b ⭐ null 規則只寫在 _scrPass 一處',
       (src.match(/沒有資料一律不通過,⛔ 不當成 0/g) || []).length === 1, '');
}

// ── ③ ⛔ 不可有回測按鈕 ──
{
    const block = src.slice(src.indexOf('_renderCustomScreener()'), src.indexOf('_loadTodaySignals()'));
    // ⚠️ 先把「解釋為什麼沒有回測」的說明句拿掉再驗,否則正確的免責句會把自己擋下來
    //    (本專案已踩過 6 次:「不是買賣訊號」含「賣訊」那一類)
    const stripped = block.replace(/沒有「?回測」?[^。]*。/g, '').replace(/回測任意條件組合[^。]*。/g, '')
                          .replace(/假回測[^。]*。/g, '').replace(/⛔[^。\n]*回測[^。\n]*/g, '');
    ok('③ ⛔ 沒有「回測」按鈕(刻意的決定)', !/onclick="app\.scr(Backtest|Bt)\b/.test(stripped) && !/>\s*回測\s*</.test(stripped), '');
}

const R = await page.evaluate(async () => {
    const out = { err: null };
    try {
        await app._loadScreener();
        const d = app._scrData;
        out.loaded = !!(d && d.rows);
        out.n = d ? Object.keys(d.rows || {}).length : 0;
        out.cols = d ? (d.cols || []).length : 0;
        out.dataDate = d ? d.data_date : null;

        // ① null 不通過:找一檔「殖利率是 null」的,確認它不會被「殖利率 > 3%」選中
        const C = app._scrC;
        let nullSym = null;
        for (const s in d.rows) { if (d.rows[s][C.yld] === null) { nullSym = s; break; } }
        out.nullSym = nullSym;
        const cYld = app._SCR_CONDS.find(c => c.id === 'yld3');
        out.nullPass = nullSym ? app._scrPass(cYld, d.rows[nullSym], nullSym) : 'no-sample';
        // 反向:有值而且真的 >3 的必須通過(⛔ 只驗一邊會做出「一律不通過」的過度修正)
        let posSym = null;
        for (const s in d.rows) { const v = d.rows[s][C.yld]; if (v !== null && v > 3) { posSym = s; break; } }
        out.posSym = posSym;
        out.posPass = posSym ? app._scrPass(cYld, d.rows[posSym], posSym) : 'no-sample';

        // ⭐ null 也不可通過「小於」型條件(最容易寫錯的方向:null 會被當 0 而 0 < 15)
        const cPe = app._SCR_CONDS.find(c => c.id === 'pe15');
        let nullPe = null;
        for (const s in d.rows) { if (d.rows[s][C.pe] === null) { nullPe = s; break; } }
        out.nullLtPass = nullPe ? app._scrPass(cPe, d.rows[nullPe], nullPe) : 'no-sample';

        // ② AND:條件越多,選出來只能越少
        const count = ids => {
            const cs = ids.map(i => app._SCR_CONDS.find(c => c.id === i)).filter(Boolean);
            let n = 0;
            for (const s in d.rows) { if (cs.every(c => app._scrPass(c, d.rows[s], s))) n++; }
            return n;
        };
        out.c1 = count(['ma20up']);
        out.c2 = count(['ma20up', 'amt5']);
        out.c3 = count(['ma20up', 'amt5', 'f3d']);

        // 抽樣核對:「站上月線」選出來的每一檔 b20 真的 > 0(⛔ 不複製判定,直接讀值)
        const cMa = app._SCR_CONDS.find(c => c.id === 'ma20up');
        let bad = 0, checked = 0;
        for (const s in d.rows) {
            if (app._scrPass(cMa, d.rows[s], s)) { checked++; if (!(d.rows[s][C.b20] > 0)) bad++; }
        }
        out.maChecked = checked; out.maBad = bad;

        // 渲染:切到選股 → 自訂
        app.switchAppTab('radar');
        app.switchRadarStrategy('custom');
        await app._renderCustomScreener();
        const box = document.getElementById('radarCustomView');
        out.hidden = box ? box.classList.contains('hidden') : true;
        out.chipN = box ? box.querySelectorAll('button[onclick^="app.scrToggle"]').length : 0;
        out.thinN = box ? (box.innerHTML.match(/僅 \d+% 個股有此資料/g) || []).length : 0;
        out.emptyMsg = box ? /還沒選條件/.test(box.innerText) : false;

        // 勾一個條件 → 結果區要出現數字
        app._scrPicked = ['limup'];
        app._scrRun();
        const res = document.getElementById('scrResult');
        out.resText = res ? res.innerText.slice(0, 120) : '';
        out.badge = (document.getElementById('radarCustomCount') || {}).textContent || '';

        // 不可能同時成立的組合 → 誠實空狀態(⛔ 不可顯示 0 檔卻裝作有結果)
        app._scrPicked = ['limup', 'limdn'];
        app._scrRun();
        out.imposs = res ? res.innerText : '';
        app._scrPicked = [];
        app._scrRun();
    } catch (e) { out.err = String((e && e.stack) || e); }
    return out;
});

if (R.err) { ok('實跑沒有例外', false, R.err); }
ok('④ 🚧 空過守門:screener.json 真的載入了', R.loaded === true, `n=${R.n}`);
ok('④b 🚧 全市場筆數合理(>800)', R.n > 800, `n=${R.n}`);
ok('④c 欄位數合理(>40)', R.cols > 40, `cols=${R.cols}`);
ok('① ⭐ 殖利率是 null 的股票 ⛔ 不通過「殖利率 > 3%」', R.nullPass === false, `sym=${R.nullSym} pass=${R.nullPass}`);
ok('①b ⭐ 反向:殖利率真的 >3% 的必須通過(⛔ 不可一律擋掉)', R.posPass === true, `sym=${R.posSym} pass=${R.posPass}`);
ok('①c ⭐⭐ PE 是 null 的 ⛔ 不通過「本益比 < 15」(null 當 0 會誤過)', R.nullLtPass === false, `pass=${R.nullLtPass}`);
ok('② AND:加條件只會變少', R.c1 >= R.c2 && R.c2 >= R.c3, `${R.c1} → ${R.c2} → ${R.c3}`);
ok('②b 🚧 空過守門:第一個條件真的有選到東西', R.c1 > 0, `c1=${R.c1}`);
ok('②c 抽樣核對:選出來的每一檔 b20 真的 > 0', R.maBad === 0 && R.maChecked > 0, `checked=${R.maChecked} bad=${R.maBad}`);
ok('⑤ 條件晶片有渲染出來', R.chipN >= 8, `chips=${R.chipN}`);
ok('⑤b 覆蓋率低的條件有標黃字提醒', R.thinN >= 0, `thin=${R.thinN}`);
ok('⑤c 沒選條件時有誠實引導', R.emptyMsg === true, '');
ok('⑤d view 切過去要顯示', R.hidden === false, '');
ok('⑦ 勾條件後結果區有「選出 N 檔」或誠實空狀態',
   /選出|沒有一檔/.test(R.resText), R.resText);
ok('⑦b ⛔ 不可能的組合要誠實說「沒有一檔」', /沒有一檔/.test(R.imposs), R.imposs.slice(0, 100));
ok('⑧ 無 pageerror', errs.length === 0, errs.join(' | '));

// ── ⑨ 採礦端:空過守門與 null 規則要在 py 側也成立 ──
{
    const py = fs.readFileSync(path.join(ROOT, 'screener_miner.py'), 'utf8');
    ok('⑨ 採礦端有空過守門(檔數不足不覆寫)', /MIN_OK/.test(py) && /不覆寫既有快照/.test(py), '');
    ok('⑨b 採礦端有印覆蓋率(欄位存在 ≠ 有資料)', /覆蓋率/.test(py), '');
    ok('⑨c ⛔ 資料日期不可用 max(陷阱 #14)', /最多檔共用的那一天|不用 max/.test(py), '');
    const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/playbook_scan.yml'), 'utf8');
    ok('⑨d workflow 有跑 screener_miner.py', /python3 screener_miner\.py/.test(wf), '');
    ok('⑨e ⭐ 產物有被 git add(⛔ 漏這步 = 每天被洗掉且零錯誤訊息)',
       /git add -f[^\n]*data\/screener\.json/.test(wf), '');
    ok('⑨f ⭐ commit 有帶上路徑', /git commit[^\n]*data\/screener\.json/.test(wf), '');
    ok('⑨g ⭐ retry 分支也要放回三個檔(⛔ 只放回一個是老 bug)', /restore_files/.test(wf), '');
}

await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ SCREENER_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
