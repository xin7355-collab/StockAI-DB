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
PARK_BUF_PCT = 1.0                                                     # 留帳戶 1% 現金當手續費 / 價差緩衝(買 0050、湊交割款都用這一個)
# 🛡️ V79.4.9 真實帳戶先不真的買 0050 —— 永豐 `settlements`(交割款)的正負號官方文件沒寫,看反了會以為錢比較多 → 可能違約交割。
#   使用者 10/22 選「等我看過你的 log 再開」:真實帳戶只**預覽**(印出今天會買幾股 + 永豐回的原始餘額 / 交割款),⛔ 不送 0050 買單;
#   湊交割款的賣出照常(那時手上也還沒有它買的 0050);模擬帳戶照常跑(不動真錢)。
#   Claude 看過 log、對完正負號後出下一版改成 True(⛔ 刻意不做成環境變數:你 git pull 就好,不用自己改設定)。
PARK_LIVE_OK = False
POLL_SEC = int(os.getenv('POLL_SEC', '60'))
# 🔐 V79.4.9 真實 / 模擬帳戶用不同的狀態檔(10/22 檢查代理:同一個檔會互相蓋掉 —— 模擬買的被當成真的去賣、真的部位被模擬那一筆蓋掉)
#   真實帳戶沿用原本的檔名(已經在跑的 ⛔ 不受影響);模擬帳戶改用 .sim 那一個;自己設了 STATE_PATH 就照你設的。
_STATE_LIVE = os.path.expanduser('~/.stockai_auto_trade.json')        # 真實帳戶(= V79.4.8 以前兩個模式共用的那個檔)
_STATE_SIM = os.path.expanduser('~/.stockai_auto_trade.sim.json')     # 模擬帳戶(V79.4.9 起)
STATE_PATH = os.getenv('STATE_PATH') or (_STATE_LIVE if LIVE else _STATE_SIM)

TW = timezone(timedelta(hours=8))


# 📝 V80.0.0 log 也寫一份到檔案(交易安全檢查清單:「每一個決定都要留紀錄」)—— 以前只印在螢幕上,關掉視窗就沒了,
#   出事時查不到那天它看到什麼、為什麼買 / 不買。檔名跟狀態檔放一起(真實 .log / 模擬 .sim.log);AUTO_LOG=0 關掉、AUTO_LOG=路徑 自己指定。
#   ⛔ 寫檔失敗一律吞掉(紀錄壞了 ⛔ 不可以擋到下單 / 賣出);超過 2 MB 換成 .1(只留一份舊的)。⛔ 不寫任何金鑰(test_no_token_leak 照掃)。
_AUTO_LOG_ENV = (os.getenv('AUTO_LOG') or '').strip()
AUTO_LOG = None if _AUTO_LOG_ENV == '0' else (_AUTO_LOG_ENV or (STATE_PATH[:-5] if STATE_PATH.endswith('.json') else STATE_PATH) + '.log')
AUTO_LOG_MAX = 2 * 1024 * 1024
# 📒 V80.1.3 實際成交價自動記下來(19 個專案評估 1-6,借 StockSharp SlippageManager 的概念)—— 以前收工時只提醒你「回 App 手動填」。
#   收工前問永豐今天每一筆委託的成交回報,一行一筆寫進 FILLS_LOG(真實 .fills.jsonl / 模擬 .sim.fills.jsonl):
#   掛單價 / 成交均價 / 收盤價 → 跟回測假設的「收盤價成交」差多少。FILLS_LOG=0 關掉、FILLS_LOG=路徑 自己指定。
#   ⛔ 只記錄:⛔ 不改狀態檔(部位 / 停損一個字都不動)、⛔ 送 / 刪任何單;查不到、寫不進去一律只印一行。
_FILLS_ENV = (os.getenv('FILLS_LOG') or '').strip()
FILLS_LOG = None if _FILLS_ENV == '0' else (_FILLS_ENV or (STATE_PATH[:-5] if STATE_PATH.endswith('.json') else STATE_PATH) + '.fills.jsonl')
FILLS_WAIT_TO = 13 * 60 + 31   # 13:25 以後掛的單 13:30 收盤競價才成交、收盤價也是那時才定 → 平日還沒到 13:31 就等到 13:31 再問(最多 10 分鐘)
_SENT_IDS = set()              # 這一次程式送出去的委託編號(只放記憶體,⛔ 不進狀態檔)→ 成交紀錄標 own


def _log_file(line):
    if not AUTO_LOG:
        return
    try:
        if os.path.exists(AUTO_LOG) and os.path.getsize(AUTO_LOG) > AUTO_LOG_MAX:
            os.replace(AUTO_LOG, AUTO_LOG + '.1')
        with open(AUTO_LOG, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except Exception:
        pass


def log(*a):
    now = datetime.now(TW)
    print(f"[{now.strftime('%H:%M:%S')}]", *a, flush=True)
    try:
        _log_file(f"[{now.strftime('%Y-%m-%d %H:%M:%S')}] " + ' '.join(str(x) for x in a))
    except Exception:
        pass


def tpe_now():
    n = datetime.now(TW)
    return n, n.hour * 60 + n.minute, n.strftime('%Y-%m-%d')


def _read_state_file(path):
    """🩺 10/24 巡邏:讀狀態檔。檔案不在 → {}(第一次跑);讀不出來 → None。
    🚨 舊寫法讀不出來就回 {} = 當成「手上沒有任何股票」→ 該賣的不賣(它只賣自己記得的)、已經有的再買一次。
       → ⛔ 不猜:回 None,main 今天 ⛔ 下單(壞檔一個位元組都不動,留給你看)。
    ⚠️ 0 bytes 也算讀不出來(⛔ 當成第一次跑)—— 舊的寫法在「清空檔案 → 寫進去」中間被關掉,留下的就是 0 bytes。
    ⚠️ 刻意 ⛔ 用 lib_jsonsafe:這支跑在你自己的電腦上,少一個檔就整支起不來;而且「尾巴多一段」也一律不拿來下單。"""
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding='utf-8') as f:
            st = json.load(f)
        if isinstance(st, dict):
            return st
        why = '內容不是一份完整的紀錄'
    except Exception as e:
        why = f'{type(e).__name__}: {str(e)[:80]}'
    log(f"🚨 狀態檔讀不出來:{path}({why})")
    log("   ⛔ 今天不下單 —— 當成空手的話,手上的部位該賣的不會賣、已經有的會再買一次")
    log(f"   👉 用文字編輯器打開它看最後面是不是被截斷;救不回來就把它改名(例如後面加 .bad)再開,"
        "程式會從空手開始(⚠️ 那時手上的部位要自己手動管)")
    return None


