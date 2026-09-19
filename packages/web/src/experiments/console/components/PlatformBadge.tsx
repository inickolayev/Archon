import type { ReactElement } from 'react';
import { platformLabel } from '../primitives/conversation';

interface PlatformBadgeProps {
  platformType: string;
  /** Hide the badge for the console's own chats, which need no marker. */
  hideWeb?: boolean;
}

/**
 * Where a conversation is read and written from. A chat started in Telegram
 * and continued in the browser is the same conversation — the badge is what
 * makes that obvious in a list of them.
 *
 * Telegram is tinted (it is the one the operator looks for); everything else
 * stays neutral. Border colours are inline: the console scope has a wildcard
 * `border-color` rule that repaints Tailwind border utilities.
 */
export function PlatformBadge({
  platformType,
  hideWeb = false,
}: PlatformBadgeProps): ReactElement | null {
  if (hideWeb && platformType === 'web') return null;
  const telegram = platformType === 'telegram';
  return (
    <span
      className="shrink-0 rounded border px-[4px] py-[1px] font-mono text-[9px] uppercase leading-[1.4] tracking-[0.08em]"
      style={
        telegram
          ? {
              color: 'var(--brand-teal)',
              borderColor: 'color-mix(in oklch, var(--brand-teal), transparent 55%)',
              background: 'color-mix(in oklch, var(--brand-teal), transparent 90%)',
            }
          : { color: 'var(--text-tertiary)', borderColor: 'var(--border-bright)' }
      }
      title={`Read and written from ${platformLabel(platformType)}`}
    >
      {platformLabel(platformType)}
    </span>
  );
}
