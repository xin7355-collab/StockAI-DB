#!/usr/bin/env python3
"""
DOM id 唯一性防呆(四驗證第 3 關,V71.0.7 起取代 check_prompt_vars.py)。

【為什麼換掉 check_prompt_vars.py】
它檢查的是 runUnifiedGroqAnalysis 裡的 prompt 變數,但那支函式自 V51.4 起
entry 就是 `return;`(整段 prompt 是不可達的死碼),V71.0.7 已整條刪除
→ 那個檢查等於在驗證死碼,是形式主義的安全網。

【為什麼換成這個】
V71.0.3 真的靠這招抓到線上 bug:「🕵️ 全市場主力雷達」modal 掛在 document.body
常駐(只 hidden 不刪),跟券商頁共用 radarBrokerSel / radarBrokerDetail /
brokerPerfBox 三個 id → 兩份同時在 DOM,document.getElementById 永遠只回
DOM 順序較前的那份 → modal 開著時點分點,內容寫進背後看不見的頁面,
使用者只覺得「按了沒反應」。

【判真偽的原則(⚠️ 不是所有重複都是 bug,別照單全收)】
下面 ALLOW 名單裡的是**人工逐條讀過原始碼確認安全**的,兩種安全情形:
  (a) 同一個函式內多個 return 分支 → 一次只會產出一份
  (b) 多個函式寫進**同一個容器**的 innerHTML → 互相取代,不會並存
新出現的重複 id 一律先當成 bug 處理:證明它屬於 (a)/(b) 才加進 ALLOW,
並在後面寫清楚理由。

用法:python3 scripts/check_dom_ids.py     (唯讀,不改檔)
"""
import re
import sys
from pathlib import Path

HTML = Path(__file__).resolve().parent.parent / "index.html"

# id -> 為什麼安全(人工驗證過的理由,新增務必寫清楚)
ALLOW = {
    "aiGodNewsBox":
        "openAiGod 與 _renderAiGodFavMode 都是寫同一個 #aiGodChat 的 innerHTML,"
        "且入口處 early return 二選一 → 互斥,同時只存在一份。",
    "overnightT1Card":
        "同一個函式內三個 return 分支(不同盤勢走不同版型)→ 一次只產出一份。",
    # ── 以下三個是 (c) 第三種情況:兩份「真的會並存」,但查詢端已做範圍限縮 ──
    #    V71.0.3 修法:app._brokerEl(id) — 主力雷達 modal 沒 hidden 時先 modal.querySelector,
    #    否則才 getElementById。⚠️ 這三個 id 若之後新增讀取端,**必須也走 _brokerEl**,
    #    直接用 getElementById 會退回原本的 bug(寫進背後看不見的頁面)。
    "brokerPerfBox":
        "券商頁 #brokerCatBody 與 主力雷達 modal 各一份,會並存;"
        "唯一讀取端已走 app._brokerEl 做 scope 限縮(V71.0.3)。",
    "radarBrokerSel":
        "同上(券商頁 / 主力雷達 modal 並存);所有讀取端已走 app._brokerEl。",
    "radarBrokerDetail":
        "同上(券商頁 / 主力雷達 modal 並存);所有讀取端已走 app._brokerEl。",
}


def main():
    if not HTML.exists():
        sys.exit(f"❌ 找不到 {HTML}")
    html = HTML.read_text(encoding="utf-8")

    seen = {}
    for m in re.finditer(r'id="([a-zA-Z_][\w-]*)"', html):
        seen.setdefault(m.group(1), []).append(html.count("\n", 0, m.start()) + 1)

    dups = {k: v for k, v in seen.items() if len(v) > 1}
    bad = {k: v for k, v in dups.items() if k not in ALLOW}
    stale = [k for k in ALLOW if k not in dups]

    if bad:
        print("❌ 發現未經確認的重複 DOM id(document.getElementById 只會抓到第 1 個):")
        for k, v in sorted(bad.items()):
            print(f"   • {k}  出現在 L{', L'.join(map(str, v))}")
        print("\n   兩種情況二選一:")
        print("   ① 兩份真的會同時存在 DOM → 這是 bug,請把查詢限縮到正確容器"
              "(參考 app._brokerEl 的作法)或改用不同 id。")
        print("   ② 確認互斥(同函式多 return / 同容器 innerHTML 取代)→ "
              "把 id 加進本檔 ALLOW 並寫明理由。")
        sys.exit(1)

    if stale:
        print(f"⚠️ ALLOW 名單有 {len(stale)} 個 id 已不再重複,可以移除:{', '.join(stale)}")

    print(f"✅ DOM id 唯一性 OK(掃 {len(seen)} 個 id;"
          f"{len(dups)} 個已知安全重複:{', '.join(sorted(dups)) or '無'})")


if __name__ == "__main__":
    main()
