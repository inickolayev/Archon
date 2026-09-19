import { describe, expect, test } from 'bun:test';
import { performSignOut } from './session';

function recorder(): { order: string[]; deps: Parameters<typeof performSignOut>[0] } {
  const order: string[] = [];
  return {
    order,
    deps: {
      signOut: async () => {
        order.push('server');
        await Promise.resolve();
      },
      clearAll: () => order.push('cache'),
      redirect: () => order.push('redirect'),
    },
  };
}

describe('performSignOut', () => {
  test('ends the session on the server, then clears the cache, then leaves', async () => {
    const { order, deps } = recorder();
    await performSignOut(deps);
    expect(order).toEqual(['server', 'cache', 'redirect']);
  });

  test('a server that refuses leaves the console exactly as it was', async () => {
    const order: string[] = [];
    const failing = {
      signOut: () => Promise.reject(new Error('network down')),
      clearAll: () => order.push('cache'),
      redirect: () => order.push('redirect'),
    };
    await expect(performSignOut(failing)).rejects.toThrow('network down');
    // No cache wipe, no navigation: the session is still live.
    expect(order).toEqual([]);
  });

  test('the cache is emptied before the sign-in page can render', async () => {
    const { order, deps } = recorder();
    await performSignOut(deps);
    expect(order.indexOf('cache')).toBeLessThan(order.indexOf('redirect'));
  });
});
