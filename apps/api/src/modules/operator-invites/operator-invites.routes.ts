import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { operatorInvitesService } from "./operator-invites.service.js";
import { requireSuperAdmin } from "../../middleware/admin-auth.js";
import {
  PaginationQuery,
  parsePagination,
  paged,
  paginationJsonSchema,
} from "../../lib/pagination.js";
import { recordSecurityEvent } from "../../lib/security-events.js";
import { ok, okPage, errs, type JsonSchema } from "../../lib/openapi.js";
import { RekeyError } from "../../lib/error.js";
import { env } from "../../config/env.js";

/**
 * The 401/403/429 trio every `/api/v1/admin/*` route shares, `requireSuperAdmin`
 * runs as an `onRequest` hook, so these precede any route-specific failure.
 */
const SUPER_ADMIN_ERRORS = {
  401:
    "ADMIN_AUTH_MISSING — no `Authorization: Bearer` header; or ADMIN_AUTH_INVALID — the " +
    "value does not match `SUPER_ADMIN_KEY`.",
  403: "ADMIN_IP_NOT_ALLOWED — the caller IP is outside `ADMIN_IP_ALLOWLIST`; or ADMIN_IP_UNVERIFIABLE — an allowlist is set but the caller arrived through a proxy the API cannot identify, so it has no client address to check.",
  429: "RATE_LIMITED — too many requests. Honour the `Retry-After` header.",
} as const;

/**
 * `PublicOperatorInvite`, metadata only, never `tokenHash`, and never the raw
 * token except in the mint response.
 */
const OperatorInvite: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    tokenPrefix: {
      type: "string",
      description: "First characters of the token, for display.",
    },
    note: { type: "string", nullable: true },
    status: {
      type: "string",
      enum: ["active", "used", "revoked", "expired"],
      description: "Derived from the timestamps below, in that priority order.",
    },
    expiresAt: { type: "string", format: "date-time", nullable: true },
    usedAt: { type: "string", format: "date-time", nullable: true },
    usedByTenantUserId: { type: "string", nullable: true },
    revokedAt: { type: "string", format: "date-time", nullable: true },
    createdAt: { type: "string", format: "date-time" },
    tenantId: {
      type: "string",
      nullable: true,
      description: "Workspace-bound keys only: the workspace redeeming the key joins.",
    },
    email: {
      type: "string",
      nullable: true,
      description: "Workspace-bound keys only: the one operator email that may redeem the key.",
    },
    role: {
      type: "string",
      enum: ["OWNER", "ADMIN", "MEMBER"],
      nullable: true,
      description: "Workspace-bound keys only: the role the redeemer is given.",
    },
  },
  required: [
    "id",
    "tokenPrefix",
    "note",
    "status",
    "expiresAt",
    "usedAt",
    "usedByTenantUserId",
    "revokedAt",
    "createdAt",
    "tenantId",
    "email",
    "role",
  ],
};

const MintBody = z.object({
  note: z.string().min(1).max(200).optional(),
  expiresAt: z.string().datetime().optional(),
  tenantId: z.string().min(1).max(64).optional(),
  email: z.string().email().max(254).optional(),
  role: z.enum(["OWNER", "ADMIN", "MEMBER"]).optional(),
});

type MintBodyInput = z.infer<typeof MintBody>;

function workspaceBinding(
  body: MintBodyInput,
): { tenantId: string; email: string; role: "OWNER" | "ADMIN" | "MEMBER" } | undefined {
  if (body.tenantId === undefined) {
    if (body.email !== undefined || body.role !== undefined) {
      throw new RekeyError({
        statusCode: 400,
        code: "OPERATOR_INVITE_TENANT_REQUIRED",
        message: "`email` and `role` bind a key to a workspace, and no `tenantId` was given.",
        fix: "Pass `tenantId` with them, or drop both for a key that creates a new workspace.",
      });
    }
    return undefined;
  }
  if (body.email === undefined) {
    throw new RekeyError({
      statusCode: 400,
      code: "OPERATOR_INVITE_EMAIL_REQUIRED",
      message: "A key bound to a workspace must name the operator email allowed to redeem it.",
      fix: "Pass `email` with `tenantId`.",
    });
  }
  return { tenantId: body.tenantId, email: body.email, role: body.role ?? "OWNER" };
}

