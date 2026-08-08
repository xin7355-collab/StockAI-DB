#!/usr/bin/env node
/**
 * 🎯 明日作戰清單 —— 全市場掃「哪一檔的哪一招,對它自己是真的會賺的」+ 算出明天的觸發價
 *
 * 使用者原話:「每晚挖礦給我推薦個股,給我最高勝率的,然後開盤的時候買點到了就大力提醒我」
 *
 * ⛔⛔ 這支存在的理由 = `portfolio_backtest.mjs` 實測出來的兩個結論,⛔ 別在這裡走回頭路:
 *
 *  ① **排序基準必須是「這一檔自己在這一招的成績」,⛔ 不是全市場平均。**
 *     實測(600 檔・13 個月・本金 100 萬):
 *        全市場型態平均排序 → +35,491 元(576 筆有 479 筆押同一招)
 *        這檔自己的成績排序 → +1,361,088 元
 *     差 38 倍。真因:同一個型態當天幾十檔一起觸發、分數完全一樣 → 等於在亂挑。
 *
 *  ② **進場點只能是「訊號日尾盤」,⛔ 不是隔天開盤。**
 *     同一套邏輯只改進場時機(本金 100 萬):
 *        訊號日尾盤買    +1,361,088 元(vs 0050 多賺 528,588・回撤 −9.4%)
 *        隔天開盤買        +818,734 元(vs 0050 少賺  13,766・回撤 −19.1%)
 *        隔天開盤・跳空>1%不追 −147,644 元(倒賠・回撤 −36.4%)
 *     真因:打法的判定條件全部用**當天收盤價**(收盤站上5MA/突破頸線/破昨高),
 *          隔天開盤時那個突破已經被跳空反映掉。
 *     ⚠️ 而「跳空太多不追」最慘 —— 跳空開高的正是後來走最遠的,濾掉等於專挑爛的買。
 *     → 所以這份清單的用途是「**明天盤中要盯哪幾檔**」,
 *       ⛔ **不是**「明天開盤買這幾檔」。文案與前端都必須這樣寫。
 *
 * 🧮 觸發價怎麼算(⛔ 不是用公式硬推,是**問偵測器本人**):
 *     把「明天那根 K」合成出來(平盤開、收在 P、量取近 5 日均量),接在歷史後面,
 *     然後直接呼叫 App 自己的 `p.test(最後一根)` —— P 由低到高掃,找出**剛好會觸發的最低價**。
 *     ⭐ 好處:任何打法都適用,⛔ 不用替 22 種型態各寫一份公式(那就是第二份真相)。
 *     ⚠️ 這是**估計值**(明天真正的開/高/低還不知道);盤中前端會拿**真實**的開高低 + 即時價重算,
 *        那次才是準的。兩者的差別必須寫在卡上。
 *
 * ⛔ 其他鐵則:
 *   ・打法與回測**直接呼叫 App 的** `_patternFitBacktest()`,⛔ 不複製一份判定邏輯
 *   ・**期望值要扣掉來回成本 0.44% 之後仍為正**才收(⛔ 不可只看勝率 —— 42 個 A 級訊號有 36 個期望值是負的)
 *   ・樣本 `n >= MIN_N`(預設 8,= 回測最好那組);⛔ 別在顯示端另外寫死門檻
 *   ・有截斷一定要把總數寫進 JSON(no silent caps)
 *
 * 跑法:node scripts/playbook_scan.mjs [最多幾檔]
 */
import { fileURLToPath, pathToFileURL } from 'url';
import fs from 'fs';
import path from 'path';

