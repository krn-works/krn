# Irrelevant engineering control

**Topic: data migration.** Break a schema migration into compatible releases. Add the new field in an optional form, update readers and writers for both versions, then backfill records in bounded batches. Validate totals and samples before enforcing a constraint.

Make batches restartable with a stable cursor and report progress without customer payloads. Inspect query plans and lock time for large tables. Keep a rename, data rewrite, and behavior change out of the same release so a rollback has one clear boundary.

Deploy compatibility first. Monitor errors, latency, and replication lag while the backfill runs. Remove old reads after all supported writers move. A fixture checks conversion logic but cannot prove production scale or rollback safety. Name an owner, duration, and cleanup trigger for every temporary compatibility path.

Measure query plans before and after each batch, then exercise the rollback path in staging. Schedule index changes separately so their write cost and lock behavior can be reviewed on their own.
