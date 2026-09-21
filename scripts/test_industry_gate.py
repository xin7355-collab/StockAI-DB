#!/usr/bin/env python3
"""🏭 產業對照表 / 股名離線表 / 公司縣市 —— ⛔ 不可再被「TWSE 基本面回空」一起擋掉(陷阱 #44)

⭐ 釘的是**用意**,不是行號:
  ⓐ `fetch_industry_map()` / `build_stock_names()` / company_geo ⛔ 不可包在 `if twse_fund:` 裡;
     只有 `aggregate_industry_pe()` 可以(它真的需要那份本益比)。
  ⓑ 上櫃要走**實測會通的那個網址**(`mopsfin_t187ap03_O`),舊的 twse 那條只能當備援。
  ⓒ FinMind 備援要把中文產業名**反查回代碼**,而且用 `screener_miner.IND`(⛔ 不另抄一份 → 陷阱 #17)。
  ⓓ JSON 解不開時要把 **body 印出來**(陷阱 #23:回 200 + 網頁,只印例外訊息看起來像網路壞了)。

📊 為什麼寫這支(實跑證據,daily_miner #576 chips job log 逐字):
   ⏭️ TWSE 基本面回空,跳過產業 PE 聚合(YoY/毛利已獨立補入既有快取)
   → 2026-09-12/13/14 連三輪,而那個閘門底下還掛著 industry_map / stock_names / company_geo。
   而上櫃那支從 08-31 到 09-11 **6 輪全部** `Expecting value: line 1 column 1`(= 回 200 但不是 JSON)。
"""
import ast
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))   # ⓔ 要 import screener_miner(⛔ 不在測試裡複製一份產業表)
SRC = (ROOT / 'miner.py').read_text(encoding='utf-8')
# ⚠️ 原始碼斷言一律先剝掉 `#` 註解 —— 本 repo 被自己的註解救活斷言已經三次
NOCOM = re.sub(r'(?m)#[^\n]*', '', SRC)
# ⚠️ 斷言一律**只比 fetch_industry_map 那一段** —— 整檔比會被別處的同名字串救活:
#   實測注入「拿掉 FinMind 備援」時,`TaiwanStockInfo` 因為 `TaiwanStockInfoWithWarrantSummary`
#   在檔案別處出現而照樣綠(本 repo 第五次踩到「斷言被別處的同樣字串救活」)。
SEG = NOCOM[NOCOM.find('def fetch_industry_map'):NOCOM.find('def build_stock_names')]
fails = []


def ck(cond, msg):
    print(('✅ ' if cond else '❌ ') + msg)
    if not cond:
        fails.append(msg)


tree = ast.parse(SRC)

# ── 建 parent 連結,才問得出「這個呼叫被哪些 if 包著」 ──────────────
parent = {}
for node in ast.walk(tree):
    for child in ast.iter_child_nodes(node):
        parent[child] = node


def gated_by_twse_fund(call_node):
    """這個呼叫是不是被 `if twse_fund:` 的**成立分支**包著"""
    cur = call_node
    while cur in parent:
        p = parent[cur]
        if isinstance(p, ast.If) and isinstance(p.test, ast.Name) and p.test.id == 'twse_fund' \
                and any(cur is s or cur in _descend(s) for s in p.body):
            return True
        cur = p
    return False


def _descend(node):
    out = set()
    for n in ast.walk(node):
        out.add(n)
    return out


calls = {}
for node in ast.walk(tree):
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
        calls.setdefault(node.func.id, []).append(node)

FREE = ['fetch_industry_map', 'build_stock_names']
NEED = 'aggregate_industry_pe'
for name in FREE:
    ns = calls.get(name, [])
    ck(len(ns) >= 1, f'ⓐ0 找不到 {name}() 的呼叫 → 這一條不算數(切片或函式改名)')
    for n in ns:
        ck(not gated_by_twse_fund(n),
           f'ⓐ {name}() 又被包回 `if twse_fund:` 裡了 —— 一支不相干的 API 回空就會讓它整批不更新(陷阱 #44)')

