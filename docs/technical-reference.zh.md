# 技术参考

本文面向需要理解实现细节的使用者与维护者，涵盖完整配置字段、路由与熔断语义、会话事件载荷、已知限制、设置 UI 实现注意，以及 dsh profile 部署与 patch 诊断。只想快速上手请看 [README](../README.md)。

English version: [technical-reference.md](technical-reference.md)

## 1. 兼容性与包构成

| 项目 | 值 |
| --- | --- |
| 插件版本 | `0.2.0` |
| 兼容的 DeepSeek Harness | `0.2.0-rc.2`（`peerDependencies` 全部对齐该版本） |
| cordis | `~4.0.4` |
| cordis-plugin-loader | `~1.0.5` |
| schemastery | `~3.18.4`（运行时依赖） |

未在其他 dsh 版本上验证。dsh `0.2.0-rc.1` → `rc.2` 只改了官方子包版本与内部实现：本插件依赖的公开类型面没有破坏性变更（`dsh-api-remotes/client` 新增一个 `export type {}`，`dsh-client-ui-primitives` 新增 `MenuGroup` 并把 `Input` 改为 `forwardRef`，其余逐字节一致），因此插件源码无需随之改动；settings seam 仍是 `Volatile` Config 字段 + 浏览器端 `ctx.configForms`。

包声明 `dsh.bundle`，指向随包发布的 `cordis.patch.yml`，因此 `dsh plugin add` 会把插件作为 profile 层自动挂载（无备用目标、休眠）。两端构成：

- 服务端半：`src/index.ts`（路由与熔断）、`src/circuit.ts`（纯状态机）、`src/types.ts`（事件载荷类型）、`src/invariant.ts`（不变量校验）。
- 浏览器半：`src/client/index.ts`（注册配置页）、`src/client/FallbackBundleConfig.tsx`（表单）、`src/client/store.ts`（设置传输适配）。

## 2. 配置字段

所有键都是顶层；不存在 `chains` / `match`。配置经 `resolveConfig` 校验后才构建熔断器。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `fallbacks` | 无（省略即休眠） | 按顺序排列的 `(provider, model)` 备用目标，请求失败后按序切换。出现时至少一条，条目不得重复 `(provider, model)` 组合，`provider`/`model` 必须为非空字符串。 |
| `switchCodes` | `EMPTY_RESPONSE, RATE_LIMIT, SERVER, UNKNOWN_MODEL, TIMEOUT, TRANSPORT` | 允许触发切换的失败码；其他错误码永不切换。不能为空、不能重复、元素必须为非空字符串。 |
| `failureThreshold` | `1` | 链头（或某个 fallback）上的连续合格失败数达到该值即打开熔断；冷却探测失败则无条件打开。必须是 ≥1 的安全整数。 |
| `cooldownMs` | `0` | 切换后链头（或该 fallback）在多长时间内保持排除、之后才可被再次探测。必须是 `0..2147483647` 内的有限数（上限即 `MAX_TIMER_DELAY_MS`）。 |

其他规则：

- 省略 `fallbacks` 键合法且插件保持休眠，所有请求原样放行；写入空数组会报错（出现时至少一条）。
- 未知键报错；旧键 `chains` / `match` / `providers` 报带迁移提示的弃用错误，见第 6 节。
- 非空配置非法时，插件加载直接报错（schema 与跨字段规则都校验）。经设置表单写入的值由 Config schema 把关；schema 表达不了的跨字段规则（重复条目、空 `switchCodes` 等）在实时更新时重新校验，插件拒绝该次更新、保留上一份可用配置，并记录一条 warning。
- 配置解析顺序为 **schema 默认 → 组合层（bundle / `cordis.yml`）→ profile patch**，因此表单保存优先，未写过的字段回落到默认值。

> 建议把 `cooldownMs` 设为至少 `30000`。默认 `0` 意味着每个请求都会先探测链头，故障期间每个请求都会先在链头上失败一次，再被备用条目接管。

## 3. 路由与熔断语义

- **链头就是请求本身**：用户在 harness 首页聊天栏选的 provider/model，或部署默认值。插件绝不改写链头；任何以可切换错误码失败的请求，都会按顺序在同一个全局 `fallbacks` 列表上重试。
- **归因**：失败请求只在“实际服务的 provider 匹配、且失败码在 `switchCodes` 内”时才计数。切换标记精确绑定 `(agent, turn, step)`，因此只有消费了该次切换的那个重试请求才会被备用目标服务。
- **打开熔断**：链头连续失败数达到 `failureThreshold`（或冷却探测失败）时，同一请求在 `fallbacks[0]` 上重试；之后每个 fallback 失败依次切到下一个。
- **冷却与探测**：链头冷却期间每个请求仍先试链头（它永不被改写）；可切换的链头失败会直接在当前服务的 fallback 上重试（事件 `reason` 为 `probe`）。
- **终止**：最后一个 fallback 永不切换；它的失败保持终态并按正常方式上抛。
- **恢复**：成功响应会清零当前服务条目的连续失败计数并清除冷却标记，恢复后阈值从头累计。
- **不包装 `ctx.llm.stream()`**：每次 adapter 调用仍是一次 provider 尝试，每次链尝试都会在同一份持久历史之上开启新的编号轮次。
- **切换时的配置改写**：只有 `provider`/`model` 会被替换；`reasoningEffort` 会移除（它按链头模型的能力解析，由切换后的 adapter 重新解析自身默认值），其余 provider 中立字段原样保留。
- **与 llm-retry 组合**：waterfall 顺序为先重试后回退；retry 策略为 `always` 的 provider 会自己重试一切，fallback 看不到它的失败。

