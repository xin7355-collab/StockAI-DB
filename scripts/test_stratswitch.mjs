// 🎯 V77.9.6 全站策略開關(使用者:「總覽 / 提醒 / 通知都照我選的策略,其它也要同步變更,才不會有不一樣的通知讓使用者錯亂;
//    策略可以在設定裡面修改,預設高基期高波動,我不想讓別人隨意知道這一套最強策略」)
//   ⛔ 這支釘的用意:
//     ① 預設 🧬;就算存了 strategy='lead',沒解鎖一律當 🧬;連點版本號 5 次才解鎖、點一下仍是環境資訊
//     ② 🧬 時:決策台 👑 那塊連 DOM 都沒有、總覽那一行不出現、更新紀錄看不到 👑 那幾行、_leaderMine 是空的
//     ③ 👑 時:總覽主卡換成領頭羊規則(⭐ 決定性對照:同一檔同一份資料,切回 🧬 就回到三條出場)
//     ④ 👑 時:三條出場的掃描 / 第 2 擊 / 背景 −5% 提醒一律跳過個股(ETF 照舊);換倉日提醒一天一則
//     ⑤ 產業作戰室:同一個判斷(讀同一份設定);🧬 時池子 / 成績單分頁 / 回測數字 / 實測總表 / 更新紀錄都沒有 👑
//     ⑥ Telegram worker:名單規則 / 錨點 == App;推播只講你選的那一套
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (n, c, e = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : '  ' + String(e).slice(0, 260)}`); if (!c) fails.push(n); };

let chromium; try { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); } catch (_) { ({ chromium } = await import('playwright')); }
const _exec = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ ...(fs.existsSync(_exec) ? { executablePath: _exec } : {}), args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof app !== 'undefined' && app._strat && app._leaderCalc, null, { timeout: 60000 });

const R = await page.evaluate(async () => {
    const o = {};
    // ── 合成 screener(同 test_leaderdeck 的形狀)
    const cols = ['c', 'chg', 'chg5', 'chg10', 'chg20', 'amt', 'amt20', 'b20', 'b60', 'lim', 'att', 'etf', 'pos252'];   // 📍 V78.0.5 一年位置全設 95(位置濾網由 test_leaderdeck ⑩ 測)
    const rows = {};
    for (let i = 0; i < 120; i++) { const sym = String(1000 + i); const ok = i % 2 === 1; rows[sym] = [100, 1, 1, 60 - i * 0.5, 10, 50, 500 - i, ok ? 5 : -1, ok ? 9 : 3, 0, 0, 0, 95]; }
    const D = { data_date: '2026-09-28', cols, rows };
    const tw = Array.from({ length: 80 }, (_, i) => ({ date: new Date(Date.UTC(2026, 6, 1) + i * 86400000).toISOString().slice(0, 10), close: 100 }));
    app._scrData = D; app._loadScreener = async () => D; app._getTwiiRows = async () => tw; app._mktBear60 = async () => ({ on: false });
    // ① 預設 / 解鎖
    app.settings.strategy = 'gene'; app.settings.stratUnlock = false;
    o.def = app._strat();
    app.settings.strategy = 'lead'; o.lockedLead = app._strat();
    let env = 0; const _env = app._showEnvInfo; app._showEnvInfo = () => { env++; };
    app._verTap(); await new Promise(r => setTimeout(r, 800)); o.oneTapEnv = env; o.oneTapUnlock = !!app.settings.stratUnlock;
    for (let i = 0; i < 5; i++) app._verTap(); await new Promise(r => setTimeout(r, 800));
    o.unlocked = !!app.settings.stratUnlock; o.afterUnlock = app._strat(); o.envAfter5 = env;
    app._showEnvInfo = _env;
    const sbx = document.getElementById('stratBox'); app._renderStratBox();
    o.boxLead = sbx ? sbx.querySelectorAll('[data-stratopt]').length : -1;
    // ② 🧬
    app.setStrategy('gene'); o.gene = app._strat();
    app.settings.stratUnlock = false; app._renderStratBox(); o.boxGene = sbx ? sbx.querySelectorAll('[data-stratopt]').length : -1; o.boxGeneTxt = sbx ? sbx.innerText : '';
    app.inventory = [{ symbol: '1001', cost: 100 }, { symbol: '0050', cost: 100 }, { symbol: '2330', cost: 500 }];
    o.mineGene = app._leaderMine().size;
    // 更新紀錄
    const ul = document.getElementById('updateLogBody');
    app._showUpdateLog(); o.logGene = ul ? ul.innerText : '';
    // ③ 👑
    app.settings.stratUnlock = true; app.settings.strategy = 'lead';
    o.mineLead = [...app._leaderMine()].sort();
    app._showUpdateLog(); o.logLead = ul ? ul.innerText : '';
    const L = app._leaderCalc(D);
    const data = Array.from({ length: 60 }, (_, i) => ({ date: tw[i + 10].date, open: 100, high: 101, low: 99, close: 100, volume: 1000 }));
    app._leadCtx = { at: Date.now(), L, clk: { isRebal: true, left: 0, day: 1 }, bearOn: false, date: '2026-09-28' };
    app.inventory = [{ symbol: '1001', cost: 100, shares: 1 }, { symbol: '1041', cost: 100, shares: 1 }];
    const d1 = app._ovDecide(data, '1001'), d41 = app._ovDecide(data, '1041'), dNo = app._ovDecide(data, '1003');
    o.lead1 = d1 && { st: d1.state, b: d1.badge, lead: !!d1.lead }; o.lead41 = d41 && { st: d41.state, b: d41.badge }; o.leadNo = dNo && { st: dNo.state, b: dNo.badge };
    app._leadCtx.clk = { isRebal: false, left: 6, day: 5 };
    const d41w = app._ovDecide(data, '1041'); o.lead41wait = d41w && { st: d41w.state, b: d41w.badge };
    // ⭐ 決定性對照:切回 🧬,同一檔同一份資料 → 回到三條出場(沒有 lead 欄)
    app.settings.strategy = 'gene';
    const g41 = app._ovDecide(data, '1041'); o.gene41 = g41 && { st: g41.state, lead: !!g41.lead, b: g41.badge };
    app.settings.strategy = 'lead';
    // ④ 提醒
    let fired = []; const _fa = app._fireAlert; app._fireAlert = (t, b) => fired.push(t + '|' + b);
    app._comboWatchGet = () => ({ '1041': { px: 999, nm: 'x' } }); app._comboWatchSet = () => {};
    o.comboLead = app._comboCheck('1041', 50);
    app.settings.strategy = 'gene'; o.comboGene = app._comboCheck('1041', 50); app.settings.strategy = 'lead';
    try { localStorage.removeItem('leadRebalFired'); } catch (_) {}
    app._leadCtx = { at: Date.now(), L, clk: { isRebal: true, left: 0, day: 1 }, bearOn: false, date: '2026-09-28' };
    fired = [];
    await app._leadRebalAlert(); o.rebal1 = fired.slice();
    await app._leadRebalAlert(); o.rebal2 = fired.length;
    app._fireAlert = _fa;
    // 決策台 👑 那塊:🧬 時連 DOM 都沒有
    o.src = { rd: app.renderDeck.toString() };
    // 背景提醒設定
    app.settings.strategy = 'lead';
    const ca = { put: async (k, r) => { o.swCfg = JSON.parse(await r.text()); } }; const _c = window.caches;
    try { Object.defineProperty(window, 'caches', { value: { open: async () => ca }, configurable: true }); } catch (_) {}
    app.inventory = [{ symbol: '1001', cost: 100 }, { symbol: '0050', cost: 100 }];
    try { await app._updateSWAlertConfig(); } catch (e) { o.swErr = String(e); }
    try { Object.defineProperty(window, 'caches', { value: _c, configurable: true }); } catch (_) {}
    o.rule = JSON.stringify(app._LEADER_EDGE.rule); o.anchor = app._LEADER_EDGE.anchor;
    o.L = { buy: L.buy.map(r => r.sym), ranked: L.ranked.map(r => r.sym) }; o.D = D;
    app.settings.strategy = 'gene'; app.settings.stratUnlock = false;
    return o;
});
ok('① 預設 🧬;存了 lead 但沒解鎖 → 仍是 🧬', R.def === 'gene' && R.lockedLead === 'gene');
ok('①b 點一下版本號 → 環境資訊(原本的功能)、⛔ 不解鎖', R.oneTapEnv === 1 && R.oneTapUnlock === false, JSON.stringify([R.oneTapEnv, R.oneTapUnlock]));
ok('①c 連點 5 次 → 解鎖(⛔ 不跳環境資訊)、設定出現 👑 選項(V78.1.9 起 👑+停車 / 💵 錢放現金 / 🅿️ / 🔥 共 4 個)', R.unlocked && R.afterUnlock === 'lead' && R.envAfter5 === 1 && R.boxLead === 4, JSON.stringify([R.unlocked, R.afterUnlock, R.envAfter5, R.boxLead]));
ok('①d 🔒 沒解鎖 → 設定只列 🧬、畫面上⛔ 看不到「領頭羊」四個字', R.boxGene === 1 && !/領頭羊|👑/.test(R.boxGeneTxt), R.boxGeneTxt);
ok('② 🧬:_leaderMine 是空的(⛔ 沒有混搭)', R.mineGene === 0);
ok('②b 🧬:更新紀錄看不到 👑 那幾行;👑 時看得到(決定性對照)', !/領頭羊/.test(R.logGene) && /領頭羊/.test(R.logLead) && R.logGene.length > 200, [R.logGene.length, /領頭羊/.test(R.logLead)]);
ok('②c 🧬:決策台 👑 那塊用 _isLead 擋(⛔ 連 DOM 都不放)', /_isLead\(\) \? await this\._leaderDeckHtml\(\) : ''/.test(R.src.rd));
ok('③ 👑:手上每一檔**個股**都算(ETF 0050 除外)', JSON.stringify(R.mineLead) === JSON.stringify(['1001', '2330']), JSON.stringify(R.mineLead));
ok('③b 👑 總覽:第 1 名 → 續抱;換倉日掉出前 10 → 明天開盤賣;不在名單的空手股 → 不在名單', R.lead1 && R.lead1.st === 'hold' && R.lead1.lead && /續抱/.test(R.lead1.b) && R.lead41.st === 'exit' && /明天\s*開盤賣/.test(R.lead41.b) && /不在名單|等換倉日|明天\s*(開盤|13:25 )買/.test(R.leadNo.b), JSON.stringify([R.lead1, R.lead41, R.leadNo]));
ok('③c 👑 非換倉日 → ⛔ 不提早賣,寫「等換倉日」', R.lead41wait.st === 'hold' && /等換倉日/.test(R.lead41wait.b), JSON.stringify(R.lead41wait));
ok('③d ⭐ 決定性對照:同一檔切回 🧬 → 沒有 lead、⛔ 不是「掉出前 10」', R.gene41 && !R.gene41.lead && !/掉出前/.test(R.gene41.b), JSON.stringify(R.gene41));
ok('④ 👑:第 2 擊(出場線)不喊;🧬 照喊', R.comboLead === false && R.comboGene === true, JSON.stringify([R.comboLead, R.comboGene]));
ok('④b 換倉日提醒:一則,寫賣誰(掉出前 10)與買誰;同一天第二次不再跳', R.rebal1.length === 1 && /換倉日/.test(R.rebal1[0]) && /賣:.*1041/.test(R.rebal1[0]) && /買:/.test(R.rebal1[0]) && R.rebal2 === 1, JSON.stringify(R.rebal1));
ok('④c 👑:背景 −5% 提醒只留 ETF(個股沒有停損線)', R.swCfg && R.swCfg.alerts.map(a => a.symbol).join() === '0050', JSON.stringify(R.swCfg || R.swErr));
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
ok('④d 👑 時 _startEodWatcher ⛔ 不跑 🧬 的買點 / 出場掃描,改跑換倉日提醒', /if \(this\._isLead\(\)\) \{ this\._leadRebalAlert\(\)\.catch\(\(\) => \{ \}\); return; \}\s*\n\s*this\._eodTriggerSweep\(\)/.test(SRC));
ok('④e _invExitScan / 庫存 −5% / 第 2 擊 / 背景提醒都讀同一個 _leaderMine(⛔ 各寫一份判斷)', (SRC.match(/_leaderMine\(\)\.has\(/g) || []).length >= 3 && /if \(_lm\.has\(sym\)\) continue;/.test(SRC));

// ⑤ 產業作戰室
const pro = await browser.newPage({ viewport: { width: 390, height: 900 } });
pro.on('pageerror', e => errs.push('pro: ' + e.message));
await pro.goto('file://' + path.join(ROOT, 'pro.html'), { waitUntil: 'domcontentloaded' });
await pro.waitForFunction(() => typeof PRO !== 'undefined' && PRO._isLead, null, { timeout: 30000 });
const P = await pro.evaluate(async () => {
    const o = {};
    const set = (st, un) => localStorage.setItem('proTerminalSettings', JSON.stringify({ strategy: st, stratUnlock: un }));
    const snap = () => {
        const B = PRO._PROFIT_BOARD; PRO._labSel = 'bt'; PRO._pbWin = 'ai'; PRO._pfSort = null; PRO.renderLab();
        const pb = document.getElementById('profitBody').innerText;
        let n = 0; for (const t of PRO.LAB_TABS) n += (PRO._labOf(t[0]) || []).length;
        const labT = []; for (const t of PRO.LAB_TABS) for (const it of (PRO._labOf(t[0]) || [])) labT.push(String(it.t || ''));
        const tabs = PRO._RECO_SRCS.filter(([k]) => k !== 'lead' || PRO._isLead()).map(x => x[0]);
        return { lead: PRO._isLead(), pb, labN: n, labLead: labT.filter(t => /領頭羊|👑/.test(t)).length, tabs };
    };
    localStorage.removeItem('proTerminalSettings'); o.def = snap();
    set('lead', false); o.locked = snap();
    set('lead', true); o.on = snap();
    // 拋竿:🧬 走 Gene 版本
    o.castSrc = PRO._castPick.toString().slice(0, 200);
    set('gene', true); PRO.selRecoSrc('lead'); o.recoGene = PRO._recoSrc;
    localStorage.removeItem('proTerminalSettings');
    return o;
});
ok('⑤ 產業作戰室預設 🧬;存了 lead 沒解鎖 → 仍 🧬', P.def.lead === false && P.locked.lead === false && P.on.lead === true);
ok('⑤b 🧬:回測數字頁沒有 👑 的列、沒有「錢不多的話」;👑 時有(決定性對照)', !/領頭羊/.test(P.def.pb) && !/錢不多/.test(P.def.pb) && /領頭羊/.test(P.on.pb) && /錢不多/.test(P.on.pb), [P.def.pb.slice(0, 80)]);
ok('⑤c 🧬:實測總表不列標題有 👑 / 領頭羊的條目;👑 時全部列出(⛔ 沒刪)', P.def.labLead === 0 && P.on.labLead > 0 && P.on.labN > P.def.labN, JSON.stringify([P.def.labN, P.on.labN, P.on.labLead]));
ok('⑤d 🧬:成績單沒有 👑 分頁、選了也退回 🧬', !P.def.tabs.includes('lead') && P.on.tabs.includes('lead') && P.recoGene === 'pb', JSON.stringify([P.def.tabs, P.recoGene]));
ok('⑤e 拋竿 🧬 走舊版本(_castPickGene),👑 才走領頭羊;🎣 V78.0.2 股海釣手(App 模式)一律 👑', /_isLead\(\) && !this\._fpvOn\(\)\) return this\._castPickGene/.test(P.castSrc));
const PS = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');
const judge = s => (s.match(/\/\^lead\(park\)\?\$\/\.test\((?:s|st)\.strategy\) && !?!?(?:s|st)\.stratUnlock/) || [''])[0];
ok('⑤f 兩邊判斷式同一條(strategy 是 lead 或 leadpark 且解鎖,V78.1.9)', /\/\^lead\(park\)\?\$\/\.test\(s\.strategy\) && s\.stratUnlock/.test(SRC) && /\/\^lead\(park\)\?\$\/\.test\(st\.strategy\) && !!st\.stratUnlock/.test(PS), [judge(SRC), judge(PS)]);

// 🔓 V78.5.1 作戰室自己也能解鎖(iPhone 主畫面兩個 App 設定不互通 → 成績單少了 👑)
const U = await pro.evaluate(async () => {
    const o = {}, wait = ms => new Promise(r => setTimeout(r, ms));
    const tap = async n => { const e = document.getElementById('proVer'); for (let i = 0; i < n; i++) e.click(); await wait(900); };
    const tabs = () => [...document.querySelectorAll('[data-recosrc]')].map(e => e.dataset.recosrc);
    const modalOpen = () => !document.getElementById('proModal').classList.contains('hidden');
    localStorage.setItem('proTerminalSettings', JSON.stringify({ geminiKey1: 'FAKEKEY123' }));
    PRO.switchTab('fish', true); await wait(200);
    o.verTxt = document.getElementById('proVer').textContent; o.t0 = tabs();
    await tap(4); o.after4 = modalOpen(); o.lead4 = PRO._isLead();
    await tap(5); o.after5 = modalOpen(); o.picks = [...document.querySelectorAll('[data-stratpick]')].map(e => e.dataset.stratpick);
    document.querySelector('[data-stratpick="leadpark"]').click(); await wait(300);
    o.lead1 = PRO._isLead(); o.closed = !modalOpen(); o.t1 = tabs(); o.st1 = JSON.parse(localStorage.getItem('proTerminalSettings'));
    await tap(5); o.lead2 = PRO._isLead(); o.t2 = tabs(); o.st2 = JSON.parse(localStorage.getItem('proTerminalSettings'));
    localStorage.removeItem('proTerminalSettings');
    return o;
});
ok('🔓a 沒解鎖:版本號一個字都不多、成績單沒有 👑', U.verTxt === PS.match(/VER: '(V[0-9.]+)'/)[1] && !U.t0.includes('lead') && U.t0.length >= 3, JSON.stringify([U.verTxt, U.t0]));
ok('🔓b 只點 4 下 ⛔ 不跳選單、⛔ 不解鎖', U.after4 === false && U.lead4 === false);
ok('🔓c 點 5 下跳選單,四套都在', U.after5 && ['leadpark', 'lead', 'park', 'gene'].every(k => U.picks.includes(k)), JSON.stringify(U.picks));
ok('🔓d 選 👑 → 成績單出現 👑 分頁、選單關掉', U.lead1 && U.closed && U.t1.includes('lead'), JSON.stringify(U.t1));
ok('🔓e ⛔ 其它設定(金鑰)不可被洗掉', U.st1.geminiKey1 === 'FAKEKEY123' && U.st2.geminiKey1 === 'FAKEKEY123' && U.st1.strategy === 'leadpark' && U.st1.stratUnlock === true, JSON.stringify([U.st1, U.st2]));
ok('🔓f 再點 5 下 → 收起、改回 🧬、👑 分頁消失', U.lead2 === false && U.st2.strategy === 'gene' && U.st2.stratUnlock === false && !U.t2.includes('lead'), JSON.stringify([U.t2, U.st2]));

// ⑥ Telegram worker
const W = fs.readFileSync(path.join(ROOT, 'cloud-worker/worker.js'), 'utf8');
const tmp = path.join(ROOT, 'scripts', '.tmp_worker_test.mjs'); fs.writeFileSync(tmp, W);
let M; try { M = await import(pathToFileURL(tmp).href + '?t=' + Date.now()); } finally { fs.unlinkSync(tmp); }
const wl = M.leadCalc(R.D);
ok('⑥ worker 名單 == App `_leaderCalc`(合成 screener,前 10 名逐一比)', JSON.stringify(wl.ranked.map(r => r.sym)) === JSON.stringify(R.L.ranked) && JSON.stringify(wl.buy.map(r => r.sym)) === JSON.stringify(R.L.buy), JSON.stringify([wl.ranked.map(r => r.sym), R.L.ranked]));
const ir = JSON.parse(R.rule);
ok('⑥b worker 規則 / 錨點 == App', M.LEAD_ANCHOR === R.anchor && ['U', 'N', 'R', 'L', 'hyst'].every(k => M.LEAD_RULE[k] === ir[k]), JSON.stringify([M.LEAD_RULE, ir, M.LEAD_ANCHOR, R.anchor]));
ok('⑥c worker 時鐘:錨點那天 = 換倉日、第 2 天不是、第 11 天又是', M.leadClock([{ date: '2026-09-24' }], '2026-09-24').isRebal && !M.leadClock([{ date: '2026-09-24' }, { date: '2026-09-29' }], '2026-09-29').isRebal && M.leadClock(Array.from({ length: 11 }, (_, i) => ({ date: '2026-10-' + String(i + 1).padStart(2, '0') })).concat([{ date: '2026-09-24' }]), '2026-10-10').isRebal);
ok('⑥d worker:settings 收 strategy、👑 個股不推 −5% 停損、5 日線 / +20% 提醒恢復(V77.9.7)、換倉日推播掛在 08:00', /strategy: payload\.settings\.strategy === 'lead' \? 'lead' : 'gene'/.test(W) && /const leadS = _leadStock\(user\.settings\?\.strategy, sym\)/.test(W) && /!leadS && ret <= -5/.test(W) && /'below5ma'/.test(W) && /'tp20'/.test(W) && /runLeaderRebalPush\(env\)/.test(W) && /if \(_leadStock\(rec\.strategy, it\.sym\)\) continue;/.test(W));
ok('⑥e App 同步 Telegram 時帶 strategy', /strategy:\s+app\._strat\?\.\(\) \|\| 'gene'/.test(SRC) && /triggers: trig, strategy: this\._strat\(\)/.test(SRC));
ok('⑦ 無 pageerror', !errs.length, errs.join(' | '));
await browser.close();
console.log(fails.length ? `\n❌ ${fails.length} 條失敗` : '\n✅ STRATSWITCH_PASS');
process.exit(fails.length ? 1 : 0);
