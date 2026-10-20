import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  // 다른 백엔드(예: 데모/임시 DB)를 붙여 볼 때 VITE_API_TARGET 으로 프록시 대상을 바꾼다.
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.VITE_API_TARGET || 'http://localhost:3000'
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': target,
        '/socket.io': { target, ws: true },
      },
    },
  }
})
