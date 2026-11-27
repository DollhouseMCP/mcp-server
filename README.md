# KDialog headless runtime evidence for PR #3353

Reviewed head `7b31338da18552848f3cfdfd4708aa2e47cb7184`.

The review used synthetic action data. Each captured window came from an aarch64 Linux container running its own Xvfb display with TCP disabled. ImageMagick `import` captured the KDialog window before it closed. The review captures show the literal `<draft> & final`, preserved indentation, and the last-line marker `KDE-STDIN-3353` after rendering the escaped `<pre>` input. Pressing Enter on the unchanged final selection returned `cancel` in all five runs.

| Distribution | KDialog package | Source for stdin handling | Runtime capture |
| --- | --- | --- | --- |
| Ubuntu 22.04 LTS | `4:21.12.3-0ubuntu1` | [v21.12.3](https://github.com/KDE/kdialog/blob/v21.12.3/src/widgets.cpp#L92-L97) | [Review](ubuntu22/review.png), [default Cancel](ubuntu22/cancel-default.png), [stdin](ubuntu22/review-input.html) |
| Ubuntu 24.04 LTS | `4:23.08.5-0ubuntu4` | [v23.08.5](https://github.com/KDE/kdialog/blob/v23.08.5/src/widgets.cpp#L91-L96) | [Review](ubuntu24/review.png), [default Cancel](ubuntu24/cancel-default.png), [stdin](ubuntu24/review-input.html) |
| Ubuntu 26.04 LTS | `4:25.12.3-0ubuntu1` | [v25.12.3](https://github.com/KDE/kdialog/blob/v25.12.3/src/widgets.cpp#L91-L96) | Source verified. Package mirror certificate verification blocked the runtime capture. |
| Fedora 43 | `26.04.3-1.fc43` | [v26.04.3](https://github.com/KDE/kdialog/blob/v26.04.3/src/widgets.cpp#L91-L96) | [Review](fedora43/review.png), [default Cancel](fedora43/cancel-default.png), [stdin](fedora43/review-input.html) |
| Fedora 44 | `26.08.3-1.fc44` | [v26.08.3](https://github.com/KDE/kdialog/blob/v26.08.3/src/widgets.cpp#L91-L96) | [Review](fedora44/review.png), [default Cancel](fedora44/cancel-default.png), [stdin](fedora44/review-input.html) |
| Fedora 45 | `26.08.3-1.fc45` | [v26.08.3](https://github.com/KDE/kdialog/blob/v26.08.3/src/widgets.cpp#L91-L96) | [Review](fedora45/review.png), [default Cancel](fedora45/cancel-default.png), [stdin](fedora45/review-input.html) |

[Ubuntu package index](https://packages.ubuntu.com/kdialog) · [Fedora package index](https://packages.fedoraproject.org/pkgs/kdialog/kdialog/)

Ubuntu 24.04 and Fedora 43/44 used Node's `execFile` child stdin stream, the same transport used in the PR. Ubuntu 22.04 and Fedora 45 used file redirection into stdin.

## Reproduce

```sh
podman run --name kdialog-evidence -i docker.io/library/ubuntu:24.04 \
  bash -s -- ubuntu < capture-kdialog-node-pipe.sh
mkdir -p ./capture
podman cp kdialog-evidence:/out/. ./capture
podman rm kdialog-evidence
```

For Fedora, use `quay.io/fedora/fedora:44` and pass `fedora` to the script instead. Use `capture-kdialog-file-stdin.sh` to reproduce the redirected-stdin runs. Both scripts install packages only inside the disposable container.
