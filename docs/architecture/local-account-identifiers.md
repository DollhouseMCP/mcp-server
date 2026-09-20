# Local account identifiers

The account-administration invite flow keeps a person's display name separate from the stable username used by the local authentication subject. The browser and API import the same normalization module so the username preview is the identifier the server persists.

Display names are trimmed and NFC-normalized while preserving case, internal whitespace, and ordinary punctuation. They may contain at most 255 Unicode code points and may not contain Unicode control or formatting characters.

Derived usernames are lowercase NFC strings. Unicode letters and numbers are retained with their attached combining marks, while each run of whitespace or punctuation becomes one hyphen. A username may also be supplied or edited directly; it accepts Unicode letters, numbers, attached combining marks, hyphens, and underscores, cannot start with a hyphen, and is limited to 64 Unicode code points. Existing normalized values such as `bob_2` remain unchanged. Derivation never truncates: punctuation-only or overlong results are validation errors.

For example, `Todd Lewis` derives `todd-lewis`, `Renée O'Connor` derives `renée-o-connor`, and `李 小龙` derives `李-小龙`. The display name itself is stored unchanged after trim/NFC normalization.

Derivation can expose a collision, such as `Todd Lewis` and `Todd-Lewis`. The UI shows the canonical username before submission and lets the administrator edit it. Persistence remains authoritative: a duplicate username or email returns HTTP 409 and never attaches the invite to an existing account or silently adds a suffix.
