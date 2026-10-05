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
//   ⓡ 📳 震動開關關掉 → 一次都不震   ⓢ 🎴 V78.0.1 遊戲卡:左上名字代號 / 五項能力⛔ 不加總 / 琥珀橫條 / 虧損 / reduced-motion
//   🎣 V78.0.2(使用者九點):ⓒ App 一律 👑 前 10、⛔ 不補魚 ⓥ fpvSea_v1 每天記住 ⓦ 只能點捲線器拋 + 瞄準
//   ⓧ 往左游 = 水平鏡像(⛔ 不轉 180°)ⓨ 🕸️ 拋網一次全抓 ⓩ 卡片排序 ⓢ8 遊戲卡避開瀏海
//   🐟 V78.0.5 等咬鉤時魚游過去、假咬、最後一口咬住(_fpvApproach)
//   🌊 V78.0.4 放回海裡(只動 fpvSea_v1、⛔ 不碰漁獲籃;釣魚中不可放)+ 沒在釣時線收在竿尖
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
await pg.waitForFunction(() => PRO._fpv && PRO._fpv.Q && PRO._fpv.swim.length > 0, null, { timeout: 60000 }).catch(() => {});
const L = await pg.evaluate(() => {
  const vis = el => { if (!el) return false; for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') return false; } return true; };
  const mf = document.querySelector('link[rel=manifest]');
  return { top: vis(document.querySelector('.topbar')), pool: vis(document.getElementById('fishPoolPane')), cast: vis(document.getElementById('rodCastPane')),
    rules: vis(document.getElementById('rodRules')), stage: vis(document.getElementById('fpvCanvas')), btn: !document.getElementById('fpvCastBtn') && !!(PRO._fpv && PRO._fpv.reel),
    title: document.title, mf: mf && mf.getAttribute('href'), icon: (document.querySelector('link[rel=apple-touch-icon]') || {}).href || '',
    app: PRO._appFish === true, tab: PRO._tab, swim: PRO._fpv.swim.length, raf: !!PRO._fpv.raf };
});
ok(!L.top && !L.pool && !L.cast && !L.rules, 'ⓐ 作戰室分頁列 / 池子 / 拋竿規則段 / 紀律卡都看不到', JSON.stringify(L));
ok(L.stage && L.btn && L.app && L.tab === 'rod' && L.swim > 0 && L.raf, 'ⓐ2 舞台看得到、⛔ 沒有另外的拋竿鈕(只有捲線器)、水下有魚在游(rAF 在跑)—— 🚧 空過守門', JSON.stringify(L));
ok(L.title === '股海釣手' && L.mf === 'fish.webmanifest' && /fish-192\.png$/.test(L.icon), 'ⓐ3 標題 / manifest / 主畫面圖示換成股海釣手', JSON.stringify(L));

const BAN = /位階|振幅|成交額前|唐奇安|吊燈|領頭羊|換倉|高基期|高波動|🧬|👑|實測|回測|六關|期望值|出場規則|停損/;
const txt0 = await pg.evaluate(() => document.body.innerText);
ok(!BAN.test(txt0), 'ⓑ 開 App 時整頁⛔ 沒有選股規則用語', (txt0.match(BAN) || [])[0]);

// ── ⓒ 決定性對照 ────────────────────────────────────────
const C = await pg.evaluate(async () => {
  localStorage.removeItem('fpvSea_v1');
  const D = PRO._fishD, R0 = PRO._castPick(D), expect = R0.picked.map(x => x.sym), isLead = PRO._isLead();
  const lead10 = ((D.LD && D.LD.ranked) || []).slice(0, 10).map(x => x.sym);
  const saved = PRO._fpvOne; let calls = 0;
  PRO._fpvOne = async () => { calls++; return { ok: true, stub: true }; };
  PRO._fpv.Q = null; await PRO.fpvCast(); const stub = PRO._fpv.lastPicked.slice();
  PRO._fpvOne = saved; PRO._fpv.Q = null; localStorage.removeItem('fpvSea_v1');
  const t0 = performance.now(); PRO.fpvCast(); for (let k = 0; k < 100 && !PRO._fpv.G; k++) await new Promise(r => setTimeout(r, 50)); const real = PRO._fpv.lastPicked.slice();
  const ten = PRO._fpvTen(D, PRO._castPick(D)).map(x => x.sym);
  // 🚫 不補魚:排行只剩 3 條 → 只有 3 條(⛔ 不拿魚池後段補)
  const saveL = D.LD; const r3 = saveL.ranked.slice(0, 3); D.LD = { ...saveL, ranked: r3, buy: saveL.buy.filter(x => r3.some(y => y.sym === x.sym)) }; const three = PRO._fpvTen(D, PRO._castPick(D)).length; D.LD = saveL;
  // 🎣 手動釣第 1 條:等咬鉤 → 按住收線(魚衝或張力高就放手)→ 破水 → 出卡
  const S = PRO._fpv, seen = [];
  for (let k = 0; k < 400 && S.G; k++) {
    const G = S.G; if (!seen.includes(G.ph)) seen.push(G.ph);
    if (G.ph === 'bite' || G.ph === 'fight') PRO.fpvHold(!(G.run || G.ten > 0.55));
    await new Promise(r => setTimeout(r, 40));
  }
  const cards1 = document.querySelectorAll('#fpvCards .fpvcard').length, i1 = S.Q ? S.Q.i : -1, sub1 = document.getElementById('fpvSub').innerText;
  const sea1 = JSON.parse(localStorage.getItem('fpvSea_v1') || '{}');
  const netR = await PRO.fpvNet();
  const ranks = [...document.querySelectorAll('#fpvCards .fpvcard')].map(e => [e.dataset.fpv, e.querySelector('.rk') ? e.querySelector('.rk').textContent : '']);
  const sea2 = JSON.parse(localStorage.getItem('fpvSea_v1') || '{}');
  const again = await PRO.fpvCast();
  return { expect, isLead, lead: R0.lead === true, lead10, stub, real, calls, ms: performance.now() - t0, seq: S.Q ? S.Q.seq : [], seen, cards1, i1, sub1, sea1, sea2, netR,
           cards: document.querySelectorAll('#fpvCards .fpvcard').length, rows: S.lastRows.slice(), ten, three, ranks, again, gAfter: !!S.G,
           hint: document.getElementById('fpvHint').innerText, netHidden: document.getElementById('fpvNet').classList.contains('hidden') };
});
ok(C.lead && !C.isLead, 'ⓒ ⭐ App 模式沒有任何設定也一律 👑(主畫面 App 讀不到作戰室的設定)', JSON.stringify([C.lead, C.isLead]));
ok(C.calls === 1 && JSON.stringify(C.stub) === JSON.stringify(C.expect) && JSON.stringify(C.real) === JSON.stringify(C.expect),
  'ⓒ2 ⭐ 名單 == _castPick;動畫 stub 掉前後名單一樣', JSON.stringify([C.stub, C.real, C.expect, C.calls]));
const exSet = new Set(C.expect);
ok(C.lead10.length > 0 && JSON.stringify(C.rows) === JSON.stringify(C.lead10) && JSON.stringify(C.ten) === JSON.stringify(C.lead10) && C.three === 3,
  'ⓛ 海裡的魚 == 排行前 10 條(照名次)、⛔ 不補魚(排行只剩 3 條 → 3 條)', JSON.stringify([C.lead10, C.rows, C.three]));
ok(C.ranks.length === C.rows.length && C.ranks.every(([s, r], i) => r.endsWith('#' + (i + 1)) && (/⭐/.test(r) === exSet.has(s))),
  'ⓛ2 每張卡有名次 #1~#N(預設照名次排)、只有今天會買的那幾條掛 ⭐', JSON.stringify(C.ranks));
const txt1 = await pg.evaluate(() => document.body.innerText);
ok(!BAN.test(txt1), 'ⓑ2 拋竿之後(卡片 + 漁獲籃)也⛔ 沒有選股規則用語', (txt1.match(BAN) || [])[0]);

const pg2 = await open('');
const C2 = await pg2.evaluate(async () => { PRO.switchTab('rod'); try { await PRO._rodP; } catch (_) {}
  const gene = PRO._castPick(PRO._fishD);
  localStorage.setItem('proTerminalSettings', JSON.stringify({ strategy: 'lead', stratUnlock: true }));
  const lead = PRO._castPick(PRO._fishD);
  return { gene: !!gene.lead, lead: lead.picked.map(x => x.sym) }; });
ok(!C2.gene && JSON.stringify(C2.lead) === JSON.stringify(C.expect), 'ⓒ3 ⭐ 決定性對照:作戰室一般模式沒解鎖 → 🧬;解鎖 👑 後名單 == App 模式(同一支 _castPick)', JSON.stringify([C2, C.expect]));

// ── ⓓ 狀態機 + 真的有畫 ─────────────────────────────────
if (C.rows.length) {
  ok(JSON.stringify(C.seen) === JSON.stringify(['cast', 'wait', 'bite', 'fight', 'breach', 'show']), 'ⓓ ⭐ 手動釣一條:cast → wait → bite → fight(按住收線)→ breach → show', JSON.stringify([C.seen, C.seq]));
  ok(C.cards1 === 1 && C.i1 === 1 && new RegExp('還有 ' + (C.rows.length - 1) + ' 條').test(C.sub1) && (C.sea1.caught || []).length === 1,
    'ⓓ2 ⭐ 一按只釣一條(第 1 條上岸只有 1 張卡、水面下剩 N−1 條、記進 fpvSea_v1)', JSON.stringify([C.cards1, C.i1, C.sub1, C.sea1]));
  ok(C.cards === C.rows.length && C.seq.includes('net') && C.seq.at(-1) === 'all' && C.netR && C.netR.ok && (C.sea2.caught || []).length === C.rows.length,
    'ⓨ 🕸️ 拋網 → 剩下的一次全抓(有動畫階段 net)、全部記進 fpvSea_v1', JSON.stringify([C.cards, C.rows.length, C.seq, C.sea2]));
  ok(C.again && C.again.none && !C.gAfter && /釣完了/.test(C.hint) && C.netHidden, 'ⓨ2 釣完海裡就沒魚:再拋不會開始釣、寫「釣完了」、拋網鈕收起來', JSON.stringify([C.again, C.hint, C.netHidden]));
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

// ── ⓝ3 🕐 V78.5.2 開盤前 ⛔ 不可把上個交易日的漲跌寫成「今日 即時」 ──
const T = await pg.evaluate(() => {
  const D = PRO._fishD, r = D.rows.find(x => x.c > 0), sym = r.sym;
  const sv = { lq: PRO._lq, at: PRO._lqAt, open: PRO._twOpenNow };
  const box = document.getElementById('fpvCards');
  const card = openNow => {
    PRO._twOpenNow = () => openNow;
    PRO._lq = { updated: new Date(Date.now() - 60000).toISOString(), ts: 'x', data: { [sym]: { p: r.c, c: 2.5 } } }; PRO._lqAt = Date.now() + 1e9;
    const F = PRO._fpvFishRow(PRO._fpvLive(r, D));
    box && box.querySelectorAll(`[data-fpv="${sym}"]`).forEach(e => e.remove());
    PRO._fpvShowCard(F, 0, null);
    const el = box && box.querySelector(`[data-fpv="${sym}"] [data-fpvchglb]`);
    const t = el ? el.innerText : '';
    box && box.querySelectorAll(`[data-fpv="${sym}"]`).forEach(e => e.remove());
    return t;
  };
  const pre = card(false), live = card(true);
  PRO._lq = sv.lq; PRO._lqAt = sv.at; PRO._twOpenNow = sv.open;
  const sd = document.getElementById('fpvSeaDate');
  return { pre, live, sea: sd ? sd.innerText : null, hasBox: !!box };
});
ok(T.hasBox && !/即時|今日/.test(T.pre) && /\d\d\/\d\d 收盤/.test(T.pre), 'ⓝ3 開盤前卡片 ⛔「今日 即時」,寫「MM/DD 收盤」', JSON.stringify(T));
ok(/今日/.test(T.live) && /即時/.test(T.live), 'ⓝ4 盤中(快照 30 分鐘內)才寫「今日 即時」', JSON.stringify(T));
ok(T.sea === null || /\d\d\/\d\d 收盤的名單/.test(T.sea) || T.sea === '', 'ⓝ5 海面標出這批是哪天收盤的名單(有填就要有日期)', JSON.stringify(T.sea));

// ── ⓕ reduced-motion ────────────────────────────────────
const pg3 = await open('?app=fish', true);
await pg3.waitForFunction(() => PRO._fishD, null, { timeout: 40000 }).catch(() => {});
const R3 = await pg3.evaluate(async () => {
  for (let k = 0; k < 100 && !(PRO._fpv && PRO._fpv.Q); k++) await new Promise(r => setTimeout(r, 100));
  const t0 = performance.now(); await PRO.fpvCast();
  const one = { ms: performance.now() - t0, seq: PRO._fpv.Q ? PRO._fpv.Q.seq.slice() : null, cards: document.querySelectorAll('#fpvCards .fpvcard, #fpvCards .fpvnone').length };
  const t1 = performance.now(); await PRO.fpvNet(); one.netMs = performance.now() - t1;
  one.all = document.querySelectorAll('#fpvCards .fpvcard').length; one.n = PRO._fpv.Q ? PRO._fpv.Q.fish.length : 0;
  await PRO._fpvProfile(PRO._fpv.Q.fish[0].sym); const tc = document.querySelector('#fpvCardWrap .fpvtcg');
  one.flip = tc ? getComputedStyle(tc).animationName : 'nocard'; PRO._fpvCardClose(); return one; });
ok(R3.ms < 1500 && R3.cards === 1 && !(R3.seq || []).includes('breach') && R3.all === R3.n && R3.netMs < 500, 'ⓕ ♿ 減少動態 → 一按直接出一張卡、拋網直接全部出卡', JSON.stringify(R3));
ok(R3.flip === 'none', 'ⓢ6 ♿ 減少動態 → 遊戲卡直接出現、⛔ 沒有翻牌動畫', R3.flip);

// ── ⓖ 斷線 / 太慢 → 同一條魚留在佇列最前面 ─────────────
const G = await pg.evaluate(async () => {
  const S = PRO._fpv; S.Q = null; localStorage.removeItem('fpvSea_v1'); PRO.fpvCast(); for (let k = 0; k < 100 && !S.G; k++) await new Promise(r => setTimeout(r, 50)); const first = S.Q.fish[S.Q.i].sym;
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
  await PRO.fpvNet();                               // ⓖ 最後一條跑掉了 → 拋網把卡片叫出來再看
  const W = 360, sm = PRO._fpvFishOf({ sym: 's', c: 500, mcap: 15, pos252: 50 }), bg = PRO._fpvFishOf({ sym: 'b', c: 20, mcap: 8000, pos252: 50 });
  const lens = [5, 30, 200, 2000, 30000].map(m => PRO._fpvFishOf({ sym: 'x', c: 50, mcap: m }).len);
  const shown = F => PRO._fpvFit(F, W, 2.1) * F.len;
  const card = [...document.querySelectorAll('#fpvCards .fpvcard')].map(e => e.innerText).join('\n');
  let vib = 0; const save = navigator.vibrate; navigator.vibrate = () => { vib++; return true; };
  localStorage.setItem('fishBuzz_v1', '0'); PRO._fpvBuzz([50, 50]); PRO.buzz(30); const off = vib;
  localStorage.setItem('fishBuzz_v1', '1'); PRO._fpvBuzz([50, 50]); const on = vib - off; navigator.vibrate = save;
  const sym = (PRO._fishD.rows.find(r => r.sym === '2330') || PRO._fishD.rows[0]).sym;
  await PRO._fpvProfile(sym); await new Promise(r => setTimeout(r, 500));   // 翻牌動畫 0.35 秒跑完再量位置
  const w = document.getElementById('fpvCardWrap'), tc = w && w.querySelector('.fpvtcg');
  const prof = w ? w.innerText : '', link = (w && w.querySelector('a.fpvq') || {}).href || '';
  const nmEl = w && w.querySelector('.hd .nm'), cdEl = w && w.querySelector('.hd .cd');
  const tcR = tc ? tc.getBoundingClientRect() : { left: 0, width: 1, top: 0 }, nmR = nmEl ? nmEl.getBoundingClientRect() : { left: 999, top: 999 };
  const topLeft = !!nmEl && nmR.left < tcR.left + tcR.width * 0.3 && nmR.top < tcR.top + 60;
  const cv = w && w.querySelector('canvas.art'); let colors = 0;
  if (cv) { const d = cv.getContext('2d').getImageData(cv.width * 0.25, cv.height * 0.25, cv.width * 0.5, cv.height * 0.5).data, seen = new Set();
    for (let i = 0; i < d.length; i += 16) seen.add((d[i] >> 3) + ',' + (d[i + 1] >> 3) + ',' + (d[i + 2] >> 3)); colors = seen.size; }
  const stats = w ? [...w.querySelectorAll('.st')].map(e => [e.dataset.st, (e.querySelector('.h b') || {}).innerText || '']) : [];
  const hue = (r, g, b) => { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), dd = mx - mn; if (!dd) return -1;
    let h = mx === r ? ((g - b) / dd) % 6 : mx === g ? (b - r) / dd + 2 : (r - g) / dd + 4; h *= 60; return h < 0 ? h + 360 : h; };
  const hues = w ? [...w.querySelectorAll('.st .fl')].flatMap(e => [...getComputedStyle(e).backgroundImage.matchAll(/rgb\((\d+), (\d+), (\d+)\)/g)].map(m => Math.round(hue(+m[1], +m[2], +m[3])))) : [];
  PRO._fpvCardClose(); const closed = !w || w.classList.contains('hidden');
  // 🎯 決定性對照:把這檔市值改成全市場最大 → 體型 100%、★★★★
  const D = PRO._fishD, r = D.rows.find(x => x.sym === sym), saveM = D.rows.map(x => x.mcap);
  D.rows.forEach((x, i) => { if (!(x.mcap > 0)) x.mcap = 10 + i; }); r.mcap = 1e7; D._rk = null;
  await PRO._fpvProfile(sym);
  const big = { ex: ((w.querySelector('.st[data-st="體型"] .ex') || {}).innerText || ''), stars: ((w.querySelector('.stars') || {}).childNodes || [{}])[0].textContent || '' };
  PRO._fpvCardClose(); D.rows.forEach((x, i) => { x.mcap = saveM[i]; }); D._rk = null;
  // 💎 虧損股:最近一季 EPS < 0 → 賺錢力寫「目前虧損中」且特性欄有 ⚠️
  const orig = PRO.fetchJson; PRO.fetchJson = (u, ms) => /data\/fin\//.test(u) ? Promise.resolve({ q: [{ p: '2026-06-30', rev: 1e9, eps: -1.5, gm: 12 }] }) : orig.call(PRO, u, ms);
  await PRO._fpvProfile(sym);
  const loss = { gm: ((w.querySelector('.st[data-st="賺錢力"]') || {}).innerText || ''), tt: ((w.querySelector('.tt') || {}).innerText || '') };
  PRO.fetchJson = orig; PRO._fpvCardClose();
  return { sm: shown(sm), bg: shown(bg), lens, card, off, on, sym, prof, link, nm: nmEl ? nmEl.innerText : '', cd: cdEl ? cdEl.innerText : '', topLeft, colors, stats, hues, closed, big, loss };
});
ok(Z.lens.every((v, i) => !i || v >= Z.lens[i - 1]) && Z.lens[4] > Z.lens[0] * 1.6 && Z.bg > Z.sm * 1.5, 'ⓟ 📏 市值越大魚越長;畫面上大魚真的比小魚大(⛔ 不再每條撐滿畫面)', JSON.stringify(Z.lens.concat([Z.sm, Z.bg])));
ok(!/一張約/.test(Z.card) && /市值/.test(Z.card) && /看這條魚的卡片/.test(Z.card), 'ⓠ 卡片⛔ 沒有「一張約」、有市值與看卡片鈕', Z.card.slice(0, 200));
ok(Z.off === 0 && Z.on >= 1, 'ⓡ 📳 震動開關關掉 → 一次都不震;打開才震', JSON.stringify([Z.off, Z.on]));
ok(/perplexity\.ai\/search\?q=/.test(Z.link) && /未來計畫/.test(Z.prof) && !BAN.test(Z.prof), 'ⓢ 🎴 遊戲卡:本站真資料 + Perplexity 查未來計畫、⛔ 沒有選股用語', (Z.prof.match(BAN) || [''])[0] + ' | ' + Z.prof.slice(0, 160));
ok(Z.topLeft && Z.cd === Z.sym && Z.nm.length > 0 && Z.colors > 40 && Z.closed, 'ⓢ2 左上角 = 中文名 + 代號;卡圖真的有畫出魚;✕ 關得掉', JSON.stringify([Z.nm, Z.cd, Z.topLeft, Z.colors, Z.closed]));
ok(Z.stats.map(x => x[0]).join() === '體型,熱度,活力,成長,賺錢力' && Z.stats.every(x => x[1].length > 0) && !/總分|戰力|推薦|值得買/.test(Z.prof),
  'ⓢ3 五項能力值都在(數字或「沒有資料」)、⛔ 沒有總分 / 戰力 / 推薦', JSON.stringify(Z.stats));
ok(Z.hues.length >= 2 && Z.hues.every(h => h >= 20 && h <= 60), 'ⓢ4 能力值橫條一律琥珀色(⛔ 不用紅綠)', JSON.stringify(Z.hues));
ok(/100%/.test(Z.big.ex) && Z.big.stars === '★★★★', 'ⓢ5 決定性對照:市值改成全市場最大 → 體型比 100% 的公司大、★★★★', JSON.stringify(Z.big));
ok(/目前虧損中/.test(Z.loss.gm) && /⚠️ 目前虧損中/.test(Z.loss.tt), 'ⓢ7 虧損股:賺錢力寫「目前虧損中」、特性欄有 ⚠️', JSON.stringify(Z.loss));

// ── ⓩ 卡片排序(接在 ⓟ 之後,pg 已經拋網全抓)───────────────
const SO = await pg.evaluate(() => {
  const read = k => [...document.querySelectorAll('#fpvCards .fpvcard')].map(e => e.dataset[k] === '' ? null : +e.dataset[k]);
  PRO.fpvSort('mcap'); const desc = read('mcap'), bar = document.getElementById('fpvSort').innerText;
  PRO.fpvSort('mcap'); const asc = read('mcap');
  PRO.fpvSort('chg'); const chg = read('chg');
  PRO.fpvSort('rank'); const rk = read('rank');
  const mono = (a, d) => { const v = a.filter(x => x != null); return v.every((x, i) => !i || (d > 0 ? x >= v[i - 1] : x <= v[i - 1])) && a.slice(v.length).every(x => x == null); };
  return { desc, asc, chg, rk, bar, ok1: mono(desc, -1), ok2: mono(asc, 1), ok3: mono(chg, -1), ok4: mono(rk, 1) };
});
ok(SO.desc.length >= 2 && SO.ok1 && SO.ok2 && SO.ok3 && SO.ok4 && /名次/.test(SO.bar) && /▼/.test(SO.bar),
  'ⓩ 🔢 卡片可排序:市值由大到小、再按一次反向、今日漲跌、名次;沒資料的排最後', JSON.stringify(SO));

// ── ⓥ 每天記住 / ⓦ 捲線器 + 瞄準 / ⓧ 往左游不顛倒 ───────────
const pg4 = await open('?app=fish');
await pg4.waitForFunction(() => PRO._fpv && PRO._fpv.Q, null, { timeout: 60000 }).catch(() => {});
const V0 = await pg4.evaluate(() => { const S = PRO._fpv, sea = JSON.parse(localStorage.getItem('fpvSea_v1'));
  const order = sea.order.slice(), caught = order.slice(0, 2); localStorage.setItem('fpvSea_v1', JSON.stringify({ date: sea.date, order, caught }));
  return { order, caught, date: sea.date, total: S.Q.total }; });
await pg4.reload();
await pg4.waitForFunction(() => typeof PRO !== 'undefined' && PRO._fpv && PRO._fpv.Q, null, { timeout: 60000 }).catch(() => {});
const V1 = await pg4.evaluate(() => { const S = PRO._fpv;
  return { q: S.Q.fish.map(f => f.sym), cards: [...document.querySelectorAll('#fpvCards .fpvcard')].map(e => e.dataset.fpv), swim: S.swim.map(s => s.F.sym),
           sub: document.getElementById('fpvSub').innerText }; });
ok(V0.total >= 3 && JSON.stringify(V1.q) === JSON.stringify(V0.order.slice(2)) && V1.cards.length === 2 && V0.caught.every(x => V1.cards.includes(x))
   && V1.swim.length === V0.total - 2 && !V1.swim.some(x => V0.caught.includes(x)) && new RegExp('還有 ' + (V0.total - 2) + ' 條').test(V1.sub),
  'ⓥ 🗓️ 重新打開 App:釣過的直接出卡、海裡只剩沒釣的(照上次的隨機順序)', JSON.stringify([V0, V1]));
await pg4.evaluate(() => { const v = JSON.parse(localStorage.getItem('fpvSea_v1')); v.date = '2000-01-01'; localStorage.setItem('fpvSea_v1', JSON.stringify(v)); });
await pg4.reload();
await pg4.waitForFunction(() => typeof PRO !== 'undefined' && PRO._fpv && PRO._fpv.Q, null, { timeout: 60000 }).catch(() => {});
const V2 = await pg4.evaluate(() => ({ n: PRO._fpv.Q.fish.length, total: PRO._fpv.Q.total, cards: document.querySelectorAll('#fpvCards .fpvcard').length,
  sea: JSON.parse(localStorage.getItem('fpvSea_v1')) }));
ok(V2.n === V2.total && V2.cards === 0 && V2.sea.caught.length === 0 && V2.sea.date !== '2000-01-01', 'ⓥ2 換了資料日 → 整池重來', JSON.stringify(V2));
// 🎲 釣起順序隨機:洗牌 30 次,至少有一次跟名次順序不同(⛔ 不可永遠照 #1 → #10)
const SH = await pg4.evaluate(() => { const a = PRO._fpv.Q.fish.map(f => f.rank); let diff = 0;
  for (let k = 0; k < 30; k++) if (JSON.stringify(PRO._fpvShuffle(a)) !== JSON.stringify(a)) diff++; return { diff, same: JSON.stringify(PRO._fpvShuffle(a).slice().sort((x, y) => x - y)) === JSON.stringify(a.slice().sort((x, y) => x - y)) }; });
ok(SH.diff > 20 && SH.same, 'ⓥ3 🎲 釣起順序是洗牌過的(同一批魚、順序隨機)', JSON.stringify(SH));
// 👆 捲線器 + 瞄準(真的滑鼠事件)
const box4 = await (await pg4.$('#fpvCanvas')).boundingBox();
const W4 = await pg4.evaluate(() => { const S = PRO._fpv; return { reel: S.reel, W: S.W, H: S.H, hz: S.hz }; });
await pg4.mouse.click(box4.x + W4.W * 0.3, box4.y + W4.hz + (W4.H - W4.hz) * 0.3);
await pg4.waitForTimeout(300);
const K1 = await pg4.evaluate(() => ({ g: !!PRO._fpv.G, aim: PRO._fpv.aim }));
await pg4.mouse.move(box4.x + W4.W * 0.2, box4.y + W4.hz + 60); await pg4.mouse.down();
await pg4.mouse.move(box4.x + W4.W * 0.25, box4.y + W4.hz + 90, { steps: 4 }); await pg4.mouse.up();
const K2 = await pg4.evaluate(() => ({ g: !!PRO._fpv.G, aim: PRO._fpv.aim }));
await pg4.waitForTimeout(500);
const bx0 = await pg4.evaluate(() => PRO._fpv.bx);
const reel = await pg4.evaluate(() => PRO._fpv.reel);
await pg4.mouse.click(box4.x + reel.x, box4.y + reel.y);
for (let k = 0; k < 40; k++) { if (await pg4.evaluate(() => !!PRO._fpv.G)) break; await pg4.waitForTimeout(50); }
const K3 = await pg4.evaluate(() => { const G = PRO._fpv.G; return { g: !!G, hook: G && G.hook, aim: PRO._fpv.aim, W: PRO._fpv.W }; });
ok(!K1.g && !K2.g && K2.aim && Math.abs(K2.aim.x - W4.W * 0.25) < 3, 'ⓦ 👆 點水面 / 拖曳⛔ 不會拋竿,只會移動落點', JSON.stringify([K1, K2]));
ok(K3.g && Math.abs(K3.hook.x - K3.aim.x) <= K3.W * 0.06 && !(await pg4.$('#fpvCastBtn')), 'ⓦ2 👆 點捲線器才拋;落點在你瞄的地方附近;⛔ 沒有黃色拋竿鈕', JSON.stringify(K3));
ok(bx0 < W4.W * 0.8, 'ⓦ3 🎯 瞄到左邊 → 竿子跟著往左移', JSON.stringify([bx0, W4.W]));
// 🐟 往左游:傳給畫魚的角度恆為 0、改用水平鏡像
const FX = await pg4.evaluate(() => { const S = PRO._fpv, saveG = S.G; S.G = null;
  S.swim.forEach((s, i) => { s.v = i % 2 ? -0.03 : 0.03; });
  const orig = PRO._fpvDrawFish, calls = []; PRO._fpvDrawFish = function (ctx, F, x, y, sc, ang, t, opt) { if (opt && opt.under && opt.alpha === 0.88) calls.push([ang, !!opt.flip]); return orig.apply(this, arguments); };
  PRO._fpvFrame(performance.now(), 0.016); PRO._fpvDrawFish = orig; S.G = saveG;
  const cv = document.createElement('canvas'); cv.width = 200; cv.height = 120; const ctx = cv.getContext('2d'), F = S.swim[0].F;
  const top = flip => { ctx.clearRect(0, 0, 200, 120); orig.call(PRO, ctx, F, 100, 60, 0.5, 0, 0.3, { flip }); const d = ctx.getImageData(0, 0, 200, 120).data;
    let y0 = 999, y1 = -1, x0 = 999, x1 = -1; for (let y = 0; y < 120; y++) for (let x = 0; x < 200; x++) if (d[(y * 200 + x) * 4 + 3] > 120) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); x0 = Math.min(x0, x); x1 = Math.max(x1, x); } return { y0, y1, x0, x1 }; };
  return { calls, r: top(false), l: top(true) }; });
