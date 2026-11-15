/**
 * Orchestrator Agent - Main entry point for AI-powered message routing
 *
 * Single entry point for all platforms:
 * - Knows all registered projects and workflows upfront
 * - Can answer directly or invoke workflows
 * - Does NOT require a project to be selected before starting a conversation
 */
import { createSqlWorkflowOperations, createWorkflowHostStore } from '../workflows/sql-host';
import { createWorkflowStore } from '../workflows/store-adapter';
import { attentionQueueSource, resolveAttentionProject } from '../operations/attention-queue';
import { existsSync } from 'fs';
import type {
  IPlatformAdapter,
  HandleMessageContext,
  Conversation,
  Codebase,
  CommandResult,
} from '../types';
import type { SendQueryOptions } from '@archon/providers/types';
import * as db from '../db/conversations';
import * as codebaseDb from '../db/codebases';
import * as sessionDb from '../db/sessions';
import * as commandHandler from '../handlers/command-handler';
import { withTrailingTextNotice } from '../handlers/command-trailing-text';
import { handleTelegramChatCommand, isTelegramChatCommand } from '../conversations/telegram-chats';
import { handleTelegramMenuCommand, isMenuCommand } from '../conversations/telegram-menu';
import { createTelegramChatStore } from '../conversations/telegram-chat-store';
import { parseTelegramConversationId } from '../conversations/telegram-conversation-id';
import { classifyAndFormatError } from '../utils/error-formatter';
import { toError } from '../utils/error';
import { quoteCommandArg } from '../utils/command-args';
import { getAgentProvider } from '../services/provider-admission';
import { buildManageRunTool } from './manage-run-tool';
import { buildAttentionTool } from './attention-tool';
import { beginTurn, TURN_STOPPED_NOTICE } from './turn-control';
import { withPersistedOutbound } from './outbound-persistence';
import {
  buildInvokeWorkflowTool,
  buildRegisterProjectTool,
  buildReportWorkflowNoMatchTool,
  type ChatLaunch,
} from './chat-tools';
import { ensureArchonWorkspacesPath } from '@archon/paths';
import type { ResolvedWorkflow, WorkflowWithSource } from '@archon/workflows/schemas/workflow';
import { loadConfig } from '../config/config-loader';
import { reportUnpushedWorkInSource } from './post-message-reminder';
import { getLog } from './agent-log';
import {
  type ChatTurn,
  type ChatTurnInput,
  handleBatchMode,
  handleStreamMode,
  reportChatTurn,
} from './chat-turn';
import { prepareChatTurnRequest, type ChatTurnRequest } from './chat-request';
import {
  buildFullPrompt,
  discoverAllWorkflows,
  inheritThreadContext,
  loadPausedGateContext,
  loadWorkflowResultContext,
  reportWorkspaceSync,
} from './chat-context';
import {
  handleDetachProject,
  handleRegisterProject,
  handleRemoveProject,
  handleSetProject,
  handleUpdateProject,
  registerProject,
} from './project-commands';
import * as messageDb from '../db/messages';
import {
  continueResolvedGateRun,
  dispatchOrchestratorWorkflow,
  handleWorkflowRunCommand,
  type ResolvedGate,
} from './workflow-dispatch';

// ─── Main Handler ───────────────────────────────────────────────────────────

/**
 * Handle a message through the orchestrator agent.
 * Single entry point for all platforms — routes slash commands deterministically,
 * and routes everything else through the AI orchestrator which knows all projects
 * and workflows upfront.
 */
