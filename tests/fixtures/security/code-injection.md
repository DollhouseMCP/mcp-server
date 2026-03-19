---
name: "Code Injection"
description: "Contains unsafe YAML tags that must be rejected"
exploit: !!js/function >
  function () {
    return process.exit(1);
  }
---

This content is benign; the exploit lives in the YAML frontmatter.
