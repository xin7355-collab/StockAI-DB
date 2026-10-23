#!/usr/bin/env python3
"""
🤖 V79.5.9 macro_miner 財經行事曆的 Groq 呼叫:每個模型帶自己的參數(跟 universal_radar 同一支 groq_apply)

🚨 10/22 Groq 把 llama 全下架(V79.5.8 修了 universal_radar 與 App)。macro_miner 的 `_groq_chat_mm`
   挑模型那段已經跟著走新偏好序(qwen → gpt-oss),但**參數沒跟著換**:
   ① gpt-oss 預設會思考、思考跟答案共用 max_tokens → 1,400 字可能被思考吃光、回空的
   ② 標在 `macro_events_ai.model` 的名字是事後**另外問一次**解析器(404 換過模型時會對不上 = 同名不同義)
⛔ 這支走**真的** `_groq_chat_mm` / `build_macro_events_ai`(只換掉網路):
   ① 第一次就用 qwen,帶 reasoning_effort=none、max_tokens 不變
   ② qwen 回 404 → 換 gpt-oss-120b:low + 不回傳思考 + 多給 400;再 404 → gpt-oss-20b(⛔ 不可疊成 2,200)
   ③ 回答裡的 <think>…</think> 要剝掉;標的模型 = 真的回答的那個
   ④ 決定性對照:把 groq_apply 換成「只換模型名」(= 改版前)→ ① 那條一定紅;
      標模型那行換回「事後再問一次」→ ③ 那條一定紅
"""
import copy
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import groq_common as G          # noqa: E402
import macro_miner as mm         # noqa: E402

fails = []


def ok(name, cond, extra=''):
    print(f"{'✅' if cond else '❌'} {name}" + ('' if cond else f'  {str(extra)[:300]}'))
    if not cond:
        fails.append(name)


# 10/22 #637 部署 log 印出來的那份真清單(聊天 4 個 + 語音 / 防護類)
REAL = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b', 'allam-2-7b',
        'whisper-large-v3', 'whisper-large-v3-turbo', 'playai-tts', 'playai-tts-arabic',
        'meta-llama/llama-guard-4-12b', 'meta-llama/llama-prompt-guard-2-86m', 'meta-llama/llama-prompt-guard-2-22m']
QWEN, OSS120, OSS20 = 'qwen/qwen3.8-27b', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'


class _Resp:
    def __init__(self, status, body=None):
        self.status_code = status
        self._body = body or {}
        self.text = str(body)[:200]

    def json(self):
        return self._body


G.requests.get = lambda url, timeout=None, headers=None: _Resp(200, {'data': [{'id': m} for m in REAL]})


class FakeHttp:
    """照劇本回應;每一次送出的 payload 都深拷貝留下來(_groq_chat_mm 每輪改的是同一個 dict)。"""
    def __init__(self, script):
        self.script, self.sent = list(script), []

    def post(self, url, json=None, headers=None, timeout=None):
        self.sent.append(copy.deepcopy(json))
        st, content = self.script.pop(0) if self.script else (200, '{}')
        return _Resp(st, {'choices': [{'message': {'content': content}}]} if st == 200 else {'error': st})


def run(script, **kw):
    G._cache.update(ids=None, at=0.0, err='')
    G._good.clear()
    mm._GROQ_USED_MM['model'] = None
    mm.GROQ_KEYS_MM = ['k1', 'k2']
    fh = FakeHttp(script)
    mm.http = fh
    out = mm._groq_chat_mm([{'role': 'user', 'content': 'hi'}], label='測試', **kw)
    return out, fh.sent


# ① 第一次就用 qwen,參數照 qwen 的給;<think> 剝掉
out, sent = run([(200, '<think>先想一下</think>\n{"summary":"x"}')])
ok('① 只打一次(⛔ 不再先白打一次 404)', len(sent) == 1, sent)
ok('① 挑 qwen', sent and sent[0].get('model') == QWEN, sent)
ok('① ⭐ qwen 帶 reasoning_effort=none、⛔ 不帶 include_reasoning', sent and sent[0].get('reasoning_effort') == 'none'
   and 'include_reasoning' not in sent[0], sent)
