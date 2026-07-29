"""
macro_miner.py — 輕量級總經風險採礦機
抓取：美債 10Y、TWSE 三大法人外資買賣超、TAIFEX 外資臺指期淨口數
複合判定：外資期現是否同步、套利避險或真實偏空
輸出：data/macro_risk.json（最輕量易解析）

設計準則：
- 1GB RAM 雲端可跑：不載入 pandas，全用內建 json + requests
- 全 try/except + urllib3 Retry：任何外部 API 故障絕不崩潰
- yfinance 拉 ^TNX（10Y *10 顯示，需 /10）
- 不在 watchdog/cron 觸發崩潰，缺資料時欄位寫 null + reason
"""
import os
import json
import sys
import time      # 🕐 V71.1.7 融資歷史回補的節流 sleep(原本只在某函式內 import,模組層級缺)
import traceback
from pathlib import Path
from datetime import datetime, timezone, timedelta
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from common import parse_twse_margin_ms   # 🧩 TWSE 融資餘額解析(與 miner.py 共用同一份)
import yfinance

DATA_DIR = Path("data")
DATA_DIR.mkdir(exist_ok=True)
OUTPUT_FILE = DATA_DIR / "macro_risk.json"

# ══════════════════════════════════════════════════════════════════
# 📅 全球重大財經事件日曆(純演算法,零外部依賴,絕不崩潰)
# ── 跨年提醒:FOMC/BOJ 排程硬編碼 2026-2027 場次,2027/Q4 需手動補 2028 排程 ──
# ══════════════════════════════════════════════════════════════════
FOMC_SCHEDULE = [
    # 2026 FOMC 排程(federalreserve.gov 公開)
    "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17",
    "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-16",
    # V17.0 — 2027 FOMC 排程預填(federalreserve.gov 公開,2027/Q4 需更新 2028 排程)
    "2027-01-27", "2027-03-17", "2027-04-28", "2027-06-16",
    "2027-07-28", "2027-09-22", "2027-11-03", "2027-12-15",
]
BOJ_SCHEDULE = [
    # 2026 BOJ 排程(boj.or.jp 公開)
    "2026-01-22", "2026-03-19", "2026-04-30", "2026-06-17",
    "2026-07-31", "2026-09-18", "2026-10-30", "2026-12-18",
    # V17.0 — 2027 BOJ 排程預填(boj.or.jp 公開,2027/Q4 需更新 2028 排程)
    "2027-01-22", "2027-03-19", "2027-04-30", "2027-06-17",
    "2027-07-30", "2027-09-22", "2027-10-29", "2027-12-17",
]


# ═══ 🤖 V70.3.0 Groq 輪動呼叫(採礦端 AI;財經行事曆解讀用) ═══
_groq_env_mm = os.environ.get("GROQ_API_KEYS") or os.environ.get("GROQ_API_KEY", "")
GROQ_KEYS_MM = [t.strip() for t in _groq_env_mm.split(",") if t.strip()]
GROQ_URL_MM = "https://api.groq.com/openai/v1/chat/completions"
# llama-3.3-70b:行事曆解讀屬「質化判讀」,用 70b 比 8b 準(專案 AI 分工鐵則:輕量判讀走 Groq)
GROQ_MODEL_MM = "llama-3.3-70b-versatile"


def _groq_chat_mm(messages, label="", max_tokens=1400, temperature=0.4):
    """429 自動換 key;全失敗回 None(呼叫端一律要能接受 None)。"""
    if not GROQ_KEYS_MM:
        print(f"  ⚠️ [Groq] 無 GROQ_API_KEYS,跳過 {label}")
        return None
    payload = {"model": GROQ_MODEL_MM, "messages": messages,
               "temperature": temperature, "max_tokens": max_tokens}
    for i, key in enumerate(GROQ_KEYS_MM):
        try:
            # 🐛 V71.3.9 這裡原本寫 http_session —— macro_miner 根本沒有這個名字
            #    (本檔的 session 叫 http,定義在 L455)。每次呼叫都 NameError,
            #    又剛好被下面的 `except Exception` 吞掉只印「例外 NameError」,
            #    所以財經行事曆的 AI 解讀**從上線到現在一次都沒成功過**
            #    (實測 gh-pages 的 macro_risk.json:macro_events_ai 一直是空的)。
            r = http.post(GROQ_URL_MM, json=payload,
                                  headers={"Authorization": f"Bearer {key}",
                                           "Content-Type": "application/json"}, timeout=45)
            if r.status_code == 429:
                print(f"  ⏳ [Groq] key#{i+1} 429,換下一把")
                continue
            if r.status_code != 200:
                print(f"  ⚠️ [Groq] HTTP {r.status_code} key#{i+1}: {r.text[:120]}")
                continue
            return (r.json().get("choices") or [{}])[0].get("message", {}).get("content", "").strip()
        except Exception as e:
            print(f"  ⚠️ [Groq] 例外 key#{i+1}: {type(e).__name__}")
    return None


# ═══ 🧠 V71.3.9 Gemini 2.5 Flash(財經行事曆「深度判讀」主力,Groq 退居備援)═══
#   為什麼換:專案 AI 分工鐵則寫得很清楚 —— 輕量翻譯/簡訊走 Groq,**深度判讀走 Gemini**。
#   財經行事曆是「看未來兩週的事件 × 當下市場狀態 → 給具體操作建議」,屬深度判讀,
#   本來就該用 Gemini,之前用 llama-3.3-70b 是將就。
#   規格照專案既有 Gemini 慣例:safetySettings 四大類全 BLOCK_NONE(財經字眼常被誤攔)
#   + thinkingBudget=0(省預算、避免 2.5 Thinking 把 token 吃光導致輸出爆短)
#   + systemInstruction(避免廢話開場)。
#   ⚠️ 拿不到 key 或呼叫失敗一律回 None → 上層自動退回 Groq,不會讓行事曆解讀開天窗。
GEMINI_KEYS_MM = [t.strip() for t in (os.environ.get("GEMINI_API_KEYS")
                                      or os.environ.get("GEMINI_API_KEY", "")).split(",") if t.strip()]
GEMINI_MODEL_MM = "gemini-2.5-flash"


