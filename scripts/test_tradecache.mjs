#!/usr/bin/env node
/**
 * 🗃️ V79.4.7 portfolio_backtest 交易快取 `.ndjson`(一行一筆)+ 分片建(`SHARD=k/K`)守門
 *
 * 為什麼:🔥 的組合回測要改跑全市場(陷阱 #55:只抽 600 檔換 41 檔成績差一倍);全市場 16 年的交易約 730MB,
 *   超過 node 單一字串上限 512MB(.json 會直接炸)→ .ndjson + 分片平行建,再用 merge_trades_cache.mjs 合併。
 *
 * 釘住:
 *   ⓐ .json 舊格式照舊;.ndjson 單一建的交易 == .json 單一建(逐筆、順序都一樣)、成績一樣
 *   ⓑ ⭐ 決定性對照:分片 0/2 + 1/2 → 合併 == .ndjson 單一建(逐位元組相同),用合併那份跑出來的成績 == 單一建
 *   ⓒ 分片那份⛔ 不可直接拿來跑(exit 1,叫你先合併)
 *   ⓓ SHARD 沒配 .ndjson / 格式錯 / k ≥ K → exit 1
 *   ⓔ 合併守門:少一片 → exit 1
 *   ⓢ 靜態:CACHE_KEY 沒有 SHARD;掃描迴圈走 SCAN_SYMS
 * ⚠️ 真跑引擎(repo `data/`,MAX_SYMS=12),約 2~3 分鐘。
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = process.env.PB_FILE || path.join(ROOT, 'scripts', 'portfolio_backtest.mjs');
const MERGE = path.join(ROOT, 'scripts', 'merge_trades_cache.mjs');
const CODE = fs.readFileSync(FILE, 'utf8').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 260)}`); if (!c) fails.push(n); };

// ── 靜態 ──
const ck = (CODE.match(/const CACHE_KEY = JSON\.stringify\(\{[^}]*\}\)/) || [''])[0];
ok('ⓢ CACHE_KEY ⛔ 沒有 SHARD(分片合併後要跟單一建同一把鑰匙)', ck && !/SHARD/.test(ck), ck);
ok('ⓢ2 掃描迴圈走 SCAN_SYMS(分片才只掃自己那一份)', /for \(const sym of SCAN_SYMS\)/.test(CODE));

// ── 執行期 ──
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
if (!fs.existsSync(path.join(DATA, '^TWII.json'))) { console.log(`❌ ${DATA} 沒有 ^TWII.json → 執行期沒驗到`); fails.push('no-data'); }
else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbtc-'));
    const T = f => path.join(tmp, f);
    const base = { ...process.env, DATA_DIR: DATA, LOT: '150000', SELF: 'high+hivolat', RANK_MIN: '75', VOLAT_MIN: '60', EXIT: 'chand2', MAXD: '20', FILTER: 'bear60', STOPFILL: 'close', WARMUP: '240' };
    for (const k of ['SHARD', 'STATS_WIN', 'STATS_FROM', 'TRADES_CACHE', 'SUMMARY_OUT', 'EQUITY_OUT', 'PARK', 'DIV', 'DIV_TRADES', 'YEAR']) delete base[k];
    const run = (extra, sum) => { const r = spawnSync(process.execPath, ['--max-old-space-size=3000', FILE, '12', '2'], { env: { ...base, ...extra, ...(sum ? { SUMMARY_OUT: T(sum) } : {}) }, encoding: 'utf8', timeout: 420000, maxBuffer: 64 << 20 }); let s = null; if (sum) try { s = JSON.parse(fs.readFileSync(T(sum), 'utf8')); } catch (_) {} return { r, s }; };
    const core = s => s && JSON.stringify({ n: s.n, cum: s.cum, per: s.per, dd: s.dd, win: s.win, skipped: s.skipped, byYear: s.byYear });
    const ndTrades = f => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(1).map(l => JSON.parse(l));

    const A = run({ TRADES_CACHE: T('a.json') }, 'sa.json');
    ok('🚧 .json 單一建跑得起來', A.r.status === 0 && A.s && A.s.n > 0 && fs.existsSync(T('a.json')), `status=${A.r.status} ${(A.r.stderr || A.r.stdout || '').slice(-300)}`);
    const B = run({ TRADES_CACHE: T('b.ndjson') }, 'sb.json');
    const ta = A.s ? JSON.parse(fs.readFileSync(T('a.json'), 'utf8')).trades : [];
    const tb = fs.existsSync(T('b.ndjson')) ? ndTrades(T('b.ndjson')) : [];
    ok('ⓐ .ndjson 單一建的交易 == .json 單一建(逐筆、順序)', ta.length > 0 && JSON.stringify(ta) === JSON.stringify(tb), `${ta.length} vs ${tb.length}`);
    ok('ⓐ2 成績一樣', core(A.s) === core(B.s), `${core(A.s)} vs ${core(B.s)}`);
    const B2 = run({ TRADES_CACHE: T('b.ndjson') }, 'sb2.json');
    ok('ⓐ3 .ndjson 讀回來(跳過掃描)成績一樣', B2.r.status === 0 && /載入交易快取/.test(B2.r.stdout || '') && core(B2.s) === core(A.s), (B2.r.stdout || '').slice(-200));

    const S0 = run({ SHARD: '0/2', TRADES_CACHE: T('s0.ndjson') }), S1 = run({ SHARD: '1/2', TRADES_CACHE: T('s1.ndjson') });
    const h0 = fs.existsSync(T('s0.ndjson')) ? JSON.parse(fs.readFileSync(T('s0.ndjson'), 'utf8').split('\n')[0]) : null;
    ok('ⓑ0 分片建 exit 0、表頭帶 shard / syms / allSyms', S0.r.status === 0 && S1.r.status === 0 && h0 && h0.shard === '0/2' && Array.isArray(h0.syms) && Array.isArray(h0.allSyms) && h0.allSyms.length === 12, `${S0.r.status} ${S1.r.status} ${(S0.r.stderr || '').slice(-200)}`);
    const M = spawnSync(process.execPath, [MERGE, T('m.ndjson'), T('s1.ndjson'), T('s0.ndjson')], { encoding: 'utf8' });
    const same = fs.existsSync(T('m.ndjson')) && fs.existsSync(T('b.ndjson')) && fs.readFileSync(T('m.ndjson')).equals(fs.readFileSync(T('b.ndjson')));
    ok('ⓑ ⭐ 決定性對照:分片 0/2 + 1/2 合併 == 單一建(逐位元組相同;給檔順序倒過來也一樣)', M.status === 0 && same, `${M.status} ${(M.stderr || M.stdout || '').slice(-200)}`);
    const C = run({ TRADES_CACHE: T('m.ndjson') }, 'sm.json');
    ok('ⓑ2 用合併那份跑出來的成績 == 單一建', C.r.status === 0 && core(C.s) === core(A.s), `${core(C.s)} vs ${core(A.s)}`);

    const D = run({ TRADES_CACHE: T('s0.ndjson') });
    ok('ⓒ 分片那份⛔ 不可直接拿來跑(exit 1、叫你先合併)', D.r.status === 1 && /分片/.test(D.r.stderr || ''), `${D.r.status} ${(D.r.stderr || '').slice(-200)}`);
    const E1 = run({ SHARD: '0/2', TRADES_CACHE: T('x.json') }), E2 = run({ SHARD: '2/2', TRADES_CACHE: T('y.ndjson') }), E3 = run({ SHARD: 'abc', TRADES_CACHE: T('z.ndjson') });
    ok('ⓓ SHARD 沒配 .ndjson → exit 1', E1.r.status === 1 && /ndjson/.test(E1.r.stderr || ''), (E1.r.stderr || '').slice(-200));
    ok('ⓓ2 SHARD=2/2(k ≥ K)/ abc → exit 1', E2.r.status === 1 && E3.r.status === 1, `${E2.r.status} ${E3.r.status}`);
    const F = spawnSync(process.execPath, [MERGE, T('m2.ndjson'), T('s0.ndjson')], { encoding: 'utf8' });
    ok('ⓔ 合併守門:少一片 → exit 1、⛔ 沒寫出檔', F.status === 1 && !fs.existsSync(T('m2.ndjson')), `${F.status} ${(F.stderr || '').slice(-200)}`);
    fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ test_tradecache 全過');
process.exit(fails.length ? 1 : 0);
