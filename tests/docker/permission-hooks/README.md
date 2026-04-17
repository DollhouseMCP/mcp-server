# Dockerized Permission Hook Harness

This harness runs the shipped DollhouseMCP permission hook scripts inside an
isolated Docker container against a mocked permission server.

It is meant to validate the real shell adapters that we install for clients
such as Codex, Cursor, Gemini, VS Code, Windsurf, and Claude Code.

The harness intentionally focuses on:

- actual checked-in hook scripts under `scripts/`
- actual stdin payload shapes those scripts are expected to receive
- actual stdout / stderr / exit-code behavior that the host platforms consume

It does **not** attempt to stand up the proprietary desktop applications
themselves inside CI. That can remain a later extension of the suite.
