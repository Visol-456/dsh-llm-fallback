// @vitest-environment jsdom
/**
 * Fallback section client tests: the provider/model pickers and their
 * interplay with validation and the Save button, driven through the plugin
 * entry's configuration form. The api mock mirrors the real harness
 * `session.modelCatalog` wire shape: only routable providers whose model
 * catalog loaded successfully, each with its display name.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientRemote, ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { FakeConfigForm } from './support/config-form.ts'
import { bindSnapshotSelector } from './support/web-react.ts'
import type { FallbackSectionProps } from '../src/client/FallbackSection.tsx'
import { FallbackSection } from '../src/client/FallbackSection.tsx'
import { FallbackSettingsStore, MAX_COOLDOWN_MS } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** The model groups `session.modelCatalog` returns on the live web profile. */
const modelGroups = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
    ],
  },
  {
    id: 'opencode-go',
    name: 'opencode-go',
    models: [
      { id: 'minimax-m3', name: 'MiniMax-M3' },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    ],
  },
]

/** Build the catalog answer for the supplied provider groups. */
function makeCatalog(groups: ModelCatalog['groups']): ModelCatalog {
  return {
    default: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    routableProviders: groups.map(group => group.id),
    groups,
    failures: [],
  }
}

function makeApi(groups: ModelCatalog['groups'] = modelGroups): Pick<ClientRemote, 'session'> {
  return {
    session: {
      modelCatalog: vi.fn(async () => ({ ok: true, value: makeCatalog(groups) })),
    },
  } as unknown as Pick<ClientRemote, 'session'>
}

/** The section value the plugin's schema resolves with no override. */
const EMPTY_VALUE = {
  fallbacks: [],
  switchCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'UNKNOWN_MODEL', 'TIMEOUT', 'TRANSPORT'],
  failureThreshold: 1,
  cooldownMs: 0,
}

/** Render the section over a real store backed by the form double. */
async function renderSection(
  overrides: Partial<FallbackSectionProps> = {},
  options: { value?: unknown; writable?: boolean; form?: FakeConfigForm } = {},
) {
  const form = options.form ?? new FakeConfigForm(options.value ?? EMPTY_VALUE, {
    writable: options.writable ?? true,
  })
  const controller = new FallbackSettingsStore(form)
  await controller.load()
  const useSnapshot = bindSnapshotSelector(controller.store)
  const t = ((key: string): string => (en as Record<string, string>)[key] ?? key) as FallbackSectionProps['t']
  const props: FallbackSectionProps = {
    controller,
    useSnapshot: useSnapshot as SnapshotSelectorHook<never>,
    api: makeApi(),
    t,
    ...overrides,
  }
  render(<FallbackSection {...props} />)
  // The provider/model catalog load is an effect; settle it.
  await waitFor(() => {
    expect(screen.queryByText(en.loading)).toBeNull()
  })
  return { controller, form }
}

/** The two selects of the first (or only) fallback row, by label text. */
function selectsOf(index = 0) {
  const labelOf = (field: string) => screen.getByText(`${field} ${index + 1}`).closest('label') as HTMLLabelElement
  const provider = labelOf(en.provider).querySelector('select') as HTMLSelectElement
  const model = labelOf(en.model).querySelector('select') as HTMLSelectElement
  return { provider, model }
}

/** Option values of a select, excluding the placeholder. */
function optionValues(select: HTMLSelectElement): string[] {
  return [...select.options].map(option => option.value)
}

