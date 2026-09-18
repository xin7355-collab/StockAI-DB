#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🎤 test_confcall.py —— 法說會採礦 `confcall_miner.py` 的解析 / 窗口 / 守門 / macro_miner 接線

⭐ 測資**逐字**抄自 Actions 探針 run #35294467879(finmind_gap_probe which=confcall,2026-09-18)
   印出的「原始列 dump」——⛔ 不憑印象編(陷阱 #40:測資跟程式一起錯,12 條全綠照樣寫錯資料)。
   六列:上市 東泥1110 / 卜蜂1215 / 愛之味1217;上櫃 漢來美食1268 / 大車隊2640 / 全心投控2718。

⛔ 注入驗證(每一條都要能叫得出來):
   ① parse_rows 把 12 欄改成只認前 6 欄 → ③④⑤ 紅
   ② 拿掉「每市場各自 try」→ ⑨ 紅
   ③ 拿掉空過守門 → ⑧ 紅
   ④ to_macro_events 的文字拿掉代號 → ⑦ 紅
   ⑤ macro_miner.fetch_earnings_calls 改回打 t187ap02 → ⑩ 紅
"""
import json
import re
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import confcall_miner as C   # noqa: E402

fails = 0


def ok(name, cond, extra=''):
    global fails
    print(f"{'✅' if cond else '❌'} {name}{'' if cond else '  ' + str(extra)}")
    if not cond:
        fails += 1


# ── 逐字測資(探針 dump;⛔ 一個字元都別改)────────────────────────────────
SII = r"""<table><tr class='odd'><th>公司代號</th><th>公司名稱</th><th>召開法人說明會日期</th><th>召開法人說明會時間</th><th>召開法人說明會地點</th><th>法人說明會擇要訊息</th><th>法人說明會簡報內容</th><th>公司網站是否提供法人說明會相關資訊</th><th>影音連結資訊</th><th>其他應敘明事項</th><th>歷年法人說明會</th></tr>
<tr class='even' data-type='body' >
<td style='text-align:left !important;'>1110</td><td>東泥</td>
<td align='center'>115/09/15</td>
<td align='center'>16:00</td>
<td style='text-align:left !important;'>線上法說會</td>
<td style='text-align:left !important;'>本公司受邀參加元大證券舉辦之線上法說會，報告本公司營運狀況。</td>
<td style='text-align:left !important;'><a href='#' onclick='document.fm_fileDownload.fileName.value="111020260914M001.pdf";document.fm_fileDownload.submit();'><font color='blue'><u>111020260914M001.pdf</u></font></a></td>
<td style='text-align:left !important;'><a href='#' onclick='document.fm_fileDownload.fileName.value="111020260914E001.pdf";document.fm_fileDownload.submit();'><font color='blue'><u>111020260914E001.pdf</u></font></a></td>
<td style='text-align:left !important;'><a href='https://southeastcement.com.tw/investor-zone/corporate-briefing-session/' target='_blink'><font color='blue'><u>https://southeastcement.com.tw/investor-zone/corporate-briefing-session/</u></font></a></td>
<td style='text-align:left !important;'>
影音資訊網址：
<a target='_blank' href='https://southeastcement.com.tw/investor-zone/corporate-briefing-session/'><font color=blue><u>https://southeastcement.com.tw/investor-zone/corporate-briefing-session/</u></font></a>
<br>
</td>
<td style='text-align:left !important;'>無。</td>
<td align='center'><input type='button' value='查詢' onclick='document.form_t100sb02_1.co_id.value="1110";openWindow(this.form ,"");'>
</td>
</tr>
<tr class='odd' data-type='body' >
<td style='text-align:left !important;'>1215</td><td>卜蜂</td>
<td align='center'>115/09/21</td>
<td align='center'>14:00</td>
<td style='text-align:left !important;'>證券交易所一樓資訊展示中心(台北市信義區信義路五段7號)</td>
<td style='text-align:left !important;'>簡報營運狀況</td>
<td style='text-align:left !important;'>內容檔案於當日會後公告於公開資訊觀測站</td>
<td style='text-align:left !important;'>內容檔案於當日會後公告於公開資訊觀測站</td>
<td style='text-align:left !important;'><a href='https://www.cptwn.com.tw/ec99/rwd1453/category.asp?category_id=21' target='_blink'><font color='blue'><u>https://www.cptwn.com.tw/ec99/rwd1453/category.asp?category_id=21</u></font></a></td>
<td style='text-align:left !important;'>
影音資訊網址：
未輸
<br>
</td>
<td style='text-align:left !important;'>無</td>
<td align='center'><input type='button' value='查詢' onclick='document.form_t100sb02_1.co_id.value="1215";openWindow(this.form ,"");'>
</td>
</tr>
<tr class='even' data-type='body' >
<td style='text-align:left !important;'>1217</td><td>愛之味</td>
<td align='center'>115/09/11</td>
<td align='center'>14:30</td>
<td style='text-align:left !important;'>台北市敦化南路&#12038;段97號16樓第&#12032;會議室</td>
<td style='text-align:left !important;'>公司簡介與營運狀況說明</td>
<td style='text-align:left !important;'><a href='#' onclick='document.fm_fileDownload.fileName.value="121720260911M001.pdf";document.fm_fileDownload.submit();'><font color='blue'><u>121720260911M001.pdf</u></font></a></td>
<td style='text-align:left !important;'><a href='#' onclick='document.fm_fileDownload.fileName.value="121720260911E001.pdf";document.fm_fileDownload.submit();'><font color='blue'><u>121720260911E001.pdf</u></font></a></td>
<td style='text-align:left !important;'><a href='https://www.agv.com.tw/ir/shareholder-column/investor-conference/' target='_blink'><font color='blue'><u>https://www.agv.com.tw/ir/shareholder-column/investor-conference/</u></font></a></td>
<td style='text-align:left !important;'>
影音資訊網址：
<a target='_blank' href='https://youtu.be/31RquACkNTE'><font color=blue><u>https://youtu.be/31RquACkNTE</u></font></a>
<br>
</td>
<td style='text-align:left !important;'>無</td>
<td align='center'><input type='button' value='查詢' onclick='document.form_t100sb02_1.co_id.value="1217";openWindow(this.form ,"");'>
</td>
</tr></table>"""

OTC = r"""<tr class='even' data-type='body' >
<td style='text-align:left !important;'>1268</td><td>漢來美食</td>
<td align='center'>115/09/10</td>
<td align='center'>14:30</td>
<td style='text-align:left !important;'>線上法說會</td>
<td style='text-align:left !important;'>本公司受邀參加由凱基證券舉辦之線上法人說明會，說明截至115年上半年之營運概況、財務概況及未來展望。</td>
<td style='text-align:left !important;'><a href='#' onclick='document.fm_fileDownload.fileName.value="126820260909M001.pdf";document.fm_fileDownload.submit();'><font color='blue'><u>126820260909M001.pdf</u></font></a></td>
<td style='text-align:left !important;'><a href='#' onclick='document.fm_fileDownload.fileName.value="126820260909E001.pdf";document.fm_fileDownload.submit();'><font color='blue'><u>126820260909E001.pdf</u></font></a></td>
<td style='text-align:left !important;'><a href='https://www.hilai-foods.com/stakeholders#96' target='_blink'><font color='blue'><u>https://www.hilai-foods.com/stakeholders#96</u></font></a></td>
<td style='text-align:left !important;'>
影音資訊網址：
<a target='_blank' href='https://www.youtube.com/watch?v=4ktcmRxAbwQ'><font color=blue><u>https://www.youtube.com/watch?v=4ktcmRxAbwQ</u></font></a>
<br>
</td>
<td style='text-align:left !important;'>無</td>
<td align='center'><input type='button' value='查詢' onclick='document.form_t100sb02_1.co_id.value="1268";openWindow(this.form ,"");'>
</td>
</tr>
<tr class='odd' data-type='body' >
<td style='text-align:left !important;'>2640</td><td>大車隊</td>
<td align='center'>115/09/11</td>
<td align='center'>14:30</td>
<td style='text-align:left !important;'>台北市南港區經貿二路188號13樓(中信金控總部B棟議室1302)</td>
<td style='text-align:left !important;'>本公司受邀參加中國信託綜合證券股份有限公司舉辦之法人說明會，並將於會中說明本公司之營運概況、財務及業務成果等相關資訊。</td>
<td style='text-align:left !important;'><a href='#' onclick='document.fm_fileDownload.fileName.value="264020260909M001.pdf";document.fm_fileDownload.submit();'><font color='blue'><u>264020260909M001.pdf</u></font></a></td>
<td style='text-align:left !important;'><a href='#' onclick='document.fm_fileDownload.fileName.value="264020260909E001.pdf";document.fm_fileDownload.submit();'><font color='blue'><u>264020260909E001.pdf</u></font></a></td>
<td style='text-align:left !important;'><a href='https://www.55688.com.tw/investor-relations/financial-information' target='_blink'><font color='blue'><u>https://www.55688.com.tw/investor-relations/financial-information</u></font></a></td>
<td style='text-align:left !important;'>
影音資訊網址：
<a target='_blank' href='http://irconference.twse.com.tw/2640_29_20260911_ch.MP4'><font color=blue><u>http://irconference.twse.com.tw/2640_29_20260911_ch.MP4</u></font></a>
<br>
</td>
<td style='text-align:left !important;'>完整財務業務資訊請至公開資訊觀測站之法人說明會一覽表或法說會項目下查閱。</td>
<td align='center'><input type='button' value='查詢' onclick='document.form_t100sb02_1.co_id.value="2640";openWindow(this.form ,"");'>
</td></tr>
<tr class='even' data-type='body' >
<td style='text-align:left !important;'>2718</td><td>全心投控</td>
<td align='center'>115/09/21</td>
<td align='center'>15:00</td>
<td style='text-align:left !important;'>本公司受邀參加元大證券舉辦之線上法說會</td>
<td style='text-align:left !important;'>說明115年第二季公司營運狀況</td>
<td style='text-align:left !important;'>內容檔案於當日會後公告於公開資訊觀測站</td>
<td style='text-align:left !important;'>內容檔案於當日會後公告於公開資訊觀測站</td>
<td style='text-align:left !important;'><a href='https://www.allmindholdings.com.tw/' target='_blink'><font color='blue'><u>https://www.allmindholdings.com.tw/</u></font></a></td>
<td style='text-align:left !important;'>
影音資訊網址：
未輸
<br>
</td>
<td style='text-align:left !important;'>無</td>
<td align='center'><input type='button' value='查詢' onclick='document.form_t100sb02_1.co_id.value="2718";openWindow(this.form ,"");'>
</td>
</tr>"""

TODAY = date(2026, 9, 18)   # 探針跑的那一天(台北)

# ── ① 民國日期 ──
ok('① 民國日期 115/09/15 → 2026-09-15', C.parse_roc_date('115/09/15') == '2026-09-15')
ok('①b 壞日期回 None(⛔ 不可 raise)', C.parse_roc_date('') is None and C.parse_roc_date('115/13/40') is None)

# ── ②~⑤ 解析真實列 ──
sii = C.parse_rows(SII, '上市')
otc = C.parse_rows(OTC, '上櫃')
ok('② 上市三列全部解出(表頭列⛔ 不可被當資料)', len(sii) == 3, [r['s'] for r in sii])
ok('②b 上櫃三列全部解出', len(otc) == 3, [r['s'] for r in otc])
r0 = next((r for r in sii if r['s'] == '1110'), {})
ok('③ 東泥:代號/名稱/日期/時間/地點 全對',
   r0.get('name') == '東泥' and r0.get('d') == '2026-09-15' and r0.get('t') == '16:00'
   and r0.get('place') == '線上法說會' and r0.get('mkt') == '上市', r0)
ok('③b 東泥:擇要訊息是純文字(⛔ 不可殘留標籤)',
   r0.get('sum') == '本公司受邀參加元大證券舉辦之線上法說會，報告本公司營運狀況。', r0.get('sum'))
ok('③c 東泥:兩個簡報 PDF 檔名(中文 M / 英文 E)都抓到',
   r0.get('pdf') == ['111020260914E001.pdf', '111020260914M001.pdf'], r0.get('pdf'))
ok('③d 東泥:公司網站與影音連結',
   r0.get('web') == 'https://southeastcement.com.tw/investor-zone/corporate-briefing-session/'
   and r0.get('vid') == 'https://southeastcement.com.tw/investor-zone/corporate-briefing-session/', (r0.get('web'), r0.get('vid')))
ok('③e 「無。」要清成空字串(⛔ 不可把「無」印給使用者)', r0.get('other') == '', r0.get('other'))
r1 = next((r for r in sii if r['s'] == '1215'), {})
ok('④ 卜蜂:還沒開 → 簡報欄是文字「內容檔案於當日會後公告…」→ pdf 空、vid 空(「未輸」)',
   r1.get('pdf') == [] and r1.get('vid') == '' and r1.get('web', '').startswith('https://www.cptwn.com.tw/'), r1)
r2 = next((r for r in sii if r['s'] == '1217'), {})
# ⚠️ 誠實紀錄:第一版斷言寫「一段…第一會議室」是**錯的** —— MOPS 原文用的是康熙部首字 &#12038;(⼆ U+2F06)、
#    &#12032;(⼀ U+2F00),⛔ 不是「二」「一」。解碼是對的,錯的是我憑印象寫的期望值(陷阱 #40 又一次)。
#    → 改釘用意:實體要被還原(⛔ 不可殘留 &#),而且還原成 MOPS 真正給的那個字。
ok('⑤ 愛之味:HTML 實體 &#12038; 要還原成字(地點),⛔ 不可殘留 &#',
   '&#' not in r2.get('place', '') and '\u2f06段97號16樓第\u2f00會議室' in r2.get('place', ''), r2.get('place'))
ok('⑤b 愛之味:youtu.be 影音連結', r2.get('vid') == 'https://youtu.be/31RquACkNTE', r2.get('vid'))
r3 = next((r for r in otc if r['s'] == '2640'), {})
ok('⑤c 大車隊:「其他應敘明事項」不是「無」就要留著',
   r3.get('other', '').startswith('完整財務業務資訊') and r3.get('vid', '').endswith('.MP4'), r3)

# ── ⑥ 窗口 / 產物 ──
out = C.build(sii, None, otc, None, TODAY, old={})
ok('⑥ build:未來場次(≥ 今天)vs 已開(< 今天)切對',
   out and sorted(r['s'] for r in out['upcoming']) == ['1215', '2718']
   and sorted(r['s'] for r in out['recent']) == ['1110', '1217', '1268', '2640'],
   out and ([r['s'] for r in out['upcoming']], [r['s'] for r in out['recent']]))
ok('⑥b 產物有 data_date / src_error 兩個市場 / n 統計', out and out['data_date'] == '2026-09-18'
   and {'sii', 'otc'} <= set(out['src_error']) and out['n']['with_sum'] == 6 and out['n']['with_files'] == 4, out and out['n'])
ok('⑥c hist 只收過去日期、每檔一份', out and set(out['hist']) == {'1110', '1217', '1268', '2640'}
   and out['hist']['1110'] == ['2026-09-15'], out and out['hist'])
old = {'upcoming': [], 'recent': [], 'hist': {'1110': ['2025-03-12', '2025-08-20'], '9999': ['2024-01-05']}}
out2 = C.build(sii, None, otc, None, TODAY, old=old)
ok('⑥d hist 是累積型:舊檔的日期要留著、別檔(9999)也不能丟',
   out2['hist']['1110'] == ['2025-03-12', '2025-08-20', '2026-09-15'] and out2['hist']['9999'] == ['2024-01-05'], out2['hist'])
ok('⑥e hist 每檔上限 HIST_MAX',
   len(C.merge_hist({'1': [f'2020-01-{i:02d}' for i in range(1, 29)] + [f'2021-01-{i:02d}' for i in range(1, 29)]}, [], TODAY)['1']) == C.HIST_MAX)

# ── ⑦ 給 macro_miner 的事件文字 ──
ev = C.to_macro_events(sii + otc, TODAY, 14)
ok('⑦ to_macro_events:只收未來 14 天,文字 = 「📞 名稱(代號) 法說會 時間」(⛔ 代號一定要在 —— index.html 靠它比對)',
   [e['event'] for e in ev] == ['📞 卜蜂(1215) 法說會 14:00', '📞 全心投控(2718) 法說會 15:00']
   and all(e['date'] >= '2026-09-18' for e in ev), ev)
ok('⑦b 每一筆都含「法說」(前端 regex /法說|法人說明會/ 才抓得到)', all('法說' in e['event'] for e in ev))

# ── ⑧ 空過守門 ──
ok('⑧ 🚧 兩市場都 0 場而舊檔有場次 → 回 None(⛔ 不覆寫)',
   C.build([], 'HTTP 403', [], '被主機擋', TODAY, old={'upcoming': [{'s': '1'}], 'recent': [], 'hist': {}}) is None)
ok('⑧b 但舊檔也沒有時要照寫(第一次跑)', C.build([], 'x', [], 'y', TODAY, old={}) is not None)
ok('⑧c 單一市場失敗 → 照寫,而且 src_error 那一格要有原因(陷阱 #22)',
   (lambda o: o is not None and o['src_error']['otc'] == '被主機擋' and o['n']['otc'] == 0)(C.build(sii, None, [], '被主機擋', TODAY, old={})))

# ── ⑨ 原始碼守門:每市場各自 try(陷阱 #44)——先剝掉註解再比 ──
def _code_only(txt):
    """剝掉 # 註解 **與** 三引號 docstring —— 兩者都會引用「舊的錯誤寫法」當說明,不剝會被自己的說明救活/害死。"""
    txt = re.sub(r'"""[\s\S]*?"""', '', txt)
    return '\n'.join(l for l in txt.split('\n') if not l.strip().startswith('#'))
SRC = _code_only(Path(ROOT / 'confcall_miner.py').read_text(encoding='utf-8'))
fm = SRC[SRC.index('def fetch_market'):SRC.index('def _load_old')]
ok('⑨ fetch_market 自己有 try/except(⛔ 一個市場掛不可拖累另一個)', 'try:' in fm and 'except Exception' in fm)
ok('⑨b ⛔ 不可讀 t187ap02 / t187ap38(探針證實那是大股東表 / 股東會表)', not re.search(r't187ap02|t187ap38', SRC))
ok('⑨c 主機是 mopsov(mops.twse.com.tw 對 runner 回「安全性考量」)', "mopsov.twse.com.tw" in SRC)
ok('⑨d 有指數退避(MOPS 對機器人敏感)', re.search(r'time\.sleep\(.*attempt', fm) is not None)

# ── ⑩ macro_miner 接線:fetch_earnings_calls 必須走 confcall_miner,⛔ 不可再打舊端點 ──
MM = Path(ROOT / 'macro_miner.py').read_text(encoding='utf-8')
seg = MM[MM.index('def fetch_earnings_calls'):]
seg = seg[:seg.index('\ndef ', 10)]
seg_nc = _code_only(seg)
ok('⑩ macro_miner.fetch_earnings_calls 走 confcall_miner.to_macro_events(⛔ 只切那一段比,免得被別處字串救活)',
   'confcall_miner' in seg_nc and 'to_macro_events' in seg_nc, seg_nc[:200])
ok('⑩b 那一段⛔ 不可再出現 t187ap02(打錯三個月的資料集)', 't187ap02' not in seg_nc)

# ═══════════ V77.2.8 新增:📄 下載樣板 / 🏭 產業碼 / 📊 會後股價反應 ═══════════
# ⭐ 逐字抄自探針 Actions #35406340327(run #14)印的官方 <form name='fm_fileDownload'> 原文。
#    🚨 注意 `name = 'step'` **等號兩邊有空白** —— run #13 的 regex 吃不到就靜默退回我猜的欄位,
#       四筆全「下載失敗」,而那測的是我的猜測不是官方(陷阱 #40)。這份測資就是用來釘住這件事的。
FORM = r"""<form action = '/server-java/FileDownLoad' method = 'post' id='fm_fileDownload' name='fm_fileDownload'>
<input type = 'hidden' name = 'step' id = 'step' value = '9'/>
<input type = 'hidden' name = 'filePath' id = 'filePath' value = '/home/html/nas/STR/'/>
<input type = 'hidden' name = 'fileName' id = 'fileName' value = ''/>
<input type = 'hidden' name = 'functionName' id = 'functionName' value = 't100sb02_1'/>
</form>"""
tpl = C.parse_file_form(FORM, 'https://mopsov.twse.com.tw')
ok('📄⑪ 從官方 form 抄得到下載樣板(⚠️ `name = \'x\'` 等號有空白也要吃得到)',
   tpl and tpl['path'] == '/server-java/FileDownLoad' and tpl['q']['filePath'] == '/home/html/nas/STR/'
   and tpl['q']['functionName'] == 't100sb02_1' and tpl['q']['step'] == '9', tpl)
ok('📄⑪b fileName 是「參數名」⛔ 不可被寫死成某一份檔案',
   tpl and tpl['arg'] == 'fileName' and 'fileName' not in tpl['q'], tpl)
ok('📄⑪c 抄到的要標 from=form(退回常數要標 fallback,⛔ 不靜默)', tpl and tpl['from'] == 'form')
ok('📄⑪d 沒有 fm_fileDownload 就回 None(⛔ 不可硬湊一個樣板出來)',
   C.parse_file_form("<form name='fm'><input name='step' value='1'></form>") is None)
ok('📄⑪e 探針實測 GET 就回真 PDF → how 記成 GET(前端才敢用 <a href>)',
   tpl['how'] == 'GET' and C.FILE_FALLBACK['how'] == 'GET')

out3 = C.build(sii, None, otc, None, TODAY)
ok('📄⑪f 產物帶樣板(⛔ 前端不可自己寫死網址)',
   (out3.get('src') or {}).get('file', {}).get('path') == '/server-java/FileDownLoad', (out3.get('src') or {}).get('file'))

# 🏭 產業碼:走 data/stock_names.json(⛔ 不猜)
ok('🏭⑫ 讀不到股名表要寫原因(陷阱 #22),⛔ 不可靜默留空',
   (lambda: (lambda m, e: (not m) and bool(e))(*(lambda old: (C._names_table()))(None)))()
   if not (C.DATA / 'stock_names.json').exists() else True)
_m, _e = C._names_table()
# 🚧 補一列**不在股名表裡**的代號(9997)—— 沒有它,「查不到就猜一個」那種缺陷叫不出來
sii_x = sii + [dict(sii[0], s='9997', d='2026-09-16')]
out_x = C.build(sii_x, None, otc, None, TODAY)
ok('🏭⑫c 查不到產業的那一檔⛔ 不可被猜一個碼(缺就是缺)',
   all(('ind' not in r) for r in out_x['upcoming'] + out_x['recent'] if r['s'] == '9997'),
   [r.get('ind') for r in out_x['upcoming'] + out_x['recent'] if r['s'] == '9997'])
ok('🏭⑫b 有股名表時 ind 要補得上;沒有時 src_error.names 要說原因',
   (out3['n']['with_ind'] > 0 and all(('ind' in r) or (r['s'] not in _m) for r in out3['upcoming'] + out3['recent']))
   if _m else bool(out3['src_error'].get('names')), (out3['n'].get('with_ind'), out3['src_error'].get('names')))

# 📊 會後股價反應:合成 K 線 —— ⭐ 決定性對照:事件組刻意比對照組多漲,兩個中位數**不可相等**
import tempfile, os
_tmp = tempfile.mkdtemp()
_old_data = C.DATA
try:
    C.DATA = Path(_tmp)
    n = 300
    # 大盤每天固定 +0.1%;個股平常跟著大盤,只有「法說會後那 5 天」多漲 1%/天
    import datetime as _dt
    base_d = _dt.date(2024, 1, 1)
    ds = [(base_d + _dt.timedelta(days=i)).isoformat() for i in range(n)]
    (Path(_tmp) / '^TWII.json').write_text(json.dumps([{'date': ds[i], 'close': 100 * (1.001 ** i)} for i in range(n)]), encoding='utf-8')
    # 個股:平常跟著大盤,只有「法說會後那 5 天」多漲 → 事件組中位數必須 > 對照組
    ev_idx = set(range(20, n - 30, 30))
    px, c = [], 100.0
    boost = set()
    for i in ev_idx:
        for k in range(i + 1, i + 6):
            boost.add(k)
    for i in range(n):
        c *= 1.001 * (1.01 if i in boost else 1.0)
        px.append(c)
    (Path(_tmp) / '8888.json').write_text(json.dumps([{'date': ds[i], 'close': px[i]} for i in range(n)]), encoding='utf-8')
    # 🚧 另補一檔**只有 1 場**的(9998)—— 沒有它,`n>=1` 跟 `n>=2` 的結果一模一樣,⑬c 就沒有鑑別力
    (Path(_tmp) / '9998.json').write_text(json.dumps([{'date': ds[i], 'close': 100 * (1.001 ** i)} for i in range(n)]), encoding='utf-8')
    R = C.build_react({'8888': [ds[i] for i in sorted(ev_idx)], '9998': [ds[50]]}, _dt.date(2024, 12, 31))
    ok('📊⑬ 算得出事件組與對照組(⛔ 沒有對照組的統計不可用,陷阱 #36)',
       not R.get('error') and R['n'] > 0 and R['base']['n'] > R['n'], R.get('error') or (R.get('n'), R.get('base', {}).get('n')))
    ok('📊⑬b ⭐ 決定性對照:事件後 5 日刻意多漲 → 事件組中位數必須明顯高於對照組',
       R['med5'] - R['base']['med5'] > 2, (R.get('med5'), R.get('base', {}).get('med5')))
    ok('📊⑬c byStock 只收 n≥2(⛔ 一場就下結論是陷阱 #27)',
       all(v['n'] >= 2 for v in R['byStock'].values()) and '9998' not in R['byStock'] and '8888' in R['byStock'],
       R['byStock'])
    ok('📊⑬d 產物自己要寫「這不是回測」與「方向 0 個成立」(⛔ 不可被讀成訊號)',
       '不是回測' in R['caveat'] and '0 個成立' in R['caveat'], R['caveat'])
    # 🚧 ⑬g「個股有那一天、大盤沒有」—— 沒有這個情境,「大盤缺就當 0」那種缺陷叫不出來
    #    (⛔ 拿 mc[-1] 去算會生出垃圾數字,而畫面上看起來完全正常)
    _evs = [ds[i] for i in sorted(ev_idx)]
    _drop = set(_evs[:2])
    _hist1 = {'8888': _evs}
    R_full = C.build_react(_hist1, _dt.date(2024, 12, 31))          # 大盤完整
    (Path(_tmp) / '^TWII.json').write_text(json.dumps(
        [{'date': ds[i], 'close': 100 * (1.001 ** i)} for i in range(n) if ds[i] not in _drop]), encoding='utf-8')
    R3 = C.build_react(_hist1, _dt.date(2024, 12, 31))              # 大盤少了那 2 天
    ok('📊⑬g 大盤那天沒有資料 → 那一場**整場不算**(⛔ 不可拿別天的大盤湊一個超額出來)',
       not R3.get('error') and R3['n'] == len(_evs) - 2, (R3.get('n'), len(_evs)))
    ok('📊⑬g2 對照組也一樣要跳過(⛔ 不可只守事件組 —— 對照組被汙染,整個比較就沒意義了)',
       R3['base']['n'] < R_full['base']['n'], (R3['base']['n'], R_full['base']['n']))
    (Path(_tmp) / '^TWII.json').unlink()
    R2 = C.build_react({'8888': [ds[30]]}, _dt.date(2024, 12, 31))
    ok('📊⑬e 沒有大盤就⛔ 不給數字(⛔ 不拿絕對報酬充數),而且要寫原因',
       bool(R2.get('error')) and not any(k in R2 for k in ('med1', 'med5', 'med20', 'win5', 'base')), R2)
finally:
    C.DATA = _old_data
    import shutil; shutil.rmtree(_tmp, ignore_errors=True)

RS = SRC[SRC.index('def build_react'):]
RS = RS[:RS.index('\ndef ', 10)]
ok('📊⑬f 對照組⛔ 不可只挑「跟事件同一天」—— 要掃那一檔的每一個交易日',
   'for d, i in si.items()' in RS, RS[:120])


print()
if fails:
    print(f'❌ CONFCALL_TEST_FAIL: {fails}')
    sys.exit(1)
print('✅ CONFCALL_TEST_PASS')
