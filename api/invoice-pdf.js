// GET ?id=<invoice id> -> the invoice and its attached bills as one PDF.
import { sql, requireUser } from './_lib.js';
import { renderInvoicePdf } from './_pdf.js';

export default async function handler(req, res) {
  const me = await requireUser(req, res);
  if (!me) return;
  const id = Number(req.query.id);
  try {
    const out = Number.isInteger(id) ? await renderInvoicePdf(sql(), id, me.role === 'employee' ? me.id : null) : null;
    if (!out) return res.status(404).json({ error: 'Invoice not found' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${out.fileName}"`);
    res.status(200).send(out.pdf);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not build the PDF' });
  }
}
