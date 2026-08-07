import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => ({
  // Ganti '/' -> '/nama-repo/' kalau di-deploy sebagai GitHub Pages project page
  // (username.github.io/nama-repo/), bukan user/organization page (username.github.io/).
  base: '/',
  plugins: [react()],
  build: {
    target: 'es2020',
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: mode === 'production',
        drop_debugger: true,
      },
      mangle: true,
      format: { comments: false },
    },
    // JANGAN publish sourcemap ke produksi -- sourcemap membongkar kembali source asli
    // (nama variabel, struktur file, komentar) dari bundle yang sudah diminifikasi.
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
        },
      },
    },
  },
}));
