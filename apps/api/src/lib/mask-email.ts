/**
 * An address shown to someone who has not proved they own it: the first
 * character and the domain.
 *
 * @example
 * maskEmail('jane@example.com'); // 'j***@example.com'
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}
