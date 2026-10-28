# @ostro/vite

Vite plugin and Module Federation engine for the OstroJS framework.

## Installation

```bash
npm install -D @ostro/vite vite
```

## Basic Usage

In your `vite.config.ts`:

```typescript
import { defineConfig } from 'vite';
import ostro from '@ostro/vite';

export default defineConfig({
    plugins: [
        ostro({
            input: [
                'resources/assets/css/app.css',
                'resources/assets/js/app.ts',
            ],
            refresh: true,
        }),
    ],
});
```

### Scripts

Update your `package.json`:

```json
"scripts": {
    "dev": "vite",
    "build": "vite build"
}
```

---

## Module Federation & Micro Frontends (MFT)

`@ostro/vite` provides first-class support for Vite Module Federation, Webpack container interop, dynamic promise-based remotes, and automated discovery via `mf-manifest.json`.

### 1. Remote App (Exposing Micro-Frontend Components)

In your remote application's `vite.config.ts`:

```typescript
import { defineConfig } from 'vite';
import ostro from '@ostro/vite';
import { federation } from '@ostro/vite/federation';

export default defineConfig({
    plugins: [
        ostro({
            input: ['resources/assets/js/app.ts'],
        }),
        federation({
            name: 'adminDashboard',
            filename: 'remoteEntry.js',
            manifest: true, // generates mf-manifest.json for dynamic MFT discovery
            exposes: {
                './UserWidget': './resources/assets/js/components/UserWidget.tsx',
                './Header': './resources/assets/js/components/Header.tsx',
            },
            shared: ['react', 'react-dom'],
        }),
    ],
});
```

### 2. Host App (Consuming Micro-Frontend Components)

In your host/container application's `vite.config.ts`:

```typescript
import { defineConfig } from 'vite';
import ostro from '@ostro/vite';
import { federation } from '@ostro/vite/federation';

export default defineConfig({
    plugins: [
        ostro({
            input: ['resources/assets/js/app.ts'],
        }),
        federation({
            name: 'shellApp',
            remotes: {
                // Point to remoteEntry.js or directly to mf-manifest.json (MFT discovery)
                adminDashboard: 'http://localhost:5174/mf-manifest.json',

                // Dynamic promise-based remote resolution
                storeApp: {
                    external: 'Promise.resolve(window.storeAppUrl || "http://localhost:5175/remoteEntry.js")',
                    externalType: 'promise',
                },

                // Webpack container interop
                legacyApp: {
                    external: 'http://localhost:5176/remoteEntry.js',
                    from: 'webpack',
                },
            },
            shared: ['react', 'react-dom'],
        }),
    ],
});
```

### Consuming Remote Modules in Code

```typescript
// Static or asynchronous import
import UserWidget from 'adminDashboard/UserWidget';

export function Dashboard() {
    return (
        <div>
            <h1>Host Shell</h1>
            <UserWidget />
        </div>
    );
}
```

### 3. Runtime Dynamic Remotes (`__federation__`)

For fully dynamic loading at runtime (e.g., loaded on route change or from a backend API):

```typescript
import React, { Suspense } from 'react';
import { setRemote, getRemote } from '__federation__';

// Dynamically register a remote
setRemote('billingApp', {
    url: 'http://localhost:5177/mf-manifest.json',
    format: 'esm',
});

// Load dynamically
const RemoteInvoice = React.lazy(async () => {
    return await getRemote('billingApp', './Invoice');
});
```

---

## License

The OstroJS framework and plugins are open-sourced software licensed under the [MIT license](LICENSE).
