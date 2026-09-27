// 💸 V77.7.4 每一筆的「機會成本」+ 賣掉之後那一檔又走了多少
//
// 外部建議的兩個問題,⭐ 用決策台**實際成交**的交易(portfolio_backtest TAKEN_OUT)直接量,⛔ 不重新模擬:
//   ① 機會成本:同一段持有期間,錢如果放在 0050(含息)會賺多少 → 每一筆的超額 = 這筆 − 0050
//      → 回答「策略輸 0050 是因為每一筆都輸一點,還是少數幾筆大賠拖累」
//   ② 賣掉之後:出場那天收盤 → 之後 20 / 40 個交易日,那一檔 vs 0050
//      → 回答「是不是太早賣、把後面的行情讓掉了」(= 要不要做「賣了再買回」)
// ⚠️ 進場 = 訊號日收盤(同 portfolio_backtest);0050 用同一天收盤到出場日收盤。
// ⚠️ 被「賣掉後」那一段只是描述,⛔ 不是可以執行的策略(出場當下不知道之後會漲)。
//
// 跑法:DATA_DIR=<K 線目錄> DIV=<dividends_hist.json> node scripts/trade_alpha_probe.mjs taken1.json[,taken2.json] [標籤]
//       node scripts/trade_alpha_probe.mjs --selftest
import fs from 'fs';
import { loadPx, trSeries } from './lib_totalreturn.mjs';

export function benchRet(idx, S, a, b) {
    const i = idx.get(a), j = idx.get(b);
    if (i === undefined || j === undefined || j < i) return null;
    return (S.v[j] / S.v[i] - 1) * 100;
}
/** 往後 n 個交易日的報酬(用那一檔自己的日曆);資料不夠回 null */
export function fwd(bars, bi, d, n) {
    const i = bi.get(d); if (i === undefined || i + n >= bars.length) return null;
    return (bars[i + n].c / bars[i].c - 1) * 100;
}
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;

function selftest() {
    const fails = []; const ck = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fails.push(m); };
    const bars = Array.from({ length: 100 }, (_, i) => ({ d: `2024-01-${String(i + 1).padStart(3, '0')}`, c: 100 + i }));
    const bi = new Map(bars.map((b, i) => [b.d, i]));
    ck(Math.abs(fwd(bars, bi, bars[10].d, 20) - (130 / 110 - 1) * 100) < 1e-9, '① 往後 20 日 = 第 i+20 根 / 第 i 根');
    ck(fwd(bars, bi, bars[90].d, 20) === null, '② 資料不夠 ⛔ 不硬算');
    const S = trSeries(bars, []);
    ck(Math.abs(benchRet(bi, S, bars[0].d, bars[10].d) - 10) < 1e-9, '③ 基準同期報酬');
    ck(benchRet(bi, S, bars[10].d, bars[0].d) === null, '④ 日期顛倒 ⛔ 不給');
    console.log(fails.length ? `❌ ${fails.length} 條沒過` : '✅ selftest 全過'); process.exit(fails.length ? 1 : 0);
}

