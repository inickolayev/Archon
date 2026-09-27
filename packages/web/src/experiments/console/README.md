# Console

The console is Archon's only shipped Web application. Its historical directory
name remains in place to avoid a mechanical move while the builder is changing.

## Routes

- `/console` → all runs
- `/console/settings` → assistant, provider, system, and identity settings
- `/console/profile` → the signed-in account: display name, linked Telegram,
  sign out (clears this console's cache, not only the session)
- `/console/link/:token` → completes a Telegram account link opened from the bot
- `/console/builder` → experimental workflow builder and project picker
- `/console/builder/:name` → edit a project workflow selected by
  `?project=<id>`
- `/console/r/:runId` → run detail without requiring a project URL
- `/console/p/:projectId` → project runs
- `/console/p/:projectId/chat` → project operator chat (redirects to the most
  recent chat of that project)
- `/console/p/:projectId/chat/:conversationId` → one chat of that project;
  `new` is an unsent chat, created on the first send. A project holds as many
  chats as the operator starts
- `/console/p/:projectId/r/:runId` → project-scoped run detail

## Ownership

- Console API calls live in `skills/`.
- Reactive data lives in `store/cache.ts`.
- Generated API shapes come from `@/lib/api.generated`.
- Shared application code is limited to authentication, generated API types,
  node-reference parsing, IDE links, and global styling.
- The `builder/` subtree remains experimental and keeps its own pure model,
  validation, editor, and serialization layers.

## What a node runs

A command node names a markdown file and a script node names a script file; neither
is readable from the definition alone, and inside a workflow pack the name is
qualified out of recognition. Both surfaces that show nodes can open the file itself:
the builder's inspector, under the node's own fields, and each node divider in a run
(`file`). `GET /api/workflows/:name/nodes/:nodeId/source` resolves it in the
workflow's context — the resolution a run uses — and answers with the text, the path
it came from and the scope that won. A node carrying its own text (an inline prompt,
a bash body) answers with that text instead: static include expansion compiles an
included command's markdown INTO the node, so in a composed run that is where the
prompt lives.

## Chat behavior

A voice message is transcribed and arrives as text; a reply may carry images,
which render inline in the transcript. The composer records a clip into the same
attachment list, so it is sent, removed or replayed like any other attachment.

The composer accepts up to five files of 10 MB each. A new conversation must be
created with a text-only first message because conversation creation uses JSON;
the UI asks the operator to attach files on the next turn.

On authenticated installations, the console requests the signed-in user's
project conversation and sends the active identity with each turn. Solo
installations operate without an identity.

## Persisted view preferences

| Key | Default | Purpose |
| --- | --- | --- |
| `archon.console.detailView` | `log` | Run-detail tab |
| `archon.console.showToolCalls` | `1` | Show tool calls in the stream |
| `archon.console.showSystem` | `0` | Show system events |
| `archon.console.runNodeFilter` | `all` | Filter the run stream by node |
| `archon.console.railWidth` | unset | Project rail width |
| `archon.console.lastWorkflow` | unset | Last selected workflow |
| `archon.console.builderProject` | unset | Builder project selection |

Local storage reads are guarded and fall back to these defaults.
