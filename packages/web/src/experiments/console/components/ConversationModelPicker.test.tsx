import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { invalidate, set } from '../store/cache';
import { K } from '../store/keys';
import { ConversationModelPicker, describeChatModel } from './ConversationModelPicker';

describe('describeChatModel', () => {
  const base = { provider: 'claude', conversationProvider: 'claude' };

  test('the default, when nothing is pinned', () => {
    expect(describeChatModel({ ...base, model: 'opus', override: null })).toEqual({
      label: 'claude · opus',
      note: 'default',
    });
  });

  test('a pin in effect', () => {
    expect(describeChatModel({ ...base, model: 'haiku', override: 'haiku' }).note).toBe(
      'pinned for this chat'
    );
  });

  test('a pin another provider outranks says it is not in effect', () => {
    const { label, note } = describeChatModel({
      provider: 'codex',
      model: 'gpt-5.5',
      override: 'haiku',
      conversationProvider: 'claude',
    });
    expect(label).toBe('codex · gpt-5.5');
    expect(note).toContain('not in effect');
  });

  test('the provider alone when its own default applies', () => {
    expect(describeChatModel({ ...base, override: null }).label).toBe('claude');
  });
});

describe('ConversationModelPicker', () => {
  test('shows the server-resolved model with a way to change it', () => {
    const key = K.conversationModel('web-1');
    set(key, {
      provider: 'claude',
      model: 'claude-haiku-4-5',
      override: 'claude-haiku-4-5',
      conversationProvider: 'claude',
    });
    try {
      const html = renderToStaticMarkup(<ConversationModelPicker conversationId="web-1" />);
      expect(html).toContain('claude · claude-haiku-4-5');
      expect(html).toContain('pinned for this chat');
      expect(html).toContain('Change model');
    } finally {
      invalidate(key);
    }
  });
});
