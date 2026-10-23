#!/usr/bin/env node
/**
 * ⏰ V79.1.9 收盤後叫醒每日採礦(換倉名單最早出來)守門
 *   ① worker minerKick:平日 + screener 還不是今天 → 發 daily-miner;週末 / 已是今天 / 沒金鑰 → 不發
 *      ⭐ 決定性對照:同一個時間點,data_date 換成今天就不可以發
 *   ② daily_miner.yml 收 repository_dispatch types: [daily-miner](事件名兩邊一致)
 *   ③ playbook_scan 的 if 收 schedule / repository_dispatch / workflow_dispatch,⛔ 不收 push
 *   ④ 台北 17:00 那一輪(CRON.eve = 0 9 * * MON-FRI;排程本身由 test_worker_cron 釘)有呼叫 minerKick
 * 注入:INJECT=nofresh(拿掉「已是今天就不發」)/ schedonly(playbook_scan 改回只收 schedule)—— 都要紅
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INJ = process.env.INJECT || '';
let W = fs.readFileSync(path.join(ROOT, 'cloud-worker/worker.js'), 'utf8');
let PS = fs.readFileSync(path.join(ROOT, '.github/workflows/playbook_scan.yml'), 'utf8');
const DM = fs.readFileSync(path.join(ROOT, '.github/workflows/daily_miner.yml'), 'utf8');
if (INJ === 'nofresh') { const b = W; W = W.replace("if (dd && dd >= today) return { sent: false, why: 'fresh', dd };", ''); if (W === b) { console.log('❌ 注入沒有注進去'); process.exit(1); } }
if (INJ === 'schedonly') { const b = PS; PS = PS.replace(`contains(fromJSON('["schedule","repository_dispatch","workflow_dispatch"]'), github.event.workflow_run.event)`, "github.event.workflow_run.event == 'schedule'"); if (PS === b) { console.log('❌ 注入沒有注進去'); process.exit(1); } }
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };

const tmp = path.join(ROOT, 'scripts', '.tmp_worker_kick.mjs');
fs.writeFileSync(tmp, W);
const M = await import(tmp + '?t=' + Date.now());
try { fs.unlinkSync(tmp); } catch (_) {}

// 合成 fetch:回一段跟真 screener 一樣開頭的 body
const mkFetch = dd => async () => ({ ok: true, body: null, text: async () => `{"updated":"x","data_date":"${dd}","n":2495,"cols":["c"]` + 'x'.repeat(2000) });
const sent = [];
const disp = async (env, ev) => { sent.push(ev); return { ok: true, why: 'http-204' }; };
const env = { GH_DISPATCH_TOKEN: 't' };
const at = s => Date.parse(s);   // UTC
// 2026-10-13 週二 台北 17:00 = 09:00 UTC
const r1 = await M.minerKick(env, at('2026-10-13T09:00:00Z'), mkFetch('2026-10-12'), disp);
ok('① 平日 17:00、資料停在昨天 → 發 daily-miner', r1.sent && sent[sent.length - 1] === 'daily-miner', JSON.stringify(r1));
const n1 = sent.length;
const r2 = await M.minerKick(env, at('2026-10-13T09:00:00Z'), mkFetch('2026-10-13'), disp);
ok('①b ⭐ 決定性對照:同一時間 data_date 換成今天 → 不可以發', !r2.sent && sent.length === n1 && r2.why === 'fresh', JSON.stringify(r2));
const r3 = await M.minerKick(env, at('2026-10-17T09:00:00Z'), mkFetch('2026-10-16'), disp);
ok('①c 週六不發', !r3.sent && r3.why === 'weekend' && sent.length === n1, JSON.stringify(r3));
const r4 = await M.minerKick({}, at('2026-10-13T09:00:00Z'), mkFetch('2026-10-12'), disp);
ok('①d 沒設金鑰不發', !r4.sent && r4.why === 'no-token' && sent.length === n1, JSON.stringify(r4));
const r5 = await M.minerKick(env, at('2026-10-13T09:00:00Z'), async () => ({ ok: false }), disp);
ok('①e 讀不到 screener(還沒產出 / 網路掛)→ 照發(⛔ 不可以因為讀不到就當成已經是今天)', r5.sent, JSON.stringify(r5));
// 讀串流的那條路
const enc = new TextEncoder();
const streamFetch = async () => ({ ok: true, body: new ReadableStream({ start(c) { c.enqueue(enc.encode('{"updated":"2026-10-13 18:01","data_date":"2026-10-13",')); c.enqueue(enc.encode('"n":1,' + 'y'.repeat(900))); c.close(); } }) });
ok('①f 串流只讀開頭也拿得到 data_date', (await M._screenerDate(streamFetch)) === '2026-10-13');

// ②
const onBlock = DM.slice(DM.indexOf('\non:'), DM.indexOf('\nconcurrency:') > 0 ? DM.indexOf('\nconcurrency:') : DM.indexOf('\njobs:'));
ok('② daily_miner.yml 收 repository_dispatch types: [daily-miner]', /\n  repository_dispatch:\s*\n\s+types:\s*\[daily-miner\]/.test(onBlock), onBlock.slice(0, 400));
ok('②b 事件名兩邊一致(worker 發的就是 daily_miner 收的)', /ghDispatch\(env,\s*'daily-miner'\)|dispatchFn\(env,\s*'daily-miner'\)/.test(W));
// ③
const ifm = PS.match(/\n    if: >-\n([\s\S]*?)\n    timeout-minutes/);
const IF = ifm ? ifm[1] : '';
ok('③ playbook_scan 跟 schedule / repository_dispatch / workflow_dispatch 那輪', /"schedule"/.test(IF) && /"repository_dispatch"/.test(IF) && /"workflow_dispatch"/.test(IF), IF);
ok('③b ⛔ 不跟 push 那輪、失敗的不跟', !/push/.test(IF.replace(/#.*$/gm, '')) && /conclusion == 'success'/.test(IF), IF);
// ④
const _i0 = W.indexOf("if (event.cron === CRON.eve)");
const sch = _i0 < 0 ? '' : W.slice(_i0, W.indexOf("} else if (event.cron === CRON.open)"));
ok('④ 台北 17:00 那一輪呼叫 minerKick', /minerKick\(env\)/.test(sch), sch.slice(0, 300));

console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ test_miner_kick 全過');
process.exit(fails.length ? 1 : 0);
