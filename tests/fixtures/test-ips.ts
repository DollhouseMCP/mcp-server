/**
 * Shared IP literals for tests.
 *
 * Tests in this repo need predictable IPs to assert rate-limit bucket keys,
 * client-identity derivation, and proxy-trust resolution. Routing them
 * through this fixture module collapses dozens of inline literals to a
 * single declaration site, and gives each IP a name that conveys its
 * *role* in the test (the primary client, the attacker, the proxy peer)
 * instead of just its octets.
 *
 * All addresses are drawn from RFC 5737 documentation-reserved ranges
 * (TEST-NET-1 192.0.2.0/24, TEST-NET-2 198.51.100.0/24, TEST-NET-3
 * 203.0.113.0/24). These blocks are reserved for use in examples and
 * specifications and are unroutable on the public internet; Sonar's
 * S1313 ("hardcoded IP") carveout recognises them, so this file produces
 * no findings.
 *
 * NOTE: Tests that need IPs as *test cases* — e.g. exercising an SSRF URL
 * validator across loopback/RFC1918/link-local categories — are better off
 * keeping the IPs inline so the test reads as "for each category…".
 */

// Numbered clients, used as interchangeable identities in rate-limit and
// per-IP bucketing tests. Names communicate "this is client N" — the octets
// don't matter beyond being distinct.
export const CLIENT_PRIMARY = '192.0.2.1';
export const CLIENT_SECONDARY = '192.0.2.2';
export const CLIENT_TERTIARY = '192.0.2.3';

// Saturation/drain trigger clients. Used in tests that walk a rate-limit
// bucket to capacity and verify drain behavior under load.
export const CLIENT_SATURATION_A = '192.0.2.10';
export const CLIENT_SATURATION_B = '192.0.2.11';
export const CLIENT_DRAIN_TRIGGER = '192.0.2.42';

// Distinct attacker IP. Used to assert that one client's failures don't
// bleed into another's bucket.
export const CLIENT_ATTACKER = '192.0.2.99';

// Generic single-client IP used when a test only needs *one* IP and the
// per-IP namespacing doesn't matter. Drawn from TEST-NET-3 (different
// block from the CLIENT_* set) so it can't accidentally collide with a
// per-client assertion.
export const CLIENT_GENERIC = '203.0.113.250';

// Public-internet-shaped client IPs used in client-key derivation tests
// where the IP needs to look like a normal external address — kept in
// TEST-NET-3 alongside CLIENT_GENERIC but at low octets so the values
// remain visually distinct.
export const PUBLIC_CLIENT_A = '203.0.113.5';
export const PUBLIC_CLIENT_B = '203.0.113.42';

// Spoofed forwarded-for value from a client that doesn't own a trusted
// proxy. The test asserts the server ignores this header value and uses
// the real socket peer instead. Drawn from TEST-NET-2 so it's visually
// distinct from the CLIENT_* and PUBLIC_CLIENT_* sets.
export const XFF_SPOOF = '198.51.100.4';

// Multi-hop X-Forwarded-For chain used to verify the server ignores the
// entire header (not just the first hop) when trust-proxy is not configured.
// Treated as one opaque string — the individual hops have no semantic role
// beyond "additional entries in a chain that should be ignored together".
export const XFF_SPOOF_CHAIN = '198.51.100.4, 198.51.100.8, 198.51.100.12';

// TCP socket peer in spoof-resistance tests — distinct from CLIENT_*
// values so a test that asserts "we used the TCP peer, not the header"
// reads unambiguously.
export const TCP_PEER = '198.51.100.99';
