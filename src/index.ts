import fs from 'node:fs';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import colors from 'picocolors';
import { loadEnv } from 'vite';
import type { Plugin, UserConfig, ConfigEnv, ResolvedConfig, PluginOption, Rollup } from 'vite';
import fullReload, { Config as FullReloadConfig } from 'vite-plugin-full-reload';

export interface OutputConfig {
    /**
     * JavaScript output directory relative to buildDirectory or absolute.
     * e.g. 'js' -> 'public/build/js/[name].js'
     */
    jsDir?: string;

    /**
     * CSS output directory relative to buildDirectory.
     * e.g. 'css' -> 'public/build/css/[name].css'
     */
    cssDir?: string;

    /**
     * Static media/assets output directory relative to buildDirectory.
     * e.g. 'images' or 'assets'
     */
    mediaDir?: string;

    /**
     * Custom chunk file naming pattern (Webpack / asset bundler style).
     * e.g. 'js/[name].js' or 'js/[name]-[hash].js'
     */
    chunkFileNames?: string | ((chunkInfo: any) => string);

    /**
     * Custom entry file naming pattern.
     * e.g. 'js/[name].js' or 'js/[name]-[hash].js'
     */
    entryFileNames?: string | ((chunkInfo: any) => string);

    /**
     * Custom asset file naming pattern.
     * e.g. 'css/[name]-[hash][extname]'
     */
    assetFileNames?: string | ((chunkInfo: any) => string);
}

export interface AssetGroupConfig {
    /**
     * Entry file(s) for this specific asset group.
     * e.g. 'resources/assets/js/app.ts' or ['resources/assets/js/admin.ts', 'resources/assets/js/auth.ts']
     */
    input: Rollup.InputOption;

    /**
     * Dedicated output directory, subdirectories, or naming rules for this asset group.
     */
    output?: OutputConfig;

    /**
     * Dedicated outDir for this group (overrides buildDirectory).
     * e.g. 'public/admin-dist'
     */
    outDir?: string;
}

export interface PluginConfig {
    /**
     * The path or paths of the entry points to compile.
     * Optional if `assets` array is provided.
     */
    input?: Rollup.InputOption;

    /**
     * Modular array of asset groups with individual inputs, outputs, and naming configurations.
     * Allows scalable multi-bundle asset definitions.
     */
    assets?: AssetGroupConfig[];

    /**
     * OstroJS public directory (where build or assets live).
     *
     * @default 'public'
     */
    publicDirectory?: string;

    /**
     * The public subdirectory where compiled assets should be written (e.g. 'build', 'dist', 'assets', or '' for root of publicDirectory).
     * Set to '' or false to write directly into publicDirectory without creating a build subdirectory.
     *
     * @default 'build'
     */
    buildDirectory?: string | false;

    /**
     * Optional custom target output directory (overrides publicDirectory + buildDirectory).
     * e.g. 'dist' or 'public/dist'
     */
    outDir?: string;

    /**
     * Whether to empty outDir before building.
     * When buildDirectory is empty (outputting directly to publicDirectory root),
     * this automatically defaults to false to protect your static files (images, favicon, etc.).
     *
     * @default buildDirectory ? true : false
     */
    emptyOutDir?: boolean;

    /**
     * Detailed sub-directory and file naming rules for JS, CSS, and media assets.
     */
    output?: OutputConfig;

    /**
     * The path to the "hot" file.
     *
     * @default `${publicDirectory}/hot`
     */
    hotFile?: string;

    /**
     * The path of the SSR entry point.
     */
    ssr?: Rollup.InputOption;

    /**
     * The directory where the SSR bundle should be written.
     *
     * @default 'bootstrap/ssr'
     */
    ssrOutputDirectory?: string;

    /**
     * Configuration for performing full page refresh on view or template file changes.
     *
     * @default false
     */
    refresh?: boolean | string | string[] | RefreshConfig | RefreshConfig[];

    /**
     * Optional HTML generation configuration.
     * When provided, an HTML file (e.g. 'index.html') will automatically be generated in the output directory
     * injecting the exact CSS and JS bundle entrypoints dynamically resolved from the build manifest.
     */
    html?: boolean | string | {
        filename?: string;
        template?: string;
        title?: string;
        mountId?: string;
    };

