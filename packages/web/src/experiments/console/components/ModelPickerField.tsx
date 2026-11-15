import { useState, type ReactElement } from 'react';
import * as skill from '../skills';
import type {
  AgentCredentials,
  OpencodeCredentialProvider,
  PiModelInfo,
  ProviderInfo,
  ProviderModel,
} from '../skills';
import {
  filterModelOptions,
  findPiModel,
  modelPickerShape,
  opencodeBackendOptions,
  piDisconnectedBackendHint,
  piModelHint,
  piModelOptions,
  providerModelOptions,
  usablePiBackends,
  type ModelOption,
  type ModelPickerShape,
  type PiPickerResult,
} from '../lib/model-options';
import { errorText } from '../lib/http';
import { useCancelledRef } from '../lib/use-cancelled-ref';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import { INPUT_CLASS } from './SettingsFormPrimitives';

/** Cap on rendered Pi suggestions — the catalog is ~920 models. */
const PI_SUGGESTION_LIMIT = 30;

const DROPDOWN_CLASS =
  // Same elevation recipe as ProjectRow's context menu (the console's other
  // floating dropdown).
  'absolute left-0 right-0 top-full z-20 mt-1 max-h-60 overflow-y-auto rounded-lg border border-border bg-surface-elevated shadow-[0_18px_44px_-18px_rgba(0,0,0,0.85)]';
const OPTION_CLASS =
  // Stacked two-line row (same shape as ArtifactPanel's list rows): the model
  // name is the primary identifier and keeps the full row width; the
  // cost/context hint rides a muted second line so it can never crowd the
  // name out (#2031).
  'flex w-full flex-col gap-0.5 px-3 py-2 text-left font-mono text-console-12 transition-colors hover:bg-surface-hover';
const FOOTER_BUTTON_CLASS =
  'w-full border-t border-border px-3 py-2 text-left font-mono text-console-11 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary';

interface ModelPickerFieldProps {
  /** Agent provider id ('' renders plain free text — e.g. an unset tier row). */
  agentId: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  /** Sizing classes for the field wrapper (e.g. 'min-w-40 flex-1'). */
  className?: string;
  /** Agents matrix (K.providerConnections) — undefined means no readiness data (solo/401). */
  agents?: AgentCredentials[];
  /** Pi catalog (K.piModels) — best-effort, undefined/[] means no Pi suggestions. */
  piModels?: PiModelInfo[];
}

/**
 * Agent-aware model input (#1957). One component, three sourced shapes:
 * - Pi: searchable picker over the baked catalog, default-filtered to usable
 *   backends per the agents matrix, with an explicit "show all backends"
 *   toggle. Cost/context/reasoning hints ride each suggestion and the exact
 *   match. Custom models.json providers are free-typed.
 * - OpenCode: free text with on-demand backend-prefix suggestions. The
 *   introspection endpoint boots the embedded runtime, so NOTHING loads until
 *   the user explicitly clicks "Load backend suggestions" inside the open
 *   dropdown; it lists `backend/` prefixes (model counts, connected state) and
 *   the model id itself stays free-typed — the endpoint doesn't expose ids.
 * - Live (every agent whose runtime reports its models — `listsModels`):
 *   suggestions come from the runtime itself, fetched the first time a field
 *   is opened and shared by every field through the cache. Nothing is baked
 *   into the client: a list here would go stale the day a vendor ships.
 * - Anything else: plain free text.
 *
 * Pickers guide, never gate: every shape saves arbitrary strings, and a model
 * on a disconnected backend only draws a non-blocking inline hint.
 */
export function ModelPickerField(props: ModelPickerFieldProps): ReactElement {
  const { data: providers } = useEntity<ProviderInfo[]>(K.providers, skill.listProviders);
  return <ModelCombobox {...props} shape={modelPickerShape(props.agentId, providers)} />;
}

/** Suggestion row; `onMouseDown` is prevented by the list container so the input never blurs. */
function OptionRow({
  option,
  onPick,
}: {
  option: ModelOption;
  onPick: (o: ModelOption) => void;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={() => {
        onPick(option);
      }}
      className={OPTION_CLASS}
    >
      <span className="truncate text-text-primary">{option.value}</span>
      {option.hint !== undefined ? (
        <span className="truncate text-console-10 text-text-tertiary">{option.hint}</span>
      ) : null}
    </button>
  );
}

