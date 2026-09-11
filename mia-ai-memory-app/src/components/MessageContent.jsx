import React, { useMemo, useState } from "react"

const safeHref = value => {
  try {
    const url = new URL(value)
    return ["http:", "https:"].includes(url.protocol) ? value : ""
  } catch {
    return ""
  }
}

const inlineTokens = text => {
  const source = String(text || "")
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)]+\))/g
  const parts = source.split(pattern).filter(Boolean)
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/)
    if (link) {
      const href = safeHref(link[2])
      return href ? <a key={index} href={href} target="_blank" rel="noreferrer">{link[1]}</a> : part
    }
    return part
  })
}

function CodeBlock({ language, value }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="chat-code-block">
      <div className="chat-code-head"><span>{language || "code"}</span><button type="button" onClick={copy}>{copied ? "Copiado" : "Copiar"}</button></div>
      <pre><code>{value}</code></pre>
    </div>
  )
}

const parseBlocks = source => {
  const lines = String(source || "").replace(/\r\n/g, "\n").split("\n")
  const blocks = []
  let index = 0

  const isBoundary = line => {
    const trimmed = line.trim()
    return !trimmed || /^```/.test(trimmed) || /^#{1,4}\s+/.test(trimmed) || /^>\s?/.test(trimmed) || /^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed) || /^---+$/.test(trimmed)
  }

  while (index < lines.length) {
    const line = lines[index]
    const trimmed = line.trim()

    if (!trimmed) {
      index += 1
      continue
    }

    const fence = trimmed.match(/^```([^`]*)$/)
    if (fence) {
      const code = []
      index += 1
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        code.push(lines[index])
        index += 1
      }
      if (index < lines.length) index += 1
      blocks.push({ type: "code", language: fence[1].trim(), value: code.join("\n") })
      continue
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/)
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, value: heading[2] })
      index += 1
      continue
    }

    if (/^---+$/.test(trimmed)) {
      blocks.push({ type: "rule" })
      index += 1
      continue
    }

    if (/^>\s?/.test(trimmed)) {
      const values = []
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        values.push(lines[index].trim().replace(/^>\s?/, ""))
        index += 1
      }
      blocks.push({ type: "quote", value: values.join("\n") })
      continue
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items = []
      while (index < lines.length && /^[-*]\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^[-*]\s+/, ""))
        index += 1
      }
      blocks.push({ type: "ul", items })
      continue
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items = []
      while (index < lines.length && /^\d+\.\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^\d+\.\s+/, ""))
        index += 1
      }
      blocks.push({ type: "ol", items })
      continue
    }

    const paragraph = [line]
    index += 1
    while (index < lines.length && !isBoundary(lines[index])) {
      paragraph.push(lines[index])
      index += 1
    }
    blocks.push({ type: "paragraph", value: paragraph.join("\n") })
  }

  return blocks
}

export default function MessageContent({ content, plain = false }) {
  const blocks = useMemo(() => parseBlocks(content), [content])

  if (plain) return <div className="chat-rich-content plain">{content}</div>

  return (
    <div className="chat-rich-content">
      {blocks.map((block, index) => {
        if (block.type === "code") return <CodeBlock key={index} language={block.language} value={block.value} />
        if (block.type === "heading") {
          const Tag = `h${Math.min(4, block.level + 1)}`
          return <Tag key={index}>{inlineTokens(block.value)}</Tag>
        }
        if (block.type === "rule") return <hr key={index} />
        if (block.type === "quote") return <blockquote key={index}>{block.value.split("\n").map((value, lineIndex) => <React.Fragment key={lineIndex}>{inlineTokens(value)}{lineIndex < block.value.split("\n").length - 1 ? <br /> : null}</React.Fragment>)}</blockquote>
        if (block.type === "ul") return <ul key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{inlineTokens(item)}</li>)}</ul>
        if (block.type === "ol") return <ol key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{inlineTokens(item)}</li>)}</ol>
        return <p key={index}>{block.value.split("\n").map((value, lineIndex) => <React.Fragment key={lineIndex}>{inlineTokens(value)}{lineIndex < block.value.split("\n").length - 1 ? <br /> : null}</React.Fragment>)}</p>
      })}
    </div>
  )
}
