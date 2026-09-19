import { useCallback, useState, type FormEvent, type ReactElement } from 'react';
import { useNavigate } from 'react-router';
import { useEntity, invalidate, clearAll } from '../store/cache';
import { K } from '../store/keys';
import * as skill from '../skills';
import type { Account } from '../skills/account';
import { relativeTime } from '../lib/format';
import { performSignOut } from '../lib/session';
import { PlatformBadge } from '../components/PlatformBadge';

/**
 * The account: who you are here, what can sign in as you, and the way out.
 *
 * Name and password go through Better Auth's own endpoints — this page does
 * not invent an account model of its own. Linked sources (Telegram today) are
 * Archon's: they say which chat identities resolve to this account.
 */
export function ProfilePage(): ReactElement {
  const navigate = useNavigate();
  const { data: account, error, loading } = useEntity<Account>(K.account, () => skill.getAccount());

  if (loading) {
    return <div className="p-6 text-[12px] text-text-tertiary">Loading your account…</div>;
  }
  if (error !== undefined || account === undefined) {
    return (
      <div className="p-6 font-mono text-[12px] text-error">
        Could not load your account: {error?.message ?? 'unknown error'}
      </div>
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-col overflow-y-auto">
      <header className="shrink-0 border-b border-border px-6 py-4">
        <h1 className="text-base font-medium text-text-primary">Profile</h1>
        <p className="text-xs text-text-tertiary">
          Your account, what is linked to it, and how to sign out.
        </p>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-6 px-6 py-5">
        <IdentityCard account={account} />
        <PasswordCard />
        <LinkedSourcesCard account={account} />
        <SignOutCard
          signOut={() =>
            performSignOut({
              signOut: skill.signOut,
              // Wipe the cache before leaving: whatever is signed in next must
              // not read this account's projects and chats out of a warm store.
              clearAll,
              redirect: () => {
                navigate('/login', { replace: true });
              },
            })
          }
        />
      </div>
    </section>
  );
}

function Card({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}): ReactElement {
  return (
    <div
      className="max-w-[640px] rounded-lg border bg-surface-inset p-4"
      style={{ borderColor: 'var(--border)' }}
    >
      <h2 className="text-[13px] font-semibold text-text-primary">{title}</h2>
      {hint !== undefined ? <p className="mt-1 text-[11px] text-text-tertiary">{hint}</p> : null}
      <div className="mt-3">{children}</div>
    </div>
  );
}

const FIELD_CLASS =
  'w-full rounded-md border bg-surface px-2.5 py-1.5 text-[12px] text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1';
const BUTTON_CLASS =
  'rounded-md border px-3 py-1.5 text-[11px] text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50';

export function IdentityCard({ account }: { account: Account }): ReactElement {
  const [name, setName] = useState(account.name ?? '');
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  const save = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      setState('saving');
      setMessage(null);
      try {
        await skill.updateName(name.trim());
        invalidate(K.account);
        invalidate(K.directory);
        setState('saved');
      } catch (err) {
        setState('failed');
        setMessage(err instanceof Error ? err.message : 'Could not save the name');
      }
    },
    [name]
  );

  return (
    <Card title="You" hint="The name is what other people see next to your messages.">
      <form onSubmit={save} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-text-tertiary">
            Email
          </span>
          <span className="font-mono text-[12px] text-text-secondary">
            {account.email ?? 'not set'}
          </span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-text-tertiary">
            Name
          </span>
          <input
            value={name}
            onChange={e => {
              setName(e.target.value);
              setState('idle');
            }}
            placeholder="Your name"
            className={FIELD_CLASS}
            style={{ borderColor: 'var(--border-bright)' }}
          />
        </label>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={state === 'saving' || name.trim() === (account.name ?? '')}
            className={BUTTON_CLASS}
            style={{ borderColor: 'var(--border-bright)' }}
          >
            {state === 'saving' ? 'Saving…' : 'Save name'}
          </button>
          {state === 'saved' ? <span className="text-[11px] text-success">Saved</span> : null}
          {message !== null ? <span className="text-[11px] text-error">{message}</span> : null}
        </div>
      </form>
    </Card>
  );
}

