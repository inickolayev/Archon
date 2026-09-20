/**
 * The directories one conversation's answers may show pictures from.
 *
 * Both outbound paths ask the same question — the HTTP route that serves an
 * image to the browser, and the Telegram adapter that uploads it as a photo —
 * and they must not be able to answer it differently, so they share this.
 *
 * The answer is read from the conversation itself: the directory the turn works
 * in, the project it is bound to, and (added by `outboundImageRoots`) the system
 * temp directory, where a screenshot tool writes by default. A conversation with
 * no project therefore shows only what is under the temp directory.
 */

import { outboundImageRoots } from '@archon/core/messaging/image-access';
import * as conversationDb from '@archon/core/db/conversations';
import * as codebaseDb from '@archon/core/db/codebases';

/**
 * Roots for the conversation named by its platform id. A conversation that
 * cannot be found still gets the temp directory — a missing row is not a reason
 * to widen anything, and not a reason to narrow the default either.
 */
export async function conversationImageRoots(
  platformConversationId: string
): Promise<readonly string[]> {
  const conversation = await conversationDb.findConversationByPlatformId(platformConversationId);
  if (conversation === null) return outboundImageRoots([]);
  const codebase =
    conversation.codebase_id !== null
      ? await codebaseDb.getCodebase(conversation.codebase_id)
      : null;
  // Both, not one: a turn running in an isolation worktree has its own `cwd`,
  // while the answer may just as well point at a file in the main checkout.
  return outboundImageRoots([conversation.cwd, codebase?.default_cwd]);
}
