import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkingIndicator } from './WorkingIndicator';

/**
 * Static markup only — the console has no DOM test harness. What is worth
 * pinning here is that the stop is VISIBLE exactly while a turn is running
 * (the indicator itself is only rendered then), that it is its own click
 * target rather than sharing one with the trace toggle, and that it is absent
 * rather than dead when there is nothing to stop.
 */
describe('WorkingIndicator — calling the agent off', () => {
  test('a stop sits beside the activity, as a control of its own', () => {
    const html = renderToStaticMarkup(
      <WorkingIndicator
        activity="Bash"
        expanded={false}
        onToggle={() => undefined}
        onStop={() => undefined}
      />
    );

    expect(html).toContain('Agent is working');
    expect(html).toContain('Stop');
    // Two buttons, not one that does both: the trace toggle is idle curiosity
    // and Stop ends work in progress. Nesting them would also be invalid HTML.
    expect(html.match(/<button/g)?.length).toBe(2);
  });

  test('without a stop handler the control is absent, not disabled', () => {
    const html = renderToStaticMarkup(
      <WorkingIndicator activity={null} expanded={false} onToggle={() => undefined} />
    );

    expect(html).toContain('Agent is working');
    expect(html).not.toContain('Stop the agent');
    expect(html.match(/<button/g)?.length).toBe(1);
  });
});
