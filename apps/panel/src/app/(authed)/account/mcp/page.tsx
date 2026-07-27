/**
 * Account → MCP (operator-side).
 *
 * Connection guide for the hosted operator MCP server at
 * `/api/v1/tenant/mcp` — the JSON-RPC surface that exposes the
 * operator's workspace data (apps, end-users, payments, webhooks,
 * security events) to Claude Desktop / Code / Cursor.
 *
 * Distinct from `/applications/[id]/mcp` (the per-Application end-user
 * MCP page that exposes a single end-user's own account). This page is
 * the operator's view of THEIR workspace, not their customers' data.
 *
 * Two live auth paths: the OAuth 2.1 + PKCE authorization server
 * (preferred — the client drives the browser sign-in + workspace pick +
 * consent, no pre-minted token) and PAT-Bearer auth
 * (`Authorization: Bearer rp_op_…`, minted on `/account/api-tokens`,
 * for headless / non-browser automation).
 */

import * as React from 'react';
import Link from 'next/link';
import { CopyButton } from '@/components/CopyButton';
import { PageHeader } from '@/components/PageHeader';
import { Card } from '@/components/Card';
import { Badge } from '@/components/Badge';

/**
 * Single labelled URL + copy button row for the OAuth endpoints card.
 * Lifted from the per-Application MCP page; kept as a small component
 * so the rows below stay visually consistent.
 */
function DefRow({
  label,
  value,
  method,
}: {
  label: React.ReactNode;
  value: string;
  method?: string;
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-[var(--color-faint-fg)]">
        {method && (
          <span className="rounded border border-[var(--color-border)] px-1 py-0.5 text-[9px] font-mono normal-case tracking-normal">
            {method}
          </span>
        )}
        <span>{label}</span>
      </div>
      <div className="flex items-center gap-2">
        <code title={value} className="flex-1 truncate rounded bg-[var(--color-surface-muted)] px-2 py-1 text-xs font-mono text-[var(--color-fg)]">{value}</code>
        <CopyButton value={value} label="Copy" />
      </div>
    </div>
  );
}

// Mirror of `app/applications/[id]/mcp/page.tsx`'s fallback — never display the
// in-cluster RELIPAY_URL; the public API origin is the operator-facing one.
function publicApiBase(): string {
  const base = process.env.NEXT_PUBLIC_API_URL ?? 'https://api.relipay.dev';
  return base.replace(/\/$/, '');
}