ns = calls.get(NEED, [])
ck(len(ns) >= 1, f'ⓐ2-0 找不到 {NEED}() 的呼叫 → 這一條不算數')
ck(all(gated_by_twse_fund(n) for n in ns),
   f'ⓐ2 {NEED}() 沒有被 `if twse_fund:` 包住 —— 它**真的**需要那份本益比,沒有就別算(空過守門)')

# ── ⓑ 上櫃的門牌 ────────────────────────────────────────────────
ck('mopsfin_t187ap03_O' in SEG,
   'ⓑ 上櫃沒有走 `mopsfin_t187ap03_O`(repo 裡另外四支在用、而且 2026-09-09 實測拿得到 1,984 檔的那個)')
m = re.search(r"\('TPEX 上櫃',\s*\[(.*?)\]\)", SEG, re.S)
ck(bool(m), 'ⓑ0 找不到上櫃的來源清單 → 這一條不算數')
if m:
    urls = re.findall(r"'([^']+)'", m.group(1))
    ck(len(urls) >= 2, f'ⓑ2 上櫃只有 {len(urls)} 個來源 —— www.tpex.org.tw 對 runner 會間歇 SSLError,⛔ 不可只靠一條腿')
    ck(urls and 'mopsfin' in urls[0], f'ⓑ3 上櫃的**第一順位**不是那個實測會通的網址:{urls[:1]}')

# ── ⓒ FinMind 備援:中文產業名要反查回代碼,而且⛔ 不另抄一份對照表 ──
ck("dataset=TaiwanStockInfo'" in SEG, 'ⓒ 上櫃沒有 FinMind 備援 —— 兩個官方網址都不通時那一格就永遠空著')
ck('from screener_miner import IND' in SEG,
   'ⓒ2 產業代碼對照表沒有走 screener_miner.IND → 抄第二份就會有兩種格式(陷阱 #17)')
ck("'01': '水泥'" not in SRC, 'ⓒ3 miner.py 裡自己抄了一份產業代碼表 → ⛔ 單一真相')

# ── ⓓ 回 200 但不是 JSON 時要把 body 印出來(陷阱 #23)──────────
seg = SEG
ck(len(seg) > 800, 'ⓓ0 切不到 fetch_industry_map → 這一條不算數')
ck('r.text' in seg, 'ⓓ JSON 解不開時沒有把 body 印出來 → 「網址錯」跟「被擋」永遠分不出來(陷阱 #23)')
ck('sorted(data[0].keys())' in seg,
   'ⓓ2 回了資料卻一列都認不出來時沒有印**實際欄名** → 下一個人又要猜一輪')

