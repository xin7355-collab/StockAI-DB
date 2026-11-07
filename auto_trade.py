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
import traceback
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
#   🧾 V82.0.4 起重開機時會從狀態檔的委託紀錄(st['ord'])把今天送過的編號補回來(_sent_ids_restore)

# 🧾 V82.0.4 委託紀錄 + 出錯先查委託再重送 + 收工對帳(外部健檢 11/07;使用者:真實帳戶在跑、四個安全機制都要)
#   以前三個真缺口:① 送單時連線出錯、但永豐其實已經收單 → 下一輪又送一次(重複買 / 賣)
#   ② 🔥 / 👑 部位記的是「送出股數」,從來不跟實際成交 / 永豐庫存對帳(只有 0050 有)
#   ③ 賣單一送出就從紀錄刪掉 → 限價賣單沒成交(跌停鎖死、送出後價格再往下)→ 那檔變成沒人管(陷阱 #68)
#   ⛔ 這一段只「少做事、多檢查」:⛔ 改每筆上限、⛔ 改賣出價格、⛔ 改選股 / 換倉 / 出場規則。
ORD_KEEP_DAYS = 14                 # 委託紀錄留幾天
GATE_WAIT_SEC = 55                 # 送單出錯之後至少等這麼久才去問永豐(單子可能還在路上)
GATE_MATCH_SEC = 300               # 永豐那邊的委託時間要在我們送出的前 1 分鐘 ~ 後 5 分鐘內,才認成同一筆
RECON_FROM = 13 * 60 + 36          # 13:36 以後才對帳下結論(13:30 收盤競價的成交回報要幾分鐘才齊)
RECON_GAP_SEC = 60                 # 對帳讀兩次、中間隔幾秒;兩次一樣才算數
RECON_APPLY = (os.getenv('RECON_APPLY') or '1') != '0'      # 逃生門:RECON_APPLY=0 = 全部只報告、⛔ 改狀態檔
LOSS_LOCK_PCT = float(os.getenv('LOSS_LOCK_PCT') or 0)      # 🔒 本月已實現虧損 ≥ 本金 X% → 不再開新的 🔥 / 👑(預設 0 = 關)
_RECON_ST = ('Submitted', 'PartFilled', 'Filled', 'Cancelled', 'Failed')   # 這幾種狀態 13:36 以後才算「今天已經定案」
_now_ts = time.time                # 測試可以換成假時鐘
_ONCE = set()                      # 同一件事只講一次(⛔ 每 60 秒洗版)


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
    # 🧾 V82.0.4 委託紀錄只留 ORD_KEEP_DAYS 天、已實現損益只留 24 個月(⛔ 狀態檔一直長大)
    if isinstance(out.get('ord'), list):
        try:
            cut = (datetime.strptime(today, '%Y-%m-%d') - timedelta(days=ORD_KEEP_DAYS)).strftime('%Y-%m-%d')
            out['ord'] = [e for e in out['ord'] if isinstance(e, dict) and str(e.get('d') or '') >= cut]
        except ValueError:
            pass
    if isinstance(out.get('pnl'), dict) and len(out['pnl']) > 24:
        out['pnl'] = {k: out['pnl'][k] for k in sorted(out['pnl'])[-24:]}
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
    """整張 + 零股拆兩筆送,其中一筆出錯:`sent_sh` = 出錯前**已經送出去**的股數(呼叫端 ⛔ 不可把那一段再送一次)
    `err` = 原本的錯誤(🧾 V82.0.4:被送單守門擋下來的是 GateHold)"""
    def __init__(self, sent_sh, err):
        super().__init__(f"{err}(出錯前已送出 {sent_sh} 股)")
        self.sent_sh = sent_sh
        self.err = err


class GateHold(Exception):
    """🧾 V82.0.4 送單守門擋下來(⛔ 不是送單失敗):kind = 'wait'(等一下再問永豐)/ 'stop'(今天這一段先不送)"""
    def __init__(self, kind, why):
        super().__init__(why)
        self.kind = kind


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


# ─── 🧾 V82.0.4 委託紀錄 + 出錯先查委託再重送 ───────────────────────────────────────────
def _log_once(key, *a):
    """同一件事只講一次(送單守門每 60 秒會被問一次 → ⛔ 洗版)"""
    if key in _ONCE:
        return
    _ONCE.add(key)
    log(*a)


def _fail_log(e, line):
    """送單沒成:真的送單出錯照舊每次都講;被守門擋下來的 —— 'stop' 那句 _send_j 已經講過(🚨)、'wait' 同一句只講一次"""
    g = e if isinstance(e, GateHold) else getattr(e, 'err', None)
    if isinstance(g, GateHold):
        if g.kind != 'stop':
            _log_once(('fail', line), line)
        return
    log(line)


def _day_of(st):
    return str((st or {}).get('d') or tpe_now()[2])


def _oid_of(tr):
    try:
        return str(getattr(getattr(tr, 'order', None), 'id', '') or '')
    except Exception:
        return ''


def _ord_today(st, day):
    return [e for e in ((st or {}).get('ord') or []) if isinstance(e, dict) and e.get('d') == day]


def _ord_add(st, day, sym, side, lot, q, px, book, p=None):
    """送單之前先記一筆(狀態「?」);呼叫端接著 save_state 才送。p = 賣出時原本的部位(沒賣掉時收回來用)"""
    st['ord_n'] = int(st.get('ord_n') or 0) + 1
    ts = float(_now_ts())
    e = {'k': st['ord_n'], 'd': day, 'ts': ts, 't': datetime.fromtimestamp(ts, TW).strftime('%H:%M:%S'),
         'sym': str(sym), 'side': side, 'lot': lot, 'q': int(q), 'px': float(px), 'book': book,
         'st': '?', 'oid': '', 'm': _mode()}
    if p:
        e['p'] = {k: v for k, v in dict(p).items() if k != 'rs'}
    st.setdefault('ord', []).append(e)
    return e


def _sent_ids_restore(st, day):
    """重開機:今天稍早那一次送過的委託編號補回來(收工時才認得出哪幾筆是程式送的)"""
    n = 0
    for e in _ord_today(st, day):
        if e.get('oid') and e['oid'] not in _SENT_IDS:
            _SENT_IDS.add(e['oid'])
            n += 1
    if n:
        log(f"🧾 今天稍早程式已經送過 {n} 筆委託(重開機前)→ 收工時照樣算成程式的單")
    return n


def _strong(r, e, use_time=True):
    """永豐那筆委託跟我們這一筆是不是「完全對得上」:代號 / 買賣 / 整張或零股 / 股數 / 價格都一樣,
    委託時間在我們送出前 1 分鐘 ~ 後 GATE_MATCH_SEC 秒(永豐沒給時間就不比)。
    use_time=False 只給收工對帳「只報告」那一段用(時間對不上也講出來,⛔ 拿來改紀錄或下單)"""
    if r.get('sym') != e.get('sym') or r.get('side') != e.get('side') or r.get('lot') != e.get('lot'):
        return False
    if int(r.get('q') or 0) != int(e.get('q') or 0) or abs(float(r.get('px') or 0) - float(e.get('px') or 0)) > 1e-6:
        return False
    ot, ts = r.get('ot'), e.get('ts')
    if use_time and ot is not None and ts is not None and not (float(ts) - 60 <= float(ot) <= float(ts) + GATE_MATCH_SEC):
        return False
    return True


