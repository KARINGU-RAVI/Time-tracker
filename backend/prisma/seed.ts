import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { seedOwner } from './seed-lib';

const prisma = new PrismaClient();

async function main() {
  const email = process.env.ALLOWED_EMAIL;
  if (!email) throw new Error('ALLOWED_EMAIL is not set');
  const user = await seedOwner(prisma, {
    email,
    trackingStart: process.env.SEED_TRACKING_START ?? '2026-09-21',
  });
  console.log(`Seeded owner ${user.id}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
