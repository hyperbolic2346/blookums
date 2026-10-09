// Can this image's code read the migrated copy?
//
//   node schema-reads.js <label>       (cwd: the image's apps/api)
//
// Uses the Prisma client generated into the image (so, for the previous
// release, the schema that release was built with) and, for every model:
//   - reads one row with every scalar column the client knows: a column
//     dropped, renamed or retyped under that code fails here;
//   - for every enum column, lists the values present in the table and
//     checks the client knows each one: a value the previous release does
//     not know (CLAUDE.md: "don't write it until the release after") makes
//     its client throw on any row that holds it. Only while the column's
//     type in the database is still an enum (pg_type, pg_enum): its values
//     are then enum labels, part of the schema. A column retyped to text
//     is not read, so no free text from a row is ever printed.
// Readiness alone proves neither: /api/health/ready only asks the database
// for SELECT 1 and the migration table.
//
// Prints model, column and enum names only, never row data; a Prisma error
// is cut to its first line, which names the column or value type.

const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const label = process.argv[2] || "candidate";
const appRequire = createRequire(path.join(process.cwd(), "package.json"));
const { PrismaClient, Prisma } = appRequire("@prisma/client");

function say(line) {
  try {
    fs.writeFileSync("/dev/termination-log", line.slice(0, 400));
  } catch {}
  console.log(line);
}

function firstLine(err) {
  const lines = String((err && err.message) || err).split("\n").map((s) => s.trim()).filter(Boolean);
  // Prisma puts "Invalid `prisma.x.findFirst()` invocation:" first; the cause follows.
  const cause = lines.find((l) => !/^Invalid `/.test(l) && !/^→?\s*\d+/.test(l)) || lines[0] || "";
  // Column names come in backticks; anything quoted may be a value from a row.
  return cause.replace(/"[^"]*"/g, '"(value)"').replace(/'[^']*'/g, "'(value)'").slice(0, 200);
}

const q = (id) => '"' + String(id).replace(/"/g, '""') + '"';

async function main() {
  const prisma = new PrismaClient();
  const { models, enums } = Prisma.dmmf.datamodel;
  const enumValues = new Map(enums.map((e) => [e.name, new Set(e.values.map((v) => v.dbName || v.name))]));
  const problems = [];
  let enumColumns = 0;

  for (const m of models) {
    const delegate = prisma[m.name.charAt(0).toLowerCase() + m.name.slice(1)];
    try {
      await delegate.findFirst();
    } catch (err) {
      problems.push(m.name + ": " + firstLine(err));
      continue;
    }
    const table = m.dbName || m.name;
    for (const f of m.fields) {
      if (f.kind !== "enum") continue;
      const colName = f.dbName || f.name;
      const types = await prisma.$queryRawUnsafe(
        "SELECT c.data_type, c.udt_name, t.typtype FROM information_schema.columns c " +
          "LEFT JOIN pg_type t ON t.typname = regexp_replace(c.udt_name, '^_', '') " +
          "WHERE c.table_schema = current_schema() AND c.table_name = $1 AND c.column_name = $2",
        table, colName,
      );
      const t = types[0];
      if (!t || t.typtype !== "e") {
        console.log("  " + m.name + "." + f.name + ": " + (t ? "now " + t.udt_name + " in the database, not an enum" : "no such column") +
          "; its values are not read");
        continue;
      }
      enumColumns++;
      const col = q(colName);
      const sql = f.isList
        ? "SELECT DISTINCT unnest(" + col + ")::text AS v FROM " + q(table)
        : "SELECT DISTINCT " + col + "::text AS v FROM " + q(table) + " WHERE " + col + " IS NOT NULL";
      try {
        const rows = await prisma.$queryRawUnsafe(sql);
        const known = enumValues.get(f.type) || new Set();
        const unknown = rows.map((r) => r.v).filter((v) => v != null && !known.has(v));
        if (unknown.length) {
          problems.push(m.name + "." + f.name + " holds " + unknown.map((v) => "'" + v + "'").join(", ") +
            ", not in " + (label === "previous" ? "its" : "this build's") + " enum " + f.type);
        }
      } catch (err) {
        problems.push(m.name + "." + f.name + ": " + firstLine(err));
      }
    }
  }
  await prisma.$disconnect();

  console.log(label + ": checked " + models.length + " tables and " + enumColumns + " enum columns");
  for (const p of problems) console.log("  " + p);
  if (problems.length) {
    const who = label === "previous" ? "The deployed release" : "This build";
    say(who + " cannot read the migrated copy: " + problems[0] +
      (problems.length > 1 ? " (+" + (problems.length - 1) + " more)" : ""));
    process.exit(1);
  }
  say("The " + (label === "previous" ? "deployed release" : "new build") + " reads all " + models.length +
    " tables of the migrated copy");
}

main().catch((err) => {
  say("The " + label + " read check could not run: " + firstLine(err));
  process.exit(1);
});
