import fs from "node:fs/promises"
import path from "node:path"
import pg from "pg"
import { config } from "./config.js"

const { Pool } = pg

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 12,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
})

const migrationFiles = async () => {
  const files = []
  try {
    const entries = await fs.readdir(config.migrationsDir, { withFileTypes: true })
    files.push(...entries
      .filter(entry => entry.isFile() && /^\d+.*\.sql$/i.test(entry.name))
      .map(entry => path.join(config.migrationsDir, entry.name)))
  } catch (error) {
    if (!config.migrationsFile) throw error
  }
  if (config.migrationsFile && !files.includes(config.migrationsFile)) files.push(config.migrationsFile)
  const unique = [...new Set(files)].sort((left, right) => path.basename(left).localeCompare(path.basename(right)))
  if (!unique.length) throw new Error("no cognitive database migrations found")
  return unique
}

export const migrate = async () => {
  const files = await migrationFiles()
  for (const file of files) {
    const sql = await fs.readFile(file, "utf8")
    await pool.query(sql)
  }
}

export const closeDatabase = async () => {
  await pool.end()
}