    /**
     * Clean up obsolete hashed build files from previous builds.
     * By default (true), it compares against the build manifest (manifest.json).
     * If a custom tracking text file is specified (e.g. { trackerFile: 'build-tracker.txt' }),
     * it generates and tracks previous files via that key-value text file.
     *
     * @default true
     */
    clean?: boolean | {
        trackerFile?: string;
        /** @deprecated use `trackerFile` instead */
        manifestFile?: string;
    };

    /**
     * Transform the code while serving.
     */
    transformOnServe?: (code: string, url: DevServerUrl) => string;
}

export interface RefreshConfig {
    paths: string[];
    config?: FullReloadConfig;
}

export interface OstroPlugin extends Plugin {
    config: (config: UserConfig, env: ConfigEnv) => UserConfig;
}

export type DevServerUrl = `${'http' | 'https'}://${string}:${number}`;

let exitHandlersBound = false;

export const defaultRefreshPaths: string[] = [
    'resources/views/**',
    'routes/**',
    'app/http/controllers/**',
].filter(p => fs.existsSync(p.replace(/\*\*$/, '')));

export const defaultAliases: Record<string, string> = {
    '@': path.resolve(process.cwd(), 'resources/assets/js'),
    '~': path.resolve(process.cwd(), 'resources/assets'),
};

/**
 * OstroJS plugin for Vite.
 *
 * @param config - A config object or relative path(s) of the scripts to be compiled.
 */
export default function ostro(config: string | string[] | PluginConfig): [OstroPlugin, ...Plugin[]] {
    const pluginConfig = resolvePluginConfig(config);

    return [
        resolveOstroPlugin(pluginConfig),
        ...(resolveFullReloadConfig(pluginConfig) as Plugin[]),
    ];
}

/**
 * Resolve the configuration object.
 */
function resolvePluginConfig(config: string | string[] | PluginConfig): Required<PluginConfig> {
    if (typeof config === 'undefined') {
        throw new Error('ostro-vite plugin: missing configuration.');
    }

    if (typeof config === 'string' || Array.isArray(config)) {
        config = { input: config, ssr: undefined };
    }

    // Merge inputs from assets array if provided
    let combinedInput: Rollup.InputOption | undefined = config.input;
    if (Array.isArray(config.assets) && config.assets.length > 0) {
        const inputsFromAssets: string[] = [];
        for (const assetGroup of config.assets) {
            if (typeof assetGroup.input === 'string') {
                inputsFromAssets.push(assetGroup.input);
            } else if (Array.isArray(assetGroup.input)) {
                inputsFromAssets.push(...(assetGroup.input as string[]));
            } else if (assetGroup.input && typeof assetGroup.input === 'object') {
                inputsFromAssets.push(...Object.values(assetGroup.input));
            }
        }
        if (inputsFromAssets.length > 0) {
            if (!combinedInput) {
                combinedInput = inputsFromAssets;
            } else if (Array.isArray(combinedInput)) {
                combinedInput = [...(combinedInput as string[]), ...inputsFromAssets];
            } else if (typeof combinedInput === 'string') {
                combinedInput = [combinedInput, ...inputsFromAssets];
            }
        }
    }

    if (typeof combinedInput === 'undefined' && typeof config.ssr === 'undefined') {
        throw new Error('ostro-vite plugin: missing either "input", "assets", or "ssr" configuration.');
    }

    const publicDirectory = config.publicDirectory ?? 'public';
    const buildDirectory = config.buildDirectory ? config.buildDirectory : '';
    const defaultEmptyOutDir = config.emptyOutDir ?? (buildDirectory !== '');

    return {
        input: combinedInput ?? '',
        assets: config.assets ?? [],
        publicDirectory,
        buildDirectory,
        outDir: config.outDir ?? '',
        emptyOutDir: defaultEmptyOutDir,
        output: config.output ?? {},
        hotFile: config.hotFile ?? path.join(publicDirectory, 'hot'),
        ssr: config.ssr ?? '',
        ssrOutputDirectory: config.ssrOutputDirectory ?? 'bootstrap/ssr',
        refresh: config.refresh ?? false,
        html: config.html ?? false,
        clean: config.clean ?? true,
        transformOnServe: config.transformOnServe ?? (code => code),
    };
}

