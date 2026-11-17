import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {createDefaultLearningCompassService} from '../server/learning-compass-service.mjs';
test('versioned Feishu HTML preserves six images, outline anchors and original attribution', () => {
  const service = createDefaultLearningCompassService();
  const items = service.guides(new URLSearchParams('page_size=100')).items;
  let images = 0, headings = 0, attachments = 0;
  for (const item of items) {
    const detail = service.guide(item.id);
    const sections = detail.sections.filter(section => section.render_format === 'feishu-html-v1');
    assert.equal(sections.length, item.content_type === 'student_experience' ? 1 : 0);
    for (const section of sections) {
      assert.ok(section.body && section.body_html);
      assert.doesNotMatch(section.body_html, /user-id=|ou_[a-z0-9]{20,}|<script|onclick=|javascript:/i);
      assert.ok(detail.sources[0].publisher);
      images += [...section.body_html.matchAll(/<img src="https:\/\/nkustudy.top\/guide-media\//g)].length;
      attachments += [...section.body_html.matchAll(/>附件 · /g)].length;
      for (const heading of section.body_outline) {
        headings++;
        assert.ok(heading.title, item.id);
        assert.match(section.body_html, new RegExp(`<h[1-6] id="${heading.id}">`));
      }
    }
  }
  assert.equal(images, 6);
  assert.equal(attachments, 159);
  assert.equal(headings, 148);
});
test('student handbook provenance, six images and AI isolation',()=>{const service=createDefaultLearningCompassService();const items=service.guides(new URLSearchParams('page_size=100')).items;const students=items.filter(g=>g.content_type==='student_experience');assert.equal(students.length,15);assert.equal(items.length-students.length,18);let images=0;for(const g of students){const d=service.guide(g.id);assert.match(d.sources[0].official_page_url,/^https:\/\/nankai.feishu.cn\/wiki\//);const body=d.sections.map(s=>s.body).join('\n');assert.doesNotMatch(body,/user-id=|ou_[a-z0-9]{20,}|<script/i);for(const m of body.matchAll(/!\[[^\]]*\]\(https:\/\/nkustudy.top(\/guide-media\/[^)]+)\)/g)){images++;assert.ok(fs.existsSync('public'+m[1]));}}assert.equal(images,6);assert.ok(service.retrievalChunks().every(c=>!c.guide_id.startsWith('handbook-')));});