ok(FX.calls.length > 1 && FX.calls.every(c => c[0] === 0) && FX.calls.some(c => c[1]) && FX.calls.some(c => !c[1])
   && Math.abs(FX.r.y0 - FX.l.y0) <= 1 && Math.abs(FX.r.y1 - FX.l.y1) <= 1 && Math.abs((FX.l.x0 - 100) + (FX.r.x1 - 100)) <= 3 && FX.l.x1 - 100 > 100 - FX.l.x0,
  'ⓧ 🐟 往左游 = 水平鏡像:角度恆為 0、上下輪廓跟往右游一樣(⛔ 不會肚子朝上)', JSON.stringify(FX));
// ── ⓨ3 撒網像真的:竿子收起來、換成雙手 + 手拉繩;四段(甩出 / 落水 / 下沉收口 / 拉上來)都有畫 ─────
const NR = await pg4.evaluate(async () => {
  const S = PRO._fpv; localStorage.removeItem('fpvSea_v1'); S.Q = null; S.G = null; S.N = null; await PRO._fpvPrep();
  cancelAnimationFrame(S.raf); S.raf = -1;
  const cnt = { rod: 0, hands: 0, rope: 0 }, o = { rod: PRO._fpvRod, hands: PRO._fpvHands, rope: PRO._fpvRope };
  PRO._fpvRod = function () { cnt.rod++; return o.rod.apply(this, arguments); };
  PRO._fpvHands = function () { cnt.hands++; return o.hands.apply(this, arguments); };
  PRO._fpvRope = function () { cnt.rope++; return o.rope.apply(this, arguments); };
  PRO._fpvFrame(performance.now(), 0.016); const idleRod = cnt.rod; cnt.rod = 0;
  PRO.fpvNet(); const N = S.N, T = PRO._FPV_NET, phs = [];
  for (const ph of ['throw', 'spread', 'sink', 'haul']) for (const p of [0.2, 0.7]) {
    N.ph = ph; N.el = T[ph] * p; N.p = p; PRO._fpvFrame(performance.now(), 0.0001);
    const d = S.ctx.getImageData(0, 0, S.cv.width, S.cv.height).data; let lit = 0; for (let i = 0; i < d.length; i += 16) if (d[i] > 220 && d[i + 1] > 225 && d[i + 2] > 230) lit++;
    phs.push([ph, p, lit]);
  }
  const hands = PRO._fpvHandsAt({ ...N, ph: 'throw', p: 0.2 }, S.W, S.H), hands2 = PRO._fpvHandsAt({ ...N, ph: 'throw', p: 0.9 }, S.W, S.H);
  Object.assign(PRO, { _fpvRod: o.rod, _fpvHands: o.hands, _fpvRope: o.rope });
  N.ph = 'haul'; N.el = T.haul; PRO._fpvNetStep(N, 0.01);
  return { idleRod, rod: cnt.rod, hands: cnt.hands, rope: cnt.rope, phs, back: hands.x > S.W * 0.55, fwdUp: hands2.y < hands.y, done: !S.N, T };
});
ok(NR.idleRod === 1 && NR.rod === 0 && NR.hands >= 8 && NR.rope >= 6, 'ⓨ3 🕸️ 撒網時竿子收起來(一次都沒畫)、換成雙手 + 手拉繩;平常待機才有竿子', JSON.stringify(NR));
ok(NR.back && NR.fwdUp && NR.T.throw >= 800 && NR.T.haul >= 1200 && NR.done, 'ⓨ4 🕸️ 甩網動作:先往右後拉、再往前上甩出;整段動畫 ≥3 秒、拉完就全部上岸', JSON.stringify([NR.back, NR.fwdUp, NR.T]));

