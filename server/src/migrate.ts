import { pool } from './db.js';
import { migrate } from './services/migrations.js';

migrate().then(applied => {
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'All migrations already applied.');
}).catch(error => {
  // SQL driver messages may include SQL data; log a classification only.
  console.error('Migration failed:', error instanceof Error ? error.name : 'UnknownError');
  process.exitCode = 1;
}).finally(() => pool.end());
