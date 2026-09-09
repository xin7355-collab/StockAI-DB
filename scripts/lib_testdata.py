#!/usr/bin/env python3
"""測試用的真實資料來源:**本地 `data/` → `origin/gh-pages` → 誠實跳過**。

⭐ 為什麼需要這支(2026-09-09 新增):
   `data/` 在 main 是 gitignore、只有採礦機才會產出 → **開發/沙箱環境本地幾乎是空的**
   (實測只有 3 個 json、`data/chips/` 0 個),而好幾支測試把「真實資料」當前提:
     ・`test_themes.py` ②c   每一檔題材成員都要有 K 線檔
     ・`test_chips_backfill.py` ⑨f  top_brokers 要從真實 chips 撈得出 ≥100 家券商
   → 它們在本地**永遠紅**。

⛔ **「永遠紅的測試等於沒有測試」** —— CLAUDE.md 白紙黑字:誤報會讓人養成無視守門的習慣,
   真的壞掉那次就被淹掉。
⛔ 但解法**不是放寬斷言**(那會把真的 bug 一起放過),而是**退回 gh-pages 拿真實資料**
   —— 同 `test_todaysig` / `test_dividend` 對 `playbook_edge.json` 的做法。
⛔ 兩邊都拿不到才**回 None 讓呼叫端誠實跳過**,而且一定要**印出走了哪一條路**
   (⚠️ 沒印的話,下一個人不知道那條斷言到底驗了什麼 —— 那又是另一種假綠燈)。

⚠️ CI 上可能是 shallow clone、沒有 `origin/gh-pages` → 所有 git 呼叫都包 try,失敗就回 None。
"""
from __future__ import annotations
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_CACHE = Path('/tmp/_stockai_testdata')


def _git(args: list, binary: bool = False):
    """跑 git,失敗一律回 None(⛔ 不 raise —— CI 可能沒有那個分支)。"""
    try:
        r = subprocess.run(['git'] + args, cwd=str(ROOT), capture_output=True, timeout=120)
        if r.returncode != 0:
            return None
        return r.stdout if binary else r.stdout.decode('utf-8', 'replace')
    except Exception:
        return None


def kline_syms(min_local: int = 100) -> set | None:
    """回傳「有 K 線檔的股票代號」集合。

    本地 `data/*.json` 夠多就用本地;不夠就問 `origin/gh-pages`;都沒有回 None。
    """
    local = {p.stem for p in (ROOT / 'data').glob('*.json')} if (ROOT / 'data').is_dir() else set()
    if len(local) >= min_local:
        print(f'  📁 K 線來源:本地 data/({len(local)} 檔)')
        return local
    out = _git(['ls-tree', '--name-only', 'origin/gh-pages', 'data/'])
    if not out:
        print('  ⏭️ 本地 data/ 不足且讀不到 origin/gh-pages → 這條斷言跳過')
        return None
    syms = {Path(l).stem for l in out.splitlines() if l.endswith('.json')}
    print(f'  ☁️ K 線來源:origin/gh-pages({len(syms)} 檔,本地只有 {len(local)})')
    return syms or None


def chips_dir(sample: int = 300) -> Path | None:
    """回傳「一個真的裝著 `data/chips/*.json` 的目錄」。

    本地有就用本地;沒有就從 gh-pages 取樣 `sample` 檔到 /tmp(快取,實測 200 檔 ~1 秒)。
    ⚠️ 取樣是為了速度 —— 全部 2,718 檔共 139 MB,而 top_brokers 只需要夠多的樣本。
    """
    local = ROOT / 'data' / 'chips'
    n_local = len(list(local.glob('*.json'))) if local.is_dir() else 0
    if n_local >= 50:
        print(f'  📁 chips 來源:本地({n_local} 檔)')
        return local
    if _CACHE.is_dir() and len(list(_CACHE.glob('*.json'))) >= min(sample, 50):
        print(f'  ♻️ chips 來源:/tmp 快取({len(list(_CACHE.glob("*.json")))} 檔)')
        return _CACHE
    names = _git(['ls-tree', '--name-only', 'origin/gh-pages', 'data/chips/'])
    if not names:
        print(f'  ⏭️ 本地 chips 只有 {n_local} 檔且讀不到 origin/gh-pages → 這條斷言跳過')
        return None
    files = [l for l in names.splitlines() if l.endswith('.json')][:sample]
    if not files:
        print('  ⏭️ origin/gh-pages 上沒有 chips → 這條斷言跳過')
        return None
    _CACHE.mkdir(parents=True, exist_ok=True)
    got = 0
    for f in files:
        blob = _git(['show', f'origin/gh-pages:{f}'], binary=True)
        if blob:
            (_CACHE / Path(f).name).write_bytes(blob)
            got += 1
    if got < 20:
        print(f'  ⏭️ 只取到 {got} 個 chips 檔 → 這條斷言跳過')
        return None
    print(f'  ☁️ chips 來源:origin/gh-pages 取樣 {got} 檔 → {_CACHE}')
    return _CACHE


if __name__ == '__main__':
    s = kline_syms()
    print('kline_syms:', len(s) if s else None)
    d = chips_dir()
    print('chips_dir:', d, len(list(d.glob('*.json'))) if d else None)