def _claim_rows(st, day, rows):
    """永豐今天的委託裡,哪幾筆(位置)是我們已經認得的:有委託編號的直接對;沒有編號的照「完全對得上」認最早那一筆"""
    ents = [e for e in _ord_today(st, day) if e.get('st') in ('ok', 'adopt')]
    known = {e['oid'] for e in ents if e.get('oid')}
    used = {i for i, r in enumerate(rows) if r.get('oid') and r['oid'] in known}
    for e in ents:
        if e.get('oid'):
            continue
        for i, r in enumerate(rows):
            if i not in used and _strong(r, e):
                used.add(i)
                break
    return used


def _send_gate(api, sj, st, sym, side, lot, q, px, book, day):
    """→ ('go' | 'wait' | 'sent' | 'stop', 原因)。平常(今天這一段沒出錯過)直接 'go',⛔ 多問永豐一次。
    今天這一段出錯過(紀錄是「?」或 err)才去問永豐:
      ・離上次送不到 GATE_WAIT_SEC 秒 → 'wait'(單子可能還在路上)
      ・問不到 → 'stop'(⛔ 不送:可能其實已經收到了)
      ・找到「完全對得上」、還沒被別筆認走的委託 → 認成程式的單('sent'),⛔ 不再送(已取消的也算 —— ⛔ 把你取消的單再送一次)
      ・有同一檔、同方向但對不上的(可能是你手動下的)→ 'stop',⛔ 不認、⛔ 不送
      ・查到確定沒有 → 只准重送一次('go');重送過還是沒成 → 'stop'
    另外:今天這一本帳這一段已經有成功送出的紀錄 → 'stop'(⛔ 重複送)"""
    mine = [e for e in _ord_today(st, day) if e.get('book') == book and e.get('sym') == str(sym)
            and e.get('side') == side and e.get('lot') == lot]
    if any(e.get('st') in ('ok', 'adopt') for e in mine):
        return 'stop', '今天這一段已經送出過(委託紀錄有成功的那一筆)→ ⛔ 再送一次'
    bad = [e for e in mine if e.get('st') in ('?', 'err')]
    if not bad:
        return 'go', ''
    ago = float(_now_ts()) - max(float(e.get('ts') or 0) for e in bad)
    if ago < GATE_WAIT_SEC:
        return 'wait', f'上一次送單出錯才 {int(ago)} 秒,先等永豐那邊確定收到沒有({GATE_WAIT_SEC} 秒後再問)'
    rows = _fill_rows(api, sj, day, quiet=True)
    if rows is None:
        return 'stop', '問不到永豐今天的委託 → ⛔ 不敢再送(可能其實已經收到了);請打開永豐 App「委託查詢」看一下'
    used = _claim_rows(st, day, rows)
    free = [i for i, r in enumerate(rows) if i not in used and r.get('sym') == str(sym) and r.get('side') == side]
    adopted, taken = [], set()
    for e in sorted(bad, key=lambda x: float(x.get('ts') or 0)):
        for i in free:
            if i not in taken and _strong(rows[i], e):
                taken.add(i)
                e['st'], e['oid'] = 'adopt', rows[i].get('oid') or ''
                if e['oid']:
                    _SENT_IDS.add(e['oid'])
                adopted.append((e, rows[i]))
                break
    if adopted:
        for o in bad:
            if o.get('st') in ('?', 'err'):
                o['st'] = 'gone'
        e, r = adopted[0]
        msg = f"永豐其實有收到(委託 {e['oid'] or '?'}・{r.get('st') or '狀態不明'})→ 認成程式的單,⛔ 不再送"
        if len(adopted) > 1:
            msg += f";🚨 而且永豐有 {len(adopted)} 筆一模一樣的委託(可能重複了)→ 請打開永豐 App 看一下"
        return 'sent', msg
    if free:
        return 'stop', (f"永豐有 {len(free)} 筆同一檔、同方向但對不上的委託(可能是你手動下的)→ ⛔ 不認、⛔ 不送;"
                        "請打開永豐 App「委託查詢」看一下")
    if any(e.get('st') == 'gone' for e in mine):
        return 'stop', '今天這一段已經重送過一次還是沒成 → ⛔ 不再送;請打開永豐 App 看一下'
    for e in bad:
        e['st'] = 'gone'
    return 'go', '查過永豐:確定沒有收到 → 重送一次(今天這一段只會重送這一次)'


