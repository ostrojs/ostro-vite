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
        expect(() => ostro({} as any)).toThrow('ostro-vite plugin: missing either "input", "assets", or "ssr" configuration.');
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

    test('supports custom outDir and hybrid output subdirectories (jsDir, cssDir, mediaDir)', () => {
        const plugins = ostro({
            input: 'resources/assets/js/app.ts',
            outDir: 'dist',
            output: {
                jsDir: 'js',
                cssDir: 'css',
                mediaDir: 'images',
                chunkFileNames: 'js/[name].js'
            }
        });

        const ostroPlugin: any = plugins[0];
        const resolved = ostroPlugin.config({} as any, { command: 'build', mode: 'production' });

        expect(resolved.build?.outDir).toBe('dist');
        expect(resolved.base).toBe('/dist/');

        const rollupOut = resolved.build?.rollupOptions?.output;
        expect(rollupOut.chunkFileNames).toBe('js/[name].js');
        expect(rollupOut.entryFileNames).toBe('js/[name]-[hash].js');

        // Test assetFileNames function
        const assetFileNamesFn = rollupOut.assetFileNames;
        expect(typeof assetFileNamesFn).toBe('function');
        expect(assetFileNamesFn({ name: 'theme.css' })).toBe('css/[name]-[hash][extname]');
        expect(assetFileNamesFn({ name: 'logo.png' })).toBe('images/[name]-[hash][extname]');
    });

    test('supports scalable assets array with modular entry and output rules', () => {
        const plugins = ostro({
            buildDirectory: 'dist',
            assets: [
                {
                    input: 'resources/assets/js/app.ts',
                    output: {
                        entryFileNames: 'js/[name].js'
                    }
                },
                {
                    input: ['resources/assets/css/app.css'],
                    output: {
                        entryFileNames: 'css/[name].css'
                    }
                }
            ]
        });

        const ostroPlugin: any = plugins[0];
        const resolved = ostroPlugin.config({} as any, { command: 'build', mode: 'production' });

        expect(resolved.build?.rollupOptions?.input).toEqual([
            'resources/assets/js/app.ts',
            'resources/assets/css/app.css'
        ]);

        const entryResolver = resolved.build?.rollupOptions?.output?.entryFileNames;
        expect(typeof entryResolver).toBe('function');
        expect(entryResolver({ facadeModuleId: '/root/resources/assets/js/app.ts' })).toBe('js/[name].js');
        expect(entryResolver({ facadeModuleId: '/root/resources/assets/css/app.css' })).toBe('css/[name].css');
    });

    test('supports buildDirectory: false to output directly into public directory without build subdir', () => {
        const plugins = ostro({
            publicDirectory: 'dist',
            buildDirectory: false,
            input: 'resources/assets/js/app.ts'
        });
        const ostroPlugin: any = plugins[0];
        const resolved = ostroPlugin.config({} as any, { command: 'build', mode: 'production' });

        expect(resolved.build?.outDir).toBe('dist');
        expect(resolved.base).toBe('/');
    });

    test('supports empty string buildDirectory and custom assetUrl', () => {
        const plugins = ostro({
            publicDirectory: 'custom-public',
            buildDirectory: '',
            input: 'resources/assets/js/app.ts'
        });
        const ostroPlugin: any = plugins[0];
        const resolved = ostroPlugin.config({} as any, { command: 'build', mode: 'production' });

        expect(resolved.build?.outDir).toBe('custom-public');
        expect(resolved.base).toBe('/');
        expect(resolved.build?.emptyOutDir).toBe(false);
    });

    test('sets emptyOutDir to true when buildDirectory is specified, unless overridden by user', () => {
        const plugins = ostro({
            buildDirectory: 'dist',
            input: 'resources/assets/js/app.ts'
        });
        const ostroPlugin: any = plugins[0];
        const resolved = ostroPlugin.config({} as any, { command: 'build', mode: 'production' });

        expect(resolved.build?.emptyOutDir).toBe(true);

        const customEmpty = ostroPlugin.config({
            build: { emptyOutDir: false }
        } as any, { command: 'build', mode: 'production' });
        expect(customEmpty.build?.emptyOutDir).toBe(false);
    });

    test('automatically emits index.html when html option is enabled with dynamic manifest bundles', () => {
        const plugins = ostro({
            input: 'resources/assets/js/app.ts',
            html: {
                title: 'Test Ostro App',
                mountId: 'app'
            }
        });
        const ostroPlugin: any = plugins[0];
        let emittedFile: any = null;
        const mockContext = {
            emitFile: (file: any) => {
                emittedFile = file;
            }
        };

        const mockBundle = {
            'js/app-B7apGlpb.js': {
                type: 'chunk',
                isEntry: true
            },
            'css/app-l0sNRNKZ.css': {
                type: 'asset'
            }
        };

        ostroPlugin.generateBundle.call(mockContext, {}, mockBundle);
        expect(emittedFile).toBeDefined();
        expect(emittedFile.fileName).toBe('index.html');
        expect(emittedFile.source).toContain('<title>Test Ostro App</title>');
        expect(emittedFile.source).toContain('<link rel="stylesheet" href="/css/app-l0sNRNKZ.css">');
        expect(emittedFile.source).toContain('<script type="module" src="/js/app-B7apGlpb.js"></script>');
    });

    test('supports string html filename and custom template replacement', () => {
        const plugins = ostro({
            input: 'resources/assets/js/app.ts',
            html: {
                filename: 'custom.html',
                template: '<html><head><!-- css-links --></head><body><div id="{{ mountId }}"></div><!-- js-scripts --></body></html>',
                mountId: 'root'
            }
        });
        const ostroPlugin: any = plugins[0];
        let emittedFile: any = null;
        const mockContext = {
            emitFile: (file: any) => {
                emittedFile = file;
            }
        };

        const mockBundle = {
            'js/main.js': {
                type: 'chunk',
                isEntry: true
            }
        };

        ostroPlugin.generateBundle.call(mockContext, {}, mockBundle);
        expect(emittedFile.fileName).toBe('custom.html');
        expect(emittedFile.source).toContain('<div id="root"></div>');
        expect(emittedFile.source).toContain('<script type="module" src="/js/main.js"></script>');
    });

    test('writeBundle defaults to cleaning obsolete previous files based on manifest.json without generating text manifest', () => {
        const tempTestDir = path.resolve(__dirname, 'temp_clean_test_json');
        if (!fs.existsSync(tempTestDir)) {
            fs.mkdirSync(tempTestDir, { recursive: true });
        }

        const oldFile = path.resolve(tempTestDir, 'app-oldHash.js');
        const activeFile = path.resolve(tempTestDir, 'app-newHash.js');
        const manifestJson = path.resolve(tempTestDir, 'manifest.json');
        const manifestTxt = path.resolve(tempTestDir, 'build-manifest.txt');

        fs.writeFileSync(oldFile, 'console.log("old");');
        fs.writeFileSync(activeFile, 'console.log("new");');
        fs.writeFileSync(manifestJson, JSON.stringify({
            'resources/assets/js/app.ts': {
                file: 'app-oldHash.js',
                isEntry: true
            }
        }));

        const plugins = ostro({
            input: 'resources/assets/js/app.ts',
            clean: true,
        });
        const ostroPlugin: any = plugins[0];
        ostroPlugin.configResolved({
            build: { outDir: tempTestDir, manifest: 'manifest.json' },
            root: tempTestDir,
        });

        const newBundle = {
            'app-newHash.js': {
                name: 'app',
                type: 'chunk',
                isEntry: true
            }
        };

        ostroPlugin.buildStart();
        ostroPlugin.writeBundle({}, newBundle);

        // Old file must be cleaned up based on previous manifest.json
        expect(fs.existsSync(oldFile)).toBe(false);
        // Active file must still exist
        expect(fs.existsSync(activeFile)).toBe(true);
        // build-manifest.txt should NOT be generated because user did not mention it
        expect(fs.existsSync(manifestTxt)).toBe(false);

        // Cleanup temp test directory
        fs.rmSync(tempTestDir, { recursive: true, force: true });
    });

    test('writeBundle generates text tracker and cleans when clean.trackerFile is explicitly specified', () => {
        const tempTestDir = path.resolve(__dirname, 'temp_clean_test_txt');
        if (!fs.existsSync(tempTestDir)) {
            fs.mkdirSync(tempTestDir, { recursive: true });
        }

        const oldFile = path.resolve(tempTestDir, 'app-oldHash.js');
        const activeFile = path.resolve(tempTestDir, 'app-newHash.js');
        const customTxt = path.resolve(tempTestDir, 'build-tracker.txt');

        fs.writeFileSync(oldFile, 'console.log("old");');
        fs.writeFileSync(activeFile, 'console.log("new");');
        fs.writeFileSync(customTxt, 'app=app-oldHash.js\n');

        const plugins = ostro({
            input: 'resources/assets/js/app.ts',
            clean: { trackerFile: 'build-tracker.txt' },
        });
        const ostroPlugin: any = plugins[0];
        ostroPlugin.configResolved({
            build: { outDir: tempTestDir },
            root: tempTestDir,
        });

        const newBundle = {
            'app-newHash.js': {
                name: 'app',
                type: 'chunk',
                isEntry: true
            }
        };

        ostroPlugin.buildStart();
        ostroPlugin.writeBundle({}, newBundle);

        // Old file must be cleaned up
        expect(fs.existsSync(oldFile)).toBe(false);
        // Active file must still exist
        expect(fs.existsSync(activeFile)).toBe(true);
        // Custom text tracker should be updated
        const content = fs.readFileSync(customTxt, 'utf-8');
        expect(content).toContain('app=app-newHash.js');

        // Cleanup temp test directory
        fs.rmSync(tempTestDir, { recursive: true, force: true });
    });

    test('writeBundle falls back to manifest.json when trackerFile is specified but not yet present on disk', () => {
        const tempTestDir = path.resolve(__dirname, 'temp_clean_test_fallback');
        if (!fs.existsSync(tempTestDir)) {
            fs.mkdirSync(tempTestDir, { recursive: true });
        }

        const oldFile = path.resolve(tempTestDir, 'app-oldHash.js');
        const activeFile = path.resolve(tempTestDir, 'app-newHash.js');
        const manifestJson = path.resolve(tempTestDir, 'manifest.json');
        const customTxt = path.resolve(tempTestDir, 'build-tracker.txt');

        fs.writeFileSync(oldFile, 'console.log("old");');
        fs.writeFileSync(activeFile, 'console.log("new");');
        fs.writeFileSync(manifestJson, JSON.stringify({
            'resources/assets/js/app.ts': {
                file: 'app-oldHash.js',
                isEntry: true
            }
        }));

        // customTxt does NOT exist initially
        expect(fs.existsSync(customTxt)).toBe(false);

        const plugins = ostro({
            input: 'resources/assets/js/app.ts',
            clean: { trackerFile: 'build-tracker.txt' },
        });
        const ostroPlugin: any = plugins[0];
        ostroPlugin.configResolved({
            build: { outDir: tempTestDir, manifest: 'manifest.json' },
            root: tempTestDir,
        });

        const newBundle = {
            'app-newHash.js': {
                name: 'app',
                type: 'chunk',
                isEntry: true
            }
        };

        ostroPlugin.buildStart();
        ostroPlugin.writeBundle({}, newBundle);

        // Old file must be cleaned up via manifest.json fallback
        expect(fs.existsSync(oldFile)).toBe(false);
        // Active file must still exist
        expect(fs.existsSync(activeFile)).toBe(true);
        // customTxt should now be created
        expect(fs.existsSync(customTxt)).toBe(true);

        // Cleanup temp test directory
        fs.rmSync(tempTestDir, { recursive: true, force: true });
    });

    test('writeBundle respects clean: false', () => {
        const plugins = ostro({
            input: 'resources/assets/js/app.ts',
            clean: false,
        });
        const ostroPlugin: any = plugins[0];
        expect(() => ostroPlugin.writeBundle({}, {})).not.toThrow();
    });
});

