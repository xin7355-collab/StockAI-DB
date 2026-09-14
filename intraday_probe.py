# -*- coding: utf-8 -*-
"""
📕 附件當沖指標「分 K 版」實測探針(V74.6.5)—— 使用者:「當沖指標是分k的,可以幫我做嗎?我自己驗證」

⭐ 為什麼要這一支:V74.6.3 已經用**日線版**測過 RVOL / TTM Squeeze / 兩者共振(六關 0 過),
   ⛔ 但附件講的是**分 K**:它的 RVOL 是「這一分鐘 vs 過去 N 天**同一分鐘**」、
   VWAP 是**當日累計**、ORB 是**開盤前 15 分鐘**、出場是沿 **5 分 K 的 5EMA**。
   日線版不成立 ⛔ 不等於分 K 版不成立 → 這一支照附件的原始定義,用**真 1 分 K** 重測。

🚨 只能在 GitHub Actions 跑(沙箱連不到 Shioaji)。Actions → 「🔬 當沖指標分K探針」→ Run workflow。

📊 測什麼(全部照附件的定義):
   ① VWAP:價在 VWAP 之上/之下(附件:之上只做多、之下只做空)
   ② ORB:突破/跌破開盤前 15 分鐘高低點(附件的進場觸發)
   ③ RVOL:這一分鐘的量 ÷ **過去 N 天同一分鐘**的平均量(⭐ 附件的正確定義,日線版做不到)
   ④ TTM Squeeze(5 分 K):布林(20,2.0)縮進凱特納(20,1.5×ATR)→ 衝出去 = 發射
   ⑤ 🚨 **附件的三大核心組合**:突破 ORB High + 價 > VWAP + RVOL ≥ 2.0
   ⑥ 🚨 **附件宣稱的「終極訊號」**:TTM 發射 + RVOL ≥ 2.0

⭐ 出場照附件寫的:沿 5 分 K 的 5EMA 抱單(實體跌破就走);
   停損 = 突破那根 K 的低點 或 VWAP(取較近);13:25 強制平倉(當沖當天一定要平掉)。

⭐⭐ **對照組(這題的成敗關鍵)**:同一批股票、同一批交易日、**同樣的出場規則**,
   但進場時間**隨機挑**(每天固定挑幾個時間點)→ ⛔ 只有這樣才分得出
   「訊號有沒有用」與「這套出場規則本身在這段行情賺不賺」。

🚧 四道守門(⛔ 都不可拿掉):
   ・抓不到任何分 K → exit 1(⛔ 不可印一份空表看起來像「沒有差異」)
   ・任何一個變體觸發 0 筆 → 明寫「這個變體根本沒生效」,⛔ 不可讀成「沒有差別」
   ・對照組樣本 < 200 → 不下結論
   ・報酬一律**扣當沖來回成本 0.25%**(手續費打折×2 + 當沖稅減半),⛔ 毛利不可拿來下結論

🗣️ V77.0.1 追加:使用者貼的 12 條盤中口訣裡,**非分 K 不可**的那三條
   ⑦ 下午大漲不追 / 下午大跌次日買 ・⑧ 早上大跌等 10 分鐘看站不站得回開盤價 ・
   ⑨ 第一根 5 分 K 上影線太長絕對不追。判定抽成純函式 `maxim_signals()`,
   `--selftest ④` 用 10 條情境驗它(含「不該觸發的不可觸發」),⭐ 沙箱裡唯一驗得到的那一段。
   ⚠️ ⑧ 口訣原句講的是「**不割**」(持有者的事),這裡測「買」是**代理**,⛔ 不等於原句。
   ⛔ 那三條**不吃** NO_ENTRY_AFTER(12:30)那道閘門 —— 口訣講的就是下午(selftest ④b 釘住)。

⚠️ 已知限制(⛔ 不可省略):Shioaji kbars 只回溯約 81~120 天 → 窗口單一、**逐年檢定做不了**;
   而且 ORB 那次(orb_probe)用同樣的資料測過,扣成本後全部是虧的。
"""
import os
import sys
import json
from datetime import datetime, timezone, timedelta

# ⭐ 登入 / 找合約 / 時間戳解讀**直接沿用 orb_probe**(⛔ 不寫第二份 —— 陷阱 #37)
#   ⚠️ 尤其 `_t()`:Shioaji kbars 的 ts 已是台灣牆鐘(naive),要用 UTC 讀才得到 09:00~13:30;
#      再套 +8 會變成 17:00~21:30 → 所有時間閘門全部誤判(CLAUDE.md 記過這個坑)。
from orb_probe import find_contract, _t

TW = timezone(timedelta(hours=8))
OUT = 'data/intraday_probe_result.json'

# 📌 標的:預設涵蓋高/中/低波動(⛔ 別只放權值股 —— 附件講的是「有波動、有量」的當沖標的)
# 🚨 V74.6.9 實跑抓到:原本寫 `os.environ.get('PROBE_SYMS', 預設)` ——
#   ⛔ 但 workflow 的「留空」是把它設成**空字串**,不是不設 → `get` 回 '' 而**不是預設值**
#   → 0 檔 → 一個交易日都沒有 → exit 1。⭐ 而錯誤訊息寫的是「一個可用交易日都沒有」,
#   看起來像「Shioaji 沒資料」,其實是**標的清單是空的**(⛔ 診斷會被帶往完全錯的方向)。
#   ⭐ 通用:`os.environ.get(k, 預設)` 擋不住「設成空字串」,一律用 `(os.environ.get(k) or 預設)`
#     —— 同族:`x = a or 0` 之後用 `x > 0` 當守門(陷阱 V74.2.1)。
_DEF_SYMS = ('2330,2317,2454,2603,2609,3661,3037,2376,3231,6547,'
             '2618,3665,4966,6182,8069,2382,3035,5483,6415,2408')