// ── 🌊 V78.0.4 放回海裡 / 閒置線收在竿尖(使用者:「拋竿的線永遠都顯示已拋出去」「新增放魚回去」)─────
for (let k = 0; k < 40; k++) { if (await pg4.evaluate(() => !PRO._fpv.N)) break; await pg4.waitForTimeout(50); }
const RL = await pg4.evaluate(() => {
  const S = PRO._fpv, cards = () => [...document.querySelectorAll('#fpvCards .fpvcard')].map(e => e.dataset.fpv);
  const left = () => S.Q.fish.length - S.Q.i, bask = localStorage.getItem('proWar_catch');
  const c0 = cards(), btn = !!document.querySelector('#fpvCards .fpvcard .fpvrel'), allBtn = !!document.getElementById('fpvRelAll'), total = S.Q.total, l0 = left();
  const sym = c0[0];
  const r1 = PRO.fpvRelease(sym), c1 = cards(), sea1 = JSON.parse(localStorage.getItem('fpvSea_v1'));
  const one = { r1, cards: c1.length, gone: !c1.includes(sym), caught: sea1.caught.length, notCaught: !sea1.caught.includes(sym), left: left(),
    q0: S.Q.fish[S.Q.i] && S.Q.fish[S.Q.i].sym, swim: S.swim.some(x => x.F.sym === sym), net: !document.getElementById('fpvNet').classList.contains('hidden'),
    bask: localStorage.getItem('proWar_catch') === bask };
  S.G = { done: false }; const busy = PRO.fpvRelease(c1[0]); const busyCards = cards().length; S.G = null;
  const r2 = PRO.fpvReleaseAll(), sea2 = JSON.parse(localStorage.getItem('fpvSea_v1'));
  const all = { r2, cards: cards().length, caught: sea2.caught.length, left: left(), swim: S.swim.length, sort: document.getElementById('fpvSort').classList.contains('hidden'),
    bask: localStorage.getItem('proWar_catch') === bask, sub: document.getElementById('fpvSub').innerText };
  return { total, l0, c0: c0.length, btn, allBtn, one, busy, busyCards, busyC1: c1.length, all };
});
ok(RL.total >= 3 && RL.c0 === RL.total && RL.l0 === 0 && RL.btn && RL.allBtn, '🌊a 全部釣起後每張卡都有「🌊 放回海裡」、上方有「🌊 全部放回」—— 🚧 空過守門', JSON.stringify(RL));
ok(RL.one.r1.ok && RL.one.cards === RL.total - 1 && RL.one.gone && RL.one.caught === RL.total - 1 && RL.one.notCaught && RL.one.left === 1 && RL.one.q0 && RL.one.swim && RL.one.net,
  '🌊b 放回一條:卡片少一張、今天的海記錄拿掉牠、牠回到水裡游、可以再釣(拋網鈕也回來了)', JSON.stringify(RL.one));
