#!/usr/bin/env node
/**
 * 🤖 Gemini / Groq 模型名自我修復(V78.5.6)測試
 *
 * 🐛 以前 gemini-2.5-flash / llama-3.3-70b-versatile / llama-3.1-8b-instant 寫死在 5 個呼叫點 →
 *    供應商一下架,全部 AI 同時失敗,畫面只寫 HTTP 404(V73.8.0 OpenRouter、V73.9.0 Groq 各踩過一次)。
 * ⛔ 釘住:
 *   ① 純函式 `_aiPickModel`:清單有 → 原名;沒有 → 同一級;清單空 → 原名(⛔ 不比改版前更糟)
 *   ② `_callGemini` / Groq 呼叫:清單問不到 → 照原名打;第一次回 404 → 清快取、換一個、只重試一次
 *   ③ 靜態:groq chat 只准在 `_groqFetch` 裡打;Gemini generateContent 只准在 `_callGemini` 裡打
 *   ④ 跨檔:index / macro_miner.py / worker.js 三份 Gemini 規則對同一批測資結果一樣
 * ⚠️ 沙箱連不到兩家 API → 一律 stub `safeFetch`,每組都有空過守門(stub 真的被叫到)。
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${String(e).slice(0, 300)}`}`); if (!c) fails.push(n); };
const SRC = process.env.AIPICK_SRC || path.join(ROOT, 'index.html');
const src = fs.readFileSync(SRC, 'utf8');

// ── ③ 靜態 ───────────────────────────────────────────
{
    const A = src.indexOf('async _groqFetch('), B = src.indexOf('_aiErr(provider, status)');
    const hits = []; const re = /api\.groq\.com\/openai\/v1\/chat\/completions/g; let m;
    while ((m = re.exec(src))) hits.push(m.index);
    const out = hits.filter(i => !(A > 0 && B > A && i > A && i < B));
    ok('③a groq chat 只准在 `_groqFetch` 裡打(陷阱 #37)', A > 0 && hits.length >= 1 && out.length === 0, `共 ${hits.length},外面 ${out.length}`);
    const G = src.indexOf('async _callGemini('), G2 = src.indexOf('_getFinmindToken()', G);
    const gh = []; const re2 = /:generateContent/g;
    while ((m = re2.exec(src))) gh.push(m.index);
    const gout = gh.filter(i => !(G > 0 && G2 > G && i > G && i < G2));
    ok('③b Gemini generateContent 只准在 `_callGemini` 裡打', G > 0 && gh.length >= 1 && gout.length === 0, `外面 ${gout.length}`);
    const body = src.slice(G, G2);
    ok('③c `_callGemini` 先經過 `_aiModel`', /await this\._aiModel\('gemini'/.test(body));
    ok('③d `_callGemini` 有模型下架重挑(_aiModelGone)', /_aiModelGone\(res\)/.test(body));
}

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
const tmp = path.join(path.dirname(SRC), '.aipick_tmp.html');
let url = 'file://' + SRC;
if (process.env.AIPICK_SRC) { fs.writeFileSync(tmp, src); url = 'file://' + tmp; }
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._aiPickModel && !!app._groqFetch, null, { timeout: 25000 });

// 跨檔測資(Gemini)
const CASES = [
    [['gemini-2.5-flash', 'gemini-2.0-flash'], 'gemini-2.5-flash'],
    [['models/gemini-2.0-flash', 'models/gemini-3.0-flash', 'models/gemini-3.0-flash-lite'], 'gemini-2.5-flash'],
    [['gemini-3.0-flash-preview-05', 'gemini-2.0-flash-lite', 'gemini-3.0-flash-image'], 'gemini-2.5-flash'],
    [['gemini-2.5-pro', 'text-embedding-004'], 'gemini-2.5-flash'],
    [[], 'gemini-2.5-flash'],
    [['gemini-2.0-flash', 'gemini-2.0-flash-001'], 'gemini-2.5-flash'],
];

// 🤖 V79.5.8 Groq 真清單(10/22 #637 部署 log):llama 全下架,只剩 qwen / gpt-oss / allam + 7 個語音防護類
const REAL_GROQ = ['allam-2-7b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b', 'openai/gpt-oss-120b',
    'whisper-large-v3', 'whisper-large-v3-turbo', 'playai-tts', 'playai-tts-arabic',
    'meta-llama/llama-guard-4-12b', 'meta-llama/llama-prompt-guard-2-22m', 'meta-llama/llama-prompt-guard-2-86m'];
// 跨語言測資:每一份清單都至少有一個偏好序配得到的(⛔ 配不到時 JS 回原名、Python 回硬清單 —— 那是刻意不同的退路)
const QCASES = (() => {
    let seed = 7; const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const shuf = a => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
    const cats = [
        [REAL_GROQ, []], [REAL_GROQ, ['qwen/qwen3.8-27b']], [REAL_GROQ, ['qwen/qwen3.8-27b', 'openai/gpt-oss-20b']],
        [['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', ...REAL_GROQ], []],
        [['llama-4-70b-x', 'qwen/qwen3-32b', 'openai/gpt-oss-120b', 'allam-2-7b'], []],
        [['qwen/qwen3-32b', 'allam-2-7b', 'whisper-large-v3'], []],
    ];
    const out = [];
    for (let k = 0; k < 5; k++) for (const [ids, av] of cats) for (const want of ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile']) out.push([shuf(ids), want, av]);
    return out;
})();
const QNAMES = ['qwen/qwen3.8-27b', 'openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'allam-2-7b', '', 'Qwen/QwQ-32B'];

const R = await page.evaluate(async ({ CASES, REAL, QCASES, QNAMES }) => {
    const o = {};
    const P = (p, ids, w, av) => app._aiPickModel(p, ids, w, av);
    o.q_real = { light: P('groq', REAL, 'llama-3.1-8b-instant'), heavy: P('groq', REAL, 'llama-3.3-70b-versatile'),
                 light2: P('groq', REAL, 'llama-3.1-8b-instant', ['qwen/qwen3.8-27b']), heavy2: P('groq', REAL, 'llama-3.3-70b-versatile', ['qwen/qwen3.8-27b']) };
    o.qx = QCASES.map(([ids, w, av]) => P('groq', ids, w, av));
    o.qex = QNAMES.map(n => [app._groqExtra(n), app._groqBudget(n, 300)]);
    o.g_keep = P('gemini', ['gemini-2.5-flash', 'gemini-3.0-flash'], 'gemini-2.5-flash');
    o.g_up = P('gemini', ['models/gemini-2.0-flash', 'models/gemini-3.0-flash', 'models/gemini-3.0-flash-lite'], 'gemini-2.5-flash');
    o.g_empty = P('gemini', [], 'gemini-2.5-flash');
    o.g_none = P('gemini', ['gemini-2.5-pro'], 'gemini-2.5-flash');
    o.q_heavy = P('groq', ['llama-3.1-8b-instant', 'llama-4-70b-versatile', 'whisper-large-v3'], 'llama-3.3-70b-versatile');
    o.q_light = P('groq', ['llama-3.3-70b-versatile', 'llama-3.2-8b-preview', 'whisper-large-v3'], 'llama-3.1-8b-instant');
    o.q_nonchat = P('groq', ['whisper-large-v3', 'playai-tts'], 'llama-3.1-8b-instant');
    o.q_avoid = P('groq', ['llama-3.3-70b-versatile', 'llama-4-70b-x'], 'llama-3.3-70b-versatile', ['llama-3.3-70b-versatile']);
    o.cases = CASES.map(([ids, w]) => P('gemini', ids, w));

    // ② Gemini 實際呼叫(stub)
    const real = app.safeFetch;
    const keyArr = app._keyArr, gk = app._getGeminiKeys, qk = app._getGroqKeys;
    app._getGeminiKeys = () => ['K1'];
    const okText = { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] }) };
    const gone = { ok: false, status: 404, json: async () => ({ error: { message: 'models/x is not found' } }), text: async () => 'not found' };
    const run = async (models, chat) => {
        app._aiModelClear('gemini');
        const log = { list: 0, chat: [] };
        app.safeFetch = async (u, opt) => {
            u = String(u);
            if (u.includes('/models?')) { log.list++; if (models === null) throw new Error('down'); return { ok: true, status: 200, json: async () => ({ models: models.map(n => ({ name: 'models/' + n, supportedGenerationMethods: ['generateContent'] })) }) }; }
            const m = u.match(/models\/([^:]+):generateContent/); log.chat.push(m && m[1]);
            return chat(m && m[1], log);
        };
        let txt = null, err = null;
        try { txt = await app._callGemini({ prompt: 'x', max_tokens: 8 }); } catch (e) { err = String(e.message || e); }
        return { log, txt, err };
    };
    o.gem_listed = await run(['gemini-2.5-flash', 'gemini-3.0-flash'], () => okText);
    o.gem_down = await run(null, () => okText);
    o.gem_gone = await run(['gemini-2.5-flash', 'gemini-3.0-flash'], (m) => m === 'gemini-2.5-flash' ? gone : okText);
    o.gem_gone2 = await run(['gemini-2.5-flash', 'gemini-3.0-flash'], () => gone);

    // ② Groq(stub)
    const runQ = async (models, chat, want) => {
        app._aiModelClear('groq');
        const log = { list: 0, chat: [] };
        app.safeFetch = async (u, opt) => {
            u = String(u);
            if (u.endsWith('/v1/models')) { log.list++; if (models === null) throw new Error('down'); return { ok: true, status: 200, json: async () => ({ data: models.map(id => ({ id })) }) }; }
            const b = JSON.parse(opt.body); log.chat.push(b.model);
            return chat(b.model);
        };
        const res = await app._groqFetch('K', { model: want, messages: [], max_tokens: 5 }, {});
        return { log, ok: res.ok, status: res.status };
    };
    const qOK = { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) };
    const qDecom = { ok: false, status: 400, clone() { return { text: async () => '{"error":{"code":"model_decommissioned"}}' }; } };
    const qBad = { ok: false, status: 400, clone() { return { text: async () => '{"error":{"message":"context too long"}}' }; } };
    o.q_listed = await runQ(['llama-3.3-70b-versatile'], () => qOK, 'llama-3.3-70b-versatile');
    o.q_down = await runQ(null, () => qOK, 'llama-3.1-8b-instant');
    o.q_decom = await runQ(['llama-3.1-8b-instant', 'llama-3.2-8b-x'], m => m === 'llama-3.1-8b-instant' ? qDecom : qOK, 'llama-3.1-8b-instant');
    o.q_bad = await runQ(['llama-3.1-8b-instant', 'llama-3.2-8b-x'], () => qBad, 'llama-3.1-8b-instant');
    // 🧠 V79.5.8 送出去的那包:每個模型帶自己的參數(呼叫端塞的 high 要被換掉;換模型 ⛔ 不可帶上一個的)
    const runQB = async (models, chat, want, mt) => {
        app._aiModelClear('groq');
        const bodies = [];
        app.safeFetch = async (u, opt) => {
            u = String(u);
            if (u.endsWith('/v1/models')) return { ok: true, status: 200, json: async () => ({ data: models.map(id => ({ id })) }) };
            const b = JSON.parse(opt.body); bodies.push(b);
            return chat(b.model);
        };
        const res = await app._groqFetch('K', { model: want, messages: [], max_tokens: mt, reasoning_effort: 'high' }, {});
        return { bodies, ok: res.ok };
    };
    o.qb_real = await runQB(REAL, () => qOK, 'llama-3.1-8b-instant', 300);
    o.qb_oss = await runQB(['openai/gpt-oss-20b'], () => qOK, 'llama-3.1-8b-instant', 300);
    o.qb_llama = await runQB(['llama-3.1-8b-instant'], () => qOK, 'llama-3.1-8b-instant', 300);
    o.qb_retry = await runQB(REAL, m => m === 'qwen/qwen3.8-27b' ? qDecom : qOK, 'llama-3.1-8b-instant', 300);
    app.safeFetch = real; app._getGeminiKeys = gk; app._getGroqKeys = qk;
    return o;
}, { CASES, REAL: REAL_GROQ, QCASES, QNAMES });

// ① 純函式
ok('①a 清單有原名 → 照用', R.g_keep === 'gemini-2.5-flash', R.g_keep);
ok('①b 原名下架 → 換最新穩定版 flash(⛔ 不挑 lite)', R.g_up === 'gemini-3.0-flash', R.g_up);
ok('①c 清單空 → 原名(⛔ 不比改版前更糟)', R.g_empty === 'gemini-2.5-flash', R.g_empty);
ok('①d 一個 flash 都沒有 → 原名', R.g_none === 'gemini-2.5-flash', R.g_none);
ok('①e Groq 70b 下架 → 換另一個 70b(⛔ 不降成 8b)', R.q_heavy === 'llama-4-70b-versatile', R.q_heavy);
ok('①f Groq 8b 下架 → 換另一個 8b', R.q_light === 'llama-3.2-8b-preview', R.q_light);
ok('①g ⛔ 不挑語音/非聊天模型', R.q_nonchat === 'llama-3.1-8b-instant', R.q_nonchat);
ok('①h avoid 名單生效', R.q_avoid === 'llama-4-70b-x', R.q_avoid);

// ② 實際呼叫
ok('②a Gemini 清單有 → 一次就成功', R.gem_listed.txt === 'OK' && R.gem_listed.log.list === 1 && R.gem_listed.log.chat.join() === 'gemini-2.5-flash', JSON.stringify(R.gem_listed));
ok('②b Gemini 清單問不到 → 照原名打', R.gem_down.txt === 'OK' && R.gem_down.log.chat.join() === 'gemini-2.5-flash', JSON.stringify(R.gem_down));
ok('②c ⭐ Gemini 回 404 → 重問清單、換 3.0、成功', R.gem_gone.txt === 'OK' && R.gem_gone.log.chat.join() === 'gemini-2.5-flash,gemini-3.0-flash' && R.gem_gone.log.list === 2, JSON.stringify(R.gem_gone));
ok('②d 換了還是 404 → 只重試一次 + 人話錯誤', R.gem_gone2.txt === null && R.gem_gone2.log.chat.length === 2 && /下架/.test(R.gem_gone2.err || '') && !/HTTP 404/.test(R.gem_gone2.err || ''), JSON.stringify(R.gem_gone2));
ok('②e Groq 清單有 → 照用', R.q_listed.ok && R.q_listed.log.chat.join() === 'llama-3.3-70b-versatile', JSON.stringify(R.q_listed));
ok('②f Groq 清單問不到 → 照原名打', R.q_down.ok && R.q_down.log.chat.join() === 'llama-3.1-8b-instant', JSON.stringify(R.q_down));
ok('②g ⭐ Groq 400 model_decommissioned → 換一個成功', R.q_decom.ok && R.q_decom.log.chat.join() === 'llama-3.1-8b-instant,llama-3.2-8b-x', JSON.stringify(R.q_decom));
ok('②h Groq 一般 400(內容太長)⛔ 不換模型', !R.q_bad.ok && R.q_bad.log.chat.length === 1, JSON.stringify(R.q_bad));

// 🤖 V79.5.8 llama 全下架之後
ok('①i ⭐ 真清單(沒有 llama)→ 兩層都挑 qwen(⛔ 不可回原名 → 404)', R.q_real.light === 'qwen/qwen3.8-27b' && R.q_real.heavy === 'qwen/qwen3.8-27b', JSON.stringify(R.q_real));
ok('①j qwen 下架 → light 換 gpt-oss-20b、heavy 換 gpt-oss-120b(⛔ 不挑 allam)', R.q_real.light2 === 'openai/gpt-oss-20b' && R.q_real.heavy2 === 'openai/gpt-oss-120b', JSON.stringify(R.q_real));
{
    const b = (R.qb_real.bodies || [])[0] || {};
    ok('②i 真清單一次就成功,送出去的是 qwen + 不思考、額度不動(呼叫端塞的 high 被換掉)', R.qb_real.ok && R.qb_real.bodies.length === 1 && b.model === 'qwen/qwen3.8-27b' && b.reasoning_effort === 'none' && !('include_reasoning' in b) && b.max_tokens === 300, JSON.stringify(R.qb_real));
    const c = (R.qb_oss.bodies || [])[0] || {};
    ok('②j gpt-oss → 低強度、不回傳思考、額度 +400', c.model === 'openai/gpt-oss-20b' && c.reasoning_effort === 'low' && c.include_reasoning === false && c.max_tokens === 700, JSON.stringify(c));
    const d = (R.qb_llama.bodies || [])[0] || {};
    ok('②k 決定性對照:llama ⛔ 一個思考參數都不帶(帶了會被拒)', d.model === 'llama-3.1-8b-instant' && !('reasoning_effort' in d) && !('include_reasoning' in d) && d.max_tokens === 300, JSON.stringify(d));
    const r = R.qb_retry.bodies || [];
    ok('②l qwen 被下架 → 換 gpt-oss-20b 重送,參數跟著換(⛔ 不可帶 qwen 的、額度不可疊)', R.qb_retry.ok && r.length === 2 && r[0].reasoning_effort === 'none' && r[1].model === 'openai/gpt-oss-20b' && r[1].reasoning_effort === 'low' && r[1].max_tokens === 700, JSON.stringify(r.map(x => [x.model, x.reasoning_effort, x.max_tokens])));
}

// ④ 跨檔
{
    const py = execFileSync('python3', ['-c', `
import json,sys; sys.path.insert(0, ${JSON.stringify(ROOT)})
import macro_miner as m
cases=json.loads(sys.stdin.read())
print(json.dumps([m._pick_gemini_model(i,w) for i,w in cases]))`], { input: JSON.stringify(CASES), encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }).trim().split('\n').pop();
    const pyR = JSON.parse(py);
    ok('④a macro_miner._pick_gemini_model == index._aiPickModel', JSON.stringify(pyR) === JSON.stringify(R.cases), `py ${py} / js ${JSON.stringify(R.cases)}`);
    const w = fs.readFileSync(path.join(ROOT, 'cloud-worker/worker.js'), 'utf8');
    const a = w.indexOf('const GEM_BAD'), b = w.indexOf('async function geminiModel');
    const fn = new Function(w.slice(a, b) + '; return pickGeminiModel;')();
    const wR = CASES.map(([ids, want]) => fn(ids, want));
    ok('④b worker.pickGeminiModel == index._aiPickModel', JSON.stringify(wR) === JSON.stringify(R.cases), `${JSON.stringify(wR)} / ${JSON.stringify(R.cases)}`);
    ok('④c worker Gemini 404 會重挑', /r\.status === 404[\s\S]{0,200}geminiModel\(env, \[model\]\)/.test(w));
    // 🤖 V79.5.8 Groq 挑模型 + 每個模型的參數:index == groq_common.py(兩邊註解都寫「必須一致」,這裡真的比)
    const qpy = execFileSync('python3', ['-c', `
import json,sys,re,io,contextlib; sys.path.insert(0, ${JSON.stringify(ROOT)})
import groq_common as G
class _R:
    status_code = 200
    def __init__(s, ids): s._ids = ids
    def json(s): return {'data': [{'id': i} for i in s._ids]}
d = json.loads(sys.stdin.read())
picks = []
for ids, want, av in d['cases']:
    G._cache.update(ids=None, at=0.0, err=''); G._good.clear()
    G.requests.get = lambda *a, _ids=ids, **k: _R(_ids)
    tier = 'heavy' if re.search(r'70b|versatile', want, re.I) else 'light'
    with contextlib.redirect_stdout(io.StringIO()):
        picks.append(G.groq_model(['k'], tier, avoid=set(av)))
ex = [[G.groq_extra(n), G.groq_budget(n, 300)] for n in d['names']]
print(json.dumps({'picks': picks, 'ex': ex}))`], { input: JSON.stringify({ cases: QCASES, names: QNAMES }), encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }).trim().split('\n').pop();
    const qR = JSON.parse(qpy);
    const diff = QCASES.map((c, i) => [i, R.qx[i], qR.picks[i]]).filter(([, a, b]) => a !== b);
    ok(`④d ⭐ Groq 挑模型 index == groq_common.py(${QCASES.length} 份亂序清單 × 兩層)`, R.qx.length === QCASES.length && diff.length === 0, JSON.stringify(diff.slice(0, 3)));
    ok('④d2 空過守門:測資裡真的挑到 qwen 與 gpt-oss 兩種', R.qx.some(x => /qwen/.test(x)) && R.qx.some(x => /gpt-oss/.test(x)), JSON.stringify([...new Set(R.qx)]));
    ok('④e 每個模型的參數 / 額度 index == groq_common.py', JSON.stringify(R.qex) === JSON.stringify(qR.ex), `js ${JSON.stringify(R.qex)} / py ${JSON.stringify(qR.ex)}`);
}

await browser.close();
try { fs.unlinkSync(tmp); } catch (_) {}
console.log(fails.length ? `\n❌ AIPICK_FAIL ${fails.length}` : '\n✅ AIPICK_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
