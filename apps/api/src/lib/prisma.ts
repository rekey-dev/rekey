import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __relipayPrisma: PrismaClient | undefined;
}

// Reuse the client across `tsx watch` reloads so we don't exhaust DB
// connections during development.
export const prisma = globalThis.__relipayPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalThis.__relipayPrisma = prisma;
}
