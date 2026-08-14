export const MAX_BODY_BYTES = 2_000_000;

function requestError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

export function readJsonBody(req, { maxBytes = MAX_BODY_BYTES } = {}) {
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
        const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        const message = error instanceof SyntaxError ? "Invalid JSON request body." : "Request body must be valid UTF-8.";
        reject(requestError(message, 400));
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
