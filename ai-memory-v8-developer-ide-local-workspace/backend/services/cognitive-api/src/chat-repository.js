import { pool } from "./db.js"

const json = value => JSON.stringify(value ?? null)

const mapConversation = row => ({
  id: row.id,
  workspace: row.workspace,
  project: row.project,
  title: row.title,
  defaultAgentId: row.default_agent_id || null,
  archived: row.archived === true,
  messageCount: Number(row.message_count || 0),
  lastAgentName: row.last_agent_name || "",
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastMessageAt: row.last_message_at
})

const mapAttachment = row => ({
  id: row.id,
  conversationId: row.conversation_id,
  messageId: row.message_id || null,
  fileName: row.file_name,
  mediaType: row.media_type,
  sizeBytes: Number(row.size_bytes || 0),
  sha256: row.sha256,
  manifest: row.manifest || [],
  createdAt: row.created_at
})

const mapMessage = (row, attachments = []) => ({
  id: row.id,
  conversationId: row.conversation_id,
  role: row.role,
  agentId: row.agent_id || null,
  agentName: row.agent_name || "",
  provider: row.provider || "",
  model: row.model || "",
  content: row.content || "",
  status: row.status,
  memoryContext: row.memory_context || {},
  metadata: row.metadata || {},
  attachments,
  createdAt: row.created_at
})

const messageSelect = `SELECT m.*, a.name AS agent_name
  FROM cognitive_chat_messages m
  LEFT JOIN cognitive_agent_registry a ON a.id = m.agent_id`

const hydrateMessages = async rows => {
  if (!rows.length) return []
  const ids = rows.map(row => row.id)
  const attachmentResult = await pool.query(
    `SELECT id, conversation_id, message_id, file_name, media_type, size_bytes, sha256, manifest, created_at
     FROM cognitive_chat_attachments
     WHERE message_id = ANY($1::uuid[])
     ORDER BY created_at, file_name`,
    [ids]
  )
  const attachments = new Map()
  for (const row of attachmentResult.rows) {
    const values = attachments.get(row.message_id) || []
    values.push(mapAttachment(row))
    attachments.set(row.message_id, values)
  }
  return rows.map(row => mapMessage(row, attachments.get(row.id) || []))
}

