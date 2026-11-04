import { initializeApp } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  getFirestore,
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";
import {
  getDownloadURL,
  getStorage,
  ref,
  uploadBytes,
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-storage.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-functions.js";
import { firebaseConfig } from "./config.js";

const requiredConfig = ["apiKey", "authDomain", "projectId", "storageBucket", "messagingSenderId", "appId"];
export const isFirebaseConfigured = requiredConfig.every((key) => Boolean(firebaseConfig[key]));

const app = isFirebaseConfigured ? initializeApp(firebaseConfig) : null;
export const auth = app ? getAuth(app) : null;
export const db = app ? getFirestore(app) : null;
export const storage = app ? getStorage(app) : null;
export const functions = app ? getFunctions(app) : null;

const protectedCollections = new Set(["businesses", "clients", "products", "invoices", "invoice_payments"]);

function assertCollection(name) {
  if (!protectedCollections.has(name)) throw new Error(`Unknown workspace collection: ${name}`);
  if (!auth?.currentUser || !db) throw new Error("Please sign in before accessing the workspace.");
}

function recordRef(name, id) {
  assertCollection(name);
  return doc(db, name, id);
}

async function getOwnedRecords(name) {
  assertCollection(name);
  const result = await getDocs(query(collection(db, name), where("user_id", "==", auth.currentUser.uid)));
  return result.docs.map((snapshot) => ({ id: snapshot.id, ...snapshot.data() }));
}

export async function loadWorkspaceRecords() {
  const names = [...protectedCollections];
  const records = await Promise.all(names.map(async (name) => [name, await getOwnedRecords(name)]));
  return Object.fromEntries(records);
}

export async function saveRecord(name, values, id = crypto.randomUUID()) {
  const reference = recordRef(name, id);
  const prior = await getDoc(reference);
  if (prior.exists() && prior.data().user_id !== auth.currentUser.uid) {
    throw new Error("This record is not available in your account.");
  }
  const now = new Date().toISOString();
  const data = {
    ...(prior.exists() ? prior.data() : {}),
    ...values,
    id,
    user_id: auth.currentUser.uid,
    created_at: prior.exists() ? prior.data().created_at || now : values.created_at || now,
    updated_at: now,
  };
  await setDoc(reference, data);
  return data;
}

async function deleteInChunks(records) {
  for (let offset = 0; offset < records.length; offset += 450) {
    const batch = writeBatch(db);
    records.slice(offset, offset + 450).forEach(({ collectionName, id }) => {
      batch.delete(recordRef(collectionName, id));
    });
    await batch.commit();
  }
}

export async function deleteRecord(name, id) {
  const reference = recordRef(name, id);
  const target = await getDoc(reference);
  if (!target.exists() || target.data().user_id !== auth.currentUser.uid) {
    throw new Error("The record was not found or is no longer accessible.");
  }

  if (name === "businesses") {
    const related = await loadWorkspaceRecords();
    const businessInvoices = related.invoices.filter((invoice) => invoice.business_id === id);
    const invoiceIds = new Set(businessInvoices.map((invoice) => invoice.id));
    const payments = related.invoice_payments.filter((payment) => invoiceIds.has(payment.invoice_id));
    const clients = related.clients.filter((client) => client.business_id === id);
    const products = related.products.filter((product) => product.business_id === id);
    const children = [
      ...payments.map((record) => ({ collectionName: "invoice_payments", id: record.id })),
      ...businessInvoices.map((record) => ({ collectionName: "invoices", id: record.id })),
      ...clients.map((record) => ({ collectionName: "clients", id: record.id })),
      ...products.map((record) => ({ collectionName: "products", id: record.id })),
    ];
    if (target.data().logo_path) {
      await deleteObject(ref(storage, target.data().logo_path));
    }
    await deleteInChunks(children);
  } else if (name === "invoices") {
    const payments = (await getOwnedRecords("invoice_payments")).filter((payment) => payment.invoice_id === id);
    await deleteInChunks(payments.map((payment) => ({ collectionName: "invoice_payments", id: payment.id })));
  } else if (name === "clients") {
    const linkedInvoices = (await getOwnedRecords("invoices")).filter((invoice) => invoice.client_id === id);
    for (const invoice of linkedInvoices) {
      await updateDoc(recordRef("invoices", invoice.id), { client_id: null, updated_at: new Date().toISOString() });
    }
  }

  await deleteDoc(reference);
}

export function uploadBusinessLogo(path, file) {
  if (!auth?.currentUser || !storage) throw new Error("Please sign in before uploading a business logo.");
  return uploadBytes(ref(storage, path), file, { contentType: file.type });
}

export function getBusinessLogoUrl(path) {
  if (!storage) throw new Error("Firebase Storage is not configured.");
  return getDownloadURL(ref(storage, path));
}

export function sendDocumentEmail(invoiceId) {
  if (!functions) throw new Error("Firebase Functions is not configured.");
  return httpsCallable(functions, "sendDocumentEmail")({ invoice_id: invoiceId });
}

export {
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
};
