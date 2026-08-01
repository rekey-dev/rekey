import * as React from 'react';
import { redirect } from 'next/navigation';
import { api, PanelApiError, type ApplicationRow } from '@/lib/api';
import { CopyButton } from '@/components/CopyButton';
import { PageHeader } from '@/components/PageHeader';
import { Card, SectionHeader } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { ConfirmButton } from '@/components/ConfirmButton';
import { SubmitButton } from '@/components/SubmitButton';
import { SavedBanner } from '@/components/SavedBanner';
import { Banner } from '@/components/Banner';

// Fallback only — the public MCP URL is authoritative from the API
// (`app.mcpUrl`, derived server-side from PUBLIC_WEBHOOK_BASE_URL). The panel's
// own REKEY_URL is the in-cluster host (e.g. http://api:3030), so never
// display it.
function fallbackBase(): string {
  // A visible sentinel, not '' — an empty base yields a RELATIVE url that looks
  // plausible in a copied snippet and then fails somewhere else entirely.
  const base = process.env.NEXT_PUBLIC_API_URL;
  if (!base) return '<set NEXT_PUBLIC_API_URL>';
  return base.replace(/\/$/, '');
}

async function setMcpEnabled(applicationId: string, enabled: boolean): Promise<void> {
  'use server';
  try {
    await api({
      method: 'PATCH',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/auth-config`,
      body: { mcpEnabled: enabled },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/mcp?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  // Bust the App Router cache for this route so the post-redirect render
  // reflects the new state immediately — without this the client Router Cache
  // serves the stale "Off"/"Live" render and the change only "sticks" after a
  // manual refresh.
  redirect(`/applications/${applicationId}/mcp?saved=1`);
}

const ERR: Record<string, string> = {
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can change MCP settings.',
};

export default async function McpPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const saved = sp.saved === '1';

  const app = await api<ApplicationRow>({
    method: 'GET',
    path: `/api/v1/tenant/applications/${encodeURIComponent(id)}`,
  });
  const enabled = app.authConfig.mcpEnabled === true;
  const mcpUrl = app.mcpUrl ?? `${fallbackBase()}/api/v1/mcp/${app.slug}`;
  const claudeCodeSnippet = `claude mcp add --transport http ${app.slug} ${mcpUrl}`;

  // Per-route URLs that the operator can paste verbatim into a client config.
  // Computed from the canonical `mcpUrl` so they survive a future host change.
  const discoveryAs = `${mcpUrl}/.well-known/oauth-authorization-server`;
  const discoveryPr = `${mcpUrl}/.well-known/oauth-protected-resource`;
  const registerUrl = `${mcpUrl}/oauth/register`;
  const authorizeUrl = `${mcpUrl}/oauth/authorize`;
  const tokenUrl = `${mcpUrl}/oauth/token`;
  const introspectUrl = `${mcpUrl}/oauth/introspect`;

  // mcp.json snippet for Claude Desktop / Claude Code's HTTP-OAuth transport.
  // Discovery URL is included explicitly so the client doesn't have to walk
  // the well-known cascade — works even when the operator's deployment runs
  // the API behind an unusual path.
  const mcpJson = `{
  "mcpServers": {
    "${app.slug}": {
      "type": "http",
      "url": "${mcpUrl}",
      "oauth": {
        "authServerMetadataUrl": "${discoveryAs}"
      }
    }
  }
}`;

  return (
    <div className="space-y-6">
      <PageHeader
        title="MCP server"
        description="Expose a hosted Model Context Protocol server for this application. End-users authenticate with their account (OAuth 2.1 + PKCE) and connect MCP clients like Claude Code, Claude Desktop, and Cursor to read their own data."
      />

      {saved && <SavedBanner message="MCP settings saved." />}
      {error && (
        <Banner tone="error">
          {ERR[error] ?? error}
        </Banner>
      )}

      {/* Master switch — gates the MCP + OAuth endpoints for this application. */}
      <Card className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">MCP server</h2>
            <Badge tone={enabled ? 'success' : 'neutral'} dot>
              {enabled ? 'Live' : 'Off'}
            </Badge>
          </div>
          <p className="mt-1 max-w-prose text-sm text-[var(--color-muted-fg)]">
            {enabled
              ? 'The MCP server and its OAuth 2.1 authorization server are reachable. Connection details are below.'
              : 'The MCP and OAuth endpoints return 404 until you enable them. Enabling mounts the server, its authorization server, and discovery metadata.'}
          </p>
        </div>
        <form action={setMcpEnabled.bind(null, id, !enabled)} className="shrink-0">
          {enabled ? (
            <ConfirmButton
              confirm="Disable the MCP server? The MCP and OAuth endpoints immediately return 404 and any connected clients lose access on their next call. Already-issued tokens stop working. You can re-enable any time."
              variant="danger"
            >
              Disable MCP
            </ConfirmButton>
          ) : (
            <SubmitButton
              pendingLabel="Enabling…"
              className="rounded-md bg-[var(--color-primary)] px-4 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)] disabled:opacity-60 disabled:cursor-not-allowed"
            >
              Enable
            </SubmitButton>
          )}
        </form>
      </Card>

      {!enabled && (
        <Card>
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">What enabling does</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-[var(--color-muted-fg)]">
            <li>Mounts the MCP JSON-RPC endpoint at <code>{mcpUrl}</code>.</li>
            <li>Mounts the OAuth 2.1 + PKCE authorization server alongside it.</li>
            <li>Publishes RFC 8414 + RFC 9728 discovery metadata so clients auto-discover.</li>
            <li>
              Accepts RFC 7591 dynamic client registration (public clients, PKCE, no secret). MCP
              clients register themselves, so this stays open by default; close it with{' '}
              <code>authConfig.dynamicClientRegistration = false</code> once your clients exist —
              worth doing if this Application is also an OpenID Provider.
            </li>
          </ul>
          <p className="mt-3 text-xs text-[var(--color-muted-fg)]">
            See the{' '}
            <a className="underline" href="https://rekey.dev/docs/mcp" target="_blank" rel="noopener noreferrer">
              full integration guide on rekey.dev/docs/mcp
            </a>{' '}
            for the OAuth flow walk-through.
          </p>
        </Card>
      )}

      {enabled && (
        <>
          <section className="space-y-3">
            <SectionHeader
              title="Connection"
              description="The endpoint, OAuth discovery URLs, and parameters a client needs. MCP clients walk discovery automatically — these are listed for hand-rolled clients and debugging."
            />
          <Card padded={false} className="divide-y divide-[var(--color-border)]">
            <div className="space-y-2 p-5">
              <div className="text-sm font-medium text-[var(--color-fg)]">MCP endpoint</div>
              <p className="text-xs text-[var(--color-muted-fg)]">
                JSON-RPC 2.0 over HTTP POST. Clients send unauthenticated, receive 401 with a
                <code className="mx-1">Bearer resource_metadata=…</code> challenge, then run the OAuth
                flow auto-discovered from the well-known URLs below.
              </p>
              <div className="flex items-center gap-2">
                <code title={mcpUrl} className="flex-1 truncate rounded bg-[var(--color-surface-muted)] px-2 py-1.5 text-xs font-mono text-[var(--color-fg)]">{mcpUrl}</code>
                <CopyButton value={mcpUrl} label="Copy" />
              </div>
            </div>

            <div className="space-y-3 p-5">
              <div className="text-sm font-medium text-[var(--color-fg)]">OAuth discovery</div>
              <p className="text-xs text-[var(--color-muted-fg)]">
                Standard well-known URLs. MCP clients walk these automatically; you only need to paste
                them if your client doesn&apos;t do discovery.
              </p>
              <DefRow label="Authorization-server metadata (RFC 8414)" value={discoveryAs} />
              <DefRow label="Protected-resource metadata (RFC 9728)" value={discoveryPr} />
            </div>

            <div className="space-y-3 p-5">
              <div className="text-sm font-medium text-[var(--color-fg)]">OAuth endpoints</div>
              <p className="text-xs text-[var(--color-muted-fg)]">
                Resolved by discovery — listed here for hand-rolled clients or curl-level debugging.
              </p>
              <DefRow label={<>Dynamic client registration (<a className="underline" href="https://datatracker.ietf.org/doc/html/rfc7591" target="_blank" rel="noopener noreferrer">RFC 7591</a>)</>} value={registerUrl} method="POST" />
              <DefRow label="Authorization (login + consent)" value={authorizeUrl} method="GET / POST" />
              <DefRow label="Token (auth-code + refresh)" value={tokenUrl} method="POST" />
              <DefRow label={<>Introspection (<a className="underline" href="https://datatracker.ietf.org/doc/html/rfc7662" target="_blank" rel="noopener noreferrer">RFC 7662</a>)</>} value={introspectUrl} method="POST" />
            </div>

            <div className="space-y-2 p-5">
              <div className="text-sm font-medium text-[var(--color-fg)]">Required parameters</div>
              <ul className="space-y-1 text-xs text-[var(--color-muted-fg)]">
                <li><code>response_type</code> = <code>code</code></li>
                <li><code>code_challenge_method</code> = <code>S256</code> (PKCE mandatory)</li>
                <li><code>scope</code> = <code>mcp:account</code> (read-only account access — the only scope today)</li>
                <li><code>grant_types_supported</code>: <code>authorization_code</code>, <code>refresh_token</code></li>
                <li><code>token_endpoint_auth_method</code> = <code>none</code> (public client; PKCE replaces the secret)</li>
              </ul>
            </div>
          </Card>
          </section>

          <section className="space-y-3">
            <SectionHeader
              title="Add to a client"
              description="Copy-paste config for the common MCP clients. Each opens the OAuth flow on first connect so the end-user signs in and grants access."
            />
          <Card padded={false} className="divide-y divide-[var(--color-border)]">
            <div className="space-y-2 p-5">
              <div className="text-sm font-medium text-[var(--color-fg)]">Add to Claude Code</div>
              <div className="flex items-center gap-2">
                <code title={claudeCodeSnippet} className="flex-1 truncate rounded bg-[var(--color-surface-muted)] px-2 py-1.5 text-xs font-mono text-[var(--color-fg)]">{claudeCodeSnippet}</code>
                <CopyButton value={claudeCodeSnippet} label="Copy" />
              </div>
              <p className="text-xs text-[var(--color-muted-fg)]">
                The CLI registers the server in your global <code>~/.claude.json</code>. On first use Claude
                Code opens the OAuth browser flow, the user authorizes, and the tools become available.
              </p>
            </div>

            <div className="space-y-2 p-5">
              <div className="text-sm font-medium text-[var(--color-fg)]">Add to Claude Desktop / Cursor</div>
              <p className="text-xs text-[var(--color-muted-fg)]">
                Drop into <code>~/Library/Application Support/Claude/claude_desktop_config.json</code>
                {' '}(macOS), <code>%APPDATA%\Claude\claude_desktop_config.json</code> (Windows), or{' '}
                <code>~/.cursor/mcp.json</code> for Cursor.
              </p>
              <div className="flex items-start gap-2">
                <pre className="flex-1 overflow-x-auto rounded bg-[var(--color-surface-muted)] px-2 py-1.5 text-[11px] font-mono leading-relaxed text-[var(--color-fg)]">
{mcpJson}
                </pre>
                <CopyButton value={mcpJson} label="Copy" />
              </div>
              <p className="text-xs text-[var(--color-muted-fg)]">
                Restart the client. The OAuth flow opens in your browser; the user signs into{' '}
                <strong>{app.name}</strong> and grants <code>mcp:account</code> scope.
              </p>
            </div>

            <div className="space-y-2 p-5">
              <div className="text-sm font-medium text-[var(--color-fg)]">Custom HTTP client</div>
              <p className="text-xs text-[var(--color-muted-fg)]">
                Paste the MCP endpoint into Claude → Settings → Connectors → Add custom connector. The
                client GETs <code>/.well-known/oauth-protected-resource</code> on its first 401 and
                drives the flow.
              </p>
              <div className="flex items-center gap-2">
                <code title={mcpUrl} className="flex-1 truncate rounded bg-[var(--color-surface-muted)] px-2 py-1.5 text-xs font-mono text-[var(--color-fg)]">{mcpUrl}</code>
                <CopyButton value={mcpUrl} label="Copy" />
              </div>
            </div>
          </Card>
          </section>

          <section className="space-y-3">
            <SectionHeader
              title="Reference"
              description="How the OAuth flow runs, what tools the session exposes, and how to debug a failed connection."
            />
          <Card>
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">OAuth flow (what happens on connect)</h2>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-[var(--color-muted-fg)]">
              <li>
                Client POSTs <code>/oauth/register</code> with its <code>redirect_uris</code> →
                receives <code>client_id</code> (public client, no secret).
              </li>
              <li>
                Client opens <code>/oauth/authorize</code> with PKCE <code>code_challenge</code>,{' '}
                <code>state</code>, and <code>redirect_uri</code> — your end-user sees the login + consent page.
              </li>
              <li>
                On approve, the AS redirects back with <code>?code=…&amp;state=…</code>.
              </li>
              <li>
                Client POSTs <code>/oauth/token</code> with <code>code</code> + <code>code_verifier</code>{' '}
                → receives <code>access_token</code> (Bearer, 1h) + <code>refresh_token</code>.
              </li>
              <li>
                Client POSTs the MCP endpoint with <code>Authorization: Bearer …</code> and starts
                calling tools.
              </li>
              <li>
                On expiry, client POSTs <code>/oauth/token</code> with{' '}
                <code>grant_type=refresh_token</code> to rotate.
              </li>
            </ol>
          </Card>

          <Card>
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">Tools the user can call</h2>
            <ul className="mt-2 space-y-2 text-sm text-[var(--color-muted-fg)]">
              <li>
                <code className="text-[var(--color-fg)]">get_profile</code> — email, role, verification, custom metadata.
              </li>
              <li>
                <code className="text-[var(--color-fg)]">get_subscription</code> — current plan + status + period end, or null.
              </li>
              <li>
                <code className="text-[var(--color-fg)]">get_credits</code> — prepaid credit balance.
              </li>
              <li>
                <code className="text-[var(--color-fg)]">list_licenses</code> — issued licenses (kind, status, expiry; no keys).
              </li>
            </ul>
            <p className="mt-2 text-xs text-[var(--color-faint-fg)]">
              All read-only. No tool returns license keys, password hashes, or provider credentials. The
              session is scoped to the (Application, EndUser) pair — a user cannot read anyone else&apos;s data.
            </p>
          </Card>

          <Card>
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">Troubleshooting</h2>
            <dl className="mt-2 space-y-3 text-sm">
              <div>
                <dt className="font-medium text-[var(--color-fg)]">404 on the MCP URL or discovery URL</dt>
                <dd className="text-[var(--color-muted-fg)]">MCP isn&apos;t enabled on this Application yet — flip the toggle above.</dd>
              </div>
              <div>
                <dt className="font-medium text-[var(--color-fg)]">401 with no <code>WWW-Authenticate</code> challenge</dt>
                <dd className="text-[var(--color-muted-fg)]">
                  The Bearer token is missing or expired. The MCP endpoint always returns 401 + a{' '}
                  <code>Bearer resource_metadata=…</code> header on unauthenticated calls — clients use that
                  header to start discovery. If your client doesn&apos;t honour it, paste the discovery URL
                  manually into the <code>oauth.authServerMetadataUrl</code> field of your mcp.json.
                </dd>
              </div>
              <div>
                <dt className="font-medium text-[var(--color-fg)]">invalid_request on /authorize</dt>
                <dd className="text-[var(--color-muted-fg)]">
                  PKCE missing (need <code>code_challenge_method=S256</code>) OR{' '}
                  <code>response_type</code> isn&apos;t <code>code</code>. Both are required.
                </dd>
              </div>
              <div>
                <dt className="font-medium text-[var(--color-fg)]">Unknown <code>client_id</code> or unregistered <code>redirect_uri</code></dt>
                <dd className="text-[var(--color-muted-fg)]">
                  Re-run dynamic registration. Allowed redirect URIs: <code>https://…</code>,{' '}
                  <code>http://localhost</code>, and custom schemes (e.g. <code>claude://…</code>). Not allowed:{' '}
                  <code>ftp://</code>, <code>file://</code>.
                </dd>
              </div>
              <div>
                <dt className="font-medium text-[var(--color-fg)]">Tools list is empty</dt>
                <dd className="text-[var(--color-muted-fg)]">
                  The access token is valid but for a different audience. Rekey binds each token to{' '}
                  <code>aud = {mcpUrl}</code>; using it against a different app&apos;s MCP endpoint returns
                  an empty tool list. Re-do the flow for the right Application.
                </dd>
              </div>
              <div>
                <dt className="font-medium text-[var(--color-fg)]">&quot;Sign all sessions out&quot;</dt>
                <dd className="text-[var(--color-muted-fg)]">
                  Bumping the Application&apos;s <code>tokenGeneration</code> (per-app kill-switch) invalidates
                  every issued MCP access token immediately, including the user&apos;s in-flight ones. Clients
                  will see 401 + a fresh challenge and re-run the flow.
                </dd>
              </div>
            </dl>
          </Card>

          <Card>
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">Further reading</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
              <li>
                <a className="text-[var(--color-primary)] underline" href="https://rekey.dev/docs/mcp" target="_blank" rel="noopener noreferrer">
                  rekey.dev/docs/mcp
                </a>{' '}— operator-facing concept guide + Claude Code / Desktop / Cursor walkthroughs.
              </li>
              <li>
                <a className="text-[var(--color-primary)] underline" href="https://modelcontextprotocol.io" target="_blank" rel="noopener noreferrer">
                  modelcontextprotocol.io
                </a>{' '}— the MCP spec.
              </li>
              <li>
                <a className="text-[var(--color-primary)] underline" href="https://datatracker.ietf.org/doc/html/rfc8414" target="_blank" rel="noopener noreferrer">
                  RFC 8414
                </a>,{' '}
                <a className="text-[var(--color-primary)] underline" href="https://datatracker.ietf.org/doc/html/rfc9728" target="_blank" rel="noopener noreferrer">
                  RFC 9728
                </a>,{' '}
                <a className="text-[var(--color-primary)] underline" href="https://datatracker.ietf.org/doc/html/rfc7591" target="_blank" rel="noopener noreferrer">
                  RFC 7591
                </a>{' '}— what Rekey implements.
              </li>
            </ul>
          </Card>
          </section>
        </>
      )}
    </div>
  );
}

/**
 * Single labelled URL + copy button row used inside the discovery + endpoints
 * cards. Keeps the OAuth-endpoint section's rows visually consistent.
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
