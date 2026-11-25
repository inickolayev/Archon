import { spellWorkflowCommand, type WorkflowCommandSurface } from '@archon/workflows/deps';
import type { CommandResult, Conversation } from '../../types';
import * as codebaseDb from '../../db/codebases';

export function helpCommand(surface: WorkflowCommandSurface, platformType: string): CommandResult {
  const cmd = (workflowCommand: string): string => spellWorkflowCommand(surface, workflowCommand);
  // Telegram holds many conversations per chat; those commands only exist
  // there, so only that platform's help mentions them.
  const telegramSection =
    platformType === 'telegram'
      ? `

**Buttons (no typing needed)**
- **Chats** — this chat's conversations; tap one to continue it
- **New chat** — start an empty conversation here
- **Project** — bind a registered project to this chat
- **Status** — where you are right now
- \`/menu\` brings the buttons back if they disappear

**The same by typing**
- \`/chats\`, \`/new\`, \`/switch <n>\`, \`/projects\`, \`/setproject <name>\``
      : '';
  return {
    success: true,
    message: `## Archon Orchestrator

Talk naturally — the orchestrator routes your requests to the right workflow and project automatically.

### Commands

**Chat**
- Just type your message — the orchestrator handles routing
- Mention a project by name and the orchestrator will use it
- Ask to "run [workflow] on [project]" for explicit invocation

**Workflows**
- \`${cmd('list')}\` — List available workflows
- \`${cmd('run <name> [message]')}\` — Run a workflow explicitly
- \`${cmd('status')}\` — Show all active workflows
- \`${cmd('get <id>')}\` — Show one run, whatever its status
- \`${cmd('cancel [id]')}\` — Cancel a running workflow (default: the one in this conversation)
- \`${cmd('resume <id>')}\` — Resume a failed, paused or killed run
- \`${cmd('abandon <id>')}\` — Abandon a running, failed, or paused run
- \`${cmd('approve <id>')}\` — Approve a paused gate
- \`${cmd('reject <id>')}\` — Reject a paused gate
- \`${cmd('watch <id>')}\` — Telegram: get this run's gates, questions and end here (\`unwatch <id>\` stops)
- \`${cmd('watch all')}\` — Telegram: get the gates of every run nobody started — the CLI, the nightly timer (\`unwatch all\` stops)
- \`${cmd('reset-sessions <name> [<node-id>]')}\` — Clear persisted AI session memory for this conversation

**Projects**
- \`/register-project <name> <path>\` — Register a local project
- \`/update-project <name> <new-path>\` — Update a project's path
- \`/remove-project <name>\` — Remove a registered project
- \`/setproject <name>\` — Bind this conversation to a registered project
- \`/detach-project "<current-project-name>"\` — Make this conversation neutral after resolving its runs and attached environment; keep the project registered

**Session**
- \`/status\` — Show current session and project info
- \`/reset\` — Clear conversation and start fresh
- \`/help\` — Show this help message${telegramSection}

### Tips
- You don't need to select a project first — just describe what you want
- The orchestrator knows all your registered projects and available workflows
- For project setup, ask the orchestrator: "How do I add a new project?"`,
  };
}

/** `/commands`: the commands registered for this conversation's project. */
export async function listRegisteredCommands(conversation: Conversation): Promise<CommandResult> {
  if (!conversation.codebase_id) {
    return { success: false, message: 'No codebase configured.' };
  }

  const commands = await codebaseDb.getCodebaseCommands(conversation.codebase_id);

  if (!Object.keys(commands).length) {
    return {
      success: true,
      message: 'No commands registered.\n\nAdd .md files to .archon/commands/ in your project.',
    };
  }

  let msg = 'Registered Commands:\n\n';
  for (const [name, def] of Object.entries(commands)) {
    msg += `${name} - ${def.path}\n`;
  }
  return { success: true, message: msg };
}
