#!/usr/bin/env python3
"""
🤖 Groq 模型名稱自我解析 + 自我修復(V73.9.1)

🚨 **為什麼需要這支**(2026-08-25 從使用者截圖查出來的):
   `radar_news.json` 裡每一則的 `ai_reason` 都是「**API 錯誤 404**」。
   404 的語意是「**這個模型名字不存在**」—— ⛔ 不是金鑰壞、不是額度用完。
   `universal_radar.py` 寫死 `llama-3.1-8b-instant`,而 Groq 已經把它下架了。

⭐⭐ **一個 404 打掉三件事**,因為它們全在同一個呼叫裡:
   ① `title_zh` → **國際新聞標題完全沒有翻譯**(前端卻寫著「已由採礦機翻成中文」)
   ② `sentiment` → 全部退回「中立」,判讀等於沒有
   ③ `important` → 失敗時預設 `True` → **垃圾新聞全部放行**
      (實測混進「美國某地回收廠火災」「MacKenzie Scott 捐款」這種跟台股無關的)

⛔ **第一個直覺(換一個新 slug 寫死)是錯的** —— 那只是把同一顆地雷往後埋。
⭐ 照本專案 V73.8.0 對 OpenRouter 的做法(以及 `_taifex_list_endpoints` / FinMind 資料集名
   那兩次):**讓官方自己說現在有哪些模型**,程式照偏好序挑。

⛔ **四個必須留著的保險**(⛔ 別「簡化」掉):
 ① 解析失敗 → 退回**上次成功過的** → 再退回 `_LEGACY` 硬清單
    —— **絕不能比改版前更糟**(⛔ 不可 throw、不可回 None)。
 ② `chat` 回 404 → **清快取、重新解析、換一個模型再打一次**(自我修復)。
 ③ 一個都配不到時,把它**實際有的清單**印出來 —— 不然下一個人只能重新猜一輪
    (這正是「只寫 HTTP 404」害我們查半天的原因)。
 ④ 🔐 **只印「第幾把 key」,⛔ 絕不印 token 值**(repo 是 public)。

🚦 **失敗分類(2026-11-13)**:以前四支採礦程式都只看狀態碼 —— 429 一律換下一把 / 整把冷卻、404 一律當模型下架。
   但 429 有三種(每分鐘限流 / 每日額度用完 / 餘額不足),404 也可能只是網址錯 → 見下方 classify()。
   用法:`groq_common.classify_response(res)['kind']`;額度用完 → `cool_model(model, 'quota', delay)`,
   之後 `groq_model()` 自動避開它(同一家其他模型照用)。自我測試:`python3 groq_common.py --selftest`。
"""
import datetime
import email.utils
import json
import math
import os
import re
import sys
import time

import requests

GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models'
GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions'

# ⭐ 偏好序用**正規表示式**,⛔ 不比對固定字串 —— 版號會一直變(3.1 → 3.3 → …)。
#   兩個層級:heavy = 質化判讀;light = 大量、便宜的工作(翻譯標題)。
# 🚨 V79.5.8 2026-10-22 實測 Groq 清單**一個 llama 都沒有了**(只剩 gpt-oss-120b / gpt-oss-20b /
#    qwen3.8-27b / allam-2-7b)→ 舊偏好序全部配不到:每一則先白打一次 404,再從**亂序**清單拿第一個
#    (1/4 機會是阿拉伯文的 allam)→ radar_news 出現「AI 回的內容看不懂」與亂碼原因。
#    ⭐ llama 那幾條留在最前面(回來了照舊用、行為不變),後面接 qwen(中文強、Groq 上預設不思考)→ gpt-oss。
_PREFS = {
    'heavy': [r'llama-3\.3-70b', r'llama-\d+(\.\d+)?-70b', r'llama.*70b',
              r'llama.*(instruct|versatile)', r'^llama',
              r'qwen', r'gpt-oss-120b', r'gpt-oss'],
    'light': [r'llama-3\.\d+-8b', r'llama.*8b', r'.*instant',
              r'llama-3\.3-70b', r'^llama',
              r'qwen', r'gpt-oss-20b', r'gpt-oss'],
}

# 🛟 保險②:解析不到時的硬清單(⛔ 只當最後手段,不是主要來源)
#    V79.5.8 llama 已全部下架 → 改成 10/22 清單上實際存在、中文最好的那一個
_LEGACY = {'heavy': 'qwen/qwen3.8-27b', 'light': 'qwen/qwen3.8-27b'}

