// Bill PDFs for reimbursement line items: uploaded to private Vercel Blob, or a public Google Drive link.
import { put, get, del } from '@vercel/blob';

export const MAX_BILL_BYTES = 2 * 1024 * 1024;
const MAX_DRIVE_BYTES = 10 * 1024 * 1024;
const isPdf = (buf) => buf.length > 4 && buf.subarray(0, 5).toString('latin1') === '%PDF-';

export async function storeBill(db, userId, buf) {
  if (!isPdf(buf)) throw new Error('The file is not a PDF');
  if (buf.length > MAX_BILL_BYTES) throw new Error('The PDF must be 2 MB or smaller');
  const blob = await put(`bills/${userId}/${Date.now()}.pdf`, buf, { access: 'private', contentType: 'application/pdf', addRandomSuffix: true });
  const [row] = await db`insert into bills (user_id, pathname, size) values (${userId}, ${blob.pathname}, ${buf.length}) returning id`;
  return row.id;
}

// Uploaded bill bytes, or null if cleared from storage.
export async function loadUpload(db, id) {
  const [row] = await db`select pathname from bills where id = ${id} and deleted_at is null`;
  if (!row) return null;
  const res = await get(row.pathname, { access: 'private' });
  if (!res || res.statusCode !== 200) return null;
  return Buffer.from(await new Response(res.stream).arrayBuffer());
}

// Accepts drive.google.com/file/d/<id>/..., ...open?id=<id>, ...uc?id=<id>, or a bare id.
export function driveFileId(input) {
  const s = String(input || '').trim();
  const m = s.match(/\/d\/([\w-]{20,})/) || s.match(/[?&]id=([\w-]{20,})/) || s.match(/^([\w-]{20,})$/);
  if (!m) throw new Error('That is not a Google Drive file link');
  if (/^https?:/.test(s) && !/^https:\/\/(drive|docs)\.google\.com\//.test(s)) throw new Error('That is not a Google Drive file link');
  return m[1];
}

// Fetch is built from the id only (never the pasted URL), so nothing but Google Drive is ever requested.
export async function loadDrive(fileId) {
  const res = await fetch(`https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`, { redirect: 'follow' });
  if (!res.ok) throw new Error('Google Drive could not find that file');
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_DRIVE_BYTES) throw new Error('The Drive PDF must be 10 MB or smaller');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DRIVE_BYTES) throw new Error('The Drive PDF must be 10 MB or smaller');
  if (!isPdf(buf)) throw new Error("Can't read that Drive file. Share it as 'Anyone with the link can view' and make sure it is a PDF");
  return buf;
}

// Deletes uploaded bills older than `months` from Blob storage; the bills row stays as a record.
export async function clearOldBills(db, months) {
  const rows = await db`select id, pathname from bills where deleted_at is null and created_at < now() - make_interval(months => ${months})`;
  if (rows.length) {
    await del(rows.map((r) => r.pathname));
    await db`update bills set deleted_at = now() where id = any(${rows.map((r) => r.id)})`;
  }
  return rows.length;
}
