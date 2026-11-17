"""Local browser evidence only; does not operate WeChat DevTools."""
import argparse
import html
import json
import pathlib
import subprocess
import xml.etree.ElementTree as ET

BASE=pathlib.Path(__file__).resolve().parents[1]
WX=BASE.parent/'NKU-study-wxapp'
parser=argparse.ArgumentParser()
parser.add_argument('--chrome',required=True,type=pathlib.Path)
args=parser.parse_args()
guides=json.loads((BASE/'content/cpp-notes.json').read_text(encoding='utf-8'))['guides']
styles=json.loads(subprocess.check_output(['node','-e','console.log(JSON.stringify(require(process.argv[1])))',str(WX/'miniprogram/pages/guide-detail/reader-style.js')],encoding='utf-8'))
css=''.join(tag+'{'+style+'}' for tag,style in styles.items())
first=guides[1]
code_guide=next(g for g in guides if '<pre ' in g['sections'][0]['body_html'] and '<table' in g['sections'][0]['body_html'])
root=ET.fromstring('<root>'+code_guide['sections'][0]['body_html']+'</root>')
pre=next(n for n in root.iter('div') if n.find('pre') is not None)
table=next(root.iter('table'))
for name,body in [('images',first['sections'][0]['body_html']),('code','<h2>代码与进制表（原文节选）</h2>'+ET.tostring(pre,encoding='unicode')+ET.tostring(table,encoding='unicode'))]:
    body=body.replace('https://nkustudy.top/guide-media/cpp-notes/',(BASE/'public/guide-media/cpp-notes').as_uri()+'/')
    page='<!doctype html><meta charset="utf-8"><style>body{margin:0;width:430px;background:#FAF7FC;color:#282230;font:16px Arial,"Microsoft YaHei",sans-serif}header{padding:16px 24px;display:flex;align-items:center;gap:12px;color:#4B1F6F}header img{width:34px;height:34px;margin:0}main{box-sizing:border-box;width:430px;padding:16px 24px}small{color:#6F6972;line-height:1.7}h1.title{font-size:25px}'+css+' table{display:block;max-width:382px;overflow:auto}pre{max-width:354px}img{max-width:382px}</style>'
    guide=first if name=='images' else code_guide
    page+='<header><img src="'+(WX/'miniprogram/assets/brand.png').as_uri()+'">NKUStudy · C++ 笔记</header><main><small>本地 HTML 排版预览 · 非微信模拟器</small><h1 class="title">'+html.escape(guide['title'])+'</h1><small>'+html.escape(guide['summary'])+'</small>'+body+'</main>'
    target=BASE/f'artifacts/cpp-notes/preview-{name}.html'
    target.write_text(page,encoding='utf-8')
    subprocess.run([str(args.chrome),'--headless','--disable-gpu','--no-sandbox','--hide-scrollbars','--allow-file-access-from-files','--window-size=430,1600','--screenshot='+str(target.with_suffix('.png')),target.as_uri()],capture_output=True,check=True,timeout=45,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    print(target.with_suffix('.png'))
