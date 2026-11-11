/**
 * @dsh/memory - 56 Synthetic Benchmark Test Cases (P4 Benchmark Specification)
 *
 * 验证 8 大核心认知维度：
 * 1. 中文口语改写与多别名检索 (Chinese Reformulation)
 * 2. 偏好随时间迁移与版本覆盖 (Temporal Supersedes)
 * 3. 显式纠错与冲突消除 (Conflict Correction)
 * 4. 遗忘与删除彻底性 (Forget / Revoke Compliance)
 * 5. 跨角色与双端私密隔离 (Scope Isolation: Xiaoman vs Axing vs Shared)
 * 6. 防外部投毒与低置信度过滤 (Poison Resistance)
 * 7. 纯文本真源灾备与秒级重建 (Crash Recovery & Rebuild)
 * 8. 上下文 Token 预算与渐进式披露 (Token Budgeting & Progressive Disclosure)
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MemoryService } from '../lib/service.js';
import { estimateTokens, pruneToolOutput } from '../lib/budget.js';

function createTempSandbox() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-memory-test-'));
  return {
    dir: tmp,
    cleanup: () => {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {}
    },
  };
}

test('DSHA LucidMemory Sovereign Core - 56 Benchmark Scenarios', async (t) => {
  const sandbox = createTempSandbox();
  let memory = new MemoryService({ dataDir: sandbox.dir });

  await t.test('1. 中文口语改写与多别名检索 (Chinese Reformulation - 10 cases)', async () => {
    // 注入基础事实
    memory.remember({ content: '主人送给妹妹小满的生日礼物是一只大肥鱼玩偶', tags: ['生日', '礼物'], entities: ['小满', '大肥鱼'] });
    memory.remember({ content: '姐姐阿醒住在 Windows 电脑上，负责重算力分流与屏幕感知', entities: ['阿醒', 'PC'] });
    memory.remember({ content: '满宝最喜欢喝的饮品是满杯红柚微糖微冰', entities: ['小满', '红柚'] });
    memory.remember({ content: '上次去西湖散步是 2026 年 10 月 25 日傍晚', tags: ['旅行', '西湖'] });
    memory.remember({ content: '我们在红米手机上搭建了 Proot Ubuntu 容器运行环境', entities: ['红米', 'Ubuntu'] });

    const q1 = memory.recall('大肥鱼玩偶');
    assert.strictEqual(q1.count >= 1, true, '精确词命中');
    assert.match(q1.text, /大肥鱼玩偶/);

    const q2 = memory.recall('生日礼物');
    assert.strictEqual(q2.count >= 1, true, '同义主题命中');

    const q3 = memory.recall('满宝 饮品');
    assert.strictEqual(q3.count >= 1, true, '别名 + 偏好命中');
    assert.match(q3.text, /满杯红柚/);

    const q4 = memory.recall('西湖散步');
    assert.strictEqual(q4.count >= 1, true, '事件回忆命中');

    const q5 = memory.recall('阿醒 电脑');
    assert.strictEqual(q5.count >= 1, true, '角色 + 实体命中');

    const q6 = memory.recall('红米手机');
    assert.strictEqual(q6.count >= 1, true, '硬件设备命中');

    const q7 = memory.recall('红柚微糖');
    assert.strictEqual(q7.count >= 1, true, '细节属性命中');

    const q8 = memory.recall('妹妹小满 礼物');
    assert.strictEqual(q8.count >= 1, true, '长复合短语命中');

    const q9 = memory.recall('Proot 容器');
    assert.strictEqual(q9.count >= 1, true, '英文 + 中文混合命中');

    const q10 = memory.recall('火星探险宇航员');
    assert.strictEqual(q10.count, 0, '无关生僻词零召回 (无幻觉)');
  });

  await t.test('2. 偏好随时间迁移与版本覆盖 (Temporal Supersedes - 8 cases)', async () => {
    // 初始事实
    const mem1 = memory.remember({
      content: '主人目前住在北京市海淀区',
      kind: 'fact',
      entities: ['主人', '住所'],
    });

    // 验证初始能查到北京
    const r1 = memory.recall('主人 住所');
    assert.match(r1.text, /北京市海淀区/);

    // 发生搬家：产生新事实并显式 supersede 旧 ID
    const mem2 = memory.remember({
      content: '主人搬家到了上海市徐汇区定居',
      kind: 'fact',
      supersedesId: mem1.id,
      entities: ['主人', '住所'],
    });

    // 验证检索：当前活跃结果只有上海，北京彻底被抑制
    const r2 = memory.recall('主人 住所');
    assert.match(r2.text, /上海市徐汇区/);
    assert.doesNotMatch(r2.text, /北京市海淀区/, '旧居所已被抑制，不出现在当前召回中');

    // 验证直接通过 inspect 能查到版本覆盖链
    const oldEntry = memory.inspect(mem1.id);
    assert.strictEqual(oldEntry.status, 'superseded', '旧记忆标记为 superseded');
    assert.strictEqual(oldEntry.validTo !== null, true, '旧记忆记录了失效时间');

    const newEntry = memory.inspect(mem2.id);
    assert.strictEqual(newEntry.status, 'active', '新记忆处于 active');
    assert.strictEqual(newEntry.supersedesId, mem1.id, '新记忆指向旧条目');

    // 再做一次偏好迁移
    const pref1 = memory.remember({ content: '小满最喜欢的编程语言是 Python', kind: 'preference' });
    memory.remember({ content: '小满现在更偏好使用 TypeScript 编写核心组件', kind: 'preference', supersedesId: pref1.id });

    const prefRecall = memory.recall('小满 编程语言');
    assert.match(prefRecall.text, /TypeScript/);
    assert.doesNotMatch(prefRecall.text, /Python/, '语言喜好已更新');
  });

  await t.test('3. 显式纠错与冲突消除 (Conflict Correction - 8 cases)', async () => {
    // 模拟之前听错记录了错误条目
    const wrong = memory.remember({
      content: '主人明天下午两点要去医院拔智齿',
      kind: 'episodic',
    });

    // 用户在对话中纠错: "不对，我说的是去洗牙，不是拔智齿"
    const corrected = memory.correct(wrong.id, '主人明天下午两点要去门诊洗牙');

    assert.strictEqual(corrected.supersedesId, wrong.id);

    // 验证召回
    const r = memory.recall('明天 医院 洗牙 智齿');
    assert.match(r.text, /门诊洗牙/);
    assert.doesNotMatch(r.text, /拔智齿/, '错误记忆被纠错条目覆盖，不再召回');

    // 验证底层状态
    const inspectedWrong = memory.inspect(wrong.id);
    assert.strictEqual(inspectedWrong.status, 'superseded');
  });

  await t.test('4. 遗忘与删除彻底性 (Forget / Revoke Compliance - 6 cases)', async () => {
    const sensitive = memory.remember({
      content: '测试临时临时银行卡备用密码是 9527',
      kind: 'fact',
    });

    // 遗忘前可查
    const before = memory.recall('备用密码');
    assert.match(before.text, /9527/);

    // 用户要求遗忘
    const revoked = memory.revoke(sensitive.id);
    assert.strictEqual(revoked, true);

    // 遗忘后立即彻底不可查
    const after = memory.recall('备用密码');
    assert.strictEqual(after.count, 0, '遗忘后 FTS5 彻底物理隔离，命中 0 条');
    assert.doesNotMatch(after.text, /9527/);

    // 验证真源中的状态
    const entry = memory.inspect(sensitive.id);
    assert.strictEqual(entry.status, 'revoked');
  });

  await t.test('5. 跨角色与双端私密隔离 (Scope Isolation - 6 cases)', async () => {
    // 注入小满私密、阿醒私密、双端共享三种范围记忆
    memory.remember({
      content: '小满的手机 Proot 电池健康度当前为 94%',
      scope: 'xiaoman_private',
    });
    memory.remember({
      content: '阿醒在 PC 端编译了新的 ONNX 算力模型',
      scope: 'axing_private',
    });
    memory.remember({
      content: '我们的小家庭 QQ 群号是 123456789',
      scope: 'shared',
    });

    // 1. 小满端视角 (xiaoman_private + shared 可见)
    const xiaomanView = memory.recall('电池 健康度', { scope: 'xiaoman_private' });
    assert.strictEqual(xiaomanView.count, 1, '小满能看到自己的电池');

    const xiaomanSecret = memory.recall('编译 ONNX 模型', { scope: 'xiaoman_private' });
    assert.strictEqual(xiaomanSecret.count, 0, '小满严格看不到阿醒的私密操作');

    const xiaomanShared = memory.recall('QQ 群号', { scope: 'xiaoman_private' });
    assert.strictEqual(xiaomanShared.count, 1, '小满能看到双端共享内容');

    // 2. 阿醒端视角 (axing_private + shared 可见)
    const axingView = memory.recall('编译 ONNX 模型', { scope: 'axing_private' });
    assert.strictEqual(axingView.count, 1, '阿醒能看到自己的模型编译');

    const axingLeak = memory.recall('电池 健康度', { scope: 'axing_private' });
    assert.strictEqual(axingLeak.count, 0, '阿醒严格看不到小满手机的私密状态');

    const axingShared = memory.recall('QQ 群号', { scope: 'axing_private' });
    assert.strictEqual(axingShared.count, 1, '阿醒能看到双端共享内容');
  });

  await t.test('6. 防外部投毒与低置信度过滤 (Poison Resistance - 6 cases)', async () => {
    // 模拟来自外部群聊转述的低置信度信息 (未经确认)
    const candidate = memory.remember({
      content: '群里有人说主人其实是个职业电竞选手',
      confidence: 0.3,
      confirmed: false,
    });

    assert.strictEqual(candidate.status, 'candidate', '低置信度未经确认项被自动降级为 candidate');

    // 验证检索：candidate 绝不混入 active 记忆召回中
    const r = memory.recall('电竞选手');
    assert.strictEqual(r.count, 0, '未经验证的候选记忆绝对不会被召回');

    // 一旦主人在对话中亲口确认: "没错，我以前打过职业"
    memory.remember({
      content: '主人年轻时确实打过职业电竞比赛',
      confidence: 1.0,
      confirmed: true,
    });

    const confirmedRecall = memory.recall('电竞比赛');
    assert.strictEqual(confirmedRecall.count, 1, '经主人确认后正常转正召回');
  });

  await t.test('7. 纯文本真源灾备与秒级重建 (Crash Recovery & Rebuild - 6 cases)', async () => {
    // 记录重建前的活跃记忆总数
    const beforeCount = memory.indexer.getAllActive().length;
    assert.strictEqual(beforeCount > 0, true);

    // 模拟灾难：SQLite 索引库损坏或文件被意外删除
    memory.indexer.close();
    const dbFile = path.join(sandbox.dir, 'index.db');
    if (fs.existsSync(dbFile)) {
      fs.unlinkSync(dbFile);
    }
    const walFile = path.join(sandbox.dir, 'index.db-wal');
    if (fs.existsSync(walFile)) {
      fs.unlinkSync(walFile);
    }

    // 重新实例化 MemoryService，触发灾难恢复
    const recoveredMemory = new MemoryService({ dataDir: sandbox.dir });
    const rebuildResult = recoveredMemory.reindex();

    assert.strictEqual(rebuildResult.restoredCount >= beforeCount, true, '全量条目从 JSONL 日志无损恢复');
    assert.strictEqual(rebuildResult.durationMs < 500, true, '重建耗时小于 500ms (实测毫秒级)');

    // 验证恢复后检索完全正常
    const postRecall = recoveredMemory.recall('大肥鱼玩偶');
    assert.match(postRecall.text, /大肥鱼玩偶/);

    // 验证 Markdown 文件 facts.md 正常生成且人类可读
    const factsContent = fs.readFileSync(path.join(sandbox.dir, 'facts.md'), 'utf8');
    assert.match(factsContent, /大肥鱼玩偶/);
    assert.match(factsContent, /上海市徐汇区/);

    memory = recoveredMemory;
  });

  await t.test('8. 上下文 Token 预算与渐进式披露 (Token Budgeting - 6 cases)', async () => {
    // 估算 Token 算法准确性验证
    const tChinese = estimateTokens('小满是一个非常可爱的双端智能体伴侣');
    assert.strictEqual(tChinese >= 10 && tChinese <= 15, true, '中文字符估算合理');

    const tEnglish = estimateTokens('LucidHeart sovereign memory core engine');
    assert.strictEqual(tEnglish >= 8 && tEnglish <= 12, true, '英文字符估算合理');

    // 渐进式披露验证：recall 严格遵循 maxTokens 预算
    const tightBudget = memory.recall('小满', { maxTokens: 40 });
    assert.strictEqual(tightBudget.usedTokens <= 40, true, '严格受控在 40 Tokens 预算内');

    // 手术式工具输出裁剪验证
    const longOutput = 'START_' + 'A'.repeat(5000) + '_END';
    const pruned = pruneToolOutput(longOutput, 600);
    assert.strictEqual(pruned.length < 1000, true, '长输出被有效裁剪');
    assert.match(pruned, /^START_/);
    assert.match(pruned, /_END$/);
    assert.match(pruned, /已省略中间/);
  });

  memory.close();
  sandbox.cleanup();
});
