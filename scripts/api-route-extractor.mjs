const HTTP_METHOD = "GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|CONNECT|TRACE";
const methodPattern = new RegExp(`req\\.method\\s*===\\s*["'](${HTTP_METHOD})["']`, "g");
const exactPathPattern = /url\.pathname\s*===\s*["']([^"'?]+)["']/g;

export function normalizeRoute(method, routePath) {
  return `${method.toUpperCase()} ${routePath.replace(/:[A-Za-z][A-Za-z0-9_]*/g, ":param")}`;
}

function methodsIn(text) {
  return [...text.matchAll(methodPattern)].map((match) => match[1]);
}

function ifConditions(source) {
  const conditions = [];
  const marker = /\bif\s*\(/g;
  for (let match; (match = marker.exec(source));) {
    const start = source.indexOf("(", match.index);
    let depth = 0;
    let quote = "";
    let escaped = false;
    let end = -1;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = "";
        continue;
      }
      if (character === '"' || character === "'" || character === "`") {
        quote = character;
        continue;
      }
      if (character === "(") depth += 1;
      else if (character === ")" && --depth === 0) {
        end = index;
        break;
      }
    }
    if (end === -1) throw new Error(`Unterminated if-condition near source offset ${match.index}.`);
    conditions.push({ text: source.slice(start + 1, end), offset: match.index });
    marker.lastIndex = end + 1;
  }
  return conditions;
}

function regexLiteralToRoute(literal) {
  const match = literal.match(/^\/\^(.+)\$\/[dgimsuvy]*$/);
  if (!match) throw new Error(`Unsupported route regex literal: ${literal}`);
  const routePath = match[1]
    .replaceAll("\\/", "/")
    .replace(/\(\?<[^>]+>\[\^\/\]\+\??\)/g, ":param")
    .replace(/\(\[\^\/\]\+\??\)/g, ":param");
  if (!routePath.startsWith("/") || /[()[\]{}*+?|]/.test(routePath)) {
    throw new Error(`Route regex cannot be represented as a documented path: ${literal}`);
  }
  return routePath;
}

export function sourceRoutes(source) {
  const routes = new Set();
  for (const condition of ifConditions(source)) {
    if (!condition.text.includes("req.method") || !condition.text.includes("url.pathname")) continue;
    const methods = methodsIn(condition.text);
    const exactPaths = [...condition.text.matchAll(exactPathPattern)].map((match) => match[1]);
    const listedPaths = [];
    for (const includes of condition.text.matchAll(/\[([^\]]+)]\.includes\(url\.pathname\)/g)) {
      listedPaths.push(...[...includes[1].matchAll(/["']([^"']+)["']/g)].map((match) => match[1]));
    }
    const paths = [...exactPaths, ...listedPaths];
    if (!methods.length || !paths.length) {
      throw new Error(`Unsupported req.method/url.pathname route candidate near source offset ${condition.offset}.`);
    }
    for (const method of methods) for (const routePath of paths) routes.add(normalizeRoute(method, routePath));
  }

  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.includes("url.pathname.match(")) continue;
    const dynamic = line.match(/(?:let|const|var)?\s*([A-Za-z_$][\w$]*)\s*=\s*url\.pathname\.match\((\/\^.*\$\/[dgimsuvy]*)\)/);
    if (!dynamic) throw new Error(`Unsupported url.pathname.match route candidate on source line ${index + 1}.`);
    const variablePattern = new RegExp(`\\b${dynamic[1].replaceAll("$", "\\$")}\\b`);
    let guard = "";
    for (let guardIndex = index + 1; guardIndex < Math.min(lines.length, index + 8); guardIndex += 1) {
      if (lines[guardIndex].includes("url.pathname.match(")) break;
      if (variablePattern.test(lines[guardIndex]) && methodsIn(lines[guardIndex]).length) {
        guard = lines[guardIndex];
        break;
      }
    }
    const dynamicMethods = methodsIn(guard);
    if (!dynamicMethods.length) throw new Error(`No HTTP method guard found for route regex on source line ${index + 1}.`);
    const routePath = regexLiteralToRoute(dynamic[2]);
    for (const method of dynamicMethods) routes.add(normalizeRoute(method, routePath));
  }
  return routes;
}

export function documentedRoutes(markdown) {
  const registry = markdown.match(/<!-- api-route-registry:start -->([\s\S]*?)<!-- api-route-registry:end -->/)?.[1];
  if (!registry) throw new Error("API documentation is missing the route-registry markers.");
  const routes = new Set();
  const registryPattern = new RegExp("^\\|\\s*`(" + HTTP_METHOD + ")`\\s*\\|\\s*`([^`]+)`\\s*\\|", "gm");
  for (const match of registry.matchAll(registryPattern)) routes.add(normalizeRoute(match[1], match[2]));
  return routes;
}