# 🈚 V79.5.8 聊得了天、但不適合中文的模型(allam = 阿拉伯文模型)—— 跟非聊天模型一樣,取清單時就濾掉
_UNSUITED = re.compile(r'allam', re.I)

# 🧠 V79.5.8 每個模型要帶的參數不一樣(Groq 官方文件):
#    - qwen3:Groq 上預設就不思考;明寫 none,免得哪天預設改了 → 思考內容混進答案、吃掉字數
#    - gpt-oss:預設 medium 思考,思考跟答案共用同一個 max_tokens → 低強度 + 不回傳思考,額度再多給 400
#    - 其他(llama…):⛔ 什麼都不帶 —— 帶了 reasoning 參數會被拒(400)
_EXTRA_KEYS = ('reasoning_effort', 'include_reasoning', 'reasoning_format')
_GPTOSS_BUDGET = 400

# 🚨 V73.9.3 **非聊天模型一律先濾掉**(實測踩到:解析器挑到 `whisper-large-v3`(語音辨識)
#    與 `canopylabs/orpheus`(語音合成)→ Groq 回 400
#    「The model … does not support」/「failed to template request」)。
#    ⛔ 真因是我自己在「硬清單也要尊重 avoid」那段加的緊急退路**沒有限制模型種類**。
#    ⭐ 正解:**在取清單的當下就濾掉**,而不是在每一條挑選路徑各補一次判斷
#       —— 補在挑選端遲早會漏掉一條(陷阱 #37 的同型)。
_NON_CHAT = re.compile(
    r'whisper|tts|orpheus|speech|audio|embed|guard|moderation|rerank|vision-only|playai',
    re.I)

_cache = {'ids': None, 'at': 0.0, 'err': ''}
_good = {}          # tier → 上次成功過的模型名
_TTL = 6 * 3600     # ⚠️ 模型下架是常態,⛔ 不可永久快取


def _list_models(keys):
    """問 Groq 現在實際有哪些模型。回 (ids, err_note)。⛔ 絕不印 token。"""
    if _cache['ids'] is not None and (time.time() - _cache['at']) < _TTL:
        return _cache['ids'], _cache['err']
    ids, err = [], ''
    for i, k in enumerate(keys or []):
        try:
            r = requests.get(GROQ_MODELS_URL, timeout=15,
                             headers={'Authorization': f'Bearer {k}'})
            if r.status_code != 200:
                err = f'key#{i + 1} HTTP {r.status_code}'   # 🔐 只記第幾把
                continue
            raw = [m.get('id') for m in (r.json().get('data') or []) if m.get('id')]
            chat = [m for m in raw if not _NON_CHAT.search(m)]
            if len(raw) != len(chat):
                print(f'  🧹 [Groq] 濾掉 {len(raw) - len(chat)} 個非聊天模型(語音/嵌入/防護類)')
            ids = [m for m in chat if not _UNSUITED.search(m)]
            if len(chat) != len(ids):
                print(f'  🧹 [Groq] 濾掉 {len(chat) - len(ids)} 個不適合中文的模型({", ".join(m for m in chat if _UNSUITED.search(m))})')
            if ids:
                err = ''
                break
        except Exception as e:
            err = f'key#{i + 1} {type(e).__name__}'
    _cache.update(ids=ids, at=time.time(), err=err)
    return ids, err


