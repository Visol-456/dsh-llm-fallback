/**
 * Fallback settings section: chain cards with a match row (provider + optional
 * model selects) and a fallback list (provider + model selects driven by the
 * harness model catalog), plus switch codes, failure threshold, and cooldown.
 * Edits stage locally and land only on Save through the loopback config
 * bridge; Reset clears the saved section back to cordis.yml. A 409 revision
 * conflict renders a reload banner instead of silently overwriting another
 * window's changes.
 * @module @deepseek-ai/dsh-llm-fallback/client/section
 */

import { useEffect, useMemo, useState } from 'react'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-web-react'
import {
  Button,
  IconChevronDownOutline14,
  IconChevronUpOutline14,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconTrashOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { en } from './locales.ts'
import type {
  FallbackChainDraft,
  FallbackConfig,
  FallbackMatchDraft,
  FallbackProviderEntry,
  FallbackSettingsState,
  FallbackSettingsStore,
} from './store.ts'
import { MAX_COOLDOWN_MS } from './store.ts'
import styles from './FallbackSection.module.css'

/** Injected dependencies of {@link FallbackSection} (slot `inject`). */
export interface FallbackSectionInjected {
  /** The page store (loaded on mount, refreshed on pushed invalidations). */
  controller: FallbackSettingsStore
  /** uSES subscription hook bound to the store. */
  useSnapshot: SnapshotSelectorHook<FallbackSettingsState>
  /** Wire face the provider/model catalogs read through. */
  api: Pick<IApiClient, 'llm'>
  /** Section copy (template params for e.g. chain labels). */
  t: (key: keyof typeof en, params?: Record<string, unknown>) => string
}

/** Props delivered by the slot outlet: the inject face spread flat. */
export type FallbackSectionProps = Partial<FallbackSectionInjected>

/** Default switch codes for a freshly added chain (mirrors the node default). */
const DEFAULT_SWITCH_CODES = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'UNKNOWN_MODEL', 'TIMEOUT', 'TRANSPORT']

/** One empty chain scaffold the user fills in. */
function emptyChain(): FallbackChainDraft {
  return {
    match: undefined,
    fallbacks: [{ provider: '', model: '' }],
    switchCodes: [...DEFAULT_SWITCH_CODES],
    failureThreshold: 1,
    cooldownMs: 0,
  }
}

/** Validate the draft against the same rules the node schema enforces. */
function validateConfig(draft: FallbackConfig | undefined, t: FallbackSectionInjected['t']): string[] {
  if (draft === undefined) return []
  const problems: string[] = []
  if (draft.chains.length === 0) {
    problems.push(t('errorNeedChain'))
    return problems
  }
  const defaultCount = draft.chains.filter(chain =>
    chain.match === undefined || chain.match.provider.trim().length === 0).length
  if (defaultCount > 1) problems.push(t('errorMultipleDefaultChains'))
  const seen = new Set<string>()
  draft.chains.forEach((chain, chainIndex) => {
    const label = `${t('chain', { n: String(chainIndex + 1) })}: `
    if (chain.fallbacks.length < 1) problems.push(`${label}${t('errorNeedFallback')}`)
    const inChain = new Set<string>()
    for (const entry of chain.fallbacks) {
      if (entry.provider.trim().length === 0) problems.push(`${label}${t('errorEmptyProvider')}`)
      if (entry.model.trim().length === 0) problems.push(`${label}${t('errorEmptyModel')}`)
      if (entry.provider.trim().length > 0 && entry.model.trim().length > 0) {
        const key = `${entry.provider.trim()}\u0000${entry.model.trim()}`
        if (inChain.has(key)) problems.push(`${label}${t('errorDuplicateInChain')}`)
        inChain.add(key)
        if (seen.has(key)) problems.push(t('errorDuplicateAcrossChains'))
        seen.add(key)
      }
    }
    if (chain.switchCodes.length === 0) problems.push(`${label}${t('errorSwitchCodes')}`)
    if (!Number.isInteger(chain.failureThreshold) || chain.failureThreshold < 1) {
      problems.push(`${label}${t('errorThreshold')}`)
    }
    if (!Number.isInteger(chain.cooldownMs) || chain.cooldownMs < 0 || chain.cooldownMs > MAX_COOLDOWN_MS) {
      problems.push(`${label}${t('errorCooldown')}`)
    }
  })
  return problems
}

/** Parse a switch-codes text input into a clean non-empty unique list. */
function parseSwitchCodes(text: string): string[] {
  const codes: string[] = []
  for (const raw of text.split(/[,\s;]+/)) {
    const code = raw.trim()
    if (code.length === 0) continue
    if (!codes.includes(code)) codes.push(code)
  }
  return codes
}

