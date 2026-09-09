"""ETF 探針 ROUND3 — 確認 etfinfo /api/etf/{code} 的持股結構(決定性)。"""
import json
import requests

session = requests.Session()
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
H = {"User-Agent": UA}


def main():
    r = session.get("https://www.etfinfo.tw/api/etf/00981A", headers=H, timeout=20)
    print("api/etf/00981A:", r.status_code, "len", len(r.text))
    try:
        d = r.json()
        print("top-level keys:", list(d.keys()))
        for k, v in d.items():
            if isinstance(v, list) and v and isinstance(v[0], dict):
                print(f"  list '{k}' n={len(v)} keys={list(v[0].keys())} "
                      f"sample={json.dumps(v[0], ensure_ascii=False)[:180]}")
            elif isinstance(v, dict):
                print(f"  dict '{k}' keys={list(v.keys())}")
    except Exception as e:
        print("json parse err:", e)
        print(r.text[:1500])

    # 候選專屬持股端點
    for u in ["/api/etf/00981A/holdings", "/api/etf/00981A/holding",
              "/api/etf/00981A/constituents", "/api/etf/00981A/composition"]:
        rr = session.get("https://www.etfinfo.tw" + u, headers=H, timeout=15)
        print(f"{u} -> {rr.status_code}", (rr.text[:220] if rr.status_code == 200 else ""))

    print("✅ round3 done")


if __name__ == "__main__":
    main()