def groq_model(keys, tier='light', avoid=None):
    """挑一個現在真的存在的模型名。⛔ 永遠回一個字串,不會回 None。
    🚦 冷卻中的模型(今天額度用完,cool_model 記的)跟 avoid 一樣跳過;每個候選都在冷卻時照樣回一個名字,
       呼叫端用 cooling_left(model) > 0 判斷「這次就別打了」。"""
    avoid = set(avoid or ()) | cooling_models()
    ids, err = _list_models(keys)
    for pat in _PREFS.get(tier, _PREFS['light']):
        for mid in ids:
            if mid not in avoid and re.search(pat, mid, re.I):
                _good[tier] = mid
                return mid
    # ① 退回上次成功過的 → 再退回硬清單
    if _good.get(tier) and _good[tier] not in avoid:
        return _good[tier]
    if ids and all(m in avoid for m in ids) and cooling_models():
        print(f'  ⏳ [Groq] {tier} 的每個模型都在冷卻(今天額度用完)或已避開')
    elif ids:
        # ③ 一個都配不到 → 把實際清單印出來,別讓下一個人重新猜
        print(f'  ⚠️ [Groq] 偏好序配不到 {tier};它實際有的是:{", ".join(ids[:25])}')
    elif err:
        print(f'  ⚠️ [Groq] 取不到模型清單({err}),退回硬清單')
    # ⚠️ 硬清單也要尊重 avoid —— ⛔ 回一個「已知 404」的模型會把重試次數白白燒光,
    #    而且外層會誤以為「已經換過了」(V73.9.1 用注入缺陷才發現這個洞)。
    leg = _LEGACY.get(tier, _LEGACY['light'])
    if leg in avoid:
        # ⛔ V79.5.8 不再拿清單的第一個 —— Groq 每次回的順序都不一樣,等於抽籤(實測 1/4 抽到 allam)
        #    → 照名字排序挑,同一份清單永遠挑同一個(清單在取的時候已濾掉非聊天 / 不適合中文的)
        for mid in sorted(ids):
            if mid not in avoid:
                return mid
        for t2, v2 in _LEGACY.items():
            if v2 not in avoid and not _NON_CHAT.search(v2):
                return v2
    return leg


def groq_extra(model):
    """🧠 V79.5.8 這個模型要多帶的參數(見 _EXTRA_KEYS 上面的說明)。⛔ llama 等其他模型回 {}。
    ⚠️ 跟 index.html `_groqExtra` 是同一份規則(test_ai_model_pick.mjs 跨語言比對)。"""
    m = (model or '').lower()
    if 'gpt-oss' in m:
        return {'reasoning_effort': 'low', 'include_reasoning': False}
    if 'qwen' in m:
        return {'reasoning_effort': 'none'}
    return {}


def groq_budget(model, max_tokens):
    """🧠 V79.5.8 gpt-oss 的思考跟答案共用 max_tokens → 多給 400,⛔ 不然 300 字的翻譯會被思考吃光、回空的。"""
    if max_tokens and 'gpt-oss' in (model or '').lower():
        return int(max_tokens) + _GPTOSS_BUDGET
    return max_tokens


def groq_apply(payload, model, base_max=None):
    """🧠 V79.5.8 把「這個模型專用」的參數套進 payload(就地改、也回傳)。
    ⭐ 先拿掉上一個模型留下的(404 換模型時,⛔ 不可把 gpt-oss 的參數帶給 llama → 400);
       max_tokens 一律從呼叫端原本的值重算(⛔ 不可在換模型時一直往上疊)。"""
    for k in _EXTRA_KEYS:
        payload.pop(k, None)
    payload['model'] = model
    payload.update(groq_extra(model))
    if base_max is not None:
        payload['max_tokens'] = groq_budget(model, base_max)
    return payload


def groq_reason(status: int, kind: str = None) -> str:
    """把光禿禿的狀態碼翻成白話(V26.18 錯誤訊息白話化鐵則)。⛔ 各碼不可同一句。
    🚦 有 classify_response 的分類就照分類講(同一個 429 可能是限流、也可能是今天額度用完 / 餘額不足)。"""
    by_kind = {
        'quota': 'AI 今天額度用完(已改用其他模型,全部用完要等恢復)',
        'billing': 'AI 帳戶餘額不足(請到 Groq 帳單頁檢查)',
        'config': 'AI 服務網址找不到(不是模型下架)',
    }
    if kind in by_kind:
        return by_kind[kind]
    return {
        400: 'AI 請求格式被拒',
        401: 'AI 金鑰無效(請更新設定)',
        403: 'AI 金鑰沒有這個權限',
        404: 'AI 模型已被下架(正在自動換一個)',
        413: '內容太長',
        429: 'AI 用量到上限,稍後再試',
        500: 'AI 服務忙碌', 502: 'AI 服務忙碌', 503: 'AI 服務忙碌',
    }.get(status, f'AI 暫時無法分析({status})')


def invalidate(tier=None, model=None):
    """② 自我修復:回應說模型不存在(classify 的 missing)時呼叫 —— 清快取,下次重新問官方。
    🚦 ⛔ 404 但回應沒說是模型(網址錯 / 中間的 Proxy,classify 的 config)不要呼叫:會把好好的模型當成下架。"""
    _cache.update(ids=None, at=0.0)
    if tier and _good.get(tier) == model:
        _good.pop(tier, None)


