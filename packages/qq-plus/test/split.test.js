import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitForQQ } from '../lib/split.js'

test('短句（< minChars）不切分，直接返回 1 段', () => {
  const shortText = '这是一句只有几十个字的简短回答。'
  const result = splitForQQ(shortText, { minChars: 120 })
  assert.deepEqual(result, [shortText])
})

test('多个短句合并到 targetChars 以内，不产生碎段', () => {
  const threeSentences = '这是第一句短话。这是第二句短话。这是第三句短话。'
  const result = splitForQQ(threeSentences, { minChars: 20, targetChars: 100, maxSegments: 3 })
  assert.equal(result.length, 1)
  assert.equal(result[0], threeSentences)
})

test('长段文本切分为 2–3 段，且严格保存在 maxSegments 限制内', () => {
  const text = [
    '第一部分内容开始叙述，详细解释相关的背景和原理。',
    '第二句话继续深入探讨具体的实现细节，包括架构设计和模块划分。',
    '第三句话阐述在实际运行环境中的表现和性能考量。',
    '第四句话分析可能遇到的边界情况与异常恢复机制。',
    '第五句话总结经验教训并指出后续的优化方向。',
    '第六句话补充说明测试验证的标准和验收流程。',
  ].join('')

  const result = splitForQQ(text, { minChars: 60, targetChars: 80, maxSegments: 3 })
  assert.ok(result.length >= 2 && result.length <= 3)

  // 拼接还原校验：strip 掉空白后，所有字完整保留
  const cleanOriginal = text.replace(/\s+/g, '')
  const cleanJoined = result.join('').replace(/\s+/g, '')
  assert.equal(cleanJoined, cleanOriginal)
})

test('群聊场景群聊上限限制（groupMaxSegments: 2）', () => {
  const text = [
    '第一句解释背景并提出问题。',
    '第二句详细列举当前面临的挑战和阻碍。',
    '第三句探讨可能的解决思路与技术方案。',
    '第四句给出具体的行动计划与分工安排。',
  ].join('')

  const result = splitForQQ(text, { minChars: 30, targetChars: 40, isGroup: true, groupMaxSegments: 2 })
  assert.equal(result.length, 2)
  const cleanOriginal = text.replace(/\s+/g, '')
  const cleanJoined = result.join('').replace(/\s+/g, '')
  assert.equal(cleanJoined, cleanOriginal)
})

test('中文引号、感叹号与省略号正常吸附在前句末尾', () => {
  const text = '她说：“这真的是太棒了！”大家都跟着欢呼……随后会议室里爆发了热烈的掌声。随后进入了下一个讨论环节。'
  const result = splitForQQ(text, { minChars: 20, targetChars: 30, maxSegments: 3 })
  assert.ok(result.length >= 2)
  // 引号必须完整跟随感叹号
  assert.ok(result[0].includes('“这真的是太棒了！”'))
  assert.ok(result[0].includes('欢呼……') || result[1].includes('欢呼……'))
})

test('英文句号不切断小数点、版本号及常用缩写', () => {
  const text = 'The price of v1.2 is $3.14 per license. Please check e.g. the documentation carefully. We will release an update soon!'
  const result = splitForQQ(text, { minChars: 40, targetChars: 50, maxSegments: 3 })
  assert.ok(result.length >= 2)
  assert.ok(result[0].includes('v1.2 is $3.14'))
  assert.ok(result[0].includes('e.g.') || result[1].includes('e.g.'))
})

test('围栏代码块保持整块不被切断（即使内部包含句号）', () => {
  const text = `这里是介绍代码的说明文本，需要足够长以触发断句切分逻辑。现在我们来看看下面的代码块实现。

\`\`\`javascript
function calculate() {
  const a = 1.0;
  console.log("hello. world.");
  return a + 2;
}
\`\`\`

代码块执行完毕之后，我们继续进行后续的结果分析和数据汇报工作，请大家仔细核对。`

  const result = splitForQQ(text, { minChars: 50, targetChars: 60, maxSegments: 3, protectCode: true })
  assert.ok(result.length >= 2)
  // 查找包含代码块的段
  const codeSegment = result.find((s) => s.includes('```javascript'))
  assert.ok(codeSegment)
  assert.ok(codeSegment.includes('console.log("hello. world.");'))
  assert.ok(codeSegment.includes('```\n') || codeSegment.endsWith('```'))
})