def _gemini_chat_mm(sys_msg, user_msg, label="", max_tokens=1400, temperature=0.4):
    if not GEMINI_KEYS_MM:
        return None
    payload = {
        "systemInstruction": {"parts": [{"text": sys_msg}]},
        "contents": [{"role": "user", "parts": [{"text": user_msg}]}],
        "generationConfig": {"temperature": temperature, "maxOutputTokens": max_tokens,
                             "thinkingConfig": {"thinkingBudget": 0}},
        "safetySettings": [{"category": c, "threshold": "BLOCK_NONE"} for c in (
            "HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH",
            "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT")],
    }
    for i, key in enumerate(GEMINI_KEYS_MM):
        try:
            url = (f"https://generativelanguage.googleapis.com/v1beta/models/"
                   f"{GEMINI_MODEL_MM}:generateContent?key={key}")
            r = http.post(url, json=payload,
                          headers={"Content-Type": "application/json"}, timeout=60)
            if r.status_code == 429:
                print(f"  ⏳ [Gemini] key#{i+1} 429,換下一把")
                continue
            if r.status_code != 200:
                print(f"  ⚠️ [Gemini] HTTP {r.status_code} key#{i+1}: {r.text[:120]}")
                continue
            j = r.json()
            parts = ((j.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
            txt = "".join(p.get("text", "") for p in parts).strip()
            if txt:
                print(f"  🧠 [Gemini {GEMINI_MODEL_MM}] {label} 成功")
                return txt
            print(f"  ⚠️ [Gemini] key#{i+1} 回空(finishReason="
                  f"{(j.get('candidates') or [{}])[0].get('finishReason')})")
        except Exception as e:
            print(f"  ⚠️ [Gemini] 例外 key#{i+1}: {type(e).__name__}")
    return None


def build_macro_events_ai(out):
    """📅 V70.3.0 財經行事曆 AI 解讀(使用者要求:後端 Groq 分析)。
    輸入:未來 14 日事件 + 當下市場狀態(VIX/外資期貨/加權位階/融資水位)。
    輸出:{summary, focus:[{date,event,impact,action}]} 寫進 macro_risk.json.macro_events_ai。
    鐵則:①禁 AI 算數 → 所有數字由這裡算好塞進 prompt ②AI 只做「事件→影響→怎麼做」的質化判讀
         ③失敗回 None 不影響主流程 ④燈號用 ✅⚠️⛔(紅綠只代表漲跌)。"""
    evs = out.get("upcoming_macro_events") or []
    if not evs:
        return None
    # 只餵「宏觀核彈事件」(法說會逐檔太多、前端另有折疊區),最多 12 筆
    import re as _re
    macro_evs = [e for e in evs if not _re.search(r"法說|法人說明會", str(e.get("event", "")))][:12]
    if not macro_evs:
        return None
    ev_lines = "\n".join(f"- {e['date']} {e['event']}(重要度 {e.get('severity', 'low')})" for e in macro_evs)
    # 市場現況(數字全部後端算好,AI 不准自己算)
    def _n(k, unit="", d=1):
        v = out.get(k)
        if v is None:
            return "無資料"
        try:
            return f"{float(v):.{d}f}{unit}"
        except Exception:
            return str(v)
    fi_fut = out.get("fi_futures_net")
    fi_txt = f"{int(fi_fut):,} 口" if isinstance(fi_fut, (int, float)) else "無資料"
    state = (
        f"VIX {_n('vix')}、標普昨日 {_n('sp500_chg_pct', '%', 2)}、"
        f"外資台指期未平倉 {fi_txt}、台幣 5 日 {_n('usdtwd_chg_5d', '%', 2)}(正=貶)、"
        f"韓股 {_n('kospi_chg_pct', '%', 2)}、日經 {_n('nikkei_chg_pct', '%', 2)}、"
        f"恐懼貪婪 {_n('fear_greed', '', 0)}、台指VIX {_n('tw_vix')}"
    )
    sys_msg = (
        "你是台股資深策略分析師,講白話文,像跟朋友解盤。"
        "鐵則:①只解讀事件對台股的影響,絕對不要自己計算或杜撰任何數字(所有數字我已給你,直接引用)。"
        "②不確定的事就說不確定,不要編造「市場預期 X%」這種假數據。"
        "③台股慣例紅漲綠跌,燈號只用 ✅(可照常操作)⚠️(留意)⛔(避開/降部位),不要用紅綠燈符號表示危險。"
        "④每則建議必須具體可執行(要不要留倉、幾成部位、盯什麼)。"
    )
    user_msg = (
        f"【未來 14 日台股相關事件】\n{ev_lines}\n\n"
        f"【目前市場狀態(數字為實測,直接引用勿改)】\n{state}\n\n"
        "請輸出 JSON(不要 markdown 圍欄,直接輸出物件):\n"
        '{"summary":"這兩週最該注意什麼,2-3 句白話,講清楚現在市場狀態下這些事件的風險等級",'
        '"focus":[{"date":"YYYY-MM-DD","event":"事件簡稱","impact":"對台股/哪些族群的實際影響,一句話",'
        '"action":"具體操作建議(留倉與否/部位幾成/盯什麼價位或指標)","level":"✅或⚠️或⛔"}]}\n'
        "focus 只挑最重要的 3-5 個事件(依重要度與逼近程度),不要全列。"
    )
    # ⚡ V71.4.0 夜間自動採礦走「輕量」Groq,深度 Gemini 留給白天手動觸發。
    #   使用者的用法:晚上採礦每天都跑,用便宜的 Groq 先給一版「快速解讀」就夠;
    #   白天真的看到某件事覺得重要,再由前端按鈕手動叫 Gemini 深度分析覆蓋。
    #   這樣 Gemini 額度只花在「你真的在意的那幾次」,不會被每天 5 次的排程燒光。
    #   (V71.3.9 曾把順序反過來 —— 那會讓每天自動跑都吃 Gemini 額度,不符實際用法。)
    #   Gemini 仍留著當備援:Groq 全掛時頂上,行事曆解讀不開天窗。
    _engine = "groq"
    raw = _groq_chat_mm([{"role": "system", "content": sys_msg},
                         {"role": "user", "content": user_msg}], label="財經行事曆解讀(夜間輕量)")
    if not raw:
        _engine = "gemini"
        raw = _gemini_chat_mm(sys_msg, user_msg, label="財經行事曆解讀(Groq 失敗,退 Gemini)")
    if not raw:
        return None
    # JSON 防呆:剝除可能的 markdown 圍欄
    txt = raw.strip()
    if txt.startswith("```"):
        txt = _re.sub(r"^```[a-zA-Z]*\s*", "", txt)
        txt = _re.sub(r"\s*```$", "", txt)
    try:
        data = json.loads(txt)
    except Exception:
        m = _re.search(r"\{[\s\S]*\}", txt)
        if not m:
            print("  ⚠️ 行事曆 AI 回傳非 JSON,放棄(保留舊解讀)")
            return None
        try:
            data = json.loads(m.group(0))
        except Exception:
            print("  ⚠️ 行事曆 AI JSON 解析失敗,放棄")
            return None
    if not isinstance(data, dict) or not data.get("summary"):
        return None
    focus = [f for f in (data.get("focus") or []) if isinstance(f, dict) and f.get("event")][:5]
    return {
        "updated": datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M"),
        # 🧠 V71.3.9 誠實標示實際用哪個引擎產的(前端/日後除錯要看得出來)
        "model": (GEMINI_MODEL_MM if _engine == "gemini" else GROQ_MODEL_MM),
        "summary": str(data.get("summary", ""))[:400],
        "focus": [{
            "date": str(f.get("date", ""))[:10],
            "event": str(f.get("event", ""))[:60],
            "impact": str(f.get("impact", ""))[:200],
            "action": str(f.get("action", ""))[:200],
            "level": f.get("level") if f.get("level") in ("✅", "⚠️", "⛔") else "⚠️",
        } for f in focus],
    }


def _warn_schedule_expiry(today):
    """📅 V71.3.9 硬編碼排程表到期自我提醒。

    FOMC / BOJ 的開會日期是寫死的清單(federalreserve.gov / boj.or.jp 公開排程),
    排到 2027 年底就沒了。到期後不會報錯 —— 行事曆只是「靜靜地」再也不出現
    FOMC 和日銀,而這兩個剛好是影響最大的事件。這種靜默失效最難發現,
    所以剩不到 120 天就開始在 log 大聲喊,提醒回來補下一年度排程。
    (對應使用者定的鐵則:寫死的對照表要有更新機制,否則會過期。)
    """
    try:
        for nm, sched in (('FOMC', FOMC_SCHEDULE), ('BOJ', BOJ_SCHEDULE)):
            ds = sorted(d for d in sched if isinstance(d, str))
            if not ds:
                continue
            last = datetime.strptime(ds[-1], '%Y-%m-%d').date()
            left = (last - today).days
            if left < 0:
                print(f"  🚨 {nm} 排程表已於 {ds[-1]} 用完 —— 財經行事曆從此不再出現 {nm},請補下一年度排程!")
            elif left <= 120:
                print(f"  ⚠️ {nm} 排程表只排到 {ds[-1]}(剩 {left} 天)→ 請盡快補下一年度,否則到期後行事曆會靜靜少掉 {nm}")
    except Exception as _e:
        print(f"  ⚠️ 排程到期檢查略過:{str(_e)[:60]}")


def _compute_upcoming_macro_events(today, window_days=14):
    """演算法計算未來 N 天的全球重大財經事件,純函式無 IO,絕對不會拋例外。
    14 天視窗(2026/06 起,從 7 → 14 涵蓋更多籌備期事件)。
    涵蓋類別:
      ✅ 全球結算:台指期大結算、美股四巫日
      ✅ 美國總經:CPI、PPI、NFP 非農、ISM PMI、FOMC、BOJ
      ✅ 台股財報:月營收旺季、季報法定截止、Q 季法說旺季廣域提醒
      ✅ 台股股權:股東會旺季+法定截止、除權息旺季月度提醒
      ✅ 台股政策:央行理監事會
      ✅ 被動資金:MSCI 季度權重調整
      ✅ 連假效應:西曆固定連假(春節/端午/中秋因農曆寫進 manual_events.json)
      ✅ 一次性:manual_events.json"""
    from datetime import date, timedelta
    if not isinstance(today, date):
        today = date.today()
    end = today + timedelta(days=window_days)
    events = []

    def _add(d, evt):
        """單筆加事件 helper(只加 window 內事件,避免重複包 if/append)。"""
        if today < d <= end:
            events.append({"date": d.isoformat(), "event": evt})

    # 預先算下 3 個月(避免月底逼近時漏算下個月初的事件;_add 會擋掉 window 外)
    months_to_check = []
    cur_y, cur_m = today.year, today.month
    for off in range(3):
        ny, nm = cur_y, cur_m + off
        while nm > 12:
            ny += 1
            nm -= 12
        months_to_check.append((ny, nm))

    for year, month in months_to_check:
        first = date(year, month, 1)
        if month < 12:
            last_day = date(year, month + 1, 1) - timedelta(days=1)
        else:
            last_day = date(year + 1, 1, 1) - timedelta(days=1)

        # ── 既有:結算/四巫日/CPI/PPI ────────────────────────────────────
        third_wed = first + timedelta(days=((2 - first.weekday()) % 7) + 14)
        _add(third_wed, "🇹🇼 台指期貨大結算 (提防外資結算洗盤)")

        if month in (3, 6, 9, 12):
            third_fri = first + timedelta(days=((4 - first.weekday()) % 7) + 14)
            _add(third_fri, "🇺🇸 美股四巫日 (選擇權結算,波動激增)")

        cpi_d = None
        for day in range(10, 15):
            try:
                cand = date(year, month, day)
            except ValueError:
                continue
            if cand.weekday() < 5:
                cpi_d = cand
                break
        if cpi_d is not None:
            _add(cpi_d, "🇺🇸 美國 CPI 通膨數據公布 (Fed 政策風向球)")
            ppi_d = cpi_d + timedelta(days=1)
            while ppi_d.weekday() >= 5:
                ppi_d += timedelta(days=1)
            _add(ppi_d, "🇺🇸 美國 PPI 生產者物價指數")

        # ── 🆕 新增 9 類台股關鍵事件 ───────────────────────────────────

        # 1️⃣ 月營收公布旺季:每月 5 日(法定 10 日截止前密集)
        try:
            _add(date(year, month, 5), f"📊 {month}月份 月營收公布旺季 (5-10 日全市場陸續公布)")
        except ValueError:
            pass

        # 2️⃣ 非農就業 NFP:每月第一個週五
        first_fri = first + timedelta(days=(4 - first.weekday()) % 7)
        _add(first_fri, "🇺🇸 美國非農就業 NFP (失業率/時薪同步公布,Fed 政策參考)")

        # 3️⃣ ISM 製造業 PMI:每月第一個工作日
        first_workday = first
        while first_workday.weekday() >= 5:
            first_workday += timedelta(days=1)
        _add(first_workday, "🇺🇸 美國 ISM 製造業 PMI (景氣領先指標)")

        # 4️⃣ 季報法定截止:5/15 (Q1)、8/14 (Q2)、11/14 (Q3)、3/31 (Q4+年報)
        season_deadlines = {3: (31, "Q4+年報"), 5: (15, "Q1"),
                            8: (14, "Q2"), 11: (14, "Q3")}
        if month in season_deadlines:
            day_n, q_label = season_deadlines[month]
            try:
                _add(date(year, month, day_n), f"📈 {q_label} 季報法定截止日 (未繳交=注意股風險)")
            except ValueError:
                pass

        # 5️⃣ Q 季法說旺季廣域提醒:1/4/7/10 月 15 日
        qs_map = {1: "Q4", 4: "Q1", 7: "Q2", 10: "Q3"}
        if month in qs_map:
            try:
                _add(date(year, month, 15), f"📞 {qs_map[month]} 法說旺季 (大型權值股密集召開,留意異動)")
            except ValueError:
                pass
            # 🆕 V50.6 台積電法說(權值王,全市場最看的法說,約每季中):Jan16/Apr17/Jul17/Oct16 → 取該月第一個 ≥ 該日的平日
            _tsmc_day = {1: 16, 4: 17, 7: 17, 10: 16}[month]
            try:
                _d = date(year, month, _tsmc_day)
                while _d.weekday() >= 5:   # 落到週末順延到週一
                    _d += timedelta(days=1)
                _add(_d, f"📞 台積電(2330){qs_map[month]}法說會 (權值王財測=全市場風向,前後波動大)")
            except ValueError:
                pass

        # 6️⃣ 股東會旺季 + 法定截止
        if month == 5:
            try:
                _add(date(year, 5, 30), "🏛️ 股東會旺季開跑 (6/30 法定截止前密集召開)")
            except ValueError:
                pass
        if month == 6:
            _add(date(year, 6, 30), "🏛️ 股東會法定截止日 (錯過視同違規)")

        # 7️⃣ 除權息旺季(7-9 月):月度提醒
        if month == 7:
            _add(date(year, 7, 1), "💰 除權息旺季開跑 (7-9 月密集,大型權值股蒸發指數點)")
        if month == 8:
            _add(date(year, 8, 15), "💰 除權息高峰期 (填息/貼息評估動能)")
        if month == 9:
            _add(date(year, 9, 30), "💰 除權息旺季收尾")

        # 8️⃣ 央行(中央銀行)理監事會:3/6/9/12 月最後一個週四
        if month in (3, 6, 9, 12):
            cb_d = last_day
            while cb_d.weekday() != 3:   # Thu=3
                cb_d -= timedelta(days=1)
            _add(cb_d, "🇹🇼 央行理監事會 (利率/外匯政策決議)")

        # 9️⃣ MSCI 季度權重調整:2/5/8/11 月第三個週四(收盤生效)
        if month in (2, 5, 8, 11):
            third_thu = first + timedelta(days=((3 - first.weekday()) % 7) + 14)
            _add(third_thu, "📊 MSCI 季度權重調整 (被動資金流向,大型股波動激增)")

        # 🔟 西曆固定連假(春節/端午/中秋因農曆建議寫進 manual_events.json)
        holidays = [(1, 1, "🎊 元旦"), (4, 4, "🌸 清明節"),
                    (10, 10, "🇹🇼 雙十國慶"), (12, 31, "🎆 跨年")]
        for hm, hd, name in holidays:
            if hm == month:
                try:
                    _add(date(year, hm, hd), f"{name} (台股休市,連假前後流動性低)")
                except ValueError:
                    pass

    # ── 預編排事件:FOMC、BOJ 利率決議 ──
    for d_str in FOMC_SCHEDULE:
        try:
            dd = date.fromisoformat(d_str)
        except ValueError:
            continue
        _add(dd, "🇺🇸 FOMC 聯準會利率決議 (終極利空/利多)")
    for d_str in BOJ_SCHEDULE:
        try:
            dd = date.fromisoformat(d_str)
        except ValueError:
            continue
        _add(dd, "🇯🇵 日銀 BOJ 利率決議 (套息交易風向球)")

    # ── 一次性事件:讀 data/manual_events.json(Claude 代為更新)──
    try:
        manual_file = Path(__file__).parent / 'data' / 'manual_events.json'
        if manual_file.exists():
            manual_data = json.loads(manual_file.read_text(encoding='utf-8'))
            for e in manual_data.get('events', []):
                try:
                    ev_date = date.fromisoformat(e['date'])
                except (ValueError, KeyError):
                    continue
                _add(ev_date, e['event'])
    except Exception as _e:
        print(f"   ⚠️ manual_events.json 讀取失敗(不影響其他):{_e}")

    # 去重 + 依日期升冪排序
    seen = set()
    uniq = []
    for e in sorted(events, key=lambda x: (x["date"], x["event"])):
        sig = (e["date"], e["event"])
        if sig in seen:
            continue
        seen.add(sig)
        uniq.append(e)

    # 🚨 事件分級:依關鍵字標 severity(高/中/低)+ direction(利多/利空/震盪)
    #    高 = D-1/D-0 必須跳紅色 banner + 連動黑天鵝矩陣 +5 風險分
    #    中 = 預先提醒,降低新單部位
    #    低 = 一般行事曆,無需特別動作
    HIGH_KW   = ['FOMC', '聯準會', 'BOJ', '日銀', 'CPI', '通膨', 'NFP', '非農', '台指期貨大結算',
                 '四巫', '央行理監事', 'MSCI', '股東會法定截止', '美股四巫']
    MID_KW    = ['PPI', '生產者物價', 'ISM', '製造業 PMI', '季報法定截止', '法說旺季',
                 '股東會旺季', '除權息高峰']
    # 利空關鍵字(同樣寬鬆比對)→ 預設利空,沒命中再看利多
    BEARISH_KW = ['CPI', '通膨', 'FOMC', '聯準會', '日銀', 'BOJ', 'NFP', '非農', '四巫', '結算',
                  '法定截止', '休市', '連假']
    BULLISH_KW = ['法說旺季', '月營收公布旺季', '除權息旺季開跑', '股東會旺季開跑', 'MSCI']

    def _classify(ev_text):
        t = ev_text or ''
        sev = 'low'
        for kw in HIGH_KW:
            if kw in t:
                sev = 'high'; break
        if sev == 'low':
            for kw in MID_KW:
                if kw in t:
                    sev = 'mid'; break
        # 方向:雙鍵字命中走「震盪」(因爆炸性事件結果不確定)
        is_bear = any(kw in t for kw in BEARISH_KW)
        is_bull = any(kw in t for kw in BULLISH_KW)
        if is_bear and is_bull:
            direction = 'volatile'
        elif is_bear:
            direction = 'bearish'
        elif is_bull:
            direction = 'bullish'
        else:
            direction = 'neutral'
        return sev, direction

    for e in uniq:
        sev, direction = _classify(e['event'])
        e['severity'] = sev
        e['direction'] = direction
    return uniq

# Retry-equipped session（任何 5xx / 連線錯誤自動重試 3 次）
http = requests.Session()
http.mount("https://", HTTPAdapter(max_retries=Retry(
    total=3, backoff_factor=1.5,
    status_forcelist=[429, 500, 502, 503, 504],
    allowed_methods=frozenset(["GET", "POST"]),
)))
HEADERS = {"User-Agent": "Mozilla/5.0 macro_miner/1.0"}


def _parse_date_flexible(s):
    """'115/07/17'(民國) / '1150717' / '2026/07/17' / '2026-07-17' → date;失敗回 None。"""
    from datetime import date
    s = str(s or "").strip().replace("-", "/").replace(".", "/")
    if not s:
        return None
    # 純數字 7-8 碼:民國(1150717) 或西元(20260717)
    if s.isdigit() and len(s) in (7, 8):
        if len(s) == 7:      # 民國 YYYMMDD
            y, m, d = int(s[:3]) + 1911, int(s[3:5]), int(s[5:7])
        else:                # 西元 YYYYMMDD
            y, m, d = int(s[:4]), int(s[4:6]), int(s[6:8])
        try: return date(y, m, d)
        except Exception: return None
    parts = [p for p in s.split("/") if p != ""]
    if len(parts) != 3:
        return None
    try:
        y, m, d = int(parts[0]), int(parts[1]), int(parts[2])
        if y < 1911:         # 民國年
            y += 1911
        return date(y, m, d)
    except Exception:
        return None


def fetch_earnings_calls(window_days=14):
    """📞 抓 TWSE OpenAPI 法人說明會(法說會)一覽表 → 回未來 window 天內 [{date, event}]。
    ⚠️ 端點/欄位名可能需依實際回應微調(候選端點,首次跑看 log)。任何失敗回 [],絕不影響主流程。"""
    from datetime import date, timedelta
    today, end = date.today(), date.today() + timedelta(days=window_days)
    candidates = [
        # TWSE OpenAPI 具名 JSON(無 307);_L=上市 _O=上櫃(候選 dataset code,首次跑確認)
        ("https://openapi.twse.com.tw/v1/opendata/t187ap02_L", "上市"),
        ("https://openapi.twse.com.tw/v1/opendata/t187ap02_O", "上櫃"),
    ]

    def _find_key(row, *musts):
        for k in row.keys():
            if all(m in k for m in musts):
                return k
        return None

    out = []
    for url, mk in candidates:
        try:
            r = http.get(url, headers={**HEADERS, "Accept": "application/json"}, timeout=15)
            if r.status_code != 200:
                print(f"  ⚠️ 法說會 {mk} HTTP {r.status_code}(端點可能需調整)")
                continue
            rows = r.json()
            if not isinstance(rows, list) or not rows:
                print(f"  ⚠️ 法說會 {mk} 回非陣列/空")
                continue
            k_date = _find_key(rows[0], "說明會", "日期") or _find_key(rows[0], "法說", "日期") or _find_key(rows[0], "日期")
            k_code = _find_key(rows[0], "公司", "代號") or _find_key(rows[0], "代號")
            k_name = _find_key(rows[0], "公司", "名稱") or _find_key(rows[0], "公司", "簡稱") or _find_key(rows[0], "名稱")
            k_time = _find_key(rows[0], "說明會", "時間") or _find_key(rows[0], "時間")
            if not (k_date and k_code):
                print(f"  ⚠️ 法說會 {mk} 找不到日期/代號欄位,keys={list(rows[0].keys())[:8]}")
                continue
            hit = 0
            for row in rows:
                d = _parse_date_flexible(row.get(k_date))
                code = str(row.get(k_code) or "").strip()
                name = str((row.get(k_name) if k_name else "") or "").strip()
                if d is None or not code or not (today <= d <= end):
                    continue
                t = str((row.get(k_time) if k_time else "") or "").strip()
                ev = f"📞 {name}({code}) 法說會" + (f" {t}" if t else "")
                out.append({"date": d.isoformat(), "event": ev})
                hit += 1
            print(f"  📞 法說會 {mk}: {hit} 場(窗內 {window_days} 天)")
        except Exception as e:
            print(f"  ⚠️ 法說會 {mk} 例外:{str(e)[:70]}")
    # 去重 + 依日期排序
    seen, uniq = set(), []
    for e in sorted(out, key=lambda x: x["date"]):
        kk = (e["date"], e["event"])
        if kk in seen:
            continue
        seen.add(kk)
        uniq.append(e)
    return uniq


def fetch_us10y_yield():
    """美債 10Y 殖利率 (^TNX，數值 = 殖利率 * 10，需 /10 還原 %)"""
    try:
        import yfinance as yf
        t = yf.Ticker("^TNX")
        hist = t.history(period="5d", auto_adjust=False)
        if hist is None or hist.empty:
            return None, "yfinance 回空"
        last_close = float(hist["Close"].iloc[-1])
        # ^TNX 的值即為殖利率（已是 %），不需再除 10
        # 但部分 yfinance 版本回傳 *10，做防呆判斷
        if last_close > 20:   # 殖利率不可能 > 20%，代表是 *10 版本
            last_close = last_close / 10
        return round(last_close, 3), None
    except Exception as e:
        print(f"  ⚠️ US10Y 抓取失敗: {e}")
        return None, str(e)[:100]


def _fetch_bfi82u_rows():
    """🌅 V41.3 — TWSE 三大法人買賣金額統計表(BFI82U)統一抓取器。
    回 ([(單位名稱, 買賣差額_元), ...], date_str, error)。

    根因:原本只打 www.twse.com.tw 的 rwd 端點,GHA runner 常被回 HTTP 307(WAF/轉址)
    → 外資現貨/投信/自營/合計 全採不到。改「官方 OpenAPI 為主、rwd 為備援」:
      ① openapi.twse.com.tw/v1/fund/BFI82U — 具名 JSON、專為程式存取、無 307,最穩。
      ② 失敗才 fallback 舊 rwd 端點(維持原行為,不會比現況更糟)。
    """
    # ① 官方 OpenAPI(dict 陣列,鍵:單位名稱 / 買賣差額)
    try:
        r = http.get("https://openapi.twse.com.tw/v1/fund/BFI82U",
                     headers={**HEADERS, "Accept": "application/json"}, timeout=12)
        if r.status_code == 200:
            arr = r.json()
            rows = []
            for o in (arr or []):
                if not isinstance(o, dict):
                    continue
                name = str(o.get("單位名稱") or o.get("name") or "").replace(" ", "")
                diff = o.get("買賣差額") or o.get("差額") or o.get("買賣超") or ""
                try:
                    rows.append((name, int(str(diff).replace(",", ""))))
                except (ValueError, TypeError):
                    pass
            if rows:
                print(f"  [BFI82U/OpenAPI] 命中 {len(rows)} 列")
                return rows, datetime.now(timezone(timedelta(hours=8))).strftime("%Y%m%d"), None  # 🐛 修:用台北時區,避免 UTC runner 跨午夜標錯交易日
            print("  [BFI82U/OpenAPI] 回 200 但解析 0 列,改試 rwd")
        else:
            print(f"  [BFI82U/OpenAPI] HTTP {r.status_code},改試 rwd")
    except Exception as e:
        print(f"  ⚠️ BFI82U OpenAPI 失敗({e}),改試 rwd")

    # ② 備援:舊 rwd 端點(array-of-arrays,需找「買賣差額」欄位 index)
    try:
        url = "https://www.twse.com.tw/rwd/zh/fund/BFI82U?type=day&response=json"
        r = http.get(url, headers=HEADERS, timeout=10, allow_redirects=True)
        if r.status_code != 200:
            return None, None, f"HTTP {r.status_code}"
        j = r.json()
        data = j.get("data") or []
        date_str = j.get("date") or datetime.now(timezone(timedelta(hours=8))).strftime("%Y%m%d")  # 🐛 修:台北時區
        if not data:
            return None, date_str, "BFI82U 回 0 列"
        fields = j.get("fields") or []
        diff_idx = None
        for i, f in enumerate(fields):
            f = (f or "").replace(" ", "")
            if "差額" in f or "買賣超" in f:
                diff_idx = i
                break
        if diff_idx is None:
            diff_idx = len(data[0]) - 1 if data and len(data[0]) > 1 else None
        rows = []
        for row in data:
            name = (row[0] or "").replace(" ", "")
            try:
                rows.append((name, int(str(row[diff_idx]).replace(",", ""))))
            except (ValueError, IndexError, TypeError):
                pass
        if not rows:
            return None, date_str, "解析 0 列"
        print(f"  [BFI82U/rwd] 命中 {len(rows)} 列")
        return rows, date_str, None
    except Exception as e:
        print(f"  ⚠️ BFI82U rwd 也失敗: {e}")
        return None, None, str(e)[:100]


def fetch_foreign_spot_net():
    """TWSE 三大法人買賣超 — 外資（買賣差額，單位：億元）。
    寬鬆比對「外資」字頭,累加所有外資相關列(含「外資及陸資」「外資自營商」)。"""
    import re
    rows, date_str, err = _fetch_bfi82u_rows()
    if not rows:
        return None, date_str, err
    total_net_yuan = 0
    matched_rows = []
    for name, val in rows:
        if re.search(r"外資", name):
            total_net_yuan += val
            matched_rows.append((name, val))
    if not matched_rows:
        print(f"  [BFI82U] 找不到外資列,全部 names={[n for n, _ in rows]}")
        return None, date_str, "找不到外資列"
    print(f"  [BFI82U] 外資命中:{matched_rows}（合計 {total_net_yuan / 1e8:.2f} 億）")
    return round(total_net_yuan / 1e8, 2), date_str, None  # 億元


def fetch_three_inst_net():
    """🌅 V36.8 — TWSE BFI82U 三大法人:投信 / 自營商 / 三大法人合計買賣超(億元)。
    回 {trust, dealer, total} 億元(抓不到的鍵為 None)+ date + error。"""
    rows, date_str, err = _fetch_bfi82u_rows()
    if not rows:
        return {}, date_str, err
    trust_y, dealer_y, total_y = 0, 0, None
    trust_hit, dealer_hit = False, False
    for name, val in rows:
        if "投信" in name:
            trust_y += val; trust_hit = True
        elif "自營" in name and "外資" not in name:   # 自營商(自行買賣)+(避險);🐛 修:排除「外資自營商」(已計入外資,避免自營被重複灌數)
            dealer_y += val; dealer_hit = True
        elif "合計" in name or "三大法人" in name:
            total_y = val
    out = {
        "trust":  round(trust_y / 1e8, 2) if trust_hit else None,
        "dealer": round(dealer_y / 1e8, 2) if dealer_hit else None,
        "total":  round(total_y / 1e8, 2) if total_y is not None else None,
    }
    print(f"  [BFI82U 三大法人] 投信={out['trust']} 自營={out['dealer']} 合計={out['total']} 億")
    return out, date_str, None


# ════════ TAIFEX 官方 OpenAPI JSON（schema 具名、穩定，取代易碎的 CSV/HTML 爬蟲）════════
# 本機沙箱無法直連 taifex（Host not in allowlist），只有 GitHub Actions 可達；
# 故採「多候選端點 + 中/英 key 模糊比對 + 失敗 dump 全部 key」設計，讓 CI log 必能揭露真實 schema。
TAIFEX_OPENAPI_BASE = "https://openapi.taifex.com.tw/v1/"
_TAIFEX_OPENAPI_UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "application/json",
}
# 三大法人-區分各期貨契約-依日期 OpenAPI 端點（probe swagger 已確認正確名）
# 實測 keys: Date / ContractCode(商品中文名) / Item(身份別) / OpenInterest(Net|Long|Short) …
_TAIFEX_INST_ENDPOINTS = [
    "MarketDataOfMajorInstitutionalTradersDetailsOfFuturesContractsBytheDate",
]


def _taifex_openapi(paths):
    """依序試候選 OpenAPI 端點，回傳 (list_of_dicts, None)；全失敗回 (None, 診斷字串)。
    任一端點 200 且 body 為非空 list 即採用，並印出第一列 keys 供 schema 確認。"""
    diag = []
    for p in paths:
        url = TAIFEX_OPENAPI_BASE + p
        try:
            r = http.get(url, headers=_TAIFEX_OPENAPI_UA, timeout=20)
            if r.status_code != 200:
                diag.append(f"{p}:HTTP{r.status_code}")
                continue
            data = r.json()
            if isinstance(data, list) and data and isinstance(data[0], dict):
                print(f"  [TAIFEX OpenAPI] ✅ {p} 回 {len(data)} 列；keys={list(data[0].keys())}")
                return data, None
            diag.append(f"{p}:非list/空({type(data).__name__})")
        except Exception as e:
            diag.append(f"{p}:{str(e)[:40]}")
    return None, "OpenAPI 全失敗 → " + " | ".join(diag)


def _find_key(row, candidates):
    """回 row 中第一個『key 含任一 candidate 子字串』的 (key, value)；找不到回 (None, None)。"""
    for k in row.keys():
        kk = str(k)
        for c in candidates:
            if c in kk:
                return k, row[k]
    return None, None


def _row_pick(row, *substrs):
    """在 dict row 的 key 裡找『同時包含全部 substrs』的第一個鍵，回值轉 float（去逗號）；否則 None。"""
    for k, v in row.items():
        kk = str(k)
        if all(s in kk for s in substrs):
            try:
                return float(str(v).replace(",", "").strip())
            except (ValueError, AttributeError, TypeError):
                return None
    return None


# 實測 OpenAPI 欄位（英文）：商品=ContractCode、身份=Item、淨/多/空未平倉口數=OpenInterest(Net|Long|Short)
_PROD_KEYS = ['ContractCode', '商品名稱', '商品', '契約', 'ContractName', 'Commodity']
_IDENT_KEYS = ['Item', '身份別', '身分別', 'Identity', 'InstitutionalInvestor', 'Investors', '法人']


def _taifex_sum_net_oi(rows, product_match, want_identity=None):
    """三大法人 OpenAPI rows → 加總『多空淨額未平倉口數』OpenInterest(Net)。
    product_match(prod_str)->bool 決定該列商品是否納入；want_identity=None 表加總全部身份別
    （外資身份實際字串為「外資及陸資」，故用子字串 '外資' 比對即可命中）。
    回 (net_total, long_short_sum, 命中列數, 全部商品名集合)。"""
    net_total = 0.0
    ls_sum = 0.0
    matched = 0
    seen_products = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        _, prod = _find_key(row, _PROD_KEYS)
        if prod is not None and str(prod).strip():
            seen_products.add(str(prod).strip()[:24])
        if prod is None or not product_match(str(prod)):
            continue
        if want_identity is not None:
            _, ident = _find_key(row, _IDENT_KEYS)
            if ident is None or want_identity not in str(ident):
                continue
        # 淨未平倉口數：實測英文 'OpenInterest(Net)'（dict 順序在 ContractValueof… 之前，子字串首匹配即正確）
        net = _row_pick(row, 'OpenInterest(Net)')
        if net is None:
            net = _row_pick(row, '多空淨額', '未平倉', '口數')  # 中文 fallback
        if net is None:
            continue
        net_total += net
        long_oi = _row_pick(row, 'OpenInterest(Long)') or _row_pick(row, '多方', '未平倉', '口數') or 0
        short_oi = _row_pick(row, 'OpenInterest(Short)') or _row_pick(row, '空方', '未平倉', '口數') or 0
        ls_sum += (long_oi + short_oi)
        matched += 1
    return net_total, ls_sum, matched, seen_products


def fetch_foreign_futures_net():
    """TAIFEX 外資臺指期 OI 淨口數（多空淨額未平倉口數）
    ① 優先官方 OpenAPI JSON（schema 穩定）② 失敗退 CSV 端點 ③ 再退 HTML regex
    """
    # ── ① 官方 OpenAPI JSON ──
    data, err = _taifex_openapi(_TAIFEX_INST_ENDPOINTS)
    if data:
        net, _ls, matched, seen = _taifex_sum_net_oi(
            data, lambda p: "臺股期貨" in p, want_identity="外資")
        if matched > 0:
            print(f"  [TAIFEX OpenAPI] 外資臺指期 淨未平倉={int(net)} 口")
            return int(net), None
        print(f"  [TAIFEX OpenAPI] 外資臺指期未匹配；keys={list(data[0].keys())}；商品名={sorted(seen)[:20]}")
    else:
        print(f"  [TAIFEX OpenAPI] 外資期貨端點失敗：{err}")

    # ── ② 原 CSV 端點（保留為 fallback）──
    return _fetch_foreign_futures_net_csv()


def _fetch_foreign_futures_net_csv():
    """原本的 CSV 端點解析（/cht/3/futContractsDateDown）→ 保留為 OpenAPI 失敗時 fallback。"""
    try:
        import csv
        import io
        import re
        url = "https://www.taifex.com.tw/cht/3/futContractsDateDown"
        today_str = datetime.now().strftime("%Y/%m/%d")
        payload = {
            "queryType": "1",
            "marketCode": "0",
            "dateaddcnt": "",
            "commodity_id": "TXF",
            "queryDate": today_str,
        }
        r = http.post(url, data=payload, headers=HEADERS, timeout=10)
        if r.status_code != 200:
            return None, f"CSV HTTP {r.status_code}"
        text = r.text
        # CSV 可能是 BIG5；嘗試 BIG5 / UTF-8 兩個編碼
        try:
            r.encoding = "big5"
            text = r.text
        except Exception:
            pass
        if "外資" not in text and "Foreign" not in text:
            # fallback：原 HTML parser，保留向下相容
            print(f"  [TAIFEX] CSV 無外資資料，前 200 字：{text[:200]}")
            return _fetch_taifex_html_fallback()
        rows = list(csv.reader(io.StringIO(text)))
        if not rows:
            return None, "CSV 空白"
        print(f"  [TAIFEX] CSV header={rows[0][:6]} rows={len(rows)}")
        # 找「外資」+「臺股期貨/TX」交集列
        for row in rows[1:]:
            if len(row) < 8:
                continue
            joined = "".join(row[:4])
            if "外資" in joined and ("臺股期貨" in joined or "TX" in joined.upper()):
                # 淨 OI 口數通常在第 8 欄附近（不同版本欄位有偏移），用 regex 找第 5 個數字
                nums = []
                for c in row:
                    s = str(c).replace(",", "").strip()
                    if re.fullmatch(r"-?\d+", s):
                        nums.append(int(s))
                if len(nums) >= 5:
                    # 慣例：[多OI口, 多金額, 空OI口, 空金額, 淨OI口, 淨金額]
                    # 取最後一個合理區間內的淨值 — 第 5 個整數通常就是淨 OI 口數
                    net_oi = nums[4]
                    print(f"  [TAIFEX] 命中外資臺指期，淨OI={net_oi} 口")
                    return net_oi, None
        return None, "CSV 找不到外資+TXF 列"
    except Exception as e:
        print(f"  ⚠️ TAIFEX 外資期貨失敗: {e}")
        return None, str(e)[:100]


def _fetch_taifex_html_fallback():
    """舊版 HTML parser fallback（CSV 失敗時用），保留原本 regex 邏輯"""
    try:
        import re
        url = "https://www.taifex.com.tw/cht/3/futContractsDate"
        today_str = datetime.now().strftime("%Y/%m/%d")
        payload = {
            "queryType": "1",
            "marketCode": "0",
            "dateaddcnt": "",
            "commodity_id": "TXF",
            "queryDate": today_str,
        }
        r = http.post(url, data=payload, headers=HEADERS, timeout=10)
        if r.status_code != 200:
            return None, f"HTML fallback HTTP {r.status_code}"
        html = r.text
        m = re.search(r"外資[^<]*?(?:</td>\s*<td[^>]*>[\s\-,\d]+){8,}", html)
        if not m:
            return None, "TAIFEX 表格結構未匹配"
        chunk = m.group(0)
        nums = re.findall(r"-?[\d,]+", chunk)
        nums = [int(n.replace(",", "")) for n in nums if n.replace(",", "").lstrip("-").isdigit()]
        if len(nums) >= 5:
            return nums[4], None
        return None, "HTML fallback 數值欄位不足"
    except Exception as e:
        return None, str(e)[:100]


def fetch_us2y_yield():
    """美債 2Y — FRED DGS2 CSV；HTTPS 偶爾逾時，3 次 exponential backoff + 鏡像 endpoint 重試
    雙層 fallback：FRED 全敗時退到 yfinance ^IRX(13W) 與 ^FVX(5Y) 內插近似 2Y
    """
    import csv as _csv
    import io as _io
    import requests as _rq
    urls = [
        "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS2",
        "https://fred.stlouisfed.org/data/DGS2.csv",  # 鏡像 endpoint（fallback）
    ]
    ua = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          "Accept": "text/csv,text/plain,*/*"}
    last_err = "FRED DGS2 全失敗"
    # 單發 GET（不走帶 urllib3 Retry 的 http session）→ FRED 在 GH Actions IP 常被封，
    # 用裸 requests + 8s timeout 快速放棄（省下原本最多 ~120s 的重試空轉），直接走 yfinance fallback。
    for url in urls:
        try:
            r = _rq.get(url, headers=ua, timeout=8)
            if r.status_code != 200:
                last_err = f"HTTP {r.status_code} @ {url[:60]}"
                continue
            rows = list(_csv.reader(_io.StringIO(r.text)))
            for row in reversed(rows[1:]):
                if len(row) >= 2 and row[1] not in (".", "", None):
                    try:
                        return round(float(row[1]), 3), None
                    except ValueError:
                        continue
            last_err = "FRED DGS2 無有效值"
        except Exception as e:
            last_err = str(e)[:100]
    # Fallback：yfinance ^IRX(13W) + ^FVX(5Y) 內插近似 2Y（FRED IP 被 GH Actions 阻斷時的救命管道）
    try:
        import yfinance as yf
        irx = yf.Ticker("^IRX").history(period="5d", auto_adjust=False)
        fvx = yf.Ticker("^FVX").history(period="5d", auto_adjust=False)
        if irx is not None and not irx.empty and fvx is not None and not fvx.empty:
            irx_v = float(irx["Close"].iloc[-1])
            fvx_v = float(fvx["Close"].iloc[-1])
            # ^IRX 13週、^FVX 5Y — 2Y 介於其中，用簡單時間距離權重
            # 13週=0.25Y、2Y=2Y、5Y=5Y → 線性內插：w_irx = (5-2)/(5-0.25) = 3/4.75
            approx_2y = round(irx_v * (3 / 4.75) + fvx_v * (1 - 3 / 4.75), 3)
            print(f"  [US2Y fallback] ^IRX={irx_v} ^FVX={fvx_v} → 近似 2Y={approx_2y}")
            return approx_2y, f"FRED 失敗，yfinance 內插（IRX+FVX）"
    except Exception as e:
        last_err = f"FRED+yfinance 全敗：{str(e)[:80]}"
    print(f"  ⚠️ US2Y 三次嘗試皆失敗: {last_err}")
    return None, last_err


