import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parse } from "csv-parse/sync";

const collectionNames = ["businesses", "clients", "products", "invoices", "invoice_payments"];
const numericFields = {
  products: ["unit_price", "unit_cost"],
  invoices: ["tax_rate", "discount_value"],
  invoice_payments: ["amount"],
};

function usage() {
  console.error("Usage: npm run import -- <export-folder> <firebase-user-uid> [--apply]");
  console.error("Without --apply, the script validates and reports the export without writing to Firebase.");
}

async function loadTable(folder, tableName) {
  const csvPath = join(folder, `${tableName}.csv`);
  const jsonPath = join(folder, `${tableName}.json`);
  let contents;
  let format;
  try {
    contents = await readFile(csvPath, "utf8");
    format = "csv";
  } catch (csvError) {
    if (csvError.code !== "ENOENT") throw csvError;
    try {
      contents = await readFile(jsonPath, "utf8");
      format = "json";
    } catch (jsonError) {
      if (jsonError.code === "ENOENT") {
        throw new Error(`Missing ${tableName}.csv or ${tableName}.json in ${folder}`);
      }
      throw jsonError;
    }
  }

  const records = format === "csv"
    ? parse(contents, { columns: true, skip_empty_lines: true, bom: true })
    : JSON.parse(contents);
  if (!Array.isArray(records)) throw new Error(`${tableName} export must contain an array of rows.`);
  return records.map((record) => ({ ...record }));
}

function normalizeRows(tableName, rows, targetUid) {
  return rows.map((row, index) => {
    if (!row.id || typeof row.id !== "string") {
      throw new Error(`${tableName} row ${index + 1} has no string id.`);
    }
    if (row.items && typeof row.items === "string") {
      try {
        row.items = JSON.parse(row.items);
      } catch {
        throw new Error(`Invoice ${row.id} has invalid JSON in its items field.`);
      }
    }
    for (const field of numericFields[tableName] || []) {
      if (row[field] !== undefined && row[field] !== null && row[field] !== "") {
        const number = Number(row[field]);
        if (!Number.isFinite(number)) throw new Error(`${tableName} row ${row.id} has an invalid ${field}.`);
        row[field] = number;
      }
    }
    if (tableName === "invoices" && !Array.isArray(row.items)) {
      throw new Error(`Invoice ${row.id} does not contain an items array.`);
    }
    row.user_id = targetUid;
    return row;
  });
}

function validateRelations(records) {
  const businessIds = new Set(records.businesses.map((row) => row.id));
  const clientIds = new Set(records.clients.map((row) => row.id));
  const invoiceIds = new Set(records.invoices.map((row) => row.id));
  for (const tableName of ["clients", "products", "invoices", "invoice_payments"]) {
    for (const row of records[tableName]) {
      if (!businessIds.has(row.business_id)) {
        throw new Error(`${tableName} row ${row.id} refers to missing business ${row.business_id}.`);
      }
    }
  }
  for (const invoice of records.invoices) {
    if (invoice.client_id && !clientIds.has(invoice.client_id)) {
      throw new Error(`Invoice ${invoice.id} refers to missing client ${invoice.client_id}.`);
    }
  }
  for (const payment of records.invoice_payments) {
    if (!invoiceIds.has(payment.invoice_id)) {
      throw new Error(`Payment ${payment.id} refers to missing invoice ${payment.invoice_id}.`);
    }
  }
}

