#!/usr/bin/env node
/**
 * 🎯 V79.4.8 回測重現 App 名單「明天漲 6% 內觸發不了就不列」守門(list_trig.mjs + 引擎 LIST_DUMP / LIST_TRIG)
 *
 * 為什麼:App(決策台「今天可以買的」/ auto_trade.py)是前一晚排好名單、只看前 2 名、隔天觸發才買;
 *   名單會先拿掉「明天漲 6% 內都觸發不了」的招(playbook_scan trigOf)。引擎 LISTK 做不到這件事
 *   → 引擎版名單前 2 名 97% 的日子都沒觸發,App 真實名單(8/14~9/11)37% 的日子至少一檔觸發 → 引擎嚴重低估 App 的買法。
 *
 * 釘住:
 *   ① 跟真的 playbook_scan 同一份資料逐筆比(走正式入口):最後一晚每一檔前 2 招,list_trig 判「列 / 不列」== App 名單有沒有它;
 *      「那一晚已觸發」== App 的 firedToday;list_trig 說不靠價位的 ⊆ App 的 loose
 *      ⭐ 決定性對照:NEAR 改 1% → 一定對不上(⛔ 比對沒有鑑別力就是假綠燈)
 *   ② 引擎:LIST_DUMP 開著成績逐位相同(只多寫一個檔)・LIST_TRIG「全部可觸發」== 不設(決定性對照)・「全部不可觸發」→ 0 筆・
 *      真的 list_trig 產物 → 名單上觸發的天數比不濾多・產物缺一半 → 記下「沒判過 / 可能不準」・設錯 exit 1
 *      ⚡ 名單快取:WARMUPS(起點沒照順序)一次跑 == 一個一個跑
 *   ③ list_trig 分片:兩片的聯集 == 一次跑完(逐行相同,排序後)
 *   ④ ALLFIRE(每天觸發都當候選):進 CACHE_KEY ・⭐ 決定性對照:seq=1 那幾筆 == 原本一筆接一筆的快取(逐筆相同)・多出持有中又觸發的 ・跟 REENTRY 一起 exit 1
 * ⚠️ 真跑(playbook_scan 30 檔 + 引擎 60 檔 × 幾次),約 6~10 分鐘;要 repo 的 data/(沒有就先跑 scripts/fetch_testdata.sh)
 */
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAIL = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 400)}`); if (!c) FAIL.push(n); };
const DATA = path.join(ROOT, 'data');
const LT = path.join(ROOT, 'scripts', 'list_trig.mjs'), PB = path.join(ROOT, 'scripts', 'portfolio_backtest.mjs');
const rdL = f => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (_) { return null; } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'listtrig-'));

const WANT = ['5314', '3026', '4537', '4573', '7856', '2426', '3443', '4939', '4958', '8996', '4931', '3189', '2330', '2317', '2454',
              '3231', '6415', '2603', '1101', '2881', '3008', '2382', '6669', '3711', '2308', '1216', '2412', '2891', '5871', '3034'];
const have = WANT.filter(s => fs.existsSync(path.join(DATA, `${s}.json`)));
if (have.length < 25 || !fs.existsSync(path.join(DATA, '^TWII.json'))) { console.error(`❌ repo 的 data/ 只找到 ${have.length}/30 檔(或沒有 ^TWII)→ 先跑 bash scripts/fetch_testdata.sh`); process.exit(1); }

// ── ① 跟真的 playbook_scan 比 ──
console.log(`── ① 跟真的 playbook_scan 同一份資料比(${have.length} 檔)──`);
{
    const R = path.join(tmp, 'pb'); fs.mkdirSync(path.join(R, 'scripts'), { recursive: true }); fs.mkdirSync(path.join(R, 'data'));
    let src = fs.readFileSync(path.join(ROOT, 'scripts', 'playbook_scan.mjs'), 'utf8');
    // 注入:把「每一檔前 2 招(含今天已觸發、明天觸發不了的)」也帶出來 —— 只多帶資料,⛔ 不動判法
    const A1 = 'const out = [], fired = [];', A2 = "return { c: Math.round(c0 * 100) / 100, v: Math.round(rows[last].volume / 1000), d: rows[last].date, rank: selfRank, vol: selfVol, bear: selfBear, out, fired };";
    const okInj = src.split(A1).length === 2 && src.split(A2).length === 2;
    ok('①0 playbook_scan 裡找得到要注入的兩行(改版就要更新這支測試)', okInj);
    src = src.replace(A1, A1 + ' const good2 = good.slice(0, 2).map(g => [g.key, g.firedToday ? 1 : 0]);').replace(A2, A2.replace('out, fired };', 'out, fired, good2 };'));
    const A3 = 'if (r.none) { noEdge++; continue; }';
    ok('①0b playbook_scan 裡找得到「沒有招」那一行', src.split(A3).length === 2);
    src = src.replace(A3, `(globalThis.__g2 ||= []).push(...((r.good2 || []).map(([k, z]) => [sym, k, z, r.d]))); ${A3}`);
    src = src.replace("fs.writeFileSync(path.join(DATA, 'playbook_edge.json'), JSON.stringify(out), 'utf-8');", "out.__good2 = globalThis.__g2 || []; fs.writeFileSync(path.join(DATA, 'playbook_edge.json'), JSON.stringify(out), 'utf-8');");
    fs.writeFileSync(path.join(R, 'scripts', 'playbook_scan.mjs'), src);
    fs.copyFileSync(path.join(ROOT, 'index.html'), path.join(R, 'index.html'));
    for (const s of have) fs.copyFileSync(path.join(DATA, `${s}.json`), path.join(R, 'data', `${s}.json`));
    fs.copyFileSync(path.join(DATA, '^TWII.json'), path.join(R, 'data', '^TWII.json'));
    const P = spawnSync(process.execPath, ['scripts/playbook_scan.mjs', String(have.length)], { cwd: R, encoding: 'utf8', timeout: 400000 });
    let J = null; try { J = JSON.parse(fs.readFileSync(path.join(R, 'data', 'playbook_edge.json'), 'utf8')); } catch (_) {}
    ok('①1 playbook_scan 跑完、帶出每檔前 2 招', P.status === 0 && J && Array.isArray(J.__good2) && J.__good2.length >= 10, `${P.status} ${(P.stderr || P.stdout || '').slice(-300)} good2=${J && J.__good2 && J.__good2.length}`);
    if (J && J.__good2) {
        const listed = new Map((J.picks || []).map(x => [`${x.s}|${x.k}`, x]));
        const firedT = new Set((J.fired || []).map(x => `${x.s}|${x.k}`));
        const cand = J.__good2;
        // dump = 那一晚全部候選(⛔ 只拿 App 會判的那些:每檔前 2 招)
        const dumpF = path.join(tmp, 'pbdump.ndjson');
        const byN = new Map(); for (const [s, k, , d] of cand) (byN.get(d) || byN.set(d, []).get(d)).push([s, k, 0]);   // 每一檔用它自己最後一天當「那一晚」
        fs.writeFileSync(dumpF, [...byN].map(([n, e]) => JSON.stringify({ d: '9999-12-31', n, e })).join('\n') + '\n');
        const runLT = (out, env) => spawnSync(process.execPath, [LT, dumpF, out], { env: { ...process.env, DATA_DIR: path.join(R, 'data'), HTML_DIR: R, TOPN: '9999', ...env }, encoding: 'utf8', timeout: 400000 });
        const L1 = runLT(path.join(tmp, 'lt1.ndjson'), {});
        const res = rdL(path.join(tmp, 'lt1.ndjson')) || [];
        ok('①2 list_trig 跑完、每一筆都有判到', L1.status === 0 && res.length === cand.length, `${L1.status} ${res.length}/${cand.length} ${(L1.stderr || '').slice(-300)}`);
        const m = new Map(res.map(o => [`${o.s}|${o.k}`, o]));
        let agree = 0, dis = [], zOk = 0, zBad = [], looseBad = [];
        for (const [s, k, z] of cand) {
            const o = m.get(`${s}|${k}`); if (!o) continue;
            const key = `${s}|${k}`;
            if ((o.z === 1) === (z === 1 || firedT.has(key))) zOk++; else zBad.push(`${key} z=${o.z} app=${z}`);
            if (z === 1) continue;   // App:今天已觸發 → 不列(⛔ 不判觸發)
            const lt = o.t > 0, app = listed.has(key);
            if (lt === app) agree++; else dis.push(`${key} lt=${o.t} app=${app ? (listed.get(key).trig ?? 'loose') : '—'}`);
            if (o.t === 2 && app && !listed.get(key).loose) looseBad.push(key);
        }
        const nz = cand.filter(x => x[2] !== 1).length;
        ok(`①3 列 / 不列跟 App 名單逐筆一樣(${agree}/${nz};App 名單 ${listed.size} 筆)`, nz >= 10 && agree === nz && listed.size >= 3, dis.slice(0, 6).join(' / '));
        ok(`①4 「那一晚已觸發」跟 App 一樣(${zOk}/${cand.length})`, zOk === cand.length, zBad.slice(0, 5).join(' / '));
        ok('①5 list_trig 說「不靠價位」的,App 也是 loose', looseBad.length === 0, looseBad.join(' '));
        // ⭐ 決定性對照:NEAR 改 1% → 一定對不上(⛔ 比對沒有鑑別力 = 假綠燈)
        const L2 = runLT(path.join(tmp, 'lt2.ndjson'), { NEAR: '1' });
        const r2 = new Map((rdL(path.join(tmp, 'lt2.ndjson')) || []).map(o => [`${o.s}|${o.k}`, o]));
        const dis2 = cand.filter(([s, k, z]) => z !== 1 && r2.get(`${s}|${k}`) && ((r2.get(`${s}|${k}`).t > 0) !== listed.has(`${s}|${k}`))).length;
        ok(`①6 決定性對照:NEAR=1% → 跟 App 對不上 ${dis2} 筆(要 > 0)`, L2.status === 0 && dis2 > 0, `${L2.status}`);
        // ③ 分片聯集 == 一次跑完
        const S0 = runLT(path.join(tmp, 'lts0.ndjson'), { SHARD: '0/2' }), S1 = runLT(path.join(tmp, 'lts1.ndjson'), { SHARD: '1/2' });
        const norm = a => (a || []).map(o => JSON.stringify(o)).sort().join('\n');
        const u = norm([...(rdL(path.join(tmp, 'lts0.ndjson')) || []), ...(rdL(path.join(tmp, 'lts1.ndjson')) || [])]);
        ok('③ 兩片的聯集 == 一次跑完(排序後逐行相同)', S0.status === 0 && S1.status === 0 && u === norm(res) && u.length > 0);
        const bad = runLT(path.join(tmp, 'ltbad.ndjson'), { SHARD: '2/2' });
        ok('③b SHARD 設錯 → exit 1', bad.status === 1);
    }
}

// ── ② 引擎 ──
console.log('── ② 引擎 LIST_DUMP / LIST_TRIG ──');
{
    const base = { ...process.env, LOT: '150000', SELF: 'high+hivolat', RANK_MIN: '75', VOLAT_MIN: '60', EXIT: 'chand2', MAXD: '20', FILTER: 'bear60', STOPFILL: 'close', WARMUP: '240', GATE: 'lb', LISTK: '2', DATA_DIR: DATA, TRADES_CACHE: path.join(tmp, 'c.json') };
    for (const k of ['STATS_WIN', 'STATS_FROM', 'LB_Z', 'LB_TOP', 'MIN_N', 'CLIFF', 'RANKBY', 'WARMUPS', 'YEARRUNS', 'PARK', 'DIV', 'DIV_TRADES', 'EQUITY_OUT', 'BENCH0050', 'LIST_DUMP', 'LIST_TRIG', 'LIST_LOOSE', 'LIST_DUMP_N']) delete base[k];
    const run = (tag, extra) => {
        const r = spawnSync(process.execPath, ['--max-old-space-size=3000', PB, '60', '2'], { env: { ...base, ...extra, SUMMARY_OUT: path.join(tmp, `s_${tag}.json`), EQUITY_OUT: path.join(tmp, `e_${tag}.json`) }, encoding: 'utf8', timeout: 600000, maxBuffer: 64 << 20 });
        let s = null, e = null; try { s = JSON.parse(fs.readFileSync(path.join(tmp, `s_${tag}.json`), 'utf8')); e = fs.readFileSync(path.join(tmp, `e_${tag}.json`), 'utf8'); } catch (_) {}
        return { r, s, e };
    };
    const core = s => s && JSON.stringify({ n: s.n, cum: s.cum, per: s.per, dd: s.dd, win: s.win, skipped: s.skipped, byYear: s.byYear, from: s.from, to: s.to });
    const A = run('a', {});
    ok('②0 基準(LISTK=2)跑得起來', A.r.status === 0 && A.s && A.s.listk, `${A.r.status} ${(A.r.stderr || A.r.stdout || '').slice(-300)}`);
    const dumpF = path.join(tmp, 'dump.ndjson');
    const D = run('d', { LIST_DUMP: dumpF, LIST_DUMP_N: '100000' });
    const dump = rdL(dumpF) || [];
    ok(`②1 LIST_DUMP 開著成績 + 逐日淨值逐位相同(只多寫一個檔;${dump.length} 晚)`, D.s && core(D.s) === core(A.s) && D.e === A.e && JSON.stringify(D.s.listk) === JSON.stringify(A.s.listk) && dump.length > 50, `${core(D.s)} vs ${core(A.s)}`);
    ok('②1b dump 每一晚都照下界由大到小排、每一筆有代號 / 招 / 下界', dump.length > 0 && dump.every(o => o.n && o.n < o.d && Array.isArray(o.e) && o.e.every((x, i) => typeof x[0] === 'string' && typeof x[1] === 'string' && Number.isFinite(x[2]) && (i === 0 || o.e[i - 1][2] >= x[2]))));
    const wr = (f, fn) => { const L = []; for (const o of dump) for (const [s, k] of o.e) L.push(JSON.stringify({ n: o.n, s, k, ...fn(s, k, o) })); fs.writeFileSync(f, L.join('\n') + '\n'); };
    const allF = path.join(tmp, 'all.ndjson'), noneF = path.join(tmp, 'none.ndjson');
    wr(allF, () => ({ t: 1, f: -1, z: 0 })); wr(noneF, () => ({ t: 0, f: -1, z: 0 }));
    const ALL = run('all', { LIST_TRIG: allF });
    ok('②2 決定性對照:LIST_TRIG「全部可觸發」== 不設(成績 + 逐日淨值逐位相同)', ALL.s && core(ALL.s) === core(A.s) && ALL.e === A.e && ALL.s.listk.trig === 1 && ALL.s.listk.unk === 0 && ALL.s.listk.inexact === 0, `${core(ALL.s)} vs ${core(A.s)} ${JSON.stringify(ALL.s && ALL.s.listk)}`);
    const NONE = run('none', { LIST_TRIG: noneF });
    ok('②3 「全部不可觸發」→ 一筆都沒進場(引擎的空過守門 exit 1 並說原因)', NONE.r.status === 1 && /一筆都沒進場/.test(NONE.r.stdout || ''), `${NONE.r.status} ${(NONE.r.stdout || '').slice(-200)}`);
    // 真的 list_trig 產物(這 60 檔)
    const ltF = path.join(tmp, 'lt.ndjson');
    const LTR = spawnSync(process.execPath, [LT, dumpF, ltF], { env: { ...process.env, DATA_DIR: DATA, HTML_DIR: ROOT, TOPN: '30' }, encoding: 'utf8', timeout: 900000 });
    ok('②4 list_trig 對引擎的 dump 跑得完', LTR.status === 0 && (rdL(ltF) || []).length > 0, `${LTR.status} ${(LTR.stderr || LTR.stdout || '').slice(-300)}`);
    const T = run('t', { LIST_TRIG: ltF });
    const rate = s => s && s.listk ? s.listk.hit / Math.max(1, s.listk.slots) : 0;
    ok(`②5 名單只留明天會觸發的 → 每一格觸發的比例變高(${(rate(A.s) * 100).toFixed(1)}% → ${(rate(T.s) * 100).toFixed(1)}%)、cfg 記下`, T.s && rate(T.s) > rate(A.s) && T.s.cfg.listTrig === 'lt.ndjson' && T.s.cfg.listLoose === 1, JSON.stringify(T.s && T.s.listk));
    const T0 = run('t0', { LIST_TRIG: ltF, LIST_LOOSE: '0' });
    ok('②6 LIST_LOOSE=0(自動下單的買法:不靠價位的不買)→ 名單格數 ≤ 含不靠價位的那次', T0.s && T0.s.cfg.listLoose === 0 && T0.s.listk.slots <= T.s.listk.slots, JSON.stringify(T0.s && T0.s.listk));
    // 產物缺一半 → 記下沒判過 / 可能不準
    const half = (rdL(ltF) || []).filter((_, i) => i % 2 === 0);
    const halfF = path.join(tmp, 'half.ndjson'); fs.writeFileSync(halfF, half.map(o => JSON.stringify(o)).join('\n') + '\n');
    const H = run('h', { LIST_TRIG: halfF });
    ok('②7 產物缺一半 → summary 記下「沒判過」與「可能不準」(⛔ 不可靜默當成不能觸發)', H.s && H.s.listk.unk > 0 && H.s.listk.inexact > 0, JSON.stringify(H.s && H.s.listk));
    // ⚡ 名單快取:WARMUPS 一次跑(起點沒照順序)== 一個一個跑(含名單統計;名單第一次算完後面的起點重複用)
    {
        const WS = [330, 240, 285];
        const M = spawnSync(process.execPath, ['--max-old-space-size=3000', PB, '60', '2'], { env: { ...base, LIST_TRIG: ltF, WARMUPS: WS.join(','), SUMMARY_OUT: path.join(tmp, 'ms_{W}.json'), EQUITY_OUT: path.join(tmp, 'me_{W}.json') }, encoding: 'utf8', timeout: 600000, maxBuffer: 64 << 20 });
        let same = M.status === 0;
        for (const w of WS) {
            const one = run(`ow${w}`, { LIST_TRIG: ltF, WARMUP: String(w) });
            let ms = null, me = null; try { ms = JSON.parse(fs.readFileSync(path.join(tmp, `ms_${w}.json`), 'utf8')); me = fs.readFileSync(path.join(tmp, `me_${w}.json`), 'utf8'); } catch (_) {}
            if (!(ms && one.s && core(ms) === core(one.s) && me === one.e && JSON.stringify(ms.listk) === JSON.stringify(one.s.listk))) same = false;
        }
        ok('②10 名單快取:LIST_TRIG + WARMUPS(起點沒照順序)一次跑 == 一個一個跑(成績 + 逐日淨值 + 名單統計)', same, `${M.status} ${(M.stderr || '').slice(-200)}`);
    }
    // 設錯 → exit 1
    const bad = (tag, env, re) => { const B = run(tag, env); ok(`②8 ${JSON.stringify(env)} → exit 1 並說原因`, B.r.status === 1 && re.test((B.r.stderr || '') + (B.r.stdout || '')), (B.r.stderr || '').slice(-200)); };
    bad('b1', { LISTK: '', LIST_TRIG: allF }, /LIST_DUMP \/ LIST_TRIG 要配 LISTK/);
    {   // WARMUPS 要用帶 {W} 的檔名(否則先被「檔名要有 {W}」那道擋下來,驗不到這一道)
        const B2 = spawnSync(process.execPath, ['--max-old-space-size=3000', PB, '60', '2'], { env: { ...base, LIST_DUMP: path.join(tmp, 'x.ndjson'), WARMUPS: '240,243', SUMMARY_OUT: path.join(tmp, 'w_{W}.json'), EQUITY_OUT: path.join(tmp, 'we_{W}.json') }, encoding: 'utf8', timeout: 600000 });
        ok('②8 LIST_DUMP + WARMUPS → exit 1 並說原因', B2.status === 1 && /LIST_DUMP 一次只跑一個起點/.test(B2.stderr || ''), (B2.stderr || '').slice(-200));
    }
    bad('b3', { LIST_DUMP: path.join(tmp, 'x.ndjson'), RANKBY: 'rand' }, /只支援 RANKBY=self/);
    bad('b4', { LIST_TRIG: path.join(tmp, 'nope.ndjson') }, /讀不到/);
    // 靜態:⛔ 不進 CACHE_KEY
    const CODE = fs.readFileSync(PB, 'utf8');
    const ck = (CODE.match(/const CACHE_KEY = JSON\.stringify\(\{[^}]*\}\)/) || [''])[0];
    ok('②9 CACHE_KEY ⛔ 沒有 LIST_DUMP / LIST_TRIG / LIST_LOOSE', ck && !/LIST_DUMP|LIST_TRIG|LIST_LOOSE/.test(ck), ck);

    // ── ④ ALLFIRE:每天觸發都當候選(成績照舊只算一筆接一筆)──
    console.log('── ④ ALLFIRE ──');
    ok('④0 ALLFIRE(含 🧬 門檻)進 CACHE_KEY(交易清單不一樣 → ⛔ 不可共用舊快取)', /\.\.\._ckAllFire \}\)$/.test(ck) && /const _ckAllFire = ALLFIRE \? \{ ALLFIRE: 1, AF_RANK: RANK_MIN, AF_VOL: VOLAT_MIN \} : \{\};/.test(CODE), ck);
    const AF = run('af', { ALLFIRE: '1', TRADES_CACHE: path.join(tmp, 'caf.json') });
    let C0 = null, C1 = null; try { C0 = JSON.parse(fs.readFileSync(path.join(tmp, 'c.json'), 'utf8')).trades; C1 = JSON.parse(fs.readFileSync(path.join(tmp, 'caf.json'), 'utf8')).trades; } catch (_) {}
    ok('④1 ALLFIRE 跑得起來、cfg 記下、每一筆都標 seq', AF.r.status === 0 && AF.s && AF.s.cfg.allFire === 1 && C1 && C1.length > 0 && C1.every(t => t.seq === 0 || t.seq === 1), `${AF.r.status} ${(AF.r.stderr || '').slice(-200)}`);
    if (C0 && C1) {
        const sig = t => `${t.sym}|${t.key}|${t.inD}|${t.outD}|${t.ret}`;
        const s0 = C0.map(sig).sort().join('\n'), s1 = C1.filter(t => t.seq === 1).map(sig).sort().join('\n');
        ok(`④2 決定性對照:ALLFIRE 裡 seq=1 那幾筆 == 原本一筆接一筆的快取(${C1.filter(t => t.seq === 1).length} / ${C0.length} 筆逐筆相同)`, s0 === s1 && C0.length > 50, `${C1.filter(t => t.seq === 1).length} vs ${C0.length}`);
        ok(`④3 ALLFIRE 多出持有中又觸發的那幾天(${C1.length} > ${C0.length})`, C1.length > C0.length);
    }
    const RB = run('afre', { ALLFIRE: '1', REENTRY: '3', TRADES_CACHE: path.join(tmp, 'cafre.json') });
    ok('④4 ALLFIRE + REENTRY → exit 1', RB.r.status === 1 && /ALLFIRE 不可跟 REENTRY/.test(RB.r.stderr || ''), (RB.r.stderr || '').slice(-200));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(FAIL.length ? `\n❌ ${FAIL.length} 條失敗` : '\n✅ LISTTRIG_PASS');
process.exit(FAIL.length ? 1 : 0);
