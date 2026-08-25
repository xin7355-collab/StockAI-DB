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
   res2[1] == G.groq_reason(404), res2[1])
ok('⑧g 而且要收斂,⛔ 不可無限重試', len(seen) <= 8, len(seen))

# ── ⑨ 快取不可永久 ───────────────────────────────────────────────
ok('⑨ 快取 TTL ≤12 小時(模型下架是常態,⛔ 不可永久快取)', 0 < G._TTL <= 12 * 3600, G._TTL)

print()
print(f'❌ {len(fails)} 條失敗' if fails else '✅ GROQMODEL_PASS(全部通過)')
sys.exit(1 if fails else 0)
