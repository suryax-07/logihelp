import type { Connection } from "../shared/types";

const databaseName = "logihelp-workspace";
const storeName = "data";
const connectionsKey = "connections";
const legacyStorageKey = "logihelp-connections-v1";

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("This browser does not support IndexedDB storage."));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(storeName, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open browser storage."));
    request.onblocked = () => reject(new Error("Browser storage upgrade is blocked by another open tab."));
  });
}

export async function loadConnections(): Promise<Connection[]> {
  const database = await openDatabase();
  try {
    const saved = await new Promise<Connection[] | undefined>((resolve, reject) => {
      const request = database.transaction(storeName, "readonly").objectStore(storeName).get(connectionsKey);
      request.onsuccess = () => resolve(request.result?.connections as Connection[] | undefined);
      request.onerror = () => reject(request.error ?? new Error("Could not read saved connections."));
    });
    if (saved) return saved;

    const legacy = JSON.parse(localStorage.getItem(legacyStorageKey) ?? "[]") as Connection[];
    if (legacy.length) {
      await saveConnections(legacy);
      localStorage.removeItem(legacyStorageKey);
    }
    return legacy;
  } finally {
    database.close();
  }
}

export async function saveConnections(connections: Connection[]): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).put({ key: connectionsKey, connections });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not save connections to browser storage."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Saving connections to browser storage was aborted."));
    });
  } finally {
    database.close();
  }
}
