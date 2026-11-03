// GET ?id=<invoice id> -> the invoice and its attached bills as one PDF.
import { sql, requireUser } from './_lib.js';
import { buildInvoicePdf, invoiceNo } from './_pdf.js';
import { loadUpload, loadDrive } from './_bills.js';

export default async function handler(req, res) {
  const me = await requireUser(req, res);
  if (!me) return;
  const db = sql();
  const id = Number(req.query.id);
  const [inv] = Number.isInteger(id)
    ? await db`select kind, number, to_char(invoice_date, 'YYYY-MM-DD') as date, items, total::float8 as total, status, employer, employee
               from invoices where id = ${id} and (${me.role !== 'employee'} or user_id = ${me.id})`
    : [];
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  try {
    const pdf = await buildInvoicePdf(inv, async (it) => {
      if (it.bill.drive) return loadDrive(it.bill.drive);
      const buf = await loadUpload(db, it.bill.upload);
      if (!buf) throw new Error('The uploaded file was deleted from storage (older than 3 months).');
      return buf;
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${invoiceNo(inv)}.pdf"`);
    res.status(200).send(pdf);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not build the PDF' });
  }
}