export async function handleMessage(
  inboundPlatform: IPlatformAdapter,
  conversationId: string,
  message: string,
  context: HandleMessageContext
): Promise<void> {
  const {
    issueContext,
    threadContext,
    parentConversationId,
    attachedFiles,
    actor,
    workflowName,
    userMessagePersisted,
  } = context;
  const userId = actor.kind === 'user' ? actor.userId : undefined;
  // Swapped for a persisting wrapper as soon as the conversation row is known
  // (a few lines into the try below). Everything after that point — refusals,
  // command answers, streamed bubbles, the closing note of a stopped turn —
  // reaches the history by being DELIVERED, so no send site has to remember to
  // write one. Before that point there is no row to write against.
  let platform = inboundPlatform;
  // Anchor "is this a slash command" at the true start of the message —
  // leading whitespace (e.g. from a platform that doesn't pre-trim after
  // stripping a bot mention) must not let a command masquerade as a plain
  // AI turn. Mirrors the trim already done inside commandHandler.parseCommand.
  const trimmedMessage = message.trim();
  // Claimed for the whole turn, not just the provider call: setup can take
  // seconds of its own (workspace sync, workflow discovery), and an operator
  // who has already seen the misunderstanding should not have to wait for the
  // model to start before the stop button means anything.
  const stopHandle = beginTurn(conversationId);
  try {
    getLog().debug({ conversationId, userId }, 'orchestrator_message_received');

    const parsed =
      workflowName === undefined && trimmedMessage.startsWith('/')
        ? commandHandler.parseCommand(message)
        : undefined;
    if (parsed?.command === 'detach-project') {
      const reply = await handleDetachProject(
        platform,
        conversationId,
        parsed.args,
        parentConversationId
      );
      await platform.sendMessage(conversationId, reply);
      return;
    }

    // 1. Get/create conversation and inherit thread context.
    // userId is recorded on the conversation row only on first creation —
    // first-user-wins. The row's user_id is provenance plus a fallback for
    // execution identity; each turn's prefs/credentials resolve from the
    // SENDER when the adapter supplied one (see executionUserId in prepareChatTurnRequest).
    // Per-message attribution happens on workflow_runs.
    // Adopt, don't fork: the browser can answer a Telegram-born conversation,
    // and the row it must land on is the one that already exists under that
    // platform id — whatever platform this turn is being delivered through.
    let conversation = await db.getOrAdoptConversation(
      platform.getPlatformType(),
      conversationId,
      undefined,
      parentConversationId,
      userId
    );
    // A row that exists but belongs to nobody gets its owner from the first
    // sender we can name: conversations created eagerly (Telegram's `+ New
    // chat` when the chat has no history to inherit from) and every row
    // written before accounts existed. Never an overwrite — see
    // claimConversationOwner.
    if (conversation.user_id === null && userId !== undefined) {
      const claimed = await db.claimConversationOwner(conversation.id, userId);
      if (claimed) conversation = { ...conversation, user_id: userId };
    }

    // Persist only when core owns message storage: an adapter that keeps its
    // own (the web adapter's buffer, which also records tool calls) would get
    // every reply twice (#1182).
    if (inboundPlatform.capabilities.messagePersistence === 'core') {
      platform = withPersistedOutbound(inboundPlatform, conversation.id);

      // The operator's own message, written before anything can decline the turn.
      // The surface that received it may have done this already, at the moment it
      // arrived and with the time the platform said it was sent (see
      // persistInboundMessage) — that is strictly better and this is the fallback
      // for surfaces that have not been wired for it.
      //
      // There is no ordering dance to get right here: every refusal below is
      // itself persisted as it is sent (the wrapper above), so the user row can
      // never end up alone and this can be the first thing the turn does.
      if (userMessagePersisted !== true) {
        await messageDb
          .addMessage(conversation.id, 'user', message, undefined, userId)
          .catch((e: unknown) => {
            const err = e instanceof Error ? e : new Error(String(e));
            getLog().warn(
              { err, errorType: err.constructor.name, conversationId },
              'orchestrator.user_message_persist_failed'
            );
          });
      }
    }

    conversation = await inheritThreadContext(
      platform,
      conversation,
      parentConversationId,
      conversationId
    );

    // 2. Check for deterministic commands
    if (
      await handleDeterministicCommand(
        platform,
        conversationId,
        message,
        conversation,
        parsed,
        context
      )
    ) {
      return;
    }

    // After the deterministic-command early-returns above so the commands that get
    // out of this state keep working.
    if (await refuseMissingCwdOverride(platform, conversationId, conversation)) return;

    // 3. Load codebases, discover workflows, build prompt
    //
    // Loaded here rather than with its other consumers further down so the
    // missing-project guard immediately below can read `default_cwd` without
    // paying a second query.
    const codebases = await codebaseDb.listCodebases();
    if (await refuseMissingProjectDirectory(platform, conversationId, conversation, codebases)) {
      return;
    }

    const discovery = await discoverAllWorkflows(conversation);
    const {
      workflows: workflowsWithSource,
      errors: workflowErrors,
      config: discoveredConfig,
      codebase: discoveredCodebase,
    } = discovery;
    const workflows: readonly ResolvedWorkflow[] = workflowsWithSource.map(ws => ws.workflow);
    if (workflowErrors.length > 0) {
      getLog().warn(
        { errorCount: workflowErrors.length, errors: workflowErrors },
        'workflow.discovery_errors_present'
      );
    }

    await reportWorkspaceSync(platform, conversationId, discovery);
    const workflowContext = await loadWorkflowResultContext(conversation, conversationId);
    const pausedGateContext = await loadPausedGateContext(platform, conversation, conversationId);

    const fullPrompt = buildFullPrompt(
      message,
      issueContext,
      threadContext,
      attachedFiles,
      workflowContext,
      pausedGateContext
    );
    const cwd = await resolveChatCwd(conversation, codebases);

    // 4. Update activity and get/create session
    await db.touchConversation(conversation.id);
    let session = await sessionDb.getActiveSession(conversation.id);
    if (!session) {
      session = await sessionDb.transitionSession(conversation.id, 'first-message', {
        ai_assistant_type: conversation.ai_assistant_type,
      });
    }

    // Reuse the config already loaded during workflow discovery (avoids a second disk read).
    // Fall back to loadConfig only when no codebase is scoped (discoveredConfig is undefined).
    const config = discoveredConfig ?? (await loadConfig());
    const { providerKey, requestOptions, caps } = await prepareChatTurnRequest({
      platform,
      conversationId,
      conversation,
      message,
      trimmedMessage,
      userId,
      codebases,
      workflows,
      config,
      cwd,
    });
    // The one thread that reaches the running agent from outside this
    // function. Every provider forwards it to its SDK, which is what actually
    // tears the subprocess down; without it a stop could only hide the answer,
    // not stop the work producing it.
    requestOptions.abortSignal = stopHandle.signal;

    // 5. Send to AI provider
    const aiClient = getAgentProvider(providerKey);
    const { gateResolution, pendingLaunch } = attachNativeTools(
      platform,
      conversation,
      actor,
      workflowsWithSource,
      caps,
      requestOptions
    );

    const turn = await runChatTurn(
      {
        platform,
        conversationId,
        aiClient,
        fullPrompt,
        originalMessage: message,
        cwd,
        session,
        conversation,
        requestOptions,
      },
      gateResolution,
      discoveredCodebase ?? null,
      context,
      providerKey
    );

    // Not every provider throws on abort — some end their stream and return
    // what they had. The turn is still over at the operator's request, so it
    // says so here and stops short of the post-turn work (a queued launch, the
    // unpushed-work reminder) that would otherwise treat it as a turn that ran
    // its course.
    if (stopHandle.wasStopped()) {
      await platform.sendMessage(conversationId, TURN_STOPPED_NOTICE);
      return;
    }

    await dispatchPendingLaunch(
      platform,
      conversationId,
      conversation,
      pendingLaunch.launch,
      turn.failed,
      context
    );
    await reportSourceWork(platform, conversationId, conversation, discoveredCodebase);

    getLog().debug({ conversationId }, 'orchestrator_message_completed');
  } catch (error) {
    const err = toError(error);
    // A stopped turn fails the same way a crashed one does — the provider
    // throws out of the abort — so the difference has to come from the handle,
    // not from the error. Saying "something went wrong" about an abort the
    // operator asked for would be a lie, and one that reads as a bug.
    const stopped = stopHandle.wasStopped();
    if (stopped) {
      getLog().info({ err, conversationId }, 'orchestrator_message_stopped');
    } else {
      getLog().error({ err, conversationId }, 'orchestrator_message_failed');
    }
    const userMessage = stopped ? TURN_STOPPED_NOTICE : classifyAndFormatError(err, platform);
    try {
      await platform.sendMessage(conversationId, userMessage);
    } catch (sendError) {
      getLog().error({ err: toError(sendError), conversationId }, 'error_notification_failed');
    }
  } finally {
    // Released before the lock is, so the next message — including one already
    // queued behind this turn — begins a turn of its own with a fresh signal.
    stopHandle.release();
  }
}