ok('① max_tokens 維持呼叫端的 1,400', sent and sent[0].get('max_tokens') == 1400, sent)
ok('③ 回答裡的 <think>…</think> 剝掉', out == '{"summary":"x"}', out)
ok('③ 記下真的回答的模型 = qwen', mm._GROQ_USED_MM['model'] == QWEN, mm._GROQ_USED_MM)

# ② qwen 404 → gpt-oss-120b;再 404 → gpt-oss-20b;⛔ 不可疊加 max_tokens、⛔ 不可留著上一個的參數
out, sent = run([(404, ''), (404, ''), (200, '{"summary":"z"}')], max_tokens=900)
ok('② 三次:qwen → gpt-oss-120b → gpt-oss-20b', [s.get('model') for s in sent] == [QWEN, OSS120, OSS20],
   [s.get('model') for s in sent])
ok('② gpt-oss 帶 low + 不回傳思考', all(s.get('reasoning_effort') == 'low' and s.get('include_reasoning') is False
                                     for s in sent[1:]), sent)
ok('② ⭐ gpt-oss 多給 400(900 → 1,300),換第二個 gpt-oss ⛔ 不可再疊(⛔ 1,700)',
   [s.get('max_tokens') for s in sent] == [900, 1300, 1300], [s.get('max_tokens') for s in sent])
ok('③ 記下真的回答的模型 = 最後那個 gpt-oss-20b', mm._GROQ_USED_MM['model'] == OSS20, mm._GROQ_USED_MM)

# ③ build_macro_events_ai 標的 model = 真的回答的那個(404 換過模型時,⛔ 不可事後另外問一次)
EVOUT = {'upcoming_macro_events': [{'date': '2026-10-28', 'event': 'FOMC 利率決議', 'severity': 'high'}], 'vix': 18.2}


def run_ai():
    G._cache.update(ids=None, at=0.0, err='')
    G._good.clear()
    mm._GROQ_USED_MM['model'] = None
    mm.GROQ_KEYS_MM = ['k1']
    mm.http = FakeHttp([(404, ''), (200, '{"summary":"這兩週波動可能放大","focus":[{"date":"2026-10-28","event":"FOMC"}]}')])
    return mm.build_macro_events_ai(EVOUT)


res = run_ai()
ok('③ build_macro_events_ai 拿得到結果', isinstance(res, dict) and res.get('summary'), res)
ok('③ ⭐ 標的模型 = 真的回答的 gpt-oss-120b(qwen 已 404)', isinstance(res, dict) and res.get('model') == OSS120,
   res and res.get('model'))

# ④ 決定性對照
_real_apply = mm._groq_apply


def _old_apply(payload, model, base_max=None):    # = 改版前:只換模型名
    payload['model'] = model
    return payload


mm._groq_apply = _old_apply
out, sent = run([(200, '{"summary":"x"}')])
ok('④ 決定性對照甲:groq_apply 換回「只換模型名」→ qwen 就不會帶 reasoning_effort(① 那條會紅)',
   sent and 'reasoning_effort' not in sent[0], sent)
mm._groq_apply = _real_apply

# 乙:模擬改版前「_groq_chat_mm 不記真的回答的模型」→ build_macro_events_ai 只能事後再問一次解析器
_orig_chat = mm._groq_chat_mm


def _chat_forget(*a, **k):
    r = _orig_chat(*a, **k)
    mm._GROQ_USED_MM['model'] = None
    return r


try:
    G._cache.update(ids=None, at=0.0, err='')
    G._good.clear()
    mm.GROQ_KEYS_MM = ['k1']
    mm.http = FakeHttp([(404, ''), (200, '{"summary":"s","focus":[]}')])
    mm._groq_chat_mm = _chat_forget
    res2 = mm.build_macro_events_ai(EVOUT)
    ok('④ 決定性對照乙:不記真的回答的模型 → 事後再問一次會標成 qwen(③ 那條會紅)',
       isinstance(res2, dict) and res2.get('model') == QWEN, res2 and res2.get('model'))
finally:
    mm._groq_chat_mm = _orig_chat

print(f"\n{'❌ %d 項未過:' % len(fails) + chr(10) + '  - ' + (chr(10) + '  - ').join(fails) if fails else '✅ 全部通過'}")
sys.exit(1 if fails else 0)
