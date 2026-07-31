<script lang="ts">
  import { onMount } from 'svelte'
  import {
    addAdmin,
    listAdmins,
    removeAdmin,
    type AdminUser,
  } from '../lib/api/client'
  import Button from '../lib/components/ui/Button.svelte'
  import Card from '../lib/components/ui/Card.svelte'
  import Identity from '../lib/components/ui/Identity.svelte'
  import TextField from '../lib/components/ui/TextField.svelte'
  import { resolveDid } from '../lib/api/identity'

  let admins = $state<AdminUser[]>([])
  let viewer = $state<string | null>(null)
  let loading = $state(false)
  let loaded = $state(false)
  let error = $state<string | null>(null)
  let notice = $state<string | null>(null)
  let newAdmin = $state('')
  let busy = $state(false)

  async function load() {
    if (loading) return
    loading = true
    error = null
    try {
      const res = await listAdmins()
      admins = res.admins
      viewer = res.viewer ?? null
      loaded = true
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      loading = false
    }
  }

  onMount(() => {
    void load()
  })

  async function handleAdd() {
    const query = newAdmin.trim()
    if (!query || busy) return
    error = null
    notice = null
    busy = true
    try {
      let did = query
      if (!did.startsWith('did:')) {
        const resolved = await resolveDid(did).catch(() => null)
        if (!resolved) {
          throw new Error(`Could not resolve handle "${query}" to a DID`)
        }
        did = resolved
      }
      await addAdmin(did)
      newAdmin = ''
      notice = `Granted admin access to ${did}.`
      await load()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  async function handleRemove(admin: AdminUser) {
    if (busy) return
    error = null
    notice = null
    busy = true
    try {
      await removeAdmin(admin.did)
      notice = `Revoked admin access from ${admin.did}.`
      await load()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }
</script>

<div class="space-y-6" data-testid="admins-screen">
  <h1 class="font-display text-2xl font-semibold">Admins</h1>

  <Card title="Grant admin access">
    <div class="flex items-end gap-3">
      <div class="grow">
        <TextField
          bind:value={newAdmin}
          ariaLabel="DID or handle to grant admin access"
          onenter={handleAdd}
          placeholder="did:plc:… or handle.example.com"
          testid="add-admin-input"
        />
      </div>
      <Button
        disabled={busy || !newAdmin.trim()}
        onclick={handleAdd}
        testid="add-admin"
      >
        Grant
      </Button>
    </div>
    <p class="mt-3 text-xs text-muted">
      Admins can manage members, boundaries, and other admins.
    </p>
  </Card>

  {#if error}
    <Card><p class="text-error" data-testid="admins-error">{error}</p></Card>
  {/if}

  {#if notice}
    <Card>
      <p
        aria-live="polite"
        class="text-purple dark:text-mint"
        data-testid="admins-notice"
        role="status"
      >
        {notice}
      </p>
    </Card>
  {/if}

  <Card testid="admins-card">
    <h2 class="mb-4 font-display text-lg italic">Current admins</h2>

    {#if !loaded && loading}
      <p class="text-muted">Loading…</p>
    {:else if error && admins.length === 0}
      <p class="text-muted">Could not load the admin list.</p>
    {:else if admins.length === 0}
      <p class="text-muted" data-testid="admins-empty">No admins configured.</p>
    {:else}
      <ul class="space-y-2" data-testid="admins-list">
        {#each admins as admin (admin.did)}
          <li
            class="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-bubble p-4 shadow-brand"
            data-testid="admin-row"
          >
            <div class="flex flex-wrap items-center gap-3">
              <Identity did={admin.did} />
              {#if admin.did === viewer}
                <span class="text-xs text-muted">you</span>
              {/if}
            </div>
            <div class="flex items-center gap-3">
              {#if admin.source === 'config'}
                <span class="text-xs text-muted" title="Set in the environment">
                  from config
                </span>
              {:else}
                <Button
                  disabled={busy || admin.did === viewer}
                  onclick={() => handleRemove(admin)}
                  testid="remove-admin"
                  variant="secondary"
                >
                  Revoke
                </Button>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
      <p class="mt-3 text-xs text-muted">
        Admins set in the environment cannot be revoked here; they are the way
        back in if this list is emptied by mistake.
      </p>
    {/if}
  </Card>
</div>
