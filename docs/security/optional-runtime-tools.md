# Optional final-image diagnostic tools

Issue #3080 removes only `/usr/bin/infocmp` and `/usr/bin/nsenter` from the final
standard and prebuilt container images. The complete builder is retained.
Application handlers, package versions, npm/npx features, other commands,
terminal databases and shared libraries are unchanged by this patch.

No explicit requirement or caller was found in the reviewed public deployment,
recovery and integration documentation, README files, application source,
scripts or integration tests. The reviewed deployment controller, private
restore reader/launcher and native qualification driver also do not invoke
these tools. Host-side Docker/Podman commands are separate from executable
paths inside the application container. This bounded check does not cover
external custom scripts or promise arbitrary interactive diagnostic tools.

The build checks both fixed paths before deleting either: regular files,
root UID/GID, mode 0755, one hardlink, and exactly one entry in their root-owned
mode-0644 dpkg ownership lists (`ncurses-bin` and `util-linux`). Changed layouts,
ownership or aliases refuse the build. The guards use no architecture-specific
binary digest. They run only in the final stages; no package purge or runtime
network access is added. A failed removal fails the image build and does not
claim that an interrupted removal was rolled back.

The offline tests use real owned temporary filesystem fixtures for type, mode,
link count, file contents and removal, with explicitly modeled image-root
ownership on unprivileged hosts. They cover preservation and refusal before
deletion, including a second-tool failure, symlink/hardlink aliases, changed
ownership, mode and package lists. The normal AMD64 and ARM64 Docker workflow
runs these tests. They do not replace actual image qualification.

Actual final-image qualification must verify both paths absent, while the
builder retains them, and retain `tput`/terminfo, other commands and libraries.
The coordinated native qualification must retain the existing npm/npx consumer,
Argon2, migration/default-startup, private drain/restart and recovery contracts.
No independent image build or deployment is claimed by the source tests.

This removes the final-filesystem executable paths for the `infocmp` analysis
issue CVE-2025-69720 and `nsenter --join-cgroup` issue CVE-2026-78408. It does not
fix the other mount/libmount issues or every finding against either source
package. Package metadata and raw scanner rows remain visible. Original base
layers still contain the binaries; no all-layer absence or clean audit is
claimed. Function-scoped disposition requires the actual final-image evidence.