# ════════ 🌍 全球巨頭脈動採集（8 大國際資金真實流向）════════
def _fetch_yf_close(ticker, name):
    """通用 yfinance 收盤 + 日漲幅%。
    🛡️ 根治日經/恆生「休市回 NaN → 一直 null」:用 dropna() 取「最後兩筆有效收盤」,
    而非固定 iloc[-1]/[-2](日股港股假日多,最後一格常是 NaN)。
    退階重試:5d 取不到 → 拉長 1mo 再試,涵蓋連假。含防 429:呼叫前小睡。"""
    import time
    last_err = f"{name} 重試後仍失敗"
    periods = ["5d", "1mo"]   # 退階:5 日不夠就拉 1 個月,確保連假後仍有 2 個有效交易日
    for attempt, period in enumerate(periods):
        try:
            time.sleep(0.4 if attempt == 0 else 1.0)
            import yfinance as yf
            hist = yf.Ticker(ticker).history(period=period, auto_adjust=False)
            if hist is None or hist.empty:
                last_err = f"{name} yfinance 回空(period={period})"
                continue
            # dropna 去掉休市/缺值列,取最後兩筆「真實有效」收盤
            closes = hist["Close"].dropna()
            if len(closes) < 2:
                last_err = f"{name} 有效收盤 <2 筆(period={period},疑長假/新上市)"
                continue
            last = float(closes.iloc[-1])
            prev = float(closes.iloc[-2])
            # 雙保險:dropna 後仍自比 NaN(極端髒資料),避免寫進 JSON 變字面 NaN
            if last != last or prev != prev:
                last_err = f"{name} Close 仍含 NaN(資料髒,period={period})"
                continue
            chg_pct = round((last - prev) / prev * 100, 2) if prev > 0 else 0
            return round(last, 2), chg_pct, None
        except Exception as e:
            last_err = str(e)[:100]
            continue
    return None, None, last_err


