"""
通用型情報監聽雷達 (universal_radar.py)
- 監聽多個 RSS Feed
- 關鍵字過濾命中文章
- Groq AI 利多/利空/中立 情緒判讀
- 輸出 data/radar_news.json 供前端 UI 渲染

環境變數（任一即可，新舊相容）：
- GROQ_API_KEYS: 多把 key 逗號分隔（推薦，撞 429 自動切下一把冰 key）
- GROQ_API_KEY:  單把 key（向下相容；缺則全部標記為中立）
"""
import os
import json
import time
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
import feedparser
from pathlib import Path
from datetime import datetime

# ── [Key 輪動] 多把 Groq API key 池（鏡像 api.py 同款邏輯，per-key 冷卻自動復活）──
_groq_env = os.environ.get("GROQ_API_KEYS") or os.environ.get("GROQ_API_KEY", "")
GROQ_API_KEYS = [t.strip() for t in _groq_env.split(",") if t.strip()]
GROQ_API_KEY = GROQ_API_KEYS[0] if GROQ_API_KEYS else ""   # 向下相容（保留變數）
GROQ_URL     = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL   = "llama-3.1-8b-instant"

# 【防禦機制】建立全域連線池與自動退避重試
http_session = requests.Session()
retry_strategy = Retry(
    total=3,
    backoff_factor=1.5,
    status_forcelist=[500, 502, 503, 504]
)
http_session.mount("https://", HTTPAdapter(max_retries=retry_strategy))

# ── [Key 輪動] per-key 冷卻狀態（Actions VM 是一次性容器，run 結束自動回收，不需持久化）──
_groq_key_idx = 0
_groq_key_cooldown = {}   # idx → 解除冷卻 unix_ts


def _groq_active_idx(now: float):
    """從目前 idx 起順時針找第一把未冷卻的 key；全冷卻回 None。"""
    if not GROQ_API_KEYS:
        return None
    n = len(GROQ_API_KEYS)
    for off in range(n):
        i = (_groq_key_idx + off) % n
        if _groq_key_cooldown.get(i, 0) <= now:
            return i
    return None


def _groq_mark_blocked(idx: int, retry_after_sec: int):
    """把第 idx 把 key 標冷卻（header 沒給就用 3600s 保守值，TPD 用罄一小時恢復）。"""
    cd = max(retry_after_sec or 3600, 60)
    _groq_key_cooldown[idx] = time.time() + cd
    print(f"  ⏳ [Groq 輪動] Key #{idx + 1}/{len(GROQ_API_KEYS)} 進入冷卻 {cd}s")


def _groq_advance():
    """順時針推進指標,下次優先試下一把 key。"""
    global _groq_key_idx
    if GROQ_API_KEYS:
        _groq_key_idx = (_groq_key_idx + 1) % len(GROQ_API_KEYS)


def _call_groq_with_rotation(payload: dict, label: str = ""):
    """
    [Key 輪動] Groq 共用呼叫：429 立刻換下一把冰 key 重試（不睡），全冷卻回 None。
    回傳 res 物件（HTTP 200 或非 429 錯誤）或 None（全部 key 撞限額/網路全失敗）。
    """
    if not GROQ_API_KEYS:
        return None
    max_attempts = len(GROQ_API_KEYS) + 1
    for _ in range(max_attempts):
        idx = _groq_active_idx(time.time())
        if idx is None:
            print(f"  🚫 [Groq 輪動] {label or 'call'}：全 {len(GROQ_API_KEYS)} 把 key 均冷卻中，回 None")
            return None
        headers = {
            "Authorization": f"Bearer {GROQ_API_KEYS[idx]}",
            "Content-Type":  "application/json",
        }
        try:
            res = http_session.post(GROQ_URL, json=payload, headers=headers, timeout=20)
            if res.status_code == 429:
                try:
                    retry_after = int(res.headers.get("Retry-After", 0))
                except Exception:
                    retry_after = 0
                _groq_mark_blocked(idx, retry_after)
                _groq_advance()
                continue
            if res.status_code != 200:
                print(f"  ⚠️ Groq HTTP {res.status_code} (key #{idx + 1}): {res.text[:120]}")
            return res
        except Exception as e:
            print(f"  ⚠️ Groq 例外 (key #{idx + 1}): {e}")
            time.sleep(1)
    return None

