import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// Anything starting with VITE_ is copied into the public browser bundle.
// Fail the build if a secret / service_role key could end up there.
function assertNoSecrets(env: Record<string, string>) {
  for (const [name, value] of Object.entries(env)) {
    if (/SERVICE_ROLE|SECRET/i.test(name)) {
      throw new Error(`Refusing to build: ${name} would be public. Never prefix secrets with VITE_.`)
    }
    if (value.startsWith('sb_secret_')) {
      throw new Error(`Refusing to build: ${name} holds a Supabase secret key.`)
    }
    try {
      const payload = JSON.parse(atob(value.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
      if (payload?.role === 'service_role') throw new Error(`Refusing to build: ${name} holds a service_role key.`)
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Refusing')) throw e
    }
  }
}

export default defineConfig(({ mode }) => {
  assertNoSecrets(loadEnv(mode, '.', 'VITE_'))
  return { plugins: [react()], build: { target: 'es2020', sourcemap: false } }
})
