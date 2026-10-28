export type TranscriptSegment = {
  offset: number;
  text: string;
  words: { word: string; start: number; end: number; speaker?: string | number }[];
};

export type TranscriptionVerification = {
  recordingSha256: string;
  audioDurationSeconds: number;
  meanVolumeDb: number | null;
  peakVolumeDb: number | null;
  requestedModel: string;
  returnedModels: string[];
  endpointHost: string;
  responseIds: string[];
  chunkCount: number;
};

export type BrowserRecording = {
  id: string;
  channel: string;
  createdAt: number;
  blob: Blob;
  segments?: TranscriptSegment[];
  verification?: TranscriptionVerification;
};

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("agora-classroom-recordings", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("recordings", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function operation<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("recordings", mode);
    const request = run(transaction.objectStore("recordings"));
    let value!: T;
    request.onsuccess = () => { value = request.result; };
    transaction.oncomplete = () => { db.close(); resolve(value); };
    transaction.onabort = () => { db.close(); reject(transaction.error ?? request.error); };
    transaction.onerror = () => { db.close(); reject(transaction.error ?? request.error); };
  });
}

export function saveRecording(recording: BrowserRecording): Promise<IDBValidKey> {
  return operation("readwrite", (store) => store.put(recording));
}

export function getRecording(id: string): Promise<BrowserRecording | undefined> {
  return operation("readonly", (store) => store.get(id));
}

export async function listRecordings(): Promise<BrowserRecording[]> {
  const recordings = await operation<BrowserRecording[]>("readonly", (store) => store.getAll());
  return recordings.sort((a, b) => b.createdAt - a.createdAt);
}
