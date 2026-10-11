# Masase Commerce Invoices

A responsive invoice app hosted as a static site on GitHub Pages. Supabase provides account sign-in and private, cross-device invoice storage.

## What it does

- Manage multiple businesses, including business contact details and an uploaded logo.
- View an all-business dashboard and individual business dashboards with client and document visualizations.
- Compare each business's document counts across today, this month, and this year with bar charts.
- Save client names separately from company names, associate one client with multiple companies, and reuse those client-company details on documents.
- Review each client's quotes and invoices alongside total paid and outstanding balances.
- Create, edit, search, print, and delete quotes and invoices; convert a quote to an invoice or start an unpaid draft invoice from an existing invoice.
- Delete businesses and their associated records, remove saved clients while keeping their historical documents, and delete documents with their payment history after confirmation.
- Number invoices sequentially by issue date (`INV-yyyy-mm-dd-1`) or, when a saved client is selected, by client (`INV-Client-Name-1`). Existing documents keep their assigned numbers.
- Automatically save complete document drafts and notes as you edit them.
- Automatically remember line-item products, descriptions, selling prices, and unit costs in the business catalogue for reuse.
- Review product quantities sold, customer-by-customer sales, recorded costs, and gross profit; add catalogue products to new invoices.
- Review workspace-wide revenue, collections, outstanding balances, company sales, and product profitability on the Reports page.
- Find saved products regardless of capitalization, and avoid duplicate catalogue entries that differ only by case. Update or remove catalogue entries without changing historical invoice lines.
- Add line items, tax, currency, status, dates, and notes.
- Add editable estimate and invoice terms; converting an estimate switches to the default invoice payment terms.
- Record multiple dated part-payments, calculate a deposit as a percentage of the remaining balance, and show paid percentage, amount received, and balance due on documents.
- Display a paid or partially-paid stamp on invoice previews, printed documents, downloaded PDFs, and emailed PDFs.
- Apply discounts as a percentage or fixed amount. A negative discount amount is treated as a surcharge.
- Calculate totals and directly download quotes and invoices as PDFs, or print them.
- Email a saved quote or invoice PDF directly to the client's email address.
- Restrict sign-in and database access to the authorized Masase Commerce account, with Supabase authentication and row-level security.

The default currency is South African rand (ZAR), displayed with the `R` symbol. Change the currency code on each invoice when needed. The workspace uses the available screen width and adapts to mobile layouts.

## Set up cloud storage

1. Create a Supabase project.
2. In the Supabase SQL Editor, run [`supabase/schema.sql`](./supabase/schema.sql). It creates the business, client-company directory, product catalogue with descriptions and unit costs, document, dated invoice-payment ledger, and logo-storage policies. If you already have this app set up, rerun the full script to add the latest fields and policies; it preserves existing records.
3. In Supabase project settings, copy the Project URL and the publishable key (or legacy `anon` key).
4. Add those values to [`config.js`](./config.js):

   ```js
   export const SUPABASE_URL = "https://your-project.supabase.co";
   export const SUPABASE_ANON_KEY = "your-public-anon-key";
   ```

   The publishable/anon key is intended for browser use. Never put a Supabase secret or `service_role` key in this file. Row-level security is enabled for invoices; keep the policies in the SQL setup enabled.

5. In Supabase Authentication settings, configure the site URL and allowed redirect URLs to include your GitHub Pages URL (for example, `https://your-user.github.io/your-repository/`). For a custom domain, add that URL too.
6. Set the repository's default branch to `main` and push the app. In GitHub, open **Settings → Pages** and select **GitHub Actions** as the build and deployment source. The workflow in `.github/workflows/deploy.yml` deploys the site on every push to `main`.
7. In Supabase **Authentication → Users**, create or invite `masasecomm@gmail.com` and set its password privately in the dashboard. In **Authentication → Providers → User Signups**, disable new-user signups. Then open the Pages URL and sign in with that account.

Because GitHub Pages is static hosting, the Supabase URL and publishable/anon key in `config.js` are visible to site visitors. This is expected: authentication and row-level security—not hiding the public key—protect invoice data.

The login UI and database policies restrict access to `masasecomm@gmail.com`. After updating an existing project, rerun [`supabase/schema.sql`](./supabase/schema.sql) in the Supabase SQL Editor so the client-company fields, product costs, payment ledger, and latest policies are applied. The script requests a PostgREST schema-cache reload at the end. Never store the account password in this repository or share it in chat; if a password has been exposed, change it in Supabase before using it.

## Set up customer email

Customer emails are sent by a Supabase Edge Function through Resend. The Resend API key must only be stored as a Supabase function secret; never add it to `config.js` or the GitHub repository.

1. Create a Resend account and verify a sending domain. Copy its API key and choose a sender address on that verified domain, such as `Masase Commerce <invoices@your-domain.com>`.
2. Install the Supabase CLI, sign in with `npx supabase login`, and link this repository to your project with `npx supabase link --project-ref iuuhshxpepccqjypreti`.
3. Set the email provider secrets and deploy the function from the repository root. Redeploy this function after pulling changes so emailed PDFs include the current invoice terms and payment details:

   ```powershell
   npx supabase secrets set RESEND_API_KEY=re_your_key "EMAIL_FROM=Masase Commerce <invoices@your-domain.com>"
   npx supabase functions deploy send-document-email
   ```

4. In the app, save a quote or invoice with a valid client email address, then choose **Email PDF** in its document actions. Successfully emailed draft documents are marked as sent.

## Local preview

Serve the repository root with any static HTTP server, then open its local URL. ES modules and authentication do not work reliably from a `file://` URL. Cloud features require the Supabase setup above and an allowed redirect URL.
