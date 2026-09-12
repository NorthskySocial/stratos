<script lang="ts">
  import type { BoundaryDraft } from '../../boundary-form'

  interface Props {
    draft: BoundaryDraft
    creating: boolean
    reserved: boolean
    disabled: boolean
  }
  let { draft = $bindable(), creating, reserved, disabled }: Props = $props()
</script>

<fieldset {disabled} class="space-y-5 disabled:opacity-70">
  {#if creating}
    <label class="block">
      <span class="mb-1 block text-sm font-medium">Boundary name</span>
      <input
        bind:value={draft.name}
        aria-label="Boundary name"
        aria-describedby="boundary-name-help"
        required
        maxlength="128"
        class="pill w-full px-5 py-2.5 text-sm"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        placeholder="engineering"
      />
      <span id="boundary-name-help" class="mt-2 block text-xs text-muted"
        >A permanent identifier, using letters, numbers, dots, underscores,
        tildes, colons or hyphens. It cannot be renamed or reused.</span
      >
    </label>
  {/if}
  <label class="block">
    <span class="mb-1 block text-sm font-medium">Display name</span>
    <input
      bind:value={draft.displayName}
      required
      maxlength="120"
      class="pill w-full px-5 py-2.5 text-sm"
      autocomplete="off"
      placeholder="Engineering"
    />
  </label>
  <label class="block">
    <span class="mb-1 block text-sm font-medium">Description</span>
    <textarea
      bind:value={draft.description}
      maxlength="2000"
      rows="3"
      class="w-full rounded-2xl border border-muted/40 bg-bubble px-4 py-3 text-sm"
    ></textarea>
  </label>
  <div class="space-y-4">
    <label class="flex items-start gap-3">
      <input
        type="checkbox"
        bind:checked={draft.listed}
        class="mt-1 size-4 shrink-0 accent-purple"
      />
      <span
        ><span class="block text-sm font-medium"
          >Show in the public room directory</span
        ><span class="block text-xs text-muted"
          >The room name and description will be public. Posts remain private.</span
        ></span
      >
    </label>
    <label class="flex items-start gap-3">
      <input
        type="checkbox"
        bind:checked={draft.joinable}
        class="mt-1 size-4 shrink-0 accent-purple"
      />
      <span
        ><span class="block text-sm font-medium">Allow members to join</span
        ><span class="block text-xs text-muted"
          >Eligible members can join this boundary themselves.</span
        ></span
      >
    </label>
    <label class="flex items-start gap-3">
      <input
        type="checkbox"
        bind:checked={draft.autoEnroll}
        disabled={reserved}
        class="mt-1 size-4 shrink-0 accent-purple"
      />
      <span
        ><span class="block text-sm font-medium"
          >Add new enrollments automatically</span
        ><span class="block text-xs text-muted"
          >{reserved
            ? 'Required for the all-members boundary.'
            : 'Applies to future enrollments. Existing members are not added.'}</span
        ></span
      >
    </label>
  </div>
  <label class="block">
    <span class="mb-1 block text-sm font-medium">App access</span>
    <select
      bind:value={draft.appAccess}
      aria-label="App access"
      aria-describedby="boundary-app-access-help"
      class="w-full rounded-2xl border border-muted/40 bg-bubble px-4 py-3 text-sm"
    >
      <option value="open">Any authorized app</option>
      <option value="allowList">Only listed apps</option>
    </select>
    <span id="boundary-app-access-help" class="mt-2 block text-xs text-muted"
      >Members must still belong to this boundary to access its records.</span
    >
  </label>
  {#if draft.appAccess === 'allowList'}
    <label class="block">
      <span class="mb-1 block text-sm font-medium">Allowed client IDs</span>
      <textarea
        bind:value={draft.clientIdsText}
        aria-label="Allowed client IDs"
        aria-describedby="boundary-client-ids-help"
        rows="4"
        class="w-full rounded-2xl border border-muted/40 bg-bubble px-4 py-3 text-sm"
        spellcheck="false"
        placeholder="https://app.example.com/client-metadata.json"
      ></textarea>
      <span id="boundary-client-ids-help" class="mt-2 block text-xs text-muted"
        >One HTTPS OAuth client ID per line, up to 100. At least one is
        required. Credentials and URL fragments are not allowed.</span
      >
    </label>
  {/if}
</fieldset>
