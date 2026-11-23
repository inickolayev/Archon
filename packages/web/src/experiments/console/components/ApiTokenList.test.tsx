import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ApiToken } from '../skills';
import { ApiTokenList, describeExpiry } from './ApiTokenList';

const token: ApiToken = {
  id: 't1',
  name: 'laptop',
  prefix: 'arc_pat_AbCd',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastUsedAt: null,
  expiresAt: null,
};

const noop = (): void => undefined;

function render(confirmingId: string | null): string {
  return renderToStaticMarkup(
    <ApiTokenList
      tokens={[token]}
      confirmingId={confirmingId}
      revokingId={null}
      onAskRevoke={noop}
      onCancelRevoke={noop}
      onRevoke={noop}
    />
  );
}

describe('ApiTokenList', () => {
  test('shows name, prefix, usage and expiry but never a secret', () => {
    const html = render(null);
    expect(html).toContain('laptop');
    expect(html).toContain('arc_pat_AbCd');
    expect(html).toContain('never used');
    expect(html).toContain('never expires');
  });

  test('asks for confirmation in the row before revoking', () => {
    expect(render(null)).not.toContain('Revoke now?');
    expect(render('t1')).toContain('Revoke now?');
  });

  test('empty state', () => {
    const html = renderToStaticMarkup(
      <ApiTokenList
        tokens={[]}
        confirmingId={null}
        revokingId={null}
        onAskRevoke={noop}
        onCancelRevoke={noop}
        onRevoke={noop}
      />
    );
    expect(html).toContain('No tokens yet');
  });

  test('describeExpiry distinguishes never, past and future', () => {
    const now = Date.parse('2026-06-01T00:00:00.000Z');
    expect(describeExpiry(null, now)).toBe('never expires');
    expect(describeExpiry('2026-05-01T00:00:00.000Z', now)).toBe('expired');
    expect(describeExpiry('2026-07-01T00:00:00.000Z', now)).toStartWith('expires ');
  });
});
