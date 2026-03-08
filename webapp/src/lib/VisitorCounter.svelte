<script lang="ts">
  const count = Math.floor(Math.random() * 900000) + 100000
  const digits = count.toString().split('')
</script>

<div class="visitor-counter">
  <div class="counter-label">~ YoU aRe ViSiToR nUmBeR ~</div>
  <div class="counter-digits">
    {#each digits as digit}
      <span class="digit">{digit}</span>
    {/each}
  </div>
  <div class="under-construction">
    <span class="construction-stripe"></span>
    <span class="construction-text">🚧 uNdEr CoNsTrUcTiOn 🚧</span>
    <span class="construction-stripe"></span>
  </div>
</div>

<style>
  .visitor-counter {
    text-align: center;
    padding: 0.5rem;
    margin: 0.5rem;
    border: 2px solid #ffff00;
    border-radius: 6px;
    background: #000;
    box-shadow: 0 0 8px #ffff0066;
  }

  .counter-label {
    color: #00ffff;
    font-size: 0.6rem;
    font-weight: bold;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 0.3rem;
    animation: rainbow-text 3s linear infinite;
  }

  .counter-digits {
    display: flex;
    justify-content: center;
    gap: 2px;
  }

  .digit {
    display: inline-block;
    background: #001800;
    color: #00ff00;
    font-family: 'Courier New', monospace;
    font-size: 1.1rem;
    font-weight: bold;
    padding: 0.15rem 0.3rem;
    border: 1px solid #003300;
    border-radius: 2px;
    text-shadow: 0 0 6px #00ff00;
    min-width: 1.2em;
    text-align: center;
  }

  .under-construction {
    margin-top: 0.5rem;
    display: flex;
    align-items: center;
    gap: 0.3rem;
    justify-content: center;
  }

  .construction-text {
    color: #ffff00;
    font-size: 0.55rem;
    font-weight: bold;
    animation: blink 1.2s step-end infinite;
    white-space: nowrap;
  }

  .construction-stripe {
    display: inline-block;
    width: 30px;
    height: 6px;
    background: repeating-linear-gradient(
      -45deg,
      #ffff00,
      #ffff00 3px,
      #000 3px,
      #000 6px
    );
    border-radius: 1px;
  }

  @keyframes rainbow-text {
    0% { color: #ff0000; }
    16% { color: #ff8800; }
    33% { color: #ffff00; }
    50% { color: #00ff00; }
    66% { color: #0088ff; }
    83% { color: #8800ff; }
    100% { color: #ff0000; }
  }

  @keyframes blink {
    50% { opacity: 0; }
  }
</style>
