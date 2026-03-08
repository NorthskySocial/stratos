<script lang="ts">
  import type { StratosEnrollment } from './stratos'
  import { enrollInStratos } from './stratos'
  import type { SlingshotProfile } from './slingshot'
  import { avatarUrl } from './slingshot'

  interface Props {
    handle: string
    did: string
    enrollment: StratosEnrollment | null
    serviceUrl: string
    profile: SlingshotProfile | null
  }

  let { handle, did, enrollment, serviceUrl, profile }: Props = $props()

  let avatarSrc = $derived(
    profile?.avatarCid ? avatarUrl(did, profile.avatarCid) : null,
  )
</script>

<div class="profile-section">
  <div class="avatar-frame">
    {#if avatarSrc}
      <img src={avatarSrc} alt="{handle}'s avatar" class="avatar-img" />
    {:else}
      <div class="avatar-placeholder">👤</div>
    {/if}
  </div>

  <div class="display-name">
    {profile?.displayName || `~*~${handle}~*~`}
  </div>

  <div class="handle-text">@{handle}</div>

  {#if enrollment}
    <div class="status online">
      <span class="blink-dot"></span>
      oNLiNe NoW!!
    </div>
    <marquee class="mood" scrollamount="2">
      {profile?.description || '~*~ feeling private & secure ~*~'}
    </marquee>
    {#if enrollment.boundaries.length > 0}
      <div class="interests-label">~ My InTeReStS ~</div>
      <div class="boundaries">
        {#each enrollment.boundaries as b}
          <span class="boundary-tag">{b.value}</span>
        {/each}
      </div>
    {/if}
  {:else}
    <div class="status offline">
      <span class="offline-dot"></span>
      nOt EnRoLLeD :(
    </div>
    {#if serviceUrl}
      <button class="enroll-btn" onclick={() => enrollInStratos(serviceUrl, handle)}>
        ~*~ EnRoLL iN StRaToS ~*~
      </button>
    {:else}
      <p class="no-service">sEt VITE_STRATOS_URL 2 eNaBLe eNrOLLmEnT</p>
    {/if}
  {/if}

  {#if profile?.description}
    <div class="about-me">
      <div class="about-header">~ AbOuT mE ~</div>
      <p class="about-text">{profile.description}</p>
    </div>
  {/if}
</div>

<style>
  .profile-section {
    padding: 0.75rem;
    border-bottom: 2px solid #ff00ff44;
    text-align: center;
  }

  .avatar-frame {
    width: 90px;
    height: 90px;
    margin: 0 auto 0.5rem;
    border: 3px solid #ff00ff;
    border-radius: 4px;
    overflow: hidden;
    box-shadow: 0 0 12px #ff00ff88, 0 0 24px #ff00ff44;
    animation: rainbow-bg 4s linear infinite;
    background: #1a0030;
  }

  .avatar-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .avatar-placeholder {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 2.5rem;
    background: linear-gradient(135deg, #1a0030, #0a0020);
  }

  .display-name {
    font-weight: bold;
    font-size: 1rem;
    color: #ff69b4;
    text-shadow: 0 0 6px #ff69b4;
    margin-bottom: 0.15rem;
  }

  .handle-text {
    font-size: 0.75rem;
    color: #888;
    word-break: break-all;
    margin-bottom: 0.4rem;
  }

  .status {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.75rem;
    font-weight: bold;
    justify-content: center;
    margin-bottom: 0.4rem;
  }

  .status.online {
    color: #00ff00;
    text-shadow: 0 0 6px #00ff00;
  }

  .status.offline {
    color: #ff4444;
    text-shadow: 0 0 4px #ff4444;
  }

  .blink-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #00ff00;
    box-shadow: 0 0 6px #00ff00;
    animation: blink 1s step-end infinite;
    display: inline-block;
  }

  .offline-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #ff4444;
    box-shadow: 0 0 4px #ff4444;
    display: inline-block;
  }

  .mood {
    color: #ffff00;
    font-size: 0.7rem;
    font-style: italic;
    margin-bottom: 0.5rem;
    display: block;
  }

  .interests-label {
    color: #00ffff;
    font-size: 0.65rem;
    font-weight: bold;
    text-transform: uppercase;
    margin-bottom: 0.25rem;
    letter-spacing: 0.05em;
  }

  .boundaries {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-bottom: 0.5rem;
    justify-content: center;
  }

  .boundary-tag {
    background: linear-gradient(135deg, #ff00ff44, #8b00ff44);
    color: #ff69b4;
    padding: 0.1rem 0.5rem;
    border-radius: 12px;
    font-size: 0.65rem;
    border: 1px solid #ff00ff66;
    text-shadow: 0 0 4px #ff00ff;
  }

  .enroll-btn {
    width: 100%;
    padding: 0.5rem;
    background: linear-gradient(135deg, #ff00ff, #8b00ff);
    color: white;
    border: 2px solid #ff69b4;
    border-radius: 6px;
    font-size: 0.8rem;
    font-weight: bold;
    font-family: inherit;
    cursor: pointer;
    text-shadow: 0 0 6px #fff;
    box-shadow: 0 0 10px #ff00ff66;
    animation: float 2s ease-in-out infinite;
  }

  .enroll-btn:hover {
    box-shadow: 0 0 20px #ff00ff, 0 0 30px #ff00ff88;
  }

  .no-service {
    margin: 0;
    color: #666;
    font-size: 0.7rem;
  }

  .about-me {
    margin-top: 0.5rem;
    border: 1px dashed #00ffff44;
    border-radius: 6px;
    padding: 0.4rem;
    background: #00ffff08;
  }

  .about-header {
    color: #00ffff;
    font-size: 0.65rem;
    font-weight: bold;
    text-transform: uppercase;
    margin-bottom: 0.2rem;
    text-shadow: 0 0 4px #00ffff;
  }

  .about-text {
    margin: 0;
    color: #ccc;
    font-size: 0.7rem;
    line-height: 1.3;
    text-align: left;
  }

  @keyframes rainbow-bg {
    0% { border-color: #ff0000; box-shadow: 0 0 12px #ff000088; }
    16% { border-color: #ff8800; box-shadow: 0 0 12px #ff880088; }
    33% { border-color: #ffff00; box-shadow: 0 0 12px #ffff0088; }
    50% { border-color: #00ff00; box-shadow: 0 0 12px #00ff0088; }
    66% { border-color: #0088ff; box-shadow: 0 0 12px #0088ff88; }
    83% { border-color: #8800ff; box-shadow: 0 0 12px #8800ff88; }
    100% { border-color: #ff0000; box-shadow: 0 0 12px #ff000088; }
  }

  @keyframes blink {
    50% { opacity: 0; }
  }

  @keyframes float {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-3px); }
  }
</style>
