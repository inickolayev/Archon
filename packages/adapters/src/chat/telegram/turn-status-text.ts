/**
 * What the transient status message says.
 *
 * One short line in the bot's own voice — the same plain, unhurried register as
 * `/help` and the menu — describing what the agent is doing at this moment, not
 * what it called. "Reading adapter.ts" rather than `READ file_path=…`: the
 * operator is looking at a phone, usually while walking, and wants to know that
 * something is happening and roughly what.
 *
 * NOTHING here may carry an absolute path. Tool-call lines like
 * `READ Reading: /Users/…/artifacts/uploads/…jpg` leaked into the chat once and
 * had to be removed (they are why `tool_call_formatted` is a structural
 * category the Telegram adapter refuses). A file's NAME is fine and genuinely
 * useful; the directory it lives in is the operator's disk, and belongs in the
 * console's trace, not in a chat message. Everything below therefore either
 * emits a fixed phrase or a basename — never a value copied out of a tool
 * input, and never the command a shell was handed.
 */

/** Marks a line as "still going", so the whole set reads as one thing. */
const WORKING = '⏳';

/** The very first thing a turn says, before it has called anything. */
export const STATUS_THINKING = `${WORKING} Thinking…`;

/**
 * A voice note being turned into words.
 *
 * The only state that exists BEFORE a turn does. Transcription happens at
 * ingest — the recording is fetched and recognised before the conversation
 * lock is even asked for — so a dictated message used to sit in silence for as
 * long as the recogniser took, which on a long recording is the better part of
 * a minute. That is the same silence the rest of this file exists to remove.
 */
export const STATUS_TRANSCRIBING = `${WORKING} Transcribing…`;

/**
 * Words ready, but the agent is still on the previous message.
 *
 * Only ever shown on a line that is already up — a dictated message that
 * finished transcribing into a busy chat. Saying "Thinking…" there would be a
 * lie (nothing is thinking about THIS message yet) and saying nothing would
 * leave "Transcribing…" on screen, stale, for however long the turn in front
 * takes. This says the true thing, and `begin` replaces it the moment the
 * turn actually starts.
 */
export const STATUS_QUEUED = `${WORKING} Waiting for the current turn…`;

/** Where a tool nobody has a phrase for lands. */
export const STATUS_WORKING = `${WORKING} Working…`;

/**
 * The one line left behind when the message cannot be deleted — Telegram
 * refuses after 48 hours, and a message somebody already removed by hand is
 * simply gone. Short, past tense, and true whatever the turn ended as: better
 * than "running tests" sitting in the chat forever.
 */
export const STATUS_FINISHED = '✓ Done.';

/** Longest file name shown; past this the middle is dropped, not the extension. */
const MAX_NAME_LENGTH = 32;

/** One working line, phrased consistently whatever produced it. */
function working(phrase: string): string {
  return `${WORKING} ${phrase}…`;
}

/**
 * The last segment of a path, and only that.
 *
 * Split on both separators regardless of host: a Windows-shaped path arriving
 * through an MCP tool must not slip past a POSIX-only split and be shown whole.
 */
function fileNameOf(input: Record<string, unknown> | undefined): string | null {
  const raw =
    input?.file_path ?? input?.filePath ?? input?.notebook_path ?? input?.path ?? input?.file;
  if (typeof raw !== 'string') return null;
  const name = (raw.split(/[\\/]/).pop() ?? '').trim();
  if (name === '') return null;
  if (name.length <= MAX_NAME_LENGTH) return name;
  // Keep both ends: the start says what it is, the end keeps the extension.
  return `${name.slice(0, MAX_NAME_LENGTH - 10)}…${name.slice(-9)}`;
}

/** `Reading adapter.ts` when the input names a file, `Reading files` otherwise. */
function onFile(verb: string, input: Record<string, unknown> | undefined, plural: string): string {
  const name = fileNameOf(input);
  return working(name === null ? plural : `${verb} ${name}`);
}

/**
 * What a shell call is for, never what it says.
 *
 * A command line is the one tool input that reliably carries absolute paths,
 * so it is classified and then thrown away. Three buckets is all the operator
 * needs: a test run is the thing worth waiting for, git is the thing worth
 * noticing, and everything else is just work.
 */
const TEST_RUNNER =
  /(^|[\s;&|(])(bun\s+test|vitest|jest|pytest|go\s+test|cargo\s+test|(npm|pnpm|yarn)\s+(run\s+)?test)\b/;
const GIT_CALL = /(^|[\s;&|(])git\s/;

function onCommand(input: Record<string, unknown> | undefined): string {
  const command = typeof input?.command === 'string' ? input.command : '';
  if (TEST_RUNNER.test(command)) return working('Running tests');
  if (GIT_CALL.test(command)) return working('Running git');
  return working('Running a command');
}

/**
 * The MCP server a call went to — `mcp__chesswin-admin__bots_list` is
 * `chesswin-admin`. A server name is configuration the operator chose, not a
 * path, so naming it is both safe and the most informative thing available.
 */
function onMcpTool(toolName: string): string {
  const server = toolName.split('__')[1]?.trim();
  return working(server === undefined || server === '' ? 'Using a tool' : `Asking ${server}`);
}

/**
 * One line for one tool call, in plain words.
 *
 * Names are matched case-insensitively and with the aliases different providers
 * use for the same act (`Edit`/`MultiEdit`, `Bash`/`shell`), because the phrase
 * describes the act rather than the SDK. An unknown tool is not a problem worth
 * a special case — "Working" is honest, and the turn goes on.
 */
export function describeTool(toolName: string, toolInput?: Record<string, unknown>): string {
  const name = toolName.trim().toLowerCase();
  if (name.startsWith('mcp__')) return onMcpTool(name);
  switch (name) {
    case 'read':
    case 'notebookread':
      return onFile('Reading', toolInput, 'Reading files');
    case 'write':
    case 'create_file':
      return onFile('Writing', toolInput, 'Writing files');
    case 'edit':
    case 'multiedit':
    case 'notebookedit':
    case 'apply_patch':
      return onFile('Editing', toolInput, 'Editing files');
    case 'bash':
    case 'bashoutput':
    case 'shell':
    case 'run_command':
      return onCommand(toolInput);
    case 'glob':
      return working('Looking for files');
    case 'grep':
    case 'search':
      return working('Searching the repo');
    case 'websearch':
      return working('Searching the web');
    case 'webfetch':
      return working('Reading a web page');
    case 'task':
    case 'agent':
      return working('Asking a sub-agent');
    case 'todowrite':
      return working('Planning the work');
    case 'exitplanmode':
      return working('Finishing the plan');
    case 'killshell':
      return working('Stopping a command');
    case 'slashcommand':
      return working('Running a command');
    default:
      return STATUS_WORKING;
  }
}
