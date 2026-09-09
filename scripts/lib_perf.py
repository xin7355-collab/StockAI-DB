#!/usr/bin/env python3
"""📊 回測績效報表模組 —— `generate_performance_report(trades_df, equity_curve)`

⭐ **零新依賴**:只用 pandas + numpy(沙箱實測 pandas 3.0.5 / numpy 2.4.6 已內建)。
⛔ **刻意不裝 vectorbt / backtrader** —— 本站已經有一支跑得動全市場的回測引擎
   (`scripts/portfolio_backtest.mjs`,已測 120 種變體),再裝一個等於同一件事有兩份真相。
   照評估紀錄⑦ 的原則:先問「我需要的是它的**哪一個函式**」,而不是「要不要裝它」。
   這裡需要的只有「績效統計」那一塊 → 自己寫 200 行,而且看得到每一個公式。
⛔ **刻意不用 plotly** —— 本站的圖表在 App 裡是 ECharts;這支輸出**自足的 HTML**
   (跟 App 同一套視覺語言),⛔ 不引入第二套繪圖庫。

🚨 **四個一定要跟著數字一起講出來的限制**(⛔ 拿掉就會被誤讀):
  ① **夏普比率的無風險利率設 0**,而且是「日報酬年化(×√252)」—— ⛔ 不可跟別人算的直接比。
  ② **CAGR 在短窗口會誇大**(半年 +20% 年化成 +44%)→ 一律同時輸出窗口月數。
  ③ **勝率要配樣本數**:n < 10 一律標「不能當結論」(同 App 的 `_wrEnough`)。
  ④ **基準不是 0 也不是 50%** —— 台股中位數個股本來就跑輸市值加權指數
     (本站實測基準勝率 34.6~36.4%)→ 有 benchmark 就一定要印出來對照。

用法:
    from lib_perf import generate_performance_report
    rep = generate_performance_report(trades_df, equity_curve, bench_curve=..., out_html='x.html')
自測:python3 scripts/lib_perf.py --selftest
"""
from __future__ import annotations

import json
import math

import numpy as np
import pandas as pd

TRADING_DAYS = 252
WR_ENOUGH = 10          # 本站鐵則:樣本 < 10 筆不下結論


# ── 內部小工具 ────────────────────────────────────────────────────────────
def _to_series(equity_curve) -> pd.Series:
    """把 equity_curve 正規化成「DatetimeIndex → 權益」的 Series。
    ⛔ 允許三種輸入(DataFrame / Series / list of (date, value)),但**一律轉成同一種**,
       免得下游有兩套讀法(同名不同義的溫床)。"""
    if isinstance(equity_curve, pd.DataFrame):
        col = 'equity' if 'equity' in equity_curve.columns else equity_curve.columns[-1]
        idx = equity_curve['Date'] if 'Date' in equity_curve.columns else equity_curve.index
        s = pd.Series(equity_curve[col].to_numpy(), index=pd.to_datetime(idx))
    elif isinstance(equity_curve, pd.Series):
        s = pd.Series(equity_curve.to_numpy(), index=pd.to_datetime(equity_curve.index))
    else:
        arr = list(equity_curve)
        s = pd.Series([v for _, v in arr], index=pd.to_datetime([d for d, _ in arr]))
    return s[~s.index.duplicated(keep='last')].sort_index().astype(float)


def _pick(df: pd.DataFrame, *names):
    """欄位名容錯:使用者的規格是 `Foreign_Buy`,本站的產物是 `foreign_net` → 兩種都吃。"""
    low = {str(c).lower(): c for c in df.columns}
    for n in names:
        if n in df.columns:
            return df[n]
        if n.lower() in low:
            return df[low[n.lower()]]
    return None


def max_consecutive_losses(pnl) -> int:
    """最大**連續**虧損筆數(⚠️ 是連續,不是總虧損筆數)。"""
    best = cur = 0
    for x in pnl:
        cur = cur + 1 if x < 0 else 0
        best = max(best, cur)
    return best


def drawdown_series(eq: pd.Series) -> pd.Series:
    """每一天「從歷史最高點算起縮水幾 %」(負值)。⭐ App 的文案一律叫它「中途最多賠」。"""
    return (eq / eq.cummax() - 1.0) * 100.0


