import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeStore,
  openStore,
  type Store,
} from "../../src/server/storage/database.js";

export interface TestStore {
  store: Store;
  dataDir: string;
  dispose(): Promise<void>;
}

export async function createTestStore(): Promise<TestStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "ibkr-journal-test-"));
  let store: Store;
  try {
    store = openStore(dataDir);
  } catch (error) {
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }

  let disposed = false;
  return {
    store,
    dataDir,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await closeStore(store);
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