def _send_j(api, sj, st, contract, px, shares, buy, book, sym, day, p=None):
    """🧾 V82.0.4 送單一律走這一支(⛔ 直接叫 `_send`):行為同 `_send`,多三件事 ——
    ① 整張 / 零股各記一筆委託紀錄,**先寫「?」存檔才送**,回來填委託編號(送出後、存檔前當掉 → 下次開機查得到這一筆)
    ② 這一段今天出錯過 → 先過 `_send_gate`(問永豐有沒有收到)才決定要不要再送
    ③ 任何一段沒送成 → 丟 SendError(帶已送出的股數,同 `_send`;被守門擋下來的 err 是 GateHold)
    book = 記在狀態檔哪一格(pos / lead / lead2 / park);p = 賣出時原本的部位"""
    lots, odd = divmod(int(shares), 1000)
    side = 'B' if buy else 'S'
    out, done_sh = [], 0
    for q, lot in ((lots * 1000, 'C'), (odd, 'O')):
        if q <= 0:
            continue
        g, why = _send_gate(api, sj, st, sym, side, lot, q, px, book, day)
        if g == 'sent':
            done_sh += q
            save_state(st)
            log(f"   🧾 {sym} {why}")
            continue
        if g in ('wait', 'stop'):
            if g == 'stop':
                _log_once(('gate', day, book, str(sym), side, lot, why), f"   🧾 🚨 {sym} {'買' if buy else '賣'}單先不送:{why}")
            save_state(st)
            raise SendError(done_sh, GateHold(g, why))
        if why:
            log(f"   🧾 {sym} {why}")
        e = _ord_add(st, day, sym, side, lot, q, px, book, p)
        save_state(st)   # ⚠️ 先存「?」再送
        try:
            sent = _send(api, sj, contract, px, q, buy)
        except Exception as err:
            orig = getattr(err, 'err', None) or err
            e['st'], e['err'] = 'err', f'{type(orig).__name__}: {orig}'[:160]
            save_state(st)
            raise SendError(done_sh, orig)
        e['st'] = 'ok'
        e['oid'] = _oid_of(sent[0]) if sent else ''
        out += sent
        done_sh += q
    return out


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
    defer = {'d': today, 'sell': [], 'buy': [], 'book': book, 'ld': dd}
    log(f"👑 換倉!{bname}名單日 {dd}(第 {day} 天)・池子 {L['n']} 檔・過趨勢 {L['passed']} 檔・前 {R['N']}:"
        + ' '.join(f"{r['sym']}({r['chg10']:+.1f}%{'・注意' if r['att'] == 1 else '・處置' if r['att'] == 2 else ''})" for r in L['buy']))
    _skip = [r for r in L['ranked'][:R['N']] if not r.get('posOk', True)]
    if _skip:
        log(f"   👑 📍 一年位置不到 {L.get('pos')}% → 不買、往下一名找:" + ' '.join(f"{r['sym']}({r['pos'] if r['pos'] is not None else '—'}%)" for r in _skip))
    # ① 賣:掉出前 2N 名(含掉出池子 / 沒過趨勢)
    for sym, pos in list(held.items()):
        if pos.get('m') and pos.get('m') != _mode():
            log(f"   👑 ⏭️ {sym} 是{'模擬' if pos.get('m') == 'sim' else '真實'}帳戶的紀錄 → 這次⛔ 不賣"); continue
        if pos.get('rs'):
            log(f"   👑 🧾 {sym} 是 {pos.get('rs')} 沒賣掉、收回來的那筆 → 交給補賣(leader_retry_step),這裡⛔ 另外再賣"); continue
        if sym in keep:
            log(f"   👑 🛡️ {sym} 還在前 {R['N'] * R['hyst']} 名(第 {L['all'][sym]['rank']} 名)→ 續抱"); continue
        try:
            contract = api.Contracts.Stocks[sym]
            snap = api.snapshots([contract])[0] if contract is not None else None
            px = float(getattr(snap, 'close', 0) or 0) if snap is not None else 0
        except Exception as e:
            log(f"   👑 ❌ {sym} 報價失敗:{e}"); continue
        if px <= 0:
            continue
        if SPLIT:
            g = _snap_gap(snap)   # 🧾 V82.0.4 用上面已經抓到的報價(以前在 try 外面再抓一次,出錯會讓整支停下來)
            if g is not None and g <= LEADER_GAPDN:
                defer['sell'].append(sym)
                log(f"   👑 ⏱️ {sym} 掉出前 {R['N'] * R['hyst']} 名,但開盤跌 {g * 100:.1f}% → 等到 09:30~10:00 再賣(回測平均多拿約 1.5%)"); continue
        sh = int(pos.get('sh') or 0)
        log(f"   👑 🚪 {sym} 掉出前 {R['N'] * R['hyst']} 名 → 賣 {sh} 股 @ {px}(帳面 {(px - float(pos.get('e') or px)) * sh:+,.0f} 元)")
        if DRY_RUN:
            log("      🧪 DRY_RUN:不送單"); continue
        try:
            log(f"      ✅ 賣單 {_send_j(api, sj, st, contract, px, sh, False, book, sym, today, p=pos)}")
            held.pop(sym, None); save_state(st)      # ⚠️ 送出後立刻移除(寧可漏一次,⛔ 不可重複送;沒成交的收工對帳會收回來)
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
                # 🧾 V82.0.4 一股都沒送出 → 也放進今天稍後要賣的(以前要等到下次換倉 = 10 個交易日沒人管);再送之前會先問永豐有沒有收到
                defer['sell'].append(sym)
                _fail_log(e, f"      ❌ 賣出失敗:{e} → 今天稍後" + ("(09:30~10:00 或尾盤)" if SPLIT else "(尾盤)")
                          + "再試(會先問永豐有沒有收到,⛔ 重複賣)")
    # ② 買:大盤嚴格空頭不買(讀作戰清單的 mkt.bear60,⛔ 這裡不另算)
    _mkt = (meta or {}).get('mkt') or {}
    if LEADER_BEAR_GATE and _mkt.get('bear60') is True:
        log("   👑 🐻 大盤嚴格空頭 → 今天不買新的(賣出已處理)")
    elif _loss_locked(st, today):
        log("   👑 🔒 虧損安全鎖鎖著 → 今天不買新的(賣出已處理)")
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
            if _buy_one(api, sj, st, held, r, px, slot, today, book=book, extra=_lead_tag(book, dd)) == 'stop':
                break
    if defer['sell'] or defer['buy']:   # 買的只有 split 會延後;賣的 split 開盤跌 ≥3% + 任何時段賣單只送出一部分剩下的
        st['lead_defer'] = defer
        log(f"   👑 ⏱️ 稍後要做:賣 {defer['sell'] or '(無)'}({'09:30~10:00' if SPLIT else '尾盤'})・買 {[x['sym'] for x in defer['buy']] or '(無)'}(13:25)")
    st['lead_day'] = today; save_state(st)


def _lead_tag(book, dd):
    """🧾 V82.0.4 👑 每筆買進記下「照哪一版規則買的」(⛔ 只記錄、⛔ 拿來判斷):錨點 / 哪本帳 / 規則 / 名單日期"""
    R = LEADER_RULE
    return {'an': LEADER_ANCHOR if book == 'lead' else LEADER_ANCHOR2, 'bk': book,
            'lr': f"U{R.get('U')}N{R.get('N')}R{R.get('R')}L{R.get('L')}h{R.get('hyst')}p{R.get('pos') if LEADER_POS is None else LEADER_POS}",
            'ld': str(dd or '')}


def _buy_one(api, sj, st, held, r, px, slot, today, book='lead', extra=None):
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
        log(f"      ✅ 買單 {_send_j(api, sj, st, api.Contracts.Stocks[sym], px, shares, True, book, sym, today)}")
        got = shares
    except Exception as e:
        got = int(getattr(e, 'sent_sh', 0) or 0)
        if got <= 0:
            _fail_log(e, f"      ❌ 下單失敗:{e}")
            return 'fail'
        log(f"      🚨 {sym} 整張送出了、零股那筆出錯({e})→ 只記已送出的 {got} 股(⛔ 不會再送);請到永豐 App 確認")
    held[sym] = {'e': px, 'd': today, 'sh': got, 'm': _mode(), **(extra or {})}
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
                log(f"      ✅ 賣單 {_send_j(api, sj, st, contract, px, sh, False, df.get('book') or 'lead', sym, today, p=pos)}")
                held.pop(sym, None); df['sell'].remove(sym); save_state(st)
            except Exception as e:
                got = _sold_part(held, sym, pos, sh, e)
                if got:
                    if sym not in held:
                        df['sell'].remove(sym)
                    save_state(st)
                    log(f"      🚨 {sym} 賣單只送出 {got} 股就出錯({e})→ 剩下的下一輪再賣(⛔ 已送出的不會重送);請到永豐 App 確認")
                else:
                    _fail_log(e, f"      ❌ 賣出失敗:{e}(下一輪再試,會先問永豐有沒有收到)")
    elif phase == 'buy':
        if df.get('d') != today:
            if df.get('buy'):
                log(f"   👑 ⏭️ 延後要買的是 {df.get('d')} 那一份(不是今天)→ ⛔ 不用舊名單下單")
            df['buy'] = []
        R = LEADER_RULE
        slot = LEADER_ACCOUNT / (R['N'] * LEADER_BOOKS) if LEADER_ACCOUNT > 0 else 0
        if df.get('buy') and _loss_locked(st, today):
            log(f"   👑 🔒 虧損安全鎖鎖著 → 13:25 延後要買的 {[x.get('sym') for x in df['buy']]} 今天不買")
            df['buy'] = []
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
            _bk = df.get('book') or 'lead'
            _buy_one(api, sj, st, held, r, px, slot, today, book=_bk, extra=_lead_tag(_bk, df.get('ld')))
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
        leader_retry_step(api, sj, st, day)   # 🧾 V82.0.4 之前沒賣掉、收回來的(rs)先賣掉,換倉那邊才算得對還剩幾檔
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


def _has_rs(st, books):
    return any((p or {}).get('rs') and (not p.get('m') or p.get('m') == _mode())
               for k in books for p in (st.get(k) or {}).values())