/**
 * Bind a conversation to a registered project from outside a message turn —
 * what the Telegram project buttons tap into. Reuses `/setproject` itself so
 * the session and worktree handling cannot drift between the two entry points.
 */
export async function setProjectForConversation(
  platformConversationId: string,
  projectName: string
): Promise<string> {
  const conversation = await db.findConversationByPlatformId(platformConversationId);
  if (conversation === null) return 'This chat has no conversation yet — send a message first.';
  return handleSetProject(`/setproject ${quoteCommandArg(projectName)}`, conversation);
}

async function dispatchPendingLaunch(
  platform: IPlatformAdapter,
  conversationId: string,
  conversation: Conversation,
  launch: ChatLaunch | null,
  failed: boolean,
  context: HandleMessageContext
): Promise<void> {
  // After the gate continuation: a launch has committed nothing yet, so unlike a resolved
  // gate it is dropped when the turn throws or ends in an error result, and the user sees
  // the error instead.
  if (launch !== null && failed) {
    getLog().info(
      { conversationId, workflowName: launch.entry.workflow.name },
      'orchestrator.invoke_workflow_dropped_failed_turn'
    );
  } else if (launch !== null) {
    const { entry, codebase, prompt, inputs } = launch;
    getLog().info(
      {
        conversationId,
        workflowName: entry.workflow.name,
        codebaseId: codebase.id,
        inputNames: Object.keys(inputs),
      },
      'orchestrator.invoke_workflow_dispatching'
    );
    await dispatchOrchestratorWorkflow(
      platform,
      conversationId,
      conversation,
      codebase,
      {
        kind: 'start',
        definition: entry.workflow,
        args: prompt,
        parseWarnings: entry.parseWarnings,
      },
      context.actor,
      context.isolationHints,
      entry.source,
      { inputs }
    );
  }
}

