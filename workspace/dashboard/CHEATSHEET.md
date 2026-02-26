# JARVIS + Claude Code Cheat Sheet

---

## JARVIS Pipelines

```bash
cd /root/.openclaw/skills/agentbox-willoughby
node monitor-email.js            # Pipeline A — reactive (email alerts)
node daily-planner.js            # Pipeline B — proactive (daily call list)
node refetch-contacts-full.js    # Refresh contacts DB from AgentBox
node fetch-buyer-enquiries.js    # Sync buyer enquiries to SQLite
```

---

## PM2

```bash
pm2 list                         # list running processes
pm2 logs snapshot-server         # tail server logs
pm2 logs snapshot-server --lines 50  # last 50 lines
pm2 restart snapshot-server      # restart server
pm2 stop snapshot-server         # stop server
pm2 start snapshot-server        # start server
pm2 save                         # persist process list across reboots
pm2 monit                        # live CPU/memory dashboard
```

---

## tmux

```bash
tmux new -s jarvis               # new named session
tmux attach -t jarvis            # attach to session
tmux ls                          # list sessions
tmux kill-session -t jarvis      # kill session
```

Inside tmux (prefix = `Ctrl+b`):

| Keys | Action |
|---|---|
| `Ctrl+b d` | Detach (leave running) |
| `Ctrl+b c` | New window |
| `Ctrl+b n` / `p` | Next / previous window |
| `Ctrl+b "` | Split pane horizontal |
| `Ctrl+b %` | Split pane vertical |
| `Ctrl+b [` | Scroll mode (`q` to exit) |
| `Ctrl+b &` | Kill current window |

---

## SQLite

```bash
sqlite3 /root/.openclaw/workspace/jarvis.db
```

Inside `sqlite3`:

```sql
.tables                          -- list all tables
.schema contacts                 -- show table schema
.headers on                      -- show column headers
.mode column                     -- aligned output
.quit                            -- exit

SELECT COUNT(*) FROM contacts;
SELECT * FROM daily_plans WHERE date = date('now') LIMIT 20;
SELECT suburb, COUNT(*) FROM contacts GROUP BY suburb ORDER BY 2 DESC;
SELECT * FROM buyers ORDER BY enquiry_date DESC LIMIT 20;
```

---

## Git

```bash
git status
git diff
git log --oneline -10
git add -p                       # interactive stage (review each chunk)
git commit -m "message"
git push
git stash                        # stash uncommitted changes
git stash pop                    # restore stashed changes
```

---

## Network / Server

```bash
curl -sk https://72.62.74.105:4242       # ping dashboard
ss -tlnp | grep 4242                     # check port is open
df -h                                    # disk space
free -h                                  # memory usage
pkill -f "node fetch-buyer"             # kill hung node process
```

---

## Cron

```bash
cat /root/.openclaw/cron/jobs.json       # view JARVIS schedule
crontab -l                              # list active system crons
crontab -e                              # edit system crons
```

---

## Useful One-liners

```bash
# Count contacts by suburb
sqlite3 /root/.openclaw/workspace/jarvis.db \
  "SELECT suburb, COUNT(*) FROM contacts GROUP BY suburb ORDER BY 2 DESC"

# Today's plan
sqlite3 /root/.openclaw/workspace/jarvis.db \
  "SELECT name, score, status FROM daily_plans WHERE date=date('now') LIMIT 20"

# Recent buyers
sqlite3 /root/.openclaw/workspace/jarvis.db \
  "SELECT buyer_name, listing_address, enquiry_type, enquiry_date FROM buyers ORDER BY enquiry_date DESC LIMIT 20"

# Tail snapshot server log
pm2 logs snapshot-server --lines 50

# Kill hung node process
pkill -f "node fetch-buyer"
```

---

## Claude Code — Sessions

```bash
claude                           # start interactive REPL
claude "query"                   # start with prompt
claude -p "query"                # print mode (non-interactive, exits after)
claude -c                        # continue last conversation
claude -r mysession              # resume session by name or ID
claude --permission-mode plan    # start in plan mode
```

---

## Claude Code — Slash Commands

| Command | Purpose |
|---|---|
| `/clear` | Clear conversation history |
| `/compact` | Summarise + compress history (saves context) |
| `/cost` | Show token usage and cost |
| `/context` | Visualise context window usage |
| `/status` | Version, model, account info |
| `/memory` | Edit CLAUDE.md memory files |
| `/model` | Change AI model |
| `/plan` | Enter plan mode |
| `/mcp` | Manage MCP server connections |
| `/tasks` | List background tasks |
| `/vim` | Enable vim editing mode |
| `/debug` | Troubleshoot session |
| `/doctor` | Check Claude Code installation health |
| `/help` | Usage help |

Skills are invoked with `/skill-name` or `/skill-name arguments`.

---

## Claude Code — Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Shift+Tab` | Cycle permission mode (Normal → Plan → Auto-Accept) |
| `Ctrl+O` | Toggle verbose output |
| `Ctrl+B` | Background running task |
| `Ctrl+T` | Toggle task list |
| `Ctrl+G` | Open current input in text editor |
| `Ctrl+R` | Search command history |
| `Ctrl+C` | Cancel current generation |
| `Ctrl+D` | Exit Claude Code |
| `Esc+Esc` | Rewind conversation |
| `Alt+P` | Switch model |
| `Alt+T` | Toggle extended thinking |

---

## Claude Code — Permission Modes

| Mode | Behaviour |
|---|---|
| Normal | Prompts before each tool use |
| Plan | Writes a plan before using any tools |
| Auto-Accept | Approves all tool calls automatically |

Toggle with `Shift+Tab` or start with `--permission-mode plan`.

---

## Claude Code — MCP Servers

```bash
claude mcp list                              # list configured servers
claude mcp add --transport http name url     # add HTTP server
claude mcp add-json name '{"type":...}'      # add from JSON
claude mcp remove name                       # remove server
claude mcp reset-project-choices             # reset server approval choices
```

---

## Claude Code — Skills

Skills live in `.claude/skills/<name>/SKILL.md`.

```
/skill-name              invoke a skill
/skill-name arguments    invoke with arguments
```

Manage with `/plugin install` (marketplace) or create your own.

---

## Claude Code — Hooks (in ~/.claude/settings.json)

| Event | When it fires |
|---|---|
| `SessionStart` | Session begins or resumes |
| `PreToolUse` | Before a tool executes (can block with exit code 2) |
| `PostToolUse` | After a tool succeeds |
| `Stop` | When Claude finishes responding |

Example — block dangerous commands:
```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{ "type": "command", "command": "check-safety.sh" }]
    }]
  }
}
```

---

## Claude Code — Keybinding Customisation

Edit `~/.claude/keybindings.json` — changes apply immediately.

```json
{
  "bindings": [
    {
      "context": "Chat",
      "bindings": {
        "ctrl+e": "chat:externalEditor",
        "ctrl+u": null
      }
    }
  ]
}
```

---

## Claude Code — Environment Variables

| Variable | Purpose |
|---|---|
| `ENABLE_TOOL_SEARCH=true` | Enable MCP tool search |
| `MCP_TIMEOUT=10000` | MCP startup timeout (ms) |
| `CLAUDE_CODE_ENABLE_TASKS=false` | Disable task list |
| `CLAUDE_ENV_FILE=.env.claude` | Load extra env vars from file |

---

*Generated 2026-02-26 · JARVIS / Willoughby*
