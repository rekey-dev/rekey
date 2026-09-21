-- The scope that admitted a request, when a scope gate ran.
--
-- With three roles, "who did it" implied "what they were allowed to do". With
-- scopes on the membership it does not: the set changes, and the log would
-- lose the authority a past write ran under. Nullable, constant default, no
-- rewrite. Null for open, floor and project routes.
ALTER TABLE "api_request_logs" ADD COLUMN "admitted_scope" TEXT;
