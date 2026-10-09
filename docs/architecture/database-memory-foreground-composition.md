# Dormant database foreground composition

The server's normal element-manager registrar can receive the internal
`AdmittedDatabaseMemoryManagerFactory` provider. No production code registers
that provider in this slice. Ordinary file and database deployments retain their
existing manager construction.

`DatabaseStorageLayerFactory.createAdmittedMemoryManager` requires the actual
factory and authenticated user-resolver identities in the manager dependencies.
It obtains one memory layer through its virtual `createForElement` entry and uses
that same layer for manager reads, conditional writes, the adapter and admission
gate. An enforcing factory subclass can supply its mandatory legacy mutation
guard through that entry; a second independently constructed store is not used.
When the adapter begins an owned head read, the gate captures the effective
server-resolved tenant before its awaited admission work and revalidates the actual database, store, adapter, profile and tenant. No
request supplies a transaction, tenant selector or admission authority.

| Foreground operation | Admitted manager behavior |
| --- | --- |
| Loaded `Memory.save` / `MemoryManager.save` | Existing-owner, unchanged-name conditional UPDATE in the gate's outer transaction |
| Immediate AQL append / clear | Same-read detached candidate; committed persistence precedes receipt and success audit |
| Console memory metadata/content UPDATE | Same-read raw-content precondition and committed response ETag |
| Memory CREATE / DELETE / import | Explicit refusal before target discovery, parsing or construction |
| Generic memory edit, rename/fork, upgrade or upgrade preview | Explicit refusal before initialization, lookup or target mutation |

Known transaction completion precedes token advancement, committed cache
publication and success audit. Refused or unknown updates retain their original
candidate and authority; they do not fall back to an ordinary writer. A committed
publication failure remains committed and preserves its receipt. Logical row
identity remains distinct from a legacy YAML display name; an incompatible owner
is refused rather than silently renamed.

This is a dormant composition seam and foreground qualification slice. The
provider is **not an activation flag**, a sticky ownership record or cohort
selector. Its absence, a restart or an older binary is not proof that legacy
writers are safe. The separate durable legacy-denial factory, deferred/admin
writers and queues, old-process exclusion, archive-free eligibility, read/index
policy, global database maintenance, durable recovery, backup/restore,
owner-aware rollback and audit evidence must qualify before any live profile is
enabled. Neither this slice nor its tests certify that complete profile. A root
composed as admitted handles its requests under the fixed reviewed UPDATE
profile; mixed-cohort routing within a live root is not implemented here.

Required PostgreSQL tests use the actual `DollhouseContainer` registrar and
uniquely owned disposable database fixtures. Mode records and dirty-marker
preparation in those fixtures are test setup, never maintenance or activation
authority. Authored cases become evidence only after the configured hosted
PostgreSQL phase executes them and completes owned cleanup.
