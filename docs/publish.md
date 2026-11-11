# 发布清单

本文件记录 `opencode-venice-auth` 的发布前检查、npm 发布路径和 magpie 社区列表登记路径。npm 发布由 GitHub Actions 流水线执行（`npm stage publish` 两段式 staging + 维护者 `npm stage approve`）；社区 registry.json PR 仍由维护者人工执行。

## 1. 发布前检查表

- [ ] 四门禁全绿：`bun test`、`bun run typecheck`、`uvx pluvy --all`、`uvx pluvy --base 05c2151`。两处 pluvy 都必须 exit 0 且报告文件数大于 0。
- [ ] README 中每条命令在干净沙箱重新核对：`git clone`/`cd`、`magpie plugin add ./`、`magpie plugin add https://github.com/Tomahawkd/opencode-venice-auth`、`magpie plugin login venice`、`magpie quota`，以及 Development 段的 `bun install`、`bun test`、`bun run typecheck`、`uvx pluvy --all`。
- [ ] 真实 key 登录后补测 `magpie provider test venice`，可用则补回 README Install 段。
- [ ] GitHub Actions 在待发布的 HEAD 上为绿。
- [ ] `package.json` 的版本号已按语义化版本提升（初始为 `0.1.0`，发布前按需提升；不要复用已发布的版本号）。
- [ ] 创建 GitHub Release：确认 `package.json` 的 `version` 与拟发布版本一致后，执行 `gh release create vX.Y.Z`（把 `X.Y.Z` 换成实际版本号；tag 必须与 `package.json` 的 `version` 一致）。Release 发布后流水线自动执行 `publish` job 完成 npm staging。
- [ ] `LICENSE`、`repository`、`author` 字段在场且正确。
- [ ] `npm pack --dry-run` 内容检查：应恰好 8 个文件——`index.ts`、`src/` 下 `auth`、`models`、`usage`、`venice` 四个文件、`README.md`、`LICENSE`、`package.json`；不得出现 `docs/` 过程文档、`test/`、`AGENTS.md`、`.pluvy/`、`.github/`、`bun.lock`、`tsconfig.json`。
- [ ] 密钥扫描：仓库和待发布包内没有 token、API key 或其他凭据。

## 2. 流水线发布路径

npm 发布由 GitHub Actions 的 `publish` job 执行：先用 `npm stage publish` 把包暂存到 npm，再由维护者在本机用 `npm stage approve` 批准公开（两段式）。

### 2.1 一次性前置

1. 在 GitHub 仓库配置 `NPM_TOKEN` secret：`Settings → Secrets and variables → Actions → New repository secret`。首发时 npm 上还没有 `opencode-venice-auth`，无法创建仅限本包的 token，因此首发使用**全部包范围**的 token。发布成功后立即收窄：
   1. 在 npm 账户创建仅限 `opencode-venice-auth` 的 token；
   2. 用新 token 更新 GitHub Actions 的 `NPM_TOKEN` secret；
   3. 撤销宽范围 token。
2. 维护者本机执行 `npm login`：`npm stage list/view/download/approve` 使用本机登录态。
3. npm 账户启用 2FA：`npm stage approve` 需要 2FA 设备确认。

### 2.2 发版步骤

1. 提升 `package.json` 的 `version` 并提交。
2. push 到 `main`，等待 CI 的 `checks` job 为绿。
3. 创建并发布 GitHub Release，tag 必须与 `package.json` 的 `version` 完全一致：`gh release create vX.Y.Z`（把 `X.Y.Z` 换成实际版本号）。Release 发布后流水线自动执行 `publish` job：先做版本一致性硬校验，再运行 `npm stage publish ./`；成功后 stage 处于待 approve 状态。

正式发版前可手动触发 `workflow_dispatch` 做 dry-run 预演（`publish` job 以 `--dry-run` 运行，不占版本号，npm 上保持未发布）：

```sh
gh workflow run ci.yml --ref main
```

### 2.3 核对与 approve 操作

流水线成功后，在维护者本机核对 staged 内容：

```sh
npm stage list
npm stage view <stage-id>
npm stage download <stage-id>
```

`npm stage download` 下载的 tarball 解包后应恰好 8 个文件：`index.ts`、`src/` 下 `auth`、`models`、`usage`、`venice` 四个文件、`README.md`、`LICENSE`、`package.json`。

确认无误后批准（需要 2FA）：

```sh
npm stage approve <stage-id>
```

有疑虑则拒绝该次 staging，修正后重新走发版流程：

```sh
npm stage reject <stage-id>
```

发布后核验：

1. npm 包页面上 README 正常渲染。
2. 在干净沙箱中实测 `magpie plugin add opencode-venice-auth`。
3. 实测通过后，把该 npm 安装命令补进 README 的 Install 段。

### 2.4 失败处理

- **版本不一致**：流水线版本校验输出 `::error` 并以非 0 退出。对齐 `package.json` 版本与 tag 后重新创建 Release，或在 Actions 页面重跑 `publish` job。
- **staging 失败**：在 Actions 页面重跑 `publish` job。若 workflow 本身有错，需要新提交修复后再走发版流程；Release 上的重跑使用 tag 提交时的旧 workflow，这也是正式发版前必须先做 `workflow_dispatch` dry-run 预演的原因。
- **内容不对**：执行 `npm stage reject <stage-id>`，修正后重新走发版流程。
- **首发回退**：在 npm 的 unpublish 窗口内（发布后 72 小时内，且无其他包依赖该版本），可用 `npm unpublish opencode-venice-auth@X.Y.Z` 撤销刚发布的版本；若整个包尚未被使用，也可用 `npm unpublish opencode-venice-auth --force` 撤销包。操作需要本机 npm 登录与 2FA；超出窗口时只能发布修复版本，具体限制以 npm 当时文档为准。

## 3. 社区 registry.json PR 路径

由维护者人工执行：

1. fork 并 clone `magpie-community/plugins`。
2. 在 `registry.json` 的 `plugins` 数组末尾追加下面的条目。保持与现有条目一致的两行式排版；这是自有仓库发布的包，按约定**不加 `community` 字段**。
3. 提交 PR，说明包已发布、GitHub Actions 为绿。

magpie 最多每 6 小时刷新一次社区列表，PR 合并后列表出现延迟属正常现象。

## 4. registry.json 条目草稿

```json
{ "package": "opencode-venice-auth", "name": "Venice", "icon": "https://venice.ai/favicon.ico", "providers": ["venice"],
  "summary": { "en": "Venice.ai text models with your API key: live model list with pricing and capabilities, plus key balances and rate limits.", "zh": "用你的 Venice API key 使用 Venice.ai 文本模型：动态模型列表含定价与能力，显示余额与限流上限。" } }
```
