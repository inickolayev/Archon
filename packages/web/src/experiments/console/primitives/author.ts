/**
 * Who wrote this.
 *
 * The console is multi-account now: a chat can be started from the browser by
 * one person and continued from Telegram by another, and a message carries the
 * Archon user that wrote it. The rules, in one place because they appear in
 * several:
 *
 *  - my own writing reads `you (<name or email>)` — the parenthesis says which
 *    account "you" is, which matters the moment there is more than one;
 *  - anyone else reads as themselves: the name when it is filled, the email
 *    when it is not;
 *  - a name always wins over an email when both exist;
 *  - an unknown or absent author is not invented — the caller shows the role
 *    label it would have shown anyway.
 */

export interface DirectoryUser {
  readonly id: string;
  readonly displayName: string | null;
  readonly email: string | null;
}

/** Everyone who has written here, plus which of them is me. */
export interface Directory {
  readonly me: string | null;
  readonly users: readonly DirectoryUser[];
}

export const EMPTY_DIRECTORY: Directory = { me: null, users: [] };

/** Name first, email second — the identity a person recognises themselves by. */
export function displayNameOf(user: DirectoryUser | undefined): string | null {
  if (user === undefined) return null;
  const name = user.displayName?.trim() ?? '';
  if (name.length > 0) return name;
  const email = user.email?.trim() ?? '';
  return email.length > 0 ? email : null;
}

/**
 * The label for one author, or null when there is nothing honest to say —
 * no user id on the row, or a user the directory does not know.
 */
export function authorLabel(
  directory: Directory,
  userId: string | null | undefined
): string | null {
  if (userId === null || userId === undefined || userId === '') return null;
  const user = directory.users.find(u => u.id === userId);
  const name = displayNameOf(user);
  if (userId === directory.me) {
    return name === null ? 'you' : `you (${name})`;
  }
  return name;
}

/** True when this row was written by the signed-in account. */
export function isMine(directory: Directory, userId: string | null | undefined): boolean {
  return userId !== null && userId !== undefined && userId !== '' && userId === directory.me;
}
