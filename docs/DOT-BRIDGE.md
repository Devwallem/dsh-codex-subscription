# Your dot 连接组件：只读试验版

本 fork 以 `WSL043/dsh-codex-subscription` 的 `f041ae3e5785ca14ea6d175c98969039ce909d83`（2.5.0）为基础，保留 MIT 许可证和上游订阅功能。组件位于 `codex/dot-bridge-probe` 分支，未发布到 npm；安装上游 `dsh-codex-subscription@2.5.0` 不会得到该组件。

## 能做什么

提供独立的 DSH Cordis 插件入口 `dsh-codex-subscription/dot-bridge`，通过官方 MCP SDK 的 Streamable HTTP 暴露一个工具 `dsh_bridge_probe`。它返回桥接版本、DSH 版本、创建／恢复任务接口是否存在，可回显短随机字符串。

它不读取账号、订阅凭据、会话、项目文件或 MemOS，也不创建任务。返回值明确包含 `mode=probe_only`、`taskExecution=not_implemented`、`memoryAccess=not_exposed`。接口存在不是执行成功或知识可用的证明。

普通订阅插件入口和默认 `cordis.patch.yml` 不加载该组件；组件自身的 `enabled` 默认值也为 `false`。启用和卸载由 DSH 原生插件生命周期管理。无需安装 Codex CLI 来运行探针。

## 为什么保留两个接口方向

上游通过独立 OAuth 让 DSH 调用订阅模型，并可让 DSH 派 Codex 子任务。这些已有实现、兼容性判断和构建测试可以复用。

本组件的方向是 `Your dot → MCP → DSH`。它的访问权限独立于订阅 OAuth；已有 ChatGPT 登录不会自动授权 dot 控制 DSH。本组件不读取或复用上游的 access token、refresh token、账号 vault 或 `auth.json`。

## 在独立测试环境加载

先构建 fork，使用构建目录或本地候选包测试；不要用本组件替换正在运行的生产安装。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
```

给启动测试 DSH 的进程提供环境变量 `DSH_DOT_BRIDGE_TOKEN`。值应使用随机生成的 32 字节 base64url 字符串（43 字符），不要复用订阅凭据，不要写入 Git、聊天或公开配置。启动时缺失、太短或格式不符会直接失败。

在测试 DSH 的 Cordis 配置中显式加载该入口，例如以下插件条目；具体配置位置沿用该 DSH 实例的加载方式：

```yaml
- id: codex-subscription-dot-bridge
  name: dsh-codex-subscription/dot-bridge
  config:
    enabled: true
    port: 18791
```

组件固定监听 `127.0.0.1`，MCP 地址为 `http://127.0.0.1:18791/mcp`。客户端须发送 `Authorization: Bearer <独立令牌>`。只接受该回环 Host 的 POST JSON，不提供浏览器 CORS、公开监听、账号登录或完整 DSH 管理接口。探针无会话状态，GET SSE 与 DELETE 返回 405；响应使用 JSON。请求正文限 16 KiB。

先用 MCP Inspector 或标准 MCP 客户端验证初始化、工具发现及 `dsh_bridge_probe`。调用可带 `{"nonce":"trial_123"}`，检查相同 nonce 出现在实际结果中。查看回执，而不是以插件显示在列表中作为成功依据。

卸载组件会关闭 HTTP 监听及连接；端口占用时显式报错。更换令牌后需重载该组件。

## 让 dot 实际调用，还需要什么

官方支持通过[自定义插件](https://developers.openai.com/plugins/build/plugins)与 [MCP 服务](https://developers.openai.com/plugins/build/mcp-server)提供工具。[开发模式接入](https://developers.openai.com/plugins/deploy/connect-chatgpt)可以使用可达 HTTPS 或 [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)。账号／workspace 权限与 dot 实际工具可见性仍须现场验证。

本机 MCP 地址不能直接作为云端地址。本组件尚未建立外部接入、OAuth、隧道或 OpenAI 插件注册。所选接入层必须兼容独立认证、重写为正确的本地 Host，并保留本机回环限制；不能通过移除认证或转发整个 DSH 管理接口解决连接问题。正式远程接入需按其实际认证协议实现并验证。

探针本身不调用模型或 OpenAI API。若选择 Secure MCP Tunnel，其 Platform 权限与运行 API key 另行配置；上游订阅登录不能替代。

首次现场验收：让 dot 调用 `dsh_bridge_probe` 并回读随机 nonce。普通 Codex 或测试客户端调用成功不能替代 dot 的这一步。

## 后续任务组件

连接验证后增加有界的 `start_task`、`get_task`、`continue_task`、`cancel_task`，复用 DSH 原生 agent 生命周期。任务需保留外部 plugin 来源、归属和幂等请求标识；不直接包装会广播所有会话的 SDK，也不把 dot 的文字标成真人输入。

`/retro` 等正文批准仍由用户通过真实问答完成。MemOS 对 plugin 来源的捕获／召回、任务与人工问题的界面可见性、重启恢复和产物传输分别验证，不在本只读组件中承诺。

## 检查范围

`node --test tests/dot-bridge.test.mjs` 使用随机端口、临时令牌和官方 MCP 客户端，验证协议互通、唯一只读工具、输入范围、认证、Host／Origin 拒绝、正文限制、端口冲突、默认关闭和清理。它不使用真实账号或生产 DSH。

完整仓库检查沿用 `pnpm run check`。源码测试和构建通过不代表已安装产品、远程连接或 dot 端到端验收。

本分支在 Node 24.19.0、Cordis 4.0.4 下通过 9 项连接组件检查。完整检查在隔离本机代理、限制回环网络并将 `TMPDIR` 指向规范路径后，603 项中 577 项通过、26 项跳过，构建和打包成功。

默认 macOS 环境的完整检查仍有 3 项失败：两个 OAuth 并发测试受到系统代理影响，一个子任务测试受临时目录的符号链接路径影响。未修改的固定上游提交与原锁文件可复现相同失败；本分支没有修改这些测试或订阅运行逻辑。该环境差异需要保留在验收记录中，不能宣称任意机器上完整检查均通过。