describe('FallbackSection provider/model pickers', () => {
  it('adds an entry with an EMPTY provider selected (never auto-picks the first catalog route)', async () => {
    await renderSection()
    fireEvent.click(screen.getByRole('button', { name: en.emptyAction }))
    const { provider } = selectsOf(0)
    // The select must be honestly empty: value '', and NOT displaying
    // 'deepseek-official' as a fake selection.
    expect(provider.value).toBe('')
    expect(provider.selectedOptions[0]?.value).toBe('')
    expect(provider.selectedOptions[0]?.text).toBe(en.selectProvider)
  })

  it('only offers usable providers: dormant pi-ai routes (deepseek, openrouter) never appear', async () => {
    await renderSection()
    fireEvent.click(screen.getByRole('button', { name: en.emptyAction }))
    const { provider } = selectsOf(0)
    const values = optionValues(provider)
    expect(values).toContain('deepseek-official')
    expect(values).toContain('opencode-go')
    expect(values).not.toContain('deepseek')
    expect(values).not.toContain('openrouter')
  })

  it('labels the official DeepSeek route with its display name to kill the two-names confusion', async () => {
    await renderSection()
    fireEvent.click(screen.getByRole('button', { name: en.emptyAction }))
    const { provider } = selectsOf(0)
    const option = [...provider.options].find(choice => choice.value === 'deepseek-official')
    expect(option?.text).toBe('DeepSeek')
  })

  it('switching provider links the model list (deepseek-official offers its two models)', async () => {
    await renderSection()
    fireEvent.click(screen.getByRole('button', { name: en.emptyAction }))
    const { provider, model } = selectsOf(0)
    fireEvent.change(provider, { target: { value: 'deepseek-official' } })
    expect(model.disabled).toBe(false)
    const values = optionValues(model)
    expect(values).toContain('deepseek-v4-flash')
    expect(values).toContain('deepseek-v4-pro')
  })

  it('keeps a stored dormant provider selectable but shows the no-models hint', async () => {
    await renderSection({}, {
      value: { ...EMPTY_VALUE, fallbacks: [{ provider: 'deepseek', model: '' }] },
    })
    const { provider, model } = selectsOf(0)
    expect(provider.value).toBe('deepseek')
    expect(model.disabled).toBe(true)
    expect(screen.getByText(en.noModelsForProvider)).toBeTruthy()
  })

  it('model select starts with an honest placeholder; Save stays disabled until provider AND model are picked', async () => {
    await renderSection()
    fireEvent.click(screen.getByRole('button', { name: en.emptyAction }))
    const { provider, model } = selectsOf(0)
    fireEvent.change(provider, { target: { value: 'deepseek-official' } })

    // The model select must NOT fake-select deepseek-v4-flash: it shows the
    // placeholder and the "model required" problem is listed.
    expect(model.value).toBe('')
    expect(model.selectedOptions[0]?.value).toBe('')
    expect(screen.getByText(en.errorEmptyModel)).toBeTruthy()
    expect((screen.getByRole('button', { name: en.save }) as HTMLButtonElement).disabled).toBe(true)

    // Picking the model clears the problem and arms Save.
    fireEvent.change(model, { target: { value: 'deepseek-v4-flash' } })
    expect(screen.queryByText(en.errorEmptyModel)).toBeNull()
    expect((screen.getByRole('button', { name: en.save }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('auto-selects the only model of a single-model provider (Save is armed right away)', async () => {
    const singleModelApi = makeApi([{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }],
    }])
    await renderSection({ api: singleModelApi })
    fireEvent.click(screen.getByRole('button', { name: en.emptyAction }))
    const { provider, model } = selectsOf(0)
    fireEvent.change(provider, { target: { value: 'deepseek-official' } })
    expect(model.value).toBe('deepseek-v4-flash')
    expect(screen.queryByText(en.errorEmptyModel)).toBeNull()
    expect((screen.getByRole('button', { name: en.save }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('saving a complete entry queues one mutation of the entry config; removing a row clears validation residue', async () => {
    const form = new FakeConfigForm(EMPTY_VALUE)
    const controller = new FallbackSettingsStore(form)
    await controller.load()
    const useSnapshot = bindSnapshotSelector(controller.store)
    const t = ((key: string): string => (en as Record<string, string>)[key] ?? key) as FallbackSectionProps['t']
    render(
      <FallbackSection
        controller={controller}
        useSnapshot={useSnapshot as SnapshotSelectorHook<never>}
        api={makeApi()}
        t={t}
      />,
    )
    await waitFor(() => expect(screen.queryByText(en.loading)).toBeNull())

    // Two entries: fill the first, leave the second empty -> problems listed.
    fireEvent.click(screen.getByRole('button', { name: en.emptyAction }))
    fireEvent.click(screen.getByRole('button', { name: en.addFallback }))
    let { provider, model } = selectsOf(0)
    fireEvent.change(provider, { target: { value: 'deepseek-official' } })
    fireEvent.change(model, { target: { value: 'deepseek-v4-flash' } })
    expect(screen.getByText(en.errorEmptyProvider)).toBeTruthy()
    expect(screen.getByText(en.errorEmptyModel)).toBeTruthy()

    // Removing the empty second row recomputes validation: no residue.
    fireEvent.click(screen.getAllByRole('button', { name: en.removeFallback })[1]!)
    expect(screen.queryByText(en.errorEmptyProvider)).toBeNull()
    expect(screen.queryByText(en.errorEmptyModel)).toBeNull()
    expect((screen.getByRole('button', { name: en.save }) as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => expect(form.mutations).toHaveLength(1))
    // One atomic section write: every field the page owns, one revision fence.
    expect(form.mutations[0]).toEqual([
      { op: 'set', path: ['fallbacks'], value: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }] },
      { op: 'set', path: ['switchCodes'], value: EMPTY_VALUE.switchCodes },
      { op: 'set', path: ['failureThreshold'], value: 1 },
      { op: 'set', path: ['cooldownMs'], value: 0 },
    ])
    // A landed save clears the dirty flag: no unsaved badge, draft re-seeded.
    expect(screen.queryByText(en.unsaved)).toBeNull()
    expect((screen.getByRole('button', { name: en.save }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('resets by clearing every saved field in one mutation', async () => {
    const form = new FakeConfigForm({ ...EMPTY_VALUE, fallbacks: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }] })
    await renderSection({}, { form })
    // Reset arms a confirmation; like the save path it requires a pending edit.
    fireEvent.click(screen.getByRole('button', { name: en.addFallback }))
    fireEvent.click(screen.getByRole('button', { name: en.reset }))
    fireEvent.click(screen.getByRole('button', { name: en.resetConfirmAction }))
    await waitFor(() => expect(form.mutations).toHaveLength(1))
    expect(form.mutations[0]).toEqual([
      { op: 'unset', path: ['fallbacks'] },
      { op: 'unset', path: ['switchCodes'] },
      { op: 'unset', path: ['failureThreshold'] },
      { op: 'unset', path: ['cooldownMs'] },
    ])
  })

  it('renders the conflict banner when a refused write landed on a moved revision', async () => {
    const form = new FakeConfigForm(EMPTY_VALUE)
    const controller = new FallbackSettingsStore(form)
    await controller.load()
    form.refuse = true
    const accepted = await controller.save({ ...EMPTY_VALUE, fallbacks: [{ provider: 'a', model: 'a' }] })
    expect(accepted).toBe(false)
    expect(controller.store.getSnapshot().error?.kind).toBe('conflict')
  })

  it('renders a transport failure when the write rejects', async () => {
    const form = new FakeConfigForm(EMPTY_VALUE)
    const controller = new FallbackSettingsStore(form)
    await controller.load()
    form.failure = new Error('socket closed')
    const accepted = await controller.save({ ...EMPTY_VALUE, fallbacks: [{ provider: 'a', model: 'a' }] })
    expect(accepted).toBe(false)
    expect(controller.store.getSnapshot().error).toEqual({ kind: 'transport', message: 'socket closed' })
  })

  it('shows the unavailable state when the host does not serve the form', async () => {
    const form = new FakeConfigForm(undefined, { status: 'unavailable', writable: false })
    const controller = new FallbackSettingsStore(form)
    await controller.load()
    expect(controller.store.getSnapshot().available).toBe(false)
    await renderSection({}, { form })
    expect(screen.getByText(new RegExp(en.unavailable))).toBeTruthy()
  })

  it('keeps the cooldown ceiling the schema enforces', () => {
    expect(MAX_COOLDOWN_MS).toBe(2_147_483_647)
  })
})
