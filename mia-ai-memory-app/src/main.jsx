import React from "react"
import { createRoot } from "react-dom/client"
import App from "./App.jsx"
import PlatformDialogHost from "./components/PlatformDialogHost.jsx"
import "./styles.css"
import "./styles/ide-workspace.css"

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
    <PlatformDialogHost />
  </React.StrictMode>
)
