#!/usr/bin/env node
// 🧪 V77.6.7 pro.html 從 index.html「原地解析常數」的守門
//
// 🚨 起因:正式網站(gh-pages)上的 index.html 是**壓縮版**(deploy_pages.yml → scripts/build_min.mjs),
//   整份只有一行、鍵前面是 `,` 不是換行。pro.html 的 `_cutLiteral` 舊寫法要求「換行 + 空白」開頭 →
//   正式網站上 `_SIGNAL_EDGE / _TIDY / _NOISE_GONE / _NOISE_KEEP / _CHANGELOG / _EDGE_RULES` **六個全部解析不到**:
//   🎣 釣魚池寫「🧬 門檻現在讀不到」、雜訊清單與更新紀錄一起空掉。
//   ⚠️ 而 test_fishrod 讀的是**未壓縮原檔** → 永遠綠(陷阱 #40:測試環境 ≠ 正式環境)。
//
// ① 壓縮版(這裡用 build_min.mjs 自己壓一份)+ 正式網站現在那一份 + 原檔,六個常數都要解析得到、而且跟原檔內容一樣
// ② 合成單行測資:鍵前面是 `,` / `{` 要抓得到;`this._X:` 那種(前面是 `.`)⛔ 不可被當成定義
// ③ 兩個呼叫端同時 loadIdx() → 兩個都要等到資料(⛔ 後到的不可立刻 return 拿到 null)
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

let fail = 0;
const ok = (c, m, d = '') => { console.log((c ? '✅ ' : '❌ ') + m + (d ? ' — ' + d : '')); if (!c) fail++; };

const pro = readFileSync(new URL('../pro.html', import.meta.url), 'utf8');
const grab = name => {
  const m = new RegExp('\\n  ' + name + '\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n  \\},').exec(pro);
  if (!m) throw new Error('pro.html 找不到 ' + name);
  return m[0].trim().replace(/,$/, '');
};
const obj = new Function('return ({' + grab('_cutLiteral') + ',' + grab('loadIdx') + ',' + grab('async _loadIdxOnce') + '})')();
const NAMES = ['_SIGNAL_EDGE', '_TIDY', '_NOISE_GONE', '_NOISE_KEEP', '_CHANGELOG', '_EDGE_RULES'];
const val = (src, n) => { const lit = obj._cutLiteral(src, n); return lit ? new Function('return (' + lit + ')')() : null; };

// ① 正式網站上的 index.html 有兩種形狀,⛔ 兩種都要解析得到:
//   ・壓縮版 —— deploy_pages.yml 用 build_min.mjs 壓的
//   ・原檔   —— daily_miner 的部署 job 直接推 main 的原檔(不壓縮)
//   🚨 V79.1.3:舊版拿「gh-pages 那份」當壓縮版測資 → 哪種形狀要看最後誰部署;而 V79.0.0 起 build_min 的抽樣
//     清單有個已刪掉的名字(_brokerEl)→ 壓縮每次都失敗、默默退回原檔 → 這條紅了好幾天,而部署 workflow 全綠。
//   → 壓縮版改成這裡自己用 build_min.mjs 壓一份(同時擋住「壓縮在部署時默默失敗」),gh-pages 那份只驗「解析得到」。
const src = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const checkShape = (tag, html) => {
  const miss = NAMES.filter(n => { try { return val(html, n) == null; } catch (_) { return true; } });
  ok(!miss.length, `${tag} 六個常數都解析得到`, miss.length ? '解析不到:' + miss.join(',') : '');
  const er = (() => { try { return val(html, '_EDGE_RULES'); } catch (_) { return null; } })();
  const srcEr = val(src, '_EDGE_RULES');
  ok(!!(er && er.gene && srcEr && JSON.stringify(er.gene) === JSON.stringify(srcEr.gene)), `${tag} 🧬 門檻跟原檔一模一樣`, er && er.gene ? `pos=${er.gene.pos} amp=${er.gene.amp}` : '');
};
// ①a 自己壓一份(esbuild:先找 NODE_PATH,沒有就裝進暫存快取;裝不到 ⛔ 不假裝驗過)
{
  const { mkdtempSync, existsSync, mkdirSync } = await import('node:fs');
  const os = await import('node:os'); const path = await import('node:path');
  const cache = path.join(os.tmpdir(), 'stockai-esbuild');
  const np = [process.env.NODE_PATH, path.join(cache, 'node_modules')].filter(Boolean).join(path.delimiter);
  if (!existsSync(path.join(cache, 'node_modules', 'esbuild'))) {
    try { mkdirSync(cache, { recursive: true }); execSync('npm i --no-audit --no-fund --silent --prefix ' + JSON.stringify(cache) + ' esbuild', { stdio: 'ignore', timeout: 180000 }); } catch (_) {}
  }
  const out = path.join(mkdtempSync(path.join(os.tmpdir(), 'idxmin-')), 'index.min.html');
  const BUILD = new URL('./build_min.mjs', import.meta.url).pathname, SRCP = new URL('../index.html', import.meta.url).pathname;
  let log = '', okBuild = false;
  try { log = execSync(`node ${JSON.stringify(BUILD)} ${JSON.stringify(SRCP)} ${JSON.stringify(out)}`, { env: { ...process.env, NODE_PATH: np }, maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'pipe'] }).toString(); okBuild = true; }
  catch (e) { log = String(e.stdout || '') + String(e.stderr || ''); }
  ok(okBuild, '①a build_min.mjs 壓得過(⛔ 壓不過 = 部署會默默退回未壓縮原檔)', log.trim().split('\n').filter(l => /❌|⚠️|壓縮完成/.test(l)).join(' / ').slice(0, 200));
  if (okBuild) {
    const mn = readFileSync(out, 'utf8');
    const oldForm = NAMES.filter(n => new RegExp('\\n\\s*' + n + ':\\s*[\\[{]').test(mn));
    ok(oldForm.length === 0, '①0 空過守門:壓出來的真的是單行形狀(六個鍵都不在行首 = 舊寫法會全部抓不到)',
       `${mn.split('\n').length} 行 vs 原檔 ${src.split('\n').length} 行${oldForm.length ? ' ・行首仍有:' + oldForm.join(',') : ''}`);
    checkShape('①b 壓縮版', mn);
  }
}
// ①c 正式網站現在那一份(壓縮或原檔都可以,只要解析得到)
let gp = null;
try { gp = execSync('git show origin/gh-pages:index.html', { maxBuffer: 64 << 20 }).toString(); } catch (_) {}
if (!gp) { console.log('⚠️ ①c 讀不到 origin/gh-pages:index.html(先 git fetch origin gh-pages)→ 這一條沒驗到'); fail++; }
else {
  const shape = gp.split('\n').length < src.split('\n').length / 3 ? '壓縮版' : '原檔';
  console.log(`   ℹ️ 正式網站現在是「${shape}」(${(gp.length / 1024).toFixed(0)} KB)`);
  checkShape('①c 正式網站(' + shape + ')', gp);
}
checkShape('①d 原檔', src);

