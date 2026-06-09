#!/usr/bin/env python3
"""
首席 AI 夜間批次分析(熱門清單預算式)

讀 data/radar_matrix.json 抓當日熱門 picks + 固定大盤標的清單,
對每檔用簡化版 prompt 呼叫 Groq,寫 data/chief_ai_cache.json,
讓白天 App 直接讀快取近乎零即時 token 消耗。

簡化版 prompt 犧牲(品質下降約 15~20%):
  - Category Router(個股/ETF/指數 三類降為單一通用提示)
  - 朱家泓折數區、unified-signal LED 對照
  - 型態警報、外資期現複合判定
保留:5/20/60/120 MA stance、60 日漲幅、三大法人、現價、最新新聞。
清單外標的 → 使用者在 App 觸發走自填 key 即時算(原 prompt 全規格)。

環境變數:
  GROQ_API_KEYS_BATCH = key1,key2,key3  (逗號分隔,撞 429 自動輪動)

輸出:
  data/chief_ai_cache.json
    {"updated": "YYYY-MM-DD", "_simplified": true, "stocks": {
       "2330": {"traffic_light": "...", "summary": "...",
                "bottom_bar": "...", "detail_action": "...", "_ts": 1234567890}}}
"""
import json
import os
import sys
import time
from datetime import date
from pathlib import Path

import requests

DATA_DIR = Path("data")
RADAR_FILE = DATA_DIR / "radar_matrix.json"
OUTPUT_FILE = DATA_DIR / "chief_ai_cache.json"


def _write_placeholder(reason, stocks=None):
    """寫一份合法 placeholder JSON,確保前端永遠 fetch 得到可 parse 的內容。
    在 main() 開頭先呼叫一次 → 即使後續 crash,deploy 也不會推 0 byte 殘檔。
    (根治:原本只有「無 key」才寫 placeholder,擋不住「有 key 但中途 crash」。)
    """
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        OUTPUT_FILE.write_text(json.dumps({
            "updated": date.today().isoformat(),
            "_placeholder": True,
            "_reason": reason,
            "stocks": stocks or {},
        }, ensure_ascii=False), encoding="utf-8")
        print(f"   📝 placeholder 已落地({reason}) → {OUTPUT_FILE}")
    except Exception as _e:
        print(f"   ⚠️ placeholder 寫入失敗: {_e}")

# 固定大盤/熱門 ETF 清單(無論 radar 結果如何永遠算這些)
FIXED_HOTLIST = ["2330", "^TWII", "0050", "0056", "00878", "00929"]
MAX_PICKS_PER_REGION = 10   # radar 每區取前 N 檔(共 3 區)
MAX_TOTAL = 30              # 整體上限,防 token 失控

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL = "llama-3.3-70b-versatile"
SLEEP_BETWEEN_CALLS = 2.5   # 同 universal_radar.py:346 防 429

# ── [Key 輪動] 鏡像 universal_radar 同款邏輯 ────────────────────────────────
# Multi-name secret fallback:使用者 secret 命名常見多種拼法,優先順序取第一個有值,
# 避免「設了 secret 但名字稍微差一字」導致整批跑空。順序:BATCH 專用 → KEYS 池 → 單把 KEY
_GROQ_ENV_NAMES = [
    "GROQ_API_KEYS_BATCH",   # 標準 (BATCH 池)
    "GROQ_API_KEY_BATCH",    # 常見拼法漏 S
    "GROQ_BATCH_API_KEYS",   # 常見拼法字序錯
    "GROQ_API_KEYS",         # 白天池(fallback)
    "GROQ_API_KEY",          # 單把(fallback)
]
_groq_env = ""
_groq_src = None
for _name in _GROQ_ENV_NAMES:
    _v = os.environ.get(_name, "").strip()
    if _v:
        _groq_env, _groq_src = _v, _name
        break
GROQ_KEYS = [t.strip() for t in _groq_env.split(",") if t.strip()]
_idx = 0
_cooldown = {}   # idx -> unix_ts 解凍時間


