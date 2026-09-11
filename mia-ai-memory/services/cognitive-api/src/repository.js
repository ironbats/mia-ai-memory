import { pool } from "./db.js"

const json = value => JSON.stringify(value ?? null)

export const repository = {
  async ping() {
    await pool.query(`SELECT 1`)
    return true
  },

  async beginSync(runId, workspace, project) {
    await pool.query(
      `INSERT INTO cognitive_sync_runs (run_id, workspace, project, status) VALUES ($1, $2, $3, 'running')`,
      [runId, workspace || null, project || null]
    )
  },

  async finishSync(runId, status, error = null) {
    await pool.query(
      `UPDATE cognitive_sync_runs SET status = $2, error = $3, finished_at = NOW() WHERE run_id = $1`,
      [runId, status, error]
    )
  },

  async latestSync(workspace = null, project = null) {
    if (workspace && project) {
      const { rows } = await pool.query(
        `SELECT * FROM cognitive_sync_runs
         WHERE (workspace = $1 AND project = $2) OR (workspace IS NULL AND project IS NULL)
         ORDER BY started_at DESC LIMIT 1`,
        [workspace, project]
      )
      return rows[0] || null
    }
    const { rows } = await pool.query(`SELECT * FROM cognitive_sync_runs ORDER BY started_at DESC LIMIT 1`)
    return rows[0] || null
  },

  async upsertScope(scope) {
    await pool.query(
      `INSERT INTO cognitive_scopes (workspace, project, page_count, last_updated, synced_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (workspace, project) DO UPDATE SET page_count = EXCLUDED.page_count, last_updated = EXCLUDED.last_updated, synced_at = NOW()`,
      [scope.workspace, scope.project, scope.pageCount || 0, scope.lastUpdated || null]
    )
  },

  async memoryVersions(workspace, project) {
    const { rows } = await pool.query(
      `SELECT path, source_updated_at FROM cognitive_memories WHERE workspace = $1 AND project = $2`,
      [workspace, project]
    )
    return new Map(rows.map(row => [row.path, row.source_updated_at?.toISOString?.() || row.source_updated_at || null]))
  },

  async upsertMemory(memory, runId) {
    const values = [
      memory.workspace,
      memory.project,
      memory.path,
      memory.title,
      memory.kind,
      memory.tier,
      memory.pinned,
      memory.createdAt,
      memory.updatedAt,
      memory.sourceSessionId,
      memory.sourceAgent,
      json(memory.provenance || {}),
      json(memory.frontmatter || {}),
      memory.bodyMarkdown || "",
      runId
    ]
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      if (memory.updatedAt) {
        await client.query(
          `INSERT INTO cognitive_memory_versions (
             workspace, project, path, title, kind, tier, source_updated_at, source_session_id, source_agent, provenance, frontmatter, body_markdown
           ) VALUES ($1,$2,$3,$4,$5,$6,$9,$10,$11,$12::jsonb,$13::jsonb,$14)
           ON CONFLICT (workspace, project, path, source_updated_at) DO NOTHING`,
          values.slice(0, 14)
        )
      }
      await client.query(
        `INSERT INTO cognitive_memories (
           workspace, project, path, title, kind, tier, pinned, created_at, source_updated_at,
           source_session_id, source_agent, provenance, frontmatter, body_markdown, last_sync_run_id, synced_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15,NOW())
         ON CONFLICT (workspace, project, path) DO UPDATE SET
           title = EXCLUDED.title, kind = EXCLUDED.kind, tier = EXCLUDED.tier, pinned = EXCLUDED.pinned,
           created_at = EXCLUDED.created_at, source_updated_at = EXCLUDED.source_updated_at,
           source_session_id = EXCLUDED.source_session_id, source_agent = EXCLUDED.source_agent,
           provenance = EXCLUDED.provenance, frontmatter = EXCLUDED.frontmatter, body_markdown = EXCLUDED.body_markdown,
           last_sync_run_id = EXCLUDED.last_sync_run_id, synced_at = NOW()`,
        values
      )
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  },

  async replaceRelations(workspace, project, fromPath, relations, runId) {
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query(
        `DELETE FROM cognitive_relations WHERE workspace = $1 AND project = $2 AND from_path = $3 AND relation_type <> 'cross-project'`,
        [workspace, project, fromPath]
      )
      for (const relation of relations) {
        await client.query(
          `INSERT INTO cognitive_relations (
             workspace, project, from_path, relation_type, to_workspace, to_project, to_path, resolved, last_sync_run_id, synced_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
           ON CONFLICT (workspace, project, from_path, relation_type, to_workspace, to_project, to_path)
           DO UPDATE SET resolved = EXCLUDED.resolved, last_sync_run_id = EXCLUDED.last_sync_run_id, synced_at = NOW()`,
          [workspace, project, fromPath, relation.type, relation.toWorkspace, relation.toProject, relation.toPath, relation.resolved, runId]
        )
      }
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  },

  async pruneMemories(workspace, project, paths) {
    if (!paths.length) {
      await pool.query(`DELETE FROM cognitive_memories WHERE workspace = $1 AND project = $2`, [workspace, project])
      await pool.query(`DELETE FROM cognitive_relations WHERE workspace = $1 AND project = $2 AND relation_type <> 'cross-project'`, [workspace, project])
      return
    }
    await pool.query(
      `DELETE FROM cognitive_memories WHERE workspace = $1 AND project = $2 AND NOT (path = ANY($3::text[]))`,
      [workspace, project, paths]
    )
    await pool.query(
      `DELETE FROM cognitive_relations WHERE workspace = $1 AND project = $2 AND relation_type <> 'cross-project' AND NOT (from_path = ANY($3::text[]))`,
      [workspace, project, paths]
    )
  },

  async upsertSessions(workspace, project, sessions, runId) {
    for (const session of sessions) {
      await pool.query(
        `INSERT INTO cognitive_sessions (
           workspace, project, session_id, agent_kind, cwd, started_at, ended_at, observation_count, actor_user, last_sync_run_id, synced_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
         ON CONFLICT (workspace, project, session_id) DO UPDATE SET
           agent_kind = EXCLUDED.agent_kind, cwd = EXCLUDED.cwd, started_at = EXCLUDED.started_at,
           ended_at = EXCLUDED.ended_at, observation_count = EXCLUDED.observation_count,
           actor_user = EXCLUDED.actor_user, last_sync_run_id = EXCLUDED.last_sync_run_id, synced_at = NOW()`,
        [workspace, project, session.session_id, session.agent_kind, session.cwd, session.started_at, session.ended_at, session.observation_count || 0, session.actor_user, runId]
      )
    }
  },

  async pruneSessions(workspace, project, runId) {
    await pool.query(
      `DELETE FROM cognitive_sessions WHERE workspace = $1 AND project = $2 AND last_sync_run_id IS DISTINCT FROM $3`,
      [workspace, project, runId]
    )
  },

  async upsertHandoffs(workspace, project, handoffs, runId) {
    for (const handoff of handoffs) {
      await pool.query(
        `INSERT INTO cognitive_handoffs (
           workspace, project, handoff_id, agent, state, created_at, summary, open_questions, next_steps,
           files_touched, cwd, owner_name, accepted_by, accepted_at, redacted, last_sync_run_id, synced_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16,NOW())
         ON CONFLICT (workspace, project, handoff_id) DO UPDATE SET
           agent = EXCLUDED.agent, state = EXCLUDED.state, created_at = EXCLUDED.created_at, summary = EXCLUDED.summary,
           open_questions = EXCLUDED.open_questions, next_steps = EXCLUDED.next_steps, files_touched = EXCLUDED.files_touched,
           cwd = EXCLUDED.cwd, owner_name = EXCLUDED.owner_name, accepted_by = EXCLUDED.accepted_by,
           accepted_at = EXCLUDED.accepted_at, redacted = EXCLUDED.redacted,
           last_sync_run_id = EXCLUDED.last_sync_run_id, synced_at = NOW()`,
        [workspace, project, handoff.id, handoff.agent, handoff.state, handoff.at, handoff.summary, json(handoff.open_questions || []), json(handoff.next_steps || []), json(handoff.files_touched || []), handoff.cwd, handoff.owner, handoff.accepted_by, handoff.accepted_at, handoff.redacted === true, runId]
      )
    }
  },

  async resetHealthFlags(workspace, project) {
    await pool.query(
      `UPDATE cognitive_memories SET stale = FALSE, duplicate = FALSE, orphan = FALSE, contradiction = FALSE WHERE workspace = $1 AND project = $2`,
      [workspace, project]
    )
  },

  async markHealth(workspace, project, health) {
    const mark = async (field, pages) => {
      for (const page of pages || []) {
        const targetWorkspace = page.workspace || workspace
        const targetProject = page.project || project
        await pool.query(
          `UPDATE cognitive_memories SET ${field} = TRUE WHERE workspace = $1 AND project = $2 AND path = $3`,
          [targetWorkspace, targetProject, page.path]
        )
      }
    }
    await mark("stale", health.stale_pages)
    await mark("duplicate", health.duplicate_pages)
    await mark("orphan", health.orphan_pages)
    for (const item of health.contradiction_pages || []) {
      await pool.query(
        `UPDATE cognitive_memories SET contradiction = TRUE WHERE workspace = $1 AND project = $2 AND path IN ($3, $4)`,
        [item.workspace || workspace, item.project || project, item.from_path, item.to_path]
      )
    }
  },

  async insertHealth(workspace, project, health) {
    const total = await this.memoryCount(workspace, project)
    const issues = Number(health.stale || 0) + Number(health.duplicates || 0) + Number(health.orphans || 0) + Number(health.contradictions || 0) * 2
    const denominator = Math.max(1, total * 2)
    const score = Math.max(0, Math.min(100, Math.round(100 - issues / denominator * 100)))
    await pool.query(
      `INSERT INTO cognitive_health_snapshots (workspace, project, score, stale, duplicates, contradictions, orphans, details)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8::jsonb
       WHERE NOT EXISTS (
         SELECT 1 FROM cognitive_health_snapshots
         WHERE workspace = $1 AND project = $2
           AND score = $3 AND stale = $4 AND duplicates = $5 AND contradictions = $6 AND orphans = $7
           AND captured_at > NOW() - INTERVAL '5 minutes'
       )`,
      [workspace, project, score, health.stale || 0, health.duplicates || 0, health.contradictions || 0, health.orphans || 0, json(health)]
    )
    return score
  },

  async upsertClientActivity(clients) {
    for (const client of clients || []) {
      await pool.query(
        `INSERT INTO cognitive_client_activity (client, reads, writes, synced_at) VALUES ($1,$2,$3,NOW())
         ON CONFLICT (client) DO UPDATE SET reads = EXCLUDED.reads, writes = EXCLUDED.writes, synced_at = NOW()`,
        [client.client, client.reads || 0, client.writes || 0]
      )
    }
  },

  async replaceCrossProjectEdges(edges, runId) {
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query(`DELETE FROM cognitive_relations WHERE relation_type = 'cross-project'`)
      for (const edge of edges || []) {
        await client.query(
          `INSERT INTO cognitive_relations (
             workspace, project, from_path, relation_type, to_workspace, to_project, to_path, resolved, last_sync_run_id, synced_at
           ) VALUES ($1,$2,$3,'cross-project',$4,$5,$6,TRUE,$7,NOW())
           ON CONFLICT (workspace, project, from_path, relation_type, to_workspace, to_project, to_path)
           DO UPDATE SET resolved = TRUE, last_sync_run_id = EXCLUDED.last_sync_run_id, synced_at = NOW()`,
          [edge.from_workspace, edge.from_project, edge.from_path, edge.to_workspace, edge.to_project, edge.to_path, runId]
        )
      }
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  },

  async pruneScopes(activeScopes) {
    const active = new Set(activeScopes.map(scope => `${scope.workspace}\u0000${scope.project}`))
    const { rows } = await pool.query(`SELECT workspace, project FROM cognitive_scopes`)
    const stale = rows.filter(row => !active.has(`${row.workspace}\u0000${row.project}`))
    if (!stale.length) return
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      for (const scope of stale) {
        const values = [scope.workspace, scope.project]
        await client.query(`DELETE FROM cognitive_memories WHERE workspace = $1 AND project = $2`, values)
        await client.query(`DELETE FROM cognitive_relations WHERE workspace = $1 AND project = $2`, values)
        await client.query(`DELETE FROM cognitive_sessions WHERE workspace = $1 AND project = $2`, values)
        await client.query(`DELETE FROM cognitive_handoffs WHERE workspace = $1 AND project = $2`, values)
        await client.query(`DELETE FROM cognitive_scopes WHERE workspace = $1 AND project = $2`, values)
      }
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  },

  async memoryCount(workspace, project) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::bigint AS total FROM cognitive_memories WHERE workspace = $1 AND project = $2`,
      [workspace, project]
    )
    return Number(rows[0]?.total || 0)
  },

  async scopes() {
    const { rows } = await pool.query(`SELECT * FROM cognitive_scopes ORDER BY last_updated DESC NULLS LAST, workspace, project`)
    return rows
  },

  async summary(workspace, project) {
    const [{ rows: memoryRows }, { rows: sessionRows }, { rows: handoffRows }, { rows: healthRows }, sync] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::bigint AS total,
                COUNT(*) FILTER (WHERE stale)::bigint AS stale,
                COUNT(*) FILTER (WHERE duplicate)::bigint AS duplicates,
                COUNT(*) FILTER (WHERE orphan)::bigint AS orphans,
                COUNT(*) FILTER (WHERE contradiction)::bigint AS contradictions,
                COUNT(*) FILTER (WHERE source_session_id IS NOT NULL)::bigint AS with_provenance
         FROM cognitive_memories WHERE workspace = $1 AND project = $2`,
        [workspace, project]
      ),
      pool.query(`SELECT COUNT(*)::bigint AS total, COALESCE(SUM(observation_count), 0)::bigint AS observations FROM cognitive_sessions WHERE workspace = $1 AND project = $2`, [workspace, project]),
      pool.query(`SELECT COUNT(*)::bigint AS total, COUNT(*) FILTER (WHERE state = 'open')::bigint AS open FROM cognitive_handoffs WHERE workspace = $1 AND project = $2`, [workspace, project]),
      pool.query(`SELECT * FROM cognitive_health_snapshots WHERE workspace = $1 AND project = $2 ORDER BY captured_at DESC LIMIT 1`, [workspace, project]),
      this.latestSync(workspace, project)
    ])
    const memories = memoryRows[0] || {}
    return {
      workspace,
      project,
      memories: Object.fromEntries(Object.entries(memories).map(([key, value]) => [key, Number(value || 0)])),
      sessions: { total: Number(sessionRows[0]?.total || 0), observations: Number(sessionRows[0]?.observations || 0) },
      handoffs: { total: Number(handoffRows[0]?.total || 0), open: Number(handoffRows[0]?.open || 0) },
      health: healthRows[0] || null,
      sync
    }
  },

  async health(workspace, project) {
    const [{ rows: latest }, { rows: flagged }] = await Promise.all([
      pool.query(`SELECT * FROM cognitive_health_snapshots WHERE workspace = $1 AND project = $2 ORDER BY captured_at DESC LIMIT 1`, [workspace, project]),
      pool.query(
        `SELECT path, title, kind, tier, stale, duplicate, orphan, contradiction, source_updated_at
         FROM cognitive_memories
         WHERE workspace = $1 AND project = $2 AND (stale OR duplicate OR orphan OR contradiction)
         ORDER BY contradiction DESC, stale DESC, duplicate DESC, orphan DESC, source_updated_at DESC NULLS LAST
         LIMIT 200`,
        [workspace, project]
      )
    ])
    return { snapshot: latest[0] || null, flagged }
  },

  async agents(workspace, project) {
    const { rows } = await pool.query(
      `WITH names AS (
         SELECT agent_kind AS agent FROM cognitive_sessions WHERE workspace = $1 AND project = $2
         UNION
         SELECT source_agent AS agent FROM cognitive_memories WHERE workspace = $1 AND project = $2 AND source_agent IS NOT NULL
       )
       SELECT n.agent,
              COALESCE((SELECT COUNT(*) FROM cognitive_sessions s WHERE s.workspace = $1 AND s.project = $2 AND s.agent_kind = n.agent), 0)::bigint AS sessions,
              COALESCE((SELECT SUM(observation_count) FROM cognitive_sessions s WHERE s.workspace = $1 AND s.project = $2 AND s.agent_kind = n.agent), 0)::bigint AS observations,
              COALESCE((SELECT COUNT(*) FROM cognitive_memories m WHERE m.workspace = $1 AND m.project = $2 AND m.source_agent = n.agent), 0)::bigint AS memories,
              (SELECT MAX(started_at) FROM cognitive_sessions s WHERE s.workspace = $1 AND s.project = $2 AND s.agent_kind = n.agent) AS last_seen
       FROM names n
       WHERE n.agent IS NOT NULL
       ORDER BY memories DESC, sessions DESC, n.agent`,
      [workspace, project]
    )
    return rows.map(row => ({ ...row, sessions: Number(row.sessions), observations: Number(row.observations), memories: Number(row.memories) }))
  },

  async clients() {
    const { rows } = await pool.query(`SELECT * FROM cognitive_client_activity ORDER BY reads + writes DESC, client`)
    return rows.map(row => ({ ...row, reads: Number(row.reads), writes: Number(row.writes) }))
  },

  async memories(workspace, project, limit, offset) {
    const { rows } = await pool.query(
      `SELECT workspace, project, path, title, kind, tier, pinned, created_at, source_updated_at, source_session_id, source_agent,
              provenance, stale, duplicate, orphan, contradiction
       FROM cognitive_memories WHERE workspace = $1 AND project = $2
       ORDER BY source_updated_at DESC NULLS LAST, path LIMIT $3 OFFSET $4`,
      [workspace, project, limit, offset]
    )
    return rows
  },

  async memory(workspace, project, path) {
    const [{ rows }, { rows: relations }] = await Promise.all([
      pool.query(`SELECT * FROM cognitive_memories WHERE workspace = $1 AND project = $2 AND path = $3`, [workspace, project, path]),
      pool.query(`SELECT * FROM cognitive_relations WHERE workspace = $1 AND project = $2 AND from_path = $3 ORDER BY relation_type, to_path`, [workspace, project, path])
    ])
    return rows[0] ? { ...rows[0], relations } : null
  },

  async brain(workspace, project, limit) {
    const [{ rows: memories }, { rows: relations }, { rows: sessions }] = await Promise.all([
      pool.query(
        `SELECT workspace, project, path, title, kind, tier, pinned, source_session_id, source_agent, frontmatter,
                stale, duplicate, orphan, contradiction, source_updated_at
         FROM cognitive_memories WHERE workspace = $1 AND project = $2
         ORDER BY pinned DESC, source_updated_at DESC NULLS LAST LIMIT $3`,
        [workspace, project, limit]
      ),
      pool.query(
        `SELECT * FROM cognitive_relations WHERE workspace = $1 AND project = $2 ORDER BY relation_type, from_path LIMIT $3`,
        [workspace, project, Math.max(limit * 6, 1000)]
      ),
      pool.query(
        `SELECT session_id, agent_kind, observation_count, started_at, ended_at FROM cognitive_sessions
         WHERE workspace = $1 AND project = $2 ORDER BY started_at DESC NULLS LAST LIMIT $3`,
        [workspace, project, limit]
      )
    ])
    return { memories, relations, sessions }
  },


  async handoffs(workspace, project, limit) {
    const { rows } = await pool.query(
      `SELECT handoff_id, agent, state, created_at, summary, open_questions, next_steps, files_touched, cwd, owner_name, accepted_by, accepted_at, redacted
       FROM cognitive_handoffs
       WHERE workspace = $1 AND project = $2
       ORDER BY created_at DESC NULLS LAST, handoff_id
       LIMIT $3`,
      [workspace, project, limit]
    )
    return rows
  },

  async activity(workspace, project, limit) {
    const { rows } = await pool.query(
      `SELECT * FROM (
         SELECT 'memory'::text AS event_type, source_updated_at AS event_at, title AS label, path AS detail, source_agent AS actor, source_session_id AS reference_id
         FROM cognitive_memories WHERE workspace = $1 AND project = $2 AND source_updated_at IS NOT NULL
         UNION ALL
         SELECT 'session'::text, COALESCE(ended_at, started_at), session_id, CONCAT(observation_count, ' observations'), agent_kind, session_id
         FROM cognitive_sessions WHERE workspace = $1 AND project = $2 AND COALESCE(ended_at, started_at) IS NOT NULL
         UNION ALL
         SELECT 'handoff'::text, created_at, COALESCE(summary, handoff_id), state, agent, handoff_id
         FROM cognitive_handoffs WHERE workspace = $1 AND project = $2 AND created_at IS NOT NULL
       ) events
       ORDER BY event_at DESC NULLS LAST
       LIMIT $3`,
      [workspace, project, limit]
    )
    return rows
  },

  async evolution(workspace, project, path, limit) {
    const { rows } = await pool.query(
      `SELECT id, path, title, kind, tier, source_updated_at, source_session_id, source_agent, provenance, frontmatter, body_markdown, captured_at
       FROM cognitive_memory_versions
       WHERE workspace = $1 AND project = $2 AND path = $3
       ORDER BY source_updated_at DESC, id DESC
       LIMIT $4`,
      [workspace, project, path, limit]
    )
    return rows
  },

  async optimizations(workspace, project, limit) {
    const { rows } = await pool.query(
      `SELECT path, title, kind, tier, source_updated_at, source_agent, source_session_id, stale, duplicate, orphan, contradiction,
              CASE
                WHEN contradiction THEN 'critical'
                WHEN stale OR duplicate THEN 'high'
                WHEN orphan OR source_session_id IS NULL THEN 'medium'
                ELSE 'low'
              END AS priority,
              CASE
                WHEN contradiction THEN 'resolve-contradiction'
                WHEN stale THEN 'refresh-stale-memory'
                WHEN duplicate THEN 'merge-duplicate-memory'
                WHEN orphan THEN 'link-or-remove-orphan'
                WHEN source_session_id IS NULL THEN 'add-provenance'
                ELSE 'review'
              END AS action
       FROM cognitive_memories
       WHERE workspace = $1 AND project = $2
         AND (contradiction OR stale OR duplicate OR orphan OR source_session_id IS NULL)
       ORDER BY
         CASE WHEN contradiction THEN 0 WHEN stale THEN 1 WHEN duplicate THEN 2 WHEN orphan THEN 3 ELSE 4 END,
         source_updated_at ASC NULLS FIRST
       LIMIT $3`,
      [workspace, project, limit]
    )
    return rows
  },

  async insertRetrievalTrace(workspace, project, query, hits) {
    for (const hit of hits || []) {
      await pool.query(
        `INSERT INTO cognitive_retrieval_traces (workspace, project, query, path, title, kind, rank, explanation)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [workspace, project, query, hit.path, hit.title, hit.kind, hit.rank, json(hit.explain || {})]
      )
    }
  },

  async recentTraces(workspace, project, limit) {
    const { rows } = await pool.query(
      `SELECT * FROM cognitive_retrieval_traces WHERE workspace = $1 AND project = $2 ORDER BY created_at DESC LIMIT $3`,
      [workspace, project, limit]
    )
    return rows
  }
}
