# TypeScript for Nanobug

[English](README.md)

独立 TypeScript 插件统一管理项目上下文和原生编译器工作进程。0.1.10 是实施候选，尚未发布。已测默认组合为 Windows x86-64、Node 24.19.0 和 TypeScript 5.9.3。最近配置根或推断源文件目录拥有独立宿主连接生命周期；共享源快照仍以原始工作区为访问边界。

适配契约 1.1 支持显式请求生态组合。异步准备通过 `plugin.services >=1.2` 的 OpenSet 和 `contribution-contract.json` 发现贡献；引用由 TS 持有，模块只由宿主封闭导出授权加载。独占 slot、ABI 不兼容或顺序环明确失败。成员或选择变化使受影响组合退休，包含原先为空的集合。旧单适配调用继续兼容；需要生态发现的消费者声明适配契约 >=1.1。

标准 LSP 提供 JS/JSX/TS/TSX 的补全及详情、诊断、悬浮、定义、引用、跨文件重命名和格式化。引擎接收编辑器未保存快照，不写源文件；配置项目与推断项目通过各消费者独立的引用共享。显式指定不兼容 SDK 会报错，不静默回退。四种语言分别声明可选择的 Tree-sitter 高亮提供者，固定来源、摘要和许可证随包放入 `grammar/`。

编译器输入按字节限额并等待有序管道写入完成；引擎暂停读取时，文档分发保留背压。适配器准入失败只在候选进程已结束或尚未创建时，返回带版本的导入释放回执。访客快照为空，不把编译器引用或未完成调用当作持久状态恢复。

公共协作服务的精确 schema 见 `contracts.json`，调用与权限规则写在 `src/lib.rs`、`native/control.mjs` 和 `native/adapters.mjs` 注释中。适配器必须由宿主签发不可变导出，匹配 ABI、TS 版本和完整文件摘要后，才进入 TS 管理的独立进程。每次挂接都重新核对闭包，拒绝未列入的邻接文件。Node 模块钩子限定普通 require/import 只能加载该闭包及选定引擎，且禁用项目里的 tsserver 插件。原生模块仍具有进程权限；文件系统、VM/eval 及其他操作系统行为不具备 WASM 沙箱保障。

构建时使用包含新公开 SDK 的宿主，执行 [英文构建步骤](README.md)。`node build.mjs --stage` 必须使用 Node 24.19.0，固定运行时和 TypeScript 的完整依赖包含在包内；上游授权文本保留在 `licenses/`。访客只通过宿主 `--plugin-cargo` 使用 SDK，不引用宿主源码路径。

验证命令：`node --test --test-concurrency=1 test/*.test.mjs`、`node node_modules/typescript/bin/tsc -p jsconfig.json`、`cargo fmt --check`。跨仓 Vue 验收需显式设置 `NANOBUG_VUE_FIXTURES` 为 Vue 插件仓库目录；未设置时该测试跳过，不能计为通过。

当前限制：仅准入 TS 5.9.3。导航和编辑限于工作区，外部 SDK/库目标会明确拒绝。配置、extends/引用配置以及各级 package/lockfile 的变化会提升代次；在这些证据不变时替换已安装依赖仍需宿主退休旧配置。已激活项目更换适配器也需要宿主退休旧配置。消费者快照向量需包含相关未保存依赖。宿主闭环、Vue 主提供者委托和完整生命周期验收完成前，不声明生产就绪。