# ══ 🚦 失敗分類(2026-11-13)════════════════════════════════════════════
# 🐛 以前每一個 429 都當成同一件事(換下一把 / 整把冷卻一小時),每一個 404 都當成模型下架。
#    但 429 有三種:① 每分鐘限流(等幾秒就好)② 每日 / 每月額度用完(等幾秒不會好,而且**只有那一個模型**用完,
#    Groq 的額度是每個模型分開算的)③ 餘額 / 帳單問題(等多久都不會好)。404 也可能只是網址錯。
#    以前只看 status_code、回應內容一個字都沒讀,所以分不出來。
# ⭐ 規則照抄 skl(同一位使用者的 repo,MIT)的 ai-model-router:
#    xin-toolkit/skills/ai-model-router/scripts/model_router.py(commit 2dc9408)的
#    parse_delay / text_delay / _reset_delay / _flat / _gemini_details / _meta_reset / with_headers / classify 與常數。
#    ⛔ 改規則兩邊一起改:這裡 + index.html 的 _AIR(App 端,照 skl 的 assets/model_router.js 抄);
#    兩邊跑同一份案例 scripts/fixtures/ai_router_cases.json(= skl 的 assets/router_cases.json 原檔),
#    scripts/test_ai429.mjs 另外拿兩邊的正規表示式逐字比對。
# 冷卻多久(秒)跟 skl 一樣:額度用完沒說何時恢復先避開 1 小時;說「幾秒後再試」不可信(Gemini 每日額度也附幾秒的
# retryDelay,照等還是 429)→ 至少 5 分鐘;怪異的 Retry-After 最多一天。限流沒說多久 → 1 分鐘(每分鐘的窗口)。
QUOTA_COOLDOWN = 3600
QUOTA_MIN_COOLDOWN = 300
MAX_COOLDOWN = 86400
RATE_COOLDOWN = 60

# 以下規則 Python 與 JS 兩邊要一模一樣(re.A:\b、\d 只認英數,跟 JS 一致)。
# 回應「明確說」模型不存在 / 下架才算:只看 404 會把網址打錯也當成模型下架,一路把每個模型都標掉。
MODEL_MISSING = re.compile(
    r"model_not_found|model_decommissioned|decommissioned"
    r"|\bmodels?\b[\s\S]{0,160}?(?:does not exist|not found|no longer (?:available|supported)"
    r"|has been (?:deprecated|retired|removed))"
    r"|not_found_error[\s\S]{0,80}?\bmodel\b|not a valid model|no endpoints found for", re.I | re.A)
# 餘額 / 帳單:等多久都不會好。⛔ 不能只比對 billing、credits 這種字:Groq 每分鐘限流的訊息有 settings/billing 網址、
# Gemini 每分鐘限流寫「check your plan and billing details」、OpenRouter 每日上限寫「Add 10 credits」,都不是沒錢。
BILLING = re.compile(
    r"insufficient[_\s-]?(?:balance|credits?|funds|quota)|credit balance is too low"
    r"|(?:out of|no remaining|not enough) credits?|requires more credits|can only afford"
    r"|credits? (?:are |have been )?(?:depleted|exhausted)|prepayment|payment required"
    r"|(?:billing|spend(?:ing)?) (?:hard )?limit|exceeded (?:your |the )?(?:monthly )?(?:budget|spend(?:ing)?)\b"
    r"|reached your specified (?:api )?usage limits?|billing[_\s]not[_\s]active"
    r"|billing account[\s\S]{0,60}?(?:disabled|closed|suspended)"
    r"|account[_\s](?:is[_\s])?(?:deactivated|suspended|inactive|not[_\s]active)|arrears", re.I | re.A)
# 每日 / 每週 / 每月額度:Groq 寫 tokens per day (TPD) / requests per day (RPD)、OpenRouter 寫 free-models-per-day、
# Gemini 的 quotaId 寫 ...PerDay...。「today」不算(Groq 每分鐘限流也寫 Upgrade to Dev Tier today)。
LONG_WINDOW = re.compile(r"per[\s_-]?(?:day|week|month)|\b(?:rpd|tpd)\b|\b(?:daily|weekly|monthly)\b", re.I | re.A)
# 訊息裡的等待時間:Groq「try again in 7m26.4s」、Gemini「Please retry in 17.3s」、「retry after 30 seconds」
TEXT_DELAY = re.compile(r"(?:try again|retry)\s+(?:in|after)\s+((?:\d+(?:\.\d+)?(?:ms|h|m|s))+|\d+(?:\.\d+)?)"
                        r"\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)?", re.I | re.A)
