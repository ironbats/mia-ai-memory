const splitLines = value => {
  const normalized = String(value ?? "").replace(/\r\n/g, "\n")
  return normalized === "" ? [] : normalized.split("\n")
}

const trimCommonEdges = (before, after) => {
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1
  let suffix = 0
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1
  return { prefix, suffix }
}

const lcsOps = (before, after) => {
  const rows = before.length + 1
  const cols = after.length + 1
  if (before.length * after.length > 180000) {
    return [
      ...before.map(text => ({ type: "delete", text })),
      ...after.map(text => ({ type: "add", text }))
    ]
  }
  const table = Array.from({ length: rows }, () => new Uint16Array(cols))
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i][j] = before[i] === after[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      ops.push({ type: "context", text: before[i] })
      i += 1
      j += 1
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ type: "delete", text: before[i] })
      i += 1
    } else {
      ops.push({ type: "add", text: after[j] })
      j += 1
    }
  }
  while (i < before.length) ops.push({ type: "delete", text: before[i++] })
  while (j < after.length) ops.push({ type: "add", text: after[j++] })
  return ops
}

export const buildDiff = ({ path = "file", before = "", after = "", beforeExists = true, afterExists = true } = {}) => {
  const beforeLines = beforeExists ? splitLines(before) : []
  const afterLines = afterExists ? splitLines(after) : []
  const { prefix, suffix } = trimCommonEdges(beforeLines, afterLines)
  const middleBefore = beforeLines.slice(prefix, beforeLines.length - suffix)
  const middleAfter = afterLines.slice(prefix, afterLines.length - suffix)
  const middleOps = lcsOps(middleBefore, middleAfter)
  const ops = [
    ...beforeLines.slice(0, prefix).map(text => ({ type: "context", text })),
    ...middleOps,
    ...beforeLines.slice(beforeLines.length - suffix).map(text => ({ type: "context", text }))
  ]
  let oldLine = 1
  let newLine = 1
  let additions = 0
  let deletions = 0
  const rows = ops.map(operation => {
    const row = { ...operation, oldLine: null, newLine: null }
    if (operation.type === "context") {
      row.oldLine = oldLine++
      row.newLine = newLine++
    } else if (operation.type === "delete") {
      row.oldLine = oldLine++
      deletions += 1
    } else {
      row.newLine = newLine++
      additions += 1
    }
    return row
  })
  const status = !beforeExists && afterExists ? "added" : beforeExists && !afterExists ? "deleted" : additions || deletions ? "modified" : "clean"
  return { path, status, additions, deletions, rows }
}

export const formatUnifiedDiff = change => {
  const diff = buildDiff(change)
  const headerBefore = change.beforeExists === false ? "/dev/null" : `a/${change.path}`
  const headerAfter = change.afterExists === false ? "/dev/null" : `b/${change.path}`
  const body = diff.rows.map(row => `${row.type === "add" ? "+" : row.type === "delete" ? "-" : " "}${row.text}`).join("\n")
  return `--- ${headerBefore}\n+++ ${headerAfter}\n${body}`
}