## 4. 会话事件

两个事件都是持久会话事件，永不呈现给模型。

`llm/fallback`——每次切换时追加。

| 字段 | 说明 |
| --- | --- |
| `turn` / `step` | 触发切换的失败请求所在轮次与步骤。 |
| `headProvider` / `headModel` | 链头的 provider / model。 |
| `fromProvider` / `fromModel` | 切换前服务的条目。 |
| `toProvider` / `toModel` | 将服务重试请求的条目。 |
| `reason` | `threshold`（连续失败达标）或 `probe`（冷却探测失败后重新打开）。 |
| `failure` | 触发切换的失败事实。 |
| `cooldownMs` | 切换时施加到该条目的冷却毫秒数。 |

`llm/fallback-route`——每次请求实际由 fallback 目标服务时追加。

| 字段 | 说明 |
| --- | --- |
| `turn` / `step` | 被路由请求所在轮次与步骤。 |
| `headProvider` / `headModel` | 触发路由的那个请求的链头 provider / model。 |
| `provider` / `model` | 实际服务该请求的条目。 |

## 5. 已知限制

- **单一全局备用列表**：所有请求共享一个 `fallbacks` 列表；失败按实际服务的 `(provider, model)` 归因，一个 agent 的成功不会清除另一个 agent 的待定计数。
- **状态仅进程内**：活动条目、冷却与连续计数在重启后归零，重启后的部署会重新从链头探测；持久事件可用于事后审计，但无法还原实时状态。
- **仅 agent-loop 请求参与**：直接调用 `ctx.llm.stream()` 的消费者仍是单 provider。
- **always 模式重试不委派**：retry 策略为 `always` 的 provider 会自己重试一切，fallback 看不到它的失败。

## 6. 历史兼容性

- **配置形状（0.1.x）**：配置曾用过 `chains[]` 里的 `providers`（0.1.0）或 `match` + `fallbacks`（更早的 0.1.1 快照）。这些都已移除：链头永远是请求本身，只需顶层 `fallbacks` 列表（加上切换规则）。迁移：`chains: [{ match: { provider: A.provider, model: A.model }, fallbacks: [B, C] }]` → `fallbacks: [B, C]`。加载含旧 `chains`/`match`/`providers` 键的配置会报清晰的弃用错误。
- **浏览器半 inject（0.1.8 修复）**：client 半必须声明 `'remote'` **和** `'remote.session'`。cordis 把每个已挂载的 Remote 命名空间解析成独立服务，只声明 `'remote'` 时 `api.session.modelCatalog()` 的属性访问会抛错，整个配置体渲染失败（表现为卡片页空白）。回归测试：`tests/client-inject.spec.ts`。
- **配置入口迁移（0.2.0）**：Fallback 配置从 Settings 弹窗内的独立 section 迁到 Plugins 页的 bundle 卡片页，与官方插件配置页同一套机制。

## 7. 设置 UI 实现注意

- 配置表单由**服务端半**注册，走 `ctx.configForms.whileServed`；只有 profile 真正把本插件挂进配置树时才存在。若只有 client 半进了页面（`__DSH_BOOT__.entries` 能看到包名）而服务端半未挂载，卡片仍在 **Installed** 列表里，但打开后没有配置控件——这是部署问题，不是源码问题（诊断见第 8 节）。
- 表单以 profile 条目 id 为键，本插件的 `id` 必须是 `llm-fallback`（与本包自带 `cordis.patch.yml` 一致）。换一个 id 挂载时回退逻辑照常工作，但 Web 页会显示「不可用」。
- Plugins 页以 **npm 包名**（`@visol-456/dsh-llm-fallback`）为 `plugins.bundle.config` 槽的 key，与应用该条目的 cordis entry id 不同。
- **未选择时的诚实占位**：新增行在未选择前显示「请选择 provider / 请选择 model」占位，不会把目录里的第一个 provider 或 model 误显为已选中；provider 下拉只列出 harness 模型目录里真实可用（即已加载 model 列表）的路由并显示展示名，休眠的 pi-ai 目录路由不会出现，避免同名/近名 provider 互相混淆；选中 provider 后联动刷新 model 列表，某 provider 只有一个 model 时自动选中它，行即可保存。
- 读写都走 harness 自身的 settings 传输（`ctx.configForms` 读、`settings.describe|mutate` 写），插件不自建 HTTP 端点；远端（非回环）页面能否写入由 harness settings 层决定。
- 保存写入当前 profile 的条目配置（`$DSH_HOME/profiles/<profile>/cordis.patch.yml`），并**在下一次请求**生效（无需重启）。表单编辑是一次 Volatile-only 配置更新，Loader 会把新值提交进运行中的配置引用并通知插件，插件据 `loader/volatile-update` 重建熔断器。
- **恢复默认值**会清除表单保存的四个字段（`fallbacks`、`switchCodes`、`failureThreshold`、`cooldownMs`），恢复组合层与 schema 默认行为。
- 若其他窗口或文档修改了配置，页面显示冲突横幅，提示先重新加载再应用；保存被拒绝时区分 `conflict` / `rejected` / `transport` 三类原因。
- 表单校验与节点 schema 保持一致：至少一条备用目标、provider/model 非空且不重复、`switchCodes` 非空、阈值为 ≥1 整数、冷却为 `0..2147483647` 整数。