export function PasswordCard(): ReactElement {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      setState('saving');
      setMessage(null);
      try {
        await skill.changePassword(current, next);
        setCurrent('');
        setNext('');
        setState('saved');
      } catch (err) {
        setState('failed');
        setMessage(err instanceof Error ? err.message : 'Could not change the password');
      }
    },
    [current, next]
  );

  return (
    <Card
      title="Password"
      hint="The current password is required. This window stays signed in afterwards."
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <input
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={e => {
            setCurrent(e.target.value);
            setState('idle');
          }}
          placeholder="Current password"
          className={FIELD_CLASS}
          style={{ borderColor: 'var(--border-bright)' }}
        />
        <input
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={e => {
            setNext(e.target.value);
            setState('idle');
          }}
          placeholder="New password"
          className={FIELD_CLASS}
          style={{ borderColor: 'var(--border-bright)' }}
        />
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={state === 'saving' || current.length === 0 || next.length < 8}
            className={BUTTON_CLASS}
            style={{ borderColor: 'var(--border-bright)' }}
          >
            {state === 'saving' ? 'Changing…' : 'Change password'}
          </button>
          {state === 'saved' ? <span className="text-[11px] text-success">Changed</span> : null}
          {message !== null ? <span className="text-[11px] text-error">{message}</span> : null}
        </div>
      </form>
    </Card>
  );
}

export function LinkedSourcesCard({ account }: { account: Account }): ReactElement {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // The web identity is the account itself, not an "external source".
  const external = account.identities.filter(identity => identity.platform !== 'web');

  const unlink = useCallback(async () => {
    if (
      !window.confirm(
        'Unlink Telegram from this account?\n\nThe chats stay here — messages from that Telegram account simply stop being you.'
      )
    ) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await skill.unlinkTelegram();
      invalidate(K.account);
      invalidate(K.directory);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Could not unlink');
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <Card
      title="Linked sources"
      hint="Chat accounts that write as you. Ask the bot for a link from its menu: ☰ Menu → Link this chat to my account."
    >
      {external.length === 0 ? (
        <p className="text-[12px] text-text-tertiary">
          Nothing linked yet. In Telegram: ☰ Menu → “Link this chat to my account”, then open the
          link it sends while signed in here.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {external.map(identity => (
            <li
              key={`${identity.platform}:${identity.platformUserId}`}
              className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
              style={{ borderColor: 'var(--border-bright)' }}
            >
              <span className="flex min-w-0 items-center gap-2">
                <PlatformBadge platformType={identity.platform} />
                <span className="truncate text-[12px] text-text-secondary">
                  {identity.displayName ?? identity.platformUserId}
                </span>
                {identity.linkedAt !== null ? (
                  <span className="shrink-0 font-mono text-[10px] text-text-tertiary">
                    linked {relativeTime(identity.linkedAt)}
                  </span>
                ) : null}
              </span>
              {identity.platform === 'telegram' ? (
                <button
                  type="button"
                  onClick={() => {
                    void unlink();
                  }}
                  disabled={busy}
                  className={BUTTON_CLASS}
                  style={{ borderColor: 'var(--border-bright)' }}
                >
                  Unlink
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {message !== null ? <p className="mt-2 text-[11px] text-error">{message}</p> : null}
    </Card>
  );
}

export function SignOutCard({ signOut }: { signOut: () => Promise<void> }): ReactElement {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  return (
    <Card title="Session" hint="Signing out ends it on the server and drops any pending link.">
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setMessage(null);
          void signOut().catch((err: unknown) => {
            setBusy(false);
            setMessage(err instanceof Error ? err.message : 'Could not sign out');
          });
        }}
        className={BUTTON_CLASS}
        style={{ borderColor: 'var(--border-bright)' }}
      >
        {busy ? 'Signing out…' : 'Sign out'}
      </button>
      {message !== null ? <p className="mt-2 text-[11px] text-error">{message}</p> : null}
    </Card>
  );
}
