#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const publicDir = path.resolve(process.cwd(), 'public');
const hotFile = path.join(publicDir, 'hot');

if (fs.existsSync(hotFile)) {
    fs.rmSync(hotFile);
    console.log('[ostro-vite] Cleaned hot file: ' + hotFile);
}
