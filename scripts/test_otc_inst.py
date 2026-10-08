"""🏪 V78.6.3 上櫃三大法人解析:新站(tables+欄名)/ 舊站(aaData 寫死位置)都吃;外資用「不含外資自營商」口徑(同上市 T86)。
2026-10-01 起舊端點上櫃股全部變 0 → 新站優先。⛔ 網址沒在 runner 驗過,由 log 的 [上櫃法人] 那行說了算。"""
import sys; sys.path.insert(0,__import__("os").path.dirname(__import__("os").path.dirname(__import__("os").path.abspath(__file__))))
import miner
# 新站形狀(欄名)
F=['代號','名稱','外資及陸資(不含外資自營商)-買進股數','外資及陸資(不含外資自營商)-賣出股數','外資及陸資(不含外資自營商)-買賣超股數','外資自營商-買進股數','外資自營商-賣出股數','外資自營商-買賣超股數','外資及陸資-買進股數','外資及陸資-賣出股數','外資及陸資-買賣超股數','投信-買進股數','投信-賣出股數','投信-買賣超股數','自營商(自行買賣)-買賣超股數','自營商(避險)-買賣超股數','自營商-買賣超股數','三大法人買賣超股數合計']
rows=[[f'{1000+i:04d}','x','1','2','-1,000','0','0','0','0','0','0','0','0','2,000','5','6','11','0'] for i in range(150)]
j={'tables':[{'fields':F,'data':rows}],'stat':'ok'}
r,f=miner._otc_inst_rows(j); g=miner._otc_inst_parse(r,f)
print(len(g), g.get('1000'))
assert g['1000']=={'foreign_net':-1000,'trust_net':2000,'dealer_net':11}
# 舊站 aaData(沒欄名)
old=[[f'{2000+i:04d}']+[str(k) for k in range(1,24)] for i in range(150)]
r,f=miner._otc_inst_rows({'aaData':old}); g=miner._otc_inst_parse(r,f); print(g['2000']); assert g['2000']=={'foreign_net':4,'trust_net':11,'dealer_net':18}
# 空的
print(miner._otc_inst_rows({'tables':[{'fields':F,'data':[]}]}))
print('OK')
