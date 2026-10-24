-- AlterTable
ALTER TABLE "custom_email_template_versions" ADD COLUMN     "topic" TEXT;

-- AlterTable
ALTER TABLE "custom_email_templates" ADD COLUMN     "topic" TEXT;

-- CreateTable
CREATE TABLE "email_topic_opt_outs" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_topic_opt_outs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_topic_opt_outs_application_id_address_topic_key" ON "email_topic_opt_outs"("application_id", "address", "topic");

-- AddForeignKey
ALTER TABLE "email_topic_opt_outs" ADD CONSTRAINT "email_topic_opt_outs_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
