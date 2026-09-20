import { useState, type ReactElement } from 'react';

interface WorkingIndicatorProps {
  /** Latest tool/activity name for the current turn, if any. */
  activity?: string | null;
  /** Whether the inline tool trace is currently revealed. */
  expanded: boolean;
  onToggle: () => void;
  /**
   * Call off the running turn. Omitted where there is nothing to stop — a
   * replayed or historical view — and the control is then absent rather than
   * disabled.
   */
  onStop?: () => void;
}

/**
 * Single "agent is working" affordance shown while a turn is in flight, in
 * place of a stream of raw tool-call cards. Shows the current activity (latest
 * tool), toggles the inline trace, and carries the one control that only makes
 * sense while a turn is running: stopping it.
 *
 * A row of two buttons rather than one button that does both — the trace
 * toggle is idle curiosity and Stop ends work in progress, so putting them on
 * the same click target would make the cheap gesture dangerous. Stop asks once
 * before it fires, for the same reason.
 */
export function WorkingIndicator({
  activity,
  expanded,
  onToggle,
  onStop,
}: WorkingIndicatorProps): ReactElement {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="mt-1.5 flex w-fit items-center gap-1.5">
      <button
        type="button"
        onClick={onToggle}
        title={expanded ? 'Hide activity' : 'Show what the agent is doing'}
        className="flex items-center gap-2 rounded-full border border-border bg-surface-inset px-3 py-1.5 text-[12px] text-text-secondary transition-colors hover:border-border-bright hover:text-text-primary"
      >
        <span
          aria-hidden
          className="h-3 w-3 shrink-0 animate-spin rounded-full border-2"
          style={{
            borderColor: 'color-mix(in oklch, var(--running) 25%, transparent)',
            borderTopColor: 'var(--running)',
          }}
        />
        <span className="font-medium">Agent is working</span>
        {activity !== null && activity !== undefined && activity !== '' ? (
          <span className="font-mono text-[11px] text-text-tertiary">· {activity}</span>
        ) : null}
        <span aria-hidden className="font-mono text-[10px] text-text-tertiary">
          {expanded ? '▾ hide' : '▸ details'}
        </span>
      </button>
      {onStop !== undefined ? (
        <button
          type="button"
          onClick={() => {
            if (!confirming) {
              setConfirming(true);
              return;
            }
            setConfirming(false);
            onStop();
          }}
          onBlur={() => {
            setConfirming(false);
          }}
          title="Stop the agent"
          className="flex items-center gap-1.5 rounded-full border border-border bg-surface-inset px-3 py-1.5 text-[12px] text-text-secondary transition-colors hover:border-error/50 hover:text-error"
        >
          <span aria-hidden>■</span>
          {confirming ? 'Stop the agent?' : 'Stop'}
        </button>
      ) : null}
    </div>
  );
}
