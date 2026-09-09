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
"""
import os
import re
import time

import requests

GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models'
GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions'

# ⭐ 偏好序用**正規表示式**,⛔ 不比對固定字串 —— 版號會一直變(3.1 → 3.3 → …)。
#   兩個層級:heavy = 質化判讀;light = 大量、便宜的工作(翻譯標題)。
_PREFS = {
    'heavy': [r'llama-3\.3-70b', r'llama-\d+(\.\d+)?-70b', r'llama.*70b',
              r'llama.*(instruct|versatile)', r'^llama'],
    'light': [r'llama-3\.\d+-8b', r'llama.*8b', r'.*instant',
              r'llama-3\.3-70b', r'^llama'],
}

# 🛟 保險②:解析不到時的硬清單(⛔ 只當最後手段,不是主要來源)
_LEGACY = {'heavy': 'llama-3.3-70b-versatile', 'light': 'llama-3.1-8b-instant'}

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
            ids = [m for m in raw if not _NON_CHAT.search(m)]
            if len(raw) != len(ids):
                print(f'  🧹 [Groq] 濾掉 {len(raw) - len(ids)} 個非聊天模型(語音/嵌入/防護類)')
            if ids:
                err = ''
                break
        except Exception as e:
            err = f'key#{i + 1} {type(e).__name__}'
    _cache.update(ids=ids, at=time.time(), err=err)
    return ids, err


def groq_model(keys, tier='light', avoid=None):
    """挑一個現在真的存在的模型名。⛔ 永遠回一個字串,不會回 None。"""
    avoid = set(avoid or ())
    ids, err = _list_models(keys)
    for pat in _PREFS.get(tier, _PREFS['light']):
        for mid in ids:
            if mid not in avoid and re.search(pat, mid, re.I):
                _good[tier] = mid
                return mid
    # ① 退回上次成功過的 → 再退回硬清單
    if _good.get(tier) and _good[tier] not in avoid:
        return _good[tier]
    if ids:
        # ③ 一個都配不到 → 把實際清單印出來,別讓下一個人重新猜
        print(f'  ⚠️ [Groq] 偏好序配不到 {tier};它實際有的是:{", ".join(ids[:25])}')
    elif err:
        print(f'  ⚠️ [Groq] 取不到模型清單({err}),退回硬清單')
    # ⚠️ 硬清單也要尊重 avoid —— ⛔ 回一個「已知 404」的模型會把重試次數白白燒光,
    #    而且外層會誤以為「已經換過了」(V73.9.1 用注入缺陷才發現這個洞)。
    leg = _LEGACY.get(tier, _LEGACY['light'])
    if leg in avoid:
        for mid in ids:
            if mid not in avoid:
                return mid
        for t2, v2 in _LEGACY.items():
            if v2 not in avoid and not _NON_CHAT.search(v2):
                return v2
    return leg


def groq_reason(status: int) -> str:
    """把光禿禿的狀態碼翻成白話(V26.18 錯誤訊息白話化鐵則)。⛔ 各碼不可同一句。"""
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
    """② 自我修復:chat 回 404 時呼叫 —— 清快取,下次重新問官方。"""
    _cache.update(ids=None, at=0.0)
    if tier and _good.get(tier) == model:
        _good.pop(tier, None)
