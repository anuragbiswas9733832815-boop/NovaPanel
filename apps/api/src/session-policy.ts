export type AccountAccessState = {
  sessionVersion: number;
  disabledAt: Date | null;
  mustChangePassword: boolean;
};

export type AccessBlockReason = 'stale-session' | 'account-disabled' | 'password-change-required';

export function sessionAccessBlockReason(
  tokenVersion: number,
  account: AccountAccessState,
  allowPasswordSetup = false,
): AccessBlockReason | null {
  if (tokenVersion !== account.sessionVersion) return 'stale-session';
  if (account.disabledAt !== null) return 'account-disabled';
  if (account.mustChangePassword && !allowPasswordSetup) return 'password-change-required';
  return null;
}