function ModelCombobox({
  agentId,
  value,
  onChange,
  disabled = false,
  placeholder,
  ariaLabel,
  className = '',
  agents,
  piModels,
  shape,
}: ModelPickerFieldProps & { shape: ModelPickerShape }): ReactElement {
  const [open, setOpen] = useState(false);
  // Pi only: include backends without a usable credential in the suggestions.
  const [showAll, setShowAll] = useState(false);
  const opencode = useOpencodeBackends();

  // Suggestions per shape; the field's text doubles as the search query.
  const backends = shape === 'pi' ? usablePiBackends(agents) : null;
  const pi =
    shape === 'pi' ? piModelOptions(piModels, value, backends, showAll, PI_SUGGESTION_LIMIT) : null;
  const options = comboboxOptions(shape, value, pi, opencode);

  const pick = (o: ModelOption): void => {
    onChange(o.value);
    // Prefix completions keep the dropdown open: the model id is typed next.
    if (o.prefix !== true) setOpen(false);
  };

  // Under-field hints (outside the dropdown, so they show while typing too).
  const exactPi = shape === 'pi' ? findPiModel(piModels, value) : undefined;
  const disconnectedHint =
    shape === 'pi' && !disabled ? piDisconnectedBackendHint(value, agents) : null;

  const hasDropdownContent = options.length > 0 || shape !== 'free';

  return (
    <span className={`relative inline-flex flex-col gap-1 ${className}`}>
      <input
        value={value}
        onChange={e => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          setOpen(true);
        }}
        onBlur={() => {
          setOpen(false);
        }}
        onKeyDown={e => {
          if (e.key === 'Escape') setOpen(false);
        }}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoComplete="off"
        className={`${INPUT_CLASS} ${disabled ? 'opacity-50' : ''}`}
      />

      {open && !disabled && hasDropdownContent ? (
        // preventDefault keeps focus in the input, so option clicks land
        // before any blur-close — the standard combobox trick.
        <div
          className={DROPDOWN_CLASS}
          onMouseDown={e => {
            e.preventDefault();
          }}
        >
          {options.map(o => (
            <OptionRow key={o.value} option={o} onPick={pick} />
          ))}

          {pi !== null ? (
            <PiDropdownFooter
              pi={pi}
              optionCount={options.length}
              catalogLoaded={piModels !== undefined}
              filterable={backends !== null}
              showAll={showAll}
              onToggleShowAll={() => {
                setShowAll(s => !s);
              }}
            />
          ) : null}

          {shape === 'live' ? (
            <LiveModelOptions agentId={agentId} value={value} onPick={pick} />
          ) : null}

          {shape === 'opencode' ? (
            <OpencodeDropdownFooter
              phase={opencode.phase}
              error={opencode.error}
              optionCount={options.length}
              onLoad={() => void opencode.load()}
            />
          ) : null}
        </div>
      ) : null}

      {exactPi !== undefined ? (
        <p className="font-mono text-console-11 text-text-tertiary">{piModelHint(exactPi)}</p>
      ) : null}
      {disconnectedHint !== null ? (
        <p className="font-mono text-console-11 text-warning">{disconnectedHint}</p>
      ) : null}
    </span>
  );
}

type OpencodePhase = 'idle' | 'loading' | 'loaded' | 'error';

interface OpencodeBackends {
  phase: OpencodePhase;
  providers: OpencodeCredentialProvider[];
  error: string | null;
  load: () => Promise<void>;
}

/**
 * OpenCode on-demand backend list. Per-field state by design: the endpoint
 * is only hit on this field's explicit "Load backend suggestions" click.
 */
function useOpencodeBackends(): OpencodeBackends {
  const [phase, setPhase] = useState<OpencodePhase>('idle');
  const [providers, setProviders] = useState<OpencodeCredentialProvider[]>([]);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useCancelledRef();

  const load = async (): Promise<void> => {
    setPhase('loading');
    setError(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        skill.listOpencodeCredentials(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error('Timed out waiting for the OpenCode runtime — retry.'));
          }, skill.OPENCODE_LOAD_TIMEOUT_MS);
        }),
      ]);
      if (cancelledRef.current) return;
      setProviders(result);
      setPhase('loaded');
    } catch (e: unknown) {
      if (cancelledRef.current) return;
      setError(e instanceof Error ? e.message : 'Failed to load OpenCode backends.');
      setPhase('error');
    } finally {
      clearTimeout(timer);
    }
  };

  return { phase, providers, error, load };
}

function comboboxOptions(
  shape: ModelPickerShape,
  value: string,
  pi: PiPickerResult | null,
  opencode: OpencodeBackends
): ModelOption[] {
  if (pi !== null) return pi.options;
  // Live suggestions render inside the dropdown (LiveModelOptions), which is
  // what defers the runtime query until a field is actually opened.
  if (shape !== 'opencode') return [];
  return opencode.phase === 'loaded'
    ? filterModelOptions(opencodeBackendOptions(opencode.providers), value)
    : [];
}

