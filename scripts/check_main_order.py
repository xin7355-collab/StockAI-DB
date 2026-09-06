#!/usr/bin/env python3
"""
採礦腳本進入點順序防呆(V71.1.1 新增,四驗證第 2 關的一部分)。

【為什麼會有這支 — 真實踩過的坑】
radar_miner.py 的 `if __name__ == '__main__':` 區塊原本卡在檔案中段,
而 V70.3.1~V71.1.0 新加的四支採礦函式定義在它「下面」。
Python 由上而下執行 → 執行到進入點時那四個名字還不存在 → NameError。
偏偏每個呼叫都包在 try/except 裡(為了「一支失敗不影響其他」),
於是錯誤被靜靜吞掉:workflow rc=0、job 顯示 success、artifact 照傳,
**但那四個 JSON 檔根本沒產出**,前端永遠讀不到,整整空轉一天才發現。

本地 dry-run 完全測不出來 —— 因為 dry-run 是 import 完(所有 def 都執行過)
之後才直接呼叫函式,順序問題自然消失。只有「真的跑整支腳本」才會現形。

【這支在檢查什麼】
對每個根目錄的採礦腳本,靜態掃描 `if __name__ == '__main__':` 區塊裡呼叫的
模組層級函式,確認它們的 `def` 都在該區塊「之前」。

用法:python3 scripts/check_main_order.py     (唯讀,不改檔)
"""
import ast
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def check(path: Path):
    """回傳 (檔名, [有問題的函式名]) — 沒問題則第二項為空 list。"""
    try:
        src = path.read_text(encoding="utf-8")
        tree = ast.parse(src)
    except Exception as e:
        return path.name, [f"(無法解析:{e})"]

    # 模組層級定義的名字 → 定義所在行號
    defined_at = {}
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            defined_at[node.name] = node.lineno
        elif isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name):
                    defined_at.setdefault(t.id, node.lineno)

    bad = []
    for node in tree.body:
        # 找 `if __name__ == '__main__':`
        if not isinstance(node, ast.If):
            continue
        test = node.test
        is_main = (
            isinstance(test, ast.Compare)
            and isinstance(test.left, ast.Name)
            and test.left.id == "__name__"
            and any(isinstance(c, ast.Constant) and c.value == "__main__" for c in test.comparators)
        )
        if not is_main:
            continue
        entry_line = node.lineno
        for sub in ast.walk(node):
            if isinstance(sub, ast.Call) and isinstance(sub.func, ast.Name):
                name = sub.func.id
                line = defined_at.get(name)
                # 只管「這支檔案自己定義的」;內建 / import 進來的不算
                if line is not None and line > entry_line:
                    bad.append(f"{name}()（定義在 L{line}，進入點在 L{entry_line}）")
    return path.name, bad


def main():
    targets = sorted(p for p in ROOT.glob("*.py"))
    if not targets:
        print("⚠️ 找不到任何根目錄 .py")
        return
    problems = []
    for p in targets:
        name, bad = check(p)
        if bad:
            problems.append((name, bad))

    if problems:
        print("❌ 進入點順序錯誤 —— 這些函式在被呼叫時「還沒定義」，執行時會 NameError：")
        for name, bad in problems:
            print(f"\n   📄 {name}")
            for b in bad:
                print(f"      • {b}")
        print("\n   ⚠️ 危險之處：若呼叫端包在 try/except 裡，錯誤會被吞掉 →")
        print("      workflow 仍然 rc=0、job 顯示成功，但檔案根本沒產出（靜默失敗）。")
        print("\n   修法：把 `if __name__ == '__main__':` 區塊整段搬到檔案最後面。")
        sys.exit(1)

    print(f"✅ 進入點順序 OK（掃 {len(targets)} 支根目錄腳本，"
          f"所有 __main__ 呼叫的函式都已在其之前定義）")


if __name__ == "__main__":
    main()
