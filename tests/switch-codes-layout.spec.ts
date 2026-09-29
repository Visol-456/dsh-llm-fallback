/**
 * Switch-codes field layout guard (0.2.0-rc.3).
 *
 * jsdom never lays anything out, so the live pixel widths cannot be asserted
 * here. What burned us twice was the CSS itself: `.switchCodesField` kept the
 * 460px cap from the old narrow Settings dialog column (rc.1) and then the
 * "fixed" 600px cap from the wider Plugins page (rc.2) - both magic numbers
 * that only held for one page width. This test pins the dynamic contract
 * instead of a number:
 *
 *   - `.switchCodesField` is `width: 100%` with no `max-width` cap;
 *   - no switch-codes rule carries a pixel width, so the field tracks whatever
 *     width the Plugins page gives the config column;
 *   - the field's input is `box-sizing: border-box`, so the input's own padding
 *     and border live inside that 100% instead of adding 26px on top of it
 *     (which is what overhangs the card's right border).
 *
 * The one thing a browser would show and jsdom cannot - that the six-code
 * default list is not truncated - is checked here as box-model arithmetic at
 * the verified Plugins-page layout: a 657px card leaves a 607px config column,
 * and the default value (`EMPTY_RESPONSE, RATE_LIMIT, SERVER, UNKNOWN_MODEL,
 * TIMEOUT, TRANSPORT`) measures ~587px of text at 14px in this app's font
 * stack. With border-box the field's text area at that column is
 * 607 - 2*border - 2*padding, which the padding parsed from the CSS below must
 * keep >= 587.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Comments stripped so `rulesUnder` sees selectors, not the prose above them.
const css = readFileSync(new URL('../src/client/FallbackBundleConfig.module.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')

/** The declaration block of the first rule whose selector is exactly `selector`. */
function ruleBody(selector: string): string {
  const start = css.indexOf(`${selector} {`)
  if (start === -1) return ''
  return css.slice(start + selector.length, css.indexOf('}', start))
}

/** Every `.<class>` rule (and its descendant rules) whose selector starts with `selector`. */
function rulesUnder(selector: string): string[] {
  const out: string[] = []
  for (const match of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const ruleSelector = match[1]!.trim()
    if (ruleSelector === selector || ruleSelector.startsWith(`${selector} `)) out.push(match[2]!)
  }
  return out
}

/** The verified Plugins-page layout: a 657px card leaves this config column. */
const VERIFIED_COLUMN = 607
/** Width of the six-code default value at 14px in this app's font stack. */
const DEFAULT_TEXT_WIDTH = 587
/** The input's hairline border on each side. */
const BORDER = 1

describe('switch-codes field layout', () => {
  it('fills the config column with a percentage instead of a pixel cap', () => {
    const body = ruleBody('.switchCodesField')
    expect(body).not.toBe('')
    expect(body).toMatch(/width:\s*100%/)
    // The whole point: no upper bound to outgrow a wider page or undershoot a
    // narrower one. `min-width: 0` is the flex shrink fix, not a width.
    expect(body).not.toMatch(/max-width/)
  })

  it('carries no pixel width anywhere in the switch-codes rules', () => {
    const rules = rulesUnder('.switchCodesField')
    expect(rules.length).toBeGreaterThanOrEqual(2)
    for (const rule of rules) {
      expect(rule).not.toMatch(/(?:max-|min-)?width:\s*[\d.]+px/)
    }
  })

  it('folds the input padding and border into the width with border-box', () => {
    const body = ruleBody('.switchCodesField .input')
    expect(body).toMatch(/box-sizing:\s*border-box/)
  })

  it('fits the six-code default in the verified column with box-model math', () => {
    const body = ruleBody('.switchCodesField .input')
    // `padding: 0 <n>px` -> side padding; anything else (e.g. a pixel width)
    // would break the intent of this assertion.
    const padding = /padding:\s*0\s+(\d+(?:\.\d+)?)px/.exec(body)
    expect(padding, 'the input must declare symmetric horizontal padding').not.toBeNull()
    const sidePadding = Number(padding![1])
    const textArea = VERIFIED_COLUMN - 2 * BORDER - 2 * sidePadding
    expect(textArea).toBeGreaterThanOrEqual(DEFAULT_TEXT_WIDTH)
  })

  it('drops the dead nowrap/overflow-x pair from the input', () => {
    // The whole `.switchCodes` class is gone: the declarations never applied to
    // a single-line input, and the value is fully visible by width now.
    expect(css).not.toMatch(/\.switchCodes\s*\{/)
    expect(css).not.toMatch(/white-space:\s*nowrap/)
    expect(css).not.toMatch(/overflow-x/)
  })
})