# ────────────────────────────────────────────────────────────
# 🏦 戰區一升級:FRED 央行貨幣供給(M1B / Fed 資產負債表)
# ────────────────────────────────────────────────────────────
def fetch_fred_series(series_id, days_back=400):
    """通用 FRED CSV fetcher,免費無 key。回傳 list of (date_str, value)。
    GH Actions IP 偶被 FRED 封,失敗即回空 list,不拋例外。
    """
    try:
        end = datetime.now(timezone.utc).date()
        start = end - timedelta(days=days_back)
        url = (f"https://fred.stlouisfed.org/graph/fredgraph.csv"
               f"?id={series_id}&cosd={start.isoformat()}&coed={end.isoformat()}")
        r = requests.get(url, timeout=15,
                         headers={"User-Agent": "Mozilla/5.0 (compatible; macro_miner)"})
        if r.status_code != 200:
            print(f"   ⚠️ FRED {series_id} HTTP {r.status_code}")
            return []
        lines = r.text.strip().split('\n')[1:]
        out = []
        for ln in lines:
            parts = ln.split(',')
            if len(parts) < 2:
                continue
            try:
                v = float(parts[1])
                out.append((parts[0], v))
            except ValueError:
                continue
        return out
    except Exception as e:
        print(f"   ⚠️ FRED {series_id} 失敗:{e}")
        return []


def fetch_m1b_and_fed_assets():
    """M1SL (M1 貨幣供給,月頻) YoY + WALCL (Fed 資產負債表,週頻) 13 週變化。
    M1B YoY 正常 1-3%;>5% 代表熱錢氾濫,易催生資產泡沫。
    Fed 資產 13 週變化:正=QE 放水(風險偏好升);負=QT 縮表(風險偏好降)。
    """
    out = {"m1b_yoy": None, "fed_assets_chg_pct": None}
    m1 = fetch_fred_series("M1SL", days_back=420)
    if len(m1) >= 13:
        try:
            latest_val = m1[-1][1]
            target_date = (datetime.fromisoformat(m1[-1][0]).date()
                           - timedelta(days=365))
            prior = min(m1, key=lambda x: abs(
                (datetime.fromisoformat(x[0]).date() - target_date).days))
            if prior[1] > 0:
                out["m1b_yoy"] = round((latest_val - prior[1]) / prior[1] * 100, 2)
                print(f"   · M1B YoY: {out['m1b_yoy']}%")
        except Exception as e:
            print(f"   ⚠️ M1B YoY 計算失敗: {e}")
    fed = fetch_fred_series("WALCL", days_back=120)
    if len(fed) >= 13:
        try:
            latest_val = fed[-1][1]
            prior = fed[-13][1]
            if prior > 0:
                out["fed_assets_chg_pct"] = round((latest_val - prior) / prior * 100, 2)
                print(f"   · Fed 資產 13 週變化: {out['fed_assets_chg_pct']}%")
        except Exception as e:
            print(f"   ⚠️ Fed 資產計算失敗: {e}")
    return out


# ── 🌪️ V69.7.8 台指選擇權 VIX(FinMind TaiwanOptionVix,Backer;台股自己的恐慌溫度計)──
def fetch_tw_vix():
    """回 (最新 vix, 5日變化%, error)。用 GitHub Secrets FINMIND_TOKENS 第一把;未設/失敗回 None 不崩。"""
    toks = [t.strip() for t in (os.getenv('FINMIND_TOKENS') or os.getenv('FINMIND_TOKEN') or '').split(',') if t.strip()]
    if not toks:
        return None, None, 'no-token'
    sd = (datetime.now(timezone.utc) - timedelta(days=20)).strftime('%Y-%m-%d')
    try:
        res = requests.get('https://api.finmindtrade.com/api/v4/data',
                           params={'dataset': 'TaiwanOptionVix', 'start_date': sd},
                           headers={'Authorization': f'Bearer {toks[0]}'}, timeout=15)
        j = res.json()
        rows = j.get('data') or []
        if not rows:
            return None, None, f"empty(status={j.get('status')})"
        # 每日可能多筆(含 time)→ 取每日最後一筆,再取近 6 個交易日
        by_day = {}
        for r in rows:
            d = str(r.get('date') or '')[:10]
            try:
                v = float(r.get('vix'))
            except (TypeError, ValueError):
                continue
            if d:
                by_day[d] = v
        ds = sorted(by_day.keys())
        if not ds:
            return None, None, 'no-valid-rows'
        cur = by_day[ds[-1]]
        base = by_day[ds[-6]] if len(ds) >= 6 else by_day[ds[0]]
        chg5 = round((cur - base) / base * 100, 1) if base > 0 else None
        return round(cur, 2), chg5, None
    except Exception as e:
        return None, None, str(e)[:80]


def fetch_gold():     return _fetch_yf_close("GC=F",     "黃金")        # 期貨 close usd/oz
def fetch_wti_oil():  return _fetch_yf_close("CL=F",     "WTI 原油")    # usd/barrel
def fetch_dxy():      return _fetch_yf_close("DX-Y.NYB", "美元指數")    # 美元指數
def fetch_btc():      return _fetch_yf_close("BTC-USD",  "比特幣")      # usd
def fetch_vix():      return _fetch_yf_close("^VIX",     "VIX 恐慌指數")
def fetch_nikkei():   return _fetch_yf_close("^N225",    "日經 225")
def fetch_hsi():      return _fetch_yf_close("^HSI",     "恆生指數")
def fetch_kospi():    return _fetch_yf_close("^KS11",    "韓股 KOSPI")
def fetch_jpy():      return _fetch_yf_close("JPY=X",    "日圓匯率")     # ⚠️ JPY=X = USD/JPY(每美元兌幾日圓);日圓升值=此值下跌
def fetch_sp500():    return _fetch_yf_close("^GSPC",    "標普 500")    # 🌎 美股大盤旗艦(台股最強連動)
def fetch_nasdaq():   return _fetch_yf_close("^IXIC",    "那斯達克")    # 🌎 美股科技指標(台積電/半導體連動)
# 💡 V58.7 補齊盤前體檢美股欄(原只在 miner.py 的 macro_cache,會 stale;放進 macro_risk 每 4hr cron 保新鮮)
def fetch_dji():      return _fetch_yf_close("^DJI",     "道瓊")
def fetch_sox():      return _fetch_yf_close("^SOX",     "費半")        # 半導體最連動台股
def fetch_tsm_adr():  return _fetch_yf_close("TSM",      "台積電ADR")    # NYSE:TSM
def fetch_asx_adr():  return _fetch_yf_close("ASX",      "日月光ADR")    # NYSE:ASX(ASE Tech)
def fetch_umc_adr():  return _fetch_yf_close("UMC",      "聯電ADR")      # NYSE:UMC
# 💡 V68.8.2 使用者要求:美股期貨(盤後即時風向,比昨收更即時)+ 美債 10 年殖利率(升=科技股壓力)
def fetch_es_fut():   return _fetch_yf_close("ES=F",     "標普500期貨")   # 小 S&P 期貨
def fetch_ym_fut():   return _fetch_yf_close("YM=F",     "道瓊期貨")     # 小道瓊期貨
def fetch_nq_fut():   return _fetch_yf_close("NQ=F",     "那斯達克期貨")  # 小那斯達克期貨(半導體最連動)
def fetch_ust10y():   return _fetch_yf_close("^TNX",     "美債10年殖利率") # close 值即殖利率%(如 4.25=4.25%)


def fetch_twii_position():
    """V25.4 — 算 ^TWII 在過去 60 日的位置百分位(0=最低,100=最高)
    給 marketMakerIndex 判讀「真低檔護盤」vs「高檔買超警訊」用。
    返回 {price, pos_60d, hi_60d, lo_60d}, 失敗回 {}
    """
    try:
        import yfinance as yf
        import time as _t
        _t.sleep(0.4)
        hist = yf.Ticker("^TWII").history(period='3mo')
        if hist.empty: return {}
        closes = hist['Close'].dropna()
        if len(closes) < 30: return {}
        # 取最近 60 個交易日(若不足 60,用所有可用的)
        recent = closes.iloc[-60:]
        current = float(recent.iloc[-1])
        hi = float(recent.max())
        lo = float(recent.min())
        # 百分位 = 現價在 [lo, hi] 區間的位置(0-100)
        pos = round((current - lo) / (hi - lo) * 100, 1) if hi > lo else 50.0
        return {
            'price':  round(current, 2),
            'pos_60d': pos,
            'hi_60d':  round(hi, 2),
            'lo_60d':  round(lo, 2),
        }
    except Exception as e:
        print(f"   ⚠️ fetch_twii_position 失敗:{e}")
        return {}


# ── 🏭 美股對標 9 細分板塊 ──
# V23.1 黃金比例混合對標(精進):每板塊「主對標」+「副對標(個股 1-2 檔)」加權平均
#   理由:單一 ETF 易被權重股稀釋(SMH 被台積電/輝達拉走情緒);加個股對標更精準抓族群資金流
#   結構:primary(權重)+ secondary[](權重),失敗 ticker 從加權池移除等比例放大
SECTOR_ETF_MAP = {
    'server': {
        'primary':   {'ticker': 'SMH',  'name': '美半導體',     'weight': 0.4},
        'secondary': [
            {'ticker': 'NVDA', 'name': '輝達(晶片供貨體感)',   'weight': 0.4},
            {'ticker': 'SMCI', 'name': '美超微(財報供應鏈指引)', 'weight': 0.2},
        ],
        'desc': 'AI 伺服器(SMH + NVDA + SMCI 黃金比例,廣達/緯創/鴻海主旋律)',
    },
    'power':     {
        'primary':   {'ticker': 'GRID', 'name': '美智慧電網', 'weight': 1.0},
        'secondary': [],
        'desc': '重電基建對標 (GEV/POWL/ETN)',
    },
    'packaging': {
        'primary':   {'ticker': 'SOXX', 'name': '半導體 SOXX',  'weight': 0.4},
        'secondary': [
            {'ticker': 'TSM',  'name': '台積電 ADR(資本支出)', 'weight': 0.4},
            {'ticker': 'ASML', 'name': '艾司摩爾(設備拉貨)',   'weight': 0.2},
        ],
        'desc': '先進封裝(SOXX + TSM + ASML 黃金比例,CoWoS 弘塑/辛耘/萬潤)',
    },
    'cpo': {
        # 🚨 V23.1 糾錯:原 IGV(科技軟體 ETF,微軟/Adobe)方向錯 → 換 MRVL + AVGO(硬體巨頭)
        'primary':   {'ticker': 'MRVL', 'name': '邁威爾(光通訊主導)', 'weight': 0.5},
        'secondary': [
            {'ticker': 'AVGO', 'name': '博通(光通訊主導)', 'weight': 0.5},
        ],
        'desc': 'CPO 光通訊(MRVL + AVGO,V23.1 糾正:原 IGV 軟體 ETF 對錯方向)',
    },
    'cooling':   {
        'primary':   {'ticker': 'XLI', 'name': '美工業', 'weight': 1.0},
        'secondary': [],
        'desc': '散熱液冷供應鏈對標 (VRT/TT)',
    },
    'robot': {
        'primary':   {'ticker': 'BOTZ', 'name': '美機器人 BOTZ', 'weight': 0.5},
        'secondary': [
            {'ticker': 'TSLA', 'name': '特斯拉(Optimus 人形機器人題材)', 'weight': 0.5},
        ],
        'desc': '機器人(BOTZ + TSLA Optimus 題材外溢,所羅門/台灣精銳)',
    },
    'finance':   {
        'primary':   {'ticker': 'XLF', 'name': '美金融', 'weight': 1.0},
        'secondary': [],
        'desc': '金融避風港對標 (JPM/BAC)',
    },
    'leo':       {
        'primary':   {'ticker': 'ITA', 'name': '美航太', 'weight': 1.0},
        'secondary': [],
        'desc': '低軌衛星 / 航太對標 (IRDM/RKLB)',
    },
    'dram': {
        'primary':   {'ticker': 'MU',  'name': '美光', 'weight': 0.4},
        'secondary': [
            {'ticker': '005930.KS', 'name': '三星(HBM 霸主之一)',   'weight': 0.3},
            {'ticker': '000660.KS', 'name': 'SK海力士(HBM 龍頭)', 'weight': 0.3},
        ],
        'desc': 'DRAM 記憶體(MU + 三星 + SK海力士;HBM 現貨報價待付費源)',
    },
    # 🆕 V69.5.0 新增熱門板塊(前端 _sectorStocks 對齊;台股特有族群用近似 proxy 對標)
    'defense': {
        'primary':   {'ticker': 'PPA', 'name': '美航太國防 ETF', 'weight': 1.0},
        'secondary': [],
        'desc': '軍工國防對標(PPA;台股 漢翔/雷虎/龍德造船)',
    },
    'wafer': {
        'primary':   {'ticker': 'SOXX', 'name': '半導體 SOXX', 'weight': 0.6},
        'secondary': [
            {'ticker': 'TSM', 'name': '台積電 ADR(晶圓需求)', 'weight': 0.4},
        ],
        'desc': '矽晶圓(SOXX+TSM 近似 proxy,無純美股晶圓 ETF;台股 環球晶/中美晶/合晶)',
    },
    'pcb': {
        'primary':   {'ticker': 'SOXX', 'name': '半導體 SOXX', 'weight': 1.0},
        'secondary': [],
        'desc': 'PCB/載板(SOXX 近似 proxy,載板隨半導體資本支出;台股 欣興/南電/景碩)',
    },
    'asic': {
        'primary':   {'ticker': 'AVGO', 'name': '博通(客製晶片)', 'weight': 0.6},
        'secondary': [
            {'ticker': 'MRVL', 'name': '邁威爾(客製晶片)', 'weight': 0.4},
        ],
        'desc': 'ASIC 矽智財(AVGO+MRVL 客製晶片需求;台股 世芯/創意/晶心科)',
    },
    'security': {
        'primary':   {'ticker': 'CIBR', 'name': '美網路資安 ETF', 'weight': 1.0},
        'secondary': [],
        'desc': '資安(CIBR;台股 安碁資訊/零壹/精誠)',
    },
}


def fetch_sector_etfs():
    """🏭 V23.1 黃金比例混合對標:每板塊主對標(ETF)+ 副對標(個股)加權平均。
    回傳 dict: {sector_key: {etf, name, desc, price, chg_pct, components, primary_only_chg}}
    - `etf/price` 維持向下相容(主對標 ticker / 主對標 price)
    - `chg_pct` 改為加權平均(成功抓到的 weight 等比例放大重分配)
    - `components[]` 列每個 ticker 的 price/chg/weight/ok/err 細項(前端 tooltip / AI prompt 用)
    - `primary_only_chg` 純主對標 chg(對比/debug 用)
    V21.7 原 fallback 機制保留:全部 ticker 都失敗才走 stale prev_cache
    """
    print("🏭 採集美股對標 9 細分板塊(V23.1 黃金比例混合對標,主+副個股加權)…")
    prev_cache = {}
    try:
        cache_path = Path('macro_cache.json')
        if cache_path.exists():
            prev = json.loads(cache_path.read_text(encoding='utf-8'))
            prev_cache = prev.get('sector_etfs') or {}
    except Exception:
        pass

    out = {}
    for key, meta in SECTOR_ETF_MAP.items():
        primary = meta['primary']
        secondary = meta.get('secondary') or []
        all_targets = [primary] + secondary
        components = []
        for t in all_targets:
            try:
                price, chg, err = _fetch_yf_close(t['ticker'], t['name'])
                ok = (price is not None) and (chg is not None)
                components.append({
                    'ticker': t['ticker'], 'name': t['name'],
                    'price': price, 'chg': chg,
                    'weight': t['weight'], 'ok': ok,
                    'err': (err or '')[:60] if not ok else None,
                })
                if ok:
                    print(f"   · [{key:9s}] {t['ticker']:10s} {t['name']:20s} ${price} ({chg:+.2f}%) w={t['weight']}")
                else:
                    print(f"   · [{key:9s}] {t['ticker']:10s} 失敗 ({err or '?'}) w={t['weight']}")
            except Exception as e:
                components.append({
                    'ticker': t['ticker'], 'name': t['name'], 'price': None, 'chg': None,
                    'weight': t['weight'], 'ok': False, 'err': str(e)[:60],
                })
                print(f"   · [{key:9s}] {t['ticker']:10s} 例外 ({str(e)[:40]})")

        ok_comps = [c for c in components if c['ok']]
        if ok_comps:
            total_w = sum(c['weight'] for c in ok_comps)
            weighted_chg = sum(c['chg'] * c['weight'] for c in ok_comps) / total_w if total_w > 0 else None
            primary_price = components[0]['price']
            primary_only_chg = components[0]['chg']
            out[key] = {
                'etf': primary['ticker'],
                'name': primary['name'],
                'desc': meta['desc'],
                'price': primary_price,
                'chg_pct': round(weighted_chg, 2) if weighted_chg is not None else None,
                'components': components,
                'primary_only_chg': round(primary_only_chg, 2) if primary_only_chg is not None else None,
            }
            if len(ok_comps) < len(components):
                out[key]['partial'] = True
        else:
            # 全部 ticker 失敗 → fallback stale prev_cache,或 error
            prev_etf = prev_cache.get(key) or {}
            if prev_etf.get('price') is not None:
                out[key] = {**prev_etf, 'stale': True, 'last_error': '全部 ticker 抓取失敗'}
            else:
                out[key] = {
                    'etf': primary['ticker'], 'name': primary['name'], 'desc': meta['desc'],
                    'price': None, 'chg_pct': None, 'components': components,
                    'error': '全部 ticker 抓取失敗',
                }
    return out