/** Catalog options plus a stored value the catalog does not list. */
function optionsWithStored(catalog: readonly string[], stored: string | undefined): string[] {
  const out = [...catalog]
  if (stored !== undefined && stored.length > 0 && !out.includes(stored)) out.push(stored)
  return out
}

/** One provider/model select row (used for the match row and fallback rows). */
function ProviderModelSelects(props: {
  provider: string
  model: string
  providers: readonly string[]
  modelsByProvider: Readonly<Record<string, readonly string[]>>
  modelOptional: boolean
  readOnly: boolean
  providerLabel: string
  modelLabel: string
  t: FallbackSectionInjected['t']
  onProvider: (value: string) => void
  onModel: (value: string) => void
}): JSX.Element {
  const { provider, model, providers, modelsByProvider, modelOptional, readOnly, providerLabel, modelLabel, t } = props
  const providerChoices = optionsWithStored(providers, provider)
  const models = modelsByProvider[provider] ?? []
  const modelChoices = modelOptional
    ? ['', ...optionsWithStored(models, model === '' ? undefined : model)]
    : optionsWithStored(models, model)
  const modelDisabled = readOnly || provider.length === 0 || modelChoices.length === 0
  const noModels = provider.length > 0 && models.length === 0 && model.length === 0
  return (
    <div className={styles.selects}>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{providerLabel}</span>
        <select
          className={styles.input}
          value={provider}
          disabled={readOnly || providerChoices.length === 0}
          onChange={(event) => { props.onProvider(event.target.value) }}
        >
          {providerChoices.length === 0
            ? <option value="">{t('provider')}…</option>
            : providerChoices.map(choice => <option key={choice} value={choice}>{choice}</option>)}
        </select>
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{modelLabel}</span>
        <select
          className={styles.input}
          value={model}
          disabled={modelDisabled}
          onChange={(event) => { props.onModel(event.target.value) }}
        >
          {modelOptional ? <option value="">{t('anyModel')}</option> : null}
          {modelChoices.map(choice => <option key={choice} value={choice}>{choice}</option>)}
        </select>
        {noModels ? <span className={styles.hint}>{t('noModelsForProvider')}</span> : null}
      </label>
    </div>
  )
}

/**
 * Render one chain card. All edits funnel through the shared immutable
 * update callbacks passed from the section.
 */
