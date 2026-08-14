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
    chains:
      - providers:
          - provider: deepseek-official
            model: deepseek-v4-flash
          - provider: pi-ai
            model: glm-4.5
        switchCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]
        failureThreshold: 1
        cooldownMs: 30000
```

`chains` 是可选的：空数组（或缺省）合法且插件保持休眠，所有请求原样放行；等你在 Web 界面的 Settings -> 回退链 页保存链之后再生效。

## 部署到 web profile（dsh web）

### A. `dsh plugin add`（推荐）

本包声明了 `dsh.bundle`，安装后会作为 profile 层自动激活（无需手写 patch 文件——随包附带的 `cordis.patch.yml` 会以空链挂载插件，链在 UI 里创建）：

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

- `chains`（可选，默认 `[]`）：相互独立的链，以链头条目为键。空列表关闭路由（请求原样放行）；可在 Settings -> 回退链 页创建，或写入 `<DSH_HOME>/settings.yaml`。链之间不得共享任何 `(provider, model)` 条目，保证一个请求至多匹配一条链。
- `providers`（链内必填，至少两个）：有序的 `(provider, model)` 服务条目；链内条目不得重复。
- `switchCodes`（默认五个瞬时错误码）：允许触发切换的失败码；其他错误码永不切换。
- `failureThreshold`（默认 1）：服务条目上的连续合格失败数达到该值即打开熔断；冷却探测失败则无条件打开。
- `cooldownMs`（默认 0）：被切走的条目在多长时间内保持排除、之后才可被再次探测。

> **建议**：把 `cooldownMs` 设为至少 `30000`。默认 `0` 意味着每个请求都会先探测链头，故障期间每个请求都会先在链头上失败一次，再被备用条目接管。

非空配置非法时，插件加载（或经 settings seam 保存时）会直接报错。

## 工作方式

- 每条链按优先级列出两个及以上 `(provider, model)` 条目；第一个条目是链头，请求以它为键。
- 失败请求只记在路由它的那条链上，且仅当服务条目的 provider 实际服务了该请求、失败码在 `switchCodes` 内时才计。
- 当连续计数达到 `failureThreshold`（或冷却探测失败）时熔断打开，同一请求在下一条目上重试。
- 成功响应会清零服务条目的连续失败计数并清除冷却标记，恢复后阈值从头累计。
- 最后一个条目永不切换；它的失败保持终态并按正常方式上抛。
- 插件不包装 `ctx.llm.stream()`：每次 adapter 调用仍是一次 provider 尝试，每次链尝试都会在同一份持久历史之上开启新的编号轮次。

## 事件

两个事件都是持久会话事件，永不呈现给模型。

- `llm/fallback`——每次切换时追加。载荷：`turn`、`step`、`headProvider`、`headModel`、`fromProvider`、`fromModel`、`toProvider`、`toModel`、`reason`（`threshold` | `probe`）、`failure`、`cooldownMs`。
- `llm/fallback-route`——每次请求实际由非链头条目服务时追加。载荷：`turn`、`step`、`headProvider`、`headModel`、`provider`、`model`。

## 已知限制

- **provider 级归因**：失败只记在路由该请求的那条链上，以精确的 `(provider, model)` 条目为键；共享同一 provider（不同 model）的两条链互不影响，未被任何链路由的请求不产生计费。
- **状态仅进程内**：活动条目、冷却与连续计数在重启后归零，重启后的部署会重新从链头探测；持久事件可用于事后审计，但无法还原实时状态。
- **仅 agent-loop 请求参与**：直接调用 `ctx.llm.stream()` 的消费者仍是单 provider。
- **always 模式重试不委派**：retry 策略为 `always` 的 provider 会自己重试一切，fallback 看不到它的失败。


## Web UI 配置（dsh web）

无需手写 `cordis.yml`，也可以在 Harness 的 Web 界面里编辑回退链。插件加载到 `dsh web` profile 后，Settings 面板会出现一个 **回退链**（Fallback）页面（与 Models 并列）：

- 没有配置任何链时，页面显示引导空状态：「还没有回退链」+「新建第一条链」按钮；新建并保存的第一条链在下一次请求生效。
- 编辑链：增删/排序 `(provider, model)` 条目、切换错误码、失败阈值与冷却时间，然后点击 **保存**。
- 保存的值写入 `<DSH_HOME>/settings.yaml`，并**在下一次请求**生效（无需重启）。解析顺序为 schema 默认 → `cordis.yml` 条目 → 已保存的 UI 段，因此 UI 保存优先，`cordis.yml` 未写的字段回落到默认值。
- **重置为 cordis.yml** 会清空已保存段，恢复纯 `cordis.yml` 行为（若条目无链则回到休眠模式）。
- 若其他窗口或设置文档修改了配置，页面会显示冲突横幅，提示先重新加载再应用。

浏览器通过插件在共享 web server 上提供的仅回环端点（`/llm-fallback/config`）读写该段。端点拒绝非回环来源与跨站请求；它是防误写/防跨站围栏，不是鉴权层。当 web server 绑定 `0.0.0.0` 时局域网客户端无法写入，但仍不建议将该端点暴露给不受信网络。

## 许可证

MIT
