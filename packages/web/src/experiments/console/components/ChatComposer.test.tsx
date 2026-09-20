import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatComposer } from './ChatComposer';

/**
 * Static markup only — the console has no DOM test harness, so what the send
 * actually produces is pinned in `primitives/quoted-context.test.ts` instead.
 * What is worth asserting here is that a pending quote is VISIBLE and can be
 * called off: a quote armed invisibly is a message sent to the wrong thing.
 */
describe('ChatComposer — replying to something', () => {
  const quote = { label: "the agent's earlier message", text: 'Both viewports look right.' };

  test('shows what is being replied to, and a way out of it', () => {
    const html = renderToStaticMarkup(
      <ChatComposer onSend={() => undefined} disabled={false} quote={quote} />
    );

    expect(html).toContain('the agent&#x27;s earlier message');
    expect(html).toContain('Both viewports look right.');
    expect(html).toContain('Cancel reply');
    expect(html).toContain('Esc');
  });

  test('with nothing quoted the composer is exactly what it was', () => {
    const html = renderToStaticMarkup(<ChatComposer onSend={() => undefined} disabled={false} />);

    expect(html).not.toContain('Cancel reply');
    expect(html).not.toContain('<blockquote');
  });
});
