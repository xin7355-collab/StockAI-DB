// 🪜 V77.7.4 多基準對照 —— 同一個窗口,把決策台的成績跟一整排 ETF「買了放著(含息)」比
//
// 使用者轉述的外部建議:「基準不能只看 0050」。⭐ 這支只做一件事:
//   同一段日期、同樣 100 萬、股利除息日再投入、扣二代健保(lib_totalreturn.trSeries,⛔ 不寫第二份),
//   印出每一檔 ETF 的總報酬、年化、最大回撤,再跟 SUMMARY_OUT 產物(portfolio_backtest)並排。
// ⛔ 上市比窗口晚的 ETF 不硬比(印「上市晚於窗口」),⛔ 不拿較短的期間湊一個數字。
// ⛔ 槓桿 ETF 另列,不混進排名。
//
// 跑法:
//   DATA_DIR=<K 線目錄> DIV=<dividends_hist.json> FROM=2022-09-16 TO=2026-09-24 \
//   STRATS="現行=path1.json,path2.json;移動停利8%=…" node scripts/bench_ladder.mjs [out.json]
//   node scripts/bench_ladder.mjs --selftest
import fs from 'fs';
import { loadPx, trSeries } from './lib_totalreturn.mjs';

export const LADDER = [
    ['0050', '台灣50(核心大盤)'], ['006208', '富邦台50(同一個指數)'], ['0052', '富邦科技'],
    ['00881', '國泰台灣5G+(科技龍頭)'], ['00891', '中信關鍵半導體'], ['00892', '富邦台灣半導體'],
    ['00733', '富邦臺灣中小'], ['00692', '富邦公司治理'], ['00922', '國泰台灣領袖50'],
    ['0056', '元大高股息'], ['00878', '國泰永續高股息'], ['00919', '群益台灣精選高息'], ['00713', '元大台灣高息低波'],
];
export const LEVER = [['00631L', '元大台灣50正2(槓桿,另列)']];

/** 一段窗口的含息成績;上市晚於窗口起點 → null + 原因 */
export function benchOf(bars, divs, from, to, capital = 1e6) {
    if (!bars || !bars.length) return { err: '沒有 K 線' };
    const w = bars.filter(b => b.d >= from && b.d <= to);
    if (!w.length) return { err: '窗口內沒有資料' };
    if (bars[0].d > from) return { err: `上市晚於窗口(${bars[0].d} 起)` };
    const S = trSeries(w, divs, { capital, nhi: true });
    const v = S.v; let pk = v[0], dd = 0;
    for (const x of v) { if (x > pk) pk = x; dd = Math.min(dd, x / pk - 1); }
    const yrs = (Date.parse(w[w.length - 1].d) - Date.parse(w[0].d)) / (365.25 * 864e5);
    const tr = v[v.length - 1] / v[0] - 1, px = w[w.length - 1].c / w[0].c - 1;
    return { from: w[0].d, to: w[w.length - 1].d, ret: tr * 100, pxRet: px * 100, cagr: (Math.pow(1 + tr, 1 / yrs) - 1) * 100, dd: dd * 100, gain: tr * capital };
}

function med(a) { const s = a.slice().sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; }

function selftest() {
    const fails = []; const ck = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fails.push(m); };
    const bars = []; let p = 100;
    for (let i = 0; i < 500; i++) { const d = new Date(Date.UTC(2022, 0, 3) + i * 864e5).toISOString().slice(0, 10); bars.push({ d, c: p }); p *= 1.001; }
    const a = benchOf(bars, [], bars[0].d, bars[499].d);
    ck(Math.abs(a.ret - a.pxRet) < 1e-9, '① 沒有股利時含息 = 價格報酬');
    const b = benchOf(bars, [[bars[100].d, 5, '息', bars[100].c]], bars[0].d, bars[499].d);
    ck(b.ret > a.ret, '② 有股利時含息 > 價格報酬(股利真的有入帳)');
    const c = benchOf(bars.slice(50), [], bars[0].d, bars[499].d);
    ck(!!c.err && /上市晚於/.test(c.err), '③ 上市晚於窗口 ⛔ 不硬比,回原因');
    const dn = bars.map((x, i) => ({ d: x.d, c: i < 250 ? 100 - i * 0.2 : 50 + (i - 250) * 0.3 }));
    const e = benchOf(dn, [], dn[0].d, dn[499].d);
    ck(e.dd < -49 && e.dd > -51, `④ 最大回撤算得出來(${e.dd.toFixed(1)}%,期望約 −50%)`);
    console.log(fails.length ? `❌ ${fails.length} 條沒過` : '✅ selftest 全過');
    process.exit(fails.length ? 1 : 0);
}

