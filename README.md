# Ryan McKee — Portfolio

Personal site: projects, blog and interactive Three.js robotics experiments.
Built with [Astro](https://astro.build) + [Three.js](https://threejs.org). Outputs a fully static site in `dist/`.

## Commands

Node is installed via nvm. In a new terminal run `nvm use --lts` if `node` isn't found.

| Command           | What it does                                   |
| ----------------- | ---------------------------------------------- |
| `npm install`     | Install dependencies                           |
| `npm run dev`     | Dev server at http://localhost:4321            |
| `npm run build`   | Type-check and build to `dist/`                |
| `npm run preview` | Serve the built site locally                   |

## Layout

```
src/
  consts.ts                 # name, role, email, social links  ← edit me first
  content/blog/             # blog posts (.md / .mdx)
  content/projects/         # project write-ups (.md / .mdx)
  content.config.ts         # frontmatter schemas for both
  components/three/         # Three.js scenes + loader
  layouts/                  # BaseLayout (shell), PostLayout (posts & projects)
  pages/                    # routes: /, /about, /blog, /projects, /lab, /rss.xml
  styles/global.css         # colour tokens, fonts, cyberpunk effects
public/                     # static files (favicon, cv.pdf, images)
```

## Writing a blog post

Create `src/content/blog/my-post.md` (or `.mdx` to embed components):

```md
---
title: 'My post'
description: 'One-line summary shown on cards and in RSS.'
pubDate: 2026-11-01
tags: ['ros2']
draft: false
---

Content here.
```

## Adding a project

Create `src/content/projects/my-project.md`:

```md
---
title: 'My Project'
summary: 'One-line summary.'
date: 2026-11-01
tags: ['perception']
repo: 'https://github.com/you/repo'   # optional
demo: 'https://...'                   # optional
scene: 'robot-arm'                    # optional: show a 3D scene at the top
featured: true                        # show on the home page
---
```

## Adding a Three.js scene

1. Create `src/components/three/MyScene.ts`:

   ```ts
   import * as THREE from 'three';
   import { runStage, addFloor } from './stage';

   export function mount(canvas: HTMLCanvasElement) {
     return runStage(canvas, ({ scene, camera }) => {
       camera.position.set(3, 3, 5);
       camera.lookAt(0, 0, 0);
       addFloor(scene);
       // build your scene...
       return {
         update(t, dt) { /* animate */ },
       };
     });
   }
   ```

   `runStage` handles the renderer, resizing, pausing when off-screen, `prefers-reduced-motion`, and cleanup.

2. Register it in `src/components/three/scenes.ts`. It then shows up on `/lab` automatically.
3. Embed it anywhere: `<SceneCanvas scene="my-scene" />` in a page or `.mdx` post, or set `scene:` in a project's frontmatter.

Scenes load lazily, so Three.js is only downloaded when a scene scrolls into view. Pages without one ship no JavaScript.

## TODO

- [ ] Fill in `src/consts.ts` (email, GitHub, LinkedIn)
- [ ] Write your bio in `src/pages/about.astro`
- [ ] Add `public/cv.pdf`
- [ ] Replace the placeholder projects and post
- [ ] Set `site` in `astro.config.mjs` to your real domain
- [ ] Pick a host (GitHub Pages, Netlify, Vercel and Cloudflare Pages all serve `dist/` as-is)
