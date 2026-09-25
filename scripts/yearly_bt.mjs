#!/usr/bin/env node
/**
 * 📅 V77.6.1 每個策略的「逐年成績單」—— 使用者:「2026、2025、2024…各別列出,以 100 萬本金為基本,
 *    加入報酬%、期望值、不含本金的賺賠,包含空頭,每個策略都用這種方式呈現」。
 *
 * ⭐ 做法:每個策略 × 每一年 × 5 個起點(那一年第 0/5/10/15/20 個交易日開始),
 *    各跑一次 `portfolio_backtest.mjs YEAR=YYYY YEAR_OFFSET=k`(每年重新放 100 萬)。
 *    主數字 = 起點 0(1 月第一個交易日);其他 4 個起點只拿來給「換個起點最好 / 最差」。
 *
 * ⭐ 所有策略都疊在**同一個基底**上(= 決策台現行那套:🧬 + 唐奇安 20 日 + 最長 20 天 + 每天 2 檔 × 15 萬
 *    + 停損收盤成交),每一條只換「它那一件事」→ 每一格都能直接跟「決策台現行」同一年比。
 *    ⚠️ 所以舊情境庫那幾組(當年是用 5 日線 / 不挑 🧬 / 13 或 36 個月跑的)數字**不會跟舊版一樣** —— 這是刻意的。
 *
 * ⛔ 三條:
 *   ① 同一個交易快取只能由**一個**程序產生(兩個程序同時寫同一個檔會壞掉)→ 依快取鍵分組,一組一條線。
 *   ② 可以中斷重跑:已經有結果檔的就跳過(⛔ 不重跑)。
 *   ③ 重跑不了的列**寫出原因**(⛔ 不可靜默消失)。
 *
 * 用法:
 *   DATA_DIR=<klines_deep 合併> FIN_DEEP=… AUX_DIR=… DIV=… OUT_DIR=<結果> CACHE_DIR=<交易快取> LANES=5 \
 *     node scripts/yearly_bt.mjs            # 跑(可續跑)
 *   OUT_DIR=… node scripts/yearly_bt.mjs --collect out.json   # 彙整成一份 json(給 embed_yearly_bt.mjs)
 *   node scripts/yearly_bt.mjs --list        # 只印策略清單
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const YEARS = ['2022', '2023', '2024', '2025', '2026'];
export const OFFSETS = [0, 5, 10, 15, 20];
export const BASE = { LOT: '150000', SELF: 'high+hivolat', RANK_MIN: '75', VOLAT_MIN: '60', EXIT: 'don20', MAXD: '20', STOPFILL: 'close' };
export const BASE_PICKS = 2;

// g = 分組 ・ id = 檔名用 ・ t = 白話名稱 ・ env = 只寫「跟基底不一樣的那一件事」 ・ picks = 每天幾檔(沒寫 = 2)
export const STRATS = [
    { g: 'now',  id: 'base',       t: '⭐ 決策台現行:🧬 高位階+高波動 ・唐奇安 20 日出場 ・最長抱 20 天', env: {} },
    // 🚪 出場(只換賣的規則)
    { g: 'exit', id: 'x_atr2',     t: 'ATR 追蹤停利(最高收盤 − 2×ATR)', env: { EXIT: 'chand2' } },
    { g: 'exit', id: 'x_trail8',   t: '移動停利 8%(從最高收盤回落 8%)', env: { EXIT: 'trail8' } },
    { g: 'exit', id: 'x_ma5',      t: '跌破 5 日線', env: { EXIT: 'ma5' } },
    { g: 'exit', id: 'x_d20m40',   t: '唐奇安 20 日・最長抱 40 天(等你決定的那個)', env: { MAXD: '40' } },
    { g: 'exit', id: 'x_d10w40',   t: '唐奇安 10 日・進場 10 天後才看・最長 40 天', env: { EXIT: 'don10w', MAXD: '40' } },
    { g: 'exit', id: 'x_d10w',     t: '唐奇安 10 日・進場 10 天後才看', env: { EXIT: 'don10w' } },
    { g: 'exit', id: 'x_d10',      t: '唐奇安 10 日', env: { EXIT: 'don10' } },
    { g: 'exit', id: 'x_d20w',     t: '唐奇安 20 日・進場 20 天後才看(最長只抱 20 天 → 其實等於不用出場線)', env: { EXIT: 'don20w' } },
    { g: 'exit', id: 'x_d15',      t: '唐奇安 15 日', env: { EXIT: 'don15' } },
    { g: 'exit', id: 'x_d5',       t: '唐奇安 5 日', env: { EXIT: 'don5' } },
    { g: 'exit', id: 'x_d30',      t: '唐奇安 30 日', env: { EXIT: 'don30' } },
    { g: 'exit', id: 'x_d55',      t: '唐奇安 55 日', env: { EXIT: 'don55' } },
    { g: 'exit', id: 'x_d55m40',   t: '唐奇安 55 日・最長抱 40 天', env: { EXIT: 'don55', MAXD: '40' } },
    { g: 'exit', id: 'x_atr2m40',  t: 'ATR 追蹤・最長抱 40 天', env: { EXIT: 'chand2', MAXD: '40' } },
    { g: 'exit', id: 'x_d10m40',   t: '唐奇安 10 日・最長抱 40 天', env: { EXIT: 'don10', MAXD: '40' } },
    { g: 'exit', id: 'x_chd25',    t: '動態 ATR 追蹤 K=2.5(ATR 逐日更新)', env: { EXIT: 'chandd2.5' } },
    { g: 'exit', id: 'x_chd2',     t: '動態 ATR 追蹤 K=2', env: { EXIT: 'chandd2' } },
    { g: 'exit', id: 'x_x520',     t: '5 日線跌破 20 日線(死亡交叉)才走', env: { EXIT: 'x5_20' } },
    { g: 'exit', id: 'x_sar',      t: '拋物線 SAR', env: { EXIT: 'sar' } },
    { g: 'exit', id: 'x_plow',     t: '跌破昨日最低就走', env: { EXIT: 'plow' } },
    { g: 'exit', id: 'x_ma5be3',   t: '5 日線 + 賺 3% 後停損提到成本', env: { EXIT: 'ma5be3' } },
    { g: 'exit', id: 'x_ma5be5',   t: '5 日線 + 賺 5% 後停損提到成本', env: { EXIT: 'ma5be5' } },
    { g: 'exit', id: 'x_atrt3',    t: 'ATR 移動停損 K=3(只升不降)', env: { EXIT: 'atrt3' } },
    { g: 'exit', id: 'x_atrt2',    t: 'ATR 移動停損 K=2', env: { EXIT: 'atrt2' } },
    { g: 'exit', id: 'x_rr2',      t: '5 日線 + 風報比 2 倍到就走', env: { EXIT: 'ma5rr2' } },
    { g: 'exit', id: 'x_rr3',      t: '5 日線 + 風報比 3 倍到就走', env: { EXIT: 'ma5rr3' } },
    { g: 'exit', id: 'x_tp10',     t: '5 日線 + 固定停利 +10%', env: { EXIT: 'ma5tp10' } },
    { g: 'exit', id: 'x_tp15',     t: '5 日線 + 固定停利 +15%', env: { EXIT: 'ma5tp15' } },
    { g: 'exit', id: 'x_tp20',     t: '5 日線 + 固定停利 +20%', env: { EXIT: 'ma5tp20' } },
    { g: 'exit', id: 'x_half10',   t: '5 日線 + 賺 10% 先賣一半', env: { EXIT: 'ma5half10' } },
    { g: 'exit', id: 'x_half15',   t: '5 日線 + 賺 15% 先賣一半', env: { EXIT: 'ma5half15' } },
    { g: 'exit', id: 'x_ma5m40',   t: '跌破 5 日線・最長抱 40 天', env: { EXIT: 'ma5', MAXD: '40' } },
    { g: 'exit', id: 'x_ma20m40',  t: '跌破 20 日線・最長抱 40 天', env: { EXIT: 'ma20', MAXD: '40' } },
    { g: 'exit', id: 'x_ma20tm',   t: '跌破 20 日線 + 10 天沒漲 3% 就走・最長 40 天', env: { EXIT: 'ma20tm10_3', MAXD: '40' } },
    { g: 'exit', id: 'x_ma10',     t: '跌破 10 日線', env: { EXIT: 'ma10' } },
    { g: 'exit', id: 'x_none',     t: '不用出場線(只靠停損 + 抱滿 20 天)', env: { EXIT: 'none' } },
    // ⏰ 進場(只換買的時間)
    { g: 'entry', id: 'e_nextopen', t: '隔天一開盤就買', env: { ENTRY: 'nextopen' } },
    { g: 'entry', id: 'e_nextclose', t: '隔天收盤才買(等一天看穩)', env: { ENTRY: 'nextclose' } },
    { g: 'entry', id: 'e_prevlim',  t: '開盤前掛「前一天收盤價」等它跌回來', env: { ENTRY: 'prevclose_lim' } },
    { g: 'entry', id: 'e_gap1',     t: '隔天開盤買、跳空 >1% 不追', env: { ENTRY: 'nextopen_lim', GAPCAP: '1' } },
    // 🧬 選股(只換挑哪幾檔)
    { g: 'pick', id: 's_plain',    t: '不挑 🧬(照清單順序)', env: { SELF: '' } },
    { g: 'pick', id: 's_hivol',    t: '只做高波動', env: { SELF: 'hivolat' } },
    { g: 'pick', id: 's_high',     t: '只做高位階', env: { SELF: 'high' } },
    { g: 'pick', id: 's_low',      t: '只做低位階(撿便宜)', env: { SELF: 'low' } },
    { g: 'pick', id: 's_lovol',    t: '只做低波動(牛皮股)', env: { SELF: 'lovolat' } },
    { g: 'pick', id: 's_liq',      t: '🧬 + 只做成交值 ≥1 億', env: { FILTER: 'liq', LIQ: '1' } },
    { g: 'pick', id: 's_conf',     t: '🧬 + 至少 2 招同時觸發才做', env: { FILTER: 'conf', CONF: '2' } },
    { g: 'pick', id: 's_finacc',   t: '🧬 + 只挑營收年增加速的', env: { FIN: 'acc' } },
    // 💰 部位(每天幾檔、每筆多少)
    { g: 'size', id: 'z_p1',       t: '每天 1 檔 × 30 萬', env: { LOT: '300000' }, picks: 1 },
    { g: 'size', id: 'z_p3',       t: '每天 3 檔 × 10 萬', env: { LOT: '100000' }, picks: 3 },
    { g: 'size', id: 'z_p6',       t: '每天 6 檔 × 5 萬(為了分散)', env: { LOT: '50000' }, picks: 6 },
    { g: 'size', id: 'z_risk1',    t: '風險法:單筆最多虧本金 1%', env: { SIZING: 'risk', RISK_PCT: '1' } },
    { g: 'size', id: 'z_risk2',    t: '風險法:單筆最多虧本金 2%', env: { SIZING: 'risk', RISK_PCT: '2' } },
    // 🏛️ 大盤狀態
    { g: 'mkt',  id: 'm_bear60',   t: '嚴格空頭不做(大盤收<60日線 且 20日線<60日線)', env: { FILTER: 'bear60' } },
    { g: 'mkt',  id: 'm_regime',   t: '大盤在月線之上才做', env: { FILTER: 'regime' } },
    { g: 'mkt',  id: 'm_onlydrop', t: '只在大盤昨天大跌 >1.5% 後做', env: { CAL: 'onlydrop' } },
    // 📆 行事曆
    { g: 'cal',  id: 'c_noset',    t: '結算日不做', env: { CAL: 'noset' } },
    { g: 'cal',  id: 'c_nolate',   t: '下旬(21 日後)不做', env: { CAL: 'nolate' } },
    { g: 'cal',  id: 'c_nofri',    t: '週五不做', env: { CAL: 'nofri' } },
    { g: 'cal',  id: 'c_nomon',    t: '週一不做', env: { CAL: 'nomon' } },
    { g: 'cal',  id: 'c_nohol',    t: '長假前不做', env: { CAL: 'nohol' } },
    { g: 'cal',  id: 'c_nofin',    t: '財報期不做', env: { CAL: 'nofin' } },
    { g: 'cal',  id: 'c_onlymid',  t: '只在中旬(11~20 日)做', env: { CAL: 'onlymid' } },
    { g: 'cal',  id: 'c_norev',    t: '上旬(1~10 日)不做', env: { CAL: 'norev' } },
    { g: 'cal',  id: 'c_mix3',     t: '下旬 + 財報期 + 長假前都不做', env: { CAL: 'nolate+nofin+nohol' } },
    // ⚔️ 其他組合
    { g: 'x',    id: 'o_stop3',    t: '停損收緊到進場 −3%', env: { STOP: 'pct3' } },
    { g: 'x',    id: 'o_t8reg',    t: '移動停利 8% + 大盤在月線之上才做', env: { EXIT: 'trail8', FILTER: 'regime' } },
];
// ⛔ 舊情境庫裡沒辦法逐年重跑的 —— 寫出原因(⛔ 不可靜默消失)
export const SKIPPED = [
    { t: '唐奇安 10 日 + 賺 5% 後停損提到成本', why: '那個出場組合現在的回測程式認不得(當年的寫法其實沒有唐奇安在裡面),重跑出來不會是同一件事' },
    { t: '🧬 × 只做「加分偵測器訊號」', why: '要另外先產一份訊號對照檔(sig_x_playbook_probe),這一輪沒做' },
    { t: '窗口長度對照(13 → 36 → 49 個月)', why: '逐年成績單本身就是更清楚的版本(一年一格),不用再比窗口' },
];
export const GROUPS = { combo: '🧪 組合:兩三個改動一起', now: '⭐ 決策台現行', exit: '🚪 出場:只換賣的規則', entry: '⏰ 進場:只換買的時間', pick: '🧬 選股:只換挑哪幾檔', size: '💰 部位:每天幾檔、每筆多少', mkt: '🏛️ 大盤狀態:哪種盤才做', cal: '📆 行事曆:哪幾天不做', x: '⚔️ 其他組合' };

// 🧪 V77.6.2 長歷史組合(`SET=long`):2011~2026,只跑不需要 2021 以後才有的資料(財報 / 週轉 / 價值)的那些
//   ⭐ 組合是**看 2011~2020 之前**就定好的(依 2022~2026 逐年表挑出來的方向)→ 2011~2020 是真的樣本外
export const COMBOS = [
    { g: 'combo', id: 'k_d10m40bear', t: '🧪 唐奇安 10 日・最長 40 天 + 嚴格空頭不做', env: { EXIT: 'don10', MAXD: '40', FILTER: 'bear60' } },
    { g: 'combo', id: 'k_d20m40bear', t: '🧪 唐奇安 20 日・最長 40 天 + 嚴格空頭不做', env: { MAXD: '40', FILTER: 'bear60' } },
    { g: 'combo', id: 'k_d10wm40bear', t: '🧪 唐奇安 10 日(10 天後才看)・最長 40 天 + 嚴格空頭不做', env: { EXIT: 'don10w', MAXD: '40', FILTER: 'bear60' } },
    { g: 'combo', id: 'k_d10m40nc',  t: '🧪 唐奇安 10 日・最長 40 天 + 隔天收盤才買', env: { EXIT: 'don10', MAXD: '40', ENTRY: 'nextclose' } },
    { g: 'combo', id: 'k_d10m40plain', t: '🧪 不挑 🧬 + 唐奇安 10 日・最長 40 天', env: { EXIT: 'don10', MAXD: '40', SELF: '' } },
    { g: 'combo', id: 'k_d10m60',    t: '🧪 唐奇安 10 日・最長 60 天', env: { EXIT: 'don10', MAXD: '60' } },
    { g: 'combo', id: 'k_d20m60',    t: '🧪 唐奇安 20 日・最長 60 天', env: { MAXD: '60' } },
    { g: 'combo', id: 'k_d20m60bear', t: '🧪 唐奇安 20 日・最長 60 天 + 嚴格空頭不做', env: { MAXD: '60', FILTER: 'bear60' } },
    // ⭐ 看完 2011~2026 的逐年表之後才加的(兩個各自兩段都站得住的成分合起來)→ ⛔ 不是樣本外,要看 17 條連續路徑與高原
    { g: 'combo', id: 'k_d55m40bear', t: '🧪 唐奇安 55 日・最長 40 天 + 嚴格空頭不做', env: { EXIT: 'don55', MAXD: '40', FILTER: 'bear60' } },
    { g: 'combo', id: 'k_d40m40bear', t: '⭐ 唐奇安 40 日・最長 40 天 + 嚴格空頭不做(16 年最穩的一組)', env: { EXIT: 'don40', MAXD: '40', FILTER: 'bear60' } },
    { g: 'combo', id: 'k_d70m40bear', t: '🧪 唐奇安 70 日・最長 40 天 + 嚴格空頭不做', env: { EXIT: 'don70', MAXD: '40', FILTER: 'bear60' } },
];
const LONG_IDS = ['base', 's_plain', 's_high', 's_hivol', 'x_atr2', 'x_trail8', 'x_ma5', 'x_d10', 'x_d20m40', 'x_d10m40', 'x_d10w40', 'x_d55m40', 'x_atr2m40', 'x_none', 'e_nextclose', 'e_nextopen', 'm_bear60', 'm_regime'];
const SET = process.env.SET || '';
const RUN_STRATS = SET === 'long' ? [...LONG_IDS.map(id => STRATS.find(s => s.id === id)), ...COMBOS] : STRATS;
const RUN_YEARS = process.env.YEARS_RUN ? process.env.YEARS_RUN.split(',') : (SET === 'long' ? Array.from({ length: 16 }, (_, k) => String(2011 + k)) : YEARS);
const CACHE_KEYS = ['ENTRY', 'EXIT', 'MAXD', 'STOP', 'GAPCAP', 'STOPFILL'];
export const envOf = s => ({ ...BASE, ...s.env });
export const cacheName = s => { const e = envOf(s); return 'tr_' + CACHE_KEYS.map(k => `${k}-${(e[k] || 'd').replace(/[^\w.]/g, '_')}`).join('_') + '.json'; };

const _MAIN = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (_MAIN) await main();
async function main() {
if (process.argv.includes('--list')) {
    for (const s of RUN_STRATS) console.log(`${s.g.padEnd(6)} ${s.id.padEnd(12)} ${cacheName(s).padEnd(70)} ${s.t}`);
    console.log(`\n${RUN_STRATS.length} 個策略 ・${RUN_YEARS.length} 年 ・${new Set(RUN_STRATS.map(cacheName)).size} 份交易快取 ・跳過 ${SKIPPED.length} 列`);
    process.exit(0);
}

const OUT = process.env.OUT_DIR;
const ci = process.argv.indexOf('--collect');
if (ci > 0) {
    if (!OUT) { console.error('🚨 --collect 要 OUT_DIR'); process.exit(1); }
    const res = { asof: new Date().toISOString().slice(0, 10), set: SET || 'main', years: RUN_YEARS, offsets: OFFSETS, base: BASE, picks: BASE_PICKS, groups: GROUPS, skipped: SKIPPED, bench: {}, strats: [] };
    const miss = [];
    for (const s of RUN_STRATS) {
        const row = { id: s.id, g: s.g, t: s.t, y: {} };
        for (const y of RUN_YEARS) {
            const rs = OFFSETS.map(o => { const f = path.join(OUT, `${s.id}_${y}_${o}.json`); try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } });
            const r0 = rs[0];
            if (!r0) { miss.push(`${s.id}_${y}_0`); continue; }
            const others = rs.filter(Boolean).map(r => r.pnl);
            row.y[y] = {
                n: r0.n, win: r0.win ?? null, per: r0.per ?? null, pnl: r0.pnl, ret: r0.ret, end: r0.end ?? Math.round(1e6 + r0.pnl),
                perAmt: r0.perAmt ?? null, worst: r0.worst ?? null, best: r0.best ?? null, dd: r0.dd ?? null,
                from: r0.yFrom || r0.from, to: r0.yTo || r0.to, lastOut: r0.lastOut || null, cross: r0.crossYear ?? 0,
                lo: Math.min(...others), hi: Math.max(...others), paths: others.length,
            };
            // ⚠️ V77.6.2 修:以前只在「0050 有值」才記 → 2021 以前(沒有 0050)連大盤那一列都不見了(embed 的守門抓到)
            if (s.id === 'base' && r0.ytwii != null) res.bench[y] = { e0050: r0.y0050 ?? null, e0050tr: r0.y0050tr ?? null, twii: r0.ytwii, from: r0.yFrom, to: r0.yTo };
        }
        res.strats.push(row);
    }
    if (miss.length) { console.error(`🚨 缺 ${miss.length} 格(例:${miss.slice(0, 5).join(', ')})→ ⛔ 不產出,先把 runner 跑完`); process.exit(1); }
    fs.writeFileSync(process.argv[ci + 1], JSON.stringify(res));
    console.log(`✅ ${res.strats.length} 個策略 × ${RUN_YEARS.length} 年 → ${process.argv[ci + 1]}`);
    process.exit(0);
}

// ── 跑 ──
const CACHE = process.env.CACHE_DIR;
if (!OUT || !CACHE || !process.env.DATA_DIR) { console.error('🚨 要 DATA_DIR / OUT_DIR / CACHE_DIR'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(CACHE, { recursive: true });
const LANES = Math.max(1, +(process.env.LANES || 4));
// 同一份快取的策略排在同一條線,而且那一條線的第一個工作一定是「產生快取」那一個(⛔ 兩條線同時寫同一個檔會壞)
const byCache = new Map();
for (const s of RUN_STRATS) { const c = cacheName(s); if (!byCache.has(c)) byCache.set(c, []); byCache.get(c).push(s); }
const groups = [...byCache.entries()].map(([c, ss]) => ({ c, jobs: ss.flatMap(s => RUN_YEARS.flatMap(y => OFFSETS.map(o => ({ s, y, o })))) }));
// 已經有快取的組排後面(先把要產快取的慢工作分出去)
groups.sort((a, b) => fs.existsSync(path.join(CACHE, a.c)) - fs.existsSync(path.join(CACHE, b.c)));
const runOne = ({ s, y, o }, c) => new Promise(res => {
    const f = path.join(OUT, `${s.id}_${y}_${o}.json`);
    if (fs.existsSync(f)) return res(0);
    const env = { ...process.env, ...envOf(s), YEAR: y, YEAR_OFFSET: String(o), TRADES_CACHE: path.join(CACHE, c), SUMMARY_OUT: f };
    const p = spawn('node', ['--max-old-space-size=5000', path.join(ROOT, 'scripts/portfolio_backtest.mjs'), '600', String(s.picks || BASE_PICKS)], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; p.stdout.on('data', d => { log += d; if (log.length > 20000) log = log.slice(-20000); }); p.stderr.on('data', d => { log += d; });
    p.on('close', code => { if (code !== 0) { fs.writeFileSync(f.replace(/\.json$/, '.err'), log); console.error(`❌ ${s.id} ${y} +${o} rc=${code}`); } res(code); });
});
// ⚖️ V77.6.2 兩階段:① 每份快取只由一個工作建(建好之前同快取的其他工作等著)② 建好之後所有工作進同一條隊伍平均分給每條線
//   (V77.6.1 那一輪「共用同一份快取的 30 個策略全擠在同一條線」→ 最後 30 分鐘只剩一條線在跑)
let done = 0; const total = groups.reduce((a, g) => a + g.jobs.length, 0); const t0 = Date.now();
const ready = new Map();
for (const g of groups) { let res; const p = new Promise(r => { res = r; }); ready.set(g.c, { p, res, built: fs.existsSync(path.join(CACHE, g.c)) }); if (fs.existsSync(path.join(CACHE, g.c))) res(); }
const queue = [...groups.map(g => ({ ...g.jobs[0], c: g.c, builder: true })), ...groups.flatMap(g => g.jobs.slice(1).map(j => ({ ...j, c: g.c })))];
const lane = async () => { while (queue.length) { const j = queue.shift(); const R = ready.get(j.c); if (!j.builder) await R.p; await runOne(j, j.c); if (j.builder) R.res(); done++; if (done % 50 === 0) console.log(`… ${done}/${total}(${((Date.now() - t0) / 60000).toFixed(1)} 分)`); } };
await Promise.all(Array.from({ length: LANES }, () => lane()));
const errs = fs.readdirSync(OUT).filter(f => f.endsWith('.err'));
console.log(`✅ 跑完 ${done}/${total} ・失敗 ${errs.length} 格${errs.length ? '(看 OUT_DIR/*.err)' : ''}・${((Date.now() - t0) / 60000).toFixed(1)} 分`);
}
