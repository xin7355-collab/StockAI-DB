#!/usr/bin/env python3
"""🗓️ 美國三種「排定的日子」的歷史日期(研究用):聯準會開會(排定的,決議日)・CPI 公布日・非農(就業報告)公布日。

為什麼要有這支:使用者 11/17 同意補測「聯準會、CPI、非農」那幾天台股的反應(要存歷史公布日期 = 新資料)。
App 行事曆裡這三種是用規則湊的(CPI = 每月 10~14 日第一個平日、非農 = 第一個星期五)→ 拿來回測會把日子算錯;
歷史日期要拿官方的。⚠️ 沙箱連不到這些網站 → 只能在 GitHub Actions 跑(macro_probe which=us_cal),log 說了算。

來源(只從官方頁面往下一層,⛔ 猜 API 網址;陷阱 #23):
 ① 聯準會 fomccalendars.htm(近幾年)+ fomc_historical_year.htm 列出的每一年那一頁(較早)
 ② 聖路易聯準銀行 ALFRED 的 release 頁(CPI rid=10、Employment Situation rid=50)上真的有的「下載公布日」連結
    (第一輪試過勞工統計局 BLS 的存檔索引:回 403 Access Denied、不給自動程式抓 → ⛔ 再試、⛔ 換 UA)
只讀:⛔ 寫任何分支 / 資料檔;⛔ 用金鑰;⛔ 偽裝瀏覽器(lib_http.Gate 的 UA 寫明是誰);被擋(401 / 403)就停、照實記。
輸出:log 最後一段 `US_CAL|種類|日期,日期…`(每行最多 20 個)→ 人工核對每年次數後存成 research/us_cal.json。

跑法:python3 scripts/us_cal_probe.py [--selftest]
     python3 scripts/us_cal_probe.py --build <log 摘錄.txt> research/us_cal.json <抓檔日> <run>(校驗碼對不上就不寫)
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))

FED_CAL = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm'
FED_HIST = 'https://www.federalreserve.gov/monetarypolicy/fomc_historical_year.htm'
ALFRED = {'cpi': 'https://alfred.stlouisfed.org/release?rid=10', 'nfp': 'https://alfred.stlouisfed.org/release?rid=50'}
FROM_YEAR = 2000

MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
MON3 = {m[:3].lower(): i + 1 for i, m in enumerate(MONTHS)}
MON_RE = '|'.join(MONTHS)


def strip_tags(html):
    t = re.sub(r'<script.*?</script>|<style.*?</style>', ' ', html or '', flags=re.S | re.I)
    t = re.sub(r'<[^>]+>', ' ', t)
    return re.sub(r'\s+', ' ', t.replace('&nbsp;', ' ').replace('&ndash;', '-').replace('–', '-')).strip()


def mon_no(txt):
    """'January' / 'Jan' / 'Apr/May' 的最後一個月份 → 1~12;認不出 → None"""
    parts = [p for p in re.split(r'[/\s]+', (txt or '').strip()) if p]
    for p in reversed(parts):
        k = p[:3].lower()
        if k in MON3:
            return MON3[k]
    return None


def fomc_entry(y, mtxt, dtxt):
    """行事曆那一列 → {'d': 'YYYY-MM-DD'(最後一天 = 決議日), 'raw', 'sched'};日期認不出 → None。
    dtxt 例:'27-28'、'17-18*'、'31-1'(跨月,月份寫 'Jan/Feb')、'3 (unscheduled)'、'22 (notation vote)'"""
    m = mon_no(mtxt)
    head = re.split(r'\(', dtxt or '', maxsplit=1)[0]
    nums = re.findall(r'\d{1,2}', head)
    if not m or not nums:
        return None
    note = (dtxt or '').lower()
    sched = not any(k in note for k in ('unscheduled', 'notation', 'cancel', 'conference call'))
    return {'d': f'{y:04d}-{m:02d}-{int(nums[-1]):02d}', 'raw': f'{mtxt.strip()} {dtxt.strip()}', 'sched': sched}


def parse_fomc_calendar(html):
    """fomccalendars.htm → 每一列一筆(含沒排定的,sched=False)。年份看「2026 FOMC Meetings」那種標題。"""
    out = []
    parts = re.split(r'(\d{4})\s+FOMC Meetings', html or '')
    for k in range(1, len(parts) - 1, 2):
        y, block = int(parts[k]), parts[k + 1]
        for mraw, draw in re.findall(r'fomc-meeting__month[^>]*>(.*?)</div>\s*<div[^>]*fomc-meeting__date[^>]*>(.*?)</div>', block, flags=re.S):
            e = fomc_entry(y, strip_tags(mraw), strip_tags(draw))
            if e:
                out.append(e)
    return out


MON_TOK = r'[A-Z][a-z]{2,8}\.?'
HIST_RE = re.compile(
    r'(?<![A-Za-z])(' + MON_TOK + r'(?:\s*/\s*' + MON_TOK + r')?)\s+(\d{1,2})(?:\s*-\s*(?:(' + MON_TOK + r')\s+)?(\d{1,2}))?\s*,?\s*'
    r'(Meeting|Conference Calls?|\(?[Uu]nscheduled\)?|Notation Votes?)\b')


def parse_fomc_hist(html, year):
    """較早那幾年的頁面:標題長得像「January 29-30 Meeting - 2008」「January 21 Conference Call - 2008」
    「July 31-August 1 Meeting - 2012」;2017 / 2018 的跨月寫法不一樣(第一輪實跑漏了 3 次)→ 月份那一段放寬、交給 mon_no。
    只有寫 Meeting 的算排定的。"""
    out, seen = [], set()
    for m1, d1, m2, d2, kind in HIST_RE.findall(strip_tags(html)):
        mon = mon_no(m2) if m2 else mon_no(m1)
        if not mon or mon_no(m1) is None:
            continue
        day = int(d2 or d1)
        d = f'{int(year):04d}-{mon:02d}-{day:02d}'
        sched = kind == 'Meeting'
        if (d, sched) in seen:
            continue
        seen.add((d, sched))
        out.append({'d': d, 'raw': f'{m1} {d1}' + (f'-{m2 + " " if m2 else ""}{d2}' if d2 else '') + f' {kind}', 'sched': sched})
    return out


def merge_two_day(dates):
    """排定的兩筆剛好差一天(2003-09-15 / 09-16:前一天是另外加開的一場,聲明在後一天)→ 只留後面那天。"""
    ds = sorted(set(dates))
    drop = set()
    for a, b in zip(ds, ds[1:]):
        from datetime import date
        if (date.fromisoformat(b) - date.fromisoformat(a)).days == 1:
            drop.add(a)
    return [d for d in ds if d not in drop]


def parse_dates_txt(text):
    """ALFRED「下載公布日」那個檔 → 裡面所有 YYYY-MM-DD(排序、不重複)。格式第一次看,先寬鬆抓、每年次數由人核對。"""
    return sorted({d for d in re.findall(r'(?<!\d)(\d{4}-\d{2}-\d{2})(?!\d)', text or '') if '1900' <= d[:4] <= '2099'})


def hist_links(html):
    """fomc_historical_year.htm 裡真的有的每年那一頁 → {年: 相對網址}"""
    return {int(y): h for h, y in re.findall(r'href="([^"]*fomchistorical(\d{4})\.htm)"', html or '')}


def interesting_links(html, words=('date', 'download', 'calendar')):
    hs = re.findall(r'href="([^"]+)"', html or '')
    return sorted({h for h in hs if any(w in h.lower() for w in words)})[:40]


def forms_of(html):
    """頁面上每一張表單 → 送去哪、用什麼方法、有哪些欄位(第二輪:下載公布日那個連結回的是一張表單,不是檔案 → 照它真的欄位送,⛔ 猜)"""
    out = []
    for fm in re.findall(r'<form\b[^>]*>.*?</form>', html or '', flags=re.S | re.I):
        head = re.match(r'<form\b([^>]*)>', fm, flags=re.I).group(1)
        attrs = dict(re.findall(r'([\w-]+)\s*=\s*"([^"]*)"', head))
        fields = []
        for tag, a in re.findall(r'<(input|select|textarea|button)\b([^>]*)>', fm, flags=re.I):
            d = dict(re.findall(r'([\w-]+)\s*=\s*"([^"]*)"', a))
            f = {k: d[k] for k in ('name', 'type', 'value', 'id') if k in d}
            f['tag'] = tag.lower()
            if 'checked' in a.lower():
                f['checked'] = True
            fields.append(f)
        opts = [(v, strip_tags(t)[:30]) for v, t in re.findall(r'<option\b[^>]*value="([^"]*)"[^>]*>(.*?)</option>', fm, flags=re.S | re.I)]
        out.append({'action': attrs.get('action'), 'method': attrs.get('method'), 'fields': fields, 'options': opts[:12]})
    return out


def sha_of(dates):
    """日期清單的校驗碼(排序、不重複、逗號接起來的 SHA-256)—— log 裡的日期抄進 repo 之後用它逐字核對"""
    import hashlib
    return hashlib.sha256(','.join(sorted(set(dates))).encode()).hexdigest()


def per_year(dates):
    c = {}
    for d in dates:
        c[d[:4]] = c.get(d[:4], 0) + 1
    return c


def emit(kind, dates):
    ds = sorted(set(dates))
    for i in range(0, len(ds), 20):
        print(f'US_CAL|{kind}|' + ','.join(ds[i:i + 20]))


def regular(dates, mode, drop=()):
    """ALFRED 給的是「這份資料有更新的每一天」→ 同一個月有兩個日期時留哪一個(只看日期的結構決定,⛔ 看股價):
    cpi:兩個相差 7 天以內 → 留後面(前面那個是每年 2 月先公布的季節調整修正,正式的 1 月 CPI 在後面;2005 起每年 2 月都這樣);
        超過 7 天 → 留前面(後面那個是更正,2000-09-28 那種)
    nfp:留前面(就業報告本身;後面那個是更正 / 基準修正,2024-08-21 那種)
    drop:抓檔那一天(ALFRED 把「今天」列成最後一個日期,不是公布日)"""
    from datetime import date
    by = {}
    for d in sorted(set(dates)):
        if d not in drop:
            by.setdefault(d[:7], []).append(d)
    out = []
    for ym in sorted(by):
        a = by[ym]
        if len(a) == 1 or mode != 'cpi':
            out.append(a[0])
        else:
            out.append(a[-1] if (date.fromisoformat(a[-1]) - date.fromisoformat(a[0])).days <= 7 else a[0])
    return out


def build(log_path, out_path, fetched, run):
    """log 裡抄下來的 US_CAL / US_CAL_SHA 幾行 → research/us_cal.json。校驗碼對不上(= 抄錯)→ 不寫檔。"""
    kinds, shas = {}, {}
    for ln in open(log_path, encoding='utf-8'):
        m = re.search(r'US_CAL\|(\w+)\|([\d,\-]+)\s*$', ln)
        if m:
            kinds.setdefault(m.group(1), []).extend(x for x in m.group(2).split(',') if x)
        m = re.search(r'US_CAL_SHA\|(\w+)\|(\d+)\|([0-9a-f]{64})', ln)
        if m:
            shas[m.group(1)] = (int(m.group(2)), m.group(3))
    for k in ('fomc', 'fomc_unsched', 'cpi', 'nfp'):
        ds = kinds.get(k) or []
        if k not in shas or shas[k] != (len(set(ds)), sha_of(ds)):
            print(f'❌ {k}:校驗碼對不上(log {shas.get(k)} vs 抄下來的 {len(set(ds))} 筆 {sha_of(ds)})→ 不寫檔')
            return 1
    cpi, nfp = regular(kinds['cpi'], 'cpi', (fetched,)), regular(kinds['nfp'], 'nfp', (fetched,))
    out = {
        'about': '美國三種排定的日子的歷史日期(研究用;EXP-20261117-01 日子 / 事件補測)。⛔ 手改:重抓用 macro_probe which=us_cal,再跑 us_cal_probe.py --build',
        'fetched': fetched, 'run': run,
        'src': {'fomc': [FED_CAL, FED_HIST], 'cpi': ALFRED['cpi'] + ' → 頁面上的下載公布日文字檔', 'nfp': ALFRED['nfp'] + ' → 頁面上的下載公布日文字檔'},
        'rule': {'fomc': '排定的會議、決議日 = 最後一天;排定的兩筆差一天只留後面(2003-09-15 / 16);臨時會議 / 電話會議 / 書面表決另外放 fomc_unsched',
                 'cpi': '同一個月兩個日期:相差 7 天以內留後面(前面是 2 月的季節調整修正)、超過 7 天留前面(後面是更正);抓檔那天不算',
                 'nfp': '同一個月兩個日期留前面(後面是更正 / 基準修正);抓檔那天不算'},
        'sha': {k: shas[k][1] for k in shas},
        'fomc': sorted(set(kinds['fomc'])), 'fomc_unsched': sorted(set(kinds['fomc_unsched'])),
        'cpi': cpi, 'nfp': nfp, 'cpi_raw': sorted(set(kinds['cpi'])), 'nfp_raw': sorted(set(kinds['nfp'])),
    }
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f'✅ 寫 {out_path}:聯準會 {len(out["fomc"])}・CPI {len(cpi)}(原始 {len(out["cpi_raw"])})・非農 {len(nfp)}(原始 {len(out["nfp_raw"])})')
    print('   CPI 每年:', per_year(cpi))
    print('   非農每年:', per_year(nfp))
    return 0


def selftest():
    fails, n = [], [0]

    def ok(name, cond, got=''):
        n[0] += 1
        print(('✅ ' if cond else '❌ ') + name + ('' if cond else f'  {str(got)[:300]}'))
        if not cond:
            fails.append(name)

    cal = '''<h4><a id="1">2026 FOMC Meetings</a></h4>
      <div class="row fomc-meeting"><div class="fomc-meeting__month col-xs-5"><strong>January</strong></div>
      <div class="fomc-meeting__date col-xs-4">27-28</div></div>
      <div class="row fomc-meeting"><div class="fomc-meeting__month col-xs-5"><strong>March</strong></div>
      <div class="fomc-meeting__date col-xs-4">17-18*</div></div>
      <div class="row fomc-meeting"><div class="fomc-meeting__month"><strong>Apr/May</strong></div>
      <div class="fomc-meeting__date">30-1</div></div>
      <div class="row fomc-meeting"><div class="fomc-meeting__month"><strong>August</strong></div>
      <div class="fomc-meeting__date">22 (notation vote)</div></div>
      <h4><a id="2">2025 FOMC Meetings</a></h4>
      <div class="row fomc-meeting"><div class="fomc-meeting__month"><strong>March</strong></div>
      <div class="fomc-meeting__date">3 (unscheduled)</div></div>
      <div class="row fomc-meeting"><div class="fomc-meeting__month"><strong>Oct/Nov</strong></div>
      <div class="fomc-meeting__date">31-1</div></div>'''
    c = parse_fomc_calendar(cal)
    ok('① 行事曆:決議日 = 最後一天(27-28 → 28)、星號不影響、年份跟著標題走',
       [x['d'] for x in c if x['sched']] == ['2026-01-28', '2026-03-18', '2026-05-01', '2025-11-01'], c)
    ok('①b 跨月(Apr/May 30-1 → 5/1;Oct/Nov 31-1 → 11/1)', c[2]['d'] == '2026-05-01' and c[-1]['d'] == '2025-11-01', c)
    ok('①c 沒排定的 / 書面表決 → sched=False(⛔ 混進排定的)',
       [x['d'] for x in c if not x['sched']] == ['2026-08-22', '2025-03-03'], c)
    ok('①d 決定性對照:取第一天會錯(1/27 ≠ 決議日)', c[0]['d'] != '2026-01-27')
    hist = '''<h5 class="panel-heading">January 21 Conference Call - 2008</h5><h5>January 29-30 Meeting - 2008</h5>
      <p>Statement</p><h5>March 18 Meeting - 2008</h5><h5>October 7 Conference Call - 2008</h5>
      <h5>July 31-August 1 Meeting - 2008</h5><p>Minutes of the meeting released March 11, 2008</p><h5>March 15 (unscheduled) - 2008</h5>'''
    h = parse_fomc_hist(hist, 2008)
    ok('② 較早那幾年:只有寫 Meeting 的算排定的;跨月取後面那個月',
       [x['d'] for x in h if x['sched']] == ['2008-01-30', '2008-03-18', '2008-08-01'], h)
    ok('②b 電話會議 / 沒排定的 → sched=False;內文裡的日期(released March 11)⛔ 算',
       sorted(x['d'] for x in h if not x['sched']) == ['2008-01-21', '2008-03-15', '2008-10-07']
       and not any(x['d'] == '2008-03-11' for x in h), h)
    h2 = parse_fomc_hist('<h5>Jan/Feb 31-1 Meeting - 2017</h5><h5>October/November 31-1 Meeting - 2017</h5><h5>March 14-15 Meeting - 2017</h5>'
                         '<p>Chairman 12 Meeting notes</p><h5>Oct./Nov. 30-1 Meeting - 2017</h5>', 2017)
    ok('②c 跨月的另一種寫法(Jan/Feb 31-1、October/November 31-1、Oct./Nov. 30-1)→ 取後面那個月;不是月份的字(Chairman 12 Meeting)⛔ 算',
       [x['d'] for x in h2] == ['2017-02-01', '2017-11-01', '2017-03-15'], h2)
    ok('②d 排定的兩筆差一天(2003-09-15 / 16)→ 只留後面那天;差兩天以上照留',
       merge_two_day(['2003-09-15', '2003-09-16', '2003-10-28', '2003-10-30']) == ['2003-09-16', '2003-10-28', '2003-10-30'])
    ok('②e 下載檔:抓出所有 YYYY-MM-DD、排序不重複;長數字裡的不算',
       parse_dates_txt('Release Dates\n2020-01-14\n2020-01-14 x\n2019-12-11\n120200-01-145') == ['2019-12-11', '2020-01-14'], parse_dates_txt('2020-01-14'))
    idx = '<a href="/monetarypolicy/fomchistorical2008.htm">2008</a> <a href="/monetarypolicy/fomchistorical1999.htm">1999</a>'
    ok('③ 每年那一頁的連結從索引頁讀(⛔ 自己拼網址)', hist_links(idx) == {2008: '/monetarypolicy/fomchistorical2008.htm', 1999: '/monetarypolicy/fomchistorical1999.htm'})
    fm = forms_of('<form action="/release/downloaddates" method="post"><input type="hidden" name="rid" value="10"><select name="ff"><option value="txt">Text</option>'
                  '<option value="xls">Excel</option></select><input type="radio" name="sort" value="asc" checked><input type="submit" value="Download"></form>')
    ok('④ 表單:送去哪、方法、欄位名稱與預設值、下拉選項(⛔ 猜欄位)',
       len(fm) == 1 and fm[0]['action'] == '/release/downloaddates' and fm[0]['method'] == 'post'
       and {'name': 'rid', 'type': 'hidden', 'value': '10', 'tag': 'input'} in fm[0]['fields'] and ('txt', 'Text') in fm[0]['options']
       and any(f.get('checked') for f in fm[0]['fields']), fm)
    ok('④b 校驗碼:順序 / 重複不影響、改一個字就不同', sha_of(['2020-01-02', '2019-01-01']) == sha_of(['2019-01-01', '2020-01-02', '2020-01-02']) and sha_of(['2020-01-02']) != sha_of(['2020-01-03']) and len(sha_of([])) == 64)
    ok('④c CPI 同一個月兩個日期:差 7 天以內留後面(2024-02-09 / 13 → 13)、超過 7 天留前面(2000-09-15 / 28 → 15);抓檔那天丟掉',
       regular(['2024-01-11', '2024-02-09', '2024-02-13', '2000-09-15', '2000-09-28', '2026-11-10', '2026-11-17'], 'cpi', ('2026-11-17',))
       == ['2000-09-15', '2024-01-11', '2024-02-13', '2026-11-10'])
    ok('④d 非農同一個月兩個日期留前面(2024-08-02 / 21 → 02);決定性對照:用 CPI 那條規則會留錯(2013-05-03 / 06 → 06)',
       regular(['2024-08-02', '2024-08-21', '2013-05-03', '2013-05-06'], 'nfp') == ['2013-05-03', '2024-08-02']
       and regular(['2013-05-03', '2013-05-06'], 'cpi') == ['2013-05-06'])
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        lg, oj = os.path.join(td, 'log.txt'), os.path.join(td, 'o.json')
        body = {'fomc': ['2020-01-29', '2020-04-29'], 'fomc_unsched': ['2020-03-15'], 'cpi': ['2020-01-14', '2020-02-11', '2020-02-13'], 'nfp': ['2020-05-08', '2020-05-11']}
        open(lg, 'w').write(''.join(f'x US_CAL|{k}|{",".join(v)}\n' for k, v in body.items()) + ''.join(f'y US_CAL_SHA|{k}|{len(v)}|{sha_of(v)}\n' for k, v in body.items()))
        r1 = build(lg, oj, '2020-06-01', 'selftest')
        o = json.load(open(oj))
        open(lg, 'w').write(''.join(f'x US_CAL|{k}|{",".join(v)}\n' for k, v in body.items()).replace('2020-04-29', '2020-04-28') + ''.join(f'y US_CAL_SHA|{k}|{len(v)}|{sha_of(v)}\n' for k, v in body.items()))
        os.remove(oj)
        r2 = build(lg, oj, '2020-06-01', 'selftest')
        ok('④e 建檔:校驗碼對得上才寫(CPI 留 02-13、非農留 05-08、原始清單也存);抄錯一個字 → 不寫檔',
           r1 == 0 and o['cpi'] == ['2020-01-14', '2020-02-13'] and o['nfp'] == ['2020-05-08'] and o['cpi_raw'][1] == '2020-02-11' and r2 == 1 and not os.path.exists(oj), o)
    ok('⑤ 每年次數', per_year(['2019-01-11', '2019-02-13', '2020-01-14']) == {'2019': 2, '2020': 1})
    ok('⑥ 月份:全名 / 縮寫 / 兩個月取後面;亂字 → None', mon_no('January') == 1 and mon_no('Jan/Feb') == 2 and mon_no('September') == 9 and mon_no('xyz') is None)
    print(f'\n{"❌ " + str(len(fails)) + " 條失敗" if fails else "✅ US_CAL_SELFTEST_PASS"}({n[0]} 條)')
    return 1 if fails else 0


def main():
    from lib_http import Gate, page_text
    g = Gate(gaps={'www.federalreserve.gov': 2.0, 'alfred.stlouisfed.org': 2.0}, backoff=(2, 4, 8), timeout=40)
    bad = []

    def fetch(url, label):
        res, why = g.get(url, expect='html')
        if res is None:
            host = url.split('/')[2]
            print(f'❌ {label}:{why}  {url}  擋頁/錯誤頁開頭:{(g.blocked_page.get(host) or g.fail_page.get(host) or "")[:160]}')
            return None
        body = res.content.decode('utf-8', errors='replace')
        t = re.search(r'<title[^>]*>(.*?)</title>', body, flags=re.S | re.I)
        print(f'✅ {label}:{len(body):,} 字元  標題「{strip_tags(t.group(1))[:80] if t else "?"}」  {url}')
        return body

    # ① 聯準會
    fomc = []
    cal = fetch(FED_CAL, '聯準會行事曆(近幾年)')
    if cal:
        c = parse_fomc_calendar(cal)
        fomc += c
        print(f'   解析出 {len(c)} 列(排定 {sum(1 for x in c if x["sched"])});年份 {sorted({x["d"][:4] for x in c})}')
        if not c:
            print('   ⚠️ 一列都沒解析到 → 頁面開頭:', strip_tags(cal)[:400])
            print('   ⚠️ 含 fomc-meeting 的片段:', [s[:200] for s in re.findall(r'.{0,60}fomc-meeting.{0,140}', cal)[:4]])
    idx = fetch(FED_HIST, '聯準會較早年份索引')
    if idx:
        links = hist_links(idx)
        print(f'   索引頁列出 {len(links)} 年:{min(links) if links else "-"} ~ {max(links) if links else "-"}')
        if not links:
            print('   ⚠️ 沒找到每年那一頁的連結 → 含 histor 的連結:', interesting_links(idx, ('histor',)))
        have = {x['d'][:4] for x in fomc}
        for y in sorted(k for k in links if k >= FROM_YEAR and str(k) not in have):
            u = links[y] if links[y].startswith('http') else 'https://www.federalreserve.gov' + links[y]
            body = fetch(u, f'聯準會 {y}')
            if not body:
                bad.append(f'聯準會 {y}')
                continue
            h = parse_fomc_hist(body, y)
            fomc += h
            if sum(1 for x in h if x['sched']) != 8:
                print(f'   ⚠️ {y} 排定的不是 8 次({sum(1 for x in h if x["sched"])})→ 全部:{[x["raw"] for x in h]}')
                print('      標題原文:', re.findall(r'[A-Za-z./ ]{0,24}\d{1,2}[^A-Za-z]{0,6}[A-Za-z. ]{0,12}\d{0,2}\s*,?\s*Meeting\s*-\s*\d{4}', strip_tags(body))[:14])
                if not h:
                    print('      頁面文字開頭:', strip_tags(body)[:500])
    sched = merge_two_day([x['d'] for x in fomc if x['sched']])
    print('   2026 / 2027 原文:', [x['raw'] for x in fomc if x['d'][:4] in ('2026', '2027')])
    unsched = sorted({x['d'] for x in fomc if not x['sched']})
    print(f'\n聯準會:排定 {len(sched)} 次、沒排定 / 電話會議 {len(unsched)} 次;每年排定次數:{per_year(sched)}')
    print('   沒排定的:', unsched)

    # ② CPI / 非農:BLS 存檔索引第一輪實跑回 403(Access Denied:不給自動程式抓)→ ⛔ 再試、⛔ 換 UA。
    #    改走 ALFRED release 頁上真的有的「下載公布日」連結(第一輪 log 印出來的 /release/downloaddates?rid=…);頁面上沒有那個連結就不抓
    rel = {}
    for k in ('cpi', 'nfp'):
        rel[k] = []
        a = fetch(ALFRED[k], f'ALFRED release 頁({k})')
        if not a:
            bad.append(f'{k} 公布日')
            continue
        link = next((h for h in interesting_links(a) if 'downloaddates' in h), None)
        if not link:
            print('   ⚠️ 頁面上沒有下載公布日的連結 → 有的連結:', interesting_links(a))
            bad.append(f'{k} 公布日')
            continue
        u = link if link.startswith('http') else 'https://alfred.stlouisfed.org' + link
        res, why = g.get(u, expect='txt')
        if res is None:
            print(f'❌ ALFRED 下載公布日({k}):{why}  {u}')
            bad.append(f'{k} 公布日')
            continue
        page = res.content.decode('utf-8', errors='replace')
        # 第三輪實跑:這一頁是 HTML,上面有兩個真的下載連結(…&ff=txt / …&ff=xlsx)+ 一張留 email 的表單(不需要)→ 抓文字檔那個
        tlink = next((h for h in interesting_links(page, ('ff=txt',))), None)
        if not tlink:
            print('   ⚠️ 下載頁上沒有文字檔連結 → 有的連結:', interesting_links(page, ('download', 'ff=')))
            bad.append(f'{k} 公布日')
            continue
        tu = (tlink if tlink.startswith('http') else 'https://alfred.stlouisfed.org' + tlink).replace('&amp;', '&')
        res, why = g.get(tu, expect='txt')
        if res is None:
            print(f'❌ ALFRED 公布日文字檔({k}):{why}  {tu}')
            bad.append(f'{k} 公布日')
            continue
        raw = res.content
        ctype = (getattr(res, 'headers', {}) or {}).get('Content-Type', '?')
        txt = raw.decode('utf-8', errors='replace')
        if txt.lstrip()[:1] == '<':
            print(f'❌ ALFRED 公布日文字檔({k}):要文字檔卻回 HTML  {tu}  開頭:{strip_tags(txt)[:200]}')
            bad.append(f'{k} 公布日')
            continue
        ds = parse_dates_txt(txt)
        rel[k] = ds
        print(f'✅ ALFRED 公布日文字檔({k}):{len(raw):,} bytes  Content-Type {ctype}  {tu}')
        print('   開頭 400 字:', repr(txt[:400]))
        print(f'   {len(ds)} 個日期 {ds[0] if ds else "-"} ~ {ds[-1] if ds else "-"};{FROM_YEAR} 起每年次數:{per_year([d for d in ds if d[:4] >= str(FROM_YEAR)])}')
        if not ds:
            bad.append(f'{k} 公布日')

    print('\n===US_CAL_BEGIN===')
    emit('fomc', sched)
    emit('fomc_unsched', unsched)
    emit('cpi', [d for d in rel['cpi'] if d[:4] >= str(FROM_YEAR)])
    emit('nfp', [d for d in rel['nfp'] if d[:4] >= str(FROM_YEAR)])
    print('===US_CAL_END===')
    for kind, ds in (('fomc', sched), ('fomc_unsched', unsched), ('cpi', [d for d in rel['cpi'] if d[:4] >= str(FROM_YEAR)]), ('nfp', [d for d in rel['nfp'] if d[:4] >= str(FROM_YEAR)])):
        print(f'US_CAL_SHA|{kind}|{len(set(ds))}|{sha_of(ds)}')
    print(json.dumps({'stats': g.stats, 'open': g.open, 'missing': bad}, ensure_ascii=False))
    # 三種都沒拿到 = 沒驗到 → 紅燈;拿到一部分 → 綠燈、缺的寫在 missing(⛔ 默默當成功)
    return 1 if (not sched and not rel['cpi'] and not rel['nfp']) else 0


if __name__ == '__main__':
    if '--build' in sys.argv:   # --build <log 摘錄> <out.json> <抓檔日 YYYY-MM-DD> <哪一次 run>
        i = sys.argv.index('--build')
        sys.exit(build(*sys.argv[i + 1:i + 5]))
    sys.exit(selftest() if '--selftest' in sys.argv else main())
