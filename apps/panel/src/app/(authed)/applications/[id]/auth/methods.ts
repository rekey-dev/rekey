export const PRIMARY_METHODS: Array<{ key: string; label: string; hint: string }> = [
  {
    key: 'password',
    label: 'Email + password',
    hint: 'Standard sign-up / sign-in. Argon2id-hashed at rest. Toggle off for OAuth-only apps.',
  },
  {
    key: 'magic_link',
    label: 'Magic link',
    hint: "One-click sign-in via email, using the SDK's auth.requestMagicLink() + verifyMagicLink(). Delivered through this app's configured email transport (set one on the Email tab; otherwise the raw token is returned to your server to send).",
  },
];
