# AGENTS.md

## 项目

`opencode-venice-auth`：magpie / OpenCode v1 的 Venice.ai provider 插件。TypeScript 源码直发（Bun 直接运行），没有构建步骤。入口为 `index.ts`，Venice 接口在 `src/venice.ts`，登录钩子在 `src/auth.ts`，测试在 `test/`。

## 准备

每个新 shell 先确保 bun 在 `PATH` 中：

```sh
export PATH="$HOME/.bun/bin:$PATH"
bun install
```

- `bun install` 生成/更新 `node_modules` 与 `bun.lock`；`node_modules` 不入库，`bun.lock` 入库。
- bun 未安装时：`curl -fsSL https://bun.sh/install | bash`（用户已批准），安装到 `~/.bun`。

## 检查三连

按顺序执行，任一失败都必须修复后重跑：

```sh
export PATH="$HOME/.bun/bin:$PATH"
bun test
bun run typecheck
uvx pluvy --all
```

退出码与结果口径：

- `bun test`：非 0 即失败，必须修复；不得删除/跳过测试或放宽断言来制造通过。
- `bun run typecheck`：报错必须修复。pluvy 不做类型推断，`tsc` 是独立保留的类型门禁。
- `uvx pluvy --all`：
  - exit 0 且报告文件数 **> 0** 才算通过（警告类 findings 不阻断；文件数为 0 属假通过）。
  - exit 1 = 代码问题，必须改代码；禁止用抑制注释或修改 `.pluvy/pluvy.json` 绕过（策略文件任何变更都需用户批准）。
  - exit 2 = 环境/配置问题，不算通过，须排查原因后重跑。

## pluvy 代码硬约束

- 不写 `any`、`unknown`、`object` 或空对象类型标注；用具体字段的 `interface`/类型。
- 不用 `as` 类型断言（`as const` 除外），不用非空断言（`!`）。
- `catch` 必须重抛，或做有实质意义的处理；不吞错。
- `JSON.stringify` 的结果只能进入 `console`/stdout/文件等输出，不得作为数据传给 `new Response(...)`、函数参数或内部消费者。
- 测试必须有实质断言，禁止恒真断言。

## 导入边界

- `src/*` 不得 import 入口 `index` / `index.ts`；依赖方向只能是入口依赖 `src`。
- `src/venice.ts` 不得 import `src/auth.ts`、`src/models.ts`、`src/usage.ts`（含对应无扩展名模块路径）。
- B/C 组预留装配点：`index.ts` 的 `server` 返回值，以及 `createAuth()` 返回对象；不要改动既有边界。

## 沙箱测试命令模板（tester 执行）

```sh
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache \
  MAGPIE_ADDR=127.0.0.1:3499 /Applications/magpie.app/Contents/MacOS/magpie "$@"; }
```

沙箱目录与 magpie CLI 绝对路径按实际环境确认；coder 不执行沙箱验证。
