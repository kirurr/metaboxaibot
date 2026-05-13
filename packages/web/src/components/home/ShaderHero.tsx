import { useEffect, useRef } from "react";

/**
 * Анимированный шейдерный фон для главной (порт из `aibox_template/ai-box.html`).
 * Шейдер рисует диагональные «волны» цвета поверх чёрного. Реализовано на
 * чистом WebGL1, чтобы не тащить three.js в bundle ради одного fullscreen-quad'а.
 */

const VERTEX_SRC = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAGMENT_SRC = `
precision highp float;
uniform vec2 resolution;
uniform float time;
void main(void) {
  vec2 uv = (gl_FragCoord.xy * 2.0 - resolution.xy) / min(resolution.x, resolution.y);
  float t = time * 0.05;
  float lineWidth = 0.002;
  vec3 color = vec3(0.0);
  for (int j = 0; j < 3; j++) {
    for (int i = 0; i < 5; i++) {
      color[j] += lineWidth * float(i * i) /
        abs(fract(t - 0.01 * float(j) + float(i) * 0.01) * 5.0
          - length(uv) + mod(uv.x + uv.y, 0.2));
    }
  }
  gl_FragColor = vec4(color, 1.0);
}
`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error("ShaderHero compile error", gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

export function ShaderHero() {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { antialias: true });
    if (!gl) return; // WebGL недоступен — оставим черный canvas, без шейдера.

    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SRC);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
    if (!vs || !fs) return;

    const prog = gl.createProgram();
    if (!prog) return;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error("ShaderHero link error", gl.getProgramInfoLog(prog));
      return;
    }
    gl.useProgram(prog);

    // Fullscreen quad (два треугольника).
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const aPos = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const uTime = gl.getUniformLocation(prog, "time");
    const uRes = gl.getUniformLocation(prog, "resolution");

    let raf = 0;
    let t = 1.0;

    function resize() {
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl!.viewport(0, 0, w, h);
      gl!.uniform2f(uRes, w, h);
    }

    function frame() {
      t += 0.05;
      resize();
      gl!.uniform1f(uTime, t);
      gl!.drawArrays(gl!.TRIANGLES, 0, 6);
      raf = requestAnimationFrame(frame);
    }

    resize();
    frame();
    window.addEventListener("resize", resize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    };
  }, []);

  return <canvas ref={ref} className="shader-hero-canvas" />;
}