/**
 * Resolve the internal Vite plugin implementation for OstroJS.
 */
function resolveOstroPlugin(pluginConfig: Required<PluginConfig>): OstroPlugin {
    let viteDevServerUrl: DevServerUrl;
    let resolvedConfig: ResolvedConfig;
    let userConfig: UserConfig;
    const previousFilesToClean = new Set<string>();

    return {
        name: 'ostro',
        enforce: 'post',
        config: (config: UserConfig, { command, mode }: ConfigEnv): UserConfig => {
            userConfig = config;
            const ssr = !!userConfig.build?.ssr;
            const env = loadEnv(mode, userConfig.envDir || process.cwd(), '');
            const assetUrl = env.ASSET_URL ?? '';

            // Handle custom hybrid output directory patterns (Webpack / asset bundler style)
            const outCfg = pluginConfig.output || {};
            const jsDir = outCfg.jsDir || 'assets';
            const cssDir = outCfg.cssDir || 'assets';
            const mediaDir = outCfg.mediaDir || 'assets';

            const defaultChunkFileNames = outCfg.chunkFileNames || `${jsDir}/[name]-[hash].js`;
            const defaultEntryFileNames = outCfg.entryFileNames || `${jsDir}/[name]-[hash].js`;
            const defaultAssetFileNames = outCfg.assetFileNames || ((assetInfo: any) => {
                if (assetInfo.name && assetInfo.name.endsWith('.css')) {
                    return `${cssDir}/[name]-[hash][extname]`;
                }
                return `${mediaDir}/[name]-[hash][extname]`;
            });

            // If asset groups define their own custom output naming, build a resolver
            const assetGroups = pluginConfig.assets || [];
            const entryFileNameResolver = (chunkInfo: any): string => {
                for (const group of assetGroups) {
                    if (group.output?.entryFileNames) {
                        const inputs = Array.isArray(group.input) ? group.input : [group.input];
                        if (chunkInfo.facadeModuleId && inputs.some(i => typeof i === 'string' && chunkInfo.facadeModuleId.includes(i))) {
                            return typeof group.output.entryFileNames === 'function'
                                ? group.output.entryFileNames(chunkInfo)
                                : group.output.entryFileNames;
                        }
                    }
                }
                return typeof defaultEntryFileNames === 'function'
                    ? defaultEntryFileNames(chunkInfo)
                    : defaultEntryFileNames;
            };

            const existingOutput = userConfig.build?.rollupOptions?.output;
            const outputObj = !Array.isArray(existingOutput) && existingOutput ? existingOutput : {};

            return {
                base: userConfig.base ?? (command === 'build' ? resolveBase(pluginConfig, assetUrl) : ''),
                publicDir: userConfig.publicDir ?? false,
                build: {
                    manifest: userConfig.build?.manifest ?? (ssr ? false : 'manifest.json'),
                    ssrManifest: userConfig.build?.ssrManifest ?? (ssr ? 'ssr-manifest.json' : false),
                    outDir: userConfig.build?.outDir ?? resolveOutDir(pluginConfig, ssr),
                    emptyOutDir: userConfig.build?.emptyOutDir ?? pluginConfig.emptyOutDir,
                    rollupOptions: {
                        input: userConfig.build?.rollupOptions?.input ?? resolveInput(pluginConfig, ssr),
                        output: {
                            chunkFileNames: outputObj.chunkFileNames ?? defaultChunkFileNames,
                            entryFileNames: outputObj.entryFileNames ?? (assetGroups.length > 0 ? entryFileNameResolver : defaultEntryFileNames),
                            assetFileNames: outputObj.assetFileNames ?? defaultAssetFileNames,
                            ...outputObj,
                        }
                    },
                    assetsInlineLimit: userConfig.build?.assetsInlineLimit ?? 0,
                    ...(typeof userConfig.build?.modulePreload !== 'undefined' ? { modulePreload: userConfig.build.modulePreload } : {}),
                },
                server: {
                    origin: userConfig.server?.origin ?? 'http://__ostro_vite_placeholder__.test',
                    cors: userConfig.server?.cors ?? true,
                },
                resolve: {
                    alias: Array.isArray(userConfig.resolve?.alias)
                        ? [
                            ...(userConfig.resolve?.alias ?? []),
                            ...Object.keys(defaultAliases).map(alias => ({
                                find: alias,
                                replacement: defaultAliases[alias]
                            }))
                        ]
                        : {
                            ...defaultAliases,
                            ...userConfig.resolve?.alias,
                        }
                }
            };
        },
        configResolved(config: ResolvedConfig) {
            resolvedConfig = config;
        },
        buildStart() {
            if (!pluginConfig.clean) {
                return;
            }

            const outDir = resolvedConfig.build?.outDir
                ? path.resolve(resolvedConfig.root || process.cwd(), resolvedConfig.build.outDir)
                : path.resolve(process.cwd(), resolveOutDir(pluginConfig, false));

            const cleanOptions = typeof pluginConfig.clean === 'object' && pluginConfig.clean !== null
                ? pluginConfig.clean
                : {};
            const textTrackerName = cleanOptions.trackerFile || cleanOptions.manifestFile;
            const textTrackerPath = textTrackerName ? path.resolve(outDir, textTrackerName) : null;
            const jsonManifestFileName = typeof resolvedConfig.build?.manifest === 'string'
                ? resolvedConfig.build.manifest
                : 'manifest.json';
            const jsonManifestPath = path.resolve(outDir, jsonManifestFileName);

            previousFilesToClean.clear();

            if (textTrackerPath && fs.existsSync(textTrackerPath)) {
                try {
                    const content = fs.readFileSync(textTrackerPath, 'utf-8');
                    for (const line of content.split('\n')) {
                        const trimmed = line.trim();
                        if (trimmed && !trimmed.startsWith('#')) {
                            const separatorIndex = trimmed.indexOf('=');
                            const val = separatorIndex !== -1 ? trimmed.slice(separatorIndex + 1).trim() : trimmed;
                            if (val) {
                                previousFilesToClean.add(val);
                            }
                        }
                    }
                } catch {}
            } else if (fs.existsSync(jsonManifestPath)) {
                try {
                    const jsonContent = JSON.parse(fs.readFileSync(jsonManifestPath, 'utf-8'));
                    for (const entry of Object.values(jsonContent) as any[]) {
                        if (entry.file) {
                            previousFilesToClean.add(entry.file);
                        }
                        if (Array.isArray(entry.css)) {
                            for (const cssFile of entry.css) {
                                previousFilesToClean.add(cssFile);
                            }
                        }
                        if (Array.isArray(entry.assets)) {
                            for (const assetFile of entry.assets) {
                                previousFilesToClean.add(assetFile);
                            }
                        }
                    }
                } catch {}
            }
        },
        transform(code: string) {
            if (resolvedConfig.command === 'serve') {
                code = code.replace(/http:\/\/__ostro_vite_placeholder__\.test/g, viteDevServerUrl);
                return pluginConfig.transformOnServe(code, viteDevServerUrl);
            }
        },
        configureServer(server: any) {
            const envDir = resolvedConfig.envDir || process.cwd();
            const appUrl = loadEnv(resolvedConfig.mode, envDir, 'APP_URL').APP_URL ?? 'http://localhost:8080';

            server.httpServer?.once('listening', () => {
                const address = server.httpServer?.address();
                const isAddressInfo = (x: any): x is AddressInfo => typeof x === 'object' && x !== null;

                if (isAddressInfo(address)) {
                    viteDevServerUrl = userConfig.server?.origin
                        ? (userConfig.server.origin as DevServerUrl)
                        : resolveDevServerUrl(address, server.config);

                    fs.writeFileSync(pluginConfig.hotFile, `${viteDevServerUrl}${server.config.base.replace(/\/$/, '')}`);

                    server.config.logger.info(`\n  ${colors.red(colors.bold('OSTROJS'))}  ${colors.dim('vite plugin')} ${colors.bold('active')}`);
                    server.config.logger.info(`  ${colors.green('➜')}  ${colors.bold('APP_URL')}: ${colors.cyan(appUrl)}`);
                    server.config.logger.info(`  ${colors.green('➜')}  ${colors.bold('HOT_FILE')}: ${colors.dim(pluginConfig.hotFile)}\n`);
                }
            });

            if (!exitHandlersBound) {
                const clean = () => {
                    if (fs.existsSync(pluginConfig.hotFile)) {
                        try {
                            fs.rmSync(pluginConfig.hotFile);
                        } catch {}
                    }
                };

                process.on('exit', clean);
                exitHandlersBound = true;
            }

            return () => server.middlewares.use((req: any, res: any, next: any) => {
                if (req.url === '/index.html') {
                    res.statusCode = 404;
                    const htmlPath = path.resolve(__dirname, 'dev-server-index.html');
                    if (fs.existsSync(htmlPath)) {
                        res.end(fs.readFileSync(htmlPath, 'utf-8').replace(/{{ APP_URL }}/g, appUrl));
                        return;
                    }
                }
                next();
            });
        },
        generateBundle(_outputOptions: any, bundle: any) {
            if (!pluginConfig.html) {
                return;
            }

            const htmlOptions = typeof pluginConfig.html === 'object' && pluginConfig.html !== null
                ? pluginConfig.html
                : {};
            const htmlFileName = typeof pluginConfig.html === 'string'
                ? pluginConfig.html
                : (htmlOptions.filename || 'index.html');
            const pageTitle = htmlOptions.title || 'OstroJS Application';
            const mountId = htmlOptions.mountId || 'app';

            const scriptTags: string[] = [];
            const linkTags: string[] = [];

            for (const [fileName, chunk] of Object.entries(bundle) as [string, any][]) {
                if (fileName.endsWith('.css') || (chunk.type === 'asset' && chunk.fileName?.endsWith('.css'))) {
                    linkTags.push(`<link rel="stylesheet" href="/${fileName}">`);
                } else if (chunk.isEntry && chunk.type === 'chunk' && fileName.endsWith('.js')) {
                    scriptTags.push(`<script type="module" src="/${fileName}"></script>`);
                }
            }

            const htmlContent = htmlOptions.template
                ? htmlOptions.template
                    .replace(/<!--\s*css-links\s*-->/gi, linkTags.join('\n    '))
                    .replace(/<!--\s*js-scripts\s*-->/gi, scriptTags.join('\n    '))
                    .replace(/\{\{\s*title\s*\}\}/gi, pageTitle)
                    .replace(/\{\{\s*mountId\s*\}\}/gi, mountId)
                : `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${pageTitle}</title>
    ${linkTags.join('\n    ')}
</head>
<body>
    <div id="${mountId}"></div>
    ${scriptTags.join('\n    ')}
</body>
</html>
`;

            this.emitFile({
                type: 'asset',
                fileName: htmlFileName,
                source: htmlContent
            });
        },
        writeBundle(_outputOptions: any, bundle: any) {
            if (!pluginConfig.clean) {
                return;
            }

            const outDir = resolvedConfig.build?.outDir
                ? path.resolve(resolvedConfig.root || process.cwd(), resolvedConfig.build.outDir)
                : path.resolve(process.cwd(), resolveOutDir(pluginConfig, false));

            const cleanOptions = typeof pluginConfig.clean === 'object' && pluginConfig.clean !== null
                ? pluginConfig.clean
                : {};
            const textTrackerName = cleanOptions.trackerFile || cleanOptions.manifestFile;
            const textTrackerPath = textTrackerName ? path.resolve(outDir, textTrackerName) : null;
            const jsonManifestFileName = typeof resolvedConfig.build?.manifest === 'string'
                ? resolvedConfig.build.manifest
                : 'manifest.json';
            const jsonManifestPath = path.resolve(outDir, jsonManifestFileName);

            // Current bundle files
            const currentFiles = new Set<string>();
            const currentEntries: Record<string, string> = {};

            for (const [fileName, chunk] of Object.entries(bundle) as [string, any][]) {
                currentFiles.add(fileName);
                const key = chunk.name || chunk.facadeModuleId || fileName;
                currentEntries[key] = fileName;
            }

            // Delete obsolete files that were in previous build but not in current build
            for (const oldFile of previousFilesToClean) {
                if (!currentFiles.has(oldFile) && oldFile !== textTrackerName && oldFile !== jsonManifestFileName) {
                    const oldFilePath = path.resolve(outDir, oldFile);
                    if (fs.existsSync(oldFilePath)) {
                        try {
                            fs.rmSync(oldFilePath, { force: true });
                        } catch {}
                    }
                }
            }

            // Only generate text tracker file if user explicitly requested/configured it
            if (textTrackerPath) {
                try {
                    const manifestLines = Object.entries(currentEntries)
                        .sort(([a], [b]) => a.localeCompare(b))
                        .map(([k, v]) => `${k}=${v}`);
                    fs.writeFileSync(textTrackerPath, manifestLines.join('\n') + '\n', 'utf-8');
                } catch {}
            }
        }
    };
}