ok(RL.one.bask && RL.all.bask, '🌊c ⭐ 放回海裡⛔ 不動漁獲籃(proWar_catch 前後一字不差)', JSON.stringify([RL.one.bask, RL.all.bask]));
ok(RL.busy && RL.busy.busy && RL.busyCards === RL.busyC1, '🌊d 正在釣(線上有魚)時⛔ 不可放魚回去', JSON.stringify(RL.busy));
ok(RL.all.r2.ok && RL.all.cards === 0 && RL.all.caught === 0 && RL.all.left === RL.total && RL.all.swim === RL.total && RL.all.sort && new RegExp('還有 ' + RL.total + ' 條').test(RL.all.sub),
  '🌊e 全部放回:卡片清空、海裡回到全部的魚、排序列收起來', JSON.stringify(RL.all));
await pg4.reload();
await pg4.waitForFunction(() => typeof PRO !== 'undefined' && PRO._fpv && PRO._fpv.Q, null, { timeout: 60000 }).catch(() => {});
const RL2 = await pg4.evaluate(() => ({ cards: document.querySelectorAll('#fpvCards .fpvcard').length, left: PRO._fpv.Q.fish.length - PRO._fpv.Q.i, total: PRO._fpv.Q.total }));
ok(RL2.cards === 0 && RL2.left === RL2.total && RL2.total === RL.total, '🌊f 放回之後重新打開 App:還是在海裡(記得住)', JSON.stringify(RL2));
const HK = await pg4.evaluate(() => { const S = PRO._fpv; S.G = null; S.N = null; const t = performance.now();
  PRO._fpvFrame(t, 0.016); const a = { h: { ...S.idleHook }, tip: { ...S.idleTip } };
  const i0 = S.Q.i; S.Q.i = S.Q.fish.length; PRO._fpvFrame(t + 16, 0.016); const b = { h: { ...S.idleHook }, tip: { ...S.idleTip } }; S.Q.i = i0;
  return { a, b, W: S.W }; });
