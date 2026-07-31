// Removes transient runtime state from restorable OpenClaw database snapshots.
import type { DatabaseSync } from "node:sqlite";
import { tryParsePersistedExecApprovals } from "../infra/exec-approvals-config.js";
import type { ExecApprovalsFile } from "../infra/exec-approvals-core.js";
import { projectionValues } from "../infra/exec-approvals-sqlite.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import { PLUGIN_BLOB_SNAPSHOT_EXCLUDED_NAMESPACE_PREFIX } from "./openclaw-state-snapshot-policy.js";

type SnapshotSanitizerDatabase = Pick<OpenClawStateKyselyDatabase, "exec_approvals_config">;

const FAIL_CLOSED_EXEC_APPROVALS: ExecApprovalsFile = {
  version: 1,
  defaults: {
    security: "deny",
    ask: "off",
    askFallback: "deny",
    autoAllowSkills: false,
  },
  agents: {},
};

function tableExists(database: DatabaseSync, tableName: string): boolean {
  const row = database // sqlite-allow-raw -- Offline snapshot maintenance boundary.
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { ok?: unknown } | undefined;
  return row?.ok === 1;
}

function tableColumnExists(database: DatabaseSync, tableName: string, columnName: string): boolean {
  const row = database // sqlite-allow-raw -- Offline snapshot maintenance boundary.
    .prepare("SELECT 1 AS ok FROM pragma_table_info(?) WHERE name = ?")
    .get(tableName, columnName) as { ok?: unknown } | undefined;
  return row?.ok === 1;
}

/** Remove coordination rows that must never survive restore. */
export function sanitizeOpenClawStateLeaseRows(database: DatabaseSync): void {
  if (tableExists(database, "state_leases")) {
    database.prepare("DELETE FROM state_leases").run(); // sqlite-allow-raw -- Offline snapshot maintenance boundary.
  }
}

/** Remove transient rows whose restoration would replay work or extend private-data retention. */
export function sanitizeOpenClawGlobalStateSnapshot(database: DatabaseSync): void {
  // Archive backup can encounter an older database shape, so each optional
  // table is detected before applying the current sanitizer contract.
  sanitizeOpenClawStateLeaseRows(database);
  if (tableExists(database, "delivery_queue_entries")) {
    database.prepare("DELETE FROM delivery_queue_entries").run(); // sqlite-allow-raw -- Offline snapshot maintenance boundary.
  }
  if (tableExists(database, "plugin_blob_entries")) {
    // A TTL or excluded namespace marks blob data as non-restorable. Remove live
    // rows too, so backup cannot extend retention or preserve recovery secrets.
    const hasExpiry = tableColumnExists(database, "plugin_blob_entries", "expires_at");
    const hasNamespace = tableColumnExists(database, "plugin_blob_entries", "namespace");
    if (hasExpiry && hasNamespace) {
      database // sqlite-allow-raw -- Offline snapshot maintenance boundary.
        .prepare(
          `DELETE FROM plugin_blob_entries
           WHERE expires_at IS NOT NULL OR substr(namespace, 1, ?) = ?`,
        )
        .run(
          PLUGIN_BLOB_SNAPSHOT_EXCLUDED_NAMESPACE_PREFIX.length,
          PLUGIN_BLOB_SNAPSHOT_EXCLUDED_NAMESPACE_PREFIX,
        );
    } else if (hasExpiry) {
      database.prepare("DELETE FROM plugin_blob_entries WHERE expires_at IS NOT NULL").run(); // sqlite-allow-raw -- Offline snapshot maintenance boundary.
    } else if (hasNamespace) {
      database // sqlite-allow-raw -- Offline snapshot maintenance boundary.
        .prepare("DELETE FROM plugin_blob_entries WHERE substr(namespace, 1, ?) = ?")
        .run(
          PLUGIN_BLOB_SNAPSHOT_EXCLUDED_NAMESPACE_PREFIX.length,
          PLUGIN_BLOB_SNAPSHOT_EXCLUDED_NAMESPACE_PREFIX,
        );
    }
  }
  if (tableExists(database, "exec_approvals_config")) {
    const stateDb = getNodeSqliteKysely<SnapshotSanitizerDatabase>(database);
    const rows = executeSqliteQuerySync(
      database,
      stateDb.selectFrom("exec_approvals_config").select(["config_key", "raw_json"]),
    ).rows;
    for (const row of rows) {
      let sanitized: ExecApprovalsFile = FAIL_CLOSED_EXEC_APPROVALS;
      const parsed = tryParsePersistedExecApprovals(row.raw_json);
      if (parsed) {
        sanitized = structuredClone(parsed);
        if (sanitized.socket) {
          delete sanitized.socket.token;
        }
      }
      executeSqliteQuerySync(
        database,
        stateDb
          .updateTable("exec_approvals_config")
          .set({
            raw_json: `${JSON.stringify(sanitized, null, 2)}\n`,
            ...projectionValues(sanitized),
          })
          .where("config_key", "=", row.config_key),
      );
    }
  }
}
