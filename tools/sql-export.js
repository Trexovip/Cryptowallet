#!/usr/bin/env node
/*
 * sql-export.js — dump the live SQLite database to MySQL- or Postgres-compatible SQL.
 *
 * Usage (from the project root, or inside the Docker container):
 *   node tools/sql-export.js --dialect mysql    > kryvonwallet.mysql.sql
 *   node tools/sql-export.js --dialect postgres > kryvonwallet.pg.sql
 *
 * Options:
 *   --dialect mysql|postgres   (default: mysql)
 *   --data <dir>               data directory (default: $CUSTODY_DATA_DIR or ./data)
 *   --out <file>               write to a file instead of stdout
 *   --no-drop                  do not emit DROP TABLE statements
 *
 * Then import, e.g.:
 *   mysql -u user -p dbname   < kryvonwallet.mysql.sql
 *   psql   "$DATABASE_URL"     -f kryvonwallet.pg.sql
 *
 * This is a one-way export for data management / reporting. It does NOT change the app,
 * which keeps running on SQLite. Re-run it (it DROPs + recreates) to refresh the copy.
 */
const path = require("path");
const fs = require("fs");

function arg(name, def) { const i = process.argv.indexOf("--" + name); return i >= 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : true) : def; }
const dialect = String(arg("dialect", "mysql")).toLowerCase();
if (!["mysql", "postgres"].includes(dialect)) { console.error("dialect must be mysql or postgres"); process.exit(1); }
const dataDir = arg("data", process.env.CUSTODY_DATA_DIR || path.join(process.cwd(), "data"));
const dbPath = path.join(dataDir, "custody.db");
const emitDrop = arg("no-drop", false) !== true;
const outFile = arg("out", null);

if (!fs.existsSync(dbPath)) { console.error("database not found at " + dbPath + " (set --data <dir>)"); process.exit(1); }

let Database;
try { Database = require("better-sqlite3"); }
catch { console.error("better-sqlite3 not installed — run `npm install` first."); process.exit(1); }
const db = new Database(dbPath, { readonly: true });

const PG = dialect === "postgres";
const q = (id) => PG ? `"${id}"` : "\`" + id + "\`";          // identifier quoting
function sqlType(sqliteType, isPkInt) {
  const t = String(sqliteType || "").toUpperCase();
  if (isPkInt) return PG ? "BIGSERIAL PRIMARY KEY" : "BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY";
  if (/INT/.test(t)) return "BIGINT";
  if (/REAL|FLOA|DOUB/.test(t)) return PG ? "DOUBLE PRECISION" : "DOUBLE";
  return PG ? "TEXT" : "LONGTEXT";                             // TEXT/CLOB/anything else
}
function escVal(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (Buffer.isBuffer(v)) v = v.toString("utf8");
  let s = String(v).replace(/'/g, "''");
  if (!PG) s = s.replace(/\\/g, "\\\\");                       // MySQL treats backslash as escape
  return "'" + s + "'";
}

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
const out = [];
out.push(`-- KryvonWallet export (${dialect}) — ${new Date().toISOString()}`);
if (PG) out.push("SET standard_conforming_strings = on;");
else { out.push("SET NAMES utf8mb4;"); out.push("SET FOREIGN_KEY_CHECKS=0;"); }
out.push("");

for (const name of tables) {
  const cols = db.prepare(`PRAGMA table_info(${name})`).all(); // {cid,name,type,notnull,dflt_value,pk}
  const pkIntCol = cols.find((c) => c.pk && /INT/.test(String(c.type).toUpperCase()));
  if (emitDrop) out.push(`DROP TABLE IF EXISTS ${q(name)}${PG ? " CASCADE" : ""};`);
  const defs = cols.map((c) => {
    const isPkInt = pkIntCol && c.name === pkIntCol.name;
    let line = `  ${q(c.name)} ${sqlType(c.type, isPkInt)}`;
    if (!isPkInt && c.notnull && c.dflt_value == null) line += " NULL"; // keep permissive; app enforces
    return line;
  });
  out.push(`CREATE TABLE ${q(name)} (\n${defs.join(",\n")}\n)${PG ? "" : " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"};`);

  const rows = db.prepare(`SELECT * FROM ${name}`).all();
  if (rows.length) {
    const colNames = cols.map((c) => q(c.name)).join(",");
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const vals = rows.slice(i, i + CHUNK)
        .map((row) => "(" + cols.map((c) => escVal(row[c.name])).join(",") + ")").join(",\n");
      out.push(`INSERT INTO ${q(name)} (${colNames}) VALUES\n${vals};`);
    }
  }
  out.push("");
}
if (!PG) out.push("SET FOREIGN_KEY_CHECKS=1;");
db.close();

const text = out.join("\n") + "\n";
if (outFile) { fs.writeFileSync(outFile, text); console.error(`Wrote ${outFile} (${tables.length} tables)`); }
else process.stdout.write(text);