NUMBER = re.compile(r"\d+(?:\.\d+)?", re.A)
DURATION = re.compile(r"(?:\d+(?:\.\d+)?(?:ms|h|m|s))+", re.I | re.A)
DUR_PART = re.compile(r"(\d+(?:\.\d+)?)(ms|h|m|s)", re.I | re.A)
UNIT = {"ms": 0.001, "h": 3600, "m": 60, "s": 1}
# Retry-After 可以是 HTTP 日期。先比對格式再解析:JS 的 Date.parse 連「test 1」都當成日期,兩邊才會一致
HTTP_DATE = re.compile(r"(?:[A-Za-z]{3},\s*)?\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2}(?::\d{2})?\s*(?:GMT|UTC|[+-]\d{4})", re.A)
# classify 只看 body 一個地方:這兩個回應標頭先併進 body(測試的假回應也照這樣做)
HEADER_KEYS = (("retry-after", "_retry_after"), ("x-ratelimit-reset", "_ratelimit_reset"))


def parse_delay(value, now=None):
    """「要等多久」換成秒數;看不懂回 None(不猜)。"5m" = 300 秒(⛔ 不是 5 秒)、"520ms"、"1m30s"、"1h2m3s"、HTTP 日期。"""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if value >= 0 and math.isfinite(value) else None
    s = str(value).strip()
    if NUMBER.fullmatch(s):
        return float(s)
    if DURATION.fullmatch(s):
        total = 0.0
        for num, unit in DUR_PART.findall(s):
            total += float(num) * UNIT[unit.lower()]
        return total
    if HTTP_DATE.fullmatch(s):
        try:
            when = email.utils.parsedate_to_datetime(s)
        except (TypeError, ValueError, IndexError):
            return None
        if when.tzinfo is None:
            when = when.replace(tzinfo=datetime.timezone.utc)
        return max(0.0, when.timestamp() - (time.time() if now is None else now))
    return None


def text_delay(text):
    """從錯誤訊息找等待時間(try again in 7m26.4s / Please retry in 17.3s / retry after 30 seconds)。"""
    m = TEXT_DELAY.search(text or "")
    if not m:
        return None
    num, unit = m.group(1), (m.group(2) or "").lower()
    if not NUMBER.fullmatch(num):
        return parse_delay(num)
    mult = 60 if unit.startswith("min") else 3600 if unit.startswith(("hour", "hr")) else 1
    return float(num) * mult


def _reset_delay(value, now):
    """x-ratelimit-reset 是「恢復的時間點」(OpenRouter 用毫秒時間戳);看起來不像時間戳的不猜。"""
    try:
        x = float(value)
    except (TypeError, ValueError):
        return None
    if x > 1e12:
        x /= 1000.0
    return max(0.0, x - now) if x > 1e9 else None


def _flat(body, limit=4000):
    """錯誤回應裡所有字串值串成一行(用 | 隔開,避免把兩個欄位接成一句話誤判)。"""
    out = []

    def walk(v, depth):
        if depth > 20:
            return
        if isinstance(v, str):
            out.append(v)
        elif isinstance(v, dict):
            for x in v.values():
                walk(x, depth + 1)
        elif isinstance(v, list):
            for x in v:
                walk(x, depth + 1)
    walk(body, 0)
    return " | ".join(out)[:limit]


def _gemini_details(body):
    """Gemini 的 error.details:QuotaFailure 的 quotaId(PerMinute / PerDay)、quotaValue 是不是 0,以及 RetryInfo 的 retryDelay。"""
    err = body.get("error") if isinstance(body, dict) else None
    details = err.get("details") if isinstance(err, dict) else None
    ids, retry, zero = [], None, False
    for d in details if isinstance(details, list) else []:
        if not isinstance(d, dict):
            continue
        kind = str(d.get("@type", ""))
        if kind.endswith("QuotaFailure"):
            violations = d.get("violations")
            for v in violations if isinstance(violations, list) else []:
                if isinstance(v, dict) and v.get("quotaId"):
                    ids.append(str(v["quotaId"]))
                    zero = zero or str(v.get("quotaValue")) == "0"
        elif kind.endswith("RetryInfo") and retry is None:
            retry = d.get("retryDelay")
    return ids, retry, zero


