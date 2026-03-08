<script lang="ts">
  const friends = [
    { name: 'Tom', emoji: '😎' },
    { name: 'xX_d4rk_Xx', emoji: '🖤' },
    { name: '~*angel*~', emoji: '👼' },
    { name: 'sk8rboi', emoji: '🛹' },
    { name: 'rawr_xD', emoji: '🐱' },
    { name: 'emo_kid03', emoji: '🥀' },
    { name: 'gl1tt3r', emoji: '✨' },
    { name: 'punk_rawk', emoji: '🎸' },
  ]
</script>

<div class="top-friends">
  <div class="tf-header">~*~ My ToP 8 ~*~</div>
  <div class="tf-grid">
    {#each friends as friend, i}
      <div class="friend-cell" class:first={i === 0}>
        <div class="friend-avatar">{friend.emoji}</div>
        <div class="friend-name">{friend.name}</div>
      </div>
    {/each}
  </div>
</div>

<style>
  .top-friends {
    margin: 0.5rem;
    border: 2px solid #00ffff;
    border-radius: 6px;
    background: #0a0020;
    box-shadow: 0 0 8px #00ffff44;
    overflow: hidden;
  }

  .tf-header {
    background: linear-gradient(90deg, #00ffff, #ff00ff);
    color: #000;
    font-weight: bold;
    font-size: 0.7rem;
    text-align: center;
    padding: 0.3rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .tf-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1px;
    background: #00ffff33;
    padding: 1px;
  }

  .friend-cell {
    background: #0a0020;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 0.35rem 0.15rem;
    gap: 0.15rem;
  }

  .friend-cell.first {
    background: #1a0040;
    box-shadow: inset 0 0 10px #ff00ff44;
  }

  .friend-avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: 2px solid #ff00ff;
    background: #1a0030;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1rem;
    box-shadow: 0 0 6px #ff00ff44;
  }

  .friend-cell.first .friend-avatar {
    border-color: #ffff00;
    box-shadow: 0 0 8px #ffff0066;
  }

  .friend-name {
    color: #00ffff;
    font-size: 0.5rem;
    text-align: center;
    word-break: break-all;
    line-height: 1.1;
  }

  .friend-cell.first .friend-name {
    color: #ffff00;
    font-weight: bold;
  }
</style>