def _active_idx(now: float):
    if not GROQ_KEYS:
        return None
    for off in range(len(GROQ_KEYS)):
        i = (_idx + off) % len(GROQ_KEYS)
        if _cooldown.get(i, 0) <= now:
            return i
    return None


def _mark_blocked(i: int, retry_after_sec: int):
    cd = max(retry_after_sec or 3600, 60)
    _cooldown[i] = time.time() + cd
    print(f"  ⏳ Key #{i + 1}/{len(GROQ_KEYS)} 冷卻 {cd}s")


def _advance():
    global _idx
    if GROQ_KEYS:
        _idx = (_idx + 1) % len(GROQ_KEYS)


def call_groq(prompt: str, label: str = "") -> dict | None:
    """回傳 parsed JSON dict 或 None。"""
    if not GROQ_KEYS:
        print(f"  ❌ {label}:無 GROQ_API_KEYS_BATCH,跳過")
        return None
    payload = {
        "model": GROQ_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 1500,
        "temperature": 0.35,
        "response_format": {"type": "json_object"},
    }
    for _ in range(len(GROQ_KEYS) + 1):
        i = _active_idx(time.time())
        if i is None:
            print(f"  🚫 {label}:全 key 冷卻中")
            return None
        try:
            res = requests.post(
                GROQ_URL, json=payload,
                headers={"Authorization": f"Bearer {GROQ_KEYS[i]}", "Content-Type": "application/json"},
                timeout=30,
            )
            if res.status_code == 429:
                try:
                    retry_after = int(res.headers.get("Retry-After", 0))
                except Exception:
                    retry_after = 0
                _mark_blocked(i, retry_after)
                _advance()
                continue
            if res.status_code != 200:
                print(f"  ⚠️ {label} HTTP {res.status_code}: {res.text[:120]}")
                return None
            content = res.json()["choices"][0]["message"]["content"].strip()
            try:
                return json.loads(content)
            except json.JSONDecodeError:
                # 容錯:剝掉 markdown fence
                cleaned = content.strip().lstrip("`").lstrip("json").strip()
                end = cleaned.rfind("}")
                if end > 0:
                    try:
                        return json.loads(cleaned[: end + 1])
                    except json.JSONDecodeError:
                        pass
                print(f"  ⚠️ {label} JSON 解析失敗: {content[:120]}")
                return None
        except Exception as e:
            print(f"  ⚠️ {label} 例外: {e}")
            time.sleep(1)
    return None


# ── 行情計算 ────────────────────────────────────────────────────────────────
def _ma(closes: list, n: int) -> float | None:
    if len(closes) < n:
        return None
    return round(sum(closes[-n:]) / n, 2)


def _build_intel(sym: str) -> dict | None:
    """從 data/{sym}.json 讀出價量並算 MA + 60 日漲幅 + 法人淨額。"""
    f = DATA_DIR / f"{sym}.json"
    if not f.exists():
        return None
    try:
        raw = json.loads(f.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"  ⚠️ {sym}.json 讀取失敗: {e}")
        return None

    # 🔴 真因修復:data/{sym}.json 是 list of dict(不是 dict),原本 raw.get() 立刻 throw
    # 同時相容舊 dict 格式(若未來改回包 wrapper)
    if isinstance(raw, list):
        rows = raw
        name = sym
    elif isinstance(raw, dict):
        rows = raw.get("data") or raw.get("ohlcv") or []
        name = raw.get("name") or raw.get("stock_name") or sym
    else:
        print(f"  ⚠️ {sym}.json 格式異常 type={type(raw).__name__}")
        return None

    if not rows or len(rows) < 30:
        return None

    closes = [r.get("close") for r in rows if r.get("close") is not None]
    if len(closes) < 30:
        return None
    last = closes[-1]
    ma5 = _ma(closes, 5)
    ma20 = _ma(closes, 20)
    ma60 = _ma(closes, 60)
    ma120 = _ma(closes, 120)

    # 60 日漲幅
    chg60 = "--"
    if len(closes) >= 61 and closes[-61] > 0:
        chg60 = round((last - closes[-61]) / closes[-61] * 100, 2)

    # 近 5 日外資淨買賣(張):foreign_net 單位是「股」,÷1000 = 張(1 張 = 1000 股)
    fi_5d = 0
    for r in rows[-5:]:
        fi_5d += (r.get("foreign_net") or 0)
    fi_5d_lots = round(fi_5d / 1000, 1)   # 股 → 張

    # name 已在上方 isinstance 分支設定(list 格式用 sym,dict 格式用 raw.get)
    return {
        "sym": sym,
        "name": name,
        "close": last,
        "ma5": ma5, "ma20": ma20, "ma60": ma60, "ma120": ma120,
        "chg60pct": chg60,
        "foreign_5d_lots": fi_5d_lots,
    }


