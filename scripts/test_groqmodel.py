#!/usr/bin/env python3
"""
🤖 Groq 模型自我解析 + 自我修復(V73.9.1)測試

🚨 起因(2026-08-25,從使用者截圖查出來的):
   `radar_news.json` 每一則的 `ai_reason` 都是「**API 錯誤 404**」。
   404 = **這個模型名字不存在**(⛔ 不是金鑰壞、不是額度用完)——
   `universal_radar.py` 寫死 `llama-3.1-8b-instant`,Groq 已經下架它。

⭐⭐ 一個 404 打掉三件事(它們全在**同一個** Groq 呼叫裡):
   ① `title_zh` → 國際新聞標題**完全沒有翻譯**(而前端寫著「已由採礦機翻成中文」)
   ② `sentiment` → 全部退回「中立」
   ③ `important` → 失敗時預設 `True` → **垃圾新聞全部放行**
      (實測混進「美國某地回收廠火災」「MacKenzie Scott 捐款」這種跟台股無關的)

⛔ 這支要釘死的九件事:
  ① 解析得出來:heavy 挑到 70b、light 挑到 8b。
  ② ⛔ **永遠不可回 None**(呼叫端會直接把 None 丟進 payload → 400)。
  ③ 完全取不到清單也不可 throw,要退回硬清單。
  ④ `avoid`(已知 404 的)不可再被挑到 —— 否則自我修復會無限重試同一個。
  ⑤ 🔐 ⛔ **絕不印 token**(repo 是 public)。
  ⑥ 錯誤訊息白話化,各碼不可同一句;404 要講「下架」。
  ⑦ ⛔ 兩支採礦都不可再有寫死的 llama slug(陷阱 #37)。
  ⑧ 實跑自我修復:收到 404 要**換模型**再打一次(⛔ 不是換 key —— 換 key 沒用)。
  ⑨ 快取不可永久(模型下架是常態)。
"""
import io
import os
import re
import sys
import contextlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
fails = []


def ok(name, cond, extra=''):
    print(f"{'✅' if cond else '❌'} {name}{'' if cond else '  ' + str(extra)[:220]}")
    if not cond:
        fails.append(name)


import groq_common as G  # noqa: E402

FAKE_IDS = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant',
            'whisper-large-v3', 'gemma2-9b-it']
SECRET = 'gsk_THIS_MUST_NEVER_BE_PRINTED_123456'


class FakeResp:
    def __init__(self, code, payload=None, text=''):
        self.status_code, self._p, self.text = code, payload or {}, text

    def json(self):
        return self._p


def stub_models(code=200, ids=None):
    def _get(url, timeout=None, headers=None):
        return FakeResp(code, {'data': [{'id': i} for i in (ids if ids is not None else FAKE_IDS)]})
    G.requests.get = _get


def reset():
    G._cache.update(ids=None, at=0.0, err='')
    G._good.clear()


# ── ① 解析 ────────────────────────────────────────────────────────
reset(); stub_models()
h = G.groq_model([SECRET], 'heavy')
l = G.groq_model([SECRET], 'light')
ok('① heavy 挑到 70b', h == 'llama-3.3-70b-versatile', h)
ok('①b light 挑到 8b', l == 'llama-3.1-8b-instant', l)
ok('①c ⛔ 不可挑到不能聊天的模型(whisper/gemma 不在偏好序)',
   'whisper' not in h and 'whisper' not in l, f'{h} {l}')

# ── ② ③ 永不回 None ───────────────────────────────────────────────
reset(); stub_models(ids=['some-unknown-model-x'])
r = G.groq_model([SECRET], 'heavy')
ok('② 清單裡沒有偏好的 → 仍要回一個字串(⛔ 不可 None)', isinstance(r, str) and r, repr(r))
reset(); stub_models(code=401)
r2 = G.groq_model([SECRET], 'light')
ok('③ 完全取不到清單 → 退回硬清單,⛔ 不可 throw/None', isinstance(r2, str) and 'llama' in r2, repr(r2))
reset()
G.requests.get = lambda *a, **k: (_ for _ in ()).throw(RuntimeError('boom'))
r3 = G.groq_model([SECRET], 'light')
ok('③b 連線整個爆掉也要回字串', isinstance(r3, str) and r3, repr(r3))

# ── ④ avoid ──────────────────────────────────────────────────────
reset(); stub_models()
a1 = G.groq_model([SECRET], 'light')
a2 = G.groq_model([SECRET], 'light', avoid={a1})
ok('④ 🚨 avoid 的模型不可再被挑到(⛔ 否則自我修復會無限重試同一個)',
   a2 != a1 and isinstance(a2, str), f'{a1} → {a2}')

