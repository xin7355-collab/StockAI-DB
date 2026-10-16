#!/usr/bin/env node
/**
 * 🌅 V79.3.4 盤前體檢的總經資料要在「美股收盤後」更新一次 —— 守門
 *   ① worker macroKick:平日 + macro_risk 還停在美股收盤前 → 發 macro-cron;
 *      ⭐ 決定性對照:同一時間,updated 換成收盤後就不可以發;週末 / 沒金鑰不發;讀不到照發
 *   ② macro_cron.yml 收 repository_dispatch types: [macro-cron](兩邊事件名一致)+ 跟 news_premarket(名字逐字對得上)
 *      + job if 放行 repository_dispatch;台北 08:00 那一輪(0 0 * * 1-5)呼叫 macroKick
 *   ③ index.html _lastUsCloseMs == worker _lastUsCloseMs(逐時比對,夏令 / 冬令都要過)
 *   ④ 盤前體檢灰字:收盤前抓的 → 有;收盤後抓的 → 沒有(決定性對照);收盤 12 小時後不講
 * 注入:INJECT=nofresh(拿掉「已是收盤後就不發」)/ dst(冬令也當 20:00)—— 都要紅
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INJ = process.env.INJECT || '';
let W = fs.readFileSync(path.join(ROOT, 'cloud-worker/worker.js'), 'utf8');
const MC = fs.readFileSync(path.join(ROOT, '.github/workflows/macro_cron.yml'), 'utf8');
const NP = fs.readFileSync(path.join(ROOT, '.github/workflows/news_premarket.yml'), 'utf8');
let IDX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const inj = (src, a, b) => { const o = src; const n = src.replace(a, b); if (n === o) { console.log('❌ 注入沒有注進去'); process.exit(1); } return n; };
if (INJ === 'nofresh') W = inj(W, "if (upd && close && upd >= close) return { sent: false, why: 'fresh', upd, close };", '');
if (INJ === 'dst') IDX = inj(IDX, "if (+fmt.format(new Date(cand)) !== 16) cand = day + 21 * 3600e3;\n                if (cand <= now) return cand;\n            }\n        } catch", "if (cand <= now) return cand;\n            }\n        } catch");
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };

const tmp = path.join(ROOT, 'scripts', '.tmp_worker_macro.mjs');
fs.writeFileSync(tmp, W);
const M = await import(tmp + '?t=' + Date.now());
try { fs.unlinkSync(tmp); } catch (_) {}

const at = s => Date.parse(s);   // UTC
const mkFetch = upd => async () => ({ ok: true, json: async () => ({ updated: upd }) });
const sent = [];
const disp = async (env, ev) => { sent.push(ev); return { ok: true, why: 'http-204' }; };
const env = { GH_DISPATCH_TOKEN: 't' };
// 2026-10-16 週五 台北 08:00 = 00:00 UTC;美股 10/15 收盤 = 20:00 UTC = 台北 10/16 04:00
const NOW = at('2026-10-16T00:00:00Z');
const r1 = await M.macroKick(env, NOW, mkFetch('2026-10-15 23:57 +0800'), disp);
ok('① 台北 08:00、資料是昨晚 23:57(美股盤中)→ 發 macro-cron', r1.sent && sent.at(-1) === 'macro-cron', JSON.stringify(r1));
const n1 = sent.length;
const r2 = await M.macroKick(env, NOW, mkFetch('2026-10-16 05:30 +0800'), disp);
ok('①b ⭐ 決定性對照:同一時間資料換成 05:30(收盤後)→ 不可以發', !r2.sent && sent.length === n1 && r2.why === 'fresh', JSON.stringify(r2));
ok('①c 週六不發', (await M.macroKick(env, at('2026-10-17T00:00:00Z'), mkFetch('2026-10-15 23:57 +0800'), disp)).why === 'weekend' && sent.length === n1);
ok('①d 沒設金鑰不發', (await M.macroKick({}, NOW, mkFetch('2026-10-15 23:57 +0800'), disp)).why === 'no-token' && sent.length === n1);
const r5 = await M.macroKick(env, NOW, async () => ({ ok: false }), disp);
ok('①e 讀不到 macro_risk → 照發(⛔ 不可當成已更新)', r5.sent, JSON.stringify(r5));
// 週一 08:00 → 收盤基準是上週五
const mon = M._lastUsCloseMs(at('2026-10-19T00:00:00Z'));
ok('①f 週一早上的「最近一次收盤」= 上週五 20:00 UTC', mon === at('2026-10-16T20:00:00Z'), new Date(mon).toISOString());
// 冬令(11/1 起)= 21:00 UTC
ok('①g 冬令收盤 = 21:00 UTC(台北 05:00)', M._lastUsCloseMs(at('2026-11-10T00:00:00Z')) === at('2026-11-09T21:00:00Z'));
ok('①h 台北時間字串解析', M._twStampMs('2026-10-15 23:57 +0800') === at('2026-10-15T15:57:00Z'));

// ②
const onBlock = MC.slice(MC.indexOf('\non:'), MC.indexOf('\npermissions:'));
ok('② macro_cron.yml 收 repository_dispatch types: [macro-cron]', /\n  repository_dispatch:\s*\n\s+types:\s*\[macro-cron\]/.test(onBlock), onBlock.slice(0, 300));
ok('②b 事件名兩邊一致(worker 發的就是 macro_cron 收的)', /dispatchFn\(env,\s*'macro-cron'\)/.test(W));
const npName = (NP.match(/^name:\s*(.+)$/m) || [])[1]?.trim();
ok('②c 跟車 host 名字跟 news_premarket.yml 的 name 逐字一樣', npName && onBlock.includes(`- "${npName}"`), npName);
const ifm = MC.match(/\n    if: >-\n([\s\S]*?)\n    timeout-minutes/);
ok('②d job if 放行非 workflow_run(repository_dispatch 進得來)', ifm && /github\.event_name != 'workflow_run'/.test(ifm[1]), ifm && ifm[1]);
const sch = W.slice(W.indexOf("} else if (event.cron === '0 0 * * 1-5')"), W.indexOf("} else {", W.indexOf("} else if (event.cron === '0 0 * * 1-5')")));
ok('②e 台北 08:00 那一輪呼叫 macroKick', /macroKick\(env\)/.test(sch), sch.slice(0, 300));

// ③④ 前端:抽出兩支方法
function grab(src, head) {
  const i = src.indexOf(head); if (i < 0) return null;
  let j = src.indexOf('{', i), d = 0;
  for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } }
  return null;
}
const f1 = grab(IDX, '_lastUsCloseMs(now = Date.now()) {'), f2 = grab(IDX, '_macroPreUsClose(now = Date.now()) {');
ok('③ 前端兩支方法存在', !!(f1 && f2));
const app = eval(`({ ${f1}, ${f2} })`);
let diff = 0;
for (let t = at('2026-01-02T00:00:00Z'); t < at('2027-01-02T00:00:00Z'); t += 3 * 3600e3 + 17 * 60e3) {
  if (app._lastUsCloseMs(t) !== M._lastUsCloseMs(t)) diff++;
}
ok('③b index.html 與 worker 的「最近一次美股收盤」逐時一致(一整年,含夏令冬令切換)', diff === 0, `差 ${diff} 處`);
app._macroRiskCache = { updated: '2026-10-15 23:57 +0800' };
const p1 = app._macroPreUsClose(at('2026-10-16T01:22:00Z'));   // 台北 09:22(使用者截圖)
ok('④ 使用者截圖情境(23:57 抓、09:22 看)→ 要講「美股收盤後還沒更新」', !!p1 && p1.closeTxt === '04:00', JSON.stringify(p1));
app._macroRiskCache = { updated: '2026-10-16 08:06 +0800' };
ok('④b ⭐ 決定性對照:資料換成 08:06(收盤後)→ 不講', app._macroPreUsClose(at('2026-10-16T01:22:00Z')) === null);
app._macroRiskCache = { updated: '2026-10-15 23:57 +0800' };
ok('④c 收盤 12 小時後(台北 16:30)不講', app._macroPreUsClose(at('2026-10-16T08:30:00Z')) === null);
ok('④d 灰字接在盤前體檢標題下(⛔ 不改分數)', /\$\{_staleWarn\}\s*\n\s*\$\{_usPreWarn\}/.test(IDX) && /text-gray-500[^"]*" data-uspre="1"/.test(IDX));

console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ test_macro_kick 全過');
process.exit(fails.length ? 1 : 0);