// ② 合成單行
const one = 'const app={x:1,y:this._EDGE_RULES?1:2,z:a._EDGE_RULES,_EDGE_RULES:{gene:{pos:75,amp:3.2}},_TIDY:[["a","b"]]};';
const e2 = val(one, '_EDGE_RULES');
ok(!!(e2 && e2.gene && e2.gene.pos === 75), '② 單行測資:`,_EDGE_RULES:{` 抓得到', JSON.stringify(e2));
ok(JSON.stringify(val(one, '_TIDY')) === '[["a","b"]]', '②b 單行測資:`,_TIDY:[` 抓得到');
ok(obj._cutLiteral('x={a:b._TIDY:[1]}', '_TIDY') === null, '②c `._TIDY:` 前面是 `.` ⛔ 不可被當成定義');

// ③ 兩個呼叫端同時 loadIdx
const minimal = 'x={_SIGNAL_EDGE:[1],_TIDY:[2],_NOISE_GONE:[3],_NOISE_KEEP:[4],_CHANGELOG:[{v:"V1"}],_EDGE_RULES:{gene:{pos:75}},_APP_VERSION:"V9.9.9"}';
let calls = 0;
globalThis.fetch = async () => { calls++; await new Promise(r => setTimeout(r, 30)); return { ok: true, text: async () => minimal }; };
const A = Object.assign({ _idxData: null, _idxErr: null, _idxLoading: false }, obj);
const seen = [];
await Promise.all([A.loadIdx().then(() => seen.push(!!A._idxData)), A.loadIdx().then(() => seen.push(!!A._idxData))]);
ok(seen.length === 2 && seen.every(Boolean), '③ 兩個呼叫端同時 loadIdx() → 兩個都等到資料(⛔ 後到的不可拿到 null)', JSON.stringify(seen));
ok(calls === 1, '③b 只抓一次 index.html(共用同一個 promise)', `fetch ${calls} 次`);
await A.loadIdx();
ok(calls === 1, '③c 已經有資料就不再抓', `fetch ${calls} 次`);

// ④ V79.1.4 兩條部署路都要壓縮(⛔ daily_miner 以前直接推原檔 → 每輪採礦後網站變回 4.6MB)
{
  const wf = n => readFileSync(new URL('../.github/workflows/' + n, import.meta.url), 'utf8');
  const dp = wf('deploy_pages.yml'), dm = wf('daily_miner.yml');
  ok(/node scripts\/build_min\.mjs/.test(dp), '④a deploy_pages.yml 有呼叫 build_min.mjs');
  const iCp = dm.indexOf('cp index.html            /tmp/mine/');
  const iMin = dm.indexOf('node scripts/build_min.mjs /tmp/mine/index.html');
  const iBack = dm.indexOf('cp /tmp/mine/index.html');
  ok(iMin > 0, '④b daily_miner.yml 部署前有壓縮 /tmp/mine/index.html');
  ok(iCp > 0 && iBack > 0 && iCp < iMin && iMin < iBack, '④c 壓縮排在「備份 index.html」之後、「放回 gh-pages」之前', `cp=${iCp} min=${iMin} back=${iBack}`);
  ok(/build_min\.mjs[^\n]*\/tmp\/index\.min\.html[^\n]*\n[^\n]*cp \/tmp\/index\.min\.html \/tmp\/mine\/index\.html/.test(dm), '④d 壓成功才換掉那一份(壓不過照推原檔、⛔ 不擋部署)');
}

console.log(fail ? `\n❌ IDXPARSE_FAIL(${fail})` : '\n✅ IDXPARSE_PASS(全部通過)');
process.exit(fail ? 1 : 0);
