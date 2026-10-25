#!/usr/bin/env node
/**
 * 🏭📞📈 V79.8.2「混著用」組合回測的三個引擎開關守門(portfolio_backtest.mjs INDRS / CCWIN / PSRC=ext + GATE=ext)
 *   + 名單模式(LISTK)擋「一起用還沒驗過的開關」那道守門
 *
 * 為什麼:
 *   ① LISTK 的守門以前寫 SIGF / IND_CYC —— 那兩個環境變數根本不存在(實際是 SIGX、FILTER=indlo|indhi)→ 從來沒擋過
 *   ② 名單層的濾網要「被擋的⛔ 佔名額,下一檔遞補」(App 的名單是先濾再取前 2)—— 寫在候選層的話,
 *      名單上被擋那檔會佔掉一格、那天少買一檔 = 把「濾網」跟「少買」混在一起量
 *   ③ 外部候選(📈 符合進場)訊號日收盤後才知道 → 一定隔天收盤買,⛔ 用到訊號那天的收盤
 *
 * 釘住(自己造一個 60 檔的資料夾:repo data/ 的 K 線 + 造出來的產業對照表):
 *   ① 守門:設錯 / 一起用沒驗過的 → exit 1 並說原因
 *   ② CCWIN ⭐ 決定性對照:擋一個不在母體的代號 == 不設(成績 + 逐日淨值 + 名單 dump 逐位相同)
 *      擋名單上最常出現的那檔:名單 dump == 不設的 dump 在被擋那幾晚拿掉它(逐筆相同 = 被擋的不佔名額、其他檔照原順序遞補)、
 *      名單格數 == 每晚「剩下的不同檔數」取 2、實際成交沒有它在被擋那幾天、CCWIN_SHIFT 平移 / PRE / POST → 被擋的日子跟著變
 *   ③ INDRS:名單 dump == 不設的 dump 拿掉「前一晚不在前 N 名產業」的(測試自己從 K 線重算排名,⛔ 抄引擎)・bot 同理・
 *      對不到產業的放行・shamtop 安慰劑每晚只留一個產業而且不是每晚都跟 top 一樣・實際成交也都守規則
 *   ④ PSRC=ext:每一筆交易的進場日 = 訊號日的下一根、進場價 = 那根收盤、停損 = min(那根最低, 進場 × 0.95)・
 *      同一天兩檔都亮照排序分高的先買(一天 1 檔)・不是交易日的訊號沒有交易・清單換了不吃舊快取(進 CACHE_KEY)・cfg 記下
 * ⚠️ 真跑引擎(60 檔 × 十幾次),約 6~10 分鐘;要 repo 的 data/(沒有就先跑 scripts/fetch_testdata.sh)
 */
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAIL = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 500)}`); if (!c) FAIL.push(n); };
// PB_FILE = 注入驗證用(放在 scripts/ 底下的引擎副本;⛔ 平常不設)
const DATA = path.join(ROOT, 'data'), PB = process.env.PB_FILE ? path.resolve(process.env.PB_FILE) : path.join(ROOT, 'scripts', 'portfolio_backtest.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'listkguard-'));
const rdL = f => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (_) { return null; } };
const nd = s => String(s || '').replace(/\//g, '-').slice(0, 10);

// ── 造 60 檔的資料夾(代號開頭輪流挑,同引擎抽樣的精神;這裡只是挑檔,⛔ 不影響判讀)──
const files = fs.readdirSync(DATA).filter(f => /^\d{4}\.json$/.test(f)).map(f => f.slice(0, 4)).sort();
if (files.length < 200 || !fs.existsSync(path.join(DATA, '^TWII.json')) || !fs.existsSync(path.join(DATA, '0050.json'))) {
    console.error(`❌ repo 的 data/ 只找到 ${files.length} 檔(或沒有 ^TWII / 0050)→ 先跑 bash scripts/fetch_testdata.sh`); process.exit(1);
}
const byHead = {}; for (const s of files) (byHead[s[0]] ||= []).push(s);
const SY = []; { const hs = Object.keys(byHead).sort(); for (let i = 0; SY.length < 60; i++) { let add = false; for (const h of hs) { if (byHead[h][i] && SY.length < 60) { SY.push(byHead[h][i]); add = true; } } if (!add) break; } }
const IND = {}; SY.forEach((s, k) => { if (k < SY.length - 4) IND[s] = 'ABCD'[k % 4]; });   // 最後 4 檔⛔ 對不到產業(放行)
const mkDir = (nm, map) => {
    const d = path.join(tmp, nm); fs.mkdirSync(d);
    for (const s of SY) fs.symlinkSync(path.join(DATA, `${s}.json`), path.join(d, `${s}.json`));
    fs.symlinkSync(path.join(DATA, '^TWII.json'), path.join(d, '^TWII.json'));
    if (map) fs.writeFileSync(path.join(d, 'industry_map.json'), JSON.stringify(map));
    return d;
};
const D1 = mkDir('d', IND), D2 = mkDir('d2', { '9999': 'A' }), D3 = mkDir('d3', null);
const rows = Object.fromEntries(SY.map(s => [s, JSON.parse(fs.readFileSync(path.join(DATA, `${s}.json`), 'utf8'))]));
const days = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8')).map(r => ({ d: nd(r.date), c: +r.close })).filter(r => r.d && r.c > 0).map(r => r.d);
const dIdx = new Map(days.map((d, i) => [d, i]));

const BASE = { ...process.env, LOT: '150000', SELF: 'high+hivolat', RANK_MIN: '75', VOLAT_MIN: '60', EXIT: 'chand2', MAXD: '20', FILTER: 'bear60', STOPFILL: 'close',
               WARMUP: '240', GATE: 'lb', LISTK: '2', DATA_DIR: D1, BENCH0050: path.join(DATA, '0050.json'), TRADES_CACHE: path.join(tmp, 'c.json') };
for (const k of ['STATS_WIN', 'STATS_FROM', 'LB_Z', 'LB_TOP', 'MIN_N', 'CLIFF', 'RANKBY', 'WARMUPS', 'YEARRUNS', 'PARK', 'DIV', 'DIV_TRADES', 'EQUITY_OUT', 'LIST_DUMP', 'LIST_TRIG',
                 'LIST_LOOSE', 'LIST_DUMP_N', 'ALLFIRE', 'SIGX', 'INDRS', 'INDRS_N', 'INDRS_L', 'INDRS_MIN', 'CCWIN', 'CCWIN_PRE', 'CCWIN_POST', 'CCWIN_SHIFT', 'PSRC', 'ENTRY', 'TAKEN_OUT', 'AUX_DIR']) delete BASE[k];
const run = (tag, extra, env0 = BASE, argv = ['60', '2']) => {
    const r = spawnSync(process.execPath, ['--max-old-space-size=3000', PB, ...argv], { env: { ...env0, ...extra, SUMMARY_OUT: path.join(tmp, `s_${tag}.json`), EQUITY_OUT: path.join(tmp, `e_${tag}.json`) }, encoding: 'utf8', timeout: 600000, maxBuffer: 64 << 20 });
    let s = null, e = null; try { s = JSON.parse(fs.readFileSync(path.join(tmp, `s_${tag}.json`), 'utf8')); e = fs.readFileSync(path.join(tmp, `e_${tag}.json`), 'utf8'); } catch (_) {}
    return { r, s, e, out: (r.stdout || '') + (r.stderr || '') };
};
const core = s => s && JSON.stringify({ n: s.n, cum: s.cum, per: s.per, dd: s.dd, win: s.win, skipped: s.skipped, byYear: s.byYear, from: s.from, to: s.to });
const lkNoBlk = s => { if (!s || !s.listk) return null; const { blk, ...o } = s.listk; return JSON.stringify(o); };
const taken = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
// 名單 dump 一晚 = {d: 進場日, n: 前一晚, e: [[代號, 招, 下界], …]};「每晚剩下的不同檔數取 2」= 名單格數(沒設 LIST_TRIG 時)
const slotsOf = dump => dump.reduce((a, o) => a + Math.min(2, new Set(o.e.map(x => x[0])).size), 0);
const sameDump = (got, exp) => got && exp && got.length === exp.length && got.every((o, k) => JSON.stringify(o) === JSON.stringify(exp[k]));
const firstDiff = (got, exp) => { if (!got || !exp) return `got=${got && got.length} exp=${exp && exp.length}`; for (let k = 0; k < Math.max(got.length, exp.length); k++) if (JSON.stringify(got[k]) !== JSON.stringify(exp[k])) return `第 ${k} 晚 got=${JSON.stringify(got[k]).slice(0, 200)} exp=${JSON.stringify(exp[k]).slice(0, 200)}`; return `長度 ${got.length} vs ${exp.length}`; };

// ── 基準 ──
console.log(`── 基準(60 檔、LISTK=2)──`);
const dA = path.join(tmp, 'dA.ndjson'), tA = path.join(tmp, 'tA.json');
const A = run('a', { LIST_DUMP: dA, LIST_DUMP_N: '100000', TAKEN_OUT: tA });
const dumpA = rdL(dA) || [];
ok(`⓪ 基準跑得起來、名單 dump ${dumpA.length} 晚`, A.r.status === 0 && A.s && A.s.listk && dumpA.length > 50 && dumpA.some(o => o.e.length >= 3), `${A.r.status} ${A.out.slice(-400)}`);
ok(`⓪b 名單格數 == 每晚 dump 不同檔數取 2(${A.s && A.s.listk.slots} vs ${slotsOf(dumpA)})、晚數 == dump 行數(下面的對照靠這兩條成立)`, A.s && A.s.listk.slots === slotsOf(dumpA) && A.s.listk.days === dumpA.length, JSON.stringify(A.s && A.s.listk));

// ── ① 守門 ──
console.log('── ① 守門 ──');
const extF = path.join(tmp, 'ext_ok.json'); fs.writeFileSync(extF, JSON.stringify({ [SY[0]]: { [nd(rows[SY[0]][400].date)]: [1, 1] } }));
const extEmpty = path.join(tmp, 'ext_empty.json'); fs.writeFileSync(extEmpty, '{}');
const ccEmpty = path.join(tmp, 'cc_empty.json'); fs.writeFileSync(ccEmpty, '{}');
const ccLate = path.join(tmp, 'cc_late.json'); fs.writeFileSync(ccLate, JSON.stringify({ [SY[0]]: [days[days.length - 5]] }));
const ccNone = path.join(tmp, 'cc_none.json'); fs.writeFileSync(ccNone, JSON.stringify({ '0000': ['2000-01-03'] }));
const bad = (tag, env, re, env0 = BASE) => { const B = run(tag, env, env0); ok(`①${tag} ${JSON.stringify(env).replace(tmp, '…')} → exit 1 並說原因`, B.r.status === 1 && re.test(B.out), `${B.r.status} ${B.out.slice(-300)}`); };
bad('a', { SIGX: 'x' }, /LISTK 還沒驗過跟 SIGX/);
bad('b', { FILTER: 'bear60+indlo' }, /FILTER=ind\*/);
bad('c', { INDRS: 'xx' }, /INDRS=xx 不認得/);
bad('d', { INDRS: 'top', INDRS_N: '0' }, /INDRS_N=0/);
bad('e', { PSRC: 'foo' }, /PSRC=foo 不認得/);
bad('f', { PSRC: `ext:${extF}` }, /要配 GATE=ext/);
bad('g', { LISTK: '', GATE: 'ext' }, /GATE=ext 要配 PSRC/);
bad('h', { LISTK: '', GATE: 'ext', PSRC: `ext:${extF}`, ENTRY: 'nextopen' }, /ENTRY 不可另外設/);
bad('i', { LISTK: '', GATE: 'ext', PSRC: `ext:${extEmpty}` }, /一筆都沒有/);
bad('i2', { LISTK: '', GATE: 'ext', PSRC: `ext:${extF}`, RANKBY: 'amt' }, /RANKBY \/ EOD_DUMP/);
bad('j', { CCWIN: ccEmpty }, /一筆法說會都沒有/);
bad('k', { CCWIN: ccLate }, /才有/);
bad('l', { CCWIN: ccNone, CCWIN_PRE: 'x' }, /要是整數/);
bad('m', { INDRS: 'top' }, /industry_map/, { ...BASE, DATA_DIR: D3 });
bad('n', { INDRS: 'top' }, /一天都排不出來/, { ...BASE, DATA_DIR: D2 });
{
    const CODE = fs.readFileSync(PB, 'utf8');
    const ck = (CODE.match(/const CACHE_KEY = JSON\.stringify\(\{[^}]*\}\)/) || [''])[0];
    ok('①o CACHE_KEY:PSRC 進(候選換了 = 交易整份不一樣)、INDRS / CCWIN ⛔ 不進(只是名單層的濾網)', /\.\.\._ckPsrc/.test(ck) && !/INDRS|CCWIN/.test(ck), ck);
    ok('①p 守門清單⛔ 不可再出現不存在的 SIGF / IND_CYC', !/'SIGF'|'IND_CYC'/.test(CODE));
}

// ── ② CCWIN ──
console.log('── ② CCWIN 法說會前後先不買 ──');
{
    const C0 = run('c0', { CCWIN: ccNone, LIST_DUMP: path.join(tmp, 'dC0.ndjson'), LIST_DUMP_N: '100000' });
    ok('②a ⭐ 決定性對照:只擋一個不在母體的代號 == 不設(成績 + 逐日淨值 + 名單統計 + dump 逐位相同、擋掉 0 次)',
       C0.r.status === 0 && core(C0.s) === core(A.s) && C0.e === A.e && lkNoBlk(C0.s) === lkNoBlk(A.s) && C0.s.listk.blk === 0 && sameDump(rdL(path.join(tmp, 'dC0.ndjson')), dumpA),
       `${C0.r.status} ${core(C0.s)} vs ${core(A.s)} ${JSON.stringify(C0.s && C0.s.listk)}`);
    // 名單上最常出現(前 2 名)的那檔
    const top2 = {}; for (const o of dumpA) { const s2 = [...new Set(o.e.map(x => x[0]))].slice(0, 2); for (const s of s2) top2[s] = (top2[s] || 0) + 1; }
    const X = Object.entries(top2).sort((a, b) => b[1] - a[1])[0][0];
    const nightsX = dumpA.filter(o => o.e.some(x => x[0] === X)).map(o => o.d);
    const conf = nightsX.filter((_, k) => k % 2 === 0);
    const ccF = path.join(tmp, 'cc1.json'); fs.writeFileSync(ccF, JSON.stringify({ '0000': ['2000-01-03'], [X]: conf }));
    const expDump = blockedIdx => dumpA.map(o => blockedIdx.has(dIdx.get(o.d)) ? { ...o, e: o.e.filter(x => x[0] !== X) } : o);
    const idxSet = (ds, pre, post, sh) => { const S = new Set(); for (const d of ds) { const c = dIdx.get(d) + sh; for (let k = c - pre; k <= c + post; k++) S.add(k); } return S; };
    const tC1 = path.join(tmp, 'tC1.json'), dC1 = path.join(tmp, 'dC1.ndjson');
    const C1 = run('c1', { CCWIN: ccF, CCWIN_PRE: '0', CCWIN_POST: '0', LIST_DUMP: dC1, LIST_DUMP_N: '100000', TAKEN_OUT: tC1 });
    const e1 = expDump(idxSet(conf, 0, 0, 0)), g1 = rdL(dC1);
    ok(`②b 擋 ${X}(名單前 2 名出現 ${top2[X]} 晚)在 ${conf.length} 個法說會日:dump == 不設的 dump 在那幾晚拿掉它(逐筆相同 = 其他檔照原順序遞補)`, C1.r.status === 0 && sameDump(g1, e1), `${C1.r.status} ${firstDiff(g1, e1)} ${C1.out.slice(-200)}`);
    ok(`②c 被擋的⛔ 佔名額:名單格數 == 每晚剩下的不同檔數取 2(${C1.s && C1.s.listk.slots} vs ${slotsOf(e1)})、擋掉次數 > 0、cfg 記下`,
       C1.s && C1.s.listk.slots === slotsOf(e1) && C1.s.listk.blk > 0 && C1.s.cfg.ccwin === 'cc1.json' && C1.s.cfg.ccPre === 0 && C1.s.cfg.ccPost === 0, JSON.stringify(C1.s && { lk: C1.s.listk, cfg: C1.s.cfg }));
    const T1 = taken(tC1) || [];
    const confI = idxSet(conf, 0, 0, 0);
    const hadX = (taken(tA) || []).filter(t => t.sym === X && confI.has(dIdx.get(t.d))).length;
    ok(`②d 實際成交(${T1.length} 筆)沒有 ${X} 在被擋那幾天;不設時那幾天買過它 ${hadX} 次 → 成績一定不一樣`, T1.length > 0 && !T1.some(t => t.sym === X && confI.has(dIdx.get(t.d))) && (!hadX || core(C1.s) !== core(A.s)), `${T1.length} hadX=${hadX}`);
    const C2 = run('c2', { CCWIN: ccF, CCWIN_PRE: '0', CCWIN_POST: '0', CCWIN_SHIFT: '1', LIST_DUMP: path.join(tmp, 'dC2.ndjson'), LIST_DUMP_N: '100000' });
    const e2 = expDump(idxSet(conf, 0, 0, 1)), g2 = rdL(path.join(tmp, 'dC2.ndjson'));
    ok('②e CCWIN_SHIFT=1(安慰劑:日期全部往後平移 1 個交易日)→ 被擋的晚上跟著平移(逐筆相同)、log 標安慰劑', C2.r.status === 0 && sameDump(g2, e2) && /安慰劑/.test(C2.out) && !sameDump(g2, e1), `${firstDiff(g2, e2)}`);
    const one = [nightsX[Math.floor(nightsX.length / 2)]];
    const ccF3 = path.join(tmp, 'cc3.json'); fs.writeFileSync(ccF3, JSON.stringify({ '0000': ['2000-01-03'], [X]: one }));
    const C3 = run('c3', { CCWIN: ccF3, CCWIN_PRE: '2', CCWIN_POST: '1', LIST_DUMP: path.join(tmp, 'dC3.ndjson'), LIST_DUMP_N: '100000' });
    const e3 = expDump(idxSet(one, 2, 1, 0)), g3 = rdL(path.join(tmp, 'dC3.ndjson'));
    ok(`②f 一場法說會、前 2 天到後 1 天 → 擋 4 個交易日(${one[0]} 前後;逐筆相同)`, C3.r.status === 0 && sameDump(g3, e3), `${firstDiff(g3, e3)}`);
    // ②g 多起點(WARMUPS):起點守門要看「最早的那個起點」,⛔ 把預設的 WARMUP=240 混進來(V79.8.2 第一版就這樣把 4 年窗口整批擋掉)
    {
        const ccM = path.join(tmp, 'cc_mid.json'); fs.writeFileSync(ccM, JSON.stringify({ [X]: [days[270]] }));
        const runW = (tag, ws) => spawnSync(process.execPath, ['--max-old-space-size=3000', PB, '60', '2'], { env: { ...BASE, CCWIN: ccM, WARMUPS: ws, SUMMARY_OUT: path.join(tmp, `sw_${tag}_{W}.json`), EQUITY_OUT: path.join(tmp, `ew_${tag}_{W}.json`) }, encoding: 'utf8', timeout: 600000, maxBuffer: 64 << 20 });
        const W1 = runW('a', '300,330'), W2 = runW('b', '250,330');
        ok(`②g WARMUPS=300,330、法說會清單 ${days[270]} 起 → 照跑(⛔ 拿預設 240 去比);WARMUPS=250,330 → exit 1`, W1.status === 0 && W2.status === 1 && /才有/.test((W2.stderr || '') + (W2.stdout || '')), `${W1.status} ${(W1.stderr || '').slice(-200)} / ${W2.status}`);
    }
}

// ── ③ INDRS ──
console.log('── ③ INDRS 只買強勢產業 ──');
{
    // 測試自己重算:每天每個產業「近 20 根漲跌」中位數(每個產業 ≥ 5 檔才排)・由高到低、同分照代碼 ・湊不到 2N 個產業那天不判
    const N = 1, L = 20, MIN = 5;
    const per = new Map();
    for (const s of SY) {
        const g = IND[s]; if (!g) continue;
        const dd = rows[s].map(r => [nd(r.date), +r.close]).filter(r => r[0] && r[1] > 0);
        for (let k = L; k < dd.length; k++) {
            const di = dIdx.get(dd[k][0]); if (di === undefined) continue;
            const r = dd[k][1] / dd[k - L][1] - 1; if (!Number.isFinite(r) || Math.abs(r) > 3) continue;
            let m = per.get(di); if (!m) per.set(di, (m = new Map())); let a2 = m.get(g); if (!a2) m.set(g, (a2 = [])); a2.push(r);
        }
    }
    const med = a2 => { const s2 = [...a2].sort((x, y) => x - y); const h = s2.length >> 1; return s2.length % 2 ? s2[h] : (s2[h - 1] + s2[h]) / 2; };
    const rank = new Map();
    for (const [di, m] of per) {
        const arr = [...m].filter(([, a2]) => a2.length >= MIN).map(([g, a2]) => [g, med(a2)]).sort((x, y) => (y[1] - x[1]) || (x[0] < y[0] ? -1 : 1));
        if (arr.length >= N * 2) rank.set(di, { top: new Set(arr.slice(0, N).map(x => x[0])), bot: new Set(arr.slice(-N).map(x => x[0])), all: new Set(arr.map(x => x[0])) });
    }
    const keep = (mode) => (sym, i) => { const g = IND[sym]; if (!g) return true; const r = rank.get(i - 1); if (!r) return true; return mode === 'bot' ? !r.bot.has(g) : r.top.has(g); };
    const expD = f => dumpA.map(o => { const i = dIdx.get(o.d); return { ...o, e: o.e.filter(x => f(x[0], i)) }; });
    const envI = { INDRS_N: String(N), INDRS_L: String(L), INDRS_MIN: String(MIN) };
    const tT = path.join(tmp, 'tT.json');
    const T = run('it', { ...envI, INDRS: 'top', LIST_DUMP: path.join(tmp, 'dT.ndjson'), LIST_DUMP_N: '100000', TAKEN_OUT: tT });
    const eT = expD(keep('top')), gT = rdL(path.join(tmp, 'dT.ndjson'));
    const nRank = [...new Set(dumpA.map(o => dIdx.get(o.d) - 1))].filter(i => rank.has(i)).length;
    ok(`③a top:dump == 不設的 dump 拿掉「前一晚不在第 1 名產業」的(測試自己重算排名;${nRank}/${dumpA.length} 晚排得出來)`, T.r.status === 0 && sameDump(gT, eT) && nRank > dumpA.length / 2, `${T.r.status} ${firstDiff(gT, eT)} ${T.out.slice(-300)}`);
    ok(`③b 被擋的⛔ 佔名額(格數 ${T.s && T.s.listk.slots} == ${slotsOf(eT)})、擋掉 > 0、cfg 記下、log 寫幾檔對得到`,
       T.s && T.s.listk.slots === slotsOf(eT) && T.s.listk.blk > 0 && T.s.cfg.indrs === 'top' && T.s.cfg.indrsN === N && /56 檔對得到/.test(T.out), JSON.stringify(T.s && T.s.listk));
    const unm = SY.filter(s => !IND[s]);
    ok(`③c 對不到產業的 ${unm.length} 檔放行(不設時在名單上的,top 那次也都在)`, dumpA.some(o => o.e.some(x => unm.includes(x[0]))) ? gT && gT.every((o, k) => dumpA[k].e.filter(x => unm.includes(x[0])).length === o.e.filter(x => unm.includes(x[0])).length) : true);
    const TT = taken(tT) || [];
    ok(`③d 實際成交(${TT.length} 筆)每一筆都守規則(對得到產業的 = 前一晚第 1 名的產業)`, TT.length > 0 && TT.every(t => keep('top')(t.sym, dIdx.get(t.d))), `${TT.length}`);
    const Bt = run('ib', { ...envI, INDRS: 'bot', LIST_DUMP: path.join(tmp, 'dB.ndjson'), LIST_DUMP_N: '100000' });
    const eB = expD(keep('bot')), gB = rdL(path.join(tmp, 'dB.ndjson'));
    ok('③e bot:dump == 拿掉「前一晚最後 1 名產業」的', Bt.r.status === 0 && sameDump(gB, eB), `${firstDiff(gB, eB)}`);
    const H = run('ih', { ...envI, INDRS: 'shamtop', LIST_DUMP: path.join(tmp, 'dH.ndjson'), LIST_DUMP_N: '100000' });
    const gH = rdL(path.join(tmp, 'dH.ndjson')) || [];
    let oneInd = true, diffNights = 0;
    gH.forEach((o, k) => {
        const i = dIdx.get(o.d), r = rank.get(i - 1);
        const gs = new Set(o.e.map(x => IND[x[0]]).filter(Boolean));
        if (r && gs.size > 1) oneInd = false;
        if (JSON.stringify(o) !== JSON.stringify(gT[k] || null)) diffNights++;
        if (!o.e.every(x => dumpA[k].e.some(y => y[0] === x[0] && y[1] === x[1]))) oneInd = false;   // 只會拿掉、⛔ 不會多出來
    });
    ok(`③f shamtop 安慰劑:每晚只留一個產業(同 N)、只會拿掉不會多、跟 top 有 ${diffNights} 晚不一樣(⛔ 不是同一批)`, H.r.status === 0 && gH.length === dumpA.length && oneInd && diffNights > 10 && /安慰劑/.test(H.out), `${H.r.status} ${diffNights}`);
}

// ── ④ PSRC=ext ──
console.log('── ④ PSRC=ext 外部候選(隔天收盤買)──');
{
    // 挑兩檔、三個訊號日(間隔 ≥ 80 根 → 前一筆一定出場了),同一天兩檔都亮時排序分不同
    const pick = SY.filter(s => rows[s].length >= 700).slice(0, 2);
    const [P, Q] = pick;
    const dQ = new Set(rows[Q].map(r => nd(r.date)));
    const both = rows[P].map(r => nd(r.date)).filter(d => dQ.has(d) && dIdx.get(d) > 300);
    const S1 = both[120], S2 = both[220], S3 = both[320];
    const sat = (() => { for (const d of both.slice(340)) { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + 1); const y = x.toISOString().slice(0, 10); if (!dIdx.has(y) && x.getUTCDay() === 6) return y; } return null; })();
    const ext1 = { [P]: { [S1]: [5, 1], [S2]: [1, 1], [S3]: [3, 1], ...(sat ? { [sat]: [9, 9] } : {}) }, [Q]: { [S1]: [1, 9], [S2]: [5, 1] } };
    const xf1 = path.join(tmp, 'ext1.json'); fs.writeFileSync(xf1, JSON.stringify(ext1));
    // ALLFIRE(每天亮都是候選)要配 SELF 含 high + hivolat → 門檻設 0 = 只要這根算得出位階 / 波動就放行(外部清單自己已經篩過 🧬)
    const EX = { ...BASE, LISTK: '', GATE: 'ext', SELF: 'high+hivolat', FILTER: '', ALLFIRE: '1', RANK_MIN: '0', VOLAT_MIN: '0', TRADES_CACHE: path.join(tmp, 'cx.json') };
    const tX = path.join(tmp, 'tX.json');
    const X1 = run('x1', { PSRC: `ext:${xf1}`, TAKEN_OUT: tX }, EX, ['9999', '1']);
    let CT = null; try { CT = JSON.parse(fs.readFileSync(path.join(tmp, 'cx.json'), 'utf8')).trades; } catch (_) {}
    const nextOf = (s, d) => { const R = rows[s]; const j = R.findIndex(r => nd(r.date) === d); return j >= 0 && j + 1 < R.length ? j + 1 : -1; };
    ok(`④a 跑得起來、快取 5 筆(${P} 3 筆 + ${Q} 2 筆;週六 ${sat || '—'} 那筆⛔ 不是交易日 → 沒有)、cfg 記下`, X1.r.status === 0 && CT && CT.length === 5 && X1.s.cfg.psrc === 'ext1.json' && X1.s.cfg.gate === 'ext' && /外部候選 2 檔/.test(X1.out), `${X1.r.status} ${CT && CT.length} ${X1.out.slice(-300)}`);
    let fill = !!CT;
    for (const t of CT || []) {
        const j = rows[t.sym].findIndex(r => nd(r.date) === nd(t.inD));
        const R = rows[t.sym];
        const sig = j >= 1 ? nd(R[j - 1].date) : null;
        const expStop = Math.min(R[j].low, R[j].close * 0.95);
        if (!(j >= 1 && ext1[t.sym][sig] && Math.abs(t.entry - R[j].close) < 1e-9 && Math.abs(t.stop - expStop) < 1e-9 && t.xs === ext1[t.sym][sig][0] && t.xa === ext1[t.sym][sig][1])) fill = false;
    }
    ok('④b 每一筆:進場日 = 訊號日的下一根(⛔ 訊號那天)、進場價 = 那根收盤、停損 = min(那根最低, 進場 × 0.95)、排序分 / 成交額帶進來', fill, JSON.stringify((CT || []).slice(0, 3)));
    const TX = taken(tX) || [];
    const want = [[P, S1], [Q, S2], [P, S3]].map(([s, d]) => `${s}@${nd(rows[s][nextOf(s, d)].date)}`).join(',');
    const got = TX.map(t => `${t.sym}@${t.d}`).join(',');
    ok(`④c 一天 1 檔:同一天兩檔都亮照排序分高的先買(${want})`, got === want, `got ${got}`);
    const ext2 = { [Q]: { [S3]: [1, 1] } };
    const xf2 = path.join(tmp, 'ext2.json'); fs.writeFileSync(xf2, JSON.stringify(ext2));
    const tX2 = path.join(tmp, 'tX2.json');
    const X2 = run('x2', { PSRC: `ext:${xf2}`, TAKEN_OUT: tX2 }, EX, ['9999', '1']);
    let CT2 = null; try { CT2 = JSON.parse(fs.readFileSync(path.join(tmp, 'cx.json'), 'utf8')).trades; } catch (_) {}
    const TX2 = taken(tX2) || [];
    ok('④d 清單換了(同一個快取檔)→ ⛔ 不吃舊快取:只剩新清單那 1 筆', X2.r.status === 0 && CT2 && CT2.length === 1 && TX2.length === 1 && TX2[0].sym === Q, `${X2.r.status} ${CT2 && CT2.length} ${JSON.stringify(TX2)}`);
    const X3 = run('x3', { PSRC: `ext:${xf2}` }, EX, ['9999', '1']);
    ok('④e 同一份清單再跑一次 → 吃快取、成績逐位相同', X3.r.status === 0 && core(X3.s) === core(X2.s) && X3.e === X2.e, `${core(X3.s)} vs ${core(X2.s)}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(FAIL.length ? `\n❌ ${FAIL.length} 條失敗:${FAIL.join(' / ')}` : '\n✅ LISTK_GUARD_TEST_PASS');
process.exit(FAIL.length ? 1 : 0);
