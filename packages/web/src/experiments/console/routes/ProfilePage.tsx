import { useCallback, useState, type FormEvent, type ReactElement } from 'react';
import { useEntity, invalidate, clearAll } from '../store/cache';
import { K } from '../store/keys';
import * as skill from '../skills';
import type { Account } from '../skills/account';
import { relativeTime } from '../lib/format';
import { leaveForSignIn, performSignOut } from '../lib/session';
import { errorText } from '../lib/http';
import { PlatformBadge } from '../components/PlatformBadge';
import { SettingsSection } from '../components/SettingsSection';
import { INPUT_CLASS } from '../components/SettingsFormPrimitives';

/**
 * The account: who you are here, what can sign in as you, and the way out.
 *
 * Name and password go through Better Auth's own endpoints — this page does
 * not invent an account model of its own. Linked sources (Telegram today) are
 * Archon's: they say which chat identities resolve to this account.
 */
export function ProfilePage(): ReactElement {
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
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="px-10 pt-[22px]">
        <h1 className="text-[22px] font-extrabold tracking-[-0.4px] text-text-primary">Profile</h1>
      </header>
      <div className="flex-1 overflow-y-auto px-10 pb-14 pt-5">
        <div className="mx-auto flex max-w-[680px] flex-col gap-[22px]">
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
                redirect: leaveForSignIn,
              })
            }
          />
        </div>
      </div>
    </div>
  );
}

/**
 * One profile card. Deliberately the settings card shell (`SettingsSection`) so
 * Profile and Settings are the same page in two places, with the hint carried
 * as the section's first line.
 */
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
    <SettingsSection title={title}>
      {hint !== undefined ? (
        <p className="-mt-[10px] mb-[14px] text-[12.5px] leading-[1.5] text-text-secondary">
          {hint}
        </p>
      ) : null}
      {children}
    </SettingsSection>
  );
}

/** The action that changes something (design v5 brand bar). */
const BUTTON_CLASS =
  'brand-bar rounded-[7px] px-3.5 py-[7px] text-[12px] font-medium text-white transition-all hover:brightness-110 disabled:opacity-40';
/** The quieter action next to it (Unlink, Sign out). */
const BUTTON_QUIET_CLASS =
  'rounded-[7px] border border-border px-3 py-[6px] text-[12px] text-text-secondary transition-colors hover:border-border-bright hover:text-text-primary disabled:opacity-40';

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
        setMessage(errorText(err, 'Could not save the name'));
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
            className={INPUT_CLASS}
          />
        </label>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={state === 'saving' || name.trim() === (account.name ?? '')}
            className={BUTTON_CLASS}
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
        setMessage(errorText(err, 'Could not change the password'));
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
          className={INPUT_CLASS}
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
          className={INPUT_CLASS}
        />
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={state === 'saving' || current.length === 0 || next.length < 8}
            className={BUTTON_CLASS}
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
      setMessage(errorText(err, 'Could not unlink'));
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
                  className={BUTTON_QUIET_CLASS}
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
            setMessage(errorText(err, 'Could not sign out'));
          });
        }}
        className={BUTTON_QUIET_CLASS}
      >
        {busy ? 'Signing out…' : 'Sign out'}
      </button>
      {message !== null ? <p className="mt-2 text-[11px] text-error">{message}</p> : null}
    </Card>
  );
}
