---
"pgrls": patch
---

`pgrls audit --schema` and `--exclude` now also take a comma-separated list, matching pgrls-action and the other CLIs: `--exclude __drizzle_migrations,audit_log` is the same as repeating the flag. Entries are trimmed and empty ones dropped. Before, the whole string was read as a single table or schema name and matched nothing.

A `--schema` or `--exclude` that names nothing (`--schema ","`) exits 2 instead of quietly falling back to the default. The message printed when the audit runs as a superuser or `BYPASSRLS` role now describes the risk accurately: the table list is the same for any role, but a clean audit over that connection says nothing about what the application can read.
