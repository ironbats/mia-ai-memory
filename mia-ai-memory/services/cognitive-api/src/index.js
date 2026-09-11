import { config } from "./config.js"
import { closeDatabase, migrate } from "./db.js"
import { createServer } from "./server.js"
import { startSyncLoop } from "./sync-service.js"

await migrate()
const stopSync = startSyncLoop()
const server = createServer()

server.listen(config.port, config.host, () => {
  console.log(JSON.stringify({ level: "info", event: "cognitive_api_started", host: config.host, port: config.port }))
})

const shutdown = async signal => {
  console.log(JSON.stringify({ level: "info", event: "shutdown", signal }))
  stopSync()
  await new Promise(resolve => server.close(resolve))
  await closeDatabase()
  process.exit(0)
}

process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT", () => shutdown("SIGINT"))
