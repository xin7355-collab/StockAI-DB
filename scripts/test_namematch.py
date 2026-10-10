#!/usr/bin/env python3
"""🏷️ V79.0.7 新聞股名誤配守門(universal_radar._title_hits / index.html _nameInTitle)

① 真資料重放:origin/data 的 news_hist 每一則標題重新比對 → 已知誤配全部擋掉、已知正確的一個都不少
② 決定性對照:清單清空 → 一則都擋不掉(證明擋掉的是清單擋的,不是別的路徑)
③ 不過度擋:擋掉的 ≤ 15%
④ 跨檔:index.html 的 _NAME_GUARD 跟 universal_radar 的 _NAME_FP / _NAME_NEED 一字不差,而且 JS 行為一致
⑤ AI 指令當標題(_clean_title_zh):原標題是中文 → 不用 AI 版;回來像指令 → 丟掉
⑥ build_stock_news 真的走 _title_hits(⛔ 不可留舊的裸比對)
"""
import json, os, re, subprocess, sys, tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, ROOT)
import universal_radar as U  # noqa: E402

fails = 0


def ok(name, cond, extra=''):
    global fails
    print(('✅ ' if cond else '❌ ') + name + ('' if cond else '  ' + str(extra)[:300]))
    if not cond:
        fails += 1


def git_json(path):
    try:
        out = subprocess.run(['git', '-C', ROOT, 'show', f'origin/data:{path}'], capture_output=True, timeout=60)
        if out.returncode == 0 and out.stdout:
            return json.loads(out.stdout.decode('utf-8'))
    except Exception:
        pass
    return None


hist = git_json('data/news_hist.json')
names = git_json('data/stock_names.json')
if not hist or not names:
    print('❌ 讀不到 origin/data 的 news_hist.json / stock_names.json → ⛔ 不可假裝測過(先 git fetch origin data)')
    sys.exit(1)

nm = {}
for k, v in (names.get('names') or names).items():
    n = v[0] if isinstance(v, list) else v
    if n and len(n) >= 2:
        nm[n] = k
nm.update(U.STOCK_NAME_CODE)
byl = sorted(nm, key=len, reverse=True)


def raw_hits(t):
    h = [n for n in byl if n in t]
    return [x for x in h if not any(x != o and x in o for o in h)]


def replay(fn):
    tot, dropped, kept = 0, [], []
    for day, m in hist['days'].items():
        for sym, its in m.items():
            for it in its:
                t = it[0]
                if sym not in {nm[x] for x in raw_hits(t)}:
                    continue
                tot += 1
                (kept if sym in {nm[x] for x in fn(t)} else dropped).append((sym, t))
    return tot, dropped, kept


tot, dropped, kept = replay(lambda t: U._title_hits(t, byl))
ds = {(s, t) for s, t in dropped}
ks = {(s, t) for s, t in kept}
print(f'📊 news_hist {len(hist["days"])} 天・{tot} 則有股名命中 → 守門擋掉 {len(dropped)} 則')

MUST_DROP = [('5007', '三星2奈米'), ('1536', '和大盤'), ('1303', '東南亞'), ('4129', '聯合國'), ('2393', '億光年'),
             ('4743', '房地合一'), ('2603', '李長榮'), ('4923', '海力士')]
MUST_KEEP = [('5347', '世界先進'), ('1303', '南亞︰台塑'), ('2371', '大同8月營收'), ('2603', '長榮海運'),
             ('1303', '南亞攜華城'), ('3711', '日月光投控'), ('2867', '三商壽')]


def has(S, sym, frag):
    return any(s == sym and frag in t for s, t in S)


for sym, frag in MUST_DROP:
    present = has(ds, sym, frag) or has(ks, sym, frag)
    ok(f'① 擋掉 {sym}「{frag}」', present and has(ds, sym, frag) and not has(ks, sym, frag),
       '真資料裡沒有這一則' if not present else '沒擋掉')
for sym, frag in MUST_KEEP:
    present = has(ds, sym, frag) or has(ks, sym, frag)
    ok(f'① 留著 {sym}「{frag}」', present and has(ks, sym, frag) and not has(ds, sym, frag),
       '真資料裡沒有這一則' if not present else '被誤擋')
ok('③ 不過度擋(≤15%)', 0 < len(dropped) <= tot * 0.15, f'{len(dropped)}/{tot}')