def fetch_business_signal():
    """🌡️ 國發會景氣對策信號自動抓取。每月 27 號發布上個月燈號(略有延遲)。

    分數區間(國發會官方規則):
      9-16  → 🔵 藍燈(衰退)
      17-22 → 🔷 黃藍燈(趨弱)
      23-31 → 🟢 綠燈(穩定)
      32-37 → 🟡 黃紅燈(轉強)
      38-45 → 🔴 紅燈(過熱)

    回傳 (light_key, score, month_str, error) 例:('green', 27, '2026-05', None)
    失敗時 (None, None, None, '錯誤訊息') — 前端 fallback 到手動下拉。
    V23.2 — 3 次 retry 指數退避(1s/2s/4s)+ UA 加強(完整瀏覽器標頭) +
            外層 stale fallback 機制移到 main() 處理(讀上次 macro_risk.json)
    """
    import requests as _req
    import time as _time
    headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://index.ndc.gov.tw/n/zh_tw',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
    }
    # 國發會景氣指標查詢系統(JSON 直接抓分數時間序列)
    candidates = [
        'https://index.ndc.gov.tw/n/json/data/IDF06',
        'https://index.ndc.gov.tw/api/data/IDF06',
    ]
    last_err_box = {'val': None}

    def _one_attempt():
        """單次嘗試:走 2 個 URL,成功 return (light, score, month, None),失敗 return None"""
        for url in candidates:
            try:
                r = _req.get(url, headers=headers, timeout=15)
                if r.status_code != 200:
                    last_err_box['val'] = f"HTTP {r.status_code} ({url.split('/')[-1]})"
                    continue
                data = r.json()
                # NDC 回傳格式通常是 list:[{'date':'1140531','value':'23'}, ...] 也可能是 dict 包含 series
                items = data if isinstance(data, list) else (
                    data.get('data') or data.get('series') or data.get('result') or []
                )
                if not items:
                    last_err_box['val'] = "empty payload"
                    continue
                score, month = None, None
                for item in reversed(items if isinstance(items, list) else []):
                    if not isinstance(item, dict):
                        continue
                    v = item.get('value') or item.get('Value') or item.get('score')
                    d = item.get('date') or item.get('Date') or item.get('month')
                    if v is None or d is None:
                        continue
                    try:
                        s = int(float(str(v).strip()))
                        if 5 <= s <= 50:
                            score = s
                            ds = str(d).strip()
                            if len(ds) == 7 and ds.isdigit():
                                month = f"{int(ds[:3]) + 1911}-{ds[3:5]}"
                            elif len(ds) >= 7 and '-' in ds:
                                month = ds[:7]
                            else:
                                month = ds
                            break
                    except Exception:
                        continue
                if score is None:
                    last_err_box['val'] = "no valid score in payload"
                    continue
                if score <= 16:    light = 'blue'
                elif score <= 22:  light = 'yellow-blue'
                elif score <= 31:  light = 'green'
                elif score <= 37:  light = 'yellow-red'
                else:              light = 'red'
                return (light, score, month, None)
            except Exception as e:
                last_err_box['val'] = str(e)[:120]
                continue
        return None

    # V23.2 — 3 次 retry 指數退避(1s / 2s / 4s)
    for attempt in range(3):
        if attempt > 0:
            backoff = 2 ** (attempt - 1)
            print(f"   ⏳ 景氣燈號 retry #{attempt} 等 {backoff}s ...")
            _time.sleep(backoff)
        result = _one_attempt()
        if result is not None:
            return result
    return (None, None, None, last_err_box['val'] or 'all retries failed')


def _yf_chg_3d(ticker, name):
    """🦅 獵鷹建倉分用:取 ticker 近 3 個交易日累積變動率%(避險煞車判斷)。
    回傳 float 或 None。dropna 取最後一筆 vs 倒數第 4 筆(=3 個交易日前)。"""
    import time
    for attempt in range(2):
        try:
            time.sleep(0.4 if attempt == 0 else 1.0)
            import yfinance as yf
            hist = yf.Ticker(ticker).history(period="1mo", auto_adjust=False)
            if hist is None or hist.empty:
                continue
            closes = hist["Close"].dropna()
            if len(closes) < 4:
                continue
            last, base = float(closes.iloc[-1]), float(closes.iloc[-4])
            if last != last or base != base or base <= 0:
                continue
            return round((last - base) / base * 100, 2)
        except Exception:
            continue
    return None


def fetch_twii_240ma_bias():
    """🛑 DEPRECATED (2026/06):本函式已從 main 流程移除呼叫,因 yfinance 對 GHA runner 美國 IP
       持續抓不到 ^TWII 2 年歷史(< 240 日無法算 240MA)。保留供未來改用 TWSE 官方 API 復用。

    🦅 大盤懼高症濾網:加權指數(^TWII)距 240MA(年線)乖離率%。
    需 240 個交易日,故抓 2 年;dropna 防休市 NaN。回傳 (bias_pct, ma240, err)。"""
    import time
    for attempt in range(2):
        try:
            time.sleep(0.4 if attempt == 0 else 1.0)
            import yfinance as yf
            hist = yf.Ticker("^TWII").history(period="2y", auto_adjust=False)
            if hist is None or hist.empty:
                return None, None, "^TWII 2y 回空"
            closes = hist["Close"].dropna()
            if len(closes) < 240:
                return None, None, f"^TWII 有效收盤 {len(closes)}<240(不足年線)"
            last = float(closes.iloc[-1])
            ma240 = float(closes.tail(240).mean())
            if last != last or ma240 != ma240 or ma240 <= 0:
                return None, None, "^TWII 240MA 含 NaN"
            return round((last - ma240) / ma240 * 100, 2), round(ma240, 0), None
        except Exception as e:
            if attempt == 1:
                return None, None, str(e)[:80]
    return None, None, "重試後仍失敗"


def _fetch_fx(ticker, name):
    """通用匯率抓取(USD/XXX)— 回 (匯率, 1日%, 5日%, err)。
    V57.9 供台幣/韓元/人民幣共用:值上升=該幣貶值;亞幣競貶=外資撤亞洲風向。"""
    try:
        import yfinance as yf
        hist = yf.Ticker(ticker).history(period="1mo", auto_adjust=False)
        if hist is None or hist.empty:
            return None, None, None, "yfinance 回空"
        closes = hist["Close"].dropna()
        if not len(closes):
            return None, None, None, "無有效收盤"
        last = float(closes.iloc[-1])
        chg1 = round((last / float(closes.iloc[-2]) - 1) * 100, 2) if len(closes) >= 2 and float(closes.iloc[-2]) > 0 else None
        chg5 = round((last / float(closes.iloc[-6]) - 1) * 100, 2) if len(closes) >= 6 and float(closes.iloc[-6]) > 0 else None
        return round(last, 3), chg1, chg5, None
    except Exception as e:
        print(f"  ⚠️ {name} 抓取失敗: {e}")
        return None, None, None, str(e)[:100]


def fetch_usdtwd():
    """新台幣匯率 USD/TWD — V57.8 加 1日/5日變化%(貶值=外資提款風向)"""
    return _fetch_fx("TWD=X", "USD/TWD")


def fetch_fear_greed():
    """CNN 恐懼與貪婪指數（0-100，需瀏覽器 UA 否則 418）"""
    try:
        url = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata"
        ua = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                            "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
              "Accept": "application/json"}
        r = http.get(url, headers=ua, timeout=10)
        if r.status_code != 200:
            return None, None, f"HTTP {r.status_code}"
        fg = (r.json() or {}).get("fear_and_greed") or {}
        score = fg.get("score")
        rating = fg.get("rating")
        if score is None:
            return None, None, "回應無 score"
        label_map = {"extreme fear": "極度恐懼", "fear": "恐懼", "neutral": "中性",
                     "greed": "貪婪", "extreme greed": "極度貪婪"}
        label = label_map.get((rating or "").lower(), rating or "")
        return round(float(score), 1), label, None
    except Exception as e:
        print(f"  ⚠️ 恐懼貪婪指數抓取失敗: {e}")
        return None, None, str(e)[:100]


def _taifex_oi_rows(commodity_id: str):
    """共用：抓 TAIFEX 三大法人某商品的未平倉 CSV（沿用 fetch_foreign_futures_net 的端點/編碼防呆）"""
    import csv
    import io
    url = "https://www.taifex.com.tw/cht/3/futContractsDateDown"
    payload = {"queryType": "1", "marketCode": "0", "dateaddcnt": "",
               "commodity_id": commodity_id,
               "queryDate": datetime.now().strftime("%Y/%m/%d")}
    r = http.post(url, data=payload, headers=HEADERS, timeout=10)
    if r.status_code != 200:
        return None, f"HTTP {r.status_code}"
    try:
        r.encoding = "big5"
        text = r.text
    except Exception:
        text = r.text
    rows = list(csv.reader(io.StringIO(text)))
    return (rows or None), (None if rows else "CSV 空白")


def fetch_retail_long_short():
    """散戶多空比 — 用小型臺指期(MTX) 三大法人淨未平倉推算
    散戶多空比 ≈ -(三大法人 MTX 淨未平倉口數) / 全市場 MTX 未平倉量 ×100%（負值＝散戶偏多）
    ① 優先官方 OpenAPI JSON（schema 穩定）② 失敗退原 CSV 解析
    """
    # ── ① 官方 OpenAPI JSON ──
    data, err = _taifex_openapi(_TAIFEX_INST_ENDPOINTS)
    if data:
        # MTX 商品名為「小型臺指期貨」；加總三大法人淨未平倉
        net, ls_max, matched, seen = _taifex_sum_net_oi(
            data, lambda p: ("小型臺指" in p) or ("小型台指" in p), want_identity=None)
        if matched > 0 and ls_max > 0:
            retail_pct = round(-(net) / ls_max * 100, 1)
            print(f"  [散戶多空比 OpenAPI] inst_net={int(net)} 近似總OI={int(ls_max)} → {retail_pct}%")
            return retail_pct, None
        print(f"  [散戶多空比 OpenAPI] 未匹配；keys={list(data[0].keys())}；商品名={sorted(seen)[:20]}")
    else:
        print(f"  [散戶多空比 OpenAPI] 端點失敗：{err}")

    # ── ② 原 CSV 解析（保留為 fallback）──
    try:
        import re
        rows, err = _taifex_oi_rows("MTX")
        if not rows:
            return None, f"MTX OI 取得失敗：{err}"
        inst_net = 0
        total_oi = 0
        matched = 0
        # 診斷用：收集所有不重複的「商品名稱」欄，幫助找出真實 commodity 字串
        product_names = set()
        for row in rows[1:]:
            if len(row) < 8:
                continue
            joined = "".join(row[:4])
            # 收集所有非空商品名（前 4 欄拼起來）方便比對
            if joined.strip():
                product_names.add(joined[:30])
            if "小型臺指" not in joined and "MTX" not in joined.upper():
                continue
            ints = []
            for c in row:
                s = str(c).replace(",", "").strip()
                if re.fullmatch(r"-?\d+", s):
                    ints.append(int(s))
            if len(ints) < 6:
                continue
            # 慣例尾端欄：… 多方未平倉口, 多方未平倉額, 空方未平倉口, 空方未平倉額, 淨額未平倉口, 淨額未平倉額
            net_oi = ints[-2]
            long_oi = ints[-6]
            short_oi = ints[-4]
            inst_net += net_oi
            total_oi = max(total_oi, long_oi + short_oi)  # 任一法人 long+short 近似全市場上限，取最大較穩
            matched += 1
        if matched == 0 or total_oi <= 0:
            # 印出實際 TAIFEX CSV 看到的商品名稱，方便下次 grep 出真實字串
            print(f"  [散戶多空比] 全部不重複商品名（前 30 個）: {sorted(product_names)[:30]}")
            return None, "MTX 三大法人列未匹配或總 OI 為 0"
        # 全市場 MTX 未平倉量：三大法人 long 合計 + 散戶；此處用三大法人 long+short 總和近似分母
        retail_pct = round(-(inst_net) / total_oi * 100, 1)
        print(f"  [散戶多空比] inst_net={inst_net} 近似總OI={total_oi} → {retail_pct}%")
        return retail_pct, None
    except Exception as e:
        print(f"  ⚠️ 散戶多空比推算失敗: {e}")
        return None, str(e)[:100]


def fetch_taifex_tx_now():
    """🌃 V23.3 — 台指期 TX 近月實時點 + 日漲跌% — 給前端頂部 3 指數區顯示
    來源:① yfinance ^TXF=F(夜盤含實時報價)→ ② V27.3 TAIFEX 官方 OpenAPI 近月收盤(可靠 fallback)
    回傳:{price, chg, est, error}(est=True 代表只有收盤價、無可靠漲跌方向 → 前端顯「估」)
    """
    # ① yfinance ^TXF=F(實時 + 含漲跌%)
    try:
        import yfinance as yf
        hist = yf.Ticker("^TXF=F").history(period="5d", auto_adjust=False)
        if hist is not None and not hist.empty:
            closes = hist["Close"].dropna()
            if len(closes) >= 2:
                last = float(closes.iloc[-1])
                prev = float(closes.iloc[-2])
                if last == last and prev == prev and prev != 0:
                    chg = round((last - prev) / prev * 100, 2)
                    # 🐛 V71.4.9 一定要回「這個價是哪一天的」:yfinance 的 ^TXF=F 實測會落後一個交易日
                    #   (2026-07-30 04:42 抓到的還是 07/28 的 41,613),前端卻把它跟當天的加權指數並排顯示
                    #   → 看起來像 +1,574 點的巨大正價差,而正逆價差是判讀外資空單的關鍵配套,會直接誤導。
                    #   有日期,前端才能誠實標「07/28 收盤」而不是假裝即時。
                    _d = None
                    try:
                        _d = str(closes.index[-1].date())
                    except Exception:
                        pass
                    return {"price": round(last, 2), "chg": chg, "est": False,
                            "date": _d, "src": "yfinance ^TXF=F", "error": None}
    except Exception as e:
        print(f"   ⚠️ 台指期 yfinance 失敗:{str(e)[:80]} → 改用 TAIFEX 官方 OpenAPI")
    # ② V27.3 — yfinance 失敗 → TAIFEX 官方 OpenAPI 近月收盤
    #   V54.x — 救「夜盤不計分」:OpenAPI 期貨行情本身就帶「漲跌」欄,直接取來算 chg%
    #   → 有漲跌% 就 est=False(前端會計分);真的取不到才退回純價 est=True。
    try:
        off, off_pct = _taifex_openapi_tx_close_change()
        if off and off > 0:
            if off_pct is not None:
                print(f"   ✅ 台指期 OpenAPI 收盤 {off}、漲跌 {off_pct}% → 夜盤可計分")
                return {"price": round(float(off), 2), "chg": off_pct, "est": False,
                        "date": None, "src": "TAIFEX OpenAPI", "error": None}
            print(f"   ✅ 台指期改用 TAIFEX 官方 OpenAPI 收盤:{off}(無漲跌欄,顯純價)")
            return {"price": round(float(off), 2), "chg": None, "est": True,
                    "date": None, "src": "TAIFEX OpenAPI", "error": None}
    except Exception as e:
        return {"price": None, "chg": None, "est": False, "error": f"both failed: {str(e)[:60]}"}
    return {"price": None, "chg": None, "est": False, "error": "yfinance+openapi both empty"}


def _taifex_openapi_tx_fut_close():
    """官方 OpenAPI『期貨每日交易行情』→ 取 TX 近月收盤（排除週契約；以未沖銷量最大者當近月）。
    回 float 收盤價；失敗回 None。"""
    data, err = _taifex_openapi(["DailyMarketReportFut", "DailyMarketReportFutures"])
    if not data:
        print(f"  [台指逆價差 OpenAPI] 期貨行情端點失敗：{err}")
        return None
    best_close, best_oi = None, -1.0
    seen = set()
    for row in data:
        if not isinstance(row, dict):
            continue
        # 契約欄：實測 OpenAPI key 為英文 'Contract'（值如 TX/MTX/TE…）
        _, contract = _find_key(row, ['Contract', '契約', '商品', 'Commodity'])
        cstr = str(contract).strip() if contract is not None else ""
        if cstr:
            seen.add(cstr[:12])
        # TX 精確比對（避免誤抓 MTX / 電子 / 金融）
        if cstr not in ("TX", "TXF", "臺股期貨"):
            continue
        # 到期月份欄：實測英文 'ContractMonth(Week)'，週契約含 'W'
        _, exp = _find_key(row, ['ContractMonth', '到期', '契約月', '月份', 'Delivery'])
        if exp is not None and ("週" in str(exp) or "W" in str(exp).upper()):
            continue  # 排除週期貨
        # 收盤：實測英文 'Last'(最後成交) / 'SettlementPrice'(結算)；'-' 會被 _row_pick 視為 None
        close = (_row_pick(row, 'Last') or _row_pick(row, '收盤')
                 or _row_pick(row, 'SettlementPrice') or _row_pick(row, '結算')
                 or _row_pick(row, '最後成交'))
        if close is None or close <= 0:
            continue
        oi = (_row_pick(row, 'OpenInterest') or _row_pick(row, '未沖銷')
              or _row_pick(row, '未平倉') or 0)
        if oi >= best_oi:
            best_oi, best_close = oi, close
    if best_close is None:
        print(f"  [台指逆價差 OpenAPI] 未匹配 TX 列；keys={list(data[0].keys())}；契約={sorted(seen)[:20]}")
    return best_close


