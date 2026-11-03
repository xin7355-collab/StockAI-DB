#!/usr/bin/env node
/**
 * 📊 V81.0.0 散戶 App「🔓 進階功能 › 📊 這套策略每年賺多少」的資料 —— 寫進 index.html 的 `_STRAT_YEARLY`(一行)
 *   使用者 11/03:「散戶 App 要放的地方是在進階設定裡面…告訴我這個策略的報酬率,我是要每年的報酬率」
 *
 *   ⭐ 每一年 = **那一年 1 月重新放 100 萬**、只買那一年的訊號(= 作戰室逐年成績單 `_YEARLY_BT` 那一格;使用者 V77.6.1 自己定的口徑)
 *     ⛔ 不用「一個帳戶一路滾、逐年切」:每筆固定 15 萬,帳戶滾到上千萬之後幾乎全部停在 0050 → 後面幾年的報酬 ≈ 0050,不是拿 100 萬在做的樣子
 *     🧯 🅿️ 那一列是 V81.0.0 修好「逐年模式 + 停 0050」之後重跑的(陷阱 #66)
 *   🏦 16 年合計 / 中途最多賠 / 勝率・每筆平均・筆數 = pro `_PROFIT_BOARD` 16 年那一組(一路滾、17 個起點,⛔ 不另算)
 *   對照:每一列 = 散戶設定裡的一個選項(park 🅿️ / gene 📈 錢放現金 / leadpark 👑 停 0050 / lead 💵 👑 錢放現金)
 *   交叉驗證(⛔ 對不上就 exit 1):每一年都有值;0050 用那一列自己的對照(yb,同一份資料、同一段日期);讀回來逐格相同
 *   用法:node scripts/embed_strat_yearly.mjs   ・   node scripts/embed_strat_yearly.mjs --selftest
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const die = m => { console.error('❌ ' + m); process.exit(1); };
export const MAP = [['park', 'park', 'now949'], ['gene', 'hot', 'now949c'], ['leadpark', 'lead', 'lead'], ['lead', 'leadcash', 'lead_cash']];   // [散戶設定 key, 看板 key, 逐年表 id]

// 逐年表一格(陣列)→ 要的四個欄位
export function cellOf(cols, a) { if (!a) return null; const o = {}; cols.forEach((c, i) => { o[c] = a[i]; }); return { r: o.ret, n: o.n, w: o.win, dd: o.dd }; }

export function build(PB, YB) {
    const L = PB.wins.long, gL = k => L.rows.find(r => r.k === k);
    const YRS = YB.years;
    const rows = MAP.map(([k, bk, yid]) => {
        const b = gL(bk), s = YB.strats.find(x => x.id === yid);
        if (!b) throw new Error(`看板沒有 ${bk}`);
        if (!s) throw new Error(`逐年表沒有 ${yid}`);
        if (b.tN == null) throw new Error(`看板 ${bk} 沒有 tWin / tPer / tN(先跑 embed_profit_board --stats)`);
        if (!s.yb) throw new Error(`逐年表 ${yid} 沒有自己的 0050 對照(yb)`);
        const y = {}, e = {};
        for (const yy of YRS) {
            const c = cellOf(YB.cols, s.y[yy]); if (!c || !Number.isFinite(c.r)) throw new Error(`${yid} ${yy} 沒有值`);
            const e50 = s.yb[yy] && s.yb[yy].e0050tr; if (!Number.isFinite(e50)) throw new Error(`${yid} ${yy} 沒有 0050 含息`);
            y[yy] = [c.r, c.n, c.w, c.dd]; e[yy] = e50;
        }
        return { k, bk, yid, y, e, to: s.yb[YRS[YRS.length - 1]].to, fin: b.fin, mdd: b.mdd, tWin: b.tWin, tPer: b.tPer, tN: b.tN };
    });
    const e0 = gL('0050');
    return { from: L.from, to: PB.to, paths: PB.paths, years: YRS, cols: ['r', 'n', 'w', 'dd'],
        src: 'scripts/embed_strat_yearly.mjs ← pro _YEARLY_BT(每年 1 月重新放 100 萬)+ _PROFIT_BOARD(16 年一路滾)',
        e50: { fin: e0.fin, mdd: e0.mdd }, rows };
}

if (process.argv[2] === '--selftest') {
    let ok = 0, bad = 0; const t = (c, m) => { if (c) ok++; else { bad++; console.error('❌ ' + m); } };
    const cols = ['n', 'win', 'per', 'pnl', 'ret', 'perAmt', 'worst', 'best', 'dd', 'lo', 'hi', 'cross'];
    const cell = (ret, n) => [n, 30, 1, ret * 1e4, ret, 1, -1, 1, -20, 0, 0, 0];
    const mkS = id => ({ id, y: { 2011: cell(10, 5), 2012: cell(-5, 6) }, yb: { 2011: { e0050tr: 3 }, 2012: { e0050tr: -2, to: '2012-12-28' } } });
    const YB = { cols, years: ['2011', '2012'], strats: ['now949', 'now949c', 'lead', 'lead_cash'].map(mkS) };
    const row = (k, fin) => ({ k, fin, mdd: -30, tWin: 33, tPer: 2, tN: 100 });
    const PB = { to: '2012-12-28', paths: 17, wins: { long: { from: '2011-01-03', rows: [row('park', 2e6), row('hot', 1.5e6), row('lead', 3e6), row('leadcash', 2.5e6), row('0050', 1.2e6)] } } };
    const o = build(PB, YB);
    t(o.rows.length === 4 && o.rows[0].k === 'park' && o.rows[0].yid === 'now949', '① 四套照散戶設定 key 對到逐年表 id');
    t(JSON.stringify(o.rows[0].y['2011']) === '[10,5,30,-20]' && o.rows[0].e['2012'] === -2, `② 每一年 = 那一格的報酬 / 筆數 / 有賺 / 最多賠,0050 用那一列自己的對照:${JSON.stringify(o.rows[0].y)}`);
    t(o.rows[3].fin === 2.5e6 && o.e50.fin === 1.2e6 && o.rows[0].to === '2012-12-28', '③ 16 年合計抄看板、0050 合計抄看板、最後一年到哪一天');
    let threw = ''; try { build({ ...PB, wins: { long: { ...PB.wins.long, rows: PB.wins.long.rows.map(r => r.k === 'hot' ? { ...r, tN: null } : r) } } }, YB); } catch (e) { threw = e.message; }
    t(/tWin/.test(threw), '④ 看板還沒有勝率 → 拒絕(⛔ 靜默寫空的)');
    threw = ''; try { const Y2 = JSON.parse(JSON.stringify(YB)); delete Y2.strats[1].y['2012']; build(PB, Y2); } catch (e) { threw = e.message; }
    t(/沒有值/.test(threw), '⑤ 少一年 → 拒絕');
    console.log(`${bad ? '❌' : '✅'} embed_strat_yearly selftest ${ok}/${ok + bad}`);
    process.exit(bad ? 1 : 0);
}

const PRO = path.join(ROOT, 'pro.html'), IDX = path.join(ROOT, 'index.html');
const ph = fs.readFileSync(PRO, 'utf8');
const pm = ph.match(/^  _PROFIT_BOARD: (.*),$/m), ym = ph.match(/^  _YEARLY_BT: (.*),$/m);
if (!pm || !ym) die('pro.html 沒有 _PROFIT_BOARD / _YEARLY_BT');
let out; try { out = build(JSON.parse(pm[1]), JSON.parse(ym[1])); } catch (e) { die(e.message); }
out.asof = new Date().toISOString().slice(0, 10);
const LINE = '    _STRAT_YEARLY: ' + JSON.stringify(out) + ',';
let h = fs.readFileSync(IDX, 'utf8');
const RE = /^    _STRAT_YEARLY: .*,$/m;
if (RE.test(h)) h = h.replace(RE, () => LINE);
else { const a = h.indexOf('    _stratOrder(keys) {'); if (a < 0) die('index.html 找不到 _stratOrder(插入點)'); h = h.slice(0, a) + '    /** 📊 V81.0.0 每一套每年賺多少(scripts/embed_strat_yearly.mjs 產生,⛔ 手改;test_stratperf 跨檔比對 pro _YEARLY_BT / _PROFIT_BOARD) */\n' + LINE + '\n' + h.slice(a); }
fs.writeFileSync(IDX, h);
const back = JSON.parse(fs.readFileSync(IDX, 'utf8').match(RE)[0].replace(/^    _STRAT_YEARLY: /, '').replace(/,$/, ''));
if (JSON.stringify(back) !== JSON.stringify(out)) die('讀回來不一樣');
console.log(`✅ _STRAT_YEARLY 已寫進 index.html(${out.years[0]}~${out.years[out.years.length - 1]}、${out.rows.length} 套)`);
for (const r of out.rows) console.log(`  ${r.k}(${r.yid}): ` + out.years.map(y => `${y} ${r.y[y][0] >= 0 ? '+' : ''}${r.y[y][0]}`).join(' ・'));
