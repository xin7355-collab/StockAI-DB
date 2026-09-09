// 🧪 極端超跌接刀偵測器(V71.8.9)
// ⚠️ 重點:這支的用途是**戳破「跌到地板 95% 會反彈」這個說法**,不是推薦接刀。
// floor_probe.py 實測(2,515 檔 / 5,310 次 / 已扣同期大盤):
//   1日 +0.14% 勝率52.0% ・10日 −0.70% 勝率45.5% ・帶量比沒量好 0.25~0.59pp
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
import { pathToFileURL } from 'node:url';
let fails = [];
const ok = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + x}`); if (!c) fails.push(n); };
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox','--disable-gpu'] });
const pg = await b.newPage();
await pg.addInitScript(()=>{const noop=()=>inst;const inst=new Proxy({},{get:(_t,k)=>(k==='getWidth'||k==='getHeight')?(()=>300):noop});Object.defineProperty(window,'echarts',{value:new Proxy({},{get:(_t,k)=>k==='init'?(()=>inst):(k==='graphic'?{}:noop)}),writable:true,configurable:true});});
const errs=[]; const benign=t=>/Failed to load resource|net::ERR_|ERR_|CORS|Cross origin|vibrate|chromestatus|Access to fetch/i.test(t);
pg.on('pageerror',e=>{const t=e&&e.message?e.message:String(e); if(!benign(t)) errs.push(t);});
await pg.route('**/*',r=>{const u=r.request().url();if(u.startsWith('file://'))return r.continue();if(/cdn|jsdelivr|unpkg|tailwind|echarts/i.test(u))return r.continue();return r.abort();});
await pg.goto(pathToFileURL('/home/user/StockAI-DB/index.html').href,{waitUntil:'domcontentloaded',timeout:45000});
await pg.waitForTimeout(2500);

const R = await pg.evaluate(()=>{
  // 造 320 根:前 300 根在 100 附近小幅震盪,最後 20 根急殺 → 製造「自己歷史最極端」的乖離
  const mk=(crashPct, lastVolMult)=>{
    const d=[]; let c=100;
    for(let i=0;i<300;i++){ c=100+Math.sin(i/8)*2; d.push({date:'2026/01/01',open:c,high:c*1.01,low:c*0.99,close:c,volume:5000}); }
    for(let i=0;i<20;i++){ c*=(1-crashPct/100); d.push({date:'2026/07/31',open:c,high:c*1.01,low:c*0.99,close:c,volume:5000}); }
    d[d.length-1].volume = 5000*lastVolMult;
    return d;
  };
  const flat=()=>{ const d=[]; for(let i=0;i<320;i++){const c=100+Math.sin(i/8)*2; d.push({date:'2026/01/01',open:c,high:c*1.01,low:c*0.99,close:c,volume:5000});} return d; };
  return {
    bigVol: app._detectFloorBounce(mk(1.5, 3)),     // 急殺 + 3 倍量
    noVol:  app._detectFloorBounce(mk(1.5, 1)),     // 急殺 + 沒量
    normal: app._detectFloorBounce(flat()),          // 沒有極端超跌
    short:  app._detectFloorBounce(mk(1.5,3).slice(-100)),  // 資料太短
    bad:    [app._detectFloorBounce(null), app._detectFloorBounce([]), app._detectFloorBounce([{}])],
    wired:  (()=>{ const src=app._detectFloorBounce.toString(); return true; })(),
  };
});
await b.close();

ok('渲染無 pageerror', errs.length===0, errs[0]||'');
ok('① 極端超跌 + 帶量 → 會觸發', R.bigVol.length===1, JSON.stringify(R.bigVol.length));
ok('① 極端超跌 + 沒量 → 也會觸發(但標題不同,提醒更不該接)',
   R.noVol.length===1 && R.noVol[0].title.includes('沒量'), R.noVol[0]?.title);
ok('① 帶量時標題要標「有量」', R.bigVol[0].title.includes('有量'), R.bigVol[0]?.title);
ok('② 沒有極端超跌 → 不出現(條件觸發,不佔版面)', R.normal.length===0, JSON.stringify(R.normal));
ok('② 資料太短 → 不硬判', R.short.length===0, JSON.stringify(R.short));
ok('③ 壞輸入不 throw', R.bad.every(x=>Array.isArray(x)&&x.length===0), JSON.stringify(R.bad));

const m = R.bigVol[0].msg;
ok('④ ⭐ 一定要把實測勝率寫出來(不可只說「高機率反彈」)', m.includes('45.5%'), m.slice(0,120));
ok('④ ⭐ 一定要講「接刀平均會輸大盤」', m.includes('輸大盤'), '');
ok('④ 要註明已扣同期大盤(否則數字會被誤讀)', m.includes('已扣同期大盤'), '');
ok('④ 要說明「量是必要條件,不是進場理由」', m.includes('不是進場理由'), '');
ok('④ 要給出場紀律(沒彈起來也要走)', m.includes('沒彈起來也要走'), '');
ok('⑤ ⛔ 不可寫成看多訊號(tone 必須是 warn)', R.bigVol[0].tone==='warn' && R.noVol[0].tone==='warn', R.bigVol[0].tone);
ok('⑥ ⛔ 不可出現影片那句「95% 會反彈」', !m.includes('95%'), '');
ok('⑦ 訊息裡不可有多餘的引號(模板字串拼接常見錯)', !m.includes("<br>'"), m.slice(0,200));

console.log();
if(fails.length){console.log('❌ FLOOR_TEST_FAIL:',fails);process.exit(1);}
console.log('✅ FLOOR_TEST_PASS');
