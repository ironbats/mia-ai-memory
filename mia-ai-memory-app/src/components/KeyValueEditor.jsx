import React from "react"

const blank = () => ({ key: "", value: "" })

export const rowsToObject = rows => Object.fromEntries(
  rows
    .map(row => [String(row.key || "").trim(), String(row.value || "")])
    .filter(([key]) => key)
)

export const objectToRows = value => {
  const entries = Object.entries(value || {}).map(([key, item]) => ({ key, value: String(item ?? "") }))
  return entries.length ? entries : [blank()]
}

export default function KeyValueEditor({ label, hint, rows, onChange, secret = false, keyPlaceholder = "Nome", valuePlaceholder = "Valor" }) {
  const update = (index, field, value) => onChange(rows.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row))
  const remove = index => {
    const next = rows.filter((_, rowIndex) => rowIndex !== index)
    onChange(next.length ? next : [blank()])
  }
  return (
    <div className="kv-editor">
      <div className="field-label-row"><label>{label}</label>{hint ? <small>{hint}</small> : null}</div>
      <div className="kv-list">
        {rows.map((row, index) => (
          <div className="kv-row" key={`${index}-${row.key}`}>
            <input value={row.key} onChange={event => update(index, "key", event.target.value)} placeholder={keyPlaceholder} />
            <input type={secret ? "password" : "text"} autoComplete="off" value={row.value} onChange={event => update(index, "value", event.target.value)} placeholder={valuePlaceholder} />
            <button type="button" className="row-remove" onClick={() => remove(index)}>×</button>
          </div>
        ))}
      </div>
      <button type="button" className="secondary-button compact" onClick={() => onChange([...rows, blank()])}>+ Adicionar campo</button>
    </div>
  )
}
