/**
 * Fallback settings section: ordered chain cards (add/remove/reorder
 * provider/model entries), switch codes, failure threshold, and cooldown.
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
import type { FallbackChainDraft, FallbackConfig, FallbackProviderEntry, FallbackSettingsState, FallbackSettingsStore } from './store.ts'
import { MAX_COOLDOWN_MS } from './store.ts'
import styles from './FallbackSection.module.css'

/** Injected dependencies of {@link FallbackSection} (slot `inject`). */
export interface FallbackSectionInjected {
  /** The page store (loaded on mount, refreshed on pushed invalidations). */
  controller: FallbackSettingsStore
  /** uSES subscription hook bound to the store. */
  useSnapshot: SnapshotSelectorHook<FallbackSettingsState>
  /** Wire face the provider suggestion list reads through. */
  api: Pick<IApiClient, 'llm'>
  /** Section copy (template params for e.g. chain labels). */
  t: (key: keyof typeof en, params?: Record<string, unknown>) => string
}

/** Props delivered by the slot outlet: the inject face spread flat. */
export type FallbackSectionProps = Partial<FallbackSectionInjected>

/** Default switch codes for a freshly added chain (mirrors the node default). */
const DEFAULT_SWITCH_CODES = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']

/** One empty chain scaffold the user fills in. */
function emptyChain(): FallbackChainDraft {
  return {
    providers: [
      { provider: '', model: '' },
      { provider: '', model: '' },
    ],
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
  const seen = new Set<string>()
  draft.chains.forEach((chain, chainIndex) => {
    if (chain.providers.length < 2) problems.push(`${t('chain', { n: String(chainIndex + 1) })}: ${t('errorNeedTwoEntries')}`)
    const inChain = new Set<string>()
    for (const entry of chain.providers) {
      if (entry.provider.trim().length === 0) problems.push(`${t('chain', { n: String(chainIndex + 1) })}: ${t('errorEmptyProvider')}`)
      if (entry.model.trim().length === 0) problems.push(`${t('chain', { n: String(chainIndex + 1) })}: ${t('errorEmptyModel')}`)
      if (entry.provider.trim().length > 0 && entry.model.trim().length > 0) {
        const key = `${entry.provider.trim()}\u0000${entry.model.trim()}`
        if (inChain.has(key)) problems.push(`${t('chain', { n: String(chainIndex + 1) })}: ${t('errorDuplicateInChain')}`)
        inChain.add(key)
        if (seen.has(key)) problems.push(t('errorDuplicateAcrossChains'))
        seen.add(key)
      }
    }
    if (chain.switchCodes.length === 0) problems.push(`${t('chain', { n: String(chainIndex + 1) })}: ${t('errorSwitchCodes')}`)
    if (!Number.isInteger(chain.failureThreshold) || chain.failureThreshold < 1) {
      problems.push(`${t('chain', { n: String(chainIndex + 1) })}: ${t('errorThreshold')}`)
    }
    if (!Number.isInteger(chain.cooldownMs) || chain.cooldownMs < 0 || chain.cooldownMs > MAX_COOLDOWN_MS) {
      problems.push(`${t('chain', { n: String(chainIndex + 1) })}: ${t('errorCooldown')}`)
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

/**
 * Render one chain card. All edits funnel through the shared immutable
 * update callbacks passed from the section.
 */
function ChainCard(props: {
  chain: FallbackChainDraft
  index: number
  providers: readonly string[]
  readOnly: boolean
  t: FallbackSectionInjected['t']
  onUpdate: (chainIndex: number, patch: Partial<FallbackChainDraft>) => void
  onUpdateEntry: (chainIndex: number, entryIndex: number, patch: Partial<FallbackProviderEntry>) => void
  onAddEntry: (chainIndex: number) => void
  onRemoveEntry: (chainIndex: number, entryIndex: number) => void
  onMoveEntry: (chainIndex: number, entryIndex: number, direction: -1 | 1) => void
  onRemoveChain: (chainIndex: number) => void
}): JSX.Element {
  const { chain, index, providers, readOnly, t } = props
  const entryCount = chain.providers.length
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

      <ol className={styles.entries}>
        {chain.providers.map((entry, entryIndex) => (
          <li key={entryIndex} className={styles.entry}>
            <input
              className={styles.input}
              value={entry.provider}
              aria-label={`${t('provider')} ${String(entryIndex + 1)}`}
              placeholder={t('providerPlaceholder')}
              list="llm-fallback-providers"
              disabled={readOnly}
              onChange={(event) => { props.onUpdateEntry(index, entryIndex, { provider: event.target.value }) }}
            />
            <input
              className={styles.input}
              value={entry.model}
              aria-label={`${t('model')} ${String(entryIndex + 1)}`}
              placeholder={t('modelPlaceholder')}
              disabled={readOnly}
              onChange={(event) => { props.onUpdateEntry(index, entryIndex, { model: event.target.value }) }}
            />
            <div className={styles.entryActions}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={t('moveUp')}
                disabled={readOnly || entryIndex === 0}
                onClick={() => { props.onMoveEntry(index, entryIndex, -1) }}
              >
                <IconChevronUpOutline14 />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={t('moveDown')}
                disabled={readOnly || entryIndex === entryCount - 1}
                onClick={() => { props.onMoveEntry(index, entryIndex, 1) }}
              >
                <IconChevronDownOutline14 />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={t('removeEntry')}
                disabled={readOnly}
                onClick={() => { props.onRemoveEntry(index, entryIndex) }}
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
          onClick={() => { props.onAddEntry(index) }}
        >
          {t('addEntry')}
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
            onChange={(event) => { props.onUpdate(index, { switchCodes: parseSwitchCodes(event.target.value) }) }}
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
            onChange={(event) => { props.onUpdate(index, { failureThreshold: Number(event.target.value) }) }}
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
            onChange={(event) => { props.onUpdate(index, { cooldownMs: Number(event.target.value) }) }}
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

  // Re-seed the draft from the server truth whenever it is not dirty.
  useEffect(() => {
    if (!dirty) setDraft(snapshot.value)
  }, [snapshot.value, dirty])

  // One-shot provider suggestion list (best-effort; free text still works).
  useEffect(() => {
    if (api === undefined) return
    void api.llm.providers({}).then((response) => {
      if (response.result.ok) {
        setProviders(response.result.value.providers.map(entry => entry.provider))
      }
    }).catch(() => {})
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

  const updateEntry = (chainIndex: number, entryIndex: number, patch: Partial<FallbackProviderEntry>): void => {
    setDraft(previous => previous === undefined ? previous : {
      ...previous,
      chains: previous.chains.map((chain, at) => at === chainIndex
        ? { ...chain, providers: chain.providers.map((entry, atEntry) => atEntry === entryIndex ? { ...entry, ...patch } : entry) }
        : chain),
    })
    setDirty(true)
  }

  const addEntry = (chainIndex: number): void => {
    setDraft(previous => previous === undefined ? previous : {
      ...previous,
      chains: previous.chains.map((chain, at) => at === chainIndex
        ? { ...chain, providers: [...chain.providers, { provider: '', model: '' }] }
        : chain),
    })
    setDirty(true)
  }

  const removeEntry = (chainIndex: number, entryIndex: number): void => {
    setDraft(previous => previous === undefined ? previous : {
      ...previous,
      chains: previous.chains.map((chain, at) => at === chainIndex
        ? { ...chain, providers: chain.providers.filter((_, atEntry) => atEntry !== entryIndex) }
        : chain),
    })
    setDirty(true)
  }

  const moveEntry = (chainIndex: number, entryIndex: number, direction: -1 | 1): void => {
    setDraft(previous => previous === undefined ? previous : {
      ...previous,
      chains: previous.chains.map((chain, at) => {
        if (at !== chainIndex) return chain
        const target = entryIndex + direction
        if (target < 0 || target >= chain.providers.length) return chain
        const providers = [...chain.providers]
        const moved = providers[entryIndex]
        /* v8 ignore next -- guarded by the bounds check above */
        if (moved === undefined) return chain
        providers[entryIndex] = providers[target]!
        providers[target] = moved
        return { ...chain, providers }
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

      <datalist id="llm-fallback-providers">
        {providers.map(provider => <option key={provider} value={provider} />)}
      </datalist>

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
                    readOnly={readOnly}
                    t={translate}
                    onUpdate={updateChain}
                    onUpdateEntry={updateEntry}
                    onAddEntry={addEntry}
                    onRemoveEntry={removeEntry}
                    onMoveEntry={moveEntry}
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
