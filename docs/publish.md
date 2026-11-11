# 发布清单

本文件记录 `opencode-venice-auth` 的发布前检查、npm 发布路径和 magpie 社区列表登记路径。npm 发布由 GitHub Actions 流水线执行（`npm stage publish` 两段式 staging + 维护者 `npm stage approve`）；社区 registry.json PR 仍由维护者人工执行。

## 1. 发布前检查表

- [ ] 四门禁全绿：`bun test`、`bun run typecheck`、`uvx pluvy --all`、`uvx pluvy --base 05c2151`。两处 pluvy 都必须 exit 0 且报告文件数大于 0。
- [ ] README 中每条命令在干净沙箱重新核对：`git clone`/`cd`、`magpie plugin add ./`、`magpie plugin add https://github.com/Tomahawkd/opencode-venice-auth`、`magpie plugin login venice`、`magpie quota`，以及 Development 段的 `bun install`、`bun test`、`bun run typecheck`、`uvx pluvy --all`。
- [ ] 真实 key 登录后补测 `magpie provider test venice`，可用则补回 README Install 段。
- [ ] GitHub Actions 在待发布的 HEAD 上为绿。
- [ ] `package.json` 的版本号已按语义化版本提升（初始为 `0.1.0`，发布前按需提升；不要复用已发布的版本号）。
- [ ] `LICENSE`、`repository`、`author` 字段在场且正确。
- [ ] `npm pack --dry-run` 内容检查：应恰好 8 个文件——`index.ts`、`src/` 下 `auth`、`models`、`usage`、`venice` 四个文件、`README.md`、`LICENSE`、`package.json`；不得出现 `docs/` 过程文档、`test/`、`AGENTS.md`、`.pluvy/`、`.github/`、`bun.lock`、`tsconfig.json`。
- [ ] 密钥扫描：仓库和待发布包内没有 token、API key 或其他凭据。
- [ ] 创建 GitHub Release：确认已完成 §2.2 的发版步骤，即 push 后 `checks` 为绿且已通过 `workflow_dispatch` dry-run 预演，并确认 `package.json` 的 `version` 与拟发布版本一致，再执行 `gh release create vX.Y.Z`（把 `X.Y.Z` 换成实际版本号；tag 必须与 `package.json` 的 `version` 一致）。Release 发布后流水线自动执行 `publish` job 完成 npm staging。

## 2. 流水线发布路径

npm 发布由 GitHub Actions 的 `publish` job 执行：先用 `npm stage publish` 把包暂存到 npm，再由维护者在本机用 `npm stage approve` 批准公开（两段式）。

### 2.1 一次性前置

1. 在 GitHub 仓库配置 `NPM_TOKEN` secret：`Settings → Secrets and variables → Actions → New repository secret`。首发时 npm 上还没有 `opencode-venice-auth`，无法创建仅限本包的 token，因此首发使用**全部包范围**的 token；该 token 同样**不要开启 bypass 2FA**，写权限只选 **stage only**（stage-only token 可以创建新包）——这两项是 token 存放在 GitHub secret 期间限制泄漏后果的主要手段。发布成功后立即收窄：
   1. 在 npm 账户创建仅限 `opencode-venice-auth` 的 granular token，同样**不要开启 bypass 2FA**、写权限只选 **stage only**；
   2. 用新 token 更新 GitHub Actions 的 `NPM_TOKEN` secret；
   3. 撤销宽范围 token。
2. 维护者本机执行 `npm login`：`npm stage list/view/download/approve` 使用本机登录态。
3. npm 账户启用 2FA：`npm stage approve` 需要 2FA 设备确认。

### 2.2 发版步骤

按以下编号顺序完成，不得跳过：

1. 提升 `package.json` 的 `version` 并提交。
2. push 到 `main`，等待 CI 的 `checks` job 为绿。
3. **必须做 `workflow_dispatch` dry-run 预演**：执行

   ```sh
   gh workflow run ci.yml --ref main
   ```

   等待 `publish` job 成功，并核对 npm 上**拟发布版本尚未公开**：首次发布（包尚不存在）时确认包仍为 404；包已存在（含 `0.0.0-stage` 占位）时确认该版本未出现在 npm 版本列表中，且本次 dry-run 未产生新的待审 staging（`npm stage list opencode-venice-auth` 无新增条目）。预演失败不得进入下一步。dry-run 不占版本号，也不上传内容；版本一旦发布，同版本的 dry-run 会失败，因此预演必须在创建 Release 之前完成。
4. 创建并发布 GitHub Release，tag 必须与 `package.json` 的 `version` 完全一致：`gh release create vX.Y.Z`（把 `X.Y.Z` 换成实际版本号）。Release 发布后流水线自动执行 `publish` job：先做版本一致性硬校验，再运行 `npm stage publish ./`；成功后 stage 处于待 approve 状态。

> 包首次发布（npm 上尚不存在该包）时，第 4 步的 `npm stage publish` 会**立即在 npm 上公开创建包**，并出现一个 `0.0.0-stage` 占位版本；真实版本内容在维护者 approve 之前不会公开。

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

- **版本不一致**：流水线版本校验输出 `::error` 并以非 0 退出。不要在 Actions 页面重跑——重跑沿用原事件的提交与原 tag，必然再次失败。按以下顺序补救：
  1. `gh release delete vX.Y.Z --cleanup-tag` 删除 Release 与指向旧提交的 tag；
  2. 对齐 `package.json` 的 `version` 与拟发布的 tag 版本并 push 到 `main`；
  3. 回到 §2.2 第 2 步重新走完整发版步骤（等待 `checks` 为绿，并重新做第 3 步 dry-run 预演）；预演通过后再用对齐后的 tag 创建 Release：`gh release create vX.Y.Z`。
- **staging 失败**：job 失败不代表 staging 未生效——若 `npm stage publish` 已成功、后续步骤（如 stage list）失败，npm 远端已有该 staging 产物。重跑前先在本机执行 `npm stage list` 或查看该次 run 的 summary 确认状态，不要盲目重跑（同版本重复 staging 会被拒绝）。若确认 staging 未产生且 workflow 本身无误，才在 Actions 页面重跑 `publish` job。若 workflow 本身有错，需要新提交修复并 push；推送后同样要 `gh release delete vX.Y.Z --cleanup-tag` 清掉指向旧提交的 Release 与 tag，然后回到 §2.2 第 2 步重新走完整发版步骤（含重新 dry-run 预演），预演通过后再在新提交上重新创建 Release——直接在旧 Release 上重跑，用的是 tag 提交时的旧 workflow。这也是 §2.2 要求正式发版前必须先做 `workflow_dispatch` dry-run 预演的原因。
- **内容不对**：执行 `npm stage reject <stage-id>`，修正后重新走发版流程。
- **首发回退**：npm 现行政策下，满足额外条件的包即使在发布 72 小时之后仍可能允许撤回，具体以 npm 当时的 unpublish 政策文档为准。可用 `npm unpublish opencode-venice-auth@X.Y.Z` 撤销刚发布的单个版本；若整个包尚未被使用，也可用 `npm unpublish opencode-venice-auth --force` 撤销整个包。**撤回后的版本号不可复用**，不能再次发布同一版本号。操作需要本机 npm 登录与 2FA；不满足撤回条件时只能发布修复版本。

  reject 或单版本 unpublish 之后，包名仍被 `0.0.0-stage` 占位版本占用；若要彻底撤回整个包，需执行 `npm unpublish opencode-venice-auth --force`。

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
