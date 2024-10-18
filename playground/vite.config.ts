import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import preloadPlugin from '../dist/plugin';
import legacy from '@vitejs/plugin-legacy';

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [
        react(),
        preloadPlugin({
            __internal_importHelperModuleName: '../../src/__internal',
            debug: true,
        }),
        legacy({
            modernPolyfills: true,
            renderLegacyChunks: false,
        }),
    ],
    build: {
        manifest: true,
        ssrManifest: false,
    },
    html: {
        cspNonce: '%NONCE%',
    },
});