# ── ⓔ V76.4.1 FinMind 的中文產業名要**真的**查得到代碼 ─────────────
#   🚨 實跑 #577:備援接上了,但「回 4,321 列 → 只補進 327 檔、1,635 檔對不到代碼」——
#      真因是兩邊寫法不同(FinMind「半導體**業**」vs IND「半導體」)。
#   ⭐ 這一條**執行 miner.py 裡那一段真的程式碼**(⛔ 不在測試裡複製一份等價的正規化邏輯 ——
#      那樣量到的是那份複製品,不是產品;陷阱 #40 第六例)。
_i = SRC.find('from screener_miner import IND as _IND_NAMES')
_j = SRC.find('jj = fm_request', _i) if _i > 0 else -1
ck(_i > 0 and _j > _i, 'ⓔ0 切不到 FinMind 反查那一段 → 這一條不算數(空過守門)')
if _i > 0 and _j > _i:
    _seg = '\n'.join(l[12:] if l.startswith(' ' * 12) else l for l in SRC[_i:_j].split('\n'))
    _ns = {}
    try:
        exec(_seg, _ns)
    except Exception as e:
        ck(False, f'ⓔ0b 那一段跑不起來:{type(e).__name__}: {e}')
        _ns = {}
    n2c, nrm = _ns.get('_name2code'), _ns.get('_nrm')
    ck(bool(n2c) and callable(nrm), 'ⓔ0c 那一段沒有產生 _name2code / _nrm → 這一條不算數')
    if n2c and callable(nrm):
        # FinMind 實際會回的全名(#577 log 印出來的 8 種 + 官方 33 類)
        REAL = ['生技醫療業', '半導體業', '電子零組件業', '光電業', '電子工業', '電腦及週邊設備業', '通信網路業',
                '水泥工業', '食品工業', '塑膠工業', '紡織纖維', '電機機械', '電器電纜', '化學工業', '玻璃陶瓷',
                '造紙工業', '鋼鐵工業', '橡膠工業', '汽車工業', '建材營造', '航運業', '觀光事業', '金融保險',
                '貿易百貨', '油電燃氣業', '電子通路業', '資訊服務業', '其他電子業', '其他', '綜合',
                '文化創意業', '農業科技', '電子商務', '綠能環保', '數位雲端', '運動休閒', '居家生活']
        bad = [n for n in REAL if not (n2c.get(n) or n2c.get(nrm(n)))]
        ck(not bad, f'ⓔ FinMind 的這幾種產業名查不到代碼 → 那幾檔的產業別會是空的:{bad[:8]}')
        # ⚠️ ETF 這種**本來就沒有產業別**的,⛔ 不可查到東西(查到 = 硬塞)
        ck(not (n2c.get('ETF') or n2c.get(nrm('ETF'))), 'ⓔ2 「ETF」竟然對到一個產業代碼 → ⛔ 不可硬塞')
# 🚨 ⓔ 只驗「對照表查得到」,查不到「那一行有沒有用它」——
#   注入把查詢那行退回 `{v:k for…}.get(nm)`(= 字串直接比)時 ⓔ 照樣綠,因為對照表本身沒被動到。
#   ⭐ 所以要再釘**查詢那一行**。⚠️ 先剝掉 `#` 註解(本 repo 被自己的註解救活斷言已經五次)。
SEG_NC = re.sub(r'#[^\n]*', '', SEG)
mlk = re.search(r'(?m)^\s*code\s*=\s*([^\n]+)', SEG_NC)
ck(bool(mlk), 'ⓔ4a 找不到查代碼那一行 → 這一條不算數')
if mlk:
    lk = mlk.group(1)
    ck('_name2code' in lk and '_nrm(' in lk,
       f'ⓔ4 查代碼那一行沒有同時用 _name2code 與 _nrm() → 「半導體業」查不到「半導體」:{lk[:90]}')
    ck('_IND_NAMES.items()' not in lk,
       'ⓔ4b 查代碼那一行又自己重建了一次原始對照表 → 等於繞過正規化(注入退回這個寫法就會走到這裡)')
# ⭐ 而且「對不到」的計數要把 ETF 那種排掉,否則真的漏接會被淹在 1,600 檔裡
mskip = re.search(r"elif\s+nm\s+in\s*\(([^)]*)\)", SEG_NC)
ck(bool(mskip) and 'ETF' in mskip.group(1),
   'ⓔ3 沒有把「本來就沒有產業別」(ETF 等)跟「真的對不到代碼」分開數 → 下次漏接會被淹掉')
ck('skip_ok' in SEG_NC, 'ⓔ3b 沒有 skip_ok 計數 → log 上分不出「本來就沒有」跟「真的漏接」')

