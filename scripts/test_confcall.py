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



# ── 🎲 V79.8.6 法說會「股性」(react.habit / react.hb):前一天收盤 → 隔天收盤,減加權;≤ −3% = 法會 ──
import tempfile as _tf, shutil as _sh, datetime as _dt2
_th = _tf.mkdtemp(); _old_data2 = C.DATA
try:
    C.DATA = Path(_th)
    _n = 400
    _b = _dt2.date(2024, 1, 1)
    _ds = []
    _t = _b
    while len(_ds) < _n:                       # 只放平日(週末不是交易日 → 測「週六的法說會接到週一」)
        if _t.weekday() < 5:
            _ds.append(_t.isoformat())
        _t += _dt2.timedelta(days=1)
    (Path(_th) / '^TWII.json').write_text(json.dumps([{'date': _ds[i], 'close': 100.0} for i in range(_n)]), encoding='utf-8')
    _ev = [150, 200, 250, 300, 350]
    _px, _c = [], 100.0
    for i in range(_n):
        _c *= (1.002 if i % 2 else 0.998)      # 平常小動
        if i - 1 in _ev:
            _c *= 0.94                          # 每一場法說會隔天跌 6%
        _px.append(_c)
    (Path(_th) / '7777.json').write_text(json.dumps([{'date': _ds[i], 'close': _px[i]} for i in range(_n)]), encoding='utf-8')
    # 6666:平常一樣小動,法說會那兩天不動;另外在第 200 根除息 10%(參考價 90)→ 接回去後⛔ 算成法會
    _q = [100.0 * (1.002 if i % 2 else 0.998) ** 0 for i in range(_n)]
    _p6 = [100.0 if i < 200 else 90.0 for i in range(_n)]
    (Path(_th) / '6666.json').write_text(json.dumps([{'date': _ds[i], 'close': _p6[i]} for i in range(_n)]), encoding='utf-8')
    (Path(_th) / 'dividends_hist.json').write_text(json.dumps({'updated': 'x', '6666': {'h': [[_ds[200], 10, '息', 100, 90]]}}), encoding='utf-8')
    # 7777 的第一場另外寫一個「隔天又開一場」(同一次法說會兩天)→ 只算一次
    _sat = _dt2.date.fromisoformat(_ds[250])
    while _sat.weekday() != 5:
        _sat -= _dt2.timedelta(days=1)
    _h = {'7777': [_ds[150], _ds[151]] + [_ds[i] for i in _ev[1:]], '6666': [_ds[200]], '5555': [_ds[100]]}
    RH = C.build_react(_h, _dt2.date(2025, 12, 31))
    _hb = RH.get('hb') or {}
    ok('🎲a 這一檔每一場都跌 6% → hb = [5 場, 5 場法會, 0 場大漲, …](同一次法說會開兩天只算一次)',
       _hb.get('7777', [None])[:3] == [5, 5, 0], _hb.get('7777'))
    ok('🎲b 平常日子(⛔ 含法說會前後 2 天)那兩個比例是 0(平常只小動)',
       _hb.get('7777', [0] * 5)[3:] == [0.0, 0.0], _hb.get('7777'))
    ok('🎲c 除息落在窗口裡 → 用參考價接回去,⛔ 算成法會', _hb.get('6666', [None] * 3)[:3] == [1, 0, 0] and RH['habit']['div_error'] is None,
       (_hb.get('6666'), RH['habit']['div_error']))
    ok('🎲d 全體:事件組 / 平常組各自的比例,而且寫了怎麼算',
       RH['habit']['ev']['n'] == 6 and RH['habit']['ev']['dn'] == round(100 * 5 / 6, 1) and RH['habit']['ord']['n'] > 500 and '前一個交易日' in RH['habit']['how'],
       RH['habit'])
    ok('🎲e K 線讀不到的那檔(5555)⛔ 出現', '5555' not in _hb, list(_hb))
    # ⭐ 決定性對照:拿掉股利檔 → 6666 那場變成法會,而且 div_error 要說原因
    (Path(_th) / 'dividends_hist.json').unlink()
    RH2 = C.build_react(_h, _dt2.date(2025, 12, 31))
    ok('🎲f 決定性對照:沒有股利檔 → 除息那場被算成法會 + 寫原因', (RH2.get('hb') or {}).get('6666', [None] * 2)[:2] == [1, 1] and bool(RH2['habit']['div_error']),
       ((RH2.get('hb') or {}).get('6666'), RH2['habit']['div_error']))
    # 週六的法說會 → 接到下一個交易日(⛔ 整場丟掉)
    #   (另放一場平日的:舊的會後統計一場都對不到 K 線就整份回 error,那是另一條守門 ⑬e)
    RH3 = C.build_react({'7777': [_sat.isoformat(), _ds[100]]}, _dt2.date(2025, 12, 31))
    ok('🎲g 週末的日期接到下一個交易日(兩場都算到)', (RH3.get('hb') or {}).get('7777', [0])[0] == 2, RH3.get('hb') or RH3.get('error'))
    # 價格斷崖窗口不算
    _pc = list(_px); _pc[300] = _pc[299] * 0.4
    for i in range(301, _n):
        _pc[i] = _pc[i] * 0.4
    (Path(_th) / '7777.json').write_text(json.dumps([{'date': _ds[i], 'close': _pc[i]} for i in range(_n)]), encoding='utf-8')
    RH4 = C.build_react({'7777': [_ds[i] for i in _ev]}, _dt2.date(2025, 12, 31))
    ok('🎲h 價格斷崖(×0.4)碰到的那一場不算', (RH4.get('hb') or {}).get('7777', [0])[0] == 4, (RH4.get('hb') or {}).get('7777'))
