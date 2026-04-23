# Still Night

**Live:** https://stillnight.joshua-garcia.com

A painting you can play. A point cloud of Van Gogh's Starry Night with particle physics and reactive audio.

Built with vanilla WebGL 2 and the Web Audio API.

## Running locally

```
npm install
npm run serve
```

Open http://localhost:8080.

## Rebuilding pre-baked assets

The production site ships pre-compressed point-cloud payloads in `assets/*.dvs.br`. To regenerate them from the source image:

```
npm run prebake
```

## License

© 2026 Joshua Garcia. All rights reserved.
