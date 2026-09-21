-- Per-workspace switch for the operator MCP server. Default on: applying this
-- changes nothing. Constant default, no rewrite.
ALTER TABLE "tenants" ADD COLUMN "operator_mcp_enabled" BOOLEAN NOT NULL DEFAULT true;
