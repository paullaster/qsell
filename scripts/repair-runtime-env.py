#!/usr/bin/env python3
"""Repair /opt/qsell/.env.runtime without displaying or committing secrets.

Run this on the deployment server from /opt/qsell. It reads the existing
PostgreSQL password file, prompts for the initial admin email/password, replaces
the app/auth/encryption settings, removes legacy unresolved variable aliases,
preserves other integration settings, and writes the env file mode 0600.
"""

from __future__ import annotations

import base64
import os
import re
import secrets
import tempfile
from getpass import getpass
from pathlib import Path
from urllib.parse import quote


ENV_PATH = Path("/opt/qsell/.env.runtime")
POSTGRES_PASSWORD_PATH = Path("/opt/qsell/secrets/postgres_password")
APP_URL = "https://omnicommerce.brainsporellc.com"
OBSOLETE_KEYS = {
    "DB_PASSWORD",
    "DATA_KEY",
    "ADMIN_EMAIL",
    "ADMIN_PASSWORD",
    "POSTGRES_PASSWORD",
}


def env_single_quote(value: str) -> str:
    """Docker Compose env-file single quotes preserve literal secret values."""
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def main() -> None:
    if not ENV_PATH.parent.is_dir():
        raise SystemExit(f"Deployment directory not found: {ENV_PATH.parent}")
    if not POSTGRES_PASSWORD_PATH.is_file():
        raise SystemExit(f"PostgreSQL password file not found: {POSTGRES_PASSWORD_PATH}")

    database_password = POSTGRES_PASSWORD_PATH.read_text(encoding="utf-8").strip()
    if not database_password:
        raise SystemExit("The PostgreSQL password file is empty")

    admin_email = input("Initial admin email: ").strip().lower()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", admin_email):
        raise SystemExit("Enter a valid email address")

    admin_password = getpass("Choose initial admin password (16+ characters): ")
    confirmation = getpass("Confirm initial admin password: ")
    if admin_password != confirmation:
        raise SystemExit("The passwords do not match")
    if len(admin_password) < 16 or "\n" in admin_password or "\r" in admin_password:
        raise SystemExit("Use an admin password of at least 16 characters on one line")

    auth_secret = secrets.token_urlsafe(48)
    jwt_secret = secrets.token_urlsafe(48)
    encryption_key = base64.urlsafe_b64encode(os.urandom(32)).decode("ascii").rstrip("=")

    values = {
        "NODE_ENV": "production",
        "NEXT_PUBLIC_APP_URL": APP_URL,
        "DATABASE_URL": (
            "postgresql://qsell:"
            + quote(database_password, safe="")
            + "@db:5432/qsell"
        ),
        "AUTH_SECRET": auth_secret,
        "AUTH_URL": APP_URL,
        "NEXTAUTH_URL": APP_URL,
        "JWT_SECRET": jwt_secret,
        "DATA_ENCRYPTION_KEY": encryption_key,
        "PAYMENT_DATA_KEY": encryption_key,
        "SUPER_ADMIN_EMAIL": admin_email,
        "SUPER_ADMIN_PASSWORD": env_single_quote(admin_password),
        "SUPER_ADMIN_NAME": "Super Admin",
    }

    previous_lines = ENV_PATH.read_text(encoding="utf-8").splitlines() if ENV_PATH.exists() else []
    replace_keys = set(values) | OBSOLETE_KEYS
    preserved_lines: list[str] = []
    for line in previous_lines:
        match = re.match(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=", line)
        if match and match.group(1) in replace_keys:
            continue
        preserved_lines.append(line)

    output_lines = preserved_lines + [
        f"{key}={value}" for key, value in values.items()
    ]
    content = "\n".join(output_lines) + "\n"
    unresolved = sorted(set(re.findall(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", content)))
    if unresolved:
        raise SystemExit("Unresolved environment placeholders remain: " + ", ".join(unresolved))

    file_descriptor, temporary_name = tempfile.mkstemp(
        prefix=".env.runtime.", dir=ENV_PATH.parent, text=True
    )
    try:
        os.fchmod(file_descriptor, 0o600)
        with os.fdopen(file_descriptor, "w", encoding="utf-8") as runtime_file:
            runtime_file.write(content)
        os.replace(temporary_name, ENV_PATH)
        ENV_PATH.chmod(0o600)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise

    print("Runtime environment repaired; unresolved placeholders: none.")
    print("Admin password was entered hidden; store it in your password manager.")


if __name__ == "__main__":
    main()