# ── ⑤ 🔐 絕不印 token ─────────────────────────────────────────────
reset(); stub_models(code=403)
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    G.groq_model([SECRET, SECRET + 'B'], 'heavy')
    G.groq_model([SECRET], 'light')
reset(); stub_models(ids=['nothing-matches'])
with contextlib.redirect_stdout(buf):
    G.groq_model([SECRET], 'heavy')
out = buf.getvalue()
ok('⑤ 🔐 ⛔ log 絕不可出現 token', SECRET not in out and 'gsk_' not in out, out[:200])
ok('⑤b 但要說得出「第幾把」才 debug 得動', re.search(r'key#\d', out) is not None, out[:200])
ok('⑤c 一個都配不到時,要把它**實際有的清單**印出來(⛔ 不然下一個人只能重猜)',
   'nothing-matches' in out, out[:250])

# ── ⑥ 錯誤白話化 ─────────────────────────────────────────────────
msgs = {c: G.groq_reason(c) for c in (400, 401, 403, 404, 429, 500)}
ok('⑥ 各狀態碼 ⛔ 不可同一句', len(set(msgs.values())) == len(msgs), msgs)
ok('⑥b 404 要講「下架」(這正是害我們查很久的那一個)', '下架' in msgs[404], msgs[404])
ok('⑥c 401 要指路到設定', '金鑰' in msgs[401], msgs[401])
ok('⑥d ⛔ 不可只丟一個光禿禿的數字', all(not m.strip().isdigit() and len(m) > 4 for m in msgs.values()), msgs)

# ── ⑦ 接線:⛔ 不可再有寫死的 slug ────────────────────────────────
for fn in ('universal_radar.py', 'macro_miner.py'):
    src = open(os.path.join(ROOT, fn), encoding='utf-8').read()
    code = '\n'.join(ln for ln in src.splitlines() if not ln.lstrip().startswith('#'))
    ok(f'⑦ {fn} ⛔ 程式碼裡不可再寫死 llama-x.y 模型名',
       re.search(r'["\']llama-\d', code) is None,
       [ln for ln in code.splitlines() if re.search(r'["\']llama-\d', ln)][:2])
    ok(f'⑦b {fn} 有接上共用解析器', 'groq_common' in src)
    ok(f'⑦c {fn} 有 404 自我修復(換模型,⛔ 不是換 key)',
       '404' in code and 'invalidate' in code)

# ── ⑧ 實跑自我修復:404 → 換模型再打一次 ─────────────────────────
reset(); stub_models()
os.environ['GROQ_API_KEYS'] = SECRET
sys.modules.pop('universal_radar', None)
import universal_radar as U  # noqa: E402
U.GROQ_API_KEYS = [SECRET]
U.SKIP_AI = False
seen = []


class _Sess:
    def post(self, url, json=None, headers=None, timeout=None):
        m = (json or {}).get('model')
        seen.append(m)
        if m == 'llama-3.1-8b-instant':          # 假裝這個被下架了
            return FakeResp(404, {}, 'model_not_found')
        return FakeResp(200, {'choices': [{'message': {'content': '{"sentiment":"利多","reason":"x","title_zh":"翻好了","important":true}'}}]})


U.http_session = _Sess()
buf2 = io.StringIO()
with contextlib.redirect_stdout(buf2):
    res = U.analyze_sentiment('Nvidia beats earnings', 'blah')
ok('⑧ 🚨 空過守門:真的有打出去(⛔ 沒打到的話下面全是假綠燈)', len(seen) >= 1, seen)
ok('⑧b 404 之後有**換模型**再打一次(⛔ 不是換 key)', len(set(seen)) >= 2, seen)
ok('⑧c 換完之後成功拿到翻譯', res[2] == '翻好了', res)
ok('⑧d 而且 sentiment/important 也一起回來了(三件事同一個呼叫)',
   res[0] == '利多' and res[3] is True, res)
ok('⑧e 🔐 自我修復的 log ⛔ 仍不可出現 token', SECRET not in buf2.getvalue(), buf2.getvalue()[:160])

# 反向:模型都不存在時,錯誤訊息要是白話的
seen.clear()


class _Sess404:
    def post(self, *a, **k):
        seen.append((k.get('json') or {}).get('model'))
        return FakeResp(404, {}, 'model_not_found')


U.http_session = _Sess404()
with contextlib.redirect_stdout(io.StringIO()):
    res2 = U.analyze_sentiment('t', 's')
