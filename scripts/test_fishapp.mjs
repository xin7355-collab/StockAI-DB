#!/usr/bin/env node
// 🎣 V77.9.7 股海釣手(pro.html?app=fish)—— 使用者:「釣魚程式變成另一個獨立 app,策略不用寫出來,魚要更好看」
// ⛔ 這支釘的「用意」:
//   ⓐ App 模式:作戰室分頁列 / 池子 / 規則段看不到,舞台 + 拋竿鈕看得到;標題、manifest、主畫面圖示換成股海釣手
//   ⓑ ⭐ 策略不寫出來:整頁看得到的字⛔ 不可有選股規則用語(位階 / 振幅 / 成交額前 / 唐奇安 / 吊燈 / 領頭羊 / 🧬 / 👑 …)
//   ⓒ ⭐ 決定性對照:App 模式的名單 == 同一份資料的 `_castPick`;把動畫 stub 掉名單也一樣(動畫⛔ 不改變名單)
//   ⓓ V78.0.0 手動:一按只釣一條 cast → wait → bite → fight(按住收線)→ breach → show;離屏真的有畫
//   ⓔ 🎨 V78.0.0 魚身顏色 = 一年高低位置(高紅低綠、今天漲跌⛔ 不影響魚色);卡片漲跌字 = .up / .dn
//   ⓕ ♿ reduced-motion → 一按直接出一張卡、全部收網出全部   ⓖ 🐟 斷線 / 太慢 → 同一條魚留在佇列最前面
//   ⓗ manifest 合法、start_url 指向 App 模式、圖示檔在   ⓘ 其它程式都連不進來(作戰室 / 散戶救星沒有任何入口)
//   ⓙ App 模式⛔ 不記分頁;作戰室⛔ 不會停在沒有按鈕的釣魚頁
//   ⓛ V77.9.9 一次 10 條:前面 == _castPick 原樣原順序(⭐),後面 == _fpvTen 同一套排序;每張卡有名次
//   ⓜ V77.9.9 四種魚長得不一樣(旗魚有吻部、鮪魚有黃色離鰭、小魚有白直紋、四種輪廓互不重疊)
//   ⓝ V77.9.9 釣起價 = 釣到那一刻的即時價 → 放進籃子當下賺賠 = 0   ⓞ 🏠 帶回家養:寫 fishHome_v1 + 匯入碼
//   ⓟ V78.0.0 大小 = 市值(畫面上大魚真的比較大,⛔ 不再每條撐滿)   ⓠ 卡片⛔ 沒有「一張約」、有市值
//   ⓡ 📳 震動開關關掉 → 一次都不震   ⓢ 🏢 公司簡介:本站真資料 + Perplexity(⛔ 沒有選股用語)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_MODULE || '/opt/node22/lib/node_modules/playwright');
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync, existsSync, statSync } from 'node:fs';