def _stance(price: float | None, ma: float | None, label: str) -> str:
    if price is None or ma is None:
        return f"{label}:--"
    diff_pct = (price - ma) / ma * 100
    if diff_pct >= 0.5:
        return f"{label} {ma}(站上 +{diff_pct:.1f}%)"
    if diff_pct <= -0.5:
        return f"{label} {ma}(跌破 {diff_pct:.1f}%)"
    return f"{label} {ma}(貼線拉鋸)"


def build_prompt(intel: dict) -> str:
    """簡化版 prompt(品質夠用,純夜間批次)。"""
    s = intel
    return f"""你是【頂級台股操盤總監】,依下方戰情下達操盤指令,口吻權證小哥風格,白話文國中生看得懂。
🛑 嚴禁自己算數學,所有數值只能引用下方給定的。
🛑 嚴禁說「根據資料」「以下為您分析」廢話,直接給點位與動作。

━━━━━━━━━━━━━━━━━━━━
【戰情】
- 標的:{s['name']} ({s['sym']})
- 最新收盤價:{s['close']}
- {_stance(s['close'], s['ma5'], '5MA')}
- {_stance(s['close'], s['ma20'], '20MA(月線)')}
- {_stance(s['close'], s['ma60'], '60MA(季線)')}
- {_stance(s['close'], s['ma120'], '120MA(半年線)')}
- 60 日累計漲幅:{s['chg60pct']}%
- 近 5 日外資累計淨買:{s['foreign_5d_lots']} 張({'買超' if s['foreign_5d_lots'] > 0 else '賣超' if s['foreign_5d_lots'] < 0 else '持平'})
- 庫存狀態:空手(假設,使用者可在 App 自行覆寫成本)

⚠️ 只准輸出純 JSON,**必須有且只有這 4 個 key**,禁 ```json 標籤、禁前後說明:
{{
  "traffic_light": "格式『<emoji+三選一動詞> — <25 字內現價與均線即時肉搏描述>』。三選一必須是 🟢強力買進 或 🟡觀望或減碼 或 🔴強制撤退。範例:'🟢強力買進 — 趨勢狂飆,不破 **{s['ma5']} 元** 不賣'",
  "summary": "30 字內首頁黃卡,強烈動詞 emoji 開頭(出貨🤑/低接試單🤔/抱緊🔥/快逃🚨/觀望🤨),融合屬性 + 數據 + 風險為一句話,必須帶具體點位",
  "bottom_bar": "15~20 字內置底浮動條,所有數字與動詞用 **xxx** 包起。範例:『空頭成型,**空手觀望等待**』或『站穩 **{s['ma20']} 元** **加碼🔥**』",
  "detail_action": "三段體完整評析,標題一字不差,段間用 \\n,每段 80~140 字。\\n【🌏 總體位階與大局觀】融合上方戰情對本檔當前位階做具體判讀,點名最關鍵 2~3 個利多/利空。\\n【⚔️ 總監專屬戰術室】依本檔當前位階給出今天的明確指令(進場價/防守點/目標價/移動停利數字),禁列舉所有可能。已跌破的均線禁稱「防守」,改稱「反彈壓力天花板」。\\n【🔥 首席操盤手終極喊話】挑一句口語化喊話(20~40 字),強烈動詞 emoji 開頭,帶具體點位。"
}}"""


