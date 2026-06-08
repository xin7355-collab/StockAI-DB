#!/usr/bin/env python3
"""
runUnifiedGroqAnalysis prompt 變數對照防呆。

抓 index.html 內 runUnifiedGroqAnalysis 函式 scope 的 const/let 宣告,
比對 `const prompt = \`...\`` template literal 內所有裸 ${IDENT},
若有未定義的就 exit 1,讓 push 前可以本機跑一次擋下 ma60 那類 ReferenceError。

用法:
    python scripts/check_prompt_vars.py
"""
import re
import sys
from pathlib import Path

INDEX = Path(__file__).resolve().parent.parent / "index.html"

BUILTINS = {
    "Math", "Date", "JSON", "Object", "Array", "String", "Number", "Boolean",
    "console", "window", "document", "this", "true", "false", "null", "undefined",
    "globalThis", "Promise", "Map", "Set", "Symbol", "Error",
}

BARE_IDENT_RE = re.compile(r"\$\{([A-Za-z_$][A-Za-z0-9_$]*)\}")
DECL_RE = re.compile(r"\b(?:const|let|var)\s+(?:\{[^}]*\}\s*=|\[[^\]]*\]\s*=|([A-Za-z_$][A-Za-z0-9_$]*))")
DESTRUCT_RE = re.compile(r"\b(?:const|let|var)\s*\{([^}]+)\}\s*=")


def extract_scope(html: str):
    start = html.find("async runUnifiedGroqAnalysis")
    if start < 0:
        sys.exit("找不到 runUnifiedGroqAnalysis 函式")
    end_marker = re.compile(r"\n    \},\n")
    m = end_marker.search(html, start)
    end = m.start() if m else start + 60000
    return html[start:end]


def extract_prompt_literal(body: str):
    idx = body.find("const prompt = `")
    if idx < 0:
        sys.exit("找不到 const prompt = `...` template literal")
    rest = body[idx + len("const prompt = `"):]
    end = rest.find("`")
    if end < 0:
        sys.exit("prompt template literal 沒有閉合 backtick")
    return rest[:end]


def main():
    html = INDEX.read_text(encoding="utf-8")
    body = extract_scope(html)

    declared = set(BUILTINS)
    for m in DECL_RE.finditer(body):
        if m.group(1):
            declared.add(m.group(1))
    for m in DESTRUCT_RE.finditer(body):
        for part in m.group(1).split(","):
            name = part.strip().split(":")[0].split("=")[0].strip()
            if name and re.match(r"^[A-Za-z_$][A-Za-z0-9_$]*$", name):
                declared.add(name)
    declared.update({"opts", "sym", "ind", "data", "lastIdx", "currentPrice", "symName"})

    prompt = extract_prompt_literal(body)
    used = set(BARE_IDENT_RE.findall(prompt))

    missing = sorted(used - declared)
    if missing:
        print("runUnifiedGroqAnalysis prompt 引用了未在 scope 內定義的變數:")
        for name in missing:
            print(f"   - ${{{name}}}")
        print("\n修法: 改用已宣告的同義變數(例如 ma60Str),或在 prompt 前新增 const 宣告。")
        sys.exit(1)

    print(f"OK: prompt 內 {len(used)} 個變數全部已在 scope 宣告({len(declared)} 個 const/let)")


if __name__ == "__main__":
    main()