/**
 * Resolve the dev server URL.
 */
function resolveDevServerUrl(address: AddressInfo, config: ResolvedConfig): DevServerUrl {
    const serverProtocol = config.server.https ? 'https' : 'http';
    const serverAddress = address.family === 'IPv6' ? `[${address.address}]` : address.address;
    const host = config.server.host === true ? serverAddress : (typeof config.server.host === 'string' ? config.server.host : 'localhost');
    const port = address.port;

    return `${serverProtocol}://${host}:${port}`;
}

/**
 * Resolve the outDir for Rollup.
 */
function resolveOutDir(pluginConfig: Required<PluginConfig>, ssr: boolean): string {
    if (ssr) {
        return pluginConfig.ssrOutputDirectory;
    }
    if (pluginConfig.outDir) {
        return pluginConfig.outDir;
    }
    return pluginConfig.buildDirectory
        ? path.join(pluginConfig.publicDirectory, pluginConfig.buildDirectory)
        : pluginConfig.publicDirectory;
}

/**
 * Resolve the Rollup entry inputs.
 */
function resolveInput(pluginConfig: Required<PluginConfig>, ssr: boolean): Rollup.InputOption {
    if (ssr) {
        return pluginConfig.ssr;
    }
    return pluginConfig.input;
}

/**
 * Resolve the base URL path.
 */
