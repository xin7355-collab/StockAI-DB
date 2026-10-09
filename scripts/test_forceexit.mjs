#!/usr/bin/env node
/**
 * 🐻🚨 V77.6.8 `portfolio_backtest.mjs` 強制出場鉤子守門(BEAR_EXIT 空頭清倉 / FORCE_EXIT 事件強制出場)
 *
 * 起因:使用者問「股市空頭時手上的是不是先賣掉」「進處置股要不要先賣」—— 本站以前**沒有任何程式會因 regime 或事件而賣掉持倉**
 *   (FILTER=bear60 只擋新買、PARK 只動閒錢),所以答不出來。這支釘住新鉤子的三件事:
 *   ⓐ BEAR_EXIT=strict:被強制賣掉的那幾筆(fx=1)出場日**一定是**大盤嚴格空頭日(獨立 oracle:收 < 60 日線 且 20 日線 < 60 日線),
 *      而且每一筆的出場日 ≤ 不設時同一筆的出場日(只會提早,不會延後);不設時一筆 fx 都沒有(決定性對照)
 *   ⓑ FORCE_EXIT:指定某檔在某個持有中的日子有事件 → 那一筆的出場日 = 事件日**之後第一個交易日**、賣價 = 那天的**開盤**(⛔ 不是事件日收盤 —— 前視)
 *   ⓒ 兩個選項一定進 CACHE_KEY(靜態 + 快取檔的 key);⓭ 不設時 key 裡⛔ 沒有那兩個欄位(既有快取照樣重用、一字不變)
 *   ⓓ 空過守門:設了卻一筆都沒被強制賣掉 → exit 1(⛔ 不可長得像「沒差別」)
 * ⚠️ 要真的跑引擎(用 repo `data/` 的 25 檔),約 2~3 分鐘;`data/` 沒有 ^TWII.json 就誠實 exit 1(⛔ 不假綠)
 * 注入(逐一確認會紅):拿掉 `_ckForce` → ⓒ 紅;強制那行改成 `exitP = c` 的事件版 → ⓑ 紅;拿掉「一筆都沒有就 exit 1」→ ⓓ 紅
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = process.env.PB_FILE || path.join(ROOT, 'scripts', 'portfolio_backtest.mjs');
const SRC = fs.readFileSync(FILE, 'utf8');
const CODE = SRC.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 240)}`); if (!c) fails.push(n); };

// ── 靜態 ──
ok('ⓒs CACHE_KEY 帶 `_ckForce`(BEAR_EXIT / FORCE_EXIT 一定進 key)', /const CACHE_KEY = JSON\.stringify\(\{[^}]*\.\.\._ckForce \}\)/.test(CODE) && /const _ckForce = \{ \.\.\.\(BEAR_EXIT \? \{ BEAR_EXIT \} : \{\}\), \.\.\.\(FORCE_EXIT \? \{ FORCE_EXIT: FORCE_HASH \} : \{\}\)/.test(CODE)   /* ⚠️ V79.0.0 修長期紅燈:後面又接了 LUDEFER / HALFSIG,⛔ 不釘結尾 */, '');
ok('ⓑs 事件強制出場用**開盤價**(`exitP = O(j) > 0 ? O(j) : c` + fx = 2)', /FS && FS\.has\(data\[j\]\.date\)\) \{ exitP = O\(j\) > 0 \? O\(j\) : c; exitIdx = j; fx = 2; break; \}/.test(CODE), '');
ok('ⓐs 空頭清倉用**收盤價**(`exitP = c` + fx = 1)', /BD && BD\.has\(data\[j\]\.date\)(?: && \(a\.bearMode !== 'strictlose' \|\| c < entry\))?\) \{ exitP = c; exitIdx = j; fx = 1; break; \}/.test(CODE), '');
ok('ⓐs2 空頭日集合直接用 `notBear60`(⛔ 不寫第二份定義)', /const BEAR_DAYS = !BEAR_EXIT \? null : new Set\(twii\.map\(\(r, i\) => \(BEAR_EXIT !== 'ma60' \? !notBear60\(i\)/.test(CODE), '');
ok('ⓓs 空過守門:設了卻 0 筆 → exit 1(兩個都要)', /BEAR_EXIT 設了卻一筆都沒被強制賣掉[^\n]*process\.exit\(1\)/.test(CODE) && /FORCE_EXIT 設了卻一筆都沒被強制賣掉[^\n]*process\.exit\(1\)/.test(CODE), '');

// ── 執行期 ──
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
if (!fs.existsSync(path.join(DATA, '^TWII.json')) || fs.readdirSync(DATA).filter(f => /^\d{4}\.json$/.test(f)).length < 200) {
    console.log(`❌ ${DATA} 沒有 ^TWII.json 或個股檔太少 → 執行期那幾條沒驗到(先 bash scripts/fetch_testdata.sh 或指定 DATA_DIR)`);
    fails.push('no-data');
} else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbforce-'));
    const N = '25';
    const base = { ...process.env, DATA_DIR: DATA, LOT: '150000', SELF: 'high+hivolat', RANK_MIN: '75', VOLAT_MIN: '60', EXIT: 'don40', MAXD: '40', FILTER: 'bear60', STOPFILL: 'close', WARMUP: '240' };
    delete base.BEAR_EXIT; delete base.FORCE_EXIT; delete base.PARK; delete base.DIV; delete base.FIN_DEEP; delete base.TURN; delete base.FIN; delete base.VAL;
    const run = (tag, extra) => spawnSync(process.execPath, ['--max-old-space-size=3000', FILE, N, '2'], { env: { ...base, ...extra, TRADES_CACHE: path.join(tmp, `c_${tag}.json`), SUMMARY_OUT: path.join(tmp, `s_${tag}.json`) }, encoding: 'utf8', timeout: 420000, maxBuffer: 64 << 20 });
    const cache = tag => { try { return JSON.parse(fs.readFileSync(path.join(tmp, `c_${tag}.json`), 'utf8')); } catch (_) { return null; } };
    const norm = d => String(d || '').replace(/\//g, '-').slice(0, 10);

    // 基準
    const r0 = run('base', {});
    const c0 = cache('base');
    ok('🚧 基準跑得起來而且有交易快取', r0.status === 0 && c0 && Array.isArray(c0.trades) && c0.trades.length > 50, `status=${r0.status} ${(r0.stderr || r0.stdout || '').slice(-300)}`);
    if (c0) {
        const k0 = JSON.parse(c0.key);
        ok('ⓓ2 不設時 key 裡⛔ 沒有 BEAR_EXIT / FORCE_EXIT(既有快取一字不變)', !('BEAR_EXIT' in k0) && !('FORCE_EXIT' in k0) && k0.EXIT === 'don40' && k0.STOPFILL === 'close', c0.key);
        ok('ⓐ0 決定性對照:不設時一筆都沒有 fx', c0.trades.every(t => !t.fx), '');
    }

    // ⓐ BEAR_EXIT=strict
    const rB = run('bear', { BEAR_EXIT: 'strict' });
    const cB = cache('bear');
    ok('ⓐ1 BEAR_EXIT=strict 跑得起來(exit 0)', rB.status === 0, `status=${rB.status} ${(rB.stderr || '').slice(-300)}`);
    if (c0 && cB) {
        ok('ⓒ 快取 key 帶 BEAR_EXIT=strict', JSON.parse(cB.key).BEAR_EXIT === 'strict', cB.key);
        // 獨立 oracle:嚴格空頭日
        const tw = JSON.parse(fs.readFileSync(path.join(DATA, '^TWII.json'), 'utf8')).map(r => ({ d: norm(r.date), c: +r.close })).filter(r => r.d && r.c > 0);
        const ma = (i, n) => i < n - 1 ? null : tw.slice(i - n + 1, i + 1).reduce((s, r) => s + r.c, 0) / n;
        const bear = new Set(); tw.forEach((r, i) => { const m20 = ma(i, 20), m60 = ma(i, 60); if (m60 != null && r.c < m60 && m20 < m60) bear.add(r.d); });
        const forced = cB.trades.filter(t => t.fx === 1);
        ok('ⓐ2 有交易被空頭日強制賣掉(空過守門的反面)', forced.length > 0, `${forced.length}`);
        ok('ⓐ3 被強制賣掉的每一筆,出場日都是嚴格空頭日(獨立 oracle)', forced.length > 0 && forced.every(t => bear.has(norm(t.outD))), forced.filter(t => !bear.has(norm(t.outD))).slice(0, 3).map(t => `${t.sym} ${t.outD}`).join(' | '));
        const k = t => `${t.sym}|${t.inD}|${t.key}`;
        const m0 = new Map(c0.trades.map(t => [k(t), t]));
        const later = forced.filter(t => m0.has(k(t)) && norm(t.outD) > norm(m0.get(k(t)).outD));
        ok('ⓐ4 強制只會提早、⛔ 不會延後(每一筆 outD ≤ 不設時的 outD)', later.length === 0, later.slice(0, 3).map(t => `${t.sym} ${t.outD} vs ${m0.get(k(t)).outD}`).join(' | '));
        // ⚠️ 被提早賣掉之後,那一檔的掃描會提早往下走 → 會多出基準沒有的**新**交易(那是合法的:部位空出來了)
        //    所以只比「兩邊都有的那些筆」要一模一樣;多出來的每一筆,進場日必須在同一檔某次強制賣出之後
        const nf = cB.trades.filter(t => !t.fx), both = nf.filter(t => m0.has(k(t)));
        const diff = both.filter(t => m0.get(k(t)).outD !== t.outD || Math.abs(m0.get(k(t)).ret - t.ret) > 1e-9);
        ok('ⓐ5 沒被強制、兩邊都有的那些筆跟基準一模一樣(⛔ 鉤子不可動到別的邏輯)', both.length > 0 && diff.length === 0, `${diff.length} 筆不同 / 共 ${both.length}`);
        const extra = nf.filter(t => !m0.has(k(t)));
        const orphan = extra.filter(t => !forced.some(f => f.sym === t.sym && norm(f.outD) <= norm(t.inD)));
        ok('ⓐ5b 多出來的新交易一律在同一檔某次強制賣出之後(部位空出來才有的)', orphan.length === 0, `${orphan.length} / ${extra.length}:` + orphan.slice(0, 2).map(t => `${t.sym} ${t.inD}`).join(' | '));
        const s = (() => { try { return JSON.parse(fs.readFileSync(path.join(tmp, 's_bear.json'), 'utf8')); } catch (_) { return null; } })();
        ok('ⓐ6 成績單有 `forced.bear` 與 `cfg.bearExit`', !!(s && s.forced && s.forced.bear >= 0 && s.cfg.bearExit === 'strict'), JSON.stringify(s && { f: s.forced, b: s.cfg && s.cfg.bearExit }));
    }

    // ⓑ FORCE_EXIT:挑基準裡抱最久的一筆,把事件日放在持有中間
    if (c0) {
        const pick = [...c0.trades].filter(t => norm(t.outD) > norm(t.inD)).sort((a, b) => (norm(b.outD) > norm(a.outD) ? 1 : -1))[0];
        const rows = JSON.parse(fs.readFileSync(path.join(DATA, `${pick.sym}.json`), 'utf8')).map(r => ({ d: norm(r.date), o: +r.open, c: +r.close })).filter(r => r.d);
        const i0 = rows.findIndex(r => r.d === norm(pick.inD)), i1 = rows.findIndex(r => r.d === norm(pick.outD));
        // 事件日 = 進場成交日之後第 3 根(⚠️ inD 是訊號日、成交在隔一根 → 至少要在 i0+2 之後)
        const ev = rows[i0 + 3], sellDay = rows[i0 + 4];
        const fj = path.join(tmp, 'force.json');
        fs.writeFileSync(fj, JSON.stringify({ [pick.sym]: [ev.d] }));
        const rF = run('force', { FORCE_EXIT: fj });
        const cF = cache('force');
        ok('ⓑ1 FORCE_EXIT 跑得起來(exit 0)', rF.status === 0, `status=${rF.status} ${(rF.stderr || '').slice(-300)}`);
        if (cF) {
            const t = cF.trades.find(x => x.sym === pick.sym && x.inD === pick.inD && x.key === pick.key);
            ok('ⓑ2 那一筆的出場日 = 事件日之後第一個交易日、fx = 2', !!(t && norm(t.outD) === sellDay.d && t.fx === 2 && i1 > i0 + 4), t ? `${t.outD} vs ${sellDay.d} fx=${t.fx}` : '找不到那一筆');
            if (t) {
                const exitP = t.entry * (1 + t.ret / 100);
                ok('ⓑ3 賣價 = 那天**開盤**(⛔ 不是事件日收盤)', Math.abs(exitP - sellDay.o) < 0.011 && Math.abs(exitP - ev.c) > 0.011 || (Math.abs(sellDay.o - ev.c) < 0.011 && Math.abs(exitP - sellDay.o) < 0.011), `exitP=${exitP.toFixed(3)} open=${sellDay.o} evClose=${ev.c}`);
            }
            ok('ⓒ2 快取 key 帶 FORCE_EXIT 的內容指紋', typeof JSON.parse(cF.key).FORCE_EXIT === 'string' && JSON.parse(cF.key).FORCE_EXIT.length >= 8, cF.key);
            ok('ⓑ4 其他檔一筆都沒被強制', cF.trades.filter(x => x.fx === 2).every(x => x.sym === pick.sym), '');
        }
        // ⓓ 事件日跟任何持倉都不重疊 → 必須 exit 1
        fs.writeFileSync(fj, JSON.stringify({ '0000': ['2000-01-03'] }));
        const rZ = run('zero', { FORCE_EXIT: fj });
        ok('ⓓ 空過守門:事件跟候選交易零重疊 → exit 1 且說出來', rZ.status === 1 && /一筆都沒被強制賣掉/.test(rZ.stderr + rZ.stdout), `status=${rZ.status}`);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(fails.length ? `\n❌ FORCEEXIT_FAIL(${fails.length}):${fails.join(' / ')}` : '\n✅ FORCEEXIT_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