def _meta_reset(body):
    """OpenRouter 把限流標頭放在 error.metadata.headers 裡(例如 X-RateLimit-Reset)。"""
    err = body.get("error") if isinstance(body, dict) else None
    meta = err.get("metadata") if isinstance(err, dict) else None
    hdrs = meta.get("headers") if isinstance(meta, dict) else None
    if isinstance(hdrs, dict):
        for k, v in hdrs.items():
            if str(k).lower() == "x-ratelimit-reset":
                return v
    return None


def _first(*values):
    for v in values:
        if v is not None:
            return v
    return None


def with_headers(body, headers):
    """把判斷限流要用的回應標頭放進 body(_retry_after、_ratelimit_reset);名稱不分大小寫,body 已有的不覆蓋。"""
    if not isinstance(body, dict) or not headers:
        return body
    if isinstance(headers, dict):
        low = {str(k).lower(): v for k, v in headers.items()}
        get = low.get
    else:
        get = headers.get        # requests 的標頭本來就不分大小寫
    for name, field in HEADER_KEYS:
        v = get(name)
        if v not in (None, "") and field not in body:
            body[field] = str(v)
    return body


def classify(status, body, now=None):
    """把失敗的回應分類,回 {"kind": ..., "delay": 秒數或 None}。
    kind:billing(餘額 / 帳單)/ missing(模型不存在)/ config(404 但不是模型問題,多半網址錯)/ auth(金鑰被拒)/
          quota(每日 / 每月額度用完)/ rate(每分鐘限流)/ server(5xx、網路斷線)/ other。
    delay 依序看:Retry-After 標頭 → Gemini retryDelay → 訊息裡的 try again in … → x-ratelimit-reset 時間戳。"""
    now = time.time() if now is None else now
    b = body if isinstance(body, dict) else {}
    text = _flat(body)
    if status == 402 or (status in (400, 401, 403, 429) and BILLING.search(text)):
        return {"kind": "billing", "delay": None}
    if status in (400, 404) and MODEL_MISSING.search(text):
        return {"kind": "missing", "delay": None}
    if status == 404:
        return {"kind": "config", "delay": None}
    if status in (401, 403):
        return {"kind": "auth", "delay": None}
    if status != 429 and status != 0 and status < 500:
        return {"kind": "other", "delay": None}
    ids, retry, zero = _gemini_details(b)
    if status == 429 and zero:
        # quotaValue 是 0(訊息寫 limit: 0):這個方案根本沒有這個模型的額度,就算 quotaId 是 PerMinute,
        # 等多久都不會好;附的 retryDelay 沒有意義,當成沒說(先避開 1 小時)
        return {"kind": "quota", "delay": None}
    delay = _first(parse_delay(b.get("_retry_after"), now), parse_delay(retry, now), text_delay(text),
                   _reset_delay(b.get("_ratelimit_reset"), now), _reset_delay(_meta_reset(b), now))
    if status == 429:
        # Gemini 有結構化的 quotaId 就只看它:每分鐘限流的訊息也寫「exceeded your current quota」,看那句話會誤判
        long_window = any(LONG_WINDOW.search(i) for i in ids) if ids else bool(LONG_WINDOW.search(text))
        return {"kind": "quota" if long_window else "rate", "delay": delay}
    return {"kind": "server", "delay": delay}


def classify_response(res, now=None):
    """requests 的回應(或測試的假回應)→ classify 的結果。⭐ 一定要讀回應內容:只看狀態碼分不出是哪一種 429 / 404。
    先用 .json();不是 JSON(HTML / 純文字錯誤頁)或是空的才讀 .text,放進 _raw(跟 skl 的 _http 一樣看得到)。"""
    status = int(getattr(res, "status_code", 0) or 0)
    body = None
    if callable(getattr(res, "json", None)):
        try:
            j = res.json()
            if j not in (None, {}, [], ""):
                body = j
        except Exception:     # noqa: BLE001 —— 空內容 / 不是 JSON:改讀文字
            pass
    if body is None:
        raw = getattr(res, "text", None)
        if isinstance(raw, str) and raw:
            try:
                body = json.loads(raw)
            except ValueError:
                body = {"_raw": raw[:500]}
    if body is None:
        body = {}
    if not isinstance(body, dict):
        body = {"_raw": json.dumps(body, ensure_ascii=False, default=str)[:500]}
    return classify(status, with_headers(dict(body), getattr(res, "headers", None)), now)


