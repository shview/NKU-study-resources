export function findReplacementCharacters(value, currentPath = "$", output = []) {
  if (typeof value === "string") {
    if (value.includes("\uFFFD")) output.push(currentPath);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => findReplacementCharacters(item, `${currentPath}[${index}]`, output));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) findReplacementCharacters(item, `${currentPath}.${key}`, output);
  }
  return output;
}

export function assertNoReplacementCharacters(value, label = "JSON data") {
  const paths = findReplacementCharacters(value);
  if (!paths.length) return;
  const preview = paths.slice(0, 10).join(", ");
  const suffix = paths.length > 10 ? ` and ${paths.length - 10} more` : "";
  throw Object.assign(new Error(`${label} contains Unicode replacement character U+FFFD at ${preview}${suffix}. Correct the source encoding instead of publishing replacement characters.`), {
    statusCode: 400,
    replacementCharacterPaths: paths,
  });
}

export function decodeUtf8Strict(bytes, label = "Input") {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw Object.assign(new Error(`${label} must be valid UTF-8.`), { statusCode: 400 });
  }
}