export const chatRepository = {
  async listConversations(workspace, project) {
    const { rows } = await pool.query(
      `SELECT c.*,
              COUNT(m.id)::bigint AS message_count,
              last_agent.name AS last_agent_name
       FROM cognitive_chat_conversations c
       LEFT JOIN cognitive_chat_messages m ON m.conversation_id = c.id
       LEFT JOIN LATERAL (
         SELECT a.name
         FROM cognitive_chat_messages lm
         JOIN cognitive_agent_registry a ON a.id = lm.agent_id
         WHERE lm.conversation_id = c.id AND lm.role = 'assistant'
         ORDER BY lm.created_at DESC, lm.id DESC
         LIMIT 1
       ) last_agent ON TRUE
       WHERE c.workspace = $1 AND c.project = $2 AND c.archived = FALSE
       GROUP BY c.id, last_agent.name
       ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC`,
      [workspace, project]
    )
    return rows.map(mapConversation)
  },

  async conversation(id) {
    const { rows } = await pool.query(
      `SELECT c.*,
              (SELECT COUNT(*)::bigint FROM cognitive_chat_messages m WHERE m.conversation_id = c.id) AS message_count,
              (SELECT a.name
               FROM cognitive_chat_messages lm
               JOIN cognitive_agent_registry a ON a.id = lm.agent_id
               WHERE lm.conversation_id = c.id AND lm.role = 'assistant'
               ORDER BY lm.created_at DESC, lm.id DESC LIMIT 1) AS last_agent_name
       FROM cognitive_chat_conversations c
       WHERE c.id = $1`,
      [id]
    )
    return rows[0] ? mapConversation(rows[0]) : null
  },

  async createConversation(conversation) {
    await pool.query(
      `INSERT INTO cognitive_chat_conversations (id, workspace, project, title, default_agent_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [conversation.id, conversation.workspace, conversation.project, conversation.title, conversation.defaultAgentId || null]
    )
    return this.conversation(conversation.id)
  },

  async updateConversation(id, values) {
    const { rows } = await pool.query(
      `UPDATE cognitive_chat_conversations
       SET title = COALESCE($2, title),
           default_agent_id = CASE WHEN $3::boolean THEN $4::uuid ELSE default_agent_id END,
           archived = COALESCE($5, archived),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, values.title ?? null, values.setDefaultAgent === true, values.defaultAgentId || null, values.archived ?? null]
    )
    return rows[0] ? this.conversation(id) : null
  },

  async deleteConversation(id) {
    const result = await pool.query(`DELETE FROM cognitive_chat_conversations WHERE id = $1`, [id])
    return result.rowCount > 0
  },

  async messages(conversationId, limit = 200) {
    const { rows } = await pool.query(
      `${messageSelect}
       WHERE m.conversation_id = $1
       ORDER BY m.created_at ASC, m.id ASC
       LIMIT $2`,
      [conversationId, limit]
    )
    return hydrateMessages(rows)
  },

  async message(id, conversationId) {
    const { rows } = await pool.query(
      `${messageSelect}
       WHERE m.id = $1 AND m.conversation_id = $2
       LIMIT 1`,
      [id, conversationId]
    )
    const values = await hydrateMessages(rows)
    return values[0] || null
  },

  async recentMessages(conversationId, limit) {
    const { rows } = await pool.query(
      `${messageSelect}
       WHERE m.conversation_id = $1 AND m.status = 'completed'
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT $2`,
      [conversationId, limit]
    )
    const values = await hydrateMessages(rows.reverse())
    return values
  },

  async insertMessage(message) {
    const { rows } = await pool.query(
      `INSERT INTO cognitive_chat_messages (
         id, conversation_id, role, agent_id, provider, model, content, status, memory_context, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)
       RETURNING *`,
      [message.id, message.conversationId, message.role, message.agentId || null, message.provider || null, message.model || null, message.content || "", message.status || "completed", json(message.memoryContext || {}), json(message.metadata || {})]
    )
    await pool.query(
      `UPDATE cognitive_chat_conversations
       SET last_message_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [message.conversationId]
    )
    const hydrated = await hydrateMessages(rows)
    return hydrated[0]
  },

  async updateMessage(id, values) {
    const { rows } = await pool.query(
      `UPDATE cognitive_chat_messages
       SET content = COALESCE($2, content),
           status = COALESCE($3, status),
           memory_context = COALESCE($4::jsonb, memory_context),
           metadata = CASE WHEN $5::jsonb IS NULL THEN metadata ELSE metadata || $5::jsonb END
       WHERE id = $1
       RETURNING *`,
      [id, values.content ?? null, values.status ?? null, values.memoryContext === undefined ? null : json(values.memoryContext), values.metadata === undefined ? null : json(values.metadata)]
    )
    if (!rows[0]) return null
    const hydrated = await hydrateMessages(rows)
    return hydrated[0]
  },

  async linkAttachments(conversationId, messageId, attachmentIds) {
    if (!attachmentIds.length) return []
    const { rows } = await pool.query(
      `UPDATE cognitive_chat_attachments
       SET message_id = $2
       WHERE conversation_id = $1 AND message_id IS NULL AND id = ANY($3::uuid[])
       RETURNING id, conversation_id, message_id, file_name, media_type, size_bytes, sha256, manifest, created_at`,
      [conversationId, messageId, attachmentIds]
    )
    if (rows.length !== new Set(attachmentIds).size) {
      throw Object.assign(new Error("one or more attachments are invalid or already linked"), { status: 409 })
    }
    return rows.map(mapAttachment)
  },

  async saveAttachment(attachment) {
    const { rows } = await pool.query(
      `INSERT INTO cognitive_chat_attachments (
         id, conversation_id, file_name, media_type, size_bytes, sha256, content, manifest, text_context
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
       RETURNING id, conversation_id, message_id, file_name, media_type, size_bytes, sha256, manifest, created_at`,
      [attachment.id, attachment.conversationId, attachment.fileName, attachment.mediaType, attachment.sizeBytes, attachment.sha256, attachment.content, json(attachment.manifest), attachment.textContext]
    )
    return mapAttachment(rows[0])
  },

  async attachment(id) {
    const { rows } = await pool.query(
      `SELECT id, conversation_id, message_id, file_name, media_type, size_bytes, sha256, manifest, text_context, created_at
       FROM cognitive_chat_attachments WHERE id = $1`,
      [id]
    )
    return rows[0] ? { ...mapAttachment(rows[0]), textContext: rows[0].text_context || "" } : null
  },

  async attachmentContent(id) {
    const { rows } = await pool.query(
      `SELECT id, conversation_id, message_id, file_name, media_type, size_bytes, sha256, content, manifest, created_at
       FROM cognitive_chat_attachments WHERE id = $1`,
      [id]
    )
    if (!rows[0]) return null
    return { ...mapAttachment(rows[0]), content: rows[0].content }
  },

  async conversationAttachments(conversationId) {
    const { rows } = await pool.query(
      `SELECT id, conversation_id, message_id, file_name, media_type, size_bytes, sha256, content, manifest, created_at
       FROM cognitive_chat_attachments WHERE conversation_id = $1 ORDER BY created_at, file_name`,
      [conversationId]
    )
    return rows.map(row => ({ ...mapAttachment(row), content: row.content }))
  },

  async relevantMessages(workspace, project, query, excludedMessageIds, limit) {
    const excluded = [...new Set(excludedMessageIds || [])]
    const { rows } = await pool.query(
      `SELECT m.id, m.conversation_id, m.role, m.content, m.provider, m.model, m.created_at,
              c.title,
              ts_rank_cd(to_tsvector('simple', COALESCE(m.content, '')), plainto_tsquery('simple', $3)) AS rank
       FROM cognitive_chat_messages m
       JOIN cognitive_chat_conversations c ON c.id = m.conversation_id
       WHERE c.workspace = $1 AND c.project = $2 AND c.archived = FALSE
         AND NOT (m.id = ANY($4::uuid[]))
         AND m.status = 'completed' AND m.role IN ('user', 'assistant')
         AND to_tsvector('simple', COALESCE(m.content, '')) @@ plainto_tsquery('simple', $3)
       ORDER BY rank DESC, m.created_at DESC
       LIMIT $5`,
      [workspace, project, query, excluded, limit]
    )
    if (rows.length) return rows.map(row => ({ ...row, rank: Number(row.rank || 0) }))
    const fallback = await pool.query(
      `SELECT m.id, m.conversation_id, m.role, m.content, m.provider, m.model, m.created_at, c.title, 0::double precision AS rank
       FROM cognitive_chat_messages m
       JOIN cognitive_chat_conversations c ON c.id = m.conversation_id
       WHERE c.workspace = $1 AND c.project = $2 AND c.archived = FALSE
         AND NOT (m.id = ANY($3::uuid[]))
         AND m.status = 'completed' AND m.role IN ('user', 'assistant')
       ORDER BY m.created_at DESC
       LIMIT $4`,
      [workspace, project, excluded, limit]
    )
    return fallback.rows.map(row => ({ ...row, rank: 0 }))
  },

  async agentState(conversationId, agentId) {
    const { rows } = await pool.query(
      `SELECT conversation_id, agent_id, external_thread_id, external_run_id, metadata, updated_at
       FROM cognitive_chat_agent_state WHERE conversation_id = $1 AND agent_id = $2`,
      [conversationId, agentId]
    )
    return rows[0] || null
  },

  async saveAgentState(state) {
    await pool.query(
      `INSERT INTO cognitive_chat_agent_state (conversation_id, agent_id, external_thread_id, external_run_id, metadata)
       VALUES ($1,$2,$3,$4,$5::jsonb)
       ON CONFLICT (conversation_id, agent_id) DO UPDATE SET
         external_thread_id = EXCLUDED.external_thread_id,
         external_run_id = EXCLUDED.external_run_id,
         metadata = cognitive_chat_agent_state.metadata || EXCLUDED.metadata,
         updated_at = NOW()`,
      [state.conversationId, state.agentId, state.externalThreadId || null, state.externalRunId || null, json(state.metadata || {})]
    )
    return this.agentState(state.conversationId, state.agentId)
  }
}
