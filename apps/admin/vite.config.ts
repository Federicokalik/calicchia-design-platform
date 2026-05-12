import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: __dirname,
  envDir: path.resolve(__dirname, '../..'), // Root monorepo .env (unico .env globale)
  envPrefix: ['VITE_', 'PUBLIC_'], // Support both Vite and Astro conventions
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '^/api/.*': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
        rewrite: (path) => path,
      },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 5000,
    rollupOptions: {
      onwarn(warning, defaultHandler) {
        if (
          warning.message.includes('"web-worker"') &&
          warning.message.includes('treating it as an external dependency')
        ) {
          return;
        }
        defaultHandler(warning);
      },
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          radix: [
            '@radix-ui/react-accordion',
            '@radix-ui/react-alert-dialog',
            '@radix-ui/react-avatar',
            '@radix-ui/react-checkbox',
            '@radix-ui/react-dialog',
            '@radix-ui/react-dropdown-menu',
            '@radix-ui/react-label',
            '@radix-ui/react-popover',
            '@radix-ui/react-select',
            '@radix-ui/react-separator',
            '@radix-ui/react-slot',
            '@radix-ui/react-switch',
            '@radix-ui/react-tabs',
            '@radix-ui/react-toast',
            '@radix-ui/react-tooltip',
          ],
          editor: [
            '@tiptap/extension-character-count',
            '@tiptap/extension-highlight',
            '@tiptap/extension-image',
            '@tiptap/extension-link',
            '@tiptap/extension-placeholder',
            '@tiptap/extension-table',
            '@tiptap/extension-table-cell',
            '@tiptap/extension-table-header',
            '@tiptap/extension-table-row',
            '@tiptap/extension-task-item',
            '@tiptap/extension-task-list',
            '@tiptap/extension-text-align',
            '@tiptap/extension-typography',
            '@tiptap/extension-youtube',
            '@tiptap/markdown',
            '@tiptap/react',
            '@tiptap/starter-kit',
            '@tiptap/suggestion',
          ],
          diagrams: ['@excalidraw/excalidraw', 'elkjs', '@xyflow/react'],
          dataViz: ['@tanstack/react-query', '@tanstack/react-table', 'recharts'],
        },
      },
    },
  },
});