/** The panel link that redeems a workspace-bound key, or null when PANEL_URL is unset. */
function redeemUrl(rawToken: string): string | null {
  if (!env.PANEL_URL) return null;
  return `${env.PANEL_URL.replace(/\/$/, "")}/accept-invite?token=${encodeURIComponent(rawToken)}`;
}

const InviteParams = z.object({ id: z.string().min(1).max(64) });

function adminContext(req: FastifyRequest): {
  ip: string | null;
  userAgent: string | null;
} {
  const ua = req.headers["user-agent"];
  return {
    ip: req.ip || null,
    userAgent: typeof ua === "string" ? ua.slice(0, 512) : null,
  };
}

/**
 * Super-admin management of operator-invite keys. All under
 * /api/v1/admin/operator-invites, gated by SUPER_ADMIN_KEY. These keys gate
 * new-operator registration when OPERATOR_SIGNUP_MODE='invite'.
 */
export async function operatorInvitesRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.addHook("onRequest", requireSuperAdmin);

  app.post(
    "/",
    {
      schema: {
        tags: ["Admin · Operator Invites"],
        security: [{ superAdminKey: [] }],
        summary: "Mint a single-use operator-invite key (raw key shown once)",
        description:
          "Returns the raw key in `data.rawToken`. **Show it to the recipient exactly once**, " +
          "only its SHA-256 hash is stored, so the value is unrecoverable after this response. " +
          "The key authorizes ONE new operator sign-up while OPERATOR_SIGNUP_MODE=invite. " +
          "With `tenantId` and `email` it is bound to that existing workspace instead: redeeming it " +
          "joins the workspace at `role` (default OWNER) rather than creating one, only an operator " +
          "whose email is `email` can redeem it, and it expires after 7 days unless `expiresAt` is given. " +
          "A bound key is redeemed at sign-up (`inviteKey`, in open or invite mode) or, by an operator who " +
          "already has an account, through POST /api/v1/tenant/invitations/accept.",
        body: {
          type: "object",
          properties: {
            note: {
              type: "string",
              minLength: 1,
              maxLength: 200,
              description: 'Optional human label, e.g. "for jane@acme.com".',
            },
            expiresAt: {
              type: "string",
              format: "date-time",
              description:
                "Optional ISO-8601 expiry. Omit for a non-expiring (still single-use) key, " +
                "or, on a workspace-bound key, for the 7-day default.",
            },
            tenantId: {
              type: "string",
              minLength: 1,
              maxLength: 64,
              description: "Bind the key to this existing workspace. Requires `email`.",
            },
            email: {
              type: "string",
              format: "email",
              maxLength: 254,
              description: "The one operator email that may redeem a workspace-bound key.",
            },
            role: {
              type: "string",
              enum: ["OWNER", "ADMIN", "MEMBER"],
              description: "Role a workspace-bound key grants. Default OWNER.",
            },
          },
        },
        response: {
          201: ok(
            {
              type: "object",
              properties: {
                invite: OperatorInvite,
                rawToken: {
                  type: "string",
                  description:
                    "The raw invite token. Returned exactly once, at mint time, no endpoint can " +
                    "ever return it again. Only its SHA-256 hash is stored.",
                },
                inviteUrl: {
                  type: "string",
                  nullable: true,
                  description:
                    "Workspace-bound keys only: the panel link that redeems the key " +
                    "(`PANEL_URL`/accept-invite?token=…). Null when the key is unbound or PANEL_URL is unset.",
                },
                warning: { type: "string" },
              },
              required: ["invite", "rawToken", "inviteUrl", "warning"],
            },
            "The newly minted invite key. Store `rawToken` now, it is shown exactly once.",
          ),
          ...errs({
            400:
              "BAD_REQUEST — the body failed schema validation; or " +
              "OPERATOR_INVITE_EXPIRY_IN_PAST: `expiresAt` is not in the future; or " +
              "OPERATOR_INVITE_TENANT_REQUIRED: `email` or `role` without `tenantId`; or " +
              "OPERATOR_INVITE_EMAIL_REQUIRED: `tenantId` without `email`.",
            404: "TENANT_NOT_FOUND: no workspace with that `tenantId`.",
            ...SUPER_ADMIN_ERRORS,
          }),
        },
      },
    },
    async (req, reply) => {
      const body = MintBody.parse(req.body);
      const workspace = workspaceBinding(body);
      const result = await operatorInvitesService.mint({
        ...(body.note !== undefined && { note: body.note }),
        ...(body.expiresAt !== undefined && {
          expiresAt: new Date(body.expiresAt),
        }),
        ...(workspace !== undefined && { workspace }),
      });
      void recordSecurityEvent({
        type: "admin.operator_invite.minted",
        actorType: "system",
        ...adminContext(req),
        metadata: {
          inviteId: result.invite.id,
          note: body.note ?? null,
          expiresAt: result.invite.expiresAt,
          tenantId: result.invite.tenantId,
          role: result.invite.role,
        },
        ...(result.invite.tenantId !== null && { tenantId: result.invite.tenantId }),
      });
      return reply.status(201).send({
        success: true,
        data: {
          invite: result.invite,
          rawToken: result.rawToken,
          inviteUrl: result.invite.tenantId !== null ? redeemUrl(result.rawToken) : null,
          warning:
            result.invite.tenantId !== null
              ? `Store this rawToken now, it is shown exactly once and cannot be recovered. It lets ${result.invite.email} join the workspace as ${result.invite.role}, once, until ${result.invite.expiresAt}.`
              : "Store this rawToken now, it is shown exactly once and cannot be recovered. It authorizes a single operator sign-up.",
        },
      });
    },
  );

  app.get(
    "/",
    {
      schema: {
        tags: ["Admin · Operator Invites"],
        security: [{ superAdminKey: [] }],
        summary:
          "List operator-invite keys (newest first, paginated; never returns the hash)",
        querystring: {
          type: "object",
          properties: { ...paginationJsonSchema },
        },
        response: {
          200: okPage(OperatorInvite, "A page of operator-invite keys."),
          ...errs({
            400: "BAD_REQUEST — `limit` or `offset` is outside the declared range.",
            ...SUPER_ADMIN_ERRORS,
          }),
        },
      },
    },
    async (req) => {
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      const { items, total } = await operatorInvitesService.list({
        take,
        skip,
      });
      return { success: true, data: paged(items, total, take, skip) };
    },
  );

  app.delete(
    "/:id",
    {
      schema: {
        tags: ["Admin · Operator Invites"],
        security: [{ superAdminKey: [] }],
        summary: "Revoke an unused operator-invite key. Idempotent.",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1, maxLength: 64 } },
        },
        response: {
          200: ok(
            OperatorInvite,
            "The revoked key (or, if already revoked, the unchanged key).",
          ),
          ...errs({
            ...SUPER_ADMIN_ERRORS,
            404: "OPERATOR_INVITE_NOT_FOUND — no invite key with that id.",
            409: "OPERATOR_INVITE_ALREADY_USED — the key already minted an operator and cannot be revoked.",
          }),
        },
      },
    },
    async (req) => {
      const { id } = InviteParams.parse(req.params);
      const invite = await operatorInvitesService.revoke(id);
      void recordSecurityEvent({
        type: "admin.operator_invite.revoked",
        actorType: "system",
        ...adminContext(req),
        metadata: { inviteId: id },
      });
      return { success: true, data: invite };
    },
  );
}