SYMS = [s.strip() for s in (os.environ.get('PROBE_SYMS') or _DEF_SYMS).split(',') if s.strip()]
if not SYMS:
    print('🚨 標的清單是空的 → ⛔ 直接停(⛔ 不可讓它跑到後面變成「沒有交易日」那種會誤導的訊息)')
    raise SystemExit(1)
DAYS_BACK = int((os.environ.get('PROBE_DAYS') or '120').strip() or 120)
COST_PCT = 0.25              # 當沖來回成本 %(⛔ 一律扣)
OR_MIN = 15                  # 附件:開盤前 15 分鐘
# 📊 要測哪幾種週期(使用者要求加 15 / 60 分 K)
#   ⚠️ 15 分 K 一天只有 18 根、60 分 K 只有 4~5 根 → **TTM Squeeze(要 20 根)在日內算不出來**
#   ⭐ 所以週期 K 一律**跨日接成一條連續序列**(= 交易軟體上那條 15 分/60 分線本來就是連續的),
#      TTM 與 5EMA 都在那條連續序列上算;⛔ 但進場/出場一律**當天結束前平掉**(當沖)。
PERIODS = [int(x) for x in (os.environ.get('PROBE_PERIODS') or '5,15,60').split(',') if x.strip()]
if not PERIODS:                       # 🚧 workflow 傳空字串 → 退回預設(⛔ 不可變成 0 個週期靜默跑完)
    PERIODS = [5, 15, 60]
RVOL_LOOKBACK = 10           # 附件建議 10 或 20 天
RVOL_HI = 2.0                # 附件:≥2.0 = 真突破
NO_ENTRY_AFTER = (12, 30)    # ⛔ 太晚不進場(尾盤流動性差,附件自己也提醒)
FORCE_OUT = (13, 25)         # 當沖強制平倉
CTRL_TIMES = [(9, 30), (10, 15), (11, 0), (11, 45)]   # 對照組:每天固定挑這幾個時間點進場


def _line(s):
    print(s, flush=True)


def _hm(t):
    return t.hour * 60 + t.minute


def agg(bars, n=5):
    """1 分 K → n 分 K(⛔ 用**時間**對齊,不可用「每 n 根」—— 中間缺 K 會錯位)。
    ⚠️ 這裡不跨日:呼叫端自己把每天的 1 分 K 丟進來,再把各天接起來。"""
    out, cur, key = [], None, None
    for b in bars:
        k = _hm(b['t']) // n
        if k != key:
            if cur:
                out.append(cur)
            key = k
            cur = {'t': b['t'], 'o': b['o'], 'h': b['h'], 'l': b['l'], 'c': b['c'], 'v': b['v']}
        else:
            cur['h'] = max(cur['h'], b['h']); cur['l'] = min(cur['l'], b['l'])
            cur['c'] = b['c']; cur['v'] += b['v']
    if cur:
        out.append(cur)
    return out


def ema(vals, n):
    out, k, prev = [], 2 / (n + 1), None
    for v in vals:
        prev = v if prev is None else v * k + prev * (1 - k)
        out.append(prev)
    return out


def ttm_state(b5):
    """5 分 K 的 TTM Squeeze:回傳每根的 (擠壓中?, 動能>0?)。⛔ 只用該根之前的資料。"""
    n = len(b5)
    on, mom = [None] * n, [None] * n
    tr = [0.0] * n
    for i in range(1, n):
        tr[i] = max(b5[i]['h'] - b5[i]['l'], abs(b5[i]['h'] - b5[i - 1]['c']), abs(b5[i]['l'] - b5[i - 1]['c']))
    for i in range(19, n):
        cs = [b5[k]['c'] for k in range(i - 19, i + 1)]
        m = sum(cs) / 20
        sd = (sum((x - m) ** 2 for x in cs) / 20) ** 0.5
        atr = sum(tr[i - 19:i + 1]) / 20
        on[i] = (m + 2 * sd) < (m + 1.5 * atr) and (m - 2 * sd) > (m - 1.5 * atr)
        hh = max(b5[k]['h'] for k in range(i - 19, i + 1))
        ll = min(b5[k]['l'] for k in range(i - 19, i + 1))
        mom[i] = b5[i]['c'] - (hh + ll + m) / 3
    return on, mom


