import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const sidecarTarget = process.env.VITE_SIDECAR_URL || 'http://127.0.0.1:38176';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0', // 允许局域网访问
    port: 5173,
    proxy: {
      '/api': {
        target: sidecarTarget,
        changeOrigin: true,
      },
    },
    headers: {
      // 允许 SharedArrayBuffer（ONNX Runtime 多线程需要）
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  optimizeDeps: {
    exclude: ['onnxruntime-web'],
  },
  build: {
    commonjsOptions: {
      exclude: ['onnxruntime-web'],
    },
  },
});
