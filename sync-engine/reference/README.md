# reference/ — original SmartStock server code

Original SmartStock server code (coupled to Prisma/Fastify/domain). Here for
study — the runnable, decoupled bits are in [`../src`](../src) and the design is
in [`../docs/DESIGN.md`](../docs/DESIGN.md).

These files are copied **verbatim** from the production sync module
(`packages/api/src/modules/sync/`) and are **NOT compiled** as part of this
package (they import `@prisma/client`, Fastify and internal `@smartstock/*`
packages that aren't bundled here). Read them alongside `DESIGN.md` to see how
the pure ideas were wired into a real server.

| File | What it shows |
|---|---|
| `types.ts` | Operation/payload/conflict contract (the desktop↔server wire format). |
| `schema.ts` | Zod validation of push/pull payloads (per-operation validation). |
| `service.ts` | The push pipeline: idempotency by UUID, org-access checks, vector-clock classification of `product_update`, and the **gap-free pull via the Postgres xmin horizon** (`safeHorizonSeq`). |
| `merge.service.ts` | Applying one operation to the master DB; physical conflict = stock would go negative → partial writeoff + shortage. |
| `conflict.service.ts` | Pure `dominates`/`isConcurrent`; semantic-conflict voting, freeze, deadlines, admin veto. |
| `server-journal.ts` | Why server-side REST mutations are also journalled (so the desktop swarm sees them via pull) and the deterministic "server device". |
| `routes.ts` | Fastify wiring of `/sync/push`, `/sync/pull`, `/sync/snapshot`, `/conflicts/:id/vote`, `/sync/resolve-conflict`. |

Mapping to the runnable core in `../src`:

- `conflict.service.ts: dominates/isConcurrent` → `src/vector-clock.ts` (verbatim) + `increment`/`merge` helpers.
- `merge.service.ts` physical branch → `src/conflict.ts: classifyPhysical`.
- `service.ts: classifyProductUpdate` → `src/conflict.ts: classifySemantic`.
- `conflict.service.ts: vote/resolve` → `src/conflict.ts: tallyVote/resolveByAdmin`.
- `service.ts: push` idempotency + serverSeq → `src/journal.ts: InMemoryJournal`.
