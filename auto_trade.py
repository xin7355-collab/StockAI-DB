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
#   ② 出場規則跟 App 設定的那一條一致(`EXIT_RULE`,預設 atr2)。
#      ⚠️ 這是**同一條公式的第二份實作**(App 是 JS、這裡是 Python)——
#      ⛔ 改任何一邊都要改另一邊,而且定義必須跟回測一字不差:
#        ・don    = 收盤跌破「前 20 個交易日最低」(⛔ 不含今天)
#        ・atr2   = 進場後最高**收盤** − 2×ATR14(ATR = 進場那天的近 14 日 TR **簡單平均**)
#        ・trail8 = 進場後最高收盤 × 0.92
#        ・ma5    = 收盤跌破 5 日均價
#   ③ 停損(進場 −5% 與前低較近者)與**最長 20 個交易日**不隨規則變 —— 回測沒動過那兩條。
#   ④ 賣出一樣要過 DRY_RUN / LIVE 的煞車,而且**送出後立刻寫狀態檔**(寧可漏一次,⛔ 不可重複送)。
#   ⑤ ⛔ 只在收盤前那個時窗動作(13:00~13:28)—— 這幾條全部是「**收盤**跌破」才算數。
EXIT_RULE = os.getenv('EXIT_RULE', 'atr2')
SELL_ENABLE = os.getenv('SELL_ENABLE', '1') == '1'
MAX_HOLD_DAYS = int(os.getenv('MAX_HOLD_DAYS', '20'))


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
    if n < 25:
        return None
    ei = None
    for i, r in enumerate(rows):
        if str(r.get('date', '')).replace('/', '-')[:10] >= str(entry_date)[:10]:
            ei = i
            break
    if ei is None or ei >= n:
        ei = max(0, n - 19)                       # 沒有進場日 → 用近 20 日當代理(同 App)
    if rule == 'don':
        lows = [float(rows[i]['low'] or 0) for i in range(max(0, n - 20), n) if rows[i].get('low')]
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
        st = {'d': today, 'done': [], 'pos': st.get('pos') or {}}
    log(f"📒 今天已下過:{st['done'] or '(無)'}")

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
                    elif held is not None and held >= MAX_HOLD_DAYS:
                        why = f"抱滿 {held} 個交易日(上限 {MAX_HOLD_DAYS})"
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
                                                 'sh': shares, 'k': EXIT_RULE}
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
