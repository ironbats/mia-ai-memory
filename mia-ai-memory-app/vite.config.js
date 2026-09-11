import { defineConfig, loadEnv } from "vite"

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "")
  const cognitiveApiUrl = (process.env.COGNITIVE_API_URL || env.COGNITIVE_API_URL || env.VITE_COGNITIVE_API_URL || "http://127.0.0.1:8787").replace(/\/$/, "")

  return {
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target: cognitiveApiUrl,
          changeOrigin: true
        },
        "/healthz": {
          target: cognitiveApiUrl,
          changeOrigin: true
        }
      }
    }
  }
})
