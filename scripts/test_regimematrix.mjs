#!/usr/bin/env node
/**
 * 🌦️ V74.9.1 情境矩陣(策略 × 多頭/空頭/盤整高波動 × 5/10/20/40 日)
 *
 * ⛔ 六條鐵則:
 *  ① 數字全部讀 PRO.RM(⛔ 前端不可寫死任何一格 —— 測試換一份假表,畫面要跟著變)
 *  ② 🚨 對照組基準(多頭/空頭都只有 ~45%)必須寫在第一眼 —— 沒有它,「勝率 44%」會被讀成很差
 *  ③ 🚨 每一列都要**同時**有「規格判定」與「本站判定」(⛔ 只給其中一個 = 二選一的偏誤)
 *  ④ 序列 MDD 的「被交易次數主導、⛔ 不可比策略」那句必須在頁面上
 *  ⑤ 樣本 <30 的格子要標 ⚠️(規格:樣本不足容易虛胖)
 *  ⑥ 「固定抱 N 天 ⛔ 不是 App 的出場規則」的限制必須寫在頁首(否則會被拿去當開關)
 *  ⑦ 探針本身:規格 ③ 的合併格必須**同時**拆出 盤整 / 高波動;規則的 ⛔ 不可用序列 MDD 判
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'pro.html'), 'utf8');
const PROBE = fs.readFileSync(path.join(ROOT, 'scripts/regime_matrix_probe.mjs'), 'utf8');
let fails = 0;
const ok = (n, c, x = '') => { console.log(`${c ? '✅' : '❌'} ${n}${c ? '' : `  ${x}`}`); if (!c) fails++; };

// ── 靜態:探針 ──────────────────────────────────────────────────────────
{
    const body = PROBE.replace(/^\s*\/\/.*$/gm, '').replace(/^\s*\*.*$/gm, '');
    ok('⑦ 探針:規格 ③ 合併格(fh)之外必須同時報 盤整(flat)與 高波動(hivol)',
       /GROUPS = \[[^\]]*'fh'[^\]]*'flat'[^\]]*'hivol'/.test(body));
    ok('⑦ 探針:進場 = T+1 開盤(⛔ 訊號日收盤買不到)', /O\[i \+ 1\]/.test(body) && /rets\[w\] = \(C\[i \+ w\] \/ o1 - 1\)/.test(body));
    ok('⑦ 探針:排除隔天開盤鎖漲停', /o1 >= C\[i\] \* 1\.095/.test(body));
    ok('⑦ 探針:對照組要按情境分(⛔ 不是全時段一包)', /add\(CTL\[g\]\[w\], rets\[w\]\)/.test(body));
    ok('⑦ 🚨 探針:⛔ 規則不可用序列 MDD 判(它被交易次數主導)',
       !/else if \(r\.mdd != null && r\.mdd > 30/.test(body) && /r\.p10 - r\.cp10 <= -3/.test(body));
    ok('⑦ 探針:四個窗口', /WINS = \[5, 10, 20, 40\]/.test(body));
}
// ── 靜態:pro.html ───────────────────────────────────────────────────────
{
    const i = SRC.indexOf('  renderRegime() {'), j = SRC.indexOf('\n  },', i);
    const fn = i >= 0 ? SRC.slice(i, j) : '';
    ok('① renderRegime 存在且⛔ 不寫死任何勝率數字(全部讀 RM)', fn.length > 500 && !/\d\d\.\d%/.test(fn.replace(/\/\/.*$/gm, '')), fn.match(/\d\d\.\d%/g)?.slice(0, 3).join(','));
    ok('④ 序列 MDD「被交易次數主導」那句在頁面上', /被交易次數主導/.test(fn));
    ok('⑥ 頁首限制:固定抱 N 天 ⛔ 不是 App 的出場規則', /不是<\/b> App 的出場規則|不是 App 的出場規則/.test(SRC));
}

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
const perr = [];
page.on('pageerror', e => perr.push(e.message.slice(0, 200)));
await page.goto('file://' + path.join(ROOT, 'pro.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.PRO, null, { timeout: 30000 });
await page.waitForTimeout(800);

const R = await page.evaluate(async () => {
    const P = window.PRO, o = {};
    P.switchTab('lab'); await new Promise(r => setTimeout(r, 600));
    P.selLab('rm'); await new Promise(r => setTimeout(r, 600));
    const items = [...document.querySelectorAll('#labList .labitem.rm')];
    o.n = items.length; o.rmN = (P.RM && P.RM.strats || []).length;
    o.intro = document.getElementById('labIntro').innerText;
    o.head = (document.querySelector('#labList .note') || {}).innerText || '';
    items.forEach(d => d.open = true);
    const txt = d => d.innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    o.bothVerd = items.every(d => /規格判定/.test(txt(d)) && /本站判定/.test(txt(d)));
    o.lowFlag = items.some(d => /⚠️ n=/.test(txt(d)));
    o.hasFlip = items.some(d => /窗口會翻轉結論/.test(txt(d)));
    o.win4 = items.every(d => d.querySelectorAll('.rmtbl').length === 4);
    o.ctlRow = items.every(d => d.querySelector('.rmctl'));
    // ① 換一份假表 → 畫面要跟著變
    const bak = P.RM;
    const fake = JSON.parse(JSON.stringify(bak));
    fake.strats = [fake.strats[0]]; fake.strats[0].t = '🧪 假策略ZZZ'; fake.strats[0].byG.bull['20'].win = 99.9;
    P.RM = fake; P.renderLab(); await new Promise(r => setTimeout(r, 300));
    const it2 = document.querySelector('#labList .labitem.rm'); it2.open = true;
    o.fakeN = document.querySelectorAll('#labList .labitem.rm').length;
    o.fakeSeen = /假策略ZZZ/.test(it2.innerText) && /99\.9/.test(it2.innerHTML);
    P.RM = bak; P.renderLab();
    return o;
});
await browser.close();

ok('① 18 個策略都渲染出來,數量 = RM.strats', R.n === R.rmN && R.n >= 15, `n=${R.n} rm=${R.rmN}`);
ok('① 換一份假表 → 畫面跟著變(⛔ 證明沒有第二份寫死的數字)', R.fakeN === 1 && R.fakeSeen, `${R.fakeN}/${R.fakeSeen}`);
ok('② 🚨 頁首要寫對照組基準(多頭/空頭 ~45%,⛔ 不是 50%)', /45\.4%/.test(R.intro) && /45\.8%/.test(R.intro) && /不是 50%/.test(R.intro), R.intro.slice(0, 80));
ok('② 🚨 頁首要有「兩族」那句總結', /兩族/.test(R.intro));
ok('③ 🚨 每一列都同時有規格判定與本站判定', R.bothVerd === true);
ok('④ 情境天數 + MDD 警語在表頭', /情境天數/.test(R.head) && /被交易次數主導/.test(R.head));
ok('⑤ 樣本 <30 的格子有標 ⚠️', R.lowFlag === true);
ok('⑤ 窗口翻轉的提醒有出現(12/18 個策略有)', R.hasFlip === true);
ok('⑥ 每個策略四個窗口都畫得出來 + 每張表都有對照列', R.win4 && R.ctlRow);
ok('⑧ 無 pageerror', perr.length === 0, perr.join(' | '));

console.log(fails ? `\n❌ ${fails} 條未通過` : '\n✅ 全部通過');
process.exit(fails ? 1 : 0);
