#!/usr/bin/env python3
"""🔍 採礦腳本「用到不存在的名字」檢查(Python 版的 NameError 獵捕)

⚠️ 為什麼需要:前端那三個 bug(`raw` / `fugleData` / `localFund`)都是
   **「用到一個不存在的變數 → 例外被 catch 吞掉 → 功能靜默壞掉」**。
   採礦端有同一種風險,而且更難發現 —— 它的 `except Exception` 通常只 print 一行,
   workflow 照樣綠、artifact 照樣傳(陷阱 #9 的教科書案例就是這樣)。

⛔ `python3 -m py_compile` 抓不到:那是**執行期**才炸的。
   本專案沒有 pyflakes/flake8(沙箱裝不了),所以自己用 `ast` 做一個保守版。

保守到什麼程度(寧可漏報,不要誤報 —— 誤報會讓人養成忽略輸出的習慣):
  ・模組層 import / 賦值 / def / class → 全部視為已定義
  ・函式的參數、區域賦值、for/with/except as、walrus、comprehension 變數 → 已定義
  ・`global` / `nonlocal` 宣告的名字 → 已定義
  ・有 `from x import *` 的模組 → **整個模組跳過**(看不出哪些名字被帶進來)
  ・所有 builtins → 已定義
  ・⛔ 只看「函式內部」;模組層的前向參照太常見(且 py_compile 會抓真正的問題)

跑法:python3 scripts/check_undefined_py.py [檔案…]      預設根目錄所有 *.py
      python3 scripts/check_undefined_py.py --selftest   注入已知缺陷,確認它叫得出來
"""
import ast
import builtins
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUILTIN = set(dir(builtins)) | {'__file__', '__name__', '__doc__', '__spec__', '__package__'}


class Collector(ast.NodeVisitor):
    """收集某個 scope 內「被綁定」的名字。⛔ 只往下走到「不換 scope」的節點。"""

    def __init__(self):
        self.names = set()

    def _bind_target(self, t):
        for n in ast.walk(t):
            if isinstance(n, ast.Name):
                self.names.add(n.id)

    def visit_Assign(self, node):
        for t in node.targets:
            self._bind_target(t)
        self.generic_visit(node)

    def visit_AnnAssign(self, node):
        self._bind_target(node.target)
        self.generic_visit(node)

    def visit_AugAssign(self, node):
        self._bind_target(node.target)
        self.generic_visit(node)

    def visit_NamedExpr(self, node):      # walrus :=
        self._bind_target(node.target)
        self.generic_visit(node)

    def visit_For(self, node):
        self._bind_target(node.target)
        self.generic_visit(node)

    visit_AsyncFor = visit_For

    def visit_With(self, node):
        for it in node.items:
            if it.optional_vars is not None:
                self._bind_target(it.optional_vars)
        self.generic_visit(node)

    visit_AsyncWith = visit_With

    def visit_ExceptHandler(self, node):
        if node.name:
            self.names.add(node.name)
        self.generic_visit(node)

    def visit_Import(self, node):
        for a in node.names:
            self.names.add((a.asname or a.name).split('.')[0])

    def visit_ImportFrom(self, node):
        for a in node.names:
            self.names.add(a.asname or a.name)

    def visit_Global(self, node):
        self.names.update(node.names)

    def visit_Nonlocal(self, node):
        self.names.update(node.names)

    def visit_FunctionDef(self, node):
        self.names.add(node.name)         # ⛔ 不進入函式本體(那是另一個 scope)

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ClassDef(self, node):
        self.names.add(node.name)

    def visit_Lambda(self, node):
        pass                              # 另一個 scope


def bound_in(node):
    c = Collector()
    for child in ast.iter_child_nodes(node):
        c.visit(child)
    return c.names


def params_of(fn):
    a = fn.args
    out = {p.arg for p in list(a.posonlyargs) + list(a.args) + list(a.kwonlyargs)}
    if a.vararg:
        out.add(a.vararg.arg)
    if a.kwarg:
        out.add(a.kwarg.arg)
    return out