test('GFM 表格保持完整不被切断', () => {
  const text = `下面是详细的数据统计报表，请各位同事对照查看各项指标的完成情况并做好记录。

| 模块名称 | 状态 | 覆盖率 |
| :--- | :--- | :--- |
| Core.Logic | 正常 | 98.5% |
| Network.IO | 预警 | 76.2% |

以上就是本周所有核心模块的健康状态总览，如有疑问请随时提出。`

  const result = splitForQQ(text, { minChars: 40, targetChars: 60, maxSegments: 3, protectCode: true })
  assert.ok(result.length >= 2)
  const tableSeg = result.find((s) => s.includes('| 模块名称 |'))
  assert.ok(tableSeg)
  assert.ok(tableSeg.includes('| Core.Logic | 正常 | 98.5% |'))
  assert.ok(tableSeg.includes('| Network.IO | 预警 | 76.2% |'))
})

test('URL 链接完整保留不被切断', () => {
  const text = '请访问官方管理后台地址 https://example.com/api?param1=test.1&param2=value.2 进行在线认证和状态查询。查完之后请在群内回复确认。'
  const result = splitForQQ(text, { minChars: 30, targetChars: 40, maxSegments: 3 })
  assert.ok(result.length >= 2)
  const urlSeg = result.find((s) => s.includes('https://example.com/api?param1=test.1&param2=value.2'))
  assert.ok(urlSeg)
})

test('长段落无句末标点时保持完整，不按空格强拆', () => {
  const text = 'abcdefghij '.repeat(20) // 220 字符连续英文单词无标点
  const result = splitForQQ(text, { minChars: 50, targetChars: 80, maxSegments: 3 })
  assert.deepEqual(result, [text.trim()])
})

test('空文本与全空白返回空数组', () => {
  assert.deepEqual(splitForQQ(''), [])
  assert.deepEqual(splitForQQ('   \n\n  '), [])
  assert.deepEqual(splitForQQ(null), [])
})

test('QQ 实例：node 24、npm 预检保持同句，不按空格拆开发送', () => {
  const text = '装完了，全过：node 24、npm 预检过、加载自检过、dsh --dump-config OK，现在 mnemon_status 是健康的，heart-main 空着。' +
    '一处跟她说的不一样：压缩包顶层没有 mnemon-install/ 目录，解开是散在 /root 的，我收进 /root/mnemon-install/ 再跑的。' +
    '要紧的是：现在两套记忆并存（heart 和 Mnemon），怎么分工得定，不然我记东西会分裂——这个等她定。'
  const firstSentence = text.slice(0, text.indexOf('。') + 1)
  for (const targetChars of [12, 30, 55]) {
    const parts = splitForQQ(text, { minChars: 120, targetChars, maxSegments: 4 })
    assert.ok(parts.some(part => part.includes(firstSentence)))
    assert.equal(parts.join(''), text)
  }
})

test('QQ 实例：main 分支、tag 还没打不被按空格拆成三条', () => {
  const text = '装好了，0.19.0（main 分支，tag 还没打），加载自检和 dump-config 都过。' +
    '源码和 heart 数据我都备份在 /root/.dsh/backups/heart-upgrade-20261030-235005/。' +
    '现在重启，会断一会儿。新版默认还是 legacy 模式，不动旧记忆，可以放心。'
  for (const targetChars of [12, 30, 55]) {
    const parts = splitForQQ(text, { minChars: 120, targetChars, maxSegments: 4 })
    assert.ok(parts.some(part => part.includes('0.19.0（main 分支，tag 还没打）')))
    assert.equal(parts.join(''), text)
  }
})

test('长句内部的单换行不是发送边界，句末之后仍可分段', () => {
  const first = '今天这个问题我想了很久，决定先把当前版本保存下来，\n然后再继续研究断句机制，因为我们更希望她能够完整地说完一句话，而不是在中间突然停住。'
  const second = '接下来我会先检查配置和发送链路。'
  assert.deepEqual(splitForQQ(first + second, { minChars: 1, targetChars: 30 }), [first, second])
})

test('英文长句及分号子句保持完整，下一完整句子可以另发', () => {
  const first = 'I want this complete sentence to remain in one message; splitting it at arbitrary spaces makes technical instructions harder to follow.'
  const second = 'Please check the result.'
  assert.deepEqual(splitForQQ(first + ' ' + second, { minChars: 1, targetChars: 40 }), [first, second])
})

test('空行仍可作为段落边界，受段数限制时完整保留正文', () => {
  const paragraphs = ['第一段没有句号也应保持完整', '第二段也没有句号但是独立一段', '第三段继续说明情况', '第四段最后补充一句']
  const text = paragraphs.join('\n \n')
  const parts = splitForQQ(text, { minChars: 1, targetChars: 10, maxSegments: 2 })
  assert.equal(parts.length, 2)
  for (const paragraph of paragraphs) assert.ok(parts.some(part => part.includes(paragraph)))
  assert.equal(parts.join('').replace(/\s/g, ''), text.replace(/\s/g, ''))
})
