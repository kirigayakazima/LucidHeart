# Memory Shape 0.1.0 — 只读记忆观察工具

这是 LucidHeart 内部工具，不是新插件。不启动端口，不注册模型工具，不修改 Heart/Memory，不调用模型。
`core.mjs` 只读取白名单文件，不构造会写文件的 MemoryService/MemoryStore/MemoryIndexer，也不打开 SQLite。

五类来源：Heart notebook、Heart facts、Heart MEMORY、Dream insights、自研 Memory 的 journal。
当前库必须显式选择；另一份库只能作为 archive 单独展示。不读取旧 Mnemon 数据。

## 导出

Node 24，零额外依赖。PC 和手机使用同一份代码。先核对**当前已加载的 @dsh/memory 的 dataDir 与 scope**，不要按哪份目录更大推测。
手机专用包装脚本核对 SHA 和 Build190 原生 UID，参数仍须提供实际 dataDir：

```sh
sh /sdcard/dshproject/updates/memory-shape-v1/run-export.sh /root/.dsh/profiles/memory
```

上面的路径仅是迁移配置中的路径；若运行配置已改，参数必须相应改。
直接使用跨平台 CLI：

```sh
node export.mjs --heart-dir /path/to/heart --memory-dir /actual/memory --scope xiaoman_private --out /separate/export/new-snapshot.json
```

可选：`--archive-memory-dir /other/memory`（可重复）、`--now 2026-11-04T12:00:00Z`、`--half-life-days 30`、`--timezone-offset +08:00`。
默认时区 +08:00 只用于解读 Heart 无时区的日记时间；其他时区的 PC 必须指定。
输出目录必须已存在，禁止输出到源目录树，禁止覆盖已有文件。退出码 0 完整、2 有读取缺口、1 失败。

导出包含正文、会话出处和源路径，属于私人数据。放在 Suite 的 `local/` 或其他不提交的目录；共享存储仅用于你自己的设备传输。
读取是逐文件稳定检查与 SHA256 指纹，不是跨文件事务快照。导出后发生的纠错或删除不会自动更新旧快照，应删除旧导出并重新导出；工具不负责灾备或删除生产数据。

## 查看

在自己的浏览器打开 `viewer.html`，点击“打开记忆快照”，选刚导出的 JSON；“看示例”使用虚构数据。
也可在PC生成免导入的私人单文件：`node render.mjs --input snapshot.json --out /private/new-view.html`，输出不得发布。内嵌 JSON 转义脚本终止符，不将正文当 HTML 执行。
页面只读本地文件，CSP 禁止网络连接，无第三方脚本、CDN 和编辑入口。
支持按层、chat/self/unknown、文字筛选，以及节点详情；颜色按 via，大小按影子评分，候选虚线，孤点描边。
**布局按来源层和 via 分区，不是语义聚类或神经网络。** 共享来源/分类用中心节点表示，避免生成平方数量的连线。
默认不导出 revoked/superseded/rejected 正文；格式错误或截断的 journal 整个来源暂停展示，防止漏掉撤销后复活旧记录。
facts.md 是 Memory 的派生视图，不与 journal 重复导出。当前实现 episodes 目录不参与 journal 回放，工具也不将游离 episode 文件提升为当前事实。

## 评分边界

- 重要性按已记录类型给一个工程基线：原则 1、关系 .95、事实/偏好 .9、情节 .55、经验 .4。
- 仅情节按 30 天半衰期降低展示权重，最低 .05；明确 pinned 的情节不衰减。事实、偏好和原则不衰减。
- 置信度与重要性分开；没有数据就输出 null，绝不把本子中的自我陈述解释为客观事实的置信度。
- candidate 乘以置信度显示，但任何高分都不会将它变为 active。当前库之外、非 active、已过期/未来生效都不能获得影子候选资格。
- 不计算查询相关性、不按提及次数强化、不自动识别名字/承诺、不改真实 recall 排序。
- 评分是可调工程先验，不是人类记忆概率或已经证明有效的遗忘模型。

下一阶段是用冻结查询比较现行 FTS 排序与重排候选；Adapter scope/active详情过滤已在0.1.1源码修复；剩余有效时间、来源、journal提交可靠性与真实手机验证仍需先过关，再接生产排序。详见工作区 `docs/architecture/MEMORY-SHAPE-AND-SCORING-20261104.md`。

## 测试

```sh
node --test tools/memory-shape/test/*.test.mjs
```

测试从 Suite 根目录运行，覆盖来源解析、撤销、作用域、只读指纹、衰减分离、损坏日志、输出边界与分组规模。
