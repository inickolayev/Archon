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
    ['packages/workflows/src/dag-executor.ts', 'WORKFLOW_ID: workflowRunId'],
  ],
  'a conversation can start the run that does real work': [
    // Without these a chat can only launch workflows that declare no inputs — which is none
    // of ours (chesswin-factory ADR 0011).
    ['packages/core/src/orchestrator/manage-run-tool.ts', 'parseInputs'],
    ['packages/core/src/orchestrator/orchestrator-agent.ts', 'launch?.inputs'],
  ],
  'two people cannot start two runs on one target': [
    ['packages/core/src/orchestrator/manage-run-tool.ts', 'liveRunFor'],
  ],
  'a run says who asked for it': [
    ['packages/core/src/db/workflows.ts', 'user_display_name'],
    ['packages/web/src/experiments/console/components/RecentRunRow.tsx', 'run.startedBy'],
  ],
  // Upstream owns this file and ships `baseBranch: dev` in it, so a catch-up that takes their
  // version silently points every run in this repository at their branch instead of ours.
  'worktrees are cut from this fork, not from upstream': [['.archon/config.yaml', 'baseBranch: chesswin']],
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
