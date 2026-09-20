import { requestJson } from '../lib/http';
import { toMessage, type Message } from '../primitives/message';

export async function listMessages(conversationId: string, limit = 500): Promise<Message[]> {
  const raw = await requestJson<Parameters<typeof toMessage>[0][]>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=${limit.toString()}`
  );
  return raw.map(toMessage);
}

/**
 * Call off the turn running in this conversation.
 *
 * Answers whether there was anything to stop. `false` is not a failure — the
 * turn may have finished between the click and the request — so the caller
 * shows it as information, not as an error.
 */
export async function stopConversation(conversationId: string): Promise<boolean> {
  const res = await requestJson<{ stopped: boolean }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/stop`,
    { method: 'POST' }
  );
  return res.stopped;
}
