# Changelog

## 0.1.0

- 建立可选 Linnkit AI SDK adapter workspace package、生产出口、conformance 测试出口和独立构建边界。
- 迁入 canonical request、usage、continuation、failure 和 stream reliability 投影。
- 迁入 language stream orchestration、factory registry 与全部 Provider conformance，删除 Host 旧 language 执行路径。
- 具体 language Provider 依赖、版本与 factory 收口到 package，并按 Provider/capability 拆分独立模块。
- 增加 Host failure classifier 与脱敏 diagnostic sink 扩展点，不向通用 adapter 泄漏 Cloud/Logger 语义。
- 增加真实 tarball CJS/ESM/DTS import 与两轮 canonical tool round-trip 门禁。
- 增加按 capability 或 npm package 选择受影响 conformance 的定向升级命令，并输出脱敏 suite/package 诊断。
- 将 `@ai-sdk/deepseek` 从 `3.0.28` 升级到 `3.0.29`，接收上游对空字符串 tool-call ID 的修复，并以 DeepSeek 定向 conformance、全矩阵和真实 tarball smoke 完成首个单 Provider patch 升级演练。
- 补齐 MIT 许可证、npmjs public/provenance 元数据、Node 22 engines 和发布前门禁，使 package 可以先于 Linnkit Quickstart 切换独立发布；本次只准备制品，不执行 npm 发布。
