"""🩺 讀「累積型」JSON 檔的唯一一份安全讀法(2026-10-24 daily_miner #647 實例)。

🚨 為什麼要有這支:
   #647 部署時 20 台採礦機的結果被「同時」寫進同一個檔(download-artifact 一次解好幾包),
   剛好那時別的 workflow 更新了那個檔 → 寫成「新的完整 JSON + 舊檔多出來的尾巴」。
   之後 confcall_miner 讀舊檔 `except: return {}` → 以為「本來就沒有歷史」→
   5 年法說會歷史只剩這一輪的;pick_snapshot 同一個寫法 → 400 天推薦紀錄會整份歸零。

⭐ 三種結果分清楚(⛔ 不可混成同一種):
   'missing'  檔案不在 / 0 bytes        → 正常(第一次跑),照舊從頭建
   'ok'       讀得出來
   'salvaged' 前面是一份完整的 JSON、後面多了一段(陷阱 #60 那次的形狀)→ 用前面那份,印 ⚠️
   'corrupt'  救不回來(亂碼 / 截斷)    → 呼叫端自己決定:⛔ 不可當成 'missing' 整份重建
"""
import json


def load_json_safe(path, default=None, log=print, what=''):
    """回 (obj, status, msg)。status ∈ missing / ok / salvaged / corrupt。"""
    name = what or str(path)
    try:
        b = path.read_bytes()
    except FileNotFoundError:
        return default, 'missing', ''
    except Exception as e:
        msg = f'{name} 讀不到({type(e).__name__}: {str(e)[:80]})'
        log(f'❌ {msg}')
        return default, 'corrupt', msg
    if not b.strip():
        return default, 'missing', ''
    try:
        s = b.decode('utf-8')
    except UnicodeDecodeError as e:
        msg = f'{name} 不是完整的 UTF-8(第 {e.start} 個位元組壞掉,共 {len(b):,} bytes)'
        log(f'❌ {msg}')
        return default, 'corrupt', msg
    try:
        return json.loads(s), 'ok', ''
    except json.JSONDecodeError as e:
        # ⭐ 只救「前面是一份完整的 JSON、後面多一段」這一種 —— 那一段之前的內容是某一版完整的檔
        try:
            obj, end = json.JSONDecoder().raw_decode(s.lstrip())
        except json.JSONDecodeError:
            obj, end = None, 0
        if obj is not None and isinstance(obj, (dict, list)):
            tail = len(s.lstrip()) - end
            msg = (f'{name} 後面多了 {tail:,} 個字({str(e)[:60]})→ 用前面那份完整的'
                   f'(⚠️ 可能是比較舊的一版)')
            log(f'⚠️ {msg}')
            return obj, 'salvaged', msg
        msg = f'{name} 解析失敗({str(e)[:80]},共 {len(b):,} bytes)'
        log(f'❌ {msg}')
        return default, 'corrupt', msg


def _selftest():
    import tempfile
    from pathlib import Path
    out = []
    ok = lambda name, cond: out.append((name, bool(cond)))
    d = Path(tempfile.mkdtemp())
    p = d / 'x.json'
    q = lambda: load_json_safe(p, {'dflt': 1}, log=lambda *_: None)
    o, st, _ = q()
    ok('① 檔案不在 → missing + 預設值', st == 'missing' and o == {'dflt': 1})
    p.write_bytes(b'')
    ok('② 0 bytes → missing', q()[1] == 'missing')
    p.write_text('{"a":1,"hist":{"2330":[1,2]}}', encoding='utf-8')
    o, st, _ = q()
    ok('③ 正常 → ok', st == 'ok' and o['hist']['2330'] == [1, 2])
    # ⭐ #647 真實形狀:新的完整 JSON + 舊版多出來的尾巴(中文 + 引號 + 右大括號)
    p.write_text('{"a":2,"note":"⛔ 不給多空。"}方向實測 0 個成立,⛔ 不給多空。"}', encoding='utf-8')
    o, st, msg = q()
    ok('④ 完整 JSON + 尾巴 → salvaged,拿到前面那份', st == 'salvaged' and o == {'a': 2, 'note': '⛔ 不給多空。'})
    ok('④b 訊息要說多了幾個字', '多了' in msg)
    p.write_bytes('{"a":"中文'.encode('utf-8') + b'\x8a\x8a' + b'"}')
    o, st, _ = q()
    ok('⑤ UTF-8 壞掉 → corrupt,⛔ 不可回成 missing', st == 'corrupt' and o == {'dflt': 1})
    p.write_text('{"a":1,"b":[1,2', encoding='utf-8')
    ok('⑥ 截斷(後面沒了)→ corrupt', q()[1] == 'corrupt')
    p.write_text('123 456', encoding='utf-8')
    ok('⑦ 前面不是物件 / 陣列 → corrupt(⛔ 不拿一個數字當舊檔)', q()[1] == 'corrupt')
    bad = [n for n, c in out if not c]
    for n, c in out:
        print(('✅ ' if c else '❌ ') + n)
    return 1 if bad else 0


if __name__ == '__main__':
    import sys
    sys.exit(_selftest() if '--selftest' in sys.argv else 0)
