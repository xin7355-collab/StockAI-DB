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
import re
import traceback
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
import feedparser
from pathlib import Path
from datetime import datetime

# V58.0 — 恢復採礦端 Groq AI(使用者要求:翻譯+判讀都後端做好,前端零額度)。
#         額度帳:每 run 最多 NEWS_AI_CAP(25) 次 8b-instant 小呼叫,3 支 workflow 一天約 200 次
#         ≈ 7 萬 tokens,遠低於免費 TPD(50萬);sleep 2.5s 控 RPM。要關:env SKIP_AI=1。
SKIP_AI = os.environ.get("SKIP_AI", "0") == "1"
NEWS_AI_CAP = int(os.environ.get("NEWS_AI_CAP", "25"))   # 每 run 最多 AI 分析則數(最新優先)

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
    # V14.16:採礦端不跑 AI(節省 TPD 配額)
    if SKIP_AI:
        return None
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
    # ➕ 即時新聞源(2026-06-13 加入,延遲 15-30 分鐘,比上面慢 1-3 小時的源快很多)
    "Yahoo 即時財經":   "https://tw.news.yahoo.com/rss/finance",
    "ETtoday 財經":     "https://feeds.feedburner.com/ettoday/finance",
    "工商時報即時":     "https://ctee.com.tw/feed",
    "Anue 即時頭條":    "https://www.cnyes.com/rss/news/realtimenews",  # 鉅亨「即時」版,比上面綜合版快
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
    """V58.0 一次 Groq 呼叫做完 4 件事(不多花額度):利多/利空 + 20字理由 + 英文標題翻繁中 + 是否台股重點。
    回傳 (sentiment, reason, title_zh, important)。
    [Key 輪動] 多把 key 自動切換,全部撞限額才 fallback 為「中立」。"""
    if SKIP_AI:
        return ("待分析", "", "", True)
    if not GROQ_API_KEYS:
        return ("中立", "未設定 GROQ_API_KEY", "", True)

    user_prompt = (
        f"你是台股情報過濾與判讀系統。分析以下新聞:\n"
        f"標題：{title}\n"
        f"摘要：{summary[:SUMMARY_MAXLEN]}\n\n"
        f"輸出純 JSON(絕對不要 Markdown backticks),欄位:\n"
        f"{{\"sentiment\":\"利多|利空|中立\",\"reason\":\"20字內具體原因(繁體中文)\","
        f"\"title_zh\":\"標題若非繁體中文則翻成繁中(30字內);已是繁中就回空字串\","
        f"\"important\":true}}\n"
        f"important 判斷:對台股個股/供應鏈/半導體/大盤有實質影響=true;"
        f"生活消費、體育娛樂、與台股無關的外國本地新聞、廣告業配=false。"
    )
    payload = {
        "model":           GROQ_MODEL,
        "messages":        [{"role": "user", "content": user_prompt}],
        "max_tokens":      180,
        "temperature":     0.3,
        "response_format": {"type": "json_object"},
    }

    res = _call_groq_with_rotation(payload, label="analyze_sentiment")
    if res is None:
        return ("中立", "AI 暫時無法分析", "", True)
    if res.status_code != 200:
        return ("中立", f"API 錯誤 {res.status_code}", "", True)

    try:
        content = res.json()["choices"][0]["message"]["content"].strip()
        parsed  = json.loads(content)
        sentiment = parsed.get("sentiment", "中立")
        if sentiment not in ("利多", "利空", "中立"):
            print(f"  ⚠️ Groq 回傳異常 sentiment={sentiment!r}，已退回中立。原始 content={content[:120]}")
            sentiment = "中立"
        reason = str(parsed.get("reason", "")).strip()[:30] or "AI 未提供說明"
        title_zh = str(parsed.get("title_zh", "")).strip()[:50]
        important = bool(parsed.get("important", True))
        return (sentiment, reason, title_zh, important)
    except Exception as e:
        print(f"  ⚠️ analyze_sentiment 解析例外：{e}")
        return ("中立", "AI 暫時無法分析", "", True)


