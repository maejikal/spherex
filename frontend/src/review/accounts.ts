/** Fictional, browser-local profiles, not authenticated users. Keep IDs stable for saved cases/votes. */
export const DEMO_ACCOUNTS = [
  { id: 'author', name: 'Alex (Demo)' },
  { id: 'reviewer-1', name: 'Maya (Demo)' },
  { id: 'reviewer-2', name: 'Sam (Demo)' },
  { id: 'reviewer-3', name: 'Jordan (Demo)' },
  { id: 'reviewer-4', name: 'Riley (Demo)' },
  { id: 'reviewer-5', name: 'Casey (Demo)' },
] as const;
const ACCOUNT_KEY = 'spherex-demo-account';
export const isDemoAccount = (id: string) => DEMO_ACCOUNTS.some((account) => account.id === id);
export const accountName = (id: string) => DEMO_ACCOUNTS.find((account) => account.id === id)?.name ?? 'Unknown demo account';

export function readDemoAccount(storage?: Pick<Storage, 'getItem'>): string {
  try {
    const value = (storage ?? globalThis.localStorage)?.getItem(ACCOUNT_KEY);
    return value && isDemoAccount(value) ? value : 'author';
  } catch { return 'author'; }
}
/** Failure keeps the selected account usable in memory without claiming it persisted. */
export function saveDemoAccount(id: string, storage?: Pick<Storage, 'setItem'>): boolean {
  if (!isDemoAccount(id)) return false;
  try {
    const target = storage ?? globalThis.localStorage;
    if (!target) return false;
    target.setItem(ACCOUNT_KEY, id);
    return true;
  } catch { return false; }
}
