# ops

Operations branch of this Archon fork — **not** engine code.

| Branch | What it is |
|---|---|
| `main` | untouched mirror of upstream `coleam00/Archon`, fast-forwarded daily by `sync-upstream` |
| `chesswin` | the engine the ChessWin Factory pins: upstream plus our patches |
| `ops` | this branch: the sync workflow only (it must live on the default branch for `schedule:` to fire) |

Moving the Factory onto newer upstream code is deliberate: rebase `chesswin` on `main`,
push, then repin the Factory with `bin/repin-archon <new sha>`.
