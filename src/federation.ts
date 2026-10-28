import path from 'path';
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
    const genericShared = isRemote ? sharedList.filter(pkg => pkg !== 'react' && pkg !== 'react-dom') : [];
    const shareReact = isRemote && sharedList.includes('react');
    const shareReactDOM = isRemote && (sharedList.includes('react-dom') || sharedList.includes('react'));

    const virtualRemotePrefix = 'ostro:federation/remotes/';
    const virtualModulePrefix = 'ostro:federation/exposes/';

    return {
        name: 'ostro-vite-module-federation',
        enforce: 'post',

        config(userConfig: UserConfig): UserConfig {
            const alias: Record<string, string> = {};

            // Map shared packages in remote apps to virtual shared bridges
            if (shareReact) {
                alias['^react$'] = '\0ostro:federation/shared/react';
                alias['^react/jsx-runtime$'] = '\0ostro:federation/shared/react/jsx-runtime';
                alias['^react/jsx-dev-runtime$'] = '\0ostro:federation/shared/react/jsx-dev-runtime';
            }
            if (shareReactDOM) {
                alias['^react-dom$'] = '\0ostro:federation/shared/react-dom';
                alias['^react-dom/client$'] = '\0ostro:federation/shared/react-dom/client';
            }

            for (const pkg of genericShared) {
                alias[`^${pkg}$`] = `\0ostro:federation/shared/${pkg}`;
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
            if (shareReact) {
                if (id === 'react') {
                    return '\0ostro:federation/shared/react';
                }
                if (id === 'react/jsx-runtime') {
                    return '\0ostro:federation/shared/react/jsx-runtime';
                }
                if (id === 'react/jsx-dev-runtime') {
                    return '\0ostro:federation/shared/react/jsx-dev-runtime';
                }
            }
            if (shareReactDOM) {
                if (id === 'react-dom') {
                    return '\0ostro:federation/shared/react-dom';
                }
                if (id === 'react-dom/client') {
                    return '\0ostro:federation/shared/react-dom/client';
                }
            }
            if (genericShared.includes(id)) {
                return `\0ostro:federation/shared/${id}`;
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
            if (id === '\0ostro:federation/shared/react') {
                let localPath = 'react';
                try {
                    const req = createRequire(path.resolve(process.cwd(), 'package.json'));
                    localPath = req.resolve('react');
                } catch (_) {}

                return [
                    `import * as _LocalReact from ${JSON.stringify(localPath)};`,
                    ``,
                    `const _getShared = () => {`,
                    `  if (typeof window !== 'undefined') {`,
                    `    if (window.React) return window.React;`,
                    `    if (window.__OSTRO_SHARED_SCOPE__?.react) {`,
                    `      const s = window.__OSTRO_SHARED_SCOPE__.react;`,
                    `      return s.value || (typeof s.get === 'function' ? s.get() : s);`,
                    `    }`,
                    `  }`,
                    `  return _LocalReact.default || _LocalReact;`,
                    `};`,
                    ``,
                    `if (typeof window !== 'undefined' && !window.React) {`,
                    `  window.React = _LocalReact.default || _LocalReact;`,
                    `}`,
                    ``,
                    `export const useState = (...args) => _getShared().useState(...args);`,
                    `export const useEffect = (...args) => _getShared().useEffect(...args);`,
                    `export const useContext = (...args) => _getShared().useContext(...args);`,
                    `export const useReducer = (...args) => _getShared().useReducer(...args);`,
                    `export const useCallback = (...args) => _getShared().useCallback(...args);`,
                    `export const useMemo = (...args) => _getShared().useMemo(...args);`,
                    `export const useRef = (...args) => _getShared().useRef(...args);`,
                    `export const useImperativeHandle = (...args) => _getShared().useImperativeHandle(...args);`,
                    `export const useLayoutEffect = (...args) => _getShared().useLayoutEffect(...args);`,
                    `export const useInsertionEffect = (...args) => _getShared().useInsertionEffect(...args);`,
                    `export const useDebugValue = (...args) => _getShared().useDebugValue(...args);`,
                    `export const useDeferredValue = (...args) => _getShared().useDeferredValue(...args);`,
                    `export const useTransition = (...args) => _getShared().useTransition(...args);`,
                    `export const useId = (...args) => _getShared().useId(...args);`,
                    `export const useSyncExternalStore = (...args) => _getShared().useSyncExternalStore(...args);`,
                    `export const createElement = (...args) => _getShared().createElement(...args);`,
                    `export const cloneElement = (...args) => _getShared().cloneElement(...args);`,
                    `export const createContext = (...args) => _getShared().createContext(...args);`,
                    `export const createRef = (...args) => _getShared().createRef(...args);`,
                    `export const forwardRef = (...args) => _getShared().forwardRef(...args);`,
                    `export const memo = (...args) => _getShared().memo(...args);`,
                    `export const lazy = (...args) => _getShared().lazy(...args);`,
                    `export const startTransition = (...args) => _getShared().startTransition(...args);`,
                    `export const isValidElement = (...args) => _getShared().isValidElement(...args);`,
                    `export const Children = new Proxy({}, { get: (_, p) => _getShared().Children?.[p] });`,
                    `export const Fragment = (typeof Symbol === 'function' && Symbol.for) ? Symbol.for('react.fragment') : 0xeacb;`,
                    `export const StrictMode = (typeof Symbol === 'function' && Symbol.for) ? Symbol.for('react.strict_mode') : 0xeacc;`,
                    `export const Suspense = (typeof Symbol === 'function' && Symbol.for) ? Symbol.for('react.suspense') : 0xead1;`,
                    `export const Profiler = (typeof Symbol === 'function' && Symbol.for) ? Symbol.for('react.profiler') : 0xead2;`,
                    `export const Component = _LocalReact.Component || _LocalReact.default?.Component;`,
                    `export const PureComponent = _LocalReact.PureComponent || _LocalReact.default?.PureComponent;`,
                    `export const version = '18.3.1';`,
                    `export const __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED = new Proxy({}, {`,
                    `  get: (_, p) => _getShared().__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED?.[p]`,
                    `});`,
                    ``,
                    `const ReactProxy = new Proxy(_LocalReact.default || _LocalReact, {`,
                    `  get(target, prop) {`,
                    `    const R = _getShared();`,
                    `    const val = R ? R[prop] : target[prop];`,
                    `    return typeof val === 'function' ? val.bind(R) : val;`,
                    `  }`,
                    `});`,
                    ``,
                    `export default ReactProxy;`
                ].join('\n');
            }

            if (id === '\0ostro:federation/shared/react/jsx-runtime') {
                let localPath = 'react/jsx-runtime';
                try {
                    const req = createRequire(path.resolve(process.cwd(), 'package.json'));
                    localPath = req.resolve('react/jsx-runtime');
                } catch (_) {}

                return [
                    `import * as _LocalJSX from ${JSON.stringify(localPath)};`,
                    ``,
                    `const _getJSX = () => {`,
                    `  if (typeof window !== 'undefined') {`,
                    `    if (window.ReactJSXRuntime) return window.ReactJSXRuntime;`,
                    `  }`,
                    `  return _LocalJSX;`,
                    `};`,
                    ``,
                    `export const jsx = (...args) => _getJSX().jsx(...args);`,
                    `export const jsxs = (...args) => _getJSX().jsxs(...args);`,
                    `export const Fragment = (typeof Symbol === 'function' && Symbol.for) ? Symbol.for('react.fragment') : 0xeacb;`,
                    `export default { jsx, jsxs, Fragment };`
                ].join('\n');
            }

            if (id === '\0ostro:federation/shared/react/jsx-dev-runtime') {
                let localPath = 'react/jsx-dev-runtime';
                try {
                    const req = createRequire(path.resolve(process.cwd(), 'package.json'));
                    localPath = req.resolve('react/jsx-dev-runtime');
                } catch (_) {}

                return [
                    `import * as _LocalJSXDev from ${JSON.stringify(localPath)};`,
                    ``,
                    `const _getJSXDev = () => {`,
                    `  if (typeof window !== 'undefined') {`,
                    `    if (window.ReactJSXDevRuntime) return window.ReactJSXDevRuntime;`,
                    `  }`,
                    `  return _LocalJSXDev;`,
                    `};`,
                    ``,
                    `export const jsxDEV = (...args) => _getJSXDev().jsxDEV(...args);`,
                    `export const Fragment = (typeof Symbol === 'function' && Symbol.for) ? Symbol.for('react.fragment') : 0xeacb;`,
                    `export default { jsxDEV, Fragment };`
                ].join('\n');
            }

            if (id === '\0ostro:federation/shared/react-dom') {
                let localPath = 'react-dom';
                try {
                    const req = createRequire(path.resolve(process.cwd(), 'package.json'));
                    localPath = req.resolve('react-dom');
                } catch (_) {}

                return [
                    `import * as _LocalDOM from ${JSON.stringify(localPath)};`,
                    ``,
                    `const _getDOM = () => {`,
                    `  if (typeof window !== 'undefined') {`,
                    `    if (window.ReactDOM) return window.ReactDOM;`,
                    `  }`,
                    `  return _LocalDOM.default || _LocalDOM;`,
                    `};`,
                    ``,
                    `export const createPortal = (...args) => _getDOM().createPortal(...args);`,
                    `export const createRoot = (...args) => _getDOM().createRoot(...args);`,
                    `export const hydrateRoot = (...args) => _getDOM().hydrateRoot(...args);`,
                    `export const findDOMNode = (...args) => _getDOM().findDOMNode(...args);`,
                    `export const flushSync = (...args) => _getDOM().flushSync(...args);`,
                    `export const render = (...args) => _getDOM().render(...args);`,
                    `export const hydrate = (...args) => _getDOM().hydrate(...args);`,
                    `export const unmountComponentAtNode = (...args) => _getDOM().unmountComponentAtNode(...args);`,
                    `export const version = '18.3.1';`,
                    `export const __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED = new Proxy({}, {`,
                    `  get: (_, p) => _getDOM().__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED?.[p]`,
                    `});`,
                    ``,
                    `const DOMProxy = new Proxy(_LocalDOM.default || _LocalDOM, {`,
                    `  get(target, prop) {`,
                    `    const D = _getDOM();`,
                    `    const val = D ? D[prop] : target[prop];`,
                    `    return typeof val === 'function' ? val.bind(D) : val;`,
                    `  }`,
                    `});`,
                    `export default DOMProxy;`
                ].join('\n');
            }

            if (id === '\0ostro:federation/shared/react-dom/client') {
                let localPath = 'react-dom/client';
                try {
                    const req = createRequire(path.resolve(process.cwd(), 'package.json'));
                    localPath = req.resolve('react-dom/client');
                } catch (_) {}

                return [
                    `import * as _LocalDOMClient from ${JSON.stringify(localPath)};`,
                    ``,
                    `const _getDOMClient = () => {`,
                    `  if (typeof window !== 'undefined') {`,
                    `    if (window.ReactDOMClient) return window.ReactDOMClient;`,
                    `    if (window.ReactDOM && window.ReactDOM.createRoot) return window.ReactDOM;`,
                    `  }`,
                    `  return _LocalDOMClient;`,
                    `};`,
                    ``,
                    `export const createRoot = (...args) => _getDOMClient().createRoot(...args);`,
                    `export const hydrateRoot = (...args) => _getDOMClient().hydrateRoot(...args);`,
                    `export default { createRoot, hydrateRoot };`
                ].join('\n');
            }

            if (id.startsWith('\0ostro:federation/shared/')) {
                const pkgName = id.slice('\0ostro:federation/shared/'.length);
                if (pkgName !== 'react' && !pkgName.startsWith('react/') && pkgName !== 'react-dom' && !pkgName.startsWith('react-dom/')) {
                    let localPath = pkgName;
                    try {
                        const req = createRequire(path.resolve(process.cwd(), 'package.json'));
                        localPath = req.resolve(pkgName);
                    } catch (_) {}

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
                    `export default module.default || module;`,
                    `export * from '${remoteExpr}';`
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