def _taifex_openapi_tx_close_change():
    """V54.x — 官方 OpenAPI『期貨每日交易行情』→ TX 近月 (收盤價, 漲跌%)。失敗回 (None, None)。
    救「台指期夜盤不計分」:yfinance ^TXF=F 失敗時,改直接從 OpenAPI 的漲跌欄算 %。
    漲跌%:① 直接的百分比欄(ChangePercent/%Change/漲跌幅) ② 漲跌價 ÷ 昨收(收盤−漲跌價)。"""
    data, err = _taifex_openapi(["DailyMarketReportFut", "DailyMarketReportFutures"])
    if not data:
        print(f"  [台指期夜盤 OpenAPI] 期貨行情端點失敗：{err}")
        return None, None

    def _numf(v):
        try:
            return float(str(v).replace(",", "").replace("%", "").replace("▲", "").replace("▼", "-").strip())
        except Exception:
            return None

    best_close, best_pct, best_oi = None, None, -1.0
    for row in data:
        if not isinstance(row, dict):
            continue
        _, contract = _find_key(row, ['Contract', '契約', '商品', 'Commodity'])
        cstr = str(contract).strip() if contract is not None else ""
        if cstr not in ("TX", "TXF", "臺股期貨"):
            continue
        _, exp = _find_key(row, ['ContractMonth', '到期', '契約月', '月份', 'Delivery'])
        if exp is not None and ("週" in str(exp) or "W" in str(exp).upper()):
            continue  # 排除週契約
        close = (_row_pick(row, 'Last') or _row_pick(row, '收盤')
                 or _row_pick(row, 'SettlementPrice') or _row_pick(row, '結算')
                 or _row_pick(row, '最後成交'))
        if close is None or close <= 0:
            continue
        # 漲跌%:先找現成百分比欄,沒有再用漲跌價 ÷ 昨收
        pct = None
        _, praw = _find_key(row, ['ChangePercent', '%Change', 'Change%', '漲跌百分比', '漲跌幅'])
        pv = _numf(praw) if praw is not None else None
        if pv is not None and -20 < pv < 20:
            pct = round(pv, 2)
        else:
            _, craw = _find_key(row, ['Change', '漲跌'])
            cv = _numf(craw) if craw is not None else None
            if cv is not None and (close - cv) > 0:
                pct = round(cv / (close - cv) * 100, 2)
        oi = (_row_pick(row, 'OpenInterest') or _row_pick(row, '未沖銷')
              or _row_pick(row, '未平倉') or 0)
        if oi >= best_oi:
            best_oi, best_close, best_pct = oi, close, pct
    if best_close is None:
        print(f"  [台指期夜盤 OpenAPI] 未匹配 TX 列；keys={list(data[0].keys())}")
    return best_close, best_pct


# 📌 V71.1.6 副產物:fetch_taifex_backwardation 內部本來就抓了 ^TWII 現貨收盤,
#    順手存起來給 fi_ratio_alert_level 算「一口台指期的合約價值(指數×200)」用,
#    免得為了同一個數字再打一次 yfinance。
_LAST_TWII_SPOT = None
_LAST_TX_FUT_DATE = None   # V71.4.9 期貨那條腿的資料日期(判斷是否與現貨同一天)


def fetch_taifex_backwardation():
    """台指逆價差 = 臺股期貨(TX)近月收盤 − 加權指數(^TWII)現貨收盤（負值＝逆價差）
    期貨收盤：① 官方 OpenAPI JSON ② yfinance ^TXF=F ③ TAIFEX HTML regex
    """
    global _LAST_TWII_SPOT
    try:
        import re
        # 1) ^TWII 現貨收盤
        #   🐛 V71.4.9 改「本地 data/^TWII.json 優先」:那份是 miner.py 直接抓證交所的權威收盤,
        #      當天下午就有;yfinance 的 ^TWII 實測會落後一個交易日
        #      (2026-07-30 04:42 抓到的還是 07/28 的 41,603,而證交所 07/29 早就是 40,039)。
        #      落後的現貨配上落後的期貨,逆價差算出來「數字自洽但整組是昨天的」,
        #      前端又把它跟當天的指數並排 → 使用者讀到不存在的價差。yfinance 留作備援。
        spot, spot_date = None, None
        try:
            _tf = DATA_DIR / '^TWII.json'
            if _tf.exists():
                _rows = json.loads(_tf.read_text(encoding='utf-8'))
                if isinstance(_rows, list) and _rows:
                    _c = float(_rows[-1].get('close') or 0)
                    if _c > 0:
                        spot = _c
                        spot_date = str(_rows[-1].get('date') or '').replace('/', '-')[:10]
                        print(f"  [台指逆價差] 現貨用本地證交所收盤 {spot:.0f}({spot_date})")
        except Exception as e:
            print(f"  [台指逆價差] 本地 ^TWII.json 讀取失敗({str(e)[:50]}),改用 yfinance")
        if spot is None:
            try:
                import yfinance as yf
                hist = yf.Ticker("^TWII").history(period="5d", auto_adjust=False)
                if hist is not None and not hist.empty:
                    closes = hist["Close"].dropna()
                    if len(closes) >= 1:
                        v = float(closes.iloc[-1])
                        if v == v:   # 非 NaN
                            spot = v
                            try:
                                spot_date = str(closes.index[-1].date())
                            except Exception:
                                pass
            except Exception as e:
                return None, f"^TWII 取得失敗：{str(e)[:60]}"
        if spot is None:
            return None, "^TWII 無有效現貨收盤(休市/NaN)"
        _LAST_TWII_SPOT = spot   # V71.1.6 給期現比用(合約價值=指數×200)
        # 2) 期貨收盤：① 官方 OpenAPI JSON ② yfinance ^TXF=F ③ TAIFEX HTML
        fut_close = _taifex_openapi_tx_fut_close()
        if fut_close is not None:
            print(f"  [台指逆價差] OpenAPI TX 近月收盤 = {fut_close}")
        if fut_close is None:
            try:
                import yfinance as yf
                fut_hist = yf.Ticker("^TXF=F").history(period="5d", auto_adjust=False)
                if fut_hist is not None and not fut_hist.empty:
                    fut_close = float(fut_hist["Close"].iloc[-1])
                    try:
                        globals()['_LAST_TX_FUT_DATE'] = str(fut_hist["Close"].dropna().index[-1].date())
                    except Exception:
                        pass
                    print(f"  [台指逆價差] yfinance ^TXF=F 期貨收盤 = {fut_close}"
                          f"({_LAST_TX_FUT_DATE or '日期未知'})")
            except Exception as e:
                print(f"  [台指逆價差] yfinance 期貨失敗，退到 TAIFEX HTML：{str(e)[:60]}")
        if fut_close is None:
            url = "https://www.taifex.com.tw/cht/3/futDailyMarketReport"
            payload = {"queryType": "2", "marketCode": "0", "commodity_id": "TX",
                       "queryDate": datetime.now().strftime("%Y/%m/%d"), "MarketCode": "0",
                       "commodity_idt": "TX"}
            r = http.post(url, data=payload, headers=HEADERS, timeout=10)
            if r.status_code != 200:
                return None, f"TAIFEX HTTP {r.status_code}"
            html = r.text
            m = re.search(r"TX[^0-9]{0,40}?([1-2]\d{4})", html)
            if not m:
                return None, "TX 近月收盤未匹配（yfinance + TAIFEX 雙失敗）"
            fut_close = float(m.group(1))
        # 🐛 V71.4.9 兩條腿必須是同一天,否則算出來的價差是假的。
        #   實例:期貨 41,613(07/28 夜盤)− 現貨 40,039(07/29 收盤)= +1,574 點「正價差」,
        #   而真相是兩者相隔一個交易日。正逆價差是判讀外資空單真假的關鍵配套
        #   (空單大但正價差=避險;空單大又深逆價差=真的在殺),算錯會把避險誤判成看空。
        #   對不上日期就誠實回 None,讓前端顯「整備中」——不硬給一個看起來合理的假數字。
        fut_date = _LAST_TX_FUT_DATE
        if spot_date and fut_date and spot_date != fut_date:
            msg = f"期貨({fut_date})與現貨({spot_date})不同交易日,不計價差"
            print(f"  [台指逆價差] ⏭️ {msg}")
            return None, msg
        back = round(fut_close - spot, 0)
        print(f"  [台指逆價差] 期貨{fut_close} − 現貨{spot:.0f} = {back:+.0f} 點"
              f"({spot_date or '日期未知'})")
        return back, None
    except Exception as e:
        print(f"  ⚠️ 台指逆價差抓取失敗: {e}")
        return None, str(e)[:100]


def judge_fi_complex(net_futures, net_spot):
    """
    複合邏輯判定（補完死區後）：
    - 期貨空單 > 30000 且現貨買超 > 0 億          → 套利避險
    - 期貨空單 > 30000 且現貨賣超 > 100 億        → 真實偏空警戒
    - 期貨空單 > 30000 且現貨 -100~0 億（接近持平）→ 暗流湧動，持續觀察
    - 其他                                         → 中性
    """
    if net_futures is None or net_spot is None:
        return "資料整編中（待對接）"
    fut_short = -net_futures if net_futures < 0 else 0
    if fut_short > 30000 and net_spot > 0:
        return "外資期現不同調：套利避險狀態"
    if fut_short > 30000 and net_spot < -100:
        return "外資期現同步倒貨：真實偏空警戒"
    if fut_short > 30000 and -100 <= net_spot <= 0:
        return "外資期貨大量布空、現貨持平：暗流湧動觀察"
    return "外資動向中性"



def backfill_margin_history(hist: list) -> int:
    """💰 V71.1.7 回補 risk_history 裡缺 margin_100m 的舊日期(使用者問:能不能先補前 6 天?)

    背景:V70.2.7 才開始把「全市場融資餘額」寫進每日快照,所以歷史只有最近幾天有值,
    前端「融資斷頭宣洩」要 5 日增減 → 得空等約 6 個交易日。
    但 TWSE 的 MI_MARGN **本來就吃 date 參數可查歷史**,沒有理由乾等 —— 直接回補。

    ・只補 margin_100m 為 None 的日期,已有值的不動(不重打、不覆寫)
    ・每檔之間 sleep 1.2s,對 TWSE 客氣一點(一次最多補 MAX_BACKFILL 天)
    ・任何一天失敗就跳過該天,不中斷整體(週末/休市本來就會回 stat != OK)
    回傳實際補上幾天。
    """
    MAX_BACKFILL = 30
    todo = [h for h in hist if isinstance(h, dict) and h.get('margin_100m') is None and h.get('date')]
    if not todo:
        return 0
    todo = todo[-MAX_BACKFILL:]
    print(f"\n💰 回補融資餘額歷史:{len(todo)} 天待補(TWSE MI_MARGN 支援指定日期查詢)")
    filled = 0
    for h in todo:
        d8 = str(h['date']).replace('-', '')
        if len(d8) != 8:
            continue
        try:
            url = f'https://www.twse.com.tw/exchangeReport/MI_MARGN?response=json&date={d8}&selectType=MS'
            j = http.get(url, headers=HEADERS, timeout=15).json()
            v = parse_twse_margin_ms(j)
            if v is not None:
                h['margin_100m'] = round(v, 2)
                filled += 1
        except Exception as e:
            print(f"   ⚠️ {d8} 回補失敗:{str(e)[:60]}")
        time.sleep(1.2)   # 對 TWSE 客氣
    print(f"   ✅ 融資歷史回補完成:{filled}/{len(todo)} 天")
    return filled

def fi_ratio_alert_level(fi_spot, fi_futures, twii_spot=None):
    """⚠️ 期現比警示:外資期貨淨額換算成「相當於幾億現貨」後,跟現貨買賣超比。

    fi_spot:外資現貨淨額(億)、fi_futures:外資台指期淨口數、twii_spot:加權指數點數
    比值 > 2.5 且期貨大空 → 主力先用期貨佈空,現貨恐跟跌(警戒)

    🐛 V71.1.6 修「期現比永遠顯示 0.0」:
       舊碼 `spot_equiv = abs(fi_spot * 1e8 / 50000)` 把一口台指期的合約價值當成 5 萬元,
       但台指期一口 = 指數 × 200 元(指數 43,000 時約 860 萬),**差了約 175 倍**
       → 分母被灌大 175 倍 → ratio 恆為 0.0x,顯示成 0.0,而且 ratio 那兩個分支永遠不會觸發
       (之所以還會亮警戒,是靠 OR 的 `fi_futures < -30000` 那條,等於比值本身完全沒作用)。
       改用真實合約乘數;拿不到指數時退回近似值 43,000(寧可粗估也不要 175 倍的錯)。
    任一資料源缺值時回字串「⏳ 期現比待採」(而非 None),讓前端顯示提示而非空白。
    """
    # 任一缺值 → 不返回 None,改成提示字串(避免前端 fi_ratio_alert 顯示空白)
    if fi_spot is None and fi_futures is None:
        return "⏳ 期現比待採(現貨/期貨皆無資料)"
    if fi_spot is None:
        return "⏳ 期現比待採(外資現貨買賣超尚無資料)"
    if fi_futures is None:
        return "⏳ 期現比待採(外資台指期未平倉尚無資料)"
    if fi_spot == 0:
        return "✅ 期現比 — 外資現貨持平(無顯著買賣超)"
    # 億 → 元 → 除以「一口台指期的合約價值(指數 × 200)」= 約等量期貨口數
    _idx = twii_spot if (twii_spot and twii_spot > 1000) else 43000.0
    spot_equiv = abs(fi_spot * 1e8) / (_idx * 200.0)
    ratio = abs(fi_futures) / max(spot_equiv, 1)
    # 改 OR:期現大幅背離(ratio>2.5) 或 期貨超級空(< -30000) 任一觸發即警戒,避免漏報
    if (ratio > 2.5 and fi_futures < 0) or fi_futures < -30000:
        return f"⚠️ 期現比 {ratio:.1f}(警戒) — 期貨先空,現貨恐跟跌"
    elif ratio > 1.8 and fi_futures < 0:
        return f"🟡 期現比 {ratio:.1f}(留意) — 期貨稍超前現貨"
    return f"✅ 期現比 {ratio:.1f}(健康) — 期現同步"