def leader_retry_step(api, sj, st, day):
    """🧾 V82.0.4 👑 補賣:收工對帳發現「賣單送了但沒成交」(跌停鎖死、送出後價格再往下)→ 那筆收回來標 rs →
    這裡把它賣掉(換不換倉日都賣:那天已經決定要賣了)。⛔ 不碰 leader_step 的換倉邏輯(它只跳過 rs 那幾筆)。
    真實帳戶送之前再看一次永豐庫存夠不夠(不夠 → 🚨 不送);再送之前一樣先問永豐有沒有收到(_send_j)。"""
    for book in ('lead', 'lead2'):
        held = st.get(book) or {}
        for sym, pos in list(held.items()):
            if not pos.get('rs') or (pos.get('m') and pos.get('m') != _mode()):
                continue
            try:
                contract = api.Contracts.Stocks[sym]
                snap = api.snapshots([contract])[0] if contract is not None else None
                px = float(getattr(snap, 'close', 0) or 0) if snap is not None else 0
            except Exception as e:
                log(f"   👑 ❌ {sym} 報價失敗:{e}"); continue
            if px <= 0:
                continue
            if LIVE and not _inv_enough(api, sj, st, sym):
                continue
            sh = int(pos.get('sh') or 0)
            log(f"👑 🧾 {sym} {pos.get('rs')} 那筆賣單沒成交(收工對帳收回來的)→ 補賣 {sh} 股 @ {px}")
            if DRY_RUN:
                log("      🧪 DRY_RUN:不送單"); continue
            try:
                log(f"      ✅ 賣單 {_send_j(api, sj, st, contract, px, sh, False, book, sym, day, p=pos)}")
                held.pop(sym, None); save_state(st)      # ⚠️ 送出後立刻移除(沒成交的今天收工對帳會再收回來)
            except Exception as e:
                got = _sold_part(held, sym, pos, sh, e)
                if got:
                    save_state(st)
                    log(f"      🚨 {sym} 補賣只送出 {got} 股就出錯({e})→ 剩下的下一輪再賣(⛔ 已送出的不會重送);請到永豐 App 確認")
                else:
                    _fail_log(e, f"      ❌ {sym} 補賣沒送出:{e}(下一輪再試,會先問永豐有沒有收到)")


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
            if pos.get('rs'):
                # 🧾 V82.0.4 之前那筆賣單送了但沒成交(收工對帳收回來的)→ 今天補賣(⛔ 再看出場線:那天已經決定要賣了)
                #    真實帳戶送之前再看一次永豐庫存夠不夠(你可能已經手動賣了)
                if LIVE and not _inv_enough(api, sj, st, sym):
                    continue
                why = f"補賣:{pos.get('rs')} 那筆賣單沒成交(收工對帳收回來的)"
            else:
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
                sent = _send_j(api, sj, st, contract, px, sh, False, 'pos', sym, _day_of(st), p=pos)
            except Exception as e:
                # 🐛 V79.4.9 整張送出、零股出錯 → 已送出的那段從紀錄扣掉(⛔ 下一輪不再賣那一段),沒送出的下一輪再賣
                got = _sold_part(st['pos'], sym, pos, sh, e)
                if got:
                    save_state(st)
                    log(f"   🚨 {sym} 賣單只送出 {got} 股就出錯({e})→ 剩下的下一輪再賣(⛔ 已送出的不會重送);請到永豐 App 確認")
                else:
                    _fail_log(e, f"   ❌ {sym} 賣單沒送出:{e}(下一輪再試,會先問永豐有沒有收到)")
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
    if _loss_locked(st, day):
        return   # 🔒 V82.0.4 虧損安全鎖(預設關;原因 _loss_locked 已經講了):⛔ 開新倉,賣出照常
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
        try:
            stop = float(stop)
        except (TypeError, ValueError):
            # 🧾 V82.0.4 名單上的停損價讀不懂 → 跳過這檔(以前 float(None) 會讓整支程式停下來;⛔ 沒有停損就不買)
            log(f"⏭️ {sym} 名單上的停損價讀不懂({stop!r})→ 今天不買這檔")
            st['done'].append(sym)
            continue

        shares, risk_pct = shares_for_playbook(px, stop)
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
            sent = _send_j(api, sj, st, contract, px, shares, True, 'pos', sym, day)
            got = shares
            log(f"   ✅ 已送出 {len(sent)} 筆:{sent}")
        except Exception as e:
            got = int(getattr(e, 'sent_sh', 0) or 0)
            if got <= 0:
                # 一股都沒送出 → 下一輪可以再試(同以前);🧾 V82.0.4 再送之前會先問永豐有沒有收到
                _fail_log(e, f"   ❌ 下單失敗:{e}"); continue
            log(f"   🚨 {sym} 整張送出了、零股那筆出錯({e})→ 只記已送出的 {got} 股(⛔ 不會再送);請到永豐 App 確認")
        # ⚠️ 先記再說 —— 寧可漏一次,也⛔ 不可重複下單
        st['done'].append(sym)
        # 🚪 記下部位,出場那段才知道「這是我買的」(⛔ 只賣自己買的,不碰手動庫存)
        #    🧾 V82.0.4 多記「照哪一版規則買的」(⛔ 只記錄、⛔ 拿來判斷):hr 排法 / dd 名單日期 / gr 位階門檻 / bg 空頭守門
        st.setdefault('pos', {})[sym] = {'e': px, 'sl': float(stop), 'd': day,
                                         'sh': got, 'k': EXIT_RULE, 'mh': max_hold(EXIT_RULE), 'm': _mode(),
                                         'hr': HOT_RULE, 'dd': str((meta or {}).get('data_date') or ''), 'gr': GENE_RANK, 'bg': int(BEAR_GATE)}
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


def _broker_inv(api, sj):
    """🧾 永豐庫存全部 {代號: (現在股數, 昨天股數)};查不到回 None(⛔ 不猜)"""
    try:
        out = {}
        for x in api.list_positions(api.stock_account, unit=sj.constant.Unit.Share):
            c = str(getattr(x, 'code', '') or '')
            q, yq = int(getattr(x, 'quantity', 0) or 0), int(getattr(x, 'yd_quantity', 0) or 0)
            a, b = out.get(c, (0, 0))
            out[c] = (a + q, b + yq)
        return out
    except Exception:
        return None


def _book_total(st, sym):
    """🧾 程式自己記著的這一檔一共幾股(這個模式的 🔥 + 👑 兩本帳;0050 再加它自己買的)"""
    n = 0
    for k in ('pos', 'lead', 'lead2'):
        p = (st.get(k) or {}).get(sym)
        if p and (not p.get('m') or p.get('m') == _mode()):
            n += int(p.get('sh') or 0)
    if str(sym) == PARK_SYM:
        pk = st.get('park') or {}
        if not pk.get('m') or pk.get('m') == _mode():
            n += int(pk.get('sh') or 0)
    return n


def _inv_enough(api, sj, st, sym):
    """🧾 真實帳戶補賣之前:永豐庫存要 ≥ 程式記著的這一檔股數(⛔ 不夠 = 你可能已經手動賣了 → ⛔ 不送,🚨 講出來)"""
    real = _broker_qty(api, sj, sym)
    need = _book_total(st, sym)
    if real is None:
        _log_once(('inv?', _day_of(st), sym), f"   🧾 ⚠️ {sym} 查不到永豐庫存 → 這一輪先不補賣(⛔ 不知道你手上還有沒有)")
        return False
    if real < need:
        _log_once(('inv<', _day_of(st), sym), f"   🧾 🚨 {sym} 永豐庫存只有 {real} 股,程式記著 {need} 股 → ⛔ 不補賣(可能你已經手動賣了);"
                  "請打開永豐 App 確認,真的賣掉了就把這段 log 傳給 Claude 清掉那筆紀錄")
        return False
    return True


