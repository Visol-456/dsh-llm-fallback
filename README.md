# @visol-456/dsh-llm-fallback

[English](README.md) | 中文

DeepSeek Harness 的 provider fallback chain 插件——当主 provider 失败时，同一请求会自动在下一个配置的 `(provider, model)` 条目上重试，限流、超时或临时不可用的 provider 不会直接终结一轮对话。

> DeepSeek Harness `dsh-plugin` 生态的社区插件，不属于官方仓库。

## 开发原因

由于众所周知的原因，deepseek要涨价了，对于我一个学生直接用不起了，于是只能去投奔opencode-go。然而，opencode-go的海外链接非常不稳定，挂了代理都不行，在长程任务中经常出错暂停，单 provider 部署在服务不稳定时会直接失败：

- 限流与配额错误
- 服务端错误、5xx 抖动
- 超时与传输层故障

本插件为每条链维护一份按优先级排序的 `(provider, model)` 路由表，跟踪连续可切换失败（熔断器），并自动把请求故障切换到下一个健康条目。后续请求会继续使用当前服务条目，直到冷却结束、对链头的一次探测成功为止。

## 快速开始

```bash
npm i @visol-456/dsh-llm-fallback
```

在 `cordis.yml` 中挂载插件：

```yaml
- name: '@visol-456/dsh-llm-fallback'
  config:
    fallbacks:
      - provider: pi-ai
        model: glm-4.5
    switchCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, UNKNOWN_MODEL, TIMEOUT, TRANSPORT]
    failureThreshold: 1
    cooldownMs: 30000
```

请求本身永远是链头（你在 UI 里选的 provider/model，或部署默认值），永不被改写。`fallbacks` 列出请求失败后按顺序切换的备用目标。省略 `fallbacks` 键合法且插件保持休眠，所有请求原样放行；等你在 Web 界面的 Settings -> 回退链 页保存备用目标之后再生效。

## 部署到 web profile（dsh web）

### A. `dsh plugin add`（推荐）

本包声明了 `dsh.bundle`，安装后会作为 profile 层自动激活（无需手写 patch 文件——随包附带的 `cordis.patch.yml` 会以无备用目标挂载插件，目标在 UI 里创建）：

```bash
dsh plugin --profile web add @visol-456/dsh-llm-fallback
```

### B. 手动 patch 覆盖层

创建一个覆盖层文件（是 patch 列表，不是裸条目列表），用 `--patch` 应用：

```yaml
# cordis.yml
- insert:
    - id: llm-fallback
      name: '@visol-456/dsh-llm-fallback'
```

```bash
dsh web --patch ./cordis.yml
```

### patch 语法（最大的坑）

- 每个挂载条目必须有 `id`。
- 新增条目必须放在顶层 `- insert:` 列表里（参照 harness 的 `examples/web-schedule/cordis.yml`）。
- 裸条目列表会被静默拒绝：报 `patch: id is required for non-insert patches` / `entry "xxx" not found`，而且 **`dsh web` 启动不打印任何错误**（只有一行 `dsh web: http://...`）。
- 用以下命令诊断组合配置树（含 patch 错误）：

  ```bash
  node --import tsx/esm apps/cli/src/bin.ts web --dump-config --patch <file>
  ```

### 本地开发 junction 位置

`$DSH_HOME/profiles/node_modules` 是 launcher 维护的 bundle 回退目录，**不参与** cordis.yml 条目的裸 import 解析（loader 从 harness 源码位置向上走 Node 标准 node_modules 解析）。本地挂载未发布的 checkout，必须把 junction 建在 **harness 根 node_modules**：

```powershell
New-Item -ItemType Junction -Path 'E:\python_programs\deepseek-harness\node_modules\@visol-456\dsh-llm-fallback' -Target 'E:\python_programs\llm-fallback'
```

然后按名字挂载（见上）。不再需要时删除 junction。

### 不要重复挂 llm-retry

web profile 的 base bundle 已经自带 `@deepseek-ai/dsh-llm-retry`，重复挂载会叠加一层重试。只需挂 `llm-fallback` 一条——waterfall 顺序（先重试后回退）天然正确。

### pnpm supply-chain 策略

发布不足 24 小时的包会被 pnpm 的 `minimumReleaseAge` 拦截（`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`）；失败的 `pnpm add` 还可能改动官方仓库的 `pnpm-workspace.yaml`（用 `git restore pnpm-workspace.yaml` 恢复）。当天安装要么等 24 小时，要么走上面的 junction 方式。

### 端口被旧进程占用

`dsh web` 起不来（或浏览器打到旧实例）时，找到并结束旧进程：

```powershell
netstat -ano | findstr :3080
taskkill /PID <pid> /F
```

## 配置项

所有键都是顶层（不再有 `chains`/`match`）：

- `fallbacks`（需要路由时必填，至少一条）：按顺序排列的 `(provider, model)` 备用目标，请求失败后切换过去。请求本身是链头，永不被改写；条目不得重复 `(provider, model)` 组合。省略 `fallbacks` 键合法且插件保持休眠（可在 Settings -> 回退链 页创建，或写入 `<DSH_HOME>/settings.yaml`）。
- `switchCodes`（默认 `EMPTY_RESPONSE, RATE_LIMIT, SERVER, UNKNOWN_MODEL, TIMEOUT, TRANSPORT`，覆盖瞬时故障与配置错误类）：允许触发切换的失败码；其他错误码永不切换。
- `failureThreshold`（默认 1）：链头（或某个 fallback）上的连续合格失败数达到该值即打开熔断；冷却探测失败则无条件打开。
- `cooldownMs`（默认 0）：切换后链头在多长时间内保持排除、之后才可被再次探测。

