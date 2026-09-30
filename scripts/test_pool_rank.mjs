#!/usr/bin/env node
/**
 * 🚀👑 V78.0.7 回測引擎兩個候選層選項守門(portfolio_backtest.mjs)
 *   RANKBY=mom10  候選照訊號日 10 日漲幅排(⛔ 只用 ≤ 訊號日)
 *   POOL=N        訊號日近 20 日平均成交金額全市場(不含 0 開頭 ETF)前 N 名才可進場
 *   POOL=sham:N   安慰劑:同通過率、跟成交額無關、固定種子
 * ① 兩個都⛔ 不進 CACHE_KEY(重用交易快取)② 不設時 summary 一字不變
 * ③ POOL:實際成交的每一筆,那天在全市場前 N(⭐ 用這支測試自己算一份獨立的門檻比對)
 * ④ 缺門檻 / 缺成交額 → 剔除(⛔ 不可當成通過)⑤ 打錯參數 → exit 1
 * 注入:`v >= thr` 改成 `v <= thr` → ③ 紅;poolRaw 的 null 回 true → ④s 紅;m10 改用 dd[i + 10] → ⑥s 紅
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = process.env.PB_FILE || path.join(ROOT, 'scripts', 'portfolio_backtest.mjs');
const SRC = fs.readFileSync(FILE, 'utf8');
const CODE = SRC.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');   // ⚠️ 先剝註解
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };

// ── 靜態 ──
const ck = (/const CACHE_KEY = JSON\.stringify\(\{([^}]*)\}\)/.exec(CODE) || [])[1] || '';
ok('①0 空過守門:切得到 CACHE_KEY', ck.length > 20, ck);
ok('① POOL / RANKBY ⛔ 不可進 CACHE_KEY', !/POOL|RANKBY/.test(ck), ck);
const pr = CODE.slice(CODE.indexOf('const poolRaw = t =>'), CODE.indexOf('const poolRaw = t =>') + 200);
ok('④s 缺門檻或缺成交額 → null,poolOk 只收 === true(⛔ 不可當成通過)', /\(thr == null \|\| v == null\) \? null : v >= thr/.test(pr) && /return poolRaw\(t\) === true;/.test(CODE), pr);
ok('④s2 候選濾網那一行真的接上 poolOk(⛔ 寫好沒接 = 陷阱 #37)', /usOk\(x\.t\) && poolOk\(x\.t\)\)/.test(CODE), '');
ok('⑥s m10 只用 ≤ 訊號日(dd[i] 對 dd[i - 10])', /const m10 = \(i >= 10 && dd\[i - 10\]\.c > 0\) \? \(dd\[i\]\.c \/ dd\[i - 10\]\.c - 1\) \* 100 : null;/.test(CODE), '');
ok('⑥s2 RANKBY=mom10 照 m10 由大到小,算不出來排最後', /RANKBY === 'mom10'[^\n]*f\.m10 != null \? f\.m10 : -Infinity[^\n]*_m\(b\) - _m\(a\)/.test(CODE), '');
ok('⑦s POOL 排名不含 0 開頭(ETF)', /\/\^\(\[1-9\]\\d\{3\}\)\\\.json\$\//.test(CODE), '');
ok('⑧s sham 通過率對齊「🧬 通過的候選」上的實測(⛔ 不寫死)', /if \(!selfOk\(x\)\) continue; const w = poolRaw\(x\)/.test(CODE) && /_shamHash\(`\$\{t\.sym\}\|\$\{t\.inD\}\|pool`\)/.test(CODE), '');

// ── 執行期 ──
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const stockFiles = fs.existsSync(DATA) ? fs.readdirSync(DATA).filter(f => /^[1-9]\d{3}\.json$/.test(f)) : [];
if (!fs.existsSync(path.join(DATA, '^TWII.json')) || stockFiles.length < 200) {
    console.log(`❌ ${DATA} 沒有 ^TWII.json 或個股檔太少 → 執行期沒驗到(先 bash scripts/fetch_testdata.sh 或指定 DATA_DIR)`);
    fails.push('no-data');
} else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbpool-'));
    const N = '40';
    const base = { ...process.env, DATA_DIR: DATA, LOT: '150000', SELF: 'high+hivolat', RANK_MIN: '75', VOLAT_MIN: '60', EXIT: 'chand2', MAXD: '20', FILTER: 'bear60', STOPFILL: 'close', WARMUP: '240', TRADES_CACHE: path.join(tmp, 'cache.json') };
    for (const k of ['POOL', 'RANKBY', 'PARK', 'DIV', 'DIV_TRADES', 'FIN_DEEP', 'TURN', 'FIN', 'VAL', 'BEAR_EXIT', 'FORCE_EXIT', 'USSIG', 'EMERGING']) delete base[k];
    const run = (tag, extra) => spawnSync(process.execPath, ['--max-old-space-size=4000', FILE, N, '2'], { env: { ...base, ...extra, SUMMARY_OUT: path.join(tmp, `s_${tag}.json`), TAKEN_OUT: path.join(tmp, `t_${tag}.json`) }, encoding: 'utf8', timeout: 600000, maxBuffer: 64 << 20 });
    const sum = tag => { try { return JSON.parse(fs.readFileSync(path.join(tmp, `s_${tag}.json`), 'utf8')); } catch (_) { return null; } };
    const tk = tag => { try { return JSON.parse(fs.readFileSync(path.join(tmp, `t_${tag}.json`), 'utf8')); } catch (_) { return null; } };

    const r0 = run('base', {}); const s0 = sum('base');
    ok('🚧 基準跑得起來', r0.status === 0 && s0 && s0.n > 5, `status=${r0.status} ${(r0.stderr || r0.stdout || '').slice(-300)}`);
    const keyOf = () => { try { return JSON.parse(fs.readFileSync(base.TRADES_CACHE, 'utf8')).key; } catch (_) { return null; } };
    const k0 = keyOf();
    const r1 = run('again', { RANKBY: 'self' }); const s1 = sum('again');
    ok('② 明寫 RANKBY=self 跟不設一字不變(summary 同)', r1.status === 0 && JSON.stringify(s1) === JSON.stringify(s0), '');

    const rm = run('mom', { RANKBY: 'mom10' }); const sm = sum('mom');
    ok('⑥ RANKBY=mom10 跑得起來、summary 標 rankby、快取 key 沒變', rm.status === 0 && sm && sm.cfg.rankby === 'mom10' && keyOf() === k0 && /跳過掃描/.test(rm.stdout), (rm.stderr || rm.stdout || '').slice(-300));

    const POOL_N = 100;
    const rp = run('pool', { POOL: String(POOL_N) }); const sp = sum('pool'); const tp = tk('pool') || [];
    ok('③0 POOL=100 跑得起來、有成交、快取 key 沒變', rp.status === 0 && sp && tp.length > 0 && keyOf() === k0, (rp.stderr || rp.stdout || '').slice(-400));
    // ⭐ 測試自己算一份門檻(⛔ 不讀引擎的):每天全市場 amt20 的第 N 名
    const amt = new Map(), byDay = new Map();
    for (const f of stockFiles) {
        let rows; try { rows = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch (_) { continue; }
        const sym = f.slice(0, 4); const a = rows.map(r => ({ d: String(r.date || '').replace(/\//g, '-').slice(0, 10), a: (+r.close || 0) * (+r.volume || 0) }));
        for (let i = 19; i < a.length; i++) { let s = 0; for (let k = i - 19; k <= i; k++) s += a[k].a; const v = s / 20; amt.set(`${sym}|${a[i].d}`, v); let arr = byDay.get(a[i].d); if (!arr) byDay.set(a[i].d, arr = []); arr.push(v); }
    }
    let bad = 0; const ex = [];
    for (const t of tp) {
        const arr = (byDay.get(t.d) || []).slice().sort((x, y) => y - x);
        const thr = arr.length >= POOL_N ? arr[POOL_N - 1] : null; const v = amt.get(`${t.sym}|${t.d}`);
        if (thr == null || v == null || !(v >= thr * (1 - 1e-9))) { bad++; if (ex.length < 3) ex.push(`${t.sym}@${t.d} v=${v} thr=${thr}`); }
    }
    ok(`③ 實際成交的 ${tp.length} 筆,每一筆那天都在全市場成交額前 ${POOL_N}(測試自己算的門檻)`, tp.length > 0 && bad === 0, `${bad} 筆不在前 ${POOL_N}:${ex.join(' / ')}`);
    ok('③b POOL 真的有擋(成交筆數 < 基準)', sp && sp.n < s0.n, `${sp && sp.n} vs ${s0.n}`);

    const rs = run('sham', { POOL: `sham:${POOL_N}` }); const ss = sum('sham');
    const fr = /POOL=sham 通過率對齊 POOL=100[^:]*:([\d.]+)%/.exec(rs.stdout || '');
    ok('⑧ POOL=sham:100 跑得起來、印出對齊的通過率、有成交', rs.status === 0 && ss && ss.n > 0 && fr && +fr[1] > 0 && +fr[1] < 100, (rs.stderr || rs.stdout || '').slice(-300));

    const re = run('bad', { POOL: 'abc' });
    const rr = run('badr', { RANKBY: 'xx' });
    ok('⑤ 打錯參數一律 exit 1(POOL=abc / RANKBY=xx)', re.status === 1 && rr.status === 1, `${re.status} ${rr.status}`);
    fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(fails.length ? `\n❌ ${fails.length} 條失敗:${fails.join(' / ')}` : '\n✅ POOL_RANK_PASS');
process.exit(fails.length ? 1 : 0);