export default function OperatorMcpPage(): React.JSX.Element {
  const apiBase = publicApiBase();
  const mcpUrl = `${apiBase}/api/v1/tenant/mcp`;

  // OAuth-flow mcp.json — auto-discovers via /.well-known. Preferred path now
  // that Phase 2 is live: the operator runs the browser flow + workspace pick,
  // no PAT pasting.
  const mcpJsonOAuth = `{
  "mcpServers": {
    "rekey-operator": {
      "type": "http",
      "url": "${mcpUrl}",
      "oauth": {
        "authServerMetadataUrl": "${mcpUrl}/.well-known/oauth-authorization-server"
      }
    }
  }
}`;

  // PAT-bearer mcp.json — alternate, useful for headless / non-browser
  // automation. Same MCP endpoint, just a static Bearer instead of OAuth.
  const mcpJsonPat = `{
  "mcpServers": {
    "rekey-operator": {
      "type": "http",
      "url": "${mcpUrl}",
      "headers": {
        "Authorization": "Bearer rp_op_<paste-your-token-here>"
      }
    }
  }
}`;

  // OAuth endpoint URLs — operators reading the page can copy them straight
  // into a hand-rolled client / curl debug session.
  const discoveryAs = `${mcpUrl}/.well-known/oauth-authorization-server`;
  const discoveryPr = `${mcpUrl}/.well-known/oauth-protected-resource`;
  const registerUrl = `${mcpUrl}/oauth/register`;
  const authorizeUrl = `${mcpUrl}/oauth/authorize`;
  const tokenUrl = `${mcpUrl}/oauth/token`;
  const introspectUrl = `${mcpUrl}/oauth/introspect`;

  // Claude Code CLI snippets — OAuth (preferred) + PAT (alternate).
  const claudeCodeOAuth = `claude mcp add --transport http rekey-operator ${mcpUrl}`;
  const claudeCodePat = `claude mcp add --transport http rekey-operator ${mcpUrl} \\
  --header "Authorization: Bearer rp_op_<paste-your-token-here>"`;

  const curlInitialize = `curl -X POST ${mcpUrl} \\
  -H 'Authorization: Bearer rp_op_<paste-your-token-here>' \\
  -H 'Content-Type: application/json' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}'`;

  const curlToolsList = `curl -X POST ${mcpUrl} \\
  -H 'Authorization: Bearer rp_op_<paste-your-token-here>' \\
  -H 'Content-Type: application/json' \\
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'`;

  const curlToolCall = `curl -X POST ${mcpUrl} \\
  -H 'Authorization: Bearer rp_op_<paste-your-token-here>' \\
  -H 'Content-Type: application/json' \\
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_workspace_overview","arguments":{}}}'`;

  const tools = [
    {
      name: 'get_workspace_overview',
      summary:
        'Workspace rollup — app count, end-user count, org count, active subs, MRR (per-currency).',
    },
    {
      name: 'list_applications',
      summary: 'All Applications in the workspace, with end-user count, active subs, 24h request volume.',
    },
    {
      name: 'list_members',
      summary: 'Operators in the workspace + their role (OWNER / ADMIN / MEMBER).',
    },
    {
      name: 'recent_payments',
      summary:
        'Recent Payment rows across the workspace (filter by status: SUCCEEDED / FAILED / PENDING / REFUNDED).',
    },
    {
      name: 'recent_subscriptions',
      summary:
        'Recent Subscription rows across the workspace (filter by status: PENDING / ACTIVE / PAST_DUE / CANCELED / EXPIRED).',
    },
    {
      name: 'recent_security_events',
      summary:
        "Recent security audit log entries for the workspace (filter by actorType: operator / end_user / system).",
    },
    {
      name: 'recent_webhook_events',
      summary:
        'Recent inbound provider webhooks (filter by provider, or onlyFailed: true to surface stuck events).',
    },
    {
      name: 'recent_failed_webhook_deliveries',
      summary: 'Outbound webhook deliveries currently FAILED. Surfaces customer endpoints that have stopped accepting events.',
    },
    {
      name: 'application_health',
      summary:
        'Per-app payment success rate (30d) + outbound webhook success rate (24h), sorted by failure count.',
    },
  ];

  return (
    <section className="mx-auto max-w-7xl space-y-6 px-6 py-8 lg:px-8">
      <PageHeader
        title="Operator MCP"
        description="Connect Claude Desktop, Claude Code, or Cursor to a workspace via a hosted MCP server. The agent reads applications, end-users, payments, and webhook health — write and admin tools exist but need explicitly granted scopes — and never sees any customer's individual data."
      />

      <Card>
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Endpoint</h2>
          <Badge tone="success" dot>
            Live
          </Badge>
        </div>
        <p className="mt-1 text-xs text-[var(--color-muted-fg)]">
          POST JSON-RPC 2.0. Two ways to authenticate:{' '}
          <strong>OAuth 2.1 + PKCE</strong> (browser flow, pick a workspace at consent) or a{' '}
          <strong>personal-access-token</strong> minted on{' '}
          <Link href="/account/api-tokens" className="underline">
            Account → API tokens
          </Link>
          .
        </p>
        <div className="mt-3 flex items-center gap-2">
          <code title={mcpUrl} className="flex-1 truncate rounded bg-[var(--color-surface-muted)] px-2 py-1.5 text-xs font-mono text-[var(--color-fg)]">{mcpUrl}</code>
          <CopyButton value={mcpUrl} label="Copy" />
        </div>
      </Card>

      <Card padded={false} className="divide-y divide-[var(--color-border)]">
        <div className="space-y-3 p-5">
          <div className="text-sm font-medium text-[var(--color-fg)]">OAuth discovery</div>
          <p className="text-xs text-[var(--color-muted-fg)]">
            MCP clients walk these automatically. Paste them only if your client doesn&apos;t do discovery.
          </p>
          <DefRow label="Authorization-server metadata (RFC 8414)" value={discoveryAs} />
          <DefRow label="Protected-resource metadata (RFC 9728)" value={discoveryPr} />
        </div>
        <div className="space-y-3 p-5">
          <div className="text-sm font-medium text-[var(--color-fg)]">OAuth endpoints</div>
          <p className="text-xs text-[var(--color-muted-fg)]">Resolved by discovery — copy for curl-level debugging.</p>
          <DefRow label="Dynamic client registration (RFC 7591)" value={registerUrl} method="POST" />
          <DefRow label="Authorization (login + workspace pick + consent)" value={authorizeUrl} method="GET / POST" />
          <DefRow label="Token (auth-code + refresh)" value={tokenUrl} method="POST" />
          <DefRow label="Introspection (RFC 7662)" value={introspectUrl} method="POST" />
        </div>
        <div className="space-y-2 p-5">
          <div className="text-sm font-medium text-[var(--color-fg)]">Required parameters</div>
          <ul className="space-y-1 text-xs text-[var(--color-muted-fg)]">
            <li><code>response_type</code> = <code>code</code></li>
            <li><code>code_challenge_method</code> = <code>S256</code> (PKCE mandatory)</li>
            <li><code>scope</code> = <code>mcp:operator:read</code> (always granted), plus <code>mcp:operator:write</code> and/or <code>mcp:operator:admin</code> when requested — each shown for approval on the consent screen</li>
            <li><code>grant_types_supported</code>: <code>authorization_code</code>, <code>refresh_token</code></li>
            <li><code>token_endpoint_auth_method</code> = <code>none</code> (public client; PKCE replaces the secret)</li>
          </ul>
        </div>
      </Card>

      <Card padded={false} className="divide-y divide-[var(--color-border)]">
        <div className="space-y-2 p-5">
          <div className="flex items-center gap-2">
            <div className="text-sm font-medium text-[var(--color-fg)]">Add to Claude Code (OAuth — recommended)</div>
            <Badge tone="success" dot>
              Preferred
            </Badge>
          </div>
          <pre className="overflow-x-auto rounded bg-[var(--color-surface-muted)] px-2 py-1.5 text-[11px] font-mono leading-relaxed text-[var(--color-fg)]">
{claudeCodeOAuth}
          </pre>
          <CopyButton value={claudeCodeOAuth} label="Copy" />
          <p className="text-xs text-[var(--color-muted-fg)]">
            Claude Code opens the browser sign-in, you authenticate with your panel email + password
            and pick a workspace. No token to paste. Tools become available immediately.
          </p>
        </div>

        <div className="space-y-2 p-5">
          <div className="text-sm font-medium text-[var(--color-fg)]">Add to Claude Desktop / Cursor (OAuth)</div>
          <p className="text-xs text-[var(--color-muted-fg)]">
            Drop into{' '}
            <code className="font-mono">
              ~/Library/Application Support/Claude/claude_desktop_config.json
            </code>{' '}
            (macOS),{' '}
            <code className="font-mono">%APPDATA%\Claude\claude_desktop_config.json</code> (Windows),
            or <code className="font-mono">~/.cursor/mcp.json</code> for Cursor.
          </p>
          <pre className="overflow-x-auto rounded bg-[var(--color-surface-muted)] px-2 py-1.5 text-[11px] font-mono leading-relaxed text-[var(--color-fg)]">
{mcpJsonOAuth}
          </pre>
          <CopyButton value={mcpJsonOAuth} label="Copy" />
          <p className="text-xs text-[var(--color-muted-fg)]">
            Restart the client. OAuth flow opens in your browser — sign in, pick a workspace, allow.
          </p>
        </div>

        <div className="space-y-2 p-5">
          <div className="text-sm font-medium text-[var(--color-fg)]">PAT-Bearer (headless / non-browser)</div>
          <p className="text-xs text-[var(--color-muted-fg)]">
            Useful when you can&apos;t drive the browser flow — CI agents, sealed containers, etc.
            Mint a PAT on{' '}
            <Link href="/account/api-tokens" className="underline">
              Account → API tokens
            </Link>
            , then paste it into either snippet below.
          </p>
          <pre className="overflow-x-auto rounded bg-[var(--color-surface-muted)] px-2 py-1.5 text-[11px] font-mono leading-relaxed text-[var(--color-fg)]">
{claudeCodePat}
          </pre>
          <CopyButton value={claudeCodePat} label="Copy CLI" />
          <pre className="mt-2 overflow-x-auto rounded bg-[var(--color-surface-muted)] px-2 py-1.5 text-[11px] font-mono leading-relaxed text-[var(--color-fg)]">
{mcpJsonPat}
          </pre>
          <CopyButton value={mcpJsonPat} label="Copy mcp.json" />
          <p className="text-xs text-[var(--color-muted-fg)]">
            <strong>Keep PATs out of shared dotfiles</strong> — paste them locally only.
          </p>
        </div>

        <div className="space-y-2 p-5">
          <div className="text-sm font-medium text-[var(--color-fg)]">Smoke test with curl</div>
          <pre className="overflow-x-auto rounded bg-[var(--color-surface-muted)] px-2 py-1.5 text-[11px] font-mono leading-relaxed text-[var(--color-fg)]">
{curlInitialize}
          </pre>
          <CopyButton value={curlInitialize} label="Copy initialize" />
          <pre className="mt-2 overflow-x-auto rounded bg-[var(--color-surface-muted)] px-2 py-1.5 text-[11px] font-mono leading-relaxed text-[var(--color-fg)]">
{curlToolsList}
          </pre>
          <CopyButton value={curlToolsList} label="Copy tools/list" />
          <pre className="mt-2 overflow-x-auto rounded bg-[var(--color-surface-muted)] px-2 py-1.5 text-[11px] font-mono leading-relaxed text-[var(--color-fg)]">
{curlToolCall}
          </pre>
          <CopyButton value={curlToolCall} label="Copy tools/call" />
        </div>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold">Read tools</h2>
        <ul className="mt-2 space-y-2 text-sm">
          {tools.map((t) => (
            <li key={t.name}>
              <code className="font-mono text-xs text-[var(--color-fg)]">{t.name}</code>
              <p className="mt-0.5 text-xs text-[var(--color-muted-fg)]">{t.summary}</p>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-[var(--color-faint-fg)]">
          The tools above are read-only and available to every credential. Write tools (create /
          update applications, plans, webhook endpoints, members) additionally require the{' '}
          <code>mcp:operator:write</code> OAuth scope — or a PAT carrying{' '}
          <code>applications:write</code>. Admin tools (billing-provider credentials, subscription
          cancel) require <code>mcp:operator:admin</code>, grantable only via OAuth consent — a PAT
          never carries it. Workspace scoping is structural — the credential is bound to one
          workspace, so every tool sees only that workspace&apos;s data.
        </p>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold">Security model</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-[var(--color-muted-fg)]">
          <li>
            Token verification is a SHA-256 hash lookup against the unique{' '}
            <code className="font-mono">token_hash</code> index — no scan, no timing oracle.
          </li>
          <li>
            Membership is re-checked against the DB on every request. Removing the operator from
            this workspace instantly invalidates every PAT bound to it.
          </li>
          <li>
            Scopes are default-deny. Read is the floor; write tools demand{' '}
            <code>mcp:operator:write</code> (OAuth) or a PAT with <code>applications:write</code>,
            and admin tools demand <code>mcp:operator:admin</code> — approved explicitly on the
            OAuth consent screen, never carried by a PAT.
          </li>
          <li>
            <code>lastUsedAt</code> on the PAT advances on every successful call — visible on{' '}
            <Link href="/account/api-tokens" className="underline">
              Account → API tokens
            </Link>{' '}
            so abuse is easy to spot.
          </li>
          <li>
            Revoke a token with one click; the next MCP request returns 401 and the client re-prompts
            for a fresh token.
          </li>
        </ul>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold">OAuth flow (what happens on connect)</h2>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-[var(--color-muted-fg)]">
          <li>
            Client POSTs <code>/oauth/register</code> with its{' '}
            <code>redirect_uris</code> → receives <code>client_id</code> (public client, no secret).
          </li>
          <li>
            Client opens <code>/oauth/authorize</code> with PKCE{' '}
            <code>code_challenge</code>, <code>state</code>, and{' '}
            <code>redirect_uri</code> — your browser sees the login form.
          </li>
          <li>
            You sign in with your panel email + password and pick a workspace at the consent page.
          </li>
          <li>
            On approve, the AS redirects back with{' '}
            <code>?code=…&amp;state=…</code>.
          </li>
          <li>
            Client POSTs <code>/oauth/token</code> with <code>code</code> +{' '}
            <code>code_verifier</code> → receives <code>access_token</code> (1h, audience-bound) +{' '}
            <code>refresh_token</code> (30d).
          </li>
          <li>
            Client POSTs the MCP endpoint with{' '}
            <code>Authorization: Bearer …</code> and starts calling tools.
          </li>
          <li>
            On expiry, client POSTs <code>/oauth/token</code> with{' '}
            <code>grant_type=refresh_token</code> to rotate.
          </li>
        </ol>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold">Troubleshooting</h2>
        <dl className="mt-2 space-y-3 text-sm">
          <div>
            <dt className="font-medium text-[var(--color-fg)]">401 OPERATOR_TOKEN_INVALID</dt>
            <dd className="text-[var(--color-muted-fg)]">
              Missing, revoked, expired, or wrong workspace. Re-mint on the API tokens page; paste
              the full <code className="font-mono">rp_op_…</code> string including the prefix.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-[var(--color-fg)]">403 TENANT_MEMBERSHIP_REVOKED</dt>
            <dd className="text-[var(--color-muted-fg)]">
              The operator behind this PAT is no longer a member of the workspace it was minted for.
              Mint a fresh token from the workspace you currently belong to.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-[var(--color-fg)]">405 METHOD_NOT_ALLOWED on GET</dt>
            <dd className="text-[var(--color-muted-fg)]">
              The MCP endpoint accepts POST only. A GET (e.g. opening the URL in a browser) returns
              this explicit error rather than a silent 404.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-[var(--color-fg)]">Tool returns empty array</dt>
            <dd className="text-[var(--color-muted-fg)]">
              The PAT is bound to a workspace that has no Applications, or the tool&apos;s filter
              (e.g. <code>onlyFailed: true</code>) matches nothing. Try <code>tools/list</code> to
              confirm the connection, then call <code>get_workspace_overview</code> for a sanity
              check.
            </dd>
          </div>
        </dl>
      </Card>
    </section>
  );
}