def simulate(b5, ei, side, vwap5, stop0, e5=None, day=None):
    """從第 ei 根**的下一根開盤**進場,沿 5EMA 抱單,回傳毛損益 %(⛔ 未扣成本)。
    ⭐ 用「下一根開盤」是刻意的:附件說要等實體收盤確認,那時候你才下得了單(零前視)。"""
    if ei + 1 >= len(b5):
        return None
    if day is not None and b5[ei + 1].get('day') != day:
        return None                      # ⛔ 訊號出在當天最後一根 → 隔天才進場就不是當沖了
    entry = b5[ei + 1]['o']
    if not (entry > 0):
        return None
    if e5 is None:
        e5 = ema([x['c'] for x in b5], 5)
    for j in range(ei + 1, len(b5)):
        # 🚪 當沖:⛔ 絕不留倉 —— 換日就用當天最後一根收盤平掉
        if day is not None and b5[j].get('day') != day:
            out = b5[j - 1]['c']
            return (out - entry) / entry * 100 if side == 'long' else (entry - out) / entry * 100
        c = b5[j]['c']
        # 🛑 停損(用該根最低/最高判,保守)
        if side == 'long' and b5[j]['l'] <= stop0:
            return (stop0 - entry) / entry * 100
        if side == 'short' and b5[j]['h'] >= stop0:
            return (entry - stop0) / entry * 100
        # 🚪 沿 5EMA:實體跌破(做多)/ 站上(做空)就走 → 下一根開盤出
        broke = (side == 'long' and c < e5[j]) or (side == 'short' and c > e5[j])
        last = j == len(b5) - 1 or _hm(b5[j]['t']) >= FORCE_OUT[0] * 60 + FORCE_OUT[1]
        if broke or last:
            out = b5[j + 1]['o'] if (broke and j + 1 < len(b5)) else c
            if not (out > 0):
                out = c
            return (out - entry) / entry * 100 if side == 'long' else (entry - out) / entry * 100
    return None


# ═══════════ 🗣️ 盤中口訣的三個分 K 變體(V77.0.1)═══════════
#  使用者貼的 12 條口訣裡,有 3 條**日 K 量不到、非分 K 不可**:
#    ⑦ ②a「下午大漲不追 / 下午大跌次日買」—— 需要「現在幾點」
#    ⑧ ③a「早上大跌不割,等 10 分鐘看站不站得回開盤價」—— 需要 09:10 那個時點
#    ⑨ 檢②「第一根 5 分 K 上影線太長絕對不追」—— 需要 09:00~09:05 那一根
#  ⚠️⚠️ **跑之前先讀這段**:Shioaji kbars 只回溯 81~120 天 → 窗口單一、**逐年檢定做不了**,
#     六關裡的③④天生過不了 → 這三條的結論**只能當方向參考,⛔ 不可據以做提醒**
#     (V76.1.7 的 `_alertWorthIt` 鐵則:查不到成績的一律擋)。
#  ⭐ 抽成純函式是刻意的:沙箱連不到 Shioaji,只有這樣 `--selftest` 才驗得到判定本身。
MAXIM_AFTERNOON = 12 * 60    # ⛔ 這三條**不吃** NO_ENTRY_AFTER(12:30)—— 口訣講的就是下午
MAXIM_GAP_DN = -2.0          # 「早上大跌」的門檻(開盤相對昨收 %)
MAXIM_RUSH = 3.0             # 「大漲/大跌」的門檻(現價相對昨收 %)
MAXIM_SHADOW = 0.5           # 上影線佔全幅多少算「太長」


def maxim_signals(st):
    """回傳這一根該觸發哪些口訣變體 → [(名稱, 方向)]。
    st 需要:hm(現在,分)・t0(當天第一根的分)・pc(昨收)・op(今開)・c(現價)
             ・sh5(第一根 5 分 K 的上影佔全幅)・back10(09:10 有沒有站回開盤價)
    ⛔ 全部只用「此刻之前就知道」的東西(零前視);⛔ 不看未來任何一根。"""
    out = []
    hm, t0, pc, op, c = st['hm'], st['t0'], st['pc'], st['op'], st['c']
    if not (pc and pc > 0 and op and op > 0):
        return out
    gap0 = (op / pc - 1) * 100          # 開盤跳空 %
    chg = (c / pc - 1) * 100            # 此刻相對昨收 %
    # ⑨ 第一根 5 分 K 的上影線(進場點 = 那根收完的下一根)
    if hm == t0 + 5 and st.get('sh5') is not None:
        if st['sh5'] >= MAXIM_SHADOW:
            out.append(('⑨ 第一根5分K長上影後仍追(口訣說絕對不追)', 'long'))
        elif st['sh5'] <= 0.2:
            out.append(('⑨b 對照:第一根5分K沒上影後追', 'long'))
    # ⑧ 早上大跌,10 分鐘後站不站得回開盤價
    #   ⚠️ 口訣講的是「不割」(持有者的事);這裡測「買」是**代理**,⛔ 不等於原句
    if hm == t0 + 10 and gap0 <= MAXIM_GAP_DN and st.get('back10') is not None:
        out.append(('⑧ 開盤大跌·10分內站回開盤價' if st['back10']
                    else '⑧b 開盤大跌·10分沒站回', 'long'))
    # ⑦ 下午急漲/急跌(口訣:下午大漲不追、下午大跌次日買)
    if hm >= MAXIM_AFTERNOON:
        if chg >= MAXIM_RUSH:
            out.append(('⑦ 下午急漲(≥+3%)後追(口訣說不要追)', 'long'))
        elif chg <= -MAXIM_RUSH:
            out.append(('⑦b 下午急跌(≤-3%)後接', 'long'))
    return out


def hist_update(hist, b1):
    for b in b1:
        hist.setdefault(_hm(b['t']), []).append(b['v'])



