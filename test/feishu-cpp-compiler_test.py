import importlib.util
import json
import pathlib
import unittest
import xml.etree.ElementTree as ET

BASE=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('cpp',BASE/'scripts/compile-feishu-cpp.py')
cpp=importlib.util.module_from_spec(spec); spec.loader.exec_module(cpp)

class CppCompilerTest(unittest.TestCase):
    def test_literal_code_and_nested_lists(self):
        compiler=cpp.Compiler(BASE/'artifacts/cpp-notes',{})
        node=ET.fromstring('<p>示例<pre lang="C++"><code>  if (a &lt; b &amp;&amp; c) {<br/>    cout &lt;&lt; 13812345678;<br/>}</code></pre><ul><li>一<ol><li>二</li></ol></li></ul></p>')
        out=ET.fromstring('<root>'+compiler.render(node)+'</root>')
        self.assertEqual(out.find('.//pre/code').text,'  if (a < b && c) {\n    cout << 13812345678;\n}')
        self.assertIsNotNone(out.find('./ul/li/ol/li'))
        self.assertIsNone(out.find('./p/div'))

    def test_real_archive_completeness(self):
        archive=BASE/'artifacts/cpp-notes'
        if not (archive/'source.json').exists(): self.skipTest('Local source archive required')
        source=json.loads((archive/'source.json').read_text(encoding='utf-8-sig'))
        root=ET.fromstring('<root>'+source['data']['document']['content']+'</root>')
        guides=json.loads((BASE/'content/cpp-notes.json').read_text(encoding='utf-8'))['guides']
        output=ET.fromstring('<root>'+''.join(g['sections'][0]['body_html'] for g in guides)+'</root>')
        self.assertEqual(len(guides),63)
        self.assertEqual([cpp.literal(n) for n in root.iter('pre')],[cpp.literal(n) for n in output.iter('pre')])
        for tag in ['img','li','ul','ol']:
            self.assertEqual(len(list(root.iter(tag))),len(list(output.iter(tag))),tag)
        self.assertEqual(len(list(output.iter('table'))),96)
        self.assertEqual(sum(len(g['sections'][0]['body_outline']) for g in guides),592)
        for guide in guides:
            section=guide['sections'][0]
            for heading in section['body_outline']:
                self.assertIn('id="'+heading['id']+'"',section['body_html'])
        self.assertIn(cpp.AUTHOR, ''.join(output.itertext()))
        self.assertTrue(all(not g['retrieval'] for g in guides))
        self.assertTrue(all(g['sources'][0]['official_page_url']==cpp.URL for g in guides))

if __name__=='__main__': unittest.main()
