import fs from 'node:fs';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import colors from 'picocolors';
import { loadEnv } from 'vite';
import type { Plugin, UserConfig, ConfigEnv, ResolvedConfig, PluginOption, Rollup } from 'vite';
import fullReload, { Config as FullReloadConfig } from 'vite-plugin-full-reload';

export interface PluginConfig {
    /**
     * The path or paths of the entry points to compile.
     */
    input: Rollup.InputOption;

    /**
     * OstroJS public directory.
     *
     * @default 'public'
     */
    publicDirectory?: string;

    /**
     * The public subdirectory where compiled assets should be written.
     *
     * @default 'build'
     */
    buildDirectory?: string;

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

    if (typeof config.input === 'undefined') {
        throw new Error('ostro-vite plugin: missing either "input" or "ssr" configuration.');
    }

    const publicDirectory = config.publicDirectory ?? 'public';
    const buildDirectory = config.buildDirectory ?? 'build';

    return {
        input: config.input,
        publicDirectory,
        buildDirectory,
        hotFile: config.hotFile ?? path.join(publicDirectory, 'hot'),
        ssr: config.ssr ?? '',
        ssrOutputDirectory: config.ssrOutputDirectory ?? 'bootstrap/ssr',
        refresh: config.refresh ?? false,
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

    return {
        name: 'ostro',
        enforce: 'post',
        config: (config: UserConfig, { command, mode }: ConfigEnv): UserConfig => {
            userConfig = config;
            const ssr = !!userConfig.build?.ssr;
            const env = loadEnv(mode, userConfig.envDir || process.cwd(), '');
            const assetUrl = env.ASSET_URL ?? '';

            return {
                base: userConfig.base ?? (command === 'build' ? resolveBase(pluginConfig, assetUrl) : ''),
                publicDir: userConfig.publicDir ?? false,
                build: {
                    manifest: userConfig.build?.manifest ?? (ssr ? false : 'manifest.json'),
                    ssrManifest: userConfig.build?.ssrManifest ?? (ssr ? 'ssr-manifest.json' : false),
                    outDir: userConfig.build?.outDir ?? resolveOutDir(pluginConfig, ssr),
                    rollupOptions: {
                        input: userConfig.build?.rollupOptions?.input ?? resolveInput(pluginConfig, ssr),
                    },
                    assetsInlineLimit: userConfig.build?.assetsInlineLimit ?? 0,
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
    return path.join(pluginConfig.publicDirectory, pluginConfig.buildDirectory);
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
    return assetUrl + (!assetUrl.endsWith('/') ? '/' : '') + pluginConfig.buildDirectory + '/';
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
