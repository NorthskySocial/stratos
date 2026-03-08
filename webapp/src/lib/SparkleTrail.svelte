<script lang="ts">
  import { onMount, onDestroy } from 'svelte'

  interface Particle {
    x: number
    y: number
    vx: number
    vy: number
    life: number
    color: string
    size: number
  }

  const COLORS = ['#ff00ff', '#00ffff', '#ffff00', '#ff69b4', '#00ff00', '#ff6600']
  let canvas: HTMLCanvasElement
  let ctx: CanvasRenderingContext2D | null = null
  let particles: Particle[] = []
  let animId = 0

  function onMouseMove(e: MouseEvent) {
    for (let i = 0; i < 3; i++) {
      particles.push({
        x: e.clientX,
        y: e.clientY,
        vx: (Math.random() - 0.5) * 4,
        vy: (Math.random() - 0.5) * 4 - 2,
        life: 1,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        size: Math.random() * 4 + 2,
      })
    }
  }

  function animate() {
    if (!ctx || !canvas) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i]
      p.x += p.vx
      p.y += p.vy
      p.vy += 0.1
      p.life -= 0.02

      if (p.life <= 0) {
        particles.splice(i, 1)
        continue
      }

      ctx.globalAlpha = p.life
      ctx.fillStyle = p.color
      ctx.beginPath()

      // draw a small star shape
      const spikes = 4
      const outerR = p.size
      const innerR = p.size * 0.4
      for (let j = 0; j < spikes * 2; j++) {
        const r = j % 2 === 0 ? outerR : innerR
        const angle = (j * Math.PI) / spikes - Math.PI / 2
        const sx = p.x + Math.cos(angle) * r
        const sy = p.y + Math.sin(angle) * r
        if (j === 0) ctx.moveTo(sx, sy)
        else ctx.lineTo(sx, sy)
      }
      ctx.closePath()
      ctx.fill()
    }

    ctx.globalAlpha = 1
    animId = requestAnimationFrame(animate)
  }

  function resize() {
    if (!canvas) return
    canvas.width = window.innerWidth
    canvas.height = window.innerHeight
  }

  onMount(() => {
    ctx = canvas.getContext('2d')
    resize()
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('resize', resize)
    animId = requestAnimationFrame(animate)
  })

  onDestroy(() => {
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('resize', resize)
    cancelAnimationFrame(animId)
  })
</script>

<canvas bind:this={canvas} class="sparkle-canvas"></canvas>

<style>
  .sparkle-canvas {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    pointer-events: none;
    z-index: 9999;
  }
</style>