## 8. 部署与 patch 诊断

### A. `dsh plugin add`（推荐）

```bash
dsh plugin --profile web add @visol-456/dsh-llm-fallback
```

本包声明了 `dsh.bundle`，安装后作为 profile 层自动激活，无需手写 patch 文件——随包的 `cordis.patch.yml` 以无备用目标挂载插件，目标在 UI 里创建。检查 `$DSH_HOME/profiles/<profile>/package.json`：本包必须同时出现在 `dependencies` 和 **`dsh.profile.bundles`** 数组里（只声明 client bundle／只装依赖是不够的）。

### B. 手动 patch 覆盖层

覆盖层文件是 **patch 列表**（不是裸条目列表），用 `--patch` 应用：

```yaml
# cordis.yml
- insert:
    - id: llm-fallback
      name: '@visol-456/dsh-llm-fallback'
```

```bash
dsh web --patch ./cordis.yml
```

这是**挂载新条目**的形式。如果插件已经由 bundle（`dsh plugin add`）挂载，要给它写入配置应使用按 `id` 定位的**覆盖** patch（不带 `insert`）——这也正是设置表单写入 profile 自身 patch 层的形状：

```yaml
# 覆盖已挂载条目的配置（非 insert，按 id 定位）
- id: llm-fallback
  config:
    fallbacks:
      - provider: pi-ai
        model: glm-4.5
```

patch 语法要点：

- 每个挂载条目必须有 `id`，且本插件的 `id` 必须是 `llm-fallback`（设置表单以该 profile 条目 id 为键）。
- 新增条目必须放在顶层 `- insert:` 列表里（可参照 harness 的 `examples/web-schedule/cordis.yml`）。
- 裸条目列表会被静默拒绝，报 `patch: id is required for non-insert patches` / `entry "xxx" not found`，而且 **`dsh web` 启动不打印任何错误**（只有一行 `dsh web: http://...`）。
- 诊断组合配置树（含 patch 错误）：

  ```bash
  dsh --profile web --dump-config | grep -i llm-fallback
  # 或从 harness 源码运行
  node --import tsx/esm apps/cli/src/bin.ts web --dump-config --patch <file>
  ```

  没有输出说明 profile 层没挂上本插件。

### 本地开发（未发布的 checkout）

把本地 checkout 装进 profile 即可：dsh 会以 profile 依赖（pnpm `link:`）安装它，并把该 bundle 追加到 `dsh.profile.bundles`。

```bash
dsh plugin --profile web add /absolute/path/to/dsh-llm-fallback
```

`dsh.profile.bundles` 里的 bundle 名由 `resolveBundleDir()` 按 **dsh 安装位置 → profile 目录** 的顺序解析（源码里就是 `for (const anchor of [installAnchor, join(profileDir, 'package.json')])`，见 `packages/boot/app-boot/src/profile.ts`）：安装自带的 bundle 始终从运行中的 dsh 安装解析；不在安装里的树外插件才落到 profile 目录，由 profile 自己的 `node_modules` 解析。因此本地 checkout 要先经 `dsh plugin add` 装进 profile，再按包名挂载。

### 安装与依赖注意

- **不要重复挂 `llm-retry`**：web profile 的 base bundle 自带 `@deepseek-ai/dsh-llm-retry`，重复挂载会叠加一层重试。只需挂 `llm-fallback` 一条。
- **pnpm supply-chain 策略**：发布不足 24 小时的包会被 pnpm 的 `minimumReleaseAge` 拦截（`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`）；失败的 `pnpm add` 还可能改动官方仓库的 `pnpm-workspace.yaml`（用 `git restore pnpm-workspace.yaml` 恢复）。当天安装要么等 24 小时，要么走上面的本地 checkout 安装方式。

## 9. 本仓库开发

构建、测试与类型检查命令见 [CONTRIBUTING.zh.md](../CONTRIBUTING.zh.md)。
