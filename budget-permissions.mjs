// Shared role interpretation. Firebase Rules remain the authority for every write.
export const PRIMARY_MANAGER_EMAIL = 'master004400@gmail.com';
export const normalizeEmail = value => String(value || '').trim().toLowerCase();
export function budgetRole(profile, email = '') {
  if (profile?.enabled !== true) return null;
  if (normalizeEmail(email) === PRIMARY_MANAGER_EMAIL) return 'manager';
  return ['manager', 'advance', 'assistant'].includes(profile.role) ? profile.role : 'teacher';
}
export const isBudgetManager = (profile, email) => budgetRole(profile, email) === 'manager';
export const canUseAdvance = (profile, email) => ['manager', 'advance'].includes(budgetRole(profile, email));
export const isAdvanceOnly = (profile, email) => budgetRole(profile, email) === 'advance';