finally:
    C.DATA = _old_data2
    _sh.rmtree(_th, ignore_errors=True)

# ── 📚 V78.2.5 補挖模式:只合併 hist,⛔ 不動 upcoming / recent ──
_old = {'upcoming': [{'s': '2330', 'd': '2026-10-20'}], 'recent': [{'s': '2330', 'd': '2026-09-01'}],
        'hist': {'2330': ['2026-07-17']}, 'react': {'n': 1}}
_rows = [{'s': str(2000 + i % 50), 'd': f'2023-{1 + i % 12:02d}-15', 't': '14:00'} for i in range(150)]
_rows += [{'s': '2330', 'd': '2027-01-01', 't': '14:00'}]   # 未來的 ⛔ 不可進 hist
_fake = lambda typek: (_rows if typek == 'sii' else [], None)
_out, _msg = C.backfill(1900, date(2026, 10, 2), _fake, json.loads(json.dumps(_old)))
ok('📚a 補挖:upcoming / recent 原封不動', _out and _out['upcoming'] == _old['upcoming'] and _out['recent'] == _old['recent'], _msg)
ok('📚b 補挖:hist 併進舊的場次(2330 舊的那筆還在)', _out and '2026-07-17' in _out['hist'].get('2330', []) and len(_out['hist']) > 10, _msg)
ok('📚c 補挖:未來的場次 ⛔ 不進 hist', _out and '2027-01-01' not in _out['hist'].get('2330', []))
ok('📚d 補挖:帶 backfill 紀錄(before / after)', _out and _out['backfill']['hist_after'] > _out['backfill']['hist_before'])
_o2, _m2 = C.backfill(1900, date(2026, 10, 2), lambda t: ([], 'HTTP 403'), json.loads(json.dumps(_old)))
ok('📚e 抓到 <100 場 → ⛔ 不寫(回 None 並說原因)', _o2 is None and '403' in _m2, _m2)
_o3, _m3 = C.backfill(1900, date(2026, 10, 2), _fake, {})
ok('📚f 沒有舊檔 → ⛔ 不補', _o3 is None, _m3)
C.PAST, C.FUTURE = 60, 45   # 還原(backfill 改過 global)


# ── ⏸️ V79.6.5 公司備註寫延期(2026-10-23 颱風「薔琵」)—— 備註原文逐字抄自 data/confcall.json,走正式入口 parse_rows ──
def _mv_row(code, name, roc, tm, other, mkt='上市'):
    return (f"<tr class='even' data-type='body' ><td>{code}</td><td>{name}</td><td align='center'>{roc}</td>"
            f"<td align='center'>{tm}</td><td>線上法說會</td><td>本公司受邀參加證券舉辦之法人說明會，說明本公司之營運概況</td>"
            f"<td></td><td></td><td></td><td></td><td>{other}</td><td></td></tr>")
