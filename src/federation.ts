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
    shareKey?: string;
    packagePath?: string;
    generate?: boolean;
    modulePreload?: boolean;
}

export type FederationShared =
    | string[]
    | Record<string, string | FederationSharedConfig>;

export interface RemoteConfig {
    external: string;
    externalType?: 'url' | 'promise';
    format?: 'esm' | 'var' | 'systemjs';
    from?: 'vite' | 'webpack';
    shareScope?: string;
}

export type FederationRemotes = Record<string, string | RemoteConfig>;

export interface ExposeConfig {
    import: string;
    name?: string;
    dontAppendStylesToHead?: boolean;
}

export type FederationExposes = Record<string, string | ExposeConfig>;

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
    shareScope?: string;
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
     * Default share scope pool name (e.g. 'default').
     *
     * @default 'default'
     */
    shareScope?: string;

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
     * Shared libraries between Host and Remotes (e.g. ['react', 'react-dom'] or object config).
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

    /**
     * Custom chunk naming, splitting, and manual chunk aliasing like Webpack.
     */
    chunks?: {
        chunkFileNames?: string | ((chunkInfo: any) => string);
        assetFileNames?: string | ((chunkInfo: any) => string);
        entryFileNames?: string | ((chunkInfo: any) => string);
        manualChunks?: Record<string, string[]> | ((id: string) => string | void);
    };
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
    const defaultShareScope = options.shareScope || 'default';

    const isRemote = Object.keys(exposes).length > 0;
    const sharedList = Array.isArray(shared) ? shared : Object.keys(shared);
    const activeShared = isRemote ? sharedList : [];

    // Helper to get normalized shared configuration
    const getSharedConfig = (pkgName: string): FederationSharedConfig => {
        if (!Array.isArray(shared) && typeof shared === 'object' && shared[pkgName]) {
            const val = shared[pkgName];
            return typeof val === 'string' ? { version: val } : val;
        }
        return {};
    };

    const virtualRemotePrefix = 'ostro:federation/remotes/';
    const virtualModulePrefix = 'ostro:federation/exposes/';

    const resolvePackageEntry = (pkgName: string): string => {
        const sharedCfg = getSharedConfig(pkgName);
        if (sharedCfg.packagePath) {
            const customPath = path.isAbsolute(sharedCfg.packagePath)
                ? sharedCfg.packagePath
                : path.resolve(process.cwd(), sharedCfg.packagePath);
            if (fs.existsSync(customPath)) {
                return customPath;
            }
        }
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

            // Expose runtime helper module (supports both '__federation__' and 'virtual:__federation__')
            alias['^__federation__$'] = '\0ostro:federation/runtime';
            alias['^virtual:__federation__$'] = '\0ostro:federation/runtime';

            // Build manualChunks map or delegate if provided via options.chunks or exposed modules
            const existingOutput = userConfig.build?.rollupOptions?.output;
            const outputObj = !Array.isArray(existingOutput) && existingOutput ? existingOutput : {};

            const customChunkFileNames = options.chunks?.chunkFileNames || outputObj.chunkFileNames;
            const customAssetFileNames = options.chunks?.assetFileNames || outputObj.assetFileNames;
            const customEntryFileNames = options.chunks?.entryFileNames || outputObj.entryFileNames;

            // Compute exposed chunk aliases if desired (like Webpack's deterministic chunk aliasing)
            const manualChunks = options.chunks?.manualChunks || outputObj.manualChunks;

            return {
                build: {
                    target,
                    modulePreload: userConfig.build?.modulePreload ?? false,
                    rollupOptions: {
                        output: {
                            ...outputObj,
                            ...(customAssetFileNames ? { assetFileNames: customAssetFileNames } : {}),
                            ...(customEntryFileNames ? { entryFileNames: customEntryFileNames } : {}),
                            ...(manualChunks ? { manualChunks } : {}),
                            // Ensure remoteEntry.js stays at build root and user chunks follow custom naming
                            chunkFileNames: (chunkInfo) => {
                                if (chunkInfo.name === filename.replace(/\.js$/, '')) {
                                    return filename;
                                }
                                if (typeof customChunkFileNames === 'function') {
                                    return customChunkFileNames(chunkInfo);
                                }
                                if (typeof customChunkFileNames === 'string') {
                                    return customChunkFileNames;
                                }
                                return 'assets/[name]-[hash].js';
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
                    fileName: filename,
                    preserveSignature: 'exports-only'
                });
            }
        },

        resolveId(id: string) {
            if (id === '__federation__' || id === 'virtual:__federation__' || id === '\0ostro:federation/runtime') {
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
                const sharedCfg = getSharedConfig(pkgName);
                const shareKey = sharedCfg.shareKey || pkgName;
                const shareScopeName = sharedCfg.shareScope || defaultShareScope;
                const isSingleton = !!sharedCfg.singleton;
                const strictVersion = !!sharedCfg.strictVersion;
                const requiredVersion = sharedCfg.requiredVersion ? `'${sharedCfg.requiredVersion}'` : 'null';

                const nonStaticMethodNames = new Set([
                    'constructor', 'request', '_request', 'getUri', 'get', 'head', 'options',
                    'post', 'postForm', 'put', 'putForm', 'patch', 'patchForm', 'query',
                    'defaults', 'interceptors'
                ]);

                // Dynamically inspect all named exports from the local package to generate delegated proxies
                let exportKeys: string[] = [];
                try {
                    const req = createRequire(path.resolve(process.cwd(), 'package.json'));
                    let mod: any;
                    try {
                        const resolvedEntry = req.resolve(pkgName);
                        mod = req(resolvedEntry);
                    } catch (_) {
                        if (localPath && fs.existsSync(localPath)) {
                            mod = req(localPath);
                        }
                    }
                    if (mod && (typeof mod === 'object' || typeof mod === 'function')) {
                        const isFn = typeof mod === 'function';
                        exportKeys = Object.keys(mod).filter(k => {
                            if (k === 'default') return false;
                            if (k.startsWith('__') && k !== '__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED') return false;
                            return !isFn || !nonStaticMethodNames.has(k);
                        });
                    }
                } catch (_) {}

                const reservedWords = new Set([
                    'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
                    'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function',
                    'if', 'import', 'in', 'instanceof', 'new', 'return', 'super', 'switch',
                    'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
                    'let', 'static', 'enum', 'await'
                ]);

                const namedExportsCode = exportKeys.map(k => {
                    const safeIdentifier = (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k) && !reservedWords.has(k)) ? k : null;
                    if (!safeIdentifier) return '';
                    return `export const ${safeIdentifier} = new Proxy(function() {}, {
  apply(target, thisArg, args) {
    const S = _getShared();
    const resolved = (S && S !== _proxy) ? S : _LocalPkg;
    const fn = (resolved && typeof resolved.${safeIdentifier} !== 'undefined') ? resolved.${safeIdentifier} : _LocalPkg.${safeIdentifier};
    return typeof fn === 'function' ? fn.apply(resolved || _LocalPkg, args) : fn;
  },
  get(target, prop) {
    const S = _getShared();
    const resolved = (S && S !== _proxy) ? S : _LocalPkg;
    const obj = (resolved && typeof resolved.${safeIdentifier} !== 'undefined') ? resolved.${safeIdentifier} : _LocalPkg.${safeIdentifier};
    if (obj && typeof obj === 'object') {
      return obj[prop];
    }
    if (typeof obj === 'function' && typeof obj[prop] === 'function') {
      return obj[prop].bind(obj);
    }
    return obj ? obj[prop] : target[prop];
  }
});`;
                }).filter(Boolean).join('\n');

                const importFallback = sharedCfg.import !== false;

                const localImportLine = importFallback
                    ? `import * as _LocalPkg from ${JSON.stringify(localPath)};`
                    : `const _LocalPkg = {};`;

                const fallbackReturn = importFallback
                    ? `return _LocalPkg.default || _LocalPkg;`
                    : `throw new Error('Shared package "${pkgName}" is marked with import: false and must be provided by the host application.');`;

                return [
                    localImportLine,
                    ``,
                    `let _proxy;`,
                    `const _getShared = () => {`,
                    `  if (typeof window !== 'undefined') {`,
                    `    window.__OSTRO_FEDERATION_SCOPES__ = window.__OSTRO_FEDERATION_SCOPES__ || {};`,
                    `    const pool = window.__OSTRO_FEDERATION_SCOPES__['${shareScopeName}'] || window.__OSTRO_SHARED_SCOPE__;`,
                    `    if (pool && pool['${shareKey}']) {`,
                    `      const s = pool['${shareKey}'];`,
                    `      return s.value || (typeof s.get === 'function' ? s.get() : s);`,
                    `    }`,
                    `    if (window['${shareKey}']) {`,
                    `      return window['${shareKey}'];`,
                    `    }`,
                    `  }`,
                    `  ${fallbackReturn}`,
                    `};`,
                    ``,
                    `_proxy = new Proxy(_LocalPkg.default || _LocalPkg, {`,
                    `  get(target, prop) {`,
                    `    const S = _getShared();`,
                    `    const resolved = (S && S !== _proxy) ? S : target;`,
                    `    const val = (resolved && typeof resolved[prop] !== 'undefined') ? resolved[prop] : target[prop];`,
                    `    return typeof val === 'function' ? val.bind(resolved || target) : val;`,
                    `  }`,
                    `});`,
                    ``,
                    `export const __esModule = true;`,
                    `export default _proxy;`,
                    namedExportsCode
                ].filter(Boolean).join('\n');
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
                    `export async function __federation_method_getRemote(name, modulePath = '', shareScope = '${defaultShareScope}') {`,
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
                    `    const activeScope = (window.__OSTRO_FEDERATION_SCOPES__ && window.__OSTRO_FEDERATION_SCOPES__[shareScope]) || window.__OSTRO_SHARED_SCOPE__ || {};`,
                    `    await container.init(activeScope);`,
                    `  }`,
                    `  return modulePath ? await container.get(modulePath) : container;`,
                    `}`,
                    ``,
                    `export function __federation_method_unwrapDefault(module) {`,
                    `  return (module && module.__esModule && module.default) ? module.default : (module?.default || module);`,
                    `}`,
                    ``,
                    `export function __federation_method_wrapDefault(module, needCheck = true) {`,
                    `  if (!needCheck) return { default: module };`,
                    `  return (module && (module.__esModule || module[Symbol.toStringTag] === 'Module')) ? module : { default: module };`,
                    `}`,
                    ``,
                    `export async function __federation_method_ensure(name) {`,
                    `  return __federation_method_getRemote(name);`,
                    `}`,
                    ``,
                    `export const setRemote = __federation_method_setRemote;`,
                    `export const getRemote = __federation_method_getRemote;`,
                    `export const unwrapDefault = __federation_method_unwrapDefault;`,
                    `export const wrapDefault = __federation_method_wrapDefault;`,
                    `export const ensure = __federation_method_ensure;`,
                    `export default { setRemote, getRemote, unwrapDefault, wrapDefault, ensure, __federation_method_setRemote, __federation_method_getRemote, __federation_method_unwrapDefault, __federation_method_wrapDefault, __federation_method_ensure };`
                ].join('\n');
            }

            if (id === `\0ostro:federation/${filename}`) {
                const exposeExports = Object.entries(exposes).map(([exposeKey, exposeValue]) => {
                    const cleanKey = exposeKey.replace(/^\.\//, '');
                    const exposePath = typeof exposeValue === 'string' ? exposeValue : exposeValue.import;
                    const dontAppendStyles = typeof exposeValue === 'object' && !!exposeValue.dontAppendStylesToHead;
                    const resolvedPath = path.isAbsolute(exposePath) ? exposePath : path.resolve(process.cwd(), exposePath);
                    return `  './${cleanKey}': async () => {
    if (typeof window !== 'undefined' && !${dontAppendStyles}) {
      // Auto-inject styles associated with this exposed module if loaded
      const styles = window['css__${options.name}__${cleanKey}'] || [];
      styles.forEach(cssUrl => {
        if (!document.querySelector('link[href="' + cssUrl + '"]')) {
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = cssUrl;
          document.head.appendChild(link);
        }
      });
    }
    return import('${resolvedPath}');
  }`;
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
                    `export const init = (shareScope = {}, scopeName = '${defaultShareScope}') => {`,
                    `  window.__OSTRO_SHARED_SCOPE__ = Object.assign(window.__OSTRO_SHARED_SCOPE__ || {}, shareScope);`,
                    `  window.__OSTRO_FEDERATION_SCOPES__ = window.__OSTRO_FEDERATION_SCOPES__ || {};`,
                    `  window.__OSTRO_FEDERATION_SCOPES__[scopeName] = Object.assign(window.__OSTRO_FEDERATION_SCOPES__[scopeName] || {}, shareScope);`,
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
                const remoteScope = (isConfigObj && remoteVal.shareScope) || defaultShareScope;
                const remoteExpr = typeof remoteVal === 'string' ? remoteVal : (remoteVal?.external || '');

                const resolveUrlCode = isPromiseType
                    ? `  let url = await (${remoteExpr});`
                    : `  let url = '${remoteExpr}';`;

                const hostSharedEntries = sharedList.map((pkg) => {
                    const cfg = getSharedConfig(pkg);
                    const sKey = cfg.shareKey || pkg;
                    const sVersion = cfg.version || cfg.requiredVersion || '';
                    return `    if (typeof window !== 'undefined' && !scope['${sKey}']) {
      try {
        const mod = await import('${pkg}');
        const resolved = mod.default || mod;
        scope['${sKey}'] = { value: resolved, version: '${sVersion}', get: () => Promise.resolve(resolved) };
      } catch (_) {}
    }`;
                }).join('\n');

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
                    `    window.__OSTRO_SHARED_SCOPE__ = window.__OSTRO_SHARED_SCOPE__ || {};`,
                    `    window.__OSTRO_FEDERATION_SCOPES__ = window.__OSTRO_FEDERATION_SCOPES__ || {};`,
                    `    const scope = window.__OSTRO_FEDERATION_SCOPES__['${remoteScope}'] || window.__OSTRO_SHARED_SCOPE__;`,
                    hostSharedEntries,
                    `    window.__OSTRO_SHARED_SCOPE__ = Object.assign(window.__OSTRO_SHARED_SCOPE__, scope);`,
                    `    window.__OSTRO_FEDERATION_SCOPES__['${remoteScope}'] = scope;`,
                    `    await container.init(scope, '${remoteScope}');`,
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
                    shareScope: defaultShareScope,
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
