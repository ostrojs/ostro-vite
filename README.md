# @ostro/vite

Vite plugin for the OstroJS framework.

## Installation

```bash
npm install -D @ostro/vite vite
```

## Usage

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

## License

The OstroJS framework and plugins are open-sourced software licensed under the [MIT license](LICENSE).
