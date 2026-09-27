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
import { existsSync } from 'node:fs';
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
    'packages/web/src/experiments/console/skills/nodeSource.ts',
    'packages/web/src/experiments/console/primitives/resource-ref.ts',
    'packages/web/src/experiments/console/primitives/resource-ref.test.ts',
    'packages/web/src/experiments/console/builder/model/authoring-shape.ts',
    'packages/web/src/experiments/console/builder/model/authoring-shape.test.ts',
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