# ⚠️ 這條第一版太鬆:只寫「不含 404」→ 走到「AI 暫時無法分析」那條路也會通過,
#    於是把錯誤訊息改回光禿禿的狀態碼**照樣綠**(注入缺陷才發現)。
#    ⭐ 正解:釘**指定的那句白話**,⛔ 不是「沒有出現某個字」。
ok('⑧f 🚨 全部模型都 404 → 要回「模型已被下架」那句白話(⛔ 不可是「API 錯誤 404」,'
   '也⛔不可退成籠統的「暫時無法分析」把真因吃掉)',
   res2[1].startswith(G.groq_reason(404)), res2[1])   # ⚠️ V73.9.2 起後面會附上對方回的原文
ok('⑧g 而且要收斂,⛔ 不可無限重試', len(seen) <= 8, len(seen))

# ── ⑨ 快取不可永久 ───────────────────────────────────────────────
ok('⑨ 快取 TTL ≤12 小時(模型下架是常態,⛔ 不可永久快取)', 0 < G._TTL <= 12 * 3600, G._TTL)

# ── ⑩ V73.9.2:400(嚴格 JSON 模式)要退一步重試,而且原因要看得見 ────────
# 🚨 實測:404 修好之後**換成 400** —— 15 則有 14 則卡住,判讀又等於沒有。
#    400 通常是 `response_format:json_object` 出問題(輸出不合 schema / 被截斷),
#    ⛔ 光把模型換掉解決不了。
seen2 = []


class _Sess400:
    """第一次(帶 response_format)回 400;拿掉之後回 200 + ```json 圍欄。"""
    def post(self, url, json=None, headers=None, timeout=None):
        p = json or {}
        seen2.append('strict' if p.get('response_format') else 'loose')
        if p.get('response_format'):
            return FakeResp(400, {}, '{"error":{"code":"json_validate_failed"}}')
        return FakeResp(200, {'choices': [{'message': {'content':
            '```json\n{"sentiment":"利空","reason":"r","title_zh":"寬鬆也翻好了","important":false}\n```'}}]})


U.http_session = _Sess400()
with contextlib.redirect_stdout(io.StringIO()):
    res3 = U.analyze_sentiment('t', 's')
# 🚨 V73.9.4 這兩條**刻意改寫**(⛔ 不是放寬):V73.9.3 的設計是「先打嚴格模式,
#    400 再退一步」—— 實測那讓每則的呼叫次數**變兩倍**,金鑰提早撞 429、冷卻 1 小時,
#    15 則有 13 則變成「全冷卻拿不到」,**比不修還糟**。
#    ⭐ 現在呼叫端一律不帶 response_format → 正常情況**只打一次**。
ok('⑩ 🚨 正常情況 ⛔ 只可以打一次(V73.9.3 打兩次 → 額度燒光 → 比不修還糟)',
   len(seen2) == 1 and seen2[0] == 'loose', seen2)
ok('⑩b 安全網仍在:呼叫端若真的帶了 response_format,400 之後要能退一步',
   'p2.pop("response_format"' in open(os.path.join(ROOT, 'universal_radar.py'), encoding='utf-8').read())
ok('⑩c 寬鬆模式回來的 ```json 圍欄要解析得掉(專案 JSON 防呆鐵則)',
   res3[2] == '寬鬆也翻好了' and res3[0] == '利空', res3)

# 兩邊都 400 → 訊息要帶**對方回的原文**(⛔ job log 會過期,只印 log 下次還是查不到)
seen2.clear()


class _AllBad:
    def post(self, *a, **k):
        seen2.append((k.get('json') or {}).get('response_format') and 'strict' or 'loose')
        return FakeResp(400, {}, '{"error":{"code":"json_validate_failed","message":"bad"}}')


U.http_session = _AllBad()
with contextlib.redirect_stdout(io.StringIO()):
    res4 = U.analyze_sentiment('t', 's')
ok('⑩d 🔍 兩邊都失敗時,原因要帶對方回的原文寫進 JSON(⛔ 不可只有一句白話)',
   'json_validate_failed' in res4[1], res4[1])
ok('⑩e 但白話那句也要在(⛔ 不可只丟一串英文 JSON 給使用者看)',
   res4[1].startswith(G.groq_reason(400)), res4[1])

# max_tokens 要夠 —— 太小會讓 JSON 被截斷,那正是 400 的來源之一
_ur = open(os.path.join(ROOT, 'universal_radar.py'), encoding='utf-8').read()
_mt = re.search(r'"max_tokens":\s*(\d+)', _ur)
ok('⑩f max_tokens 要 ≥400(⛔ 太小 → JSON 被截斷 → Groq 回 400)',
   _mt and int(_mt.group(1)) >= 400, _mt.group(1) if _mt else 'not found')