async function reportSourceWork(
  platform: IPlatformAdapter,
  conversationId: string,
  conversation: Conversation,
  codebase: Codebase | null | undefined
): Promise<void> {
  // Direct-chat turns may have written to source/. If there is local-only state
  // (uncommitted edits, unpushed commits), surface a one-line reminder so the
  // user can push or commit + push before the next worktree creation or
  // re-clone reclaims that work. No-op when no codebase is attached.
  // Use the codebase already fetched by discoverAllWorkflows — no second DB call.
  if (codebase) {
    try {
      await reportUnpushedWorkInSource(conversationId, codebase, platform);
    } catch (err) {
      getLog().warn(
        { err: err as Error, conversationId, codebaseId: conversation.codebase_id },
        'orchestrator.post_message_reminder_failed'
      );
    }
  }
}

async function runChatTurn(
  input: Omit<ChatTurnInput, 'turn'>,
  gateResolution: { resolved: ResolvedGate | null },
  codebase: Codebase | null,
  context: HandleMessageContext,
  providerKey: string
): Promise<ChatTurn> {
  const { platform, conversationId, conversation, aiClient, requestOptions } = input;
  const mode = platform.getStreamingMode();
  // The one line that ties a chat turn to both conversation ids, so grepping the
  // URL id finds the provider and model of every turn. `model` is read from the
  // options handed to the provider, never re-resolved, so it cannot disagree.
  getLog().info(
    {
      conversationId: conversation.id,
      platformConversationId: conversationId,
      provider: providerKey,
      model: requestOptions.model,
    },
    'orchestrator.chat_dispatch_started'
  );
  // `finally`, not straight-line code: the gate resolution is committed to the
  // DB the moment the tool call returns, so once the agent has resolved a gate
  // the continuation must run even if the rest of the turn throws — a provider
  // subprocess crash after a successful tool call would otherwise leave the run
  // resolved and parked with only a generic error to show for it. The outer
  // catch cannot cover this: it does not know about the resolution.
  // continueResolvedGateRun never throws, so this cannot mask the real error.
  const turn: ChatTurn = {
    startedAt: Date.now(),
    reported: false,
    failed: false,
  };
  const turnInput = { ...input, turn };
  try {
    if (mode === 'stream') {
      await handleStreamMode(turnInput);
    } else {
      await handleBatchMode(turnInput);
    }
  } catch (error) {
    // A provider that throws mid-turn never reaches the handler's own report. Count
    // the turn as failed here, once, then let the outer catch tell the user.
    if (!turn.reported) {
      reportChatTurn(turn, {
        platform: platform.getPlatformType(),
        provider: aiClient.getType(),
        model: requestOptions?.model,
        durationMs: Date.now() - turn.startedAt,
        outcome: 'failed',
      });
    }
    throw error;
  } finally {
    if (gateResolution.resolved !== null) {
      await continueResolvedGateRun(
        platform,
        conversationId,
        conversation,
        codebase,
        gateResolution.resolved.run,
        gateResolution.resolved.action,
        context.actor,
        context.isolationHints
      );
    }
  }
  return turn;
}

