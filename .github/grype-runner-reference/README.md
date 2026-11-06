These are raw public registry documents for the independent scanner execution base already pinned in protected beta `88efb60c` (`docker/Dockerfile:5`). They are data, not a replacement image choice.

- Immutable Node index: `sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66` (`index.json`).
- Linux/amd64 child manifest: `sha256:c83040f7e24bacea68e58a0b96a484ba430bf24abb2973eab7ba4701144b7b63` (`linux-amd64-manifest.json`).
- Child config: `sha256:04f59b17d8d39a8fdeb138fecb8fcbaa6e208ed7b6db929c7e98ad9005e0a52f`.

The scanner hashes both documents, checks their index → platform manifest → config relationship, and verifies the local export's selected graph and ordered layer diffIDs. The image being scanned is mounted only as archive data. A store image ID, OCI manifest/index digest, and config digest have separate roles; Grype's archive source ID is the config digest.

The container is created with the exact immutable Node reference. Inspection must report that reference in `Config.Image`, the verified local store ID in `Image`, and (for OCI stores) the exact verified selected manifest descriptor. The engine source matching the observed Docker 29.4.2 server commit `d3298094ac5111e5d67517a252d291d27543e408` establishes this chain: `daemon/containerd/image.go` assigns `GetImage`'s ID from `img.Target.Digest`; `daemon/create.go` passes `img.ID()` to `newContainer`; `daemon/container.go` stores it in `ImageID`; `daemon/inspect.go` emits that ID and the selected `ImageManifestDescriptor`.

Image size admission hashes and counts layer streams without extraction; Docker `inspect.Size` is retained only as an observation. Docker's containerd store retains compressed content and unpacked snapshots separately (https://docs.docker.com/engine/storage/containerd/; https://github.com/moby/moby/pull/53426).

This identity reference does not claim vulnerability clearance or successful runtime qualification of the scanner/base. Those remain separate gates.
