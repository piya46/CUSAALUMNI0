import { z } from 'zod';
import { pool } from './db.js';
import { bootstrapAdmin } from './models/adminModel.js';

async function bootstrap() {
  const email = z.string().trim().toLowerCase().max(254).email().parse(process.env.BOOTSTRAP_ADMIN_EMAIL);
  const result = await bootstrapAdmin(email);
  console.log(result.created ? `Added initial administrator: ${email}` : `Administrator already exists: ${email}`);
}

bootstrap().catch(error => {
  console.error(error instanceof z.ZodError
    ? 'Set BOOTSTRAP_ADMIN_EMAIL to a valid email address before running this command.'
    : error instanceof Error ? error.message : 'Bootstrap failed.');
  process.exitCode = 1;
}).finally(() => pool.end());
