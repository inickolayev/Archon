import type { ReactElement } from 'react';
import type { ApiToken } from '../skills';
import { formatDateTime, relativeTime } from '../lib/format';

const BUTTON_CLASS =
  'shrink-0 rounded border border-border px-2.5 py-1 text-console-11 text-text-secondary transition-colors hover:border-border-bright hover:text-text-primary disabled:opacity-40';

/** When the token stops working, as a person reads it. */
export function describeExpiry(expiresAt: string | null, now: number = Date.now()): string {
  if (expiresAt === null) return 'never expires';
  return Date.parse(expiresAt) <= now ? 'expired' : `expires ${formatDateTime(expiresAt)}`;
}

/**
 * The user's tokens. Revoking asks in place (a second click confirms) rather than
 * through window.confirm, so the prompt stays inside the page and the row it names.
 */
export function ApiTokenList({
  tokens,
  confirmingId,
  revokingId,
  onAskRevoke,
  onCancelRevoke,
  onRevoke,
}: {
  tokens: readonly ApiToken[];
  confirmingId: string | null;
  revokingId: string | null;
  onAskRevoke: (id: string) => void;
  onCancelRevoke: () => void;
  onRevoke: (id: string) => void;
}): ReactElement {
  if (tokens.length === 0) {
    return <p className="font-mono text-console-11 text-text-tertiary">No tokens yet.</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {tokens.map(token => (
        <li
          key={token.id}
          className="flex items-center justify-between gap-3 rounded border border-border bg-surface-inset px-3 py-2"
        >
          <div className="min-w-0">
            <div className="truncate text-console-12 font-medium text-text-primary">
              {token.name}{' '}
              <span className="font-mono text-console-11 text-text-tertiary">{token.prefix}…</span>
            </div>
            <div className="text-console-11 text-text-tertiary">
              created {relativeTime(token.createdAt)} ·{' '}
              {token.lastUsedAt === null ? 'never used' : `used ${relativeTime(token.lastUsedAt)}`}{' '}
              · {describeExpiry(token.expiresAt)}
            </div>
          </div>
          {confirmingId === token.id ? (
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-console-11 text-text-secondary">
                Revoke now? Clients using it stop working.
              </span>
              <button
                type="button"
                onClick={() => {
                  onRevoke(token.id);
                }}
                disabled={revokingId === token.id}
                className="rounded border border-error px-2.5 py-1 text-console-11 text-error transition-colors hover:bg-error/10 disabled:opacity-40"
              >
                {revokingId === token.id ? 'Revoking…' : 'Revoke'}
              </button>
              <button type="button" onClick={onCancelRevoke} className={BUTTON_CLASS}>
                Keep
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                onAskRevoke(token.id);
              }}
              className={BUTTON_CLASS}
            >
              Revoke
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