> **建议**：把 `cooldownMs` 设为至少 `30000`。默认 `0` 意味着每个请求都会先探测链头，故障期间每个请求都会先在链头上失败一次，再被备用条目接管。

> **破坏性变更（0.1.x）**：配置曾用过 `chains[]` 里的 `providers`（0.1.0）或 `match` + `fallbacks`（更早的 0.1.1 快照）。这些都没了：链头永远是请求本身，只需顶层 `fallbacks` 列表（加上切换规则）。迁移：`chains: [{ match: { provider: A.provider, model: A.model }, fallbacks: [B, C] }]` → `fallbacks: [B, C]`。加载含旧 `chains`/`match`/`providers` 键的配置会报清晰弃用错误。

非空配置非法时，插件加载（或经 settings seam 保存时）会直接报错。

## 工作方式

- 链头就是请求本身（用户在 harness 首页聊天栏选的 provider/model，或部署默认值）。插件绝不改写链头；任何以可切换错误码失败的请求，都会按顺序在同一个全局 `fallbacks` 列表上重试。
- 失败请求只在实际服务的 provider 匹配、失败码在 `switchCodes` 内时才计。
- 链头的连续失败数达到 `failureThreshold`（或冷却探测失败）时，同一请求在 `fallbacks[0]` 上重试；之后每个 fallback 失败依次切到下一个。
- 链头冷却期间每个请求仍先试链头（它永不被改写）；可切换的链头失败会直接在当前服务的 fallback 上重试。
- 最后一个 fallback 永不切换；它的失败保持终态并按正常方式上抛。
- 成功响应会清零当前服务条目的连续失败计数并清除冷却标记，恢复后阈值从头累计。
- 插件不包装 `ctx.llm.stream()`：每次 adapter 调用仍是一次 provider 尝试，每次链尝试都会在同一份持久历史之上开启新的编号轮次。

## 事件

两个事件都是持久会话事件，永不呈现给模型。

- `llm/fallback`——每次切换时追加。载荷：`turn`、`step`、`headProvider`、`headModel`、`fromProvider`、`fromModel`、`toProvider`、`toModel`、`reason`（`threshold` | `probe`）、`failure`、`cooldownMs`。
- `llm/fallback-route`——每次请求实际由 fallback 目标服务时追加。载荷：`turn`、`step`、`headProvider`、`headModel`、`provider`、`model`（head = 触发路由的那个请求）。

## 已知限制

- **单一全局备用列表**：所有请求共享一个 `fallbacks` 列表；失败按实际服务的 `(provider, model)` 归因，一个 agent 的成功不会清除另一个 agent 的待定计数。
- **状态仅进程内**：活动条目、冷却与连续计数在重启后归零，重启后的部署会重新从链头探测；持久事件可用于事后审计，但无法还原实时状态。
- **仅 agent-loop 请求参与**：直接调用 `ctx.llm.stream()` 的消费者仍是单 provider。
- **always 模式重试不委派**：retry 策略为 `always` 的 provider 会自己重试一切，fallback 看不到它的失败。


## Web UI 配置（dsh web）

无需手写 `cordis.yml`，也可以在 Harness 的 Web 界面里编辑备用目标。插件加载到 `dsh web` profile 后，Settings 面板会出现一个 **回退链**（Fallback）页面（与 Models 并列）：

- 没有配置任何备用目标时，页面显示引导空状态：「还没有备用目标」+「添加备用目标」按钮；新建并保存的第一个目标在下一次请求生效。
- 编辑备用目标：每行都用**下拉选择**（provider 与 model 均取自 harness 模型目录；选中 provider 后联动刷新 model 列表，从根源杜绝手填出 `11111` 这类不存在的 model），上移/下移/删除按钮在行内右侧；切换错误码（宽输入框）、失败阈值与冷却时间在下方同一对齐网格里，然后点击 **保存**。
- 新增行在未选择前显示「请选择 provider / 请选择 model」占位，**不会**把目录里的第一个 provider 或 model 误显为已选中；provider 下拉只列出**当前可用**的 provider（即 harness 模型目录里真实存在 model 列表的路由），并显示其展示名（如官方的 `deepseek-official` 显示为 `DeepSeek`），休眠的 pi-ai 目录路由（如没有配置段的 `deepseek`）不会出现，避免同名/近名 provider 互相混淆。provider 只有一个 model 时自动选中它，选完即可保存。
- 保存的值写入 `<DSH_HOME>/settings.yaml`，并**在下一次请求**生效（无需重启）。解析顺序为 schema 默认 → `cordis.yml` 条目 → 已保存的 UI 段，因此 UI 保存优先，`cordis.yml` 未写的字段回落到默认值。
- **重置为 cordis.yml** 会清空已保存段，恢复纯 `cordis.yml` 行为（若条目无链则回到休眠模式）。
- 若其他窗口或设置文档修改了配置，页面会显示冲突横幅，提示先重新加载再应用。

浏览器通过插件在共享 web server 上提供的仅回环端点（`/llm-fallback/config`）读写该段。端点拒绝非回环来源与跨站请求；它是防误写/防跨站围栏，不是鉴权层。当 web server 绑定 `0.0.0.0` 时局域网客户端无法写入，但仍不建议将该端点暴露给不受信网络。

## 许可证

MIT
