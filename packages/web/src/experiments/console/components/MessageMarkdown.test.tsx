import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageMarkdown } from './MessageMarkdown';

const render = (md: string): string => renderToStaticMarkup(<MessageMarkdown content={md} />);

describe('MessageMarkdown tables', () => {
  const table = [
    '| Task | Status | Cost |',
    '| --- | :---: | ---: |',
    '| #222 | ready | $1.85 |',
    '| #247 | draft | $0.40 |',
  ].join('\n');

  test('renders a GFM table with its header and cells', () => {
    const html = render(table);
    expect(html).toContain('<table');
    expect(html).toContain('<th');
    expect(html).toContain('Task');
    expect(html).toContain('Status');
    expect(html).toContain('<td');
    expect(html).toContain('#222');
    expect(html).toContain('$0.40');
  });

  test('wraps the table so a wide one scrolls instead of widening the chat', () => {
    expect(render(table)).toContain('overflow-x-auto');
  });

  test('keeps the column alignment GFM asked for, and defaults to left', () => {
    const html = render(table);
    expect(html).toContain('text-align:center'); // the :---: column
    expect(html).toContain('text-align:right'); // the ---: column
    expect(html).toContain('text-align:left'); // the unmarked one
  });

  test('draws its own separators (the console repaints border utilities)', () => {
    expect(render(table)).toContain('border-right:1px solid var(--border)');
  });
});

describe('MessageMarkdown code blocks', () => {
  test('a fenced block gets a copy button with an accessible name', () => {
    const html = render('```ts\nconst a = 1;\n```');
    expect(html).toContain('aria-label="Copy code"');
    expect(html).toContain('<button');
    // Highlighting wraps tokens in spans, so check the tokens, not the line.
    expect(html).toContain('>const</span>');
    expect(html).toContain('language-ts');
  });

  test('shows the language of a fenced block when there is one', () => {
    expect(render('```ts\nconst a = 1;\n```')).toContain('>ts</span>');
  });

  test('a plain fence still gets the button, without a language label', () => {
    const html = render('```\nplain text\n```');
    expect(html).toContain('aria-label="Copy code"');
    expect(html).not.toContain('language-');
  });

  test('inline code gets no copy button', () => {
    const html = render('use `npm run dev` to start');
    expect(html).toContain('<code');
    expect(html).not.toContain('aria-label="Copy code"');
    expect(html).not.toContain('<button');
  });
});

describe('MessageMarkdown images', () => {
  const inConversation = (md: string): string =>
    renderToStaticMarkup(
      <MessageMarkdown content={md} conversationId="web-1" onOpenImage={() => undefined} />
    );

  test('draws the screenshot an answer names instead of printing its path', () => {
    const html = inConversation('Файлы: /tmp/devshot/desktop.png');
    expect(html).toContain(
      'src="/api/conversations/web-1/image?path=%2Ftmp%2Fdevshot%2Fdesktop.png"'
    );
    expect(html).toContain('alt="desktop.png"');
  });

  test('uses the alt text of a markdown image as its label', () => {
    expect(inConversation('![the lobby](/tmp/a.png)')).toContain('alt="the lobby"');
  });

  test('leaves a path in a code fence as code', () => {
    const html = inConversation('```\n/tmp/a.png\n```');
    expect(html).not.toContain('<img');
    expect(html).toContain('/tmp/a.png');
  });

  test('a remote image is not routed through the conversation', () => {
    const html = inConversation('![remote](https://example.com/a.png)');
    expect(html).toContain('src="https://example.com/a.png"');
  });

  test('without a conversation the path stays the text the agent wrote', () => {
    const html = render('Файлы: /tmp/devshot/desktop.png');
    expect(html).not.toContain('<img');
    expect(html).toContain('/tmp/devshot/desktop.png');
  });
});

describe('MessageMarkdown image grid', () => {
  const inConversation = (md: string): string =>
    renderToStaticMarkup(
      <MessageMarkdown content={md} conversationId="web-1" onOpenImage={() => undefined} />
    );

  test('several pictures lay out as a grid instead of a column', () => {
    const html = inConversation('Вот экраны:\n/tmp/a.png\n/tmp/b.png\n/tmp/c.png');
    expect(html).toContain('flex flex-wrap');
    expect(html.match(/<img/g)?.length).toBe(3);
  });

  test('the sentence that introduces them keeps its own line', () => {
    const html = inConversation('Вот экраны:\n/tmp/a.png\n/tmp/b.png');
    expect(html).toContain('Вот экраны:');
    expect(html).toContain('basis-full');
  });

  test('a single picture stays an ordinary paragraph', () => {
    const html = inConversation('Скрин: /tmp/a.png');
    expect(html).toContain('<p>');
    expect(html).not.toContain('flex flex-wrap');
  });
});
