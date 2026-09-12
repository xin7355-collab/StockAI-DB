#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🧮 check_vol_baseline.py —— 抓「**基準區間把被判斷的那幾根自己算進去**」這一類 bug(陷阱 #43)。
⛔ 這是**巡邏工具**:exit 0、**不進四驗證**(誤報擋 push 會讓人養成無視它的習慣,
   同 page_sweep / card_inventory / check_lab_coverage)。每一筆都要人工讀原始碼驗真偽。

🚨 本專案已經踩過四次(V76.1.5 / V76.1.6 抓出來的):
  ① `miner.py` 🐲 妖股雷達:爆量基準用「含爆量那 3 根」的 5 日均量 → 第一根爆完就把門檻墊高
     → 全市場 2,719 檔通過 **0 檔**,產物一直是空的、workflow 全綠、零錯誤訊息。
  ② 同一個修法**自己又踩一次**:上游只回 `vols[-3:]`(長度 3),而新基準要 `rv[-8:-3]`
     → `len(rv) >= 8` 恆 False → 基準恆 0 → **修完還是 0 檔**。
  ③ 多空計分卡 P7「跌破 20 日低」:`min(含今日 low)` ≤ 今日收盤 → `pC < low20` **數學上不可能**
     = 死碼(實測少抓 99.75%),一條 weight=3 的**空方**規則整條沒作用。
  ④ 同卡 P5「爆量突破 60 日新高」:`max(含今日 high)` → 實測少抓 67%。

⭐ 判準(單根事件、視窗 N、倍數 m):實際門檻 = m·(N−1)/(N−m),膨脹率 = (N−1)/(N−m)。
   ・m ≥ N      → ❌ **數學上不可能** = 功能安靜地不作用
   ・膨脹 ≥ 10% → ⚠️ 門檻被自己墊高,跟註解/文案寫的數字不符
   ・m == 1.0   → ✅ 完全無害(代數上等價於「跟前 N−1 根比」)→ ⛔ 不報

⛔ 刻意不報的幾類(報了就是誤報,而誤報會淹掉真的):
   ・`* 100` / `* 1000` 這種單位/百分比換算 → 只收 0.05 ≤ m ≤ 20 的倍數
   ・`var > 0` 這種防呆、`lo20 > lo60 * 1.02` 這種**兩個區間互比** → 另一邊必須是「今日的值」
   ・`>=` / `<=` 型(`v >= max(vols[-60:])` = 「今日就是天量」)→ 語意正確
   ・流動性/殭屍量門檻、位階/距高幾%/乖離/停損價 → 含今日是對的語意

有 `--selftest`(注入 4 組:妖股原版 / 切片餵不飽 / 正確排除今日 / m=1.0,
前兩組一定要叫、後兩組一定不能叫)。
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGETS = ['miner.py', 'radar_miner.py', 'screener_miner.py', 'momentum_miner.py',
           'potential_miner.py', 'universal_radar.py', 'concept_miner.py', 'rotation_miner.py',
           'daytrade_data_miner.py', 'etf_miner.py', 'pe_band_miner.py', 'extras_miner.py',
           'backtest.py', 'live_snapshot_miner.py', 'index.html']

SKIP_WORDS = ('殭屍', '流動性', '位階', '距高', '乖離', 'bias', '停損', 'zombie',
              'pos_pct', 'dd_pct', 'drop_from_high', 'percentile', '百分位')
LOOKAHEAD = 14

# 「今日的那個值」的常見變數名 —— B 類要求比較的另一邊是這些才算數
TODAY = {'c', 'pc', 'pC', 'v', 'V', '_v', '_c', 'close', 'price', 'nowPrice', 'lastVol',
         'vCur', 'pV', 'v_lots', 'cur', 'today', 'lastV', 'px', 'nowP', 'last_c'}

PY_AVG = re.compile(r"(\w+)\s*=\s*.*?sum\(\s*[\w\.]+\[-(\d+):\]\s*\)\s*/")
JS_AVG = re.compile(r"(?:const|let|var)\s+(\w+)\s*=\s*.*?\.slice\(\s*(?:-|\w+\s*-\s*)(\d+)\s*\).*?/\s*\d+")
PY_EXT = re.compile(r"(\w+)\s*=\s*(max|min)\(\s*[\w\.]+\[-(\d+):\]\s*\)")
# ⚠️ slice 只吃**單一參數**(`slice(-20)` / `slice(n - 20)`)—— 那才是「含最後一根」;
#    兩個參數(`slice(n-21, n-1)`)是明確區間,多半已經排除今日 → ⛔ 不報。
JS_EXT = re.compile(r"(?:const|let|var)\s+(\w+)\s*=\s*.*?Math\.(max|min)\(\s*\.\.\..*?\.slice\(\s*(?:-\s*\d+|\w+\s*-\s*\d+)\s*\)")


