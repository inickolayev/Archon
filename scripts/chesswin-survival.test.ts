/**
 * What this fork adds on top of upstream, asserted to still be here.
 *
 * This exists because of how upstream's changes actually reach us. They move and rewrite
 * files — `outcome.py` became `outcome.ts`, a whole workflow pack changed language — and git
 * reports that as "they deleted it". Our side of such a file survives as an orphan, or our
 * file goes with the rename and nothing conflicts: a merge can drop a whole feature of ours
 * without a single conflict marker, and the tests that would have noticed disappear together
 * with the code they covered.
 *
 * So the list below is deliberately a list of PATHS, not of behaviours. Behaviour is what the
 * ordinary tests are for; they run only as long as they exist. This asserts existence, which is
 * the one thing no other check in this repository does.
 *
 * Keeping it honest: a path here proves the file is present, never that it still works. When a
 * feature is deliberately removed or moved, edit this list in the same commit — that edit is
 * the record of the decision, and a reviewer should ask about it.
 *
 * The nightly upstream catch-up treats a failure here as "stop and tell a human"
 * (chesswin-factory ADR 0008).
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..');

/** Feature → the files without which it is simply gone. */
const OURS: Record<string, string[]> = {
  'several chats per project': [
    'packages/web/src/experiments/console/components/ChatList.tsx',
    'packages/web/src/experiments/console/components/ChatPicker.tsx',
    'packages/core/src/conversations/telegram-chats.ts',
    'packages/core/src/conversations/telegram-chats.test.ts',
  ],
  'Telegram access by account link, not by an id allowlist': [
    'packages/server/src/adapters/telegram-access.ts',
    'packages/server/src/adapters/telegram-access.test.ts',
    'packages/server/src/auth/link-tokens.ts',
    'packages/server/src/auth/link-tokens.test.ts',
    'packages/core/src/db/account-links.ts',
    'packages/core/src/db/account-links.test.ts',
    'packages/web/src/experiments/console/routes/LinkTelegramPage.tsx',
  ],
  'the operator can dictate': [
    'packages/server/src/voice/transcribe.ts',
    'packages/server/src/voice/transcribe.test.ts',
    'packages/server/src/voice/dictation.ts',
    'packages/server/src/voice/yandex-stt.ts',
    'packages/core/src/messaging/dictation.ts',
    'packages/core/src/messaging/dictation.test.ts',
  ],
  'the agent can answer with a picture': [
    'packages/core/src/messaging/image-references.ts',
    'packages/core/src/messaging/image-references.test.ts',
    'packages/core/src/messaging/image-access.ts',
    'packages/adapters/src/chat/telegram/outbound-images.ts',
    'packages/adapters/src/chat/telegram/outbound-images.test.ts',
    'packages/server/src/routes/api.conversation-images.test.ts',
  ],
  'attachments arrive the same way from the browser and from Telegram': [
    'packages/server/src/uploads/attachments.ts',
    'packages/server/src/uploads/attachments.test.ts',
    'packages/server/src/adapters/telegram-uploads.ts',
    'packages/server/src/adapters/telegram-uploads.test.ts',
  ],
  'the operator can stop a turn': [
    'packages/core/src/orchestrator/turn-control.ts',
    'packages/core/src/orchestrator/turn-control.test.ts',
  ],
  'an answer typed in the browser still reaches the phone': [
    'packages/server/src/adapters/mirror.ts',
    'packages/server/src/adapters/mirror.test.ts',
  ],
  'the model pickers list what each runtime offers now': [
    'packages/providers/src/claude/models.ts',
    'packages/providers/src/codex/models.ts',
    'packages/web/src/experiments/console/components/ModelPickerField.tsx',
  ],
  'a bare repository can own every checkout': [
    'packages/core/src/utils/workflow-source-root.test.ts',
  ],
  'a conversation survives a restart': [
    'packages/core/src/orchestrator/session-recovery.ts',
    'packages/core/src/orchestrator/session-recovery.test.ts',
    'packages/core/src/orchestrator/conversation-replay.ts',
  ],
  'the console shows the file a node runs': [
    'packages/workflows/src/resource-source.ts',
    'packages/workflows/src/resource-source.test.ts',
    'packages/web/src/experiments/console/components/NodeSourcePanel.tsx',
    'packages/web/src/experiments/console/components/NodeSourcePanel.test.tsx',
    'packages/web/src/experiments/console/skills/nodeSource.ts',
    'packages/web/src/experiments/console/primitives/resource-ref.ts',
    'packages/web/src/experiments/console/primitives/resource-ref.test.ts',
    'packages/web/src/experiments/console/builder/model/authoring-shape.ts',
    'packages/web/src/experiments/console/builder/model/authoring-shape.test.ts',
  ],
  // chesswin-factory ADR 0011 §6, issue #32: a run belongs to nobody, so it calls whoever asked.
  'a run calls its Telegram watchers to its gates and its end': [
    'packages/core/src/services/run-watchers.ts',
    'packages/core/src/services/run-watchers.test.ts',
    'packages/core/src/handlers/commands/workflow-watch.ts',
    'packages/core/src/handlers/commands/workflow-watch.test.ts',
    'packages/server/src/adapters/telegram-attention.ts',
    'packages/server/src/adapters/telegram-attention.test.ts',
    'packages/server/src/adapters/telegram-attention-text.ts',
    'packages/server/src/adapters/telegram-attention-text.test.ts',
  ],
  'the Factory runs its global pack under a pinned --workflow-source': [
    'packages/cli/src/commands/workflow-source-global.ts',
    'packages/cli/src/commands/workflow-source-global.test.ts',
    'packages/cli/src/commands/workflow-source-global.integration.spec.ts',
  ],
};

