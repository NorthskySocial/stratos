<script lang="ts">
  import { onMount } from 'svelte'

  let playing = $state(false)
  let audioCtx: AudioContext | null = null
  let intervalId: ReturnType<typeof setInterval> | null = null

  const NOTES = [262, 294, 330, 349, 392, 440, 494, 523, 587, 659]
  let noteIndex = 0

  function playNote(freq: number) {
    if (!audioCtx) return
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.type = 'square'
    osc.frequency.value = freq
    gain.gain.value = 0.05
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3)
    osc.connect(gain)
    gain.connect(audioCtx.destination)
    osc.start()
    osc.stop(audioCtx.currentTime + 0.3)
  }

  function toggle() {
    if (playing) {
      if (intervalId) clearInterval(intervalId)
      intervalId = null
      playing = false
    } else {
      if (!audioCtx) audioCtx = new AudioContext()
      intervalId = setInterval(() => {
        playNote(NOTES[noteIndex % NOTES.length])
        noteIndex++
      }, 250)
      playing = true
    }
  }
</script>

<div class="music-player">
  <div class="player-header">
    <span class="now-playing">♫ NOW PLAYING ♫</span>
  </div>
  <div class="player-body">
    <marquee class="track-name" scrollamount="3">
      ~*~ xX_str4t0s_Xx - my_private_data_anthem.mid ~*~
    </marquee>
    <div class="controls">
      <button class="play-btn" onclick={toggle}>
        {playing ? '⏸' : '▶'}
      </button>
      <div class="eq-bars">
        {#each Array(5) as _, i}
          <div class="eq-bar" class:active={playing} style="animation-delay: {i * 0.1}s"></div>
        {/each}
      </div>
    </div>
  </div>
</div>

<style>
  .music-player {
    border: 2px solid #ff00ff;
    border-radius: 8px;
    overflow: hidden;
    background: #1a0030;
    box-shadow: 0 0 10px #ff00ff88, inset 0 0 10px #ff00ff22;
    margin: 0.5rem;
  }

  .player-header {
    background: linear-gradient(90deg, #ff00ff, #8b00ff, #ff00ff);
    background-size: 200% 100%;
    animation: gradient-shift 2s linear infinite;
    padding: 0.25rem 0.5rem;
    text-align: center;
  }

  .now-playing {
    color: #fff;
    font-size: 0.65rem;
    font-weight: bold;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    animation: blink 1s step-end infinite;
  }

  .player-body {
    padding: 0.4rem 0.5rem;
  }

  .track-name {
    color: #00ffff;
    font-size: 0.7rem;
    font-family: 'Comic Sans MS', 'Comic Sans', cursive;
    margin-bottom: 0.3rem;
    display: block;
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .play-btn {
    background: linear-gradient(180deg, #333, #111);
    border: 1px solid #ff00ff;
    color: #00ffff;
    font-size: 1rem;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    box-shadow: 0 0 6px #ff00ff66;
  }

  .play-btn:hover {
    box-shadow: 0 0 12px #ff00ff;
  }

  .eq-bars {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 20px;
  }

  .eq-bar {
    width: 4px;
    height: 4px;
    background: #00ff00;
    border-radius: 1px;
    transition: height 0.1s;
  }

  .eq-bar.active {
    animation: eq-bounce 0.5s ease-in-out infinite alternate;
  }

  @keyframes eq-bounce {
    0% { height: 4px; background: #00ff00; }
    50% { height: 14px; background: #ffff00; }
    100% { height: 20px; background: #ff0000; }
  }

  @keyframes gradient-shift {
    0% { background-position: 0% 50%; }
    100% { background-position: 200% 50%; }
  }

  @keyframes blink {
    50% { opacity: 0; }
  }
</style>
