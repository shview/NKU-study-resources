export function responseWarnings(data) {
  return [data?.warnings, data?.cleanupWarnings]
    .flatMap((warnings) => Array.isArray(warnings) ? warnings : [])
    .filter((warning) => typeof warning === "string" && warning);
}

export function statusWithWarnings(message, data) {
  const warnings = responseWarnings(data);
  return warnings.length ? `${message}；警告：${warnings.join("；")}` : message;
}
