import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { IdentityCard, LinkedSourcesCard, PasswordCard, SignOutCard } from './ProfilePage';
import type { Account } from '../skills/account';

const account = (over: Partial<Account> = {}): Account => ({
  userId: 'user-me',
  role: 'admin',
  name: 'Igor Nikolaev',
  email: 'igorabcpps@gmail.com',
  identities: [],
  ...over,
});

describe('Profile — you', () => {
  test('shows the email as a fact and the name as something you can change', () => {
    const html = renderToStaticMarkup(<IdentityCard account={account()} />);
    expect(html).toContain('igorabcpps@gmail.com');
    // The name is an input with the current value; the email is not editable.
    expect(html).toContain('value="Igor Nikolaev"');
    expect(html).not.toContain('value="igorabcpps@gmail.com"');
    expect(html).toContain('Save name');
  });

  test('an account with no name yet offers an empty field, not a placeholder identity', () => {
    const html = renderToStaticMarkup(<IdentityCard account={account({ name: null })} />);
    expect(html).toContain('value=""');
  });

  test('an account with no email says so rather than showing nothing', () => {
    const html = renderToStaticMarkup(<IdentityCard account={account({ email: null })} />);
    expect(html).toContain('not set');
  });
});

describe('Profile — password', () => {
  test('asks for the current password and warns nothing else is signed out', () => {
    const html = renderToStaticMarkup(<PasswordCard />);
    expect(html).toContain('Current password');
    expect(html).toContain('New password');
    expect(html).toContain('stays signed in');
    // Both fields are real password inputs, not plain text.
    expect(html.match(/type="password"/g)?.length).toBe(2);
  });

  test('the change button starts disabled — an empty form cannot be submitted', () => {
    const html = renderToStaticMarkup(<PasswordCard />);
    expect(html).toContain('disabled=""');
  });
});

describe('Profile — linked sources', () => {
  test('with nothing linked, it says how to get a link from the bot', () => {
    const html = renderToStaticMarkup(<LinkedSourcesCard account={account()} />);
    expect(html).toContain('Nothing linked yet');
    expect(html).toContain('Link this chat to my account');
    expect(html).not.toContain('Unlink');
  });

  test('a linked Telegram account shows when it was linked and offers Unlink', () => {
    const html = renderToStaticMarkup(
      <LinkedSourcesCard
        account={account({
          identities: [
            {
              platform: 'telegram',
              platformUserId: '4242',
              displayName: 'Igor',
              linkedAt: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
            },
          ],
        })}
      />
    );
    expect(html).toContain('Igor');
    expect(html).toContain('linked');
    expect(html).toContain('Unlink');
  });

  test('the web identity is the account itself, so it is not listed as a source', () => {
    const html = renderToStaticMarkup(
      <LinkedSourcesCard
        account={account({
          identities: [
            {
              platform: 'web',
              platformUserId: 'user-me',
              displayName: 'Igor Nikolaev',
              linkedAt: null,
            },
          ],
        })}
      />
    );
    expect(html).toContain('Nothing linked yet');
    expect(html).not.toContain('Unlink');
  });
});

describe('Profile — session', () => {
  test('there is a sign out button, and it says the session ends on the server', () => {
    const html = renderToStaticMarkup(<SignOutCard signOut={() => Promise.resolve()} />);
    expect(html).toContain('Sign out');
    expect(html).toContain('ends it on the server');
  });
});
