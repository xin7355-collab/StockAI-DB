#!/usr/bin/env node
/**
 * 🧩 版面 shim(唯一一份)—— 沙箱連不到 Tailwind CDN,`flex` / `min-w-[466px]` / `grid-cols-*`
 * 這些 **class 型**的版面規則整個不生效 → 不注入的話,量到的幾何**全是假的**(陷阱 #40)。
 *
 * ⛔ 這份**只補會影響版面幾何的**(box-sizing / display / flex / grid / padding / 寬度 / 換行 / text-[Npx]),
 *    ⛔ 不假裝補齊 Tailwind:顏色、`md:`/`sm:` 斷點、`space-x-*` 一律沒補 → 那幾類要在**真機**上看。
 * ⭐ V76.3.2 從 `scripts/rwd_audit.mjs` 抽出來共用(`test_vspace.mjs` 也要用)——
 *    ⛔ 不可複製第二份:漏一條規則就會整片誤報,而那種誤報跟真問題**長得一模一樣**。
 *
 * 用法:`await page.evaluate(rwdShim)` → 回傳「沒生效的規則」陣列(空陣列 = 7 條自我檢查全過)。
 * 🚧 ⛔ 拿到非空陣列時,底下量到的所有幾何數字**都不可信**,要當紅燈處理。
 */
