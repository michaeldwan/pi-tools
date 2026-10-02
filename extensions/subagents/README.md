# pi RPC subagents

Run independent workers as real `pi --mode rpc` processes. Foreground launch waits for settlement; background launch returns a stable ID promptly. Workers remain inspectable across compaction, reload and parent restart.

Try the local package without changing your active installation:

```sh
PI_CODING_AGENT_DIR=/absolute/path/to/scratch-agent-dir \
  pi -e /absolute/path/to/pi-tools
```

The scratch agent directory needs its own credential/model copies. Don't copy secrets into the repository. To validate a local install without touching real settings:

```sh
export PI_CODING_AGENT_DIR=/absolute/path/to/scratch-agent-dir
pi install /absolute/path/to/pi-tools
pi list
pi --model provider/model --thinking high
```

The package declares `extensions/subagents/index.ts` as the subagents entry point. Its supporting modules aren't loaded as separate extensions. It doesn't depend on `things` or its harness package. Workers use the same agent directory and their assigned cwd's resources; parent-only `-e` and `--skill` arguments aren't copied to child startup. Configure shared resources in scratch settings or the worker's project. Put project MCP configuration in the worker cwd's `.pi/mcp.json` before launching it.

Call `subagent` with:

```json
{
  "task": "Read the assigned task and implement it. Report your result.",
  "cwd": "/absolute/path/to/worktree",
  "agent": "general-purpose",
  "approveProject": true,
  "requiredTools": ["codemode", "mcp__example__show"]
}
```

`cwd` and `task` are required. `model` accepts an exact provider/model or model ID. `thinking` accepts pi's thinking levels. Precedence is call override, Markdown definition, then the parent's effective model/thinking. A model's `:thinking` suffix overrides the definition's thinking field. The child checks its actual model/thinking before sending work; an unsupported level or fuzzy model substitution fails rather than silently changing them.

Workers load their normal configuration, instructions, skills, project extensions and MCP connections. `approveProject` trusts only the assigned cwd's project resources for this process. A trusted parent in the same cwd passes that trust to its child; saved child trust also applies normally. Project agent definitions load with explicit approval, same-cwd parent trust, or saved trust. No global settings are changed.

Agent definitions come from `<agent-dir>/agents/*.md` and the nearest trusted `.pi/agents/*.md`. Project definitions override user definitions. Frontmatter accepts `name`, `model`, `thinking` (also `thinkingLevel`), `tools`, and `requiredTools`; lists can be YAML arrays or comma-separated strings. The body appends instructions without replacing the child's normal system prompt. Defaults are `general-purpose`, `Explore`, and `Plan`, with no pinned model. Explore and Plan expose read-only file tools and reject mutating nested tool calls.

`tools` is an exact allowlist and overrides the definition's list, including an empty list. It also restricts calls inside codemode. `requiredTools` adds to the definition's requirements. Startup polls tool reachability for up to 20 seconds -- MCP tools aren't necessarily ready at `session_start`. A missing required tool fails before the task prompt. Restricted tools aren't added just to make a requirement pass.

Recursive delegation/control calls are blocked in workers, without disabling extensions or MCP. Workers use fresh sessions and wait for `agent_settled`, not `agent_end` or exit zero. The last terminal assistant message determines success -- an earlier error followed by a successful retry doesn't fail the run.

Add `"background": true` to return an ID while startup is still in progress. Inspect that ID with `get_subagent_result` (`id`, optional `wait: true`, optional `timeoutMs` up to 60,000). Waiting or canceling a wait doesn't stop the worker. Siblings run independently. `steer_subagent` takes `id` and `message`; steering queues input after the current tool calls, before the next model call. It doesn't interrupt a blocked tool or restart a terminal worker. `stop_subagent` takes `id`, clears queued input, aborts work and closes the process. Stopping a terminal worker is a no-op.

Each result has `status` (`starting`, `running`, `completed`, `failed`, `stopped`, `interrupted`), an `attempt` number, bounded text, cumulative usage, an actionable error when needed, and session, RPC transcript and saved-result paths. Startup failures retain the ID and evidence. Text and error fields are capped at 16,384 characters. State, saved configuration and full transcripts live in private directories under `<agent-dir>/pi-rpc-subagents/`, keyed by the parent's canonical session file, so custom session IDs in different projects don't collide. Omit `id` from `get_subagent_result` to recover the list after compaction. Terminal retrieval reports only usage not previously reported, including across reload, restart and resumed attempts. A background worker sends one completion per attempt, queued as a parent follow-up. Recovery checks completion and usage markers against the parent's persisted entries, so a crash before delivery doesn't acknowledge a result the parent never received. Read transcripts and check actual output rather than relying on the summary.

`startupTimeoutMs` defaults to 20,000. `runTimeoutMs` defaults to 600,000 and caps time through settlement, including retries and tool calls. A missed deadline fails the worker and closes its process. Foreground cancellation stops its worker; background work outlives the launching tool call. Parent quit or session replacement stops owned workers and records interruption. Compaction and reload keep the same live process handles, with fresh completion callbacks after reload. After parent death, child processes abort and shut down when they detect the lost parent. Reopening the parent's saved session reconstructs disk state, never reattaches a PID, and treats an unrecorded settlement as interrupted. A session lock refuses another live parent controlling the same children. Each child also holds a local socket until shutdown; resume is refused while a previous child still owns the conversation, even if its parent has already died.

