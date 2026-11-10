# 发布清单

本文件记录 `opencode-venice-auth` 的发布前检查、npm 发布路径和 magpie 社区列表登记路径。npm 发布与 registry.json PR 由维护者人工执行。

## 1. 发布前检查表

- [ ] 四门禁全绿：`bun test`、`bun run typecheck`、`uvx pluvy --all`、`uvx pluvy --base 05c2151`。两处 pluvy 都必须 exit 0 且报告文件数大于 0。
- [ ] README 中每条命令在干净沙箱重新核对：`git clone`/`cd`、`magpie plugin add ./`、`magpie plugin login venice`、`magpie provider test venice`、`magpie quota`，以及 Development 段的 `bun install`、`bun test`、`bun run typecheck`、`uvx pluvy --all`。
- [ ] GitHub Actions 在待发布的 HEAD 上为绿。
- [ ] `package.json` 的版本号已按语义化版本提升（初始为 `0.1.0`，发布前按需提升；不要复用已发布的版本号）。
- [ ] 打 tag 并推送：`git tag vX.Y.Z && git push origin vX.Y.Z`（把 `X.Y.Z` 换成实际版本号）。
- [ ] `LICENSE`、`repository`、`author` 字段在场且正确。
- [ ] `npm pack --dry-run` 内容检查：应包含 `index.ts`、`src/`、`README.md`、`LICENSE`、`package.json`；确认没有不该发布的文件。
- [ ] 密钥扫描：仓库和待发布包内没有 token、API key 或其他凭据。

## 2. npm publish 路径

由维护者人工执行：

```sh
npm login
npm publish
```

项目直接发布 TypeScript 源码，没有构建步骤。发布后核验：

1. npm 包页面上 README 正常渲染。
2. 在干净沙箱中实测 `magpie plugin add opencode-venice-auth`。
3. 实测通过后，把该 npm 安装命令补进 README 的 Install 段。

## 3. 社区 registry.json PR 路径

由维护者人工执行：

1. fork 并 clone `magpie-community/plugins`。
2. 在 `registry.json` 的 `plugins` 数组中按包名字母序插入下面的条目。保持与现有条目一致的两行式排版；这是自有仓库发布的包，按约定**不加 `community` 字段**。
3. 提交 PR，说明包已发布、GitHub Actions 为绿。

magpie 最多每 6 小时刷新一次社区列表，PR 合并后列表出现延迟属正常现象。

## 4. registry.json 条目草稿

```json
{ "package": "opencode-venice-auth", "name": "Venice", "icon": "https://venice.ai/favicon.ico", "providers": ["venice"],
  "summary": { "en": "Venice.ai text models with your API key: live model list with pricing and capabilities, plus key balances and rate limits.", "zh": "用你的 Venice API key 使用 Venice.ai 文本模型：动态模型列表含定价与能力，显示余额与限流上限。" } }
```
