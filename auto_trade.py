#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🤖 尾盤自動下單(永豐 Shioaji)—— ⛔⛔ 只能在「你自己的電腦」跑

═══════════════════════════════════════════════════════════════════════════
🔐 最重要的一條:⛔ 這支程式**絕對不可以**放進 .github/workflows/
═══════════════════════════════════════════════════════════════════════════
   ・本 repo 是 **public**;GitHub Actions 的 log / artifact 都有外洩風險,
     而且任何能改 workflow 的人都能把 Secrets 印出來。
   ・下單需要的是「**電子憑證 .pfx + 憑證密碼 + 身分證字號**」——
     那等於「代表你本人動你的錢」,外洩 = 別人可以拿你的帳戶下單。
   ⭐ 分界很清楚:**行情可以在雲端跑(現在就是),下單只能在你自己的電腦跑。**
   ⚠️ scripts/check_workflow_paths.py 不會替你擋這件事 —— 這是人的紀律。

═══════════════════════════════════════════════════════════════════════════
⚠️ 上線前必讀(⛔ 別跳過)
═══════════════════════════════════════════════════════════════════════════
1. **預設是模擬模式**(`simulation=True`)。要真的下單必須明確設 `LIVE=1`,
   ⛔ 而且我建議你先用模擬模式跑滿 1~3 個月,對照 App 裡的「📒 你自己的實盤成績」。
2. **回測 ≠ 實盤**:回測假設你一定買得到那個價。實際上會遇到
   漲停買不到 / 量太小掛不進去 / 滑價吃掉利潤。
3. **勝率只有 33%** —— 連錯 5~7 次是正常的。自動化不會改變這件事,
   只會讓你**更快**遇到。手動時你會停下來想,自動時它會繼續扣你的錢。
4. **這套策略還沒經過空頭驗證**(回測那 13 個月 0050 漲 83%,是大多頭)。
5. 需要先向永豐申請 **API 下單權限**(抓行情的金鑰**不含**下單權限)。

═══════════════════════════════════════════════════════════════════════════
⏰ 為什麼是尾盤 13:00~13:28(⛔ 別改成開盤或整天跑)
═══════════════════════════════════════════════════════════════════════════
`scripts/portfolio_backtest.mjs` 實測(600 檔・13 個月・本金 100 萬・每天 3 檔那組):
    訊號日**尾盤**買        +1,361,088 元(vs 0050 多賺 528,588・回撤 −9.4%)
    隔天**開盤**買            +818,734 元(比 0050 還少賺 13,766・回撤 −19.1%)
    隔天開盤・跳空>1% 不追    −147,644 元(倒賠・回撤 −36.4%)
⭐ 改成「每天 2 檔 + 等權」之後是 **+1,718,529 元 ・回撤 −9.31%**(現行設定)。
真因:打法的判定條件全部用**收盤價**算 → 09:30 站上去、13:20 又掉下來的**不算數**。

跑法:
    # 模擬(預設,強烈建議先跑一兩個月)
    export SHIOAJI_API_KEY=...  SHIOAJI_SECRET_KEY=...
    export SJ_CA_PATH=/你的路徑/Sinopac.pfx  SJ_CA_PASSWD=...  SJ_PERSON_ID=A123456789
    python3 auto_trade.py

    # 只看它想做什麼、完全不送單
    DRY_RUN=1 python3 auto_trade.py

    # 真的下單(⛔ 確認模擬跑過再開)
    LIVE=1 MAX_LOTS_PER_TRADE=1 python3 auto_trade.py

═══════════════════════════════════════════════════════════════════════════
👑 V77.8.9 第二套:領頭羊短線輪動(⛔ 預設關,要自己開 LEADER=1)
═══════════════════════════════════════════════════════════════════════════
規則跟 App 決策台最下面那一區**一字不差**(`leader_calc` 是 App `_leaderCalc` 的第二份實作,
test_leaderdeck.mjs 拿同一份 screener.json 跨語言比對):
    近 20 日平均成交額前 100 大(不含 ETF)→ 收盤 > 20 日線 > 60 日線 → 近 10 日漲幅排名 →
    前 5 名買(📍 V78.0.5 起只買「一年位置 ≥85%」的,不夠就往下一名找;LEADER_POS=0 換回舊的)、
    手上的掉出前 10 名就賣;每 10 個交易日換一次(起點 LEADER_ANCHOR,跟 App 同一個);
    ⛔ 不設停損線;大盤嚴格空頭不買(賣照常);注意 / 處置股⛔ 不跳過(實測跳過反而輸 0050)。
    LEADER=1 LEADER_ACCOUNT=1000000 python3 auto_trade.py           # 尾盤跑(預設,跟上面那套同一個時段)
    LEADER=1 LEADER_WINDOW=open LEADER_ACCOUNT=1000000 python3 ...  # 09:00~09:10 開盤跑(= 回測那一組)
⚠️ 實測(17 條起點中位,V78.0.5 新規則):隔天開盤買 AI 時代 +953% / 16 年 +6,783%;尾盤買 +817% / +3,342%(0050 含息 +375% / +1,097%)。
   (舊規則不看位置:+760% / +3,176%;尾盤 +670% / +2,219%)
