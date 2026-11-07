// CI-only launch configuration; never changes the application's default renderer.
export function smokeGraphicsFlags(platform) {
  // Retain the existing Linux CI sandbox exception; do not extend it elsewhere.
  return platform === 'linux' ? ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'] : [];
}

export async function assertSmokeGraphics(page, platform) {
  await page.waitForFunction(() => document.querySelector('#connection')?.textContent.includes('World connected'));
  const sceneError = await page.locator('#scene-error').textContent();
  if (await page.locator('#scene-error').isVisible()) throw new Error(`Scene initialization failed: ${sceneError}`);
  // Check several actual animation frames, not just the presence of a canvas.
  const evidence = await page.evaluate(async () => {
    const canvas = document.querySelector('#viewport canvas');
    const gl = canvas?.getContext('webgl2');
    if (!gl) return { error: 'WebGL2 context missing' };
    for (let frame = 0; frame < 5; frame++) {
      if (gl.isContextLost()) return { error: 'WebGL2 context lost' };
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Animation frame timeout')), 5000);
        requestAnimationFrame(() => { clearTimeout(timeout); resolve(); });
      });
    }
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return { lost: gl.isContextLost(), vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER), backend: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null };
  });
  if (evidence.error || evidence.lost || !evidence.vendor || !evidence.renderer) throw new Error(`Unhealthy WebGL: ${JSON.stringify(evidence)}`);
  if (platform === 'linux' && !evidence.backend?.includes('SwiftShader')) throw new Error(`Expected explicit CI SwiftShader backend: ${JSON.stringify(evidence)}`);
  console.log(`Graphics evidence: ${JSON.stringify(evidence)}`);
}
