---
"pgrls": patch
---

`pgrls audit --schema` and `--exclude` now also take a comma-separated list, matching pgrls-action and the other CLIs: `--exclude __drizzle_migrations,audit_log` is the same as repeating the flag. Entries are trimmed and empty ones dropped. Before, the whole string was read as a single table or schema name and matched nothing.