MV_HTML = '<table>' + ''.join([
    _mv_row('1303', '南亞', '115/10/23', '14:00', '如台北市政府公告115/10/23停止上班，本說明會將順延至115/10/27 14:00(線上會議)'),
    _mv_row('3264', '欣銓', '115/10/23', '14:00', '視公司所在地若因薔琵颱風影響，停止上班上課，原訂115/10/23法說會將順延至10/27召開', '上櫃'),
    _mv_row('2008', '高興昌', '115/10/23', '14:00', '若因薔琵颱風影响,本公司115/10/23原訂法說會延後一個工作日舉辦.'),
    _mv_row('4169', '泰宗', '115/10/27', '14:30', '原10/23法說會，因遇薔琵颱風改期至10/27。報名網址https://reurl.cc/0k0lMY', '上櫃'),
    _mv_row('6530', '創威', '115/10/27', '14:00', '簡報內容檔案於當日會後公告於公開資訊觀測站。'),
    _mv_row('6548', '長科', '115/10/28', '14:00', '活動報名，請洽凱基證券 鄭小姐 02-2181-8167'),
    _mv_row('9001', '測試', '115/12/30', '14:00', '因故本次法說會改期至1/6舉行'),
    _mv_row('9002', '測試二', '115/10/23', '14:00', '簡報延後至10/30上傳'),
]) + '</table>'
mv_rows = {r['s']: r for r in C.parse_rows(MV_HTML, '上市')}
ok('⏸️a 南亞:民國年「順延至115/10/27」→ mv 2026-10-27、有條件(如台北市停班)',
   mv_rows['1303'].get('mv') == '2026-10-27' and mv_rows['1303'].get('mvc') == 1 and 'mvq' not in mv_rows['1303'], mv_rows['1303'])
ok('⏸️b 欣銓:「原訂115/10/23…順延至10/27」→ 原訂日期 ⛔ 不可被當新日期;沒寫年份照原訂那年',
   mv_rows['3264'].get('mv') == '2026-10-27' and mv_rows['3264'].get('mvc') == 1, mv_rows['3264'])
ok('⏸️c 高興昌:「延後一個工作日」沒寫日期 → 只標 mvq(⛔ 不維護節日行事曆,⛔ 猜哪天)',
   mv_rows['2008'].get('mvq') == 1 and 'mv' not in mv_rows['2008'] and mv_rows['2008'].get('mvc') == 1, mv_rows['2008'])
ok('⏸️d 泰宗:場次表日期已經改成 10/27 → 新日期不晚於原訂日 → ⛔ 不算延期', not ({'mv', 'mvq', 'mvc'} & set(mv_rows['4169'])), mv_rows['4169'])
ok('⏸️e 一般備註(簡報會後上傳 / 報名資訊)→ 沒有延期欄位',
   not ({'mv', 'mvq', 'mvc'} & set(mv_rows['6530'])) and not ({'mv', 'mvq', 'mvc'} & set(mv_rows['6548'])))
ok('⏸️f 沒寫年份又跨年(12/30 → 1/6)→ 2027-01-06', mv_rows['9001'].get('mv') == '2027-01-06', mv_rows['9001'])
ok('⏸️g 「簡報延後上傳」不是會議延期 → ⛔ 不標', not ({'mv', 'mvq', 'mvc'} & set(mv_rows['9002'])), mv_rows['9002'])
# build:延期還沒開的算「未來」、⛔ 不進歷年;行事曆照新日期
_T = date(2026, 10, 24)
_mvout = C.build(list(mv_rows.values()), None, [], None, _T, old={})
_up = {r['s'] for r in _mvout['upcoming']}; _rc = {r['s'] for r in _mvout['recent']}
ok('⏸️h build:南亞 / 欣銓(延到 10/27)在「未來」、⛔ 不在「已開」;高興昌(沒有日期)照原訂日算已開',
   {'1303', '3264'} <= _up and not ({'1303', '3264'} & _rc) and '2008' in _rc, (_up, _rc))
