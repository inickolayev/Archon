import { useState, type ReactElement } from 'react';
import * as skill from '../skills';
import { useEntity, invalidate } from '../store/cache';
import { K } from '../store/keys';
import { HttpError, errorText } from '../lib/http';
import { INPUT_CLASS, SELECT_CLASS, SelectShell } from './SettingsFormPrimitives';
import { SettingsSection } from './SettingsSection';
import { ApiTokenList } from './ApiTokenList';

const EXPIRY_OPTIONS: readonly { label: string; value: string; days: skill.ApiTokenExpiryDays }[] =
  [
    { label: '30 days', value: '30', days: 30 },
    { label: '90 days', value: '90', days: 90 },
    { label: '1 year', value: '365', days: 365 },
    { label: 'No expiry', value: 'never', days: null },
  ];

/** A just-minted token: the only moment its full value exists on screen. */
function NewTokenNotice({
  created,
  onDismiss,
}: {
  created: skill.CreatedApiToken;
  onDismiss: () => void;
}): ReactElement {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyToken = (): void => {
    // `navigator.clipboard` is undefined on an insecure origin, and writeText can reject.
    const clipboard = navigator.clipboard as Clipboard | undefined;
    (clipboard === undefined
      ? Promise.reject(new Error('Clipboard unavailable'))
      : clipboard.writeText(created.token)
    ).then(
      () => {
        setCopy('copied');
      },
      () => {
        setCopy('failed');
      }
    );
  };
  return (
    <div className="flex flex-col gap-2 rounded border border-border-bright bg-surface-inset p-3">
      <p className="text-console-12 font-medium text-text-primary">
        Token “{created.record.name}” created. Copy it now: it won’t be shown again.
      </p>
      <div className="flex items-center gap-2">
        <code
          data-testid="new-api-token"
          className="min-w-0 flex-1 select-all break-all rounded border border-border bg-surface px-2.5 py-1.5 font-mono text-console-12 text-text-primary"
        >
          {created.token}
        </code>
        <button
          type="button"
          onClick={copyToken}
          className="brand-bar shrink-0 rounded px-3 py-1 text-console-11 font-medium text-white transition-all hover:brightness-110"
        >
          {copy === 'copied' ? 'Copied' : copy === 'failed' ? 'Copy failed' : 'Copy'}
        </button>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="self-start text-console-11 text-text-tertiary underline underline-offset-2 hover:text-text-primary"
      >
        I’ve saved it
      </button>
    </div>
  );
}

/**
 * Personal API tokens: let a signed-in user mint, see, and revoke the tokens
 * that Claude Code, Codex, scripts and the MCP endpoint authenticate with.
 * Hidden where tokens cannot be managed (no web auth, or not signed in).
 */
export function ApiTokensPanel(): ReactElement | null {
  const { data: tokens, error } = useEntity(K.apiTokens, skill.listApiTokens);
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState('90');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<skill.CreatedApiToken | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (error instanceof HttpError && (error.status === 401 || error.status === 403)) return null;

  const create = async (): Promise<void> => {
    const days = EXPIRY_OPTIONS.find(option => option.value === expiry)?.days ?? 90;
    setCreating(true);
    setMessage(null);
    try {
      setCreated(await skill.createApiToken(name.trim(), days));
      setName('');
      invalidate(K.apiTokens);
    } catch (e: unknown) {
      setMessage(errorText(e, 'Could not create the token.'));
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (id: string): Promise<void> => {
    setRevokingId(id);
    setMessage(null);
    try {
      await skill.revokeApiToken(id);
      setConfirmingId(null);
      invalidate(K.apiTokens);
    } catch (e: unknown) {
      setMessage(errorText(e, 'Could not revoke the token.'));
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <SettingsSection title="API tokens">
      <div className="flex flex-col gap-3 text-console-12">
        <p className="text-text-secondary">
          Tokens let Claude Code, Codex and scripts act as you through the API and the MCP endpoint.
          Treat them like passwords.
        </p>

        {created !== null ? (
          <NewTokenNotice
            created={created}
            onDismiss={() => {
              setCreated(null);
            }}
          />
        ) : null}

        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={e => {
            e.preventDefault();
            void create();
          }}
        >
          <input
            type="text"
            value={name}
            onChange={e => {
              setName(e.target.value);
            }}
            placeholder="Token name, e.g. laptop Claude Code"
            maxLength={100}
            aria-label="Token name"
            className={`${INPUT_CLASS} min-w-48 flex-1`}
          />
          <SelectShell>
            <select
              value={expiry}
              onChange={e => {
                setExpiry(e.target.value);
              }}
              aria-label="Token expiry"
              className={SELECT_CLASS}
            >
              {EXPIRY_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </SelectShell>
          <button
            type="submit"
            disabled={creating || name.trim() === ''}
            className="brand-bar shrink-0 rounded px-3 py-1 text-console-11 font-medium text-white transition-all hover:brightness-110 disabled:opacity-40"
          >
            {creating ? 'Creating…' : 'Create token'}
          </button>
        </form>

        {error !== undefined ? (
          <p className="font-mono text-console-11 text-error">{error.message}</p>
        ) : tokens === undefined ? (
          <p className="font-mono text-console-11 text-text-tertiary">Loading…</p>
        ) : (
          <ApiTokenList
            tokens={tokens}
            confirmingId={confirmingId}
            revokingId={revokingId}
            onAskRevoke={setConfirmingId}
            onCancelRevoke={() => {
              setConfirmingId(null);
            }}
            onRevoke={id => void revoke(id)}
          />
        )}

        {message !== null ? (
          <p className="font-mono text-console-11 text-error">{message}</p>
        ) : null}
      </div>
    </SettingsSection>
  );
}
