# Skills Manager — Claude Code mod

Port of the [Obsidian Skills Manager](https://github.com/cbruyndoncx/obsidian-skills-manager) plugin to a Claude Code mod (function-hooks plugin), plus the playbooks and value chains from [BOB Workspace](https://github.com/cbruyndoncx/obsidian-bob-workspace). It manages `SKILL.md` skill folders, playbook notes and their value-chain mapping from inside Claude Code.

## Load it

```bash
git clone https://github.com/cbruyndoncx/claude-skills-manager-mod
claude --plugin-dir ./claude-skills-manager-mod
```

Or put that path in `CLAUDE_CODE_PLUGIN_DIRS`. Settings live in `/config` (rows under *skills-manager*):

| Setting | Default | Plugin equivalent |
|---|---|---|
| Skills directory | `.claude/skills` (use `00-CORE/Agents/skills` for a BOB vault) | Skills directory |
| GitHub PAT | — | GitHub PAT |
| Check for updates on start | on (60 s after start) | Auto-check for updates |
| Default category / Custom categories | `uncategorized` / — | same |
| Generate SKILLS.md | on | same |
| Cross-tool export + Export targets | off / — (`cursor, copilot, windsurf, cline`) | same |
| SkillsMP API key | — | Marketplace registry key |
| Playbook folders | `00-CORE/Playbooks, 20-COMPANY/03-PROCESSES/Playbooks, 10-ME/Playbooks, 30-CLIENTS` | BOB playbook `location_pattern` |
| Value chains | — (the 13 BOB chains plus `infrastructure`) | BOB value-chain taxonomy |

## Use it

- **`/skills`** opens the pane with three tabs:
  - **Installed:** search (optionally descriptions), a source filter, stats, bulk enable/disable/check/update/export, collapsible categories with per-category toggles, and per-skill toggle/freeze/check/delete (two-press confirm). Expanding a skill shows its metadata, a category picker, auto-loading and user-invocable toggles, an edit link, an update button, its files, the security scan and the instructions.
  - **Marketplace:** Skills.sh and SkillsMP (Tessl is a stub), with boards, search, load more, one-click install and an activity log.
  - **Add skill:** `owner/repo` (fetch versions), `owner/repo/path`, GitHub tree URLs, skills.sh URLs, a local folder, or a `.zip` (preview, then install one or all).
- **Playbooks tab** (notes with `type: playbook`): search, filters for status, value chain and maturity, and pinned playbooks first. Each playbook has **▶ run**, which starts a Claude turn: `/playbook-runner <title>` when that skill is installed (what BOB's Playbook Runner sends), otherwise a "read it and work through its steps" instruction. Its detail shows trigger, outcome, coverage, maturity and tags, with status and value-chain pickers, "Draft in prompt", an edit link and the steps.
- **Value chains tab:** one row per chain with playbook and skill counts (active and enabled), the stages its playbooks cover, and gaps (chains with no playbooks or no skills). Expand a chain to run or open its playbooks and to remove skills from it. The *Unassigned* row lets you assign skills to a chain. Skill details also show and edit their `value-chains`.
- **`/playbook [name [context]]`:** runs a playbook by title or file name. With no name it opens the Playbooks tab.
- **`/skills <subcommand>`:** `list [q]`, `show`, `rescan`, `enable|disable <skill|category|all>`, `invocable`, `category`, `install <ref> [version]`, `versions`, `check-updates`, `update [skill|all]`, `freeze`, `delete`, `browse [q]`, `export`, `index`, `playbooks [q]`, `playbook`, `run`, `pin`, `playbook-status`, `playbook-chain`, `chains [chain]`, `chain-add`, `chain-remove`, `help`. This replaces the plugin's command palette and its `obsidian://skills-manager?action=install` handler.
- **Model tool `mcp__skills-manager__skills`:** Claude can run the same actions on request. Delete is pane/command only, and `run` returns the playbook's instructions instead of starting a second turn.

The behaviour matches the plugin. Toggling flips `disable-model-invocation` in SKILL.md. Installs stage into a dot-folder, validate, and swap in with backup and rollback, then fill in standard frontmatter. Install bookkeeping (source, repo, version, frozen) lives in the mod's store, as the plugin's `data.json` did. ZIP extraction uses `unzip`, falling back to `python3 -m zipfile`.

## Develop

`claude plugin validate .` · `claude plugin test .` (pure-logic tests plus an in-memory end-to-end test of the command and pane).