def _loss_base():
    """🔒 虧損安全鎖的本金 = 帳戶總資金(🔥)+ 分給 👑 的錢(有開才算)"""
    return int(ACCOUNT_SIZE or 0) + (int(LEADER_ACCOUNT or 0) if LEADER else 0)


def _loss_locked(st, day):
    """🔒 V82.0.4 虧損安全鎖(LOSS_LOCK_PCT,預設 0 = 關):本月已實現虧損(收工對帳算的,只算程式自己的 🔥 / 👑 賣單)
    ≥ 本金 × 設定% → 這個月剩下的日子 ⛔ 開新的 🔥 / 👑;賣出、補賣、0050 照常;下個月自動解開。"""
    if LOSS_LOCK_PCT <= 0:
        return False
    base = _loss_base()
    if base <= 0:
        _log_once(('lockbase', day), "🔒 ⚠️ 設了 LOSS_LOCK_PCT 但沒設 ACCOUNT_SIZE / LEADER_ACCOUNT(本金)→ 虧損安全鎖沒作用(⛔ 猜你的本金)")
        return False
    pnl = float((st.get('pnl') or {}).get(str(day)[:7]) or 0)
    if pnl <= -LOSS_LOCK_PCT / 100.0 * base:
        _log_once(('lock', day), f"🔒 本月已實現虧損 {pnl:+,.0f} 元 ≥ 本金 {base:,} 的 {LOSS_LOCK_PCT:g}% → 這個月剩下的日子 ⛔ 開新的 🔥 / 👑"
                  "(賣出、補賣、0050 照常);下個月自動解開。要提早解開:把 LOSS_LOCK_PCT 拿掉或調大")
        return True
    return False


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
            log(f"   ✅ 賣單 {_send_j(api, sj, st, c0, sell_px, sell_sh, False, 'park', PARK_SYM, day)}")
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
        log(f"   ✅ 買單 {_send_j(api, sj, st, c0, buy_px, sh, True, 'park', PARK_SYM, day)}")
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


def _order_ts(odt):
    """永豐委託時間 → 秒數(永豐給的是台北時間、沒帶時區);讀不懂回 None(⛔ 猜)"""
    try:
        if odt is None:
            return None
        if isinstance(odt, (int, float)):
            return float(odt)
        return (odt if getattr(odt, 'tzinfo', None) else odt.replace(tzinfo=TW)).timestamp()
    except Exception:
        return None


def _fill_rows(api, sj, today, quiet=False):
    """📒 問永豐今天每一筆委託的成交回報 → list[dict];查不到 → None(⛔ 不猜)。⛔ 只讀:update_status / list_trades。
    單位:整張那筆的數量是「張」、零股那筆是「股」(永豐文件);成交回報自己的總成交量(deal_quantity)跟逐筆加總對不上 → 印出來。
    🧾 V82.0.4 送單守門 / 收工對帳也用這一支(quiet = 查不到時不印「成交回報」那句,呼叫端自己講);
    多帶 ot(委託時間,秒)與 dqx(總成交量跟逐筆加總對不上 → 收工對帳只報告、⛔ 改紀錄)"""
    try:
        try:
            api.update_status(api.stock_account)
        except TypeError:
            api.update_status()
        trades = list(api.list_trades() or [])
    except Exception as e:
        if not quiet:
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
                'ot': _order_ts(getattr(s, 'order_datetime', None)),
                'dqx': bool(api_dq is not None and abs(float(api_dq) - dq) > 1e-9),
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


# ═══════ 🧾 V82.0.4 收工對帳(外部健檢 11/07;使用者選「收工對帳 + 跌停沒賣掉收回」)═══════
_FEE_RATE = 0.001425
_BOOK_NAME = {'pos': '🔥', 'lead': '👑', 'lead2': '👑 乙帳', 'park': '🅿️'}


def _sell_tax(sym):
    return 0.001 if str(sym).startswith('00') else 0.003   # ETF 0.1%、股票 0.3%


def _realized(e, fq, avg):
    """程式自己的賣單成交 fq 股 @ avg → 已實現損益(元)= (成交均價 − 進場價)× 股數 − 買賣手續費(0.1425%,⛔ 算折扣 = 保守)− 證交稅。
    進場價讀委託紀錄裡那筆部位(p.e);讀不到回 None(⛔ 猜)"""
    entry = float(((e or {}).get('p') or {}).get('e') or 0)
    if entry <= 0 or fq <= 0 or not avg:
        return None
    return round((avg - entry) * fq - (entry + avg) * fq * _FEE_RATE - avg * fq * _sell_tax(e.get('sym')))


def _recon_scan_old(st, today):
    """第一次跑新版:往回掃 30 天的成交紀錄(FILLS_LOG),程式自己送的單沒成交完的列出來。⛔ 只報告、⛔ 改狀態檔;只做一次(recon_v)。"""
    if st.get('recon_v'):
        return 0
    st['recon_v'] = 1
    if not FILLS_LOG or not os.path.exists(FILLS_LOG):
        return 0
    try:
        cut = (datetime.strptime(today, '%Y-%m-%d') - timedelta(days=30)).strftime('%Y-%m-%d')
        last = {}
        with open(FILLS_LOG, encoding='utf-8') as f:
            for line in f.readlines()[-20000:]:
                try:
                    j = json.loads(line)
                except Exception:
                    continue
                if not isinstance(j, dict) or not j.get('own') or j.get('m') not in (None, _mode()):
                    continue
                d = str(j.get('d') or '')
                if cut <= d < today:
                    last[(d, str(j.get('oid')), j.get('lot'))] = j     # 同一筆後來成交更多會多一行 → 留最後那行
    except Exception as e:
        log(f"🧾 ⚠️ 讀不到以前的成交紀錄({type(e).__name__}: {e})→ 這次不掃以前的")
        return 0
    n = 0
    for (d, _o, _l), j in sorted(last.items()):
        q, fq = int(j.get('q') or 0), int(j.get('fq') or 0)
        if fq >= q:
            continue
        n += 1
        if j.get('side') == 'S':
            log(f"🧾 🔎 以前程式送的賣單沒賣完:{d} {j.get('sym')} 賣 {q:,} 股只成交 {fq:,} 股 → 剩下 {q - fq:,} 股那時程式就不管了;"
                "請打開永豐 App 看還在不在、要不要自己處理(⛔ 程式不會自己補賣以前的)")
        else:
            log(f"🧾 🔎 以前程式送的買單沒買滿:{d} {j.get('sym')} 買 {q:,} 股只成交 {fq:,} 股 → 程式記的是送出的股數;"
                "請打開永豐 App 對一下(之後賣的時候可能賣不到那麼多)")
    if n:
        log(f"🧾 以前 30 天有 {n} 筆程式送的單沒成交完(上面那幾行)—— 這只列一次,⛔ 不會自動改紀錄")
    return n


