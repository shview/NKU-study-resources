"""Regression checks for the original DocxXML shapes that lost formatting in Markdown."""
import importlib.util
import pathlib
import unittest
import xml.etree.ElementTree as ET

spec = importlib.util.spec_from_file_location('compiler', pathlib.Path(__file__).resolve().parents[1] / 'scripts/compile-feishu-handbook.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class HandbookCompilerTest(unittest.TestCase):
    def compile(self, xml):
        compiler = module.Compiler('https://nankai.feishu.cn/wiki/original', {'image-token': 'https://nkustudy.top/guide-media/chart.png'}, {'doc-token': 'https://nkustudy.top/guides/handbook-next/'})
        result = compiler.render(ET.fromstring('<root>' + xml + '</root>'))
        self.assertFalse(compiler.unknown)
        return ET.fromstring('<root>' + result + '</root>'), compiler

    def test_nested_lists_leave_heading_and_keep_inline_emphasis(self):
        root, compiler = self.compile('<h2>科研：<ul><li>先<b>联系老师</b>，再读论文<ol><li seq="3">文献笔记</li><li seq="4">实验记录</li></ol></li></ul></h2><p>查看<a href="https://example.edu/rules?a=1&amp;b=2">要求</a>并准备。</p>')
        self.assertEqual([node.tag for node in root], ['h2', 'ul', 'p'])
        self.assertEqual(root[0].text, '科研：')
        self.assertEqual(root.find('./ul/li/strong').text, '联系老师')
        self.assertEqual(root.find('./ul/li/ol').get('start'), '3')
        self.assertEqual(compiler.outline, [{'id': root[0].get('id'), 'title': '科研：', 'level': 2}])
        self.assertEqual(''.join(root[-1].itertext()), '查看要求并准备。')

    def test_images_attribution_links_attachments_and_formula_survive(self):
        root, compiler = self.compile('<p>作者：<cite type="user" user-name="原作者" user-id="private-id" /></p><callout emoji="💡">提示<b>保留</b></callout><img src="image-token" alt="分流图"/><figure><source name="原始课件.pdf" token="private-token" /></figure><p><cite doc-id="doc-token" title="下一篇"/><latex>Y\\leq_p X</latex></p>')
        result = ET.tostring(root, encoding='unicode')
        self.assertIn('作者：原作者', result)
        self.assertNotIn('private-', result)
        self.assertEqual(root.find('img').get('src'), 'https://nkustudy.top/guide-media/chart.png')
        self.assertEqual(compiler.attachments, 1)
        self.assertEqual(root.find('div/a').text, '附件 · 原始课件.pdf')
        self.assertEqual(root.find('p/a').get('href'), 'https://nkustudy.top/guides/handbook-next/')
        self.assertEqual(root.find('p/span/sub').text, 'p')

    def test_public_content_rejects_unsafe_links_and_redacts_contacts(self):
        root, _ = self.compile('<p>电话13812345678，微信：private123 <a href="javascript:alert(1)">仍保留标签</a><span style="position:fixed" onclick="alert(1)">正文</span></p>')
        result = ET.tostring(root, encoding='unicode')
        self.assertNotIn('13812345678', result)
        self.assertNotIn('private123', result)
        self.assertNotIn('javascript:', result)
        self.assertNotIn('onclick', result)
        self.assertIn('仍保留标签', result)
        self.assertEqual(module.safe_url('https://[bad-host'), '')

    def test_table_cells_and_missing_images_are_not_silently_lost(self):
        root, _ = self.compile('<table><tr><th colspan="2">课程</th></tr><tr><td>必修</td><td>选修</td></tr></table>')
        self.assertEqual(root.find('table/tr/th').get('colspan'), '2')
        self.assertEqual([n.text for n in root.findall('table/tr/td')], ['必修', '选修'])
        with self.assertRaisesRegex(ValueError, 'no archived public mapping'):
            self.compile('<img src="missing-image"/>')


if __name__ == '__main__':
    unittest.main()