def main():
    print("📡 macro_miner 啟動 — 抓取總經三維風險指標")
    out = {
        "updated":     datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M %z"),
        "us10y_yield": None,
        "us10y_error": None,
        "fi_spot_net":     None,   # 億元
        "fi_spot_date":    None,
        "fi_spot_error":   None,
        "fi_futures_net":  None,   # 口數（淨）
        "fi_futures_error":None,
        "fi_complex_conclusion": None,
        # ── 頂部戰略指揮部新增六大宏觀指標 ──
        "us2y_yield":   None,
        "us2y_error":   None,
        "usdtwd":       None,
        "usdtwd_error": None,
        "usdtwd_chg_pct": None,   # 💱 V57.8 台幣 1 日變化%(正=貶值)
        "usdtwd_chg_5d":  None,   # 💱 V57.8 台幣 5 日變化%(正=連貶=外資提款風向)
        "krw": None, "krw_chg_pct": None, "krw_chg_5d": None, "krw_error": None,   # 💱 V57.9 韓元(亞幣競貶)
        "cny": None, "cny_chg_pct": None, "cny_chg_5d": None, "cny_error": None,   # 💱 V57.9 人民幣(中國資金外逃)
        "fear_greed":       None,
        "fear_greed_label": None,
        "fear_greed_error": None,
        "retail_ls_pct":   None,   # 散戶多空比 %（負值＝散戶偏多）
        "retail_ls_error": None,
        "taifex_backwardation":       None,   # 台指逆價差（點，負值＝逆價差）
        "taifex_backwardation_error": None,
        "m1b_pct":     None,                                 # 由 m1b_yoy 換算(FRED M1SL),null=待採
        "m1b_label":   "待採",
        "m1b_note":    "由 FRED M1SL 年增率換算流動性熱度;FRED 失敗時為 null",
        # ── 🌍 全球巨頭脈動(10 大國際指標,V21 加 SP500/NASDAQ)──
        "gold_usd":       None, "gold_chg_pct":   None, "gold_error":   None,
        "wti_oil":        None, "wti_chg_pct":    None, "wti_error":    None,
        "dxy":            None, "dxy_chg_pct":    None, "dxy_error":    None,
        "btc_usd":        None, "btc_chg_pct":    None, "btc_error":    None,
        "vix":            None, "vix_chg_pct":    None, "vix_error":    None,
        "nikkei":         None, "nikkei_chg_pct": None, "nikkei_error": None,
        "hsi":            None, "hsi_chg_pct":    None, "hsi_error":    None,
        "kospi":          None, "kospi_chg_pct":  None, "kospi_error":  None,
        "sp500":          None, "sp500_chg_pct":  None, "sp500_error":  None,
        "nasdaq":         None, "nasdaq_chg_pct": None, "nasdaq_error": None,
        # 💡 V58.7 盤前體檢美股欄(道瓊/費半/三大 ADR),放新鮮檔避免 macro_cache stale
        "dji":            None, "dji_chg_pct":    None, "dji_error":    None,
        "sox":            None, "sox_chg_pct":    None, "sox_error":    None,
        "tsm":            None, "tsm_chg_pct":    None, "tsm_error":    None,
        "asx":            None, "asx_chg_pct":    None, "asx_error":    None,
        "umc":            None, "umc_chg_pct":    None, "umc_error":    None,
        # 💡 V68.8.2 美股期貨(盤後即時)+ 美債 10Y 殖利率
        "es_fut":         None, "es_fut_chg_pct": None, "es_fut_error": None,
        "ym_fut":         None, "ym_fut_chg_pct": None, "ym_fut_error": None,
        "nq_fut":         None, "nq_fut_chg_pct": None, "nq_fut_error": None,
        "ust10y":         None, "ust10y_chg_pct": None, "ust10y_error": None,
        # ── 🌡️ 景氣對策信號(Q2 自動,前端 fallback 手動下拉)──
        "business_signal": None,    # {light, score, month, source, error}
        # ── 🏭 美股產業 ETF 板塊對應(Q3 板塊輪動配 ETF)──
        "sector_etfs":     None,    # {sector_key: {etf, name, desc, price, chg_pct}}
        # ── 📅 未來 14 日核彈事件(純演算法,主流程結尾計算填入)──
        "upcoming_macro_events": [],
        "macro_events_ai": None,   # 🤖 V70.3.0 Groq 行事曆解讀
    }

    print("─" * 50)
    print("[1/8] 抓取美債 10Y 殖利率 (^TNX)…")
    y10, y10err = fetch_us10y_yield()
    out["us10y_yield"], out["us10y_error"] = y10, y10err
    print(f"     → {y10}% （err={y10err}）" if y10 is not None else f"     → 失敗：{y10err}")

    print("[2/8] 抓取美債 2Y 殖利率 (FRED DGS2)…")
    y2, y2err = fetch_us2y_yield()
    out["us2y_yield"], out["us2y_error"] = y2, y2err
    print(f"     → {y2}% （err={y2err}）")

    print("[3/8] 抓取 TWSE 外資現貨買賣超…")
    spot, sdate, serr = fetch_foreign_spot_net()
    out["fi_spot_net"], out["fi_spot_date"], out["fi_spot_error"] = spot, sdate, serr
    print(f"     → {spot} 億（{sdate}, err={serr}）")

    # 🌅 V36.8 — 三大法人(投信/自營商/合計)買賣超,供盤前大盤體檢
    inst3, idate, ierr = fetch_three_inst_net()
    out["fi_trust_net"]  = inst3.get("trust")
    out["fi_dealer_net"] = inst3.get("dealer")
    out["fi_total_net"]  = inst3.get("total")
    out["fi_three_date"], out["fi_three_error"] = idate, ierr

    print("[4/8] 抓取 TAIFEX 外資臺指期淨口數…")
    fut, ferr = fetch_foreign_futures_net()
    out["fi_futures_net"], out["fi_futures_error"] = fut, ferr
    print(f"     → {fut} 口（err={ferr}）")

    print("[5/8] 抓取新台幣匯率 (USD/TWD)…")
    twd, twd1, twd5, twderr = fetch_usdtwd()
    out["usdtwd"], out["usdtwd_error"] = twd, twderr
    out["usdtwd_chg_pct"], out["usdtwd_chg_5d"] = twd1, twd5   # 💱 V57.8 貶值=外資提款風向
    print(f"     → {twd}（1日 {twd1}% / 5日 {twd5}%, err={twderr}）")

    # 💱 V57.9 韓元/人民幣(亞幣競貶偵測:台幣+韓元 5 日同貶=外資撤亞洲)
    for _tk, _nm, _key in (("KRW=X", "USD/KRW 韓元", "krw"), ("CNY=X", "USD/CNY 人民幣", "cny")):
        _fx, _fx1, _fx5, _fxerr = _fetch_fx(_tk, _nm)
        out[_key], out[f"{_key}_chg_pct"], out[f"{_key}_chg_5d"], out[f"{_key}_error"] = _fx, _fx1, _fx5, _fxerr
        print(f"     → {_nm}: {_fx}（1日 {_fx1}% / 5日 {_fx5}%, err={_fxerr}）")

    print("[6/8] 抓取 CNN 恐懼與貪婪指數…")
    fg, fglabel, fgerr = fetch_fear_greed()
    out["fear_greed"], out["fear_greed_label"], out["fear_greed_error"] = fg, fglabel, fgerr
    print(f"     → {fg}（{fglabel}, err={fgerr}）")

    print("[6b] 抓取台指選擇權 VIX(台股自己的恐慌溫度計,FinMind)…")
    twv, twv5, twverr = fetch_tw_vix()
    out["tw_vix"], out["tw_vix_chg_5d"], out["tw_vix_error"] = twv, twv5, twverr
    print(f"     → {twv}(5日 {twv5}%, err={twverr})")

    print("[7/8] 推算散戶多空比 (TAIFEX 小型臺指期)…")
    rls, rlserr = fetch_retail_long_short()
    out["retail_ls_pct"], out["retail_ls_error"] = rls, rlserr
    print(f"     → {rls}%（err={rlserr}）")

    print("[8/16] 抓取台指逆價差 (TX − ^TWII)…")
    back, backerr = fetch_taifex_backwardation()
    out["taifex_backwardation"], out["taifex_backwardation_error"] = back, backerr
    print(f"     → {back} 點（err={backerr}）")

    # ── 🌍 全球巨頭脈動(10 大國際指標,V21 加 SP500 + NASDAQ)──
    print("─" * 50)
    print("🌍 採集全球巨頭脈動(黃金/油/美元/BTC/VIX/日經/恆指/韓股/SP500/NASDAQ)")
    big_player_fns = [
        ("黃金",         "gold",   fetch_gold),
        ("WTI原油",       "wti",    fetch_wti_oil),
        ("美元指數DXY",    "dxy",    fetch_dxy),
        ("比特幣BTC",     "btc",    fetch_btc),
        ("VIX恐慌",       "vix",    fetch_vix),
        ("日經225",       "nikkei", fetch_nikkei),
        ("恆生指數",       "hsi",    fetch_hsi),
        ("韓股KOSPI",     "kospi",  fetch_kospi),
        ("標普500",      "sp500",  fetch_sp500),
        ("那斯達克",      "nasdaq", fetch_nasdaq),
        ("道瓊",         "dji",    fetch_dji),        # 💡 V58.7 盤前體檢美股欄補進新鮮檔
        ("費半",         "sox",    fetch_sox),
        ("台積電ADR",     "tsm",    fetch_tsm_adr),
        ("日月光ADR",     "asx",    fetch_asx_adr),
        ("聯電ADR",       "umc",    fetch_umc_adr),
        ("標普期貨",       "es_fut", fetch_es_fut),      # 💡 V68.8.2 美股期貨(盤後即時)
        ("道瓊期貨",       "ym_fut", fetch_ym_fut),
        ("那指期貨",       "nq_fut", fetch_nq_fut),
        ("美債10Y",       "ust10y", fetch_ust10y),      # 💡 V68.8.2 美債殖利率
    ]
    key_alias = {"gold": "gold_usd", "wti": "wti_oil", "dxy": "dxy",
                 "btc": "btc_usd", "vix": "vix", "nikkei": "nikkei",
                 "hsi": "hsi", "kospi": "kospi",
                 "sp500": "sp500", "nasdaq": "nasdaq",
                 "dji": "dji", "sox": "sox", "tsm": "tsm", "asx": "asx", "umc": "umc",
                 "es_fut": "es_fut", "ym_fut": "ym_fut", "nq_fut": "nq_fut", "ust10y": "ust10y"}
    for i, (name, key, fn) in enumerate(big_player_fns, 9):
        print(f"[{i}] {name}…")
        val, chg, err = fn()
        out[key_alias[key]]      = val
        out[f"{key}_chg_pct"]    = chg
        out[f"{key}_error"]      = err
        if val is not None:
            sign = "+" if (chg or 0) > 0 else ""
            print(f"     → {val} ({sign}{chg}%)")
        else:
            print(f"     → 失敗:{err}")

    # ── 🌡️ 國發會景氣對策信號(Q2 自動抓取,每月 27 號發布)──
    print("─" * 50)
    print("🌡️ 抓取國發會景氣對策信號(每月 27 號發布上月燈號)…")
    bsi_light, bsi_score, bsi_month, bsi_err = fetch_business_signal()
    # V23.2 — 失敗時 stale fallback:讀上次 macro_risk.json 保留 light,加 stale=True 標示
    if not bsi_light:
        try:
            prev_path = Path('data/macro_risk.json')
            if prev_path.exists():
                prev = json.loads(prev_path.read_text(encoding='utf-8'))
                prev_bsi = (prev.get('business_signal') or {})
                if prev_bsi.get('light'):
                    bsi_light  = prev_bsi['light']
                    bsi_score  = prev_bsi.get('score')
                    bsi_month  = prev_bsi.get('month')
                    out["business_signal"] = {
                        "light":  bsi_light,
                        "score":  bsi_score,
                        "month":  bsi_month,
                        "source": "ndc-stale",
                        "stale":  True,
                        "last_error": bsi_err,
                    }
                    print(f"   ⚠️ NDC 抓取失敗({bsi_err}),保留上次 {bsi_month}: {bsi_light} ({bsi_score} 分)")
        except Exception as e:
            print(f"   ⚠️ stale fallback 讀檔失敗:{e}")
    if "business_signal" not in out:
        out["business_signal"] = {
            "light":  bsi_light,
            "score":  bsi_score,
            "month":  bsi_month,
            "source": "ndc",
            "error":  bsi_err,
        }
    if bsi_light and not out["business_signal"].get("stale"):
        print(f"   → {bsi_month}: {bsi_light} ({bsi_score} 分)")
    elif not bsi_light:
        print(f"   → 失敗(前端 fallback 手動下拉):{bsi_err}")

    # V25.4 — ^TWII 60 日百分位(給主力護盤判讀真低/高檔用)
    print("📊 採集 ^TWII 60 日位置百分位…")
    twii_pos_data = fetch_twii_position()
    if twii_pos_data:
        out['twii_pos'] = twii_pos_data['pos_60d']
        out['twii_pos_detail'] = twii_pos_data
        print(f"   → ^TWII ${twii_pos_data['price']} = 過去 60 日 {twii_pos_data['pos_60d']}% 分位 (lo:{twii_pos_data['lo_60d']} / hi:{twii_pos_data['hi_60d']})")
    else:
        print("   → ^TWII 百分位抓取失敗")

    # ── 🏭 美股產業 ETF 板塊對應(Q3 板塊輪動配 ETF)──
    print("─" * 50)
    out["sector_etfs"] = fetch_sector_etfs()

    # ── 🌃 V23.3 — 台指期實時點(給前端頂部 3 指數區顯示) ──
    print("─" * 50)
    print("🌃 抓取台指期 TX 近月實時點(yfinance ^TXF=F)…")
    tx_now = fetch_taifex_tx_now()
    out["taifex_tx_now"] = tx_now
    if tx_now.get("price") is not None:
        # 🛡️ V36.9 修:OpenAPI fallback 時 chg=None,舊 f-string {None:+.2f} 會頂層崩潰
        #    → macro_risk.json 自 2026-06-26 起整支沒寫出。改成 chg 缺值時不格式化。
        if tx_now.get("chg") is not None:
            print(f"   → {tx_now['price']} ({tx_now['chg']:+.2f}%)")
        else:
            print(f"   → {tx_now['price']}(估,無前日比較)")
    else:
        print(f"   → 失敗:{tx_now.get('error')}")

    # ── 🦅 獵鷹建倉分:全球宏觀避險因子(日圓 / 3日變動 / 黑天鵝旗標;年線乖離已停用)──
    print("─" * 50)
    print("🦅 採集獵鷹建倉宏觀因子(日圓套利 / 3日變動 / 大盤懼高症)")
    # 日圓(JPY=X = USD/JPY,日圓升值=此值下跌)
    jpy_val, jpy_chg, jpy_err = fetch_jpy()
    out["jpy"], out["jpy_chg_pct"], out["jpy_error"] = jpy_val, jpy_chg, jpy_err
    # 3 日變動率(避險煞車:日圓急升=USDJPY 3日跌、金/油 3日暴漲)
    out["jpy_chg_3d"]  = _yf_chg_3d("JPY=X",  "日圓")
    out["gold_chg_3d"] = _yf_chg_3d("GC=F",   "黃金")
    out["wti_chg_3d"]  = _yf_chg_3d("CL=F",   "WTI原油")
    print(f"   · 日圓 {jpy_val}({jpy_chg}% 日/{out['jpy_chg_3d']}% 3日) 金3日 {out['gold_chg_3d']}% 油3日 {out['wti_chg_3d']}%")
    # V17.0 — 大盤 240MA 年線乖離率前端 V16.5 _loadTaiexMA240Bias 直接從 data/^TWII.json 算,
    #         macro_miner 不再嘗試寫此欄位(yfinance ^TWII 2y 在 GHA runner 不穩,改由 miner.py mine batch 0 抓)

    # 🦅 黑天鵝防禦旗標(全市場同步,供 radar_miner 算建倉分 + 前端防禦矩陣顯示)
    #    日圓急升:USDJPY 3日 < -1.5%(利差交易平倉);金/油單日 > 3%(通膨地緣恐慌);KOSPI 早盤 < -1.5%
    _jpy3 = out.get("jpy_chg_3d")
    _gold1 = out.get("gold_chg_pct")
    _wti1 = out.get("wti_chg_pct")
    _kospi1 = out.get("kospi_chg_pct")
    # V21 — Q5 風險指數整合:加美股大盤(昨夜 SP500/NASDAQ 跌 > 1% → 台股風險)+ 日經早盤同步
    _sp500_1 = out.get("sp500_chg_pct")
    _nasdaq_1 = out.get("nasdaq_chg_pct")
    _nikkei_1 = out.get("nikkei_chg_pct")
    out["blackswan"] = {
        # V17.0 — 移除 dead market_bias_high(永遠 False);大盤懼高判定改前端用 ^TWII 240MA 即時算
        "jpy_surge":        (_jpy3 is not None and _jpy3 < -1.5),    # 日圓急升(USDJPY 跌)→ -20
        "metal_oil_spike":  ((_gold1 is not None and _gold1 > 3) or (_wti1 is not None and _wti1 > 3)),  # 金/油暴漲 → -20
        "kospi_dump":       (_kospi1 is not None and _kospi1 < -1.5),  # 亞股提款 → -10
        # V21 新增:美股 + 日經風險(台股 80% 看美股臉色)
        "us_market_dump":   ((_sp500_1 is not None and _sp500_1 < -1.0) or (_nasdaq_1 is not None and _nasdaq_1 < -1.5)),  # 美股昨夜大跌 → -15
        "nikkei_dump":      (_nikkei_1 is not None and _nikkei_1 < -1.5),  # 日經早盤大跌 → -10
    }
    print(f"   🦅 黑天鵝旗標:{out['blackswan']}")

    out["fi_complex_conclusion"] = judge_fi_complex(fut, spot)
    print(f"\n🎯 複合判定：{out['fi_complex_conclusion']}")

    # 🛡️ 斷崖防護：對每個 None 欄位，用「上一次的 macro_risk.json」補值，
    # 並標記 _from_cache_yesterday=True；避免單日 API 抽風(如 TWSE 307)就讓使用者看到大片「採集中」。
    #   來源優先序(V41.13 修 macro_cron fresh-checkout 無本地檔 → 斷崖防護整個跳過、單次 307 就全 None):
    #     ① 本地 data/macro_risk.json(daily_miner 會 git archive origin/data 鋪好)
    #     ② 線上 data 分支 raw(snapshot 備份,通常最完整)
    #     ③ 線上 gh-pages(已部署版)
    try:
        prev = None
        if OUTPUT_FILE.exists():
            try: prev = json.loads(OUTPUT_FILE.read_text(encoding="utf-8"))
            except Exception: prev = None
        if not prev or all(prev.get(k) is None for k in ("fi_spot_net", "fi_total_net")):
            for _label, _url in (("data 分支 raw", "https://raw.githubusercontent.com/xin7355-collab/StockAI-DB/data/data/macro_risk.json"),
                                  ("gh-pages", "https://xin7355-collab.github.io/StockAI-DB/data/macro_risk.json")):
                try:
                    _r = http.get(_url, timeout=12)
                    if _r.status_code == 200:
                        _j = _r.json()
                        # 取「法人有值」的那份當基準,避免拿到同樣是 null 的版本
                        if _j.get("fi_total_net") is not None or (not prev):
                            prev = _j
                            print(f"  🛡️ 斷崖防護：本地舊檔缺法人,改抓線上 {_label} 版當基準")
                            if _j.get("fi_total_net") is not None:
                                break
                except Exception as _e:
                    print(f"  ⚠️ 斷崖防護抓線上 {_label} 失敗：{_e}")
        if prev:
            patched = []
            for key in ("us10y_yield", "us2y_yield", "fi_spot_net", "fi_futures_net",
                        # 🌅 V41.13 三大法人(投信/自營/合計)也納入斷崖防護(V36.8 加了欄位卻漏加保護 → 單次 307 就消失)
                        "fi_trust_net", "fi_dealer_net", "fi_total_net",
                        "fi_spot_date", "fi_three_date",
                        "usdtwd", "usdtwd_chg_pct", "usdtwd_chg_5d",
                        "krw", "krw_chg_pct", "krw_chg_5d", "cny", "cny_chg_pct", "cny_chg_5d",
                        "fear_greed", "fear_greed_label",
                        "retail_ls_pct", "taifex_backwardation",
                        # 🌍 全球巨頭脈動 10 指標斷崖防護(V21 加 SP500/NASDAQ)
                        "gold_usd", "gold_chg_pct", "wti_oil", "wti_chg_pct",
                        "dxy", "dxy_chg_pct", "btc_usd", "btc_chg_pct",
                        "vix", "vix_chg_pct", "nikkei", "nikkei_chg_pct",
                        "hsi", "hsi_chg_pct", "kospi", "kospi_chg_pct",
                        "sp500", "sp500_chg_pct", "nasdaq", "nasdaq_chg_pct",
                        # 💡 V58.7 道瓊/費半/三大 ADR 斷崖防護
                        "dji", "dji_chg_pct", "sox", "sox_chg_pct", "tsm", "tsm_chg_pct",
                        "asx", "asx_chg_pct", "umc", "umc_chg_pct",
                        # 🌡️ 景氣燈號 + 🏭 板塊 ETF(V21 斷崖防護)
                        "business_signal", "sector_etfs",
                        # 🦅 獵鷹建倉宏觀因子(API 偶失敗時沿用昨日,避免顯示待採)
                        "jpy", "jpy_chg_pct", "jpy_chg_3d", "gold_chg_3d", "wti_chg_3d",
                        # 🏦 戰區一新增(FRED 偶失敗時沿用昨日)
                        "m1b_yoy", "fed_assets_chg_pct", "fi_ratio_alert",
                        # 🤖 V70.3.0 行事曆 AI 解讀(429/無 key 那次沿用上次,不讓卡片忽有忽無)
                        "macro_events_ai"):
                if out.get(key) is None and prev.get(key) is not None:
                    out[key] = prev[key]
                    patched.append(key)
            if patched:
                out["_from_cache_yesterday"] = patched
                print(f"  🛡️ 斷崖防護：{len(patched)} 個欄位用昨天 cache 補值 → {patched}")
    except Exception as e:
        print(f"  ⚠️ 斷崖防護讀舊檔失敗：{e}（不影響本次寫檔）")

    # 🛡️ V27.8 — 全球指數/升貼水「離譜值守門」:超出合理範圍 = yfinance/來源誤值 → 設 None(前端顯 --);
    #          放斷崖防護「之後」,連昨日殘留壞值也一起擋。
    # 🐛 V57.7 — 絕對上限會過時!2026-07 日經真的漲到 68k、KOSPI 7.6k,被舊上限(65000/6000)每天誤殺
    #          → 前端「採集中」永不復原。改法:絕對範圍只留「數量級」超寬底線(擋 KOSPI 回成日經點位那種錯),
    #          精準守門改用「與上一份有效值比,單日 ±25% 不可能(熔斷都到不了)」的相對判斷,永不過時。
    try:
        _INDEX_SANITY = {'nikkei': (8000, 200000), 'kospi': (800, 30000), 'hsi': (5000, 90000),
                         'sp500': (1500, 40000), 'nasdaq': (4000, 120000),
                         'dji': (20000, 120000), 'sox': (2000, 60000)}   # 💡 V58.7 道瓊/費半數量級守門(ADR 是個股價,免守門)
        _prev_idx = prev if isinstance(prev, dict) else {}
        for _k, (_lo, _hi) in _INDEX_SANITY.items():
            _v = out.get(_k)
            if not isinstance(_v, (int, float)):
                continue
            _bad_reason = None
            if not (_lo <= _v <= _hi):
                _bad_reason = f"超出數量級範圍 [{_lo},{_hi}]"
            else:
                _pv = _prev_idx.get(_k)
                if isinstance(_pv, (int, float)) and _pv > 0 and abs(_v / _pv - 1) > 0.25:
                    _bad_reason = f"與上次有效值 {_pv} 差 {abs(_v / _pv - 1) * 100:.0f}%(單日不可能)"
            if _bad_reason:
                print(f"  ⚠️ {_k}={_v} {_bad_reason} → 判定來源誤值,設 None(不顯壞值)")
                out[_k] = None
                out[f"{_k}_chg_pct"] = None
        _tb = out.get('taifex_backwardation')
        if isinstance(_tb, (int, float)) and abs(_tb) > 600:
            print(f"  ⚠️ taifex_backwardation={_tb} 離譜(正常 ±300)→ 設 None")
            out['taifex_backwardation'] = None
    except Exception as e:
        print(f"  ⚠️ 離譜值守門失敗(不影響):{e}")

    # ── 🏦 戰區一升級:FRED 央行貨幣供給 + 期現比強化 ──
    try:
        fred_extra = fetch_m1b_and_fed_assets()
        out["m1b_yoy"] = fred_extra.get("m1b_yoy")
        out["fed_assets_chg_pct"] = fred_extra.get("fed_assets_chg_pct")
        # 流動性熱度:M1B 年增率換算 0-100(YoY 0%→30 偏冷、3%→55 中性、6%+→85 過熱)
        _yoy = out["m1b_yoy"]
        if _yoy is not None:
            pct = max(0, min(100, round(30 + _yoy * 9, 0)))
            out["m1b_pct"] = pct
            zone = "過熱⚠️" if pct >= 75 else "中性" if pct >= 45 else "偏冷"
            out["m1b_label"] = f"M1B年增 {_yoy}% · 熱度 {int(pct)}% ({zone})"
    except Exception as e:
        print(f"  ⚠️ FRED 央行資料失敗(不影響主流程):{e}")
        out["m1b_yoy"] = None
        out["fed_assets_chg_pct"] = None
    try:
        # V71.1.6 傳入加權指數,合約乘數才算得對(見 fi_ratio_alert_level 的說明)
        out["fi_ratio_alert"] = fi_ratio_alert_level(
            out.get("fi_spot_net"), out.get("fi_futures_net"), _LAST_TWII_SPOT)
        out["twii_close"] = _LAST_TWII_SPOT   # V71.1.6 一併吐給前端(反攻雷達的價差說明可引用)
        if out["fi_ratio_alert"]:
            print(f"  📊 {out['fi_ratio_alert']}")
    except Exception as e:
        print(f"  ⚠️ fi_ratio 計算失敗:{e}")
        out["fi_ratio_alert"] = None

    # ── 📅 全球重大財經事件日曆(純演算法,絕不拋例外)──
    try:
        from datetime import date as _date
        _warn_schedule_expiry(_date.today())   # 📅 V71.3.9 硬編碼 FOMC/BOJ 排程快用完就大聲喊
        out["upcoming_macro_events"] = _compute_upcoming_macro_events(_date.today(), window_days=14)
        # 📞 併入 TWSE 法說會逐檔日期(失敗回 [] 不影響演算法事件)
        try:
            _ec = fetch_earnings_calls(window_days=14)
            if _ec:
                out["upcoming_macro_events"] = sorted(
                    out["upcoming_macro_events"] + _ec, key=lambda x: x["date"])
                print(f"  📞 法說會併入 {len(_ec)} 場 → 行事曆共 {len(out['upcoming_macro_events'])} 場")
        except Exception as _e:
            print(f"  ⚠️ 法說會併入失敗(不影響):{_e}")
        print(f"📅 未來 14 日財經行事曆:{len(out['upcoming_macro_events'])} 場")
        # 🤖 V70.3.0 Groq 解讀(失敗不影響行事曆本身)
        try:
            _ai = build_macro_events_ai(out)
            if _ai:
                out["macro_events_ai"] = _ai
                print(f"  🤖 行事曆 AI 解讀完成({len(_ai.get('focus') or [])} 則重點)")
            else:
                print("  ℹ️ 行事曆 AI 未產出(無 key/429/解析失敗)→ 前端顯純事件表")
        except Exception as _e:
            print(f"  ⚠️ 行事曆 AI 例外(不影響):{_e}")
        for ev in out["upcoming_macro_events"]:
            print(f"     · {ev['date']}  {ev['event']}")
    except Exception as e:
        print(f"  ⚠️ 事件日曆演算法失敗(不影響主流程):{e}")
        out["upcoming_macro_events"] = []

    # 寫檔（最輕量）— 任何 IO 錯誤不能讓整個 daily_miner 崩潰
    # 🛡️ NaN 最後防線:json.dumps 預設 allow_nan=True 會輸出字面 NaN(非法 JSON),
    # 瀏覽器 JSON.parse 直接 throw → 前端整頁(範例)。寫檔前遞迴掃成 None,再用 allow_nan=False 鎖死。
    def _sanitize_nan(v):
        if isinstance(v, float) and (v != v or v in (float('inf'), float('-inf'))):
            return None
        if isinstance(v, dict):
            return {k: _sanitize_nan(x) for k, x in v.items()}
        if isinstance(v, list):
            return [_sanitize_nan(x) for x in v]
        return v
    # 🛡️ V69.8.4 P0-8 鐵律守門:外部源全掛時 out 幾乎全 None。macro_cron 每 4 小時
    #    reset --hard 後整檔覆蓋上線,空殼會直接蓋掉好資料且 4 小時後才有機會修 → 不寫檔。
    _key_fields = ['us10y_yield', 'fi_futures_net', 'fear_greed', 'sp500', 'vix', 'nikkei', 'usdtwd', 'gold_usd']
    _alive = sum(1 for k in _key_fields if out.get(k) is not None)
    if _alive < 3:
        print(f"❌ macro_risk 關鍵欄位只有 {_alive}/8 有值(疑似外部源全掛)→ 不寫檔,保留舊檔")
        sys.exit(0)
    try:
        OUTPUT_FILE.write_text(
            json.dumps(_sanitize_nan(out), ensure_ascii=False, indent=2, allow_nan=False),
            encoding="utf-8")
        print(f"✅ 已輸出 → {OUTPUT_FILE}")
    except Exception as e:
        print(f"⚠️ macro_risk.json 寫檔失敗（不影響其他流程）：{e}")
        sys.exit(0)   # 強制 exit 0 避免污染 workflow

    # V27.6 — item 3:每日風險快照 append 到 data/risk_history.json(不覆蓋,保留歷史趨勢)
    #          讀既有(deploy 底層 git archive origin/data 會保留)→ 同日去重 → 留最近 90 筆 → 寫回
    try:
        rh_file = DATA_DIR / 'risk_history.json'
        hist = []
        if rh_file.exists():
            try:
                _prev = json.loads(rh_file.read_text(encoding='utf-8'))
                hist = _prev if isinstance(_prev, list) else (_prev.get('data') or [])
            except Exception:
                hist = []
        today_str = (out.get('updated') or '')[:10] or datetime.now().strftime('%Y-%m-%d')
        snap = {
            'date': today_str,
            'vix': out.get('vix'),
            'sp500_chg_pct': out.get('sp500_chg_pct'),
            'fi_spot_net': out.get('fi_spot_net'),
            'fi_futures_net': out.get('fi_futures_net'),
            'retail_ls_pct': out.get('retail_ls_pct'),
            'taifex_backwardation': out.get('taifex_backwardation'),
            'jpy_chg_pct': out.get('jpy_chg_pct'),
            # 🇰🇷 V71.1.9 開始存韓/日:反攻雷達「韓股翻紅」目前是結構性推理(韓股半導體權重高、
            #   日經由日圓主導),**沒有回測依據**。存起來累積 3-6 個月後就能真的驗證
            #   「韓股 vs 日經 誰對台股次日開盤更有預測力」,而不是繼續用推理。
            'kospi_chg_pct': out.get('kospi_chg_pct'),
            'nikkei_chg_pct': out.get('nikkei_chg_pct'),
            'fear_greed': out.get('fear_greed'),
            'business_signal': (out.get('business_signal') or {}).get('light'),
            'blackswan_flags': sum(1 for v in (out.get('blackswan') or {}).values() if v),
        }
        # 💰 V70.2.7 大盤融資餘額(億)一併入每日快照 → 前端可算「融資 N 日增減」偵測斷頭賣壓宣洩
        try:
            _bw = json.loads((DATA_DIR / 'bubble_warning.json').read_text(encoding='utf-8'))
            _m = ((_bw or {}).get('margin_leverage') or {}).get('total_100m')
            if _m is not None:
                snap['margin_100m'] = _m
        except Exception:
            pass
        # 💰 V71.1.7 使用者問「能不能先補前 6 天?」→ 可以,TWSE MI_MARGN 支援指定日期。
        #    在 append 今日之前先把舊日期補齊,前端「融資 5 日增減」當天就能用,不用空等 6 個交易日。
        try:
            backfill_margin_history(hist)
        except Exception as _e:
            print(f"  ⚠️ 融資歷史回補略過(不影響今日快照):{_e}")
        hist = [h for h in hist if isinstance(h, dict) and h.get('date') != today_str]  # 同日去重
        hist.append(snap)
        hist = hist[-90:]   # 留最近 90 筆(約一季)
        rh_file.write_text(json.dumps(hist, ensure_ascii=False), encoding='utf-8')
        print(f"✅ risk_history.json 已 append 今日風險快照(共 {len(hist)} 筆歷史)")
    except Exception as e:
        print(f"⚠️ risk_history append 失敗(不影響其他):{e}")