# ── 主流程 ──────────────────────────────────────────────────────────────────
def collect_hotlist() -> list[str]:
    """從 radar_matrix 取 picks + 固定清單,dedupe 後回傳。"""
    syms: list[str] = list(FIXED_HOTLIST)
    if RADAR_FILE.exists():
        try:
            radar = json.loads(RADAR_FILE.read_text(encoding="utf-8"))
            for region in ("momentum", "swing", "sniper"):
                items = (radar.get("data") or {}).get(region, [])[:MAX_PICKS_PER_REGION]
                for it in items:
                    sym = it.get("sym")
                    if sym and sym not in syms:
                        syms.append(sym)
        except Exception as e:
            print(f"⚠️ radar_matrix.json 解析失敗: {e}")
    else:
        print(f"⚠️ {RADAR_FILE} 不存在,僅算固定清單")

    return syms[:MAX_TOTAL]


def main():
    print(f"🌙 首席 AI 夜間批次分析 — {date.today().isoformat()}")
    # 🛡️ 根治 0 byte:開頭就先寫一份合法 placeholder。
    #    即使下方任何一步 crash(且被 workflow 的 || echo 吞掉),
    #    deploy 也只會推這份合法 JSON,絕不會是 0 byte 殘檔。
    _write_placeholder("startup_guard")

    if GROQ_KEYS:
        print(f"   ✅ 載入 {len(GROQ_KEYS)} 把 key (src: {_groq_src})")
    else:
        print(f"   ❌ 五個 env 變體 ({', '.join(_GROQ_ENV_NAMES)}) 全空")
    if not GROQ_KEYS:
        _write_placeholder("no_groq_key")
        sys.exit(0)

    syms = collect_hotlist()
    print(f"   熱門清單共 {len(syms)} 檔: {', '.join(syms[:10])}{'...' if len(syms) > 10 else ''}")

    out_stocks: dict = {}
    success = 0
    err_types: dict = {}   # 錯誤型別計數(避免再被 try/except 吞掉看不出根因)
    skipped = 0
    for n, sym in enumerate(syms, 1):
        try:
            intel = _build_intel(sym)
            if not intel:
                skipped += 1
                print(f"  [{n}/{len(syms)}] {sym}:資料不足,跳過")
                continue

            prompt = build_prompt(intel)
            result = call_groq(prompt, label=f"{sym}")
            if result and result.get("detail_action"):
                result["_ts"] = int(time.time())
                out_stocks[sym] = result
                success += 1
                print(f"  [{n}/{len(syms)}] {sym} ✅")
            else:
                print(f"  [{n}/{len(syms)}] {sym} ❌ Groq 無回應")
        except Exception as _e:
            # 單檔失敗不可拖垮整批,但要清楚記錄錯誤型別
            etype = type(_e).__name__
            err_types[etype] = err_types.get(etype, 0) + 1
            print(f"  [{n}/{len(syms)}] {sym} 💥 {etype}: {str(_e)[:100]}")

        _advance()   # 每檔強制換 key,均勻消耗額度
        time.sleep(SLEEP_BETWEEN_CALLS)

    # 錯誤型別摘要(讓下次 log 一眼看出根因)
    if err_types:
        print(f"\n📊 錯誤型別統計: {dict(err_types)}")
    print(f"📊 總計:✅ {success} / ⏭️ {skipped} / 💥 {sum(err_types.values())} / 全部 {len(syms)} 檔")

    output = {
        "updated": date.today().isoformat(),
        "_simplified": True,
        "stocks": out_stocks,
    }
    DATA_DIR.mkdir(exist_ok=True)
    OUTPUT_FILE.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n✅ 寫入 {OUTPUT_FILE} — {success}/{len(syms)} 檔成功")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        # 頂層保險:main 任何未捕捉例外 → 確保 OUTPUT_FILE 仍是合法 JSON
        print(f"💥 chief_ai_batch 頂層例外: {e}")
        if not (OUTPUT_FILE.exists() and OUTPUT_FILE.stat().st_size > 2):
            _write_placeholder("top_level_crash")
        sys.exit(0)