// ⚙️ playwright 來源:本機開發是絕對路徑、CI 是 node_modules。
//   ⛔ 別再用 workflow 裡 `sed` 改原始碼那招(daily_signal_scan 那樣做)——
//      我的 launch() 是多行多屬性,sed 掉一行會留下 `{ , args: … }` 直接語法錯,
//      而且 workflow 全綠、只有這支靜默失敗(陷阱 #9 的同型)。改成程式自己判斷。
let chromium;
try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); }
catch (_) { ({ chromium } = await import('playwright')); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const MAX_SYMS = +(process.argv[2] || 99999);
const MIN_N = +(process.env.MIN_N || 8);      // 這檔在這招打過幾次才算數(= 回測最好那組)
const COST = 0.44;                            // 來回成本 %:期望值扣完還要 > 0
const CAP = +(process.env.CAP || 300);        // 輸出上限(⚠️ 總數另外寫進 JSON)
const NEAR = +(process.env.NEAR || 6);        // 觸發價距離現價超過幾 % 就不列(明天到不了)
const t0 = Date.now();
const log = (...a) => console.log(...a);

function loadSeries(p) {
    try {
        const rows = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (!Array.isArray(rows)) return null;
        const out = [];
        for (const r of rows) {
            const c = +(r.close || 0), d = String(r.date || '').replace(/\//g, '-').slice(0, 10);
            if (c > 0 && d) out.push({ date: d, open: +(r.open || c), high: +(r.high || c), low: +(r.low || c), close: c, volume: +(r.volume || 0) });
        }
        return out.length >= 120 ? out : null;
    } catch (_) { return null; }
}

const files = fs.readdirSync(DATA).filter(f => /^\d{4}\.json$/.test(f)).sort();
log(`🎯 明日作戰清單掃描 ・${files.length} 檔${MAX_SYMS < 99999 ? `(上限 ${MAX_SYMS})` : ''}`);
log(`   門檻:期望值扣 ${COST}% 成本後 > 0 ・樣本 ≥ ${MIN_N} 次 ・觸發價距現價 ≤ ${NEAR}%\n`);

// ⚠️ `--allow-file-access-from-files` 不可拿掉:少了它 index.html 讀不到本機檔,
//    會**靜默**跑出空結果(page_sweep 踩過的坑)→ 下面有「掃到 0 檔就 exit 1」的空過守門。
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({
    ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}),   // CI 沒這支 → 用 playwright 自帶的
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
page.on('pageerror', () => {});
await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._patternFitBacktest, null, { timeout: 25000 });

const picks = [], firedToday = [];
let used = 0, latest = '', noEdge = 0, tooFar = 0;
for (const f of files) {
    if (used >= MAX_SYMS) break;
    const sym = f.slice(0, 4);
    const rows = loadSeries(path.join(DATA, f));
    if (!rows) continue;
    used++;
    let r;
    try {
        r = await page.evaluate(a => {
            const { rows, minN, cost, near } = a;
            // ① 這一檔自己的打法成績(⛔ 直接用 App 的,不複製邏輯)
            let ranked; try { ranked = app._patternFitBacktest(rows); } catch (_) { return null; }
            if (!ranked || !ranked.length) return null;
            // ② 扣成本後仍為正 + 樣本足(⛔ 不可只看勝率)
            const good = ranked.filter(x => x.count >= minN && (x.expectancy - cost) > 0);
            if (!good.length) return { none: true };

            const last = rows.length - 1;
            const c0 = rows[last].close;
            const volAvg = Math.round(rows.slice(-5).reduce((s, x) => s + (x.volume || 0), 0) / 5);

            // 🧮 合成「明天那根 K」:平盤開、收在 P(⚠️ 明天真正的開高低未知 → 這是估計)
            const fireAt = (key, P) => {
                const ext = rows.concat([{
                    date: '9999-12-31', open: c0,
                    high: Math.max(P, c0), low: Math.min(P, c0), close: P, volume: volAvg,
                }]);
                let defs; try { defs = app._playbookPatternDefs(ext); } catch (_) { return false; }
                const p = defs.find(d => d.key === key);
                if (!p) return false;
                try { return !!p.test(ext.length - 1); } catch (_) { return false; }
            };
            // 由低到高粗掃找「最低會觸發的價」→ 再二分細修
            //   ⛔ 不假設單調(有些型態高太多反而不算突破)→ 粗掃才不會漏
            const trigOf = key => {
                const lo = c0 * 0.94, hi = c0 * (1 + near / 100);
                const STEP = 14;
                let firstHit = -1;
                for (let k = 0; k <= STEP; k++) {
                    const P = lo + (hi - lo) * k / STEP;
                    if (fireAt(key, P)) { firstHit = k; break; }
                }
                if (firstHit < 0) return null;                       // 明天漲到上限也不會觸發
                if (firstHit === 0) return { trig: lo, loose: true };  // 連跌 6% 都觸發 → 不是價格閘門
                let a2 = lo + (hi - lo) * (firstHit - 1) / STEP;
                let b2 = lo + (hi - lo) * firstHit / STEP;
                for (let k = 0; k < 12; k++) { const m = (a2 + b2) / 2; if (fireAt(key, m)) b2 = m; else a2 = m; }
                return { trig: b2 };
            };

            const out = [], fired = [];
            for (const g of good.slice(0, 2)) {          // 一檔最多留 2 招(⛔ 免得一檔洗版)
                const row = { k: g.key, w: +g.winRate.toFixed(1), po: +g.plRatio.toFixed(2),
                              exp: +g.expectancy.toFixed(2), n: g.count };
                if (g.firedToday) { fired.push(row); continue; }      // 今天已觸發 → 明天買已太晚,另外放
                const t = trigOf(g.key);
                if (!t) continue;
                out.push({ ...row, trig: +t.trig.toFixed(2), loose: t.loose ? 1 : 0 });
            }
            return { c: c0, v: Math.round(rows[last].volume / 1000), d: rows[last].date, out, fired };
        }, { rows, minN: MIN_N, cost: COST, near: NEAR });
    } catch (_) { continue; }
    if (!r) continue;
    if (r.none) { noEdge++; continue; }
    if (r.d > latest) latest = r.d;
    for (const x of r.out) {
        // 停損 = 觸發價 −5%(⛔ 跟 App 回測的出場規則一致:min(當日低點, 進場×0.95);
        //   明天的低點還不知道 → 保守用 ×0.95,盤中重算時會換成真的)
        picks.push({ s: sym, c: r.c, v: r.v, d: r.d, ...x,
                     up: +((x.trig - r.c) / r.c * 100).toFixed(2),
                     stop: +(x.trig * 0.95).toFixed(2) });
    }
    for (const x of r.fired) firedToday.push({ s: sym, c: r.c, v: r.v, d: r.d, ...x });
    if (used % 200 === 0) log(`   …${used} 檔 / ${((Date.now() - t0) / 1000).toFixed(0)}s / 候選 ${picks.length}・今日已觸發 ${firedToday.length}`);
}
await browser.close();

// 🚧 空過守門(⛔ 別拿掉):這支最大的風險是「跑完了、rc=0、檔案也寫了,但內容其實是空的」
//    —— 少了 --allow-file-access-from-files、index.html 沒載起來、偵測器改名…都會長這樣,
//    而且 workflow 會全綠(陷阱 #9:rc=0 不等於功能有跑)。
if (used === 0) { log('❌ 一檔都沒掃到 → 資料沒還原?(不寫檔)'); process.exit(1); }
if (used >= 200 && picks.length === 0 && firedToday.length === 0) {
    log(`❌ 掃了 ${used} 檔卻一筆候選都沒有 → 極可能是 index.html 沒載起來或偵測器掛了(不寫檔)`);
    process.exit(1);
}

// 期望值高的排前面;同分用成交量(⛔ 別退化成代號順序 —— 那等於「1xxx 永遠排前面」)
picks.sort((a, b) => (b.exp - a.exp) || (b.v - a.v));
firedToday.sort((a, b) => (b.exp - a.exp) || (b.v - a.v));

const out = {
    updated: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    data_date: latest,
    scanned: used,
    min_n: MIN_N, cost: COST, near_pct: NEAR,
    // ⛔ 這兩句是這份資料的**使用說明**,前端必須顯示 —— 不然使用者會照著隔天開盤買(實測會倒賠)
    how: '這是「明天盤中要盯哪幾檔」的清單,⛔ 不是「明天開盤買這幾檔」。實測隔天開盤買會把邊際吃光。',
    entry_note: '有效的進場時點是「觸發當天的尾盤(13:00~13:25)」—— 打法的判定條件都是用收盤價算的。',
    trig_note: '觸發價是**估計值**(明天真正的開高低還不知道);盤中會用即時報價重算,以那次為準。',
    cost_note: `期望值已扣來回成本 ${COST}%(手續費+證交稅,未打折)`,
    picks_total: picks.length,
    picks_syms: new Set(picks.map(p => p.s)).size,
    picks_cap: CAP,
    picks: picks.slice(0, CAP),
    // 今天才觸發的:⛔ 明天買已經來不及(進場點是今天尾盤)→ 只當「這幾檔正在走」的參考
    fired_total: firedToday.length,
    fired: firedToday.slice(0, 60),
    no_edge: noEdge,
};
fs.writeFileSync(path.join(DATA, 'playbook_edge.json'), JSON.stringify(out), 'utf-8');

log(`\n✅ ${used} 檔 ・${((Date.now() - t0) / 1000).toFixed(0)}s`);
log(`   🎯 明日候選:${picks.length} 筆 / ${out.picks_syms} 檔(輸出前 ${out.picks.length} 筆)`);
log(`   🔥 今天已觸發:${firedToday.length} 筆(⛔ 明天買太晚,只當參考)`);
log(`   ➖ 沒有任何一招扣成本後為正的:${noEdge} 檔`);
if (picks.length > out.picks.length) log(`   ⚠️ 有截斷:${picks.length} → ${out.picks.length};picks_total/picks_syms 已寫進 JSON`);
if (out.picks.length) {
    log('\n🏆 期望值最高的 10 筆:');
    for (const p of out.picks.slice(0, 10)) {
        log(`   ${p.s}  現價 ${String(p.c).padStart(8)} → 漲過 ${String(p.trig).padStart(8)} 觸發(+${p.up}%)  ${p.k}`);
        log(`         停損 ${p.stop} ・勝率 ${p.w}% ・賺賠比 ${p.po} ・每趟 +${p.exp}% ・打過 ${p.n} 次${p.loose ? ' ・⚠️不是價格閘門' : ''}`);
    }
}
log(`\n💾 已寫 data/playbook_edge.json (${(fs.statSync(path.join(DATA, 'playbook_edge.json')).size / 1024).toFixed(1)} KB)`);