function ChainCard(props: {
  chain: FallbackChainDraft
  index: number
  providers: readonly string[]
  modelsByProvider: Readonly<Record<string, readonly string[]>>
  readOnly: boolean
  t: FallbackSectionInjected['t']
  onUpdateChain: (chainIndex: number, patch: Partial<FallbackChainDraft>) => void
  onUpdateMatch: (chainIndex: number, patch: Partial<FallbackMatchDraft>) => void
  onUpdateFallback: (chainIndex: number, fallbackIndex: number, patch: Partial<FallbackProviderEntry>) => void
  onAddFallback: (chainIndex: number) => void
  onRemoveFallback: (chainIndex: number, fallbackIndex: number) => void
  onMoveFallback: (chainIndex: number, fallbackIndex: number, direction: -1 | 1) => void
  onRemoveChain: (chainIndex: number) => void
}): JSX.Element {
  const { chain, index, providers, modelsByProvider, readOnly, t } = props
  const matchProvider = chain.match?.provider ?? ''
  const matchModel = chain.match?.model ?? ''
  const fallbackCount = chain.fallbacks.length
  return (
    <section className={styles.chain} aria-label={t('chain', { n: String(index + 1) })}>
      <header className={styles.chainHeader}>
        <h3 className={styles.chainTitle}>{t('chain', { n: String(index + 1) })}</h3>
        <Button
          type="button"
          variant="outline"
          size="sm"
          icon={<IconTrashOutline16 size={14} />}
          disabled={readOnly}
          onClick={() => { props.onRemoveChain(index) }}
        >
          {t('removeChain')}
        </Button>
      </header>

      <div className={styles.matchRow}>
        <span className={styles.matchLabel}>{t('match')}</span>
        <ProviderModelSelects
          provider={matchProvider}
          model={matchModel}
          providers={providers}
          modelsByProvider={modelsByProvider}
          modelOptional
          readOnly={readOnly}
          providerLabel={t('matchProvider')}
          modelLabel={t('matchModel')}
          t={t}
          onProvider={(value) => { props.onUpdateMatch(index, { provider: value }) }}
          onModel={(value) => { props.onUpdateMatch(index, { model: value }) }}
        />
        {matchProvider.length === 0
          ? <span className={styles.hint}>{t('defaultChain')}</span>
          : null}
      </div>

      <span className={styles.fallbacksLabel}>{t('fallbacks')}</span>
      <ol className={styles.entries}>
        {chain.fallbacks.map((entry, entryIndex) => (
          <li key={entryIndex} className={styles.entry}>
            <ProviderModelSelects
              provider={entry.provider}
              model={entry.model}
              providers={providers}
              modelsByProvider={modelsByProvider}
              modelOptional={false}
              readOnly={readOnly}
              providerLabel={`${t('provider')} ${String(entryIndex + 1)}`}
              modelLabel={`${t('model')} ${String(entryIndex + 1)}`}
              t={t}
              onProvider={(value) => { props.onUpdateFallback(index, entryIndex, { provider: value }) }}
              onModel={(value) => { props.onUpdateFallback(index, entryIndex, { model: value }) }}
            />
            <div className={styles.entryActions}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={t('moveUp')}
                disabled={readOnly || entryIndex === 0}
                onClick={() => { props.onMoveFallback(index, entryIndex, -1) }}
              >
                <IconChevronUpOutline14 />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={t('moveDown')}
                disabled={readOnly || entryIndex === fallbackCount - 1}
                onClick={() => { props.onMoveFallback(index, entryIndex, 1) }}
              >
                <IconChevronDownOutline14 />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={t('removeFallback')}
                disabled={readOnly}
                onClick={() => { props.onRemoveFallback(index, entryIndex) }}
              >
                <IconTrashOutline16 size={14} />
              </Button>
            </div>
          </li>
        ))}
      </ol>

      <div className={styles.chainActions}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          icon={<IconPlusOutline16 size={14} />}
          disabled={readOnly}
          onClick={() => { props.onAddFallback(index) }}
        >
          {t('addFallback')}
        </Button>
      </div>

      <div className={styles.fields}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t('switchCodes')}</span>
          <input
            className={styles.input}
            value={chain.switchCodes.join(', ')}
            placeholder={t('switchCodesPlaceholder')}
            disabled={readOnly}
            onChange={(event) => { props.onUpdateChain(index, { switchCodes: parseSwitchCodes(event.target.value) }) }}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t('failureThreshold')}</span>
          <input
            className={`${styles.input} ${styles.number}`}
            type="number"
            min={1}
            step={1}
            value={Number.isNaN(chain.failureThreshold) ? '' : String(chain.failureThreshold)}
            disabled={readOnly}
            onChange={(event) => { props.onUpdateChain(index, { failureThreshold: Number(event.target.value) }) }}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t('cooldownMs')}</span>
          <input
            className={`${styles.input} ${styles.number}`}
            type="number"
            min={0}
            step={1}
            value={Number.isNaN(chain.cooldownMs) ? '' : String(chain.cooldownMs)}
            disabled={readOnly}
            onChange={(event) => { props.onUpdateChain(index, { cooldownMs: Number(event.target.value) }) }}
          />
        </label>
      </div>
    </section>
  )
}

/**
 * Render the Fallback settings page.
 * @param props - injected face (partial for direct component tests).
 */
