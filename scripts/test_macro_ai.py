#!/usr/bin/env python3
"""財經行事曆 AI 引擎切換 單元測試(不打網路,全用假回應)。

背景:使用者說「我有比較強的 AI,可不可以覆蓋原本的」。
      查證後:財經行事曆的解讀本來用 Groq llama-3.3-70b,但依專案 AI 分工鐵則
      「深度判讀走 Gemini、輕量翻譯走 Groq」,這一段屬深度判讀,本來就該用 Gemini。
      V71.3.9 改成 Gemini 2.5 Flash 主力 + Groq 備援。

V71.4.0 再修正:使用者實際用法是「夜間排程用便宜的 Groq、白天手動才叫 Gemini」,
      所以採礦端順序改回 Groq 優先,Gemini 只當備援(深度分析改由前端按鈕觸發)。

驗:
  ① Groq 成功 → 用 Groq,不打 Gemini(夜間不燒 Gemini 額度)
  ② Groq 失敗 → 自動退 Gemini(不能開天窗)
  ③ 兩個都失敗 → 回 None(上層保留上次解讀)
  ④ 沒設 Gemini key 且 Groq 掛掉 → 回 None,不亂寫
  ⑤ Gemini 規格正確:safetySettings 四類全 BLOCK_NONE + thinkingBudget=0 + systemInstruction
  ⑥ 回傳被 markdown 圍欄包住也要解析得出來
"""
import json
import os
import sys

sys.path.insert(0, '/home/user/StockAI-DB')
os.environ.setdefault('SKIP_GLOBAL', '1')

# ⚠️ macro_miner 在 module 層 import yfinance,而測試機沒裝(採礦機才有)。
#    這裡塞最小的假模組,讓 import 過得去 —— 本測試完全不碰行情抓取,只驗 AI 引擎切換。
import types
for _m in ('yfinance',):
    if _m not in sys.modules:
        _stub = types.ModuleType(_m)
        _stub.Ticker = lambda *a, **k: None
        sys.modules[_m] = _stub
import macro_miner as mm

GOOD = json.dumps({
    "summary": "這兩週最該注意日銀利率決議與美國 CPI。",
    "focus": [{"date": "2026-07-31", "event": "日銀 BOJ", "impact": "套息交易風向球",
               "action": "留倉降到 5 成", "level": "⚠️"}],
}, ensure_ascii=False)

OUT = {
    "upcoming_macro_events": [
        {"date": "2026-07-31", "event": "日銀 BOJ 利率決議", "level": "高", "days": 2},
        {"date": "2026-08-10", "event": "美國 CPI", "level": "高", "days": 12},
    ],
    "vix": 18.18, "kospi_chg_pct": -16.17, "nikkei_chg_pct": -5.39,
    "fi_spot_net": -222.52, "fi_futures_net": -82255,
}

calls = {"gemini": 0, "groq": 0}
captured = {}


class R:
    def __init__(self, code, body):
        self.status_code = code
        self._b = body
        self.text = json.dumps(body, ensure_ascii=False)

    def json(self):
        return self._b


def gem_ok(text=GOOD):
    return R(200, {"candidates": [{"content": {"parts": [{"text": text}]}}]})


def fake_post(url, json=None, headers=None, timeout=None):
    if 'generativelanguage' in url:
        calls['gemini'] += 1
        captured['payload'] = json
        return fake_post.gem
    calls['groq'] += 1
    return fake_post.groq


# ⚠️ macro_miner 的 session 叫 http(不是 http_session)——
#    V71.3.9 之前程式錯寫成 http_session,每次呼叫 NameError 被 except 吞掉,
#    導致財經行事曆 AI 從上線到現在一次都沒成功過。這裡順便把名字釘死當回歸測試。
assert hasattr(mm, 'http') and not hasattr(mm, 'http_session'), \
    'macro_miner 的 session 名字改了?AI 呼叫層要跟著改'
mm.http.post = fake_post


def run(gem, groq, gkeys=('g1',), qkeys=('q1',)):
    calls['gemini'] = calls['groq'] = 0
    fake_post.gem, fake_post.groq = gem, groq
    mm.GEMINI_KEYS_MM[:] = list(gkeys)
    mm.GROQ_KEYS_MM[:] = list(qkeys)
    return mm.build_macro_events_ai(OUT)


GROQ_OK = R(200, {"choices": [{"message": {"content": GOOD}}]})
FAIL = R(500, {"error": "boom"})

# ① Groq 成功(夜間常態)→ 不可動用 Gemini 額度
r = run(gem_ok(), GROQ_OK)
assert r and 'llama' in r['model'], f"① model 應標 groq,實際 {r and r.get('model')}"
assert calls['gemini'] == 0, "① Groq 成功時不該打 Gemini(夜間排程不燒 Gemini 額度)"
print(f"✅ ① 夜間 Groq 成功({r['model']})→ 完全不碰 Gemini 額度")

# ② Groq 失敗 → 退 Gemini
r = run(gem_ok(), FAIL)
assert r and r['model'].startswith('gemini'), f"② 應退回 Gemini,實際 {r and r.get('model')}"
assert calls['groq'] >= 1 and calls['gemini'] >= 1
print(f"✅ ② Groq 掛掉 → 自動退回 Gemini({r['model']}),行事曆不開天窗")

# ③ 兩個都失敗
r = run(FAIL, FAIL)
assert r is None, "③ 兩個都失敗應回 None(上層保留上次解讀)"
print("✅ ③ 兩條都掛 → 回 None,上層保留上次解讀不亂寫")

# ④ 沒設 Gemini key 且 Groq 掛掉 → 回 None,不浪費呼叫也不亂寫
r = run(gem_ok(), FAIL, gkeys=())
assert calls['gemini'] == 0, "④ 沒 key 不該發出 Gemini 請求"
assert r is None, "④ 兩條都不可用應回 None"
print("✅ ④ 沒設 Gemini 金鑰 + Groq 掛掉 → 回 None,不浪費呼叫也不亂寫")

# ⑤ Gemini 規格(走備援路徑時仍須符合專案 Gemini 慣例)
run(gem_ok(), FAIL)
p = captured['payload']
cats = {s['category'] for s in p['safetySettings']}
assert len(cats) == 4 and all(s['threshold'] == 'BLOCK_NONE' for s in p['safetySettings']), "⑤ safetySettings 不符"
assert p['generationConfig']['thinkingConfig']['thinkingBudget'] == 0, "⑤ thinkingBudget 應為 0"
assert p.get('systemInstruction', {}).get('parts'), "⑤ 缺 systemInstruction"
assert '不要自己計算或杜撰任何數字' in p['systemInstruction']['parts'][0]['text'], "⑤ 禁 AI 算數的鐵則沒帶進去"
assert '-16.17' in p['contents'][0]['parts'][0]['text'], "⑤ 市場狀態數字(韓股)沒餵進去"
print("✅ ⑤ Gemini 規格正確:4 類 BLOCK_NONE + thinkingBudget=0 + systemInstruction + 禁算數鐵則")

# ⑥ markdown 圍欄
r = run(gem_ok("```json\n" + GOOD + "\n```"), GROQ_OK)
assert r and r['summary'], "⑥ 被 ``` 包住也要解析得出來"
print("✅ ⑥ 回傳被 markdown 圍欄包住 → 照樣解析成功")

print("\n🎉 財經行事曆 AI 引擎 六項測試全過")
