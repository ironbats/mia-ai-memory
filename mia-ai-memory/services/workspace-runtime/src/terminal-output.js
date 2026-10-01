export const MAX_TERMINAL_OUTPUT_BYTES = 4 * 1024 * 1024

export const createTerminalOutput = () => ({ output: "", outputOffset: 0, outputBytes: 0 })

export const appendTerminalOutput = (session, text, maxBytes = MAX_TERMINAL_OUTPUT_BYTES) => {
  session.output += text
  session.outputBytes += Buffer.byteLength(text, "utf8")
  if (session.outputBytes <= maxBytes) return

  const bytes = Buffer.from(session.output, "utf8")
  let start = Math.max(0, bytes.length - maxBytes)
  // Drop any partial leading code point when retaining the bounded UTF-8 tail.
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1
  const retained = bytes.subarray(start).toString("utf8")
  session.outputOffset += session.output.length - retained.length
  session.output = retained
  session.outputBytes = bytes.length - start
}

export const readTerminalOutput = (session, cursor = 0) => {
  const numericCursor = Number(cursor)
  const requested = Number.isSafeInteger(numericCursor) && numericCursor >= 0 ? numericCursor : 0
  // Keep the existing UTF-16 cursor units, but count discarded output too.
  const nextCursor = session.outputOffset + session.output.length
  let startCursor = Math.max(session.outputOffset, Math.min(requested, nextCursor))
  let localCursor = startCursor - session.outputOffset
  const current = session.output.charCodeAt(localCursor)
  const previous = session.output.charCodeAt(localCursor - 1)
  if (current >= 0xdc00 && current <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) {
    localCursor += 1
    startCursor += 1
  }
  return {
    output: session.output.slice(localCursor),
    startCursor,
    nextCursor,
    truncated: requested < session.outputOffset
  }
}
