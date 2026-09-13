// @vitest-environment jsdom
/**
 * Fallback section client tests: the provider/model pickers and their
 * interplay with validation and the Save button. The api mock mirrors the
 * real harness `session.modelCatalog` wire shape: only routable providers
 * whose model catalog loaded successfully, each with its display name.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientRemote, ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { bindSnapshotSelector } from './support/web-react.ts'
import type { FallbackSectionProps } from '../src/client/FallbackSection.tsx'
import { FallbackSection } from '../src/client/FallbackSection.tsx'
import { CONFIG_PATH, FallbackSettingsStore } from '../src/client/store.ts'
import type { FallbackConfigView } from '../src/client/store.ts'
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

/** Stub the config bridge GET/PUT so the real store can load/save. */
function stubBridge(initial: FallbackConfigView): { put: ReturnType<typeof vi.fn> } {
  let view = initial
  const put = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { expectedRevision: number; section: unknown }
    view = {
      ...view,
      revision: view.revision + 1,
      value: body.section,
      user: body.section,
    }
    return new Response(JSON.stringify(view), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === CONFIG_PATH && (init?.method === undefined || init.method === 'GET')) {
      return new Response(JSON.stringify(view), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return put(input, init)
  }))
  return { put }
}

const EMPTY_VIEW: FallbackConfigView = {
  available: true,
  writable: true,
  hasDocument: true,
  value: { fallbacks: [], switchCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'UNKNOWN_MODEL', 'TIMEOUT', 'TRANSPORT'], failureThreshold: 1, cooldownMs: 0 },
  base: undefined,
  user: undefined,
  revision: 1,
}

/** Render the section with the real store, its bridge stubbed, and the api mock. */
async function renderSection(overrides: Partial<FallbackSectionProps> = {}, view: FallbackConfigView = EMPTY_VIEW) {
  stubBridge(view)
  const controller = new FallbackSettingsStore()
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
  return { controller }
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
    const storedView: FallbackConfigView = {
      ...EMPTY_VIEW,
      value: {
        fallbacks: [{ provider: 'deepseek', model: '' }],
        switchCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'UNKNOWN_MODEL', 'TIMEOUT', 'TRANSPORT'],
        failureThreshold: 1,
        cooldownMs: 0,
      },
    }
    await renderSection({}, storedView)
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

  it('saving a complete entry persists through the bridge; removing the row clears validation residue', async () => {
    const { put } = stubBridge(EMPTY_VIEW)
    const controller = new FallbackSettingsStore()
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

    // Two entries: fill the first, leave the second empty → problems listed.
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
    await waitFor(() => expect(put).toHaveBeenCalled())
    const body = JSON.parse(String(put.mock.calls[0]![1]?.body)) as { section: { fallbacks: Array<{ provider: string; model: string }> } }
    expect(body.section.fallbacks).toEqual([{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }])
    // A landed save clears the dirty flag: no unsaved badge, draft re-seeded.
    expect(screen.queryByText(en.unsaved)).toBeNull()
    expect((screen.getByRole('button', { name: en.save }) as HTMLButtonElement).disabled).toBe(true)
  })
})
