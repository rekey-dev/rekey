/**
 * Admin-API client used by every MCP tool. Mirrors `packages/cli/src/lib/api.ts`
 * but is decoupled (the MCP server doesn't depend on the CLI).
 */

interface ErrorEnvelope {
  success: false;
  error: { code: string; message: string; fix?: string; docs?: string };
}

export interface AdminClientConfig {
  apiUrl: string;
  /**
   * Global super-admin key. Authenticates the deployment-wide read tools.
   * Optional: when unset, the server still runs for the operator-token tools,
   * and the admin read tools fail closed with `READ_REQUIRES_ADMIN_KEY` rather
   * than silently using a lesser credential.
   */
  adminKey?: string;
  /**
   * Operator personal-access-token (`rp_op_…`), if configured. Every write
   * tool uses it, so an agent changes things as a scoped operator and never
   * with the all-powerful `adminKey`. The billing read tools of one
   * Application use it too: those routes are operator routes. Optional: when
   * unset, the tools that need it refuse with `OPERATOR_TOKEN_MISSING`.
   */
  operatorToken?: string;
}

export class AdminApiError extends Error {
  public readonly code: string;
  public readonly fix: string | undefined;
  public readonly statusCode: number;
  constructor(args: { code: string; message: string; fix?: string; statusCode: number }) {
    super(args.message);
    this.name = 'AdminApiError';
    this.code = args.code;
    this.fix = args.fix;
    this.statusCode = args.statusCode;
  }
}

/** What an operator-token tool does, and the scope its route asks of the token. */
export interface OperatorNeed {
  kind: 'read' | 'write';
  scope: string;
}

const KEYS_MINT: OperatorNeed = { kind: 'write', scope: 'keys:mint' };

export class AdminClient {
  constructor(private readonly cfg: AdminClientConfig) {
    if (!cfg.apiUrl) throw new Error('AdminClient: apiUrl is required.');
  }

  /** Read-path request, authenticated with the admin key. */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.cfg.adminKey) {
      throw new AdminApiError({
        code: 'READ_REQUIRES_ADMIN_KEY',
        message: 'This read/introspection tool requires the global SUPER_ADMIN_KEY.',
        fix: 'Set SUPER_ADMIN_KEY in the MCP server env to enable the deployment-wide read tools. (The operator-token tools only need REKEY_OPERATOR_TOKEN.)',
        statusCode: 400,
      });
    }
    return this.send<T>(method, path, this.cfg.adminKey, body);
  }

  /**
   * A request authenticated with the configured operator PAT (`rp_op_…`), so
   * the agent acts as a SCOPED operator, not as the global super-admin. Throws
   * `OPERATOR_TOKEN_MISSING` if no PAT was configured: these tools fail
   * closed, and never fall back to the admin key.
   *
   * @example
   * await client.requestAsOperator('PUT', path, body, { kind: 'write', scope: 'billing:write' });
   */
  async requestAsOperator<T>(method: string, path: string, body?: unknown, need: OperatorNeed = KEYS_MINT): Promise<T> {
    if (!this.cfg.operatorToken) {
      throw new AdminApiError({
        code: 'OPERATOR_TOKEN_MISSING',
        message:
          need.kind === 'write'
            ? 'This write tool requires an operator personal-access-token.'
            : 'This tool reads one Application as a workspace operator and requires an operator personal-access-token.',
        fix: `Set REKEY_OPERATOR_TOKEN (an rp_op_… token minted in the Panel, scoped to ${need.scope}) in the MCP server env.`,
        statusCode: 400,
      });
    }
    return this.send<T>(method, path, this.cfg.operatorToken, body);
  }

  private async send<T>(
    method: string,
    path: string,
    bearer: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${this.cfg.apiUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => ({}))) as
      | { success: true; data: T }
      | ErrorEnvelope;
    if (!res.ok || ('success' in json && json.success === false)) {
      const err =
        'error' in json
          ? json.error
          : { code: 'UNKNOWN_ERROR', message: `HTTP ${res.status}` };
      throw new AdminApiError({ ...err, statusCode: res.status });
    }
    return (json as { success: true; data: T }).data;
  }
}