/**
 * The other half: ours living INSIDE a file that is upstream's.
 *
 * The list above asserts existence, which is the right question for a file we added — it either
 * survived the merge or it did not. It is the wrong question for a line we added to a file that
 * will always be there: `dag-executor.ts` is not going to disappear, and a merge that drops our
 * three lines out of it leaves every path above intact.
 *
 * So each entry is a file of theirs plus the smallest fragment of ours that cannot be there by
 * accident. A fragment, not a behaviour: behaviour is what the ordinary tests are for. And
 * deliberately not a line number or a whole block — upstream reformats, and a check that breaks
 * on reformatting teaches people to silence it.
 *
 * Feature → [their file, the fragment of ours it must still contain].
 */
const OURS_INSIDE_THEIRS: Record<string, [string, string][]> = {
  'the engine tells an agent which run it is in': [
    // Without this an agent inherits the server's environment, where no run exists, and the
    // harness cannot tell a conversation from a run (chesswin-factory ADR 0011, ADR 0007).
    // Upstream shipped the same guarantee independently (#4059: `buildAiNodeEnvironment`,
    // spread after project env in agent and loop nodes), superseding our line in
    // `dag-executor.ts`; the fragment now follows their implementation.
    ['packages/workflows/src/exec-environment.ts', 'WORKFLOW_ID: execution.runId'],
  ],
  'a conversation can start the run that does real work': [
    // Without these a chat can only launch workflows that declare no inputs — which is none
    // of ours (chesswin-factory ADR 0011). Upstream now carries this itself: chat launches
    // moved from manage_run's `start` (which we had taught to take inputs) to the typed
    // `invoke_workflow` tool, whose inputs ride the launch to the dispatch gate. The
    // fragments are theirs; what is ours is the need for them to stay.
    ['packages/core/src/orchestrator/chat-tools.ts', 'resolveLaunchInputs'],
    ['packages/core/src/orchestrator/orchestrator-agent.ts', '{ inputs }'],
  ],
  'two people cannot start two runs on one target': [
    // Ported from manage_run's `start` to `invoke_workflow` when upstream moved launches.
    ['packages/core/src/orchestrator/chat-tools.ts', 'liveRunFor'],
  ],
  'a run says who asked for it': [
    // Upstream split `db/workflows.ts` into `workflow-run-*` modules (#4509); the dashboard
    // query, and our join on it, now live in `workflow-run-lists.ts`.
    ['packages/core/src/db/workflow-run-lists.ts', 'user_display_name'],
    ['packages/workflows/src/schemas/workflow-run-listing.ts', 'user_display_name'],
    ['packages/web/src/experiments/console/components/RecentRunRow.tsx', 'run.startedBy'],
  ],
  // Upstream owns this file and ships `baseBranch: dev` in it, so a catch-up that takes their
  // version silently points every run in this repository at their branch instead of ours.
  'worktrees are cut from this fork, not from upstream': [
    ['.archon/config.yaml', 'baseBranch: chesswin'],
  ],
  // Without these the files above survive and nothing calls them: the bundled bot is no
  // destination of the attention router, and `/workflow watch` answers with the usage text.
  'a run calls its Telegram watchers to its gates and its end (wiring)': [
    ['packages/server/src/index.ts', 'createTelegramAttentionDestination('],
    ['packages/core/src/handlers/commands/workflow.ts', "case 'watch':"],
  ],
  // Without this the file above survives and admission ignores it: every `bin/factory run`
  // of the Factory's pack is refused again (chesswin-factory#40).
  'the Factory runs its global pack under a pinned --workflow-source (wiring)': [
    ['packages/cli/src/commands/workflow-run-admission.ts', 'workflowSourceAdmits('],
  ],
};

describe('what this fork adds is still here', () => {
  for (const [feature, paths] of Object.entries(OURS)) {
    test(feature, () => {
      const missing = paths.filter((path): boolean => !existsSync(join(REPO_ROOT, path)));
      expect(missing).toEqual([]);
    });
  }
});

describe('what this fork adds inside upstream files is still there', () => {
  for (const [feature, pairs] of Object.entries(OURS_INSIDE_THEIRS)) {
    test(feature, () => {
      const lost = pairs
        .filter(([path, fragment]): boolean => {
          const full = join(REPO_ROOT, path);
          if (!existsSync(full)) return true;
          return !readFileSync(full, 'utf-8').includes(fragment);
        })
        .map(([path, fragment]): string => `${path} no longer contains "${fragment}"`);
      expect(lost).toEqual([]);
    });
  }
});