def monthly_return_matrix(eq: pd.Series) -> pd.DataFrame:
    """每月報酬率矩陣(年 × 月,%)。
    ⛔ 用**月底權益的變化**算,⛔ 不是把當月每筆交易損益加起來 ——
       後者在有複利/同時多檔部位時會對不起來(同「快照檔不可沿時間軸加總」那條)。"""
    if eq.empty:
        return pd.DataFrame()
    m = eq.resample('ME').last()
    # 第一個月要用**期初**權益當基準,⛔ 不可讓它憑空變成 0%
    base = pd.concat([pd.Series([eq.iloc[0]], index=[m.index[0] - pd.offsets.MonthEnd(1)]), m])
    ret = (base.pct_change().dropna() * 100.0)
    out = pd.DataFrame({'y': ret.index.year, 'm': ret.index.month, 'r': ret.to_numpy()})
    return out.pivot(index='y', columns='m', values='r').rename_axis(index='年', columns='月')


# ── 主函式 ────────────────────────────────────────────────────────────────
def generate_performance_report(trades_df, equity_curve, bench_curve=None,
                                initial_capital=None, out_html=None, title='策略績效'):
    """回傳 dict(核心數據 / 風險數據 / 交易統計 / 月報酬矩陣),並可輸出自足的 HTML 圖。

    trades_df 需要的欄位(大小寫皆可,括號內是替代名):
      pnl(profit / 損益)= 每筆**淨**損益金額;⚠️ 手續費與稅必須**已經扣掉**
      ret_pct(報酬率)  = 每筆報酬率 %(沒有的話用 pnl / 進場金額推)
      hold_days(持有天數) ・ entry_date / exit_date(可選,只影響平均持有天數)
    """
    eq = _to_series(equity_curve)
    t = pd.DataFrame(trades_df).copy() if trades_df is not None else pd.DataFrame()

    # ── 交易層級
    pnl = _pick(t, 'pnl', 'profit', 'net_pnl', '損益')
    pnl = pd.to_numeric(pnl, errors='coerce').dropna() if pnl is not None else pd.Series(dtype=float)
    ret = _pick(t, 'ret_pct', 'return_pct', 'ret', '報酬率')
    ret = pd.to_numeric(ret, errors='coerce').dropna() if ret is not None else pd.Series(dtype=float)
    hold = _pick(t, 'hold_days', 'days', '持有天數')
    hold = pd.to_numeric(hold, errors='coerce').dropna() if hold is not None else pd.Series(dtype=float)

    n = int(len(pnl))
    wins, losses = pnl[pnl > 0], pnl[pnl < 0]
    win_rate = len(wins) / n * 100 if n else float('nan')
    avg_win, avg_loss = (wins.mean() if len(wins) else 0.0), (abs(losses.mean()) if len(losses) else 0.0)
    pl_ratio = (avg_win / avg_loss) if avg_loss > 0 else float('inf') if avg_win > 0 else float('nan')
    gross_p, gross_l = float(wins.sum()), float(abs(losses.sum()))
    profit_factor = (gross_p / gross_l) if gross_l > 0 else float('inf') if gross_p > 0 else float('nan')
    # 期望值:每做一筆平均賺多少「錢」;另給 % 版本(有 ret_pct 才算得出來)
    expectancy = float(pnl.mean()) if n else float('nan')
    expectancy_pct = float(ret.mean()) if len(ret) else float('nan')

    # ── 權益層級
    init = float(initial_capital if initial_capital is not None else (eq.iloc[0] if len(eq) else np.nan))
    final = float(eq.iloc[-1]) if len(eq) else float('nan')
    total_ret = (final / init - 1) * 100 if init else float('nan')
    days = (eq.index[-1] - eq.index[0]).days if len(eq) > 1 else 0
    years = days / 365.25 if days else 0.0
    months = round(days / 30.44, 1) if days else 0.0
    cagr = ((final / init) ** (1 / years) - 1) * 100 if (years > 0 and init > 0 and final > 0) else float('nan')

    dd = drawdown_series(eq)
    mdd = float(dd.min()) if len(dd) else float('nan')
    daily = eq.pct_change().dropna()
    sharpe = (float(daily.mean()) / float(daily.std(ddof=1)) * math.sqrt(TRADING_DAYS)
              if len(daily) > 1 and daily.std(ddof=1) > 0 else float('nan'))

    bench = None
    if bench_curve is not None:
        b = _to_series(bench_curve).reindex(eq.index).ffill().dropna()
        if len(b) > 1:
            bench = (float(b.iloc[-1]) / float(b.iloc[0]) - 1) * 100

    rep = {
        '核心數據': {
            '總報酬率%': round(total_ret, 2), '年化報酬率CAGR%': round(cagr, 2),
            '勝率%': round(win_rate, 2), '盈虧比': round(pl_ratio, 2),
            '獲利因子': round(profit_factor, 2),
            '期望值_每筆元': round(expectancy, 2), '期望值_每筆%': round(expectancy_pct, 3),
        },
        '風險數據': {'最大回撤%': round(mdd, 2), '夏普比率': round(sharpe, 2)},
        '交易統計': {
            '總交易筆數': n, '平均持有天數': round(float(hold.mean()), 1) if len(hold) else None,
            '最大連續虧損筆數': max_consecutive_losses(pnl.tolist()),
            '毛獲利': round(gross_p, 0), '毛虧損': round(gross_l, 0),
        },
        '窗口': {'起': str(eq.index[0].date()) if len(eq) else None,
                 '訖': str(eq.index[-1].date()) if len(eq) else None, '月數': months},
        '對照': {'買進持有基準%': round(bench, 2) if bench is not None else None,
                 '贏基準pp': round(total_ret - bench, 2) if bench is not None else None},
        # 🚨 這四句一定要跟著數字一起出現,⛔ 不可只回傳數字
        '限制': [
            '夏普比率的無風險利率設 0,用日報酬 ×√252 年化 → ⛔ 不可跟別人算的直接比。',
            f'CAGR 在短窗口會誇大:這次窗口只有 {months} 個月。' if months < 36 else
            f'窗口 {months} 個月。',
            ('樣本只有 %d 筆(< %d)→ ⛔ 勝率不能當結論。' % (n, WR_ENOUGH)) if n < WR_ENOUGH else
            ('樣本 %d 筆。' % n),
            '報酬是否已扣手續費/證交稅/滑價,取決於 trades_df 的 pnl 怎麼算 —— ⛔ 這支不會替你扣。',
        ],
        'monthly_matrix': monthly_return_matrix(eq),
    }
    if out_html:
        _write_html(out_html, title, eq, dd, rep, bench_curve)
    return rep