/** Pi dropdown footer: overflow count, the two empty states, and the backend filter toggle. */
function PiDropdownFooter({
  pi,
  optionCount,
  catalogLoaded,
  filterable,
  showAll,
  onToggleShowAll,
}: {
  pi: PiPickerResult;
  optionCount: number;
  catalogLoaded: boolean;
  filterable: boolean;
  showAll: boolean;
  onToggleShowAll: () => void;
}): ReactElement {
  return (
    <>
      {pi.matchTotal > optionCount ? (
        <p className="px-3 py-1.5 font-mono text-console-11 text-text-tertiary">
          …{pi.matchTotal - optionCount} more — keep typing to narrow.
        </p>
      ) : null}
      {/* Two distinct empty states: an undefined catalog (still
          loading, or the fetch failed — all panels read K.piModels
          best-effort and drop the error) is NOT "no match". */}
      {!catalogLoaded ? (
        <p className="px-3 py-2 font-mono text-console-11 text-text-tertiary">
          Catalog unavailable — free text is fine.
        </p>
      ) : null}
      {catalogLoaded && pi.matchTotal === 0 && pi.hiddenByFilter === 0 ? (
        <p className="px-3 py-2 font-mono text-console-11 text-text-tertiary">
          No catalog match — custom models.json refs are fine as free text.
        </p>
      ) : null}
      {filterable ? (
        <button type="button" onClick={onToggleShowAll} className={FOOTER_BUTTON_CLASS}>
          {showAll
            ? 'Show connected backends only'
            : `Show all backends${pi.hiddenByFilter > 0 ? ` (${String(pi.hiddenByFilter)} more match)` : ''}`}
        </button>
      ) : null}
    </>
  );
}

/** OpenCode dropdown footer: explicit load affordance + loading/error states. */
function OpencodeDropdownFooter({
  phase,
  error,
  optionCount,
  onLoad,
}: {
  phase: OpencodePhase;
  error: string | null;
  optionCount: number;
  onLoad: () => void;
}): ReactElement {
  if (phase === 'idle') {
    return (
      <div className="flex flex-col gap-1 px-3 py-2">
        <p className="font-mono text-console-11 text-text-tertiary">
          Format: <span className="text-text-secondary">backend/model-id</span> (free text).
        </p>
        <button
          type="button"
          onClick={onLoad}
          className="self-start rounded border border-border px-2.5 py-1 font-mono text-console-11 text-text-secondary transition-colors hover:border-border-bright hover:text-text-primary"
        >
          Load backend suggestions
        </button>
      </div>
    );
  }
  if (phase === 'loading') {
    return (
      <p className="px-3 py-2 font-mono text-console-11 text-text-tertiary">
        Loading backends… (starting the OpenCode runtime can take a moment)
      </p>
    );
  }
  if (phase === 'error') {
    return (
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <p className="font-mono text-console-11 text-error">{error}</p>
        <button
          type="button"
          onClick={onLoad}
          className="rounded border border-border px-2.5 py-1 font-mono text-console-11 text-text-secondary transition-colors hover:border-border-bright hover:text-text-primary"
        >
          Retry
        </button>
      </div>
    );
  }
  return (
    <p className="border-t border-border px-3 py-1.5 font-mono text-console-11 text-text-tertiary">
      {optionCount > 0
        ? 'Pick a backend prefix, then type the model id.'
        : 'No backend matches the typed prefix — free text is fine.'}
    </p>
  );
}

/**
 * The runtime's own model list for a `live` agent. Mounted only while the
 * dropdown is open, so the first open asks the server (which may spawn the
 * agent CLI) and every later field reads the shared cache entry.
 */
function LiveModelOptions({
  agentId,
  value,
  onPick,
}: {
  agentId: string;
  value: string;
  onPick: (o: ModelOption) => void;
}): ReactElement {
  const { data, error, refetch } = useEntity<ProviderModel[]>(K.providerModels(agentId), () =>
    skill.listProviderModels(agentId)
  );
  if (error !== undefined) {
    return (
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <p className="font-mono text-console-11 text-error">
          {errorText(error, 'Could not load the model list.')} Free text is fine.
        </p>
        <button
          type="button"
          onClick={refetch}
          className="rounded border border-border px-2.5 py-1 font-mono text-console-11 text-text-secondary transition-colors hover:border-border-bright hover:text-text-primary"
        >
          Retry
        </button>
      </div>
    );
  }
  if (data === undefined) {
    return (
      <p className="px-3 py-2 font-mono text-console-11 text-text-tertiary">
        Asking the agent for its models…
      </p>
    );
  }
  const options = filterModelOptions(providerModelOptions(data), value);
  if (options.length === 0) {
    return (
      <p className="px-3 py-2 font-mono text-console-11 text-text-tertiary">
        No listed model matches — free text is fine.
      </p>
    );
  }
  return (
    <>
      {options.map(o => (
        <OptionRow key={o.value} option={o} onPick={onPick} />
      ))}
    </>
  );
}
