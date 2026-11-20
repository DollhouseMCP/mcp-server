The exact Google image is signed, and its embedded SPDX2.3 document passes the matching official JSON schema. The failed one-shot verification is caused by legacy string-predicate packaging and a Cosign3.1.3 compatibility-decoder bug, not an unsigned artifact or an unsupported SPDX2.3 schema. Full stock Cosign attestation verification still exits1; no success is invented.

Target: `gcr.io/distroless/nodejs24-debian13@sha256:b8cec4b2f2126ff7bd034ec9ac207ffb3272667dfdc48376e3b035d3270549ba`.

Tools actually used: Cosign v3.1.3, GitCommit11926fa5bbbbde47e88fc006b625a17769b743b2, Go1.26.4, darwin/arm64; binary SHA2565cf948c2f4dfe59687bdd0b8523709067383e03982cc543475c8a7dc70e92a76. Independent signature check: /usr/bin/openssl, LibreSSL3.3.6. Matching schema validator: existing Ajv6.14.0 on Nodev24.16.0, JSON Schema Draft07. No tools/packages were installed.

The unmodified signed DSSE payload is in-toto Statement/v0.1 with predicateType `https://spdx.dev/Document`; `predicate` is a JSON string containing SPDX-2.3,137packages. Cosign's v3.1.3 fallback explicitly supports string predicates but deserializes remaining header fields with encoding/json into protobuf fields tagged `type`/`predicate_type`; the actual signed `_type`/`predicateType` are lost. Matching therefore sees a blank predicate type. Its modern bundle decoder instead rejects the string where an object is expected. This is not a v0.1-v1 or SPDX2.3-v3.0 selection error. The legacy wrapper differs from canonical in-toto's object-shaped predicate; Cosign itself still generates/supports this legacy form.

Primary source: https://github.com/sigstore/cosign/blob/v3.1.3/pkg/cosign/attestation/attestation.go#L70-L99 ; generator#L422-L450 ; https://github.com/in-toto/attestation/blob/v1.2.0/go/v1/statement.pb.go#L31-L34 .

Original remote verification — exit 1

```sh
/private/tmp/beta3-minimal-runtime-evidence-20261108/cosign-darwin-arm64 verify-attestation --certificate-identity keyless@distroless.iam.gserviceaccount.com --certificate-oidc-issuer https://accounts.google.com --type https://spdx.dev/Document --output json gcr.io/distroless/nodejs24-debian13@sha256:b8cec4b2f2126ff7bd034ec9ac207ffb3272667dfdc48376e3b035d3270549ba
```

```text
Error: none of the attestations matched the predicate type: https://spdx.dev/Document, found:
error during command execution: none of the attestations matched the predicate type: https://spdx.dev/Document, found:
```

Explicit SPDX JSON alias — exit 1

```sh
/private/tmp/beta3-minimal-runtime-evidence-20261108/cosign-darwin-arm64 verify-attestation --certificate-identity keyless@distroless.iam.gserviceaccount.com --certificate-oidc-issuer https://accounts.google.com --type spdxjson --output json gcr.io/distroless/nodejs24-debian13@sha256:b8cec4b2f2126ff7bd034ec9ac207ffb3272667dfdc48376e3b035d3270549ba --timeout 60s
```

```text
Error: none of the attestations matched the predicate type: spdxjson, found:
error during command execution: none of the attestations matched the predicate type: spdxjson, found:
```

Modern bundle decoding — exit 1

```sh
/private/tmp/beta3-minimal-runtime-evidence-20261108/cosign-darwin-arm64 verify-blob-attestation --bundle /private/tmp/beta3-minimal-runtime-evidence-20261108/spdx.sigstore.json --certificate-identity keyless@distroless.iam.gserviceaccount.com --certificate-oidc-issuer https://accounts.google.com --type https://spdx.dev/Document --digest b8cec4b2f2126ff7bd034ec9ac207ffb3272667dfdc48376e3b035d3270549ba --digestAlg sha256 --timeout 60s
```

