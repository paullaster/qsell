#!/usr/bin/env python3
"""Remove unsupported query parameters from /opt/qsell/.env.runtime DATABASE_URL.

Postgres.js pool settings belong in src/server/db/drizzle/client.ts, not in the
PostgreSQL URL query string. This script preserves the credential and does not
print the URL or password.
"""

from pathlib import Path
from urllib.parse import urlsplit, urlunsplit


ENV_PATH = Path("/opt/qsell/.env.runtime")


def main() -> None:
    if not ENV_PATH.is_file():
        raise SystemExit(f"Runtime environment file not found: {ENV_PATH}")

    lines = ENV_PATH.read_text(encoding="utf-8").splitlines()
    for index, line in enumerate(lines):
        if not line.startswith("DATABASE_URL="):
            continue

        raw_url = line.split("=", 1)[1].strip().strip("'\"")
        parsed = urlsplit(raw_url)
        if (
            parsed.scheme not in ("postgres", "postgresql")
            or parsed.hostname != "db"
            or parsed.path != "/qsell"
            or not parsed.password
        ):
            raise SystemExit("DATABASE_URL does not match the expected qsell database; unchanged")

        # Keep scheme, credentials, service host, and database; remove query
        # parameters such as libpq's connection_limit that Postgres.js forwards
        # as server settings.
        lines[index] = "DATABASE_URL=" + urlunsplit(
            (parsed.scheme, parsed.netloc, parsed.path, "", "")
        )
        ENV_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")
        ENV_PATH.chmod(0o600)
        print("DATABASE_URL repaired; credentials were preserved and not displayed.")
        return

    raise SystemExit("DATABASE_URL entry not found; file unchanged")


if __name__ == "__main__":
    main()