def _write_html(path, title, eq, dd, rep, bench_curve=None):
    """自足的 HTML(資產曲線 + 回撤區域 + 月報酬熱力圖),⛔ 不依賴 plotly。
    ⚠️ 沿用 App 的深色語彙與**台股慣例:紅漲綠跌**(⛔ 不可反過來)。"""
    idx = [str(d.date()) for d in eq.index]
    b = None
    if bench_curve is not None:
        bs = _to_series(bench_curve).reindex(eq.index).ffill()
        if bs.notna().any():
            b = (bs / bs.dropna().iloc[0] * float(eq.iloc[0])).round(2).tolist()
    mm = rep['monthly_matrix']
    cells = []
    if not mm.empty:
        for y in mm.index:
            for m in mm.columns:
                v = mm.loc[y, m]
                if pd.notna(v):
                    cells.append([int(m) - 1, int(list(mm.index).index(y)), round(float(v), 2)])
    lim = [l for l in rep['限制']]
    kpi = {**rep['核心數據'], **rep['風險數據'], **rep['交易統計']}
    html = f"""<!doctype html><meta charset=utf-8><title>{title}</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/echarts/5.5.0/echarts.min.js"></script>
<style>body{{background:#0d1117;color:#e6edf3;font:14px/1.6 system-ui,-apple-system,"Noto Sans TC",sans-serif;margin:0;padding:16px}}
h1{{font-size:18px;margin:0 0 4px}}.sub{{color:#8b949e;font-size:12px;margin-bottom:14px}}
.kpi{{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-bottom:16px}}
.c{{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:10px}}
.c b{{display:block;font-size:10px;color:#8b949e;font-weight:400}}.c span{{font-size:19px;font-weight:800;font-family:ui-monospace,monospace}}
.up{{color:#f85149}}.dn{{color:#3fb950}}.warn{{background:#161b22;border-left:4px solid #d29922;padding:10px;border-radius:0 6px 6px 0;font-size:12px;color:#c9d1d9;margin-bottom:16px}}
.warn li{{margin:2px 0}}#eq,#ddc,#hm{{height:300px;background:#161b22;border:1px solid #30363d;border-radius:8px;margin-bottom:14px}}#hm{{height:260px}}</style>
<h1>{title}</h1><div class=sub>{rep['窗口']['起']} ~ {rep['窗口']['訖']} ・{rep['窗口']['月數']} 個月</div>
<div class=kpi>{''.join(f'<div class=c><b>{k}</b><span class="{"up" if isinstance(v,(int,float)) and v==v and v>0 and ("報酬" in k or "期望" in k or "獲利" in k) else "dn" if isinstance(v,(int,float)) and v==v and v<0 else ""}">{v}</span></div>' for k, v in kpi.items() if v is not None)}</div>
<div class=warn><b>⚠️ 讀這些數字之前必須知道</b><ul>{''.join(f'<li>{x}</li>' for x in lim)}</ul></div>
<div id=eq></div><div id=ddc></div><div id=hm></div>
<script>
const D={json.dumps(idx)},E={json.dumps(eq.round(2).tolist())},DD={json.dumps(dd.round(2).tolist())},B={json.dumps(b)};
const base={{backgroundColor:'transparent',textStyle:{{color:'#8b949e'}},grid:{{left:60,right:18,top:38,bottom:34}},
 xAxis:{{type:'category',data:D,axisLine:{{lineStyle:{{color:'#30363d'}}}}}},tooltip:{{trigger:'axis'}}}};
echarts.init(document.getElementById('eq')).setOption({{...base,title:{{text:'📈 資產累積曲線',textStyle:{{color:'#e6edf3',fontSize:13}}}},
 legend:{{data:['策略','買進持有'],textStyle:{{color:'#8b949e'}},right:10}},
 yAxis:{{type:'value',scale:true,splitLine:{{lineStyle:{{color:'#21262d'}}}}}},
 series:[{{name:'策略',type:'line',data:E,showSymbol:false,lineStyle:{{color:'#58a6ff',width:2}}}}]
   .concat(B?[{{name:'買進持有',type:'line',data:B,showSymbol:false,lineStyle:{{color:'#8b949e',width:1,type:'dashed'}}}}]:[])}});
echarts.init(document.getElementById('ddc')).setOption({{...base,title:{{text:'📉 回撤(中途從最高點賠多少 %)',textStyle:{{color:'#e6edf3',fontSize:13}}}},
 yAxis:{{type:'value',max:0,splitLine:{{lineStyle:{{color:'#21262d'}}}}}},
 series:[{{type:'line',data:DD,showSymbol:false,areaStyle:{{color:'rgba(63,185,80,.25)'}},lineStyle:{{color:'#3fb950',width:1}}}}]}});
const HM={json.dumps(cells)},HY={json.dumps([str(y) for y in (list(mm.index) if not mm.empty else [])])};
if(HM.length)echarts.init(document.getElementById('hm')).setOption({{backgroundColor:'transparent',
 title:{{text:'🗓️ 每月報酬率(%)',textStyle:{{color:'#e6edf3',fontSize:13}}}},tooltip:{{}},grid:{{left:52,right:18,top:38,bottom:30}},
 xAxis:{{type:'category',data:['1','2','3','4','5','6','7','8','9','10','11','12'],axisLabel:{{color:'#8b949e'}}}},
 yAxis:{{type:'category',data:HY,axisLabel:{{color:'#8b949e'}}}},
 visualMap:{{min:-12,max:12,calculable:true,orient:'horizontal',left:'center',bottom:0,textStyle:{{color:'#8b949e'}},
  inRange:{{color:['#3fb950','#161b22','#f85149']}}}},
 series:[{{type:'heatmap',data:HM,label:{{show:true,color:'#e6edf3',fontSize:10}}}}]}});
</script>"""
    with open(path, 'w', encoding='utf-8') as f:
        f.write(html)


