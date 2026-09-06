#!/usr/bin/env node
/**
 * 🐢 0050 七種買法實測 + 跟「你現在這套打法」比
 *
 * 使用者:「0050 買賣策略,是定期定額買,還有大跌加買,還是有其它策略,
 *          幫我回測並與目前我的賺錢策略比拚,哪個厲害」
 *
 * ⛔⛔ 先講**為什麼不能直接比「賺多少錢」**(這是這題最大的陷阱):
 *   ・打法回測是「本金 100 萬**一次到位**」,資金從第一天就全額在市場裡
 *   ・定期定額是「每月投一點」,平均只有一半的錢在市場裡
 *   → 直接比總獲利,等於讓 lump sum 用兩倍的錢去比,**不公平**。
 *   ⭐ 所以主指標用 **IRR(資金加權年化報酬)** —— 它會把「錢什麼時候進場」算進去。
 *      同時也列總獲利與「平均在市場裡的錢」,讓兩種角度都看得到。
 *
 * ⚠️ 三個必須誠實揭露的限制(⛔ 報告不可省略):
 *   ① **沒有含股息**:`data/0050.json` 是 `auto_adjust=False`(原始價,才對得上官方收盤),
 *      配息沒有加回去 → **長抱型策略被低估約 3%/年**(0050 近年殖利率約 3~4%)。
 *      ⛔ 這對「一次全買放著」最不利,結論要考慮進去。
 *   ② **窗口整段是 AI 大多頭**(0050 從 32.25 漲到 103.1,+220%)→
 *      任何「一直待在市場裡」的策略天生佔便宜,⛔ 不可外推到空頭。
 *   ③ **ETF 證交稅是 0.1% 不是 0.3%**(股票才 0.3%)—— 算錯會高估 0050 的成本。
 *
 * ⚠️ 資料已做過分割還原(V71.7.9 `_backadjust_splits`,0050 有 2024/07 ×4、2025/06 ÷4 兩次),
 *    所以 32.25 → 103.1 是**同一把尺**下的真實報酬。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const CAPITAL = 1_000_000;      // 總投入資金(跟打法回測同一個數字)
const FEE = 0.001425 * 0.6;     // 手續費 6 折(跟 App 預設一致)
const TAX_ETF = 0.001;          // ⚠️ ETF 證交稅 0.1%(⛔ 不是股票的 0.3%)
const nd = d => String(d || '').replace(/\//g, '-').slice(0, 10);

const rows = JSON.parse(fs.readFileSync(path.join(DATA, '0050.json'), 'utf8'))
    .map(r => ({ d: nd(r.date), o: +r.open, c: +r.close }))
    .filter(r => r.d && r.c > 0);
const N = rows.length;
if (N < 400) { console.error(`❌ 空過守門:0050 只有 ${N} 根 K`); process.exit(1); }

// 每月第 1 個交易日的索引(定期定額扣款日)
const monthFirst = [];
let lastM = '';
rows.forEach((r, i) => { const m = r.d.slice(0, 7); if (m !== lastM) { monthFirst.push(i); lastM = m; } });
const MONTHS = monthFirst.length;

// 距 60 日高的回落%
const dd60 = new Float64Array(N);
for (let i = 0; i < N; i++) {
    let hi = 0;
    for (let j = Math.max(0, i - 59); j <= i; j++) if (rows[j].c > hi) hi = rows[j].c;
    dd60[i] = hi > 0 ? (rows[i].c / hi - 1) * 100 : 0;
}
const ma = (i, k) => { if (i < k - 1) return null; let s = 0; for (let j = i - k + 1; j <= i; j++) s += rows[j].c; return s / k; };

// ── 帳戶模擬器 ───────────────────────────────────────────────────
// flows: [{i, amt}] 現金流(正=投入),用來算 IRR
function run(name, step, note) {
    let sh = 0, cash = 0, invested = 0;       // 持股數、帳上現金、累計投入
    const flows = [];
    const equity = new Float64Array(N);
    // 🚨🚨 修(第二個、也是更根本的公平性 bug):第一版 `buy` **沒有限制在手上的現金**,
    //    所以 `put` 封頂之後,買單照樣用原本的金額成交 → 帳戶現金變負數 = **透支**。
    //    症狀很陰:封頂前後「淨賺」完全一樣(1,395,604),只有「投入」的帳面數字變了
    //    → 看起來像修好了,其實一毛都沒改到。
    //    ⭐ 通用:改「資金上限」時,要同時檢查**花錢那一端**有沒有跟著受限,
    //       ⛔ 只改記帳的那一端 = 只改了報表,沒改行為。
    const buy = (i, money) => {
        const m = Math.min(money, cash);          // ⛔ 不可透支
        if (m <= 0) return;
        const px = rows[i].c;
        const lots = m / (px * (1 + FEE));
        if (lots <= 0) return;
        sh += lots; cash -= lots * px * (1 + FEE);
    };
    const sellAll = i => {
        if (sh <= 0) return;
        const px = rows[i].c;
        cash += sh * px * (1 - FEE - TAX_ETF); sh = 0;
    };
    const sellPart = (i, shares) => {
        const s0 = Math.min(shares, sh);
        if (s0 <= 0) return;
        cash += s0 * rows[i].c * (1 - FEE - TAX_ETF); sh -= s0;
    };
    // 🚨 修:第一版沒有把「累計投入」封頂 → ③ 投了 125 萬、④ 投了 137.5 萬,
    //    等於拿比別人多 25~37% 的錢去比,**前提就不公平了**。
    //    ⛔ 任何策略的累計投入都不可超過 CAPITAL。
    const put = (i, amt) => {
        const room = CAPITAL - invested;
        const a2 = Math.min(amt, room);
        if (a2 <= 0) return;
        cash += a2; invested += a2; flows.push({ i, amt: a2 });
    };
    for (let i = 0; i < N; i++) {
        step(i, { buy, sellAll, sellPart, put, get sh() { return sh; }, get cash() { return cash; }, get invested() { return invested; } });
        equity[i] = cash + sh * rows[i].c;
    }
    // 收尾:全部賣掉換現金(⭐ 含賣出成本,⛔ 不可只算市值)
    sellAll(N - 1);
    const final = cash;
    // 最大回撤(⚠️ 只看「錢已經投進去之後」的資產曲線)
    let peak = -Infinity, mdd = 0;
    for (let i = 0; i < N; i++) {
        if (equity[i] <= 0) continue;
        if (equity[i] > peak) peak = equity[i];
        if (peak > 0) mdd = Math.min(mdd, equity[i] / peak - 1);
    }
    // IRR(資金加權年化):解 Σ amt*(1+r)^((N-1-i)/252) = final
    const yrs = i => (N - 1 - i) / 252;
    const fv = r => flows.reduce((s, f) => s + f.amt * Math.pow(1 + r, yrs(f.i)), 0);
    let lo = -0.95, hi = 3;
    for (let k = 0; k < 200; k++) { const m = (lo + hi) / 2; if (fv(m) < final) lo = m; else hi = m; }
    const irr = (lo + hi) / 2;
    // 平均在市場裡的錢(= 資金效率;⭐ 這是「公不公平」的關鍵數字)
    let avgIn = 0;
    for (let i = 0; i < N; i++) { let put = 0; for (const f of flows) if (f.i <= i) put += f.amt; avgIn += put; }
    avgIn /= N;
    return { name, note, final, profit: final - invested, invested, irr, mdd: mdd * 100, avgIn, flows: flows.length };
}

const per = CAPITAL / MONTHS;                    // 定期定額每期金額
const isMonth = i => monthFirst.includes(i);

const S = [];
// ① 一次全買放著
S.push(run('① 一次全買放著', (i, a) => { if (i === 0) { a.put(i, CAPITAL); a.buy(i, CAPITAL); } },
    '最單純;資金第一天就全上'));
// ② 定期定額
S.push(run('② 定期定額(每月)', (i, a) => { if (isMonth(i)) { a.put(i, per); a.buy(i, per); } },
    `每月投 ${Math.round(per).toLocaleString()} 元,共 ${MONTHS} 期`));
// ③ 定期定額 + 大跌加碼(留 30% 當銀彈,回落 ≥10% 時加投一份)
S.push(run('③ 定期定額 + 大跌加碼', (i, a) => {
    if (isMonth(i)) { a.put(i, per * 0.7); a.buy(i, per * 0.7); }
    if (dd60[i] <= -10 && (i === 0 || dd60[i - 1] > -10)) {
        const bullet = CAPITAL * 0.3 / 6;         // 銀彈分 6 次用完
        a.put(i, bullet); a.buy(i, bullet);
    }
}, '每期只投 7 成,留 3 成等大跌(回落 ≥10%)分 6 次加碼'));
// ④ 只在大跌時買
S.push(run('④ 只等大跌才買', (i, a) => {
    if (dd60[i] <= -10 && (i === 0 || dd60[i - 1] > -10)) {
        const bullet = CAPITAL / 8;
        a.put(i, bullet); a.buy(i, bullet);
    }
}, '回落 ≥10% 才進場,分 8 次;⛔ 沒跌就一直空手'));
// ⑤ 定期定額但只在月線之上買(月線之下那期把錢存著)
S.push(run('⑤ 定期定額(只在月線之上買)', (i, a) => {
    if (!isMonth(i)) return;
    a.put(i, per);
    const m = ma(i, 20);
    if (m && rows[i].c > m) a.buy(i, a.cash);      // 把存下來的一起買
}, '月線之下先存現金,站上月線一次補買'));
// ⑥ 擇時:站上月線買、跌破月線全賣
S.push(run('⑥ 站上月線買・跌破月線全賣', (i, a) => {
    if (i === 0) a.put(i, CAPITAL);
    const m = ma(i, 20); if (!m) return;
    const up = rows[i].c > m;
    if (up && a.sh === 0 && a.cash > 0) a.buy(i, a.cash);
    else if (!up && a.sh > 0) a.sellAll(i);
}, '⚠️ 進出頻繁 → 手續費 + 稅會吃掉不少'));
// ⑦ 價值平均法(目標市值線性成長,多退少補)
S.push(run('⑦ 價值平均法', (i, a) => {
    if (!isMonth(i)) return;
    const k = monthFirst.indexOf(i) + 1;
    const target = CAPITAL * k / MONTHS;
    const now = a.sh * rows[i].c;
    if (now < target) {
        const need = Math.min(target - now, CAPITAL - a.invested);
        if (need > 0) { a.put(i, need); a.buy(i, need); }
    } else if (now > target * 1.15) {
        // 🚨 修:第一版這裡寫成 no-op(`a.buy(i,0)`)= 只做「少買」不做「賣」,
        //    那不是價值平均法,是半套。⛔ 顯示一個沒實作完的策略比不顯示更糟。
        a.sellPart(i, (now - target) / rows[i].c);
    }
}, '落後目標就多買、超前就賣掉超出的部分(⚠️ 賣出會實現手續費+稅)'));

// ── 報告 ─────────────────────────────────────────────────────────
const f = (x, w = 12) => Math.round(x).toLocaleString().padStart(w);
const p = (x, w = 7) => ((x >= 0 ? '+' : '') + x.toFixed(2)).padStart(w);
console.log('═'.repeat(112));
console.log('🐢 0050 七種買法實測');
console.log('═'.repeat(112));
console.log(`窗口:${rows[0].d} ~ ${rows[N - 1].d}(${N} 個交易日 ・ ${MONTHS} 個月)`);
console.log(`0050:${rows[0].c} → ${rows[N - 1].c}(${((rows[N - 1].c / rows[0].c - 1) * 100).toFixed(1)}%,⚠️ 已做分割還原)`);
console.log(`資金:總投入上限 ${CAPITAL.toLocaleString()} 元 ・ 手續費 6 折 ・ ETF 證交稅 0.1%`);
console.log('⚠️ **沒有含股息** → 長抱型被低估約 3%/年(0050 殖利率約 3~4%)\n');
console.log('策略                              最終資產     實際投入      淨賺      年化(IRR)  最大回撤   平均在市場的錢');
console.log('─'.repeat(112));
for (const s of S) {
    console.log(`${s.name.padEnd(30)} ${f(s.final)} ${f(s.invested)} ${f(s.profit)}  ${p(s.irr * 100)}%  ${p(s.mdd, 7)}%  ${f(s.avgIn, 12)}`);
}
console.log('\n說明:');
for (const s of S) console.log(`  ${s.name} —— ${s.note}`);

// ── 分年拆解:⭐ 這才看得出「是不是只靠某一年」 ────────────────────
console.log('\n' + '─'.repeat(112));
console.log('📅 0050 分年報酬(⭐ 用來判斷上面的結論是不是只靠某一年)');
console.log('─'.repeat(112));
{
    const byYear = {};
    for (let i = 1; i < N; i++) {
        const y = rows[i].d.slice(0, 4);
        (byYear[y] ||= []).push(rows[i].c / rows[i - 1].c - 1);
    }
    const ys = Object.keys(byYear).sort();
    console.log('年份    ' + ys.map(y => y.padStart(9)).join(''));
    console.log('報酬    ' + ys.map(y => {
        const r = byYear[y].reduce((a, b) => a * (1 + b), 1) - 1;
        return (((r >= 0 ? '+' : '') + (r * 100).toFixed(1)) + '%').padStart(9);
    }).join(''));
    console.log('交易日  ' + ys.map(y => String(byYear[y].length).padStart(9)).join(''));
    console.log('⚠️ 這段窗口**沒有一整年的空頭** → 上面所有「一直待在市場裡」的策略都天生佔便宜。');
}

// ── 股息估算(⭐ 明確標成估算,⛔ 不假裝是實測)────────────────────
console.log('\n' + '─'.repeat(112));
console.log('💰 股息補正(⚠️ **估算**,⛔ 不是實測 —— 資料源沒有配息紀錄)');
console.log('─'.repeat(112));
{
    const YRS = N / 252, YIELD = 0.03;               // 0050 近年殖利率約 3~4%,取保守 3%
    console.log(`  假設年化殖利率 ${(YIELD * 100).toFixed(0)}%、窗口 ${YRS.toFixed(1)} 年,依「平均在市場裡的錢」估算:`);
    for (const s of S) {
        const div = s.avgIn * YIELD * YRS;
        console.log(`  ${s.name.padEnd(30)} 約 +${f(div, 0)} 元 → 淨賺約 ${f(s.profit + div, 0)} 元`);
    }
    console.log('  ⚠️ 這是粗估(沒算再投入、沒算實際除息日),只用來說明「表上低估了多少」。');
}

console.log('\n' + '─'.repeat(112));
console.log('🆚 跟「你現在這套打法」比(portfolio_backtest.mjs,同樣本金 100 萬)');
console.log('─'.repeat(112));
// ⚠️ 打法回測的窗口(2023-06 起、36 個月)跟這裡(38 個月)幾乎一樣,但⛔ 不是同一支腳本算的,
//    所以只做「量級比較」,⛔ 不宣稱小數點等級的精確可比。
const PB = [
    ['🧬 只做高位階+高波動(現行配置)', 2896478, -22.44],
    ['📋 照清單順序做(不挑)', 1260926, -23.96],
];
const lump = S[0];
console.log('打法                              淨賺          最大回撤   vs 0050 一次全買');
for (const [n, prof, mdd] of PB) {
    console.log(`${n.padEnd(30)} ${f(prof)}  ${p(mdd, 7)}%   ${prof > lump.profit ? '多賺 ' + f(prof - lump.profit, 0) : '少賺 ' + f(lump.profit - prof, 0)} 元`);
}
console.log(`${'🐢 0050 一次全買放著'.padEnd(30)} ${f(lump.profit)}  ${p(lump.mdd, 7)}%   —`);
console.log('\n⚠️ 打法回測窗口 36 個月 vs 這裡 38 個月,兩支腳本不同 → 只比量級,⛔ 不宣稱小數點可比。');
console.log('⚠️ 打法那邊「淨賺」已扣手續費與證交稅(股票 0.3%);0050 這邊用 ETF 0.1%。');
console.log('⚠️ 0050 沒含股息 → 它的真實成績比表上再好一些(約每年 3%)。');
