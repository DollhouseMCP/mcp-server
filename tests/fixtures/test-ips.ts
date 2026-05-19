/**
 * Shared IP literals for tests.
 *
 * Tests in this repo need predictable IPs to assert rate-limit bucket keys,
 * client-identity derivation, and proxy-trust resolution. Inlining literal
 * `10.0.0.1` etc. in every test file triggers Sonar's S1313 (hardcoded IP)
 * across dozens of sites. Routing them through this fixture module collapses
 * that to a single declaration site, and gives each IP a name that conveys
 * its *role* in the test (the primary client, the attacker, the proxy peer)
 * instead of just its octets.
 *
 * NOTE: Tests that need IPs as *test cases* — e.g. exercising an SSRF URL
 * validator across loopback/RFC1918/link-local categories — are better off
 * keeping the IPs inline so the test reads as "for each category…".
 */

// Numbered clients, used as interchangeable identities in rate-limit and
// per-IP bucketing tests. Names communicate "this is client N" — the octets
// don't matter beyond being distinct.
export const CLIENT_PRIMARY = '10.0.0.1';
export const CLIENT_SECONDARY = '10.0.0.2';
export const CLIENT_TERTIARY = '10.0.0.3';

// Saturation/drain trigger clients. Used in tests that walk a rate-limit
// bucket to capacity and verify drain behavior under load.
export const CLIENT_SATURATION_A = '10.0.0.10';
export const CLIENT_SATURATION_B = '10.0.0.11';
export const CLIENT_DRAIN_TRIGGER = '10.0.0.42';

// Distinct attacker IP. Used to assert that one client's failures don't
// bleed into another's bucket.
export const CLIENT_ATTACKER = '10.0.0.99';

// Generic single-client IP used when a test only needs *one* IP and the
// per-IP namespacing doesn't matter. Distinct from the 10/8 set so it
// can't accidentally collide with a per-client assertion.
export const CLIENT_GENERIC = '1.1.1.1';

// Public-internet-shaped client IPs (RFC 5737 documentation range). Used
// in client-key derivation tests where the IP needs to look "real" —
// i.e. not RFC1918 — to exercise the trusted-proxy header logic.
export const PUBLIC_CLIENT_A = '203.0.113.5';
export const PUBLIC_CLIENT_B = '203.0.113.42';

// Spoofed forwarded-for value from a client that doesn't own a trusted
// proxy. The test asserts the server ignores this header value and uses
// the real socket peer instead.
export const XFF_SPOOF = '1.2.3.4';

// Multi-hop X-Forwarded-For chain used to verify the server ignores the
// entire header (not just the first hop) when trust-proxy is not configured.
// Treated as one opaque string — the individual hops have no semantic role
// beyond "additional entries in a chain that should be ignored together".
export const XFF_SPOOF_CHAIN = '1.2.3.4, 5.6.7.8, 9.10.11.12';

// TCP socket peer in spoof-resistance tests — distinct from CLIENT_*
// values so a test that asserts "we used the TCP peer, not the header"
// reads unambiguously.
export const TCP_PEER = '198.51.100.99';