def load_state():
    """回狀態 dict;狀態檔讀不出來回 None(main 看到 None ⛔ 下單)。"""
    # 📒 V79.4.9 模擬帳戶改用自己的檔(.sim.json)→ 第一次跑新版時新檔還不存在:接著用以前那個檔的紀錄
    #   (使用者 10/22:「永豐自動買賣我都是拿來參考,看模擬買賣賺不賺錢」→ ⛔ 不可讓以前模擬的部位一夜之間不見、成績斷掉)。
    #   ⛔ 舊檔一個字都不動(之後寫進新檔);自己設了 STATE_PATH 就照你設的。
    if not LIVE and not os.getenv('STATE_PATH') and not os.path.exists(STATE_PATH) and os.path.exists(_STATE_LIVE):
        st = _read_state_file(_STATE_LIVE)
        if st is None:
            return None
        for k, book in (st.pop('legacy', None) or {}).items():   # 真實帳戶第一次跑時搬走的舊部位 = 模擬留下的 → 放回原本那本帳
            for sym, p in (book or {}).items():
                st.setdefault(k, {}).setdefault(sym, p)
        st.pop('mv', None)
        for k in ('pos', 'lead', 'lead2'):   # 真實帳戶自己買的(標 live)⛔ 不搬進模擬帳戶
            for sym in [s for s, p in (st.get(k) or {}).items() if (p or {}).get('m') == 'live']:
                st[k].pop(sym)
        if (st.get('park') or {}).get('m') == 'live':
            st.pop('park')
        n = sum(len(st.get(k) or {}) for k in ('pos', 'lead', 'lead2'))
        log(f"📒 模擬帳戶改用自己的狀態檔({STATE_PATH})→ 這次先接著用以前的紀錄({_STATE_LIVE},{n} 筆部位;⛔ 那個檔不會被改)")
        return st
    return _read_state_file(STATE_PATH)


_DRY_SAVE_LOGGED = False