```text
Error: failed to verify signature: could not verify artifact: unable to extract statement from envelope: validation error: invalid attestation: decoding json
error during command execution: failed to verify signature: could not verify artifact: unable to extract statement from envelope: validation error: invalid attestation: decoding json
```

Legacy bundle: correct URI — exit 1

```sh
/private/tmp/beta3-minimal-runtime-evidence-20261108/cosign-darwin-arm64 verify-blob-attestation --bundle /private/tmp/beta3-minimal-runtime-evidence-20261108/legacy-spdx-complete-bundle.json --certificate-identity keyless@distroless.iam.gserviceaccount.com --certificate-oidc-issuer https://accounts.google.com --type https://spdx.dev/Document --digest b8cec4b2f2126ff7bd034ec9ac207ffb3272667dfdc48376e3b035d3270549ba --digestAlg sha256 --timeout 60s
```

```text
Error: invalid predicate type, expected https://spdx.dev/Document got
error during command execution: invalid predicate type, expected https://spdx.dev/Document got
```

Legacy bundle: spdx alias — exit 1

```sh
/private/tmp/beta3-minimal-runtime-evidence-20261108/cosign-darwin-arm64 verify-blob-attestation --bundle /private/tmp/beta3-minimal-runtime-evidence-20261108/legacy-spdx-complete-bundle.json --certificate-identity keyless@distroless.iam.gserviceaccount.com --certificate-oidc-issuer https://accounts.google.com --type spdx --digest b8cec4b2f2126ff7bd034ec9ac207ffb3272667dfdc48376e3b035d3270549ba --digestAlg sha256 --timeout 60s
```

```text
Error: invalid predicate type, expected spdx got
error during command execution: invalid predicate type, expected spdx got
```

Correct verification another way: the legacy bundle command passes Cosign's signature/certificate-identity/issuer/transparency and subject-digest verification before the later policy decoder fails. Tagged CLI source checks VerifyBlobAttestation and returns on error before policy matching (verify_blob_attestation.go395–406). Wrong-identity and wrong-digest controls reject earlier; the wrong-digest error is `no matching subject digest found`. This is stage-specific evidence, not a claim the whole CLI exited0.

Independent unmodified DSSE PAE signature check — exit0 `Verified OK`:

```sh
/usr/bin/openssl dgst -sha256 -verify /private/tmp/beta3-attestation-investigation-20261108/signer-public-key.pem -signature /private/tmp/beta3-attestation-investigation-20261108/dsse.signature.der /private/tmp/beta3-attestation-investigation-20261108/dsse.pae
```

OpenSSL alone proves signature/key correspondence; certificate trust, signer identity and exact subject binding are the separate Cosign checks above.

Original inner predicate decoded as data, without rewriting the signed envelope — official SPDX2.3 JSON-schema validation exit0, valid=true, errors=[]:

```sh
node /private/tmp/beta3-attestation-investigation-20261108/validate-spdx-2.3.cjs /private/tmp/beta3-attestation-investigation-20261108/official-spdx-2.3-schema.json /private/tmp/beta3-attestation-investigation-20261108/original-decoded-spdx.json
```

Schema: https://raw.githubusercontent.com/spdx/spdx-spec/v2.3/schemas/spdx-schema.json ; SHA256 `239208b7ac287b3cf5d9a9af23f9d69863971102a5e1587a27a398b43490b89b`. Original inner document SHA256 `a7a1eb2f57a31c20cbe28dff8c7f7dc696f8e9366ce932e0edaa7df5137356d9`. SPDX3.0 is not the declared format and is not the appropriate validator.

The separate checks authenticate the signed content and validate its SPDX2.3 JSON structure. They do not establish inventory completeness, correct source-to-binary provenance or an exception to adoption policy. A stock Cosign3.1.3 one-command verification remains unsuccessful. No original bytes were edited/re-signed, no trust-ignore flags were used, no registry writes were made, and nothing was merged or deployed. Exact argv/exits/stdout/stderr/source snapshots and hashes are retained beside this report.

Display copy removes only trailing spaces from four verbatim error lines; original report SHA-256 `42ec07ea71eb9cffa91611b4b485ee83d19364121c8947ee44aefcdc9322af06`, retained raw stderr and argv unchanged.