⚠️ 中途最多賠 49~57%、16 年只有 10 年贏 0050;沒用到的錢程式**不會**自動買 0050(回測有停 0050,自己手動放)。
⚠️ 它只賣「這套自己買、記在狀態檔 lead 那一格」的部位 —— ⛔ 不碰你手動買的、⛔ 也不碰上面那套買的。
"""
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone, timedelta

# ── 設定(全部走環境變數,⛔ 不要把金鑰寫進這個檔案)────────────────────────
GH_BASE = os.getenv('GH_BASE', 'https://xin7355-collab.github.io/StockAI-DB/')
LIVE = os.getenv('LIVE') == '1'            # ⛔ 預設 False = 模擬模式
DRY_RUN = os.getenv('DRY_RUN') == '1'      # 只印不送單(連模擬單都不送)
EOD_FROM = int(os.getenv('EOD_FROM', '13')) * 60 + int(os.getenv('EOD_FROM_M', '0'))
EOD_TO = int(os.getenv('EOD_TO', '13')) * 60 + int(os.getenv('EOD_TO_M', '28'))
# ⭐ V73.0.0 實測「一天最多做 2 檔」(⛔ 原本 3):600 檔・13 個月・本金 100 萬
#   6 檔 +735,938 / 3 檔 +1,361,088 / ⭐2 檔 +1,718,529 / 1 檔 +1,720,402(回撤變大)
#   → 單調趨勢,2 檔是甜蜜點(賺最多且回撤最小)。⛔ 別「順手放寬」成更多。
MAX_PICKS = int(os.getenv('MAX_PICKS', '2'))              # 一天最多買幾檔
# 🧬 V78.0.7 一年位階門檻 75 → 85(兩窗口 17/17 贏、贏同比例隨機、80/85/90 高原)
#   採礦端 playbook_scan 已經照 85 標 hq 並排好;這裡用清單自帶的 rank / vol 再排一次,
#   只是讓「換回舊的」有地方設(GENE_RANK=75)。⛔ 同一條在 index `_GENE_RULE` / pro `_HQ_RULE`,test_generank 跨檔比對。
GENE_RANK = 75 if os.getenv('GENE_RANK', '85').strip() == '75' else 85
GENE_VOL = 60
MAX_LOTS_PER_TRADE = int(os.getenv('MAX_LOTS_PER_TRADE', '1'))   # 單筆張數上限(硬煞車)
MAX_AMT_PER_TRADE = int(os.getenv('MAX_AMT_PER_TRADE', '100000'))  # 單筆金額上限(元)
ACCOUNT_SIZE = int(os.getenv('ACCOUNT_SIZE', '0'))        # 帳戶總資金(算張數用;0 = 只買 1 張)
# 💰 V73.0.1 部位大小改用**等權**(⛔ 不是風險法)—— 跟 App 的 `_lotsForPlaybook` 同一套。
#   實測(600 檔・13 個月・本金 100 萬・每天 2 檔,只改「每筆買多少」):
#     ⭐ 等權(每筆本金 15%)  +1,718,529 元 ・回撤 −9.31% ・資金使用率 92%
#       風險法 1%              +593,234 元 ・回撤 −9.15% ・資金使用率 59%(還輸 0050 +832,500)
#   ⛔ 風險法的回撤**沒有比較小** → 不是取捨,是單純比較差:停損寬時只買很少張甚至 0 張,
#     資金長期只用到 59%,四成的錢一直在睡覺。
#   ⚠️ 這支是**會下真單**的程式 → 部位算法一定要跟回測驗證過的那一套一致。
POS_PCT = float(os.getenv('POS_PCT', '15'))               # 每筆投入 = 帳戶總資金的幾 %
POLL_SEC = int(os.getenv('POLL_SEC', '60'))
STATE_PATH = os.getenv('STATE_PATH', os.path.expanduser('~/.stockai_auto_trade.json'))

TW = timezone(timedelta(hours=8))


def log(*a):
    print(f"[{datetime.now(TW).strftime('%H:%M:%S')}]", *a, flush=True)


def tpe_now():
    n = datetime.now(TW)
    return n, n.hour * 60 + n.minute, n.strftime('%Y-%m-%d')


def load_state():
    try:
        with open(STATE_PATH, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(st):
    # ⚠️ 寫失敗不可讓整支掛掉(但要講出來 —— 沒存成功 = 可能重複下單)
    try:
        with open(STATE_PATH, 'w', encoding='utf-8') as f:
            json.dump(st, f, ensure_ascii=False)
    except Exception as e:
        log(f"🚨 狀態檔寫入失敗({e})—— 重複下單的防護失效,請立刻停掉檢查")


# ═══════ 👑 V77.8.9 領頭羊短線輪動 ═══════
LEADER = os.getenv('LEADER') == '1'
LEADER_ACCOUNT = int(os.getenv('LEADER_ACCOUNT') or 0)       # 分給這一套的錢(每檔 = 這筆 ÷ N);0 = 不買(⛔ 不猜)
LEADER_WINDOW = (os.getenv('LEADER_WINDOW') or 'eod').lower()  # eod(尾盤,預設)| open(09:00~09:10)
# ⛔ 規則 / 錨點 / 名單 / 時鐘 V77.9.3 起搬到 lib_leader.py(成績單的採礦端也要用,⛔ 不複製第二份)。
#    App `_LEADER_EDGE.rule` / `.anchor` 跟 lib_leader 一字不差(test_leaderdeck.mjs 跨檔比對)。
import lib_leader as _LL
LEADER_RULE = _LL.LEADER_RULE
LEADER_ANCHOR = os.getenv('LEADER_ANCHOR') or _LL.LEADER_ANCHOR
# 📍 V78.0.5 買進的一年位置門檻(預設跟 App 同一個 = lib_leader 的 pos);LEADER_POS=0 = 換回舊規則(不看位置)
LEADER_POS = None if (os.getenv('LEADER_POS') or '') == '' else float(os.getenv('LEADER_POS'))


def fetch_json(rel):
    url = GH_BASE.rstrip('/') + f'/{rel}?t={int(time.time())}'
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.loads(r.read().decode('utf-8'))


def leader_calc(D, U=None, N=None):
    """→ lib_leader.leader_calc(App `_leaderCalc` 的 Python 版)"""
    return _LL.leader_calc(D, U, N, LEADER_POS)


def leader_clock(dates, data_date, anchor=None):
    """→ lib_leader.leader_clock;錨點預設讀 LEADER_ANCHOR(可用環境變數改)"""
    return _LL.leader_clock(dates, data_date, anchor or LEADER_ANCHOR)


def _send(api, sj, contract, px, shares, buy):
    """整張 + 零股拆兩筆送(同上面那套的寫法;⛔ 不動上面那套原本的程式碼)"""
    lots, odd = divmod(int(shares), 1000)
    act = sj.constant.Action.Buy if buy else sj.constant.Action.Sell
    sent = []
    for q, lot in ((lots, sj.constant.StockOrderLot.Common), (odd, sj.constant.StockOrderLot.IntradayOdd)):
        if q > 0:
            sent.append(api.place_order(contract, api.Order(
                price=px, quantity=q, action=act, price_type=sj.constant.StockPriceType.LMT,
                order_type=sj.constant.OrderType.ROD, order_lot=lot, account=api.stock_account)))
    return sent


def leader_step(api, sj, st, meta, today):
    """一天只做一次:換倉日的下一個交易日 → 賣掉掉出前 2N 的、買進前 N 還沒有的。⛔ 只動 st['lead'] 裡的部位。"""
    if st.get('lead_day') == today:
        return
    R = LEADER_RULE
    try:
        D = fetch_json('data/screener.json')
        tw = fetch_json('data/^TWII.json')
    except Exception as e:
        log(f"👑 ⚠️ 領頭羊:抓不到 screener / 加權({e}),稍後重試"); return
    L = leader_calc(D)
    if L.get('err'):
        log(f"👑 ⏭️ 領頭羊今天算不出名單({L['err']}:採礦還沒補欄位或檔案不在)")
        st['lead_day'] = today; save_state(st); return
    dd = str(L['date'])[:10]
    dates = sorted({str(r.get('date', '')).replace('/', '-')[:10] for r in (tw if isinstance(tw, list) else [])})
    prev = max((d for d in dates if d < today), default=None)
    if not dates or dd != prev:
        # ⛔ 名單必須是「今天之前最近一個交易日」收盤算的(用交易日判,⛔ 不用天數 —— 過年休 9 天也不會誤擋)
        log(f"👑 ⏭️ 名單日期 {dd} 不是今天之前最近的交易日 {prev}(今天 {today})→ ⛔ 不用舊名單下單")
        st['lead_day'] = today; save_state(st); return
    day, is_rebal, left = leader_clock(dates, dd)
    held = st.setdefault('lead', {})
    if not is_rebal:
        log(f"👑 {dd} 是第 {day} 個交易日({LEADER_ANCHOR} 起)→ 不是換倉日,還有 {left} 天。手上 {list(held) or '(無)'}")
        st['lead_day'] = today; save_state(st); return
    keep = {r['sym'] for r in L['ranked']}
    log(f"👑 換倉!名單日 {dd}(第 {day} 天)・池子 {L['n']} 檔・過趨勢 {L['passed']} 檔・前 {R['N']}:"
        + ' '.join(f"{r['sym']}({r['chg10']:+.1f}%{'・注意' if r['att'] == 1 else '・處置' if r['att'] == 2 else ''})" for r in L['buy']))
    _skip = [r for r in L['ranked'][:R['N']] if not r.get('posOk', True)]
    if _skip:
        log(f"   👑 📍 一年位置不到 {L.get('pos')}% → 不買、往下一名找:" + ' '.join(f"{r['sym']}({r['pos'] if r['pos'] is not None else '—'}%)" for r in _skip))
    # ① 賣:掉出前 2N 名(含掉出池子 / 沒過趨勢)
    for sym, pos in list(held.items()):
        if sym in keep:
            log(f"   👑 🛡️ {sym} 還在前 {R['N'] * R['hyst']} 名(第 {L['all'][sym]['rank']} 名)→ 續抱"); continue
        try:
            contract = api.Contracts.Stocks[sym]
            px = float(getattr(api.snapshots([contract])[0], 'close', 0) or 0) if contract is not None else 0
        except Exception as e:
            log(f"   👑 ❌ {sym} 報價失敗:{e}"); continue
        if px <= 0:
            continue
        sh = int(pos.get('sh') or 0)
        log(f"   👑 🚪 {sym} 掉出前 {R['N'] * R['hyst']} 名 → 賣 {sh} 股 @ {px}(帳面 {(px - float(pos.get('e') or px)) * sh:+,.0f} 元)")
        if DRY_RUN:
            log("      🧪 DRY_RUN:不送單"); continue
        try:
            log(f"      ✅ 賣單 {_send(api, sj, contract, px, sh, False)}")
            held.pop(sym, None); save_state(st)      # ⚠️ 送出後立刻移除(寧可漏一次,⛔ 不可重複送)
        except Exception as e:
            log(f"      ❌ 賣出失敗:{e}")
    # ② 買:大盤嚴格空頭不買(讀作戰清單的 mkt.bear60,⛔ 這裡不另算)
    _mkt = (meta or {}).get('mkt') or {}
    if BEAR_GATE and _mkt.get('bear60') is True:
        log("   👑 🐻 大盤嚴格空頭 → 今天不買新的(賣出已處理)")
    elif LEADER_ACCOUNT <= 0:
        log("   👑 ⚠️ 沒設 LEADER_ACCOUNT(分給這套的錢)→ 不買。要買請設 LEADER_ACCOUNT=<金額>")
    else:
        slot = LEADER_ACCOUNT / R['N']
        for r in L['buy']:
            sym = r['sym']
            if sym in held:
                continue
            if len(held) >= R['N']:
                break
            try:
                contract = api.Contracts.Stocks[sym]
                if contract is None:
                    log(f"   👑 ⚠️ 找不到合約 {sym}"); continue
                snap = api.snapshots([contract])[0]
                px = float(getattr(snap, 'close', 0) or 0)
                chg = float(getattr(snap, 'change_rate', 0) or 0)
            except Exception as e:
                log(f"   👑 ❌ {sym} 報價失敗:{e}"); continue
            if px <= 0:
                continue
            if chg >= 9.7:
                log(f"   👑 ⏭️ {sym} 已接近漲停({chg:.1f}%)→ 買不到,不追(回測同一條)"); continue
            shares = min(int(slot // px), MAX_LOTS_PER_TRADE * 1000, int(MAX_AMT_PER_TRADE // px))
            if shares <= 0:
                log(f"   👑 ⏭️ {sym} 算出 0 股(每檔 {slot:,.0f} 元,被 MAX_LOTS_PER_TRADE / MAX_AMT_PER_TRADE 壓到 0)"); continue
            if shares < int(slot // px):
                log(f"   👑 ⚠️ {sym} 被硬煞車壓成 {shares} 股(原本 {int(slot // px)} 股)—— 要照回測等權,請調高 MAX_LOTS_PER_TRADE / MAX_AMT_PER_TRADE")
            tag = '(注意股)' if r['att'] == 1 else '(處置股:第二次處置要預收款券,可能被退單)' if r['att'] == 2 else ''
            log(f"   👑 🛒 {sym} 第 {r['rank']} 名(10 日 {r['chg10']:+.1f}%)→ 買 {shares} 股 @ {px}{tag}")
            if DRY_RUN:
                log("      🧪 DRY_RUN:不送單"); continue
            try:
                log(f"      ✅ 買單 {_send(api, sj, contract, px, shares, True)}")
                held[sym] = {'e': px, 'd': today, 'sh': shares}; save_state(st)   # ⚠️ 先記再說(⛔ 不可重複下單)
            except Exception as e:
                log(f"      ❌ 下單失敗:{e}")
    st['lead_day'] = today; save_state(st)


def gene_hq(p):
    """🧬 這一筆是不是強勢高波動(位階 ≥ GENE_RANK 且年化波動率 ≥ 60);清單沒帶 rank / vol 就退回採礦端的 hq。"""
    r, v = p.get('rank'), p.get('vol')
    try:
        if r is not None and v is not None:
            return 1 if (float(r) >= GENE_RANK and float(v) >= GENE_VOL) else 0
    except (TypeError, ValueError):
        pass
    return 1 if p.get('hq') else 0


def fetch_picks():
    """讀 App 每晚產的『明日作戰清單』(gh-pages 上的 playbook_edge.json)。"""
    url = GH_BASE.rstrip('/') + f'/data/playbook_edge.json?t={int(time.time())}'
    with urllib.request.urlopen(url, timeout=20) as r:
        j = json.loads(r.read().decode('utf-8'))
    raw = j.get('picks') or []
    # 🚨 同一檔可能出現**多次**(不同招;實測 206 筆裡 6949 就出現兩次)。
    #    ⛔ 不先去重的話,picks[:MAX_PICKS] 的名額會被同一檔吃掉 →
    #    「一天最多 2 檔」實際上變成 1 檔(而 2 檔正是實測最好的那個設定)。
    #    ⭐ 清單已經照「🧬 優先 → 保守下界」排好 → 保留**第一筆(最好的那一招)**。
    # 🧬 用現行門檻重排(穩定排序:同一組裡保留採礦端的「保守下界」順序)
    raw = sorted(raw, key=lambda p: -gene_hq(p))
    picks, seen = [], set()
    for p in raw:
        sy = str(p.get('s') or '')
        if not sy or sy in seen:
            continue
        seen.add(sy)
        picks.append(p)
    log(f"📋 明日作戰清單:{len(raw)} 筆 / 去重後 {len(picks)} 檔"
        f"(資料日 {j.get('data_date')});本機取前 {MAX_PICKS} 檔")
    return j, picks


# ═══════ 🚪 V74.5.4 出場(賣出)—— 使用者:「自動下單只管買不管賣,把賣出也接上」 ═══════
# ⛔ 五條鐵則:
#   ① **只賣這支程式自己買進、而且有記在狀態檔裡的部位** —— ⛔ 絕不碰你手動買的庫存。
#   ② 出場規則跟 App 設定的那一條一致(`EXIT_RULE`,V77.7.6 起預設 **atr2**;V77.6.5~V77.7.5 是 don40、V75.0.9~V77.6.4 是 don)。
#      ⚠️ 這是**同一條公式的第二份實作**(App 是 JS、這裡是 Python)——
#      ⛔ 改任何一邊都要改另一邊,而且定義必須跟回測一字不差:
#        ・don40  = 收盤跌破「前 40 個交易日最低」(⛔ 不含今天)——舊預設,最長抱 40 天
#        ・don    = 收盤跌破「前 20 個交易日最低」(⛔ 不含今天)——更早的預設,最長抱 20 天
#        ・atr2   = 進場後最高**收盤** − 2×ATR14(ATR = 進場那天的近 14 日 TR **簡單平均**)——預設(吊燈 ATR 2 倍),最長抱 20 天
#        ・trail8 = 進場後最高收盤 × 0.92
#        ・ma5    = 收盤跌破 5 日均價
#   ③ 停損(min(訊號日最低, 進場 −5%))不隨規則變;**最長抱幾天跟著規則走**(`MAX_HOLD_BY_RULE`,
#      唐奇安 40 日 = 40 天、其他 = 20 天)—— 每一條的回測成績都是在它自己那組天數下量的,⛔ 不可混搭。
#   ③b 🐻 V77.6.5 **大盤嚴格空頭不開新倉**(`BEAR_GATE`,預設開):讀 playbook_edge.json 的 `mkt.bear60`
#      (playbook_scan 直接呼叫 App 的 `_bear60Of` 算的 → ⛔ 這裡不另外算一份)。只擋買進,⛔ 不擋賣出。
#   ④ 賣出一樣要過 DRY_RUN / LIVE 的煞車,而且**送出後立刻寫狀態檔**(寧可漏一次,⛔ 不可重複送)。
#   ⑤ ⛔ 只在收盤前那個時窗動作(13:00~13:28)—— 這幾條全部是「**收盤**跌破」才算數。
EXIT_RULE = os.getenv('EXIT_RULE') or 'atr2'    # 🔁 V77.7.6:don40 → atr2(修好日 K 後重跑:4 年 179 → 324 萬、16 年 285 → 494 萬,17 條路徑全贏;空頭不開新倉照舊)
SELL_ENABLE = os.getenv('SELL_ENABLE', '1') == '1'
# ⏳ 最長抱幾天 = 跟著出場規則走(⛔ 跟 App `_MAX_HOLD_BY_RULE` 一字不差,test_beargate 跨檔比對)
MAX_HOLD_BY_RULE = {'don40': 40}
MAX_HOLD_OVERRIDE = int(os.getenv('MAX_HOLD_DAYS') or 0)   # 只有你自己設了才覆蓋(⛔ 那就不是回測那一組了)
BEAR_GATE = (os.getenv('BEAR_GATE') or '1') == '1'


def max_hold(rule):
    return MAX_HOLD_OVERRIDE or MAX_HOLD_BY_RULE.get(rule, 20)


def fetch_klines(sym):
    """日 K(gh-pages 上的 data/{sym}.json)—— 跟 App 讀的是同一份。"""
    url = GH_BASE.rstrip('/') + f'/data/{sym}.json?t={int(time.time())}'
    with urllib.request.urlopen(url, timeout=20) as r:
        j = json.loads(r.read().decode('utf-8'))
    rows = j if isinstance(j, list) else (j.get('data') or j.get('rows') or [])
    return [x for x in rows if x.get('close')]


def _atr_tr14(rows, i):
    """近 14 日 TR 簡單平均(⛔ 回測同款,不是 Wilder)。"""
    s, n = 0.0, 0
    for q in range(max(1, i - 13), i + 1):
        pc = float(rows[q - 1]['close'] or 0)
        if pc <= 0:
            continue
        h, l = float(rows[q]['high'] or 0), float(rows[q]['low'] or 0)
        s += max(h - l, abs(h - pc), abs(l - pc))
        n += 1
    return (s / n) if n else 0.0


def exit_line(rows, rule, entry_date):
    """今天的出場價(⛔ 定義跟 App/回測一字不差)。算不出來回 None。"""
    n = len(rows) - 1
    if n < (45 if rule == 'don40' else 25):
        return None
    ei = None
    for i, r in enumerate(rows):
        if str(r.get('date', '')).replace('/', '-')[:10] >= str(entry_date)[:10]:
            ei = i
            break
    if ei is None or ei >= n:
        ei = max(0, n - 19)                       # 沒有進場日 → 用近 20 日當代理(同 App)
    if rule in ('don', 'don40'):
        N = 40 if rule == 'don40' else 20
        lows = [float(rows[i]['low'] or 0) for i in range(max(0, n - N), n) if rows[i].get('low')]
        return min(lows) if lows else None
    if rule == 'ma5':
        cl = [float(rows[i]['close']) for i in range(n - 4, n + 1)]
        return sum(cl) / 5
    peak = max(float(rows[i]['close']) for i in range(ei, n + 1))
    if rule == 'trail8':
        return peak * 0.92
    atr = _atr_tr14(rows, ei)                     # atr2(預設)
    return (peak - 2 * atr) if atr > 0 else None


def held_trading_days(rows, entry_date):
    for i, r in enumerate(rows):
        if str(r.get('date', '')).replace('/', '-')[:10] == str(entry_date)[:10]:
            return len(rows) - 1 - i
    return None


def shares_for_playbook(price, stop):
    """💰 該買幾股 —— 跟 App 的 `_lotsForPlaybook` 同一條公式(⛔ 別在這裡另立一套)。
    **等權 + 支援零股**:每筆投入 = 帳戶總資金 × POS_PCT%,換算成**股數**。

    🧩 為什麼要支援零股(V73.1.0):只算整張的話,實測 2026-08-07 那份清單
       **159 筆裡有 32 筆(20%)因為「不夠買 1 張」被整個跳過**,而且集中在排名最前面
       (台光電 6949 一張要 100 萬)。台股本來就能買零股 → 用股數算就全部救回來。
    ⚠️ 零股的代價:流動性較差、盤中零股是**每分鐘集合競價**(不是連續成交)。
    回傳 (股數, 風險%)。"""
    if price <= 0:
        return 0, None
    shares = int((ACCOUNT_SIZE * POS_PCT / 100) // price) if ACCOUNT_SIZE > 0 else 1000
    # 硬煞車(⛔ 別拿掉):張數上限換算成股數、單筆金額上限
    shares = min(shares, MAX_LOTS_PER_TRADE * 1000, int(MAX_AMT_PER_TRADE // price))
    shares = max(0, shares)
    per = price - stop
    risk_pct = (shares * per / ACCOUNT_SIZE * 100) if (ACCOUNT_SIZE > 0 and per > 0 and shares > 0) else None
    return shares, risk_pct


def main():
    if not LIVE:
        log("🧪 模擬模式(simulation=True)—— ⛔ 不會有真的成交。要真下單請設 LIVE=1")
    else:
        log("🔴🔴 真實下單模式 —— 這會用你的真錢。5 秒內 Ctrl+C 可中止")
        time.sleep(5)

    # 🚨 V75.0.9:沒設 ACCOUNT_SIZE 的話 POS_PCT 完全不生效(shares_for_playbook 退成固定 1000 股)
    #    → 部位大小會跟 App 顯示的**不一樣**。⛔ 不可靜默 —— 這支會動真錢。
    log(f"🚪 出場規則:{EXIT_RULE} ・最長抱 {max_hold(EXIT_RULE)} 天(要跟 App 設定中心的那一條一致,⛔ 不同的話你看到的出場價不是它執行的)")
    log(f"🐻 大盤嚴格空頭不開新倉:{'開' if BEAR_GATE else '關(BEAR_GATE=0)'}")
    if LEADER:
        log(f"👑 領頭羊短線輪動:開(LEADER=1)・時段 {'開盤 09:00~09:10' if LEADER_WINDOW == 'open' else '尾盤(跟上面那套同一段)'}"
            f"・分給它 {LEADER_ACCOUNT:,} 元(每檔 {LEADER_ACCOUNT / LEADER_RULE['N']:,.0f})・換倉起點 {LEADER_ANCHOR}")
    if ACCOUNT_SIZE <= 0:
        log("⚠️⚠️ 你沒有設 ACCOUNT_SIZE(帳戶總資金)→ POS_PCT 這個設定**完全沒有作用**,"
            "每筆一律買 1,000 股(再被 MAX_LOTS_PER_TRADE / MAX_AMT_PER_TRADE 壓一次)"
            f"→ 部位大小跟 App 算的**不一樣**。要一致請設 ACCOUNT_SIZE=<你的總資金>(App 用的是 POS_PCT={POS_PCT:g}%)")
    else:
        log(f"💰 帳戶總資金 {ACCOUNT_SIZE:,} 元 ・每筆投入 {POS_PCT:g}%"
            f"(上限 {MAX_LOTS_PER_TRADE} 張 / {MAX_AMT_PER_TRADE:,} 元)")

    try:
        import shioaji as sj
    except ImportError:
        log("❌ 沒有 shioaji 套件:pip install 'shioaji<1.7'")
        return 1

    api_key = os.getenv('SHIOAJI_API_KEY')
    secret = os.getenv('SHIOAJI_SECRET_KEY')
    if not api_key or not secret:
        log("❌ 缺 SHIOAJI_API_KEY / SHIOAJI_SECRET_KEY")
        return 1

    api = sj.Shioaji(simulation=not LIVE)
    api.login(api_key=api_key, secret_key=secret)
    log("✅ 已登入 Shioaji" + ("(模擬)" if not LIVE else "(真實)"))

    if LIVE:
        # 🔐 憑證只在真實模式需要;⛔ 路徑與密碼一律走環境變數,不寫進檔案
        ca_path, ca_pw, pid = os.getenv('SJ_CA_PATH'), os.getenv('SJ_CA_PASSWD'), os.getenv('SJ_PERSON_ID')
        if not (ca_path and ca_pw and pid):
            log("❌ 真實下單需要 SJ_CA_PATH / SJ_CA_PASSWD / SJ_PERSON_ID(電子憑證)")
            return 1
        if not api.activate_ca(ca_path=ca_path, ca_passwd=ca_pw, person_id=pid):
            log("❌ 憑證啟用失敗")
            return 1
        log("🔐 憑證已啟用")

    st = load_state()
    _, _, today = tpe_now()
    if st.get('d') != today:
        # ⚠️ `done`(今天買過誰)每天重置,但 `pos`(還沒賣掉的部位)⛔ 絕不可跟著清掉
        st = {'d': today, 'done': [], 'pos': st.get('pos') or {}, 'lead': st.get('lead') or {}, 'lead_day': st.get('lead_day')}   # ⚠️ 領頭羊的部位也⛔ 不可跟著清
    log(f"📒 今天已下過:{st['done'] or '(無)'}")

    # 👑 開盤時段(LEADER_WINDOW=open):09:00~09:10 做一次,之後照常等尾盤
    if LEADER and LEADER_WINDOW == 'open':
        while True:
            now, mins, day = tpe_now()
            if now.weekday() >= 5 or mins > 9 * 60 + 10:
                if mins > 9 * 60 + 10 and st.get('lead_day') != day:
                    log("👑 ⏰ 已過 09:10 → 今天開盤那一次錯過了(⛔ 不改到尾盤補做:那是另一組回測數字)")
                break
            if mins < 9 * 60:
                time.sleep(min(POLL_SEC, max(10, (9 * 60 - mins) * 60))); continue
            try:
                meta, _ = fetch_picks()
            except Exception:
                meta = {}
            leader_step(api, sj, st, meta, day)
            break

    while True:
        now, mins, day = tpe_now()
        if now.weekday() >= 5:
            log("週末不開盤,結束"); break
        if mins > EOD_TO:
            log(f"⏰ 已過 {EOD_TO // 60}:{EOD_TO % 60:02d},今天結束"); break
        if mins < EOD_FROM:
            log(f"⏳ 還沒到 {EOD_FROM // 60}:{EOD_FROM % 60:02d}(現在 {now.strftime('%H:%M')}),等待…")
            time.sleep(min(POLL_SEC * 5, max(30, (EOD_FROM - mins) * 60)))
            continue

        try:
            meta, picks = fetch_picks()
        except Exception as e:
            log(f"⚠️ 清單抓取失敗({e}),{POLL_SEC}s 後重試"); time.sleep(POLL_SEC); continue

        # ═══ 🚪 先處理出場(⛔ 排在買進之前:錢先回來,才買得起下一檔)═══
        if SELL_ENABLE and st.get('pos'):
            for sym, pos in list(st['pos'].items()):
                try:
                    contract = api.Contracts.Stocks[sym]
                    if contract is None:
                        log(f"⚠️ 出場:找不到合約 {sym}"); continue
                    px = float(getattr(api.snapshots([contract])[0], 'close', 0) or 0)
                    if px <= 0:
                        continue
                    rows = fetch_klines(sym)
                    # ⚠️ 把「現在這個價」當今天的收盤接上歷史 → 才跟回測的「收盤跌破」同一個定義
                    if rows:
                        rows = rows[:-1] + [dict(rows[-1], close=px)]
                    rule = pos.get('k') or EXIT_RULE
                    line = exit_line(rows, rule, pos.get('d')) if rows else None
                    held = held_trading_days(rows, pos.get('d')) if rows else None
                    why = None
                    if px <= float(pos.get('sl') or 0):
                        why = f"停損 {pos['sl']}"
                    elif line is not None and px < line:
                        why = f"跌破{rule} 出場線 {line:.2f}"
                    elif held is not None and held >= int(pos.get('mh') or max_hold(rule)):
                        why = f"抱滿 {held} 個交易日(上限 {int(pos.get('mh') or max_hold(rule))})"
                    if not why:
                        log(f"   🛡️ {sym} {px} 續抱(出場線 {line and round(line, 2)}"
                            f"・停損 {pos.get('sl')}・已抱 {held} 天)")
                        continue
                    sh = int(pos.get('sh') or 0)
                    _l, _o = divmod(sh, 1000)
                    pl = (px - float(pos.get('e') or px)) * sh
                    log(f"🚪 {sym} 出場!{why} ・賣 {sh} 股 ・帳面 {pl:+,.0f} 元")
                    if DRY_RUN:
                        log("   🧪 DRY_RUN:不送單"); continue
                    sent = []
                    if _l > 0:
                        sent.append(api.place_order(contract, api.Order(
                            price=px, quantity=_l, action=sj.constant.Action.Sell,
                            price_type=sj.constant.StockPriceType.LMT,
                            order_type=sj.constant.OrderType.ROD,
                            order_lot=sj.constant.StockOrderLot.Common,
                            account=api.stock_account)))
                    if _o > 0:
                        sent.append(api.place_order(contract, api.Order(
                            price=px, quantity=_o, action=sj.constant.Action.Sell,
                            price_type=sj.constant.StockPriceType.LMT,
                            order_type=sj.constant.OrderType.ROD,
                            order_lot=sj.constant.StockOrderLot.IntradayOdd,
                            account=api.stock_account)))
                    log(f"   ✅ 賣單已送出 {len(sent)} 筆:{sent}")
                    # ⚠️ 送出後立刻移除(寧可漏一次,⛔ 不可重複送賣單)
                    st['pos'].pop(sym, None); save_state(st)
                except Exception as e:
                    log(f"   ❌ {sym} 出場處理失敗:{e}")

        # 👑 領頭羊(尾盤時段):一天一次,⛔ 不受上面那套的空頭 continue 影響(它自己只擋買)
        if LEADER and LEADER_WINDOW != 'open':
            leader_step(api, sj, st, meta, day)

        # 🐻 V77.6.5 大盤嚴格空頭 → 今天不開新倉(⛔ 賣出已經在上面處理完,這裡只擋買)
        _mkt = (meta or {}).get('mkt') or {}
        if BEAR_GATE and _mkt.get('bear60') is True:
            if not st.get('bear_logged'):
                log(f"🐻 大盤嚴格空頭({_mkt.get('d')} 收盤 {_mkt.get('c')} < 60 日線 {_mkt.get('ma60')},20 日線 {_mkt.get('ma20')} 也在下面)"
                    " → 策略規定今天不開新倉(賣出照常)")
                st['bear_logged'] = 1
            time.sleep(POLL_SEC)
            continue
        if BEAR_GATE and 'bear60' not in _mkt and not st.get('mkt_warned'):
            log("⚠️ 作戰清單裡沒有大盤空頭判斷(清單是舊版)→ 今天照常買;下一輪採礦後就會有")
            st['mkt_warned'] = 1
        for p in picks[:MAX_PICKS]:
            sym, trig, stop = str(p.get('s')), p.get('trig'), p.get('stop')
            if sym in st['done']:
                continue
            if trig is None:
                # ⚠️ 這一招不是靠價位觸發 → 本機沒有 App 那套偵測器可以重算
                #    ⛔ 寧可不做,也不要用「差不多的條件」代替(那是另一個沒驗證過的策略)
                log(f"⏭️ {sym} 沒有固定觸發價(這招不是靠價位)→ 本機跳過,請看 App 提醒")
                continue
            try:
                contract = api.Contracts.Stocks[sym]
                if contract is None:
                    log(f"⚠️ 找不到合約 {sym}"); continue
                snap = api.snapshots([contract])[0]
                px = float(getattr(snap, 'close', 0) or 0)
            except Exception as e:
                log(f"⚠️ {sym} 報價失敗({e})"); continue
            if px <= 0:
                continue
            if px < float(trig):
                log(f"   {sym} {px} < 觸發 {trig} → 還沒到")
                continue

            shares, risk_pct = shares_for_playbook(px, float(stop))
            if shares <= 0:
                log(f"⏭️ {sym} 算出來 0 股(本金太小或超過單筆金額上限)→ 跳過")
                continue
            _lots, _odd = divmod(shares, 1000)
            _how = (f"{_lots} 張 + {_odd} 股" if _lots and _odd else
                    f"{_lots} 張" if _lots else f"{_odd} 股(零股)")
            _rk = f" ・停損時虧本金 {risk_pct:.1f}%" if risk_pct is not None else ""
            log(f"🚨 {sym} 觸發!現價 {px} ≥ {trig} ・買 {_how}"
                f"(約 {int(shares * px):,} 元){_rk} ・停損 {stop}")
            if risk_pct is not None and risk_pct > 2:
                log(f"   ⚠️ 這檔停損很寬,一次會虧本金 {risk_pct:.1f}% —— 超過 2%,考慮手動減量")
            if DRY_RUN:
                log(f"   🧪 DRY_RUN:不送單"); st['done'].append(sym); save_state(st); continue
            try:
                # 🧩 零股與整張是**不同的委託類別**,⛔ 不可混:
                #    整張 → quantity 用「張」+ StockOrderLot.Common
                #    零股 → quantity 用「股」+ StockOrderLot.IntradayOdd(盤中零股)
                #    ⚠️ 有零股尾數時拆兩筆送(整張一筆 + 零股一筆)。
                sent = []
                if _lots > 0:
                    o_c = api.Order(price=px, quantity=_lots,
                                    action=sj.constant.Action.Buy,
                                    price_type=sj.constant.StockPriceType.LMT,
                                    order_type=sj.constant.OrderType.ROD,
                                    order_lot=sj.constant.StockOrderLot.Common,
                                    account=api.stock_account)
                    sent.append(api.place_order(contract, o_c))
                if _odd > 0:
                    o_o = api.Order(price=px, quantity=_odd,
                                    action=sj.constant.Action.Buy,
                                    price_type=sj.constant.StockPriceType.LMT,
                                    order_type=sj.constant.OrderType.ROD,
                                    order_lot=sj.constant.StockOrderLot.IntradayOdd,
                                    account=api.stock_account)
                    sent.append(api.place_order(contract, o_o))
                log(f"   ✅ 已送出 {len(sent)} 筆:{sent}")
                # ⚠️ 先記再說 —— 寧可漏一次,也⛔ 不可重複下單
                st['done'].append(sym)
                # 🚪 記下部位,出場那段才知道「這是我買的」(⛔ 只賣自己買的,不碰手動庫存)
                st.setdefault('pos', {})[sym] = {'e': px, 'sl': float(stop), 'd': day,
                                                 'sh': shares, 'k': EXIT_RULE, 'mh': max_hold(EXIT_RULE)}
                save_state(st)
            except Exception as e:
                log(f"   ❌ 下單失敗:{e}")

        time.sleep(POLL_SEC)

    try:
        api.logout()
    except Exception:
        pass
    log("👋 結束。⭐ 記得回 App 的「📌 追蹤中」把實際成交價填進去 —— "
        "沒有那個數字,永遠不知道滑價吃掉多少。")
    return 0


# ⚠️ 進入點一律放檔案最後面(陷阱 #9:放中段會讓後面定義的名字還不存在)
if __name__ == '__main__':
    sys.exit(main())
