# Irrelevant engineering control

**Topic: data migration.** Plan a migration around compatible schema stages. Introduce nullable or defaulted fields, make all readers and writers accept both forms, then backfill data in bounded batches. Check totals and sampled values before making the new field mandatory.

Make each batch safe to retry and report progress without printing customer data. Use a stable cursor so restarts do not rescan completed rows. For a large table, inspect query plans and measure lock time against realistic indexes. Keep renames, bulk rewrites, and application behavior changes in separate releases.

Deploy compatibility before starting the backfill. Watch errors, request latency, and replication lag; remove old reads only when every supported writer has switched. A local fixture covers mapping logic, not production scale or rollback safety. Record an owner, duration estimate, and removal condition for temporary compatibility code.

Compare query plans before and after each batch, then test rollback in staging. Schedule indexes separately and measure their write cost. Measure locks.
