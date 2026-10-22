# MoveLite 浏览器模型与运行组件来源

这些文件保留本项目分发的第三方模型、JavaScript 与 WebAssembly 组件的许可证和来源。
应用自身代码的许可证不覆盖这些第三方组件。上游文件按原文保留；未修改模型权重、运行组件或许可证正文。

## 模型

- 原始模型：BAAI/bge-small-zh-v1.5。官方模型卡标注 MIT，并说明发布模型可免费商用。模型卡版本 `7999e1d3359715c523056ef9478215996d62a620`。
- ONNX 适配：Xenova/bge-small-zh-v1.5，固定版本 `75c43b069aac4d136ba6bc1122f995fedcfd2781`。该模型卡链接至 BAAI 原始模型。本项目分发其 q8 权重、配置及分词器；同时保留两份模型卡与模型卡所链接的 FlagEmbedding MIT 许可证。
- 原始模型卡：https://huggingface.co/BAAI/bge-small-zh-v1.5/blob/7999e1d3359715c523056ef9478215996d62a620/README.md
- ONNX 模型卡：https://huggingface.co/Xenova/bge-small-zh-v1.5/blob/75c43b069aac4d136ba6bc1122f995fedcfd2781/README.md
- 模型许可证来源：https://github.com/FlagOpen/FlagEmbedding/blob/master/LICENSE

## 运行组件

- Transformers.js 3.8.1：Apache License 2.0。保留其 LICENSE；固定版本 npm 发行包未另附 NOTICE 文件。
- ONNX Runtime Web：`1.22.0-dev.20250409-89f8206ba4`，对应 Transformers.js 3.8.1 的锁定依赖；保留 Microsoft MIT 许可证和该提交的完整 ThirdPartyNotices.txt。该通知覆盖上游多种构建使用的组件；并不表示 MoveLite 浏览器版本包含其中每一种组件。
- @huggingface/jinja 0.5.3：MIT，保留 npm 发行包 LICENSE。
- 另保留 ONNX Runtime Web 依赖图中的 flatbuffers、long、platform、protobufjs 和 @protobufjs 工具包发行版许可证，便于随本地打包的运行组件一同分发。guid-typescript 1.0.9 的 npm 元数据声明 ISC，但其发行包与上游仓库没有独立 LICENSE 文件；保留该版本的完整 npm 元数据，不编造上游版权文本。

## 来源和校验

- `license-provenance.json` 记录许可证与模型卡下载地址、大小及 SHA-256。
- `transitive-license-provenance.json` 记录 npm 依赖许可证及其固定版本 jsDelivr 元数据哈希校验结果。
- `asset-integrity-and-dependencies.json` 记录从官方最新取得的固定版本元数据复核结果，以及 Transformers.js 3.8.1 package-lock 中的依赖版本。
- 模型的四个小 JSON 文件按 Hugging Face 固定版本 Git Blob SHA-1 校验，计算方法为 `SHA1("blob " + 字节长度 + NUL + 原始字节)`。ONNX 权重按该版本 LFS SHA-256 校验。
- 三个运行文件按 jsDelivr 对固定 npm 版本公布的 SHA-256 校验。八个文件也均重新计算 SHA-256，与已有缓存清单相符。

官方实现参考：

- https://github.com/huggingface/transformers.js/blob/3.8.1/src/utils/hub.js
- https://github.com/huggingface/transformers.js/blob/3.8.1/src/backends/onnx.js
- https://github.com/huggingface/transformers.js/blob/3.8.1/package-lock.json
- https://github.com/microsoft/onnxruntime/blob/89f8206ba4/LICENSE
- https://github.com/microsoft/onnxruntime/blob/89f8206ba4/ThirdPartyNotices.txt

