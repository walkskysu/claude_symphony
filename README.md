# claude-symphony

一个用 TypeScript / Node.js 实现的、兼容 [OpenAI Symphony 规范](https://github.com/openai/symphony/blob/main/SPEC.md)（Draft v1）的后台守护服务：

- **Issue 跟踪器**：GitHub Issues（`tracker.kind: github`）
- **编码代理**：Claude Code CLI（`claude -p --input-format stream-json --output-format stream-json`），替代规范中的 Codex app-server

它持续轮询 GitHub 上处于活跃状态的 issue，为每个 issue 创建隔离的工作区，在其中启动一个 Claude Code 会话，并通过宿主侧的 MCP 工具桥让代理更新 issue 状态、评论、推送分支和创建 PR —— **代理进程本身拿不到 GitHub token**。

## 快速开始

```bash
cp symphony.example.yml symphony.yml        # 修改 tracker.provider.repositories 等（symphony.yml 已被 git 忽略）
echo 'GITHUB_TOKEN=ghp_xxx' > .env          # 需要 issues / pull_requests / contents 写权限；.env 已被 git 忽略

scripts/symphony.sh check                   # 校验配置 + 列出候选 issue + 报告缺失的标签
scripts/symphony.sh labels                  # （可选）立即在各仓库创建缺失的工作流标签
scripts/symphony.sh start                   # 后台启动（先 check，失败则不启动）
scripts/symphony.sh status | logs | stop | restart
scripts/symphony.sh run                     # 前台运行，Ctrl-C 退出
# 浏览器打开 http://127.0.0.1:<server.port>/ 查看仪表盘
```

启动脚本 `scripts/symphony.sh` 会：检查 Node ≥ 22；缺少依赖时 `npm ci`；`dist/` 不存在或源码更新时自动构建；加载 `.env`；后台模式把 pid 写到 `.symphony/symphony.pid`、输出追加到 `.symphony/symphony.out`。用法 `scripts/symphony.sh start [配置文件] [-- 额外 CLI 参数]`；不给配置文件时固定使用项目目录下的 `symphony.yml`。示例：`scripts/symphony.sh start -- --port 4400`。可用环境变量：`SYMPHONY_ENV_FILE`、`SYMPHONY_WORKFLOW`、`SYMPHONY_STATE_DIR`、`SYMPHONY_PORT`。

也可以直接调用 CLI：`npm install && npm run build && node dist/cli.js symphony.yml --port 4400`。

开发时可以直接运行 TS 源码（Node ≥ 22.18 原生支持类型擦除）：`node src/cli.ts symphony.yml`。

在 GitHub 上给 issue 打上 `agent` 和 `status:Todo` 标签即可被调度（标签不存在时服务启动会自动创建，见下文“标签”）。

## CLI

```
claude-symphony [check|labels] [config-file] [--port N] [--host H] [--log-file F] [--log-level L]
```

- 不给路径时固定使用当前目录的 `./symphony.yml`（不查找其他文件名）；文件不存在或启动校验失败时以非 0 退出。
- `check`：校验配置、列出候选 issue、报告每个仓库缺失的标签（只读）。`labels`：创建缺失的标签后退出。
- `--port` 覆盖 `server.port`，`0` 表示随机端口；默认只绑定 `127.0.0.1`。
- `SIGINT`/`SIGTERM` 优雅退出（停止所有代理、执行 `after_run` hook），退出码 0。

## 架构

| 规范组件 | 实现 |
|---|---|
| Workflow Loader + 动态重载 | `src/workflow.ts`（目录 watch + 指纹轮询兜底；每个 tick 前再防御性检查一次） |
| Config Layer | `src/config.ts`（默认值、`$VAR`、`~`、相对配置文件解析） |
| Issue Tracker Adapter | `src/tracker/github.ts`，注册表 `src/tracker/index.ts` |
| Orchestrator | `src/orchestrator.ts`（单一权威内存状态、claim、重试队列、协调、停滞检测） |
| Workspace Manager | `src/workspace.ts`（清洗 key + 64 位哈希后缀、根目录约束、4 个 hook、超时杀进程组） |
| Agent Runner | `src/agent/runner.ts` + `src/agent/claude.ts` |
| 代理工具（可选扩展） | `src/agent/tool-bridge.ts`（宿主侧 MCP Streamable-HTTP 服务器） |
| 日志 | `src/log.ts`（`key=value`，stderr + 可选文件；sink 失败不影响服务） |
| HTTP 扩展 | `src/http.ts`（`/`、`/api/v1/state`、`/api/v1/<identifier>`、`POST /api/v1/refresh`） |

### 编码代理协议（Claude Code）

规范 §10 以 Codex app-server 为目标协议；本实现的“目标协议”是 **Claude Code 无头流式模式**：

- 启动：`bash -lc "<claude.command> -p --input-format stream-json --output-format stream-json --verbose --session-id <uuid> --permission-mode … --permission-prompts … --name '<identifier>: <title>' [--mcp-config …] …"`，cwd 为该 issue 的工作区。
- 传输：stdio 上的换行分隔 JSON；stdout 为协议流，stderr 单独写入代理日志，最大行 10 MB。
- `thread_id` = Symphony 预先生成并通过 `--session-id` 传入的 Claude 会话 ID；`turn_id` = `turn-N`；`session_id = <thread_id>-<turn_id>`。
- 一个 turn = 写入一条 `{"type":"user",…}` 消息，直到收到 `{"type":"result"}`。续跑 turn 复用同一个活进程/会话，只发送续跑指引，不重发原始提示。
- `result.subtype == "success"` → `turn_completed`；其他 subtype 或 `is_error` → `turn_failed`；进程退出 → `port_exit`（退出码 127 → `codex_not_found`）；首个 `system/init` 超过 `read_timeout_ms` → `response_timeout`；输出静默超过 `turn_timeout_ms` → `turn_timeout`。
- Token 统计：每个 `result.usage` 累加为线程绝对总量（input = input + cache_creation + cache_read），orchestrator 按“与上次上报的差值”累计，避免重复计数；`rate_limit_event` 记录为最新限流快照；`total_cost_usd` 额外统计为 `cost_usd`。
- 发出的事件：`session_started`、`startup_failed`、`turn_completed`、`turn_failed`、`turn_input_required`、`approval_auto_approved`、`unsupported_tool_call`、`tool_call_completed`、`tool_call_failed`、`notification`、`other_message`、`malformed`。

## 配置文件

配置文件固定为 **`symphony.yml`**（显式传路径时也可用 `.yaml` / `.json`）：整个文件就是配置，提示词模板放在 `prompt:`（YAML 多行字符串），或用 `prompt_file: prompts/default.md` 指向单独的文件（相对配置文件解析，支持 `~` / `$VAR`）。两者不能同时设置。修改配置文件或提示词文件都会自动热重载。完整示例见 `symphony.example.yml`。

```yaml
tracker:
  kind: github
  provider:
    owner: walkskysu
    repositories: [llm_media_library]
polling:
  interval_ms: 30000
prompt_file: prompts/default.md      # 或 prompt: |  ...
```

仓库自带的默认提示词在 **`prompts/default.md`**，`symphony.example.yml` 通过 `prompt_file: prompts/default.md` 引用它。需要按仓库/团队定制时，复制一份（如 `prompts/my-team.md`）并修改 `prompt_file` 即可。

为兼容 Symphony 规范，显式传入 **`WORKFLOW.md`**（YAML front matter + Markdown 提示词正文）仍然可用，配置键完全相同，按扩展名区分（`.yml/.yaml/.json` 以外都按 WORKFLOW.md 解析）。

### 配置参考

核心字段与规范 §6.4 一致：`tracker.*`、`polling.interval_ms`、`workspace.root`、`hooks.*`、`agent.*`。差异与扩展：

### `claude`（替代 `codex`，扩展键）

| 键 | 默认 | 说明 |
|---|---|---|
| `command` | `claude` | 通过 `bash -lc` 启动；Symphony 在其后追加协议参数 |
| `model` | 无 | `--model` |
| `permission_mode` | `bypassPermissions` | `--permission-mode`（acceptEdits / auto / dontAsk / plan / …） |
| `permission_prompts` | `none` | `none` = 会触发提示的操作自动拒绝；`host` = 通过 control_request 交给 Symphony（见下） |
| `allowed_tools` / `disallowed_tools` | `[]` / `[AskUserQuestion]` | `--allowedTools` / `--disallowedTools`；`mcp__symphony` 会自动加入 allowed |
| `append_system_prompt` | 无 | `--append-system-prompt` |
| `max_budget_usd` | 无 | 每个会话的花费上限 |
| `strict_mcp_config` | `false` | 只加载 Symphony 提供的 MCP 服务器 |
| `extra_args` | `[]` | 追加的原样参数 |
| `env` | `{}` | 给代理子进程的额外环境变量（值支持 `$VAR`） |
| `turn_timeout_ms` | `3600000` | turn 内最大静默时间 |
| `read_timeout_ms` | `60000` | 等待会话初始化的时间（Claude Code 启动 + 连接 MCP 比 Codex 慢，故默认值高于规范中 codex 的 5000） |
| `stall_timeout_ms` | `300000` | orchestrator 停滞检测；`<= 0` 关闭 |

如果没有 `claude` 段，三个超时字段会回退读取 `codex.*`，以兼容原生 Symphony 的 WORKFLOW.md。`codex.command` 不会被使用。

### 其他扩展

- `server.port`、`server.host`（默认 `127.0.0.1`）：HTTP 扩展。改端口需要重启。
- `logging.file`、`logging.level`、`logging.agent_log_dir`（默认 `<tmp>/symphony_logs`）：每次 worker 运行的原始代理流写入 `<agent_log_dir>/<workspace_key>/<时间戳>.log`，并维护 `latest.log` 软链。

### 模板

Liquid（liquidjs），开启 `strictVariables` + `strictFilters`。变量：`issue`（全部规范化字段）与 `attempt`（首次为 `null`）。模板错误只让本次尝试失败并进入重试。

## Adapter profile: `github`

- **`tracker.kind`**：`github`
- **`tracker.provider` 键**

  | 键 | 默认 | 说明 |
  |---|---|---|
  | `repositories` | 三选一必填 | **多仓库**：列表项为 `owner/repo`、裸 `repo`（使用顶层 `owner`），或 `{repository, owner?, identifier_prefix?, protected_branches?}`。调度范围 = 所有列出的仓库 |
  | `repository: owner/repo`，或 `owner` + `repo` | 三选一必填 | 单仓库写法（与 `repositories` 互斥） |
  | `token` | 省略时依次读取 `$GITHUB_TOKEN`、`$GH_TOKEN` | **密钥**，支持 `$VAR`；解析为空视为缺失 |
  | `api_url` | `https://api.github.com` | GHES：`https://host/api/v3` |
  | `state_label_prefix` | `status:` | 状态标签前缀 |
  | `open_state` / `closed_state` | `Open` / `Closed` | 无状态标签的 open issue / 所有 closed issue 的状态名 |
  | `assignee` | 无 | 设置后只有指派给该 login 的 issue 才 `dispatchable` |
  | `blocking_labels` | `[]` | 含这些标签的 issue `dispatchable=false` |
  | `priority_label_prefix` | `priority:` | `priority:1`/`priority:p1` → `priority=1` |
  | `identifier_prefix` | 仓库名 | `identifier = <prefix>-<number>`；多仓库时在每个条目上设置，所有仓库的前缀（忽略大小写）必须唯一，否则报 `invalid_tracker_config` |
  | `web_url` | 由 `api_url` 推导 | 生成 clone URL 用；github.com → `https://github.com`，GHES 去掉 `/api/v3` |
  | `closed_lookback_days` | `14` | 拉取 closed 状态时只看最近 N 天更新过的 |
  | `page_size` / `max_pages` | `100` / `50` | 分页；超过 `max_pages` 报 `tracker_pagination` |
  | `request_timeout_ms` | `30000` | |
  | `allow_force_push` | `false` | 是否允许 `github_git_push` 强推 |
  | `protected_branches` | `[main, master]` | 外加仓库默认分支，`github_git_push` 一律拒绝；可在每个仓库条目上覆盖 |
  | `allowed_states` | 不限制 | 设置后 `github_issue_set_state` 只接受这些 + active/terminal/open/closed |
  | `attachment_max_bytes` / `attachment_max_count` | `10485760` / `20` | `github_issue_attachments` 单张图片大小上限 / 每次调用最多下载张数 |
  | `ensure_labels` | `true` | 启动（及配置重载）时在每个仓库创建缺失的工作流标签，见下 |

- **默认状态**：`active_states = [Todo, In Progress]`，`terminal_states = [Closed, Done]`。
- **状态模型**：GitHub issue 只有 open/closed，因此工作流状态由标签承载：`status:Todo`、`status:In Progress`、`status:Human Review`……closed issue 的状态恒为 `closed_state`；open 且无状态标签为 `open_state`。状态名保留标签中的原始拼写，比较时 trim + lowercase。
- **多仓库**：按配置顺序对每个仓库执行下面的查询，合并结果交给 orchestrator 统一排序和限流（`max_concurrent_agents` 等是全局的）。任一仓库查询失败则整次拉取失败、本 tick 不派发（规范 §11.4：不基于不完整视图调度）。
- **查询与分页**：每个仓库、每个非 open/closed 状态发一次 `GET /repos/{o}/{r}/issues?state=open&labels=<prefix><state>`；`open_state` 拉全部 open issue；`closed_state` 拉 `since=now-closed_lookback_days` 的 closed issue。按 `Link: rel="next"` 顺序翻页并按 id 去重。空状态列表/空 id 列表不发请求。
- **ID 映射**：`id` = `owner/repo#number`（跨仓库唯一且稳定）；`identifier` = `<identifier_prefix>-<number>`；`native_ref = {provider, owner, repo, full_name, clone_url, number, node_id, database_id, assignees, state_labels}`（均为非密钥，模板中可用 `{{ issue.native_ref.full_name }}`）。`fetch_issues_by_ids` 解析 id 后对相应仓库调 `GET /issues/{n}`（并发 8）；不属于已配置仓库的 id、404/410、已转移到其他仓库、或其实是 PR 的条目视为“不可见”而省略。
- **提供给 hook 和代理的环境变量**：`SYMPHONY_ISSUE_REPO`（`owner/repo`）、`SYMPHONY_ISSUE_REPO_OWNER`、`SYMPHONY_ISSUE_REPO_NAME`、`SYMPHONY_ISSUE_NUMBER`、`SYMPHONY_REPO_URL`（clone URL），另有通用的 `SYMPHONY_ISSUE_ID`、`SYMPHONY_ISSUE_IDENTIFIER`、`SYMPHONY_ISSUE_URL`、`SYMPHONY_WORKSPACE`。一份 `after_create` 即可为不同仓库的 issue clone 正确的仓库（见 `symphony.example.yml`）。
- **标签**：工作流依赖的标签为 active / terminal / `allowed_states` 中每个状态对应的 `<prefix><state>`（`open_state`/`closed_state` 没有标签），以及 `tracker.required_labels` 和 `blocking_labels`。新加入的仓库通常一个都没有：此时按标签查询只会返回空结果，该仓库永远不会有候选 issue，但不会报错。因此：
  - `ensure_labels: true`（默认）时，服务启动和每次配置重载都会列出各仓库的标签，缺失的自动创建（状态标签蓝/绿/黄、`required_labels` 紫、`blocking_labels` 红）。创建失败（如 token 无权限）只记 warn 日志，不影响启动。
  - `check` 只报告缺失的标签，不做修改；`labels` 子命令（`scripts/symphony.sh labels`）立即创建，不受 `ensure_labels` 影响。
  - 即使标签不存在，代理通过 `github_issue_set_state` 设置状态时 GitHub 也会自动创建该标签（默认灰色）。
- **规范化**：labels trim + 小写 + 去重；`created_at/updated_at` 解析为 RFC 3339；`branch_name = null`；`blocked_by = []`（GitHub 依赖关系不做推断）；`assignee_id` = 第一个 assignee login。
- **`dispatchable`**：`false` 当且仅当：同时带多个不同状态标签（歧义，需人工处理）、配置了 `assignee` 但未指派给它、或带有 `blocking_labels`。
- **畸形记录**：缺少 number/title/state 的记录在状态列表查询中被省略并记 warn 日志；在 id 刷新中直接报 `tracker_response` 错误。Pull request 永远不在范围内。
- **错误映射**（`TrackerError.category` + `message`）：
  `invalid_tracker_config`（provider 键非法）、`missing_tracker_secret`（token 为空）、`tracker_request`（网络/超时）、`tracker_status`（非 2xx；5xx 标记 retryable）、`tracker_response`（非 JSON / 结构不对 / 畸形 issue）、`tracker_pagination`（超过 max_pages 或跨域 next 链接）、`tracker_rate_limited`（429，或 403 且 `x-ratelimit-remaining: 0`/`retry-after`；带 `retryAfterMs`，orchestrator 据此推迟下一次 tick）。
- **需要从子进程环境中移除的密钥变量**：`GITHUB_TOKEN`、`GH_TOKEN`、`GITHUB_PAT`、`GH_ENTERPRISE_TOKEN`、`GITHUB_ENTERPRISE_TOKEN`，以及 `token: $X` 引用的 `X`。

### 代理工具（通过 MCP 服务器 `symphony` 暴露，在 Claude 中显示为 `mcp__symphony__<name>`）

| 工具 | 会修改跟踪器 | 作用域 | 输入 |
|---|---|---|---|
| `github_issue_read` | 否 | 当前 issue | `{include_comments?: boolean}` |
| `github_issue_attachments` | 否 | 当前 issue | `{include_body?, include_comments?, comment_ids?: number[], max_images?, inline?}`：下载正文/评论中的图片（见下） |
| `github_issue_comment` | 是 | 当前 issue | `{body: string}` |
| `github_issue_set_state` | 是 | 当前 issue | `{state: string, close_reason?: "completed"\|"not_planned"}`：移除其他状态标签并添加 `<prefix><state>`；`closed_state` 会关闭 issue，其它状态会在需要时重新打开 |
| `github_issue_labels` | 是 | 当前 issue | `{add?: string[], remove?: string[]}`，不能修改状态标签 |
| `github_git_push` | 是（仓库） | 当前 issue 所在仓库 | `{branch, force?}`：在宿主侧用 token 推送工作区 `HEAD`；拒绝受保护/默认分支；禁用仓库 git hooks；凭据只放在宿主侧 git 进程的 `GIT_CONFIG_*` 环境变量中 |
| `github_pr_create` | 是（仓库） | 当前 issue 所在仓库 | `{title, head, base?, body?, draft?, closes_issue?=true}`，默认在 body 末尾追加 `Closes #<n>` |
| `github_pr_list` | 否 | 当前 issue 所在仓库 | `{head?, state?}` |

结果：成功为 `{ok: true, result}`；失败为 `{ok: false, error: {code, message}}` 且 MCP `isError: true`。错误码：`invalid_arguments`、`forbidden`、`unsupported_tool`、`git_push_failed`、`tool_error`，以及上面的 tracker 错误类别。未知工具名返回结构化失败，会话继续。工具不做幂等去重（例如重复调用 `github_issue_comment` 会发两条评论；`github_pr_create` 对已存在的 PR 会返回 GitHub 的 422），提示词中应让代理先 `github_pr_list`。GitHub 限流同读接口。

每个代理会话有独立的随机 bearer token，绑定到该会话启动时的 adapter 快照与当前 issue；配置重载只影响之后的会话。

### 读取 issue 中的图片（`github_issue_attachments`）

代理无法自己下载 issue 里的截图（私有仓库附件需要凭据，而代理拿不到 token），所以由 Symphony 在宿主侧完成：

1. 以 `application/vnd.github.full+json` 读取正文和评论，优先从渲染后的 `body_html` 中取 `<img src>` —— 私有仓库在这里给出短时有效的签名 URL，无需浏览器登录；没有 HTML 时回退解析 Markdown（`![](…)`、`<img>`）。
2. **只下载 GitHub 自己的地址**：`github.com` 上的附件路径（`/user-attachments/…`、`/<owner>/<repo>/assets/…`）和 `*.githubusercontent.com`（GHES：`web_url` 的主机及其子域名）。每一跳重定向都重新校验，不会被引到任意网址或内网地址；token 只发给 GitHub 网页主机本身，不发给 CDN。
3. 边下载边检查大小；按文件头判断真实类型（PNG/JPEG/GIF/WebP 可内联，SVG/BMP 只保存），登录页等 HTML 会被拒绝。
4. 支持的图片以 MCP `image` 内容块直接返回给 Claude（单张 ≤ 3.75 MB、单次合计 ≤ 15 MB），同时全部保存到工作区 `.symphony/attachments/<issue|comment-ID>-<n>.<ext>`，以后的轮次可以用 Read 工具重新打开。`.symphony/` 里会写入 `.gitignore`（内容为 `*`），避免被提交；如果 `.symphony` 是指向工作区外的符号链接则拒绝写入。
5. 返回的 JSON 列出每张图片的来源、作者、alt、路径或错误原因；URL 去掉了查询串（不暴露签名）。`github_issue_read` 发现图片时会附带 `images_referenced` 提示。

## 信任与安全策略（规范 §10.5、§15 要求说明）

本实现**面向受信任环境**，默认采用高信任姿态：

- **审批**：`permission_mode: bypassPermissions` + `permission_prompts: none`。代理在工作区内执行命令/改文件无需审批；任何仍会弹出提示的操作会被自动拒绝，因此不会无限挂起。若设置 `permission_prompts: host`，Symphony 会自动批准 `can_use_tool` 控制请求（记 `approval_auto_approved` 事件），但拒绝请求用户输入的工具。
- **用户输入**：默认禁用 `AskUserQuestion`；若代理仍请求用户输入，则被拒绝并记 `turn_input_required` 事件，代理需自行继续或把阻塞原因写到 issue 里。永不等待操作员。
- **沙箱**：不提供超出 Claude Code 自身与操作系统的沙箱。可通过 `permission_mode: acceptEdits`/`dontAsk` + `allowed_tools`、`--restricted`（`extra_args`）、或把整个服务跑在容器/专用 OS 用户里来收紧。
- **工作区不变量**：工作区目录名只含 `[A-Za-z0-9._-]`（变化时追加 64 位哈希）；路径必须在 `workspace.root` 内（含 realpath 检查）；代理 cwd 必须等于该 issue 的工作区路径。
- **密钥**：GitHub token 只在 Symphony 进程中使用；adapter 声明的密钥环境变量会从代理子进程环境中删除；日志不打印 token。注意：同一 OS 用户下的代理理论上仍可读取 Symphony 进程的 `/proc/<pid>/environ`，若需要强隔离请让代理以不同 OS 用户运行。不要在配置文件里写明文 token（用 `token: $GITHUB_TOKEN` + `.env`）。
- **Hooks**：视为完全受信任的配置，继承宿主环境（包括 token），在工作区目录内用 `bash -lc` 执行，有超时并杀进程组，输出在日志中截断。不要让 hook 把凭据写进工作区。
- **加固建议**：用 `required_labels` / `assignee` 限制哪些 issue 能被调度（防止外部人员通过开 issue 注入提示词）；为 token 使用仅限单仓库的 fine-grained PAT；设置 `max_budget_usd`。

## 实现定义的行为

- 工作区位置存在非目录文件时：失败，不删除。
- `after_create` 失败：删除刚创建的目录。复用的工作区不会被破坏性重置。
- 协调终止（terminal / 非活跃 / 不可路由 / 不可见）会释放 claim，不重试；只有 terminal 会清理工作区。停滞终止按指数退避重试。
- 重试时如果配置当前无效，会以退避重新排队，而不是释放 claim。
- 仅内存状态：重启后不恢复重试计时器和运行中的会话，依靠启动时 terminal 工作区清理 + 重新轮询恢复。
- `/api/v1/<identifier>` 对最近 1000 个出现过的 issue 保留历史（工作区、日志路径、最近事件、最后错误）。

## 测试

```bash
npm test         # node:test，48 个用例；使用 test/fixtures/fake-claude.mjs 模拟 Claude Code
npm run typecheck
```

覆盖规范 §17.1–§17.7 的核心一致性项：workflow/配置解析、动态重载与无效重载回退、严格模板、工作区与 hooks、GitHub adapter（分页、规范化、错误映射、工具）、调度排序与过滤、并发限制、续跑与退避重试、协调、停滞检测、代理客户端超时与错误映射、MCP 工具桥、HTTP API。

**真实集成测试（§17.8）未包含**：需要真实 `GITHUB_TOKEN` 与已登录的 Claude Code，建议在测试仓库上运行 `claude-symphony check` 后再正式启动。
