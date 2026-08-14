import assert from "node:assert/strict";
import test from "node:test";
import { clientIp, hashActor } from "../server/client-identity.mjs";

function request(remoteAddress, forwarded) {
  return { socket: { remoteAddress }, headers: forwarded ? { "x-forwarded-for": forwarded } : {} };
}

test("untrusted peers cannot spoof X-Forwarded-For", () => {
  assert.equal(clientIp(request("198.51.100.10", "203.0.113.4")), "198.51.100.10");
});

test("trusted reverse proxy chain yields the nearest untrusted client", () => {
  assert.equal(clientIp(request("127.0.0.1", "203.0.113.4, 127.0.0.1")), "203.0.113.4");
});

test("actor hashing is secret-bound and does not expose the address", () => {
  const value = hashActor("203.0.113.4", "server-secret-that-is-long-enough");
  assert.match(value, /^[0-9a-f]{32}$/);
  assert.equal(value.includes("203.0.113.4"), false);
  assert.notEqual(value, hashActor("203.0.113.4", "different-secret-that-is-long-enough"));
});

test("invalid forwarded hops fail closed and IPv6/CIDR chains canonicalize", () => {
  const env = { TRUSTED_PROXIES: "127.0.0.1/32,2001:db8:abcd::/48" };
  assert.equal(clientIp(request("127.0.0.1", "203.0.113.9, forged-hop"), env), "127.0.0.1");
  assert.equal(clientIp(request("2001:0db8:abcd:0::1", "2001:db8:ffff::8, 2001:db8:abcd::2"), env), "2001:db8:ffff::8");
  assert.throws(() => clientIp(request("127.0.0.1"), { NODE_ENV: "production" }), /TRUSTED_PROXIES/);
});