ok('⏸️i 延期還沒開的 ⛔ 進歷年 hist', '1303' not in _mvout['hist'] and '3264' not in _mvout['hist'], _mvout['hist'])
_ev = {e['event']: e['date'] for e in C.to_macro_events(list(mv_rows.values()), _T, 14)}
_ev1303 = [k for k in _ev if '(1303)' in k]
ok('⏸️j 行事曆照新日期、文字寫出原訂日(⛔ 代號 / 「法說」照留,index.html 靠它比對)',
   _ev1303 and _ev[_ev1303[0]] == '2026-10-27' and '原訂 10/23' in _ev1303[0] and '法說' in _ev1303[0], _ev)
# 決定性對照:同一列拿掉延期欄位 → 回到「已開」
_plain = dict(mv_rows['1303']); [_plain.pop(k, None) for k in ('mv', 'mvc', 'mvq')]
_o4 = C.build([_plain], None, [], None, _T, old={})
ok('⏸️k 決定性對照:同一列拿掉 mv → 回到「已開」、進歷年(證明 ⏸️h/⏸️i 靠的是 mv)',
   [r['s'] for r in _o4['recent']] == ['1303'] and _o4['hist'].get('1303') == ['2026-10-23'], (_o4['recent'], _o4['hist']))

# ── ⑬ 🩺 2026-10-24 #647:上一份被寫成「完整 JSON + 舊版尾巴」/ 亂碼 ─────────────────
#   🚨 舊寫法 `except: return {}` → 以為本來沒有歷史 → 5 年 hist 只剩這一輪那幾百場(全綠零訊息)
import tempfile as _tf
_old_out = C.OUT
_good = {'hist': {'2330': ['2021-07-15', '2022-01-20'], '1303': ['2024-04-01']}, 'upcoming': [], 'recent': []}
try:
    with _tf.TemporaryDirectory() as _td:
        C.OUT = Path(_td) / 'confcall.json'
        C.OUT.write_text(json.dumps(_good, ensure_ascii=False) + '方向實測 0 個成立,⛔ 不給多空。"}', encoding='utf-8')
        _o = C._load_old()
        ok('🩺⑬a 尾巴多一段 → 救回前面那份(歷年還在)', C._OLD_STATE['status'] == 'salvaged' and _o.get('hist', {}).get('2330') == _good['hist']['2330'],
           (C._OLD_STATE, _o))
        _b = C.build(list(mv_rows.values()), None, [], None, _T, old=_o)
        ok('🩺⑬a2 build 接著用救回的歷年(2330 / 1303 的舊場次留著)、hist_error 是空的',
           '2021-07-15' in (_b['hist'].get('2330') or []) and _b.get('hist_error') is None, (_b['hist'].get('2330'), _b.get('hist_error')))
        # 決定性對照:舊寫法(讀不到就 {})在同一份檔上 → 歷年整份不見
        try:
            _legacy = json.loads(C.OUT.read_text(encoding='utf-8'))
        except Exception:
            _legacy = {}
        ok('🩺⑬b 決定性對照:舊寫法同一份檔讀到 {}(= 5 年歷史不見)', _legacy == {}, _legacy)
        C.OUT.write_bytes(json.dumps(_good).encode('utf-8')[:20] + b'\x8a\x8a' + b'"}')
        _o = C._load_old()
        _b = C.build(list(mv_rows.values()), None, [], None, _T, old=_o)
        ok('🩺⑬c 救不回來 → 照寫(手機要能用)但 hist_error 要說出來 + 教怎麼補回',
           C._OLD_STATE['status'] == 'corrupt' and _b.get('hist_error') and 'hist_backfill' in _b['hist_error'], _b.get('hist_error'))
        C.OUT.unlink()
        _o = C._load_old()
        _b = C.build(list(mv_rows.values()), None, [], None, _T, old=_o)
        ok('🩺⑬d 檔案不在(第一次跑)→ hist_error 空的(⛔ 誤報)', C._OLD_STATE['status'] == 'missing' and _b.get('hist_error') is None, C._OLD_STATE)
finally:
    C.OUT = _old_out
    C._OLD_STATE.update(status='missing', msg='')

print()
if fails:
    print(f'❌ CONFCALL_TEST_FAIL: {fails}')
    sys.exit(1)
print('✅ CONFCALL_TEST_PASS')
