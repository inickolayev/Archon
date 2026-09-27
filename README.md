# ops

Operations branch of this Archon fork — **not** engine code. Nothing here is ever merged into
`chesswin`, which is the point: our automation cannot conflict with upstream's.

| Branch | What it is |
|---|---|
| `chesswin` | the engine the ChessWin Factory pins: upstream plus our patches |
| `ops` | this branch: the nightly catch-up only. It must be the default branch, because GitHub fires `schedule:` from nowhere else |

## catch-up

`.github/workflows/catch-up.yml` runs at 03:30 MSK. It merges upstream's newest **green**
commit into `chesswin`, proves the result with this repository's own Test Suite, and moves
`chesswin` only when that passes. It never deploys: the Factory has its own nightly job that
notices `chesswin` moved ahead of its pin, rolls forward, checks that its workflow pack still
fits the new engine, and reports the outcome where a person reads it.

Three things it deliberately does not do:

- **trust upstream's tip.** A red commit of theirs would spend our night on their breakage, so
  it walks back to the newest commit their own Test Suite accepted;
- **trust a clean merge.** Upstream renames and rewrites files; git calls that a deletion, and
  our change disappears without a conflict marker. The proof, not the absence of conflicts, is
  the gate;
- **decide anything arguable.** Conflicts and a clean-but-red merge become an issue labelled
  `needs-agent`. Adding `sync-block` to an issue stops the following nights entirely, which is
  how a question stays a question instead of being buried by tomorrow's merge.

Why this exists and what it costs is in the Factory repository:
`docs/adr/0008-nightly-upstream-catch-up.md`.

Moving the Factory by hand is unchanged: merge into `chesswin`, push, then
`bin/repin-archon <sha>` there.