const dy = o => o.h.y - o.tip.y, dx = o => Math.abs(o.h.x - o.tip.x);
ok(dx(HK.a) <= 6 && dy(HK.a) > 10 && dy(HK.a) < 45 && dx(HK.b) <= 6 && dy(HK.b) < dy(HK.a),
  '🌊g 🎣 沒在釣時線收在竿尖、鉤子吊在竿尖正下方(⛔ 不再畫成已經拋進水裡);海裡沒魚時收得更短', JSON.stringify(HK));
const txtR = await pg4.evaluate(() => document.body.innerText);
ok(!BAN.test(txtR), '🌊h 新按鈕 / 提示⛔ 沒有選股規則用語', (txtR.match(BAN) || [])[0]);

// ── 🐟 V78.0.5 魚游過去咬餌(使用者:「魚要有跑去咬餌的動作」)────────────
const AP = await pg4.evaluate(() => {
  const hz = 170, G = { waitMs: 1700, nib0: [900], hook: { x: 200 }, el: 0 };
  const at = (el, nx = 20) => { G.el = el; return PRO._fpvApproach(G, nx, 400, 0.8, hz); };
  const a0 = at(0), aNib = at(900), aHover = at(1250), aEnd = at(1699);
  G.ap = null; const R = { waitMs: 1700, nib0: [], hook: { x: 200 }, el: 0 }; R.el = 800; const r1 = PRO._fpvApproach(R, 360, 400, 0.8, hz);
  let maxJump = 0; G.ap = null; let prev = null; for (let el = 0; el <= 1700; el += 16) { const q = at(el); if (prev) maxJump = Math.max(maxJump, Math.hypot(q.x - prev.x, q.y - prev.y)); prev = q; }
  return { a0, aNib, aHover, aEnd, r1flip: r1.flip, maxJump, hy: hz + 32 };
});
ok(Math.abs(AP.a0.x - 20) < 1e-9 && Math.abs(AP.aEnd.x - 200) < 2 && Math.abs(AP.aEnd.y - AP.hy) < 2 && Math.abs(AP.aEnd.sc - 0.45) < 0.01,
  '🐟a 等咬鉤:一開始照原路徑游、最後一刻嘴剛好在餌上(位置 / 大小接得上 bite 那一段)', JSON.stringify(AP));