def _fetch_rss_with_encoding_fallback(url: str):
    """抓 RSS feed,若 feedparser 直連 parse 失敗(常見:鉅亨網/MoneyDJ 因
    XML 宣告 us-ascii 但實際是 utf-8/windows-1252 → bozo 但 entries 空),
    fallback 用 requests 強制以 utf-8 重新 decode 後再丟給 feedparser。
    """
    feed = feedparser.parse(url, request_headers={'User-Agent': 'Mozilla/5.0 universal_radar/1.0'})
    if feed.entries:
        return feed
    # 🔧 fallback:requests 預拿 bytes,強制 utf-8 decode,再丟回 feedparser
    try:
        import requests as _rq
        resp = _rq.get(url, headers={'User-Agent': 'Mozilla/5.0 universal_radar/1.0'}, timeout=10)
        resp.encoding = 'utf-8'
        feed2 = feedparser.parse(resp.text)
        if feed2.entries:
            return feed2
    except Exception:
        pass
    return feed


def fetch_feed(source_name: str, url: str) -> list:
    """抓取單一 RSS Feed，回傳命中關鍵字的文章列表"""
    matched = []
    try:
        feed = _fetch_rss_with_encoding_fallback(url)
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
            # V58.0 — 記精確時間戳供「最新優先」排序(AI 額度 CAP 先給最新的)
            _pp = entry.get("published_parsed") or entry.get("updated_parsed")
            try:
                import calendar as _cal
                _ts = _cal.timegm(_pp) if _pp else 0
            except Exception:
                _ts = 0
            matched.append({
                "source_name":      source_name,
                "title":            title,
                "link":             entry.get("link", ""),
                "published_time":   entry.get("published", "") or entry.get("updated", ""),
                "matched_keywords": hits,
                "_summary":         summary,
                "_ts":              _ts,
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
    # 🇰🇷🇯🇵 V50.5 使用者要求:韓/日影響台股的重大新聞(三星/SK海力士=記憶體對手;東京威力=半導體設備;軟銀/Nikkei)
    "韓股記憶體":     "https://news.google.com/rss/search?q=Samsung+OR+%22SK+Hynix%22+OR+Korea+(chip+OR+semiconductor+OR+memory+OR+HBM)&hl=en&gl=US&ceid=US:en",
    "日股半導體":     "https://news.google.com/rss/search?q=Japan+(Nikkei+OR+SoftBank+OR+%22Tokyo+Electron%22+OR+Renesas+OR+chip+OR+semiconductor)&hl=en&gl=US&ceid=US:en",
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
    'recession', 'rate cut', 'rate hike', 'stock market', 'stocks', 'shares',
    'markets', 'tech', 'equities', 'wall street', 'nasdaq', 'dow jones',
]

# V27.8 — 生活/娛樂雜訊黑名單:即使誤含關鍵字也直接排除(BBC Business RSS 夾帶 King's tax bill / power banks / after uni 等生活新聞)
TW_NEWS_BLACKLIST = ['royal', "king's", 'queen', 'prince', 'recipe', 'football', 'rugby',
                     'celebrity', 'vape', 'lifestyle', 'after uni', 'wedding', 'weather', 'power bank']

# V27.8 — 關鍵字改「整詞」比對(\b 邊界):修 'ai' 短字當「子字串」誤命中 ag(ai)n / ret(ai)l / cont(ai)n,
#         導致生活新聞(如「back home after uni ... again」)漏進財經情報的 bug。
_TW_KW_RE = re.compile(r'\b(' + '|'.join(re.escape(k) for k in TW_RELATED_KEYWORDS) + r')\b', re.IGNORECASE)


def _is_tw_relevant(title: str, url: str = '') -> bool:
    """判斷新聞是否與台股相關(科技巨頭/供應鏈/宏觀)。先過生活雜訊黑名單,再要求「整詞」命中至少一個關鍵字。"""
    combined = (title + ' ' + url)
    if any(bad in combined.lower() for bad in TW_NEWS_BLACKLIST):
        return False
    return bool(_TW_KW_RE.search(combined))


def fetch_global_news():
    """抓取全球財經 RSS，用 Groq 批次分析對台股的影響，輸出 data/global_news.json"""
    print("\n📡 盤前新聞(美/韓/日)採集中...")
    from datetime import timezone, timedelta
    import calendar
    TPE = timezone(timedelta(hours=8))
    now_utc = datetime.now(timezone.utc)
    now_tpe = now_utc.astimezone(TPE)
    # 🕔 V50.5 盤前新聞窗(台北):end=最近已過的 05:00;start=前一交易日 05:00(end 落週一→往前抓到週五,涵蓋週末)
    _five = now_tpe.replace(hour=5, minute=0, second=0, microsecond=0)
    win_end = _five if now_tpe >= _five else _five - timedelta(days=1)
    _back = 3 if win_end.weekday() == 0 else 1
    win_start = win_end - timedelta(days=_back)
    print(f"  🕔 盤前新聞窗(台北):{win_start:%m/%d %H:%M} → {win_end:%m/%d %H:%M}(截止 05:00)")

    def _in_window(entry):
        pp = entry.get('published_parsed') or entry.get('updated_parsed')
        if not pp:
            return None   # 無時間→不確定,當備援
        try:
            dt = datetime.fromtimestamp(calendar.timegm(pp), TPE)
            return win_start <= dt <= win_end
        except Exception:
            return None

    items = []          # 命中盤前窗內
    fallback = []       # 無精確時間的近期新聞(窗內全空時才用,避免整片空白)
    skipped_irrelevant = 0
    for source, url in GLOBAL_NEWS_SOURCES.items():
        try:
            feed = feedparser.parse(url, request_headers={'User-Agent': 'Mozilla/5.0 universal_radar/1.0'})
            count = 0
            for entry in feed.entries[:20]:
                title = (entry.get("title", "") or "").strip()
                link  = entry.get("link", "") or ""
                pub   = entry.get("published", "") or entry.get("updated", "") or ""
                if not title:
                    continue
                # 對台股有關 filter：純美股本地、體育、政治八卦不抓
                if not _is_tw_relevant(title, link):
                    skipped_irrelevant += 1
                    continue
                rec = {"source": source, "title": title, "url": link, "published": pub}
                w = _in_window(entry)
                if w is True:
                    items.append(rec); count += 1
                elif w is None:
                    fallback.append(rec)
                # w is False → 盤前窗外(太舊/今日盤中),丟棄
                if count >= 6:  # 每源最多 6 則
                    break
            print(f"  {source}: {count} 篇(窗內)")
        except Exception as e:
            print(f"  ⚠️ {source} 失敗: {e}")

    print(f"  🔍 對台股無關過濾掉 {skipped_irrelevant} 則")
    if not items and fallback:
        print(f"  ⚠️ 盤前窗內 0 則(RSS 多無精確時間)→ 用備援 {len(fallback)} 則")
        items = fallback
    if not items:
        print("  ⚠️ 無法取得全球新聞")
        return
    # 新到舊排序,讓翻譯額度優先給最新的
    def _ts(it):
        try: return time.mktime(time.strptime(it.get('published', ''), '%a, %d %b %Y %H:%M:%S %Z'))
        except Exception: return 0
    items.sort(key=_ts, reverse=True)

    # 批次呼叫 Groq 分析每則新聞對台股的影響(控 token)
    # [Key 輪動] 走 _call_groq_with_rotation,撞 429 自動換下一把冰 key
    # 翻譯上限:20→10(2026/06 起,為省 Groq TPD,每則 sleep 2.5s 仍在 30 RPM 內)
    analyzed = []
    for i, item in enumerate(items[:10]):
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

    # 🛡️ V69.8.4 P0-8 鐵律守門:RSS 全被擋/Groq 全冷卻時 analyzed 會是空的,
    #    寫出去等於用空檔蓋掉好資料(還會被 news_express 與 daily_miner 部署擴散)。
    if len(analyzed) < 5:
        print(f"❌ 全球新聞只有 {len(analyzed)} 篇(<5,疑似來源被擋)→ 不寫檔,保留舊檔")
        return
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


# 📰 V69.5.1 個股消息面:股名 → 代號(權值股 + 熱門族群成分股;新聞標題含股名即歸該股)
STOCK_NAME_CODE = {
    '台積電': '2330', '鴻海': '2317', '聯發科': '2454', '台達電': '2308', '廣達': '2382', '緯創': '3231', '緯穎': '6669',
    '技嘉': '2376', '華碩': '2357', '和碩': '4938', '英業達': '2356', '光寶科': '2301', '智邦': '2345', '瑞昱': '2379',
    '聯詠': '3034', '聯電': '2303', '大立光': '3008', '日月光': '3711', '弘塑': '3131', '辛耘': '3583', '萬潤': '6187',
    '世芯': '3661', '創意': '3443', '智原': '3035', '力旺': '3529', '晶心科': '6533', '譜瑞': '4966', '祥碩': '5269',
    '環球晶': '6488', '中美晶': '5483', '合晶': '6182', '台勝科': '3532', '嘉晶': '3016',
    '華邦電': '2344', '南亞科': '2408', '群聯': '8299', '旺宏': '2337', '晶豪科': '3006', '十銓': '4967',
    '欣興': '3037', '南電': '8046', '景碩': '3189', '金像電': '2368', '台郡': '6269',
    '華城': '1519', '士電': '1503', '中興電': '1513', '東元': '1504', '大亞': '1609',
    '奇鋐': '3017', '雙鴻': '3324', '健策': '3653', '超眾': '6230', '高力': '8996',
    '上銀': '2049', '亞德客': '1590', '所羅門': '2359', '廣明': '6188', '崇友': '4506',
    '漢翔': '2634', '雷虎': '8033', '龍德造船': '6753', '寶一': '8222', '公準': '3178', '千附': '8383',
    '昇達科': '3491', '華通': '2313', '啟碁': '6285', '台通': '8011', '台揚': '2314',
    '聯亞': '3081', '聯鈞': '3450', '上詮': '3363', '華星光': '4979', '光環': '3234', '雷笛克': '6869',
    '安碁資訊': '6690', '零壹': '3029', '精誠': '6214', '敦陽科': '2480',
    '富邦金': '2881', '國泰金': '2882', '中信金': '2891', '兆豐金': '2886', '玉山金': '2884', '第一金': '2892',
    '中華電': '2412', '台塑': '1301', '南亞': '1303', '中鋼': '2002',
}
_TONE_MAP = {'利多': 'pos', '利空': 'neg', '中立': 'neu'}


def _fetch_full_name_map():
    """📰 V69.7.2 全市場股名→代號(使用者要求:庫存/自選任何股的新聞都要挖得到,不只 90 檔熱門股)。
    來源:TWSE/TPEx 官方 OpenAPI 公司基本資料(Actions 可達;失敗 fallback 內建熱門股表)。"""
    full = {}
    try:
        import requests as _rq
        srcs = [
            ('上市', 'https://openapi.twse.com.tw/v1/opendata/t187ap03_L'),
            ('上櫃', 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O'),
        ]
        for lbl, url in srcs:
            try:
                r = _rq.get(url, timeout=25, headers={'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json'})
                if r.status_code != 200:
                    print(f"  ⚠️ 股名表 {lbl} HTTP {r.status_code}")
                    continue
                cnt = 0
                for row in r.json():
                    code = str(row.get('公司代號') or row.get('SecuritiesCompanyCode') or '').strip()
                    name = str(row.get('公司簡稱') or row.get('CompanyAbbreviation') or '').strip()
                    if code and name and len(name) >= 2 and code[:1].isdigit() and 4 <= len(code) <= 6:
                        full[name] = code
                        cnt += 1
                print(f"  📇 股名表 {lbl}:+{cnt} 檔")
            except Exception as e:
                print(f"  ⚠️ 股名表 {lbl} 失敗:{type(e).__name__}")
    except Exception:
        pass
    # 官方表 + 內建表(內建為準,含慣用簡稱如「世芯」;官方全市場補冷門股)
    if len(full) >= 500:
        full.update(STOCK_NAME_CODE)
        return full
    print("  ⚠️ 全市場股名表不足 500 檔 → 只用內建熱門股表")
    return dict(STOCK_NAME_CODE)


def build_stock_news(news_items):
    """📰 把已判讀情緒的新聞,依標題含哪些股名 → data/stock_news.json(個股消息面)。
    純加值:失敗只印警告,不影響 radar_news 主輸出。標題同時命中「南亞/南亞科」時只留較長者(去子字串誤判)。"""
    try:
        name_map = _fetch_full_name_map()
        names_by_len = sorted(name_map.keys(), key=len, reverse=True)
        stocks = {}
        for it in news_items:
            title = (it.get('title_zh') or it.get('title') or '').strip()
            if not title:
                continue
            hits = [nm for nm in names_by_len if nm in title]
            # 去子字串:若某股名是另一個已命中股名的子字串(如「南亞」⊂「南亞科」),丟掉短的
            hits = [nm for nm in hits if not any(nm != o and nm in o for o in hits)]
            if not hits:
                continue
            tone = _TONE_MAP.get(it.get('ai_sentiment', '中立'), 'neu')
            rec = {
                'title': title[:60],
                'source': (it.get('source') or '')[:20],
                'url': it.get('url') or it.get('link') or '#',
                'date': (it.get('published') or '')[:16],
                'tone': tone,
                'reason': (it.get('reason') or '')[:40],
            }
            for nm in hits:
                code = name_map[nm]
                bucket = stocks.setdefault(code, [])
                if any(x.get('url') == rec['url'] or x.get('title') == rec['title'] for x in bucket):
                    continue
                bucket.append(rec)
        # 每檔:利多/利空優先、最多 6 則
        out_stocks = {}
        for code, arr in stocks.items():
            arr.sort(key=lambda x: 0 if x['tone'] != 'neu' else 1)
            out_stocks[code] = {'items': arr[:6]}
        # 🛡️ 守門(V71.6.6 重新校準)——**改看「上游有沒有真的壞掉」,不是看輸出檔數**。
        #
        #   為什麼要改(實測抓到的,不是理論):V69.8.4 訂的是「<20 檔就不寫檔」,理由寫
        #   「正常日至少幾十檔有新聞」。但這支拿到的輸入是 **CAP=25 篇**已判讀新聞 ——
        #   25 篇新聞本來就很難命中 20 檔以上的不同股票,門檻跟實際流程對不起來。
        #   後果:`stock_news.json` 從 2026/07/27 卡住整整 3 天,每輪都印「疑似來源被擋」。
        #   2026/07/30 那輪的真實數字是:
        #       📇 股名表 上市 +1092 / 上櫃 +890(名單來源完全正常)
        #       ❌ 個股消息面只有 16 檔(<20)→ 不寫檔,保留舊檔
        #   而「保留」的那份舊檔**只有 7 檔** —— 守門在用更差的資料取代更好的資料。
        #
        #   新規則:名單來源正常(≥500)且有新聞可比對 → 就寫。真正該擋的是:
        #     ① 股名表沒載到(名單來源掛)② 完全沒有新聞(RSS 全掛)③ 一檔都沒命中(比對邏輯壞)
        #   另外加一條「不准退步」:算出來的比現有檔還少 → 保留舊的(這才是原本想防的事)。
        #   ⚠️ 訊息一律印出實際數字 —— 舊訊息只寫「<20」,「一直被擋」跟「今天剛好少」
        #      長得一模一樣,這正是它卡了 3 天沒被發現的原因。
        n_in, n_names, n_out = len(news_items or []), len(name_map), len(out_stocks)
        if n_names < 500:
            print(f"  ❌ 股名表只有 {n_names} 檔(<500,名單來源被擋)→ 不寫檔,保留舊檔")
            return
        if not n_in:
            print("  ❌ 完全沒有新聞可比對(RSS 全掛)→ 不寫檔,保留舊檔")
            return
        if not n_out:
            print(f"  ❌ {n_in} 篇新聞一檔都沒命中(股名比對邏輯異常)→ 不寫檔,保留舊檔")
            return
        # 🛡️ 防「崩塌」,不是防「變少」(V71.6.7 修 V71.6.6 自己種下的棘輪)
        #
        #   V71.6.6 寫成「比現有檔少就不覆蓋」—— 那會變成**只進不退的棘輪**:
        #   檔數哪天衝到 40,之後所有正常的清淡日(15、20 檔)都寫不進去 → 檔案又卡死,
        #   跟原本要修的病一模一樣。**這是我自己種的,不是原本就有的。**
        #
        #   真正要防的是「RSS 掛了一半,只剩 2 檔」這種崩塌,不是日常波動:
        #     ・崩到剩不到 1/3(且舊檔本身有一定規模)→ 才判定異常、保留舊檔
        #     ・**但舊檔太舊(>12 小時)一律覆蓋** —— 一份新鮮的小檔,
        #       永遠好過一份三天前的大檔(這就是 07/27 卡住那次的教訓)。
        COLLAPSE_RATIO, STALE_H = 3, 12
        try:
            _old = json.loads((DATA_DIR / 'stock_news.json').read_text(encoding='utf-8'))
            _n_old = len(_old.get('stocks') or {})
            _age_h = None
            try:
                _age_h = (datetime.utcnow() - datetime.strptime(
                    str(_old.get('updated', ''))[:16], '%Y-%m-%d %H:%M')).total_seconds() / 3600
            except Exception:
                pass
            _stale = (_age_h is None) or (_age_h > STALE_H)
            if _n_old >= 10 and n_out * COLLAPSE_RATIO < _n_old and not _stale:
                print(f"  ⏭️ 算出 {n_out} 檔,不到現有 {_n_old} 檔的 1/{COLLAPSE_RATIO}"
                      f"(舊檔僅 {_age_h:.1f} 小時前)→ 疑似來源崩塌,保留舊檔")
                return
            if _stale and _n_old > n_out:
                print(f"  ♻️ 舊檔已 {'?' if _age_h is None else f'{_age_h:.1f}'} 小時"
                      f"(>{STALE_H}h)→ 即使只有 {n_out} 檔(舊 {_n_old})仍以新鮮為優先,覆蓋")
        except Exception:
            pass
        print(f"  📊 個股消息面守門:新聞 {n_in} 篇 / 股名表 {n_names} 檔 → 命中 {n_out} 檔")
        out = {'updated': datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC'), 'stocks': out_stocks}
        (DATA_DIR / 'stock_news.json').write_text(
            json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        print(f"  ✅ 個股消息面:{len(out_stocks)} 檔有新聞 → data/stock_news.json")
    except Exception as e:
        print(f"  ⚠️ build_stock_news 失敗(不影響 radar_news):{type(e).__name__}: {e}")


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

    # V58.0 — 最新優先 + AI 額度上限(CAP):額度先給最新新聞,舊的不分析也不呈現
    all_matched.sort(key=lambda x: x.get("_ts") or 0, reverse=True)
    todo = all_matched[:NEWS_AI_CAP]
    print(f"\n🎯 共命中 {len(all_matched)} 篇,AI 判讀最新 {len(todo)} 篇(CAP={NEWS_AI_CAP})")

    results = []
    for i, item in enumerate(todo):
        sentiment, reason, title_zh, important = analyze_sentiment(item["title"], item["_summary"])
        item.pop("_summary", None)
        item.pop("_ts", None)
        item["ai_sentiment"] = sentiment
        item["ai_reason"]    = reason
        if title_zh:
            item["title_zh"] = title_zh
        item["important"] = important
        results.append(item)

        if (i + 1) % 5 == 0 or i == len(todo) - 1:
            print(f"  進度：{i+1}/{len(todo)}（{sentiment}{'・重點' if important else ''} — {reason}）")

        # 【致命危機修復】Groq 免費版限制 30 RPM (每分鐘 30 次)。
        # 強制冷卻 2.5 秒 (相當於一分鐘最多 24 次)，確保絕對不會觸發 429 封鎖！
        time.sleep(2.5)

    # V58.0 — 只呈現「台股重點」(使用者要求:其他不用呈現);守門避免空白:
    #   重點 <5 → 補「非中立」;仍 <5 → 補最新的湊 5;最終最多 15 則
    keep = [r for r in results if r.get("important")]
    if len(keep) < 5:
        extra = [r for r in results if r not in keep and r.get("ai_sentiment") in ("利多", "利空")]
        keep += extra[:5 - len(keep)]
    if len(keep) < 5:
        keep += [r for r in results if r not in keep][:5 - len(keep)]
    keep = keep[:15]
    print(f"  🔍 重點過濾:{len(results)} 篇 → 呈現 {len(keep)} 篇")

    output = {
        "updated": datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC"),
        "count":   len(keep),
        "data":    keep,
    }
    OUTPUT_FILE.write_text(
        json.dumps(output, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )
    print(f"\n✅ 已輸出 {len(keep)} 篇 → {OUTPUT_FILE}")

    # 📰 V69.5.1 個股消息面:用「全部已判讀新聞」比對股名 → data/stock_news.json(涵蓋較廣,非只重點 15 篇)
    build_stock_news(results)

    # 🛡️ 兩者輸出各自獨立的 JSON(global_news / tech_giants_news)→ 隔離,
    #    前者失敗不該讓後者也不產出(否則前端盤前戰情少一整段)。
    for _label, _fn in (("盤前全球新聞 fetch_global_news", fetch_global_news),
                        ("科技巨頭情報 fetch_tech_giants_news", fetch_tech_giants_news)):
        try:
            _fn()
        except Exception as e:
            print(f"  ⚠️ 步驟「{_label}」失敗,已跳過:{type(e).__name__}: {e}")
            traceback.print_exc()


if __name__ == "__main__":
    main()
