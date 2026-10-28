import ostro, { defaultRefreshPaths } from '../src/index.js';
import fs from 'node:fs';
import path from 'node:path';

describe('@ostro/vite plugin', () => {
    test('exports ostro function and defaultRefreshPaths', () => {
        expect(typeof ostro).toBe('function');
        expect(Array.isArray(defaultRefreshPaths)).toBe(true);
    });

    test('throws error if no config provided', () => {
        expect(() => (ostro as any)()).toThrow('ostro-vite plugin: missing configuration.');
    });

    test('throws error if input is missing in object config', () => {
        expect(() => ostro({} as any)).toThrow('ostro-vite plugin: missing either "input" or "ssr" configuration.');
    });

    test('configures single input file', () => {
        const plugins = ostro('resources/assets/js/app.ts');
        expect(Array.isArray(plugins)).toBe(true);
        expect(plugins.length).toBeGreaterThan(0);

        const ostroPlugin: any = plugins[0];
        expect(ostroPlugin.name).toBe('ostro');
        expect(ostroPlugin.enforce).toBe('post');

        const resolved = ostroPlugin.config({} as any, { command: 'build', mode: 'production' });
        expect(resolved.build?.manifest).toBe('manifest.json');
        expect(resolved.build?.outDir).toBe('public/build');
        expect(resolved.build?.rollupOptions?.input).toBe('resources/assets/js/app.ts');
        expect(resolved.base).toBe('/build/');
        expect(resolved.resolve.alias).toBeDefined();
    });

    test('configures SSR mode properly', () => {
        const plugins = ostro({
            input: 'resources/assets/js/app.ts',
            ssr: 'resources/assets/js/ssr.ts',
            ssrOutputDirectory: 'bootstrap/ssr',
        });
        const ostroPlugin: any = plugins[0];
        const resolved = ostroPlugin.config({
            build: { ssr: true }
        } as any, { command: 'build', mode: 'production' });

        expect(resolved.build?.manifest).toBe(false);
        expect(resolved.build?.ssrManifest).toBe('ssr-manifest.json');
        expect(resolved.build?.outDir).toBe('bootstrap/ssr');
        expect(resolved.build?.rollupOptions?.input).toBe('resources/assets/js/ssr.ts');
    });

    test('preserves user custom aliases array and object', () => {
        const pluginsWithArray = ostro({
            input: 'resources/assets/js/app.ts',
        });
        const plugin1: any = pluginsWithArray[0];
        const resArray = plugin1.config({
            resolve: {
                alias: [{ find: '@custom', replacement: '/custom/path' }]
            }
        } as any, { command: 'build', mode: 'production' });
        expect(Array.isArray(resArray.resolve.alias)).toBe(true);

        const resObj = plugin1.config({
            resolve: {
                alias: { '@custom': '/custom/path' }
            }
        } as any, { command: 'build', mode: 'production' });
        expect(resObj.resolve.alias['@custom']).toBe('/custom/path');
    });

    test('configures custom buildDirectory and assetUrl', () => {
        process.env.ASSET_URL = 'https://cdn.example.com/';
        const plugins = ostro({
            input: ['resources/assets/js/app.ts', 'resources/assets/css/app.css'],
            buildDirectory: 'bundle',
            publicDirectory: 'dist-public',
        });
        const ostroPlugin: any = plugins[0];
        const resolved = ostroPlugin.config({} as any, { command: 'build', mode: 'production' });
        expect(resolved.build?.outDir).toBe('dist-public/bundle');
        expect(resolved.base).toBe('https://cdn.example.com/bundle/');
        delete process.env.ASSET_URL;
    });

    test('configures refresh paths with various formats', () => {
        const p1 = ostro({ input: 'app.ts', refresh: false });
        expect(p1.length).toBe(1);

        const p2 = ostro({ input: 'app.ts', refresh: true });
        expect(p2.length).toBe(2);

        const p3 = ostro({ input: 'app.ts', refresh: 'custom/path/**' });
        expect(p3.length).toBe(2);

        const p4 = ostro({ input: 'app.ts', refresh: ['path1/**', 'path2/**'] });
        expect(p4.length).toBe(2);

        const p5 = ostro({ input: 'app.ts', refresh: { paths: ['path1/**'] } });
        expect(p5.length).toBe(2);
    });

    test('configures transformOnServe in dev server mode', () => {
        const plugins = ostro({
            input: 'resources/assets/js/app.ts',
            transformOnServe: (code: string, url: string) => `/* served from ${url} */ ${code}`
        });
        const ostroPlugin: any = plugins[0];
        ostroPlugin.configResolved({ command: 'serve' });
        const result = ostroPlugin.transform('const x = "http://__ostro_vite_placeholder__.test/app.js";');
        expect(result).toContain('const x = "undefined/app.js";');
    });

    test('configures server dev server listening and middleware', () => {
        const tempHot = path.resolve(process.cwd(), 'temp-hot-file');
        const plugins = ostro({
            input: 'resources/assets/js/app.ts',
            hotFile: tempHot,
        });
        const ostroPlugin: any = plugins[0];
        ostroPlugin.config({} as any, { command: 'serve', mode: 'development' });
        ostroPlugin.configResolved({ command: 'serve', mode: 'development' });

        let listeningCallback: any;
        const middlewareList: any[] = [];
        const mockServer: any = {
            config: {
                base: '/',
                logger: { info: jest.fn() },
                server: { https: false, host: '127.0.0.1' }
            },
            httpServer: {
                address: () => ({ address: '127.0.0.1', family: 'IPv4', port: 5173 }),
                once: (event: string, cb: any) => {
                    if (event === 'listening') listeningCallback = cb;
                }
            },
            middlewares: {
                use: (fn: any) => middlewareList.push(fn)
            }
        };

        const postMiddlewareFactory = ostroPlugin.configureServer(mockServer);
        expect(typeof postMiddlewareFactory).toBe('function');
        postMiddlewareFactory();

        if (listeningCallback) listeningCallback();
        expect(fs.existsSync(tempHot)).toBe(true);
        const hotContent = fs.readFileSync(tempHot, 'utf-8');
        expect(hotContent).toContain('http://127.0.0.1:5173');
        fs.rmSync(tempHot);

        // Test dev server index.html 404 handler
        const devServerMiddleware = middlewareList[0];
        expect(typeof devServerMiddleware).toBe('function');

        let statusCode = 200;
        let endedWith = '';
        let nextCalled = false;
        devServerMiddleware(
            { url: '/index.html' },
            {
                set statusCode(val: number) { statusCode = val; },
                end: (content: string) => { endedWith = content; }
            },
            () => { nextCalled = true; }
        );
        expect(statusCode).toBe(404);
        expect(endedWith).toContain('OstroJS Vite Development Server');

        nextCalled = false;
        devServerMiddleware({ url: '/other.js' }, {}, () => { nextCalled = true; });
        expect(nextCalled).toBe(true);
    });
});
