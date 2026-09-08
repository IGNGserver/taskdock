const AUTH_LOCK_KEY = 'devtodo.auth-locked';

export function isAuthLocallyLocked(): boolean {
  try {
    return localStorage.getItem(AUTH_LOCK_KEY) === '1';
  } catch {
    return false;
  }
}

export function lockAuthLocally(): void {
  try {
    localStorage.setItem(AUTH_LOCK_KEY, '1');
  } catch {
    /* If storage is unavailable, the server session remains the authority. */
  }
}

export function unlockAuthLocally(): void {
  try {
    localStorage.removeItem(AUTH_LOCK_KEY);
  } catch {
    /* private browsing may disable localStorage */
  }
}
