# Workspace runtime

The local runtime exposes registered project files, the existing command runner,
and persistent interactive terminals to the IDE. Requires Node.js 22 or newer.

```sh
npm ci
npm run check
npm test
npm start
```

`node-pty` is pinned to `1.1.0` with a lockfile. It is an optional native
dependency so file access and the command runner still start when its installation
fails. Building from source requires Python and a C/C++ build toolchain; see the
[upstream installation instructions](https://github.com/microsoft/node-pty#dependencies).
Check the package installation log if `/healthz` reports `pty: false`. A successful
import is advertised as PTY capability; a shell spawn failure returns
`503 PTY_UNAVAILABLE` while the old command API remains usable. Missing-native
`pty: false` selects the IDE's command fallback automatically; a spawn failure
after a successful import is reported as a terminal-opening error with retry.

## Security boundary

**A terminal is a real host shell running as the runtime's OS user. It is not a
sandbox.** Its initial directory is the registered workspace, but commands can
change directories, access other files, inherit environment variables and launch
programs with that user's permissions. HTTP workspace scoping protects session
ownership, not the host filesystem from a shell command. Do not expose this
runtime to untrusted clients or register untrusted origins. Use OS/container
isolation when host-level isolation is required. The runtime binds to loopback by
default and retains its existing origin and pairing-token authentication gates.

The client cannot choose an executable, shell path, arguments, environment or
initial directory. The runtime selects `/bin/bash` then `/bin/sh` on Linux,
`/bin/zsh`, `/bin/bash`, then `/bin/sh` on macOS, or system PowerShell then cmd on
Windows. Normal interactive shell startup configuration applies.

## Interactive terminal protocol

All routes below are relative to
`/api/v1/runtime/workspaces/:workspaceId`. Every request requires the existing
pairing token, an allowed origin (when sent), and a registered workspace.
`/healthz` and `/api/v1/runtime/pair` advertise `pty: boolean`, plus `ptyReason`
when native support is unavailable. The previous `/terminal/commands` and
`/terminal/sessions/:id` routes are unchanged.

| Method | Path | Body / result |
| --- | --- | --- |
| GET | `/terminal/pty` | `{ sessions }`; metadata only, no replayed output |
| POST | `/terminal/pty` | `{ cols?, rows?, clientId? }` → `{ session }`; 201 created, 200 existing |
| GET | `/terminal/pty/:id?cursor=0&waitMs=20000` | `{ session }`; cancellable long poll |
| POST | `/terminal/pty/:id/input` | `{ data }` → `{ session }` with empty output |
| POST | `/terminal/pty/:id/resize` | `{ cols, rows }` → `{ session }` with empty output |
| DELETE | `/terminal/pty/:id` | `{ stopped: true, removed: true }` |

`clientId` is an optional 1–128 character ASCII alphanumeric, underscore or hyphen
identifier. Repeated creates with that identifier reuse the retained session in
the same workspace, including exited sessions, preventing duplicate shells on
retries/remounts. Deleting a session removes that association. Sessions live in
memory, survive browser detach/reconnect, and do not survive runtime restart.

A session contains `id`, `workspaceId`, `clientId`, `shell`, `cwd`, `cols`, `rows`,
`running`, `exitCode`, `signal`, `pid`, `startedAt`, `endedAt`, `removed`, `output`,
`startCursor`, `nextCursor`, and `truncated`. `cwd` is the **initial absolute
directory**, not a promise to track the shell's subsequent `cd` commands.
`signal` follows node-pty's numeric signal value, or is null when absent.

Output preserves ANSI sequences, control characters, line endings and Unicode.
Cursors count absolute JavaScript UTF-16 code units, including discarded output.
Consume output only from create/replay/poll results; write and resize responses
must not advance the reader's cursor. Use each poll's `nextCursor` on the next
request. If `truncated` is true, reset the terminal display before writing the
retained tail and tell the user that older output was lost. The tail is raw
stream data, not a screen snapshot, so applications using an alternate screen may
need to redraw after reconnecting beyond retention. Replay with `cursor=0` on a
fresh emulator to restore retained output. Invalid or negative cursors are 400;
future cursors return the current end immediately.

Polls wait for output, resize, process exit or deletion, up to 20 seconds. Set
`waitMs=0` for an immediate snapshot. Clients should allow at least 25–30 seconds
for transport timeout and abort the HTTP request on detach; cancellation removes
its waiter and timer. Keep one reader per visible terminal. A terminal permits
at most eight concurrent readers.

## Resource limits and cleanup

- At most eight retained/closing sessions per workspace and 64 globally
- 1 MiB of raw UTF-8 output retained per session, never splitting code points
- 64 KiB UTF-8 input per write; bounded JSON body (including escaped controls)
- Dimensions: 2–500 columns, 1–300 rows; defaults 80 × 24
- Detached running shells expire after 30 minutes without reads/input/resize
- Exited sessions expire five minutes after exit; cleanup sweeps every 30 seconds
- Output alone does not extend the detached TTL; active polling does
- Delete, workspace removal and runtime shutdown close their PTYs and release
  waiting readers. Closing processes still count toward admission limits until
  their exit callbacks run

Terminal deletion intentionally force-stops the shell and its current process
tree. On Unix the runtime snapshots descendants before stopping the shell; on
Windows it uses `taskkill /T /F`. Deliberately daemonized/reparented processes
cannot be guaranteed to remain in that tree; robust containment requires an OS
job/container boundary. Ctrl+C is ordinary PTY input (`\u0003`), so shell job
control interrupts foreground programs without closing the terminal.

Tests cover the injectable manager's limits, Unicode, cursors, idempotency,
isolation, cleanup and canceled polling, plus authenticated HTTP integration and
a real native TTY (ANSI, persistent cwd/environment, dimensions, Ctrl+C and
shutdown). Native integration is explicitly skipped if node-pty is unavailable;
the missing-native fallback is tested separately. Linux is exercised in this
change; macOS/Windows native behavior still needs platform validation.
