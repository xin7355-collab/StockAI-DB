#!/usr/bin/env node
/**
 * 🚦 V80.1.1 `portfolio_backtest.mjs` DAYGATE(那幾天不開新倉)守門 —— 反攻雷達「成形才買」研究用
 *
 * 釘住:
 *   ⓐ 不設時一個字都不變:⛔ 不進 CACHE_KEY;不設兩次逐位相同、summary 沒有 daygate
 *   ⓑ 只擋買、⛔ 不 continue:擋在「挑完候選」之後、「買進迴圈」之前,🅿️ 收盤停 0050 那段照跑
 *   ⓒ 決定性對照:只擋暖身期的一天(窗口內一天都沒擋)== 不設(逐位相同,含逐日淨值)
 *   ⓓ 窗口全擋 → 0 筆進場(引擎照舊 exit 1「一筆都沒進場」)
 *   ⓔ 擋一半 → 真的少買、成績不同、cand 有數
 *   ⓕ 安慰劑:DAYGATE_SHIFT=0 == 不平移(逐位相同)、K=37 擋的天數一樣多但成績不同
 *   ⓖ 🅿️ 被擋的日子出場拿回來的錢收盤照停 0050(cash 停在 0 附近;⛔ EQGATE 那種 continue 會讓錢卡在現金)
 *   ⓗ 空過守門:資料範圍內一天都沒擋 → exit 1;格式不對 → exit 1;SHIFT 沒配 DAYGATE → exit 1
 *   ⓘ WARMUPS 一次跑多個起點:每個起點的 daygate.blocked 各算各的(計數有重設)
 *   ⓙ BEAR_MODE(空頭那天):skip == 同一批空頭日的 DAYGATE(逐位相同)・cash 空頭日 0050 全換現金、過了停回去・half 減半・跟 FILTER=bear60 互斥
 * ⚠️ 真跑引擎(repo `data/` 25 檔),約 5 分鐘。
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = process.env.PB_FILE || path.join(ROOT, 'scripts', 'portfolio_backtest.mjs');
const CODE = fs.readFileSync(FILE, 'utf8').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 260)}`); if (!c) fails.push(n); };

// ── 靜態 ──
const ck = (CODE.match(/const CACHE_KEY = JSON\.stringify\(\{[^}]*\}\)/) || [''])[0];
ok('ⓐs CACHE_KEY ⛔ 沒有 DAYGATE', ck && !/DAYGATE|DG_/.test(ck), ck);
const lineGate = (CODE.match(/^.*DG_BLOCK && DG_BLOCK\.has\(d\).*$/m) || [''])[0];
const iGate = CODE.indexOf('DG_BLOCK && DG_BLOCK.has(d)'), iCand = CODE.indexOf('const cand = '), iBuy = CODE.indexOf('for (const { t } of cand) {'), iPark = CODE.indexOf("if (PARK === 'idle' && parkOf && parkOf(i) > 0 && cash > 1");
ok('ⓑs 擋在挑完候選之後、買進迴圈之前、停車之前', iCand > 0 && iGate > iCand && iGate < iBuy && iBuy < iPark, `${iCand} ${iGate} ${iBuy} ${iPark}`);
ok('ⓑs2 那一行只清空候選,⛔ 不 continue(停車那段要跑到)', /cand\.length = 0/.test(lineGate) && !/continue/.test(lineGate), lineGate);
ok('ⓘs 每個起點重設計數', /listBlk = 0; dgBlk = 0; dgCand = 0;/.test(CODE));

// ── 執行期 ──
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
if (!fs.existsSync(path.join(DATA, '^TWII.json'))) { console.log(`❌ ${DATA} 沒有 ^TWII.json → 執行期沒驗到`); fails.push('no-data'); }
else {
    const tw = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8')).map(r => String(r.date || '').replace(/\//g, '-').slice(0, 10)).filter(Boolean);
    const WU = 240, win = tw.slice(WU);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbdg-'));
    const f0050 = path.join(DATA, '0050.json');
    const gate = (nm, arr) => { const f = path.join(tmp, `${nm}.json`); fs.writeFileSync(f, JSON.stringify(arr)); return f; };
    const base = { ...process.env, DATA_DIR: DATA, LOT: '150000', SELF: 'high+hivolat', RANK_MIN: '75', VOLAT_MIN: '60', EXIT: 'chand2', MAXD: '20', FILTER: '', STOPFILL: 'close', WARMUP: String(WU), TRADES_CACHE: path.join(tmp, 'c.json') };
    for (const k of ['DAYGATE', 'DAYGATE_SHIFT', 'VOLCAP', 'EQGATE', 'EQGATE_SRC', 'ROTATE', 'COST_X', 'PARK', 'DIV', 'DIV_TRADES', 'EQUITY_OUT', 'WARMUPS', 'YEARRUNS', 'LISTK', 'ALLFIRE']) delete base[k];
    const run = (tag, extra) => {
        const r = spawnSync(process.execPath, ['--max-old-space-size=3000', FILE, '25', '2'], { env: { ...base, ...extra, SUMMARY_OUT: extra.SUMMARY_OUT || path.join(tmp, `s_${tag}.json`) }, encoding: 'utf8', timeout: 420000, maxBuffer: 64 << 20 });
        let s = null; try { s = JSON.parse(fs.readFileSync(extra.SUMMARY_OUT || path.join(tmp, `s_${tag}.json`), 'utf8')); } catch (_) {}
        return { r, s };
    };
    const rd = f => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return ''; } };
    const A = run('a', { EQUITY_OUT: path.join(tmp, 'eq_a.json') }), B = run('b', {});
    ok('🚧 基準跑得起來', A.r.status === 0 && A.s && A.s.n > 5, `status=${A.r.status} ${(A.r.stderr || A.r.stdout || '').slice(-300)}`);
    ok('ⓐ 不設:兩次逐位相同、summary 沒有 daygate', A.s && B.s && A.s.cum === B.s.cum && A.s.n === B.s.n && !('daygate' in A.s), `${A.s?.cum} vs ${B.s?.cum}`);

    // ⓒ 只擋暖身期的一天 → 窗口內 0 天 → 跟不設逐位相同(含逐日淨值)
    const C = run('c', { DAYGATE: gate('warm1', [tw[10]]), EQUITY_OUT: path.join(tmp, 'eq_c.json') });
    ok('ⓒ 決定性對照:窗口內一天都沒擋 == 不設(成績 + 逐日淨值逐位相同)',
        C.r.status === 0 && C.s && C.s.cum === A.s?.cum && C.s.n === A.s?.n && C.s.daygate?.blocked === 0
        && rd(path.join(tmp, 'eq_c.json')) === rd(path.join(tmp, 'eq_a.json')),
        `${C.r.status} ${C.s?.cum} vs ${A.s?.cum} ${JSON.stringify(C.s?.daygate)} ${(C.r.stderr || '').slice(-160)}`);

    // ⓓ 窗口全擋 → 0 筆
    const D = run('d', { DAYGATE: gate('all', win) });
    ok('ⓓ 窗口全擋 → 一筆都沒進場(exit 1 並說原因)', D.r.status === 1 && /一筆都沒進場/.test(D.r.stdout || ''), `${D.r.status} ${(D.r.stdout || '').slice(-200)}`);
    ok('ⓓ2 一開始就寫出擋了幾天(= 整個窗口)', new RegExp(`:${win.length}/\\d+ 個交易日不開新倉`).test(D.r.stdout || ''), (D.r.stdout || '').match(/🚦 DAYGATE[^\n]*/)?.[0] || '');

    // ⓔ 擋一半(隔天擋)
    const half = win.filter((_, k) => k % 2 === 0);
    const E = run('e', { DAYGATE: gate('half', half) });
    ok('ⓔ 擋一半 → 少買、成績不同、有記到被擋的候選', E.r.status === 0 && E.s && E.s.n < A.s?.n && E.s.cum !== A.s?.cum && E.s.daygate?.blocked > 0 && E.s.daygate?.cand > 0,
        `${E.r.status} n=${E.s?.n} vs ${A.s?.n} ${JSON.stringify(E.s?.daygate)}`);

    // ⓕ 安慰劑
    const F0 = run('f0', { DAYGATE: gate('half', half), DAYGATE_SHIFT: '0' }), F7 = run('f7', { DAYGATE: gate('half', half), DAYGATE_SHIFT: '37' });
    ok('ⓕ 決定性對照:SHIFT=0 == 不平移', F0.s && E.s && F0.s.cum === E.s.cum && F0.s.n === E.s.n, `${F0.s?.cum} vs ${E.s?.cum}`);
    ok('ⓕ2 SHIFT=37:擋的天數一樣多、成績不同', F7.s && E.s && F7.s.daygate.days === E.s.daygate.days && F7.s.daygate.shift === 37 && F7.s.cum !== E.s.cum,
        `${F7.s?.daygate?.days} ${E.s?.daygate?.days} ${F7.s?.cum}`);

    // ⓖ 🅿️ 被擋的日子照停 0050:擋掉窗口第 200 天以後 → 那段的現金收盤都停進 0050(cash 只剩零頭)
    //   ⚠️ repo 的 0050.json 比加權晚開始 → 只看 0050 有價的那幾天(沒價那幾天本來就停不了)
    if (fs.existsSync(f0050)) {
        const j50 = JSON.parse(fs.readFileSync(f0050, 'utf8')), r50 = Array.isArray(j50) ? j50 : (j50.data || []);
        const has50 = new Set(r50.filter(r => +r.close > 0).map(r => String(r.date || '').replace(/\//g, '-').slice(0, 10)));
        const P0 = run('p0', { PARK: 'idle', EQUITY_OUT: path.join(tmp, 'eq_p0.json') });
        // 從「第一次有部位」的隔天開始擋:⭐ 擋的時候手上還有部位 → 它們在被擋的日子出場,拿回來的錢一定要當天收盤停進 0050
        //   (⛔ 擋在部位都出清之後的話,被擋的日子根本沒有錢回來 → 這條對「continue 寫法」沒有鑑別力)
        let r0 = []; try { r0 = JSON.parse(rd(path.join(tmp, 'eq_p0.json'))).rows || []; } catch (_) {}
        const first = r0.findIndex(r => r.n > 0), cut = first >= 0 ? win.indexOf(r0[first].d) + 1 : win.length;
        const late = win.slice(cut);
        const P = run('p', { PARK: 'idle', DAYGATE: gate('late', late), EQUITY_OUT: path.join(tmp, 'eq_p.json') });
        let rows = []; try { rows = JSON.parse(rd(path.join(tmp, 'eq_p.json'))).rows || []; } catch (_) {}
        const lateSet = new Set(late);
        const blkRows = rows.filter(r => lateSet.has(r.d) && has50.has(r.d));
        const maxCash = Math.max(0, ...blkRows.map(r => r.cash));
        const parked = blkRows.filter(r => r.park > 0).length;
        const exitsIn = blkRows.some((r, k) => k > 0 && r.n < blkRows[k - 1].n);
        ok('ⓖ PARK=idle:被擋的日子有部位出場、收盤照停 0050(現金只剩零頭、停車天數 = 被擋天數)', P.r.status === 0 && blkRows.length > 100 && exitsIn && maxCash <= 2 && parked === blkRows.length,
            `${P.r.status} rows=${blkRows.length} exitsIn=${exitsIn} maxCash=${maxCash} parked=${parked} ${(P.r.stdout || '').slice(-160)}`);
        ok('ⓖ2 而且真的比不擋少買(擋了有作用)', P.s && P0.s && P.s.n < P0.s.n, `${P.s?.n} vs ${P0.s?.n}`);
    } else ok('ⓖ 沒有 0050.json → 停車那條沒驗到', false, DATA);

    // ⓗ 空過守門
    const H1 = run('h1', { DAYGATE: gate('out', ['1999-01-04']) });
    ok('ⓗ 資料範圍內一天都沒擋 → exit 1', H1.r.status === 1 && /一天都沒擋/.test(H1.r.stderr || ''), (H1.r.stderr || '').slice(-200));
    const H2 = run('h2', { DAYGATE: gate('bad', ['2024/01/02']) });
    ok('ⓗ2 日期格式不對 → exit 1', H2.r.status === 1 && /格式不對/.test(H2.r.stderr || ''), (H2.r.stderr || '').slice(-200));
    const H3 = run('h3', { DAYGATE_SHIFT: '5' });
    ok('ⓗ3 只設 SHIFT 沒設 DAYGATE → exit 1', H3.r.status === 1 && /DAYGATE_SHIFT 要跟 DAYGATE 一起設/.test(H3.r.stderr || ''), (H3.r.stderr || '').slice(-200));

    // ⓘ WARMUPS:兩個起點,各自的 blocked 不累加
    const W = run('w', { DAYGATE: gate('half', half), WARMUPS: `${WU},${WU + 40}`, SUMMARY_OUT: path.join(tmp, 'sw_{W}.json') });
    let w0 = null, w1 = null; try { w0 = JSON.parse(rd(path.join(tmp, `sw_${WU}.json`))); w1 = JSON.parse(rd(path.join(tmp, `sw_${WU + 40}.json`))); } catch (_) {}
    ok('ⓘ WARMUPS 第一個起點 == 單獨跑(逐位相同)、第二個起點的計數沒有累加', W.r.status === 0 && w0 && w1 && w0.cum === E.s?.cum && w0.daygate.blocked === E.s?.daygate?.blocked && w1.daygate.blocked < w0.daygate.blocked,
        `${W.r.status} ${w0?.cum} vs ${E.s?.cum} ${JSON.stringify(w0?.daygate)} ${JSON.stringify(w1?.daygate)} ${(W.r.stderr || '').slice(-160)}`);

    // ⓙ BEAR_MODE(空頭那幾天:skip 不買 / cash 不買 + 0050 換現金 / half 減半)
    const twc = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8')).map(r => ({ d: String(r.date || '').replace(/\//g, '-').slice(0, 10), c: +r.close })).filter(r => r.d && r.c > 0);
    const ma = (k, N) => (k < N - 1 ? null : twc.slice(k - N + 1, k + 1).reduce((a, r) => a + r.c, 0) / N);
    const bearD = twc.filter((r, k) => { const m60 = ma(k, 60), m20 = ma(k, 20); return m60 != null && r.c < m60 && m20 < m60; }).map(r => r.d);
    const bearWin = bearD.filter(d => d >= tw[WU]);
    ok('ⓙ0 測資窗口內有空頭日(不然下面幾條沒有鑑別力)', bearWin.length >= 10, bearWin.length);
    const BS = run('bs', { BEAR_MODE: 'skip' });
    const BG = run('bg', { DAYGATE: gate('bear', bearD) });
    ok('ⓙ1 skip 有擋到空頭日、少買', BS.r.status === 0 && BS.s && BS.s.bearMode?.days === bearWin.length && BS.s.n < A.s?.n, `${BS.r.status} ${JSON.stringify(BS.s?.bearMode)} n=${BS.s?.n} ${(BS.r.stderr || '').slice(-160)}`);
    ok('ⓙ2 ⭐ 跨檢查:skip == DAYGATE(同一批空頭日)逐位相同', BS.s && BG.s && BS.s.cum === BG.s.cum && BS.s.n === BG.s.n, `${BS.s?.cum} vs ${BG.s?.cum}`);
    const BF = run('bf', { BEAR_MODE: 'skip', FILTER: 'bear60' });
    ok('ⓙ3 跟 FILTER=bear60 一起設 → exit 1', BF.r.status === 1 && /不跟 FILTER=bear60 一起設/.test(BF.r.stderr || ''), (BF.r.stderr || '').slice(-160));
    const BC0 = run('bc0', { BEAR_MODE: 'cash' });
    ok('ⓙ4 cash 沒配 PARK=idle → exit 1', BC0.r.status === 1 && /要配 PARK=idle/.test(BC0.r.stderr || ''), (BC0.r.stderr || '').slice(-160));
    if (fs.existsSync(f0050)) {
        const j50 = JSON.parse(fs.readFileSync(f0050, 'utf8')), r50 = Array.isArray(j50) ? j50 : (j50.data || []);
        const has50 = new Set(r50.filter(r => +r.close > 0).map(r => String(r.date || '').replace(/\//g, '-').slice(0, 10)));
        const BC = run('bc', { BEAR_MODE: 'cash', PARK: 'idle', EQUITY_OUT: path.join(tmp, 'eq_bc.json') });
        let rc = [], r0 = []; try { rc = JSON.parse(rd(path.join(tmp, 'eq_bc.json'))).rows || []; r0 = JSON.parse(rd(path.join(tmp, 'eq_p0.json'))).rows || []; } catch (_) {}
        const bset = new Set(bearWin.filter(d => has50.has(d)));
        const bRows = rc.filter(r => bset.has(r.d)), b0 = r0.filter(r => bset.has(r.d));
        const after = rc.filter(r => !bset.has(r.d) && has50.has(r.d) && r.d > (bearWin[bearWin.length - 1] || '9'));
        ok('ⓙ5 cash:空頭日收盤 0050 一股都沒有、沒設時那幾天是有停車的', BC.r.status === 0 && bRows.length >= 5 && bRows.every(r => r.park === 0) && b0.some(r => r.park > 0) && BC.s?.bearMode?.sell > 0,
            `${BC.r.status} rows=${bRows.length} parks=${bRows.filter(r => r.park > 0).length} base=${b0.filter(r => r.park > 0).length} ${JSON.stringify(BC.s?.bearMode)} ${(BC.r.stderr || '').slice(-160)}`);
        ok('ⓙ5b 空頭過了就停回 0050', !after.length || after.some(r => r.park > 0), after.length);
    } else ok('ⓙ5 沒有 0050.json → cash 那條沒驗到', false, DATA);
    const BH = run('bh', { BEAR_MODE: 'half' });
    ok('ⓙ6 half:空頭日買的那幾筆減半、成績跟不設不同', BH.r.status === 0 && BH.s && BH.s.bearMode?.half > 0 && BH.s.cum !== A.s?.cum, `${BH.r.status} ${JSON.stringify(BH.s?.bearMode)} ${BH.s?.cum} vs ${A.s?.cum}`);
    fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ test_daygate 全過');
process.exit(fails.length ? 1 : 0);
