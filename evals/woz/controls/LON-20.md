# Irrelevant engineering control

**Topic: data migration.** Treat a database migration as a sequence of compatible states. Add nullable or defaulted fields first, update readers and writers to tolerate both schemas, then backfill in bounded batches. Verify row counts and representative values before tightening constraints.

Keep migration code idempotent and make progress observable without logging customer payloads. A retry should resume from a stable cursor rather than repeat an unbounded scan. For large tables, measure lock duration and query plans on realistic indexes. Avoid combining a schema rename, data rewrite, and application behavior change in one release.

Deploy the compatibility layer before the backfill. Monitor errors, latency, and lag, then remove the old read path only after every supported writer has moved. A local fixture can cover conversion logic; it does not establish production scale or rollback safety. Record the owner, expected duration, and cleanup condition for temporary compatibility code.

Review query plans after the backfill and keep the migration reversible. Use staging.
