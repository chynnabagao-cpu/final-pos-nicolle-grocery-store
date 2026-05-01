import Database from "better-sqlite3";

const db = new Database("pos.db");

function getSchema() {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  
  console.log("--- SQLite Database Schema ---\n");
  
  tables.forEach(row => {
    const tableName = row.name;
    const schema = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`).get(tableName);
    console.log(`Table: ${tableName}`);
    console.log(schema.sql);
    console.log("\n------------------------------------------------\n");
  });
}

getSchema();
