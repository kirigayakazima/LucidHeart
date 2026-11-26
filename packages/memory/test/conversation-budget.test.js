import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, formatConversationProjection } from '../lib/budget.js';

const entries = (...content) => content.map((text) => ({ content: text }));

test('自动投影最多 360 tokens 和五条完整记忆', () => {
  const long = '在约定完成之前不会改变原来的偏好'.repeat(40);
  const projection = formatConversationProjection(entries(long, '喜欢EVA', '每年种树', '听过樱花草', '吃过桂花糕', '养过金渐层', '爱唱小星星'));
  assert.equal(projection, '[小满的回忆: 1. 喜欢EVA; 2. 每年种树; 3. 听过樱花草; 4. 吃过桂花糕; 5. 养过金渐层]');
  const nearLimit = formatConversationProjection(entries('山'.repeat(200), '水'.repeat(200), '🌙'.repeat(400)));
  assert.ok(estimateTokens(nearLimit) <= 360);
  assert.match(nearLimit, /2\. 水/);
  assert.doesNotMatch(nearLimit, /🌙/);
  assert.equal(formatConversationProjection(entries(long)), '');
  assert.equal(formatConversationProjection([]), '');
});

test('挂件保持单行且将宿主模板括号作为字面文本', () => {
  const projection = formatConversationProjection(entries('项目名是\n  {{alpha}}'));
  assert.equal(projection, '[小满的回忆: 1. 项目名是 ｛｛alpha｝｝]');
});