async function resolveChatCwd(
  conversation: Conversation,
  codebases: readonly Codebase[]
): Promise<string> {
  const scopedCodebase =
    conversation.codebase_id !== null
      ? codebases.find(c => c.id === conversation.codebase_id)
      : undefined;
  let cwd: string;
  if (scopedCodebase !== undefined) {
    cwd = conversation.cwd ?? scopedCodebase.default_cwd;
  } else {
    if (conversation.codebase_id !== null) {
      getLog().warn(
        { codebaseId: conversation.codebase_id },
        'orchestrator.scoped_codebase_not_found'
      );
    }
    cwd = await ensureArchonWorkspacesPath();
  }
  return cwd;
}

/**
 * Answer a turn that a slash command or a named workflow start owns, without the AI.
 * Returns whether the turn was handled.
 */
async function handleDeterministicCommand(
  platform: IPlatformAdapter,
  conversationId: string,
  message: string,
  conversation: Conversation,
  parsed: ReturnType<typeof commandHandler.parseCommand> | undefined,
  context: HandleMessageContext
): Promise<boolean> {
  const { actor, isolationHints, workflowName } = context;
  const deliverCommandResult = async (result: CommandResult): Promise<void> => {
    // A command reads only its own arguments; text typed after it would otherwise
    // vanish without a word. Say what was dropped (see command-trailing-text.ts).
    await platform.sendMessage(
      conversationId,
      parsed ? withTrailingTextNotice(result.message, parsed.command, message) : result.message
    );
    if (!result.workflow) return;
    await handleWorkflowRunCommand(
      platform,
      conversationId,
      conversation,
      result.workflow,
      actor,
      isolationHints,
      {
        // Declared inputs (#2554) arrive on the request context, not in the
        // command text — the run route is the only caller that sets them.
        inputs: context.workflowInputs,
        modelOverrides: context.workflowModelOverrides,
        runConfig: context.workflowRunConfig,
        // Between-run continuation (#2747), same channel.
        adoptRunId: context.workflowAdoptRunId,
        supersedesRunId: context.workflowSupersedesRunId,
      }
    );
  };

  // 2. Check for deterministic commands
  if (workflowName !== undefined) {
    await deliverCommandResult(
      await commandHandler.startWorkflow(conversation, workflowName, message, false, platform)
    );
    return true;
  }
  if (!parsed) return false;
  const { command } = parsed;
  if (await handleTelegramCommand(platform, conversationId, message, parsed)) return true;
  const deterministicCommands = [
    'help',
    'status',
    'reset',
    'workflow',
    'register-project',
    'update-project',
    'remove-project',
    'setproject',
    'commands',
    'init',
    'worktree',
  ];

  if (!deterministicCommands.includes(command)) return false;
  getLog().debug({ command, conversationId }, 'deterministic_command');
  if (command === 'register-project') {
    const result = await handleRegisterProject(message);
    await platform.sendMessage(conversationId, result);
    return true;
  }

  if (command === 'update-project') {
    const result = await handleUpdateProject(message);
    await platform.sendMessage(conversationId, result);
    return true;
  }

  if (command === 'remove-project') {
    const result = await handleRemoveProject(message);
    await platform.sendMessage(conversationId, result);
    return true;
  }

  if (command === 'setproject') {
    // Pass the full Conversation — handleSetProject updates by the DB
    // primary key (conversation.id, not the platform conversation id)
    // and needs the prior cwd/isolation state for the detach note.
    const result = await handleSetProject(message, conversation);
    await platform.sendMessage(conversationId, result);
    return true;
  }

  await deliverCommandResult(
    await commandHandler.handleCommand(conversation, message, actor, platform)
  );
  return true;
}