# ② 決定性對照
_fp, _need = U._NAME_FP, U._NAME_NEED
U._NAME_FP, U._NAME_NEED = [], {}
_, d0, _ = replay(lambda t: U._title_hits(t, byl))
U._NAME_FP, U._NAME_NEED = _fp, _need
ok('② 清單清空 → 一則都擋不掉(決定性對照)', len(d0) == 0 and len(dropped) > 0, f'清空後還擋 {len(d0)}')

# ④ 跨檔
html = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()
i0 = html.find('_NAME_GUARD: {')
i1 = html.find('_newsDupTxt(it) {', i0)
ok('④ 總覽「近期有事件」走 _nameInTitle(⛔ 不可留裸的 includes(nm))',
   'evs.find(e => this._nameInTitle(nm, e.title || e.event))' in html and "String(e.title || e.event || '').includes(nm)" not in html)
ok('④ index.html 有 _NAME_GUARD 與 _nameInTitle', i0 > 0 and i1 > i0 and '_nameInTitle(nm, title)' in html[i0:i1])
js_obj = '({\n' + re.sub(r'(^|\n)\s*//[^\n]*', '\n', html[i0:i1]) + '\n})'
probe = [t for _, t in dropped[:40]] + [t for _, t in kept[:40]]
cases = []
for t in probe:
    for n in raw_hits(t):
        cases.append([n, t])
script = f'''const A = {js_obj};
const cases = {json.dumps(cases, ensure_ascii=False)};
console.log(JSON.stringify({{fp: A._NAME_GUARD.fp, need: A._NAME_GUARD.need,
  r: cases.map(([n, t]) => A._nameInTitle(n, t))}}));'''
with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False, encoding='utf-8') as f:
    f.write(script)
    jsf = f.name
try:
    res = subprocess.run(['node', jsf], capture_output=True, timeout=60)
    J = json.loads(res.stdout.decode('utf-8')) if res.returncode == 0 else None
finally:
    os.unlink(jsf)
ok('④ JS 抄本能跑', J is not None, res.stderr.decode('utf-8')[:300] if J is None else '')
if J:
    ok('④ fp 清單一字不差', J['fp'] == U._NAME_FP, set(J['fp']) ^ set(U._NAME_FP))
    ok('④ need 規則一字不差', J['need'] == U._NAME_NEED, set(J['need'].items()) ^ set(U._NAME_NEED.items()))

    def py_in(n, t):
        m = t
        for w in U._NAME_FP:
            m = m.replace(w, '□' * len(w))
        return n in m and (n not in U._NAME_NEED or bool(re.search(U._NAME_NEED[n], t)))
    diff = [c for c, r in zip(cases, J['r']) if r != py_in(*c)]
    ok(f'④ JS 行為 == Python({len(cases)} 個真標題)', len(cases) > 20 and not diff, diff[:3])

# ⑤ AI 把指令當標題
C = U._clean_title_zh
ok('⑤ 英文標題 → 用 AI 翻譯', C('Samsung HBM4 price triples', '三星 HBM4 價格漲逾 3 倍') == '三星 HBM4 價格漲逾 3 倍')
ok('⑤ 中文標題 → ⛔ 不用 AI 的版本', C('台股晚報:緯創營收創新高', '台股晚報：緯創與英業達營收增長，台股市整體市場情緒分析') == '')
ok('⑤ 英文標題但回指令 → 丟掉', C('TSMC capex plan', '標題為繁體中文時,如果內容涉及台股則為true') == '')
ok('⑤ 空的 → 空', C('NVIDIA earnings', '') == '')
src = open(os.path.join(ROOT, 'universal_radar.py'), encoding='utf-8').read()
ok('⑤ 呼叫端有接(analyze_sentiment 回來先過 _clean_title_zh)', re.search(r'title_zh\s*=\s*_clean_title_zh\(', src) is not None)

# ⑥ build_stock_news 走 _title_hits
b0 = src.find('def build_stock_news')
b1 = src.find('\ndef ', b0 + 10)
body = re.sub(r'#[^\n]*', '', src[b0:b1])
ok('⑥ build_stock_news 用 _title_hits', '_title_hits(title' in body)
ok('⑥ ⛔ 沒有留舊的裸比對', 'nm in title]' not in body)

print(f'\n❌ {fails} 條失敗' if fails else '\n✅ test_namematch 全過')
sys.exit(1 if fails else 0)
