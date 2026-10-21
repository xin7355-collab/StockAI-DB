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
    LEADER=1 LEADER_ACCOUNT=1000000 python3 auto_trade.py           # ⏱️ V78.4.4 預設 split:看開盤情況分時段(見下)
    LEADER=1 LEADER_WINDOW=open LEADER_ACCOUNT=1000000 python3 ...  # 換回舊的:全部 09:01~09:10 開盤買賣(V78.2.4~V78.4.3)
    LEADER=1 LEADER_WINDOW=eod LEADER_ACCOUNT=1000000 python3 ...   # 更舊的:全部尾盤
⏱️ split(V78.4.4 預設,leader_intraday_probe 5 分 K 回測;🧭 V79.2.4 引擎修尺 + 5 分 K 對到 97% 重跑:17 條 657→945% 17/17、902→1,271% 16/17,規則不變;修尺前寫的是 611→783% 15/17、953→1,091% 14/17):
    要賣的 → 09:01~09:10 開盤就賣;只有「開盤比昨收跌 ≥3%」的等到 09:30~10:00 再賣(過 10:00 還沒賣成 → 尾盤補賣)
    要買的 → 只有「開盤比昨收跌 ≥3%」的開盤就買;其他等 13:25 再買(13:25 已接近漲停 → 買不到不追)
⚠️ 實測(17 條起點中位,V79.2.4 引擎修尺後重算、規則沒變):隔天開盤買 AI 時代 +902% / 16 年 +6,687%;尾盤買 +968% / +3,749%(0050 含息 +386% / +1,124%;修尺前寫的是 953 / 6,783、817 / 3,342)。
   (舊規則不看位置:+760% / +3,176%;尾盤 +670% / +2,219%)
⚠️ 中途最多賠 49~57%、16 年只有 10 年贏 0050;沒用到的錢程式**不會**自動買 0050(回測有停 0050,自己手動放)。
⚠️ 它只賣「這套自己買、記在狀態檔 lead 那一格」的部位 —— ⛔ 不碰你手動買的、⛔ 也不碰上面那套買的。

═══════════════════════════════════════════════════════════════════════════
🔥🅿️ V79.4.9 三件預設一起換(使用者 10/21 選的;App 設定中心有同樣的三個開關)
═══════════════════════════════════════════════════════════════════════════
    HOT_RULE=mean(預設)  每一檔每一招都算、照這一招平均每次賺多少排(≥8 次)/ HOT_RULE=lb = 舊的保守排法
    BEAR_GATE=0(預設)    大盤嚴格空頭也照常買 🔥 / BEAR_GATE=1 = 舊的:空頭不買(👑 另外用 LEADER_BEAR_GATE,預設照擋)
    PARK=1(預設)         沒用到的錢停 0050:每天 13:27 收盤競價做一次(要設 ACCOUNT_SIZE;沒設 → 不動)
        目標 0050 = ACCOUNT_SIZE ×(1 − PARK_RESERVE_PCT%)− 自己買的 🔥 持股市值;差距 < 帳戶 2% 不動
        一天最多買 PARK_MAX_AMT_PER_DAY(預設 30 萬 → 100 萬約 3 天買滿);同一天只買或只賣(⛔ 不當沖 0050)
        今天有買 🔥 → 現金不夠的部分一定賣 0050 補交割款;買 0050 前會查交割戶現金(真實模式查不到 → 那天不買)
        ⛔ 只動自己買的 0050(狀態檔 park.sh),⛔ 不碰你手動買的、⛔ 不碰 👑 那筆錢
    🐛 順手修兩個真錢 bug:已經持有的 🔥 再觸發 ⛔ 不再買(以前會重買而且蓋掉原本的持倉紀錄)・每天重置狀態只清當天的鍵(以前會清掉新加的欄位)