export function FallbackSection(props: FallbackSectionProps): JSX.Element | null {
  const { controller, useSnapshot, api, t } = props
  const translate = (t ?? ((key: string, _params?: Record<string, unknown>): string => key)) as FallbackSectionInjected['t']
  const selectIdentity = (state: FallbackSettingsState): FallbackSettingsState => state
  const useSnapshotSafe = (useSnapshot ?? ((_state: FallbackSettingsState): FallbackSettingsState => undefined as unknown as FallbackSettingsState)) as SnapshotSelectorHook<FallbackSettingsState>
  const snapshot = useSnapshotSafe(selectIdentity)
  const [draft, setDraft] = useState<FallbackConfig | undefined>(undefined)
  const [dirty, setDirty] = useState(false)
  const [resetArmed, setResetArmed] = useState(false)
  const [providers, setProviders] = useState<string[]>([])
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, string[]>>({})

  // Re-seed the draft from the server truth whenever it is not dirty.
  useEffect(() => {
    if (!dirty) setDraft(snapshot.value)
  }, [snapshot.value, dirty])

  // Provider + model catalogs (best-effort; stored values stay selectable).
  useEffect(() => {
    if (api === undefined) return
    let cancelled = false
    void Promise.all([
      api.llm.providers({}).then(response =>
        response.result.ok ? response.result.value.providers.map(entry => entry.provider) : []),
      api.llm.models({}).then(response =>
        response.result.ok ? response.result.value.groups : []),
    ]).then(([providerList, groups]) => {
      if (cancelled) return
      setProviders(providerList)
      const map: Record<string, string[]> = {}
      for (const group of groups) map[group.id] = group.models.map(model => model.id)
      setModelsByProvider(map)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [api])

  if (controller === undefined || useSnapshot === undefined) return null

  const problems = useMemo(() => validateConfig(draft, translate), [draft, translate])
  const invalid = problems.length > 0
  const readOnly = !snapshot.writable || !snapshot.available
  const saving = snapshot.saving
  if (snapshot.status === 'loading') {
    return <p className={styles.status}>{translate('loading')}</p>
  }
  if (snapshot.status === 'error') {
    return (
      <div className={styles.section}>
        <p className={styles.errorBanner} role="status">{translate('loadFailed')}</p>
        <Button type="button" variant="outline" icon={<IconRefreshOutline16 size={14} />} onClick={() => { void controller.load() }}>
          {translate('reload')}
        </Button>
      </div>
    )
  }
  if (!snapshot.available) {
    return (
      <div className={styles.section}>
        <h2 className={styles.title}>{translate('title')}</h2>
        <p className={styles.description}>{translate('description')}</p>
        <p className={styles.status}>{translate('unavailable')} — {translate('unavailableDescription')}</p>
      </div>
    )
  }

  const updateChain = (chainIndex: number, patch: Partial<FallbackChainDraft>): void => {
    setDraft(previous => previous === undefined
      ? previous
      : { ...previous, chains: previous.chains.map((chain, at) => at === chainIndex ? { ...chain, ...patch } : chain) })
    setDirty(true)
  }

  const updateMatch = (chainIndex: number, patch: Partial<FallbackMatchDraft>): void => {
    setDraft(previous => previous === undefined ? previous : {
      ...previous,
      chains: previous.chains.map((chain, at) => {
        if (at !== chainIndex) return chain
        if (patch.provider !== undefined) {
          if (patch.provider === '') return { ...chain, match: undefined }
          const keepModel = chain.match?.model !== undefined && patch.provider === chain.match.provider
          return {
            ...chain,
            match: keepModel
              ? { provider: patch.provider, model: chain.match!.model }
              : { provider: patch.provider },
          }
        }
        if (patch.model !== undefined) {
          const provider = chain.match?.provider ?? ''
          if (provider === '') return chain
          return { ...chain, match: patch.model === '' ? { provider } : { provider, model: patch.model } }
        }
        return chain
      }),
    })
    setDirty(true)
  }

  const updateFallback = (chainIndex: number, fallbackIndex: number, patch: Partial<FallbackProviderEntry>): void => {
    setDraft(previous => previous === undefined ? previous : {
      ...previous,
      chains: previous.chains.map((chain, at) => at === chainIndex
        ? {
          ...chain,
          fallbacks: chain.fallbacks.map((entry, atEntry) => {
            if (atEntry !== fallbackIndex) return entry
            // Changing the provider clears the model so the new provider's
            // catalog drives the choice (stored values stay selectable).
            return patch.provider !== undefined
              ? { provider: patch.provider, model: '' }
              : { ...entry, ...patch }
          }),
        }
        : chain),
    })
    setDirty(true)
  }

  const addFallback = (chainIndex: number): void => {
    setDraft(previous => previous === undefined ? previous : {
      ...previous,
      chains: previous.chains.map((chain, at) => at === chainIndex
        ? { ...chain, fallbacks: [...chain.fallbacks, { provider: '', model: '' }] }
        : chain),
    })
    setDirty(true)
  }

  const removeFallback = (chainIndex: number, fallbackIndex: number): void => {
    setDraft(previous => previous === undefined ? previous : {
      ...previous,
      chains: previous.chains.map((chain, at) => at === chainIndex
        ? { ...chain, fallbacks: chain.fallbacks.filter((_, atEntry) => atEntry !== fallbackIndex) }
        : chain),
    })
    setDirty(true)
  }

  const moveFallback = (chainIndex: number, fallbackIndex: number, direction: -1 | 1): void => {
    setDraft(previous => previous === undefined ? previous : {
      ...previous,
      chains: previous.chains.map((chain, at) => {
        if (at !== chainIndex) return chain
        const target = fallbackIndex + direction
        if (target < 0 || target >= chain.fallbacks.length) return chain
        const fallbacks = [...chain.fallbacks]
        const moved = fallbacks[fallbackIndex]
        /* v8 ignore next -- guarded by the bounds check above */
        if (moved === undefined) return chain
        fallbacks[fallbackIndex] = fallbacks[target]!
        fallbacks[target] = moved
        return { ...chain, fallbacks }
      }),
    })
    setDirty(true)
  }

  const addChain = (): void => {
    setDraft(previous => previous === undefined
      ? { chains: [emptyChain()] }
      : { ...previous, chains: [...previous.chains, emptyChain()] })
    setDirty(true)
  }

  const removeChain = (chainIndex: number): void => {
    setDraft(previous => previous === undefined ? previous : {
      ...previous,
      chains: previous.chains.filter((_, at) => at !== chainIndex),
    })
    setDirty(true)
  }

  const discard = (): void => {
    setResetArmed(false)
    setDirty(false)
  }

  const onSave = (): void => {
    if (draft === undefined || invalid || saving) return
    void controller.save(draft).then((landed) => { if (landed) setDirty(false) })
  }

  const onReset = (): void => {
    if (saving) return
    void controller.reset().then((landed) => {
      setResetArmed(false)
      if (landed) setDirty(false)
    })
  }

  const reload = (): void => {
    setResetArmed(false)
    setDirty(false)
    void controller.load()
  }

  return (
    <div className={styles.section}>
      <h2 className={styles.title}>{translate('title')}</h2>
      <p className={styles.description}>{translate('description')}</p>

      {snapshot.error?.kind === 'conflict'
        ? (
          <div className={styles.conflictBanner} role="status">
            <strong>{translate('conflictTitle')}</strong>
            <span>{translate('conflictMessage')}</span>
            <Button type="button" variant="outline" size="sm" icon={<IconRefreshOutline16 size={14} />} onClick={reload}>
              {translate('reload')}
            </Button>
          </div>
        )
        : null}
      {snapshot.error !== null && snapshot.error.kind !== 'conflict'
        ? <p className={styles.errorBanner} role="status">{translate('saveFailed')}: {snapshot.error.message}</p>
        : null}
      {readOnly ? <p className={styles.readOnly} role="status">{translate('readOnly')}</p> : null}

      {draft === undefined ? null : (
        <>
          {draft.chains.length === 0 ? (
            <div className={styles.emptyState}>
              <h3 className={styles.emptyTitle}>{translate('emptyTitle')}</h3>
              <p className={styles.emptyBody}>{translate('emptyBody')}</p>
              <Button
                type="button"
                variant="outline"
                icon={<IconPlusOutline16 size={14} />}
                disabled={readOnly}
                onClick={addChain}
              >
                {translate('emptyAction')}
              </Button>
            </div>
          ) : (
            <>
              <div className={styles.chains}>
                {draft.chains.map((chain, chainIndex) => (
                  <ChainCard
                    key={chainIndex}
                    chain={chain}
                    index={chainIndex}
                    providers={providers}
                    modelsByProvider={modelsByProvider}
                    readOnly={readOnly}
                    t={translate}
                    onUpdateChain={updateChain}
                    onUpdateMatch={updateMatch}
                    onUpdateFallback={updateFallback}
                    onAddFallback={addFallback}
                    onRemoveFallback={removeFallback}
                    onMoveFallback={moveFallback}
                    onRemoveChain={removeChain}
                  />
                ))}
              </div>
              <Button
                type="button"
                variant="outline"
                icon={<IconPlusOutline16 size={14} />}
                disabled={readOnly}
                onClick={addChain}
              >
                {translate('addChain')}
              </Button>
            </>
          )}

          {invalid && draft.chains.length > 0 ? (
            <ul className={styles.problems}>
              {problems.map(problem => <li key={problem}>{problem}</li>)}
            </ul>
          ) : null}

          {resetArmed
            ? (
              <div className={styles.resetConfirm} role="alert">
                <span>{translate('resetConfirm')}</span>
                <Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => { setResetArmed(false) }}>
                  {translate('resetCancel')}
                </Button>
                <Button type="button" variant="outline" size="sm" disabled={saving} onClick={onReset}>
                  {translate(saving ? 'resetting' : 'resetConfirmAction')}
                </Button>
              </div>
            )
            : null}

          <footer className={styles.footer}>
            {dirty ? <span className={styles.unsaved}>{translate('unsaved')}</span> : null}
            <span className={styles.spacer} />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!dirty || saving || readOnly}
              onClick={() => { setResetArmed(true) }}
            >
              {translate('reset')}
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={!dirty || saving} onClick={discard}>
              {translate('discard')}
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={!dirty || invalid || saving || readOnly}
              onClick={onSave}
            >
              {translate(saving ? 'saving' : 'save')}
            </Button>
          </footer>
        </>
      )}
    </div>
  )
}
