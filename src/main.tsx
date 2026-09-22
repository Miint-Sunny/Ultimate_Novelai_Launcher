import React, { useState } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import {
  initializeLocalSidecar,
  pairLocalSidecar,
  SidecarPairingRequiredError,
} from './api/sidecar'
import { installRangeFillSync } from './utils/rangeFill'

installRangeFillSync()

const root = ReactDOM.createRoot(document.getElementById('app')!)

function renderApp() {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}

function PairingScreen() {
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function pair() {
    if (!/^[0-9]{6}$/.test(code)) {
      setError('请输入完整的 6 位数字配对码')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      await pairLocalSidecar(code)
      await initializeLocalSidecar()
      renderApp()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-nai-dark p-6 text-gray-100">
      <section className="w-full max-w-md rounded-2xl border border-gray-700 bg-nai-panel p-6 shadow-xl">
        <h1 className="text-lg font-semibold">连接本地后端</h1>
        <p className="mt-3 text-sm leading-6 text-gray-300">
          输入 sidecar 终端显示的 6 位配对码。配对码 120 秒内有效且只能使用一次。
        </p>
        <input
          aria-label="Sidecar 配对码"
          autoComplete="one-time-code"
          className="mt-5 w-full rounded-lg border border-gray-700 bg-nai-dark px-4 py-3 text-center font-mono text-2xl tracking-[0.5em] outline-none focus:border-nai-accent"
          inputMode="numeric"
          maxLength={6}
          onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
          onKeyDown={event => {
            if (event.key === 'Enter') void pair()
          }}
          value={code}
        />
        {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
        <button
          className="mt-5 w-full rounded-lg bg-nai-accent px-4 py-2 text-sm font-bold text-black hover:bg-nai-accent-hover disabled:opacity-50"
          disabled={submitting}
          onClick={() => void pair()}
          type="button"
        >
          {submitting ? '正在配对…' : '连接'}
        </button>
      </section>
    </main>
  )
}

// 桌面壳不再卡着窗口等 sidecar:单文件打包的 sidecar 每次冷启动都要十几秒,
// 这段时间窗口已经出来了,得告诉用户在等什么,而不是一片空白。
function StartingScreen() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-nai-dark p-6 text-gray-100">
      <p className="animate-pulse text-sm text-gray-400">正在启动本地后端…</p>
    </main>
  )
}

async function bootstrap() {
  root.render(<StartingScreen />)
  try {
    await initializeLocalSidecar()
    renderApp()
  } catch (error) {
    if (error instanceof SidecarPairingRequiredError) {
      root.render(<PairingScreen />)
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    root.render(
      <main className="flex min-h-screen items-center justify-center bg-nai-dark p-6 text-gray-100">
        <section className="max-w-lg rounded-2xl border border-red-400/30 bg-nai-panel p-6 shadow-xl">
          <h1 className="text-lg font-semibold">本地后端未就绪</h1>
          <p className="mt-3 text-sm leading-6 text-gray-300">{message}</p>
          <button
            className="mt-5 rounded-lg bg-nai-accent px-4 py-2 text-sm font-bold text-black hover:bg-nai-accent-hover"
            onClick={() => window.location.reload()}
            type="button"
          >
            重试
          </button>
        </section>
      </main>,
    )
  }
}

void bootstrap()
