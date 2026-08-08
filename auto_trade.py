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
`scripts/portfolio_backtest.mjs` 實測(600 檔・13 個月・本金 100 萬):
    訊號日**尾盤**買        +1,361,088 元(vs 0050 多賺 528,588・回撤 −9.4%)
    隔天**開盤**買            +818,734 元(比 0050 還少賺 13,766・回撤 −19.1%)
    隔天開盤・跳空>1% 不追    −147,644 元(倒賠・回撤 −36.4%)
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
MAX_PICKS = int(os.getenv('MAX_PICKS', '3'))              # 一天最多買幾檔
MAX_LOTS_PER_TRADE = int(os.getenv('MAX_LOTS_PER_TRADE', '1'))   # 單筆張數上限(硬煞車)
MAX_AMT_PER_TRADE = int(os.getenv('MAX_AMT_PER_TRADE', '100000'))  # 單筆金額上限(元)
ACCOUNT_SIZE = int(os.getenv('ACCOUNT_SIZE', '0'))        # 帳戶總資金(算張數用;0 = 只買 1 張)
RISK_PCT = float(os.getenv('RISK_PCT', '1'))              # 單筆最多虧帳戶幾 %
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
    picks = j.get('picks') or []
    log(f"📋 明日作戰清單:{j.get('picks_total')} 筆 / {j.get('picks_syms')} 檔"
        f"(資料日 {j.get('data_date')});本機取前 {MAX_PICKS} 檔")
    return j, picks


def lots_for_risk(price, stop):
    """💰 該買幾張 —— 跟 App 的 `_lotsForRisk` 同一條公式(⛔ 別在這裡另立一套)。
    風險法:單筆最多虧「帳戶 × RISK_PCT%」;再套單筆張數/金額硬上限。"""
    per = price - stop
    if per <= 0 or price <= 0:
        return 0
    if ACCOUNT_SIZE > 0:
        lots = int((ACCOUNT_SIZE * RISK_PCT / 100) // (per * 1000))
    else:
        lots = 1
    lots = min(lots, MAX_LOTS_PER_TRADE, int(MAX_AMT_PER_TRADE // (price * 1000)) or 0)
    return max(0, lots)


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
        st = {'d': today, 'done': []}
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

            lots = lots_for_risk(px, float(stop))
            if lots <= 0:
                log(f"⏭️ {sym} 算出來 0 張(停損距離太寬或超過金額上限)→ 跳過")
                continue

            log(f"🚨 {sym} 觸發!現價 {px} ≥ {trig} ・買 {lots} 張 ・停損 {stop}")
            if DRY_RUN:
                log(f"   🧪 DRY_RUN:不送單"); st['done'].append(sym); save_state(st); continue
            try:
                order = api.Order(
                    price=px, quantity=lots,
                    action=sj.constant.Action.Buy,
                    price_type=sj.constant.StockPriceType.LMT,
                    order_type=sj.constant.OrderType.ROD,
                    account=api.stock_account,
                )
                trade = api.place_order(contract, order)
                log(f"   ✅ 已送出:{trade}")
                # ⚠️ 先記再說 —— 寧可漏一次,也⛔ 不可重複下單
                st['done'].append(sym); save_state(st)
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