def _recon_prev_days(st, today):
    """🧾 以前那幾天(委託紀錄留 ORD_KEEP_DAYS 天)程式送了、卻沒對到帳的單 → 開工時列出來。
    會沒對到:那天電腦在 13:36 之前就關了、對帳時出錯、或程式中途停下來。
    ⛔ 只報告、⛔ 改部位紀錄(永豐只查得到「今天」的委託,以前的沒辦法自動對);每一筆只列一次(rc='p')。"""
    try:
        old = [e for e in (st.get('ord') or []) if isinstance(e, dict) and str(e.get('d') or '') < str(today)
               and e.get('m', _mode()) == _mode() and not e.get('rc') and e.get('st') in ('ok', 'adopt', '?', 'err')]
        if not old:
            return 0
        for e in sorted(old, key=lambda x: (str(x.get('d') or ''), float(x.get('ts') or 0))):
            side = '買' if e.get('side') == 'B' else '賣'
            what = ('送出了(委託 ' + (e.get('oid') or '?') + '),但那天沒對到帳 → 不知道有沒有成交、成交幾股'
                    if e.get('st') in ('ok', 'adopt') else '那天送單時出錯、也沒對到帳 → 不知道永豐有沒有收到')
            tail = ('程式當時已經把這筆從紀錄移除,沒賣掉的話那幾股現在沒人管' if side == '賣' and e.get('st') in ('ok', 'adopt')
                    else '程式記的股數可能跟永豐不一樣')
            log(f"🧾 🔎 {e.get('d')} {_BOOK_NAME.get(e.get('book'), e.get('book') or '')} {e.get('sym')} {side} {int(e.get('q') or 0):,} 股:{what};"
                f"{tail} → 請打開永豐 App「成交回報 / 庫存」對一下(⛔ 程式不會自己改)")
            e['rc'] = 'p'
        log(f"🧾 以前有 {len(old)} 筆程式送的單沒對到帳(上面那幾行;多半是那天電腦在 {RECON_FROM // 60}:{RECON_FROM % 60:02d} 之前就關了)—— 只列這一次")
        save_state(st)
        return len(old)
    except Exception as e:
        log(f"🧾 ⚠️ 檢查以前沒對到帳的單時出錯({type(e).__name__}: {e})—— ⛔ 不影響今天下單")
        return 0


def _row_of(rows, e, used):
    """這一筆委託紀錄對到永豐的哪一筆(位置):有委託編號照編號;沒有(舊的 / 測試)照「完全對得上」挑還沒被用的第一筆"""
    if e.get('oid'):
        for i, r in enumerate(rows):
            if i not in used and r.get('oid') == e['oid']:
                return i
        return None
    for i, r in enumerate(rows):
        if i not in used and _strong(r, e):
            return i
    return None


