// Adds a user, or resets their password (and role) if the email exists.
// Usage: npm run add-user -- someone@example.com 'their-password' [admin|employee|management]
import { neon } from '@neondatabase/serverless';
import { hashPassword } from '../api/_lib.js';

const [email, password, role = 'admin'] = process.argv.slice(2);
if (!email || !password || password.length < 8 || !['admin', 'employee', 'management'].includes(role)) {
  console.error("Usage: npm run add-user -- email 'password' [admin|employee|management]   (password: 8+ characters)");
  process.exit(1);
}
const db = neon(process.env.DATABASE_URL);
await db`insert into users (email, password_hash, role) values (${email.trim().toLowerCase()}, ${hashPassword(password)}, ${role})
         on conflict (email) do update set password_hash = excluded.password_hash, role = excluded.role`;
console.log(`User ${email} saved as ${role}.`);
