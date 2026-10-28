import type { Plugin, UserConfig } from 'vite';

export interface FederationSharedConfig {
    import?: boolean | string;
    shareScope?: string;
    version?: string;
    requiredVersion?: string;
    singleton?: boolean;
    strictVersion?: boolean;
}

export type FederationShared =
    | string[]
    | Record<string, string | FederationSharedConfig>;

export interface RemoteConfig {
    external: string;
    externalType?: 'url' | 'promise';
    format?: 'esm' | 'var';
    from?: 'vite' | 'webpack';
}

export type FederationRemotes = Record<string, string | RemoteConfig>;

export type FederationExposes = Record<string, string>;

export interface ModuleFederationOptions {
    /**
     * Unique name of the federated module (Host or Remote).
     */
    name: string;

    /**
     * Entry filename for remote module manifests or bundles.
     *
     * @default 'remoteEntry.js'
     */
    filename?: string;

    /**
     * Modules exposed to other remote or host applications.
     *
     * Example:
     * ```ts
     * exposes: {
     *   './Header': './resources/assets/js/components/Header.tsx',
     *   './AuthContext': './resources/assets/js/context/AuthContext.ts',
     * }
     * ```
     */
    exposes?: FederationExposes;

    /**
     * Remotes consumed by this host application.
     *
     * Example:
     * ```ts
     * remotes: {
     *   adminDashboard: 'http://localhost:5174/remoteEntry.js',
     * }
     * ```
     */
    remotes?: FederationRemotes;

    /**
     * Shared libraries between Host and Remotes (e.g. ['react', 'react-dom']).
     */
    shared?: FederationShared;

    /**
     * Custom federation manifest filename for discovery.
     *
     * @default 'mf-manifest.json'
     */
    manifest?: boolean | string;

    /**
     * Target ECMAScript runtime.
     *
     * @default 'esnext'
     */
    target?: string;
}

/**
 * Creates an OstroJS Module Federation Vite Plugin for micro-frontends.
 * Enables zero-boilerplate code sharing between OstroJS hosts and remotes.
 *
 * @param options - Module Federation configuration options.
 */
export function federation(options: ModuleFederationOptions): Plugin {
    if (!options || typeof options !== 'object' || !options.name) {
        throw new Error('ostro-vite federation plugin: "name" is required.');
    }

    const filename = options.filename || 'remoteEntry.js';
    const target = options.target || 'esnext';
    const exposes = options.exposes || {};
    const remotes = options.remotes || {};
    const shared = options.shared || [];

    const virtualRemotePrefix = 'ostro:federation/remotes/';
    const virtualModulePrefix = 'ostro:federation/exposes/';

    return {
        name: 'ostro-vite-module-federation',
        enforce: 'post',

        config(userConfig: UserConfig): UserConfig {
            const alias: Record<string, string> = {};

            // Map remotes to virtual modules
            for (const [remoteKey, remoteVal] of Object.entries(remotes)) {
                alias[`^${remoteKey}$`] = `${virtualRemotePrefix}${remoteKey}`;
                alias[`^${remoteKey}/(.*)$`] = `${virtualRemotePrefix}${remoteKey}/$1`;
            }

            return {
                build: {
                    target,
                    rollupOptions: {
                        output: {
                            // Ensure shared packages can be preserved in distinct chunks
                            chunkFileNames: (chunkInfo) => {
                                if (chunkInfo.name === filename.replace(/\.js$/, '')) {
                                    return filename;
                                }
                                return userConfig.build?.rollupOptions?.output &&
                                    !Array.isArray(userConfig.build.rollupOptions.output) &&
                                    typeof userConfig.build.rollupOptions.output.chunkFileNames === 'string'
                                    ? userConfig.build.rollupOptions.output.chunkFileNames
                                    : 'assets/[name]-[hash].js';
                            }
                        }
                    }
                },
                resolve: {
                    alias: Array.isArray(userConfig.resolve?.alias)
                        ? userConfig.resolve.alias
                        : {
                            ...(userConfig.resolve?.alias || {}),
                            ...alias
                        }
                }
            };
        },

        resolveId(id: string) {
            if (id.startsWith(virtualRemotePrefix) || id.startsWith(virtualModulePrefix)) {
                return `\0${id}`;
            }
            if (id === filename || id === `/${filename}`) {
                return `\0ostro:federation/${filename}`;
            }
            return null;
        },

        load(id: string) {
            if (id === `\0ostro:federation/${filename}`) {
                const exposeExports = Object.entries(exposes).map(([exposeKey, exposePath]) => {
                    const cleanKey = exposeKey.replace(/^\.\//, '');
                    return `  './${cleanKey}': () => import('${exposePath}')`;
                }).join(',\n');

                return [
                    `// OstroJS Module Federation remoteEntry: ${options.name}`,
                    `const moduleMap = {`,
                    exposeExports,
                    `};`,
                    ``,
                    `export const get = (module) => {`,
                    `  if (!moduleMap[module]) {`,
                    `    throw new Error('Module ' + module + ' not found in ${options.name}');`,
                    `  }`,
                    `  return moduleMap[module]();`,
                    `};`,
                    ``,
                    `export const init = (shareScope = {}) => {`,
                    `  window.__OSTRO_FEDERATION_SCOPES__ = window.__OSTRO_FEDERATION_SCOPES__ || {};`,
                    `  window.__OSTRO_FEDERATION_SCOPES__['${options.name}'] = shareScope;`,
                    `};`,
                    ``,
                    `export default { get, init };`
                ].join('\n');
            }

            if (id.startsWith(`\0${virtualRemotePrefix}`)) {
                const remoteSpecifier = id.slice(`\0${virtualRemotePrefix}`.length);
                const parts = remoteSpecifier.split('/');
                const remoteName = parts[0];
                const subPath = parts.slice(1).join('/');
                const remoteVal = remotes[remoteName];
                const remoteUrl = typeof remoteVal === 'string' ? remoteVal : (remoteVal?.external || '');

                return [
                    `// Remote bridge for ${remoteSpecifier}`,
                    `async function loadRemote() {`,
                    `  const container = await import(/* @vite-ignore */ '${remoteUrl}');`,
                    `  if (container.init) {`,
                    `    await container.init(window.__OSTRO_SHARED_SCOPE__ || {});`,
                    `  }`,
                    subPath
                        ? `  return await container.get('./${subPath}');`
                        : `  return container;`,
                    `}`,
                    `const module = await loadRemote();`,
                    `export default module.default || module;`,
                    `export * from '${remoteUrl}';`
                ].join('\n');
            }

            return null;
        },

        generateBundle(_outputOptions, _bundle) {
            if (options.manifest !== false && (Object.keys(exposes).length > 0 || Object.keys(remotes).length > 0)) {
                const manifestName = typeof options.manifest === 'string' ? options.manifest : 'mf-manifest.json';
                const manifestData = {
                    id: options.name || 'ostro-federation',
                    name: options.name,
                    filename,
                    exposes,
                    remotes,
                    shared
                };
                this.emitFile({
                    type: 'asset',
                    fileName: manifestName,
                    source: JSON.stringify(manifestData, null, 2)
                });
            }
        }
    };
}

export default federation;