/**
 * Telegram-only chat management: a Telegram chat holds many conversations
 * (`<chat id>:<n>`), and these are how the operator moves between them from a
 * phone. The answers carry the buttons that belong with them — typing the
 * command still works, it is simply no longer the only way. The web console has
 * its own UI for the same thing. Returns whether the turn was handled.
 */
async function handleTelegramCommand(
  platform: IPlatformAdapter,
  conversationId: string,
  message: string,
  { command, args }: ReturnType<typeof commandHandler.parseCommand>
): Promise<boolean> {
  if (platform.getPlatformType() !== 'telegram') return false;
  if (!isTelegramChatCommand(command) && !isMenuCommand(command)) return false;
  const parsedId = parseTelegramConversationId(conversationId);
  if (parsedId === null) return false;
  getLog().debug({ command, conversationId }, 'telegram_chat_command');
  const store = createTelegramChatStore();
  const chatId = String(parsedId.chatId);
  const reply = await handleTelegramMenuCommand({
    command,
    args,
    chatId,
    store,
    runChatCommand: (chatCommand, chatArgs) =>
      handleTelegramChatCommand({ command: chatCommand, args: chatArgs, chatId, store }),
  });
  if (reply === null) return false;
  // `/start` and `/menu` read nothing after themselves, and a leftover command
  // in the composer is exactly how a paragraph of instruction ends up behind
  // one. Say what was dropped rather than answering the command as if the rest
  // had never been typed.
  await platform.sendMessage(
    conversationId,
    withTrailingTextNotice(reply.text, command, message),
    reply.keyboard ? { keyboard: reply.keyboard } : undefined
  );
  return true;
}