RSS_SOURCES = {
    "科技新報":         "https://technews.tw/feed/",
    "鉅亨網台股":       "https://www.cnyes.com/rss/cat/tw_stock",
    "MoneyDJ 即時新聞": "https://www.moneydj.com/RSS/RSSNews.aspx",
    "Reddit r/stocks":  "https://www.reddit.com/r/stocks/.rss",
    # ➕ 使用者指定來源(有公開 RSS 才可程式化抓):自由財經 / 聯合新聞網 / 中央社財經
    "自由財經":         "https://news.ltn.com.tw/rss/business.xml",
    "聯合新聞網財經":   "https://udn.com/rssfeed/news/2/6644?ch=news",
    "中央社財經":       "https://feeds.feedburner.com/rsscna/finance",
    # PTT RSSHub 預留（自架 rsshub instance 後解開）
    # "PTT Stock":      "https://rsshub.app/ptt/stock",
}

KEYWORDS = [
    "砍單", "急單", "擴產", "良率", "滿載", "停機",
    "缺貨", "庫存", "出貨", "轉單", "降價",
    "漲停", "跌停", "破底", "新高",
    "處置股", "減資", "增資", "重訊",
]

DATA_DIR       = Path("data")
DATA_DIR.mkdir(exist_ok=True)
OUTPUT_FILE    = DATA_DIR / "radar_news.json"
MAX_PER_SOURCE = 30
SUMMARY_MAXLEN = 300


def analyze_sentiment(title: str, summary: str) -> tuple:
    """呼叫 Groq AI 進行利多/利空判讀，回傳 (sentiment, reason)。
    [Key 輪動] 多把 key 自動切換,全部撞限額才 fallback 為「中立」。"""
    if not GROQ_API_KEYS:
        return ("中立", "未設定 GROQ_API_KEY")

    user_prompt = (
        f"你是一個專業的財經情緒分析系統。請分析以下台股情報，判斷其對個股或供應鏈的影響為【利多】、【利空】或【中立】。\n\n"
        f"標題：{title}\n"
        f"摘要：{summary[:SUMMARY_MAXLEN]}\n\n"
        f"輸出要求：\n"
        f"1. 必須輸出純 JSON 格式，絕對不要包含 Markdown backticks (如 ```json)。\n"
        f"2. 格式範例：{{\"sentiment\": \"利多\", \"reason\": \"此處填寫20字內具體原因\"}}"
    )
    payload = {
        "model":           GROQ_MODEL,
        "messages":        [{"role": "user", "content": user_prompt}],
        "max_tokens":      120,
        "temperature":     0.3,
        "response_format": {"type": "json_object"},
    }

    res = _call_groq_with_rotation(payload, label="analyze_sentiment")
    if res is None:
        return ("中立", "AI 暫時無法分析")
    if res.status_code != 200:
        return ("中立", f"API 錯誤 {res.status_code}")

    try:
        content = res.json()["choices"][0]["message"]["content"].strip()
        parsed  = json.loads(content)
        sentiment = parsed.get("sentiment", "中立")
        if sentiment not in ("利多", "利空", "中立"):
            print(f"  ⚠️ Groq 回傳異常 sentiment={sentiment!r}，已退回中立。原始 content={content[:120]}")
            sentiment = "中立"
        reason = str(parsed.get("reason", "")).strip()[:30] or "AI 未提供說明"
        return (sentiment, reason)
    except Exception as e:
        print(f"  ⚠️ analyze_sentiment 解析例外：{e}")
        return ("中立", "AI 暫時無法分析")


def fetch_feed(source_name: str, url: str) -> list:
    """抓取單一 RSS Feed，回傳命中關鍵字的文章列表"""
    matched = []
    try:
        feed = feedparser.parse(url, request_headers={'User-Agent': 'Mozilla/5.0 universal_radar/1.0'})
        if not feed.entries:
            if feed.bozo:
                print(f"  ⚠️ {source_name} parse 失敗：{feed.bozo_exception}")
            return matched

        for entry in feed.entries[:MAX_PER_SOURCE]:
            title   = entry.get("title", "") or ""
            summary = entry.get("summary", "") or entry.get("description", "") or ""
            combined = title + " " + summary
            hits = [k for k in KEYWORDS if k in combined]
            if not hits:
                continue
            matched.append({
                "source_name":      source_name,
                "title":            title,
                "link":             entry.get("link", ""),
                "published_time":   entry.get("published", "") or entry.get("updated", ""),
                "matched_keywords": hits,
                "_summary":         summary,
            })
        print(f"  📡 {source_name}：總 {len(feed.entries)} 篇，命中 {len(matched)} 篇")
    except Exception as e:
        print(f"  ⚠️ {source_name} 抓取例外：{e}")
    return matched


