import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, formatConversationProjection } from '../lib/budget.js';

const entries = (...content) => content.map((text) => ({ content: text }));

test('自动投影包含包装在内最多 120 字、100 估算 Token 和三条完整记忆', () => {
  const long = '在约定完成之前不会改变原来的偏好'.repeat(10);
  const projection = formatConversationProjection(entries(long, '喜欢EVA', '每年种树', '听过樱花草', '吃过桂花糕'));
  assert.equal(projection, '[小满的回忆: 1. 喜欢EVA; 2. 每年种树; 3. 听过樱花草]');
  const nearLimit = formatConversationProjection(entries('山'.repeat(50), '水'.repeat(52), '🌙'.repeat(30)));
  assert.ok(nearLimit.length <= 120);
  assert.ok(estimateTokens(nearLimit) <= 100);
  assert.match(nearLimit, /2\. 水/);
  assert.equal(formatConversationProjection(entries(long)), '');
  assert.equal(formatConversationProjection([]), '');
});

test('挂件保持单行且将宿主模板括号作为字面文本', () => {
  const projection = formatConversationProjection(entries('项目名是\n  {{alpha}}'));
  assert.equal(projection, '[小满的回忆: 1. 项目名是 ｛｛alpha｝｝]');
});
