// ⏱️ V80.0.0 手機冷開 index.html 量測(performance-optimization:先量再改)—— 巡邏工具,⛔ 不進四驗證、exit 0
//   用法:CPU=4 node scripts/perf_probe.mjs          (CPU = Chrome CPU 降速倍數,4 ≈ 中階手機)
//         PAGE=/path/to/壓縮版.html CPU=4 node scripts/perf_probe.mjs   (量部署那份:node scripts/build_min.mjs 產出)
//   印:載入 / app 就緒毫秒、第一次畫面、主執行緒時間、堆積、最長的幾個長任務(ms)。
//   2026-10-30 實測(390×844、4×降速):部署那份(壓縮)第一次畫面約 0.47 秒、app 就緒約 1.5 秒;原檔約 1.1 / 2.2 秒;
//   最長任務約 240 ms、第二次開 App 走 Service Worker 快取 → 沒有明確瓶頸,⛔ 沒改程式(沒量到瓶頸就不優化)。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch (_) { pw = require('/opt/node22/lib/node_modules/playwright'); }
const { chromium } = pw;
const b = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
const cdp = await ctx.newCDPSession(p);
await cdp.send('Performance.enable'); await cdp.send('Emulation.setCPUThrottlingRate',{rate:+(process.env.CPU||1)});
const t0 = Date.now();
await p.goto('file://' + (process.env.PAGE||process.cwd()+'/index.html'), { waitUntil: 'load', timeout: 60000 });
const tLoad = Date.now() - t0;
await p.waitForFunction(() => typeof app !== 'undefined' && app._APP_VERSION, null, { timeout: 30000 }).catch(() => {});
const tApp = Date.now() - t0;
const nav = await p.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; const pt = performance.getEntriesByType('paint'); return { dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), paints: pt.map(x => [x.name, Math.round(x.startTime)]) }; });
const m = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(x => [x.name, x.value]));
const lt = await p.evaluate(() => new Promise(r => { const out = []; try { new PerformanceObserver(l => out.push(...l.getEntries().map(e => Math.round(e.duration)))).observe({ type: 'longtask', buffered: true }); } catch (_) {} setTimeout(() => r(out), 500); }));
console.log(JSON.stringify({ tLoad, tApp, nav, scriptDur: +m.ScriptDuration.toFixed(2), taskDur: +m.TaskDuration.toFixed(2), layoutDur: +m.LayoutDuration.toFixed(2), heapMB: +(m.JSHeapUsedSize / 1e6).toFixed(1), nodes: m.Nodes, longTasks: lt.sort((a, b) => b - a).slice(0, 8) }));
await b.close();
