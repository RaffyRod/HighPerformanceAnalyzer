import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
const apiHost = process.env.API_HOST || '127.0.0.1'
const apiPort = process.env.API_PORT || process.env.PORT || '3000'
const defaultApiTarget = `http://${apiHost}:${apiPort}`

export default defineConfig({
  plugins: [vue()],
  server: {
    port: Number(process.env.WEB_PORT || 5173),
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || defaultApiTarget,
        changeOrigin: true,
      },
    },
  },
})
