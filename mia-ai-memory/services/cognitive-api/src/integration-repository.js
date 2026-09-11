import { pool } from "./db.js"

const json = value => JSON.stringify(value ?? null)

const mapModel = row => ({
  id: row.id,
  agentId: row.agent_id,
  provider: row.provider || "",
  modelId: row.model_id,
  displayName: row.display_name,
  capabilities: row.capabilities || {},
  settings: row.settings || {},
  isDefault: row.is_default === true,
  enabled: row.enabled === true,
  createdAt: row.created_at,
  updatedAt: row.updated_at
})

const mapCredential = row => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  provider: row.provider || "",
  maskedFields: row.masked_fields || {},
  createdAt: row.created_at,
  updatedAt: row.updated_at
})

const mapMcp = row => ({
  id: row.id,
  name: row.name,
  description: row.description || "",
  transport: row.transport,
  endpointUrl: row.endpoint_url || "",
  command: row.command || "",
  args: row.args || [],
  publicHeaders: row.public_headers || {},
  publicEnv: row.public_env || {},
  authType: row.auth_type || "none",
  credentialId: row.credential_id || null,
  credential: row.credential_id ? {
    id: row.credential_id,
    name: row.credential_name,
    kind: row.credential_kind,
    provider: row.credential_provider || "",
    maskedFields: row.credential_masked_fields || {}
  } : null,
  enabled: row.enabled === true,
  createdAt: row.created_at,
  updatedAt: row.updated_at
})

