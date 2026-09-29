# 贡献指南

感谢你考虑为 `@visol-456/dsh-llm-fallback` 做贡献。这是 DeepSeek Harness `dsh-plugin` 生态的社区插件，不属于官方仓库。

## 开发环境

仓库使用 npm（已提交 `package-lock.json`）。

```bash
npm install
npm run typecheck   # 同时检查 node 与 client 两个 program
npm test            # vitest run
npm run build       # 先 tsc（node + client），再 tsdown
```

- `src/index.ts`、`src/circuit.ts` 是服务端半（路由与纯熔断状态机）。
- `src/client/*` 是浏览器半（Plugins 页配置表单）。
- `tests/*.spec.ts` 覆盖熔断器、loader 组合、settings 传输与 client 半。`tests/client-inject.spec.ts` 把 client `inject` 列表钉死为浏览器半实际读取的每个命名空间；改 client 时必须让它保持通过。

## 兼容性

`package.json` 把 DeepSeek Harness `peerDependencies` 钉在已验证的版本（`0.2.0-rc.2`）。未针对该 harness 版本验证前，不要放宽或升级这些依赖。

## 文档约定

- `README.md` 是中文入口，`README_en.md` 是英文入口；两者都面向用户，必须保持同步且简洁。
- 深度技术内容放在 `docs/technical-reference.zh.md`（中文）与 `docs/technical-reference.md`（英文），不要写进 README。
- 修改任一语言时必须同步另一语言，然后重新记录 `README.i18n.yaml` 中的哈希：

  ```bash
  git hash-object README.md README_en.md docs/technical-reference.zh.md docs/technical-reference.md CONTRIBUTING.zh.md CONTRIBUTING.md
  ```

- 使用仓库相对链接（`docs/...`、`../README.md` 等），确保在 GitHub 与 npm 上都能解析。用 `git diff --check` 检查空白错误，并确认每个相对链接的目标文件存在。

## 范围

PR 不应包含 `lib/`（生成物）、`node_modules/`，或与依赖变更无关的 `package-lock.json` 改动。发布、打 tag 与 publish 步骤仅由维护者执行。
