<script lang="ts">
  import Button from '../lib/components/ui/Button.svelte'
  import Card from '../lib/components/ui/Card.svelte'
  import GradientHeading from '../lib/components/ui/GradientHeading.svelte'
  import TextField from '../lib/components/ui/TextField.svelte'
  import { theme } from '../lib/stores/theme.svelte'
  import logoBtext from '../assets/logo/Northsky-Horizontal-Color_Btext.svg'
  import logoWtext from '../assets/logo/Northsky-Horizontal-Color_Wtext.svg'

  let handle = $state('')

  function signIn() {
    const trimmed = handle.trim()
    if (!trimmed) return
    window.location.href = `/admin/oauth/authorize?handle=${encodeURIComponent(trimmed)}`
  }
</script>

<main
  class="flex min-h-dvh items-center justify-center p-6"
  data-testid="login-screen"
>
  <div class="w-full max-w-sm space-y-6">
    <div class="space-y-3 text-center">
      <img
        alt="Northsky"
        class="mx-auto h-10"
        src={theme.dark ? logoWtext : logoBtext}
      />
      <GradientHeading>Admin</GradientHeading>
      <p class="text-sm text-muted">
        Sign in with your ATProto account to manage this Stratos service.
      </p>
    </div>
    <Card>
      <div class="space-y-4">
        <TextField
          bind:value={handle}
          label="Handle"
          onenter={signIn}
          placeholder="alice.example.com"
          testid="handle-input"
        />
        <Button
          disabled={!handle.trim()}
          onclick={signIn}
          testid="oauth-signin"
        >
          Sign in with ATProto
        </Button>
      </div>
    </Card>
  </div>
</main>