GLOBAL_NEWS_SOURCES = {
    # Reuters/MarketWatch/CNBC block datacenter IPs (403)
    # Using datacenter-accessible alternatives + Google News 多 query 補科技巨頭
    "BBC Business":   "https://feeds.bbci.co.uk/news/business/rss.xml",
    "Google Finance": "https://news.google.com/rss/search?q=stock+market+economy+finance&hl=en&gl=US&ceid=US:en",
    "Nasdaq News":    "https://www.nasdaq.com/feed/nasdaq-originals/rss.xml",
    # 科技巨頭與政治影響（川普 / 馬斯克 / 黃仁勳 / 庫克 / Lisa Su / 貝佐斯）
    "Trump Market":   "https://news.google.com/rss/search?q=%22Donald+Trump%22+stock+market+tariff&hl=en&gl=US&ceid=US:en",
    "Musk Tesla":     "https://news.google.com/rss/search?q=%22Elon+Musk%22+Tesla+OR+SpaceX&hl=en&gl=US&ceid=US:en",
    "Huang Nvidia":   "https://news.google.com/rss/search?q=%22Jensen+Huang%22+OR+Nvidia+AI+chip&hl=en&gl=US&ceid=US:en",
    "TSMC Apple":     "https://news.google.com/rss/search?q=TSMC+OR+%22Tim+Cook%22+Apple+iPhone&hl=en&gl=US&ceid=US:en",
    "AMD Amazon":     "https://news.google.com/rss/search?q=AMD+OR+%22Jeff+Bezos%22+Amazon&hl=en&gl=US&ceid=US:en",
    # ➕ 使用者指定來源:中央社國際財經(繁中、datacenter 可達)+ NASA 發射公告(衛星題材)
    "中央社國際":     "https://feeds.feedburner.com/rsscna/intworld",
    "NASA 發射":      "https://www.nasa.gov/feed/",
}
GLOBAL_NEWS_FILE = DATA_DIR / "global_news.json"

# 🛰️ 科技巨頭專屬 RSS(餵盤前戰情官報的「川普/黃仁勳/SpaceX/Kuiper」獨立觀測段落)
#    用 Google News RSS:彙整全網即時,GHA IP 可達,無付費限制
TECH_GIANTS_SOURCES = {
    "trump":  "https://news.google.com/rss/search?q=%22Donald+Trump%22+(stocks+OR+tariff+OR+economy)&hl=en&gl=US&ceid=US:en",
    "huang":  "https://news.google.com/rss/search?q=%22Jensen+Huang%22+OR+(NVIDIA+AI+chip)&hl=en&gl=US&ceid=US:en",
    "spacex": "https://news.google.com/rss/search?q=SpaceX+(Starlink+OR+Starship+OR+launch)&hl=en&gl=US&ceid=US:en",
    "kuiper": "https://news.google.com/rss/search?q=Amazon+(%22Project+Kuiper%22+OR+satellite)&hl=en&gl=US&ceid=US:en",
}
TECH_GIANTS_FILE = DATA_DIR / "tech_giants_news.json"

# 對台股有關的 keyword filter：標題或 URL 含至少一個才保留
# 涵蓋科技巨頭 / 公司 / 台股供應鏈相關產業詞 / 宏觀經濟詞
TW_RELATED_KEYWORDS = [
    # 科技巨頭與政治人物
    'trump', 'musk', 'tesla', 'spacex', 'nvidia', 'jensen', 'huang',
    'tsmc', 'taiwan semi', 'apple', 'tim cook', 'iphone', 'ipad',
    'amd', 'lisa su', 'amazon', 'bezos', 'meta', 'zuckerberg',
    'microsoft', 'satya', 'google', 'alphabet', 'sundar', 'openai', 'altman',
    # 台股相關產業
    'semiconductor', 'chip', 'hbm', 'foundry', 'euv', 'gpu', 'cpu',
    'taiwan', 'export', 'supply chain', 'ai',
    # 宏觀（影響台股大盤）
    'tariff', 'tariffs', 'fed', 'interest rate', 'inflation', 'cpi', 'gdp',
    'recession', 'rate cut', 'rate hike',
]