ok(Math.abs(AP.aNib.x - 200) < Math.abs(AP.aHover.x - 200) - 10 && AP.r1flip === true && AP.maxJump < 20,
  '🐟b 假咬 = 往前衝碰到餌再退回;從右邊游來的魚頭朝左;每一格位移都小於 20px(⛔ 不會瞬移)', JSON.stringify(AP));
const AF = await pg4.evaluate(() => {
  const S = PRO._fpv; cancelAnimationFrame(S.raf); S.raf = -1; S.G = null; S.N = null;
  if (!(S.Q && S.Q.fish.length - S.Q.i > 0)) return { none: true };
  PRO._fpvOne(); cancelAnimationFrame(S.raf); S.raf = -1; const G = S.G;
  PRO._fpvEnter(G, 'wait'); G.el = G.waitMs - 20; G.ap = null; S.dbgFish = [];
  for (let k = 0; k < 3; k++) { G.el = G.waitMs - 20 + k * 2; PRO._fpvFrame(performance.now(), 0.0001); }
  const f = S.dbgFish.at(-1);
  return { f, hx: G.hook.x, hy: S.hz + 32, ph: G.ph };
});
ok(!AF.none && AF.f && Math.abs(AF.f.x - AF.hx) <= 40 && Math.abs(AF.f.y - AF.hy) <= 40,
  '🐟c 實際畫面:等咬鉤的最後一刻,那條魚真的畫在浮標下面的餌旁邊(⛔ 不是還在遠處亂游)', JSON.stringify(AF));

// 📱 遊戲卡避開瀏海
ok(/\.fpvcw\{[^}]*env\(safe-area-inset-top\)[^}]*env\(safe-area-inset-bottom\)/.test(SRC) && /\.fpvtcg\{[^}]*max-height:calc\(100dvh[^}]*safe-area-inset-top/.test(SRC),
  'ⓢ8 📱 遊戲卡上下留出瀏海 / 底部橫條的空間(safe-area)');

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
