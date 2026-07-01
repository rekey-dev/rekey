# Changelog

All notable changes to the `@relipay/*` SDK packages are documented here. The
packages share one version and release together.

## 1.0.0

First stable release. All `@relipay/*` packages publish under the `latest`
dist-tag. `npm install @relipay/node` (no tag) now resolves.

Since `1.0.0-rc.1`: operator MCP write/operate tools (plan entitlements,
member management, credentials, end-user + mode controls, scoped + audited),
new ReliPay brand/logo across the apps, panel MCP-consent and passkey
sign-in fixes, and marketing self-host guide + SEO updates.

Install:

```bash
npm install @relipay/node
```

## 1.0.0-rc.1

First release candidate for the 1.0 line. Published under the `beta` npm
dist-tag (pre-release) so it can be smoke-tested end-to-end before `1.0.0`
stable promotes to `latest`.

- Cut the first public release from the new OSS home, `relipay-dev/relipay`.
- No API changes versus `0.1.0-beta.4`; this is a version-line bump to exercise
  the public release pipeline (clean mirror → GitHub Release → npm publish).

Install:

```bash
npm install @relipay/node@beta
```
