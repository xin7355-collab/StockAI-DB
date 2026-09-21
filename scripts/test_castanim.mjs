#!/usr/bin/env node
// 🎣 V77.4.1 拋竿動畫(canvas 狀態機)—— 使用者:「釣魚介面有沒有辦法做動畫」
//   ⭐ 附件那份介面本身**沒有任何動畫**;本站魚缸早就有魚游、同族靠攏、光暈,缺的是**拋竿的操作回饋**
//   (`castRod` 那 420ms 以前是純 setTimeout,畫面沒動)。
//
// ⛔ 這支釘的「用意」:
//   ⓐ ⭐ 決定性對照:動畫⛔ 不改變名單(stub 掉 `_castAnimRun` 前後 picked 相同;呼叫時 `_cast.picked` 已存在)
//   ⓑ phase 依序 fly → splash → (pull|bob) → reel → done;總時長 800~2500ms
//   ⓒ 離屏 canvas 真的有畫(fly 中段非透明像素 >0;done = 0;splash 中段 > fly 中段)
//   ⓓ reduce-motion → 直接 done、<300ms     ⓔ 列表模式同 ⓓ
//   ⓕ 沒有魚上鉤 → 序列含 bob、reel,而且「今天沒有魚上鉤」那張卡看得見
//   ⓖ 🛟 安全閥:rAF 不跑仍 ≤3s resolve      ⓗ 靜態:castRod 無 setTimeout(r, 420)、_fishTick 掛了 _castAnimDraw
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_MODULE || '/opt/node22/lib/node_modules/playwright');
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

