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
        expect(plugin.enforce).toBe('post');

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

        // Test resolveId
        const resolvedId = (plugin as any).resolveId('customRemoteEntry.js');
        expect(resolvedId).toBe('\0ostro:federation/customRemoteEntry.js');

        // Test load
        const code = (plugin as any).load('\0ostro:federation/customRemoteEntry.js');
        expect(code).toContain('OstroJS Module Federation remoteEntry: ui_components');
        expect(code).toContain("'./Button': () => import('./resources/assets/js/components/Button.tsx')");
        expect(code).toContain("'./Navbar': () => import('./resources/assets/js/components/Navbar.tsx')");
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
        expect(codeRoot).toContain("import(/* @vite-ignore */ 'http://localhost:5180/assets/remoteEntry.js')");
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

        (plugin as any).generateBundle.call(mockContext, {}, {});

        expect(emittedFiles.length).toBe(1);
        expect(emittedFiles[0].fileName).toBe('custom-manifest.json');
        const manifest = JSON.parse(emittedFiles[0].source);
        expect(manifest.name).toBe('federated_core');
        expect(manifest.exposes['./UserWidget']).toBe('./resources/assets/js/UserWidget.tsx');
        expect(manifest.shared).toEqual(['react', 'react-dom']);
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