def cool_seconds(kind, delay):
    """這一類失敗要避開多久(秒):quota 照對方說的但至少 5 分鐘、沒說 1 小時;rate 照對方說的、沒說 1 分鐘;最多一天。"""
    d = None if delay is None else max(0.0, float(delay))
    if kind == "quota":
        s = QUOTA_COOLDOWN if d is None else max(d, QUOTA_MIN_COOLDOWN)
    elif kind == "rate":
        s = RATE_COOLDOWN if d is None else d
    else:
        s = QUOTA_COOLDOWN
    return min(MAX_COOLDOWN, max(1.0, s))


# 冷卻紀錄:模型 → 到期時間。⭐ 記在模型上(qwen 今天用完,gpt-oss 照用);採礦程式一次跑完就結束、
# 金鑰組固定 → 不必分金鑰(= skl model_router 的指紋是「整組金鑰」)。⛔ 不存金鑰。
_COOL = {}


def cool_model(model, kind="quota", delay=None, now=None):
    """記下「這個模型先別用」;回避開幾秒。已經有更久的冷卻就不縮短。"""
    if not model:
        return 0.0
    now = time.time() if now is None else now
    secs = cool_seconds(kind, delay)
    _COOL[model] = max(_COOL.get(model, 0.0), now + secs)
    left = _COOL[model] - now
    word = "今天額度用完" if kind == "quota" else "限流"
    print(f"  ⏳ [Groq] {model} {word},約 {max(1, round(left / 60))} 分鐘後恢復;這段時間改用其他模型")
    return left


def cooling_left(model, now=None):
    """這個模型還要冷卻幾秒(0 = 可以用)。"""
    now = time.time() if now is None else now
    return max(0.0, _COOL.get(model, 0.0) - now)


def cooling_models(now=None):
    now = time.time() if now is None else now
    return {m for m, until in _COOL.items() if until > now}


def reset_cooldowns():
    """清掉所有冷卻(測試用)。"""
    _COOL.clear()


