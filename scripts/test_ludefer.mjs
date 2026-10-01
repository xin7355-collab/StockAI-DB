#!/usr/bin/env node
/**
 * 🟥 V78.1.4 `portfolio_backtest.mjs` LUDEFER=1 守門:「抱滿 MAXD 天那天收盤鎖漲停 → 延到隔天開盤賣」
 *
 * 起因:使用者拿國巨(10/01 收盤鎖漲停、剛好抱滿)問「要觀察還是照總覽先出場」,
 *   本站 `_DT_EDGE.lu` 說鎖漲停隔天開盤賣平均 +2.19%,但這條**從沒在組合回測裡測過** → 加開關先量。
 *   ⓢ 靜態:只動時間到期那一條、鎖漲停定義 = dt_daily_probe.lockUp(收 ≥ 昨收×1.09 且收在最高)、進 CACHE_KEY、空過守門
 *   ⓐ 不設時 key 裡⛔ 沒有 LUDEFER、一筆 ld 都沒有(既有快取一字不變)
 *   ⓑ 每一筆被延的(ld=1):出場日前一天是鎖漲停(獨立 oracle)、出場日 = 到期日的隔天、賣價 = 隔天開盤
 *   ⓒ 沒有任何一筆被延的那幾檔,交易跟不設時一模一樣(⛔ 鉤子不可動到別的邏輯)
 * ⚠️ 要真的跑引擎(repo `data/`),約 3~5 分鐘;沒有 ^TWII.json 就誠實 exit 1
 * 注入(逐一確認會紅):門檻 1.09 改 0.9 → ⓑ 紅;拿掉 `endJ === eIdx + a.maxD` → ⓢ 紅;拿掉 LUDEFER 進 key → ⓢ/ⓒk 紅
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

ok('ⓢ1 只在 MAXD 到期那天延(`endJ === eIdx + a.maxD`)且不是資料最後一天', /a\.luDefer && endJ === eIdx \+ a\.maxD && j < last && /.test(CODE), '');
ok('ⓢ2 鎖漲停 = 收 ≥ 昨收×1.09 且收在最高(同 dt_daily_probe.lockUp)', /c >= C\(j - 1\) \* 1\.09 && c >= data\[j\]\.high - 1e-9/.test(CODE)
    && /lockUp = i => C\[i\] >= C\[i - 1\] \* 1\.09 && C\[i\] >= H\[i\] - 1e-9/.test(fs.readFileSync(path.join(ROOT, 'scripts', 'dt_daily_probe.mjs'), 'utf8')), '');
ok('ⓢ3 延的那筆賣隔天開盤(`exitIdx = j + 1; exitP = O(j + 1)`)', /exitIdx = j \+ 1; exitP = O\(j \+ 1\) > 0 \? O\(j \+ 1\) : C\(j \+ 1\); ld = 1;/.test(CODE), '');
ok('ⓢ4 LUDEFER 進 CACHE_KEY(只在設了的時候)', /\.\.\.\(LUDEFER \? \{ LUDEFER: 1 \} : \{\}\)/.test(CODE), '');
ok('ⓢ5 空過守門:設了卻 0 筆 → exit 1', /LUDEFER 設了卻一筆都沒延[^\n]*process\.exit\(1\)/.test(CODE), '');

const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
if (!fs.existsSync(path.join(DATA, '^TWII.json')) || fs.readdirSync(DATA).filter(f => /^\d{4}\.json$/.test(f)).length < 200) {
    console.log(`❌ ${DATA} 沒有 ^TWII.json 或個股檔太少 → 執行期沒驗到(先 bash scripts/fetch_testdata.sh 或指定 DATA_DIR)`);
    fails.push('no-data');
} else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pblud-'));
    const N = process.env.LUD_N || '400';
    // MAXD 調短:讓「到期那天剛好鎖漲停」在小樣本裡也碰得到(機制測試,⛔ 不是成績)
    const base = { ...process.env, DATA_DIR: DATA, LOT: '150000', SELF: 'high+hivolat', RANK_MIN: '75', VOLAT_MIN: '60', EXIT: 'chand2', MAXD: '3', FILTER: 'bear60', STOPFILL: 'close', WARMUP: '240' };
    for (const k of ['LUDEFER', 'BEAR_EXIT', 'FORCE_EXIT', 'PARK', 'DIV', 'DIV_TRADES', 'FIN_DEEP', 'TURN', 'FIN', 'VAL', 'USSIG']) delete base[k];
    const run = (tag, extra) => spawnSync(process.execPath, ['--max-old-space-size=4000', FILE, N, '2'], { env: { ...base, ...extra, TRADES_CACHE: path.join(tmp, `c_${tag}.json`), SUMMARY_OUT: path.join(tmp, `s_${tag}.json`) }, encoding: 'utf8', timeout: 900000, maxBuffer: 64 << 20 });
    const cache = tag => { try { return JSON.parse(fs.readFileSync(path.join(tmp, `c_${tag}.json`), 'utf8')); } catch (_) { return null; } };
    const norm = d => String(d || '').replace(/\//g, '-').slice(0, 10);

    const r0 = run('base', {}), c0 = cache('base');
    ok('🚧 基準跑得起來而且有交易快取', r0.status === 0 && c0 && c0.trades.length > 50, `status=${r0.status} ${(r0.stderr || r0.stdout || '').slice(-300)}`);
    const r1 = run('lud', { LUDEFER: '1' }), c1 = cache('lud');
    ok('🚧 LUDEFER=1 跑得起來(exit 0 = 有延到至少一筆)', r1.status === 0 && c1, `status=${r1.status} ${(r1.stderr || r1.stdout || '').slice(-300)}`);
    if (c0 && c1) {
        const k0 = JSON.parse(c0.key), k1 = JSON.parse(c1.key);
        ok('ⓐ 不設時 key 沒有 LUDEFER、一筆 ld 都沒有', !('LUDEFER' in k0) && c0.trades.every(t => !t.ld), c0.key);
        ok('ⓒk 設了 key 帶 LUDEFER', k1.LUDEFER === 1, c1.key);
        const ld = c1.trades.filter(t => t.ld);
        ok('ⓑ0 有延到的交易', ld.length > 0, ld.length);
        const bars = {};
        const B = s => bars[s] || (bars[s] = JSON.parse(fs.readFileSync(path.join(DATA, `${s}.json`), 'utf8')).map(r => ({ d: norm(r.date), o: +r.open, h: +r.high, c: +r.close })));
        const bad = [];
        for (const t of ld) {
            const b = B(t.sym), k = b.findIndex(r => r.d === norm(t.outD)), s = b.findIndex(r => r.d === norm(t.inD));
            const due = b[k - 1], prev = b[k - 2];
            const lock = due && prev && due.c >= prev.c * 1.09 && due.c >= due.h - 1e-9;
            const px = t.entry * (1 + t.ret / 100);
            // 訊號日 s → 進場 s+1(或 s)→ 到期 = 進場 + MAXD;被延 → 出場 = 到期 + 1
            const span = k - s;
            if (!lock || Math.abs(px - b[k].o) > Math.max(0.011, b[k].o * 1e-6) || !(span === 3 + 1 || span === 3 + 2)) bad.push(`${t.sym} ${t.inD}→${t.outD} lock=${lock} px=${px.toFixed(2)} o=${b[k] && b[k].o} span=${span}`);
        }
        ok('ⓑ 每一筆被延的:到期那天鎖漲停(獨立 oracle)、賣隔天開盤、出場 = 到期 +1', ld.length > 0 && bad.length === 0, bad.slice(0, 3).join(' | '));
        const symsLd = new Set(ld.map(t => t.sym));
        const key = t => `${t.sym}|${t.inD}|${t.key}`;
        const a = c0.trades.filter(t => !symsLd.has(t.sym)).map(t => `${key(t)}|${t.outD}|${t.ret.toFixed(6)}`).sort();
        const b2 = c1.trades.filter(t => !symsLd.has(t.sym)).map(t => `${key(t)}|${t.outD}|${t.ret.toFixed(6)}`).sort();
        ok('ⓒ 沒被延的那幾檔交易跟不設時一模一樣', a.length > 0 && a.join('\n') === b2.join('\n'), `${a.length} vs ${b2.length}`);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('\n' + (fails.length ? `❌ ${fails.length} 條失敗` : '✅ LUDEFER_PASS'));
process.exit(fails.length ? 1 : 0);