// A conversation's `cwd` override can outlive the directory it names. Every
// path that tears a worktree down (`archon isolation cleanup`, the periodic
// reaper, the isolation API route, a user's own `rm -rf`) marks the env row
// destroyed without touching the conversation row, so `cwd` keeps pointing at
// a path that is gone. Only the WORKFLOW path re-resolves isolation and
// notices; a chat turn reads `cwd` verbatim and hands it to the provider,
// which spawns its subprocess there and fails ENOENT — an error the Claude
// SDK reports as a binary/libc mismatch, sending the operator after entirely
// the wrong thing.
//
// Deliberately does NOT fall back to codebase.default_cwd: this conversation
// asked to work in an isolated worktree, and quietly relocating the agent
// into the live checkout would widen its write scope without consent. Which of
// the recovery commands applies depends on `isolation_env_id` — see the message
// branch below.
async function refuseMissingCwdOverride(
  platform: IPlatformAdapter,
  conversationId: string,
  conversation: Conversation
): Promise<boolean> {
  if (conversation.codebase_id !== null && conversation.cwd !== null) {
    if (!existsSync(conversation.cwd)) {
      getLog().warn(
        {
          conversationId: conversation.id,
          cwd: conversation.cwd,
          isolationEnvId: conversation.isolation_env_id,
        },
        'orchestrator.conversation_cwd_missing'
      );
      // The recovery advice branches on whether a worktree is still attached,
      // because `/worktree remove` hard-returns "This conversation is not using
      // a worktree." when `isolation_env_id` is null (command-handler.ts:428).
      // That state is reachable, not hypothetical: the `stale_cleaned` branch in
      // validateAndResolveIsolation (dispatch/isolation-resolver.ts) clears
      // `isolation_env_id` and leaves `cwd` set, so a workflow run can strand a
      // conversation exactly here and the next chat turn would be told to run a
      // command that dead-ends. `/setproject` clears the cwd override and works
      // in both states, so it is the one suggestion that always applies.
      await platform.sendMessage(
        conversationId,
        `This conversation's working directory no longer exists:\n\`${conversation.cwd}\`\n\n` +
          (conversation.isolation_env_id !== null
            ? 'Its isolated worktree was removed after this conversation was bound to it. ' +
              'Run `/worktree remove` to detach and go back to the project root, or ' +
              '`/setproject <name>` to rebind this conversation to a project.'
            : 'This conversation is not bound to an isolated workspace, so there is nothing ' +
              'to detach. Run `/setproject <name>` to rebind this conversation to a project.')
      );
      return true;
    }
  }
  return false;
}

// A registered project's directory can vanish under a long-lived conversation —
// the clone deleted, the folder moved, the volume holding it unmounted.
// Providers pass `cwd` straight to their subprocess, and `posix_spawn` reports
// a missing WORKING DIRECTORY as ENOENT against the EXECUTABLE's path, so the
// failure surfaces as "No such file or directory (os error 2)" on Codex or a
// bogus libc/architecture mismatch on Claude. Neither names the directory
// (#2663).
//
// Scoped to `conversation.cwd === null` on purpose. A conversation WITH a cwd
// override is a different situation with different recovery advice, handled by
// `refuseMissingCwdOverride` (#2551). The two conditions are disjoint on
// the same field with no mutation between the reads, which is what lets them sit
// side by side.
//
// `&& conversation.cwd === null` is load-bearing. Dropping it while leaving the
// target as `default_cwd` refuses a healthy turn: a conversation working in a
// live worktree, whose project root happens to be gone, would be told its
// project directory no longer exists and offered `/update-project` for a
// directory that turn never touches. Covered by `runs the turn when the cwd
// override is healthy but default_cwd is gone`.
//
// Widening it the other way — to `conversation.cwd ?? default_cwd`, moving the
// target with the condition — is instead unobservable here, because the guard
// `refuseMissingCwdOverride` already returns for every `cwd !== null` case. No test holds you to
// that one. Keep it narrow anyway: it becomes observable the moment that guard
// is moved, narrowed, or removed, at which point this guard would answer
// for a stale worktree with the wrong message, one that says nothing about
// `isolation_env_id`.
//
// Refuses rather than falling back to the workspaces root the way the
// `scopedCodebase === undefined` branch in `handleMessage` does: relocating the agent into a
// directory the user did not scope would widen its write scope without consent.
async function refuseMissingProjectDirectory(
  platform: IPlatformAdapter,
  conversationId: string,
  conversation: Conversation,
  codebases: readonly Codebase[]
): Promise<boolean> {
  if (conversation.codebase_id !== null && conversation.cwd === null) {
    const scoped = codebases.find(c => c.id === conversation.codebase_id);
    if (scoped !== undefined && !existsSync(scoped.default_cwd)) {
      getLog().warn(
        { conversationId, codebaseId: scoped.id, cwd: scoped.default_cwd },
        'orchestrator.codebase_cwd_missing'
      );
      await platform.sendMessage(
        conversationId,
        `This conversation's project directory no longer exists:\n\`${scoped.default_cwd}\`\n\n` +
          `The project "${scoped.name}" is still registered, but its folder is gone — ` +
          'deleted, moved, or on a volume that is no longer mounted.\n\n' +
          `- \`/update-project ${quoteCommandArg(scoped.name)} <new-path>\` ` +
          'to point it at the new location\n' +
          '- `/setproject <name>` to switch this conversation to a different project'
      );
      return true;
    }
  }
  return false;
}