# ── ⑪ V73.9.3:非聊天模型要在「取清單」時就濾掉 ────────────────────
# 🚨 實測踩到:解析器挑到 `whisper-large-v3`(語音辨識)與 `canopylabs/orpheus`(語音合成)
#    → Groq 回 400「The model … does not support」/「failed to template request」。
#    ⛔ 真因是我自己在「硬清單也要尊重 avoid」那段加的緊急退路**沒有限制模型種類**。
#    ⭐ 正解:在**取清單的當下**就濾掉,⛔ 不是在每一條挑選路徑各補一次判斷(那遲早會漏一條)。
DIRTY = ['whisper-large-v3', 'canopylabs/orpheus-tts', 'llama-guard-4-12b',
         'playai-tts', 'text-embedding-3', 'llama-3.3-70b-versatile']
reset(); stub_models(ids=DIRTY)
picked = [G.groq_model([SECRET], 'light'),
          G.groq_model([SECRET], 'heavy'),
          G.groq_model([SECRET], 'light', avoid={'llama-3.3-70b-versatile'})]
bad = [p for p in picked if re.search(r'whisper|tts|orpheus|guard|embed', p or '', re.I)]
ok('⑪ 🚨 ⛔ 任何路徑都不可挑到語音/嵌入/防護類模型(含 avoid 用光後的緊急退路)',
   not bad, picked)
ok('⑪b 濾完仍要挑得到能用的', picked[0] == 'llama-3.3-70b-versatile', picked)

# ⛔ 不可有第四份「呼叫 Groq → 解析 JSON」的複製品(陷阱 #37)
_ur2 = open(os.path.join(ROOT, 'universal_radar.py'), encoding='utf-8').read()
n_direct = len(re.findall(r'json\.loads\(res\.json\(\)\["choices"\]', _ur2))
ok('⑪c ⛔ 三個呼叫端都要走共用 `_groq_json`,不可再自己解析一份',
   n_direct == 0 and _ur2.count('_groq_json(payload') >= 3,
   f'直接解析 {n_direct} 處 / 共用 {_ur2.count("_groq_json(payload")} 處')
# 三處的 max_tokens 都要夠(⛔ 太小 → JSON 被截斷 → 400)
small = [int(m) for m in re.findall(r'"max_tokens":\s*(\d+)', _ur2) if int(m) < 250]
ok('⑪d ⛔ 不可有 max_tokens < 250 的呼叫(舊版 100/80 就是一則都翻不出來的原因)',
   not small, small)

# ── ⑫ V73.9.4:⛔ 呼叫端不可再帶嚴格 JSON 模式(那是 400 與額度加倍的源頭)──
_ur3 = open(os.path.join(ROOT, 'universal_radar.py'), encoding='utf-8').read()
_code3 = '\n'.join(ln for ln in _ur3.splitlines() if not ln.lstrip().startswith('#'))
ok('⑫ 🚨 ⛔ 三個呼叫端都不可帶 response_format('
   'V73.9.3 因此呼叫次數加倍 → 金鑰全冷卻 → 15 則有 13 則拿不到,比不修還糟)',
   'response_format": {"type"' not in _code3,
   [ln.strip() for ln in _code3.splitlines() if 'response_format": {' in ln][:2])
ok('⑫b 但共用函式要留它當安全網(萬一日後有人加回去)', 'p2.pop("response_format"' in _ur3)

# 全冷卻時的原因要具體,⛔ 不可只寫「AI 暫時無法分析」
sys.modules.pop('universal_radar', None)
import universal_radar as U2  # noqa: E402
U2.GROQ_API_KEYS = [SECRET, SECRET + 'B']
U2.SKIP_AI = False
U2._groq_key_cooldown.update({0: 9e18, 1: 9e18})     # 兩把都冷卻
with contextlib.redirect_stdout(io.StringIO()):
    r5 = U2.analyze_sentiment('t', 's')
ok('⑫c 🔍 全部金鑰冷卻時,原因要說出「用量到上限」(⛔ 不可只寫「暫時無法分析」)',
   '用量到上限' in r5[1], r5[1])
ok('⑫d 而且要講得出「幾把 / 多久恢復」', '2 把' in r5[1] and '小時' in r5[1], r5[1])

print()
print(f'❌ {len(fails)} 條失敗' if fails else '✅ GROQMODEL_PASS(全部通過)')
sys.exit(1 if fails else 0)