let bad = 0;
const ok = (c, n, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c || !e ? '' : ' — ' + e}`); if (!c) bad++; };
for (const f of ['data/screener.json', 'data/playbook_edge.json']) {
  if (!existsSync(f)) { console.log(`❌ 沒有 ${f}(跑 bash scripts/fetch_testdata.sh)—— ⛔ 不跑假測試`); process.exit(1); }
}
const SRC = readFileSync('pro.html', 'utf8');
const URL0 = pathToFileURL(resolve('pro.html')).href;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const errs = [];
const open = async (q, reduce) => {
  const pg = await b.newPage({ viewport: { width: 390, height: 844 } });
  await pg.emulateMedia({ reducedMotion: reduce ? 'reduce' : 'no-preference' });
  pg.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  await pg.goto(URL0 + q);
  await pg.waitForFunction(() => typeof PRO !== 'undefined' && !!PRO._fpvOne, null, { timeout: 30000 });
  return pg;
};

// ── ⓐ ⓑ ────────────────────────────────────────────────
const pg = await open('?app=fish');
await pg.waitForFunction(() => PRO._fpv && PRO._fpv.swim.length > 0, null, { timeout: 40000 }).catch(() => {});
const L = await pg.evaluate(() => {
  const vis = el => { if (!el) return false; for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') return false; } return true; };
  const mf = document.querySelector('link[rel=manifest]');
  return { top: vis(document.querySelector('.topbar')), pool: vis(document.getElementById('fishPoolPane')), cast: vis(document.getElementById('rodCastPane')),
    rules: vis(document.getElementById('rodRules')), stage: vis(document.getElementById('fpvCanvas')), btn: vis(document.getElementById('fpvCastBtn')),
    title: document.title, mf: mf && mf.getAttribute('href'), icon: (document.querySelector('link[rel=apple-touch-icon]') || {}).href || '',
    app: PRO._appFish === true, tab: PRO._tab, swim: PRO._fpv.swim.length, raf: !!PRO._fpv.raf };
});
ok(!L.top && !L.pool && !L.cast && !L.rules, 'ⓐ 作戰室分頁列 / 池子 / 拋竿規則段 / 紀律卡都看不到', JSON.stringify(L));
ok(L.stage && L.btn && L.app && L.tab === 'rod' && L.swim > 0 && L.raf, 'ⓐ2 舞台 + 拋竿鈕看得到、水下有魚在游(rAF 在跑)—— 🚧 空過守門', JSON.stringify(L));
ok(L.title === '股海釣手' && L.mf === 'fish.webmanifest' && /fish-192\.png$/.test(L.icon), 'ⓐ3 標題 / manifest / 主畫面圖示換成股海釣手', JSON.stringify(L));

const BAN = /位階|振幅|成交額前|唐奇安|吊燈|領頭羊|換倉|高基期|高波動|🧬|👑|實測|回測|六關|期望值|出場規則|停損/;
const txt0 = await pg.evaluate(() => document.body.innerText);
ok(!BAN.test(txt0), 'ⓑ 開 App 時整頁⛔ 沒有選股規則用語', (txt0.match(BAN) || [])[0]);

// ── ⓒ 決定性對照 ────────────────────────────────────────
const C = await pg.evaluate(async () => {
  const expect = PRO._castPick(PRO._fishD).picked.map(x => x.sym);
  const saved = PRO._fpvOne; let calls = 0;
  PRO._fpvOne = async () => { calls++; return { ok: true, stub: true }; };
  await PRO.fpvCast(); const stub = PRO._fpv.lastPicked.slice();
  PRO._fpvOne = saved; PRO._fpv.Q = null;
  const t0 = performance.now(); PRO.fpvCast(); await new Promise(r => setTimeout(r, 400)); const real = PRO._fpv.lastPicked.slice();
  const ten = PRO._fpvTen(PRO._fishD, PRO._castPick(PRO._fishD)).map(x => x.sym);
  // 🎣 手動釣第 1 條:等咬鉤 → 按住收線(魚衝或張力高就放手)→ 破水 → 出卡
  const S = PRO._fpv, seen = [];
  for (let k = 0; k < 400 && S.G; k++) {
    const G = S.G; if (!seen.includes(G.ph)) seen.push(G.ph);
    if (G.ph === 'bite' || G.ph === 'fight') PRO.fpvHold(!(G.run || G.ten > 0.55));
    await new Promise(r => setTimeout(r, 40));
  }
  const cards1 = document.querySelectorAll('#fpvCards .fpvcard').length, i1 = S.Q ? S.Q.i : -1, btn = document.getElementById('fpvCastBtn').textContent;
  PRO.fpvSkip();
  const ranks = [...document.querySelectorAll('#fpvCards .fpvcard')].map(e => [e.dataset.fpv, e.querySelector('.rk') ? e.querySelector('.rk').textContent : '']);
  return { expect, stub, real, calls, ms: performance.now() - t0, seq: S.Q ? S.Q.seq : [], seen, cards1, i1, btn, cards: document.querySelectorAll('#fpvCards .fpvcard').length,
           rows: S.lastRows.slice(), ten, ranks };
});
ok(C.calls === 1 && JSON.stringify(C.stub) === JSON.stringify(C.expect) && JSON.stringify(C.real) === JSON.stringify(C.expect),
  'ⓒ ⭐ 名單 == _castPick;動畫 stub 掉前後名單一樣', JSON.stringify(C));
const exSet = new Set(C.expect);
ok(C.expect.length === 0 ? C.rows.length === 0 : (JSON.stringify(C.rows.slice(0, C.expect.length).slice().sort()) === JSON.stringify(C.expect.slice().sort())
   && C.rows.length <= 10 && C.rows.length >= Math.min(10, C.expect.length) && JSON.stringify(C.rows) === JSON.stringify(C.ten) && new Set(C.rows).size === C.rows.length),
  'ⓛ 一次 10 條:前面 == _castPick 那幾條、後面 == _fpvTen 同一套排序、不重複、≤10', JSON.stringify([C.expect, C.rows]));
ok(C.ranks.length === C.rows.length && C.ranks.every(([s, r], i) => r.endsWith('#' + (i + 1)) && (/⭐/.test(r) === exSet.has(s))),
  'ⓛ2 每張卡有名次 #1~#N,只有 _castPick 那幾條掛 ⭐', JSON.stringify(C.ranks));
const txt1 = await pg.evaluate(() => document.body.innerText);
ok(!BAN.test(txt1), 'ⓑ2 拋竿之後(卡片 + 漁獲籃)也⛔ 沒有選股規則用語', (txt1.match(BAN) || [])[0]);

const pg2 = await open('');
const C2 = await pg2.evaluate(async () => { PRO.switchTab('rod'); try { await PRO._rodP; } catch (_) {} return PRO._castPick(PRO._fishD).picked.map(x => x.sym); });
ok(JSON.stringify(C2) === JSON.stringify(C.expect), 'ⓒ2 ⭐ App 模式名單 == 作戰室一般模式名單(同一支 _castPick)', JSON.stringify([C2, C.expect]));

// ── ⓓ 狀態機 + 真的有畫 ─────────────────────────────────
if (C.rows.length) {
  ok(JSON.stringify(C.seen) === JSON.stringify(['cast', 'wait', 'bite', 'fight', 'breach', 'show']), 'ⓓ ⭐ 手動釣一條:cast → wait → bite → fight(按住收線)→ breach → show', JSON.stringify([C.seen, C.seq]));
  ok(C.cards1 === 1 && C.i1 === 1 && /第 2 \/ /.test(C.btn), 'ⓓ2 ⭐ 一按只釣一條(第 1 條上岸只有 1 張卡,按鈕變「第 2 / N 條」)', JSON.stringify([C.cards1, C.i1, C.btn]));
  ok(C.cards === C.rows.length && C.seq.at(-1) === 'all', 'ⓓ3 ⏭ 全部收網 → 剩下的一次全部出卡', `${C.cards} vs ${C.rows.length}`);
} else ok(C.seq.length === 0 || C.seq.includes('none'), 'ⓓ 今天沒有魚 → 直接結束');
const P = await pg.evaluate(() => {
  const cv = document.createElement('canvas'); cv.width = 240; cv.height = 120; const ctx = cv.getContext('2d');
  const px = F => { ctx.clearRect(0, 0, 240, 120); PRO._fpvDrawFish(ctx, F, 190, 60, 1, 0, 0.3, {}); const d = ctx.getImageData(0, 0, 240, 120).data;
    let n = 0, r = 0, g = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200) { n++; r += d[i]; g += d[i + 1]; } return { n, r: r / Math.max(1, n), g: g / Math.max(1, n) }; };
  const hi = px(PRO._fpvFishOf({ sym: 'U', c: 120, chg: -3, amp20: 4, pos252: 96, mcap: 500 })), lo = px(PRO._fpvFishOf({ sym: 'D', c: 120, chg: 3, amp20: 4, pos252: 4, mcap: 500 }));
  const a = PRO._fpvFishOf({ sym: 'A', c: 120, chg: 5, pos252: 50, mcap: 500 }).pal, b2 = PRO._fpvFishOf({ sym: 'B', c: 120, chg: -5, pos252: 50, mcap: 500 }).pal;
  const hs = [0, 25, 50, 75, 100].map(v => PRO._fpvPal(v).t);
  const S = PRO._fpv; const stage = S.ctx.getImageData(0, 0, 50, 50).data; let sn = 0; for (let i = 3; i < stage.length; i += 4) if (stage[i]) sn++;
  return { hi, lo, same: JSON.stringify(a) === JSON.stringify(b2), hs, sn };
});
ok(P.hi.n > 1000 && P.lo.n > 1000 && P.sn > 1000, 'ⓓ4 離屏真的畫出魚、舞台有畫面', JSON.stringify(P));
ok(P.hi.r > P.hi.g + 30 && P.lo.g > P.lo.r + 30, 'ⓔ 🎨 一年高低位置高 → 偏紅、低 → 偏綠(使用者核准的魚身例外)', JSON.stringify(P));
ok(P.same && P.hs.every((v, i) => !i || v > P.hs[i - 1]), 'ⓔ3 ⭐ 決定性對照:今天漲跌換成相反,魚色一模一樣;位置越高 t 越大(漸變單調)', JSON.stringify(P));
const cardCls = await pg.evaluate(() => [...document.querySelectorAll('#fpvCards .fpvchg')].map(e => [e.textContent, e.className]));
ok(cardCls.every(([t, c]) => (/^\+/.test(t) && parseFloat(t) > 0 ? /\bup\b/.test(c) : /^-/.test(t) ? /\bdn\b/.test(c) : true)), 'ⓔ2 卡片漲跌字:漲 = .up(紅)、跌 = .dn(綠)', JSON.stringify(cardCls));

// ── ⓜ 四種魚長得不一樣 ─────────────────────────────────
const SP = await pg.evaluate(() => {
  const W = 420, H = 220, out = {};
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const ctx = cv.getContext('2d');
  for (const [k, m] of [['reef', 20], ['tuna', 120], ['sword', 800], ['arow', 5000]]) {
    const F = PRO._fpvFishOf({ sym: k, c: 100, chg: 2, amp20: 3, mcap: m, pos252: 60 }); F.ph = 0;
    ctx.clearRect(0, 0, W, H);
    const sc = Math.min(W * 0.9 / (F.len * F.span), H * 0.8 / (F.len * F.hgt));
    const hx = W / 2 + PRO._fpvOx(F, sc);
    PRO._fpvDrawFish(ctx, F, hx, H / 2, sc, 0, 0, { thrash: 0 });
    const d = ctx.getImageData(0, 0, W, H).data, mask = new Uint8Array(W * H);
    let x0 = W, x1 = 0, y0 = H, y1 = 0, yel = 0, wht = 0, nose = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4; if (d[i + 3] < 128) continue;
      mask[y * W + x] = 1; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      if (d[i] > 225 && d[i + 1] > 180 && d[i + 2] < 110) yel++;
      if (d[i] > 225 && d[i + 1] > 225 && d[i + 2] > 225) wht++;
      if (x > hx + F.len * sc * 0.2) nose++;
    }
    out[k] = { tag: F.tag, asp: (x1 - x0 + 1) / Math.max(1, y1 - y0 + 1), yel, wht, nose, mask: Array.from(mask) };
  }
  const iou = (a, b) => { let i = 0, u = 0; for (let k = 0; k < a.length; k++) { if (a[k] && b[k]) i++; if (a[k] || b[k]) u++; } return u ? i / u : 1; };
  const ks = Object.keys(out), pairs = {};
  for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) pairs[ks[i] + '-' + ks[j]] = +iou(out[ks[i]].mask, out[ks[j]].mask).toFixed(2);
  for (const k of ks) delete out[k].mask;
  return { out, pairs };
});
ok(Object.values(SP.pairs).every(v => v < 0.8), 'ⓜ 四種魚輪廓互不相同(兩兩重疊率 < 0.8)', JSON.stringify(SP.pairs));
ok(SP.out.sword.nose > 60 && SP.out.tuna.nose < SP.out.sword.nose / 4 && SP.out.reef.nose < SP.out.sword.nose / 4, 'ⓜ2 🗡️ 旗魚頭前面有長吻部(鮪魚沒有)', JSON.stringify([SP.out.sword.nose, SP.out.tuna.nose]));
ok(SP.out.tuna.yel > 20 && SP.out.sword.yel < SP.out.tuna.yel, 'ⓜ3 🐟 鮪魚有黃色小離鰭', JSON.stringify([SP.out.tuna.yel, SP.out.sword.yel]));
ok(SP.out.reef.wht > 150 && SP.out.reef.wht > SP.out.tuna.wht * 4 && SP.out.reef.asp < SP.out.sword.asp && SP.out.reef.asp < SP.out.arow.asp, 'ⓜ4 🐠 小魚圓胖有白直紋(比旗魚 / 龍魚短胖)', JSON.stringify(SP.out));

// ── ⓝ 釣起價 = 即時價 / ⓞ 帶回家養 ───────────────────────
const N = await pg.evaluate(async () => {
  const D = PRO._fishD, r = D.rows.find(x => x.c > 0); const sym = r.sym;
  const saveLq = PRO._lq, saveAt = PRO._lqAt, saveBk = localStorage.getItem('proWar_catch');
  localStorage.setItem('proWar_catch', '[]');
  const lp = +(r.c * 1.07).toFixed(2);
  PRO._lq = { updated: '2099-01-02T10:00:00+08:00', data: { [sym]: { p: lp, c: 1.5 } } }; PRO._lqAt = Date.now() + 1e9;
  PRO._fishCatch(sym);
  const x = PRO._catchLoad()[0];
  await new Promise(res => setTimeout(res, 300)); PRO._fishBasketRender();
  const row = [...document.querySelectorAll('#fishBasket .fpvbk, .fpvbk')].map(e => e.innerText).find(s => s.includes(sym)) || '';
  localStorage.removeItem('fishHome_v1');
  const code = PRO.fishTakeHome();
  const home = JSON.parse(localStorage.getItem('fishHome_v1') || '[]');
  const dec = JSON.parse(decodeURIComponent(escape(atob(code.split('.')[1]))));
  PRO._lq = saveLq; PRO._lqAt = saveAt; if (saveBk == null) localStorage.removeItem('proWar_catch'); else localStorage.setItem('proWar_catch', saveBk);
  return { sym, lp, px: x.px, d: x.d, row, home, dec };
});
ok(N.px === N.lp && N.d === '2099-01-02', 'ⓝ 釣起價 = 釣到那一刻的即時價、日期 = 即時快照那天(⛔ 不是選股那天的收盤)', JSON.stringify(N));
ok(/\+?0\.0%/.test(N.row) && /\+?0 元/.test(N.row), 'ⓝ2 剛放進籃子賺賠 = 0(⛔ 不會釣到就賺)', N.row);
ok(N.home.some(h => h.sym === N.sym && h.px === N.lp && h.d === '2099-01-02') && N.dec.some(a => a[0] === N.sym && a[1] === N.lp),
  'ⓞ 🏠 帶回家養:寫 fishHome_v1 + 匯入碼可解回同一份', JSON.stringify([N.home, N.dec]));

// ── ⓕ reduced-motion ────────────────────────────────────
const pg3 = await open('?app=fish', true);
await pg3.waitForFunction(() => PRO._fishD, null, { timeout: 40000 }).catch(() => {});
const R3 = await pg3.evaluate(async () => {
  const t0 = performance.now(); await PRO.fpvCast();
  const one = { ms: performance.now() - t0, seq: PRO._fpv.Q ? PRO._fpv.Q.seq.slice() : null, cards: document.querySelectorAll('#fpvCards .fpvcard, #fpvCards .fpvnone').length };
  PRO.fpvSkip(); one.all = document.querySelectorAll('#fpvCards .fpvcard').length; one.n = PRO._fpv.Q ? PRO._fpv.Q.fish.length : 0; return one; });
ok(R3.ms < 1500 && R3.cards === 1 && !(R3.seq || []).includes('breach') && R3.all === R3.n, 'ⓕ ♿ 減少動態 → 一按直接出一張卡、全部收網出全部', JSON.stringify(R3));

// ── ⓖ 斷線 / 太慢 → 同一條魚留在佇列最前面 ─────────────
const G = await pg.evaluate(async () => {
  const S = PRO._fpv; S.Q = null; PRO.fpvCast(); for (let k = 0; k < 100 && !S.G; k++) await new Promise(r => setTimeout(r, 50)); const first = S.Q.fish[S.Q.i].sym;
  for (let k = 0; k < 100 && S.G && S.G.ph !== 'bite'; k++) await new Promise(r => setTimeout(r, 50));
  PRO.fpvHold(true); PRO._fpvGameStep(S.G, 0.01);
  const G1 = S.G; G1.run = true; G1.surge = 1.2; G1.runT = 99999; for (let k = 0; k < 40 && S.G; k++) PRO._fpvGameStep(G1, 0.05);
  const snapI = S.Q.i, snapSeq = S.Q.seq.at(-1), next = S.Q.fish[S.Q.i].sym, hint = document.getElementById('fpvHint').innerText;
  PRO.fpvCast(); for (let k = 0; k < 100 && S.G && S.G.ph !== 'bite'; k++) await new Promise(r => setTimeout(r, 50));
  const G2 = S.G; PRO._fpvGameStep(G2, 4.2); const lateSeq = S.Q.seq.at(-1), lateI = S.Q.i;
  return { first, snapI, snapSeq, next, hint, lateSeq, lateI };
});
ok(G.snapSeq === 'escape' && G.snapI === 0 && G.next === G.first && /跑掉了/.test(G.hint), 'ⓖ 🐟 張力爆表 → 斷線,同一條魚留在佇列最前面(名次不變)', JSON.stringify(G));
ok(G.lateSeq === 'escape' && G.lateI === 0, 'ⓖ2 咬鉤 4 秒沒按 → 跑掉,還是同一條', JSON.stringify(G));

// ── ⓟ 大小 = 市值 / ⓠ 卡片 / ⓡ 震動 / ⓢ 公司簡介 ───────────
const Z = await pg.evaluate(async () => {
  PRO.fpvSkip();                                    // ⓖ 最後一條跑掉了 → 收網把卡片叫出來再看
  const W = 360, sm = PRO._fpvFishOf({ sym: 's', c: 500, mcap: 15, pos252: 50 }), bg = PRO._fpvFishOf({ sym: 'b', c: 20, mcap: 8000, pos252: 50 });
  const lens = [5, 30, 200, 2000, 30000].map(m => PRO._fpvFishOf({ sym: 'x', c: 50, mcap: m }).len);
  const shown = F => PRO._fpvFit(F, W, 2.1) * F.len;
  const card = [...document.querySelectorAll('#fpvCards .fpvcard')].map(e => e.innerText).join('\n');
  let vib = 0; const save = navigator.vibrate; navigator.vibrate = () => { vib++; return true; };
  localStorage.setItem('fishBuzz_v1', '0'); PRO._fpvBuzz([50, 50]); PRO.buzz(30); const off = vib;
  localStorage.setItem('fishBuzz_v1', '1'); PRO._fpvBuzz([50, 50]); const on = vib - off; navigator.vibrate = save;
  const sym = (PRO._fishD.rows.find(r => r.sym === '2330') || PRO._fishD.rows[0]).sym;
  await PRO._fpvProfile(sym); const prof = document.getElementById('proModal').innerText, link = (document.querySelector('#proModal a.fpvq') || {}).href || '';
  PRO.closeModal();
  return { sm: shown(sm), bg: shown(bg), lens, card, off, on, sym, prof, link };
});
ok(Z.lens.every((v, i) => !i || v >= Z.lens[i - 1]) && Z.lens[4] > Z.lens[0] * 1.6 && Z.bg > Z.sm * 1.5, 'ⓟ 📏 市值越大魚越長;畫面上大魚真的比小魚大(⛔ 不再每條撐滿畫面)', JSON.stringify(Z.lens.concat([Z.sm, Z.bg])));
ok(!/一張約/.test(Z.card) && /市值/.test(Z.card) && /公司簡介/.test(Z.card), 'ⓠ 卡片⛔ 沒有「一張約」、有市值與公司簡介鈕', Z.card.slice(0, 200));
ok(Z.off === 0 && Z.on >= 1, 'ⓡ 📳 震動開關關掉 → 一次都不震;打開才震', JSON.stringify([Z.off, Z.on]));
ok(/產業/.test(Z.prof) && /perplexity\.ai\/search\?q=/.test(Z.link) && /未來計畫/.test(Z.prof) && !BAN.test(Z.prof), 'ⓢ 🏢 公司簡介:本站真資料 + Perplexity 查未來計畫、⛔ 沒有選股用語', (Z.prof.match(BAN) || [''])[0] + ' | ' + Z.prof.slice(0, 160));

// ── ⓗ manifest / 圖示 ──────────────────────────────────
let M = null; try { M = JSON.parse(readFileSync('fish.webmanifest', 'utf8')); } catch (_) {}
ok(M && M.name === '股海釣手' && /pro\.html\?app=fish/.test(M.start_url) && M.display === 'standalone' && (M.icons || []).every(i => existsSync(i.src) && statSync(i.src).size > 2000),
  'ⓗ fish.webmanifest 合法、start_url 指 App 模式、圖示檔都在', JSON.stringify(M));

// ── ⓘ ⓙ 作戰室那顆鈕 / 不記分頁 ─────────────────────────
const IDX = readFileSync('index.html', 'utf8');
ok(!/id="tabBtnRod"/.test(SRC) && !/app=fish/.test(IDX) && !/PRO\._fishPoolK='fam';PRO\.switchTab\(/.test(SRC) && (SRC.match(/app=fish/g) || []).length <= 3,
  'ⓘ ⭐ 其它程式都連不進來:作戰室沒有釣魚鈕 / 放下水鈕、散戶救星沒有連結(pro.html 裡的 app=fish 只准出現在偵測那幾行)', String((SRC.match(/app=fish/g) || []).length));
ok(/_saveNav\(\) \{\n    if \(this\._appFish\) return;/.test(SRC) && /if \(s\.tab === 'rod'\) s\.tab = 'val';/.test(SRC), 'ⓙ App ⛔ 不記分頁;作戰室⛔ 還原到釣魚頁');
ok(!errs.length, 'ⓚ 無 pageerror', errs.join(' | '));
await b.close();
console.log(bad ? `\n❌ ${bad} 條沒過` : '\n✅ FISHAPP_PASS');
process.exit(bad ? 1 : 0);
