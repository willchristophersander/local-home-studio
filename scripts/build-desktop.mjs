import {build} from 'esbuild';
await build({entryPoints:{main:'src/desktop/main.ts',preload:'src/desktop/preload.ts','asset-worker':'src/desktop/asset-worker.ts'},outdir:'dist-desktop',outExtension:{'.js':'.cjs'},bundle:true,platform:'node',format:'cjs',target:'node24',external:['electron','@gltf-transform/core','@gltf-transform/extensions','gltf-validator'],sourcemap:true});
