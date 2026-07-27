import * as React from 'react';
import { getWorkspaceContext } from '@/lib/session';
import { rekey } from '@/lib/relipay';
import { AppShell } from '@/components/app-shell';
import { revokeSessionAction, signOutEverywhereAction } from '@/lib/actions';
import { mcpConnectionInfo } from '@rekey.dev/nextjs';
import { CopyField } from '@/components/copy-field';

export default async function AccountPage(): Promise<React.JSX.Element> {
  const ctx = await getWorkspaceContext();
  const { session, entitlements } = ctx;

  const sessions = await rekey.auth.listSessions(session.accessToken).catch(() => []);

  // MCP connection helper — only meaningful if the app has MCP enabled, but the
  // string builder is pure, so we always render it as a "connect" affordance.
  const appSlug = process.env.NEXT_PUBLIC_RELIPAY_APP_SLUG ?? ctx.config.appSlug;
  const mcp = mcpConnectionInfo({ apiUrl: process.env.RELIPAY_URL!, appSlug });

  return (
    <AppShell
      active="account"
      email={session.user.email}
      workspaceLabel={ctx.workspaceLabel}
      planLabel={ctx.planLabel}
      isPro={entitlements.isPro}
    >
      <section>
        <h1 className="text-xl font-semibold">Account</h1>
        <p className="text-sm text-neutral-500">{session.user.email}</p>
      </section>

      <section className="card">
        <h3 className="font-semibold">Active sessions</h3>
        <p className="text-xs text-neutral-500">
          Each live refresh token, newest first. Revoke any device, or sign out everywhere.
        </p>
        <div className="mt-3 space-y-2">
          {sessions.length === 0 ? (
            <p className="text-sm text-neutral-500">No active sessions.</p>
          ) : (
            sessions.map((s) => (
              <div key={s.id} className="flex items-center gap-3 rounded-lg border border-neutral-200 dark:border-neutral-800 px-3 py-2 text-sm">
                <div className="min-w-0">
                  <div className="truncate">{s.userAgent ?? 'Unknown device'}</div>
                  <div className="text-xs text-neutral-500">
                    {s.ip ?? 'unknown ip'} · {new Date(s.createdAt).toLocaleString()}
                  </div>
                </div>
                <form action={revokeSessionAction} className="ml-auto">
                  <input type="hidden" name="sessionId" value={s.id} />
                  <button type="submit" className="btn-danger">Revoke</button>
                </form>
              </div>
            ))
          )}
        </div>
        <form action={signOutEverywhereAction} className="mt-3">
          <button type="submit" className="btn-danger">Sign out everywhere</button>
        </form>
      </section>

      <section className="card">
        <h3 className="font-semibold">Connect to Claude (MCP)</h3>
        <p className="text-xs text-neutral-500">
          If this application has MCP enabled in the Rekey panel, connect it to Claude with:
        </p>
        <div className="mt-2 space-y-2">
          <CopyField label="MCP URL" value={mcp.url} />
          <CopyField label="claude mcp add" value={mcp.claudeAddCommand} />
        </div>
      </section>
    </AppShell>
  );
}
