// 🛑📐 V77.5.9 停損成交價三種口徑 + ATR 反比部位 —— 回測腳本守門
//   ATR 逐字稿檢視時照出來的:同一條停損,全站有三種執行方式
//     回測(舊)= 收盤跌破 → 用**停損價**算(收盤已經在下面了,那個價其實賣不到)
//     auto_trade.py = 現價 <= 停損 → 用**現價**賣(≈ close)
//     App 複製智慧單 = 盤中**觸價**就賣(≈ touch)
//
// ⛔ 這支釘的用意(每條都做過注入驗證):
//   ⓐ 出場模擬器三種口徑的數字對(跑 breakout_exit_probe --selftest ⑨~⑨e)
//   ⓑ portfolio_backtest 認不得的 STOPFILL / SIZING 一律 exit 1(打錯字⛔ 不可安靜地退回預設)
//   ⓒ 預設 STOPFILL=stop ⛔ 不進 CACHE_KEY(舊快取照樣重用、舊輸出逐位元組相同)
//   ⓓ 累積損益用**每一筆自己的投入金額**(⛔ 寫死 LOT 會讓 risk / volpar 的總獲利是錯的)
//   ⓔ volpar 的參考 ATR% ⛔ 不含今天的候選(今天的候選要在挑完之後才放進歷史)
//   ⓕ 三種口徑在 portfolio_backtest 裡都有分支,而且 close 用收盤、touch 用 min(開盤, 停損)
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

let bad = 0;
const ok = (c, n, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${e ? ' — ' + e : ''}`); if (!c) bad++; };
const strip = t => t.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');

// ⓐ
{
    const r = spawnSync('node', ['scripts/breakout_exit_probe.mjs', '--selftest'], { encoding: 'utf8' });
    const out = r.stdout || '';
    ok(r.status === 0 && /⑨ stop 口徑/.test(out) && /⑨d 盤中碰到/.test(out), 'ⓐ 出場模擬器三種口徑 selftest 全過', (out.match(/❌[^\n]*/g) || []).join(' | '));
}
// ⓑ
for (const [k, v] of [['STOPFILL', 'clsoe'], ['SIZING', 'volpr']]) {
    const r = spawnSync('node', ['scripts/portfolio_backtest.mjs', '10', '2'], { encoding: 'utf8', env: { ...process.env, [k]: v, DATA_DIR: '/nonexistent' } });
    ok(r.status === 1 && (r.stderr || '').includes(`${k}=${v} 不認得`), `ⓑ ${k}=${v} 打錯字 → exit 1 並說不認得`, `status=${r.status}`);
}
const SRC = strip(readFileSync('scripts/portfolio_backtest.mjs', 'utf8'));
// ⓒ
ok(/const _ckStopFill = STOPFILL !== 'stop' \? \{ STOPFILL \} : \{\};/.test(SRC) && /CACHE_KEY = JSON\.stringify\(\{[^}]*GRACE, \.\.\._ckStopFill \}\)/.test(SRC), 'ⓒ STOPFILL 只在非預設時進 CACHE_KEY');
// ⓓ
ok(/const money = t => \(t\._amt \|\| LOT\) \* net\(t\) \/ 100;/.test(SRC) && !/const money = t => LOT \*/.test(SRC), 'ⓓ 累積損益用每一筆自己的投入金額');
// ⓔ
{
    const iRef = SRC.indexOf('vpRef = sv[sv.length >> 1]');
    const iPick = SRC.indexOf('taken.push(t); live.push(t); picked++;');
    const iHist = SRC.indexOf('for (const { t } of cand) if (t.ap > 0) vpHist.push(t.ap);');
    ok(iRef > 0 && iPick > iRef && iHist > iPick, 'ⓔ volpar 參考值在挑選之前算、今天的候選在挑完之後才放進歷史', JSON.stringify([iRef, iPick, iHist]));
    ok(/k = vpK\[Math\.floor\(_rnd\(\) \* vpK\.length\)\]/.test(SRC), 'ⓔ2 volsham 的倍數從歷史倍數分布隨機抽(跟這檔 ATR 無關)');
}
// ⓕ
ok(/a\.stopFill === 'touch' \? \(L\(j\) > 0 && L\(j\) <= stop\) : c <= stop/.test(SRC)
    && /exitP = a\.stopFill === 'close' \? c/.test(SRC)
    && /a\.stopFill === 'touch' \? Math\.min\(O\(j\) > 0 \? O\(j\) : stop, stop\)/.test(SRC), 'ⓕ 三種口徑分支都在(close 用收盤、touch 用 min(開盤, 停損))');
ok(/stopFill: STOPFILL \}\);/.test(SRC), 'ⓕ2 STOPFILL 真的傳進掃描(沒傳 = 三種跑出來一模一樣)');

console.log(bad ? `\n❌ ${bad} 條沒過` : '\n✅ test_stopfill 全過');
process.exit(bad ? 1 : 0);
