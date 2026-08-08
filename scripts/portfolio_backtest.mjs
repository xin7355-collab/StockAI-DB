#!/usr/bin/env node
/**
 * 💼 「每天挑 3 檔、照 App 的打法進出」組合回測 —— vs 同期 0050 買進持有
 *
 * 使用者的問題:「如果有一筆錢,每天推薦我 3 隻個股,依照你給的打法及離場,
 *                每個月勝率多少?獲利幾%?跟同時段的 0050 比呢?」
 *
 * ⛔⛔ 最關鍵的方法論陷阱:**前視偏誤(look-ahead bias)**
 *    `_SIGNAL_EDGE` / `_patternFitBacktest` 的成績是用**全期間**算出來的。
 *    如果拿「哪個型態期望值高」去選股,等於**用未來的資訊決定今天買什麼** ——
 *    那種回測一定漂亮,而且一定假。
 *    ⭐ 這裡改成 **walk-forward**:第 T 天選股時,只准用「**出場日 < T**」的
 *      已完成交易來算型態成績。暖身期(前 WARMUP 天)只累積、不下單。
 *
 * ⛔ 其他必須遵守的(CLAUDE.md 鐵則):
 *   ・打法與出場**直接呼叫 App 自己的** `_playbookPatternDefs()`,⛔ 不複製一份判定邏輯
 *   ・**扣交易成本**(來回 0.44%:買賣手續費 0.1425%×2×折數 + 賣出證交稅 0.3%)
 *   ・對照組 = **同期 0050 買進持有**(⛔ 不是跟 0 比)
 *   ・倖存者偏誤:`data/` 只有還在市場的股票 → 結果**偏樂觀**,報告要寫明
 *   ・分層抽樣:⛔ 不可用 `files.sort().slice(0,N)`(台股代號帶產業意義,
 *     那等於只測傳產金融 —— V72.1.7 踩過)
 *
 * 跑法:node scripts/portfolio_backtest.mjs [檔數] [每天幾檔]
 *       node scripts/portfolio_backtest.mjs 600 3
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath, pathToFileURL } from 'url';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_SYMS = +(process.argv[2] || 600);
const PICKS_PER_DAY = +(process.argv[3] || 3);
const WARMUP = 240;          // 暖身:前 N 個交易日只累積成績、不下單
// 🚨 V2 改法(600 檔首跑抓到的真問題):第一版用「**全市場**型態平均期望值」排序,
//   結果 576 筆裡有 **479 筆全押同一招**(站上長黑K壓力,每趟只有 +0.30%)——
//   因為同一個型態當天可能 50 檔觸發,而它們的分數**完全一樣**,等於在亂挑。
//   ⭐ 使用者要的是「**每個個股都有最好的打法**」= App 的「打法適配儀」(每檔自己的歷史),
//     ⛔ 不是全市場平均。→ 成績改成 **per-stock × per-pattern**。
const MIN_N = +(process.env.MIN_N || 4);   // **這一檔**在**這個型態**打過幾次才准用
const MIN_MKT_N = 20;                       // 全市場該型態的最低樣本(第二層門檻)
const ENTRY = process.env.ENTRY || 'close';   // close | nextopen | nextclose(見 page.evaluate 內註解)
const COST = 0.44;           // 來回交易成本 %(手續費 0.1425%×2 + 證交稅 0.3%,未打折)
const LOT = +(process.env.LOT || 100000);        // 每筆投入(等權)
const CAPITAL = +(process.env.CAPITAL || 1000000); // 💰 你手上的總本金 —— 錢用完就買不了(這才貼近現實)

// ── 分層抽樣:每個代號開頭各取,⛔ 不可只取前 N(那等於只測傳產金融)──────
const files = fs.readdirSync(path.join(ROOT, 'data'))
    .filter(f => /^\d{4}\.json$/.test(f)).map(f => f.slice(0, 4)).sort();
const byHead = {};
for (const s of files) (byHead[s[0]] ||= []).push(s);
const syms = [];
{
    const heads = Object.keys(byHead).sort();
    let i = 0;
    while (syms.length < Math.min(MAX_SYMS, files.length)) {
        let added = false;
        for (const h of heads) {
            if (byHead[h][i]) { syms.push(byHead[h][i]); added = true; }
            if (syms.length >= MAX_SYMS) break;
        }
        if (!added) break;
        i++;
    }
}
const cover = {};
for (const s of syms) cover[s[0]] = (cover[s[0]] || 0) + 1;
console.log(`💼 組合回測 ・${syms.length} 檔(分層抽樣,代號開頭分布 ${JSON.stringify(cover)})`);
console.log(`   每天最多挑 ${PICKS_PER_DAY} 檔 ・本金 ${CAPITAL.toLocaleString()} 元 ・每筆 ${LOT.toLocaleString()} 元 ・暖身 ${WARMUP} 日 ・成本 ${COST}%/趟 ・進場=${ENTRY}\n`);

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._playbookPatternDefs, null, { timeout: 25000 });

// ── ① 掃全部候選:每檔每天觸發哪些型態 + 照 App 規則模擬出場 ──────────────
//    ⭐ 出場規則直接抄 App `_patternFitBacktest` 的 `bt()`:
//       停損 = min(訊號日最低, 進場×0.95) ・停利 = 跌破 5MA ・最長 20 日
const t0 = Date.now();
let done = 0;
const allTrades = [];        // {sym, key, inD, outD, retPct}
for (const sym of syms) {
    let rows;
    try {
        rows = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', `${sym}.json`), 'utf8'));
    } catch (_) { continue; }
    if (!Array.isArray(rows) || rows.length < 120) continue;
    const tr = await page.evaluate(a => {
        const data = a.rows.map(r => ({
            date: String(r.date || '').replace(/\//g, '-').slice(0, 10),
            open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume || 0,
        })).filter(r => r.close > 0);
        if (data.length < 120) return [];
        const last = data.length - 1;
        const C = i => data[i].close, L = i => data[i].low, O = i => data[i].open;
        let P;
        try { P = app._playbookPatternDefs(data); } catch (_) { return []; }
        const out = [];
        for (const p of P) {
            let i = 45;
            while (i < last) {
                let fired = false;
                try { fired = p.test(i); } catch (_) {}
                if (fired) {
                    // 🚪 進場點(ENTRY 決定,⛔ 預設 close 維持既有結果不變)
                    //   close    = 訊號當天收盤買(回測慣例,但**現實中你收盤前不知道訊號會成立**)
                    //   nextopen = 隔天開盤買(⭐ 這才是「每晚推薦 → 隔天買」真正會發生的事)
                    //   nextclose= 隔天收盤買(等一天看穩再買)
                    const eIdx = a.entry === 'close' ? i : i + 1;
                    if (eIdx > last) { i++; continue; }
                    const entry = a.entry === 'nextopen' ? (O(eIdx) > 0 ? O(eIdx) : C(eIdx))
                                : a.entry === 'nextclose' ? C(eIdx)
                                : C(i);
                    if (entry > 0) {
                        // ⚠️ 停損基準跟著進場點走 —— ⛔ 不可沿用「訊號當天低點」配「隔天開盤價」
                        //   (跳空開高時那個停損會變成 -10% 以上,等於偷偷放寬風險)
                        const stop = Math.min(L(eIdx), entry * 0.95);
                        let exitP = C(last), exitIdx = last;
                        const endJ = Math.min(last, eIdx + 20);
                        for (let j = eIdx + 1; j <= endJ; j++) {
                            const c = C(j);
                            const ma5 = j >= 4 ? (C(j) + C(j - 1) + C(j - 2) + C(j - 3) + C(j - 4)) / 5 : null;
                            if (c <= stop) { exitP = stop; exitIdx = j; break; }
                            if (ma5 != null && c < ma5) { exitP = c; exitIdx = j; break; }
                            if (j === endJ) { exitP = c; exitIdx = j; }
                        }
                        // ⚠️ inD 一律記「**訊號日**」—— 選股是那天晚上做的決定,
                        //   實際成交日在 eIdx。⛔ 若記成 eIdx,walk-forward 的時間軸會偏一天。
                        out.push({ key: p.key, inD: data[i].date, outD: data[exitIdx].date,
                                   ret: (exitP - entry) / entry * 100 });
                        i = exitIdx + 1; continue;
                    }
                }
                i++;
            }
        }
        return out;
    }, { rows, entry: ENTRY });
    for (const t of tr) allTrades.push({ ...t, sym });
    if (++done % 50 === 0) {
        const el = (Date.now() - t0) / 1000;
        process.stdout.write(`\r   掃描 ${done}/${syms.length} ・${allTrades.length} 筆交易 ・${el.toFixed(0)}s`);
    }
}
console.log(`\r   ✅ 掃描完成:${done} 檔 ・${allTrades.length} 筆候選交易 ・${((Date.now() - t0) / 1000).toFixed(0)}s      \n`);
await browser.close();

if (!allTrades.length) { console.log('❌ 一筆交易都沒有 → 回測無效'); process.exit(1); }

// ── ② 時間軸:用加權指數的交易日 ────────────────────────────────────────
const twii = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', '^TWII.json'), 'utf8'))
    .map(r => ({ d: String(r.date || '').replace(/\//g, '-').slice(0, 10), c: +r.close }))
    .filter(r => r.d && r.c > 0);
const days = twii.map(r => r.d);
const dIdx = new Map(days.map((d, i) => [d, i]));

// ── ③ Walk-forward 模擬 ────────────────────────────────────────────────
//    第 T 天選股時,型態成績只用「**出場日 < T**」的已完成交易 ⇒ 零前視偏誤。
const byIn = new Map();      // 進場日 → 候選交易
for (const t of allTrades) { if (dIdx.has(t.inD)) (byIn.get(t.inD) || byIn.set(t.inD, []).get(t.inD)).push(t); }
const byOut = new Map();     // 出場日 → 已完成交易(用來累積成績)
for (const t of allTrades) { if (dIdx.has(t.outD)) (byOut.get(t.outD) || byOut.set(t.outD, []).get(t.outD)).push(t); }

const stat = {};             // 「sym|key」→ {n, sum}(⭐ 每檔自己的打法成績)
const mkt = {};              // key → {n, sum}(全市場該型態,當第二層門檻)
const taken = [];            // 實際成交的交易
const openCnt = [];          // 每天同時持有幾筆
let live = [];               // 目前持有
let skipped = 0;             // 💰 因為錢不夠而錯過的次數(⛔ 一定要報 —— 不然等於假設無限資金)
let cash = CAPITAL;          // 現金
let realized = 0;            // 已實現損益
const equity = [];           // 逐日權益(算最大回撤)
for (let i = 0; i < days.length; i++) {
    const d = days[i];
    // 今天到期的先出場 → 錢回來
    for (const x of live.filter(x => dIdx.get(x.outD) <= i)) {
        cash += LOT + LOT * (x.ret - COST) / 100;
        realized += LOT * (x.ret - COST) / 100;
    }
    live = live.filter(x => dIdx.get(x.outD) > i);
    // (a) 先把「今天之前已出場」的交易計入成績(⛔ 今天出場的還不能用 —— 那是今天才知道的)
    if (i > 0) for (const t of (byOut.get(days[i - 1]) || [])) {
        const s = (stat[`${t.sym}|${t.key}`] ||= { n: 0, sum: 0 });
        s.n++; s.sum += t.ret;
        const m = (mkt[t.key] ||= { n: 0, sum: 0 });
        m.n++; m.sum += t.ret;
    }
    if (i < WARMUP) continue;
    // (b) 今天觸發的候選,依「當下已知的期望值」排序
    //   ⭐ 兩層門檻(缺一不可):
    //     ① **這一檔**在**這個型態**上,到昨天為止扣成本後仍是賺的(= App 說「這檔適合這招」)
    //     ② 全市場該型態樣本夠(⛔ 擋掉「這檔剛好打中 4 次」的假強)
    //   排序用**這檔自己**的期望值 —— 這才是「每個個股最好的打法」。
    const cand = (byIn.get(d) || [])
        .map(t => ({ t, s: stat[`${t.sym}|${t.key}`], m: mkt[t.key] }))
        .filter(x => x.s && x.s.n >= MIN_N && (x.s.sum / x.s.n) - COST > 0
                  && x.m && x.m.n >= MIN_MKT_N)
        .sort((a, b) => (b.s.sum / b.s.n) - (a.s.sum / a.s.n));
    const seen = new Set(live.map(x => x.sym));
    let picked = 0;
    for (const { t } of cand) {
        if (picked >= PICKS_PER_DAY) break;
        if (seen.has(t.sym)) continue;      // 同一檔不重複開倉
        // 💰 錢不夠就買不了 —— ⛔ 這條一定要有,不然等於假設無限資金(那個報酬率是假的)
        if (cash < LOT) { skipped++; continue; }
        seen.add(t.sym); cash -= LOT;
        taken.push(t); live.push(t); picked++;
    }
    openCnt.push(live.length);
    equity.push(cash + live.length * LOT);   // 持倉以成本計(保守,不逐日 mark-to-market)
}

if (!taken.length) { console.log('❌ 暖身後一筆都沒進場(門檻太嚴或樣本太小)'); process.exit(1); }

// ── ④ 結果:整體 / 每月 / vs 0050 ────────────────────────────────────────
const net = t => t.ret - COST;                       // 扣成本後的單趟報酬 %
const money = t => LOT * net(t) / 100;               // 每筆固定 10 萬 → 實際賺賠元
const totalPnL = taken.reduce((a, t) => a + money(t), 0);
const wins = taken.filter(t => net(t) > 0);
const avgOpen = openCnt.reduce((a, b) => a + b, 0) / openCnt.length;
const maxOpen = Math.max(...openCnt);
const capital = CAPITAL;
// 📉 最大回撤:權益曲線從高點掉下來最多幾 %(使用者最該知道「中途會不會嚇到砍在最低點」)
let peak = -Infinity, mdd = 0;
for (const e of equity) { if (e > peak) peak = e; mdd = Math.min(mdd, (e - peak) / peak * 100); }

const from = days[WARMUP], to = days[days.length - 1];
const i0 = dIdx.get(from), i1 = days.length - 1;
// 0050 買進持有(同一段期間)
const f50 = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', '0050.json'), 'utf8'))
    .map(r => ({ d: String(r.date || '').replace(/\//g, '-').slice(0, 10), c: +r.close })).filter(r => r.c > 0);
const px50 = d => { let hit = null; for (const r of f50) { if (r.d <= d) hit = r.c; else break; } return hit; };
const b50 = px50(from), e50 = px50(to);
const ret50 = (b50 && e50) ? (e50 - b50) / b50 * 100 - COST : null;
const twiiRet = (twii[i1].c - twii[i0].c) / twii[i0].c * 100;

// 每月
const byMon = {};
for (const t of taken) {
    const m = t.outD.slice(0, 7);
    (byMon[m] ||= { n: 0, w: 0, pnl: 0 });
    byMon[m].n++; if (net(t) > 0) byMon[m].w++; byMon[m].pnl += money(t);
}
const mons = Object.keys(byMon).sort();
const monWin = mons.filter(m => byMon[m].pnl > 0).length;

const nf = n => Math.round(n).toLocaleString('en-US');
const pct = v => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
console.log('═'.repeat(74));
console.log(`📅 期間:${from} ~ ${to}(${days.length - WARMUP} 個交易日 ・${mons.length} 個月)`);
const yrs = (days.length - WARMUP) / 244;
console.log(`💰 本金 ${nf(CAPITAL)} 元 ・每筆 ${nf(LOT)} 元 ・同時最多持有 ${maxOpen} 筆(平均 ${avgOpen.toFixed(1)} 筆 → 資金使用率 ${(avgOpen * LOT / CAPITAL * 100).toFixed(0)}%)`);
if (skipped) console.log(`⚠️ 有 ${skipped} 次訊號因為**錢已經用完**而錯過(本金再多一點結果會不同)`);
console.log('═'.repeat(74));
console.log(`\n📊 整體(扣掉來回成本 ${COST}%)`);
console.log(`   成交筆數      ${taken.length} 筆`);
console.log(`   勝率          ${(wins.length / taken.length * 100).toFixed(1)}%`);
console.log(`   每趟平均      ${pct(taken.reduce((a, t) => a + net(t), 0) / taken.length)}`);
console.log(`   累積損益      ${totalPnL >= 0 ? '+' : '−'}${nf(Math.abs(totalPnL))} 元`);
console.log(`   對本金報酬    ${pct(totalPnL / capital * 100)}  ${yrs >= 0.5 ? `(年化約 ${pct((Math.pow(1 + totalPnL / capital, 1 / yrs) - 1) * 100)})` : ''}`);
console.log(`   📉 最大回撤    ${mdd.toFixed(2)}%  ← 中途最難熬的時候(⚠️ 這是會不會半路砍在最低點的關鍵)`);
console.log(`\n🆚 同期對照`);
console.log(`   0050 買進持有  ${ret50 == null ? '(無資料)' : pct(ret50)}`);
console.log(`   加權指數      ${pct(twiiRet)}`);
if (ret50 != null) {
    const diff = totalPnL / capital * 100 - ret50;
    console.log(`   ⭐ 這套 vs 0050:${diff >= 0 ? '贏' : '輸'} ${Math.abs(diff).toFixed(2)}pp`);
}
console.log(`\n📆 每月(共 ${mons.length} 個月,賺錢的月份 ${monWin}/${mons.length} = ${(monWin / mons.length * 100).toFixed(0)}%)`);
console.log('   月份      筆數   勝率    損益(元)');
for (const m of mons) {
    const b = byMon[m];
    console.log(`   ${m}   ${String(b.n).padStart(4)}  ${(b.w / b.n * 100).toFixed(0).padStart(4)}%  ${(b.pnl >= 0 ? '+' : '−') + nf(Math.abs(b.pnl))}`);
}
console.log(`\n🧩 實際用到的打法(⭐ 選股用「**這一檔自己**在這個型態的歷史成績」,不是全市場平均)`);
const useCnt = {};
for (const t of taken) (useCnt[t.key] ||= { n: 0, w: 0, sum: 0 }), useCnt[t.key].n++, useCnt[t.key].sum += net(t), (net(t) > 0 && useCnt[t.key].w++);
for (const [k, v] of Object.entries(useCnt).sort((a, b) => b[1].n - a[1].n)) {
    console.log(`   ${k.padEnd(16)} ${String(v.n).padStart(4)} 筆 ・勝率 ${(v.w / v.n * 100).toFixed(0)}% ・每趟 ${pct(v.sum / v.n)}`);
}
console.log('\n' + '═'.repeat(74));
console.log('⚠️ 這份回測誠實揭露的限制(⛔ 別把數字當保證):');
console.log(`   ① **倖存者偏誤**:data/ 只有「現在還在市場」的股票 → 結果偏樂觀`);
console.log(`   ② 用收盤價成交,沒有滑價;實際掛單不一定買得到那個價`);
console.log(`   ③ 回測窗口只有這段期間,而這段是什麼行情會決定結果(加權 ${pct(twiiRet)})`);
console.log(`   ④ 每天最多 ${PICKS_PER_DAY} 檔、同一檔不重複開倉、錢用完就跳過(錯過 ${skipped} 次)`);
console.log(`   ⑤ 選股用 walk-forward(只用當下已知的成績)→ **沒有**前視偏誤,但也因此比「事後最佳化」難看`);
console.log('═'.repeat(74));
