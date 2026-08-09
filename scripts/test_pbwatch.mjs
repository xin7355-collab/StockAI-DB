#!/usr/bin/env node
/**
 * 🎯 V72.9.0 明日作戰清單 + 尾盤買點提醒 —— 測試
 *
 * ⛔⛔ 這支存在的**唯一理由**是釘死一條靠人記不住的結論:
 *     **有效進場點是「訊號日尾盤」,⛔ 不是「隔天開盤」。**
 *     實測(portfolio_backtest.mjs,600 檔・13 個月・本金 100 萬):
 *       訊號日尾盤買 +1,361,088 元 / 隔天開盤買 +818,734 元(輸 0050)/
 *       隔天開盤+跳空>1%不追 −147,644 元(倒賠)。
 *     日後有人「順手優化」成開盤提醒,這裡要當場擋下來。
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath, pathToFileURL } from 'url';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};

const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

console.log('① 靜態:文案與時窗鐵則');
// ⛔ 不可出現「明天開盤買/開盤就買」這類指令。
//   ⚠️ 先把**否定句**拿掉再驗 —— 正確的免責句本身一定含有那幾個字
//   (踩過 10 次的坑:「⛔ 不是叫你明天開盤買」會把測試自己絆倒)。
const stripNeg = t => t
    .replace(/[⛔]?\s*(不是|別|勿|不可|絕不)[^。\n<]{0,40}(開盤|追高)[^。\n<]{0,40}/g, '')
    .replace(/隔天開盤買[^。\n<]{0,60}/g, '')       // 回測數字的敘述
    .replace(/開盤就買[^。\n<]{0,40}會把[^。\n<]{0,40}/g, '');
// ⚠️ 用**定義**當邊界,⛔ 不可用裸名字 —— `_refreshTodaySigBadge` 在檔案更前面有呼叫端,
//   `indexOf` 會抓到那個 → 切出空字串,然後 13 條測試全部假失敗(第一版就這樣)。
const _pbA = src.indexOf('_PB_ENTRY_NOTE');
const _pbB = src.indexOf('async _refreshTodaySigBadge()', _pbA);
const pbBlock = (_pbA >= 0 && _pbB > _pbA) ? src.slice(_pbA, _pbB) : '';
ok('① 明日清單區塊存在', pbBlock.length > 2000, `只有 ${pbBlock.length} 字`);
ok('①a ⛔ 沒有「明天開盤買」這種指令(已排除否定句)',
   !/(明天|隔日|隔天)\s*開盤\s*(就)?買/.test(stripNeg(pbBlock)));
ok('①b 有明講正確時點是尾盤', /尾盤/.test(pbBlock) && /13:00/.test(pbBlock));
// 時窗常數:⛔ 不可涵蓋開盤時段
const from = +(/_EOD_FROM:\s*(\d+)\s*\*\s*60\s*\+\s*(\d+)/.exec(src)?.[1]) * 60 + +(/_EOD_FROM:\s*\d+\s*\*\s*60\s*\+\s*(\d+)/.exec(src)?.[1] || 0);
const to = (() => { const m = /_EOD_TO:\s*(\d+)\s*\*\s*60\s*\+\s*(\d+)/.exec(src); return m ? +m[1] * 60 + +m[2] : -1; })();
ok('①c 掃描時窗不早於 13:00', from >= 13 * 60, `from=${from}`);
ok('①d 掃描時窗不晚於 13:30(來不及下單)', to > from && to <= 13 * 60 + 30, `to=${to}`);

console.log('② 靜態:限量與紀律');
// ⭐⭐ V73.0.0 實測:每天做 2 檔賺 1,718,529 元、3 檔 1,361,088、6 檔只剩 735,938
//   → 推播上限改成 **2**(掃 8 檔但最多推 2 則,因為不是每檔都會真的成立)。
//   ⛔ 日後有人「順手放寬」成推更多,這裡要擋下來。
ok('②a 推播有嚴格上限(⛔ 全推等於使用者關通知)', /ranked\.slice\(0,\s*[1-9]\)/.test(pbBlock), '找不到 slice 限量');
ok('②a2 ⭐ 一天最多推 2 檔(⛔ 實測做越多賺越少)',
   /if \(_pushed >= 2\) break;/.test(pbBlock) && /_pushed\+\+;/.test(pbBlock));
ok('②a3 清單上有明講「一天最多做前 2 檔」+ 數字', /一天最多做前 2 檔就好/.test(pbBlock) && /1,718,529/.test(pbBlock));
ok('②a4 ⛔ 停損維持原樣(-3% 那個改善在 2 檔設定下反而更差,教學要留著這個反例)',
   /單獨測有效 != 合起來還有效/.test(src));
ok('②b 推播內容一定帶停損', /停損/.test(pbBlock) && /_fireAlert\(`🚨 尾盤買點成立/.test(pbBlock));
ok('②c 推播內容一定帶「會錯幾次」的心理準備', /十次會錯七次/.test(pbBlock));
ok('②d 有當日去重(⛔ 同一檔同一招不可重複吵)', /_kbarFiredToday\(dkey\)/.test(pbBlock));
ok('②e 沒開通知 / 沒開自選提醒 → 不做事', /settings\?\.watchlistAlert/.test(pbBlock) && /Notification\.permission !== 'granted'/.test(pbBlock));

console.log('③ 靜態:⛔ 不可拿估計觸發價當成交條件');
ok('③a 盤中是**重算**不是比大小', /_pbExactCheck/.test(pbBlock) && /_playbookPatternDefs\(ext\)/.test(pbBlock));
ok('③b 重算用的是 App 自己的偵測器(⛔ 不複製判定邏輯)',
   !/function\s+_myOwnPatternTest/.test(pbBlock) && /p\.test\(ext\.length - 1\)/.test(pbBlock));
ok('③c 沒真的成立就不推', /if \(!chk \|\| !chk\.fired\) continue;/.test(pbBlock));
ok('③d 量的單位走共用 _volToLots(⛔ 別各判一次,V72.4.3 教訓)', /this\._volToLots\(live\.volume\)/.test(pbBlock));
ok('③e 同一天不可 append 成兩根 K', /norm\.slice\(0, -1\)\.concat/.test(pbBlock));

console.log('④ 靜態:「該買幾張」—— 兩個問題兩個答案(⛔ 刻意不共用)');
// 🚨 V73.0.1 實測抓到:App 原本用「風險法」給張數,但那從來沒被回測過。
//   同樣每天 2 檔、只改部位大小(600 檔・13 個月・本金 100 萬):
//     等權       +1,718,529 元 ・回撤 −9.31% ・資金使用率 92%
//     風險法 1%    +593,234 元 ・回撤 −9.15% ・資金使用率 59%  ← 還輸 0050(+832,500)
//   回撤幾乎一樣 → ⛔ 不是取捨,是單純比較差。→ 清單/推播/條件單一律改等權。
// 🚨 這條第一次跑就抓到真 bug:函式被呼叫但**根本沒定義**(改檔腳本中途 assert 失敗,
//   只寫進了呼叫端)。⚠️ smoke_test 抓不到 —— 沙箱沒有 playbook 資料,那段程式不會執行。
//   ⭐ 教訓:「新增共用函式」要同時驗**定義存在**與**呼叫端都接上**,只驗其中一邊會漏。
ok('④0 明日清單用**等權** _lotsForPlaybook(⛔ 不可退回風險法)',
   /_lotsForPlaybook\(price, stop\)\s*\{/.test(src)
   && !/const ps = this\._lotsForRisk\(/.test(src));
ok('④0b 三個顯示點(清單/推播/條件單)都接上了',
   (src.match(/this\._lotsForPlaybook\(/g) || []).length >= 3);
ok('④0c 等權的代價要誠實顯示(每筆風險%會浮動)',
   /riskPct/.test(src) && /本金的 \$\{ps\.riskPct\.toFixed\(1\)\}%/.test(src));
ok('④0d 停損太寬要警告(超過本金 2%)', /一次會虧超過本金 2%,可考慮減量/.test(src));
// 🧩 V73.1.0 零股:⛔ 只算整張會讓 20% 的候選(而且是排名最前面的高價股)被整個跳過
ok('④0e ⭐ 支援零股(用**股數**算,⛔ 不是只算整張)',
   /const shares = Math\.floor\(budget \/ price\)/.test(src) && /oddOnly/.test(src));
ok('④0f 零股要明講「下單要選零股」', /這是<b>零股<\/b>,下單要選「零股」/.test(src));
ok('④0g 買法要白話(1 張 + N 股 / N 股)',
   src.includes('張 + ${odd} 股') && src.includes('${odd} 股(零股)'));
const lotsDefs = (src.match(/_lotsForRisk\(price, stop\)\s*\{/g) || []).length;
ok('④a _lotsForRisk 只定義一次', lotsDefs === 1, `定義了 ${lotsDefs} 次`);
ok('④b 部位風控卡改用共用函式', /const _ps = this\._lotsForRisk\(price, stop\);/.test(src));
const inlineLots = (src.match(/Math\.floor\(riskAmt \/ \(risk/g) || []).length;
ok('④c ⛔ 沒有殘留的第二份 inline 公式', inlineLots === 0, `還有 ${inlineLots} 處`);

console.log('⑤ 採礦端:門檻與免責');
const scan = fs.readFileSync(path.join(ROOT, 'scripts/playbook_scan.mjs'), 'utf8');
// ⭐ V72.9.2 起門檻升級成「**保守下界**扣成本後仍為正」,⛔ 不是原始期望值。
//   理由:2,317 檔 × 22 招排期望值取前面,前段班必然被「樣本少但剛好很賺」佔滿
//   (首跑實測首名 每趟 +17.63%・賺賠比 12.63・只有 24 次 = 選樣偏誤)。
ok('⑤a 門檻用**保守下界**扣成本(⛔ 不可退回原始期望值)', /\(lb\(x\) - cost\) > 0/.test(scan));
ok('⑤a2 下界公式是 期望值 − 1.28×sd/√n', /x\.expectancy - 1\.28 \* \(x\.sd \|\| 0\) \/ Math\.sqrt/.test(scan));
// ⚠️ V73.2.4 起 picks.sort 前面多了 hq(高位階+高波動)這一鍵 —— 但**下界仍必須在排序式子裡**,
//    ⛔ 不可退回原始期望值。這條同時釘住「hq 只能是第一鍵、lb 必須緊接在後」。
ok('⑤a3 ⛔ 排序也要用下界(只改門檻等於沒改)', /sort\(\(a, b\) => lb\(b\) - lb\(a\)\)/.test(scan) && /picks\.sort\(\(a, b\) => \(b\.hq - a\.hq\) \|\| \(b\.lb - a\.lb\)/.test(scan));
// 🧬 V73.2.4 高位階+高波動(六道關卡全過的唯一一組)
ok('⑤a3b 掃描端要算這檔自己的位階與波動率', /selfRank = Math\.round/.test(scan) && /selfVol = cn >= 10/.test(scan));
ok('⑤a3c hq 門檻寫死 75/60,且⛔ 不符合的仍要輸出(只標記不刪除)',
   /rank >= 75 && r\.vol != null && r\.vol >= 60/.test(scan) && /picks\.push\(\{ s: sym/.test(scan));
ok('⑤a3d 尾盤推播 hq 優先,但只影響排序',
   /const _hq = x => \(this\.settings\?\.pbHqOff \? 0 : \(\+x\.hq \|\| 0\)\)/.test(src) && /_hq\(b\) - _hq\(a\)/.test(src));
ok('⑤a3e 卡上必須寫「空頭沒有驗證過」(⛔ 不可只報好消息)', /空頭沒有驗證過/.test(src));
ok('⑤a3f 徽章⛔ 不可用紅綠(燈號鐵則:紅綠只表示漲跌方向)',
   /🧬 強勢高波動/.test(src) && !/text-(red|green)-\d00[^>]*>🧬 強勢高波動/.test(src));
ok('⑤a4 _patternFitBacktest 有回 sd', /const sd = n > 1 \? Math\.sqrt/.test(src) && /expectancy: mean, sd,/.test(src));
ok('⑤a5 前端顯示與排序也用下界', /const shown = Number\.isFinite\(\+x\.lb\)/.test(src) && (src.match(/const _lb = x => Number\.isFinite\(\+x\.lb\)/g) || []).length === 2);
ok('⑤a6 沒有觸發價(loose)時⛔ 不可顯示「漲過 null」', /const hasTrig = x\.trig != null/.test(src) && /這招不是靠價位觸發/.test(src));
// ⚠️ V72.9.4 起這條由 ⑤a10 用「進位到跳動單位之後」的版本承接(更嚴)。
//   ⛔ 這裡改驗「⛔ 不可退回成無條件回傳 b2」——原始 b2 沒對齊跳動單位也可能 <= 現價。
ok('⑤a7 ⛔ 不可無條件回傳原始二分結果(要先進位、round、再比現價)',
   !/return \{ trig: b2 \};/.test(scan) && /return \{ trig: upR \};/.test(scan));
ok('⑤a8 loose 一律不給觸發價(⛔ 不可回一個假的價)',
   !/return \{ trig: lo, loose: true \}/.test(scan) && /if \(firstHit === 0\) return \{ loose: true \}/.test(scan));
ok('⑤a9 觸發價**無條件進位**到跳動單位(⛔ 四捨五入會低於真門檻=叫人提早買)',
   /Math\.ceil\(\(b2 - 1e-9\) \/ tickOf\(b2\)\) \* tickOf\(b2\)/.test(scan)
   && /const tickOf = v => v < 10 \? 0\.01/.test(scan));
ok('⑤a10 進位後沒真的高於現價 → 當成無閘門(⛔「漲過 90.1」而現價 90.1 是零資訊)',
   /if \(upR <= cR\) return \{ loose: true \};/.test(scan));
ok('⑤a11 ⭐ 守門要驗「將會被存下來的那個值」(⛔ 不可驗中間值 —— 浮點會漏)',
   /const upR = Math\.round\(up \* 100\) \/ 100;/.test(scan) && /return \{ trig: upR \};/.test(scan));
// ⭐⭐ 第六輪才修對:上一版只把**一邊**換成顯示值(upR),另一邊 c0 還是原始浮點
//   → 16.65 <= 16.6499996 是 false,守門放行,但畫面兩邊都印 16.65。
ok('⑤a13 ⭐⭐ 比較的**兩邊**都要是顯示值(⛔ 只換一邊等於沒換)',
   /const cR = Math\.round\(c0 \* 100\) \/ 100;/.test(scan) && /if \(upR <= cR\) return \{ loose: true \};/.test(scan));
ok('⑤a14 輸出的現價與守門用的 cR 是同一個式子(⛔ toFixed 與 round 在 .005 邊界會不一致)',
   /return \{ c: Math\.round\(c0 \* 100\) \/ 100, v:/.test(scan));
ok('⑤a12 跳動單位看**進位後**那個價落在哪一檔(498→501 會跨檔)',
   /const tk = tickOf\(up\)/.test(scan));
ok('⑤b 有樣本門檻', /x\.count >= minN/.test(scan));
ok('⑤c 用「這一檔自己」的成績(⛔ 不是全市場平均)', /_patternFitBacktest\(rows\)/.test(scan));
ok('⑤d 有截斷就把總數寫進 JSON(no silent caps)', /picks_total/.test(scan) && /picks_cap/.test(scan));
ok('⑤e 輸出帶「⛔ 不是明天開盤買」的使用說明', /how:/.test(scan) && /不是「明天開盤買/.test(scan));
ok('⑤f 有空過守門(掃到 0 筆不寫檔)', /process\.exit\(1\)/.test(scan) && /一筆候選都沒有/.test(scan));
ok('⑤g playwright 路徑自動判斷(⛔ 不靠 workflow sed 改原始碼)',
   /await import\('playwright'\)/.test(scan) && /fs\.existsSync\(_exec\)/.test(scan));

console.log('⑥ 實跑:載入 App,驗函式行為');
const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
const errs = [];
// ⚠️ echarts 走 CDN,沙箱連不到 → 那個 ReferenceError 是環境問題不是本次改動
//   (smoke_test 也是同樣處理)。⛔ 只濾這一個,別把真的錯誤一起濾掉。
page.on('pageerror', e => { const m = String(e); if (!/echarts is not defined/.test(m)) errs.push(m); });
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._lotsForRisk, null, { timeout: 25000 });

const r = await page.evaluate(() => {
    const out = {};
    // 沒填帳戶資金 → 回 acc:0,⛔ 不可自己編一個本金
    app.settings = app.settings || {};
    app.settings.accountSize = 0;
    out.noAcc = app._lotsForRisk(100, 95);
    // 填了 100 萬、風險 1% → 每股風險 5 元 → 風險金額 10,000 → 2 張
    app.settings.accountSize = 1000000; app.settings.riskPct = 1;
    out.calc = app._lotsForRisk(100, 95);
    // 單檔上限 25%:便宜股停損很近時張數會爆 → 要被壓住
    out.capped = app._lotsForRisk(10, 9.9);
    // 停損 >= 價 → 不可回出張數
    out.bad = app._lotsForRisk(100, 100);
    // 時窗函式
    out.tpe = app._tpeMinutes();
    out.hasSweep = typeof app._eodTriggerSweep === 'function' && typeof app._pbExactCheck === 'function';
    return out;
});
ok('⑥a 沒填帳戶資金 → acc=0 且不給張數', r.noAcc.acc === 0 && !r.noAcc.lots);
ok('⑥b 100萬・風險1%・每股風險5元 → 2 張', r.calc.lots === 2, JSON.stringify(r.calc));
ok('⑥c 最多虧 = 2張×1000股×5元 = 10,000 元', r.calc.maxLoss === 10000, String(r.calc.maxLoss));
ok('⑥d 單檔上限 25% 有生效', r.capped.capped === true && r.capped.investAmt <= 250000, JSON.stringify(r.capped));
ok('⑥e 停損不低於價 → 0 張(⛔ 不可算出無限大)', !r.bad.lots);
ok('⑥f 台北時間函式回得出星期與分鐘', /^[A-Z][a-z]{2}$/.test(r.tpe.wd) && r.tpe.min >= 0 && r.tpe.min < 1440, JSON.stringify(r.tpe));
ok('⑥g 尾盤掃描函式都在', r.hasSweep);

// ⑦ 空過守門:確認上面那些斷言真的跑在**有載起來**的 App 上
ok('⑦ 無 pageerror', errs.length === 0, errs.slice(0, 2).join(' | '));


console.log('⑧ 紀律追蹤:出場提醒⛔ 不可限量、⛔ 不可預設你買了');
const trkA = src.indexOf('_PB_TRADES_KEY:');
const trkB = src.indexOf('_startEodWatcher()', trkA);
const trk = (trkA >= 0 && trkB > trkA) ? src.slice(trkA, trkB) : '';
ok('⑧ 紀律追蹤區塊存在', trk.length > 2000, `只有 ${trk.length} 字`);
ok('⑧a ⛔ 不預設「你買了」(took 初始為 null)', /took: null/.test(trk));
ok('⑧b 只有標記 took===true 才盯停損', /x\.t\.took === true/.test(trk));
ok('⑧c 停損提醒⛔ 不是一天一次(用時間分桶才能重複提醒)',
   /Math\.floor\(Date\.now\(\) \/ 1800000\)/.test(trk));
ok('⑧d 出場守望⛔ 不受 13:00 時窗限制', /不受 13:00 時窗限制/.test(src));
ok('⑧e 停利用的是回測同一條規則(跌破 5MA)', /跌破 5 日線/.test(trk) && /ma5/.test(trk));
ok('⑧f 金額走共用 _netPL(⛔ 別 inline 再寫一份損益公式)',
   /this\._netPL\(t\.e, px, 1000\)/.test(trk));
ok('⑧g localStorage 寫入有包 try(空間不足會 throw,陷阱 #18)',
   /try \{ localStorage\.setItem\(this\._PB_TRADES_KEY/.test(trk));
ok('⑧h 讀取走 _lsJson(壞值自動清掉)', /this\._lsJson\(this\._PB_TRADES_KEY/.test(trk));
ok('⑧i 一筆都沒有 → 整塊不顯示(不留空殼)', /if \(!rows\.length\) return '';/.test(trk));
ok('⑧j 觸發時有記一筆待確認', /this\._pbRecordFire\(sym, x\.k, chk\.price, chk\.stop, x\)/.test(src));


console.log('⑨ 自動/半自動交易(V72.9.9)');
ok('⑨a 條件單複製一定要講「尾盤 vs 觸價」的時點落差(⛔ 不可省略)',
   /_copyCondOrder/.test(src) && /回測是「尾盤買」算的;條件單是「觸價就買」/.test(src));
ok('⑨b 沒有固定觸發價的不給條件單(⛔ 不可硬編一個價)',
   /x\.trig == null\) \{ alert\('這一檔沒有固定的觸發價/.test(src));
ok('⑨c 實盤記錄一定要問「實際成交價」(⛔ 拿觸發價充當會把滑價藏起來)',
   /你實際成交在多少\?/.test(src) && /all\[i\]\.slip = /.test(src));
ok('⑨d 出場也要問實際賣價,金額走共用 _netPL', /你實際賣在多少\?/.test(src) && /this\._netPL\(base, v, 1000\)/.test(src));
ok('⑨e 樣本不足⛔ 不下結論', /還不能下任何結論/.test(src) && /_wrEnough/.test(src));
ok('⑨f 沒有實盤紀錄 → 整塊不顯示(不留空殼)', /_pbScoreHtml\(\) \{[\s\S]{0,400}?if \(!done\.length\) return '';/.test(src));

// 🔐 最重要的一條:下單程式絕不可進 CI
const at = fs.existsSync(path.join(ROOT, 'auto_trade.py')) ? fs.readFileSync(path.join(ROOT, 'auto_trade.py'), 'utf8') : '';
ok('⑨g auto_trade.py 存在', at.length > 2000);
ok('⑨h ⛔ 預設是模擬模式(要真下單必須明確設 LIVE=1)', /LIVE = os\.getenv\('LIVE'\) == '1'/.test(at) && /simulation=not LIVE/.test(at));
ok('⑨i 憑證只走環境變數(⛔ 不可寫進檔案)', /os\.getenv\('SJ_CA_PATH'\)/.test(at) && !/\.pfx['"]\s*$/m.test(at));
ok('⑨j 有單筆張數與金額硬上限', /MAX_LOTS_PER_TRADE/.test(at) && /MAX_AMT_PER_TRADE/.test(at));
ok('⑨k 時窗鎖在尾盤(⛔ 不可整天跑)', /EOD_FROM/.test(at) && /if mins > EOD_TO/.test(at));
ok('⑨l 沒有觸發價的一律跳過(⛔ 不可用「差不多的條件」代替)', /本機跳過,請看 App 提醒/.test(at));
ok('⑨m 送出後立刻記狀態(寧可漏一次也不重複下單)', /st\['done'\]\.append\(sym\); save_state\(st\)/.test(at));
// 🚨 V73.0.1:改了 App 的部位算法卻忘了改這支(陷阱 #37),而它是**會下真單**的。
ok('⑨p ⭐ 下單程式也用**等權**(⛔ 不可留著風險法 —— 實測少賺 112 萬)',
   /def shares_for_playbook/.test(at) && !/def lots_for_risk/.test(at) && /POS_PCT/.test(at));
ok('⑨p2 🧩 下單程式支援零股,而且整張/零股分開送(⛔ 委託類別不可混)',
   /StockOrderLot\.IntradayOdd/.test(at) && /StockOrderLot\.Common/.test(at)
   && /divmod\(shares, 1000\)/.test(at));
ok('⑨q 一天最多 2 檔(跟 App 一致)', /MAX_PICKS', '2'/.test(at));
ok('⑨r 停損太寬要印警告(等權的代價要講出來)', /超過 2%,考慮手動減量/.test(at));
{
  const wf = fs.readdirSync(path.join(ROOT, '.github/workflows'));
  const hit = wf.filter(f => /\.ya?ml$/.test(f) &&
      /auto_trade\.py|SJ_CA_PASSWD|SJ_PERSON_ID/.test(fs.readFileSync(path.join(ROOT, '.github/workflows', f), 'utf8')));
  ok('⑨n 🔐 ⛔ 下單程式/憑證機密沒有出現在任何 workflow(repo 是 public)', hit.length === 0, hit.join(','));
}
const cwp = fs.readFileSync(path.join(ROOT, 'scripts/check_workflow_paths.py'), 'utf8');
ok('⑨o 這條規則有納入 push 前四驗證(⛔ 光靠人記會忘)',
   /def check_no_trading_in_ci/.test(cwp) && /ok = check_no_trading_in_ci\(\) and ok/.test(cwp));

await browser.close();
console.log(`\n${fail ? '❌' : '✅'} ${pass} 通過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);