def save_state(st):
    # 🧪 V79.4.9 DRY_RUN ⛔ 不寫狀態檔(檢查代理 10/22 抓到:預覽跑過之後,同一天真的跑會以為「今天做過了」→ 跳過湊交割款)
    global _DRY_SAVE_LOGGED
    if DRY_RUN:
        if not _DRY_SAVE_LOGGED:
            log("🧪 DRY_RUN:狀態檔⛔ 不寫入(預覽不影響之後真的跑)")
            _DRY_SAVE_LOGGED = True
        return
    # ⚠️ 寫失敗不可讓整支掛掉(但要講出來 —— 沒存成功 = 可能重複下單)
    # 🩺 10/24 巡邏:先寫暫存檔再整個換過去 —— 直接覆寫時程式剛好被關掉(關機 / 斷電 / Ctrl+C)會留下半截的檔,
    #    下次就讀不出來(現在讀不出來會 ⛔ 下單,但能不壞最好)。換名失敗(別的程式開著那個檔)才退回直接寫。
    try:
        tmp = STATE_PATH + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(st, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        try:
            os.replace(tmp, STATE_PATH)
        except OSError as e:
            log(f"⚠️ 狀態檔換名失敗({e})→ 改成直接寫")
            with open(STATE_PATH, 'w', encoding='utf-8') as f:
                json.dump(st, f, ensure_ascii=False)
            try:
                os.remove(tmp)
            except OSError:
                pass
    except Exception as e:
        log(f"🚨 狀態檔寫入失敗({e})—— 重複下單的防護失效,請立刻停掉檢查")


# 📒 每天第一次開要清掉的鍵(⛔ 只有這幾個;部位 pos / lead / lead2 / park、lead_day、lead_defer… 一律保留)
DAILY_KEYS = ('d', 'done', 'bear_logged', 'mkt_warned', 'hot_buy_amt', 'lead_buy_amt', 'park_day', 'hot_after_park_logged')


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


class SendError(Exception):
    """整張 + 零股拆兩筆送,其中一筆出錯:`sent_sh` = 出錯前**已經送出去**的股數(呼叫端 ⛔ 不可把那一段再送一次)"""
    def __init__(self, sent_sh, err):
        super().__init__(f"{err}(出錯前已送出 {sent_sh} 股)")
        self.sent_sh = sent_sh


def _send(api, sj, contract, px, shares, buy):
    """整張 + 零股拆兩筆送(全 App 下單都走這一支)。
    🐛 V79.4.9 任何一筆出錯 → 丟 SendError 並帶著已經送出的股數(10/22 檢查代理:以前整張送出、零股出錯時,
       呼叫端以為整筆失敗,下一輪又把整張送一次 = 重複下單)"""
    lots, odd = divmod(int(shares), 1000)
    act = sj.constant.Action.Buy if buy else sj.constant.Action.Sell
    sent, done_sh = [], 0
    for q, lot, unit in ((lots, sj.constant.StockOrderLot.Common, 1000), (odd, sj.constant.StockOrderLot.IntradayOdd, 1)):
        if q > 0:
            try:
                sent.append(api.place_order(contract, api.Order(
                    price=px, quantity=q, action=act, price_type=sj.constant.StockPriceType.LMT,
                    order_type=sj.constant.OrderType.ROD, order_lot=lot, account=api.stock_account)))
            except Exception as e:
                raise SendError(done_sh, e)
            done_sh += q * unit
            _note_sent(sent[-1])   # 📒 V80.1.3 只記編號(⛔ 絕不丟例外、⛔ 不影響送單)
    return sent


def _note_sent(tr):
    """📒 記下這一次程式送出去的委託編號,收工時拿來標「這筆是程式送的」。⛔ 絕不丟例外。"""
    try:
        oid = str(getattr(getattr(tr, 'order', None), 'id', '') or '')
        if oid:
            _SENT_IDS.add(oid)
    except Exception:
        pass


def _sold_part(book, sym, pos, sh, e):
    """賣單出錯時:已經送出的那幾股從紀錄扣掉(⛔ 下次不再賣那一段),沒送出的留著下次賣;一股都沒送出 → 原封不動(同以前,下次再試)"""
    got = int(getattr(e, 'sent_sh', 0) or 0)
    if got <= 0:
        return 0
    left = int(sh) - got
    if left > 0:
        book[sym] = dict(pos, sh=left)
    else:
        book.pop(sym, None)
    return got


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
        if pos.get('m') and pos.get('m') != _mode():
            log(f"   👑 ⏭️ {sym} 是{'模擬' if pos.get('m') == 'sim' else '真實'}帳戶的紀錄 → 這次⛔ 不賣"); continue
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
            got = _sold_part(held, sym, pos, sh, e)
            if got:
                if sym in held:
                    defer['sell'].append(sym)   # ⏱️ 剩下的今天就賣完(10/22 第三輪檢查代理:以前要等到下次換倉 = 好幾天沒人管)
                save_state(st)
                log(f"      🚨 {sym} 賣單只送出 {got} 股就出錯({e})→ 剩下的今天稍後"
                    + ("(09:30~10:00 或尾盤)" if SPLIT else "(尾盤)")
                    + "再賣,⛔ 已送出的不會重送;⛔ 請不要自己手動賣剩下那段(不然會多賣),到永豐 App 確認就好")
            else:
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
    if defer['sell'] or defer['buy']:   # 買的只有 split 會延後;賣的 split 開盤跌 ≥3% + 任何時段賣單只送出一部分剩下的
        st['lead_defer'] = defer
        log(f"   👑 ⏱️ 稍後要做:賣 {defer['sell'] or '(無)'}({'09:30~10:00' if SPLIT else '尾盤'})・買 {[x['sym'] for x in defer['buy']] or '(無)'}(13:25)")
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
        got = shares
    except Exception as e:
        got = int(getattr(e, 'sent_sh', 0) or 0)
        if got <= 0:
            log(f"      ❌ 下單失敗:{e}")
            return 'fail'
        log(f"      🚨 {sym} 整張送出了、零股那筆出錯({e})→ 只記已送出的 {got} 股(⛔ 不會再送);請到永豐 App 確認")
    held[sym] = {'e': px, 'd': today, 'sh': got, 'm': _mode()}
    st['lead_buy_amt'] = float(st.get('lead_buy_amt') or 0) + got * px   # 🅿️ 今天花掉的現金(買 0050 前要扣)
    save_state(st)   # ⚠️ 先記再說(⛔ 不可重複下單)
    return 'ok'


def leader_defer_step(api, sj, st, today, phase):
    """⏱️ 第二段:phase='sell'(split 09:30~10:00 / 尾盤補賣)賣掉延後要賣的(split 開盤跌 ≥3% 的・任何時段賣單只送出一部分剩下的);
    phase='buy'(split 13:25)買進延後的。
    ⛔ 只動 st['lead'];賣的跨日也要賣(⛔ 不可留著不賣),買的只買當天那一份(隔天就是舊名單)。"""
    df = st.get('lead_defer') or {}
    held = st.setdefault(df.get('book') or 'lead', {})   # 📚 延後的是哪一本帳的(舊格式沒有 book = 第 1 本)
    if phase == 'sell':
        for sym in list(df.get('sell') or []):
            pos = held.get(sym)
            if not pos or (pos.get('m') and pos.get('m') != _mode()):
                df['sell'].remove(sym); continue
            try:
                contract = api.Contracts.Stocks[sym]
                px = float(getattr(api.snapshots([contract])[0], 'close', 0) or 0)
            except Exception as e:
                log(f"   👑 ❌ {sym} 報價失敗:{e}"); continue
            if px <= 0:
                continue
            sh = int(pos.get('sh') or 0)
            log(f"   👑 🚪 {sym}(延後要賣的那筆)→ 賣 {sh} 股 @ {px}")
            if DRY_RUN:
                log("      🧪 DRY_RUN:不送單"); df['sell'].remove(sym); continue
            try:
                log(f"      ✅ 賣單 {_send(api, sj, contract, px, sh, False)}")
                held.pop(sym, None); df['sell'].remove(sym); save_state(st)
            except Exception as e:
                got = _sold_part(held, sym, pos, sh, e)
                if got:
                    if sym not in held:
                        df['sell'].remove(sym)
                    save_state(st)
                    log(f"      🚨 {sym} 賣單只送出 {got} 股就出錯({e})→ 剩下的下一輪再賣(⛔ 已送出的不會重送);請到永豐 App 確認")
                else:
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


def exit_step(api, sj, st):
    """🚪 一輪出場檢查(V79.4.9 從 main 搬出來,假永豐測得到;⛔ 規則不變):只賣狀態檔裡這個模式自己買的部位,
    停損 / 出場線 / 抱滿天數任一條到了就賣;送出後立刻從紀錄移除(⛔ 不可重複送)。"""
    for sym, pos in list(st['pos'].items()):
        if pos.get('m') and pos.get('m') != _mode():
            continue   # 模擬帳戶買的 ⛔ 不在真實帳戶賣(反之亦然);沒標的舊紀錄照舊
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
            pl = (px - float(pos.get('e') or px)) * sh
            log(f"🚪 {sym} 出場!{why} ・賣 {sh} 股 ・帳面 {pl:+,.0f} 元")
            if DRY_RUN:
                log("   🧪 DRY_RUN:不送單"); continue
            try:
                sent = _send(api, sj, contract, px, sh, False)
            except Exception as e:
                # 🐛 V79.4.9 整張送出、零股出錯 → 已送出的那段從紀錄扣掉(⛔ 下一輪不再賣那一段),沒送出的下一輪再賣
                got = _sold_part(st['pos'], sym, pos, sh, e)
                if got:
                    save_state(st)
                    log(f"   🚨 {sym} 賣單只送出 {got} 股就出錯({e})→ 剩下的下一輪再賣(⛔ 已送出的不會重送);請到永豐 App 確認")
                else:
                    log(f"   ❌ {sym} 賣單沒送出:{e}(下一輪再試)")
                continue
            log(f"   ✅ 賣單已送出 {len(sent)} 筆:{sent}")
            # ⚠️ 送出後立刻移除(寧可漏一次,⛔ 不可重複送賣單)
            st['pos'].pop(sym, None); save_state(st)
        except Exception as e:
            log(f"   ❌ {sym} 出場處理失敗:{e}")


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
    if st.get('park_day') == day and (PARK or _park_has_own(st)):
        # 🅿️ 今天的 0050 已經處理過(湊交割款也做完了)→ ⛔ 不再買:再買就沒有人湊交割款(10/22 檢查代理:程式中途重開才會走到這裡)
        if not st.get('hot_after_park_logged'):
            log("🅿️ 今天的 0050 已經處理過 → ⛔ 不再買 🔥(再買就沒有人湊交割款)")
            st['hot_after_park_logged'] = 1
        return
    for p in picks[:MAX_PICKS]:
        sym, trig, stop = str(p.get('s')), p.get('trig'), p.get('stop')
        if sym in st['done']:
            continue
        _held = (st.get('pos') or {}).get(sym)
        if _held and (not _held.get('m') or _held.get('m') == _mode()):
            log(f"⏭️ {sym} 已經持有(自動下單之前買的)→ 不再買(名單這一格空著,同回測)")
            st['done'].append(sym)   # 記進今天做過的 → 這一行只印一次
            continue
        if _held:
            # 狀態檔裡是另一個模式(模擬 / 真實)的紀錄 → ⛔ 不買,免得把那一筆蓋掉(真實 / 模擬 V79.4.9 起本來就分兩個檔,只有舊檔或自己設 STATE_PATH 才會遇到)
            log(f"⏭️ {sym} 狀態檔裡有一筆{'模擬' if _held.get('m') == 'sim' else '真實'}帳戶的紀錄 → 這次⛔ 不買(免得蓋掉那一筆)")
            st['done'].append(sym)
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
        # 🧩 零股與整張是**不同的委託類別**,⛔ 不可混:整張 → 張 + StockOrderLot.Common;零股 → 股 + IntradayOdd(盤中零股)
        #    ⚠️ 有零股尾數時拆兩筆送(`_send`);🐛 V79.4.9 整張送出、零股出錯 → 只記已送出的那段、⛔ 不再送(以前下一輪會把整張再送一次)
        try:
            sent = _send(api, sj, contract, px, shares, True)
            got = shares
            log(f"   ✅ 已送出 {len(sent)} 筆:{sent}")
        except Exception as e:
            got = int(getattr(e, 'sent_sh', 0) or 0)
            if got <= 0:
                log(f"   ❌ 下單失敗:{e}"); continue   # 一股都沒送出 → 下一輪可以再試(同以前)
            log(f"   🚨 {sym} 整張送出了、零股那筆出錯({e})→ 只記已送出的 {got} 股(⛔ 不會再送);請到永豐 App 確認")
        # ⚠️ 先記再說 —— 寧可漏一次,也⛔ 不可重複下單
        st['done'].append(sym)
        # 🚪 記下部位,出場那段才知道「這是我買的」(⛔ 只賣自己買的,不碰手動庫存)
        st.setdefault('pos', {})[sym] = {'e': px, 'sl': float(stop), 'd': day,
                                         'sh': got, 'k': EXIT_RULE, 'mh': max_hold(EXIT_RULE), 'm': _mode()}
        st['hot_buy_amt'] = float(st.get('hot_buy_amt') or 0) + got * px   # 🅿️ 今天要付的錢(收盤前賣 0050 湊交割款)
        save_state(st)


# ═══════ 🅿️ V79.4.9 沒用到的錢停 0050 ═══════
def park_plan(acc, stock_val, park_val, reserve_pct=0.0, min_pct=2.0, today_buy=0.0):
    """今天該停多少在 0050 —— 跟 App `_parkPlan` 同一個算法(⛔ 改一邊要改另一邊;test_auto_park 跨檔比對):
    目標 = 帳戶總資金 ×(1 − 保留%)− 手上個股市值(⛔ 不含 0050);差距 < 帳戶 min_pct% → 不動。
    回 (target, diff, act):act ∈ 'buy' / 'sell' / 'ok' / 'stale'(股票 + 0050 > 帳戶 ×1.1 = 帳戶總資金過期)/ 'none'(沒設帳戶)
    today_buy = 今天自動下單剛買的股票:「過期」判斷 ⛔ 算它(那筆錢今天才要從 0050 換過來,不是帳戶變大了;
    10/22 檢查代理:0050 停滿後買一檔 15% 就被誤判成過期、log 叫人改帳戶總資金)。App 那邊沒有「今天剛買」→ 預設 0。"""
    if not acc or acc <= 0:
        return 0.0, 0.0, 'none'
    if stock_val - today_buy + park_val > acc * PARK_STALE_X:
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


def _mode():
    """這一次是真實帳戶還是模擬帳戶(狀態檔裡的部位要分開算:模擬買的 ⛔ 不可在真實帳戶被當成自己的去賣)"""
    return 'live' if LIVE else 'sim'


def _cash_info(api):
    """可動用的現金 = 交割戶餘額 + 還沒付的交割款(負數當應付;應收的不算 = 保守)+ 永豐回的原始資料(印給 Claude 對正負號)。
    ⚠️ 正負號官方文件沒寫 → 真實帳戶在 `PARK_LIVE_OK` 打開之前只預覽,⛔ 不靠它下 0050 的買單。查不到回 (None, 原因)(⛔ 不猜)。
    shioaji 1.5.x:`account_balance().acc_balance`;`settlements()` 有兩種格式(t_money / t1_money / t2_money 或 date / amount / T)→ 兩種都吃。"""
    raw = []
    try:
        bal = api.account_balance()
        if getattr(bal, 'errmsg', ''):
            return None, f"餘額查詢回錯誤:{getattr(bal, 'errmsg', '')}"
        cash = float(getattr(bal, 'acc_balance', None))
        raw.append(f"餘額 {cash:,.0f}")
    except Exception as e:
        return None, f"查不到餘額({e})"
    try:
        rows = api.settlements(api.stock_account)
        rows = rows if isinstance(rows, (list, tuple)) else [rows]
        for r in rows:
            vals = [(k, getattr(r, k, None)) for k in ('t_money', 't1_money', 't2_money')]
            if all(v is None for _, v in vals):
                vals = [(f"T{getattr(r, 'T', '?')}({getattr(r, 'date', '?')})", getattr(r, 'amount', None))]
            for k, v in vals:
                if v is None:
                    continue
                raw.append(f"{k} {float(v):+,.0f}")
                if float(v) < 0:
                    cash += float(v)
    except Exception as e:
        return None, '・'.join(raw + [f"查不到交割款({e})"])
    return cash, '・'.join(raw)


def _avail_cash(api):
    return _cash_info(api)[0]


def _broker_qty(api, sj, code):
    """永豐庫存裡這一檔有幾股(股數);查不到回 None(⛔ 不猜)"""
    try:
        return sum(int(getattr(x, 'quantity', 0) or 0)
                   for x in api.list_positions(api.stock_account, unit=sj.constant.Unit.Share)
                   if str(getattr(x, 'code', '')) == code)
    except Exception:
        return None


def _legacy_check(st):
    """🔐 V79.4.9 真實帳戶第一次用新版跑:狀態檔裡**沒標模式**的舊部位一律當成以前模擬帳戶留下的 → 搬到 `legacy`,
    ⛔ 不自動賣、⛔ 不擋買,🚨 列出來。(V79.4.8 以前模擬 / 真實共用同一個檔;使用者 10/22:沒用真實帳戶跑過、模擬是拿來參考的)
    ⛔ 不拿永豐庫存去猜是不是真的(10/22 第三輪檢查代理:庫存夠 ≠ 是自動下單買的 —— 你手動買的同一檔也會被當成它的 → 停損時賣掉你的)。
    之後買的都會標模式;做完記 `mv` = 1,之後不再做。"""
    if not LIVE or st.get('mv') == 1:
        return
    moved = []
    for k in ('pos', 'lead', 'lead2'):
        book = st.get(k) or {}
        for sym in [s for s, p in book.items() if not p.get('m')]:
            p = book.pop(sym)
            st.setdefault('legacy', {}).setdefault(k, {})[sym] = p
            moved.append(f"{sym} {int(p.get('sh') or 0)} 股")
    if moved:
        log("🔐 🚨 狀態檔裡有以前留下、沒標「模擬 / 真實」的部位 → 一律當成以前模擬帳戶的紀錄:⛔ 不自動賣、⛔ 不擋買:"
            + '・'.join(moved) + "。如果其實是你在真實帳戶用自動下單買的,請自己照 App 決策台的出場線處理,並把這段 log 傳給 Claude")
    st['mv'] = 1
    save_state(st)


def _lead_reserve(st):
    """👑 要留著的錢 = 分給 👑 的錢 − 👑 持股成本(⛔ 用成本不用市值:漲上去那段不是現金)。沒開 👑 → 0。
    ⛔ 停 0050 / 湊交割款都不可以用到這筆(檢查代理 10/22 抓到:以前上限只看總現金)"""
    if not LEADER or LEADER_ACCOUNT <= 0:
        return 0.0
    cost = sum(int(p.get('sh') or 0) * float(p.get('e') or 0)
               for k in ('lead', 'lead2') for p in (st.get(k) or {}).values())
    return max(0.0, LEADER_ACCOUNT - cost)


def _park_rec(st):
    """這個模式(真實 / 模擬)自己買的 0050 紀錄。另一個模式留下的 ⛔ 不算自己的(不賣、不當成已經停了),直接換成新的一筆。"""
    pk = st.get('park') or {}
    if pk.get('m') and pk.get('m') != _mode():
        log(f"🅿️ ⚠️ 狀態檔裡那 {int(pk.get('sh') or 0)} 股 0050 是{'模擬' if pk.get('m') == 'sim' else '真實'}帳戶買的"
            f" → 這次({'真實' if LIVE else '模擬'})⛔ 不算自己的(不賣、不當成已經停了)")
        pk = {}
    st['park'] = pk
    return pk


def _park_has_own(st):
    """這個模式手上還有沒有自己買的 0050(有的話就算 PARK=0 也要能湊交割款)"""
    pk = st.get('park') or {}
    if pk.get('m') and pk.get('m') != _mode():
        return False
    return int(pk.get('sh') or 0) > 0 or bool(pk.get('pend'))


def _park_quote(api, tries=3, sleep_fn=None):
    """0050 現價與參考價(昨收);失敗重試 tries 次,都失敗回 (0, 0)(⛔ 不猜價)"""
    sl = sleep_fn or time.sleep
    for i in range(tries):
        try:
            s0 = api.snapshots([api.Contracts.Stocks[PARK_SYM]])[0]
            px = float(getattr(s0, 'close', 0) or 0)
            if px > 0:
                return px, px - float(getattr(s0, 'change_price', 0) or 0)
        except Exception as e:
            log(f"🅿️ ⚠️ 0050 報價失敗({e})")
        if i + 1 < tries:
            sl(2)
    return 0.0, 0.0


def _park_settle(api, sj, pk, day):
    """昨天以前送出的 0050 買單(真實帳戶)→ 用永豐庫存差算「真的成交幾股」才算自己的
    (⛔ 送出 ≠ 成交:颱風假 / 被退單也會「送出成功」;檢查代理 10/22 抓到以前送出就記 → 之後可能賣到你手動買的)。
    回 (own, pend_sh):own = 確定是自己的股數(只有這些可以賣);pend_sh = 還沒對到帳的(⛔ 不賣,但算進「已經停了多少」免得一直加買)。"""
    own = int(pk.get('sh') or 0)
    pend = pk.get('pend')
    if not pend:
        return own, 0
    psh = int(pend.get('sh') or 0)
    if pend.get('d') == day:
        return own, psh
    real = _broker_qty(api, sj, PARK_SYM)
    if real is None or pend.get('b') is None:
        log(f"🅿️ ⚠️ 查不到永豐 0050 庫存 → {pend.get('d')} 那筆 0050 買單({psh} 股)還沒對帳,先⛔ 不算自己的、⛔ 不賣")
        return own, psh
    filled = max(0, min(psh, real - int(pend['b'])))
    log(f"🅿️ 📒 {pend.get('d')} 那筆 0050 買單:送出 {psh} 股・永豐 0050 庫存 {int(pend['b'])} → {real} 股 → 算真的成交 {filled} 股")
    pk['sh'] = own + filled
    pk.pop('pend', None)
    return own + filled, 0


def _past_close():
    """現在是不是已經過了 13:30 收盤(送單前再看一次鐘 —— 主迴圈的分鐘數是那一輪開頭讀的)"""
    return tpe_now()[1] >= 13 * 60 + 30


def _today_buy(st):
    """今天自動下單花掉的錢(🔥 + 👑)—— 湊交割款的提醒一律看這個(⛔ 只看 🔥 會漏掉只有 👑 買的日子)"""
    return float(st.get('hot_buy_amt') or 0) + float(st.get('lead_buy_amt') or 0)


def _park_manual_alert(st):
    """湊交割款做不到(0050 一直沒報價 / 程式太晚啟動)→ 🚨 講清楚要你做什麼(⛔ 不可安靜結束)"""
    amt = _today_buy(st)
    own = int((st.get('park') or {}).get('sh') or 0)
    log(f"🅿️ 🚨🚨 今天自動下單買了約 {amt:,.0f} 元的股票,但還沒賣 0050 湊交割款(0050 一直沒有報價,或程式太晚啟動)。"
        f"請確認交割戶在 T+2 早上 9 點前有這筆錢;不夠的話今天 14:00~14:30 可以用盤後定價手動賣它買的 0050(最多 {own} 股)")


def park_step(api, sj, st, day, sleep_fn=None):
    """🅿️ 一天一次(13:27 收盤競價):
    ① **先湊交割款**:今天自動下單買的(🔥 + 👑)+ 👑 要留的錢 + 1% 緩衝 > 可用現金 → 一定賣「自己的」0050 補
       ⛔ 不管「帳戶總資金過期」/ 沒設帳戶 / PARK=0 —— 只要手上還有它買的 0050(檢查代理 10/22 抓到:以前會被「過期」擋掉 → 違約交割)
       查不到現金 → 今天 🔥 買多少就賣多少 0050(保守)
    ② 再照 `park_plan` 補買 / 賣多出來的(⛔ 同一天只做一邊、⛔ 不當沖 0050)
    ③ 買:一天最多 PARK_MAX_AMT_PER_DAY;⛔ 不超過「現金 − 今天要付的 − 👑 要留的 − 緩衝」;
       真實帳戶:查不到現金那天不買、`PARK_LIVE_OK` 還沒開 → 只預覽;送出前記下永豐庫存,隔天對帳才算自己的
    回傳 'off' / 'done' / 'retry' / 'none' / 'stale' / 'ok' / 'sell' / 'buy' / 'preview' / 'nocash' / 'err'"""
    if not PARK and not _park_has_own(st):
        return 'off'
    if st.get('park_day') == day:
        return 'done'
    pk = _park_rec(st)
    hot_buy = float(st.get('hot_buy_amt') or 0)
    lead_buy = float(st.get('lead_buy_amt') or 0)
    px, ref = _park_quote(api, sleep_fn=sleep_fn)
    if px <= 0:
        if hot_buy + lead_buy > 0 and _park_has_own(st):
            log("🅿️ 🚨 0050 一直沒有報價 → 還沒賣 0050 湊今天買股票的錢,下一輪再試")
        else:
            log("🅿️ ⚠️ 0050 沒有報價 → 下一輪再試")
        return 'retry'   # ⛔ 不標今天做完(下一輪補;收盤前還不行 → main 會跳 🚨)
    own, pend_sh = _park_settle(api, sj, pk, day)
    # 🔥 持股市值(⛔ 只算這個模式自己買的 pos;報價失敗那檔用買進價)
    stock_val = 0.0
    for sym, pos in (st.get('pos') or {}).items():
        if pos.get('m') and pos.get('m') != _mode():
            continue
        sh = int(pos.get('sh') or 0)
        p = 0.0
        try:
            p = float(getattr(api.snapshots([api.Contracts.Stocks[sym]])[0], 'close', 0) or 0)
        except Exception:
            p = 0.0
        stock_val += sh * (p if p > 0 else float(pos.get('e') or 0))
    if LIVE and own > 0:
        real = _broker_qty(api, sj, PARK_SYM)   # 真實模式:跟永豐的庫存比一次(取小)
        if real is None:
            log(f"🅿️ ⚠️ 查不到永豐庫存 → 先照狀態檔的 {own} 股")
        elif real < own:
            log(f"🅿️ ⚠️ 狀態檔記自己買了 {own} 股 0050,永豐庫存只有 {real} 股 → 以 {real} 股為準")
            own = real; pk['sh'] = own
    park_val = (own + pend_sh) * px
    cash, raw = _cash_info(api)
    lead_res = _lead_reserve(st)
    buf = ACCOUNT_SIZE * PARK_BUF_PCT / 100.0 if ACCOUNT_SIZE > 0 else 0.0
    buy_px, sell_px = _park_limits(px, ref)
    if LIVE:
        log(f"🅿️ 🔎 永豐回的原始資料(給 Claude 對交割款正負號):{raw} ・今天自動下單買了 🔥 {hot_buy:,.0f} / 👑 {lead_buy:,.0f}")
    # ① 湊交割款(只在今天有買的時候;⛔ 沒買東西時現金略低於緩衝 ⛔ 不賣 —— 那會變成天天小額來回)
    need = 0.0
    if hot_buy + lead_buy > 0:
        need = (hot_buy + lead_buy + lead_res + buf - cash) if cash is not None else hot_buy
    fund_sh = min(own, math.ceil(need / sell_px)) if need > 0 and own > 0 else 0
    if need > 0 and own * sell_px < need:
        log(f"🅿️ 🚨 今天買股票要付的錢,現金加上它自己的 0050 還差約 {need - own * sell_px:,.0f} 元 —— 請確認交割戶 T+2 早上 9 點前的錢夠")
    # ② 停多少(⛔ 只影響補買 / 賣多出來的,⛔ 不影響上面湊交割款)
    if not PARK:
        target, diff, act = 0.0, 0.0, 'off'
    else:
        target, diff, act = park_plan(ACCOUNT_SIZE, stock_val, park_val, PARK_RESERVE_PCT, PARK_MIN_TRADE_PCT, today_buy=hot_buy)
    if act == 'none' and not fund_sh:
        log("🅿️ 沒設 ACCOUNT_SIZE(帳戶總資金)→ 不停 0050(⛔ 不猜你有多少錢);要停請設 ACCOUNT_SIZE=<股票 + 0050 + 現金>")
    if act == 'stale':
        log(f"🅿️ ⚠️ 手上股票 {stock_val:,.0f} + 0050 {park_val:,.0f} 比帳戶總資金 {ACCOUNT_SIZE:,} 的 1.1 倍還多 → ACCOUNT_SIZE 可能過期了,"
            "今天不照它補買 / 賣多出來的(請改成現在的總資金);湊交割款照做")
    elif act not in ('none', 'off'):
        log(f"🅿️ 帳戶 {ACCOUNT_SIZE:,} − 個股 {stock_val:,.0f} = 該停 0050 {target:,.0f}(自己的 {own} 股"
            + (f" + 還沒對帳 {pend_sh} 股" if pend_sh else '') + f" ≈ {park_val:,.0f})"
            f"・今天買股票 {hot_buy + lead_buy:,.0f}・現金 {'查不到' if cash is None else f'{cash:,.0f}'}")
    sell_sh = max(fund_sh, math.ceil(-diff / sell_px) if act == 'sell' else 0)
    sell_sh = min(sell_sh, own)
    if sell_sh > 0:
        why = '湊今天買股票的交割款' if fund_sh else '比該停的多'
        log(f"🅿️ 🔻 賣 {sell_sh} 股 0050 @ {sell_px}(約 {sell_sh * sell_px:,.0f} 元;{why};收盤競價)")
        if DRY_RUN:
            log("   🧪 DRY_RUN:不送單"); st['park_day'] = day; return 'sell'
        if _past_close():   # 主迴圈的分鐘數是這一輪開頭讀的,報價重試可能拖過 13:30 → 送前再看一次鐘(10/22 檢查代理)
            log("🅿️ 🚨 已經過了 13:30 收盤,0050 賣單送不進去")
            if fund_sh:
                _park_manual_alert(st)
            st['park_day'] = day; save_state(st); return 'late'
        c0 = api.Contracts.Stocks[PARK_SYM]
        try:
            log(f"   ✅ 賣單 {_send(api, sj, c0, sell_px, sell_sh, False)}")
            got = sell_sh
        except Exception as e:
            got = int(getattr(e, 'sent_sh', 0) or 0)
            if got <= 0:
                log(f"   🚨 0050 賣單沒送出:{e} → 下一輪再試(收盤前還不行會提醒你手動賣)")
                return 'retry'
            log(f"   🚨 0050 賣單只送出 {got} 股就出錯({e})→ 剩下 {sell_sh - got} 股 ⛔ 不會再送;請到永豐 App 確認,"
                f"不夠的話手動賣(盤後定價 14:00~14:30 也可以),不然 T+2 交割款可能不夠")
        pk['sh'] = own - got; pk['m'] = _mode(); st['park_day'] = day; save_state(st)   # ⚠️ 送出就扣(⛔ 不可重複賣)
        return 'sell'
    if act != 'buy':
        if act == 'ok':
            log("🅿️ ✅ 差不多了,不用動")
        st['park_day'] = day; save_state(st)
        return {'none': 'none', 'stale': 'stale', 'off': 'ok'}.get(act, 'ok')
    # ③ 買
    amt = min(diff, float(PARK_MAX_AMT_PER_DAY))
    if cash is None and LIVE:
        log(f"🅿️ ⚠️ 查不到交割戶現金({raw})→ 今天⛔ 不買 0050(寧可少停一天,⛔ 不可買到錢不夠交割)")
        st['park_day'] = day; save_state(st); return 'nocash'
    if cash is not None:
        amt = min(amt, cash - hot_buy - lead_buy - lead_res - buf)
    sh = int(max(0.0, amt) // buy_px)
    if sh <= 0:
        log("🅿️ 現金不夠買 0050(或差距太小)→ 今天不買"); st['park_day'] = day; save_state(st); return 'ok'
    left = max(0.0, diff - sh * buy_px)
    msg = (f"🅿️ 🔺 買 {sh} 股 0050 @ {buy_px}(約 {sh * buy_px:,.0f} 元;收盤競價)"
           + (f" ・還差約 {left:,.0f} 元,之後每天補(一天最多 {PARK_MAX_AMT_PER_DAY:,})" if left >= ACCOUNT_SIZE * PARK_MIN_TRADE_PCT / 100 else ''))
    if LIVE and not PARK_LIVE_OK:
        log(msg.replace('🅿️ 🔺 買', '🅿️ 👀 預覽(⛔ 沒送單):今天會買'))
        log("   ⏳ 真實帳戶的「停 0050」還沒開:等你把這段 log + 永豐 App「交割款查詢」的截圖傳給 Claude 對過正負號,下一版才會真的買")
        st['park_day'] = day; save_state(st); return 'preview'
    log(msg)
    if DRY_RUN:
        log("   🧪 DRY_RUN:不送單"); st['park_day'] = day; return 'buy'
    if _past_close():
        log("🅿️ 已經過了 13:30 收盤 → 今天不買 0050"); st['park_day'] = day; save_state(st); return 'late'
    c0 = api.Contracts.Stocks[PARK_SYM]
    before = _broker_qty(api, sj, PARK_SYM) if LIVE else None
    if LIVE and before is None:
        log("🅿️ ⚠️ 查不到永豐 0050 庫存 → 今天⛔ 不買(買了之後沒辦法對帳哪些是自己的)")
        st['park_day'] = day; save_state(st); return 'nocash'
    try:
        log(f"   ✅ 買單 {_send(api, sj, c0, buy_px, sh, True)}")
        got = sh
    except Exception as e:
        got = int(getattr(e, 'sent_sh', 0) or 0)
        log(f"   🚨 買 0050 送單出錯:{e} —— 已送出 {got} 股(⛔ 不會再送);請到永豐 App 確認")
    if got > 0:
        if LIVE:
            pk['pend'] = {'d': day, 'sh': got, 'b': before}   # ⛔ 送出 ≠ 成交:隔天用永豐庫存差對帳才算自己的
        else:
            pk['sh'] = own + got   # 模擬帳戶:送出就算(不動真錢)
    pk['m'] = _mode(); st['park_day'] = day; save_state(st)
    return 'buy' if got > 0 else 'err'


_FILL_PENDING = ('PendingSubmit', 'PreSubmitted', 'Submitted', 'PartFilled')


def _fill_rows(api, sj, today):
    """📒 問永豐今天每一筆委託的成交回報 → list[dict];查不到 → None(⛔ 不猜)。⛔ 只讀:update_status / list_trades。
    單位:整張那筆的數量是「張」、零股那筆是「股」(永豐文件);成交回報自己的總成交量(deal_quantity)跟逐筆加總對不上 → 印出來。"""
    try:
        try:
            api.update_status(api.stock_account)
        except TypeError:
            api.update_status()
        trades = list(api.list_trades() or [])
    except Exception as e:
        log(f"📒 ⚠️ 查不到今天的成交回報({type(e).__name__}: {e})→ 這次沒記到實際成交價")
        return None
    C = sj.constant
    rows = []
    for t in trades:
        try:
            o, s, c = t.order, t.status, t.contract
            odd = getattr(o, 'order_lot', None) == C.StockOrderLot.IntradayOdd
            unit = 1 if odd else 1000
            deals = list(getattr(s, 'deals', None) or [])
            dq = sum(float(getattr(d, 'quantity', 0) or 0) for d in deals)
            amt = sum(float(getattr(d, 'price', 0) or 0) * float(getattr(d, 'quantity', 0) or 0) for d in deals)
            api_dq = getattr(s, 'deal_quantity', None)
            sym = str(getattr(c, 'code', '') or '')
            if api_dq is not None and deals and abs(float(api_dq) - dq) > 1e-9:
                log(f"📒 ⚠️ {sym} 成交回報的總成交量 {api_dq} 跟逐筆加總 {dq:g} 對不上(單位可能不同)→ 照逐筆記,請到永豐 App 對一下")
            rows.append({
                'd': today, 'oid': str(getattr(o, 'id', '') or getattr(o, 'seqno', '') or ''), 'sym': sym,
                'side': 'B' if getattr(o, 'action', None) == C.Action.Buy else 'S', 'lot': 'O' if odd else 'C',
                'px': float(getattr(o, 'price', 0) or 0), 'q': int(round(float(getattr(o, 'quantity', 0) or 0) * unit)),
                'fq': int(round(dq * unit)), 'avg': round(amt / dq, 4) if dq > 0 else None,
                'st': str(getattr(s, 'status', '') or '').split('.')[-1], 'n': len(deals), 'm': _mode(),
            })
        except Exception as e:
            log(f"📒 ⚠️ 有一筆成交回報讀不懂({type(e).__name__}: {e}),略過")
    return rows


def _fill_closes(api, syms):
    """📒 今天的收盤價(13:30 以後的快照 = 收盤價);拿不到的那檔 → 不放(⛔ 不猜)"""
    out = {}
    for sym in syms:
        try:
            snap = api.snapshots([api.Contracts.Stocks[sym]])[0]
            px = float(getattr(snap, 'close', 0) or 0)
            if px > 0:
                out[sym] = px
        except Exception:
            pass
    return out


def fills_report(api, sj, today, now_fn=None, sleep_fn=None):
    """📒 V80.1.3 收工前把今天的實際成交價記進 FILLS_LOG,並印出跟「回測假設的收盤價成交」差多少。
    ⛔ 只讀(update_status / list_trades / snapshots);⛔ 不碰狀態檔、⛔ 不送 / 不刪任何單。回傳這次新寫進去幾筆(查不到 → None)。"""
    if DRY_RUN:
        log("📒 🧪 DRY_RUN:沒有送單,不查成交回報"); return 0
    if not FILLS_LOG:
        return 0
    now_fn = now_fn or tpe_now
    sleep_fn = sleep_fn or time.sleep
    rows = _fill_rows(api, sj, today)
    if rows is None:
        return None
    if not rows:
        log("📒 今天沒有任何委託 → 沒有成交要記"); return 0
    now, mins, _ = now_fn()
    if now.weekday() < 5 and mins < FILLS_WAIT_TO:
        wait = min(10, FILLS_WAIT_TO - mins)
        log(f"📒 等到 {FILLS_WAIT_TO // 60}:{FILLS_WAIT_TO % 60:02d}(約 {wait} 分鐘)收盤競價成交完再記實際成交價 —— ⛔ 這段時間不會送任何單")
        sleep_fn(wait * 60)
        rows = _fill_rows(api, sj, today) or rows
        now, mins, _ = now_fn()
    closes = _fill_closes(api, sorted({r['sym'] for r in rows if r['fq'] > 0})) if mins >= 13 * 60 + 30 else {}
    worse = []
    for r in rows:
        r['own'] = r['oid'] in _SENT_IDS
        c = closes.get(r['sym'])
        r['close'] = c
        r['vs_px'] = round((r['avg'] / r['px'] - 1) * 100, 3) if r['avg'] and r['px'] > 0 else None
        # 正數 = 比回測假設的收盤價成交差(買貴了 / 賣便宜了)
        r['vs_close'] = (round(((r['avg'] / c - 1) if r['side'] == 'B' else (1 - r['avg'] / c)) * 100, 3)
                         if r['avg'] and c else None)
        side = '買' if r['side'] == 'B' else '賣'
        if r['fq'] <= 0:
            log(f"📒 {r['sym']} {side} {r['q']:,} 股:掛 {r['px']:g} → 沒成交({r['st'] or '狀態不明'})")
            continue
        tail = ''
        if r['vs_close'] is not None:
            worse.append(r['vs_close'])
            word = ('買貴了' if r['side'] == 'B' else '賣便宜了') if r['vs_close'] > 0 else ('少付' if r['side'] == 'B' else '多拿')
            tail = f",收盤 {c:g} → 比收盤 {word} {abs(r['vs_close']):.2f}%"
        elif mins < 13 * 60 + 30:
            tail = "(還沒收盤,收盤價等明天看)"
        part = '' if r['fq'] >= r['q'] else f"(只成交 {r['fq']:,} / {r['q']:,} 股)"
        log(f"📒 {r['sym']} {side} {r['fq']:,} 股{part}:掛 {r['px']:g} → 成交均價 {r['avg']:g}{tail}"
            + ('' if r['own'] else '(⚠️ 不是這一次程式送的單 —— 可能是你手動下的,或是之前那一次)'))
    seen = set()
    try:
        if os.path.exists(FILLS_LOG):
            with open(FILLS_LOG, encoding='utf-8') as f:
                for line in f.readlines()[-5000:]:
                    try:
                        j = json.loads(line)
                    except Exception:
                        continue
                    seen.add((j.get('d'), j.get('oid'), j.get('lot'), j.get('fq'), j.get('st')))
    except Exception:
        pass
    new = [r for r in rows if (r['d'], r['oid'], r['lot'], r['fq'], r['st']) not in seen]
    try:
        with open(FILLS_LOG, 'a', encoding='utf-8') as f:
            for r in new:
                f.write(json.dumps(r, ensure_ascii=False) + '\n')
    except Exception as e:
        log(f"📒 ⚠️ 成交紀錄寫不進去({type(e).__name__}: {e})—— ⛔ 不影響任何下單")
        return None
    filled = sum(1 for r in rows if r['fq'] > 0)
    avg_w = f";跟回測假設的收盤價比,平均每筆 {sum(worse) / len(worse):+.2f}%(正數 = 比回測差)" if worse else ''
    log(f"📒 今天 {len(rows)} 筆委託、{filled} 筆有成交 → 新記 {len(new)} 筆到 {FILLS_LOG}{avg_w}")
    return len(new)


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
            + ("" if ACCOUNT_SIZE > 0 else " ⚠️ 但沒設 ACCOUNT_SIZE → 不會動")
            + (" ・👀 真實帳戶目前只預覽、⛔ 不送 0050 買單(等交割款正負號確認,見 PARK_LIVE_OK)" if LIVE and not PARK_LIVE_OK else ""))
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
    if st is None:      # 🩺 狀態檔讀不出來 → ⛔ 今天不下單(原因與修法 load_state 已經印了)
        return 1
    _, _, today = tpe_now()
    # ⚠️ `done`(今天買過誰)每天重置,但部位(`pos` / `lead` / `lead2` / `park`)與延後要賣的(`lead_defer`)⛔ 絕不可跟著清掉
    st = reset_day(st, today)
    _legacy_check(st)   # 🔐 真實帳戶第一次跑新版:沒標模式的舊部位一律當成模擬留下的(⛔ 不自動賣)
    log(f"📒 今天已下過:{st['done'] or '(無)'}")
    _, _m0, _ = tpe_now()
    if _m0 >= 13 * 60 + 30 and st.get('park_day') != today and _today_buy(st) > 0 and _park_has_own(st):
        _park_manual_alert(st)   # 🅿️ 程式太晚啟動(或中途掛掉):今天買的還沒賣 0050 湊交割款 → 🚨 講清楚

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
            #    PARK=0 但手上還有它買的 0050 也要做(湊交割款);還是做不到 → 🚨 講清楚要你手動做什麼
            if (PARK or _park_has_own(st)) and st.get('park_day') != day:
                r = park_step(api, sj, st, day) if mins < 13 * 60 + 30 else 'retry'
                if r == 'retry' and _today_buy(st) > 0 and _park_has_own(st):
                    _park_manual_alert(st)
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
            exit_step(api, sj, st)

        # 👑 領頭羊(尾盤時段):一天一次,⛔ 不受上面那套的空頭 continue 影響(它自己只擋買)
        if LEADER and LEADER_WINDOW == 'eod':
            leader_step(api, sj, st, meta, day)
        # ⏱️ 補賣延後要賣的(split 開盤跌 ≥3% 延後的・任何時段賣單只送出一部分剩下的)+ split 13:25 買進延後的(買只買今天那一份)
        if LEADER:
            _df = st.get('lead_defer') or {}
            if _df.get('sell'):
                log("👑 ⏱️ 延後要賣的還沒賣成 → 尾盤補賣"); leader_defer_step(api, sj, st, day, 'sell')
            if LEADER_WINDOW == 'split' and _df.get('buy') and mins >= LEADER_DEFER_BUY_FROM:
                leader_defer_step(api, sj, st, day, 'buy')

        # 🔥 買進(V79.4.9 搬進 hot_step 才測得到;⛔ 行為不變,只多「已經持有就不再買」)
        hot_step(api, sj, st, meta, picks, day)
        # 🅿️ V79.4.9 沒用到的錢停 0050:一天一次、排在所有買進之後(要知道今天花了多少);跑完就收工(⛔ 之後不再買 🔥,免得錢不夠交割)
        if (PARK or _park_has_own(st)) and mins >= PARK_AT:
            if park_step(api, sj, st, day) != 'retry':   # 0050 沒報價 → 下一輪再試(⛔ 不收工,收盤前還不行會跳 🚨)
                log("🅿️ 0050 已處理 → 今天的買進到此為止"); break

        time.sleep(POLL_SEC)

    # 📒 V80.1.3 收工前把今天的實際成交價記下來(⛔ 只讀;出任何錯都只印一行,⛔ 不影響已經做完的買賣)
    try:
        fills_report(api, sj, today)
    except Exception as e:
        log(f"📒 ⚠️ 記成交回報時出錯({type(e).__name__}: {e})—— ⛔ 不影響任何下單")
    try:
        api.logout()
    except Exception:
        pass
    log("👋 結束。" + (f"📒 今天的實際成交價已記在 {FILLS_LOG};" if FILLS_LOG and not DRY_RUN else "")
        + "App 的「📌 追蹤中」還是要你自己填實際成交價(手機跟這台電腦不同步)—— 沒有那個數字,永遠不知道滑價吃掉多少。")
    return 0


# ⚠️ 進入點一律放檔案最後面(陷阱 #9:放中段會讓後面定義的名字還不存在)
if __name__ == '__main__':
    sys.exit(main())