# ── ⓕ V77.4.4 景氣循環旗標:值域必須是**代碼**,而且實跑要真的有產業被標成 True ──
#   🚨 V74.6.8 起 `CYCLICAL_INDUSTRIES` 放的是中文名('航運業'),而 industry_map 存的是代碼('15')
#      → `ind in CYCLICAL_INDUSTRIES` 對 33 個產業**全部 False**,前端「循環股 PE 要反著讀」的警語
#      從上線到 V77.4.3 一次都沒亮過(`cyclical_probe.mjs:13` 記過沒修)。全綠、零訊息 = 陷阱 #37 型。
#   ⭐ 兩層釘:①靜態 —— 每個元素都要是 `screener_miner.IND` 的 key(注入一個中文名要紅)
#            ②行為 —— 用**真實** industry_map + fundamentals_cache 實跑 `aggregate_industry_pe`,
#              至少 3 個產業要 `is_cyclical=True`(⛔ 只驗 ① 的話,改比對那一行退回中文名照樣綠)
try:
    import json as _json
    import screener_miner as _sm
    _mi = {}
    _cyc_src = re.search(r'(?ms)^CYCLICAL_INDUSTRIES\s*=\s*(\{.*?\})', NOCOM)
    ck(bool(_cyc_src), 'ⓕ0 找不到 CYCLICAL_INDUSTRIES → 這一條不算數')
    if _cyc_src:
        _cyc = eval(_cyc_src.group(1), {})
        ck(isinstance(_cyc, (set, frozenset)) and len(_cyc) >= 5, f'ⓕ0b CYCLICAL_INDUSTRIES 形狀不對:{type(_cyc).__name__} / {len(_cyc)}')
        _bad = sorted(x for x in _cyc if x not in _sm.IND)
        ck(not _bad, f'ⓕ 這幾個不是 screener_miner.IND 的**代碼**(industry_map 存的是代碼,寫中文名永遠比不到):{_bad}')
    _fc_p, _im_p = ROOT / 'data' / 'fundamentals_cache.json', ROOT / 'data' / 'industry_map.json'
    if _fc_p.exists() and _im_p.exists():
        _fc = {k: v for k, v in _json.load(open(_fc_p, encoding='utf-8')).items() if not str(k).startswith('__')}
        _im = _json.load(open(_im_p, encoding='utf-8'))
        _codes = {str(v) for v in _im.values() if v}
        # ⚠️ 正式產物裡有 '91'(存託憑證)這種 IND 沒收的代碼 → 判「多數是代碼」不判「全部」
        _hit = sum(1 for c in _codes if c in _sm.IND)
        ck(_codes and _hit >= len(_codes) * 0.9,
           f'ⓕ2-0 industry_map.json 的值大多不是 IND 代碼(測資形狀跟正式產物不同,陷阱 #40):{sorted(_codes)[:5]}')
        import importlib
        _miner = importlib.import_module('miner')
        _inds = _miner.aggregate_industry_pe(_fc, _im) or {}   # 回的就是 {代碼: {...}}(寫檔時才包一層 industries)
        _true = sorted(k for k, v in _inds.items() if v.get('is_cyclical'))
        ck(len(_inds) >= 10, f'ⓕ2-1 aggregate_industry_pe 只算出 {len(_inds)} 個產業 → 空過守門(fundamentals_cache 太薄?)')
        ck(len(_true) >= 3, f'ⓕ2 實跑 aggregate_industry_pe 只有 {len(_true)} 個產業 is_cyclical=True(要 ≥3;全 False = 旗標又沒作用了):{_true}')
        ck(not _true or all(t in _sm.IND for t in _true), f'ⓕ3 被標成循環的鍵不是代碼:{_true[:5]}')
    else:
        ck(False, 'ⓕ2-0b 本地沒有 data/fundamentals_cache.json / industry_map.json → 先跑 bash scripts/fetch_testdata.sh(⛔ 不改測試蓋掉真因)')
except SystemExit:
    raise
except Exception as _e:
    ck(False, f'ⓕ 這一段跑不起來:{type(_e).__name__}: {_e}')

print()
if fails:
    print(f'❌ INDUSTRY_GATE_FAIL:{len(fails)} 條')
    sys.exit(1)
print('✅ INDUSTRY_GATE_PASS')
