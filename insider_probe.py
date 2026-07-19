#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🔍 董監質押 / 內部人持股 資料源探針(B 案可行性實測)
只在 GitHub Actions 跑,不部署、不動任何資料分支。目的:
  1. 掃 TWSE OpenAPI 全 endpoint,找「董監 / 質押 / 設質 / 持股」相關
  2. 實測幾個候選 endpoint 能不能抓 + 資料格式
  3. 實測 MOPS 股權設質 / 內部人查詢(2330 台積電 當測試)
結果印 log + 存 data/insider_probe_result.json 上傳 artifact。
"""
import json
import sys

try:
    import requests
except Exception:
    print("❌ requests 未安裝")
    sys.exit(0)

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
result = {"twse_openapi_hits": [], "endpoint_tests": [], "mops_tests": []}


def _line(s):
    print(s, flush=True)


def try_get(url, desc):
    rec = {"desc": desc, "url": url, "status": None, "note": ""}
    try:
        r = requests.get(url, timeout=25, headers=UA)
        rec["status"] = r.status_code
        txt = r.text or ""
        _line(f"[{desc}] {url}\n  HTTP {r.status_code}, len={len(txt)}")
        if r.status_code == 200 and txt.strip():
            try:
                j = r.json()
                if isinstance(j, list):
                    keys = list(j[0].keys()) if j else []
                    rec["note"] = f"JSON list {len(j)} 筆; keys={keys}"
                    _line(f"  ✅ JSON list, {len(j)} 筆。第1筆 keys: {keys}")
                    if j:
                        _line(f"  樣本: {json.dumps(j[0], ensure_ascii=False)[:600]}")
                elif isinstance(j, dict):
                    rec["note"] = f"JSON dict keys={list(j.keys())[:20]}"
                    _line(f"  JSON dict keys: {list(j.keys())[:20]}")
            except Exception:
                rec["note"] = f"非JSON,前200字={txt[:200]}"
                _line(f"  ⚠️ 非JSON,前300字: {txt[:300]}")
    except Exception as e:
        rec["note"] = f"連線失敗 {e}"
        _line(f"[{desc}] {url}\n  ❌ {e}")
    _line("")
    return rec


_line("=" * 64)
_line("🔍 董監質押 / 內部人資料源 PROBE")
_line("=" * 64)

# 1. TWSE OpenAPI swagger 全掃描,找董監/質押相關 endpoint
_line("\n### 1. TWSE OpenAPI 全 endpoint 掃描(董/監/質/設質/持股/股權)")
try:
    r = requests.get("https://openapi.twse.com.tw/v1/swagger.json", timeout=25, headers=UA)
    _line(f"  swagger HTTP {r.status_code}, len={len(r.text)}")
    if r.status_code == 200:
        sw = r.json()
        paths = sw.get("paths", {})
        _line(f"  OpenAPI 共 {len(paths)} 個 endpoint")
        kws = ["董", "監", "質", "設質", "持股", "股權", "內部人", "經理人"]
        for p, info in paths.items():
            summ = ""
            for m in info.values():
                if isinstance(m, dict):
                    summ += str(m.get("summary", "")) + str(m.get("description", ""))
            if any(k in (p + summ) for k in kws):
                hit = {"path": p, "summary": summ[:80]}
                result["twse_openapi_hits"].append(hit)
                _line(f"    🎯 {p}  — {summ[:70]}")
        _line(f"  → 命中 {len(result['twse_openapi_hits'])} 個董監/質押相關 endpoint")
except Exception as e:
    _line(f"  ❌ swagger 失敗: {e}")

# 2. 測命中的 endpoint(前 6 個)+ 已知候選
_line("\n### 2. 測候選 endpoint 抓資料 + 格式")
cand = [(h["path"].strip("/").split("/")[-1], h["summary"][:20]) for h in result["twse_openapi_hits"][:6]]
for ep, desc in [("t187ap11_L", "董監持股不足法定成數"), ("t187ap10_L", "董監持股餘額")] + cand:
    result["endpoint_tests"].append(try_get(f"https://openapi.twse.com.tw/v1/opendata/{ep}", desc))

# 3. MOPS 股權設質 / 內部人(2330 測試)
_line("\n### 3. MOPS 股權設質 / 內部人查詢(2330 台積電 測試)")
for url, desc, data in [
    ("https://mopsov.twse.com.tw/mops/web/ajax_t16sn02", "MOPS設質t16sn02",
     {"encodeURIComponent": "1", "step": "1", "firstin": "1", "co_id": "2330", "TYPEK": "sii"}),
    ("https://mops.twse.com.tw/mops/web/ajax_stapap1", "MOPS內部人stapap1",
     {"encodeURIComponent": "1", "step": "1", "firstin": "1", "co_id": "2330", "TYPEK": "sii"}),
]:
    rec = {"desc": desc, "url": url, "status": None, "note": ""}
    try:
        r = requests.post(url, data=data, timeout=25,
                          headers={**UA, "Content-Type": "application/x-www-form-urlencoded"})
        rec["status"] = r.status_code
        rec["note"] = f"len={len(r.text)}"
        _line(f"[{desc}] HTTP {r.status_code}, len={len(r.text)}")
        if r.status_code == 200:
            _line(f"  前400字: {r.text[:400]}")
    except Exception as e:
        rec["note"] = f"連線失敗 {e}"
        _line(f"[{desc}] ❌ {e}")
    result["mops_tests"].append(rec)
    _line("")

_line("=" * 64)
_line("PROBE 完成 — 看上方哪個 endpoint 回 200 + 有董監質押欄位")
_line("=" * 64)

try:
    with open("data/insider_probe_result.json", "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    _line("💾 已存 data/insider_probe_result.json")
except Exception as e:
    _line(f"⚠️ 存檔失敗(不影響 log): {e}")
