import { SCOPE_DOMAINS } from '@/lib/operator-scopes';

/** Every scope, for a fixture of a caller the API restricts in nothing. */
export const ALL_SCOPES: string[] = SCOPE_DOMAINS.flatMap((domain) => [`${domain}:read`, `${domain}:write`]);