def selftest():
    """🧪 自我驗證:合成分 K,注入一個**必然賺得到**的訊號,確認這支探針抓得出來。
    ⛔ 沒有這條的話,「所有訊號都貼近對照組」分不出是「真的沒用」還是「程式根本沒觸發」。"""
    import random
    random.seed(7)
    base = datetime(2026, 8, 3, 9, 0, tzinfo=timezone.utc)
    ok = True

    def mkday(day, inject):
        """做一天的 1 分 K。inject=True 時:突破 ORB 高點之後**一路漲**(訊號必賺)。"""
        bars, px = [], 100.0
        for m in range(270):                      # 09:00~13:30
            t = base + timedelta(days=day, minutes=m)
            if m < OR_MIN:
                px += random.uniform(-0.05, 0.05)          # 開盤區間:小幅震盪
            elif inject and m == OR_MIN + 5:
                px += 1.2                                   # 一根帶量突破
            elif inject and m > OR_MIN + 5:
                px += 0.06                                  # 之後一路漲(5EMA 不會跌破)
            else:
                px += random.uniform(-0.08, 0.08)
            v = 300 if (inject and OR_MIN + 5 <= m <= OR_MIN + 6) else 30   # 爆量 10 倍 → RVOL 高
            # 🕳️ 刻意挖洞:真實分 K 有「那一分鐘沒成交」的缺 K → agg5 必須**用時間對齊**,
            #    ⛔ 用「每 5 根」會錯位。沒有洞的話這條注入驗證抓不到(測資要重現情境)
            if m in (40, 41, 42, 77, 120, 121, 200):
                continue
            bars.append({'t': t, 'o': px, 'h': px + 0.05, 'l': px - 0.05, 'c': px, 'v': v})
        return bars

    # ① agg5:時間對齊,⛔ 不是「每 5 根」
    b1 = mkday(0, False)
    b5 = agg(b1, 5)
    # ⭐ 正確的不變式:輸出根數 == 1 分 K 落在幾個「5 分鐘桶」裡,而且桶序嚴格遞增。
    #   ⛔ 不可斷言「每根都落在 %5==0 的分鐘」—— 缺 K 時該桶的第一根本來就不是整 5 分。
    want = len({_hm(b['t']) // 5 for b in b1})
    inc = all((_hm(b5[i]['t']) // 5) > (_hm(b5[i - 1]['t']) // 5) for i in range(1, len(b5)))
    if len(b5) != want or not inc:
        _line(f'❌ selftest① agg5 沒有時間對齊:輸出 {len(b5)} 根 vs 應有 {want} 桶 ・桶序遞增={inc}'); ok = False
    else:
        _line(f'✅ selftest① 1分K → 5分K 用**時間**對齊({want} 根,測資含 7 根缺 K)')

    # ①b 🚨 釘住進場點:simulate 必須用「訊號那根的**下一根開盤**」——
    #    ⛔ 用訊號那根的收盤 = 前視偏誤(那時候你還沒看到收盤價)。合成資料的差額太小驗不出來,
    #    所以直接釘實作(同本專案「釘住關鍵呼叫點」的做法)。
    import inspect as _insp
    _src = _insp.getsource(simulate)
    if "b5[ei + 1]['o']" not in _src:
        _line('❌ selftest①b 進場點不是「下一根開盤」→ 有前視偏誤'); ok = False
    else:
        _line('✅ selftest①b 進場點釘住:訊號那根的下一根開盤(零前視)')

    # ② simulate:一路漲的日子,做多必須是正的;一路跌必須被 5EMA/停損砍掉
    up = agg(mkday(1, True), 5)
    g = simulate(up, 4, 'long', up[4]['c'], up[4]['l'] - 5)
    if g is None or g <= 0:
        _line(f'❌ selftest② 一路漲卻沒賺到:{g}'); ok = False
    else:
        _line(f'✅ selftest② 一路漲 → 做多毛利 {g:+.2f}%(沿 5EMA 抱得住)')

    # ③ 🚨 最重要的:注入訊號後,「三大核心」那一桶必須真的收到樣本且是正的
    hist, got = {}, []
    for d in range(6):
        bars = mkday(d, d >= 3)                    # 前 3 天暖身(給 RVOL 基準),後 3 天注入
        rv = {}
        for b in bars:
            h = _hm(b['t']); prev = hist.get(h, [])
            if len(prev) >= 3:
                a = sum(prev[-RVOL_LOOKBACK:]) / len(prev[-RVOL_LOOKBACK:])
                rv[h] = (b['v'] / a) if a > 0 else None
        cum_pv = cum_v = 0.0; vwap1 = {}
        for b in bars:
            tp = (b['h'] + b['l'] + b['c']) / 3
            cum_pv += tp * b['v']; cum_v += b['v']
            vwap1[_hm(b['t'])] = cum_pv / cum_v
        t0 = _hm(bars[0]['t'])
        orb = [b for b in bars if _hm(b['t']) < t0 + OR_MIN]
        orh = max(b['h'] for b in orb)
        bb = agg(bars, 5)
        for i in range(1, len(bb)):
            hm = _hm(bb[i]['t'])
            if hm < t0 + OR_MIN:
                continue
            rr = [rv[x] for x in range(hm, hm + 5) if rv.get(x) is not None]
            rvol = max(rr) if rr else None
            vw = vwap1.get(hm)
            if rvol is not None and rvol >= RVOL_HI and bb[i - 1]['c'] <= orh < bb[i]['c'] and vw and bb[i]['c'] > vw:
                gg = simulate(bb, i, 'long', vw, min(bb[i]['l'], vw))
                if gg is not None:
                    got.append(gg)
                break
        hist_update(hist, bars)
    if len(got) < 2 or sum(got) / len(got) <= 0:
        _line(f'❌ selftest③ 注入的訊號沒被抓到(收到 {len(got)} 筆)→ 這支探針有問題,⛔ 別信它的結論'); ok = False
    else:
        _line(f'✅ selftest③ 注入訊號抓到 {len(got)} 筆 ・平均毛利 {sum(got) / len(got):+.2f}%')

    # ④ 🗣️ 口訣變體的判定(⭐ 純函式,沙箱裡唯一驗得到的那一段)
    T0 = 540      # 09:00
    cases = [
        # (情境, st, 應該出現的名稱片段, 不應該出現的片段)
        ('長上影後追', dict(hm=T0 + 5, t0=T0, pc=100, op=100, c=101, sh5=0.7, back10=None), '長上影', '沒上影'),
        ('沒上影對照', dict(hm=T0 + 5, t0=T0, pc=100, op=100, c=101, sh5=0.1, back10=None), '沒上影', '長上影'),
        ('上影中間值不觸發', dict(hm=T0 + 5, t0=T0, pc=100, op=100, c=101, sh5=0.35, back10=None), None, '⑨'),
        ('開盤大跌+站回', dict(hm=T0 + 10, t0=T0, pc=100, op=97, c=97.5, sh5=None, back10=True), '站回開盤價', '沒站回'),
        ('開盤大跌+沒站回', dict(hm=T0 + 10, t0=T0, pc=100, op=97, c=96, sh5=None, back10=False), '沒站回', '站回開盤價'),
        ('開盤沒大跌 → ⛔ 不觸發', dict(hm=T0 + 10, t0=T0, pc=100, op=99.5, c=99, sh5=None, back10=False), None, '⑧'),
        ('下午急漲', dict(hm=12 * 60 + 5, t0=T0, pc=100, op=100, c=104, sh5=None, back10=None), '下午急漲', '急跌'),
        ('下午急跌', dict(hm=12 * 60 + 5, t0=T0, pc=100, op=100, c=96, sh5=None, back10=None), '下午急跌', '急漲'),
        ('上午急漲 → ⛔ 不是「下午」', dict(hm=10 * 60, t0=T0, pc=100, op=100, c=104, sh5=None, back10=None), None, '⑦'),
        ('沒有昨收 → ⛔ 什麼都不觸發', dict(hm=12 * 60 + 5, t0=T0, pc=None, op=100, c=104, sh5=None, back10=None), None, ''),
    ]
    bad4 = 0
    for label, st, want, avoid in cases:
        names = ' | '.join(n for n, _ in maxim_signals(st))
        hit = (want is None) or (want in names)
        miss = (not avoid) and names == '' or (avoid and avoid not in names)
        if not (hit and miss):
            _line(f'❌ selftest④ {label}:得到「{names or "(空)"}」'); bad4 += 1; ok = False
    if not bad4:
        _line(f'✅ selftest④ 口訣三變體的判定 {len(cases)} 條全過(含「不該觸發的不可觸發」)')
    # ④b ⛔ 這三條**不可以**吃 NO_ENTRY_AFTER(12:30)那道閘門 —— 口訣講的就是下午
    if MAXIM_AFTERNOON >= NO_ENTRY_AFTER[0] * 60 + NO_ENTRY_AFTER[1]:
        _line('❌ selftest④b 下午變體的時間門比 NO_ENTRY_AFTER 還晚 → 它永遠不會觸發'); ok = False
    else:
        _line('✅ selftest④b 下午變體有自己的時間門(⛔ 不吃 12:30 那道)')

    _line('✅ SELFTEST_PASS' if ok else '❌ SELFTEST_FAIL')
    return 0 if ok else 1


def main():
    # 🚨🚨 這面旗子**一定要印在最上面**(⛔ 不可只寫在 docstring —— 看 log 的人不會回去讀原始碼):
    #   Shioaji kbars 只回溯 81~120 天 → 窗口單一、**逐年檢定與「去最好年」天生做不了**
    #   → 這支印出來的任何數字都**只能當方向參考**,⛔ 不可據以做盤中提醒
    #     (V76.1.7 `_alertWorthIt` 鐵則:查不到成績的一律擋)。
    #   ⚠️ 而且分 K **一根都沒有被存下來** → 每次重跑窗口都往後滑,**兩次結果不會一樣**。
    _line('=' * 72)
    _line('⚠️ 窗口限制:Shioaji kbars 只回溯 81~120 天 → ⛔ 逐年檢定 / 去最好年這兩關做不了。')
    _line('⚠️ 分 K 沒有落地存檔 → 每次重跑窗口都往後滑,**兩次跑出來不會一樣**。')
    _line('⛔ 所以:這裡的數字只能當**方向參考**,⛔ 不可拿來做盤中提醒或接進 App。')
    _line(f'⚠️ 當沖來回成本一律扣 {COST_PCT}%;⛔ 毛利為正不代表賺得到(orb_probe 就是這樣死的)。')
    _line('=' * 72)
    key = os.environ.get('SHIOAJI_API_KEY', '').strip()
    sec = os.environ.get('SHIOAJI_SECRET_KEY', '').strip()
    res = {'ok': False, 'rows': [], 'note': ''}
    if not key or not sec:
        _line('❌ 缺 SHIOAJI_API_KEY / SHIOAJI_SECRET_KEY'); _save(res); sys.exit(1)
    try:
        import shioaji as sj
    except Exception as e:
        _line(f'❌ shioaji 未安裝: {e}'); _save(res); sys.exit(1)

    api = sj.Shioaji()
    try:
        try:
            api.login(api_key=key, secret_key=sec, fetch_contract=True)
        except TypeError:
            api.login(api_key=key, secret_key=sec)
            try:
                api.fetch_contracts(contract_download=True)
            except Exception:
                pass
        _line('✅ Shioaji 登入成功')
    except Exception as e:
        _line(f'❌ Shioaji 登入失敗: {e}'); _save(res); sys.exit(1)

    today = datetime.now(TW).date()
    start = (today - timedelta(days=DAYS_BACK)).strftime('%Y-%m-%d')
    end = today.strftime('%Y-%m-%d')
    _line(f'📕 附件當沖指標「分 K 版」實測 ・{len(SYMS)} 檔 ・kbars {start} ~ {end}')
    _line(f'   扣當沖來回成本 {COST_PCT}% ・ORB={OR_MIN} 分 ・RVOL 回看 {RVOL_LOOKBACK} 天同一分鐘 ・門檻 {RVOL_HI}')
    _line('=' * 96)

    buckets = {}          # 「[週期] 事件名」→ [淨損益%]
    ctrl = {}             # 週期 → 對照組 [淨損益%]
    scanned = 0

    def put(k, g):
        if g is None:
            return
        buckets.setdefault(k, []).append(g - COST_PCT)

    for sym in SYMS:
        c = find_contract(api, sym)
        if c is None:
            _line(f'[{sym}] ⚠️ 無合約'); continue
        try:
            kb = api.kbars(c, start=start, end=end)
            ts = list(kb.ts)
            op, hi, lo, cl = list(kb.Open), list(kb.High), list(kb.Low), list(kb.Close)
            vol = list(getattr(kb, 'Volume', [0] * len(ts)))
        except Exception as e:
            _line(f'[{sym}] ❌ {type(e).__name__}: {str(e)[:110]}'); continue

        by_day = {}
        for i in range(len(ts)):
            t = _t(ts[i])
            by_day.setdefault(t.strftime('%Y-%m-%d'), []).append(
                {'t': t, 'o': op[i], 'h': hi[i], 'l': lo[i], 'c': cl[i], 'v': vol[i]})

        # ── 第 1 輪:每天各自算 RVOL / VWAP / ORB(⛔ 都只用當天到目前為止 + 之前的天)──
        hist, perday = {}, {}
        prev_close = None          # 🗣️ 口訣變體要用的「昨收」(第一天沒有 → 那天不觸發,刻意)
        for d in sorted(by_day):
            b1 = sorted(by_day[d], key=lambda x: x['t'])
            if len(b1) < 60:
                continue
            # RVOL:這一分鐘的量 ÷ **過去 N 天同一分鐘**的平均量(⛔ hist 只累積到前一天 = 零前視)
            rv = {}
            for b in b1:
                h = _hm(b['t']); prev = hist.get(h, [])
                if len(prev) >= 3:
                    a2 = sum(prev[-RVOL_LOOKBACK:]) / len(prev[-RVOL_LOOKBACK:])
                    rv[h] = (b['v'] / a2) if a2 > 0 else None
            # 當日 VWAP(累計)
            cum_pv = cum_v = 0.0
            vwap1 = {}
            for b in b1:
                tp = (b['h'] + b['l'] + b['c']) / 3
                cum_pv += tp * b['v']; cum_v += b['v']
                vwap1[_hm(b['t'])] = (cum_pv / cum_v) if cum_v > 0 else b['c']
            t0 = _hm(b1[0]['t'])
            orb = [b for b in b1 if _hm(b['t']) < t0 + OR_MIN]
            hist_update(hist, b1)
            if len(orb) < 5:
                continue
            orh = max(b['h'] for b in orb); orl = min(b['l'] for b in orb)
            if not (orh > orl > 0):
                continue
            # 🗣️ 口訣變體要用的當日純量(⛔ 全部只用當天到該時點為止 + 前一天收盤 = 零前視)
            op0 = b1[0]['o']
            five = [b for b in b1 if t0 <= _hm(b['t']) < t0 + 5]
            sh5 = None
            if five:
                fh = max(b['h'] for b in five); fl = min(b['l'] for b in five)
                fo, fc = five[0]['o'], five[-1]['c']
                sh5 = (fh - max(fo, fc)) / (fh - fl) if fh > fl else 0.0
            b10 = [b for b in b1 if _hm(b['t']) <= t0 + 10]
            back10 = (b10[-1]['c'] >= op0) if b10 else None
            perday[d] = {'b1': b1, 'rv': rv, 'vw': vwap1, 't0': t0, 'orh': orh, 'orl': orl,
                         'pc': prev_close, 'op': op0, 'sh5': sh5, 'back10': back10}
            prev_close = b1[-1]['c']          # ⭐ 給**下一個**交易日當昨收(⛔ 不是今天自己的)

        if not perday:
            _line(f'[{sym}] ⚠️ 沒有可用交易日'); continue
        scanned += len(perday)
        seg = []

        # ── 第 2 輪:每個週期各跑一次 ─────────────────────────────
        for P in PERIODS:
            # ⭐ 週期 K **跨日接成一條連續序列** —— 交易軟體上的 15 分/60 分線本來就是連續的,
            #    而且 15 分一天只有 18 根、60 分只有 4~5 根,TTM(要 20 根)日內根本算不出來。
            #    ⛔ 但進出場一律當天結束前平掉(simulate 有換日守門)。
            bars = []
            for d in sorted(perday):
                for bb in agg(perday[d]['b1'], P):
                    bb['day'] = d
                    bars.append(bb)
            if len(bars) < 40:
                continue
            on, mom = ttm_state(bars)
            e5 = ema([x['c'] for x in bars], 5)
            fired = set()
            for i in range(1, len(bars)):
                d = bars[i].get('day')
                pd = perday.get(d)
                if not pd:
                    continue
                hm = _hm(bars[i]['t'])
                if hm < pd['t0'] + OR_MIN or hm >= NO_ENTRY_AFTER[0] * 60 + NO_ENTRY_AFTER[1]:
                    continue
                if bars[i - 1].get('day') != d:
                    continue                      # 當天第一根:沒有「前一根」可比,跳過
                cc = bars[i]['c']
                vw = pd['vw'].get(hm) or pd['vw'].get(hm - 1)
                if vw is None:
                    continue
                # RVOL:這根週期 K 涵蓋的分鐘裡取最大(附件講的是「這一分鐘爆量」)
                rr = [pd['rv'][x] for x in range(hm, hm + P) if pd['rv'].get(x) is not None]
                rvol = max(rr) if rr else None
                above = cc > vw
                brkU = bars[i - 1]['c'] <= pd['orh'] < cc
                brkD = bars[i - 1]['c'] >= pd['orl'] > cc
                sq_fire = on[i - 1] is True and on[i] is False
                stopL = min(bars[i]['l'], vw)
                stopS = max(bars[i]['h'], vw)

                def once(name, side):
                    k = f'[{P:>2}分] {name}'
                    if (d, k) in fired:
                        return
                    fired.add((d, k))
                    put(k, simulate(bars, i, side, vw, stopL if side == 'long' else stopS, e5, d))

                if above:
                    once('① 價在 VWAP 之上(附件:只做多)', 'long')
                else:
                    once('① 價在 VWAP 之下(附件:只做空)', 'short')
                if brkU:
                    once('② 突破 ORB 高點', 'long')
                if brkD:
                    once('② 跌破 ORB 低點', 'short')
                if rvol is not None:
                    if rvol >= RVOL_HI:
                        once('③ RVOL ≥ 2.0(附件:主力進場)', 'long')
                    elif rvol < 1.0:
                        once('③ RVOL < 1.0(附件:假突破)', 'long')
                if sq_fire:
                    once('④ TTM 擠壓發射', 'long' if (mom[i] or 0) > 0 else 'short')
                if brkU and above and rvol is not None and rvol >= RVOL_HI:
                    once('⑤ 🚨 三大核心:突破ORB高+價>VWAP+RVOL≥2', 'long')
                if brkU and above:
                    once('⑤b 只有兩個(突破ORB高+價>VWAP,不看量)', 'long')
                if brkD and (not above) and rvol is not None and rvol >= RVOL_HI:
                    once('⑤c 🚨 做空版:跌破ORB低+價<VWAP+RVOL≥2', 'short')
                if sq_fire and rvol is not None and rvol >= RVOL_HI:
                    once('⑥ 🚨 終極訊號:TTM發射+RVOL≥2', 'long' if (mom[i] or 0) > 0 else 'short')

            # ── 🗣️ 口訣變體(⛔ 只在 5 分 K 跑:⑧⑨ 綁 09:05 / 09:10 這兩個時點,
            #    15/60 分 K 上根本沒有那兩根 → 在別的週期跑會變成「沉默不觸發」= 看起來像沒差別)
            if P == 5:
                for i in range(1, len(bars)):
                    d = bars[i].get('day'); pd = perday.get(d)
                    if not pd or bars[i - 1].get('day') != d:
                        continue
                    hm = _hm(bars[i]['t'])
                    vw = pd['vw'].get(hm) or pd['vw'].get(hm - 1) or bars[i]['c']
                    sigs = maxim_signals({'hm': hm, 't0': pd['t0'], 'pc': pd['pc'], 'op': pd['op'],
                                          'c': bars[i]['c'], 'sh5': pd['sh5'], 'back10': pd['back10']})
                    for name, side in sigs:
                        k = f'[口訣] {name}'
                        if (d, k) in fired:
                            continue
                        fired.add((d, k))
                        put(k, simulate(bars, i, side, vw,
                                        min(bars[i]['l'], vw) if side == 'long' else max(bars[i]['h'], vw), e5, d))

            # ⭐ 對照組:同樣的出場規則,但進場時間**固定挑幾個**(⛔ 不看任何訊號)
            for d in sorted(perday):
                idxs = [i for i, b in enumerate(bars) if b.get('day') == d]
                if not idxs:
                    continue
                for (H, M) in CTRL_TIMES:
                    tgt = H * 60 + M
                    idx = next((i for i in idxs if _hm(bars[i]['t']) >= tgt), None)
                    if idx is None:
                        continue
                    vw = perday[d]['vw'].get(_hm(bars[idx]['t'])) or bars[idx]['c']
                    g = simulate(bars, idx, 'long', vw, min(bars[idx]['l'], vw), e5, d)
                    if g is not None:
                        ctrl.setdefault(P, []).append(g - COST_PCT)
            seg.append(f'{P}分{len(bars)}根')
        _line(f'[{sym}] {len(by_day)} 天資料 ・{len(perday)} 個可用交易日 ・' + ' / '.join(seg))

    try:
        api.logout()
    except Exception:
        pass

    # 🚧 空過守門
    if scanned == 0:
        _line('🚨 一個可用交易日都沒有 → ⛔ 不下結論(⛔ 不可讀成「沒有差異」)'); _save(res); sys.exit(1)
    thin = [P for P in PERIODS if len(ctrl.get(P, [])) < 200]
    if len(thin) == len(PERIODS):
        _line(f'🚨 每個週期的對照組都不足 200 筆 → ⛔ 不下結論'); _save(res); sys.exit(1)

    def stat(a):
        n = len(a)
        if not n:
            return None
        m = sum(a) / n
        w = sum(1 for x in a if x > 0) / n * 100
        srt = sorted(a)
        return {'n': n, 'avg': m, 'wr': w, 'med': srt[n // 2]}

    rows = []
    for P in PERIODS:
        cs = stat(ctrl.get(P, []))
        _line('')
        _line('=' * 100)
        if cs is None or cs['n'] < 200:
            _line(f'📊 【{P} 分 K】對照組只有 {cs["n"] if cs else 0} 筆 → ⛔ 樣本太小,這個週期不下結論')
            continue
        _line(f'📊 【{P} 分 K】對照組(同樣出場、⛔ 不看訊號隨便挑時間進場):'
              f'{cs["n"]} 筆 ・淨每趟 {cs["avg"]:+.3f}% ・勝率 {cs["wr"]:.1f}% ・中位 {cs["med"]:+.3f}%')
        _line('   ⛔ 基準不是 0 也不是 50% —— 下面每一列都要跟這個比')
        _line('-' * 100)
        _line(f'{"事件(附件說的)":<44}{"n":>6}{"淨每趟":>10}{"勝率":>8}{"中位":>9}{"vs對照":>10}')
        mine = {k: v for k, v in buckets.items() if k.startswith(f'[{P:>2}分] ')}
        for k, arr in sorted(mine.items(), key=lambda kv: -(sum(kv[1]) / len(kv[1]) if kv[1] else -9)):
            st = stat(arr)
            nm = k.split('] ', 1)[1]
            if st is None or st['n'] < 30:
                _line(f'{nm:<44}{(st["n"] if st else 0):>6}   樣本太少,⛔ 不下結論')
                continue
            rows.append({'p': P, 'k': nm, **st, 'vs': st['avg'] - cs['avg']})
            _line(f'{nm:<44}{st["n"]:>6}{st["avg"]:>+10.3f}{st["wr"]:>7.1f}%{st["med"]:>+9.3f}{st["avg"] - cs["avg"]:>+10.3f}')
        # 🚧 那兩個「附件主打」如果一筆都沒觸發,要點名(⛔ 不可靜默)
        for want in ('⑤ 🚨 三大核心:突破ORB高+價>VWAP+RVOL≥2', '⑥ 🚨 終極訊號:TTM發射+RVOL≥2'):
            if f'[{P:>2}分] {want}' not in buckets:
                _line(f'🚨 【{P}分】「{want}」觸發 0 筆 = 這個變體根本沒生效,⛔ 別讀成「沒有差別」')

    _line('')
    _line('=' * 100)
    _line('🧭 怎麼讀')
    _line('   ⭐ 只看「vs對照」那一欄 —— 它跟每一列用**同樣的出場規則、同樣的週期**,')
    _line('      所以差額才是「這個訊號」本身的價值,⛔ 不是「這套當沖出場好不好」。')
    _line(f'   ⚠️ 全部已扣當沖來回成本 {COST_PCT}%;⛔ 毛利不可拿來下結論。')
    _line('   ⚠️ 週期 K 是**跨日連續**的(交易軟體上本來就是),但進出場一律當天平掉;')
    _line('      ⚠️ 60 分 K 一天只有 4~5 根 → 沿 5EMA 幾乎抱到收盤,實質接近「進場後放到 13:25」。')
    _line('   ⚠️ 窗口只有這一段(kbars 回溯有限)→ **逐年檢定做不了**,⛔ 不可外推到別的行情。')
    _line('   ⚠️ 同一天同一個訊號只算第一次(⛔ 否則同一段行情會被重複計分)。')
    res.update({'ok': True, 'ctrl': {str(P): stat(v) for P, v in ctrl.items()}, 'rows': rows,
                'syms': SYMS, 'days': scanned, 'periods': PERIODS,
                'cost': COST_PCT, 'start': start, 'end': end})
    _save(res)


# 🚨🚨 V74.6.9 這裡原本還有**第二份** `hist_update` / `selftest` / `main`(舊版)——
#   Python 用**最後**一個定義 → 實際跑的是舊版,而我一直以為在跑新版。
#   症狀:守門寫 `len(ctrl) < 200`,但 `ctrl` 是「週期 → 陣列」的 dict → `len` = **週期數(3)**
#   → 一律報「對照組只有 3 筆」而停掉,看起來像資料不夠,其實是**單位搞錯 + 跑到舊碼**。
#   ⭐ 通用:同一個檔案裡重複定義同名函式**不會報錯**,只會安靜地讓舊版生效
#     → 已加守門 `scripts/check_dup_def.py`(納入四驗證第 2 項)。

def _save(r):
    try:
        os.makedirs('data', exist_ok=True)
        with open(OUT, 'w', encoding='utf-8') as f:
            json.dump(r, f, ensure_ascii=False, indent=1)
        _line(f'💾 已存 {OUT}')
    except Exception as e:
        _line(f'⚠️ 存檔失敗:{e}')


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        sys.exit(selftest())
    main()