let bad = 0;
const ok = (c, n, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${e ? ' — ' + e : ''}`); if (!c) bad++; };
for (const f of ['data/screener.json', 'data/playbook_edge.json']) {
  if (!existsSync(f)) { console.log(`❌ 沒有 ${f}(跑 bash scripts/fetch_testdata.sh)—— ⛔ 不跑假測試`); process.exit(1); }
}
const PB = JSON.parse(readFileSync('data/playbook_edge.json', 'utf8'));
if (!(PB.picks || []).length) { console.log('❌ 空過守門:playbook 沒有 picks → 拋竿測不到'); process.exit(1); }
const SRC = readFileSync('pro.html', 'utf8');
const body = (head) => { const i = SRC.indexOf(head); return i < 0 ? '' : SRC.slice(i, SRC.indexOf('\n  },', i)); };

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const pg = await b.newPage();
await pg.emulateMedia({ reducedMotion: 'no-preference' });
const errs = []; pg.on('pageerror', e => errs.push(String(e).slice(0, 200)));
await pg.goto(pathToFileURL(resolve('pro.html')).href);
await pg.waitForFunction(() => typeof PRO !== 'undefined' && !!PRO._castAnimRun, null, { timeout: 30000 });
await pg.evaluate(async () => { PRO.switchTab('rod'); try { await PRO._rodP; } catch (_) {} });
const hasD = await pg.evaluate(() => !!PRO._fishD && PRO._fish.length > 0 && !!PRO._fishRaf);
ok(hasD, '⓪ 魚缸在跑(資料 + rAF)—— 🚧 空過守門');

// ── ⓐ 決定性對照 ────────────────────────────────────────────
const A = await pg.evaluate(async () => {
  const saved = PRO._castAnimRun;
  let hadPicked = null;
  PRO._castAnimRun = async function (t, none) { hadPicked = !!(PRO._cast && Array.isArray(PRO._cast.picked)); };
  await PRO.castRod(); const p1 = PRO._cast.picked.map(x => x.sym).join(',');
  PRO._castAnimRun = saved;
  PRO.fishBack(true); PRO._fishPoolK = 'gene'; await (PRO._rodP = PRO.renderRod());
  const t0 = performance.now();
  await PRO.castRod(); const p2 = PRO._cast.picked.map(x => x.sym).join(',');
  const dt = performance.now() - t0;
  return { hadPicked, p1, p2, dt, seq: PRO._castAnim ? PRO._castAnim.seq.slice() : [], phase: PRO._castAnim && PRO._castAnim.phase };
});
ok(A.hadPicked === true && A.p1 === A.p2 && A.p1.length > 0, 'ⓐ ⭐ 動畫⛔ 不改變名單(stub 前後 picked 相同;呼叫時名單已算好)', `p1=${A.p1} p2=${A.p2}`);
const hasPull = A.seq.includes('pull') || A.seq.includes('bob');
ok(A.phase === 'done' && A.seq[0] === 'fly' && A.seq.includes('splash') && hasPull && A.seq.includes('reel') && A.seq[A.seq.length - 1] === 'done',
  'ⓑ phase 依序 fly → splash → (pull|bob) → reel → done', A.seq.join('→'));
ok(A.dt >= 800 && A.dt <= 4000, 'ⓑ2 拋竿整段(含重畫)800ms~4s,⛔ 不可卡住', `${Math.round(A.dt)}ms`);

// ── ⓒ 離屏 canvas 真的有畫 ───────────────────────────────────
const C = await pg.evaluate(() => {
  const cv = document.createElement('canvas'); cv.width = 300; cv.height = 200; const ctx = cv.getContext('2d');
  const W0 = PRO._fishW, H0 = PRO._fishH; PRO._fishW = 300; PRO._fishH = 200;
  const count = () => { const d = ctx.getImageData(0, 0, 300, 200).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; };
  const mk = (phase, frac) => ({ phase, t0: performance.now() - PRO._CAST_DUR[phase] * frac, seq: [phase], targets: [], none: true, from: { x: 18, y: 14 }, timer: 0, finish() { this.phase = 'done'; } });
  const saved = PRO._castAnim;
  PRO._castAnim = mk('fly', 0.5); ctx.clearRect(0, 0, 300, 200); PRO._castAnimDraw(ctx, performance.now()); const fly = count();
  PRO._castAnim = mk('splash', 0.5); ctx.clearRect(0, 0, 300, 200); PRO._castAnimDraw(ctx, performance.now()); const splash = count();
  PRO._castAnim = { phase: 'done', seq: ['done'] }; ctx.clearRect(0, 0, 300, 200); PRO._castAnimDraw(ctx, performance.now()); const done = count();
  PRO._castAnim = saved; PRO._fishW = W0; PRO._fishH = H0;
  return { fly, splash, done };
});
ok(C.fly > 0 && C.done === 0 && C.splash > C.fly, 'ⓒ 離屏 canvas:fly 中段有畫、done 不畫、splash(漣漪)比 fly 畫得多', JSON.stringify(C));

// ── ⓓ reduce-motion / ⓔ 列表模式 ─────────────────────────────
await pg.emulateMedia({ reducedMotion: 'reduce' });
const D = await pg.evaluate(async () => { const t0 = performance.now(); await PRO._castAnimRun(['x'], false); return { dt: performance.now() - t0, ph: PRO._castAnim.phase, seq: PRO._castAnim.seq }; });
ok(D.ph === 'done' && D.dt < 300 && D.seq.length === 1, 'ⓓ prefers-reduced-motion → 第一次讀 phase 就是 done、<300ms', `${Math.round(D.dt)}ms ${D.seq}`);
await pg.emulateMedia({ reducedMotion: 'no-preference' });
const E = await pg.evaluate(async () => {
  const m = PRO._fishModeV; PRO._fishModeV = 'list';
  const t0 = performance.now(); await PRO._castAnimRun(['x'], false); const r = { dt: performance.now() - t0, ph: PRO._castAnim.phase };
  PRO._fishModeV = m; return r;
});
ok(E.ph === 'done' && E.dt < 300, 'ⓔ 列表模式(沒有魚缸)→ 直接 done', `${Math.round(E.dt)}ms`);

// ── ⓕ 沒有魚上鉤 ────────────────────────────────────────────
const F = await pg.evaluate(async () => {
  PRO.fishBack(true); PRO._fishPoolK = 'gene'; await (PRO._rodP = PRO.renderRod());
  const saved = PRO._recoPicks; PRO._recoPicks = () => [];
  await PRO.castRod();
  PRO._recoPicks = saved;
  const pick = document.getElementById('fishPickPane');
  return { seq: PRO._castAnim.seq.slice(), vis: !pick.classList.contains('hidden'), txt: document.getElementById('fishCard').innerText.slice(0, 60),
           chips: (document.getElementById('rodCastPicks') || {}).innerText || '' };
});
ok(F.seq.includes('bob') && F.seq.includes('reel') && F.vis && /今天沒有魚上鉤/.test(F.txt) && /沒有魚上鉤/.test(F.chips),
  'ⓕ 沒有魚上鉤 → 浮標上下(bob)→ 收線;「今天沒有魚上鉤」那張卡看得見、02 段也寫了', `${F.seq.join('→')} vis=${F.vis}`);

// ── ⓖ 安全閥 ────────────────────────────────────────────────
const G = await pg.evaluate(async () => {
  PRO.fishStop();
  const raf = window.requestAnimationFrame; window.requestAnimationFrame = () => 0;   // rAF 不跑 = 沒有任何一幀會推進 phase
  PRO._fishRaf = 1;                                                                   // 假裝魚缸還活著(canDraw 要 true 才進得了狀態機)
  const t0 = performance.now();
  // ⚠️ 用 race 包住:拿掉安全閥時要**紅**,⛔ 不可讓測試自己卡住(卡住 = 沒有結果 = 假的「沒抓到」)
  const hung = await Promise.race([PRO._castAnimRun(['x'], false).then(() => false), new Promise(r => setTimeout(() => r(true), 4000))]);
  const dt = performance.now() - t0;
  if (hung && PRO._castAnim) { PRO._castAnim.resolved = true; PRO._castAnim.phase = 'done'; }
  window.requestAnimationFrame = raf; PRO._fishRaf = 0; PRO._fishStart();
  return { dt, ph: PRO._castAnim.phase, seq: PRO._castAnim.seq, hung };
});
ok(G.ph === 'done' && G.dt >= 2000 && G.dt <= 3500 && G.seq[0] === 'fly' && !G.hung, 'ⓖ 🛟 rAF 被停掉時安全閥 2.5s 仍會 resolve(名單⛔ 不可卡住)', `${Math.round(G.dt)}ms ${G.seq}`);

// ── ⓗ 靜態 ──────────────────────────────────────────────────
const cast = body('  async castRod() {'), tick = body('  _fishTick(t, move) {');
ok(cast.length > 200 && !/setTimeout\(r, 420\)/.test(cast) && /_castAnimRun\(/.test(cast) && /_castAnimDraw\(ctx/.test(tick),
  'ⓗ 靜態:castRod 用 `_castAnimRun` 取代 setTimeout(420);`_fishTick` 尾端掛 `_castAnimDraw`');
ok(errs.length === 0, 'ⓘ ⛔ 無 pageerror', errs.join(' | '));
await b.close();
console.log(bad ? `\n❌ ${bad} 條失敗` : '\n✅ CASTANIM_PASS(全部通過)');
process.exit(bad ? 1 : 0);