/**
 * Give providers with in-process tools the chat's typed tools. Returns the holders
 * the tools write during the turn, which `handleMessage` acts on once it ends.
 */
function attachNativeTools(
  platform: IPlatformAdapter,
  conversation: Conversation,
  actor: HandleMessageContext['actor'],
  workflowsWithSource: readonly WorkflowWithSource[],
  caps: ChatTurnRequest['caps'],
  requestOptions: SendQueryOptions
): {
  gateResolution: { resolved: ResolvedGate | null };
  pendingLaunch: { launch: ChatLaunch | null };
} {
  // Written by the `manage_run` tool when the agent resolves a human gate
  // during this turn, and acted on once the turn ends (#2565). Resolving a
  // gate and continuing the run are two halves of one action — the tool
  // records the intent so its call returns immediately, and the resume runs
  // after the turn rather than blocking the agent loop on a whole workflow. Held in an
  // object because a `let` assigned only from a callback narrows to `null`.
  const gateResolution: { resolved: ResolvedGate | null } = { resolved: null };
  // Written by `invoke_workflow` and dispatched once the turn ends, for the same
  // reason: on a foreground surface the run would otherwise block the agent loop.
  const pendingLaunch: { launch: ChatLaunch | null } = { launch: null };

  // Providers with in-process native tools launch workflows, register projects and
  // read and answer the attention queue through typed tools in every chat.
  // Project-scoped chats also get `manage_run` to inspect and operate that project's runs.
  if (caps.nativeTools) {
    const operations = createSqlWorkflowOperations();
    const tools = [
      buildInvokeWorkflowTool({
        workflows: workflowsWithSource,
        listCodebases: () => codebaseDb.listCodebases(),
        listRuns: async codebaseId =>
          (await operations.listWorkflowRuns({ codebaseId, limit: 50 })).runs,
        onLaunch: launch => {
          if (pendingLaunch.launch !== null) return pendingLaunch.launch;
          pendingLaunch.launch = launch;
          return null;
        },
      }),
      buildRegisterProjectTool({ registerProject }),
      buildReportWorkflowNoMatchTool(),
      buildAttentionTool({
        actor,
        operations,
        queue: attentionQueueSource(createWorkflowStore(), createWorkflowHostStore().isolation),
        resolveProject: spec => resolveAttentionProject(codebaseDb, spec),
        codebaseId: conversation.codebase_id,
      }),
    ];
    if (conversation.codebase_id !== null) {
      tools.push(
        buildManageRunTool({
          actor,
          operations,
          codebaseId: conversation.codebase_id,
          surface: platform,
          // One continuation per turn: the resume runs in this conversation and
          // to completion, so a second gate resolved in the same turn is
          // declined rather than silently dropped (the tool tells the agent).
          onGateResolved: (run, action) => {
            if (gateResolution.resolved !== null) return false;
            gateResolution.resolved = { run, action };
            return true;
          },
        })
      );
    }
    requestOptions.nativeTools = tools;
  }
  return { gateResolution, pendingLaunch };
}
