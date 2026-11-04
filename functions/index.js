const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { defineSecret, defineString } = require("firebase-functions/params");
const { HttpsError, onCall } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

initializeApp();

const db = getFirestore();
const resendApiKey = defineSecret("RESEND_API_KEY");
const emailFrom = defineString("EMAIL_FROM");
const authorizedUserUid = defineString("AUTHORIZED_USER_UID");

function calculateAmounts(invoice) {
  const subtotal = invoice.items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
  const discount = invoice.discount_type === "percent"
    ? subtotal * Number(invoice.discount_value) / 100
    : Number(invoice.discount_value || 0);
  const taxable = subtotal - discount;
  const tax = taxable * Number(invoice.tax_rate || 0) / 100;
  return { subtotal, discount, tax, total: taxable + tax };
}

function money(value, currency) {
  return currency === "ZAR" ? `R ${value.toFixed(2)}` : `${currency} ${value.toFixed(2)}`;
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function wrapText(text, maxWidth, size, font) {
  const words = String(text || "").normalize("NFKD").replace(/[^\x20-\x7e]/g, " ").split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

async function createPdf(invoice, business, payments) {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pageSize = [595.28, 841.89];
  const margin = 48;
  const right = pageSize[0] - margin;
  const blue = rgb(0.03, 0.53, 0.79);
  let page = pdf.addPage(pageSize);
  let y = pageSize[1] - margin;

  const nextPage = () => {
    page = pdf.addPage(pageSize);
    y = pageSize[1] - margin;
  };
  const ensureSpace = (height) => {
    if (y - height < margin) nextPage();
  };
  const draw = (text, x, top, size = 10, font = regular, color = rgb(0, 0, 0)) => {
    page.drawText(String(text || "").normalize("NFKD").replace(/[^\x20-\x7e]/g, " "), {
      x,
      y: top - size,
      size,
      font,
      color,
    });
  };
  const drawWrapped = (text, x, width, size = 10, font = regular) => {
    const lines = wrapText(text, width, size, font);
    lines.forEach((line, index) => draw(line, x, y - index * (size + 3), size, font));
    y -= lines.length * (size + 3);
  };
  const amounts = calculateAmounts(invoice);
  const paidFromRecords = payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
  const paid = Math.min(amounts.total, invoice.status === "paid" && paidFromRecords === 0 ? amounts.total : paidFromRecords);

  draw(invoice.document_type === "quote" ? "QUOTE" : "INVOICE", margin, y, 11, bold, blue);
  y -= 25;
  draw(invoice.invoice_number, margin, y, 22, bold);
  y -= 35;
  draw(business.name || invoice.issuer_name, margin, y, 12, bold);
  y -= 20;
  drawWrapped(`${invoice.document_type === "quote" ? "Estimate" : "Invoice"} from ${invoice.issuer_name}`, margin, right - margin);
  drawWrapped(`Bill to: ${invoice.client_name}${invoice.client_company_name ? ` · ${invoice.client_company_name}` : ""}`, margin, right - margin);
  if (invoice.client_email) drawWrapped(invoice.client_email, margin, right - margin, 9);
  if (invoice.client_address) drawWrapped(invoice.client_address, margin, right - margin, 9);
  if (invoice.issuer_email) drawWrapped(invoice.issuer_email, margin, right - margin, 9);
  if (invoice.issuer_address) drawWrapped(invoice.issuer_address, margin, right - margin, 9);
  y -= 10;
  draw(`Issue date: ${invoice.issue_date}`, margin, y);
  draw(`${invoice.document_type === "quote" ? "Valid until" : "Due date"}: ${invoice.due_date}`, 310, y);
  y -= 34;

  page.drawLine({ start: { x: margin, y }, end: { x: right, y }, thickness: 1, color: blue });
  y -= 22;
  draw("Description", margin, y, 9, bold);
  draw("Qty", 345, y, 9, bold);
  draw("Unit price", 390, y, 9, bold);
  draw("Amount", 485, y, 9, bold);
  y -= 20;
  for (const item of invoice.items) {
    const lines = wrapText(item.description, 270, 9, regular);
    const rowHeight = Math.max(22, lines.length * 12 + 8);
    ensureSpace(rowHeight);
    lines.forEach((line, index) => draw(line, margin, y - index * 12, 9));
    draw(String(item.quantity), 345, y, 9);
    draw(money(Number(item.unit_price), invoice.currency), 390, y, 9);
    draw(money(Number(item.quantity) * Number(item.unit_price), invoice.currency), 485, y, 9);
    y -= rowHeight;
  }

  ensureSpace(150);
  page.drawLine({ start: { x: margin, y }, end: { x: right, y }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) });
  y -= 22;
  const summary = (label, value, strong = false) => {
    draw(label, 365, y, 9, strong ? bold : regular);
    draw(value, 465, y, 9, strong ? bold : regular);
    y -= 17;
  };
  summary("Subtotal", money(amounts.subtotal, invoice.currency));
  if (amounts.discount !== 0) {
    summary(amounts.discount < 0 ? "Surcharge" : "Discount", `${amounts.discount < 0 ? "+ " : "- "}${money(Math.abs(amounts.discount), invoice.currency)}`);
  }
  summary(`Tax (${invoice.tax_rate}%)`, money(amounts.tax, invoice.currency));
  summary("Total", money(amounts.total, invoice.currency), true);
  if (paid > 0) {
    summary("Amount paid", money(paid, invoice.currency));
    summary("Balance due", money(Math.max(0, amounts.total - paid), invoice.currency), true);
    if (payments.length) {
      y -= 3;
      ensureSpace(25);
      draw("PAYMENT HISTORY", margin, y, 8, bold);
      y -= 16;
      for (const payment of payments) {
        ensureSpace(18);
        draw(`${payment.paid_at}${payment.reference ? ` - ${payment.reference}` : ""}`, margin, y, 9);
        draw(money(Number(payment.amount), invoice.currency), 465, y, 9);
        y -= 15;
      }
    }
  }
  for (const [label, value] of [["TERMS", invoice.terms], ["NOTES", invoice.notes]]) {
    if (!value) continue;
    y -= 12;
    ensureSpace(35);
    draw(label, margin, y, 8, bold);
    y -= 16;
    for (const line of wrapText(value, right - margin, 9, regular)) {
      ensureSpace(16);
      draw(line, margin, y, 9);
      y -= 13;
    }
  }
  return pdf.save();
}

exports.sendDocumentEmail = onCall(
  { region: "us-central1", secrets: [resendApiKey], timeoutSeconds: 60 },
  async (request) => {
    const userId = request.auth?.uid;
    if (!userId) throw new HttpsError("unauthenticated", "Please sign in before sending a document.");
    if (!authorizedUserUid.value() || userId !== authorizedUserUid.value()) {
      throw new HttpsError("permission-denied", "This account is not authorized to send documents.");
    }
    const invoiceId = request.data?.invoice_id;
    if (typeof invoiceId !== "string" || !invoiceId.trim() || invoiceId.length > 128) {
      throw new HttpsError("invalid-argument", "A valid document ID is required.");
    }
    const apiKey = resendApiKey.value();
    const sender = emailFrom.value();
    if (!apiKey || !sender) {
      throw new HttpsError("failed-precondition", "Email sending is not configured. Set the Resend API key and verified sender address.");
    }

    const invoiceRef = db.collection("invoices").doc(invoiceId);
    const invoiceSnapshot = await invoiceRef.get();
    const invoice = invoiceSnapshot.data();
    if (!invoice || invoice.user_id !== userId) {
      throw new HttpsError("not-found", "Document not found or you do not have permission to send it.");
    }
    if (!invoice.client_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(invoice.client_email)) {
      throw new HttpsError("invalid-argument", "Add a valid client email address before sending this document.");
    }

    const businessSnapshot = await db.collection("businesses").doc(invoice.business_id).get();
    const business = businessSnapshot.data();
    if (!business || business.user_id !== userId) {
      throw new HttpsError("not-found", "The business profile for this document could not be found.");
    }
    const paymentSnapshot = await db.collection("invoice_payments")
      .where("user_id", "==", userId)
      .where("invoice_id", "==", invoiceId)
      .get();
    const payments = paymentSnapshot.docs.map((snapshot) => snapshot.data())
      .sort((left, right) => left.paid_at.localeCompare(right.paid_at));
    const pdfBytes = await createPdf(invoice, business, payments);
    const safeNumber = invoice.invoice_number.replace(/[^a-z0-9-_]/gi, "-");
    const filename = `${invoice.document_type}-${safeNumber}.pdf`;
    const title = invoice.document_type === "quote" ? "Quote" : "Invoice";
    const totals = calculateAmounts(invoice);
    const totalPaid = Math.min(totals.total, invoice.status === "paid" && payments.length === 0
      ? totals.total
      : payments.reduce((sum, payment) => sum + Number(payment.amount), 0));
    const paidHtml = totalPaid > 0
      ? `Paid: <strong>${escapeHtml(money(totalPaid, invoice.currency))}</strong><br>Balance due: <strong>${escapeHtml(money(Math.max(0, totals.total - totalPaid), invoice.currency))}</strong><br>`
      : "";
    const html = [
      `<p>Hello ${escapeHtml(invoice.client_name)},</p>`,
      `<p>Please find your ${title.toLowerCase()} <strong>${escapeHtml(invoice.invoice_number)}</strong> from ${escapeHtml(invoice.issuer_name)} attached as a PDF.</p>`,
      `<p>Total: <strong>${escapeHtml(money(totals.total, invoice.currency))}</strong><br>${paidHtml}`,
      `${invoice.document_type === "quote" ? "Valid until" : "Due date"}: ${escapeHtml(invoice.due_date)}</p>`,
      `<p>Thank you,<br>${escapeHtml(invoice.issuer_name)}</p>`,
    ].join("");
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: sender,
        to: [invoice.client_email],
        subject: `Your ${title.toLowerCase()} ${invoice.invoice_number} from ${invoice.issuer_name}`,
        html,
        attachments: [{ filename, content: Buffer.from(pdfBytes).toString("base64") }],
      }),
    });
    if (!response.ok) {
      logger.error("Resend rejected document email", { status: response.status });
      throw new HttpsError("internal", "The email provider rejected the message. Check that the sender address is verified in Resend.");
    }

    let statusUpdated = true;
    if (invoice.status === "draft") {
      try {
        await db.runTransaction(async (transaction) => {
          const current = await transaction.get(invoiceRef);
          if (current.exists && current.data().user_id === userId && current.data().status === "draft") {
            transaction.update(invoiceRef, { status: "sent", updated_at: new Date().toISOString() });
          }
        });
      } catch (error) {
        logger.error("Email sent but invoice status could not be updated", error);
        statusUpdated = false;
      }
    }
    return {
      message: statusUpdated ? "Document email sent." : "Email sent, but the document status could not be updated.",
      recipient: invoice.client_email,
      status_updated: statusUpdated,
    };
  },
);