function resolveBase(pluginConfig: Required<PluginConfig>, assetUrl: string): string {
    const dir = pluginConfig.outDir
        ? pluginConfig.outDir.replace(new RegExp(`^${pluginConfig.publicDirectory}/?`), '')
        : pluginConfig.buildDirectory;
    const prefix = assetUrl ? (!assetUrl.endsWith('/') ? `${assetUrl}/` : assetUrl) : '/';
    return dir ? `${prefix}${dir}/` : prefix;
}

/**
 * Resolve full reload configuration.
 */
function resolveFullReloadConfig({ refresh }: Required<PluginConfig>): PluginOption[] {
    if (typeof refresh === 'boolean') {
        return refresh ? [fullReload(defaultRefreshPaths)] : [];
    }

    if (typeof refresh === 'string') {
        refresh = [{ paths: [refresh] }];
    }

    if (typeof refresh === 'object' && !Array.isArray(refresh)) {
        refresh = [refresh];
    }

    if (Array.isArray(refresh)) {
        if (refresh.some(c => typeof c === 'string')) {
            refresh = [{ paths: refresh as string[] }];
        }

        return (refresh as RefreshConfig[]).map(c => fullReload(c.paths, c.config));
    }

    return [];
}

export { federation } from './federation.js';
export type {
    ModuleFederationOptions,
    FederationShared,
    FederationSharedConfig,
    FederationRemotes,
    FederationExposes,
    RemoteConfig
} from './federation.js';
