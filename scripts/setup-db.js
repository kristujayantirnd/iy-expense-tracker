// Creates the tables. Safe to re-run. Usage: npm run setup-db
import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';

const db = neon(process.env.DATABASE_URL);
const statements = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8')
  .split(';').map((s) => s.trim()).filter(Boolean);
for (const s of statements) await db.query(s);
console.log(`Schema applied (${statements.length} statements).`);