async function getLogoFile(folder, originalUserId, businessId) {
  const directories = [
    join(folder, "logos", originalUserId || "", businessId),
    join(folder, "logos", businessId),
  ];
  for (const directory of directories) {
    let names;
    try {
      names = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const files = names.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
    if (!files.length) continue;
    const preferred = files.find((name) => /^logo\./i.test(name)) || files[0];
    return { path: join(directory, preferred), name: preferred };
  }
  return null;
}

async function migrateLogos(folder, businesses, targetUid, bucket, apply) {
  const warnings = [];
  for (const business of businesses) {
    const logo = await getLogoFile(folder, business.original_user_id, business.id);
    if (!logo) {
      if (business.logo_url) warnings.push(`No exported logo file found for business "${business.name}" (${business.id}); its old Supabase URL will not be usable after cutover.`);
      business.logo_url = null;
      business.logo_path = null;
      continue;
    }
    const extension = logo.name.includes(".") ? logo.name.split(".").pop().toLowerCase() : "";
    const contentTypes = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml" };
    const contentType = contentTypes[extension];
    if (!contentType) throw new Error(`Unsupported logo file type for ${logo.name}.`);
    const storagePath = `business-logos/${targetUid}/${business.id}/logo.${extension}`;
    business.logo_path = storagePath;
    if (apply) {
      const bytes = await readFile(logo.path);
      if (bytes.byteLength > 2 * 1024 * 1024) throw new Error(`Logo ${logo.path} exceeds the 2 MB app limit.`);
      const token = randomUUID();
      await bucket.file(storagePath).save(bytes, {
        resumable: false,
        metadata: { contentType, metadata: { firebaseStorageDownloadTokens: token } },
      });
      business.logo_url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(storagePath)}?alt=media&token=${token}`;
    } else {
      business.logo_url = `https://firebasestorage.googleapis.com/v0/b/${process.env.FIREBASE_STORAGE_BUCKET || "your-project.appspot.com"}/o/${encodeURIComponent(storagePath)}?alt=media&token=SET_DURING_IMPORT`;
    }
  }
  return warnings;
}

async function main() {
  const [, , exportFolderArgument, targetUid, ...options] = process.argv;
  const apply = options.includes("--apply");
  if (!exportFolderArgument || !targetUid || options.some((option) => option !== "--apply")) {
    usage();
    process.exitCode = 2;
    return;
  }
  const exportFolder = resolve(exportFolderArgument);
  const rawRecords = Object.fromEntries(await Promise.all(
    collectionNames.map(async (name) => [name, await loadTable(exportFolder, name)]),
  ));
  const sourceUserIds = new Set(Object.values(rawRecords).flat().map((row) => row.user_id).filter(Boolean));
  if (sourceUserIds.size > 1) {
    throw new Error("The exports contain records from multiple Supabase users. Stop and separate the authorized account's records before importing.");
  }
  const originalUserId = [...sourceUserIds][0] || "";
  const records = Object.fromEntries(collectionNames.map((name) => [
    name,
    normalizeRows(name, rawRecords[name], targetUid),
  ]));
  validateRelations(records);
  const businesses = records.businesses.map((business, index) => ({
    ...business,
    original_user_id: rawRecords.businesses[index]?.user_id || originalUserId,
  }));
  const warnings = [];
  let bucket;
  if (apply) {
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      throw new Error("Set GOOGLE_APPLICATION_CREDENTIALS to a Firebase service-account JSON file outside the repository.");
    }
    if (!process.env.FIREBASE_STORAGE_BUCKET) {
      throw new Error("Set FIREBASE_STORAGE_BUCKET to your Firebase project's Storage bucket name.");
    }
    const { applicationDefault, initializeApp } = await import("firebase-admin/app");
    const { getFirestore } = await import("firebase-admin/firestore");
    const { getStorage } = await import("firebase-admin/storage");
    initializeApp({
      credential: applicationDefault(),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    });
    bucket = getStorage().bucket();
    const logoWarnings = await migrateLogos(exportFolder, businesses, targetUid, bucket, true);
    warnings.push(...logoWarnings);
    const db = getFirestore();
    for (const tableName of collectionNames) {
      const rows = tableName === "businesses" ? businesses : records[tableName];
      for (let offset = 0; offset < rows.length; offset += 450) {
        const batch = db.batch();
        rows.slice(offset, offset + 450).forEach((row) => {
          const { original_user_id: _sourceUid, ...record } = row;
          batch.set(db.collection(tableName).doc(record.id), record);
        });
        await batch.commit();
      }
    }
  } else {
    warnings.push(...await migrateLogos(exportFolder, businesses, targetUid, null, false));
  }

  console.log(`${apply ? "Imported" : "Validated"} Supabase export for Firebase UID ${targetUid}:`);
  for (const tableName of collectionNames) console.log(`  ${tableName}: ${records[tableName].length}`);
  console.log(`  logo files: ${businesses.filter((business) => business.logo_path).length}`);
  if (!apply) console.log("No Firebase writes were made. Add --apply after reviewing the counts and warnings.");
  for (const warning of warnings) console.warn(`WARNING: ${warning}`);
}

main().catch((error) => {
  console.error(`Migration failed: ${error.message}`);
  process.exitCode = 1;
});
