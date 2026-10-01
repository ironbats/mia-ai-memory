import { pool } from "./db.js"

const mapSkill = row => row ? ({
  id: row.id,
  workspace: row.workspace,
  project: row.project,
  name: row.name,
  fileName: row.file_name,
  content: row.content,
  sha256: row.sha256,
  enabled: Boolean(row.enabled),
  createdAt: row.created_at,
  updatedAt: row.updated_at
}) : null

export const skillRepository = {
  async list(workspace, project) {
    const { rows } = await pool.query(
      `SELECT id, workspace, project, name, file_name, content, sha256, enabled, created_at, updated_at
       FROM cognitive_chat_skills
       WHERE workspace = $1 AND project = $2
       ORDER BY enabled DESC, updated_at DESC, name`,
      [workspace, project]
    )
    return rows.map(mapSkill)
  },

  async active(workspace, project) {
    const { rows } = await pool.query(
      `SELECT id, workspace, project, name, file_name, content, sha256, enabled, created_at, updated_at
       FROM cognitive_chat_skills
       WHERE workspace = $1 AND project = $2 AND enabled = TRUE
       ORDER BY updated_at DESC, name`,
      [workspace, project]
    )
    return rows.map(mapSkill)
  },

  async skill(id) {
    const { rows } = await pool.query(
      `SELECT id, workspace, project, name, file_name, content, sha256, enabled, created_at, updated_at
       FROM cognitive_chat_skills WHERE id = $1`,
      [id]
    )
    return mapSkill(rows[0])
  },

  async upsert(skill) {
    const { rows } = await pool.query(
      `INSERT INTO cognitive_chat_skills (id, workspace, project, name, file_name, content, sha256, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE)
       ON CONFLICT (workspace, project, file_name) DO UPDATE SET
         name = EXCLUDED.name,
         content = EXCLUDED.content,
         sha256 = EXCLUDED.sha256,
         enabled = TRUE,
         updated_at = NOW()
       RETURNING id, workspace, project, name, file_name, content, sha256, enabled, created_at, updated_at`,
      [skill.id, skill.workspace, skill.project, skill.name, skill.fileName, skill.content, skill.sha256]
    )
    return mapSkill(rows[0])
  },

  async setEnabled(id, enabled) {
    const { rows } = await pool.query(
      `UPDATE cognitive_chat_skills SET enabled = $2, updated_at = NOW()
       WHERE id = $1
       RETURNING id, workspace, project, name, file_name, content, sha256, enabled, created_at, updated_at`,
      [id, enabled]
    )
    return mapSkill(rows[0])
  },

  async delete(id) {
    const result = await pool.query(`DELETE FROM cognitive_chat_skills WHERE id = $1`, [id])
    return result.rowCount > 0
  }
}
