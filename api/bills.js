// POST {data: base64 PDF}       -> upload a bill, returns {id}
// POST {driveUrl}               -> check a Drive link is a readable PDF, returns {fileId}
// GET  ?id=<bill id>            -> view an uploaded bill (owner, admin, management)
// GET  ?usage=1                 -> admin: storage used
// DELETE                       -> admin: delete uploaded bills older than 3 months from storage
import { sql, requireUser } from './_lib.js';
import { storeBill, loadUpload, driveFileId, loadDrive, clearOldBills, MAX_BILL_BYTES } from './_bills.js';

const CLEAR_MONTHS = 3;

export default async function handler(req, res) {
  const me = await requireUser(req, res);
  if (!me) return;
  const db = sql();
  const bad = (msg) => res.status(400).json({ error: msg });
  try {
    if (req.method === 'POST' && req.body?.driveUrl) {
      let fileId;
      try {
        fileId = driveFileId(req.body.driveUrl);
        await loadDrive(fileId);
      } catch (e) {
        return bad(e.message);
      }
      return res.status(200).json({ fileId });
    }
    if (req.method === 'POST') {
      const data = String(req.body?.data || '');
      if (data.length > Math.ceil(MAX_BILL_BYTES / 3) * 4 + 4) return bad('The PDF must be 2 MB or smaller');
      try {
        return res.status(200).json({ id: await storeBill(db, me.id, Buffer.from(data, 'base64')) });
      } catch (e) {
        if (/PDF/.test(e.message)) return bad(e.message);
        throw e;
      }
    }
    if (req.method === 'GET' && req.query.usage) {
      if (me.role !== 'admin') return res.status(403).json({ error: 'You do not have access to this' });
      const [u] = await db`select coalesce(sum(size), 0)::float8 as bytes, count(*)::int as files,
                                  count(*) filter (where created_at < now() - make_interval(months => ${CLEAR_MONTHS}))::int as old
                           from bills where deleted_at is null`;
      return res.status(200).json({ ...u, months: CLEAR_MONTHS });
    }
    if (req.method === 'GET') {
      const id = Number(req.query.id);
      const [row] = Number.isInteger(id) ? await db`select user_id from bills where id = ${id}` : [];
      if (!row || (me.role === 'employee' && row.user_id !== me.id)) return res.status(404).json({ error: 'Bill not found' });
      const buf = await loadUpload(db, id);
      if (!buf) return res.status(410).json({ error: 'This bill was deleted from storage' });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="bill-${id}.pdf"`);
      return res.status(200).send(buf);
    }
    if (req.method === 'DELETE') {
      if (me.role !== 'admin') return res.status(403).json({ error: 'You do not have access to this' });
      return res.status(200).json({ deleted: await clearOldBills(db, CLEAR_MONTHS) });
    }
    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
}
