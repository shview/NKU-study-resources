import { createHmac } from "node:crypto";
import net from "node:net";

export function normalizeIp(value = "") {
  let address = String(value).trim();
  if (address.startsWith("[") && address.endsWith("]")) address = address.slice(1, -1);
  const zone = address.indexOf("%");
  if (zone !== -1) address = address.slice(0, zone);
  if (address.toLowerCase().startsWith("::ffff:")) {
    const mapped = address.slice(7);
    if (net.isIP(mapped) === 4) return mapped.split(".").map(Number).join(".");
  }
  const version = net.isIP(address);
  if (!version) return "";
  if (version === 4) return address.split(".").map(Number).join(".");
  const host = new URL(`http://[${address}]/`).hostname;
  return host.slice(1, -1).toLowerCase();
}

function ipBigInt(address) {
  const normalized = normalizeIp(address);
  const version = net.isIP(normalized);
  if (version === 4) return { version, bits: 32, value: normalized.split(".").reduce((result, part) => (result << 8n) | BigInt(part), 0n) };
  if (version !== 6) return null;
  const [leftText, rightText = ""] = normalized.split("::");
  const left = leftText ? leftText.split(":") : [];
  const right = rightText ? rightText.split(":") : [];
  const parts = normalized.includes("::") ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  if (parts.length !== 8) return null;
  return { version, bits: 128, value: parts.reduce((result, part) => (result << 16n) | BigInt(`0x${part || "0"}`), 0n) };
}

function parseProxyRule(value) {
  const [addressText, prefixText] = String(value).trim().split("/");
  const parsed = ipBigInt(addressText);
  if (!parsed) throw new Error(`Invalid trusted proxy address: ${value}`);
  const prefix = prefixText === undefined ? parsed.bits : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > parsed.bits) throw new Error(`Invalid trusted proxy CIDR: ${value}`);
  if ((parsed.version === 4 && prefix < 8) || (parsed.version === 6 && prefix < 32)) throw new Error(`Trusted proxy CIDR is too broad: ${value}`);
  const shift = BigInt(parsed.bits - prefix);
  return { version: parsed.version, prefix, network: (parsed.value >> shift) << shift };
}

export function trustedProxyRules(env = process.env) {
  const configured = String(env.TRUSTED_PROXIES || env.TRUSTED_PROXY_ADDRESSES || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (env.NODE_ENV === "production" && !configured.length) throw new Error("TRUSTED_PROXIES must be explicitly configured in production.");
  const values = configured.length ? configured : ["127.0.0.1/32", "::1/128"];
  return values.map(parseProxyRule);
}

function matchesRule(address, rule) {
  const parsed = ipBigInt(address);
  if (!parsed || parsed.version !== rule.version) return false;
  const shift = BigInt(parsed.bits - rule.prefix);
  return ((parsed.value >> shift) << shift) === rule.network;
}

export function clientIp(req, env = process.env) {
  const remote = normalizeIp(req.socket?.remoteAddress || "");
  if (!remote) return "unknown";
  const trusted = trustedProxyRules(env);
  if (!trusted.some((rule) => matchesRule(remote, rule))) return remote;

  const forwarded = req.headers?.["x-forwarded-for"];
  if (typeof forwarded !== "string" || !forwarded.trim()) return remote;
  const rawChain = forwarded.split(",").map((item) => item.trim()).filter(Boolean);
  if (!rawChain.length || rawChain.length > 16) return remote;
  const chain = rawChain.map(normalizeIp);
  if (chain.some((address) => !address)) return remote;
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    if (!trusted.some((rule) => matchesRule(chain[index], rule))) return chain[index];
  }
  return chain[0] || remote;
}

export function hashActor(value, secret, length = 32) {
  if (!secret || String(secret).length < 16) throw new Error("A strong server-side HMAC secret is required to hash rate-limit actors.");
  if (!Number.isSafeInteger(length) || length < 16 || length > 64) throw new Error("Actor hash length must be between 16 and 64.");
  return createHmac("sha256", secret).update(String(value)).digest("hex").slice(0, length);
}
