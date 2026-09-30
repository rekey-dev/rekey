-- AlterTable
ALTER TABLE "mfa_credentials" ADD COLUMN     "used_backup_code_hashes" TEXT[] DEFAULT ARRAY[]::TEXT[];
