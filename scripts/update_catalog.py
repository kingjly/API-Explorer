"""Apply a reviewed API catalog migration to an API Explorer SQLite database."""

from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATABASE = ROOT / "ApiInfo2.0.db"
DEFAULT_CATALOG = ROOT / "data" / "api_catalog_updates_2026-08-06.json"

FUNCTION_COLUMNS = {
    "name": "function",
    "method": "type",
    "url": "url",
    "headers": "headers",
    "path": "path_params",
    "query": "get_params",
    "contentType": "content_type",
    "body": "post_params",
    "isToken": "is_token",
    "tokenPattern": "token_re",
    "documentation": "api_doc",
    "specStatus": "spec_status",
    "specVersion": "spec_version",
    "docUrl": "doc_url",
    "changeNote": "change_note",
}

APPLICATION_COLUMNS = {
    "name": "application",
    "idLabel": "id_tab",
    "keyLabel": "key_tab",
    "baseUrl": "baseurl",
}

FUNCTION_INSERT_COLUMNS = {
    "id": "id",
    "groupId": "group_id",
    **FUNCTION_COLUMNS,
}

ALLOWED_STATUSES = {
    "active",
    "legacy",
    "deprecated",
    "removed",
    "unverified",
    "test-only",
}


def ensure_schema(connection: sqlite3.Connection) -> None:
    existing = {
        row[1] for row in connection.execute('PRAGMA table_info("function")')
    }
    for name, definition in (
        ("path_params", "TEXT NOT NULL DEFAULT ''"),
        ("spec_status", "TEXT NOT NULL DEFAULT 'active'"),
        ("spec_version", "TEXT NOT NULL DEFAULT ''"),
        ("doc_url", "TEXT NOT NULL DEFAULT ''"),
        ("verified_at", "TEXT NOT NULL DEFAULT ''"),
        ("change_note", "TEXT NOT NULL DEFAULT ''"),
    ):
        if name not in existing:
            connection.execute(
                f'ALTER TABLE "function" ADD COLUMN "{name}" {definition}'
            )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS api_catalog_metadata (
            key TEXT PRIMARY KEY NOT NULL,
            value TEXT NOT NULL
        )
        """
    )


def update_record(
    connection: sqlite3.Connection,
    table: str,
    identifier: int,
    record: dict[str, object],
    mapping: dict[str, str],
    extra: dict[str, object] | None = None,
) -> None:
    values = {
        column: record[key]
        for key, column in mapping.items()
        if key in record and record[key] is not None
    }
    if extra:
        values.update(extra)
    if "is_token" in values:
        values["is_token"] = int(bool(values["is_token"]))
    if not values:
        return
    assignments = ", ".join(f'"{column}" = ?' for column in values)
    cursor = connection.execute(
        f'UPDATE "{table}" SET {assignments} WHERE id = ?',
        [*values.values(), identifier],
    )
    if cursor.rowcount != 1:
        raise RuntimeError(f"{table} ID {identifier} does not exist")


def apply(database: Path, catalog_path: Path, create_backup: bool) -> None:
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    function_ids = [int(record["id"]) for record in catalog["functions"]]
    new_groups = catalog.get("newGroups", [])
    required_group_fields = {"id", "appId", "name"}
    for group in new_groups:
        missing_fields = sorted(required_group_fields - group.keys())
        if missing_fields:
            raise RuntimeError(
                f"new group {group.get('id')} missing fields: {missing_fields}"
            )
    new_group_ids = [int(record["id"]) for record in new_groups]
    new_functions = catalog.get("newFunctions", [])
    new_function_ids = [int(record["id"]) for record in new_functions]
    application_ids = [int(record["id"]) for record in catalog["applications"]]
    all_catalog_function_ids = function_ids + new_function_ids
    if len(all_catalog_function_ids) != len(set(all_catalog_function_ids)):
        raise RuntimeError("catalog contains duplicate function IDs")
    if len(application_ids) != len(set(application_ids)):
        raise RuntimeError("catalog contains duplicate application IDs")
    if len(new_group_ids) != len(set(new_group_ids)):
        raise RuntimeError("catalog contains duplicate new group IDs")
    invalid_catalog_statuses = [
        (record["id"], record.get("specStatus"))
        for record in [*catalog["functions"], *new_functions]
        if record.get("specStatus") not in ALLOWED_STATUSES
    ]
    if invalid_catalog_statuses:
        raise RuntimeError(f"invalid catalog statuses: {invalid_catalog_statuses}")
    required_insert_fields = {
        "id",
        "groupId",
        "name",
        "method",
        "url",
        "isToken",
        "documentation",
        "specStatus",
        "specVersion",
        "docUrl",
    }
    for function in new_functions:
        missing_fields = sorted(required_insert_fields - function.keys())
        if missing_fields:
            raise RuntimeError(
                f"new function {function.get('id')} missing fields: {missing_fields}"
            )

    if create_backup:
        backup = database.with_name(f"{database.stem}.pre-{catalog['version']}.db")
        if not backup.exists():
            shutil.copy2(database, backup)
            print(f"backup: {backup}")

    connection = sqlite3.connect(database)
    try:
        database_application_ids = {
            int(row[0]) for row in connection.execute("SELECT id FROM application")
        }
        database_group_ids = {
            int(row[0]) for row in connection.execute('SELECT id FROM "group"')
        }
        database_function_ids = {
            int(row[0]) for row in connection.execute("SELECT id FROM function")
        }
        patch_function_ids = set(function_ids)
        missing_patch_ids = patch_function_ids - database_function_ids
        unexpected_ids = (
            database_function_ids - patch_function_ids - set(new_function_ids)
        )
        if missing_patch_ids or unexpected_ids:
            raise RuntimeError(
                "catalog coverage mismatch; "
                f"missing-patch-ids={sorted(missing_patch_ids)}, "
                f"unexpected-database-ids={sorted(unexpected_ids)}"
            )
        for group in new_groups:
            application_id = int(group["appId"])
            if application_id not in database_application_ids:
                raise RuntimeError(
                    f"new group {group['id']} references missing application "
                    f"{application_id}"
                )
            existing = connection.execute(
                'SELECT app_id, "group" FROM "group" WHERE id = ?',
                (int(group["id"]),),
            ).fetchone()
            expected = (application_id, group["name"])
            if existing is not None and existing != expected:
                raise RuntimeError(
                    f"new group ID {group['id']} conflicts with existing data"
                )

        available_group_ids = database_group_ids | set(new_group_ids)
        for function in new_functions:
            group_id = int(function["groupId"])
            if group_id not in available_group_ids:
                raise RuntimeError(
                    f"new function {function['id']} references missing group "
                    f"{group_id}"
                )
            existing = connection.execute(
                "SELECT group_id, function, url FROM function WHERE id = ?",
                (int(function["id"]),),
            ).fetchone()
            expected = (
                int(function["groupId"]),
                function["name"],
                function["url"],
            )
            if existing is not None and existing != expected:
                raise RuntimeError(
                    f"new function ID {function['id']} conflicts with existing data"
                )

        with connection:
            ensure_schema(connection)
            for application in catalog["applications"]:
                update_record(
                    connection,
                    "application",
                    int(application["id"]),
                    application,
                    APPLICATION_COLUMNS,
                )
            for group in new_groups:
                connection.execute(
                    """
                    INSERT INTO "group"(id, app_id, "group") VALUES(?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        app_id = excluded.app_id,
                        "group" = excluded."group"
                    """,
                    (int(group["id"]), int(group["appId"]), group["name"]),
                )
            for function in catalog["functions"]:
                update_record(
                    connection,
                    "function",
                    int(function["id"]),
                    function,
                    FUNCTION_COLUMNS,
                    {
                        "verified_at": catalog["verifiedAt"],
                        "change_note": function.get("changeNote", ""),
                    },
                )
            for function in new_functions:
                values = {
                    column: function.get(key, "")
                    for key, column in FUNCTION_INSERT_COLUMNS.items()
                }
                values["is_token"] = int(bool(values["is_token"]))
                values["verified_at"] = catalog["verifiedAt"]
                columns = list(values)
                placeholders = ", ".join("?" for _ in columns)
                quoted_columns = ", ".join(f'"{column}"' for column in columns)
                updates = ", ".join(
                    f'"{column}" = excluded."{column}"'
                    for column in columns
                    if column != "id"
                )
                connection.execute(
                    f"INSERT INTO function ({quoted_columns}) "
                    f'VALUES ({placeholders}) ON CONFLICT(id) DO UPDATE SET {updates}',
                    [values[column] for column in columns],
                )
            for key, value in (
                ("catalog_version", catalog["version"]),
                ("verified_at", catalog["verifiedAt"]),
            ):
                connection.execute(
                    """
                    INSERT INTO api_catalog_metadata(key, value) VALUES(?, ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value
                    """,
                    (key, value),
                )

            updated = connection.execute(
                "SELECT COUNT(*) FROM function WHERE verified_at = ?",
                (catalog["verifiedAt"],),
            ).fetchone()[0]
            invalid = connection.execute(
                """
                SELECT id, function FROM function
                WHERE spec_status NOT IN ('active','legacy','deprecated','removed','unverified','test-only')
                """
            ).fetchall()
            if invalid:
                raise RuntimeError(f"invalid spec statuses: {invalid}")
            final_ids = {
                int(row[0]) for row in connection.execute("SELECT id FROM function")
            }
            expected_final_ids = patch_function_ids | set(new_function_ids)
            if final_ids != expected_final_ids:
                raise RuntimeError(
                    f"post-migration ID mismatch: {sorted(final_ids ^ expected_final_ids)}"
                )
            final_group_ids = {
                int(row[0]) for row in connection.execute('SELECT id FROM "group"')
            }
            expected_final_group_ids = database_group_ids | set(new_group_ids)
            if final_group_ids != expected_final_group_ids:
                raise RuntimeError(
                    "post-migration group ID mismatch: "
                    f"{sorted(final_group_ids ^ expected_final_group_ids)}"
                )
            if updated != len(final_ids):
                raise RuntimeError(
                    f"only {updated} of {len(final_ids)} functions were verified"
                )
        application_total = connection.execute(
            "SELECT COUNT(*) FROM application"
        ).fetchone()[0]
        group_total = connection.execute(
            'SELECT COUNT(*) FROM "group"'
        ).fetchone()[0]
        function_total = len(final_ids)
        created_group_count = len(set(new_group_ids) - database_group_ids)
        created_function_count = len(set(new_function_ids) - database_function_ids)
        print(f"catalog version: {catalog['version']}")
        print(
            f"applications: total={application_total}, "
            f"catalog-updated={len(application_ids)}"
        )
        print(
            f"groups: total={group_total}, declared-new={len(new_group_ids)}, "
            f"created={created_group_count}, "
            f"already-present={len(new_group_ids) - created_group_count}"
        )
        print(
            f"functions: total={function_total}, catalog-updated={len(function_ids)}, "
            f"declared-new={len(new_function_ids)}, created={created_function_count}, "
            f"already-present={len(new_function_ids) - created_function_count}, "
            f"verified={updated}"
        )
    finally:
        connection.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", type=Path, default=DEFAULT_DATABASE)
    parser.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    parser.add_argument("--backup", action="store_true")
    args = parser.parse_args()
    apply(args.database.resolve(), args.catalog.resolve(), args.backup)


if __name__ == "__main__":
    main()