"""
import json
import math
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone, timedelta
from lib_hotrule import hot_rule, rule_rows, rule_key   # 🔥 V79.4.9 每檔挑哪一招的規則(= scripts/lib_hotrule.mjs)

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
# 🔥 V79.4.9 每檔挑哪一招(使用者 10/21 選「換,次數維持 8 次」):預設 mean = 照這一招的平均排・每一招都算;
#   HOT_RULE=lb = 換回 V72.9.2~V79.4.8 的保守下界排法(一檔最多 2 招)。⛔ 規則常數只在 lib_hotrule.py(= scripts/lib_hotrule.mjs,test_hotrule 跨檔比對)
HOT_RULE = hot_rule(os.getenv('HOT_RULE'))
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
# 🅿️ V79.4.9 沒用到的錢停 0050(使用者:「改預設,自動下單也幫我買」+「全部停 0050,分 3 天買滿」)——
#   回測(PARK=idle)就是這樣跑的:沒買股票的錢每天收盤停 0050,要買股票時先賣需要的那部分。App `_parkPlan` 同一個算法(test_auto_park 跨檔比對)。
#   ⛔ 只動「它自己買的」0050(狀態檔 park.sh),⛔ 不碰你手動買的;⛔ 不碰 👑(LEADER_ACCOUNT 那筆錢)。
#   沒設 ACCOUNT_SIZE → 整段不做(⛔ 不猜你有多少錢)。
PARK = (os.getenv('PARK') or '1') == '1'
PARK_SYM = '0050'
PARK_RESERVE_PCT = float(os.getenv('PARK_RESERVE_PCT') or 0)          # 留幾 % 現金不停(預設 0 = 全部停,同回測)
PARK_MAX_AMT_PER_DAY = int(os.getenv('PARK_MAX_AMT_PER_DAY') or 300000)   # 一天最多買多少 0050(100 萬約 3 天買滿,之後每天只補差額)
PARK_MIN_TRADE_PCT = float(os.getenv('PARK_MIN_TRADE_PCT') or 2)      # 差距 < 帳戶 2% 不動(⛔ 不為了一點點來回買賣;同 App)
PARK_AT = int(os.getenv('PARK_AT_H') or 13) * 60 + int(os.getenv('PARK_AT_M') or 27)   # 一天一次:收盤競價時段(13:25~13:30)內
PARK_STALE_X = 1.1                                                     # 手上的股票 + 0050 > 帳戶總資金 ×1.1 = 帳戶總資金過期 → 不動
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


# 📒 每天第一次開要清掉的鍵(⛔ 只有這幾個;部位 pos / lead / lead2 / park、lead_day、lead_defer… 一律保留)
DAILY_KEYS = ('d', 'done', 'bear_logged', 'mkt_warned', 'hot_buy_amt', 'lead_buy_amt', 'park_day')


def reset_day(st, today):
    """🐛 V79.4.9 修:以前是「列出要留的鍵、重建整個 dict」→ 之後新加的鍵(例:park 停 0050 的股數)會被當天清掉 =
    忘了自己買過的 0050(之後就不會賣它,也會再買一次)。改成**只清當天的那幾個鍵**,其餘一個都不動。"""
    if st.get('d') == today:
        return st
    out = {k: v for k, v in (st or {}).items() if k not in DAILY_KEYS}
    out['d'] = today
    out['done'] = []
    for k in ('pos', 'lead', 'lead2', 'lead_defer'):
        out.setdefault(k, {})
    return out


# ═══════ 👑 V77.8.9 領頭羊短線輪動 ═══════
LEADER = os.getenv('LEADER') == '1'
LEADER_ACCOUNT = int(os.getenv('LEADER_ACCOUNT') or 0)       # 分給這一套的錢(每檔 = 這筆 ÷ N);0 = 不買(⛔ 不猜)
LEADER_WINDOW = (os.getenv('LEADER_WINDOW') or 'split').lower()  # split(V78.4.4 預設,看開盤情況分時段)| open(全部開盤,V78.2.4~V78.4.3)| eod(全部尾盤)
LEADER_GAPDN = -0.03                                          # ⏱️ split:開盤比昨收跌到這裡(含)以下 → 賣的延到 09:30~10:00、買的開盤就買
LEADER_DEFER_SELL_FROM, LEADER_DEFER_SELL_TO = 9 * 60 + 30, 10 * 60
LEADER_DEFER_BUY_FROM = 13 * 60 + 25
LEADER_OPEN_FROM, LEADER_OPEN_TO = 9 * 60 + 1, 9 * 60 + 10   # ⛔ 09:00 那一分鐘不下單:開盤撮合可能還沒出來,快照會是昨收
# ⛔ 規則 / 錨點 / 名單 / 時鐘 V77.9.3 起搬到 lib_leader.py(成績單的採礦端也要用,⛔ 不複製第二份)。
#    App `_LEADER_EDGE.rule` / `.anchor` 跟 lib_leader 一字不差(test_leaderdeck.mjs 跨檔比對)。
import lib_leader as _LL
LEADER_RULE = _LL.LEADER_RULE
LEADER_ANCHOR = os.getenv('LEADER_ANCHOR') or _LL.LEADER_ANCHOR
# 📚 V79.2.5 兩本帳 / V79.2.6 改成選項(預設 1 = 一本帳;LEADER_BOOKS=2 才開):錢平分兩本、換倉日錯開 4 天,
#    甲帳記在 st['lead'](你原本的部位全部算這本,⛔ 不強迫減半)、乙帳記在 st['lead2'];兩本⛔ 不會同一天換倉。
LEADER_BOOKS = int(os.getenv('LEADER_BOOKS') or _LL.LEADER_BOOKS)
LEADER_ANCHOR2 = os.getenv('LEADER_ANCHOR2') or _LL.LEADER_ANCHOR2
# 📍 V78.0.5 買進的一年位置門檻(預設跟 App 同一個 = lib_leader 的 pos);LEADER_POS=0 = 換回舊規則(不看位置)
LEADER_POS = None if (os.getenv('LEADER_POS') or '') == '' else float(os.getenv('LEADER_POS'))
# 🐻 V79.4.9 👑 的大盤嚴格空頭不開新倉 **一律照擋**(👑 的回測全部含這道守門;App `_leadBearOn()` 同一個意思)——
#   ⛔ 不跟 🔥 的 `BEAR_GATE` 走(🔥 V79.4.9 起預設關)。要關掉 👑 這道守門才設 LEADER_BEAR_GATE=0(⛔ 那就不是回測那一組了)
LEADER_BEAR_GATE = (os.getenv('LEADER_BEAR_GATE') or '1') == '1'


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


def _snap_gap(snap):
    """開盤比昨收(參考價 = 現價 − 漲跌)差幾 %;拿不到開盤或參考價 → None(⛔ 不猜,當作「沒有開低」照開盤做)"""
    try:
        o = float(getattr(snap, 'open', 0) or 0)
        c = float(getattr(snap, 'close', 0) or 0)
        ref = c - float(getattr(snap, 'change_price', 0) or 0)
        return o / ref - 1 if o > 0 and ref > 0 else None
    except (TypeError, ValueError, ZeroDivisionError):
        return None


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
    book, day, is_rebal, left = _LL.leader_books_clock(dates, dd, LEADER_BOOKS, [LEADER_ANCHOR] if LEADER_BOOKS == 1 else [LEADER_ANCHOR, LEADER_ANCHOR2])
    held = st.setdefault(book, {})
    bname = '' if LEADER_BOOKS == 1 else ('甲帳' if book == 'lead' else '乙帳')   # 📚 V79.2.6 名字跟 App 同一組
    if not is_rebal:
        others = {k: list(st.get(k) or {}) for k in ('lead', 'lead2')[:LEADER_BOOKS]}
        log(f"👑 {dd} 不是換倉日 → 下一個換倉的是{bname or '這本帳'},還有 {left} 天。手上 {others}")
        st['lead_day'] = today; save_state(st); return
    keep = {r['sym'] for r in L['ranked']}
    SPLIT = LEADER_WINDOW == 'split'
    defer = {'d': today, 'sell': [], 'buy': [], 'book': book}
    log(f"👑 換倉!{bname}名單日 {dd}(第 {day} 天)・池子 {L['n']} 檔・過趨勢 {L['passed']} 檔・前 {R['N']}:"
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
        if SPLIT:
            g = _snap_gap(api.snapshots([contract])[0])
            if g is not None and g <= LEADER_GAPDN:
                defer['sell'].append(sym)
                log(f"   👑 ⏱️ {sym} 掉出前 {R['N'] * R['hyst']} 名,但開盤跌 {g * 100:.1f}% → 等到 09:30~10:00 再賣(回測平均多拿約 1.5%)"); continue
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
    if LEADER_BEAR_GATE and _mkt.get('bear60') is True:
        log("   👑 🐻 大盤嚴格空頭 → 今天不買新的(賣出已處理)")
    elif LEADER_ACCOUNT <= 0:
        log("   👑 ⚠️ 沒設 LEADER_ACCOUNT(分給這套的錢)→ 不買。要買請設 LEADER_ACCOUNT=<金額>")
    else:
        slot = LEADER_ACCOUNT / (R['N'] * LEADER_BOOKS)   # 📚 每本帳一半錢、每檔一份
        for r in L['buy']:
            sym = r['sym']
            if sym in held:
                continue
            if len(held) + len(defer['buy']) >= R['N']:
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
            if SPLIT:
                g = _snap_gap(snap)
                if g is None or g > LEADER_GAPDN:
                    defer['buy'].append({'sym': sym, 'rank': r['rank'], 'chg10': r['chg10'], 'att': r['att']})
                    log(f"   👑 ⏱️ {sym} 第 {r['rank']} 名 → 開盤{'' if g is None else f'{g * 100:+.1f}%'}先不買,13:25 再買(回測平均便宜 0.4~1.0%)"); continue
                log(f"   👑 ⏱️ {sym} 開盤跌 {g * 100:.1f}% → 開盤就買(這種情況等到尾盤反而比較貴)")
            if _buy_one(api, sj, st, held, r, px, slot, today) == 'stop':
                break
    if SPLIT and (defer['sell'] or defer['buy']):
        st['lead_defer'] = defer
        log(f"   👑 ⏱️ 稍後要做:賣 {defer['sell'] or '(無)'}(09:30~10:00)・買 {[x['sym'] for x in defer['buy']] or '(無)'}(13:25)")
    st['lead_day'] = today; save_state(st)


def _buy_one(api, sj, st, held, r, px, slot, today):
    """👑 買一檔(開盤那次與 13:25 那次共用,⛔ 不寫兩份):張數 = 每檔金額 ÷ 價,再被硬煞車壓"""
    sym = r['sym']
    shares = min(int(slot // px), MAX_LOTS_PER_TRADE * 1000, int(MAX_AMT_PER_TRADE // px))
    if shares <= 0:
        log(f"   👑 ⏭️ {sym} 算出 0 股(每檔 {slot:,.0f} 元,被 MAX_LOTS_PER_TRADE / MAX_AMT_PER_TRADE 壓到 0)"); return 'skip'
    if shares < int(slot // px):
        log(f"   👑 ⚠️ {sym} 被硬煞車壓成 {shares} 股(原本 {int(slot // px)} 股)—— 要照回測等權,請調高 MAX_LOTS_PER_TRADE / MAX_AMT_PER_TRADE")
    tag = '(注意股)' if r['att'] == 1 else '(處置股:第二次處置要預收款券,可能被退單)' if r['att'] == 2 else ''
    log(f"   👑 🛒 {sym} 第 {r['rank']} 名(10 日 {r['chg10']:+.1f}%)→ 買 {shares} 股 @ {px}{tag}")
    if DRY_RUN:
        log("      🧪 DRY_RUN:不送單"); return 'dry'
    try:
        log(f"      ✅ 買單 {_send(api, sj, api.Contracts.Stocks[sym], px, shares, True)}")
        held[sym] = {'e': px, 'd': today, 'sh': shares}
        st['lead_buy_amt'] = float(st.get('lead_buy_amt') or 0) + shares * px   # 🅿️ 今天花掉的現金(買 0050 前要扣)
        save_state(st)   # ⚠️ 先記再說(⛔ 不可重複下單)
        return 'ok'
    except Exception as e:
        log(f"      ❌ 下單失敗:{e}")
        return 'fail'


def leader_defer_step(api, sj, st, today, phase):
    """⏱️ split 的第二段:phase='sell'(09:30~10:00 / 尾盤補賣)賣掉開盤跌 ≥3% 延後的;phase='buy'(13:25)買進延後的。
    ⛔ 只動 st['lead'];賣的跨日也要賣(⛔ 不可留著不賣),買的只買當天那一份(隔天就是舊名單)。"""
    df = st.get('lead_defer') or {}
    held = st.setdefault(df.get('book') or 'lead', {})   # 📚 延後的是哪一本帳的(舊格式沒有 book = 第 1 本)
    if phase == 'sell':
        for sym in list(df.get('sell') or []):
            pos = held.get(sym)
            if not pos:
                df['sell'].remove(sym); continue
            try:
                contract = api.Contracts.Stocks[sym]
                px = float(getattr(api.snapshots([contract])[0], 'close', 0) or 0)
            except Exception as e:
                log(f"   👑 ❌ {sym} 報價失敗:{e}"); continue
            if px <= 0:
                continue
            sh = int(pos.get('sh') or 0)
            log(f"   👑 🚪 {sym}(開盤跌 ≥3% 延後的那筆)→ 賣 {sh} 股 @ {px}")
            if DRY_RUN:
                log("      🧪 DRY_RUN:不送單"); df['sell'].remove(sym); continue
            try:
                log(f"      ✅ 賣單 {_send(api, sj, contract, px, sh, False)}")
                held.pop(sym, None); df['sell'].remove(sym); save_state(st)
            except Exception as e:
                log(f"      ❌ 賣出失敗:{e}")
    elif phase == 'buy':
        if df.get('d') != today:
            if df.get('buy'):
                log(f"   👑 ⏭️ 延後要買的是 {df.get('d')} 那一份(不是今天)→ ⛔ 不用舊名單下單")
            df['buy'] = []
        R = LEADER_RULE
        slot = LEADER_ACCOUNT / (R['N'] * LEADER_BOOKS) if LEADER_ACCOUNT > 0 else 0
        for r in list(df.get('buy') or []):
            sym = r['sym']
            df['buy'].remove(r)
            if sym in held or len(held) >= R['N'] or slot <= 0:
                continue
            try:
                snap = api.snapshots([api.Contracts.Stocks[sym]])[0]
                px = float(getattr(snap, 'close', 0) or 0)
                chg = float(getattr(snap, 'change_rate', 0) or 0)
            except Exception as e:
                log(f"   👑 ❌ {sym} 報價失敗:{e}"); continue
            if px <= 0:
                continue
            if chg >= 9.7:
                log(f"   👑 ⏭️ {sym} 13:25 已接近漲停({chg:.1f}%)→ 買不到,不追"); continue
            _buy_one(api, sj, st, held, r, px, slot, today)
    st['lead_defer'] = df; save_state(st)


def leader_open_window(api, sj, st, now_fn=None, sleep_fn=None, picks_fn=None):
    """👑 開盤時段:09:01 起做一次;抓不到資料(leader_step 沒蓋 lead_day)就在 09:10 前重試。
    ⛔ 過了 09:10 還沒做 → 那天跳過,⛔ 不改到尾盤補做(那是另一組回測數字)。"""
    now_fn, sleep_fn, picks_fn = now_fn or tpe_now, sleep_fn or time.sleep, picks_fn or fetch_picks
    while True:
        now, mins, day = now_fn()
        if st.get('lead_day') == day:
            return True
        if now.weekday() >= 5:
            return False
        if mins > LEADER_OPEN_TO:
            log("👑 ⏰ 已過 09:10 → 今天開盤那一次錯過了(⛔ 不改到尾盤補做:那是另一組回測數字)")
            return False
        if mins < LEADER_OPEN_FROM:
            sleep_fn(min(POLL_SEC, max(10, (LEADER_OPEN_FROM - mins) * 60))); continue
        try:
            meta, _ = picks_fn()
        except Exception:
            meta = {}
        leader_step(api, sj, st, meta, day)
        if st.get('lead_day') == day:
            return True
        log(f"👑 ⚠️ 開盤這一次沒做成(資料抓不到),{POLL_SEC}s 後重試(到 09:10 為止)")
        sleep_fn(POLL_SEC)


def leader_defer_sell_window(api, sj, st, now_fn=None, sleep_fn=None):
    """⏱️ split:09:30~10:00 把開盤跌 ≥3% 延後的賣掉(沒有延後的就直接回)"""
    now_fn, sleep_fn = now_fn or tpe_now, sleep_fn or time.sleep
    while (st.get('lead_defer') or {}).get('sell'):
        now, mins, day = now_fn()
        if now.weekday() >= 5 or mins > LEADER_DEFER_SELL_TO:
            log("👑 ⏰ 已過 10:00,延後要賣的還沒賣成 → 尾盤那段補賣"); return False
        if mins < LEADER_DEFER_SELL_FROM:
            sleep_fn(min(POLL_SEC, max(10, (LEADER_DEFER_SELL_FROM - mins) * 60))); continue
        leader_defer_step(api, sj, st, day, 'sell')
        if (st.get('lead_defer') or {}).get('sell'):
            sleep_fn(POLL_SEC)
    return True


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
    # 🔥 V79.4.9 先只留這套規則的列(mean → r > 0、lb → o > 0;舊格式名單不篩),再照「🧬 → 這套規則的值」排
    #   ⛔ 跟決策台 `_pbSort` 同一條(少了「自己手上的優先」那層 —— 本機讀不到 App 的自選 / 庫存;test_pbpick_same 跨檔比對)
    raw = rule_rows(j.get('picks') or [], HOT_RULE)
    # 🚨 同一檔可能出現**多次**(不同招;實測 206 筆裡 6949 就出現兩次)。
    #    ⛔ 不先去重的話,picks[:MAX_PICKS] 的名額會被同一檔吃掉 →
    #    「一天最多 2 檔」實際上變成 1 檔(而 2 檔正是實測最好的那個設定)。
    #    ⭐ 排好之後保留**第一筆(最好的那一招)**;同分照採礦端的順序(穩定排序)
    raw = sorted(raw, key=lambda p: (-gene_hq(p), -rule_key(p, HOT_RULE)))
    picks, seen = [], set()
    for p in raw:
        sy = str(p.get('s') or '')
        if not sy or sy in seen:
            continue
        seen.add(sy)
        picks.append(p)
    # 🧬 V79.4.7 🧬 是**必要條件**不是排序加分(V73.2.9:不挑它整套輸給 0050)+ 這一檔自己空頭不買 ——
    #   跟決策台 `_deckBuyOf` 同一條(以前只排前面不擋 → 🧬 不夠 2 檔時會買到非 🧬 的;test_pbpick_same 跨檔比對)
    uniq = len(picks)
    picks = [p for p in picks if gene_hq(p) == 1 and not p.get('bear')]
    log(f"📋 明日作戰清單({'照平均・每一招都算' if HOT_RULE == 'mean' else '舊的保守排法'};名單是 {j.get('rule') or '舊格式'}):"
        f"{len(raw)} 筆 / 去重後 {uniq} 檔 / 🧬 且不是空頭 {len(picks)} 檔"
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
#   ③b 🐻 V77.6.5 **大盤嚴格空頭不開新倉**(`BEAR_GATE`):讀 playbook_edge.json 的 `mkt.bear60`
#      (playbook_scan 直接呼叫 App 的 `_bear60Of` 算的 → ⛔ 這裡不另外算一份)。只擋買進,⛔ 不擋賣出。
#      🐻 V79.4.9 🔥 這一套**預設關**(使用者:「關掉:空頭也照買」;App `_bearGateOn()` 同一個預設)→ 要擋才設 BEAR_GATE=1;
#      👑 那一套另外一個變數 `LEADER_BEAR_GATE`(預設開,⛔ 不跟這個走)。test_beargate 跨檔比對兩個預設。
#   ④ 賣出一樣要過 DRY_RUN / LIVE 的煞車,而且**送出後立刻寫狀態檔**(寧可漏一次,⛔ 不可重複送)。
#   ⑤ ⛔ 只在收盤前那個時窗動作(13:00~13:28)—— 這幾條全部是「**收盤**跌破」才算數。
EXIT_RULE = os.getenv('EXIT_RULE') or 'atr2'    # 🔁 V77.7.6:don40 → atr2(修好日 K 後重跑:4 年 179 → 324 萬、16 年 285 → 494 萬,17 條路徑全贏;空頭不開新倉照舊)
SELL_ENABLE = os.getenv('SELL_ENABLE', '1') == '1'
# ⏳ 最長抱幾天 = 跟著出場規則走(⛔ 跟 App `_MAX_HOLD_BY_RULE` 一字不差,test_beargate 跨檔比對)
MAX_HOLD_BY_RULE = {'don40': 40}
MAX_HOLD_OVERRIDE = int(os.getenv('MAX_HOLD_DAYS') or 0)   # 只有你自己設了才覆蓋(⛔ 那就不是回測那一組了)
BEAR_GATE = (os.getenv('BEAR_GATE') or '0') == '1'      # 🐻 V79.4.9 🔥 預設關(⛔ 跟 App `_bearGateOn()` 同一個預設,test_beargate 釘住)


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


def hot_step(api, sj, st, meta, picks, day):
    """🔥 一輪尾盤買進(V79.4.9 從 main 搬出來,假永豐測得到;⛔ 行為照舊):
    ① 🐻 大盤嚴格空頭(BEAR_GATE=1 才擋,V79.4.9 起預設關)② 名單前 MAX_PICKS 檔 ③ 漲過觸發價才買。
    🐛 V79.4.9 修:**已經持有的不再買**(以前會再買一次,而且把原本那筆持倉紀錄蓋掉 → 原本的停損 / 買進日不見了;
       回測引擎本來就是跳過手上已有的 —— 名單那一格就空著,⛔ 不往下補)。"""
    _mkt = (meta or {}).get('mkt') or {}
    if BEAR_GATE and _mkt.get('bear60') is True:
        if not st.get('bear_logged'):
            log(f"🐻 大盤嚴格空頭({_mkt.get('d')} 收盤 {_mkt.get('c')} < 60 日線 {_mkt.get('ma60')},20 日線 {_mkt.get('ma20')} 也在下面)"
                " → 你設了 BEAR_GATE=1:今天不開新倉(賣出照常)")
            st['bear_logged'] = 1
        return
    if BEAR_GATE and 'bear60' not in _mkt and not st.get('mkt_warned'):
        log("⚠️ 作戰清單裡沒有大盤空頭判斷(清單是舊版)→ 今天照常買;下一輪採礦後就會有")
        st['mkt_warned'] = 1
    for p in picks[:MAX_PICKS]:
        sym, trig, stop = str(p.get('s')), p.get('trig'), p.get('stop')
        if sym in st['done']:
            continue
        if sym in (st.get('pos') or {}):
            log(f"⏭️ {sym} 已經持有(自動下單之前買的)→ 不再買(名單這一格空著,同回測)")
            st['done'].append(sym)   # 記進今天做過的 → 這一行只印一次
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
            st['hot_buy_amt'] = float(st.get('hot_buy_amt') or 0) + shares * px   # 🅿️ 今天要付的錢(收盤前賣 0050 湊交割款)
            save_state(st)
        except Exception as e:
            log(f"   ❌ 下單失敗:{e}")


# ═══════ 🅿️ V79.4.9 沒用到的錢停 0050 ═══════
def park_plan(acc, stock_val, park_val, reserve_pct=0.0, min_pct=2.0):
    """今天該停多少在 0050 —— 跟 App `_parkPlan` 同一個算法(⛔ 改一邊要改另一邊;test_auto_park 跨檔比對):
    目標 = 帳戶總資金 ×(1 − 保留%)− 手上個股市值(⛔ 不含 0050);差距 < 帳戶 min_pct% → 不動。
    回 (target, diff, act):act ∈ 'buy' / 'sell' / 'ok' / 'stale'(股票 + 0050 > 帳戶 ×1.1 = 帳戶總資金過期)/ 'none'(沒設帳戶)"""
    if not acc or acc <= 0:
        return 0.0, 0.0, 'none'
    if stock_val + park_val > acc * PARK_STALE_X:
        return 0.0, 0.0, 'stale'
    target = max(0.0, acc * (1 - reserve_pct / 100.0) - stock_val)
    diff = target - park_val
    if abs(diff) < acc * min_pct / 100.0:
        return target, diff, 'ok'
    return target, diff, ('buy' if diff > 0 else 'sell')


def _etf_tick(px):
    """ETF 跳動單位(⚠️ 跟個股不同):未滿 50 元 0.01、50 元以上 0.05"""
    return 0.01 if px < 50 else 0.05


def _tick_up(px, tick):
    return round(math.ceil(round(px / tick, 6)) * tick, 2)


def _tick_dn(px, tick):
    return round(math.floor(round(px / tick, 6)) * tick, 2)


def _park_limits(px, ref):
    """0050 收盤競價的限價:買 = 現價 +1%(⛔ 不超過漲停)・賣 = 現價 −1%(⛔ 不低於跌停)—— 收盤競價時一定成交,除非鎖死"""
    t = _etf_tick(px)
    buy = _tick_up(px * 1.01, t)
    sell = _tick_dn(px * 0.99, t)
    if ref and ref > 0:
        buy = min(buy, _tick_dn(ref * 1.10, t))
        sell = max(sell, _tick_up(ref * 0.90, t))
    return buy, sell


def _avail_cash(api):
    """可動用的現金 = 交割戶餘額 + 還沒付的交割款(⛔ 還沒收到的不算 = 保守)。查不到回 None(⛔ 不猜)。
    shioaji 1.5.x:`account_balance().acc_balance`;`settlements()` 有兩種格式(t_money / t1_money / t2_money 或 amount)→ 兩種都吃。"""
    try:
        bal = api.account_balance()
        cash = float(getattr(bal, 'acc_balance', None))
        if getattr(bal, 'errmsg', ''):
            return None
    except Exception:
        return None
    try:
        rows = api.settlements(api.stock_account)
        rows = rows if isinstance(rows, (list, tuple)) else [rows]
        for r in rows:
            vals = [getattr(r, k, None) for k in ('t_money', 't1_money', 't2_money')]
            if all(v is None for v in vals):
                vals = [getattr(r, 'amount', None)]
            for v in vals:
                if v is not None and float(v) < 0:
                    cash += float(v)
    except Exception:
        return None
    return cash


def park_step(api, sj, st, day):
    """🅿️ 一天一次:照 `park_plan` 買或賣 0050(⛔ 同一天只做一邊,⛔ 不當沖 0050)。
    ① 今天有買 🔥:先確保交割款夠 —— 現金不夠的部分一定賣 0050 補(查不到現金 → 今天買的全部用賣 0050 支應)
    ② 賣:只賣「自己買的」0050(狀態檔 park.sh;真實模式再跟永豐的庫存比一次取小)
    ③ 買:一天最多 PARK_MAX_AMT_PER_DAY;真實模式一定要查得到現金,買的金額 ⛔ 不超過現金(查不到那天不買)
    回傳 'off' / 'done' / 'none' / 'stale' / 'ok' / 'sell' / 'buy' / 'nocash' / 'err'"""
    if not PARK:
        return 'off'
    if st.get('park_day') == day:
        return 'done'
    pk = st.setdefault('park', {})
    if ACCOUNT_SIZE <= 0:
        log("🅿️ 沒設 ACCOUNT_SIZE(帳戶總資金)→ 不停 0050(⛔ 不猜你有多少錢);要停請設 ACCOUNT_SIZE=<股票 + 0050 + 現金>")
        st['park_day'] = day; save_state(st); return 'none'
    try:
        c0 = api.Contracts.Stocks[PARK_SYM]
        s0 = api.snapshots([c0])[0]
        px = float(getattr(s0, 'close', 0) or 0)
        ref = px - float(getattr(s0, 'change_price', 0) or 0)
    except Exception as e:
        log(f"🅿️ ⚠️ 0050 報價失敗({e})→ 今天不動"); st['park_day'] = day; save_state(st); return 'err'
    if px <= 0:
        log("🅿️ ⚠️ 0050 沒有報價 → 今天不動"); st['park_day'] = day; save_state(st); return 'err'
    # 🔥 持股市值(⛔ 只算自己買的 pos;報價失敗那檔用買進價)
    stock_val = 0.0
    for sym, pos in (st.get('pos') or {}).items():
        sh = int(pos.get('sh') or 0)
        p = 0.0
        try:
            p = float(getattr(api.snapshots([api.Contracts.Stocks[sym]])[0], 'close', 0) or 0)
        except Exception:
            p = 0.0
        stock_val += sh * (p if p > 0 else float(pos.get('e') or 0))
    own = int(pk.get('sh') or 0)
    if LIVE and own > 0:
        try:   # 真實模式:跟永豐的庫存比一次(買單沒成交的那部分 ⛔ 不算),取小
            real = sum(int(getattr(x, 'quantity', 0) or 0) for x in api.list_positions(api.stock_account, unit=sj.constant.Unit.Share)
                       if str(getattr(x, 'code', '')) == PARK_SYM)
            if real < own:
                log(f"🅿️ ⚠️ 狀態檔記自己買了 {own} 股 0050,永豐庫存只有 {real} 股 → 以 {real} 股為準")
                own = real; pk['sh'] = own
        except Exception as e:
            log(f"🅿️ ⚠️ 查不到永豐庫存({e})→ 先照狀態檔的 {own} 股")
    park_val = own * px
    target, diff, act = park_plan(ACCOUNT_SIZE, stock_val, park_val, PARK_RESERVE_PCT, PARK_MIN_TRADE_PCT)
    if act == 'stale':
        log(f"🅿️ ⚠️ 手上股票 {stock_val:,.0f} + 0050 {park_val:,.0f} 比帳戶總資金 {ACCOUNT_SIZE:,} 的 1.1 倍還多 → ACCOUNT_SIZE 可能過期了,今天不動 0050(請改成現在的總資金)")
        st['park_day'] = day; save_state(st); return 'stale'
    buy_px, sell_px = _park_limits(px, ref)
    hot_buy = float(st.get('hot_buy_amt') or 0)
    cash = None if DRY_RUN else _avail_cash(api)
    log(f"🅿️ 帳戶 {ACCOUNT_SIZE:,} − 個股 {stock_val:,.0f} = 該停 0050 {target:,.0f}(現在 {own} 股 ≈ {park_val:,.0f})"
        f"・今天買股票 {hot_buy:,.0f}・現金 {'查不到' if cash is None else f'{cash:,.0f}'}")
    # ① + ② 賣
    sell_sh = math.ceil(-diff / sell_px) if act == 'sell' else 0
    if hot_buy > 0:
        need = hot_buy - (cash if cash is not None else 0.0)
        if need > 0:
            sell_sh = max(sell_sh, math.ceil(need / sell_px))
    sell_sh = min(sell_sh, own)
    if sell_sh > 0:
        log(f"🅿️ 🔻 賣 {sell_sh} 股 0050 @ {sell_px}(約 {sell_sh * sell_px:,.0f} 元;收盤競價)")
        if DRY_RUN:
            log("   🧪 DRY_RUN:不送單"); st['park_day'] = day; return 'sell'
        try:
            log(f"   ✅ 賣單 {_send(api, sj, c0, sell_px, sell_sh, False)}")
            pk['sh'] = own - sell_sh; st['park_day'] = day; save_state(st)   # ⚠️ 送出就記(⛔ 不可重複送)
            return 'sell'
        except Exception as e:
            log(f"   ❌ 賣 0050 失敗:{e}"); st['park_day'] = day; save_state(st); return 'err'
    if act != 'buy':
        log("🅿️ ✅ 差不多了,不用動" if act == 'ok' else "🅿️ 不用動")
        st['park_day'] = day; save_state(st); return 'ok'
    # ③ 買
    amt = min(diff, float(PARK_MAX_AMT_PER_DAY))
    if cash is None and LIVE:
        log("🅿️ ⚠️ 查不到交割戶現金 → 今天⛔ 不買 0050(寧可少停一天,⛔ 不可買到錢不夠交割)")
        st['park_day'] = day; save_state(st); return 'nocash'
    if cash is not None:
        spent = hot_buy + float(st.get('lead_buy_amt') or 0)
        amt = min(amt, cash - spent - ACCOUNT_SIZE * 0.01)   # 留帳戶 1% 當手續費緩衝
    sh = int(max(0.0, amt) // buy_px)
    if sh <= 0:
        log("🅿️ 現金不夠買 0050(或差距太小)→ 今天不買"); st['park_day'] = day; save_state(st); return 'ok'
    left = max(0.0, diff - sh * buy_px)
    log(f"🅿️ 🔺 買 {sh} 股 0050 @ {buy_px}(約 {sh * buy_px:,.0f} 元;收盤競價)"
        + (f" ・還差約 {left:,.0f} 元,之後每天補(一天最多 {PARK_MAX_AMT_PER_DAY:,})" if left >= ACCOUNT_SIZE * PARK_MIN_TRADE_PCT / 100 else ''))
    if DRY_RUN:
        log("   🧪 DRY_RUN:不送單"); st['park_day'] = day; return 'buy'
    try:
        log(f"   ✅ 買單 {_send(api, sj, c0, buy_px, sh, True)}")
        pk['sh'] = own + sh; st['park_day'] = day; save_state(st)
        return 'buy'
    except Exception as e:
        log(f"   ❌ 買 0050 失敗:{e}"); st['park_day'] = day; save_state(st); return 'err'


def main():
    if not LIVE:
        log("🧪 模擬模式(simulation=True)—— ⛔ 不會有真的成交。要真下單請設 LIVE=1")
    else:
        log("🔴🔴 真實下單模式 —— 這會用你的真錢。5 秒內 Ctrl+C 可中止")
        time.sleep(5)

    # 🚨 V75.0.9:沒設 ACCOUNT_SIZE 的話 POS_PCT 完全不生效(shares_for_playbook 退成固定 1000 股)
    #    → 部位大小會跟 App 顯示的**不一樣**。⛔ 不可靜默 —— 這支會動真錢。
    log(f"🚪 出場規則:{EXIT_RULE} ・最長抱 {max_hold(EXIT_RULE)} 天(要跟 App 設定中心的那一條一致,⛔ 不同的話你看到的出場價不是它執行的)")
    log(f"🐻 大盤嚴格空頭不開新倉:🔥 {'開(BEAR_GATE=1)' if BEAR_GATE else '關(預設:空頭也照買;要擋設 BEAR_GATE=1)'}"
        + (f" ・👑 {'開(預設)' if LEADER_BEAR_GATE else '關(LEADER_BEAR_GATE=0)'}" if LEADER else ''))
    if LEADER:
        log(f"👑 領頭羊短線輪動:開(LEADER=1)・時段 {'⏱️ 看開盤情況分時段(預設):賣 = 開盤(開低 ≥3% 等 09:30~10:00)・買 = 13:25(開低 ≥3% 開盤買)' if LEADER_WINDOW == 'split' else '全部開盤 09:01~09:10(舊)' if LEADER_WINDOW == 'open' else '全部尾盤(更舊)'}"
            f"・分給它 {LEADER_ACCOUNT:,} 元(每檔 {LEADER_ACCOUNT / (LEADER_RULE['N'] * LEADER_BOOKS):,.0f})・換倉起點 {LEADER_ANCHOR}"
            + (f"・📚 甲帳・乙帳(乙帳起點 {LEADER_ANCHOR2},錯開 4 天;換回一本帳:LEADER_BOOKS=1)" if LEADER_BOOKS == 2 else "・一本帳(預設;甲帳・乙帳:LEADER_BOOKS=2)"))
    if ACCOUNT_SIZE <= 0:
        log("⚠️⚠️ 你沒有設 ACCOUNT_SIZE(帳戶總資金)→ POS_PCT 這個設定**完全沒有作用**,"
            "每筆一律買 1,000 股(再被 MAX_LOTS_PER_TRADE / MAX_AMT_PER_TRADE 壓一次)"
            f"→ 部位大小跟 App 算的**不一樣**。要一致請設 ACCOUNT_SIZE=<你的總資金>(App 用的是 POS_PCT={POS_PCT:g}%)")
    else:
        log(f"💰 帳戶總資金 {ACCOUNT_SIZE:,} 元 ・每筆投入 {POS_PCT:g}%"
            f"(上限 {MAX_LOTS_PER_TRADE} 張 / {MAX_AMT_PER_TRADE:,} 元)")
    log(f"🔥 每檔挑哪一招:{'照平均・每一招都算(預設)' if HOT_RULE == 'mean' else '舊的保守排法(HOT_RULE=lb)'}")
    if PARK:
        log(f"🅿️ 沒用到的錢停 0050:開(預設)・留現金 {PARK_RESERVE_PCT:g}%・一天最多買 {PARK_MAX_AMT_PER_DAY:,} 元"
            f"・{PARK_AT // 60}:{PARK_AT % 60:02d} 收盤競價做一次(之後今天不再買 🔥)"
            + ("" if ACCOUNT_SIZE > 0 else " ⚠️ 但沒設 ACCOUNT_SIZE → 不會動"))
    else:
        log("🅿️ 沒用到的錢停 0050:關(PARK=0)")

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
    # ⚠️ `done`(今天買過誰)每天重置,但部位(`pos` / `lead` / `lead2` / `park`)與延後要賣的(`lead_defer`)⛔ 絕不可跟著清掉
    st = reset_day(st, today)
    log(f"📒 今天已下過:{st['done'] or '(無)'}")

    # 👑 開盤時段(LEADER_WINDOW=open / split):09:01~09:10 做一次,之後照常等尾盤
    if LEADER and LEADER_WINDOW in ('open', 'split'):
        leader_open_window(api, sj, st)
    # ⏱️ split:開盤跌 ≥3% 延後要賣的 → 09:30~10:00 賣(過了 10:00 還沒賣成 → 尾盤那段補賣)
    if LEADER and LEADER_WINDOW == 'split':
        leader_defer_sell_window(api, sj, st)

    while True:
        now, mins, day = tpe_now()
        if now.weekday() >= 5:
            log("週末不開盤,結束"); break
        if mins > EOD_TO:
            # 🅿️ 上一輪拖太久、錯過 13:27 那一拍 → 收盤競價(13:30)前補做一次(⛔ 不可整天沒停 0050 卻也沒賣 0050 湊交割款)
            if PARK and st.get('park_day') != day and mins < 13 * 60 + 30:
                park_step(api, sj, st, day)
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
        if LEADER and LEADER_WINDOW == 'eod':
            leader_step(api, sj, st, meta, day)
        # ⏱️ split:補賣沒賣成的 + 13:25 買進延後的(買只買今天那一份)
        if LEADER and LEADER_WINDOW == 'split':
            _df = st.get('lead_defer') or {}
            if _df.get('sell'):
                log("👑 ⏱️ 早上延後要賣的還沒賣成 → 尾盤補賣"); leader_defer_step(api, sj, st, day, 'sell')
            if _df.get('buy') and mins >= LEADER_DEFER_BUY_FROM:
                leader_defer_step(api, sj, st, day, 'buy')

        # 🔥 買進(V79.4.9 搬進 hot_step 才測得到;⛔ 行為不變,只多「已經持有就不再買」)
        hot_step(api, sj, st, meta, picks, day)
        # 🅿️ V79.4.9 沒用到的錢停 0050:一天一次、排在所有買進之後(要知道今天花了多少);跑完就收工(⛔ 之後不再買 🔥,免得錢不夠交割)
        if PARK and mins >= PARK_AT:
            park_step(api, sj, st, day)
            log("🅿️ 0050 已處理 → 今天的買進到此為止"); break

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
