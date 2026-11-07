#!/usr/bin/env node
/**
 * 📲 V82.0.5 Telegram「今天的作戰清單」(台北 08:00)與「尾盤買點」(13:15)改由 Cloudflare Worker 準時叫醒 tg_push.yml —— 守門
 *   (外部健檢 11/07:GitHub 排程在這個 repo 遲到好幾小時 —— 13:20 那輪最近 10 個交易日最早台北 18:35 才跑、
 *    20:00「明天的作戰清單」凌晨 1~5 點才到 → 收盤前一次都沒送到;⛔ 原因不是時區)
 *   ① tgKick 時段:list 只在台北 07:50~08:40、eod 只在 13:10~13:25(13:00 / 13:30 那兩輪 ⛔ 派)
 *   ② 週末不派;沒金鑰不派;不認得的種類不派
 *   ③ 每天每種只派一次(KV);派失敗 ⛔ 記成已派
 *   ④ ⭐ 決定性對照:同一時間,擁有者 KV 設定 strategy = 'lead'(👑)→ 不派;換成 'gene'(🔥 / 🅿️)→ 派
 *      讀不到擁有者 / 沒設 OWNER_CHAT_ID / KV 壞掉 → 照派(⛔ 比以前少送);擁有者按了暫停推播 → 不派
 *   ⑤ 休市:crash_events.json 的 nx(官方休市表算的下一個開盤日)比今天晚 → 不派;nx = 今天 / 讀不到 / 舊的 → 照派
 *   ⑥ 接線:08:00 那輪呼叫 tgKick('list')、盤中末班(CRON.last)呼叫 tgKick('eod'),帶排程時間
 *   ⑦ 事件名:TG_KICK 的 ev == tg_push.yml 收的 types(雙向);tg_push.yml 事件 → 模式(tg-eod → eod、tg-list → playbook_am)、⛔ 沒有 cron
 *   ⑧ telegram_alert.yml 排程那兩輪 → ALERT_MODE=none(cron 照留 —— macro_cron / news_express 跟在它後面)
 *   ⑨ deploy_worker 把 OWNER_CHAT_ID(= TELEGRAM_CHAT_ID)上傳成 Worker secret
 * 注入:INJECT=nolead(拿掉 👑 不派)/ noclosed(拿掉休市不派)/ nokv(拿掉每天一次)—— 都要紅
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INJ = process.env.INJECT || '';
let W = fs.readFileSync(path.join(ROOT, 'cloud-worker/worker.js'), 'utf8');
const TP = fs.readFileSync(path.join(ROOT, '.github/workflows/tg_push.yml'), 'utf8');
const TA = fs.readFileSync(path.join(ROOT, '.github/workflows/telegram_alert.yml'), 'utf8');
const DW = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy_worker.yml'), 'utf8');
const inject = (src, a, b) => { const out = src.split(a).join(b); if (out === src) { console.log(`❌ 注入沒有注進去:${a.slice(0, 80)}`); process.exit(1); } return out; };
if (INJ === 'nolead') W = inject(W, "if (strat === 'lead') return { sent: false, why: 'lead' };", '');
if (INJ === 'noclosed') W = inject(W, "if (nx && nx > today) return { sent: false, why: 'closed', nx };", '');
if (INJ === 'nokv') W = inject(W, "if (env.KV && await env.KV.get(key)) return { sent: false, why: 'done' };", '');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 300)}`); if (!c) fails.push(n); };

const tmp = path.join(ROOT, 'scripts', '.tmp_worker_tgkick.mjs');
fs.writeFileSync(tmp, W);
let M;
try { M = await import(tmp + '?t=' + Date.now()); } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
ok('⓪ worker.js export tgKick / TG_KICK', typeof M.tgKick === 'function' && M.TG_KICK && M.TG_KICK.list && M.TG_KICK.eod);

// ── 假 KV / 假網路 / 假派工 ──
function mkKV(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async k => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); } };
}
const sent = [];
const disp = async (env, ev) => { sent.push(ev); return { ok: true, why: 'http-204' }; };
const dispFail = async (env, ev) => { sent.push(ev); return { ok: false, why: 'http-500' }; };
const fx = nx => async () => ({ ok: true, json: async () => ({ nx }) });
const fxFail = async () => { throw new Error('no network'); };
const at = s => Date.parse(s);                        // UTC
const OWNER = '123456';
const user = (strategy, extra = {}) => JSON.stringify({ chat_id: OWNER, settings: { strategy }, ...extra });
const env = (kvInit, extra = {}) => ({ GH_DISPATCH_TOKEN: 't', OWNER_CHAT_ID: OWNER, KV: mkKV(kvInit), ...extra });
// 2026-11-09 週一:台北 08:00 = 00:00 UTC、13:15 = 05:15 UTC
const D = '2026-11-09';
const AM = at(`${D}T00:00:00Z`), EOD = at(`${D}T05:15:00Z`);

// ① 時段
let n0 = sent.length;
let r = await M.tgKick(env({ [`user:${OWNER}`]: user('gene') }), 'list', AM, fx(D), disp);
ok('① 台北 08:00、擁有者 🔥、今天開盤 → 派 tg-list', r.sent && sent.at(-1) === 'tg-list' && sent.length === n0 + 1, JSON.stringify(r));
n0 = sent.length;
r = await M.tgKick(env({ [`user:${OWNER}`]: user('gene') }), 'eod', EOD, fx(D), disp);
ok('①b 台北 13:15 → 派 tg-eod', r.sent && sent.at(-1) === 'tg-eod' && sent.length === n0 + 1, JSON.stringify(r));
n0 = sent.length;
for (const [lab, kind, iso] of [['13:00', 'eod', `${D}T05:00:00Z`], ['13:30', 'eod', `${D}T05:30:00Z`], ['09:00', 'list', `${D}T01:00:00Z`], ['07:30', 'list', '2026-11-08T23:30:00Z']]) {
  const x = await M.tgKick(env({}), kind, at(iso), fx(D), disp);
  ok(`①c 台北 ${lab} 不在 ${kind} 的時段 → 不派`, !x.sent && x.why === 'time', JSON.stringify(x));
}
ok('①d 13:00 / 13:30 那兩輪真的一個都沒派', sent.length === n0, `多派 ${sent.length - n0}`);
const T = M.TG_KICK;
ok('①e 時段包住各自那一輪(08:00 / 13:15),⛔ 包到 13:00 / 13:30', T.list.from <= 480 && 480 <= T.list.to && T.eod.from <= 795 && 795 <= T.eod.to && T.eod.from > 780 && T.eod.to < 810, JSON.stringify(T));

// ② 週末 / 沒金鑰 / 種類
n0 = sent.length;
ok('② 週六不派', (await M.tgKick(env({}), 'list', at('2026-11-07T00:00:00Z'), fx(D), disp)).why === 'weekend');
ok('②b 週日不派', (await M.tgKick(env({}), 'eod', at('2026-11-08T05:15:00Z'), fx(D), disp)).why === 'weekend');
ok('②c 沒設 GH_DISPATCH_TOKEN → 不派', (await M.tgKick({ OWNER_CHAT_ID: OWNER, KV: mkKV() }, 'list', AM, fx(D), disp)).why === 'no-token');
ok('②d 不認得的種類 → 不派', (await M.tgKick(env({}), 'xx', AM, fx(D), disp)).why === 'kind');
ok('②e 上面四種一個都沒派', sent.length === n0);

// ③ 每天每種一次
const e3 = env({ [`user:${OWNER}`]: user('gene') });
n0 = sent.length;
const a1 = await M.tgKick(e3, 'list', AM, fx(D), disp);
const a2 = await M.tgKick(e3, 'list', AM + 5 * 60e3, fx(D), disp);
ok('③ 同一天第二次 → done、不派', a1.sent && !a2.sent && a2.why === 'done' && sent.length === n0 + 1, JSON.stringify([a1, a2]));
const a3 = await M.tgKick(e3, 'eod', EOD, fx(D), disp);
ok('③b 早上派過 list,13:15 的 eod 照派(不同種類各算各的)', a3.sent, JSON.stringify(a3));
const a4 = await M.tgKick(e3, 'list', at('2026-11-10T00:00:00Z'), fx('2026-11-10'), disp);
ok('③c 隔天照派', a4.sent, JSON.stringify(a4));
const e3b = env({ [`user:${OWNER}`]: user('gene') });
const f1 = await M.tgKick(e3b, 'list', AM, fx(D), dispFail);
const f2 = await M.tgKick(e3b, 'list', AM + 60e3, fx(D), disp);
ok('③d 派失敗(GitHub 回 500)⛔ 記成已派 → 下一次照派', !f1.sent && f2.sent, JSON.stringify([f1, f2]));

// ④ 擁有者的策略(⭐ 決定性對照)
n0 = sent.length;
const l1 = await M.tgKick(env({ [`user:${OWNER}`]: user('lead') }), 'list', AM, fx(D), disp);
const l2 = await M.tgKick(env({ [`user:${OWNER}`]: user('lead') }), 'eod', EOD, fx(D), disp);
ok('④ 擁有者選 👑 → 作戰清單與尾盤買點都不派', !l1.sent && l1.why === 'lead' && !l2.sent && l2.why === 'lead' && sent.length === n0, JSON.stringify([l1, l2]));
const g1 = await M.tgKick(env({ [`user:${OWNER}`]: user('gene') }), 'list', AM, fx(D), disp);
ok('④b ⭐ 決定性對照:同一時間只把策略換成 gene(🔥 / 🅿️)→ 派', g1.sent && g1.strat === 'gene', JSON.stringify(g1));
const u1 = await M.tgKick(env({}), 'list', AM, fx(D), disp);
ok('④c 讀不到擁有者設定(沒同步過)→ 照派(⛔ 比以前少送)', u1.sent, JSON.stringify(u1));
const u2 = await M.tgKick({ GH_DISPATCH_TOKEN: 't', KV: mkKV({ [`user:${OWNER}`]: user('lead') }) }, 'list', AM, fx(D), disp);
ok('④d 沒設 OWNER_CHAT_ID → 照派(⛔ 拿別人的設定)', u2.sent, JSON.stringify(u2));
const u3 = await M.tgKick(env({ [`user:${OWNER}`]: '{壞掉' }), 'list', AM, fx(D), disp);
ok('④e KV 裡那份讀不出來 → 照派', u3.sent, JSON.stringify(u3));
const u4 = await M.tgKick({ GH_DISPATCH_TOKEN: 't', OWNER_CHAT_ID: OWNER }, 'list', AM, fx(D), disp);
ok('④f 沒有 KV → 照派', u4.sent, JSON.stringify(u4));
const m1 = await M.tgKick(env({ [`user:${OWNER}`]: user('gene', { muted_until: AM + 3600e3 }) }), 'list', AM, fx(D), disp);
const m2 = await M.tgKick(env({ [`user:${OWNER}`]: user('gene', { muted_until: AM - 3600e3 }) }), 'list', AM, fx(D), disp);
ok('④g 擁有者按了暫停推播 → 不派;暫停時間過了 → 照派', !m1.sent && m1.why === 'muted' && m2.sent, JSON.stringify([m1, m2]));

// ⑤ 休市
n0 = sent.length;
const c1 = await M.tgKick(env({}), 'list', AM, fx('2026-11-10'), disp);
ok('⑤ 今天休市(nx = 明天)→ 不派', !c1.sent && c1.why === 'closed' && sent.length === n0, JSON.stringify(c1));
const c2 = await M.tgKick(env({}), 'list', AM, fx(D), disp);
ok('⑤b ⭐ 決定性對照:nx = 今天 → 派', c2.sent, JSON.stringify(c2));
ok('⑤c 讀不到 crash_events.json → 照派', (await M.tgKick(env({}), 'list', AM, fxFail, disp)).sent);
ok('⑤d nx 是舊的(檔案好幾天沒更新)→ 照派', (await M.tgKick(env({}), 'list', AM, fx('2026-11-02'), disp)).sent);
ok('⑤e 檔案裡沒有 nx → 照派', (await M.tgKick(env({}), 'list', AM, async () => ({ ok: true, json: async () => ({}) }), disp)).sent);

// ⑥ 接線
const S = W.slice(W.indexOf('async scheduled(event, env, ctx)'));
const bPre = (() => { const i = S.indexOf('} else if (event.cron === CRON.pre)'); return i < 0 ? '' : S.slice(i, S.indexOf('} else {', i)); })();
const bElse = (() => { const i = S.indexOf('} else {'); return i < 0 ? '' : S.slice(i, S.indexOf('\n    },', i)); })();
ok("⑥ 08:00 那輪呼叫 tgKick(env, 'list', 排程時間)", /tgKick\(env, 'list', event\.scheduledTime \|\| Date\.now\(\)\)/.test(bPre), bPre.slice(0, 300));
ok("⑥b 盤中末班(CRON.last)那輪才呼叫 tgKick(env, 'eod', 排程時間)", /if \(event\.cron === CRON\.last\) ctx\.waitUntil\(tgKick\(env, 'eod', event\.scheduledTime \|\| Date\.now\(\)\)\)/.test(bElse), bElse.slice(0, 400));
ok('⑥c 只有這兩處呼叫 tgKick(⛔ 別的排程偷派)', (S.match(/tgKick\(env,/g) || []).length === 2);
// 真的呼叫 scheduled():13:15 那輪會走到 tgKick('eod')(用假 fetch 記錄 dispatch)
{
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opt) => {
    const u = String(url);
    if (u.includes('/dispatches')) { calls.push(JSON.parse(opt.body).event_type); return { status: 204, ok: true }; }
    if (u.includes('crash_events.json')) return { ok: true, json: async () => ({ nx: D }) };
    throw new Error('test: no network');
  };
  const ps = [];
  const ctx = { waitUntil: p => { ps.push(Promise.resolve(p).catch(() => {})); } };
  const quiet = { l: console.log, e: console.error, w: console.warn };
  console.log = console.error = console.warn = () => {};
  try {
    const E = { GH_DISPATCH_TOKEN: 't', OWNER_CHAT_ID: OWNER, KV: mkKV({ [`user:${OWNER}`]: user('gene') }) };
    await M.default.scheduled({ cron: M.CRON.last, scheduledTime: EOD, type: 'scheduled' }, E, ctx);
    await Promise.race([Promise.allSettled(ps), new Promise(res => setTimeout(res, 5000))]);
    ps.length = 0;
    await M.default.scheduled({ cron: M.CRON.last, scheduledTime: at(`${D}T05:30:00Z`), type: 'scheduled' }, E, ctx);
    await Promise.race([Promise.allSettled(ps), new Promise(res => setTimeout(res, 5000))]);
  } finally { console.log = quiet.l; console.error = quiet.e; console.warn = quiet.w; globalThis.fetch = realFetch; }
  ok('⑥d 真的跑 scheduled():13:15 那輪派出 tg-eod、13:30 那輪不再派', calls.filter(x => x === 'tg-eod').length === 1, JSON.stringify(calls));
}

// ⑦ 事件名雙向 + tg_push.yml
const evs = new Set(Object.values(M.TG_KICK).map(k => k.ev));
const tm = TP.match(/\n  repository_dispatch:\s*\n\s+types:\s*\[([^\]]+)\]/);
const recv = new Set(tm ? tm[1].split(',').map(s => s.trim()) : []);
ok('⑦ tg_push.yml 收的 types == Worker TG_KICK 的 ev(雙向,⛔ 差一字永遠不觸發且零訊息)',
  evs.size === 2 && recv.size === evs.size && [...evs].every(e => recv.has(e)), `worker=${[...evs]} yml=${[...recv]}`);
ok('⑦b tg_push.yml ⛔ 沒有 cron(準時靠 Worker;排程那條路正是會遲到好幾小時的那條)', !/^\s+- cron:/m.test(TP) && !/\n  schedule:/.test(TP));
ok("⑦c 事件 → 模式:tg-eod → eod、其他 → playbook_am(⛔ 用時間判斷)",
  TP.includes("ALERT_MODE: ${{ github.event.inputs.mode || (github.event.action == 'tg-eod' && 'eod' || 'playbook_am') }}"));
ok('⑦d tg_push.yml 走 secrets + 尾盤那輪會拉 gh-pages 的 live_quotes.json', TP.includes('secrets.TELEGRAM_BOT_TOKEN') && TP.includes('secrets.TELEGRAM_CHAT_ID') && TP.includes('FETCH_HEAD:data/live_quotes.json'));
ok('⑦e tg_push.yml 有逾時 + 只讀權限', /timeout-minutes:\s*\d+/.test(TP) && /permissions:\s*\n\s+contents:\s*read/.test(TP));

// ⑧ telegram_alert.yml 排程那兩輪 → none,cron 照留
const crons = [...TA.matchAll(/- cron: '([^']+)'/g)].map(m => m[1]);
ok('⑧ telegram_alert.yml 兩條 cron 照留(macro_cron / news_express 跟在它後面)', crons.includes('0 12 * * 1-5') && crons.includes('20 5 * * 1-5'), JSON.stringify(crons));
ok("⑧b 排程那兩輪 ALERT_MODE = none(⛔ 再用排程字串對應成 playbook / eod)", TA.includes("ALERT_MODE: ${{ github.event.inputs.mode || 'none' }}") && !/github\.event\.schedule ==/.test(TA));
const MC = fs.readFileSync(path.join(ROOT, '.github/workflows/macro_cron.yml'), 'utf8');
const taName = (TA.match(/^name:\s*(.+)$/m) || [])[1]?.trim();
ok('⑧c macro_cron 仍跟在「📲 Telegram 警報系統」後面(名字逐字一樣)', taName && MC.includes(`"${taName}"`), taName);

// ⑨ deploy_worker
ok('⑨ deploy_worker 上傳 OWNER_CHAT_ID = secrets.TELEGRAM_CHAT_ID', /OWNER_CHAT_ID:\s*\$\{\{\s*secrets\.TELEGRAM_CHAT_ID\s*\}\}/.test(DW) && /for K in [^\n]*OWNER_CHAT_ID/.test(DW));
// 🔐 擁有者 id ⛔ 不可被印出來
const ownLines = W.split('\n').filter(l => l.includes('OWNER_CHAT_ID'));
ok('⑨b 🔐 OWNER_CHAT_ID ⛔ 不可被 console / 訊息印出來', ownLines.length > 0 && !ownLines.some(l => /console\.|tg\(|JSON\.stringify/.test(l)), ownLines.join(' | '));

console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ test_tg_kick 全過');
process.exit(fails.length ? 1 : 0);