const mapAgent = (row, bindings, sessionStats, memoryStats) => {
  const session = sessionStats.get(row.id) || {}
  const memory = memoryStats.get(row.id) || {}
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    connectionType: row.connection_type,
    provider: row.provider || "",
    model: row.model || "",
    baseUrl: row.base_url || "",
    workspace: row.workspace || "",
    project: row.project || "",
    observedAgentKind: row.observed_agent_kind || "",
    credentialId: row.credential_id || null,
    credential: row.credential_id ? {
      id: row.credential_id,
      name: row.credential_name,
      kind: row.credential_kind,
      provider: row.credential_provider || "",
      maskedFields: row.credential_masked_fields || {}
    } : null,
    settings: row.settings || {},
    enabled: row.enabled === true,
    mcpServers: bindings.get(row.id) || [],
    observed: {
      sessions: Number(session.sessions || 0),
      observations: Number(session.observations || 0),
      memories: Number(memory.memories || 0),
      lastSeen: session.last_seen || memory.last_seen || null
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

const withTransaction = async callback => {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const result = await callback(client)
    await client.query("COMMIT")
    return result
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

const insertCredential = async (client, credential) => {
  await client.query(
    `INSERT INTO cognitive_credentials (id, name, kind, provider, ciphertext, iv, auth_tag, masked_fields)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [credential.id, credential.name, credential.kind, credential.provider || null, credential.ciphertext, credential.iv, credential.authTag, json(credential.maskedFields)]
  )
}

const updateCredential = async (client, credential) => {
  await client.query(
    `UPDATE cognitive_credentials
     SET name = $2, kind = $3, provider = $4, ciphertext = $5, iv = $6, auth_tag = $7, masked_fields = $8::jsonb, updated_at = NOW()
     WHERE id = $1`,
    [credential.id, credential.name, credential.kind, credential.provider || null, credential.ciphertext, credential.iv, credential.authTag, json(credential.maskedFields)]
  )
}

const audit = async (client, action, resourceType, resourceId, resourceName, details = {}) => {
  await client.query(
    `INSERT INTO cognitive_integration_audit (action, resource_type, resource_id, resource_name, details)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [action, resourceType, resourceId || null, resourceName || null, json(details)]
  )
}

const replaceBindings = async (client, agentId, mcpIds) => {
  await client.query(`DELETE FROM cognitive_agent_mcp_bindings WHERE agent_id = $1`, [agentId])
  for (const mcpId of mcpIds || []) {
    await client.query(
      `INSERT INTO cognitive_agent_mcp_bindings (agent_id, mcp_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [agentId, mcpId]
    )
  }
}

export const integrationRepository = {
  async summary() {
    const { rows } = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM cognitive_agent_registry) AS agents,
         (SELECT COUNT(*) FROM cognitive_agent_registry WHERE enabled = TRUE) AS active_agents,
         (SELECT COUNT(*) FROM cognitive_mcp_servers) AS mcps,
         (SELECT COUNT(*) FROM cognitive_mcp_servers WHERE enabled = TRUE) AS active_mcps,
         (SELECT COUNT(*) FROM cognitive_credentials) AS credentials`
    )
    const row = rows[0] || {}
    return {
      agents: Number(row.agents || 0),
      activeAgents: Number(row.active_agents || 0),
      mcps: Number(row.mcps || 0),
      activeMcps: Number(row.active_mcps || 0),
      credentials: Number(row.credentials || 0)
    }
  },

  async listModels() {
    const { rows } = await pool.query(
      `SELECT id, agent_id, provider, model_id, display_name, capabilities, settings, is_default, enabled, created_at, updated_at
       FROM cognitive_agent_models
       ORDER BY provider, is_default DESC, display_name`
    )
    return rows.map(mapModel)
  },

  async listCredentials() {
    const { rows } = await pool.query(
      `SELECT id, name, kind, provider, masked_fields, created_at, updated_at
       FROM cognitive_credentials ORDER BY updated_at DESC, name`
    )
    const usageRows = await pool.query(
      `SELECT credential_id, COUNT(*)::bigint AS usages FROM (
         SELECT credential_id FROM cognitive_agent_registry WHERE credential_id IS NOT NULL
         UNION ALL
         SELECT credential_id FROM cognitive_mcp_servers WHERE credential_id IS NOT NULL
       ) x GROUP BY credential_id`
    )
    const usages = new Map(usageRows.rows.map(row => [row.credential_id, Number(row.usages || 0)]))
    return rows.map(row => ({ ...mapCredential(row), usages: usages.get(row.id) || 0 }))
  },

  async credential(id) {
    const { rows } = await pool.query(`SELECT * FROM cognitive_credentials WHERE id = $1`, [id])
    return rows[0] || null
  },

  async credentialMetadata(id) {
    const { rows } = await pool.query(
      `SELECT id, name, kind, provider, masked_fields, created_at, updated_at FROM cognitive_credentials WHERE id = $1`,
      [id]
    )
    return rows[0] ? mapCredential(rows[0]) : null
  },

  async createCredential(credential) {
    return withTransaction(async client => {
      await insertCredential(client, credential)
      await audit(client, "created", "credential", credential.id, credential.name, { kind: credential.kind, provider: credential.provider || "" })
      return credential.id
    })
  },

  async rotateCredential(credential) {
    return withTransaction(async client => {
      const result = await client.query(`SELECT id FROM cognitive_credentials WHERE id = $1 FOR UPDATE`, [credential.id])
      if (!result.rowCount) return false
      await updateCredential(client, credential)
      await audit(client, "rotated", "credential", credential.id, credential.name, { kind: credential.kind, provider: credential.provider || "" })
      return true
    })
  },

  async credentialUsage(id) {
    const [agents, mcps] = await Promise.all([
      pool.query(`SELECT id, name FROM cognitive_agent_registry WHERE credential_id = $1 ORDER BY name`, [id]),
      pool.query(`SELECT id, name FROM cognitive_mcp_servers WHERE credential_id = $1 ORDER BY name`, [id])
    ])
    return { agents: agents.rows, mcps: mcps.rows }
  },

  async deleteCredential(id) {
    return withTransaction(async client => {
      const { rows } = await client.query(`SELECT name FROM cognitive_credentials WHERE id = $1 FOR UPDATE`, [id])
      if (!rows[0]) return false
      await client.query(`DELETE FROM cognitive_credentials WHERE id = $1`, [id])
      await audit(client, "deleted", "credential", id, rows[0].name)
      return true
    })
  },

  async listMcps() {
    const { rows } = await pool.query(
      `SELECT m.*, c.name AS credential_name, c.kind AS credential_kind, c.provider AS credential_provider, c.masked_fields AS credential_masked_fields
       FROM cognitive_mcp_servers m
       LEFT JOIN cognitive_credentials c ON c.id = m.credential_id
       ORDER BY m.updated_at DESC, m.name`
    )
    return rows.map(mapMcp)
  },

  async mcp(id) {
    const { rows } = await pool.query(
      `SELECT m.*, c.name AS credential_name, c.kind AS credential_kind, c.provider AS credential_provider, c.masked_fields AS credential_masked_fields
       FROM cognitive_mcp_servers m
       LEFT JOIN cognitive_credentials c ON c.id = m.credential_id
       WHERE m.id = $1`,
      [id]
    )
    return rows[0] ? mapMcp(rows[0]) : null
  },

  async saveMcp(mcp, credentialRecord = null, credentialIsNew = false) {
    return withTransaction(async client => {
      if (credentialRecord) {
        if (credentialIsNew) await insertCredential(client, credentialRecord)
        else await updateCredential(client, credentialRecord)
      }
      await client.query(
        `INSERT INTO cognitive_mcp_servers (
           id, name, description, transport, endpoint_url, command, args, public_headers, public_env, auth_type, credential_id, enabled
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, description = EXCLUDED.description, transport = EXCLUDED.transport,
           endpoint_url = EXCLUDED.endpoint_url, command = EXCLUDED.command, args = EXCLUDED.args,
           public_headers = EXCLUDED.public_headers, public_env = EXCLUDED.public_env, auth_type = EXCLUDED.auth_type,
           credential_id = EXCLUDED.credential_id, enabled = EXCLUDED.enabled, updated_at = NOW()`,
        [mcp.id, mcp.name, mcp.description, mcp.transport, mcp.endpointUrl || null, mcp.command || null, json(mcp.args), json(mcp.publicHeaders), json(mcp.publicEnv), mcp.authType, mcp.credentialId || null, mcp.enabled]
      )
      await audit(client, mcp.isNew ? "created" : "updated", "mcp", mcp.id, mcp.name, { transport: mcp.transport, authType: mcp.authType, enabled: mcp.enabled })
      return mcp.id
    })
  },

  async setMcpEnabled(id, enabled) {
    return withTransaction(async client => {
      const { rows } = await client.query(
        `UPDATE cognitive_mcp_servers SET enabled = $2, updated_at = NOW() WHERE id = $1 RETURNING name`,
        [id, enabled]
      )
      if (!rows[0]) return false
      await audit(client, enabled ? "enabled" : "disabled", "mcp", id, rows[0].name)
      return true
    })
  },

  async deleteMcp(id) {
    return withTransaction(async client => {
      const { rows } = await client.query(`SELECT name FROM cognitive_mcp_servers WHERE id = $1 FOR UPDATE`, [id])
      if (!rows[0]) return false
      await client.query(`DELETE FROM cognitive_mcp_servers WHERE id = $1`, [id])
      await audit(client, "deleted", "mcp", id, rows[0].name)
      return true
    })
  },

  async validateMcpIds(ids) {
    if (!ids.length) return true
    const { rows } = await pool.query(`SELECT id FROM cognitive_mcp_servers WHERE id = ANY($1::uuid[])`, [ids])
    return rows.length === new Set(ids).size
  },

  async listAgents() {
    const [agentsResult, bindingsResult, sessionResult, memoryResult] = await Promise.all([
      pool.query(
        `SELECT a.*, c.name AS credential_name, c.kind AS credential_kind, c.provider AS credential_provider, c.masked_fields AS credential_masked_fields
         FROM cognitive_agent_registry a
         LEFT JOIN cognitive_credentials c ON c.id = a.credential_id
         ORDER BY a.updated_at DESC, a.name`
      ),
      pool.query(
        `SELECT b.agent_id, m.id, m.name, m.transport, m.endpoint_url, m.command, m.enabled
         FROM cognitive_agent_mcp_bindings b
         JOIN cognitive_mcp_servers m ON m.id = b.mcp_id
         ORDER BY m.name`
      ),
      pool.query(
        `SELECT a.id AS agent_id, COUNT(s.session_id)::bigint AS sessions, COALESCE(SUM(s.observation_count), 0)::bigint AS observations,
                MAX(COALESCE(s.ended_at, s.started_at)) AS last_seen
         FROM cognitive_agent_registry a
         LEFT JOIN cognitive_sessions s
           ON s.agent_kind = COALESCE(NULLIF(a.observed_agent_kind, ''), a.name)
          AND (a.workspace IS NULL OR a.workspace = '' OR s.workspace = a.workspace)
          AND (a.project IS NULL OR a.project = '' OR s.project = a.project)
         GROUP BY a.id`
      ),
      pool.query(
        `SELECT a.id AS agent_id, COUNT(m.path)::bigint AS memories, MAX(m.source_updated_at) AS last_seen
         FROM cognitive_agent_registry a
         LEFT JOIN cognitive_memories m
           ON m.source_agent = COALESCE(NULLIF(a.observed_agent_kind, ''), a.name)
          AND (a.workspace IS NULL OR a.workspace = '' OR m.workspace = a.workspace)
          AND (a.project IS NULL OR a.project = '' OR m.project = a.project)
         GROUP BY a.id`
      )
    ])
    const bindings = new Map()
    for (const row of bindingsResult.rows) {
      const values = bindings.get(row.agent_id) || []
      values.push({ id: row.id, name: row.name, transport: row.transport, endpointUrl: row.endpoint_url || "", command: row.command || "", enabled: row.enabled === true })
      bindings.set(row.agent_id, values)
    }
    const sessionStats = new Map(sessionResult.rows.map(row => [row.agent_id, row]))
    const memoryStats = new Map(memoryResult.rows.map(row => [row.agent_id, row]))
    return agentsResult.rows.map(row => mapAgent(row, bindings, sessionStats, memoryStats))
  },

  async agent(id) {
    const agents = await this.listAgents()
    return agents.find(agent => agent.id === id) || null
  },

  async saveAgent(agent, credentialRecord = null, credentialIsNew = false) {
    return withTransaction(async client => {
      if (credentialRecord) {
        if (credentialIsNew) await insertCredential(client, credentialRecord)
        else await updateCredential(client, credentialRecord)
      }
      await client.query(
        `INSERT INTO cognitive_agent_registry (
           id, name, description, connection_type, provider, model, base_url, workspace, project,
           observed_agent_kind, credential_id, settings, enabled
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, description = EXCLUDED.description, connection_type = EXCLUDED.connection_type,
           provider = EXCLUDED.provider, model = EXCLUDED.model, base_url = EXCLUDED.base_url,
           workspace = EXCLUDED.workspace, project = EXCLUDED.project, observed_agent_kind = EXCLUDED.observed_agent_kind,
           credential_id = EXCLUDED.credential_id, settings = EXCLUDED.settings, enabled = EXCLUDED.enabled,
           updated_at = NOW()`,
        [agent.id, agent.name, agent.description, agent.connectionType, agent.provider, agent.model, agent.baseUrl || null, agent.workspace || null, agent.project || null, agent.observedAgentKind, agent.credentialId || null, json(agent.settings), agent.enabled]
      )
      await replaceBindings(client, agent.id, agent.mcpIds)
      await audit(client, agent.isNew ? "created" : "updated", "agent", agent.id, agent.name, { connectionType: agent.connectionType, provider: agent.provider, model: agent.model, enabled: agent.enabled, mcpCount: agent.mcpIds.length })
      return agent.id
    })
  },

  async setAgentEnabled(id, enabled) {
    return withTransaction(async client => {
      const { rows } = await client.query(
        `UPDATE cognitive_agent_registry SET enabled = $2, updated_at = NOW() WHERE id = $1 RETURNING name`,
        [id, enabled]
      )
      if (!rows[0]) return false
      await audit(client, enabled ? "enabled" : "disabled", "agent", id, rows[0].name)
      return true
    })
  },

  async deleteAgent(id) {
    return withTransaction(async client => {
      const { rows } = await client.query(`SELECT name FROM cognitive_agent_registry WHERE id = $1 FOR UPDATE`, [id])
      if (!rows[0]) return false
      await client.query(`DELETE FROM cognitive_agent_registry WHERE id = $1`, [id])
      await audit(client, "deleted", "agent", id, rows[0].name)
      return true
    })
  },

  async audit(limit = 100) {
    const { rows } = await pool.query(
      `SELECT id, action, resource_type, resource_id, resource_name, details, created_at
       FROM cognitive_integration_audit ORDER BY created_at DESC LIMIT $1`,
      [limit]
    )
    return rows
  }
}
