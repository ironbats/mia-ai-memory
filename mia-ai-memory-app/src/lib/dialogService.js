let dialogHost = null
let nextDialogId = 1
const pendingDialogs = []

const dispatchDialog = request => {
  if (dialogHost) dialogHost(request)
  else pendingDialogs.push(request)
}

export const bindDialogHost = handler => {
  dialogHost = handler
  while (pendingDialogs.length) dialogHost(pendingDialogs.shift())
  return () => {
    if (dialogHost === handler) dialogHost = null
  }
}

export const requestDialog = options => new Promise(resolve => {
  dispatchDialog({
    id: `platform-dialog-${nextDialogId++}`,
    mode: "confirm",
    tone: "default",
    title: "Confirmar ação",
    description: "",
    confirmLabel: "Confirmar",
    cancelLabel: "Cancelar",
    inputLabel: "",
    inputType: "text",
    placeholder: "",
    initialValue: "",
    ...options,
    resolve
  })
})

export const confirmAction = options => requestDialog({ ...options, mode: "confirm" })

export const promptValue = options => requestDialog({ ...options, mode: "prompt" })
