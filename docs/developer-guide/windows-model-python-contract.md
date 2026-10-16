# Windows CI Python dependency for the graceful-stop model

Issue #3111 makes interpreter selection explicit for the deterministic
`hostedGracefulStopPolling` fixture. It does not identify or repair the cause of
previous Python launch timeouts.

Windows CI declares `DOLLHOUSE_MODEL_PYTHON_CONTRACT=github-cache-cpython-3.12.10-x64`.
The test accepts only GitHub Actions with `CI=true`, an x64 Node process, and a
canonical drive-absolute Windows `RUNNER_TOOL_CACHE` root. It derives only
`Python\3.12.10\x64\python.exe` beneath that root. It accepts no executable-path
override. Missing or invalid configuration fails before spawn; an unavailable
cached executable fails the original returned-error assertion. There is no
ambient fallback, filesystem preflight, download, version probe, warmup, PATH
change, new action or retry. Default local Windows uses `python`; non-Windows
continues to use `python3`.

The cache-root trust comes from the GitHub runner and repository-owned workflow,
not from lexical validation. Validation rejects relative, noncanonical, escaped,
UNC/device, alternate-stream and reserved-component spellings. It does not
attest physical binaries or resolve junctions/reparse points. Existing native
error assertions can display the runner-owned cache command path; no arbitrary
private caller path is introduced.

The exact captured [Windows image inventory](https://github.com/actions/runner-images/blob/win25-vs2026/20261007.264/images/windows/Windows2025-VS2026-Readme.md)
lists 3.12.10 as installed and cached. The [hosted-cache documentation](https://github.com/actions/setup-python/blob/ece7cb06caefa5fff74198d8649806c4678c61a1/docs/advanced-usage.md#hosted-tool-cache)
and [Windows cache finder](https://github.com/actions/setup-python/blob/ece7cb06caefa5fff74198d8649806c4678c61a1/src/find-python.ts)
bind the provider root and version/architecture/executable layout. These are
source references, not adoption of that action or attestation of a failed child.
Image rotation that removes the exact version or changes the layout intentionally
fails qualification; updating this dependency requires an explicit reviewed
change, never an automatic version substitution.

Core's two ordinary shards, Extended's ordinary matrix, and Cross-Platform
Simple's unfiltered unit command declare the contract. Their events, selections,
matrices, outcomes, guards and job limits are unchanged. The latter remains a
manual/main workflow with its existing ten-minute limit; Core/Extended keep
fifteen minutes. Other Python fixtures and performance-only selection are not
retargeted.

The model still runs one child, with the same two arguments, 5,000 ms total
`spawnSync` timeout, 64 KiB output bound, eleven methods and 43 actual-helper
executions. All nonce, authority, inspection-count and fake-clock deadline
proofs remain required. This five-second condition covers the complete Python
process lifecycle; it is separate from the simulated product deadline. A timeout
still fails. Explicit selection does not prove better startup latency or a cure.
No native image input or operational runtime policy changes here.
