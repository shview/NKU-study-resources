import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createLearningCompassService } from '../server/learning-compass-service.mjs';
test('C++ candidate preserves existing guides and AI retrieval and exposes full rich text', () => {
  const base=JSON.parse(fs.readFileSync(new URL('../server/data/learning-compass-snapshot.json',import.meta.url)));
  const addition=JSON.parse(fs.readFileSync(new URL('../content/cpp-notes.json',import.meta.url)));
  const original=createLearningCompassService(base);
  const candidate=createLearningCompassService({...base,guides:[...base.guides,...addition.guides]});
  assert.deepEqual(candidate.retrievalChunks(),original.retrievalChunks());
  for(const guide of base.guides) assert.deepEqual(candidate.guide(guide.id),original.guide(guide.id));
  for(const guide of addition.guides){
    const dto=candidate.guide(guide.id);
    assert.equal(dto.sections[0].body_html,guide.sections[0].body_html);
    assert.equal(dto.sections[0].render_format,'feishu-html-v1');
    assert.ok(Buffer.byteLength(JSON.stringify(dto))<700000);
  }
});