# ── 自測:用**手算得出唯一答案**的資料釘住每一個公式 ──────────────────────
def _selftest():
    fails = []

    def ok(name, cond, extra=''):
        print(('✅ ' if cond else '❌ ') + name + ('' if cond else f'  {extra}'))
        if not cond:
            fails.append(name)

    # 權益:100 → 110 → 99 → 121(最大回撤 = 99/110-1 = −10%)
    idx = pd.to_datetime(['2024-01-31', '2024-02-29', '2024-03-31', '2024-04-30'])
    eq = pd.Series([100.0, 110.0, 99.0, 121.0], index=idx)
    trades = pd.DataFrame({'pnl': [10, -11, 22, -3, -4], 'ret_pct': [10, -10, 20, -3, -4],
                           'hold_days': [5, 3, 7, 2, 4]})
    r = generate_performance_report(trades, eq, initial_capital=100.0)
    c, k, s = r['核心數據'], r['風險數據'], r['交易統計']
    ok('① 總報酬率 = 121/100 − 1 = +21%', abs(c['總報酬率%'] - 21.0) < 1e-6, c['總報酬率%'])
    ok('② 勝率 = 2/5 = 40%', abs(c['勝率%'] - 40.0) < 1e-6, c['勝率%'])
    ok('③ 盈虧比 = 平均賺16 / 平均賠6 = 2.67', abs(c['盈虧比'] - 16 / 6) < 0.01, c['盈虧比'])
    ok('④ 獲利因子 = 32 / 18 = 1.78', abs(c['獲利因子'] - 32 / 18) < 0.01, c['獲利因子'])
    ok('⑤ 期望值 = 14/5 = +2.8 元', abs(c['期望值_每筆元'] - 2.8) < 1e-6, c['期望值_每筆元'])
    ok('⑥ 最大回撤 = 99/110 − 1 = −10%', abs(k['最大回撤%'] + 10.0) < 1e-6, k['最大回撤%'])
    ok('⑦ 最大**連續**虧損 = 2 筆(⛔ 不是總虧損 3 筆)', s['最大連續虧損筆數'] == 2, s['最大連續虧損筆數'])
    ok('⑧ 平均持有天數 = 21/5 = 4.2', abs(s['平均持有天數'] - 4.2) < 1e-6, s['平均持有天數'])
    # CAGR:90 天 → 0.2464 年;1.21^(1/0.2464) − 1
    yrs = (idx[-1] - idx[0]).days / 365.25
    ok('⑨ CAGR 用實際天數年化', abs(c['年化報酬率CAGR%'] - ((1.21 ** (1 / yrs) - 1) * 100)) < 0.01, c['年化報酬率CAGR%'])
    mm = r['monthly_matrix']
    ok('⑩ 月報酬矩陣第一個月用期初當基準(⛔ 不可憑空變 0%)',
       not mm.empty and abs(float(mm.loc[2024, 1]) - 0.0) < 1e-6 and abs(float(mm.loc[2024, 2]) - 10.0) < 1e-6,
       mm.to_dict() if not mm.empty else 'empty')
    ok('⑪ 3 月 = 99/110 − 1 = −10%', abs(float(mm.loc[2024, 3]) + 10.0) < 1e-6)
    # 🚨 限制那四句必須跟著出現
    lim = ' '.join(r['限制'])
    ok('⑫ 一定要講出「夏普的無風險利率設 0」', '無風險利率設 0' in lim, lim)
    ok('⑬ 窗口 < 36 個月要講「CAGR 會誇大」', 'CAGR 在短窗口會誇大' in lim, lim)
    ok('⑭ 樣本 < 10 筆要講「勝率不能當結論」', '不能當結論' in lim, lim)
    ok('⑮ 要講「這支不會替你扣成本」', '不會替你扣' in lim, lim)
    # 樣本足夠時語氣要換掉(⛔ 不可永遠都在道歉)
    big = pd.DataFrame({'pnl': [1, -1] * 8, 'ret_pct': [1, -1] * 8, 'hold_days': [3] * 16})
    ok('⑯ 樣本 ≥10 筆時就不再說「不能當結論」',
       '不能當結論' not in ' '.join(generate_performance_report(big, eq, initial_capital=100.0)['限制']))
    # 欄位名容錯:使用者規格的大寫欄名也要吃
    ok('⑰ 欄位名容錯(Foreign_Buy 這種大寫寫法)',
       _pick(pd.DataFrame({'Foreign_Buy': [1]}), 'foreign_net', 'Foreign_Buy') is not None)
    # 對照組
    bench = pd.Series([100.0, 100.0, 100.0, 110.0], index=idx)
    r2 = generate_performance_report(trades, eq, bench_curve=bench, initial_capital=100.0)
    ok('⑱ 有基準時要算「贏基準幾 pp」', abs(r2['對照']['贏基準pp'] - 11.0) < 1e-6, r2['對照'])
    print()
    print('❌ LIB_PERF_FAIL: ' + str(fails) if fails else '✅ LIB_PERF_PASS(全部通過)')
    return 1 if fails else 0


if __name__ == '__main__':
    import sys
    sys.exit(_selftest() if '--selftest' in sys.argv else print(__doc__) or 0)
