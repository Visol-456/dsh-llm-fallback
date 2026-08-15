/**
 * Fallback settings section: a global fallback target list (provider + model
 * dropdowns driven by the harness model catalog) plus the switch rules.
 * The request itself is always the head and is never rewritten. Edits stage
 * locally and land only on Save through the loopback config bridge; Reset
 * clears the saved section back to cordis.yml. A 409 revision conflict
 * renders a reload banner instead of silently overwriting another window's
 * changes.
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
  FallbackConfig,
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

/** Default switch codes for a freshly added configuration (mirrors the node default). */
const DEFAULT_SWITCH_CODES = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'UNKNOWN_MODEL', 'TIMEOUT', 'TRANSPORT']

/** One empty configuration scaffold the user fills in. */
function emptyConfig(): FallbackConfig {
  return {
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
  if (draft.fallbacks.length < 1) problems.push(t('errorNeedFallback'))
  const seen = new Set<string>()
  for (const entry of draft.fallbacks) {
    if (entry.provider.trim().length === 0) problems.push(t('errorEmptyProvider'))
    if (entry.model.trim().length === 0) problems.push(t('errorEmptyModel'))
    if (entry.provider.trim().length > 0 && entry.model.trim().length > 0) {
      const key = `${entry.provider.trim()}\u0000${entry.model.trim()}`
      if (seen.has(key)) problems.push(t('errorDuplicateFallback'))
      seen.add(key)
    }
  }
  if (draft.switchCodes.length === 0) problems.push(t('errorSwitchCodes'))
  if (!Number.isInteger(draft.failureThreshold) || draft.failureThreshold < 1) {
    problems.push(t('errorThreshold'))
  }
  if (!Number.isInteger(draft.cooldownMs) || draft.cooldownMs < 0 || draft.cooldownMs > MAX_COOLDOWN_MS) {
    problems.push(t('errorCooldown'))
  }
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

/** One model the harness catalog lists for a provider. */
export interface CatalogModel {
  /** Exact model id served by the route. */
  id: string
  /** Human model name from the catalog (falls back to the id). */
  name?: string
}

/** Catalog options plus a stored value the catalog does not list. */
function optionsWithStored(catalog: readonly string[], stored: string | undefined): string[] {
  const out = [...catalog]
  if (stored !== undefined && stored.length > 0 && !out.includes(stored)) out.push(stored)
  return out
}

/** Display label for a provider option (the harness display name, else the id). */
function providerLabel(provider: string, names: Readonly<Record<string, string>>): string {
  return names[provider] ?? provider
}

/** Display label for a model option within one provider's catalog (the model name, else the id). */
function modelLabel(provider: string, model: string, modelsByProvider: Readonly<Record<string, readonly CatalogModel[]>>): string {
  return modelsByProvider[provider]?.find(entry => entry.id === model)?.name ?? model
}

/**
 * One fallback row: provider select + model select (linked to the provider's
 * catalog) + in-row move/remove buttons on the right.
 */
function FallbackRow(props: {
  entry: FallbackProviderEntry
  index: number
  count: number
  providers: readonly string[]
  providerNames: Readonly<Record<string, string>>
  modelsByProvider: Readonly<Record<string, readonly CatalogModel[]>>
  readOnly: boolean
  t: FallbackSectionInjected['t']
  onUpdate: (index: number, patch: Partial<FallbackProviderEntry>) => void
  onMove: (index: number, direction: -1 | 1) => void
  onRemove: (index: number) => void
}): JSX.Element {
  const { entry, index, count, providers, providerNames, modelsByProvider, readOnly, t } = props
  const providerChoices = optionsWithStored(providers, entry.provider)
  const models = modelsByProvider[entry.provider] ?? []
  const modelChoices = optionsWithStored(models.map(model => model.id), entry.model)
  const modelDisabled = readOnly || entry.provider.length === 0 || modelChoices.length === 0
  const noModels = entry.provider.length > 0 && models.length === 0 && entry.model.length === 0
  return (
    <li className={styles.row}>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{`${t('provider')} ${String(index + 1)}`}</span>
        <select
          className={styles.input}
          value={entry.provider}
          disabled={readOnly || providerChoices.length === 0}
          onChange={(event) => { props.onUpdate(index, { provider: event.target.value }) }}
        >
          {providerChoices.length === 0
            ? <option value="">{t('provider')}…</option>
            : [
              // Explicit empty option: an entry with no provider yet must
              // display as unselected instead of faking the first catalog
              // route (a select whose value matches no option shows option
              // #1 while the real value stays empty).
              <option key="" value="">{t('selectProvider')}</option>,
              ...providerChoices.map(choice => (
                <option key={choice} value={choice} title={choice}>{providerLabel(choice, providerNames)}</option>
              )),
            ]}
        </select>
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{`${t('model')} ${String(index + 1)}`}</span>
        <select
          className={styles.input}
          value={entry.model}
          disabled={modelDisabled}
          onChange={(event) => { props.onUpdate(index, { model: event.target.value }) }}
        >
          {modelChoices.length === 0
            ? <option value="">{t('model')}…</option>
            : [
              // Same honesty as the provider select: an entry with no model
              // yet shows the placeholder, never a fake first option.
              <option key="" value="">{t('selectModel')}</option>,
              ...modelChoices.map(choice => (
                <option key={choice} value={choice} title={choice}>{modelLabel(entry.provider, choice, modelsByProvider)}</option>
              )),
            ]}
        </select>
        {noModels ? <span className={styles.hint}>{t('noModelsForProvider')}</span> : null}
      </label>
      <div className={styles.rowActions}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={t('moveUp')}
          disabled={readOnly || index === 0}
          onClick={() => { props.onMove(index, -1) }}
        >
          <IconChevronUpOutline14 />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={t('moveDown')}
          disabled={readOnly || index === count - 1}
          onClick={() => { props.onMove(index, 1) }}
        >
          <IconChevronDownOutline14 />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={t('removeFallback')}
          disabled={readOnly}
          onClick={() => { props.onRemove(index) }}
        >
          <IconTrashOutline16 size={14} />
        </Button>
      </div>
    </li>
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
  const [providerNames, setProviderNames] = useState<Record<string, string>>({})
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, CatalogModel[]>>({})

  // Re-seed the draft from the server truth whenever it is not dirty.
  useEffect(() => {
    if (!dirty) setDraft(snapshot.value)
  }, [snapshot.value, dirty])

  // Provider + model catalogs (best-effort; stored values stay selectable).
  // Only providers that actually list models are offered as fresh choices:
  // the harness marks dormant pi-ai routes (e.g. a `deepseek` route without
  // a settings section) `active: false` AND leaves them out of llm.models —
  // offering them dead-ends in "no models listed" and, worse, sits a
  // lookalike next to the real `deepseek-official` route.
  useEffect(() => {
    if (api === undefined) return
    let cancelled = false
    void Promise.all([
      api.llm.providers({}).then(response =>
        response.result.ok ? response.result.value.providers : []),
      api.llm.models({}).then(response =>
        response.result.ok ? response.result.value.groups : []),
    ]).then(([providerRows, groups]) => {
      if (cancelled) return
      const names: Record<string, string> = {}
      for (const row of providerRows) names[row.provider] = row.displayName
      const map: Record<string, CatalogModel[]> = {}
      for (const group of groups) {
        if (names[group.id] === undefined) names[group.id] = group.name
        map[group.id] = group.models.map(model => ({ id: model.id, ...model.name === undefined ? {} : { name: model.name } }))
      }
      setProviderNames(names)
      setProviders(Object.keys(map))
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

  const updateConfig = (patch: Partial<FallbackConfig>): void => {
    setDraft(previous => previous === undefined ? previous : { ...previous, ...patch })
    setDirty(true)
  }

  const updateFallback = (index: number, patch: Partial<FallbackProviderEntry>): void => {
    setDraft(previous => previous === undefined ? previous : {
      ...previous,
      fallbacks: previous.fallbacks.map((entry, at) => {
        if (at !== index) return entry
        // Changing the provider clears the model so the new provider's
        // catalog drives the choice (stored values stay selectable). A
        // provider with exactly one listed model adopts it right away, so
        // the row lands complete instead of showing a fake first option.
        if (patch.provider !== undefined) {
          const models = modelsByProvider[patch.provider] ?? []
          return {
            provider: patch.provider,
            model: models.length === 1 ? models[0]!.id : '',
          }
        }
        return { ...entry, ...patch }
      }),
    })
    setDirty(true)
  }

  const addFallback = (): void => {
    setDraft(previous => previous === undefined
      ? { ...emptyConfig(), fallbacks: [{ provider: '', model: '' }] }
      : { ...previous, fallbacks: [...previous.fallbacks, { provider: '', model: '' }] })
    setDirty(true)
  }

  const removeFallback = (index: number): void => {
    setDraft(previous => previous === undefined ? previous : {
      ...previous,
      fallbacks: previous.fallbacks.filter((_, at) => at !== index),
    })
    setDirty(true)
  }

  const moveFallback = (index: number, direction: -1 | 1): void => {
    setDraft(previous => previous === undefined ? previous : {
      ...previous,
      fallbacks: previous.fallbacks.map((entry, at, list) => {
        if (at !== index) return entry
        const target = index + direction
        if (target < 0 || target >= list.length) return entry
        return list[target]!
      }).map((entry, at, list) => {
        const target = index + direction
        if (target < 0 || target >= list.length) return entry
        if (at === target) return list[index]!
        return entry
      }),
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
        <div className={styles.card}>
          {draft.fallbacks.length === 0 ? (
            <div className={styles.emptyState}>
              <h3 className={styles.emptyTitle}>{translate('emptyTitle')}</h3>
              <p className={styles.emptyBody}>{translate('emptyBody')}</p>
              <Button
                type="button"
                variant="outline"
                icon={<IconPlusOutline16 size={14} />}
                disabled={readOnly}
                onClick={addFallback}
              >
                {translate('emptyAction')}
              </Button>
            </div>
          ) : (
            <>
              <span className={styles.sectionLabel}>{translate('fallbacks')}</span>
              <ol className={styles.rows}>
                {draft.fallbacks.map((entry, index) => (
                  <FallbackRow
                    key={index}
                    entry={entry}
                    index={index}
                    count={draft.fallbacks.length}
                    providers={providers}
                    providerNames={providerNames}
                    modelsByProvider={modelsByProvider}
                    readOnly={readOnly}
                    t={translate}
                    onUpdate={updateFallback}
                    onMove={moveFallback}
                    onRemove={removeFallback}
                  />
                ))}
              </ol>
              <div className={styles.addRow}>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  icon={<IconPlusOutline16 size={14} />}
                  disabled={readOnly}
                  onClick={addFallback}
                >
                  {translate('addFallback')}
                </Button>
              </div>
            </>
          )}

          <div className={styles.params}>
            <label className={`${styles.field} ${styles.switchCodesField}`}>
              <span className={styles.fieldLabel}>{translate('switchCodes')}</span>
              <input
                className={`${styles.input} ${styles.switchCodes}`}
                value={draft.switchCodes.join(', ')}
                placeholder={translate('switchCodesPlaceholder')}
                spellCheck={false}
                disabled={readOnly}
                onChange={(event) => { updateConfig({ switchCodes: parseSwitchCodes(event.target.value) }) }}
              />
            </label>
            <div className={styles.paramPair}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{translate('failureThreshold')}</span>
              <input
                className={`${styles.input} ${styles.number}`}
                type="number"
                min={1}
                step={1}
                value={Number.isNaN(draft.failureThreshold) ? '' : String(draft.failureThreshold)}
                disabled={readOnly}
                onChange={(event) => { updateConfig({ failureThreshold: Number(event.target.value) }) }}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{translate('cooldownMs')}</span>
              <input
                className={`${styles.input} ${styles.number}`}
                type="number"
                min={0}
                step={1}
                value={Number.isNaN(draft.cooldownMs) ? '' : String(draft.cooldownMs)}
                disabled={readOnly}
                onChange={(event) => { updateConfig({ cooldownMs: Number(event.target.value) }) }}
              />
            </label>
            </div>
          </div>

          {invalid ? (
            <ul className={styles.problems}>
              {problems.map((problem, at) => <li key={at}>{problem}</li>)}
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
        </div>
      )}
    </div>
  )
}
