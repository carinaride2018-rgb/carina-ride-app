#!/usr/bin/env node
// Builds dist/demo.html: the whole app in one file, running in the browser
// with sample data and no server. Used for the clickable demo.
'use strict';
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
const safe = (js) => js.replace(/<\/script/gi, '<\\/script');

const svgUri = (p) => 'data:image/svg+xml;base64,' + Buffer.from(read(p)).toString('base64');
const logos = { light: svgUri('public/icons/logo-light.svg'), dark: svgUri('public/icons/logo-dark.svg'), hero: svgUri('public/icons/hero.svg') };

const html = `<meta charset="utf-8">
<title>LimoRelay</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..800&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>
${read('public/styles.css')}
</style>
<div id="app"></div>
<script>window.LIMO_DEMO = true; window.LIMO_LOGOS = ${JSON.stringify(logos)};</script>
<script>
${safe(read('core.js'))}
</script>
<script>
${safe(read('public/app.js'))}
</script>
`;
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist', 'demo.html'), html);
console.log('Wrote dist/demo.html (' + Math.round(html.length / 1024) + ' KB)');
