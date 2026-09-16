#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""🪙 etf_miner.fetch_etf_premium 的批次信封解析守門

【為什麼有這支】
`data/etf_tracking.json` 的 `_premium_status` 長期是
    命中0檔;arr長=24;首筆keys=['msgArray','refURL','userDelay','rtMessage','rtCode']
→ ETF 折溢價與淨值**從那次改版起一直是空的,而且零錯誤訊息**(workflow 全綠)。

真因:mis.twse `all_etf.txt` 回的是「**批次信封**」不是資料列,而程式只剝到 `j['a1']`。

🚨 測資**逐字照 scripts/stockname_probe.py 在 Actions 實跑印出來的**(2026-09-09 run #10):
    {"a1":[{"msgArray":[{"a":"00693U","b":"街口標普高盛黃豆ER…","c":69166000.00,
                         "d":-1000000.00,"e":23.76,"f":23.97,"g":-0.88,"h":23.94,
                         "i":"20260909","j":"17:01:15","k":"3"}, …]}, …]}
⛔ **不可憑印象編測資** —— V75.1.3 的上櫃融券就是「測資跟程式用同一組想像的欄名、
   兩邊對得上」才讓 12 條測試全綠卻寫進錯資料(陷阱 #40)。

⚠️ 沙箱連不到 mis.twse → 一律 stub `etf_miner.session.get`;
   不 stub 的話這支測試的結果會取決於網路(而且要等 timeout)。
"""
import json, sys, types

sys.path.insert(0, '.')
import etf_miner

FAIL = []


def ck(name, cond, extra=''):
    print(f"{'✅' if cond else '❌'} {name}" + (f" — {extra}" if extra else ''))
    if not cond:
        FAIL.append(name)


# ── 真實回應(⭐ 逐字照探針輸出;只縮成 2 包 3 列,欄位與型別一字不改)────────
REAL = {
    "a1": [
        {"msgArray": [
            {"a": "00693U", "b": "街口標普高盛黃豆ER指數股票型期貨信託基金",
             "c": 69166000.00, "d": -1000000.00, "e": 23.76, "f": 23.97,
             "g": -0.88, "h": 23.94, "i": "20260909", "j": "17:01:15", "k": "3"},
            {"a": "0050", "b": "元大台灣卓越50證券投資信託基金",
             "c": 1.0, "d": 0.0, "e": 250.0, "f": 249.5,
             "g": 0.20, "h": 248.0, "i": "20260909", "j": "17:01:15", "k": "3"},
        ], "refURL": "https://mis.twse.com.tw/stock", "userDelay": 5000,
            "rtMessage": "OK", "rtCode": "0000"},
        {"msgArray": [
            {"a": "00981A", "b": "統一台股增長主動式ETF",
             "c": 1.0, "d": 0.0, "e": 15.0, "f": 15.10,
             "g": -0.66, "h": 15.05, "i": "20260909", "j": "17:01:15", "k": "3"},
            {"a": "00888", "b": "永豐台灣ESG",  # 🚧 g 是「未結出」→ 要被跳過
             "c": 1.0, "d": 0.0, "e": 18.0, "f": "", "g": "未結出",
             "h": 18.0, "i": "20260909", "j": "17:01:15", "k": "3"},
        ], "refURL": "https://mis.twse.com.tw/stock", "userDelay": 5000,
            "rtMessage": "OK", "rtCode": "0000"},
    ]
}

# 舊格式(⭐ 向後相容:哪天官方改回直接給資料列,也不可以壞掉)
FLAT = {"a1": [
    {"a": "0050", "e": 250.0, "f": 249.5, "g": 0.20, "h": 248.0},
    {"a": "0056", "e": 40.0, "f": 40.1, "g": -0.25, "h": 40.0},
]}

# 混合(有的是信封、有的已經是資料列)
MIXED = {"a1": [
    {"msgArray": [{"a": "0050", "e": 250.0, "f": 249.5, "g": 0.20}]},
    {"a": "0056", "e": 40.0, "f": 40.1, "g": -0.25},
]}


def run(payload, status=200):
    """stub 掉 session.get,實跑真的 fetch_etf_premium(⛔ 測試裡不複製一份解析邏輯)"""
    class _R:
        status_code = status
        def json(self): return payload
    orig = etf_miner.session.get
    etf_miner.session.get = lambda *a, **k: _R()
    try:
        etf_miner._PREMIUM_STATUS = "(未執行)"
        return etf_miner.fetch_etf_premium(), etf_miner._PREMIUM_STATUS
    finally:
        etf_miner.session.get = orig


print("=" * 66)
print("🪙 ETF 折溢價:批次信封解析")
print("=" * 66)

# ① 真實結構要剝得開(這條就是那個 bug 本身)
out, st = run(REAL)
ck("① 真實批次信封要解析得出來(⛔ 不可再是 0 檔)", len(out) > 0, f"命中 {len(out)} 檔 ・{st[:60]}")
ck("①b 0050 的折溢價要對得上", out.get("0050", {}).get("prem") == 0.20, str(out.get("0050")))
ck("①c 淨值 nav 要一起收(V72.4.1 的用意)", out.get("0050", {}).get("nav") == 249.5, str(out.get("0050")))
ck("①d 成交價 px 要一起收", out.get("0050", {}).get("px") == 250.0, str(out.get("0050")))
ck("①e 兩包信封都要攤到(第 2 包的 00981A)", "00981A" in out, sorted(out))
ck("①f 負的折溢價(折價)要收得到", out.get("00693U", {}).get("prem") == -0.88, str(out.get("00693U")))

# ② 「未結出」要跳過 —— ⛔ 不可變成 0
# ⚠️ 注入驗證的誠實紀錄:把 `"未結出"` 從那個 tuple 拿掉,這條**照樣綠** ——
#    因為真正擋住它的是下一行的 `if f is not None`(`_to_float("未結出")` 回 None)。
#    那個 tuple 是**提早收工 + 寫明意圖**的第二道,⛔ 不 load-bearing。
#    ⭐ 而拿掉 `if f is not None` 的話 `round(None,2)` 會丟例外 → 被外層 except 吞成整包空
#      → 由 ① 叫出來。⛔ 兩條都不可拿掉。
ck("② g='未結出' 的要跳過(⛔ 不可當成 0% 溢價)", "00888" not in out, sorted(out))

# ③ 狀態字串要說得出「剝了幾包」,⛔ 不可靜默
ck("③ 成功時 _PREMIUM_STATUS 要寫命中幾檔", "命中" in st and "0檔" not in st, st[:70])

# ④ 向後相容:官方哪天改回直接給資料列
out2, st2 = run(FLAT)
ck("④ 舊的『直接給資料列』格式仍要正常", out2.get("0050", {}).get("prem") == 0.20 and len(out2) == 2,
   f"{len(out2)} 檔")

# ⑤ 混合型態(有信封也有資料列)⛔ 不可漏掉沒包信封的那筆
out3, _ = run(MIXED)
ck("⑤ 混合型態兩種都要收得到", set(out3) == {"0050", "0056"}, sorted(out3))

# ⑥ HTTP 非 200 要誠實回空 + 說原因
out4, st4 = run(REAL, status=403)
ck("⑥ HTTP 403 要回空並寫進狀態", out4 == {} and "403" in st4, st4[:60])

# ⑦ 🚧 空過守門:確認 stub 真的被呼叫到(⛔ 否則上面每一條都可能是假綠燈)
ck("⑦ 空過守門:stub 有被走到(狀態字串不是『未執行』)", st != "(未執行)", st[:40])

# ⑧ 原始碼守門:⛔ 不可只剝一層
body = open('etf_miner.py', encoding='utf-8').read()
seg = body[body.index('def fetch_etf_premium'):body.index('def main(')]
seg_nc = '\n'.join(l for l in seg.split('\n') if not l.lstrip().startswith('#'))
ck("⑧ 函式本體要有 msgArray 的攤平(剝註解後仍在)", 'msgArray' in seg_nc,
   "⛔ 只剝 j['a1'] 就會回到那個 bug")

print("=" * 66)
print(f"{'🎉 全過' if not FAIL else '❌ 失敗 ' + str(len(FAIL)) + ' 條:' + ', '.join(FAIL)}")
sys.exit(1 if FAIL else 0)
