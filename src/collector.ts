import fs from 'node:fs';
import path from 'node:path';

import {
    createHtmlTag,
    createLinkHeader,
    createSingleLinkHeader,
    Preload,
    sortPreloads,
} from './utils';

interface ManifestChunk {
    src: string;
    name: string;
    file: string;
    isEntry?: boolean;
    imports?: string[];
    dynamicImports?: string[];
    css?: string[];
    assets?: string[];
}

type Manifest = Record<string, ManifestChunk>;

export class ChunkCollector {
    modulesIds = new Set<string>();
    preloads = new Map<string, Preload>();

    constructor(
        public manifest: Manifest,
        public entry: string,
        public preloadFonts = true,
        public preloadAssets = false,
        public nonce = '',
        public asyncScript = false
    ) {
        this.__context_collectModuleId =
            this.__context_collectModuleId.bind(this);
        this.getChunks = this.getChunks.bind(this);
        this.getSortedModules = this.getSortedModules.bind(this);
        this.getTags = this.getTags.bind(this);
        this.getLinkHeader = this.getLinkHeader.bind(this);
        this.getLinkHeaders = this.getLinkHeaders.bind(this);

        // Load the entry modules
        collectModules('vite/legacy-polyfills', this);
        collectModules(entry, this);
    }

    /**
     * Function is called by `ChunkCollectorContext`
     */
    __context_collectModuleId(moduleId: string) {
        this.modulesIds.add(moduleId);
        collectModules(moduleId, this);
    }

    /**
     * @deprecated - use getChunks instead
     */
    getSortedModules() {
        const modules = Array.from(this.preloads.values());
        return sortPreloads(modules);
    }

    getChunks() {
        const modules = Array.from(this.preloads.values());
        return sortPreloads(modules);
    }

    /**
     * Returns all HTML tags for preload hints and stylesheets.
     *
     * See https://vitejs.dev/guide/backend-integration for using your own template
     */
    getTags({
        includeEntry,
    }: {
        /**
         * Will include the entry <script module=""> and entry stylesheets tags.
         *
         * If you are using the default Vite settings and having vite transform your index.html
         * as build time, then the entry tags are already included in the template.
         */
        includeEntry?: boolean;
    } = {}): string {
        const modules = this.getChunks();

        return modules
            .filter((m) => includeEntry || !m.isEntry)
            .map(createHtmlTag)
            .filter((x) => x != null)
            .join('\n');
    }

    /**
     * Returns a `Link` header with all chunks to preload,
     * including entry chunks.
     *
     * @example res.setHeader('link', collector.getLinkHeader());
     */
    getLinkHeader(): string {
        const modules = this.getChunks();
        return createLinkHeader(modules);
    }

    /**
     * Returns an array of `Link` header values
     *
     * @example res.append('link', collector.getLinkHeaders());
     */
    getLinkHeaders(): string[] {
        return this.getChunks()
            .map(createSingleLinkHeader)
            .filter((x) => x != null);
    }
}

interface CollectorOptions {
    /**
     * The Vite manifest or a path to it.
     *
     * Set build.manifest: true in your vite config to generate it.
     *
     * May be missing in development mode since vite-preload has no effect there
     *
     * This is not the ssr-manifest.json.
     */
    manifest?: Manifest | string;

    /**
     * The entry module. Defaults to `index.html`
     */
    entry?: string;

    /**
     * Preload fonts.
     *
     * @default true
     */
    preloadFonts?: boolean;

    /**
     * Preload any static imported asset such as image, svgs
     *
     * @default false
     */
    preloadAssets?: boolean;

    /**
     * Nonce for scripts and stylesheets
     */
    nonce?: string;

    /**
     * Set the `async` attribute on the entry <script module=""> tag.
     *
     * This requires you to control template generation and add the <script module async> tag to the end of the <body>
     * or only hydrate React when DOMContentLoaded has fired.
     *
     * The polyfill entry script will not be async.
     */
    asyncScript?: boolean;
}

let manifestFromFile: Manifest;

/**
 * Create a chunk collector.
 * This function will throw if not configured correctly
 */