export function rwdShim() {
    // ⭐ V76.2.4 改成**產生器**:一條一條補會沒完沒了,而且每漏一條就整片誤報
    //   (實測漏 `overflow-*` → 跑馬燈害 header 報 +2719px;漏 `hidden` → 每頁 +135px;
    //    漏 `flex-wrap` → K線 HUD 本來會換行卻被擠成一行報 +129px)。
    //   ⛔ 它仍然**不是** Tailwind —— 只補「會影響版面幾何」的那些,顏色/斷點/動畫一律不補。
    const R = ['*,::before,::after{box-sizing:border-box}'];
    const H0 = document.documentElement.innerHTML;
    const REM = n => (n === '0' ? '0' : (parseFloat(n.replace('\\.', '.')) * 0.25) + 'rem');
    // ① 固定對照表(display / flex / position / 文字流)
    Object.entries({
        'flex': 'display:flex', 'inline-flex': 'display:inline-flex', 'grid': 'display:grid', 'inline-grid': 'display:inline-grid',
        'block': 'display:block', 'inline-block': 'display:inline-block', 'inline': 'display:inline', 'hidden': 'display:none',
        'flex-col': 'flex-direction:column', 'flex-row': 'flex-direction:row',
        'flex-wrap': 'flex-wrap:wrap', 'flex-nowrap': 'flex-wrap:nowrap',
        'flex-1': 'flex:1 1 0%', 'flex-auto': 'flex:1 1 auto', 'flex-none': 'flex:none',
        'flex-shrink-0': 'flex-shrink:0', 'shrink-0': 'flex-shrink:0', 'grow': 'flex-grow:1',
        'min-w-0': 'min-width:0', 'w-full': 'width:100%', 'h-full': 'height:100%',
        'w-max': 'width:max-content', 'w-min': 'width:min-content', 'w-fit': 'width:fit-content',
        'items-center': 'align-items:center', 'items-start': 'align-items:flex-start', 'items-end': 'align-items:flex-end',
        'items-baseline': 'align-items:baseline', 'items-stretch': 'align-items:stretch',
        'justify-between': 'justify-content:space-between', 'justify-center': 'justify-content:center',
        'justify-end': 'justify-content:flex-end', 'justify-start': 'justify-content:flex-start',
        'justify-around': 'justify-content:space-around', 'justify-evenly': 'justify-content:space-evenly',
        'text-right': 'text-align:right', 'text-center': 'text-align:center', 'text-left': 'text-align:left',
        'whitespace-pre-wrap': 'white-space:pre-wrap', 'whitespace-nowrap': 'white-space:nowrap', 'whitespace-normal': 'white-space:normal',
        'break-words': 'overflow-wrap:break-word', 'break-all': 'word-break:break-all',
        'truncate': 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
        'relative': 'position:relative', 'absolute': 'position:absolute', 'fixed': 'position:fixed', 'sticky': 'position:sticky',
        'overflow-hidden': 'overflow:hidden', 'overflow-x-hidden': 'overflow-x:hidden', 'overflow-y-hidden': 'overflow-y:hidden',
        'overflow-auto': 'overflow:auto', 'overflow-x-auto': 'overflow-x:auto', 'overflow-y-auto': 'overflow-y:auto',
        'overflow-scroll': 'overflow:scroll', 'overflow-x-scroll': 'overflow-x:scroll', 'overflow-clip': 'overflow:clip',
        'mx-auto': 'margin-left:auto;margin-right:auto',
        // 🧱 V76.4.1 無框版面靠「分隔線」分段 → `border-b` / `border-t` 少了的話,沙箱裡看起來會像「分段壞掉」,
        //    而那是工具的錯不是版面的錯(而且 border-b 也**真的佔 1px 高度**,量垂直空間時會差)。
        'border': 'border-width:1px;border-style:solid', 'border-l-4': 'border-left-width:4px;border-left-style:solid',
        'border-b': 'border-bottom-width:1px;border-bottom-style:solid', 'border-t': 'border-top-width:1px;border-top-style:solid',
        'border-l': 'border-left-width:1px;border-left-style:solid', 'border-r': 'border-right-width:1px;border-right-style:solid',
        'border-l-2': 'border-left-width:2px;border-left-style:solid',
        'rounded': 'border-radius:.25rem', 'rounded-lg': 'border-radius:.5rem',
        'grid-flow-col': 'grid-auto-flow:column',
    }).forEach(([k, v]) => R.push(`.${k.replace(/([.\/])/g, '\\$1')}{${v}}`));
    // ② 數值級距(gap / padding / margin)—— 只收檔案裡真的用到的,⛔ 不整張表倒進去
    const SCALE = { gap: 'gap', 'gap-x': 'column-gap', 'gap-y': 'row-gap',
        p: 'padding', px: 'padding-left|padding-right', py: 'padding-top|padding-bottom',
        pl: 'padding-left', pr: 'padding-right', pt: 'padding-top', pb: 'padding-bottom',
        m: 'margin', mx: 'margin-left|margin-right', my: 'margin-top|margin-bottom',
        ml: 'margin-left', mr: 'margin-right', mt: 'margin-top', mb: 'margin-bottom' };
    new Set((H0.match(/\b(?:gap-x|gap-y|gap|px|py|pl|pr|pt|pb|mx|my|ml|mr|mt|mb|p|m)-\d+(?:\.\d+)?\b/g) || [])).forEach(cls => {
        const i = cls.lastIndexOf('-'), pre = cls.slice(0, i), num = cls.slice(i + 1);
        const prop = SCALE[pre]; if (!prop) return;
        const body = prop.split('|').map(x => `${x}:${REM(num)}`).join(';');
        R.push(`.${pre}-${num.replace('.', '\\.')}{${body}}`);
    });
    // ③ 字級(⚠️ index.html 自己有 V44.2 的 `!important` 放大表,它會贏過這裡 —— 那是對的)
    new Set((H0.match(/text-\[([\d.]+)px\]/g) || []).map(m => m.match(/[\d.]+/)[0])).forEach(n =>
        R.push(`.text-\\[${String(n).replace('.', '\\.')}px\\]{font-size:${n}px}`));
    // ④ 🚨 grid 樣板:刻意重現 Tailwind 的**語意差別**,⛔ 不可兩種都寫成一樣
    //     ・具名 `grid-cols-N` → `repeat(N, minmax(0,1fr))`(會收縮)
    //     ・任意值 `[1fr_auto]` → 原生 `1fr auto` = `minmax(auto,1fr)`(⛔ 不收縮,就是它在撐寬)
    new Set((H0.match(/grid-cols-(\d+)/g) || [])).forEach(m => {
        const n = m.match(/\d+/)[0]; R.push(`.grid-cols-${n}{grid-template-columns:repeat(${n},minmax(0,1fr))}`);
    });
    const ESC = raw => raw.replace(/[.[\]()%,#/]/g, c => '\\' + c);
    new Set((H0.match(/grid-cols-\[[^\]"' ]+\]/g) || [])).forEach(m => {
        const raw = m.slice(11, -1);
        R.push(`.grid-cols-\\[${ESC(raw)}\\]{grid-template-columns:${raw.replace(/_/g, ' ')}}`);
    });
    // ⑤ 寬度:具名 max-w-* 與任意值 min-w-[…] / max-w-[…] / w-[…]
    const MAXW = { xs: 320, sm: 384, md: 448, lg: 512, xl: 576, '2xl': 672, '3xl': 768, '4xl': 896, '5xl': 1024, '6xl': 1152, '7xl': 1280 };
    Object.entries(MAXW).forEach(([k, v]) => R.push(`.max-w-${k}{max-width:${v}px}`));   // ⭐ 開頭是字母 → ⛔ 不需 CSS 轉義
    new Set((H0.match(/(?:min-w|max-w|w)-\[[^\]"' ]+\]/g) || [])).forEach(m => {
        const i = m.indexOf('['), pre = m.slice(0, i - 1), raw = m.slice(i + 1, -1);
        const prop = pre === 'min-w' ? 'min-width' : pre === 'max-w' ? 'max-width' : 'width';
        R.push(`.${pre}-\\[${ESC(raw)}\\]{${prop}:${raw.replace(/_/g, ' ')}}`);
    });
    const st = document.createElement('style'); st.id = '__rwdshim'; st.textContent = R.join('\n'); document.head.appendChild(st);
    // 🚧 空過守門③(V76.2.4):**shim 自己有沒有生效** —— ⛔ 「沒報錯」不等於「它有能力報錯」。
    //   少一條規則就會整片誤報(實測 overflow-* / hidden / flex-wrap 各害過一次),
    //   而那種誤報跟真問題**長得一模一樣** → 先拿幾條代表性的問它一次。
    const probe = [];
    //   ⚠️ 斷言要挑**computed 之後還看得出來**的形式:`getComputedStyle().gridTemplateColumns`
    //      回的是**已解析的 px**(例如 `390px 0px`),⛔ 不會回 `1fr auto`;`gap-1.5` 也不是 6px
    //      (這個 App 的 root font-size 不是 16px,實測 6.36px)。第一版兩條都寫錯 —— 自我檢查抓到自己。
    const mk = (cls, fn, label) => { const d = document.createElement('div'); d.className = cls;
        d.innerHTML = '<span>xxxxxxxx</span><span>y</span>'; document.body.appendChild(d);
        let ok = false; try { ok = fn(getComputedStyle(d), d); } catch (_) {}
        d.remove(); if (!ok) probe.push(label || cls); };
    mk('flex-wrap', s => s.flexWrap === 'wrap', 'flex-wrap 沒生效');
    mk('hidden', s => s.display === 'none', 'hidden 沒生效');
    mk('overflow-x-auto', s => s.overflowX === 'auto', 'overflow-x-auto 沒生效');
    //   grid 任意值:兩條軌道、而且**第二條明顯比第一條窄**(`auto` 只吃內容)→ 證明 `1fr auto` 真的套上了
    mk('grid grid-cols-[1fr_auto]', s => { const t = String(s.gridTemplateColumns).split(/\s+/).map(parseFloat);
        return t.length === 2 && t[0] > t[1] && t[0] > 0; }, 'grid-cols-[1fr_auto] 沒生效');
    mk('gap-1.5', s => parseFloat(s.columnGap) > 0, 'gap-1.5 沒生效');
    //   🧱 V76.4.1 無框版面全靠分隔線分段 → 這兩條沒生效的話,量到的「乾淨」跟「分段消失」分不出來
    mk('border-b', s => parseFloat(s.borderBottomWidth) === 1, 'border-b 沒生效');
    mk('border-l-4', s => parseFloat(s.borderLeftWidth) === 4, 'border-l-4 沒生效');
    window.__rwdShimBad = probe;
    return probe;
}