def reconcile_day(api, sj, st, today, now_fn=None, sleep_fn=None):
    """🧾 V82.0.4 收工對帳(接在 fills_report 後面、登出前面):今天程式自己送的每一筆委託 vs 永豐的成交回報 + 庫存。
    ① 13:36 以後才下結論,隔 RECON_GAP_SEC 秒讀兩次、兩次一樣才算數;狀態沒定案 / 成交回報自己對不上 → 只報告
    ② 要改紀錄,真實帳戶兩邊(成交回報 + 永豐庫存)都要對得上:
       買單只成交一部分 → 紀錄改成實際股數(0 股 → 移除);賣單沒賣掉 → 收回來、標 rs(下一個交易日補賣);
       改完之後程式記的這一檔股數 ⛔ 可以比永豐庫存多 —— 多了就只報告(🚨),⛔ 改
    ③ 模擬帳戶 / RECON_APPLY=0 → 只報告;🅿️ 0050 那筆沒賣掉 → 🚨 提醒(⛔ 改紀錄,隔天 park_step 會跟永豐庫存對)
    ④ 同一天跑兩次結果一樣(對過的那筆標 rc,⛔ 再做)
    ⑤ 順便把程式自己 🔥 / 👑 的賣單算成已實現損益,累加到 st['pnl'][月份](🔒 LOSS_LOCK_PCT 用)
    ⛔ 只讀永豐(update_status / list_trades / list_positions)、⛔ 送 / 刪 / 改任何單。回傳報告(dict,給測試)。"""
    now_fn, sleep_fn = now_fn or tpe_now, sleep_fn or time.sleep
    rep = {'applied': [], 'reported': [], 'pnl': 0, 'final': False}
    if DRY_RUN:
        log("🧾 🧪 DRY_RUN:沒有送單,不對帳"); return rep
    _recon_scan_old(st, today)
    ents = [e for e in _ord_today(st, today) if e.get('m', _mode()) == _mode()]
    todo = [e for e in ents if e.get('st') in ('ok', 'adopt') and e.get('rc') not in ('a', 'r')]
    loose = [e for e in ents if e.get('st') in ('?', 'err') and not e.get('rc')]
    rs_left = [f"{_BOOK_NAME.get(k, k)} {s}" for k in ('pos', 'lead', 'lead2')
               for s, p in (st.get(k) or {}).items() if (p or {}).get('rs')]
    if not todo and not loose:
        log("🧾 收工對帳:" + ("今天程式送的單都對過了" if ents else "今天程式沒有送任何單 → 不用對帳")
            + (f";還有 {len(rs_left)} 筆等下一個交易日補賣:{'、'.join(rs_left)}" if rs_left else ''))
        save_state(st)
        return rep
    now, mins, _ = now_fn()
    if now.weekday() < 5 and mins < RECON_FROM:
        gap = RECON_FROM - mins
        if gap <= 15:      # 正常收工(13:28~13:31 結束主迴圈)→ 等一下就到
            log(f"🧾 等到 {RECON_FROM // 60}:{RECON_FROM % 60:02d}(約 {gap} 分鐘)再對帳 —— 收盤競價的成交回報要幾分鐘才齊;⛔ 這段時間不會送任何單")
            sleep_fn(gap * 60)
            now, mins, _ = now_fn()
        else:              # 中途出錯 / 提早結束 → ⛔ 乾等幾個小時;今天只報告,明天開工再列出來
            log(f"🧾 現在才 {now.strftime('%H:%M')},收盤競價的成交回報要 {RECON_FROM // 60}:{RECON_FROM % 60:02d} 以後才齊 → 今天只先報告、⛔ 改紀錄;"
                "下一次開工會把今天沒對到的單列出來")
    final = now.weekday() < 5 and mins >= RECON_FROM   # 週末 / 還沒到 13:36 → 只報告(⛔ 改紀錄)
    rep['final'] = final
    rows1 = _fill_rows(api, sj, today, quiet=True)
    sleep_fn(RECON_GAP_SEC)
    rows2 = _fill_rows(api, sj, today, quiet=True)
    if rows1 is None or rows2 is None:
        log("🧾 ⚠️ 收工對帳:問不到永豐今天的委託 → 今天沒辦法對帳;程式今天送的單:"
            + '、'.join(f"{e['sym']} {'買' if e['side'] == 'B' else '賣'} {e['q']:,} 股" for e in todo + loose)
            + " → 請打開永豐 App「委託查詢 / 成交回報」對一下(⛔ 程式不會自己改紀錄)")
        rep['reported'] += [e['sym'] for e in todo + loose]
        save_state(st)
        return rep
    used1, used2 = set(), set()
    groups = {}          # sym → {book: {'B': 沒買到的, 'S': 沒賣掉的, 'ents': [...], 'p': 原本的部位}}
    unsure = set()       # 今天有任何一筆對不上的那幾檔 → 整檔只報告(⛔ 拿一半的資訊改紀錄)
    for e in sorted(todo, key=lambda x: float(x.get('ts') or 0)):
        sym, side = e['sym'], e['side']
        i2, i1 = _row_of(rows2, e, used2), _row_of(rows1, e, used1)
        if i2 is None:
            log(f"🧾 ⚠️ {sym} {'買' if side == 'B' else '賣'} {e['q']:,} 股(委託 {e.get('oid') or '?'}):永豐查不到這筆 → 只報告,請打開永豐 App 對一下")
            rep['reported'].append(sym)
            unsure.add(sym)
            if final:
                e['rc'] = 'r'
            continue
        used2.add(i2)
        if i1 is not None:
            used1.add(i1)
        r = rows2[i2]
        r1 = rows1[i1] if i1 is not None else None
        why = None
        if not final:
            why = f'還沒到 {RECON_FROM // 60}:{RECON_FROM % 60:02d}(收盤競價的成交回報可能還沒齊)'
        elif r1 is None or (r1.get('fq'), r1.get('st'), r1.get('q')) != (r.get('fq'), r.get('st'), r.get('q')):
            why = f'隔 {RECON_GAP_SEC} 秒查兩次結果不一樣(永豐還在更新)'
        elif r.get('st') not in _RECON_ST:
            why = f"永豐的狀態是「{r.get('st') or '不明'}」(還沒定案)"
        elif int(r.get('q') or 0) != int(e.get('q') or 0):
            why = f"股數對不上(程式記 {e['q']:,}、永豐 {int(r.get('q') or 0):,})"
        elif r.get('dqx') or (r.get('st') == 'Filled' and int(r.get('fq') or 0) < int(r.get('q') or 0)):
            why = '永豐的成交回報自己對不上(狀態 / 總成交量 / 逐筆成交兜不起來)'
        if why:
            log(f"🧾 ⚠️ {sym} {'買' if side == 'B' else '賣'} {e['q']:,} 股:{why} → 只報告,⛔ 改紀錄")
            rep['reported'].append(sym)
            unsure.add(sym)
            if final and '還沒' not in why and '不一樣' not in why:
                e['rc'] = 'r'
            continue
        fq = int(r.get('fq') or 0)
        e['fq'], e['avg'] = fq, r.get('avg')
        if side == 'S' and e.get('book') in ('pos', 'lead', 'lead2') and fq > 0:
            pl = _realized(e, fq, r.get('avg'))
            if pl is not None:
                delta = pl - float(e.get('pl') or 0)
                e['pl'] = pl
                mo = str(today)[:7]
                pm = st.setdefault('pnl', {})
                pm[mo] = round(float(pm.get(mo) or 0) + delta)
                rep['pnl'] += delta
        g = groups.setdefault(sym, {}).setdefault(e.get('book') or 'pos', {'B': 0, 'S': 0, 'ents': [], 'p': None, 'cx': False})
        g[side] += max(0, int(e['q']) - fq)
        if side == 'S' and fq < int(e['q']) and r.get('st') == 'Cancelled':
            g['cx'] = True    # 程式自己從來不取消單 → 多半是你在永豐 App 取消的 → 收回來但 ⛔ 硬賣(見下面)
        g['ents'].append(e)
        if side == 'S' and g['p'] is None and e.get('p'):
            g['p'] = e['p']
    inv = _broker_inv(api, sj) if LIVE else None
    apply_ok = LIVE and RECON_APPLY
    for sym, books in sorted(groups.items()):
        plan, notes, bad = {}, [], None
        if sym in unsure:
            log(f"🧾 ⚠️ {sym} 今天有別筆委託對不上(上面那幾行)→ 這一檔整檔只報告、⛔ 改紀錄;請打開永豐 App 對一下")
            for g in books.values():
                for e in g['ents']:
                    e['rc'] = 'r' if final else e.get('rc')
            continue
        for book, g in books.items():
            if book == 'park':
                if g['S'] > 0:
                    log(f"🧾 🚨 🅿️ 今天賣 0050 有 {g['S']:,} 股沒成交 → 交割款可能不夠:請確認交割戶 T+2 早上 9 點前的錢夠;"
                        "不夠的話今天 14:00~14:30 可以用盤後定價手動賣 0050(⛔ 程式不會自己改 0050 的紀錄,隔天會跟永豐庫存對)")
                    rep['reported'].append(sym)
                if g['B'] > 0:
                    log(f"🧾 🅿️ 今天買 0050 有 {g['B']:,} 股沒成交 → 真實帳戶隔天會用永豐庫存差算真的買到幾股(⛔ 現在不改)")
                for e in g['ents']:
                    e['rc'] = 'r'
                continue
            if g['B'] <= 0 and g['S'] <= 0:
                for e in g['ents']:
                    e['rc'] = 'a'      # 全部成交 = 紀錄本來就對
                continue
            held = st.get(book) or {}
            cur = dict(held[sym]) if sym in held else None
            sh0 = int((cur or {}).get('sh') or 0)
            sh1 = sh0
            if g['B'] > 0:
                if cur is None:
                    bad = f"{_BOOK_NAME.get(book, book)} 買單沒買滿 {g['B']:,} 股,但程式已經沒有這筆紀錄(可能今天又賣掉了)"
                    break
                sh1 -= g['B']
                notes.append(f"{_BOOK_NAME.get(book, book)} 買單只成交 {sh0 - g['B']:,} / {sh0:,} 股 → 紀錄改成實際股數"
                             + ("(0 股 → 移除)" if sh1 <= 0 else ''))
            if g['S'] > 0:
                if cur is None:
                    if not g['p']:
                        bad = f"{_BOOK_NAME.get(book, book)} 賣單有 {g['S']:,} 股沒成交,但委託紀錄裡沒有原本的部位 → 收不回來"
                        break
                    cur = dict(g['p'])
                sh1 += g['S']
                if g.get('cx'):
                    # 🧾 永豐那筆是「已取消」→ 你自己取消的機會最大 → 收回來(⛔ 變成沒人管),但 ⛔ 標補賣、⛔ 隔天硬賣;
                    #    照原本的規則走:🔥 下一個交易日尾盤出場條件還在才賣、👑 等下一次換倉
                    cur.pop('rs', None)
                    notes.append(f"{_BOOK_NAME.get(book, book)} 賣單有 {g['S']:,} 股在永豐是「已取消」(程式不會自己取消單 → 多半是你在永豐 App 取消的)"
                                 "→ 收回來,照原本的出場規則走(⛔ 隔天硬賣;不想讓程式管這檔請告訴 Claude)")
                else:
                    cur['rs'] = today
                    notes.append(f"{_BOOK_NAME.get(book, book)} 賣單有 {g['S']:,} 股沒成交(跌停鎖死或價格一路往下)→ 收回來,下一個交易日補賣")
            plan[book] = (cur, max(0, sh1), sh0)
        if bad:
            log(f"🧾 🚨 {sym}:{bad} → 只報告,⛔ 改紀錄;請打開永豐 App 對一下")
            rep['reported'].append(sym)
            for g in books.values():
                for e in g['ents']:
                    e['rc'] = 'r'
            continue
        if not plan:
            continue
        msg = f"🧾 {sym}:" + ';'.join(notes)
        if LIVE:
            if inv is None:
                bad = '查不到永豐庫存(⛔ 兩邊都對得上才改)'
            else:
                after = _book_total(st, sym) + sum(n - o for _c, n, o in plan.values())
                real = inv.get(sym, (0, 0))[0]
                if real < after:
                    bad = f"永豐庫存只有 {real:,} 股,照成交回報改完程式會記 {after:,} 股 → 兩邊對不上"
        if bad or not apply_ok:
            why = bad or ('模擬帳戶:只報告(還沒驗證模擬帳戶的成交回報)' if not LIVE else 'RECON_APPLY=0:只報告')
            log(f"{msg} → ⛔ 改紀錄({why})" + (";請打開永豐 App 對一下" if bad else ''))
            rep['reported'].append(sym)
            for g in books.values():
                for e in g['ents']:
                    e['rc'] = 'r'
            continue
        for book, (cur, sh1, sh0) in plan.items():
            held = st.setdefault(book, {})
            if sh1 <= 0:
                held.pop(sym, None)
            else:
                held[sym] = dict(cur, sh=sh1)
        log(f"{msg} → ✅ 已改(成交回報跟永豐庫存兩邊都對得上)")
        rep['applied'].append(sym)
        for g in books.values():
            for e in g['ents']:
                e['rc'] = 'a'
    for e in loose:
        i = _row_of(rows2, dict(e, oid=''), used2)
        if i is None:   # 委託時間對不上也講出來(永豐的時間格式萬一跟我們想的不一樣)—— 只報告
            i = next((j for j, r in enumerate(rows2) if j not in used2 and _strong(r, e, use_time=False)), None)
        if i is not None:
            used2.add(i)
            r = rows2[i]
            log(f"🧾 🚨 {e['sym']} {'買' if e['side'] == 'B' else '賣'} {e['q']:,} 股:程式當成沒送出,但永豐其實有這筆"
                f"(委託 {r.get('oid') or '?'},成交 {int(r.get('fq') or 0):,} 股)→ 程式沒有記到;請打開永豐 App 自己處理,並把這段 log 傳給 Claude")
            rep['reported'].append(e['sym'])
        if final:
            e['rc'] = 'r'
    if LIVE and inv is not None:
        for sym in sorted({s for k in ('pos', 'lead', 'lead2') for s in (st.get(k) or {})}):
            need, real = _book_total(st, sym), inv.get(sym, (0, 0))[0]
            if real < need:
                log(f"🧾 🚨 {sym} 程式記著 {need:,} 股,永豐庫存只有 {real:,} 股 → ⛔ 照程式的紀錄下單前請先對一下(可能你手動賣過)")
    mo = str(today)[:7]
    pnl_txt = f";本月程式自己已實現 {float((st.get('pnl') or {}).get(mo) or 0):+,.0f} 元" if (st.get('pnl') or {}).get(mo) is not None else ''
    rs_now = [f"{_BOOK_NAME.get(k, k)} {s}" for k in ('pos', 'lead', 'lead2') for s, p in (st.get(k) or {}).items() if (p or {}).get('rs')]
    log(f"🧾 收工對帳完成:改了 {len(rep['applied'])} 檔・只報告 {len(rep['reported'])} 檔{pnl_txt}"
        + (f";下一個交易日要補賣:{'、'.join(rs_now)}" if rs_now else ''))
    save_state(st)
    return rep


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
    # 🧾 V82.0.4 安全機制(只「少做事、多檢查」,⛔ 改上限 / 賣價 / 規則)
    log("🧾 送單安全:每一筆先記委託紀錄再送;送單出錯 → 先問永豐有沒有收到才決定要不要重送(只重送一次)")
    log(f"🧾 收工對帳:{RECON_FROM // 60}:{RECON_FROM % 60:02d} 以後跟永豐成交回報 + 庫存對一次(電腦請開到 13:40)"
        + ("・真實帳戶兩邊對得上才改紀錄(買不滿改股數、賣不掉收回來隔天補賣)" if LIVE and RECON_APPLY else
           "・只報告、⛔ 改紀錄(RECON_APPLY=0)" if LIVE else "・模擬帳戶只報告"))
    if LOSS_LOCK_PCT > 0:
        _b = _loss_base()
        log(f"🔒 虧損安全鎖:開(LOSS_LOCK_PCT={LOSS_LOCK_PCT:g})→ 本月已實現虧損 ≥ "
            + (f"{LOSS_LOCK_PCT / 100 * _b:,.0f} 元(本金 {_b:,} 的 {LOSS_LOCK_PCT:g}%)" if _b > 0 else "本金的設定%(⚠️ 但沒設 ACCOUNT_SIZE / LEADER_ACCOUNT → 沒作用)")
            + " 就不再開新倉(賣出照常)")
    else:
        log("🔒 虧損安全鎖:關(預設;要開設 LOSS_LOCK_PCT=3 之類 = 本月已實現虧損 ≥ 本金 3% 就不再開新倉)")

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
    _sent_ids_restore(st, today)   # 🧾 V82.0.4 重開機:今天稍早送過的委託編號補回來(收工時才認得出哪幾筆是程式送的)
    _recon_prev_days(st, today)    # 🧾 V82.0.4 以前那幾天沒對到帳的單(電腦提早關機)→ 先列出來(⛔ 只報告)
    crash = None
    # 🧾 V82.0.4 外層 try:沒預料到的錯 → 🚨 + 錯誤訊息進 log、⛔ 不再送新單,但照樣收工記成交 + 對帳 + 登出、回傳 1
    #   (以前一出錯整支停下來 → 收工的成交紀錄沒寫、永豐沒登出,你也不知道它停在哪裡)
    try:
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

            # 🧾 V82.0.4 👑 之前沒賣掉的(收工對帳收回來、標 rs)→ 補賣(開盤那次沒賣成 / 程式晚開 → 尾盤這裡補)
            if LEADER and _has_rs(st, ('lead', 'lead2')):
                leader_retry_step(api, sj, st, day)
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
    except Exception as e:
        crash = e
        log(f"🚨🚨 程式出錯停下來了({type(e).__name__}: {e})→ ⛔ 今天不再送新的單;照樣收工記成交 + 對帳 + 登出")
        for _ln in traceback.format_exc().strip().splitlines()[-6:]:
            log(f"   {_ln}")
        log("   👉 請把這段 log 傳給 Claude;今天手上的部位請打開永豐 App 看一下")
        save_state(st)

    # 📒 V80.1.3 收工前把今天的實際成交價記下來(⛔ 只讀;出任何錯都只印一行,⛔ 不影響已經做完的買賣)
    try:
        fills_report(api, sj, today)
    except Exception as e:
        log(f"📒 ⚠️ 記成交回報時出錯({type(e).__name__}: {e})—— ⛔ 不影響任何下單")
    # 🧾 V82.0.4 收工對帳(⛔ 只讀永豐;出任何錯都只印一行,⛔ 不影響已經做完的買賣)
    try:
        reconcile_day(api, sj, st, today)
    except Exception as e:
        log(f"🧾 ⚠️ 收工對帳時出錯({type(e).__name__}: {e})—— ⛔ 不影響已經做完的買賣;今天的單請打開永豐 App 對一下")
    try:
        api.logout()
    except Exception:
        pass
    log("👋 結束。" + (f"📒 今天的實際成交價已記在 {FILLS_LOG};" if FILLS_LOG and not DRY_RUN else "")
        + "App 的「📌 追蹤中」還是要你自己填實際成交價(手機跟這台電腦不同步)—— 沒有那個數字,永遠不知道滑價吃掉多少。")
    return 1 if crash is not None else 0


# ⚠️ 進入點一律放檔案最後面(陷阱 #9:放中段會讓後面定義的名字還不存在)
if __name__ == '__main__':
    sys.exit(main())
