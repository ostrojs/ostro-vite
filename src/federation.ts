import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import type { Plugin, UserConfig } from 'vite';

export interface FederationSharedConfig {
    import?: boolean | string;
    shareScope?: string;
    version?: string;
    requiredVersion?: string;
    singleton?: boolean;
    strictVersion?: boolean;
    packageName?: string;
}

export type FederationShared =
    | string[]
    | Record<string, string | FederationSharedConfig>;

export interface RemoteConfig {
    external: string;
    externalType?: 'url' | 'promise';
    format?: 'esm' | 'var' | 'systemjs';
    from?: 'vite' | 'webpack';
}

export type FederationRemotes = Record<string, string | RemoteConfig>;

export type FederationExposes = Record<string, string>;

export interface ModuleFederationManifest {
    id: string;
    name: string;
    meta?: Record<string, any>;
    remoteEntry?: {
        name: string;
        path: string;
        type?: string;
    };
    filename?: string;
    exposes?: FederationExposes;
    remotes?: FederationRemotes;
    shared?: FederationShared;
    assets?: string[];
}

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
     *   ordersApp: 'http://localhost:5175/mf-manifest.json',
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

    const isRemote = Object.keys(exposes).length > 0;
    const sharedList = Array.isArray(shared) ? shared : Object.keys(shared);
    const activeShared = isRemote ? sharedList : [];

    const virtualRemotePrefix = 'ostro:federation/remotes/';
    const virtualModulePrefix = 'ostro:federation/exposes/';

    const resolvePackageEntry = (pkgName: string): string => {
        try {
            const pkgJsonPath = path.resolve(process.cwd(), 'node_modules', pkgName, 'package.json');
            if (fs.existsSync(pkgJsonPath)) {
                const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
                const relativeEntry = pkg.module || (typeof pkg.browser === 'string' ? pkg.browser : null) || pkg.main || 'index.js';
                const resolved = path.resolve(path.dirname(pkgJsonPath), relativeEntry);
                if (fs.existsSync(resolved)) {
                    return resolved;
                }
            }
        } catch (_) {}
        try {
            const req = createRequire(path.resolve(process.cwd(), 'package.json'));
            return req.resolve(pkgName);
        } catch (_) {}
        return pkgName;
    };

    return {
        name: 'ostro-vite-module-federation',
        enforce: 'pre',

        config(userConfig: UserConfig): UserConfig {
            const alias: Record<string, string> = {};

            // Dynamically map all configured shared packages and their subpaths to virtual shared bridges
            for (const pkg of activeShared) {
                alias[`^${pkg}$`] = `\0ostro:federation/shared/${pkg}`;
                alias[`^${pkg}/(.*)$`] = `\0ostro:federation/shared/${pkg}/$1`;
            }

            // Map remotes to virtual modules
            for (const [remoteKey] of Object.entries(remotes)) {
                alias[`^${remoteKey}$`] = `${virtualRemotePrefix}${remoteKey}`;
                alias[`^${remoteKey}/(.*)$`] = `${virtualRemotePrefix}${remoteKey}/$1`;
            }

            // Expose runtime helper module
            alias['^__federation__$'] = '\0ostro:federation/runtime';

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

        buildStart() {
            if (Object.keys(exposes).length > 0) {
                this.emitFile({
                    type: 'chunk',
                    id: filename,
                    name: filename.replace(/\.js$/, ''),
                    fileName: `assets/${filename}`,
                    preserveSignature: 'exports-only'
                });
            }
        },

        resolveId(id: string) {
            if (id === '__federation__' || id === '\0ostro:federation/runtime') {
                return '\0ostro:federation/runtime';
            }
            // Check exact package or subpath match for any shared library
            for (const pkg of activeShared) {
                if (id === pkg || id.startsWith(`${pkg}/`)) {
                    return `\0ostro:federation/shared/${id}`;
                }
            }
            if (id.startsWith(virtualRemotePrefix) || id.startsWith(virtualModulePrefix)) {
                return `\0${id}`;
            }
            // Match any import targeting a configured remote: e.g. "freshRemoteApp/UserCard" or "freshRemoteApp"
            for (const remoteKey of Object.keys(remotes)) {
                if (id === remoteKey || id.startsWith(`${remoteKey}/`)) {
                    return `\0${virtualRemotePrefix}${id}`;
                }
            }
            if (id === filename || id === `/${filename}`) {
                return `\0ostro:federation/${filename}`;
            }
            return null;
        },

        load(id: string) {
            if (id.startsWith('\0ostro:federation/shared/')) {
                const pkgName = id.slice('\0ostro:federation/shared/'.length);
                const localPath = resolvePackageEntry(pkgName);

                return [
                    `import * as _LocalPkg from ${JSON.stringify(localPath)};`,
                    ``,
                    `const _getShared = () => {`,
                    `  if (typeof window !== 'undefined') {`,
                    `    const scope = window.__OSTRO_SHARED_SCOPE__;`,
                    `    if (scope && scope['${pkgName}']) {`,
                    `      const s = scope['${pkgName}'];`,
                    `      return s.value || (typeof s.get === 'function' ? s.get() : s);`,
                    `    }`,
                    `    if (window['${pkgName}']) {`,
                    `      return window['${pkgName}'];`,
                    `    }`,
                    `  }`,
                    `  return _LocalPkg.default || _LocalPkg;`,
                    `};`,
                    ``,
                    `const _proxy = new Proxy(_LocalPkg.default || _LocalPkg, {`,
                    `  get(target, prop) {`,
                    `    const S = _getShared();`,
                    `    const val = S ? S[prop] : target[prop];`,
                    `    return typeof val === 'function' ? val.bind(S) : val;`,
                    `  }`,
                    `});`,
                    ``,
                    `export default _proxy;`,
                    `export * from ${JSON.stringify(localPath)};`
                ].join('\n');
            }

            if (id === '\0ostro:federation/runtime') {
                return [
                    `// OstroJS Module Federation Runtime Helpers (__federation__)`,
                    `const registeredRemotes = {};`,
                    ``,
                    `export function __federation_method_setRemote(name, config) {`,
                    `  registeredRemotes[name] = config;`,
                    `}`,
                    ``,
                    `export async function __federation_method_getRemote(name, modulePath = '') {`,
                    `  const config = registeredRemotes[name] || {};`,
                    `  let url = typeof config.url === 'function' ? await config.url() : (config.url || config.external);`,
                    `  if (url && url.endsWith('.json')) {`,
                    `    const res = await fetch(url);`,
                    `    const manifest = await res.json();`,
                    `    const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);`,
                    `    url = baseUrl + (manifest.remoteEntry?.path || manifest.filename || 'remoteEntry.js');`,
                    `  }`,
                    `  const container = await import(/* @vite-ignore */ url);`,
                    `  if (container.init) {`,
                    `    await container.init(window.__OSTRO_SHARED_SCOPE__ || {});`,
                    `  }`,
                    `  return modulePath ? await container.get(modulePath) : container;`,
                    `}`,
                    ``,
                    `export const setRemote = __federation_method_setRemote;`,
                    `export const getRemote = __federation_method_getRemote;`,
                    `export default { setRemote, getRemote, __federation_method_setRemote, __federation_method_getRemote };`
                ].join('\n');
            }

            if (id === `\0ostro:federation/${filename}`) {
                const exposeExports = Object.entries(exposes).map(([exposeKey, exposePath]) => {
                    const cleanKey = exposeKey.replace(/^\.\//, '');
                    const resolvedPath = path.isAbsolute(exposePath) ? exposePath : path.resolve(process.cwd(), exposePath);
                    return `  './${cleanKey}': () => import('${resolvedPath}')`;
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
                    `  window.__OSTRO_SHARED_SCOPE__ = Object.assign(window.__OSTRO_SHARED_SCOPE__ || {}, shareScope);`,
                    `  window.__OSTRO_FEDERATION_SCOPES__ = window.__OSTRO_FEDERATION_SCOPES__ || {};`,
                    `  window.__OSTRO_FEDERATION_SCOPES__['${options.name}'] = shareScope;`,
                    `};`,
                    ``,
                    `// Interop for Webpack container consumers`,
                    `if (typeof window !== 'undefined') {`,
                    `  window['${options.name}'] = { get, init };`,
                    `}`,
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
                const isConfigObj = typeof remoteVal === 'object' && remoteVal !== null;
                const isPromiseType = isConfigObj && remoteVal.externalType === 'promise';
                const fromWebpack = isConfigObj && remoteVal.from === 'webpack';
                const remoteExpr = typeof remoteVal === 'string' ? remoteVal : (remoteVal?.external || '');

                const resolveUrlCode = isPromiseType
                    ? `  let url = await (${remoteExpr});`
                    : `  let url = '${remoteExpr}';`;

                return [
                    `// Remote bridge for ${remoteSpecifier}`,
                    `async function loadRemoteContainer() {`,
                    resolveUrlCode,
                    `  // If manifest URL is provided (MFT support), parse the manifest to resolve remoteEntry.js`,
                    `  if (url && url.endsWith('.json')) {`,
                    `    const res = await fetch(url);`,
                    `    const manifest = await res.json();`,
                    `    const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);`,
                    `    url = baseUrl + (manifest.remoteEntry?.path || manifest.filename || 'remoteEntry.js');`,
                    `  }`,
                    fromWebpack
                        ? [
                            `  // Webpack container interop`,
                            `  if (!window['${remoteName}']) {`,
                            `    await import(/* @vite-ignore */ url);`,
                            `  }`,
                            `  const container = window['${remoteName}'];`
                        ].join('\n')
                        : `  const container = await import(/* @vite-ignore */ url);`,
                    `  if (container.init) {`,
                    `    await container.init(window.__OSTRO_SHARED_SCOPE__ || {});`,
                    `  }`,
                    subPath
                        ? `  return await container.get('./${subPath}');`
                        : `  return container;`,
                    `}`,
                    `const module = await loadRemoteContainer();`,
                    `export default module.default || module;`
                ].join('\n');
            }

            return null;
        },

        generateBundle(_outputOptions, bundle) {
            if (options.manifest !== false && (Object.keys(exposes).length > 0 || Object.keys(remotes).length > 0)) {
                const manifestName = typeof options.manifest === 'string' ? options.manifest : 'mf-manifest.json';
                const assets: string[] = Object.keys(bundle);

                const manifestData: ModuleFederationManifest = {
                    id: options.name || 'ostro-federation',
                    name: options.name,
                    meta: {
                        framework: 'OstroJS',
                        buildTime: new Date().toISOString()
                    },
                    remoteEntry: {
                        name: filename,
                        path: filename,
                        type: 'esm'
                    },
                    filename,
                    exposes,
                    remotes,
                    shared,
                    assets
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
