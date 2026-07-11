# -*- coding: utf-8 -*-
"""共用工具模組(單一真相來源)。

背景:本專案是「扁平目錄 + 每支腳本在 CI 各自獨立執行(python xxx_miner.py)」的結構,
      許多小工具函式(NaN 防呆、平均、台北時區、JSON 讀取)在多支檔案被重複定義。
      本模組把這些「與情境無關」的純函式集中,消除重複、避免各檔行為漂移。

原則:只依賴標準函式庫(math / json / datetime / pathlib),不 import 任何專案內模組,
      確保任何腳本 `from common import ...` 都不會產生循環相依。
"""
import json
import math
from datetime import timezone, timedelta
from pathlib import Path

# 台北時區(UTC+8)—— 原本散落在 miner / momentum / potential / rotation ... 各自定義。
TPE = timezone(timedelta(hours=8))


def is_finite_num(x) -> bool:
    """x 是否為「有限的數值」:排除 None / 字串 / bool / NaN / ±Inf。

    技術指標(MA/MACD/布林/KD)最常見的髒資料就是序列裡混進 NaN——
    isinstance(nan, float) 為 True 會漏過單純的型別檢查,污染整條指標卻無聲。
    這個檢查是全專案 NaN 防呆的單一入口。
    (排除 bool 是因為 isinstance(True, int) 為 True,價格/量不該是布林。)
    """
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def avg(seq):
    """安全平均:空序列回 0.0(對齊各 miner 原本的 avg 語意)。"""
    return sum(seq) / len(seq) if seq else 0.0


def safe_ma(closes, period, idx=None):
    """closes[idx] 往回 period 日的移動平均(含當日)。
    資料不足、或視窗含非有限值 → 回 None(而非算出被污染的 NaN)。
    idx 預設為最後一筆。"""
    if idx is None:
        idx = len(closes) - 1
    if idx + 1 < period or idx < 0:
        return None
    seg = closes[idx - period + 1: idx + 1]
    if len(seg) != period or not all(is_finite_num(c) for c in seg):
        return None
    return sum(seg) / period


def load_json(path, default=None):
    """讀 JSON;檔案不存在/解析失敗一律回 default(不拋例外)。"""
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except Exception:
        return default