export function createChunkCollector(options: CollectorOptions) {
    let manifest: Manifest = {};
    const entry = options.entry || 'index.html';

    const enabled = process.env.NODE_ENV === 'production';

    if (enabled) {
        if (typeof options.manifest === 'string') {
            if (manifestFromFile) {
                manifest = manifestFromFile;
            } else {
                const data = fs.readFileSync(options.manifest, 'utf8');
                const json = JSON.parse(data);
                manifestFromFile = manifest = json;
            }
        } else {
            manifest = options.manifest!;
        }

        if (!options.manifest) {
            throw new Error(
                'options.manifest must be provided in production either as a path or object'
            );
        }

        if (!manifest[entry]) {
            throw new Error(
                `Vite manifest.json does not contain key "${entry}"`
            );
        }

        if (!manifest[entry].isEntry) {
            throw new Error(`Module "${entry}" is not an entry module`);
        }
    }

    const collector = new ChunkCollector(
        manifest,
        entry,
        options.preloadFonts,
        options.preloadAssets,
        options.nonce,
        options.asyncScript
    );
    return collector;
}

/*
  url: '/src/pages/Browse/index.ts',
  id: '/<absolute>/src/pages/Browse/index.ts',
  file: '/<absolute>/src/pages/Browse/index.ts',
*/
/**
 * https://vitejs.dev/guide/backend-integration
 * https://github.com/vitejs/vite-plugin-react/tree/main/packages/plugin-react#consistent-components-exports
 * https://github.com/vitejs/vite-plugin-vue/blob/main/playground/ssr-vue/src/entry-server.js
 */

/**
 * This function figures out what modules are used based on the modules rendered by React.
 *
 * It follows https://vitejs.dev/guide/backend-integration
 */
function collectModules(
    moduleId: string,
    {
        entry,
        manifest,
        preloadAssets,
        preloadFonts,
        preloads,
        nonce,
        asyncScript,
    }: ChunkCollector
) {
    // The reported module ID is not in it's own chunk
    // Possible cause for the missing module in the manifest is build.rollupOptions.output.experimentalMinChunkSize
    if (!manifest[moduleId] || preloads.has(moduleId)) {
        return preloads;
    }

    const chunks = new Map<string, ManifestChunk>();
    collectChunksRecursively(manifest, moduleId, chunks);

    for (const chunk of chunks.values()) {
        if (preloads.has(chunk.file)) {
            continue;
        }

        const isPolyfill = chunk.src === 'vite/legacy-polyfills';
        const isPrimaryModule = chunk.src === entry;

        preloads.set(chunk.file, {
            // Only the entrypoint module is used as <script module>, everything else is <link rel=modulepreload>
            rel: isPrimaryModule || isPolyfill ? 'module' : 'modulepreload',
            href: chunk.file,
            comment: `chunk: ${chunk.name}, isEntry: ${chunk.isEntry}`,
            isEntry: chunk.isEntry,
            nonce,

            // The polyfill chunk should not be async and it should run before the entry chunk
            asyncScript: asyncScript && !isPolyfill,
        });

        for (const cssFile of chunk.css || []) {
            if (preloads.has(cssFile)) continue;
            preloads.set(cssFile, {
                rel: 'stylesheet',
                href: cssFile,
                comment: `chunk: ${chunk.name}, isEntry: ${chunk.isEntry}`,
                isEntry: chunk.isEntry,
                nonce,
            });
        }

        if (!preloadFonts && !preloadAssets) {
            continue;
        }

        // Assets such as svg, png imports
        for (const asset of chunk.assets || []) {
            const ext = path.extname(asset).substring(1);
            let as;
            let mimeType;

            switch (ext) {
                case 'png':
                case 'jpg':
                case 'webp':
                case 'svg':
                    as = 'image';
                    mimeType = ext === 'svg' ? 'image/svg+xml' : `image/${ext}`;
                    if (preloadAssets) break;
                    else continue;
                case 'woff2':
                case 'woff':
                case 'ttf':
                    as = 'font';
                    mimeType = `font/${ext}`;
                    if (preloadFonts) break;
                    else continue;
            }

            preloads.set(asset, {
                rel: 'preload',
                href: asset,
                as,
                type: mimeType,
                comment: `Asset from chunk ${chunk.name}: ${chunk.file}`,
            });
        }
    }

    return preloads;
}

function collectChunksRecursively(
    manifest: Manifest,
    moduleId: string,
    chunks: Map<string, ManifestChunk>,
    isEntry?: boolean
) {
    const chunk = manifest[moduleId];

    if (!chunk) {
        throw new Error(`Missing chunk '${moduleId}'`);
    }

    if (chunks.has(moduleId)) {
        return;
    }

    chunks.set(moduleId, {
        ...chunk,

        // Any static import in the entry chunk is considered an entry chunk
        // and inlined by Vite in the generated HTML template but it's not
        // marked with isEntry: true in the manifest
        isEntry: isEntry || chunk.isEntry,
    });

    for (const importName of chunk.imports || []) {
        collectChunksRecursively(
            manifest,
            importName,
            chunks,
            isEntry || chunk.isEntry
        );
    }
}