def _is_tw_relevant(title: str, url: str = '') -> bool:
    """判斷新聞是否與台股相關（科技巨頭/供應鏈/宏觀）。任一 keyword 命中即保留"""
    combined = (title + ' ' + url).lower()
    return any(kw in combined for kw in TW_RELATED_KEYWORDS)


def fetch_global_news():
    """抓取全球財經 RSS，用 Groq 批次分析對台股的影響，輸出 data/global_news.json"""
    print("\n📡 全球即時情報採集中...")
    from datetime import timezone, timedelta
    now_utc = datetime.now(timezone.utc)
    cutoff = now_utc - timedelta(hours=48)

    items = []
    skipped_irrelevant = 0
    for source, url in GLOBAL_NEWS_SOURCES.items():
        try:
            feed = feedparser.parse(url, request_headers={'User-Agent': 'Mozilla/5.0 universal_radar/1.0'})
            count = 0
            for entry in feed.entries[:15]:  # 從 10 提高到 15，給 filter 更多挑選空間
                title = (entry.get("title", "") or "").strip()
                link  = entry.get("link", "") or ""
                pub   = entry.get("published", "") or entry.get("updated", "") or ""
                if not title:
                    continue
                # 對台股有關 filter：純美股本地、體育、政治八卦不抓
                if not _is_tw_relevant(title, link):
                    skipped_irrelevant += 1
                    continue
                items.append({"source": source, "title": title, "url": link, "published": pub})
                count += 1
                if count >= 6:  # 每源最多 6 則（5 源 = 上限 30 則）
                    break
            print(f"  {source}: {count} 篇")
        except Exception as e:
            print(f"  ⚠️ {source} 失敗: {e}")

    print(f"  🔍 對台股無關過濾掉 {skipped_irrelevant} 則")
    if not items:
        print("  ⚠️ 無法取得全球新聞")
        return

    # 批次呼叫 Groq 分析每則新聞對台股的影響（控 token 只翻前 15 則）
    # [Key 輪動] 走 _call_groq_with_rotation,撞 429 自動換下一把冰 key
    # 翻譯上限 15→20(新聞源從 8 擴到 10 個,給更多翻譯名額;每則 sleep 2.5s 仍在 30 RPM 內)
    analyzed = []
    for i, item in enumerate(items[:20]):
        impact, level, title_zh = "暫無分析", "neutral", ""
        if GROQ_API_KEYS:
            prompt = (
                f"請將以下新聞標題翻譯成繁體中文（20字以內），並用一句話說明對台股的影響，判斷bullish/bearish/neutral。\n"
                f"標題：{item['title']}\n"
                f"輸出純JSON，格式：{{\"title_zh\":\"繁體中文標題\",\"impact\":\"...\",\"impact_level\":\"bullish|bearish|neutral\"}}"
            )
            payload = {
                "model": GROQ_MODEL,
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 100,
                "temperature": 0.3,
                "response_format": {"type": "json_object"},
            }
            res = _call_groq_with_rotation(payload, label="fetch_global_news")
            if res is not None and res.status_code == 200:
                try:
                    parsed = json.loads(res.json()["choices"][0]["message"]["content"])
                    impact = str(parsed.get("impact", "暫無分析"))[:30]
                    lvl = parsed.get("impact_level", "neutral")
                    level = lvl if lvl in ("bullish", "bearish", "neutral") else "neutral"
                    title_zh = str(parsed.get("title_zh", ""))[:40]
                except Exception as e:
                    print(f"  ⚠️ fetch_global_news 解析例外: {e}")
            time.sleep(2.5)

        analyzed.append({**item, "title_zh": title_zh, "impact": impact, "impact_level": level})
        if (i + 1) % 5 == 0:
            print(f"  進度: {i+1}/{min(len(items), 20)}")

    output = {
        "updated": now_utc.strftime("%Y-%m-%d %H:%M UTC"),
        "items": analyzed,
    }
    GLOBAL_NEWS_FILE.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"✅ 全球新聞已輸出 {len(analyzed)} 篇 → {GLOBAL_NEWS_FILE}")


