/**
 * Orders destructive object-store work so the currently published manifest
 * never references deleted keys. Preparation may leave verified orphan copies;
 * cleanup failure leaves only unreferenced old objects.
 */
export async function publishAfterR2Prepare({ prepare, publish, cleanup }) {
  const prepared = await prepare();
  const published = await publish(prepared);
  const cleanupWarnings = [];
  try {
    await cleanup(prepared, published);
  } catch (error) {
    cleanupWarnings.push(`Manifest published safely, but old R2 objects require later cleanup: ${error.message}`);
  }
  return { ...published, cleanupWarnings };
}

export class R2MutationQueue {
  constructor() {
    this.queue = Promise.resolve();
  }

  enqueue(operation) {
    const current = this.queue.catch(() => {}).then(operation);
    this.queue = current;
    return current;
  }
}

export function runExclusiveR2Mutation({ queue, mutate }) {
  if (!queue || typeof mutate !== "function") {
    throw new Error("Exclusive R2 mutation requires queue and mutate.");
  }
  return queue.enqueue(mutate);
}

/** Revision checking must occur after entering this queue, before any R2 read/write. */
export function runSerializedR2Mutation({ queue, expectedRevision, readCurrent, mutate }) {
  if (!queue || typeof readCurrent !== "function" || typeof mutate !== "function") {
    throw new Error("Serialized R2 mutation requires queue, readCurrent and mutate.");
  }
  return runExclusiveR2Mutation({ queue, mutate: async () => {
    const current = await readCurrent();
    if (current.revision !== expectedRevision) {
      const error = new Error("Manifest changed before the R2 transaction began; no R2 objects were changed.");
      error.statusCode = 409;
      error.currentRevision = current.revision;
      throw error;
    }
    return mutate(current);
  } });
}
