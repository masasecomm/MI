# Invoices

A responsive invoice app hosted on GitHub Pages. Firebase provides email/password sign-in, private Firestore storage, logo storage, and the server-side email function.

## What it does

- Manage businesses, clients, and reusable products.
- Create, edit, search, print, and download quotes and invoices.
- Save document drafts automatically and reuse saved product prices and costs.
- Record dated invoice part-payments and calculate balances.
- Review workspace-wide sales, payments, outstanding balances, and product profitability.
- Send a saved quote or invoice PDF to the client by email.
- Restrict app data, uploaded logos, and email sending to the authorized Firebase user.

The default currency is South African rand (ZAR). The existing Supabase schema and function remain in `supabase/` as legacy references and are not used by the app.

## Create and configure Firebase

The browser Firebase configuration and Firebase user UID in `config.js` are public. Never put a service-account key, Resend API key, or other private credential in the repository.

1. Open the [Firebase Console](https://console.firebase.google.com/) and create a project. Register a **Web app** in **Project settings → General** to get its web app configuration.
2. In **Authentication → Sign-in method**, enable **Email/Password**. In **Authentication → Users**, add the one authorized user and set its password. Do not add a sign-up form to the app; Firestore and Storage rules still enforce the authorized UID.
   Add `masasecomm.github.io` under **Authentication → Settings → Authorized domains** so sign-in works from GitHub Pages.
3. Create a **Cloud Firestore** database in production mode. Create a **Cloud Storage** bucket.
4. Put the web app settings in [`config.js`](./config.js), and set `AUTHORIZED_USER_UID` to the UID shown for the user you created.
5. Replace `REPLACE_WITH_AUTHORIZED_FIREBASE_UID` in [`firestore.rules`](./firestore.rules) and [`storage.rules`](./storage.rules) with that same UID.
6. Install the Firebase CLI, sign in, and select the new project:

   ```powershell
   npm install -g firebase-tools
   firebase login
   firebase use --add
   ```

7. Deploy Firestore and Storage security rules:

   ```powershell
   firebase deploy --only firestore:rules,storage
   ```

8. Configure the email function. Create `functions/.env.<project-id>` (replace `<project-id>` with the Firebase project ID) with the verified sender and authorized user UID:

   ```text
   EMAIL_FROM="Invoices <invoices@your-domain.com>"
   AUTHORIZED_USER_UID="the-firebase-user-uid"
   ```

   Set the Resend API key as a Firebase secret and deploy the function:

   ```powershell
   firebase functions:secrets:set RESEND_API_KEY
   firebase deploy --only functions
   ```

   Enter the Resend key only at the CLI prompt. Never put it in `config.js`, `.env` files, or Git.

9. Push the repository to GitHub. The existing GitHub Actions workflow publishes the app to Pages. Open the Pages URL and sign in with the Firebase account.

**Billing note:** Firebase Cloud Functions and Cloud Storage may require the Blaze (pay-as-you-go) plan. Review Firebase pricing and set budget alerts before linking billing; budget alerts are notifications, not a hard spending cap. Firestore and Authentication have their own usage quotas.

## Migrate data from Supabase

The app's former Supabase project (`iuuhshxpepccqjypreti`) is currently paused. Supabase reports that it cannot be resumed until the organization frees one of its two active free-project slots or upgrades. The existing records have not been copied to Firebase yet. Do not delete the old project.

The migration utility imports CSV or JSON exports of all five tables and can upload exported business logos. It preserves record IDs and links while changing `user_id` to the authorized Firebase UID.

1. Temporarily resume the Supabase project. Because the organization is at its free-project limit, first decide whether to upgrade or pause another project. Do not delete a project unless you have independently backed up and verified its data.
2. Export the `businesses`, `clients`, `products`, `invoices`, and `invoice_payments` tables from Supabase as CSV or JSON. Put one file per table in `migration/exports/`, for example `businesses.csv`.
3. Export business logo files from Supabase Storage. Put each logo at `migration/exports/logos/<old-supabase-user-uid>/<business-id>/logo.<ext>`. The importer accepts PNG, JPEG, WebP, or SVG files up to 2 MB. If a logo is not exported, its old Supabase URL will not work after cutover.
4. Create a Firebase Admin service-account key with the permissions needed to write Firestore and Storage. Keep the downloaded JSON file outside the repository and never share it.
5. Install the migration utility's dependencies and validate the export first:

   ```powershell
   cd migration
   npm install
   $env:GOOGLE_APPLICATION_CREDENTIALS = "C:\secure\firebase-adminsdk.json"
   $env:FIREBASE_STORAGE_BUCKET = "your-storage-bucket-name"
   npm run import -- .\exports <firebase-user-uid>
   ```

6. Review the counts and any logo warnings. Run the same command with `--apply` to import:

   ```powershell
   npm run import -- .\exports <firebase-user-uid> --apply
   ```

   The importer checks record links before writing and uses the existing record IDs. Import once into the new Firebase project; running it again overwrites records with matching IDs.

7. Verify the businesses, clients, products, invoices, payments, and logos in the app before switching users to Firebase. Keep the Supabase project and its backups until the Firebase copy is verified.

The importer accepts table CSV/JSON exports, not a raw Supabase database backup file. If you only have a backup, restore it to a temporary Postgres database and export the five tables and logo files first.

## Local preview

Serve the repository root with a static HTTP server and open its local URL. ES modules and Firebase authentication do not work reliably from a `file://` URL. Add the local preview URL to Firebase Authentication's authorized domains when needed.
