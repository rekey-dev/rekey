/**
 * Shared cookie name. Lives in its own file so the Edge-runtime middleware can
 * import it without pulling in node:crypto via auth.ts. Anything edge-bound
 * must stay node-API-free.
 */
export const SESSION_COOKIE = 'relipay_admin_session';
