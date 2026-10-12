-- CreateTable
CREATE TABLE "support_case_notes" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "case_id" TEXT NOT NULL,
    "end_user_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_case_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "support_case_notes_case_id_created_at_idx" ON "support_case_notes"("case_id", "created_at");

-- CreateIndex
CREATE INDEX "support_case_notes_application_id_end_user_id_idx" ON "support_case_notes"("application_id", "end_user_id");