def comp_vars(node):
    """comprehension / generator 內部綁定的變數(它們自成 scope,但只往內看)"""
    out = set()
    for n in ast.walk(node):
        if isinstance(n, (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
            for g in n.generators:
                for x in ast.walk(g.target):
                    if isinstance(x, ast.Name):
                        out.add(x.id)
        elif isinstance(n, ast.Lambda):
            out |= params_of(n)
    return out


def scan_source(src, fname='<src>'):
    tree = ast.parse(src, fname)
    # `from x import *` → 看不出帶進哪些名字,整份跳過(⛔ 寧可漏報)
    for n in ast.walk(tree):
        if isinstance(n, ast.ImportFrom) and any(a.name == '*' for a in n.names):
            return None
    module_names = bound_in(tree) | BUILTIN
    findings = []

    def walk_fn(fn, outer):
        scope = set(outer) | params_of(fn) | bound_in(fn) | comp_vars(fn)
        # 巢狀函式:名字先加進來(可互相呼叫)
        for ch in ast.walk(fn):
            if isinstance(ch, (ast.FunctionDef, ast.AsyncFunctionDef)):
                scope.add(ch.name)
        # ⛔ 只看「屬於這個函式自己」的 Name —— 巢狀函式的內容留給遞迴處理,
        #   不然巢狀函式的區域變數會被拿到外層 scope 去比,反過來也會誤報。
        inner_fns = set()
        for ch in ast.walk(fn):
            if ch is not fn and isinstance(ch, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
                inner_fns.update(id(x) for x in ast.walk(ch))
        for node in ast.walk(fn):
            if id(node) in inner_fns:
                continue
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
                if node.id not in scope:
                    findings.append((node.lineno, node.id, fn.name))
        for sub in top_level_fns(fn):
            walk_fn(sub, scope)

    # ⛔ 只從「最外層」的函式開始 —— 巢狀函式由 walk_fn 自己往下帶著外層 scope 遞迴。
    #   第一版用 `ast.walk(tree)` 把巢狀函式也當成頂層來掃 → 它看不到外層的區域變數,
    #   於是每一個閉包都被誤報(selftest 當場抓到:`inner()` 讀 `a`/`i` 被判成未定義)。
    def top_level_fns(n):
        for ch in ast.iter_child_nodes(n):
            if isinstance(ch, (ast.FunctionDef, ast.AsyncFunctionDef)):
                yield ch
            elif isinstance(ch, ast.ClassDef):
                yield from top_level_fns(ch)
            elif isinstance(ch, (ast.If, ast.Try, ast.With, ast.For, ast.While)):
                yield from top_level_fns(ch)

    for node in top_level_fns(tree):
        walk_fn(node, module_names)

    # 去重(同一個名字在同一個函式只報一次)
    seen, uniq = set(), []
    for ln, name, fn in findings:
        k = (name, fn)
        if k in seen:
            continue
        seen.add(k)
        uniq.append((ln, name, fn))
    return uniq


def selftest():
    """⭐ 「沒報錯」≠「檢查過了」—— 注入已知缺陷,確認它叫得出來。"""
    bad = "def f(a):\n    try:\n        return a + undefined_thing\n    except Exception as e:\n        print(e)\n"
    good = ("import os\n"
            "K = 1\n"
            "def f(a, *args, **kw):\n"
            "    b = [x for x in range(3)]\n"
            "    with open('x') as fh:\n"
            "        pass\n"
            "    for i in b:\n"
            "        pass\n"
            "    def inner():\n"
            "        return a + K + i\n"
            "    try:\n"
            "        return inner() + os.getpid() + len(b) + fh.fileno() + sum(args) + len(kw)\n"
            "    except Exception as e:\n"
            "        return str(e)\n")
    r1 = scan_source(bad)
    r2 = scan_source(good)
    print('🧪 selftest')
    okd = True
    if any(n == 'undefined_thing' for _, n, _ in r1):
        print('   ✅ 抓得到「用到不存在的名字」')
    else:
        print(f'   ❌ 抓不到 —— 偵測器壞了({r1})')
        okd = False
    if r2:
        print(f'   ❌ 誤報:正常寫法也被報了 → {r2}')
        okd = False
    else:
        print('   ✅ 正常寫法(參數/推導式/with/for/巢狀函式/import)不誤報')
    return 0 if okd else 1


if '--selftest' in sys.argv:
    raise SystemExit(selftest())

args = [a for a in sys.argv[1:] if not a.startswith('-')]
files = [Path(a) for a in args] or sorted(ROOT.glob('*.py'))
total = skipped = 0
for f in files:
    try:
        res = scan_source(f.read_text(encoding='utf-8'), f.name)
    except SyntaxError as e:
        print(f'❌ {f.name} 語法錯:{e}')
        total += 1
        continue
    if res is None:
        skipped += 1
        continue
    if not res:
        continue
    total += len(res)
    print(f'❌ {f.name}:{len(res)} 個用到不存在的名字')
    for ln, name, fn in res:
        print(f'   L{ln}  `{name}`(在 {fn}() 裡)')

print()
print(f'掃 {len(files)} 支(跳過 {skipped} 支有 import *)')
if total:
    print(f'❌ UNDEFINED_PY_FAIL:{total} 處')
    print('⚠️ 人工驗證:那個名字是不是打錯字 / 是不是別的函式的參數。')
    print('   ⛔ 採礦端的 NameError 常被 `except Exception` 吞掉 → workflow 照樣綠、檔案就是不見(陷阱 #9)。')
    raise SystemExit(1)
print('✅ UNDEFINED_PY_PASS')
