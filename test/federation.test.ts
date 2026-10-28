import { federation } from '../src/federation.js';

describe('Vite Module Federation plugin for OstroJS', () => {
    test('throws error if name is missing', () => {
        expect(() => (federation as any)()).toThrow('ostro-vite federation plugin: "name" is required.');
        expect(() => (federation as any)({} as any)).toThrow('ostro-vite federation plugin: "name" is required.');
    });

    test('configures module federation plugin with default parameters', () => {
        const plugin = federation({
            name: 'app_host'
        });

        expect(plugin.name).toBe('ostro-vite-module-federation');
        expect(plugin.enforce).toBe('pre');

        const resolvedConfig = (plugin as any).config({} as any);
        expect(resolvedConfig.build?.target).toBe('esnext');
        expect(resolvedConfig.resolve?.alias).toBeDefined();
    });

    test('configures remotes with virtual module aliases', () => {
        const plugin = federation({
            name: 'shell_app',
            remotes: {
                remoteDashboard: 'http://localhost:5174/remoteEntry.js',
                adminPanel: {
                    external: 'http://localhost:5175/remoteEntry.js'
                }
            }
        });

        const resolved = (plugin as any).config({} as any);
        expect(resolved.resolve.alias['^remoteDashboard$']).toBe('ostro:federation/remotes/remoteDashboard');
        expect(resolved.resolve.alias['^remoteDashboard/(.*)$']).toBe('ostro:federation/remotes/remoteDashboard/$1');
        expect(resolved.resolve.alias['^adminPanel$']).toBe('ostro:federation/remotes/adminPanel');
    });

    test('resolves and loads remoteEntry.js container', () => {
        const plugin = federation({
            name: 'ui_components',
            filename: 'customRemoteEntry.js',
            exposes: {
                './Button': './resources/assets/js/components/Button.tsx',
                './Navbar': './resources/assets/js/components/Navbar.tsx'
            }
        });

        // Test buildStart
        const emittedChunks: any[] = [];
        const mockContext = {
            emitFile: (c: any) => emittedChunks.push(c)
        };
        if ((plugin as any).buildStart) {
            (plugin as any).buildStart.call(mockContext);
            expect(emittedChunks.length).toBe(1);
            expect(emittedChunks[0].type).toBe('chunk');
        }

        // Test resolveId
        const resolvedId = (plugin as any).resolveId('customRemoteEntry.js');
        expect(resolvedId).toBe('\0ostro:federation/customRemoteEntry.js');

        // Test load
        const code = (plugin as any).load('\0ostro:federation/customRemoteEntry.js');
        expect(code).toContain('OstroJS Module Federation remoteEntry: ui_components');
        expect(code).toContain("'./Button': () => import(");
        expect(code).toContain("resources/assets/js/components/Button.tsx')");
        expect(code).toContain("'./Navbar': () => import(");
        expect(code).toContain("resources/assets/js/components/Navbar.tsx')");
        expect(code).toContain('export const get =');
        expect(code).toContain('export const init =');
    });

    test('resolves and loads remote bridge for consuming remotes', () => {
        const plugin = federation({
            name: 'host_app',
            remotes: {
                mfeStore: 'http://localhost:5180/assets/remoteEntry.js'
            }
        });

        const rootId = (plugin as any).resolveId('ostro:federation/remotes/mfeStore');
        expect(rootId).toBe('\0ostro:federation/remotes/mfeStore');

        const codeRoot = (plugin as any).load('\0ostro:federation/remotes/mfeStore');
        expect(codeRoot).toContain("let url = 'http://localhost:5180/assets/remoteEntry.js';");
        expect(codeRoot).toContain('await import(/* @vite-ignore */ url);');
        expect(codeRoot).toContain('return container;');

        const subId = (plugin as any).resolveId('ostro:federation/remotes/mfeStore/Cart');
        expect(subId).toBe('\0ostro:federation/remotes/mfeStore/Cart');

        const codeSub = (plugin as any).load('\0ostro:federation/remotes/mfeStore/Cart');
        expect(codeSub).toContain("return await container.get('./Cart');");
    });

    test('generates federation manifest asset when remotes or exposes are defined', () => {
        const plugin = federation({
            name: 'federated_core',
            manifest: 'custom-manifest.json',
            exposes: {
                './UserWidget': './resources/assets/js/UserWidget.tsx'
            },
            shared: ['react', 'react-dom']
        });

        const emittedFiles: any[] = [];
        const mockContext = {
            emitFile: (f: any) => emittedFiles.push(f)
        };

        const bundleMock = {
            'assets/UserWidget-abc.js': {},
            'assets/app-123.css': {}
        };

        (plugin as any).generateBundle.call(mockContext, {}, bundleMock);

        expect(emittedFiles.length).toBe(1);
        expect(emittedFiles[0].fileName).toBe('custom-manifest.json');
        const manifest = JSON.parse(emittedFiles[0].source);
        expect(manifest.name).toBe('federated_core');
        expect(manifest.exposes['./UserWidget']).toBe('./resources/assets/js/UserWidget.tsx');
        expect(manifest.shared).toEqual(['react', 'react-dom']);
        expect(manifest.assets).toContain('assets/UserWidget-abc.js');
        expect(manifest.remoteEntry.name).toBe('remoteEntry.js');
        expect(manifest.meta.framework).toBe('OstroJS');
    });

    test('supports promise remotes, manifest-based discovery, and webpack interop', () => {
        const plugin = federation({
            name: 'dynamic_host',
            remotes: {
                promiseRemote: {
                    external: 'Promise.resolve("http://localhost:6000/remoteEntry.js")',
                    externalType: 'promise'
                },
                webpackRemote: {
                    external: 'http://localhost:7000/remoteEntry.js',
                    from: 'webpack'
                },
                manifestRemote: {
                    external: 'http://localhost:8000/mf-manifest.json'
                }
            }
        });

        const promiseCode = (plugin as any).load('\0ostro:federation/remotes/promiseRemote/Button');
        expect(promiseCode).toContain('await (Promise.resolve("http://localhost:6000/remoteEntry.js"))');
        expect(promiseCode).toContain("container.get('./Button')");

        const webpackCode = (plugin as any).load('\0ostro:federation/remotes/webpackRemote/Nav');
        expect(webpackCode).toContain("window['webpackRemote']");

        const manifestCode = (plugin as any).load('\0ostro:federation/remotes/manifestRemote/Header');
        expect(manifestCode).toContain("if (url && url.endsWith('.json'))");
        expect(manifestCode).toContain('await fetch(url)');
    });

    test('provides __federation__ runtime helpers for dynamic runtime remote loading', () => {
        const plugin = federation({
            name: 'runtime_host'
        });

        const runtimeId = (plugin as any).resolveId('__federation__');
        expect(runtimeId).toBe('\0ostro:federation/runtime');

        const runtimeCode = (plugin as any).load('\0ostro:federation/runtime');
        expect(runtimeCode).toContain('__federation_method_setRemote');
        expect(runtimeCode).toContain('__federation_method_getRemote');
        expect(runtimeCode).toContain('manifest.remoteEntry?.path');
    });

    test('resolves and loads shared bridges for React, ReactDOM, and generic packages (axios)', () => {
        const plugin = federation({
            name: 'shared_remote',
            exposes: {
                './Card': './src/Card.tsx'
            },
            shared: ['react', 'react-dom', 'axios']
        });

        const reactId = (plugin as any).resolveId('react');
        expect(reactId).toBe('\0ostro:federation/shared/react');
        const reactCode = (plugin as any).load(reactId);
        expect(reactCode).toContain('window.__OSTRO_SHARED_SCOPE__?.react');
        expect(reactCode).toContain('export const useState =');

        const jsxId = (plugin as any).resolveId('react/jsx-runtime');
        expect(jsxId).toBe('\0ostro:federation/shared/react/jsx-runtime');
        const jsxCode = (plugin as any).load(jsxId);
        expect(jsxCode).toContain('export const jsx =');

        const jsxDevId = (plugin as any).resolveId('react/jsx-dev-runtime');
        expect(jsxDevId).toBe('\0ostro:federation/shared/react/jsx-dev-runtime');
        const jsxDevCode = (plugin as any).load(jsxDevId);
        expect(jsxDevCode).toContain('export const jsxDEV =');

        const domId = (plugin as any).resolveId('react-dom');
        expect(domId).toBe('\0ostro:federation/shared/react-dom');
        const domCode = (plugin as any).load(domId);
        expect(domCode).toContain('export const createPortal =');

        const domClientId = (plugin as any).resolveId('react-dom/client');
        expect(domClientId).toBe('\0ostro:federation/shared/react-dom/client');
        const domClientCode = (plugin as any).load(domClientId);
        expect(domClientCode).toContain('export const createRoot =');

        const axiosId = (plugin as any).resolveId('axios');
        expect(axiosId).toBe('\0ostro:federation/shared/axios');
        const axiosCode = (plugin as any).load(axiosId);
        expect(axiosCode).toContain("scope['axios']");
        expect(axiosCode).toContain('export default _proxy;');
    });

    test('preserves user chunkFileNames function and configures filename', () => {
        const plugin = federation({
            name: 'header_remote',
            filename: 'headerEntry.js'
        });

        const resolved = (plugin as any).config({
            build: {
                rollupOptions: {
                    output: {
                        chunkFileNames: 'custom/[name].js'
                    }
                }
            }
        });

        const chunkNaming = resolved.build.rollupOptions.output.chunkFileNames;
        expect(chunkNaming({ name: 'headerEntry' })).toBe('headerEntry.js');
        expect(chunkNaming({ name: 'otherChunk' })).toBe('custom/[name].js');

        // Test fallback
        const plugin2 = federation({ name: 'fallback_remote' });
        const resolved2 = (plugin2 as any).config({} as any);
        const chunkNaming2 = resolved2.build.rollupOptions.output.chunkFileNames;
        expect(chunkNaming2({ name: 'remoteEntry' })).toBe('remoteEntry.js');
        expect(chunkNaming2({ name: 'other' })).toBe('assets/[name]-[hash].js');
    });

    test('returns null for unrelated resolveId and load', () => {
        const plugin = federation({ name: 'test_plugin' });
        expect((plugin as any).resolveId('some-random-id')).toBeNull();
        expect((plugin as any).load('some-random-id')).toBeNull();
        expect((plugin as any).resolveId('/remoteEntry.js')).toBe('\0ostro:federation/remoteEntry.js');
    });
});