def _mults(text, var):
    """只收「**比較式其中一邊**」的倍數:`x > VAR * m` / `VAR * m < x`。"""
    out = []
    for pat in (r"[<>]=?\s*" + re.escape(var) + r"\s*\*\s*([0-9.]+)",
                re.escape(var) + r"\s*\*\s*([0-9.]+)\s*[<>]"):
        for m in re.finditer(pat, text):
            try:
                x = float(m.group(1))
            except ValueError:
                continue
            if 0.05 <= x <= 20.0:
                out.append(x)
    return out


def _cmp_today(text, var):
    """有沒有拿「今日的那個值」去跟 var 做**嚴格**比較(> / <)。"""
    for m in re.finditer(r"(\w+)\s*[<>](?!=)\s*" + re.escape(var) + r"\b", text):
        if m.group(1) in TODAY:
            return True
    for m in re.finditer(re.escape(var) + r"\s*[<>](?!=)\s*(\w+)", text):
        if m.group(1) in TODAY:
            return True
    return False


def scan_text(text, fname='<mem>'):
    """回 [(line_no, level, msg, line)]。level ∈ {'FATAL','WARN'}。"""
    lines = text.splitlines()
    hits = []
    scan_text.seen = getattr(scan_text, 'seen', 0)
    win = lambda i: '\n'.join(lines[i: i + LOOKAHEAD])

    for i, raw in enumerate(lines):
        line = raw.split('#', 1)[0] if fname.endswith('.py') else raw
        if not line.strip() or any(w in raw for w in SKIP_WORDS):
            continue

        # ── A 類:含今日的「平均」+ 倍數門檻 ──
        m = PY_AVG.search(line) or JS_AVG.search(line)
        if m:
            scan_text.seen += 1
            var, N = m.group(1), int(m.group(2))
            for mult in _mults(win(i), var):
                if mult == 1.0 or N <= 1:
                    continue
                if mult >= N:
                    hits.append((i + 1, 'FATAL',
                                 f"基準 {var} 的 {N} 根視窗含被判斷的那根,倍數 {mult} ≥ N={N} → 數學上不可能成立",
                                 raw.strip()[:120]))
                else:
                    infl = (N - 1) / (N - mult)
                    # ⚠️ m < 1(量縮型)時 infl < 1 = 門檻變**更嚴**,同樣是名實不符 → 取雙向
                    if abs(infl - 1) >= 0.10:
                        hits.append((i + 1, 'WARN',
                                     f"基準 {var} 含今日:寫 {mult}× 實際是 {mult * infl:.2f}×"
                                     f"(門檻被墊高 {(infl - 1) * 100:.0f}%)",
                                     raw.strip()[:120]))
                break

        # ── B 類:含今日的 max/min,又拿今日去做**嚴格**比較 ──
        e = PY_EXT.search(line) or JS_EXT.search(line)
        if e and _cmp_today(win(i), e.group(1)):
            kind = e.group(2)
            hits.append((i + 1, 'FATAL',
                         f"{e.group(1)} 用 {kind}(視窗含今日) 卻拿今日做嚴格比較 → "
                         + ("今日 close < min(含今日 low) 永遠不成立" if kind == 'min'
                            else "只有『今日就是那個極值』才成立,幾乎永遠不會過"),
                         raw.strip()[:120]))

        # ── C 類:切片長度餵不飽下游要用的基準視窗(妖股修法自己踩的那個)──
        #    指紋 =「上游只存 n 根」+「**同一個變數**被 [-m:-k] 取用且配 len(該變數) >= m」且 m > n
        c = re.search(r"['\"](\w+)['\"]\s*:\s*[\w\.]+\[-(\d+):\]", line)
        if c:
            key, span = c.group(1), int(c.group(2))
            alias = set(re.findall(r"(\w+)\s*=\s*[^=\n]*\[['\"]" + key + r"['\"]\]", text))
            alias |= set(re.findall(r"def\s+\w+\(\s*(\w+)\s*\)", text)) if key == '__none__' else set()
            for al in alias:
                mm = re.search(re.escape(al) + r"\[-(\d+):-\d+\]", text)
                if not mm:
                    continue
                need = int(mm.group(1))
                if need > span and re.search(r"len\(\s*" + re.escape(al) + r"\s*\)\s*>=\s*" + str(need) + r"\b", text):
                    hits.append((i + 1, 'FATAL',
                                 f"'{key}' 只存 {span} 根,但 {al}[-{need}:…] 配 len({al}) >= {need} 的守門 "
                                 f"→ 守門恆 False、基準恆 0 = 功能安靜地不作用",
                                 raw.strip()[:120]))
                    break
    return hits


