/*
  Warnings:

  - You are about to drop the column `failed_sign_in_attempts` on the `end_users` table. All the data in the column will be lost.
  - You are about to drop the column `locked_until` on the `end_users` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "end_users" DROP COLUMN "failed_sign_in_attempts",
DROP COLUMN "locked_until";
