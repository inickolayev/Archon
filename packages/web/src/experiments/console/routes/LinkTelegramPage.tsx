import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import * as skill from '../skills';
import type { LinkPreview } from '../skills/account';
import { invalidate } from '../store/cache';
import { K } from '../store/keys';

/**
 * The confirmation screen of the Telegram handshake.
 *
 * The operator arrives here from a one-time link the bot sent. Nothing is
 * linked by opening it: the page says what would be connected to which
 * account, and waits. Confirming spends the token — a second visit finds it
 * gone, which is the point.
 */
export function LinkTelegramPage(): ReactElement {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'linking' | 'done'>('loading');
  const [result, setResult] = useState<{ movedRows: number; email: string | null } | null>(null);

  useEffect(() => {
    if (token === undefined) {
      setError('This link is incomplete.');
      setState('ready');
      return;
    }
    let cancelled = false;
    void skill
      .previewTelegramLink(token)
      .then(p => {
        if (!cancelled) {
          setPreview(p);
          setState('ready');
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'This link cannot be used');
          setState('ready');
        }
      });
    return (): void => {
      cancelled = true;
    };
  }, [token]);

  const confirm = useCallback(async () => {
    if (token === undefined) return;
    setState('linking');
    setError(null);
    try {
      const outcome = await skill.confirmTelegramLink(token);
      setResult({ movedRows: outcome.movedRows, email: outcome.email });
      invalidate(K.account);
      invalidate(K.directory);
      invalidate('conversations');
      setState('done');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not link the account');
      setState('ready');
    }
  }, [token]);

  return (
    <section className="flex h-full items-center justify-center p-6">
      <div
        className="w-full max-w-[460px] rounded-lg border bg-surface-inset p-5"
        style={{ borderColor: 'var(--border)' }}
      >
        <h1 className="text-[15px] font-semibold text-text-primary">Link Telegram</h1>

        {state === 'loading' ? (
          <p className="mt-3 text-[12px] text-text-tertiary">Checking the link…</p>
        ) : null}

        {error !== null ? (
          <>
            <p className="mt-3 text-[12px] text-error">{error}</p>
            <p className="mt-2 text-[11px] text-text-tertiary">
              Links work once and expire after a few minutes. Ask the bot for a new one: ☰ Menu →
              “Link this chat to my account”.
            </p>
          </>
        ) : null}

        {state === 'done' && result !== null ? (
          <>
            <p className="mt-3 text-[12px] text-text-primary">
              Linked{result.email !== null ? ` to ${result.email}` : ''}. Telegram messages now
              belong to this account.
            </p>
            {result.movedRows > 0 ? (
              <p className="mt-2 text-[11px] text-text-tertiary">
                {result.movedRows} existing rows moved across, so nothing was left behind.
              </p>
            ) : null}
            <div className="mt-4 flex gap-2">
              <Link
                to="/console/profile"
                className="rounded-md border px-3 py-1.5 text-[11px] text-text-secondary transition-colors hover:text-text-primary"
                style={{ borderColor: 'var(--border-bright)' }}
              >
                Open Profile
              </Link>
              <button
                type="button"
                onClick={() => {
                  navigate('/console');
                }}
                className="rounded-md border px-3 py-1.5 text-[11px] text-text-secondary transition-colors hover:text-text-primary"
                style={{ borderColor: 'var(--border-bright)' }}
              >
                Back to the console
              </button>
            </div>
          </>
        ) : null}

        {preview !== null && state !== 'done' && error === null ? (
          <>
            <dl className="mt-4 flex flex-col gap-2 text-[12px]">
              <div className="flex justify-between gap-3">
                <dt className="text-text-tertiary">Telegram</dt>
                <dd className="truncate text-text-primary">
                  {preview.telegram.displayName ?? 'the account that asked for this link'}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-text-tertiary">This console account</dt>
                <dd className="truncate text-text-primary">
                  {preview.account.name ?? preview.account.email ?? 'signed in'}
                </dd>
              </div>
            </dl>

            {preview.alreadyLinkedToThisAccount ? (
              <p className="mt-3 text-[11px] text-text-tertiary">
                These are already linked — confirming changes nothing.
              </p>
            ) : (
              <p className="mt-3 text-[11px] text-text-tertiary">
                Confirming moves that Telegram account&apos;s chats and messages to this account.
                Nothing is deleted.
              </p>
            )}

            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => {
                  void confirm();
                }}
                disabled={state === 'linking'}
                className="brand-bar rounded-md px-3 py-1.5 text-[11px] font-bold text-white disabled:opacity-50"
              >
                {state === 'linking' ? 'Linking…' : 'Link this account'}
              </button>
              <button
                type="button"
                onClick={() => {
                  navigate('/console');
                }}
                className="rounded-md border px-3 py-1.5 text-[11px] text-text-secondary transition-colors hover:text-text-primary"
                style={{ borderColor: 'var(--border-bright)' }}
              >
                Cancel
              </button>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
