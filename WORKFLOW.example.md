---
# Copy to WORKFLOW.md, put GITHUB_TOKEN=... in .env, then:
#   scripts/symphony.sh start            # or: scripts/symphony.sh run (foreground)
tracker:
  kind: github
  provider:
    # One instance can serve many repositories. Entries are `owner/repo`, a bare `repo`
    # (uses `owner:` below), or a map with per-repo overrides. Identifiers are
    # `<identifier_prefix>-<number>` (default prefix: the repo name) and must be unique.
    owner: your-org
    repositories:
      - your-repo
      - other-org/another-repo
      - repository: your-org/web
        identifier_prefix: web            # optional; e.g. to avoid two repos both named "web"
        protected_branches: [main, release]
    # Single-repo form still works:  repository: your-org/your-repo
    token: $GITHUB_TOKEN                  # host-side only; never passed to the agent
    state_label_prefix: "status:"         # states are labels: status:Todo, status:In Progress, ...
    # assignee: your-bot-login            # only dispatch issues assigned to this login
    # blocking_labels: [blocked]          # issues with these labels are not dispatchable
  required_labels: [agent]                # only issues labelled `agent` are eligible
  active_states: [Todo, In Progress]
  terminal_states: [Closed, Done]

polling:
  interval_ms: 30000

workspace:
  root: ~/symphony_workspaces

hooks:
  timeout_ms: 300000
  # Runs once when the per-issue workspace is created. $SYMPHONY_REPO_URL is the clone URL of the
  # issue's own repository (also: SYMPHONY_ISSUE_REPO=owner/repo, SYMPHONY_ISSUE_NUMBER).
  # The `-c http.extraHeader` form authenticates for private repos without writing the token
  # into the workspace's .git/config (the agent can read the workspace).
  after_create: |
    auth="$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0)"
    git -c "http.extraHeader=Authorization: Basic $auth" clone --depth 50 "$SYMPHONY_REPO_URL" .
    git checkout -b "symphony/$SYMPHONY_ISSUE_IDENTIFIER"
  before_run: |
    auth="$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0)"
    git -c "http.extraHeader=Authorization: Basic $auth" fetch origin --quiet || true

agent:
  max_concurrent_agents: 3
  max_turns: 10
  max_retry_backoff_ms: 300000
  max_concurrent_agents_by_state:
    In Progress: 2

claude:
  command: claude
  # model: sonnet
  permission_mode: bypassPermissions      # high-trust default; see README "Trust posture"
  permission_prompts: none
  disallowed_tools: [AskUserQuestion]
  # max_budget_usd: 5
  turn_timeout_ms: 3600000
  read_timeout_ms: 60000
  stall_timeout_ms: 300000

server:
  port: 4400

logging:
  file: ~/symphony.log
  agent_log_dir: ~/symphony_logs
---
You are an autonomous software engineer working on GitHub issue **{{ issue.identifier }}**
in repository `{{ issue.native_ref.full_name }}` (checked out in the current directory).

- Title: {{ issue.title }}
- URL: {{ issue.url }}
- Current state: {{ issue.state }}
- Labels: {% for l in issue.labels %}`{{ l }}` {% endfor %}
{% if attempt %}
This is retry/continuation attempt {{ attempt }}. Inspect the workspace and the issue comments
(`github_issue_read`) to see what was already done before continuing.
{% endif %}

## Issue description

{{ issue.description }}

## How to work

1. If the issue is in `Todo`, call `github_issue_set_state` with `In Progress` first.
2. Read the issue and its comments with `github_issue_read`. If they contain screenshots or other
   images, call `github_issue_attachments` to see them (saved under `.symphony/attachments/`).
3. Implement the change in this workspace (already a git checkout on branch
   `symphony/{{ issue.identifier }}`). Run the project's tests/linters and make them pass.
4. Commit your work with a clear message.
5. Push with `github_git_push` (branch `symphony/{{ issue.identifier }}`); never push to the default branch.
6. Open a pull request with `github_pr_create` (check `github_pr_list` first to avoid duplicates).
7. Post a short summary comment with `github_issue_comment` (what changed, how it was tested, PR link).
8. Move the issue to `Human Review` with `github_issue_set_state`.

If you are blocked (missing information, failing infrastructure), explain the blocker in an issue
comment and move the issue to `Human Review` instead of guessing. No human will answer questions
during the run.