const _MAIN = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (_MAIN) {
    if (process.argv.includes('--selftest')) selftest();
    const DIR = process.env.DATA_DIR, FROM = process.env.FROM, TO = process.env.TO;
    if (!DIR || !FROM || !TO) { console.error('🚨 要 DATA_DIR / FROM / TO'); process.exit(1); }
    let DV = {};
    if (process.env.DIV) { const raw = JSON.parse(fs.readFileSync(process.env.DIV, 'utf8')); DV = raw.d || raw; }
    else console.log('⚠️ 沒給 DIV → 全部是「不含息」,對高股息 ETF 嚴重不公平');
    const out = { from: FROM, to: TO, etf: [], lever: [], strats: [] };
    console.log(`\n🪜 多基準對照 ${FROM} ~ ${TO}(100 萬・股利除息日再投入・扣二代健保)\n`);
    console.log('ETF'.padEnd(8) + '名稱'.padEnd(20) + '含息總報酬'.padStart(10) + '價格報酬'.padStart(10) + '年化'.padStart(8) + '最大回撤'.padStart(9));
    for (const [list, key] of [[LADDER, 'etf'], [LEVER, 'lever']]) {
        if (key === 'lever') console.log('── 槓桿(另列,⛔ 不進排名)──');
        for (const [sym, nm] of list) {
            const r = benchOf(loadPx(DIR, sym), (DV[sym] || {}).h || [], FROM, TO);
            out[key].push({ sym, nm, ...r });
            if (r.err) { console.log(`${sym.padEnd(8)}${nm.padEnd(20)} ⏳ ${r.err}`); continue; }
            console.log(`${sym.padEnd(8)}${nm.padEnd(20)}${(r.ret.toFixed(1) + '%').padStart(10)}${(r.pxRet.toFixed(1) + '%').padStart(10)}${(r.cagr.toFixed(1) + '%').padStart(8)}${(r.dd.toFixed(1) + '%').padStart(9)}`);
        }
    }
    // 策略:STRATS="名稱=a.json,b.json;名稱2=…" → 17 條起點取中位
    for (const grp of (process.env.STRATS || '').split(';').filter(Boolean)) {
        const [nm, files] = grp.split('=');
        const rs = files.split(',').map(f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } }).filter(Boolean);
        if (!rs.length) continue;
        out.strats.push({ nm, n: rs.length, ret: med(rs.map(r => r.ret)), dd: med(rs.map(r => r.dd)), lo: Math.min(...rs.map(r => r.ret)), hi: Math.max(...rs.map(r => r.ret)) });
    }
    if (out.strats.length) {
        console.log('\n── 策略(17 條起點中位;⚠️ 起點每條不同,ETF 那一排是從窗口第一天算)──');
        const ok = out.etf.filter(e => !e.err);
        for (const s of out.strats) {
            const beat = ok.filter(e => s.ret > e.ret).map(e => e.sym);
            console.log(`${s.nm.padEnd(18)} 中位 ${s.ret.toFixed(1)}%(${s.lo.toFixed(0)}~${s.hi.toFixed(0)}%)回撤 ${s.dd.toFixed(1)}% ・贏 ${beat.length}/${ok.length} 檔:${beat.join(' ') || '—'}`);
        }
    }
    if (process.argv[2] && !process.argv[2].startsWith('-')) { fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1)); console.log(`\n📤 → ${process.argv[2]}`); }
}
