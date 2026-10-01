import { createHash, randomUUID } from "node:crypto"
import { config } from "./config.js"
import { skillRepository } from "./skill-repository.js"

const failure = (message, status = 400) => Object.assign(new Error(message), { status, expose: true })

const text = (value, name, max, required = false) => {
  const normalized = String(value ?? "").trim()
  if (required && !normalized) throw failure(`${name} is required`)
  if (normalized.length > max) throw failure(`${name} is too long`)
  return normalized
}

const scope = (workspace, project) => ({
  workspace: text(workspace, "workspace", 180, true),
  project: text(project, "project", 180, true)
})

const markdownName = (fileName, content) => {
  const heading = String(content || "").split(/\r?\n/).map(line => line.match(/^\s*#\s+(.+?)\s*$/)?.[1]?.trim()).find(Boolean)
  return text(heading || fileName.replace(/\.md$/i, ""), "skill name", 160, true)
}

const publicSkill = skill => ({
  id: skill.id,
  workspace: skill.workspace,
  project: skill.project,
  name: skill.name,
  fileName: skill.fileName,
  sha256: skill.sha256,
  enabled: skill.enabled,
  sizeBytes: Buffer.byteLength(skill.content || "", "utf8"),
  createdAt: skill.createdAt,
  updatedAt: skill.updatedAt
})

const scopedSkill = async (id, workspace, project) => {
  const skill = await skillRepository.skill(text(id, "skill id", 64, true))
  if (!skill || skill.workspace !== workspace || skill.project !== project) throw failure("skill not found", 404)
  return skill
}

const skillBytes = skill => Buffer.byteLength(skill?.content || "", "utf8")

const assertActiveCapacity = (skills, candidate = null) => {
  const bytes = skills.filter(skill => skill.enabled && skill.id !== candidate?.id).reduce((total, skill) => total + skillBytes(skill), 0) + (candidate ? skillBytes(candidate) : 0)
  if (bytes > config.chatSkillContextMaxBytes) throw failure(`active Skills exceed the configured context limit of ${config.chatSkillContextMaxBytes} bytes; disable another Skill or reduce the Markdown content`, 409)
  return bytes
}

export const skillService = {
  async list(workspaceValue, projectValue) {
    const values = scope(workspaceValue, projectValue)
    return (await skillRepository.list(values.workspace, values.project)).map(publicSkill)
  },

  async active(workspaceValue, projectValue) {
    const values = scope(workspaceValue, projectValue)
    const skills = await skillRepository.active(values.workspace, values.project)
    assertActiveCapacity(skills)
    return skills
  },

  async upload(workspaceValue, projectValue, fileNameValue, buffer) {
    const values = scope(workspaceValue, projectValue)
    const fileName = text(fileNameValue, "file name", 240, true)
    if (!fileName.toLowerCase().endsWith(".md")) throw failure("only .md skill files are supported")
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw failure("skill file is empty")
    if (buffer.length > config.chatSkillMaxBytes) throw failure("skill file exceeds the allowed size", 413)
    const content = buffer.toString("utf8").replace(/^\uFEFF/, "").trim()
    if (!content) throw failure("skill file is empty")
    if (content.includes("\0")) throw failure("skill file contains invalid content")
    const currentSkills = await skillRepository.list(values.workspace, values.project)
    const existing = currentSkills.find(item => item.fileName === fileName)
    if (!existing && currentSkills.length >= config.chatSkillMaxCount) {
      throw failure(`at most ${config.chatSkillMaxCount} skills are allowed per project`, 409)
    }
    assertActiveCapacity(currentSkills, { id: existing?.id || null, content })
    const skill = await skillRepository.upsert({
      id: existing?.id || randomUUID(),
      ...values,
      name: markdownName(fileName, content),
      fileName,
      content,
      sha256: createHash("sha256").update(content).digest("hex")
    })
    return publicSkill(skill)
  },

  async setEnabled(id, workspaceValue, projectValue, enabled) {
    const values = scope(workspaceValue, projectValue)
    const current = await scopedSkill(id, values.workspace, values.project)
    if (enabled === true && !current.enabled) {
      const skills = await skillRepository.list(values.workspace, values.project)
      assertActiveCapacity(skills, current)
    }
    const updated = await skillRepository.setEnabled(current.id, enabled === true)
    return publicSkill(updated)
  },

  async delete(id, workspaceValue, projectValue) {
    const values = scope(workspaceValue, projectValue)
    const current = await scopedSkill(id, values.workspace, values.project)
    if (!(await skillRepository.delete(current.id))) throw failure("skill not found", 404)
    return { deleted: true }
  }
}
