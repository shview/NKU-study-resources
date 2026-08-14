import { createHash } from "node:crypto";

export function manifestRevision(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class ManifestConflictError extends Error {
  constructor(message, currentRevision) {
    super(message);
    this.name = "ManifestConflictError";
    this.statusCode = 409;
    this.currentRevision = currentRevision;
  }
}
