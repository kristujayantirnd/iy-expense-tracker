// Adds a user, or resets their password if the email exists.
// Usage: npm run add-user -- someone@example.com 'their-password'
import { neon } from '@neondatabase/serverless';
import { hashPassword } from '../api/_lib.js';

const [email, password] = process.argv.slice(2);
if (!email || !password || password.length < 8) {
  console.error("Usage: npm run add-user -- email 'password'   (password: 8+ characters)");
  process.exit(1);
}
const db = neon(process.env.DATABASE_URL);
await db`insert into users (email, password_hash) values (${email.trim().toLowerCase()}, ${hashPassword(password)})
         on conflict (email) do update set password_hash = excluded.password_hash`;
console.log(`User ${email} saved.`);