const _MAIN = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (_MAIN) {
    if (process.argv.includes('--selftest')) selftest();
    const DIR = process.env.DATA_DIR; if (!DIR) { console.error('🚨 要 DATA_DIR'); process.exit(1); }
    const files = (process.argv[2] || '').split(',').filter(Boolean); const tag = process.argv[3] || '';
    if (!files.length) { console.error('🚨 要 TAKEN_OUT 產物'); process.exit(1); }
    let DV = {}; if (process.env.DIV) { const raw = JSON.parse(fs.readFileSync(process.env.DIV, 'utf8')); DV = raw.d || raw; }
    const b50 = loadPx(DIR, '0050'); const S50 = trSeries(b50, (DV['0050'] || {}).h || []);
    const i50 = new Map(b50.map((b, i) => [b.d, i]));
    const cache = new Map(); const getB = s => { if (!cache.has(s)) { const b = loadPx(DIR, s); cache.set(s, b ? { b, bi: new Map(b.map((x, i) => [x.d, i])) } : null); } return cache.get(s); };
    const seen = new Set(); const rows = [];
    for (const f of files) for (const t of JSON.parse(fs.readFileSync(f, 'utf8'))) {
        const k = `${t.sym}|${t.d}|${t.outD}`; if (seen.has(k) || !t.outD) continue; seen.add(k);   // 多條起點合併時同一筆只算一次
        const bm = benchRet(i50, S50, t.d.replace(/\//g, '-'), String(t.outD).replace(/\//g, '-'));
        if (bm == null) continue;
        const own = t.ret + (t.dv || 0) - 0.44;
        const P = getB(t.sym); const od = String(t.outD).replace(/\//g, '-');
        const a20 = P ? fwd(P.b, P.bi, od, 20) : null, a40 = P ? fwd(P.b, P.bi, od, 40) : null;
        const i0 = i50.get(od);
        const m20 = i0 != null && i0 + 20 < b50.length ? (S50.v[i0 + 20] / S50.v[i0] - 1) * 100 : null;
        const m40 = i0 != null && i0 + 40 < b50.length ? (S50.v[i0 + 40] / S50.v[i0] - 1) * 100 : null;
        // ③ 回吐:持有期間最高收盤 → 出場收盤掉了多少、最高點離出場幾天(= 「抱太久把賺的吐回去」有多嚴重)
        let gb = null, pkAgo = null;
        if (P) { const ia = P.bi.get(t.d.replace(/\//g, '-')), ib = P.bi.get(od);
            if (ia != null && ib != null && ib > ia) { let mx = -1, mi = ia; for (let k = ia; k <= ib; k++) if (P.b[k].c > mx) { mx = P.b[k].c; mi = k; }
                gb = (P.b[ib].c / mx - 1) * 100; pkAgo = ib - mi; } }
        rows.push({ own, bm, alpha: own - bm, fx: t.fx, win: own > 0, gb, pkAgo, p20: a20 != null && m20 != null ? a20 - m20 : null, p40: a40 != null && m40 != null ? a40 - m40 : null, r20: a20 });
    }
    const A = rows.map(r => r.alpha).sort((x, y) => x - y);
    const tot = A.reduce((x, y) => x + y, 0);
    const top10 = A.slice(-Math.ceil(A.length * 0.1)).reduce((x, y) => x + y, 0);
    const noTop = A.slice(0, A.length - Math.ceil(A.length * 0.1));
    console.log(`\n💸 ${tag} 實際成交 ${rows.length} 筆(多條起點合併去重)`);
    console.log(`① 機會成本:這筆扣成本後 vs 同期 0050 含息`);
    console.log(`   平均超額 ${mean(A).toFixed(2)}pp ・中位 ${q(A, 0.5).toFixed(2)}pp ・贏 0050 的筆數 ${(A.filter(x => x > 0).length / A.length * 100).toFixed(1)}%`);
    console.log(`   最差 10% ${q(A, 0.1).toFixed(1)}pp ・最好 10% ${q(A, 0.9).toFixed(1)}pp ・拿掉最好那 10% 筆,其餘平均 ${mean(noTop).toFixed(2)}pp`);
    const win = rows.filter(r => r.win), lose = rows.filter(r => !r.win);
    console.log(`   有賺的那幾筆:同期 0050 平均 ${mean(win.map(r => r.bm)).toFixed(2)}% ・賠的那幾筆:同期 0050 平均 ${mean(lose.map(r => r.bm)).toFixed(2)}%`);
    const G = rows.filter(r => r.gb != null), GW = G.filter(r => r.win);
    console.log(`③ 回吐:持有期間最高收盤 → 出場,全部平均 ${mean(G.map(r => r.gb)).toFixed(2)}% ・賺錢那幾筆平均 ${mean(GW.map(r => r.gb)).toFixed(2)}%、最高點在出場前平均 ${mean(GW.map(r => r.pkAgo)).toFixed(1)} 個交易日`);
    const P20 = rows.map(r => r.p20).filter(x => x != null), P40 = rows.map(r => r.p40).filter(x => x != null);
    console.log(`② 賣掉之後(出場日收盤起,那一檔 − 0050 含息):`);
    console.log(`   20 日 平均 ${mean(P20).toFixed(2)}pp ・中位 ${q(P20, 0.5).toFixed(2)}pp ・贏 0050 ${(P20.filter(x => x > 0).length / P20.length * 100).toFixed(1)}%(n=${P20.length})`);
    console.log(`   40 日 平均 ${mean(P40).toFixed(2)}pp ・中位 ${q(P40, 0.5).toFixed(2)}pp ・贏 0050 ${(P40.filter(x => x > 0).length / P40.length * 100).toFixed(1)}%(n=${P40.length})`);
    const W = rows.filter(r => r.win && r.p20 != null).map(r => r.p20), L = rows.filter(r => !r.win && r.p20 != null).map(r => r.p20);
    console.log(`   分開看:賺錢出場的那幾檔 20 日後 ${mean(W).toFixed(2)}pp ・停損/賠錢出場的 ${mean(L).toFixed(2)}pp`);
    const F = rows.filter(r => r.fx === 1 && r.p20 != null).map(r => r.p20);
    if (F.length) console.log(`   空頭日強制賣掉的 ${F.length} 筆:20 日後 ${mean(F).toFixed(2)}pp`);
    if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify({ tag, n: rows.length, alphaMean: mean(A), alphaMed: q(A, 0.5), beat: A.filter(x => x > 0).length / A.length, noTopMean: mean(noTop), giveback: mean(G.map(r => r.gb)), givebackWin: mean(GW.map(r => r.gb)), post20: mean(P20), post20med: q(P20, 0.5), post40: mean(P40), post20win: mean(W), post20lose: mean(L) }));
}