def generate_bubble_warning():
    """抓取台灣證交所「全市場融資餘額」，生成泡沫預警 JSON"""
    try:
        print("\n" + "─" * 50)
        print("📊 開始抓取大盤融資餘額 (TWSE MI_MARGN)...")
        url = "https://www.twse.com.tw/exchangeReport/MI_MARGN?response=json&selectType=MS"
        # 使用系統內建帶有重試機制的 http session
        res = http.get(url, headers=HEADERS, timeout=10).json()

        # 擷取全市場融資餘額 (單位: 仟元)
        margin_str = res['tables'][0]['data'][2][5]
        margin_value_k = int(margin_str.replace(',', ''))
        margin_value_100m = margin_value_k / 100000  # 轉換為億元

        status = "✅ 健康 (散戶槓桿安定)"
        if margin_value_100m > 3200:
            status = "⛔ 極度危險 (融資餘額破3200億，散戶槓桿過熱，提防多殺多斷頭潮)"
        elif margin_value_100m > 2800:
            status = "🟡 警戒 (融資水位偏高，盤勢易震盪)"

        bubble_data = {
            "大盤融資餘額_億元": round(margin_value_100m, 2),
            "融資槓桿水位狀態": status,
            "警報說明": "融資餘額代表散戶借錢炒股的金額。水位過高代表市場泡沫化，下跌時容易引發斷頭賣壓。"
        }

        # 確保檔案存放在 data 資料夾，這樣才能被 GitHub 同步到網頁端！
        bubble_path = DATA_DIR / "bubble_warning.json"
        with open(bubble_path, 'w', encoding='utf-8') as f:
            json.dump(bubble_data, f, ensure_ascii=False, indent=4)

        print(f"✅ 成功生成 {bubble_path}: 目前融資餘額 {margin_value_100m:.2f} 億元")

    except Exception as e:
        print(f"❌ 抓取大盤融資餘額失敗: {e}")

# ==========================================
# 🚀 程式執行起點 (雙引擎同時發動)
# ==========================================
if __name__ == "__main__":
    try:
        # 第一引擎：抓取總經三大指標
        main()

        # ⛔ V69.8.4 P0-1:generate_bubble_warning() 已移除 —— 它用「3 個中文 key」的舊 schema
        #    整檔覆寫 miner.py build_bubble_warning() 的富 schema(broker_heat/junk_count/
        #    margin_leverage/kline_status),導致泡沫預警卡四格永遠空白。融資水位 miner.py
        #    的 margin_leverage 已含 total_100m 絕對值,功能完全覆蓋。函式保留但不再呼叫。

    except Exception as e:
        print(f"💥 macro_miner 頂層異常：{e}")
        traceback.print_exc()
        sys.exit(0)
