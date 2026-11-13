#!/usr/bin/env node
/**
 * 🚦 AI 失敗分類 + 冷卻記在模型上 + 白話狀態 + 連點去重(2026-11-13)
 *
 * 🐛 以前每一個 429 都當同一件事:等 2~5 秒換下一把、整家供應商冷卻 30 秒(localStorage aiCooldown_*),
 *    畫面寫「撞 429」;錯誤回應的內容一個字都沒讀,404 一律當模型下架。
 *    → 今天額度用完的模型每 30 秒又被打一次、同一家還有額度的模型被一起擋掉、看不出要等多久 / 要不要處理。
 * ⭐ 規則照抄 skl ai-model-router(model_router.js,commit 2dc9408),兩邊跑同一份案例:
 *    scripts/fixtures/ai_router_cases.json(= skl 的 assets/router_cases.json 原檔,⛔ 手改)
 *
 * ⛔ 釘住:
 *   ⓪ 靜態:註明規則來源 + 「改規則兩邊一起改」;四個正規表示式 == groq_common.py(逐字);
 *      整家冷卻 30 秒(_isProviderCoolingDown / aiCooldown_)⛔ 復活;三個入口都帶 raw429;顯示文字 ⛔「撞 429」
 *   ① 共用案例:delays / text_delays / classify(直接呼叫 app._AIR,也用真的 Response 走 _aiErrBody → ⛔ 只看狀態碼)
 *      + Python(groq_common)跑同一份 → 結果一樣;另外點名使用者指定的那幾條(TPD → quota、"5m" = 300 秒 …)
 *   ② Groq 某個模型今天額度用完 → 同一次馬上換同一家下一個模型;下一次直接用沒冷卻的(⛔ 整家跳過、⛔ 再打用完的);
 *      冷卻分金鑰記、⛔ 存金鑰本身
 *   ③ 餘額不足(OpenRouter 402)→ 停用那把金鑰、白話「帳戶餘額不足 → 去帳單頁看看」;下一次一個請求都不送
 *   ④ 白話:chip「Groq 今天額度用完(約 HH:MM 恢復)→ 已改用 Gemini」「太頻繁,N 秒後再試」(真的等完再試同一個);
 *      限流要等很久 → 冷卻那個模型、換下一個;⛔ 🔴🟢、⛔「撞 429」、要過 lib_retailbad 的 badOf
 *   ⑤ 設定「📡 AI 現在狀態」:一列一筆(第幾把・模型・原因・還要多久);「現在再試」≥44×44,按下去那一筆消失、下一次真的再試
 *   ⑥ 連點兩下同一題 → 只打一次 API、兩個拿到同一個 Promise;回來之後再問 → 照常再打(⛔ 快取結果)
 *   ⑦ 390px:「AI 現在狀態」那一區 + chip ⛔ 橫向溢出(逐元素跟父層比 + 真的去捲,⛔ scrollWidth)
 *   ⑧ 404 有說模型不存在 → 換模型;沒說(網址錯 / HTML)→ ⛔ 換模型、⛔ 作廢模型清單、白話說是網址
 *   ⑨ 無 pageerror
 *
 * 🧪 INJECT(注入缺陷,必紅):
 *   INJECT=all429rate  每個 429 都當限流(= 舊行為)              → ① ② 紅
 *   INJECT=provider    冷卻記在整把金鑰上(= 整家冷卻)           → ② 紅
 *   INJECT=nodedup     連點不去重                               → ⑥ 紅
 *   INJECT=nobody      ⛔ 讀回應內容(= 舊行為只看 res.status)    → ① ② 紅
 * ⚠️ 沙箱連不到三家 API → 一律 stub `safeFetch`(回真的 Response 物件);每組都有空過守門(stub 真的被叫到)。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { badOf } from './lib_retailbad.mjs';
import { rwdShim } from './lib_rwdshim.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'scripts', 'fixtures', 'ai_router_cases.json');
const C = JSON.parse(fs.readFileSync(FIX, 'utf8'));
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 400)}`); if (!c) fails.push(n); };

// ── 注入 ──
const SRC0 = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const INJ = {
    all429rate: ["return { kind: longWindow ? 'quota' : 'rate', delay };", "return { kind: 'rate', delay };"],
    provider: ["_aiCoolId(provider, key, model) { return `${provider}|${this._aiKh(key)}|${model || '*'}`; },",
        "_aiCoolId(provider, key, model) { return `${provider}|${this._aiKh(key)}|*`; },"],
    nodedup: ['        if (m.has(k)) return m.get(k);\n', ''],
    nobody: ["    async _aiErrBody(res) {\n        if (!res || typeof res !== 'object') return {};", '    async _aiErrBody(res) {\n        return {};'],
};
let HTML = path.join(ROOT, 'index.html'), SRC = SRC0;
const TMP = path.join(ROOT, '.test_ai429.html');   // /.test_*.html 在 .gitignore 裡
if (process.env.INJECT) {
    const inj = INJ[process.env.INJECT];
    if (!inj || SRC0.split(inj[0]).length !== 2) { console.error(`❌ INJECT=${process.env.INJECT} 的注入點找不到(或不只一處)`); process.exit(1); }
    SRC = SRC0.replace(inj[0], inj[1]);
    fs.writeFileSync(TMP, SRC);
    HTML = TMP;
    console.log(`🧪 INJECT=${process.env.INJECT}:${inj[0].trim().slice(0, 60)}…`);
}
const CODE = SRC.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

// ── ⓪ 靜態 ──
{
    const i = SRC.indexOf('    _AIR: (() => {');
    const head = SRC.slice(Math.max(0, i - 2500), i);
    ok('⓪a 註明規則來源(skl model_router.js、commit 2dc9408)+「改規則兩邊一起改」',
        i > 0 && /ai-model-router\/assets\/model_router\.js/.test(head) && /2dc9408/.test(head) && /改規則兩邊一起改/.test(head));
    const gc = fs.readFileSync(path.join(ROOT, 'groq_common.py'), 'utf8');
    ok('⓪b groq_common.py 也註明來源(skl scripts/model_router.py、2dc9408)+「改規則兩邊一起改」',
        /ai-model-router\/scripts\/model_router\.py/.test(gc) && /2dc9408/.test(gc) && /改規則兩邊一起改/.test(gc));
    ok('⓪c 整家冷卻 30 秒那層⛔ 復活(_isProviderCoolingDown / _markProviderCoolingDown / 寫 aiCooldown_)',
        !/_isProviderCoolingDown|_markProviderCoolingDown/.test(CODE) && !/setItem\(`aiCooldown_/.test(CODE));
    const fnBody = (sig, end) => { const a = SRC.indexOf(sig); const b = SRC.indexOf(end, a + 1); return a > 0 && b > a ? SRC.slice(a, b) : ''; };
    const gq = fnBody('    async _groqFetch(', '    _aiErr(provider, status) {'), orc = fnBody('    async _orChat(', '    _orErr(status) {'),
        gem = fnBody('    async _callGemini(', '    _getFinmindToken() {');
    ok('⓪d 三個 AI 入口都帶 raw429(⛔ 讓 safeFetch 的通用 429 退避白等、跳看不出原因的 toast)',
        /raw429: true/.test(gq) && /raw429: true/.test(orc) && /raw429: true/.test(gem), [gq.length, orc.length, gem.length]);
    ok('⓪e safeFetch 認得 raw429', /raw429 && res\.status === 429\) return res;/.test(SRC));
    const shown = ['    _setAIStatus(', '    _aiPlain(', '    _renderAICoolList(', '    _aiSummary('].map(s => fnBody(s, '\n    },')).join('\n');
    ok('⓪f chip / 白話 / 狀態列表的程式裡⛔「撞 429」、⛔ 🔴🟢', shown.length > 2000 && !/撞 ?429/.test(shown) && !/[🔴🟢]/u.test(shown), shown.length);
}

// ── ① Python 那一份(groq_common)跑同一份案例 + 拿正規表示式出來逐字比 ──
let PY = null;
try {
    const out = execFileSync('python3', ['-c', `
import json, sys
sys.path.insert(0, ${JSON.stringify(ROOT)})
import groq_common as G
C = json.load(open(${JSON.stringify(FIX)}, encoding='utf-8'))
cls = []
for c in C['classify']:
    s = json.loads(json.dumps(C['samples'][c['sample']]))
    cls.append(G.classify(s['status'], G.with_headers(s.get('body') or {}, s.get('headers')), c.get('now', C['now'])))
print(json.dumps({'cls': cls, 're': {k: [getattr(G, k).pattern, bool(getattr(G, k).flags & 2)] for k in ('MODEL_MISSING', 'BILLING', 'LONG_WINDOW', 'TEXT_DELAY')}}))
`], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }).trim().split('\n').pop();
    PY = JSON.parse(out);
} catch (e) { PY = { err: String(e.message || e).slice(0, 300) }; }

// ── 瀏覽器 ──
let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const EXE = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(EXE) ? { executablePath: EXE } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', e => errs.push((e && e.message) || String(e)));
await page.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
await page.goto('file://' + HTML, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => typeof app !== 'undefined' && !!app._AIR && !!app._groqFetch && !!app._aiCoolAll, null, { timeout: 60000 });
await page.waitForTimeout(1200);

// 假的三家 API:回真的 Response 物件(clone / headers.get / json 都跟正式環境一樣)
await page.evaluate((C) => {
    const A = app;
    const S = window.__S = { posts: [], lists: { groq: 0, gemini: 0, openrouter: 0 }, script: {}, gate: null, C };
    S.ids = {
        groq: ['qwen/qwen3.8-27b', 'openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'allam-2-7b', 'whisper-large-v3'],
        gemini: ['gemini-2.5-flash', 'gemini-2.0-flash'],
        openrouter: ['deepseek/deepseek-r1-0528:free', 'meta-llama/llama-3.1-8b-instruct:free'],
    };
    const chip = () => { const c = document.getElementById('aiStatusChip'), t = document.getElementById('aiStatusChipText'); return c && !c.classList.contains('hidden') && t ? t.textContent : ''; };
    const J = (o, status = 200, headers = {}) => new Response(typeof o === 'string' ? o : JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', ...headers } });
    S.mk = (spec, provider, model) => {
        if (!spec || spec === 'ok') {
            const text = 'ok:' + model;
            return provider === 'gemini' ? J({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }) : J({ choices: [{ message: { content: text } }] });
        }
        const s = typeof spec === 'string' ? C.samples[spec] : spec;
        const b = s.body || {};
        const raw = b && typeof b._raw === 'string' && Object.keys(b).length === 1 ? b._raw : JSON.stringify(b);
        // 狀態 0(網路斷線)Response 造不出來 → 用長得一樣的物件(只給分類那條用)
        if (s.status < 200) return { ok: false, status: s.status, headers: new Headers(s.headers || {}), clone() { return this; }, text: async () => raw, json: async () => JSON.parse(raw) };
        return new Response(raw, { status: s.status, headers: s.headers || {} });
    };
    S.reset = (script = {}) => {
        S.posts = []; S.script = JSON.parse(JSON.stringify(script)); S.lists = { groq: 0, gemini: 0, openrouter: 0 };
        try { localStorage.removeItem('aiCool_v1'); } catch (_) {}
        A._aiModelClear('groq'); A._aiModelClear('gemini'); A._orModelClear();
        A._aiInflight = null;
    };
    A.safeFetch = async (url, opt = {}, fo = {}) => {
        url = String(url);
        if (/api\.groq\.com\/openai\/v1\/models$/.test(url)) { S.lists.groq++; return J({ data: S.ids.groq.map(id => ({ id })) }); }
        if (/generativelanguage\.googleapis\.com\/v1beta\/models\?/.test(url)) { S.lists.gemini++; return J({ models: S.ids.gemini.map(n => ({ name: 'models/' + n, supportedGenerationMethods: ['generateContent'] })) }); }
        if (/openrouter\.ai\/api\/v1\/models/.test(url)) { S.lists.openrouter++; return J({ data: S.ids.openrouter.map(id => ({ id })) }); }
        let provider, model, key;
        const h = opt.headers || {};
        if (url.includes('api.groq.com')) { provider = 'groq'; model = JSON.parse(opt.body).model; key = String(h.Authorization || '').replace(/^Bearer /, ''); }
        else if (url.includes('generativelanguage')) { provider = 'gemini'; model = decodeURIComponent((url.match(/models\/([^/:]+):/) || [])[1] || ''); key = h['x-goog-api-key']; }
        else if (url.includes('openrouter.ai')) { provider = 'openrouter'; model = JSON.parse(opt.body).model; key = String(h.Authorization || '').replace(/^Bearer /, ''); }
        else return new Response('{}', { status: 404 });
        S.posts.push({ provider, model, key, raw429: !!fo.raw429, chip: chip(), t: Date.now() });
        if (S.gate) await S.gate;
        const q = S.script[`${provider}:${model}`] || S.script[`${provider}:*`];
        const spec = Array.isArray(q) ? (q.length > 1 ? q.shift() : q[0]) : q;
        return S.mk(spec, provider, model);
    };
    A.showToast = () => {};
    A.settings.aiEngine = 'auto';
    A.settings.aiPreferGroq = true;
    S.keys = (g, m, o) => {
        A.settings.groqKeys = g.map(k => ({ k, on: true }));
        A.settings.geminiKeys = m.map(k => ({ k, on: true }));
        A.settings.openrouterKeys = o.map(k => ({ k, on: true }));
    };
}, C);

// ── ① 共用案例(JS)──
const R1 = await page.evaluate(async (C) => {
    const A = app.__proto__ ? app : app, X = app._AIR, out = { delays: [], text: [], cls: [], viaRes: [] };
    const sample = item => JSON.parse(JSON.stringify(typeof item === 'string' ? C.samples[item] : item));
    for (const c of C.delays) out.delays.push(X.parseDelay(c.value, c.now));
    for (const c of C.text_delays) out.text.push(X.textDelay(c.text));
    for (const c of C.classify) {
        const s = sample(c.sample);
        out.cls.push(X.classify(s.status, X.withHeaders(s.body || {}, s.headers), c.now != null ? c.now : C.now));
        // 同一筆用真的 Response 物件走正式的讀法(_aiErrBody:讀內容 + 併標頭)→ ⛔ 只看狀态碼
        const r = window.__S.mk(sample(c.sample), 'groq', 'm');
        const body = await A._aiErrBody(r);
        out.viaRes.push(X.classify(s.status, body, c.now != null ? c.now : C.now));
        // 讀過之後原本的 body 還要讀得到(用 clone 讀;⛔ 把呼叫端的 res.json() 弄壞)
        if (!out.bodyLeft) { try { await r.text(); out.bodyLeft = true; } catch (_) { out.bodyLeft = false; } }
    }
    out.re = Object.fromEntries(['MODEL_MISSING', 'BILLING', 'LONG_WINDOW', 'TEXT_DELAY'].map(k => [k, [X[k].source, X[k].ignoreCase]]));
    return out;
}, C);
const same = (a, b) => (a == null || b == null ? a == null && b == null : Math.abs(a - b) < 1e-6);
const show = v => (v == null ? 'null' : String(v));
let bad = C.delays.map((c, i) => [c, R1.delays[i]]).filter(([c, g]) => !same(g, c.seconds));
ok(`①a 等待時間 ${C.delays.length} 條(5m=300 秒、520ms、1m30s、HTTP 日期、看不懂不猜…)`, C.delays.length >= 18 && !bad.length, bad.map(([c, g]) => `${c.name}:期望 ${show(c.seconds)} 得到 ${show(g)}`).join(';'));
bad = C.text_delays.map((c, i) => [c, R1.text[i]]).filter(([c, g]) => !same(g, c.seconds));
ok(`①b 訊息裡的等待時間 ${C.text_delays.length} 條(try again in 7m26.4s …)`, C.text_delays.length >= 6 && !bad.length, bad.map(([c, g]) => `${c.text}:期望 ${show(c.seconds)} 得到 ${show(g)}`).join(';'));
const clsBad = arr => C.classify.map((c, i) => [c, arr[i]]).filter(([c, g]) => !(g && g.kind === c.kind && same(g.delay, c.delay)));
bad = clsBad(R1.cls);
ok(`①c 分類 ${C.classify.length} 條(billing / missing / config / auth / quota / rate / server / other)`, C.classify.length >= 30 && !bad.length, bad.map(([c, g]) => `${c.name}:期望 ${c.kind} ${show(c.delay)} 得到 ${g && g.kind} ${show(g && g.delay)}`).join(';'));
bad = clsBad(R1.viaRes);
ok('①d ⭐ 用真的 Response 走 _aiErrBody 也一樣(錯誤回應的 JSON 有讀、Retry-After 標頭有併進來)', !bad.length, bad.map(([c, g]) => `${c.name}:得到 ${g && g.kind} ${show(g && g.delay)}`).join(';'));
ok('①e _aiErrBody 用 clone 讀 → 呼叫端之後還讀得到原本的 body', R1.bodyLeft === true, R1.bodyLeft);
const pick = name => { const i = C.classify.findIndex(c => c.sample === name); return i < 0 ? null : R1.viaRes[i]; };
ok('①f 點名:Groq「tokens per day (TPD)」→ quota(7m26.4s = 446.4 秒)', JSON.stringify(pick('groq_tpd')) === JSON.stringify({ kind: 'quota', delay: 446.4 }), JSON.stringify(pick('groq_tpd')));
ok('①f 點名:"5m" = 300 秒(⛔ 5 秒)', R1.delays[C.delays.findIndex(c => c.value === '5m')] === 300);
ok('①f 點名:Gemini 每分鐘(訊息寫 exceeded your current quota、quotaId PerMinute)→ rate 17 秒', JSON.stringify(pick('gemini_minute')) === JSON.stringify({ kind: 'rate', delay: 17 }), JSON.stringify(pick('gemini_minute')));
ok('①f 點名:Gemini quotaValue "0" → quota(retryDelay ⛔ 採用)', JSON.stringify(pick('gemini_limit_zero')) === JSON.stringify({ kind: 'quota', delay: null }), JSON.stringify(pick('gemini_limit_zero')));
ok('①f 點名:402 / 帳單文字 → billing', pick('openrouter_402')?.kind === 'billing' && pick('anthropic_credit')?.kind === 'billing' && pick('openai_insufficient_quota')?.kind === 'billing');
ok('①f 點名:404 有說模型不存在 → missing;沒說(網址錯 / HTML / {"detail"})→ config',
    ['groq_404_model', 'gemini_404_model', 'openrouter_404_endpoints'].every(s => pick(s)?.kind === 'missing') && ['groq_404_url', 'fastapi_404', 'html_404'].every(s => pick(s)?.kind === 'config'));
if (PY && PY.cls) {
    const diff = C.classify.map((c, i) => [c.name, R1.cls[i], PY.cls[i]]).filter(([, a, b]) => !(a && b && a.kind === b.kind && same(a.delay, b.delay)));
    ok(`①g ⭐ Python(groq_common.classify)跑同一份 ${C.classify.length} 條 == index.html`, PY.cls.length === C.classify.length && !diff.length, JSON.stringify(diff.slice(0, 3)));
    const rd = Object.keys(R1.re).filter(k => JSON.stringify(R1.re[k]) !== JSON.stringify(PY.re[k]));
    ok('①h ⭐ 四個正規表示式(模型不存在 / 帳單 / 每日額度 / 等待時間)兩邊逐字一樣(改規則兩邊一起改)', !rd.length, rd.map(k => `${k}: js ${R1.re[k][0].slice(0, 60)} / py ${(PY.re[k] || [''])[0].slice(0, 60)}`).join(';'));
} else ok('①g Python(groq_common)跑得起來', false, PY && PY.err);

// ── ② Groq 某個模型今天額度用完 → 換同一家下一個模型;下一次直接用沒冷卻的 ──
const R2 = await page.evaluate(async () => {
    const S = window.__S, A = app, o = {};
    S.keys(['gk-test-1'], ['gm-test-1'], []);
    S.reset({ 'groq:qwen/qwen3.8-27b': 'groq_tpd' });
    const t0 = Date.now();
    try { o.r1 = await A._callAI({ prompt: '② 第一題' }); } catch (e) { o.e1 = String(e.message); }
    o.p1 = S.posts.map(p => `${p.provider}:${p.model}`);
    o.raw429 = S.posts.every(p => p.raw429);
    const all = A._aiCoolAll();
    o.cool = Object.values(all).map(c => ({ p: c.p, m: c.m, k: c.k, left: Math.round((c.u - t0) / 1000) }));
    o.lsRaw = localStorage.getItem('aiCool_v1') || '';
    o.keyCool = !!A._aiCoolGet('groq', 'gk-test-1', '*');
    o.otherKey = A._aiCoolModels('groq', 'gk-test-2');
    o.thisKey = A._aiCoolModels('groq', 'gk-test-1');
    S.posts = [];
    try { o.r2 = await A._callAI({ prompt: '② 第二題' }); } catch (e) { o.e2 = String(e.message); }
    o.p2 = S.posts.map(p => `${p.provider}:${p.model}`);
    o.oldKey = ['groq', 'gemini', 'openrouter'].some(p => localStorage.getItem(`aiCooldown_${p}`) != null);
    return o;
});
ok('②a ⭐ qwen 今天額度用完 → 同一次馬上換 gpt-oss-20b(還是 Groq,⛔ 跑去 Gemini)',
    R2.r1 === 'ok:openai/gpt-oss-20b' && JSON.stringify(R2.p1) === JSON.stringify(['groq:qwen/qwen3.8-27b', 'groq:openai/gpt-oss-20b']), JSON.stringify(R2));
ok('②b ⭐ 下一次直接用 gpt-oss-20b(⛔ 再打一次用完的 qwen、⛔ 整家跳過)',
    R2.r2 === 'ok:openai/gpt-oss-20b' && JSON.stringify(R2.p2) === JSON.stringify(['groq:openai/gpt-oss-20b']), JSON.stringify(R2.p2) + ' ' + (R2.e2 || ''));
ok('②c 冷卻記在模型上:qwen・quota・照 Groq 說的 7m26.4s(至少 5 分鐘),整把金鑰⛔ 被停',
    R2.cool.length === 1 && R2.cool[0].m === 'qwen/qwen3.8-27b' && R2.cool[0].k === 'quota' && R2.cool[0].left >= 440 && R2.cool[0].left <= 450 && !R2.keyCool, JSON.stringify(R2.cool));
ok('②d 冷卻分金鑰記(第 2 把⛔ 被第 1 把連累)、localStorage ⛔ 存金鑰本身',
    JSON.stringify(R2.thisKey) === '["qwen/qwen3.8-27b"]' && R2.otherKey.length === 0 && R2.lsRaw && !R2.lsRaw.includes('gk-test-1'), R2.lsRaw);
ok('②e 每一次 AI 請求都帶 raw429(交給分類處理)、舊的 aiCooldown_* ⛔ 寫', R2.raw429 && !R2.oldKey);

// ── ③ 餘額不足 → 停用那把金鑰、白話提醒看帳單;下一次一個請求都不送 ──
const R3 = await page.evaluate(async () => {
    const S = window.__S, A = app, o = {};
    S.keys([], [], ['or-test-1']);
    S.reset({ 'openrouter:*': 'openrouter_402' });
    try { await A._callAI({ prompt: '③ 第一題' }); o.r1 = 'no-throw'; } catch (e) { o.e1 = String(e.message); }
    o.chip1 = document.getElementById('aiStatusChipText').textContent;
    o.p1 = S.posts.length;
    o.keyCool = A._aiCoolGet('openrouter', 'or-test-1', '*');
    S.posts = [];
    try { await A._callAI({ prompt: '③ 第二題' }); } catch (e) { o.e2 = String(e.message); }
    o.p2 = S.posts.length;
    o.friendly = A._aiFriendlyError(o.e1 || '');
    A.settings.aiEngine = 'openrouter';
    S.posts = [];
    try { await A._callAI({ prompt: '③ 指定 OpenRouter' }); } catch (e) { o.e3 = String(e.message); }
    o.p3 = S.posts.length;
    A.settings.aiEngine = 'auto';
    return o;
});
ok('③a 402 → 白話「OpenRouter 帳戶餘額不足 → 去帳單頁看看」(⛔ 狀態碼、⛔「撞 429」)',
    /^AI 暫時都不能用:OpenRouter 帳戶餘額不足 → 去帳單頁看看/.test(R3.e1 || '') && !/\b402\b|429/.test(R3.e1 || '') && R3.p1 === 1, JSON.stringify(R3));
ok('③b 停用那把金鑰(整把冷卻 billing);下一次一個請求都不送,原因照講', R3.keyCool && R3.keyCool.k === 'billing' && R3.p2 === 0 && /帳戶餘額不足/.test(R3.e2 || ''), JSON.stringify([R3.keyCool, R3.p2, R3.e2]));
ok('③c chip 講白話(帳單)', /帳戶餘額不足 → 去帳單頁看看/.test(R3.chip1) && !/撞|429/.test(R3.chip1), R3.chip1);
ok('③d 指定只用 OpenRouter 時也一樣停下(0 個請求)、講白話', R3.p3 === 0 && /^OpenRouter 帳戶餘額不足/.test(R3.e3 || ''), JSON.stringify([R3.p3, R3.e3]));
ok('③e _aiFriendlyError 照原句(⛔ 改寫成籠統的「全部撞限流」)', /^⚠️ AI 暫時都不能用:OpenRouter 帳戶餘額不足/.test(R3.friendly || ''), R3.friendly);

// ── ④ 白話 chip:Groq 每個模型都用完 → 改用 Gemini;太頻繁 → 等完再試同一個;等很久 → 冷卻、換下一個 ──
const R4 = await page.evaluate(async () => {
    const S = window.__S, A = app, o = {};
    S.keys(['gk-test-1'], ['gm-test-1'], []);
    S.reset({ 'groq:qwen/qwen3.8-27b': 'groq_tpd', 'groq:openai/gpt-oss-20b': 'groq_rpd', 'groq:openai/gpt-oss-120b': 'groq_tpd' });
    try { o.r1 = await A._callAI({ prompt: '④ 全部用完' }); } catch (e) { o.e1 = String(e.message); }
    o.p1 = S.posts.map(p => `${p.provider}:${p.model}`);
    const gem = S.posts.find(p => p.provider === 'gemini');
    o.chipAtGemini = gem ? gem.chip : '';
    const soon = A._aiCoolSoonest('groq', 'gk-test-1');
    o.expect = `🔄 Groq ${A._aiPlain({ kind: 'quota', until: soon.u })}→ 已改用 Gemini`;
    o.soonLeft = Math.round((soon.u - Date.now()) / 1000);
    // 每個候選都在冷卻 → 下一次 Groq 一個請求都不送(⛔ 白打清單上沒有的舊名字 llama-3.1-8b-instant 才發現),直接 Gemini
    S.posts = [];
    try { o.r1b = await A._callAI({ prompt: '④ 全部用完 第二題' }); } catch (e) { o.e1b = String(e.message); }
    o.p1b = S.posts.map(p => `${p.provider}:${p.model}`);
    o.chip1b = (S.posts.find(p => p.provider === 'gemini') || {}).chip || '';
    // 太頻繁:對方說 1 秒 → 等 1 秒再試同一個(chip 寫「太頻繁,1 秒後再試」)
    const tpm1 = JSON.parse(JSON.stringify(S.C.samples.groq_tpm)); tpm1.headers = { 'retry-after': '1' };
    S.reset({ 'groq:qwen/qwen3.8-27b': [tpm1, 'ok'] });
    const t0 = Date.now();
    try { o.r2 = await A._callAI({ prompt: '④ 太頻繁' }); } catch (e) { o.e2 = String(e.message); }
    o.p2 = S.posts.map(p => `${p.provider}:${p.model}`);
    o.gap = S.posts.length > 1 ? S.posts[1].t - S.posts[0].t : -1;
    o.chipWait = S.posts.length > 1 ? S.posts[1].chip : '';
    o.cool2 = Object.keys(A._aiCoolAll()).length;
    // 等很久(Retry-After 是 2 分鐘後的日期)→ ⛔ 卡住等,冷卻 qwen、換 gpt-oss-20b
    const later = { status: 429, headers: { 'Retry-After': new Date(Date.now() + 120e3).toUTCString() }, body: { _raw: 'Too Many Requests' } };
    S.reset({ 'groq:qwen/qwen3.8-27b': later });
    const t3 = Date.now();
    try { o.r3 = await A._callAI({ prompt: '④ 等很久' }); } catch (e) { o.e3 = String(e.message); }
    o.ms3 = Date.now() - t3;
    o.p3 = S.posts.map(p => `${p.provider}:${p.model}`);
    o.cool3 = Object.values(A._aiCoolAll()).map(c => ({ m: c.m, k: c.k, left: Math.round((c.u - Date.now()) / 1000) }));
    // 白話句子本身(使用者給的範例)
    o.plain = {
        rate20: A._aiPlain({ kind: 'rate', wait: 20 }),
        quota: A._aiPlain({ kind: 'quota', until: Date.now() + 3600e3 }),
        billing: A._aiErr('openrouter', { kind: 'billing' }),
        errs: ['quota', 'rate', 'billing', 'auth', 'missing', 'config', 'server', 'other'].map(k => A._aiErr('groq', { kind: k, until: Date.now() + 600e3, delay: 30 })),
        legacy: [404, 400, 401, 429, 503].map(s => A._aiErr('gemini', s)),
        clock: A._aiClock(Date.parse('2026-11-13T06:05:00Z')),
    };
    // 全部失敗的 chip(多家)
    S.keys(['gk-test-1'], ['gm-test-1'], ['or-test-1']);
    S.reset({ 'groq:*': 'groq_tpd', 'gemini:*': 'gemini_day', 'openrouter:*': 'openrouter_402' });
    try { await A._callAI({ prompt: '④ 全部失敗' }); } catch (e) { o.e5 = String(e.message); }
    o.chipFail = document.getElementById('aiStatusChipText').textContent;
    o.chipCls = document.getElementById('aiStatusChip').className;
    return o;
});
ok('④a ⭐ Groq 每個模型都用完 → chip「Groq 今天額度用完(約 HH:MM 恢復)→ 已改用 Gemini」,HH:MM = 最快恢復的那一個',
    R4.r1 === 'ok:gemini-2.5-flash' && R4.chipAtGemini === R4.expect && /今天額度用完\(約 (明天 )?\d{2}:\d{2} 恢復\)→ 已改用 Gemini$/.test(R4.chipAtGemini) && R4.soonLeft >= 295 && R4.soonLeft <= 305,
    JSON.stringify({ chip: R4.chipAtGemini, expect: R4.expect, p: R4.p1, left: R4.soonLeft }));
ok('④b Groq 那家最多打 3 次就換(⛔ 一個模型一個模型打到天荒地老)', R4.p1.filter(x => x.startsWith('groq:')).length === 3, JSON.stringify(R4.p1));
ok('④b2 ⭐ 每個 Groq 模型都在冷卻 → 下一次 Groq 0 個請求(整家才跳過)、直接 Gemini、chip 照講原因',
    R4.r1b === 'ok:gemini-2.5-flash' && JSON.stringify(R4.p1b) === '["gemini:gemini-2.5-flash"]' && R4.chip1b === R4.expect, JSON.stringify({ p: R4.p1b, chip: R4.chip1b, e: R4.e1b }));
ok('④c ⭐ 太頻繁(對方說 1 秒)→ chip「⏳ Groq 太頻繁,1 秒後再試」、真的等完再試同一個、⛔ 記冷卻',
    R4.r2 === 'ok:qwen/qwen3.8-27b' && JSON.stringify(R4.p2) === JSON.stringify(['groq:qwen/qwen3.8-27b', 'groq:qwen/qwen3.8-27b']) && R4.gap >= 950 && R4.chipWait === '⏳ Groq 太頻繁,1 秒後再試' && R4.cool2 === 0,
    JSON.stringify({ p: R4.p2, gap: R4.gap, chip: R4.chipWait, cool: R4.cool2 }));
ok('④d 要等很久(2 分鐘)→ ⛔ 卡住等:冷卻 qwen 約 2 分鐘、馬上換 gpt-oss-20b',
    R4.r3 === 'ok:openai/gpt-oss-20b' && R4.ms3 < 5000 && R4.cool3.length === 1 && R4.cool3[0].k === 'rate' && R4.cool3[0].left >= 110 && R4.cool3[0].left <= 121,
    JSON.stringify({ r: R4.r3, ms: R4.ms3, cool: R4.cool3, p: R4.p3 }));
ok('④e 使用者給的句子:「太頻繁,20 秒後再試」「今天額度用完(約 HH:MM 恢復)」「帳戶餘額不足 → 去帳單頁看看」',
    R4.plain.rate20 === '太頻繁,20 秒後再試' && /^今天額度用完\(約 (明天 )?\d{2}:\d{2} 恢復\)$/.test(R4.plain.quota) && R4.plain.billing === 'OpenRouter 帳戶餘額不足 → 去帳單頁看看', JSON.stringify(R4.plain));
ok('④f 恢復時間用台北時間(06:05Z = 14:05)', /14:05$/.test(R4.plain.clock), R4.plain.clock);
ok('④g 八種原因的句子都不一樣、⛔ 狀態碼 / HTTP / 撞 429', new Set(R4.plain.errs).size === 8 && R4.plain.errs.every(s => !/HTTP|\b\d{3}\b|撞/.test(s)), JSON.stringify(R4.plain.errs));
ok('④h 只有狀態碼的舊呼叫照樣講白話(404 仍講下架;429 講太頻繁)', /下架/.test(R4.plain.legacy[0]) && /太頻繁/.test(R4.plain.legacy[3]) && R4.plain.legacy.every(s => !/HTTP|撞/.test(s)), JSON.stringify(R4.plain.legacy));
ok('④i 全部失敗 → chip 一次講完每一家的原因(Groq 額度 / Gemini 額度 / OpenRouter 帳單)',
    /^⚠️ AI 暫時都不能用:Groq 今天額度用完.*;Gemini 今天額度用完.*;OpenRouter 帳戶餘額不足/.test(R4.chipFail) && R4.e5 && R4.chipFail.includes(R4.e5), JSON.stringify([R4.chipFail, R4.e5]));
ok('④j 失敗的 chip ⛔ 紅綠(燈號鐵則)', !/\b(red|green|emerald|rose)-\d/.test(R4.chipCls), R4.chipCls);

// ── ⑤ 設定「📡 AI 現在狀態」+「現在再試」──
await page.evaluate(async () => {
    const S = window.__S, A = app;
    S.keys(['gk-test-1', 'gk-test-2'], ['gm-test-1'], ['or-test-1']);
    S.reset({});
    A._aiCoolSet('groq', 'gk-test-2', 'qwen/qwen3.8-27b', 'quota', 446.4);
    A._aiCoolSet('gemini', 'gm-test-1', 'gemini-2.5-flash', 'rate', 40);
    A._aiCoolSet('openrouter', 'or-test-1', '*', 'billing', null);
    A._aiCoolSet('groq', 'gk-removed', 'openai/gpt-oss-20b', 'quota', null);   // 金鑰已經刪掉的那筆 → 要順手清掉
    A.openSettings();
    const d = document.querySelector('details[data-setgrp="keys"]'); if (d) d.open = true;
    A._renderAICoolList();
});
const R5 = await page.evaluate(() => {
    const box = document.getElementById('aiCoolList');
    const rows = [...box.querySelectorAll('[data-aicool-row]')].map(r => r.innerText.replace(/\s+/g, ' ').trim());
    const btns = [...box.querySelectorAll('button[data-aicool]')].map(b => { const r = b.getBoundingClientRect(); return { w: r.width, h: r.height, id: b.dataset.aicool }; });
    const sum = (document.getElementById('setGrpSum_keys') || {}).textContent || '';
    return { rows, btns, text: box.innerText, sum, left: Object.keys(app._aiCoolAll()).length };
});
ok('⑤a 一列一筆:第幾把・模型・原因・還要多久(幾點恢復);金鑰已刪掉的那筆清掉',
    R5.rows.length === 3 && /Groq 第 2 把・qwen\/qwen3\.8-27b/.test(R5.rows[0]) && /今天額度用完・還要約 7 分鐘\((明天 )?\d{2}:\d{2} 恢復\)/.test(R5.rows[0])
    && /Gemini 第 1 把・gemini-2\.5-flash/.test(R5.rows[1]) && /太頻繁/.test(R5.rows[1]) && /還要 \d+ 秒/.test(R5.rows[1])
    && /OpenRouter 第 1 把・整把金鑰/.test(R5.rows[2]) && /帳戶餘額不足 → 去帳單頁看看/.test(R5.rows[2])
    && /後自動再試一次/.test(R5.rows[2]) && !/恢復/.test(R5.rows[2]) && R5.left === 3,   // 帳單問題⛔ 寫「幾點恢復」(不會自己好)
    JSON.stringify(R5.rows));
ok('⑤b 「現在再試」每顆 ≥44×44', R5.btns.length === 3 && R5.btns.every(b => b.w >= 44 && b.h >= 44), JSON.stringify(R5.btns));
ok('⑤c 設定收起來也看得到「有 AI 在休息」(金鑰那一組的 summary)', /3 個 AI 休息中/.test(R5.sum), R5.sum);
const retx = [...R5.text.matchAll(/./gu)].length ? [R5.text, ...R5.rows].join('\n') : '';
ok('⑤d 狀態列表 ⛔ 🔴🟢、⛔「撞 429」、⛔ 研究字樣(badOf)', !/[🔴🟢]/u.test(retx) && !/撞 ?429/.test(retx) && badOf(retx).length === 0, badOf(retx).join(','));
// 真的按一下第一顆(Groq qwen)
await page.locator('#aiCoolList button[data-aicool]').first().click();
const R5b = await page.evaluate(async () => {
    const S = window.__S, A = app, o = {};
    o.left = Object.values(A._aiCoolAll()).map(c => `${c.p}:${c.m}`);
    o.rows = document.querySelectorAll('#aiCoolList [data-aicool-row]').length;
    // 解除之後真的會再試:第 2 把金鑰的 qwen
    S.keys(['gk-test-2'], [], []);
    S.posts = [];
    try { o.r = await A._callAI({ prompt: '⑤ 現在再試' }); } catch (e) { o.e = String(e.message); }
    o.p = S.posts.map(p => `${p.provider}:${p.model}`);
    return o;
});
ok('⑤e ⭐ 按「現在再試」→ 那一筆冷卻消失、列表少一列、下一次真的再試 qwen',
    !R5b.left.includes('groq:qwen/qwen3.8-27b') && R5b.left.length === 2 && R5b.rows === 2 && R5b.r === 'ok:qwen/qwen3.8-27b' && JSON.stringify(R5b.p) === '["groq:qwen/qwen3.8-27b"]', JSON.stringify(R5b));

// ── ⑥ 連點兩下同一題 → 只打一次 ──
const R6 = await page.evaluate(async () => {
    const S = window.__S, A = app, o = {};
    S.keys(['gk-test-1'], ['gm-test-1'], []);
    S.reset({});
    let open; S.gate = new Promise(r => { open = r; });
    const p1 = A._callAI({ prompt: '⑥ 同一題', max_tokens: 300 });
    const p2 = A._callAI({ prompt: '⑥ 同一題', max_tokens: 300 });
    const p3 = A._callAI({ prompt: '⑥ 不同題', max_tokens: 300 });
    o.same = p1 === p2; o.diff = p1 !== p3;
    await new Promise(r => setTimeout(r, 50));
    open(); S.gate = null;
    const [a, b, c] = await Promise.all([p1, p2, p3]);
    o.vals = [a, b, c];
    o.posts1 = S.posts.length;
    // 回來之後再問一次 → 照常再打(⛔ 快取)
    await A._callAI({ prompt: '⑥ 同一題', max_tokens: 300 });
    o.posts2 = S.posts.length;
    // 深度那支也一樣
    S.posts = [];
    S.gate = new Promise(r => { open = r; });
    const d1 = A._callDeepAI({ prompt: '⑥ 深度', chain: 'gemini-openrouter' });
    const d2 = A._callDeepAI({ prompt: '⑥ 深度', chain: 'gemini-openrouter' });
    o.dsame = d1 === d2;
    await new Promise(r => setTimeout(r, 50));
    open(); S.gate = null;
    await Promise.all([d1, d2]);
    o.dposts = S.posts.length;
    // 失敗也要從進行中的表上拿掉(⛔ 下一次永遠拿到同一個失敗)
    S.reset({ 'groq:*': 'server_503' });
    S.keys(['gk-test-1'], [], []);
    try { await A._callAI({ prompt: '⑥ 失敗' }); } catch (_) {}
    o.inflightAfter = A._aiInflight ? A._aiInflight.size : 0;
    return o;
});
ok('⑥a ⭐ 連點兩下同一題 → 兩個拿到同一個 Promise、API 只打一次(不同題照打)',
    R6.same && R6.diff && R6.posts1 === 2 && R6.vals[0] === R6.vals[1], JSON.stringify(R6));
ok('⑥b 回來之後再問 → 照常再打(⛔ 快取結果)', R6.posts2 === 3, JSON.stringify(R6));
ok('⑥c 深度分析(_callDeepAI)也去重', R6.dsame && R6.dposts === 1, JSON.stringify(R6));
ok('⑥d 成功 / 失敗回來都從「進行中」拿掉', R6.inflightAfter === 0, R6.inflightAfter);

// ── ⑧ 404:有說模型不存在 → 換模型;沒說 → ⛔ 換、⛔ 作廢清單 ──
const R8 = await page.evaluate(async () => {
    const S = window.__S, A = app, o = {};
    S.keys(['gk-test-1'], [], []);
    S.reset({ 'groq:qwen/qwen3.8-27b': 'groq_404_model' });
    o.r1 = await A._callAI({ prompt: '⑧ 模型下架' }).catch(e => 'ERR ' + e.message);
    o.p1 = S.posts.map(p => p.model); o.l1 = S.lists.groq;
    S.reset({ 'groq:*': 'html_404' });
    A.settings.aiEngine = 'groq';
    o.r2 = await A._callAI({ prompt: '⑧ 網址錯' }).catch(e => 'ERR ' + e.message);
    A.settings.aiEngine = 'auto';
    o.p2 = S.posts.map(p => p.model); o.l2 = S.lists.groq; o.mem2 = !!(A._aiModelMem && A._aiModelMem.groq);
    S.keys([], ['gm-test-1'], []);
    S.reset({ 'gemini:*': 'fastapi_404' });
    o.r3 = await A._callDeepAI({ prompt: '⑧ Gemini 網址錯', chain: 'gemini-only' }).catch(e => 'ERR ' + e.message);
    o.p3 = S.posts.map(p => p.model); o.l3 = S.lists.gemini;
    return o;
});
ok('⑧a 404 + 回應說模型不存在 → 重問清單、換 gpt-oss-20b 成功', R8.r1 === 'ok:openai/gpt-oss-20b' && JSON.stringify(R8.p1) === '["qwen/qwen3.8-27b","openai/gpt-oss-20b"]' && R8.l1 === 2, JSON.stringify(R8));
ok('⑧b ⭐ 404 但回應沒說是模型(HTML)→ ⛔ 換模型(1 次)、⛔ 作廢清單,白話說是網址', /^ERR Groq 找不到 AI 服務的網址\(不是模型下架\)/.test(R8.r2) && R8.p2.length === 1 && R8.l2 === 1 && R8.mem2, JSON.stringify(R8));
ok('⑧c Gemini 404 {"detail":"Not Found"} → 同上(1 次、⛔ 重問清單)', /^ERR Gemini 找不到 AI 服務的網址/.test(R8.r3) && R8.p3.length === 1 && R8.l3 === 1, JSON.stringify(R8));

// ── ⑦ 390px ⛔ 橫向溢出(⚠️ 沙箱沒有 Tailwind → 先注入唯一一份版面 shim)──
const shimBad = await page.evaluate(rwdShim);
ok('⑦⓪ 版面 shim 每條都生效(⛔ 的話底下量到的全不可信)', Array.isArray(shimBad) && shimBad.length === 0, JSON.stringify(shimBad));
const R7 = await page.evaluate(async () => {
    const S = window.__S, A = app;
    S.keys(['gk-test-1', 'gk-test-2'], ['gm-test-1'], ['or-test-1']);
    S.reset({});
    A._aiCoolSet('groq', 'gk-test-1', 'qwen/qwen3.8-27b', 'quota', 446.4);
    A._aiCoolSet('groq', 'gk-test-2', 'meta-llama/llama-4-maverick-17b-128e-instruct-super-long-model-name-for-test', 'rate', 50);
    A._aiCoolSet('gemini', 'gm-test-1', 'gemini-2.5-flash', 'quota', null);
    A._aiCoolSet('openrouter', 'or-test-1', '*', 'billing', null);
    A.openSettings();
    const d = document.querySelector('details[data-setgrp="keys"]'); if (d) d.open = true;
    A._renderAICoolList();
    A._setAIStatus(null, null, 'failed', [
        { provider: 'groq', kind: 'quota', until: Date.now() + 3600e3 }, { provider: 'gemini', kind: 'rate', until: Date.now() + 40e3 },
        { provider: 'openrouter', kind: 'billing', until: Date.now() + 3600e3 }]);
    await new Promise(r => setTimeout(r, 100));
    const box = document.getElementById('aiCoolList');
    box.scrollIntoView({ block: 'center' });
    window.scrollTo(80, 0); const sx = Math.round(window.scrollX); window.scrollTo(0, 0);
    const W = window.innerWidth, out = [];
    const chk = el => {
        const r = el.getBoundingClientRect(); if (!r.width) return;
        const p = el.parentElement && el.parentElement.getBoundingClientRect();
        const name = (el.id ? '#' + el.id : el.tagName.toLowerCase()) + ' ' + (el.innerText || '').trim().slice(0, 24);
        if (r.right > W + 1 || r.left < -1) out.push(`${name} 超出螢幕 L${Math.round(r.left)} R${Math.round(r.right)}`);
        else if (p && p.width && r.right > p.right + 1) out.push(`${name} 超出父層 ${Math.round(r.right - p.right)}px`);
    };
    const els = [box, ...box.querySelectorAll('*')];
    els.forEach(chk);
    const chip = document.getElementById('aiStatusChip');
    const cr = chip.getBoundingClientRect();
    if (cr.right > W + 1 || cr.left < -1) out.push(`chip 超出螢幕 L${Math.round(cr.left)} R${Math.round(cr.right)}`);
    return { sx, out, n: els.length, w: Math.round(box.getBoundingClientRect().width), W, chipW: Math.round(cr.width), chipTxt: chip.innerText };
});
ok(`⑦a 390px:「AI 現在狀態」${R7.n} 個元素 + chip ⛔ 超出(逐元素跟父層 / 螢幕比)`, R7.n >= 10 && R7.out.length === 0, R7.out.join(' | '));
ok('⑦b 真的去捲:⛔ 能橫向捲動', R7.sx <= 2, R7.sx);
ok(`⑦c 空過守門:列表真的有寬度(${R7.w}px / 螢幕 ${R7.W}px)、chip 有內容`, R7.w >= 250 && R7.chipW > 50 && /AI 暫時都不能用/.test(R7.chipTxt), JSON.stringify(R7));
ok('⑦d chip 文字過 badOf、⛔ 🔴🟢', badOf(R7.chipTxt).length === 0 && !/[🔴🟢]/u.test(R7.chipTxt), R7.chipTxt);

ok('⑨ 無 pageerror', errs.length === 0, errs.join(' | '));

await browser.close();
try { if (fs.existsSync(TMP)) fs.unlinkSync(TMP); } catch (_) {}
console.log(fails.length ? `\n❌ AI429_FAIL ${fails.length} 條` : '\n✅ AI429_PASS(全部通過)');
process.exit(fails.length ? 1 : 0);
