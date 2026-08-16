import { assertNoReplacementCharacters, decodeUtf8Strict } from "./text-integrity.mjs";

export const MAX_BODY_BYTES = 2_000_000;

function requestError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

export function readJsonBody(req, { maxBytes = MAX_BODY_BYTES, rejectReplacementCharacters = false } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let byteLength = 0;
    let settled = false;

    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
    };
    const fail = (error, { destroy = false } = {}) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
      if (destroy && !req.destroyed) req.destroy();
    };
    const onData = (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += bytes.length;
      if (byteLength > maxBytes) {
        fail(requestError("Request body is too large.", 413), { destroy: true });
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        const bytes = Buffer.concat(chunks, byteLength);
        const body = decodeUtf8Strict(bytes, "Request body");
        const parsed = body ? JSON.parse(body) : {};
        if (rejectReplacementCharacters) assertNoReplacementCharacters(parsed, "Request body");
        resolve(parsed);
      } catch (error) {
        if (error.statusCode) reject(error);
        else reject(requestError("Invalid JSON request body.", 400));
      }
    };
    const onError = (error) => fail(error);
    const onAborted = () => fail(requestError("Request body was aborted.", 400));

    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
  });
}