# ═══════════════════════════ selftest ═══════════════════════════
BAD1 = """
vma5 = sum(vols[-5:]) / 5
vol_burst = sum(1 for v in rv[-3:] if v > vma5 * 5)
"""
BAD2 = """
def q(vols):
    return {'recent_vols': vols[-3:]}
def f(ind):
    rv = ind['recent_vols']
    _vbase = (sum(rv[-8:-3]) / 5) if len(rv) >= 8 else 0
"""
GOOD1 = """
const _a5 = kdata.slice(-6, -1).map(r => r.volume || 0);
const _avg5 = _a5.reduce((a, x) => a + x, 0) / 5;
if (_v >= _avg5 * 2) hit = true;
"""
GOOD2 = """
v_avg_5 = sum(vols[-5:]) / 5
vol_expanding = v > v_avg_5 * 1.0
"""
BAD3 = """
const low20 = n >= 20 ? Math.min(...arr.slice(n - 20).map(b => b.low || b.close)) : null;
hit = (low20 != null && pC < low20) || todayChg <= -5;
"""
GOOD3 = """
const low20 = n >= 21 ? Math.min(...arr.slice(n - 21, n - 1).map(b => b.low || b.close)) : null;
hit = (low20 != null && pC < low20) || todayChg <= -5;
"""
CASES = (('BAD1 妖股原版', BAD1, 'x.py', True),
         ('BAD3 跌破20日低(含今日)', BAD3, 'x.html', True),
         ('GOOD3 同一條已排除今日', GOOD3, 'x.html', False),
         ('BAD2 切片餵不飽', BAD2, 'x.py', True),
         ('GOOD1 正確排除今日', GOOD1, 'x.html', False),
         ('GOOD2 m=1.0', GOOD2, 'x.py', False))


def runselftest():
    ok = True
    for nm, txt, fn, want in CASES:
        got = bool(scan_text(txt, fn))
        if got != want:
            ok = False
        print(f"  {'✅' if got == want else '❌'} {nm}: 預期{'報' if want else '不報'} / 實際{'報' if got else '不報'}")
    print('✅ SELFTEST PASS' if ok else '❌ SELFTEST FAIL(這支守門自己壞了,先修它)')
    return 0 if ok else 1


# ⚠️ 已知是同型、但這支**靜態掃描看不到**的(基準藏在 helper / 預先算好的陣列裡)。
#    ⛔ 一定要印出來 —— 否則「0 筆」會被讀成「都沒問題」(空過守門,同 page_sweep 那四道)。
BLIND = [
    ("backtest.py:130/192/203/285/327", "基準來自 _avg_volume_lots(rows, idx) —— 視窗是 rows[idx-N+1:idx+1](含今日)",
     "1.5×→1.71× / 0.6×→0.545× / 0.8×→0.762× / 1.2×→1.26× / 2.0×(N=20)→2.11×"),
    ("index.html:21477/21484", "基準 vma5 來自 worker 預算好的 ind.vma5 陣列(sma(vols,5),含今日)",
     "1.5×→1.71× / 0.6×→0.545×"),
    ("radar_miner.py:1806", "v5 ⊂ v20(兩個視窗重疊,不是「含今日」而是「含那 5 根」)", "1.3×→1.44×"),
    ("miner.py:5753/5758", "基準 vma5 由 _quick_ind 回傳(含今日)", "1.2×→1.26× / 1.1×→1.16×"),
]


def main():
    if '--selftest' in sys.argv:
        print('🧪 check_vol_baseline --selftest')
        sys.exit(runselftest())
    nf = nw = 0
    for name in TARGETS:
        p = ROOT / name
        if not p.exists():
            continue
        for ln, lvl, msg, src in scan_text(p.read_text(encoding='utf-8'), name):
            print(f"{'❌' if lvl == 'FATAL' else '⚠️'} {name}:{ln}  {msg}")
            print(f"     {src}")
            nf, nw = (nf + 1, nw) if lvl == 'FATAL' else (nf, nw + 1)
    print(f"\n📊 ❌ 數學上不可能 {nf} 筆 ・⚠️ 門檻被墊高/變嚴 {nw} 筆"
          f"(共掃到 {getattr(scan_text, 'seen', 0)} 個含今日的視窗基準)")
    if getattr(scan_text, 'seen', 0) < 20:
        print("🚨 空過守門:掃到的基準定義 < 20 個 → 多半是正則失效,⛔ 不可把這次的『0 筆』當成沒問題。")
    print("\n👁️ 已知同型、但這支掃不到的(基準藏在 helper / 預算好的陣列裡,⛔ 不是『沒問題』):")
    for loc, why, eff in BLIND:
        print(f"   ・{loc}\n       {why}\n       實際門檻:{eff}")
    print("\n⛔ 這是巡邏工具,每一筆都要人工讀原始碼驗真偽(約 1/3 是設計取捨)。exit 0。")
    sys.exit(0)


if __name__ == '__main__':
    main()