def selftest():
    """離線自我測試:兩個語言共用的案例 + 讀回應內容 + 冷卻。回 0 = 全過。"""
    fails = []

    def ok(name, cond, extra=""):
        print(f"{'✅' if cond else '❌'} {name}{'' if cond else '  ' + str(extra)[:220]}")
        if not cond:
            fails.append(name)

    def same(a, b):
        return (a is None and b is None) if (a is None or b is None) else abs(a - b) < 1e-6

    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scripts", "fixtures", "ai_router_cases.json")
    with open(path, encoding="utf-8") as f:
        C = json.load(f)
    t0 = C["now"]

    def sample(item):
        return json.loads(json.dumps(C["samples"][item] if isinstance(item, str) else item))   # 複本:with_headers 會改 body

    # ① 共用案例(skl 的 router_cases.json 原檔;JS 那邊 scripts/test_ai429.mjs 跑同一份)
    for c in C["delays"]:
        got = parse_delay(c["value"], c.get("now"))
        ok(f"①a 等待時間:{c['name']}", same(got, c["seconds"]), f"期望 {c['seconds']} 得到 {got}")
    for c in C["text_delays"]:
        got = text_delay(c["text"])
        ok(f"①b 訊息裡的等待時間:{c['text']}", same(got, c["seconds"]), f"期望 {c['seconds']} 得到 {got}")
    for c in C["classify"]:
        s = sample(c["sample"])
        info = classify(s["status"], with_headers(s.get("body") or {}, s.get("headers")), c.get("now", t0))
        ok(f"①c 分類:{c['name']}", info["kind"] == c["kind"] and same(info["delay"], c["delay"]),
           f"期望 {c['kind']} {c['delay']},得到 {info}")
    ok("①d 空過守門:三組案例都真的有跑(≥18 / ≥6 / ≥30)",
       len(C["delays"]) >= 18 and len(C["text_delays"]) >= 6 and len(C["classify"]) >= 30,
       [len(C["delays"]), len(C["text_delays"]), len(C["classify"])])

    # ② classify_response:真的讀回應內容(以前只看 status_code)
    class _Res:
        def __init__(self, status, text=None, js=None, headers=None):
            self.status_code, self.headers = status, headers or {}
            if text is not None:
                self.text = text
            self._js = js

        def json(self):
            if self._js is None:
                raise ValueError("no json")
            return self._js
    tpd = json.dumps(C["samples"]["groq_tpd"]["body"])
    ok("② requests 回應(文字是 JSON)→ 讀得到 TPD → quota 446.4 秒",
       classify_response(_Res(429, tpd), t0) == {"kind": "quota", "delay": 446.4})
    ok("② 標頭不分大小寫(Retry-After: 4)→ rate 4 秒",
       classify_response(_Res(429, json.dumps(C["samples"]["groq_tpm"]["body"]), headers={"Retry-After": "4"}), t0)
       == {"kind": "rate", "delay": 4.0})
    ok("② HTML 錯誤頁(404)→ config(⛔ 不可當成模型下架)",
       classify_response(_Res(404, "<html><h1>404 Not Found</h1></html>"))["kind"] == "config")
    ok("② 純文字 model_not_found(404)→ missing", classify_response(_Res(404, "model_not_found"))["kind"] == "missing")
    ok("② 假回應只有 .json() → 也讀得到(402 餘額不足 → billing)",
       classify_response(_Res(402, js=C["samples"]["openrouter_402"]["body"]))["kind"] == "billing")
    ok("② 空的 404 → config(⛔ 不把模型標成下架)", classify_response(_Res(404, "", js=None))["kind"] == "config")

    # ③ 冷卻:多久、groq_model 自動避開、全部冷卻照樣回字串
    ok("③ quota:對方說 35 秒 → 至少 5 分鐘;沒說 → 1 小時;怪異的 → 最多一天",
       cool_seconds("quota", 35) == 300 and cool_seconds("quota", None) == 3600 and cool_seconds("quota", 9e9) == 86400)
    ok("③ rate:照對方說的、沒說 1 分鐘", cool_seconds("rate", 4) == 4 and cool_seconds("rate", None) == 60)
    saved = (dict(_cache), dict(_good), dict(_COOL), requests.get)
    ids = ["qwen/qwen3.8-27b", "openai/gpt-oss-20b", "openai/gpt-oss-120b"]

    class _List:
        status_code = 200

        def json(self):
            return {"data": [{"id": m} for m in ids]}
    try:
        requests.get = lambda *a, **k: _List()
        _cache.update(ids=None, at=0.0, err="")
        _good.clear()
        _COOL.clear()
        first = groq_model(["k"], "light")
        cool_model(first, "quota", 446.4, now=time.time())
        second = groq_model(["k"], "light")
        ok("③ ⭐ qwen 今天額度用完 → 下一次挑同一家的 gpt-oss-20b(⛔ 整家不用)",
           first == "qwen/qwen3.8-27b" and second == "openai/gpt-oss-20b" and cooling_left(first) >= 300, [first, second])
        for m in ids:
            cool_model(m, "quota", None)
        third = groq_model(["k"], "light")
        ok("③ 全部冷卻 → 照樣回一個名字(⛔ None),cooling_left > 0 讓呼叫端知道這次別打",
           isinstance(third, str) and cooling_left(third) > 0, third)
    finally:
        _cache.clear()
        _cache.update(saved[0])
        _good.clear()
        _good.update(saved[1])
        _COOL.clear()
        _COOL.update(saved[2])
        requests.get = saved[3]

    # ④ 決定性對照:把「每日 / 每月」的判斷拿掉(= 所有 429 都當限流)→ TPD 必須變成 rate,上面 ①c 那條才有鑑別力
    global LONG_WINDOW
    keep = LONG_WINDOW
    try:
        LONG_WINDOW = re.compile(r"(?!)")
        s = sample("groq_tpd")
        ok("④ 決定性對照:拿掉每日額度的判斷 → TPD 被當成限流(⛔ 還是 quota 就代表案例沒在測)",
           classify(s["status"], s["body"], t0)["kind"] == "rate")
    finally:
        LONG_WINDOW = keep

    print(f"\n{'✅ GROQ_COMMON_SELFTEST_PASS(全部通過)' if not fails else f'❌ GROQ_COMMON_SELFTEST_FAIL {len(fails)} 條'}")
    return 0 if not fails else 1


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(selftest())
    print("用法:python3 groq_common.py --selftest(離線自我測試;這支平常是給採礦程式 import 的)")