def fetch_tech_giants_news():
    """🛰️ 科技巨頭專屬 RSS 採集(餵盤前戰情官報「川普/黃仁勳/SpaceX/Kuiper」獨立觀測段)。
    每桶最多 3 則,共 12 則 Groq 翻譯,輸出 data/tech_giants_news.json 給前端 runGlobalMarketAI 讀。
    任一桶失敗不影響其他;Groq 翻譯失敗時 fallback 保留英文標題(前端仍可顯示)。
    """
    print("\n🛰️ 科技巨頭專屬情報採集中...")
    bucket = {"trump": [], "huang": [], "spacex": [], "kuiper": []}
    for key, url in TECH_GIANTS_SOURCES.items():
        try:
            feed = feedparser.parse(url, request_headers={'User-Agent': 'Mozilla/5.0 universal_radar/1.0'})
            for entry in feed.entries[:5]:
                title = (entry.get("title", "") or "").strip()
                link  = entry.get("link", "") or ""
                pub   = entry.get("published", "") or entry.get("updated", "") or ""
                if title:
                    bucket[key].append({"title": title, "url": link, "published": pub})
            print(f"  {key}: {len(bucket[key])} 篇")
        except Exception as e:
            print(f"  ⚠️ {key} 失敗: {e}")

    # Groq 翻譯每桶前 3 則(共最多 12 則,搭配 sleep 2.5s 不撞 30 RPM)
    if GROQ_API_KEYS:
        for key, arr in bucket.items():
            for it in arr[:3]:
                try:
                    payload = {
                        "model": GROQ_MODEL,
                        "messages": [{"role": "user", "content":
                            f"請把以下英文新聞標題翻譯成繁體中文(25 字以內),只輸出 JSON。\n標題:{it['title']}\n格式:{{\"title_zh\":\"...\"}}"}],
                        "max_tokens": 80,
                        "temperature": 0.2,
                        "response_format": {"type": "json_object"},
                    }
                    res = _call_groq_with_rotation(payload, label=f"tech_giants_{key}")
                    if res is not None and res.status_code == 200:
                        parsed = json.loads(res.json()["choices"][0]["message"]["content"])
                        it["title_zh"] = str(parsed.get("title_zh", ""))[:50]
                except Exception as e:
                    print(f"  ⚠️ {key} 翻譯例外: {e}")
                time.sleep(2.5)

    output = {
        "updated": datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC"),
        **bucket,
    }
    TECH_GIANTS_FILE.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    total = sum(len(v) for v in bucket.values())
    print(f"✅ 科技巨頭情報已輸出 {total} 篇 → {TECH_GIANTS_FILE}")


def main():
    print("📡 通用型情報監聽雷達啟動")
    print(f"  關鍵字（{len(KEYWORDS)}）：{', '.join(KEYWORDS)}")
    print(f"  情報源（{len(RSS_SOURCES)}）：{', '.join(RSS_SOURCES.keys())}")
    if GROQ_API_KEYS:
        print(f"  🔑 [Groq 輪動] 載入 {len(GROQ_API_KEYS)} 把 API key（>1 把時 429 自動切換冰 key）")
    else:
        print("  ⚠️ 未設定 GROQ_API_KEY / GROQ_API_KEYS — 全部將標記為中立")

    all_matched = []
    for name, url in RSS_SOURCES.items():
        all_matched.extend(fetch_feed(name, url))
        time.sleep(0.5)

    print(f"\n🎯 共命中 {len(all_matched)} 篇，啟動 AI 情緒判讀")

    results = []
    for i, item in enumerate(all_matched):
        sentiment, reason = analyze_sentiment(item["title"], item["_summary"])
        item.pop("_summary", None)
        item["ai_sentiment"] = sentiment
        item["ai_reason"]    = reason
        results.append(item)
        
        # 【修復】縮排對齊！讓印出進度的邏輯正確包在迴圈內
        if (i + 1) % 5 == 0 or i == len(all_matched) - 1:
            print(f"  進度：{i+1}/{len(all_matched)}（{sentiment} — {reason}）")
        
        # 【致命危機修復】Groq 免費版限制 30 RPM (每分鐘 30 次)。
        # 強制冷卻 2.5 秒 (相當於一分鐘最多 24 次)，確保絕對不會觸發 429 封鎖！
        time.sleep(2.5)

    output = {
        "updated": datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC"),
        "count":   len(results),
        "data":    results,
    }
    OUTPUT_FILE.write_text(
        json.dumps(output, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )
    print(f"\n✅ 已輸出 {len(results)} 篇 → {OUTPUT_FILE}")

    fetch_global_news()
    fetch_tech_giants_news()


if __name__ == "__main__":
    main()
