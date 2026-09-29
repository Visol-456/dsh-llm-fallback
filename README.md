# @visol-456/dsh-llm-fallback

[English](README_en.md) | 中文

DeepSeek Harness 的 provider fallback chain 插件：主 provider 失败时，同一个请求会自动在下一个配置的 `(provider, model)` 目标上重试，限流、超时或临时不可用的 provider 不再直接终结一轮对话。

> DeepSeek Harness `dsh-plugin` 生态的社区插件，不属于官方仓库。
>
> 当前插件版本 **0.2.0**，兼容 DeepSeek Harness **0.2.0-rc.2**（`peerDependencies` 对齐该版本，cordis `~4.0.4`、schemastery `~3.18.4`；未在其他 dsh 版本上验证）。

## 功能与行为

- 请求本身永远是链头（UI 里选的 provider/model，或部署默认值），插件绝不改写它；只有失败重试才会切到备用目标。
- 失败请求按顶层 `fallbacks` 顺序切换，最后一个备用目标不再切换，其失败按正常方式上抛。
- 按链头/备用目标的连续可切换失败计数打开熔断；冷却期内每个请求仍先试链头，探测失败则无条件再次切换。
- 无备用目标时插件保持休眠，所有请求原样放行；保存第一个目标后在下一次请求生效，无需重启。
- 每次切换、以及每次实际由备用目标服务的请求，都会写入持久会话事件（模型不可见）。
- 与 base bundle 自带的 `@deepseek-ai/dsh-llm-retry` 按 waterfall 顺序组合，只需挂 `llm-fallback` 一条，不要重复挂 `llm-retry`。

完整路由语义、字段规则与事件载荷见[技术参考](docs/technical-reference.zh.md)。

## 安装与最短可用配置

```bash
dsh plugin --profile web add @visol-456/dsh-llm-fallback
```

本包声明了 `dsh.bundle`，安装后会作为 profile 层自动激活；随包的 `cordis.patch.yml` 以**无备用目标**挂载插件（休眠状态）。装好后在 Web 界面创建备用目标即可：

侧边栏 **Plugins** → **Installed** 列表里的 **llm-fallback** 卡片 → 打开卡片页 → 用 provider/model 下拉框添加备用目标，调整切换错误码/失败阈值/冷却时间 → **保存**。

如需手动挂载或通过 `cordis.yml` 配置，请看[技术参考](docs/technical-reference.zh.md)。

## 插件页能力

- 备用目标逐行编辑：provider/model 联动下拉、行内上移/下移/删除；provider 下拉只列出 harness 模型目录里真实可用且已加载 model 列表的路由，并按展示名显示。
- 切换错误码（宽输入框）、失败阈值、冷却时间在同一表单内编辑；保存写入当前 profile 的条目配置，并在下一次请求生效。
- **恢复默认值**清除表单保存的四个字段，回到组合层与 schema 默认行为。
- 若配置在别处被修改，页面显示冲突横幅，提示先重新加载再重新应用。

## 文档

- [技术参考（中文）](docs/technical-reference.zh.md) / [Technical reference (English)](docs/technical-reference.md)：完整配置字段、路由与熔断语义、事件载荷、已知限制、设置 UI 实现注意、dsh profile bundle 激活与 patch 诊断。
- [贡献指南（中文）](CONTRIBUTING.zh.md) / [Contributing (English)](CONTRIBUTING.md)。

## 许可证

MIT
