# Security policy

## Supported versions

The latest published minor version receives fixes. This project is pre-1.0, so older minors are not backported.

## Reporting a vulnerability

Please report privately through GitHub's [security advisory form](https://github.com/rajanaggarwal11/pgrls/security/advisories/new) rather than opening a public issue.

You should get an acknowledgement within 72 hours and an assessment within a week.

## Scope

`pgrls` reads `package.json`, `pnpm-workspace.yaml`, `tsconfig.json` and source files, and with `--fix` writes back to the first two. It runs no code from the workspace it inspects, spawns no subprocesses, and makes no network requests.

The things most worth reporting:

- A path that writes outside the workspace root.
- Input in a manifest or workspace file that causes code execution or a crash that could be exploited.
- A `--fix` edit that destroys content it was not meant to touch.
