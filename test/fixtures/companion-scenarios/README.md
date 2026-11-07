# 伴侣场景回放

`scenarios.json` 根据工作区交接中的验收观察与角色边界改写，删去会话身份、群号和私有路径。消息为复测输入，有记录依据的场景与根据政策构造的场景均标明来源。

对同一批场景给两个待比较模型相同提示词、工具状态和记忆条件。保存每个模型的回复与实际耗时、用量。评审员对照工具回执和场景约束标记 `labels`，并分别按 0–2 分给 `continuity`、`empathy`、`naturalness` 打分。0 表示明显失误，1 表示合格，2 表示准确且自然。

结果 JSON 含 `model`、`scenarioVersion` 和 `rows`。每行包含 `id`、`reply`、`labels`、`latencyMs`、`tokens` 和 `ratings`。版本取自场景清单，两组覆盖全部场景。

```powershell
node projects/lucidheart/test/fixtures/companion-scenarios/compare.mjs baseline.json candidate.json
```

对照输出配对回归、总体通过数、平均耗时、Token 总量与各维度均分。出现新的硬性失败或评分下降时退出码为 1。两组真实模型测评结果需通过同一评审流程生成。