Resume explicitly with `subagent` using `resume: "<worker ID>"`, the original `cwd`, and a new `task`. It opens the exact saved child session, keeps the ID, increments `attempt`, and refuses overlapping attempts. Model/thinking default to the child's last confirmed startup values, not the current parent; explicit overrides are allowed. A failed model override doesn't replace those defaults, including after restart. Agent instructions, read-only rules, tool allowlists and required capabilities persist. Resume can't change cwd or agent, broaden an allowlist, or remove earlier requirements. It rechecks capabilities before sending the new prompt. A child that failed before creating a persisted conversation can't resume -- launch a fresh worker instead. Don't delete recovery directories while controlling their workers. An ephemeral parent (`--no-session`) can't recover its worker list after restart.

## Interactive controls

`/subagents` or **Ctrl+Alt+S** opens the same live overlay, even while the parent is working. Use the command if your terminal can't send the shortcut. The overlay is TUI-only; RPC clients keep using the existing tools.

- **List:** opens on **Active** -- starting/running workers, including stopping ones. Tab or Shift+Tab switches to **History** for completed/failed/stopped/interrupted workers; both counts stay visible. ↑/↓ selects; Enter opens the conversation. Each row shows the latest assistant text or tool output, including partial output while running. Each list remembers selection while open. If a selected worker leaves the list, the nearest remaining row is selected. Esc or Ctrl+C closes without stopping workers.
- **Detail:** ↑/↓ and PgUp/PgDn scroll output; Home goes to the start; End returns to following new output. Scrolling back stays put while output arrives.
- **Output focus:** Ctrl+O expands/collapses tool arguments and results; Ctrl+T expands/collapses thinking. These use pi's configured tool/thinking shortcuts and affect only this view. Thinking starts collapsed. Tool results show their last three lines, capped at 600 characters, with long lines clipped to the latest text. A clipping notice and the shortcut hint offer the full result.
- **Tab / Shift+Tab:** switches between output and steering input. Detail opens with **Output focus**; inactive steering shows `Tab to edit` without a cursor. **Steering focus** shows the editable input and cursor; switching back keeps your draft and cursor position. Enter in the input sends directly to this running worker. Queued feedback isn't proof of delivery -- steering waits for current tools and doesn't interrupt a blocked command. Failed sends retain your input.
- **Ctrl+C in detail:** stops only this worker, including from the steering input. Stopping feedback lasts until it settles. Files aren't undone. Detail stays on that worker through status changes; Esc selects it in its current Active/History list without stopping anything.

Closing preserves the parent draft and cursor and releases only viewer resources. Reopening rebuilds conversation history, including terminal and partial output. Reload/session replacement closes an open view; reopen to use the current parent's registry. Viewing doesn't report usage or acknowledge completions. No sidebar or UI resume control.

## Internal viewer interface

`Registry.observe(listener)` creates a session-scoped `RegistryView`. `summaries()` returns every worker, including starting and terminal workers, with its current task, saved agent name, model, cwd, attempt, status and separate `stopping` feedback. Worker additions and summary changes emit `{kind: "worker", id}`. This subscription doesn't replace `registry.changed`, which still owns footer/completion delivery.

`view.activity(id, listener)` returns a `WorkerActivity`. Await `ready` for its initial history; `loading` and `historyError` support loading/error feedback. `entries` is a borrowed, read-only ordered projection of the RPC transcript and live records -- not the bounded result text. Message entries retain text, thinking and tool-call blocks; tool entries correlate execution updates/results by call ID, including nested calls. Tool-result messages update that execution entry instead of adding a duplicate. Other lifecycle/error/queue records are event entries. Partial messages/tools stay incomplete if their attempt ends without a final record. New transcripts include `worker_attempt` markers with task/agent identity; older transcripts infer attempts from settlement markers.

The overlay loads history only for visible list rows or the open detail. Opening detail reuses that row's history; leaving the viewport releases it. History is read asynchronously once per activity view, up to a captured byte boundary. Later records are buffered during that read, then applied in order. Each entry has a stable `id` and a `revision`; `{kind: "history", from}` identifies the earliest changed entry for layout caches. Rendering should use these cached entries, not reread the transcript. `summary()` and `{kind: "summary"}` provide current identity/status independently of history. Message tool-call blocks describe the request; tool entries describe its execution, so a renderer needn't display the request twice.

`view.steer(id, message)` and `view.stop(id)` dispatch directly to the existing worker methods without reporting usage. Dispose an activity when it's no longer visible and the registry view when closing the interaction. Disposal frees history/subscriptions, not workers. `Registry.detach()` disposes all registry views and their details, emitting `{kind: "disposed"}`; old views then refuse actions. Reload can open a fresh view over the same live registry. Session replacement requires the new parent's registry. Viewing never calls `takeUsage`, reconciles ledgers, or acknowledges completion.

Test with Pi 1.0.0; development types are pinned to that version, while host libraries remain peers and aren't bundled. Completion delivery still uses the follow-up behavior described above. The [host capability probes](../../README.md#development) document why quiet waiting with explicit idle-abort suppression needs upstream support before it can ship.

This package doesn't manage tasks, worktrees, commits, goals or workflow recipes. A subprocess and a cwd aren't a security boundary. Review project resources before approving them.

From the repository root, run `pnpm run check` to typecheck and test. Tests use isolated `PI_CODING_AGENT_DIR` directories and deterministic providers; they don't need credentials or a live task store.
