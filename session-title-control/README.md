# @local/session-title-control

会话标题的两个增强：

1. **失败自动重试**：替换内置的首问标题 provider；单次模型调用失败时最多重试 5 次（指数退避 + 抖动），每次尝试仍有独立的超时上限。
2. **手动重排标题**：按当前会话内容（全部人类提问 + 最近一条助手回复的摘要）重新生成标题。入口有两个：
   - 会话头部的「重排标题」按钮（slot `conversation.session.header.actions`）
   - 输入框命令 `/retitle`（立即返回，后台生成）

标题仍由 `@deepseek-ai/dsh-session-title` 写入 `session/title` 事件，侧栏通过正常投影更新，不会进入模型上下文。

## 为什么不用内置的 `@deepseek-ai/*` 包

profile 里用 `link:` 安装的包位于 profile 目录之外，桌面宿主的 runtime 解析器不会为这个根映射应用内的裸包名（实测 `ERR_MODULE_NOT_FOUND`）。因此 `index.js` 只依赖 `node:` 内置模块与 `ctx` 服务：

- `ctx.sessionTitle.register/refresh/get`
- `ctx.llm.prepareCall(...).stream(...)`
- `ctx.sessions`、`ctx.commands`、`ctx.webServer`

模型调用、输入裁剪、超时与流式装配都由本包自己完成，不依赖内置 title provider 的代码。

## 安装（组合包形态，零手改配置）

包自带 `cordis.patch.yml`，里面已经写好两件事：禁用内置的 `session-title-llm`，插入本 provider。安装时不需要再编辑任何 YAML。

产物二选一（都已生成）：

- 目录：`D:\f30082294\dsh_workspace\session-title-control\`
- 压缩包：`local-session-title-control-1.0.0.tgz`（`pnpm pack` 生成，推荐迁移用，自带全部文件）

装到别的 profile / 别的机器：

```powershell
# 目录或 tgz 都可以；会写入依赖、追加到 dsh.profile.bundles，并发布 runtime resolution
dsh plugin --profile <profile 名> add D:\path\to\local-session-title-control-1.0.0.tgz
```

`desktop` profile 例外：启动器禁止 CLI 管理它（`profile "desktop" is managed exclusively by the Electron application`），要在应用的 **设置 → 插件** 页里用同一条路径安装，或直接按本机现状使用。

安装器做的三件事，等价于手工步骤（仅供核对）：

1. 在 profile 的 `package.json` 里加依赖；
2. 把包名追加到 `dsh.profile.bundles`（组合包层，位于用户 patch 之前）；
3. 重新组合 profile —— 首次需要重启才一定生效，本机实测通过 HMR 也能立即挂上。

卸载：

```powershell
dsh plugin --profile <profile 名> remove @local/session-title-control
```

它会同时从 `dsh.profile.bundles` 移除、卸载依赖并发布新的 resolution。

## 覆盖参数（可选，仍然零 YAML 也能用）

组合包里的默认值已经够用。要调，在 profile 的 `cordis.patch.yml` 里按 id 覆盖即可（用户层在组合包层之后应用）：

```yaml
- id: session-title-control
  config:
    maxAttempts: 5
    timeoutMs: 60000
```

## 本机现状

- 已作为组合包装在 `desktop` profile：依赖 `link:` + `dsh.profile.bundles` 中的 `@local/session-title-control`。
- 用户 patch 里只留了说明注释，没有标题相关的行；改参数请在注释下方按上面的 `- id:` 形式覆盖。

**注意**：如果某次启动时某个行导入失败，桌面版会判定 profile 损坏，把 `cordis.patch.yml` / `package.json` 备份成 `*.bak-<时间戳>` 并恢复默认 bundle 列表。本包只导入 `node:` 内置模块，正常情况下不会触发；改包后先 `node --check index.js`，再重启。

## 配置（profile patch 里）

| 键 | 现值 | 说明 |
| --- | --- | --- |
| `targetWords` / `targetCjkCharacters` | 5 / 10 | 标题长度目标（语言自适应） |
| `maxInputBytes` | 16384 | 单次请求输入上限；超长会话自动裁剪（首条 + 最近若干条） |
| `maxOutputTokens` | 4096 | 输出上限（不是目标长度；推理 token 计入） |
| `timeoutMs` | 30000 | **单次尝试**的超时 |
| `maxAttempts` | 5 | 总尝试次数（1–10） |
| `retryBaseDelayMs` / `retryMaxDelayMs` | 500 / 8000 | 退避区间（指数增长，±20% 抖动） |
| `provider` / `model` | 省略 | 可选固定路由；两者必须成对出现，否则启动即报错 |

最坏耗时 ≈ `maxAttempts × timeoutMs + 退避总和`，默认约 2.5 分钟；自动标题在后台跑，不阻塞主回答。

## 重试策略

- 可重试：路由/网络/限流/超时、`finish.kind === 'error'`、输出为空、输出含工具调用或触到 `max-tokens`。
- 不重试（立刻失败）：输入超 `maxInputBytes`、没有可用路由、`provider`/`model` 未成对、配置键未知。
- 每次失败写一条 `logger.warn`（`title attempt n/5 failed …`），每次尝试都会在会话日志里留一条 `session/title-llm-request`，便于核对次数。
- `request.signal` 被取消（用户停止、会话关闭）时立即结束循环。

## 手动重排

- `POST /plugin/session-title-control/retitle`，body `{ "sessionId": "…" }`，同步等待结果并返回 `{ ok, sessionId, title }`；失败返回 400 + `error`。
- `GET /plugin/session-title-control/retitle` 列出**当前打开**的会话及其 provider 标题（诊断用；标题来自确定性回退时这里显示 `null`）。
- 只对 live（已打开）会话有效：`refresh()` 需要会话在内存中。未打开时返回 `session is not open; open it in the app before regenerating the title`。
- 旧会话没有记录过 `request/header` 路由时，必须配置 `provider`/`model` 才能重排。

## 回滚

删除 profile patch 末尾的 `session-title-llm` 禁用项与 `insert` 行，重启即可回到内置行为；随后可把 `package.json` 里的 `link:` 依赖一并删掉。
